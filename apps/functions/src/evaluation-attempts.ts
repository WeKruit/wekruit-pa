import { HttpsError, onCall } from "firebase-functions/v2/https"
import { defineSecret } from "firebase-functions/params"
import { getFirestore, type Firestore } from "firebase-admin/firestore"
import { z } from "zod"
import {
  EvaluationOutcomeSchema,
  HumanReviewStatusSchema,
  PA_COLLECTIONS,
  type EvaluationAttempt,
  type EvaluationOutcome,
} from "@pa/core-types"
import { getEvaluationAttempt, saveHumanReview } from "@pa/pa-persistence"
import { callWithFallback } from "@pa/pa-resume-parser"
import { requireExternalSupplyAdmin } from "./external-supply/resolve-identity.js"
import { sendRuntimeApprovedIMessage } from "./runtime-approved-outbox.js"
import { sendProactiveSchedulingInvite } from "./claire-agent/scheduling-invite.js"
import { markPrescreenTerminalOutcome } from "./prescreen-outcome-service.js"
import { getAnthropicConfig, getOpenAIConfig } from "./lib/llm-providers.js"
import { extractChecklistGroups, renderChecklist } from "./recruiter-submission-eval.js"
import {
  ANTHROPIC_API_KEY,
  CALCOM_API_KEY,
  MAILGUN_API_KEY,
  MAILGUN_DOMAIN,
  MAILGUN_FROM,
  MAILGUN_REGION,
} from "./orchestrator-deps.js"

const PA_OPENAI_AGENT_API_KEY = defineSecret("PA_OPENAI_AGENT_API_KEY")

const ReviewEvaluationAttemptInputSchema = z.object({
  attemptId: z.string().min(1),
  status: HumanReviewStatusSchema,
  finalOutcome: z.unknown().optional(),
  candidateMessageBody: z.string().max(2_000).optional(),
  decisionReason: z.string().max(1_000).optional(),
  recommendedActions: z.array(z.string().max(240)).max(5).optional(),
  note: z.string().max(2_000).optional(),
  correctionReason: z.string().max(2_000).optional(),
})

const PrescreenTerminalOutcomeInputSchema = z
  .object({
    prescreenTerminal: z.enum(["PASS", "FAIL", "HARD_STOP"]),
  })
  .strict()

const DraftPrescreenReviewMessagesInputSchema = z.object({
  sessionIds: z.array(z.string().min(1)).min(1).max(20),
  terminal: z.enum(["PASS", "FAIL", "HARD_STOP"]),
})

export type ReviewEvaluationAttemptInput = z.infer<typeof ReviewEvaluationAttemptInputSchema>

export interface ReviewEvaluationAttemptResult {
  ok: true
  attemptId: string
  status: ReviewEvaluationAttemptInput["status"]
  finalOutcome?: EvaluationOutcome
  correctionEventId?: string
  prescreenTerminalActionFired?: boolean
  prescreenOutcomeCommitted?: boolean
  candidateOutboundId?: string
  candidateDecision?: PrescreenCandidateDecision
  externalEvaluationUpdated?: boolean
}

export interface DraftPrescreenReviewMessagesInput {
  sessionIds: string[]
  terminal: "PASS" | "FAIL" | "HARD_STOP"
}

export interface DraftPrescreenReviewMessage {
  sessionId: string
  attemptId: string
  candidateId: string
  jobId: string
  proposedTerminal?: string
  finalTerminal: "PASS" | "FAIL" | "HARD_STOP"
  candidateMessageBody: string
  decisionReason: string
  recommendedActions: string[]
  evidenceSummary: string
  /** Operator-only detailed reason: the per-tier checklist cross-check. Never sent to the candidate. */
  internalReviewNotes?: string
  tone?: RejectionTone
}

export type PrescreenCandidateDecision = {
  candidateMessageBody: string
  decisionReason: string
  recommendedActions: string[]
  finalTerminal: "PASS" | "FAIL" | "HARD_STOP"
  reviewedAt: string
  decisionOutboundId?: string
}

export interface DraftPrescreenReviewMessagesResult {
  ok: true
  drafts: DraftPrescreenReviewMessage[]
}

export interface ReviewEvaluationAttemptDeps {
  db: Firestore
  now?: () => string
  markPrescreenOutcome?: typeof markPrescreenTerminalOutcome
  sendSms?: typeof sendRuntimeApprovedIMessage
  /**
   * Proactive interview-invite seam (Gap 1). Production = the real
   * sendProactiveSchedulingInvite (gated, idempotent, fail-open); tests inject a
   * spy. Fires ONLY on a PASS commit; a failure never fails the commit.
   */
  sendSchedulingInvite?: typeof sendProactiveSchedulingInvite
}

export interface DraftPrescreenReviewMessagesDeps {
  db: Firestore
  composeDraft?: typeof composePrescreenReviewCandidateMessage
  loadTurns?: typeof loadPrescreenTurnsForDraft
}

type CallableAuth = Parameters<typeof requireExternalSupplyAdmin>[0]

type PrescreenDraftTurn = {
  qId?: string
  reply?: string
  scored?: {
    aggregate?: {
      s?: number
      c?: number
      summary?: string
    }
  }
}

/**
 * Candidate-facing tone for the rejection draft (Adam 2026-06-14): be honest and
 * genuine, never fake. A strong candidate who is simply wrong-for-this-role hears
 * their real strength + a redirect; a genuinely under-qualified candidate hears
 * the real gap named kindly + a redirect to where they DO fit — not "you suck".
 */
export type RejectionTone = "strong_wrong_role" | "honest_underqualified" | "neutral_pass"

type PrescreenReviewDraftContext = {
  sessionId: string
  candidateId: string
  jobId: string
  proposedTerminal?: string
  finalTerminal: "PASS" | "FAIL" | "HARD_STOP"
  terminalReason?: string
  score?: number
  scoreMax?: number
  threshold?: number
  attemptExplanation?: string
  dimensions?: Array<{
    dimensionId?: string
    score?: number
    confidence?: number
    rationale?: string
  }>
  turns: PrescreenDraftTurn[]
  // Job-side requirements, cross-checked so the rejection speaks the SAME language
  // recruiters see (the recruiterBoard checklist tiers + required skills).
  jobTitle?: string
  company?: string
  requiredSkills?: string[]
  checklistText?: string
  candidateSignal?: string
  tone?: RejectionTone
}

/**
 * Pick the candidate-facing tone from the screen outcome. HARD_STOP or a clearly
 * low score → name the real gap (honest_underqualified); a near-miss FAIL → frame
 * as a strong candidate in the wrong role. PASS → neutral warm next-step.
 */
export function selectRejectionTone(context: {
  finalTerminal: "PASS" | "FAIL" | "HARD_STOP"
  score?: number
  scoreMax?: number
}): RejectionTone {
  if (context.finalTerminal === "PASS") return "neutral_pass"
  if (context.finalTerminal === "HARD_STOP") return "honest_underqualified"
  const ratio =
    typeof context.score === "number" && typeof context.scoreMax === "number" && context.scoreMax > 0
      ? context.score / context.scoreMax
      : undefined
  if (ratio !== undefined && ratio < 0.5) return "honest_underqualified"
  return "strong_wrong_role"
}

export async function runReviewEvaluationAttempt(
  data: unknown,
  auth: CallableAuth,
  deps: ReviewEvaluationAttemptDeps,
): Promise<ReviewEvaluationAttemptResult> {
  const { uid } = requireExternalSupplyAdmin(auth)
  const input = ReviewEvaluationAttemptInputSchema.parse(data)
  const nowIso = deps.now?.() ?? new Date().toISOString()
  const attempt = await getEvaluationAttempt(deps.db, input.attemptId)
  if (!attempt) throw new HttpsError("not-found", `Evaluation attempt ${input.attemptId} not found.`)
  const finalOutcome = resolveFinalOutcome(input, attempt)
  const prescreenCommit = shouldCommitPrescreenOutcome(input.status, attempt)
  const candidateMessageBody = prescreenCommit
    ? requirePrescreenCandidateMessage(input.candidateMessageBody, finalOutcome)
    : undefined

  const saved = await saveHumanReview(deps.db, {
    attemptId: attempt.attemptId,
    reviewer: uid,
    nowIso,
    correctionReason: input.correctionReason ?? `operator_${input.status}`,
    review: {
      status: input.status,
      finalOutcome,
      note: input.note,
    },
  })

  let prescreenOutcomeCommitted = false
  let candidateOutboundId: string | undefined
  let candidateDecision: PrescreenCandidateDecision | undefined
  let externalEvaluationUpdated = false

  if (input.status === "approved" || input.status === "overridden") {
    if (attempt.source === "prescreen" && attempt.purpose === "employment_prescreen") {
      const committed = await commitPrescreenOutcome({
        db: deps.db,
        attempt: saved.attempt,
        finalOutcome,
        candidateMessageBody: candidateMessageBody ?? "",
        decisionReason: input.decisionReason,
        recommendedActions: input.recommendedActions,
        reviewedAt: nowIso,
        reviewer: uid,
        reviewStatus: input.status,
        markPrescreenOutcome: deps.markPrescreenOutcome ?? markPrescreenTerminalOutcome,
        sendSms: deps.sendSms ?? sendRuntimeApprovedIMessage,
        sendSchedulingInvite: deps.sendSchedulingInvite ?? sendProactiveSchedulingInvite,
      })
      prescreenOutcomeCommitted = committed.committed
      candidateOutboundId = committed.outboundId
      candidateDecision = committed.candidateDecision
    }
    if (attempt.source === "external_supply") {
      externalEvaluationUpdated = await commitExternalSupplyProjection({
        db: deps.db,
        attempt: saved.attempt,
        finalOutcome,
        reviewer: uid,
        reviewedAt: nowIso,
        note: input.note,
      })
    }
  }

  return {
    ok: true,
    attemptId: attempt.attemptId,
    status: input.status,
    finalOutcome,
    correctionEventId: saved.correctionEvent?.eventId,
    prescreenTerminalActionFired: false,
    prescreenOutcomeCommitted,
    ...(candidateOutboundId ? { candidateOutboundId } : {}),
    ...(candidateDecision ? { candidateDecision } : {}),
    externalEvaluationUpdated,
  }
}

export async function runDraftPrescreenReviewMessages(
  data: unknown,
  auth: CallableAuth,
  deps: DraftPrescreenReviewMessagesDeps,
): Promise<DraftPrescreenReviewMessagesResult> {
  requireExternalSupplyAdmin(auth)
  const input = DraftPrescreenReviewMessagesInputSchema.parse(data)
  const composeDraft = deps.composeDraft ?? composePrescreenReviewCandidateMessage
  const loadTurns = deps.loadTurns ?? loadPrescreenTurnsForDraft
  const drafts: DraftPrescreenReviewMessage[] = []

  for (const sessionId of input.sessionIds) {
    const sessionSnap = await deps.db.collection("pa-prescreen-sessions").doc(sessionId).get()
    if (!sessionSnap.exists) {
      throw new HttpsError("not-found", `Prescreen session ${sessionId} not found.`)
    }
    const session = (sessionSnap.data() ?? {}) as Record<string, unknown>
    if (session.terminalActionPendingReview !== true) {
      throw new HttpsError(
        "failed-precondition",
        `Prescreen session ${sessionId} is not pending WeKruit team review.`,
      )
    }
    const attemptId = cleanNonEmptyString(session.evaluationAttemptId) ?? cleanNonEmptyString((session.review as { evaluationAttemptId?: unknown } | undefined)?.evaluationAttemptId)
    if (!attemptId) {
      throw new HttpsError("failed-precondition", `Prescreen session ${sessionId} has no evaluation attempt.`)
    }
    const attempt = await getEvaluationAttempt(deps.db, attemptId)
    if (!attempt) throw new HttpsError("not-found", `Evaluation attempt ${attemptId} not found.`)
    if (attempt.source !== "prescreen" || attempt.purpose !== "employment_prescreen") {
      throw new HttpsError("failed-precondition", `Evaluation attempt ${attemptId} is not a prescreen review.`)
    }
    const candidateId = cleanNonEmptyString(attempt.candidateId) ?? cleanNonEmptyString(session.userId)
    const jobId = cleanNonEmptyString(attempt.jobId) ?? cleanNonEmptyString(session.jobId)
    if (!candidateId || !jobId) {
      throw new HttpsError("failed-precondition", `Prescreen session ${sessionId} is missing candidateId or jobId.`)
    }

    const context = await buildPrescreenDraftContext(
      deps.db,
      {
        sessionId,
        candidateId,
        jobId,
        proposedTerminal: cleanNonEmptyString(attempt.proposedOutcome?.prescreenTerminal) ?? cleanNonEmptyString(session.terminal),
        finalTerminal: input.terminal,
        terminalReason: cleanNonEmptyString(session.terminalReason),
        score: numberOrUndefined(session.score),
        scoreMax: numberOrUndefined(session.scoreMax),
        threshold: numberOrUndefined(session.threshold),
        attemptExplanation: cleanNonEmptyString(attempt.explanation),
        dimensions: attempt.dimensions?.slice(0, 8).map((d) => ({
          dimensionId: d.dimensionId,
          score: d.score,
          confidence: d.confidence,
          rationale: d.rationale,
        })),
      },
      loadTurns,
    )
    const composed = await composeDraft(context)
    const normalized = normalizePrescreenDraftDecision(context.finalTerminal, composed, context)
    drafts.push({
      sessionId,
      attemptId,
      candidateId,
      jobId,
      proposedTerminal: context.proposedTerminal,
      finalTerminal: input.terminal,
      ...normalized,
      tone: composed.tone ?? context.tone,
    })
  }

  return { ok: true, drafts }
}

function shouldCommitPrescreenOutcome(
  status: ReviewEvaluationAttemptInput["status"],
  attempt: EvaluationAttempt,
): boolean {
  return (
    (status === "approved" || status === "overridden") &&
    attempt.source === "prescreen" &&
    attempt.purpose === "employment_prescreen"
  )
}

function cleanNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

async function loadPrescreenTurnsForDraft(
  db: Firestore,
  sessionId: string,
): Promise<PrescreenDraftTurn[]> {
  const turnsSnap = await db
    .collection("pa-prescreen-sessions")
    .doc(sessionId)
    .collection("turns")
    .orderBy("ts", "asc")
    .limit(12)
    .get()
  return turnsSnap.docs.map((doc) => doc.data() as PrescreenDraftTurn)
}

/**
 * Load the job-side requirements that the rejection should cross-check against:
 * the recruiter checklist (same hard/fit/anti/bonus tiers recruiters screen
 * against), required skills, and a human title/company. Fail-open: any error
 * yields an empty context (the draft still works off the transcript).
 */
async function loadPrescreenJobContext(
  db: Firestore,
  jobId: string,
): Promise<Pick<PrescreenReviewDraftContext, "jobTitle" | "company" | "requiredSkills" | "checklistText">> {
  try {
    const snap = await db.collection("pa-jobs").doc(jobId).get()
    const job = (snap.data() ?? {}) as Record<string, unknown>
    const groups = extractChecklistGroups(job)
    const checklistText = groups.length > 0 ? renderChecklist(groups, {}) : undefined
    const recruiterBoard = (job.recruiterBoard ?? {}) as Record<string, unknown>
    const label = (recruiterBoard.label ?? {}) as Record<string, unknown>
    const jobTitle =
      cleanNonEmptyString(label.title) ?? cleanNonEmptyString(job.title) ?? cleanNonEmptyString(job.roleTitle)
    const company =
      cleanNonEmptyString(label.company) ?? cleanNonEmptyString(job.company) ?? cleanNonEmptyString(job.companyName)
    const requiredSkills = Array.isArray(job.requiredSkills)
      ? job.requiredSkills
          .map((s) => cleanNonEmptyString(typeof s === "string" ? s : (s as { value?: unknown })?.value))
          .filter((s): s is string => Boolean(s))
          .slice(0, 20)
      : undefined
    return {
      jobTitle,
      company,
      requiredSkills: requiredSkills && requiredSkills.length > 0 ? requiredSkills : undefined,
      checklistText,
    }
  } catch {
    return {}
  }
}

/** Lightweight candidate profile signal (current role / stage / yoe / top skills). Fail-open. */
async function loadPrescreenCandidateSignal(db: Firestore, candidateId: string): Promise<string | undefined> {
  try {
    const snap = await db.collection(PA_COLLECTIONS.users).doc(candidateId).get()
    const u = (snap.data() ?? {}) as Record<string, unknown>
    const bits: string[] = []
    const current = cleanNonEmptyString(u.recentRoleTitle)
    if (current) bits.push(`current role: ${current}`)
    const stage = cleanNonEmptyString(u.careerStage)
    if (stage) bits.push(`career stage: ${stage}`)
    const yoe = u.yoeRange
    if (Array.isArray(yoe) && yoe.length === 2) bits.push(`yoe: ${yoe[0]}-${yoe[1]}`)
    const tags = (u.tags ?? {}) as Record<string, unknown>
    if (Array.isArray(tags.skills)) {
      const skills = tags.skills
        .map((s) => cleanNonEmptyString(typeof s === "string" ? s : (s as { value?: unknown })?.value))
        .filter((s): s is string => Boolean(s))
        .slice(0, 12)
      if (skills.length > 0) bits.push(`skills: ${skills.join(", ")}`)
    }
    return bits.length > 0 ? bits.join("; ") : undefined
  } catch {
    return undefined
  }
}

/**
 * Build the full draft context for a session (turns + job requirements + candidate
 * signal + tone). Shared by the on-demand draft callable and the inline auto-draft.
 */
async function buildPrescreenDraftContext(
  db: Firestore,
  args: {
    sessionId: string
    candidateId: string
    jobId: string
    finalTerminal: "PASS" | "FAIL" | "HARD_STOP"
    proposedTerminal?: string
    terminalReason?: string
    score?: number
    scoreMax?: number
    threshold?: number
    attemptExplanation?: string
    dimensions?: PrescreenReviewDraftContext["dimensions"]
  },
  loadTurns: typeof loadPrescreenTurnsForDraft = loadPrescreenTurnsForDraft,
): Promise<PrescreenReviewDraftContext> {
  const [turns, jobCtx, candidateSignal] = await Promise.all([
    loadTurns(db, args.sessionId),
    loadPrescreenJobContext(db, args.jobId),
    loadPrescreenCandidateSignal(db, args.candidateId),
  ])
  return {
    ...args,
    ...jobCtx,
    candidateSignal,
    tone: selectRejectionTone(args),
    turns,
  }
}

/**
 * Generate the two-tier draft INLINE at terminal (Adam 2026-06-14) and store it on
 * the session as `review.autoDraft`. NEVER sends — a human still commits from the
 * dashboard. Fully fail-open: a draft/LLM error never breaks the terminal flow.
 * Idempotent-ish: callers pass `force` to refresh; default skips if a draft exists.
 */
export async function generateAndStorePrescreenAutoDraft(args: {
  db: Firestore
  sessionId: string
  candidateId: string
  jobId: string
  attemptId?: string
  terminal: "PASS" | "FAIL" | "HARD_STOP"
  proposedTerminal?: string
  score?: number
  scoreMax?: number
  threshold?: number
  attemptExplanation?: string
  terminalReason?: string
  dimensions?: PrescreenReviewDraftContext["dimensions"]
  now: string
  composeDraft?: typeof composePrescreenReviewCandidateMessage
  loadTurns?: typeof loadPrescreenTurnsForDraft
  log?: (event: string, payload?: Record<string, unknown>) => void
}): Promise<{ stored: boolean }> {
  const log = args.log ?? (() => {})
  try {
    const context = await buildPrescreenDraftContext(
      args.db,
      {
        sessionId: args.sessionId,
        candidateId: args.candidateId,
        jobId: args.jobId,
        finalTerminal: args.terminal,
        proposedTerminal: args.proposedTerminal,
        terminalReason: args.terminalReason,
        score: args.score,
        scoreMax: args.scoreMax,
        threshold: args.threshold,
        attemptExplanation: args.attemptExplanation,
        dimensions: args.dimensions,
      },
      args.loadTurns ?? loadPrescreenTurnsForDraft,
    )
    const composed = await (args.composeDraft ?? composePrescreenReviewCandidateMessage)(context)
    await args.db.collection("pa-prescreen-sessions").doc(args.sessionId).set(
      {
        review: {
          autoDraft: {
            candidateMessageBody: composed.candidateMessageBody,
            decisionReason: composed.decisionReason,
            recommendedActions: composed.recommendedActions,
            internalReviewNotes: composed.internalReviewNotes ?? composed.evidenceSummary,
            tone: composed.tone ?? context.tone ?? selectRejectionTone(context),
            finalTerminal: args.terminal,
            draftedBy: "auto_inline",
            draftedAt: args.now,
            ...(args.attemptId ? { evaluationAttemptId: args.attemptId } : {}),
          },
          updatedAt: args.now,
        },
        updatedAt: args.now,
      },
      { merge: true },
    )
    log("prescreen.auto_draft.stored", { sessionId: args.sessionId, terminal: args.terminal, tone: composed.tone })
    return { stored: true }
  } catch (err) {
    log("prescreen.auto_draft.failed", {
      sessionId: args.sessionId,
      error: err instanceof Error ? err.message : String(err),
    })
    return { stored: false }
  }
}

function buildPrescreenDraftEvidenceSummary(context: PrescreenReviewDraftContext): string {
  const lines: string[] = []
  if (context.attemptExplanation) lines.push(`attempt: ${context.attemptExplanation}`)
  if (context.terminalReason) lines.push(`terminal reason: ${context.terminalReason}`)
  for (const d of context.dimensions ?? []) {
    const dimension = cleanNonEmptyString(d.dimensionId)
    const rationale = cleanNonEmptyString(d.rationale)
    if (dimension || rationale) {
      lines.push(
        `dimension ${dimension ?? "unknown"} score=${d.score ?? "?"} confidence=${d.confidence ?? "?"}: ${rationale ?? ""}`,
      )
    }
  }
  for (const turn of context.turns.slice(0, 8)) {
    const qId = cleanNonEmptyString(turn.qId) ?? "question"
    const reply = cleanNonEmptyString(turn.reply)
    const summary = cleanNonEmptyString(turn.scored?.aggregate?.summary)
    if (reply || summary) {
      lines.push(`${qId}: reply="${(reply ?? "").slice(0, 220)}" summary="${(summary ?? "").slice(0, 220)}"`)
    }
  }
  return lines.join("\n").slice(0, 4_000)
}

export const PRESCREEN_REVIEW_DRAFT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  // OpenAI strict json_schema mode requires EVERY property in `required`.
  required: ["candidateMessageBody", "decisionReason", "recommendedActions", "evidenceSummary", "internalReviewNotes"],
  properties: {
    candidateMessageBody: {
      type: "string",
      description: "Candidate-facing iMessage body, 1-3 short sentences, no internal score/status jargon.",
    },
    decisionReason: {
      type: "string",
      description: "Candidate-visible reason for the decision, one concise sentence grounded only in evidence.",
    },
    recommendedActions: {
      type: "array",
      minItems: 1,
      maxItems: 3,
      items: { type: "string" },
      description: "Short candidate-visible action bullets. Avoid internal status jargon.",
    },
    evidenceSummary: {
      type: "string",
      description: "One short operator-facing summary of the evidence used for the draft.",
    },
    internalReviewNotes: {
      type: "string",
      description:
        "OPERATOR-ONLY (never shown to the candidate). A detailed per-tier cross-check against the job's recruiter checklist: for HARD / FIT / ANTI / BONUS and required skills, what the candidate showed vs needed (cite transcript/profile evidence), the single deciding gap, and the better-fit role type. Multi-line is fine.",
    },
  },
} as const

/** Tone-specific candidate-message instruction. Honest + warm + genuine, never fake (Adam 2026-06-14). */
function rejectionToneInstruction(tone: RejectionTone): string {
  switch (tone) {
    case "neutral_pass":
      return "The WeKruit team is moving this screen forward. Draft a warm next-step message in Claire's lowercase, friendly iMessage voice. Do NOT promise employment."
    case "strong_wrong_role":
      return [
        "Outcome: the hiring manager is not moving forward on THIS specific role, but the candidate is genuinely strong — just wrong-fit for this one.",
        "Draft candidateMessageBody in Claire's warm, lowercase, genuine iMessage voice. It MUST:",
        "- acknowledge ONE real, evidence-backed strength of theirs (no generic flattery, no invented praise),",
        "- be honest that the hiring manager passed on this specific role,",
        "- redirect to the kind/level of role they'd line up better with,",
        "- make retention explicit: they stay in the WeKruit pool, you'll keep matching them, and if a team's interested you'll text to set up an interview,",
        "- end with a soft opt-out note (they can reply STOP to pause matches).",
        "Never a cold form letter. Never mention scores, thresholds, PASS/FAIL, or internal systems.",
      ].join("\n")
    case "honest_underqualified":
    default:
      return [
        "Outcome: the candidate is genuinely under-qualified / not a fit for this role's hard requirements.",
        "Be HONEST and GENUINE — do NOT fake praise or pretend their background is strong when it isn't. But be WARM and kind, never demeaning.",
        "Draft candidateMessageBody in Claire's warm, lowercase iMessage voice. It MUST:",
        "- appreciate the time they put into the screen,",
        "- name the REAL fit gap plainly and kindly (the concrete must-have they're earlier on) — frame it as 'not the right match', not as a personal failing,",
        "- redirect constructively to the kind/level of role they WOULD be a stronger fit for,",
        "- keep them in the pool: you'll point better-fit roles their way, and if a team's interested you'll set up an interview,",
        "- end with a soft opt-out note (reply STOP anytime).",
        "Tell them where they CAN fit, not that they fell short. Never mention scores, thresholds, PASS/FAIL, or internal systems.",
      ].join("\n")
  }
}

async function composePrescreenReviewCandidateMessage(
  context: PrescreenReviewDraftContext,
): Promise<Pick<DraftPrescreenReviewMessage, "candidateMessageBody" | "decisionReason" | "recommendedActions" | "evidenceSummary" | "internalReviewNotes" | "tone">> {
  const openai = getOpenAIConfig()
  if (!openai.apiKey) {
    throw new HttpsError("failed-precondition", "PA_OPENAI_AGENT_API_KEY is required to draft prescreen review messages.")
  }
  const anthropic = getAnthropicConfig()
  const evidence = buildPrescreenDraftEvidenceSummary(context)
  const tone = context.tone ?? selectRejectionTone(context)
  const roleLine =
    context.jobTitle || context.company
      ? `Role: ${[context.jobTitle, context.company].filter(Boolean).join(" @ ")}`
      : null
  const userText = [
    `Session: ${context.sessionId}`,
    `Candidate: ${context.candidateId}`,
    `Job: ${context.jobId}`,
    roleLine,
    `AI proposed terminal: ${context.proposedTerminal ?? "unknown"}`,
    `Selected terminal: ${context.finalTerminal}`,
    typeof context.score === "number" && typeof context.scoreMax === "number"
      ? `Internal score: ${context.score}/${context.scoreMax}, threshold=${context.threshold ?? "unknown"}`
      : null,
    context.requiredSkills && context.requiredSkills.length > 0
      ? `Required skills: ${context.requiredSkills.join(", ")}`
      : null,
    "",
    "Recruiter checklist (the SAME hard/fit/anti/bonus tiers recruiters screen against — judge the candidate against these from the transcript/profile, do NOT trust any ticks):",
    context.checklistText || "(no recruiter checklist configured for this job)",
    "",
    context.candidateSignal ? `Candidate profile signal: ${context.candidateSignal}` : null,
    "",
    "Prescreen evidence (transcript + per-dimension scoring):",
    evidence || "(no detailed evidence captured)",
    "",
    rejectionToneInstruction(tone),
    "",
    "ALSO produce internalReviewNotes: an OPERATOR-ONLY detailed cross-check against the recruiter checklist above — per tier (HARD/FIT/ANTI/BONUS) and required skills, what the candidate showed vs needed with evidence, the single deciding gap, and the better-fit role type. This is never shown to the candidate, so it can be specific and direct.",
  ].filter((line): line is string => line !== null).join("\n")

  const result = await callWithFallback({
    apiKey: openai.apiKey,
    baseURL: openai.baseURL,
    anthropicApiKey: anthropic.apiKey ?? undefined,
    systemPrompt:
      "You draft WeKruit candidate iMessages after a prescreen, PLUS detailed operator-only review notes. " +
      "Return JSON only. The candidateMessageBody is sent to a real candidate over iMessage: warm, genuine, Claire's lowercase voice, " +
      "NEVER mention PASS, FAIL, HARD_STOP, scores, thresholds, internal review systems, or evaluation ids, and NEVER fake praise. " +
      "internalReviewNotes is operator-only and may be specific. Do not invent evidence. Do not include PII beyond what is given. " +
      "Keep the candidate message concise and editable by the operator.",
    userText,
    schemaName: "PrescreenReviewCandidateMessageDraft",
    schema: PRESCREEN_REVIEW_DRAFT_SCHEMA as unknown as Record<string, unknown>,
  })
  let parsed: {
    candidateMessageBody?: string
    decisionReason?: string
    recommendedActions?: unknown
    evidenceSummary?: string
    internalReviewNotes?: string
  }
  try {
    parsed = JSON.parse(result.rawJson)
  } catch {
    throw new HttpsError("internal", "LLM returned invalid JSON for prescreen review draft.")
  }
  const normalized = normalizePrescreenDraftDecision(context.finalTerminal, parsed, context)
  if (normalized.candidateMessageBody.length > 2_000) {
    throw new HttpsError("internal", "LLM returned an invalid candidate message draft.")
  }
  return { ...normalized, tone }
}

function normalizePrescreenDraftDecision(
  terminal: "PASS" | "FAIL" | "HARD_STOP",
  raw: {
    candidateMessageBody?: unknown
    decisionReason?: unknown
    recommendedActions?: unknown
    evidenceSummary?: unknown
    internalReviewNotes?: unknown
  },
  context: PrescreenReviewDraftContext,
): Pick<DraftPrescreenReviewMessage, "candidateMessageBody" | "decisionReason" | "recommendedActions" | "evidenceSummary" | "internalReviewNotes"> {
  const candidateMessageBody = cleanNonEmptyString(raw.candidateMessageBody)
  if (!candidateMessageBody || candidateMessageBody.length > 2_000) {
    throw new HttpsError("internal", "LLM returned an invalid candidate message draft.")
  }
  const evidenceSummary =
    cleanNonEmptyString(raw.evidenceSummary) ??
    buildPrescreenDraftEvidenceSummary(context).slice(0, 500)
  const decisionReason =
    cleanNonEmptyString(raw.decisionReason) ??
    defaultDecisionReason(terminal, evidenceSummary)
  const recommendedActions = cleanStringArray(raw.recommendedActions, 3, 160)
  const internalReviewNotes =
    cleanNonEmptyString(raw.internalReviewNotes)?.slice(0, 4_000) ?? evidenceSummary
  return {
    candidateMessageBody,
    decisionReason,
    recommendedActions: recommendedActions.length > 0 ? recommendedActions : defaultRecommendedActions(terminal),
    evidenceSummary,
    internalReviewNotes,
  }
}

function requirePrescreenCandidateMessage(
  raw: unknown,
  finalOutcome?: EvaluationOutcome,
): string {
  const terminal = finalOutcome?.prescreenTerminal
  if (terminal !== "PASS" && terminal !== "FAIL" && terminal !== "HARD_STOP") {
    throw new HttpsError(
      "invalid-argument",
      "finalOutcome.prescreenTerminal must be PASS, FAIL, or HARD_STOP for prescreen review approval.",
    )
  }
  const body = typeof raw === "string" ? raw.trim() : ""
  if (!body) {
    throw new HttpsError(
      "invalid-argument",
      "candidateMessageBody is required when approving or overriding a prescreen review.",
    )
  }
  return body
}

function hasReviewProfileSignal(user: Record<string, unknown>): boolean {
  if (typeof user.latestResumeArtifactId === "string" && user.latestResumeArtifactId.trim()) return true
  if (typeof user.linkedinUrl === "string" && user.linkedinUrl.trim()) return true
  if (user.linkedinOauthLinked === true) return true
  const resumeParseCount = user.resumeParseCount
  if (typeof resumeParseCount === "number" && Number.isFinite(resumeParseCount) && resumeParseCount > 0) {
    return true
  }
  return false
}

async function augmentRejectedPrescreenCandidateMessage(args: {
  db: Firestore
  userId: string
  body: string
  reason: string
}): Promise<string> {
  const normalized = args.body.toLowerCase()
  const prefix = hasConcreteRejectionReason(args.body)
    ? null
    : `WeKruit team notes: this specific role probably is not moving forward because ${args.reason}.`
  const additions: string[] = []
  if (!/\blinkedin\b|\bresume\b|\brésumé\b/.test(normalized)) {
    let profileSignalOnFile = false
    try {
      const snap = await args.db.collection(PA_COLLECTIONS.users).doc(args.userId).get()
      profileSignalOnFile = hasReviewProfileSignal((snap.data() ?? {}) as Record<string, unknown>)
    } catch {
      profileSignalOnFile = false
    }
    additions.push(
      profileSignalOnFile
        ? "I have your resume/LinkedIn signal on file and will keep using it with this screen context for future collaboration roles."
        : "If you add your LinkedIn or resume, I can pull your experience into your profile and pitch future collaboration roles with more context.",
    )
  }
  if (!/matching recommendations|match recommendations|send.*recommend|recommend.*role|matching role/i.test(args.body)) {
    additions.push("Want me to send matching recommendations too?")
  }
  if (!prefix && additions.length === 0) return args.body
  return [prefix, args.body.replace(/\s+$/g, ""), ...additions].filter(Boolean).join(" ")
}

function hasConcreteRejectionReason(body: string): boolean {
  return /\b(because|reason|gap|missing|not enough|did not show|didn't show|lacked|needs?|weaker|ownership|experience|evidence)\b/i.test(body)
}

function cleanCandidateReason(value: string): string {
  return value
    .replace(/\s+/g, " ")
    .replace(/^(attempt|terminal reason|dimension [^:]+):\s*/i, "")
    .replace(/[.!?\s]+$/g, "")
    .trim()
    .slice(0, 240)
}

function buildRejectedPrescreenReason(attempt: EvaluationAttempt, decisionReason?: string): string {
  const explicit = cleanNonEmptyString(decisionReason)
  if (explicit) return cleanCandidateReason(explicit)

  const blockingGate = attempt.gates.find((gate) => gate.status !== "pass" && cleanNonEmptyString(gate.rationale))
  if (blockingGate?.rationale) return cleanCandidateReason(blockingGate.rationale)

  const weakestDimension = [...attempt.dimensions]
    .filter((dimension) => cleanNonEmptyString(dimension.rationale) || dimension.missingEvidence.length > 0)
    .sort((a, b) => a.score - b.score)[0]
  if (weakestDimension) {
    const missing = weakestDimension.missingEvidence.find((item) => cleanNonEmptyString(item))
    if (missing) return cleanCandidateReason(missing)
    if (weakestDimension.rationale) return cleanCandidateReason(weakestDimension.rationale)
  }

  const missingEvidence = attempt.missingEvidence.find((item) => cleanNonEmptyString(item))
  if (missingEvidence) return cleanCandidateReason(missingEvidence)

  const evidenceSummary = attempt.evidence.find((item) => cleanNonEmptyString(item.summary))?.summary
  if (evidenceSummary) return cleanCandidateReason(evidenceSummary)

  const explanation = cleanNonEmptyString(attempt.explanation)
  if (explanation && !/looks good|pass|move forward/i.test(explanation)) return cleanCandidateReason(explanation)
  return "the screen did not show enough direct evidence for the role's required experience"
}

function resolveFinalOutcome(
  input: ReviewEvaluationAttemptInput,
  attempt: EvaluationAttempt,
): EvaluationOutcome | undefined {
  const inputOutcome = normalizeReviewFinalOutcome(input.finalOutcome, attempt)
  if (input.status === "approved") return inputOutcome ?? attempt.proposedOutcome
  if (input.status === "overridden") {
    if (!inputOutcome) {
      throw new HttpsError("invalid-argument", "finalOutcome is required when overriding an evaluation.")
    }
    return inputOutcome
  }
  return inputOutcome
}

function normalizeReviewFinalOutcome(
  raw: unknown,
  attempt: EvaluationAttempt,
): EvaluationOutcome | undefined {
  if (raw === undefined) return undefined
  const canonical = EvaluationOutcomeSchema.safeParse(raw)
  if (canonical.success) return canonical.data
  const terminalOnly = PrescreenTerminalOutcomeInputSchema.safeParse(raw)
  if (terminalOnly.success) {
    if (attempt.source !== "prescreen" || attempt.purpose !== "employment_prescreen") {
      throw new HttpsError(
        "invalid-argument",
        "finalOutcome.prescreenTerminal-only input is only valid for prescreen review approval.",
      )
    }
    return {
      kind: terminalOnly.data.prescreenTerminal === "PASS" ? "pass" : "reject",
      prescreenTerminal: terminalOnly.data.prescreenTerminal,
    }
  }
  throw new HttpsError("invalid-argument", "finalOutcome must be a valid evaluation outcome.")
}

async function commitPrescreenOutcome(args: {
  db: Firestore
  attempt: EvaluationAttempt
  finalOutcome?: EvaluationOutcome
  candidateMessageBody: string
  decisionReason?: string
  recommendedActions?: string[]
  reviewedAt: string
  reviewer: string
  reviewStatus: "approved" | "overridden"
  markPrescreenOutcome: typeof markPrescreenTerminalOutcome
  sendSms: typeof sendRuntimeApprovedIMessage
  sendSchedulingInvite: typeof sendProactiveSchedulingInvite
}): Promise<{ committed: boolean; outboundId?: string; candidateDecision?: PrescreenCandidateDecision }> {
  const terminal = args.finalOutcome?.prescreenTerminal
  if (
    (terminal !== "PASS" && terminal !== "FAIL" && terminal !== "HARD_STOP") ||
    !args.attempt.prescreenSessionId ||
    !args.attempt.candidateId ||
    !args.attempt.jobId
  ) {
    return { committed: false }
  }
  const snap = await args.db.collection("pa-prescreen-sessions").doc(args.attempt.prescreenSessionId).get()
  const data = snap.data() ?? {}
  const toE164 = typeof data.e164 === "string" ? data.e164 : ""
  if (!toE164) {
    throw new HttpsError("failed-precondition", `Prescreen session ${args.attempt.prescreenSessionId} has no e164.`)
  }
  await args.markPrescreenOutcome({
    db: args.db,
    sessionId: args.attempt.prescreenSessionId,
    terminal,
    userId: args.attempt.candidateId,
    jobId: args.attempt.jobId,
    occurredAt: args.reviewedAt,
  })
  const candidateMessageBody = terminal === "PASS"
    ? args.candidateMessageBody
    : await augmentRejectedPrescreenCandidateMessage({
        db: args.db,
        userId: args.attempt.candidateId,
        body: args.candidateMessageBody,
        reason: buildRejectedPrescreenReason(args.attempt, args.decisionReason),
      })

  const sent = await args.sendSms({
    db: args.db,
    userId: args.attempt.candidateId,
    to: toE164,
    content: candidateMessageBody,
    runtimeSource: "pa_operator_review",
    idempotencyKey: `prescreen_review_decision:${args.attempt.attemptId}`,
  })
  const outboundId = typeof sent.outboundId === "string" ? sent.outboundId : undefined
  const candidateDecision = buildPrescreenCandidateDecision({
    candidateMessageBody,
    decisionReason: args.decisionReason,
    recommendedActions: args.recommendedActions,
    finalTerminal: terminal,
    reviewedAt: args.reviewedAt,
    outboundId,
  })
  await args.db.collection("pa-prescreen-sessions").doc(args.attempt.prescreenSessionId).set(
    {
      terminalActionPendingReview: false,
      review: {
        status: args.reviewStatus,
        evaluationAttemptId: args.attempt.attemptId,
        finalTerminal: terminal,
        reviewedAt: args.reviewedAt,
        reviewer: args.reviewer,
        ...(outboundId ? { decisionOutboundId: outboundId } : {}),
        candidateDecision,
        updatedAt: args.reviewedAt,
      },
      ...(outboundId ? { reviewDecisionOutboundId: outboundId } : {}),
      reviewDecisionAt: args.reviewedAt,
      updatedAt: args.reviewedAt,
    },
    { merge: true },
  )
  await args.db.collection(PA_COLLECTIONS.evaluationAttempts).doc(args.attempt.attemptId).set(
    {
      downstreamCommit: {
        kind: "prescreen_human_review",
        terminal,
        committedAt: args.reviewedAt,
        ...(outboundId ? { outboundId } : {}),
      },
      updatedAt: args.reviewedAt,
    },
    { merge: true },
  )

  // GAP 1 — proactive interview invite on a PASS commit. Runs AFTER the durable
  // writes (employer-visible profile now exists → the job is schedulable) and is
  // gated/idempotent/fail-open inside sendProactiveSchedulingInvite: at the live
  // default it only fires for the dev uids, NEVER throws, and never double-invites.
  // A failure must not affect the already-committed PASS, so it is fully isolated.
  if (terminal === "PASS") {
    try {
      await args.sendSchedulingInvite({
        db: args.db,
        candidateId: args.attempt.candidateId,
        jobId: args.attempt.jobId,
        toE164,
        sessionId: args.attempt.prescreenSessionId,
        nowIso: args.reviewedAt,
      })
    } catch {
      /* fail-open — the PASS is already committed; the invite is best-effort. */
    }
  }

  return { committed: true, outboundId, candidateDecision }
}

function buildPrescreenCandidateDecision(args: {
  candidateMessageBody: string
  decisionReason?: unknown
  recommendedActions?: unknown
  finalTerminal: "PASS" | "FAIL" | "HARD_STOP"
  reviewedAt: string
  outboundId?: string
}): PrescreenCandidateDecision {
  const decisionReason =
    cleanNonEmptyString(args.decisionReason) ??
    defaultDecisionReason(args.finalTerminal, args.candidateMessageBody)
  const recommendedActions = cleanStringArray(args.recommendedActions, 5, 240)
  return {
    candidateMessageBody: args.candidateMessageBody,
    decisionReason,
    recommendedActions,
    finalTerminal: args.finalTerminal,
    reviewedAt: args.reviewedAt,
    ...(args.outboundId ? { decisionOutboundId: args.outboundId } : {}),
  }
}

function cleanStringArray(value: unknown, maxItems: number, maxLength: number): string[] {
  if (!Array.isArray(value)) return []
  const out: string[] = []
  for (const item of value) {
    const cleaned = cleanNonEmptyString(item)
    if (cleaned) out.push(cleaned.slice(0, maxLength))
    if (out.length >= maxItems) break
  }
  return out
}

function defaultDecisionReason(terminal: "PASS" | "FAIL" | "HARD_STOP", evidence: string): string {
  if (terminal === "PASS") return "The screen showed enough role-relevant evidence to move to the next step."
  const cleaned = evidence.replace(/\s+/g, " ").trim()
  if (cleaned) return cleaned.slice(0, 240)
  return "This screen did not show enough direct evidence for this specific role."
}

function defaultRecommendedActions(terminal: "PASS" | "FAIL" | "HARD_STOP"): string[] {
  if (terminal === "PASS") {
    return ["Watch for the next WeKruit message.", "Keep your profile details current."]
  }
  return [
    "Add LinkedIn or a resume so future collaboration roles can be pitched with more context.",
    "Say yes if you want Claire to send matching recommendations.",
    "Add a concrete example that shows the target experience.",
  ]
}

async function commitExternalSupplyProjection(args: {
  db: Firestore
  attempt: EvaluationAttempt
  finalOutcome?: EvaluationOutcome
  reviewer: string
  reviewedAt: string
  note?: string
}): Promise<boolean> {
  const finalTier = args.finalOutcome?.supplyTier
  if (!finalTier || !args.attempt.externalEvaluationId) return false
  await args.db
    .collection(PA_COLLECTIONS.candidateCompanyJobEvaluations)
    .doc(args.attempt.externalEvaluationId)
    .set(
      {
        reviewerDecision: {
          finalTier,
          reviewer: args.reviewer,
          reviewedAt: args.reviewedAt,
          ...(args.note ? { note: args.note } : {}),
        },
        updatedAt: args.reviewedAt,
      },
      { merge: true },
    )
  return true
}

export const paReviewEvaluationAttempt = onCall(
  {
    region: "us-central1",
    memory: "256MiB",
    timeoutSeconds: 60,
    // Cal.com + Mailgun power the Gap-1 proactive interview invite on a PASS
    // commit (sendProactiveSchedulingInvite → buildInterviewOffer reads
    // process.env.CALCOM_API_KEY; the confirmation/invite path reads MAILGUN_*).
    // The invite is gated/fail-open: an UNSET CALCOM_API_KEY just makes the offer
    // return calcom_unavailable → no invite, commit unaffected.
    secrets: [CALCOM_API_KEY, MAILGUN_API_KEY, MAILGUN_DOMAIN, MAILGUN_FROM, MAILGUN_REGION],
  },
  async (req): Promise<ReviewEvaluationAttemptResult> => {
    // Populate process.env so the scheduling offer/invite reads them lazily. A
    // missing secret is tolerated (fail-open) — never throws into the commit.
    for (const s of [CALCOM_API_KEY, MAILGUN_API_KEY, MAILGUN_DOMAIN, MAILGUN_FROM, MAILGUN_REGION] as const) {
      try {
        const v = s.value().trim()
        if (v) process.env[s.name] = v
      } catch {
        /* secret unset → leave env as-is; invite fails open */
      }
    }
    return runReviewEvaluationAttempt(req.data, req.auth, { db: getFirestore() })
  },
)

export const paDraftPrescreenReviewMessages = onCall(
  {
    region: "us-central1",
    memory: "512MiB",
    timeoutSeconds: 120,
    secrets: [PA_OPENAI_AGENT_API_KEY, ANTHROPIC_API_KEY],
  },
  async (req): Promise<DraftPrescreenReviewMessagesResult> => {
    try {
      const openAiKey = PA_OPENAI_AGENT_API_KEY.value().trim()
      if (openAiKey) process.env.PA_OPENAI_AGENT_API_KEY = openAiKey
      else delete process.env.PA_OPENAI_AGENT_API_KEY
    } catch {
      delete process.env.PA_OPENAI_AGENT_API_KEY
    }
    try {
      const anthropicKey = ANTHROPIC_API_KEY.value().trim()
      if (anthropicKey && anthropicKey !== "__UNSET__") process.env.ANTHROPIC_API_KEY = anthropicKey
      else delete process.env.ANTHROPIC_API_KEY
    } catch {
      delete process.env.ANTHROPIC_API_KEY
    }
    return runDraftPrescreenReviewMessages(req.data, req.auth, { db: getFirestore() })
  },
)
