/**
 * v1.8 Phase 77.4 — paPrescreenTurn (subsequent reply handler).
 *
 * Inbound coalescer calls `runPrescreenTurnIfActive(db, userId, reply, lang)`
 * BEFORE claimer → Claire orchestrator. If there's an active (terminal=null)
 * prescreen session for the user, we route the reply through
 * PreScreenPipeline.runTurn and short-circuit. Otherwise return ok:false
 * so the coalescer falls through to Claire as normal.
 *
 * Wires:
 *   - FirestorePreScreenStore (reads + writes pa-prescreen-sessions)
 *   - PreScreenQuestion bindings from session.cfgSnapshot
 *   - KeywordSetLlmCaller (production gpt-5.4-nano + Sonnet fallback)
 *   - runtime-approved outbox for outbound text
 */
import { createHash } from "node:crypto"
import type { Firestore } from "firebase-admin/firestore"
import {
  AI_USAGE_SHARED_KEY,
  applyPartialUserTags,
  isRegisteredSharedKey,
  mergeUserPrescreenSharedAnswers,
  type PartialUserTags,
  KeywordSetJudge,
  PreScreenPipeline,
  WEKRUIT_CANDIDATE_SOURCE,
  buildKeywordSetPrompt,
  buildSharedOnboardingPrompt,
  buildSharedOnboardingPromptContext,
  buildSharedOnboardingStartedState,
  hardFilterClarifyText,
  isPrescreenSessionPastMaxAge,
  isSharedOnboardingSlotSatisfied,
  loadSharedOnboardingParsedResumeForPrompt,
  type KeywordSetLlmCaller,
  type KeywordSetLlmOutput,
  type KeywordSpec,
  type PreScreenClarifyComposer,
  type PreScreenQuestion,
  type PreScreenState,
  type PreScreenStateProvider,
  type SharedOnboardingQuestionId,
} from "@pa/pa-orchestrator"
import { DEFAULT_ONBOARDING_SLOTS } from "./claire-agent/reducers/onboarding-fsm.js"
import { AI_QUESTION_QID } from "./claire-agent/prescreen-ai-question.js"
import { isClaireEntryUxCanary, isPrescreenRetentionHandoffCanary } from "./claire-agent/canary.js"
import {
  isStaleClosedPrescreenSession,
  buildStalePrescreenSweepPatch,
  buildStalePrescreenSweepTurn,
} from "./prescreen-staleness.js"
import { classifyInboundReplyNeed } from "./sendblue/ack-classifier.js"
import { PA_COLLECTIONS } from "@pa/core-types"
import { SAFETY_CANNED_REPLIES, pickLangForSafety, runSafetyCheck } from "@pa/pa-safety"
import { sendRuntimeApprovedIMessage } from "./runtime-approved-outbox.js"
import {
  defaultGenerateJobRecs,
  runPrescreenTerminalAction,
  writePrescreenMemoryUpdate,
} from "./prescreen-terminal-action.js"
import { isLayoffIntakeActiveForUser } from "./layoff-sms-start.js"
import {
  finalizePrescreenForHumanReview,
  type PrescreenHumanReviewTerminal,
} from "./prescreen-review-finalization.js"
import type { MarkPrescreenReviewPendingArgs } from "./prescreen-outcome-service.js"
import {
  isAgenticPrescreenEnabled,
  runAgenticPrescreenTurn,
  type AgenticRunTurnResult,
} from "./prescreen-agentic-turn.js"
import { isClaireVoiceDevPhone } from "./voice/dev-phone-gate.js"
import { isExplicitVoicePrescreenRequest } from "./claire-agent/voice-prescreen-request-router.js"
import { parseLowInfoCallConfirmation } from "./claire-agent/voice-call-ack-guard.js"

const ACTIVE_PRESCREEN_TIMEOUT_MS = 21 * 24 * 60 * 60 * 1000
const RECENT_TERMINAL_PRESCREEN_GUARD_MS = 60 * 60 * 1000

type RuntimeSmsSender = (args: {
  to: string
  content: string
  userId?: string
  db?: Firestore
  runtimeSource?: string
  idempotencyKey?: string
}) => Promise<unknown>

function stablePrescreenSendKey(...parts: string[]): string {
  return createHash("sha256").update(parts.join("|"), "utf8").digest("hex").slice(0, 32)
}

/**
 * True when an inbound media URL is an image attachment (screenshot proof),
 * NOT a document we already ingest (PDF résumé). Conservative: any non-PDF
 * media is treated as an image for the proof-guard. A PDF flows through the
 * normal CV-ingest path and is not handled here.
 */
function isLikelyImageMediaUrl(mediaUrl: string | undefined | null): boolean {
  if (typeof mediaUrl !== "string" || !mediaUrl.trim()) return false
  const u = mediaUrl.trim().toLowerCase()
  if (/\.pdf(\?|#|$)/.test(u)) return false
  if (/\.(png|jpe?g|gif|heic|heif|webp|bmp|tiff?)(\?|#|$)/.test(u)) return true
  // No extension (Sendblue CDN URLs often omit one) → assume image for the guard.
  return true
}

/** Firestore-backed PreScreenStateProvider. */
class FirestorePreScreenStore implements PreScreenStateProvider {
  constructor(private readonly db: Firestore) {}
  async load(sessionId: string): Promise<PreScreenState | null> {
    const snap = await this.db.collection("pa-prescreen-sessions").doc(sessionId).get()
    if (!snap.exists) return null
    const data = snap.data()
    if (!data) return null
    return data as PreScreenState
  }
  async save(state: PreScreenState): Promise<void> {
    // v1.9 hotfix — Firestore Admin SDK rejects `undefined` field values
    // unless ignoreUndefinedProperties is set. KeywordSetJudge omits
    // optional fields (abortHint, etc.) as undefined, which then propagate
    // into state.questions[qId].scored.abortHint. Strip undefined recursively
    // before write so save never throws "Cannot use \"undefined\"".
    await this.db
      .collection("pa-prescreen-sessions")
      .doc(state.sessionId)
      .set(stripUndefined(state) as PreScreenState, { merge: false })
  }
}

/** Recursively drop keys whose value is `undefined`. Preserves null. */
function stripUndefined<T>(v: T): T {
  if (v === null || v === undefined) return v
  if (Array.isArray(v)) {
    return v.map((x) => stripUndefined(x)) as unknown as T
  }
  if (typeof v === "object") {
    const out: Record<string, unknown> = {}
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (val === undefined) continue
      out[k] = stripUndefined(val)
    }
    return out as T
  }
  return v
}

/** Production LLM caller — gpt-5.4-nano JSON-mode. */
function makeProductionKeywordSetCaller(candidateContext = ""): KeywordSetLlmCaller {
  return {
    async score({ reply, lang, keywords, questionPrompt, candidateContext: perCall }) {
      const apiKey = process.env.PA_OPENAI_AGENT_API_KEY ?? process.env.OPENAI_API_KEY
      if (!apiKey) throw new Error("missing OpenAI API key")
      const { system, user } = buildKeywordSetPrompt({
        reply,
        lang,
        keywords,
        questionPrompt,
        candidateContext: perCall ?? candidateContext,
      })
      const res = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model: "gpt-5.4-nano",
          messages: [
            { role: "system", content: system },
            { role: "user", content: user },
          ],
          temperature: 0,
          response_format: { type: "json_object" },
        }),
      })
      if (!res.ok) throw new Error(`OpenAI ${res.status}: ${await res.text().catch(() => "?")}`)
      const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> }
      const content = json.choices?.[0]?.message?.content
      if (!content) throw new Error("OpenAI empty response")
      return JSON.parse(content) as KeywordSetLlmOutput
    },
  }
}

/** One-paragraph candidate context (résumé + profile) for the prescreen judge/clarify. Best-effort; "" on any miss. */
async function buildPrescreenCandidateContext(
  db: FirebaseFirestore.Firestore,
  userId: string,
): Promise<string> {
  try {
    const userSnap = await db.collection(PA_COLLECTIONS.users).doc(userId).get()
    const user = (userSnap.data() ?? {}) as Record<string, unknown>
    const tags = (user.tags ?? {}) as Record<string, unknown>
    const lines: string[] = []
    const role = (tags.recentRoleTitle ?? user.recentRoleTitle) as unknown
    const company = (tags.recentCompany ?? user.recentCompany) as unknown
    if (role || company) {
      lines.push(`Current/recent: ${[role, company].filter(Boolean).join(" @ ")}`)
    }
    if (Array.isArray(tags.yoeRange) && tags.yoeRange.length === 2) {
      lines.push(`YoE: ${tags.yoeRange[0]}-${tags.yoeRange[1]}`)
    }
    if (typeof tags.workHistorySummary === "string" && tags.workHistorySummary.trim()) {
      lines.push(`History: ${String(tags.workHistorySummary).slice(0, 400)}`)
    }
    // tags.skills is an array of Skill objects ({ name, bucket, ... }), not strings.
    if (Array.isArray(tags.skills) && tags.skills.length) {
      const skillNames = (tags.skills as unknown[])
        .map((s) => (typeof s === "string" ? s : (s as Record<string, unknown> | null)?.name))
        .filter((n): n is string => typeof n === "string" && n.length > 0)
        .slice(0, 20)
      if (skillNames.length) lines.push(`Skills: ${skillNames.join(", ")}`)
    }
    const parsedResume = await loadSharedOnboardingParsedResumeForPrompt(db, userId, user).catch(() => null)
    if (parsedResume) {
      const r = parsedResume as Record<string, unknown>
      // Parsed-resume summary lives under one of these keys (see summaryTextFrom).
      const summary =
        r.candidateProfileSummary ?? r.profileSummary ?? r.resumeSummary ?? r.summary
      if (typeof summary === "string" && summary.trim()) {
        lines.push(`Résumé summary: ${summary.slice(0, 400)}`)
      }
    }
    return lines.join("\n").slice(0, 1200)
  } catch {
    return ""
  }
}

/** Production LLM caller — gpt-5.4-nano JSON-mode (keyword-set judge). */
function makeProductionClarifyComposer(candidateContext = ""): PreScreenClarifyComposer {
  return async (input) => {
    const hardFilterText = hardFilterClarifyText(input.question.qId, input.lang)
    if (hardFilterText) return hardFilterText

    const apiKey = process.env.PA_OPENAI_AGENT_API_KEY ?? process.env.OPENAI_API_KEY
    if (!apiKey) throw new Error("missing OpenAI API key")

    const weakCells = [...input.merged.perKeyword]
      .filter((cell) => Number.isFinite(cell.match) && cell.match < 0.75)
      .sort((a, b) => a.match - b.match)
      .slice(0, 4)
      .map((cell) => ({
        keyword: cell.keyword,
        match: Number(cell.match.toFixed(2)),
        confidence: Number(cell.confidence.toFixed(2)),
        evidence: cell.evidence,
        reasoning: cell.reasoning,
      }))

    const sessionEvidence = prescreenSessionEvidenceContext(input.state, input.question.qId)
    const qSpecificGuidance = prescreenClarifyRoundGuidance(input.clarifyRound, input.lang, input.question.qId)

    const system = [
      "You are Claire, a candidate prescreening agent.",
      "Write ONE warm iMessage follow-up that probes like a thoughtful recruiter friend learning the candidate's story.",
      "Do not reject the candidate. Do not conclude fit. Do not repeat the prior generic clarify wording.",
      "Do not start with the same generic acknowledgment every round; avoid repeated 'That's helpful' / 'That helps' openers.",
      "Use the candidate's latest answer and weak evidence to ask the next most useful detail.",
      "Do not ask a checklist. Pick one natural angle: their role, technical depth, systems touched, tradeoff, failure, user/customer impact, or measurable outcome.",
      "Do not ask for business impact, ownership, systems touched, or validation again if the session evidence already covers it. Ask for the missing signal instead.",
      "For technical-depth questions, prefer the weakest required technology or implementation detail; do not drift back to role-fit impact/ownership unless that is the only missing signal.",
      "If the candidate has signaled they cannot produce the artifact, or the profile/résumé context already answers this, do NOT keep probing the same point — acknowledge and move on.",
      "Keep it under 360 characters. Output strict JSON only: {\"text\":\"...\"}.",
    ].join("\n")

    const userMsg = [
      `Language: ${input.lang}`,
      `Question id: ${input.question.qId}`,
      `Original question: ${input.question.prompt[input.lang]}`,
      `Clarify round for this same question: ${input.clarifyRound}`,
      `Required probe angle for this round: ${qSpecificGuidance}`,
      `Reason: ${input.reason}`,
      `Latest candidate reply: """${input.reply}"""`,
      `Prior answers for this same question: ${JSON.stringify(input.state.questions[input.question.qId]?.evidenceReplies ?? [])}`,
      `Already-covered session evidence from other questions: ${sessionEvidence}`,
      `Merged score: s=${input.merged.aggregate.s.toFixed(2)} c=${input.merged.aggregate.c.toFixed(2)} summary=${input.merged.aggregate.summary}`,
      `Weak or missing areas JSON: ${JSON.stringify(weakCells)}`,
      candidateContext
        ? `Candidate résumé/profile context (don't re-ask what this already proves):\n${candidateContext}`
        : "",
      `If unsure, use this fallback intent without copying it verbatim: ${input.fallbackText}`,
    ]
      .filter(Boolean)
      .join("\n")

    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: "gpt-5.4-nano",
        messages: [
          { role: "system", content: system },
          { role: "user", content: userMsg },
        ],
        temperature: 0.2,
        response_format: { type: "json_object" },
      }),
    })
    if (!res.ok) throw new Error(`OpenAI clarify ${res.status}: ${await res.text().catch(() => "?")}`)
    const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> }
    const content = json.choices?.[0]?.message?.content
    if (!content) throw new Error("OpenAI clarify empty response")
    const parsed = JSON.parse(content) as { text?: unknown }
    if (typeof parsed.text !== "string" || !parsed.text.trim()) throw new Error("OpenAI clarify missing text")
    return normalizePrescreenClarifyTextForRound(parsed.text, input.clarifyRound, input.lang)
  }
}

export function prescreenClarifyRoundGuidance(round: number, _lang: "zh" | "en", qId?: string): string {
  const normalizedRound = Math.max(1, Math.floor(round))
  if (qId === "technical_depth") {
    if (normalizedRound === 1) return "Probe the weakest required technology or implementation detail; do not repeat role-fit impact/ownership."
    if (normalizedRound === 2) return "Probe concrete engineering depth: code, data, APIs, debugging, or architecture tradeoff; avoid re-asking business impact."
    if (normalizedRound === 3) return "Confirm the technical gap: whether they used the required tech, depth of use, and what they did not own."
    return "Final technical check: smallest provable shipped technical work or explicit gap; do not circle back to project impact."
  }
  if (normalizedRound === 1) return "Find the closest relevant project: context, personal ownership, and user or business outcome."
  if (normalizedRound === 2) return "Probe ownership and system boundary: what they personally built, and which systems or data it touched."
  if (normalizedRound === 3) return "Probe the hardest failure, tradeoff, or validation: what broke, what they changed, and how they knew it worked."
  return "Final concrete check: smallest provable shipped work, measurable result, or explicit gap; do not keep circling."
}

export function prescreenSessionEvidenceContext(
  state: { questions?: Record<string, { evidenceReplies?: unknown }> },
  activeQId: string,
): string {
  const rows: string[] = []
  for (const [qId, qState] of Object.entries(state.questions ?? {})) {
    if (qId === activeQId) continue
    const replies = Array.isArray(qState?.evidenceReplies) ? qState.evidenceReplies : []
    const cleanReplies = replies
      .filter((reply): reply is string => typeof reply === "string")
      .map((reply) => reply.replace(/\s+/g, " ").trim())
      .filter(Boolean)
      .slice(-3)
    if (!cleanReplies.length) continue
    rows.push(`${qId}: ${cleanReplies.join(" | ")}`.slice(0, 1200))
  }
  return rows.length ? rows.join("\n") : "none"
}

export function normalizePrescreenClarifyTextForRound(text: string, round: number, _lang: "zh" | "en"): string {
  const normalized = text.replace(/\s+/g, " ").trim()
  if (!normalized) return normalized

  const openerByRound = [
    "Got it - ",
    "The ownership piece matters here - ",
    "The systems detail is the useful signal - ",
    "One last concrete check before I score it - ",
  ]
  const idx = Math.min(Math.max(1, Math.floor(round)), openerByRound.length) - 1

  const genericAckPattern =
    /^(that'?s helpful|that is helpful|that helps|thanks|thank you|got it|interesting|nice)[\s,.:;!—-]*/i

  if (!genericAckPattern.test(normalized)) return normalized

  const withoutAck = normalized.replace(genericAckPattern, "").trim()
  if (!withoutAck) return normalized
  const replacement = `${openerByRound[idx]}${withoutAck.charAt(0).toLowerCase()}${withoutAck.slice(1)}`
  return replacement
}

/**
 * Find active prescreen session for a user (terminal=null). Returns
 * sessionId or null if none.
 */
type ActivePrescreenLookup =
  | { kind: "none" }
  | { kind: "active"; sessionId: string }
  | { kind: "expired"; sessionId: string; jobId: string }
  | { kind: "recent_terminal"; sessionId: string; jobId: string; terminal: string }

async function findActiveSession(
  db: Firestore,
  userId: string,
  opts: {
    nowMs?: number
    log?: (event: string, payload: Record<string, unknown>) => void
  } = {},
): Promise<ActivePrescreenLookup> {
  const snap = await db
    .collection("pa-prescreen-sessions")
    .where("userId", "==", userId)
    .where("terminal", "==", null)
    .get()
  if (snap.empty) return { kind: "none" }
  const candidates = [...snap.docs].sort((a, b) => {
    const aData = a.data() as Record<string, unknown>
    const bData = b.data() as Record<string, unknown>
    const aMs = timestampMs(aData.updatedAt) ?? timestampMs(aData.createdAt) ?? 0
    const bMs = timestampMs(bData.updatedAt) ?? timestampMs(bData.createdAt) ?? 0
    return bMs - aMs
  })
  const doc = candidates[0]!
  const data = doc.data() as Record<string, unknown>
  const lastActiveMs = timestampMs(data.updatedAt) ?? timestampMs(data.createdAt)
  const createdAtMs = timestampMs(data.createdAt)
  const nowMs = opts.nowMs ?? Date.now()
  const inactivityExpired = lastActiveMs !== null && nowMs - lastActiveMs > ACTIVE_PRESCREEN_TIMEOUT_MS
  // Zombie-prescreen fix (Adam 2026-06-21): a createdAt-keyed absolute age cap that the
  // clarify-loop updatedAt self-refresh CANNOT poison. Without it a session stuck on Q1
  // re-bumps its own updatedAt on every captured turn → the inactivity clock never fires
  // → it hijacks unrelated future inbounds (job-rec "yes") into prescreen probes forever.
  const pastMaxAge = isPrescreenSessionPastMaxAge(createdAtMs, nowMs)
  if (inactivityExpired || pastMaxAge) {
    const nowIso = new Date(nowMs).toISOString()
    const createdAtIso = createdAtMs !== null ? new Date(createdAtMs).toISOString() : null
    const ageMs = createdAtMs !== null ? nowMs - createdAtMs : null
    // CANCEL CONTEXT CLEANLY (Adam 2026-06-21 #2): one canonical stale-closed terminal patch so the
    // session is truly closed for routing — no detector re-picks it, and the stale-closed copy path
    // narrates it as "timed out" (never "under review"). expiryNoticeSentAt is stamped LATER, on the
    // turn that actually sends the candidate notice (the one-time idempotency gate).
    await doc.ref.set(buildStalePrescreenSweepPatch(nowIso), { merge: true })
    // STORE PROPERLY (Adam 2026-06-21 #3): an auditable expiry record in the session's turns
    // subcollection — best-effort, never blocks the sweep.
    try {
      await doc.ref.collection("turns").add(
        buildStalePrescreenSweepTurn({ createdAtIso, nowIso, ageMs, detector: "find_active_session" }),
      )
    } catch (err) {
      opts.log?.("prescreen.turn.expired_audit_write_failed", {
        userId,
        sessionId: doc.id,
        error: err instanceof Error ? err.message : String(err),
      })
    }
    opts.log?.("prescreen.turn.expired_inactive_session", {
      userId,
      sessionId: doc.id,
      lastActiveAt: lastActiveMs !== null ? new Date(lastActiveMs).toISOString() : null,
      timeoutMinutes: ACTIVE_PRESCREEN_TIMEOUT_MS / 60_000,
      reason: pastMaxAge ? "max_age" : "inactivity",
      ageMs,
      ...(createdAtIso !== null ? { createdAt: createdAtIso } : {}),
    })
    return {
      kind: "expired",
      sessionId: doc.id,
      jobId: typeof data.jobId === "string" ? data.jobId : "",
    }
  }
  return { kind: "active", sessionId: doc.id }
}

async function findRecentTerminalSession(
  db: Firestore,
  userId: string,
  opts: {
    nowMs?: number
    log?: (event: string, payload: Record<string, unknown>) => void
  } = {},
): Promise<ActivePrescreenLookup> {
  const nowMs = opts.nowMs ?? Date.now()
  const snap = await db
    .collection("pa-prescreen-sessions")
    .where("userId", "==", userId)
    .get()

  let latest:
    | {
        id: string
        jobId: string
        terminal: string
        atMs: number
      }
    | null = null

  for (const doc of snap.docs) {
    const data = doc.data() as Record<string, unknown>
    const terminal = typeof data.terminal === "string" ? data.terminal : null
    if (!terminal) continue
    const workSession = data.workSession as Record<string, unknown> | undefined
    if (workSession && workSession.kind !== "job_prescreen") continue

    const endedAtMs =
      timestampMs(workSession?.endedAt) ??
      timestampMs(data.updatedAt) ??
      timestampMs(data.completedAt) ??
      timestampMs(data.createdAt)
    if (endedAtMs === null) continue
    if (nowMs - endedAtMs > RECENT_TERMINAL_PRESCREEN_GUARD_MS) continue
    if (latest && endedAtMs <= latest.atMs) continue

    latest = {
      id: doc.id,
      jobId: typeof data.jobId === "string" ? data.jobId : "",
      terminal,
      atMs: endedAtMs,
    }
  }

  if (!latest) return { kind: "none" }
  opts.log?.("prescreen.turn.recent_terminal_guard_found", {
    userId,
    sessionId: latest.id,
    jobId: latest.jobId,
    terminal: latest.terminal,
    endedAt: new Date(latest.atMs).toISOString(),
  })
  return {
    kind: "recent_terminal",
    sessionId: latest.id,
    jobId: latest.jobId,
    terminal: latest.terminal,
  }
}

function timestampMs(value: unknown): number | null {
  if (typeof value === "string") {
    const parsed = Date.parse(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (value && typeof value === "object") {
    const maybe = value as { toMillis?: () => number; toDate?: () => Date }
    if (typeof maybe.toMillis === "function") {
      const ms = maybe.toMillis()
      return Number.isFinite(ms) ? ms : null
    }
    if (typeof maybe.toDate === "function") {
      const ms = maybe.toDate().getTime()
      return Number.isFinite(ms) ? ms : null
    }
  }
  return null
}

export interface RunPrescreenTurnArgs {
  db: Firestore
  userId: string
  toE164: string
  replyText: string
  /**
   * Optional inbound media (iMessage image attachment URL). When a candidate
   * answers a scoring prescreen question with ONLY a screenshot/image and no
   * usable text, the reply would otherwise reach the judge as empty text →
   * scored 0 → unfair HARD_STOP (live victim 2026-06-19: proof arrived as 3
   * analytics screenshots). `runPrescreenTurnIfActive` uses this to ask for the
   * text/link instead of hard-stopping. See the image-proof guard below.
   */
  mediaUrl?: string
  lang?: "zh" | "en"
  sendSms?: RuntimeSmsSender
  runTerminalAction?: typeof runPrescreenTerminalAction
  markReviewPending?: (args: MarkPrescreenReviewPendingArgs) => Promise<unknown>
  keywordSetCaller?: KeywordSetLlmCaller
  clarifyComposer?: PreScreenClarifyComposer
  /**
   * #3 convergence (Adam 2026-06-05): injectable rec-firer for the post-prescreen→onboarding
   * convergence's all-slots-satisfied bridge. Production default = `defaultGenerateJobRecs`
   * (the SAME find_match path the FAIL terminal uses). Tests inject a stub.
   */
  fireJobRecs?: (args: {
    userId: string
    toE164: string
    lang?: "zh" | "en"
  }) => Promise<{ ok: boolean; jobCount: number; reason?: string }>
  log?: (event: string, payload: Record<string, unknown>) => void
}

export interface RunPrescreenTurnResult {
  /** True when an active session was found and the reply was handled. */
  handled: boolean
  sessionId?: string
  terminal?: string | null
  textSent?: string
}

type PrescreenTurnRecordAction =
  | { kind: "clarify"; qId: string; kAfter: number }
  | { kind: "advance"; fromQId: string; toQId: string }
  | { kind: "terminal"; terminal: "PASS" | "FAIL" | "HARD_STOP" | "PAUSE"; reason: string }
  | { kind: "safety_block"; reason: string; signals?: string[] }
  | { kind: "error"; reason: string }

export function prescreenTurnRecordQId(
  action: PrescreenTurnRecordAction,
  activeQId: string | null | undefined
): string {
  if (action.kind === "clarify") return action.qId
  if (action.kind === "advance") return action.fromQId
  return activeQId ?? "terminal"
}

function prescreenTurnRecordScored(state: PreScreenState, qId: string) {
  const scored = state.questions[qId]?.scored
  if (!scored) return undefined
  return {
    perKeyword: scored.perKeyword,
    aggregate: scored.aggregate,
    ...(scored.abortHint ? { abortHint: scored.abortHint } : {}),
  }
}

function prescreenHumanReviewTerminal(value: string): PrescreenHumanReviewTerminal | null {
  return value === "PASS" || value === "FAIL" || value === "HARD_STOP" ? value : null
}

async function maybeHandlePrescreenSafetyBlock(args: {
  db: Firestore
  userId: string
  toE164: string
  replyText: string
  sessionId: string
  sendSms: RuntimeSmsSender
  log: (event: string, payload: Record<string, unknown>) => void
}): Promise<RunPrescreenTurnResult | null> {
  const verdict = await runSafetyCheck(
    args.db,
    { userId: args.userId, channel: "imessage", text: args.replyText },
    { promptInjection: true },
  )
  if (verdict.verdict !== "block") return null

  const lang = pickLangForSafety(args.replyText)
  let text: string | null
  if (verdict.action === "silent_drop") {
    text = null
  } else if (verdict.action === "escalate") {
    text = SAFETY_CANNED_REPLIES.escalate[lang]
  } else if (verdict.action === "respond_sanitized") {
    text = SAFETY_CANNED_REPLIES.respond_sanitized[lang]
  } else {
    text = "I can’t work with that message. Try rephrasing."
  }

  const nowIso = new Date().toISOString()
  const sessionRef = args.db.collection("pa-prescreen-sessions").doc(args.sessionId)
  await sessionRef.collection("turns").add({
    qId: "safety",
    reply: args.replyText,
    action: {
      kind: "safety_block",
      reason: verdict.layer ?? verdict.reasons[0] ?? "safety_block",
      signals: verdict.signals,
    },
    ts: nowIso,
  })
  await sessionRef.set({ updatedAt: nowIso }, { merge: true })

  if (text !== null) {
    await args.sendSms({
      to: args.toE164,
      content: text,
      userId: args.userId,
      db: args.db,
      runtimeSource: "pa_prescreen_runtime",
      idempotencyKey: `prescreen_safety:${args.sessionId}:${stablePrescreenSendKey(args.replyText, text)}`,
    })
  }

  args.log("prescreen.turn.safety_blocked", {
    userId: args.userId,
    sessionId: args.sessionId,
    action: verdict.action,
    layer: verdict.layer,
    signals: verdict.signals,
    replied: text !== null,
  })
  return { handled: true, sessionId: args.sessionId, textSent: text ?? undefined }
}

function isUserExitPrescreenReply(reply: string): boolean {
  const normalized = reply.trim().toLowerCase()
  if (!normalized) return false
  if (/^(stop|cancel|pause|quit|exit|end|not now|later|nevermind|never mind)[.!\s]*$/i.test(normalized)) {
    return true
  }
  const hasExitVerb = /\b(stop|cancel|pause|quit|exit|end)\b/i.test(normalized)
  const hasScreenContext = /\b(this|screen|role|interview|prescreen|pre-screen|job)\b/i.test(normalized)
  const hasDeferralContext = /\b(for now|not now|later|come back|continue later|resume later)\b/i.test(normalized)
  const startsLikeRequest = /^(can|could|may)\s+(we|i)\b/i.test(normalized) || /^let[’']?s\b/i.test(normalized) || /\bplease\b/i.test(normalized)
  if (hasExitVerb && hasScreenContext && (hasDeferralContext || startsLikeRequest)) {
    return true
  }
  return /^(please\s+)?(stop|cancel|pause|quit|exit|end)\b(?=.*\b(this|screen|role|interview|prescreen|pre-screen|for now|now|please)\b)[a-z0-9\s'’.-]*[.!?。！？\s]*$/i.test(normalized)
}

function hasIncompleteOnboardingQuestion(user: Record<string, unknown> | undefined): boolean {
  if (!user) return false
  if (user.onboardingState === "complete" || user.onboardingStatus === "complete") return false
  const pipeline = user.pipelineState && typeof user.pipelineState === "object"
    ? user.pipelineState as Record<string, unknown>
    : null
  if (pipeline?.completed === true) return false
  return typeof pipeline?.currentQId === "string" || /^q_[a-z0-9_]+_asked$/.test(String(user.onboardingState ?? ""))
}

/**
 * POST-TERMINAL MATCHING IS OPT-IN (Adam 2026-06-15 live bug). After a prescreen
 * reaches a terminal and Claire sends the handoff/next-step note, the candidate's
 * reply must NOT bridge into matching unless it is an EXPLICIT matching request.
 *
 * The previous gate (detectSimpleYesNo) treated a bare "sure" / "ok" / "sounds
 * good" — including a COURTESY ACK of the pending review like "Sure. Looking
 * forward for the update." — as a "yes, proceed to matching", so Claire sent
 * "pulling a few fresh matches 🔍" unrequested. That's the gap: gating existed
 * (matching only after a settled terminal) but the proceed signal was a generic
 * yes, not an explicit opt-in.
 *
 * Returns:
 *   - "yes"       → an UNAMBIGUOUS request to find/see roles → proceed to matching.
 *   - "no"        → an explicit decline.
 *   - "ambiguous" → anything else, INCLUDING a polite acknowledgment of the review
 *                   ("sure", "ok", "sounds good", "thanks", "looking forward to the
 *                   update") → re-offer matching (warm hold); never auto-match.
 *
 * NOTE on no-regex-in-tagging: this is a deliver/control-flow decision (proceed to
 * find_match vs warm hold), NOT a text→enum tag classification, so a deterministic
 * matcher is allowed here (same scope as ack-classifier.ts). The "yes" allowlist
 * mirrors the TRIAGE HARD RULE match-command list in claire-agent/prompt.ts.
 */
function detectPostTerminalMatchingIntent(body: string): "yes" | "no" | "ambiguous" {
  const normalized = body.trim().toLowerCase()
  if (!normalized) return "ambiguous"

  // Explicit decline still respected (verbatim from the old yes/no detector).
  if (
    /^(no|nope|nah|pass|skip|later|not now|don'?t|do not|no thanks|no thank you)\b/i.test(normalized) ||
    /\b(not right now|i'?m good|i am good|good for now|i'?ll pass|i will pass|don'?t want|do not want)\b/i.test(normalized)
  ) {
    return "no"
  }

  // A polite acknowledgment of the pending review is NOT an opt-in. Reuse the
  // shared ack-classifier (pure_ack / greeting / stop) — a "thanks 👍" / "ok" /
  // "sounds good" / bare emoji following Claire's handoff is an ack, not a request.
  const ackNeed = classifyInboundReplyNeed(normalized, { followsClaireMessage: true })
  if (ackNeed === "pure_ack" || ackNeed === "greeting" || ackNeed === "stop") {
    return "ambiguous"
  }

  // EXPLICIT matching request only (mirrors prompt.ts TRIAGE match-command list).
  // Multi-clause courtesy replies that merely START with "sure"/"ok" ("Sure.
  // Looking forward for the update.") fall through to "ambiguous" — they are not
  // a verb phrase asking for roles.
  const wantsMatching =
    /\b(find|pull|show|recommend|send|get)\b[^.!?]*\b(me\b[^.!?]*)?(role|roles|job|jobs|match|matches|position|positions|opening|openings|opportunit)/i.test(
      normalized,
    ) ||
    /\b(match me|recommend (me )?(some )?(roles|jobs)|what (else|other).*(role|roles|job|jobs|have)|other (roles|jobs|matches|options))\b/i.test(
      normalized,
    ) ||
    /\b(yes|yeah|yep|sure|ok|okay)\b[, ]+\b(pull|find|show|match|recommend|send|go|do it|please)\b/i.test(normalized) ||
    /^(go ahead and (match|pull|find|recommend)|pull them|match me|lfg)\b/i.test(normalized)

  if (wantsMatching) return "yes"

  return "ambiguous"
}

/**
 * SECOND-STAGE detector: used ONLY after Claire has already asked the explicit
 * "Do you want to proceed?" offer (retentionStage await_basic_onboarding /
 * await_daily_opt_in). Here the candidate is answering THAT offer, so a SHORT bare
 * affirmative ("yes" / "sure" / "ok" / "sounds good") is a legitimate opt-in — but
 * a MULTI-CLAUSE courtesy reply ("Sure. Looking forward for the update.") that only
 * happens to start with an affirmative token is NOT, because it acknowledges the
 * review rather than answering the proceed question. Decline still wins outright.
 *
 * Kept separate from detectPostTerminalMatchingIntent so the FIRST post-terminal
 * turn (no offer asked yet) NEVER reaches this lenient bare-yes path.
 */
function detectSimpleYesNoForProceedOffer(body: string): "yes" | "no" | "ambiguous" {
  const normalized = body.trim().toLowerCase()
  if (!normalized) return "ambiguous"
  if (
    /^(no|nope|nah|pass|skip|later|not now|don'?t|do not|no thanks|no thank you)\b/i.test(normalized) ||
    /\b(not right now|i'?m good|i am good|good for now|i'?ll pass|i will pass|don'?t want|do not want)\b/i.test(normalized)
  ) {
    return "no"
  }
  // A SHORT bare affirmative answering the explicit offer is a yes. We reuse the
  // ack-classifier's pure_ack judgment (it already maps short "yes"/"sure"/"ok"/
  // "sounds good"/"yep" to pure_ack, and longer multi-clause replies to "other").
  // This is what cleanly separates "yes"/"sure thank you" (a yes to the offer) from
  // "Sure. Looking forward for the update." (a courtesy ack of the review → other →
  // ambiguous → re-offer). No state-contradicting auto-match on a polite ack.
  if (classifyInboundReplyNeed(normalized, { followsClaireMessage: true }) === "pure_ack") {
    return "yes"
  }
  return "ambiguous"
}

function postPrescreenOnboardingPrompt(_lang: "zh" | "en", terminal?: string | null): string {
  return terminal === "PASS"
    ? "Thanks for your answers — the role-fit screen is complete. For the next step, I’ll schedule you directly with the hiring manager once there’s a match. Meanwhile, I can help find jobs that meet your expectations, but I need to understand you a bit better first. Do you want to proceed?"
    : "Thanks for taking the time. I can help find jobs that meet your expectations, but I need to understand you a bit better first. Do you want to proceed?"
}

function pendingReviewFollowupAckText(_lang: "zh" | "en", terminal?: string | null): string {
  // Claire IS the WeKruit recruiting team — warm, human, on-their-side. Not a
  // detached "I won't guess at the decision" bot (Adam 2026-06-14: felt robotic).
  // VERDICT-AWARE (live bug 2026-06-19): the "pitch you to the hiring manager" framing implies a PASS
  // and MUST NOT fire on a NOT_PASS (FAIL / HARD_STOP) outcome held for review — that reads as a
  // fabricated pass on a rejection. A NOT_PASS gets warm, honest holding copy instead.
  if (terminal === "FAIL" || terminal === "HARD_STOP") {
    return "thank you — really appreciate you taking the time on this 🙏 i've got your full screen now and the WeKruit team is reviewing where things landed. i'll text you the moment there's an update either way — and in the meantime i'm keeping an eye out for other roles that fit you."
  }
  return "thank you — really appreciate you taking the time on this 🙏 i've got your full screen now, and the WeKruit team is reviewing it to help pitch you to the hiring manager. i'll text you the moment there's an update — and in the meantime i'm keeping an eye out for other roles that fit you."
}

async function markUserPrescreenWorkSessionEnded(args: {
  db: Firestore
  userId: string
  sessionId: string
  jobId: string
  terminal: string
  nowIso: string
}): Promise<void> {
  await args.db.collection(PA_COLLECTIONS.users).doc(args.userId).set(
    {
      workSession: {
        kind: "job_prescreen",
        status: "ended",
        boundary: "terminal",
        endedAt: args.nowIso,
        sessionId: args.sessionId,
        jobId: args.jobId,
        terminal: args.terminal,
      },
      updatedAt: args.nowIso,
    },
    { merge: true },
  )
}

async function startSharedOnboardingAfterPrescreen(args: {
  db: Firestore
  userId: string
  toE164: string
  nowIso: string
  sendSms: RuntimeSmsSender
  log: (event: string, payload: Record<string, unknown>) => void
  sessionId: string
  /**
   * #3 convergence (Adam 2026-06-05): when role + location are BOTH already known we
   * skip straight to recs. Injectable for tests; default = the SAME find_match-backed
   * closure the FAIL terminal uses (no parallel rec path). Fail-open: any error is logged.
   */
  fireJobRecs?: (args: {
    userId: string
    toE164: string
    lang?: "zh" | "en"
  }) => Promise<{ ok: boolean; jobCount: number; reason?: string }>
}): Promise<string> {
  const userRef = args.db.collection(PA_COLLECTIONS.users).doc(args.userId)
  const userSnap = await userRef.get()
  const user = (userSnap.data() ?? {}) as Record<string, unknown>
  if (user.onboardingState === "complete" || user.onboardingStatus === "complete") {
    const doneText = "Great — I already have your basic profile context, so there’s nothing else you need to answer right now. I’ll reach out when there’s a strong next match."
    await args.sendSms({
      to: args.toE164,
      content: doneText,
      userId: args.userId,
      db: args.db,
      runtimeSource: "pa_prescreen_retention_onboarding",
      idempotencyKey: `prescreen_retention_onboarding_complete:${args.sessionId}`,
    })
    return doneText
  }

  const parsedResume = await loadSharedOnboardingParsedResumeForPrompt(
    args.db,
    args.userId,
    user,
    (event, payload) => args.log(`shared_onboarding.${event}`, payload ?? {}),
  )
  const promptContext = buildSharedOnboardingPromptContext({ user, parsedResume })
  const startedFields = buildSharedOnboardingStartedState(
    args.nowIso,
    WEKRUIT_CANDIDATE_SOURCE,
    promptContext,
  )
  await userRef.set(
    {
      ...startedFields,
      candidateContext: {
        sms: {
          phoneE164: args.toE164,
          smsTriggeredAt: args.nowIso,
        },
      },
      smsState: "shared-onboarding-started-after-prescreen",
      smsThreadId: `iMessage;-;${args.toE164}`,
      updatedAt: args.nowIso,
    },
    { merge: true },
  )
  // CONVERGE to the SAME thin enrich→pitch→rec onboarding (Adam #3 2026-06-05): a
  // prescreen-first entrant, AFTER the screen, runs the SAME gap-aware ASKED set as a
  // cold-start (target_role auto-derived from enrich → suppressed; only the genuinely-
  // MISSING slot — location — is asked). Wording differs slightly (we thank them for the
  // screen). This is NOT the legacy 7-question main_goal wall. Pure structured presence
  // checks over the closed-enum tags (isSharedOnboardingSlotSatisfied) — NO regex, NO LLM.
  const userTags = (user.tags ?? {}) as Record<string, unknown>
  const statedPrefs = (user.statedPreferences ?? null) as Record<string, unknown> | null
  const firstMissing =
    (DEFAULT_ONBOARDING_SLOTS as SharedOnboardingQuestionId[]).find(
      (slot) => !isSharedOnboardingSlotSatisfied(slot, userTags, statedPrefs),
    ) ?? null

  if (!firstMissing) {
    // role + location already known → nothing left to ask; bridge straight to recs.
    const doneText =
      "Great — thanks for completing the screen. I’ve got your profile, so I’ll pull a few matches for you now."
    await args.sendSms({
      to: args.toE164,
      content: doneText,
      userId: args.userId,
      db: args.db,
      runtimeSource: "pa_prescreen_retention_onboarding",
      idempotencyKey: `prescreen_retention_onboarding_done:${args.sessionId}`,
    })
    // Fire the SAME find_match-backed recs the FAIL terminal uses. Fail-open: any error
    // is swallowed (the bridge message already shipped; recs are best-effort).
    const fire = args.fireJobRecs ?? defaultGenerateJobRecs
    try {
      await fire({ userId: args.userId, toE164: args.toE164, lang: "en" })
    } catch (err) {
      args.log("prescreen.turn.post_prescreen_onboarding_recs_failed", {
        sessionId: args.sessionId,
        error: err instanceof Error ? err.message : String(err),
      })
    }
    return doneText
  }

  const qNext = buildSharedOnboardingPrompt(firstMissing, promptContext)
  const text = `Great — thanks for completing the screen. I’ll use what you shared there, and I just need one quick thing for future matches. ${qNext}`
  await args.sendSms({
    to: args.toE164,
    content: text,
    userId: args.userId,
    db: args.db,
    runtimeSource: "pa_prescreen_retention_onboarding",
    idempotencyKey: `prescreen_retention_onboarding:${args.sessionId}`,
  })
  return text
}

function isLikelyPrescreenContinuationReply(reply: string): boolean {
  const normalized = reply.trim().toLowerCase()
  if (!normalized) return false
  if (/\b(?:what(?:'s|\s+is|\s+are)?|whats)\s+(?:the\s+)?next\s+steps?\b/.test(normalized)) return true
  if (/\bwhat\s+happens\s+next\b/.test(normalized)) return true
  if (/\b(prescreen|pre-screen|role screen|job screen|screen|interview)\b/.test(normalized)) return true
  if (/\b(this|that|same)\s+(role|job|screen|interview)\b/.test(normalized)) return true
  if (/\b(reopen|continue|resume|restart|start over|try again)\b(?=.*\b(role|job|screen|interview|prescreen|pre-screen)\b)/.test(normalized)) {
    return true
  }
  return /\b(rain|software engineer|fullstack|full-stack|technical account manager|product manager|product designer)\b/.test(normalized)
}

function isJobSearchRequest(reply: string): boolean {
  const normalized = reply.trim().toLowerCase()
  if (!normalized) return false
  return /\b(?:find|get|show|send|pull|recommend|match|search|look\s+for|looking\s+for|need|want|interested\s+in|help\s+me\s+find)\b[^.!?]{0,80}\b(?:jobs?|roles?|positions?|opportunities|openings|listings|matches|swe|software\s+engineering|software\s+engineer)\b/i.test(normalized)
}

function isJobOrCompanyInfoRequest(reply: string): boolean {
  const body = reply.trim()
  if (!body) return false
  const asksQuestion =
    /[?]/.test(body) ||
    /\b(?:what|which|who|where|how|can\s+you|could\s+you|tell\s+me|explain|details?)\b/i.test(body)
  if (!asksQuestion) return false
  return /\b(?:company|employer|hiring\s+manager|team|role|job|position|interviewing\s+for|interviewed\s+for|screening\s+for|screened\s+for)\b/i.test(body)
}

function isPrescreenOutcomeExplanationRequest(reply: string): boolean {
  const body = reply.trim()
  if (!body) return false
  const asksQuestion =
    /[?]/.test(body) ||
    /\b(?:why|how|what|could\s+you|can\s+you|help\s+me|understand|explain|tell\s+me)\b/i.test(body)
  if (!asksQuestion) return false
  const wantsOutcomeReason =
    /\b(?:improv(?:e|ed|ing|ement)|better|stronger|strengthen|missing|gap|weak|low|pass|fail|failed|pause|paused|not\s+(?:a\s+)?fit|not\s+pass|didn'?t\s+pass|could\s+have)\b/i.test(body)
  if (!wantsOutcomeReason) return false
  return /\b(?:above|this|that|same|role|job|screen|interview|prescreen|pre-screen|rain|fit)\b/i.test(body)
}

function isJobRecommendationExplanationRequest(reply: string): boolean {
  const body = reply.trim()
  if (!body) return false
  const lower = body.toLowerCase()
  const asksQuestion =
    /[?]/.test(body) ||
    /\b(?:why|what|which|how|can\s+you|tell\s+me|explain|answer)\b/i.test(body)
  if (!asksQuestion) return false
  const hasJobContext =
    /\b(?:recommend(?:ed)?|matching?|matched|jobs?|roles?|positions?|opportunities|openings|internships?|co-?ops?|company|rain|constant\s+contact|fullstack)\b/i.test(body)
  if (!hasJobContext) return false
  return (
    /\bwhich\s+(?:jobs?|roles?|positions?|opportunities|matches)\b[\s\S]{0,120}\b(?:fit|fits|match|matches|best|make\s+sense)\b/i.test(body) ||
    /\bbest\s+(?:current\s+)?(?:match|fit|role|job|opportunity)\b/i.test(body) ||
    /\bwhether\b[\s\S]{0,140}\b(?:rain|fullstack|role|job)\b[\s\S]{0,140}\b(?:still\s+)?(?:makes?\s+sense|fits?|matches?)\b/i.test(body) ||
    /\blower\s+priority\b[\s\S]{0,120}\b(?:jobs?|roles?|internships?|co-?ops?)\b/i.test(lower) ||
    /\b(?:jobs?|roles?|internships?|co-?ops?)\b[\s\S]{0,120}\blower\s+priority\b/i.test(lower) ||
    /\bwhy\s+(?:did\s+you\s+)?recommend\b/i.test(body) ||
    /\bwhat\s+part\b[\s\S]{0,120}\bmatch(?:ed|es)?\b/i.test(body) ||
    /\bwhy\s+(?:is|was|did|does)?\s*.*\bmatch(?:ed|es|ing)?\b/i.test(body) ||
    /\b(?:deprioritize|prioritize|prefer|rather|instead\s+of)\b[\s\S]{0,120}\b(?:jobs?|roles?|internships?|co-?ops?|startups?|fullstack)\b/i.test(lower)
  )
}

function isExplicitNewIntentAfterTerminal(reply: string): boolean {
  if (isPrescreenOutcomeExplanationRequest(reply)) return false
  return isJobRecommendationExplanationRequest(reply) || isJobSearchRequest(reply) || isJobOrCompanyInfoRequest(reply)
}

function isShortTerminalAck(reply: string): boolean {
  const normalized = reply.trim().toLowerCase()
  return /^(ok|okay|yes|yeah|yep|sure|alright|all right|go ahead|proceed|got it|thanks|thank you|sounds good)[.!\s]*$/i.test(normalized)
}

function isPostTerminalConstraintUpdate(reply: string): boolean {
  const normalized = reply.trim().toLowerCase()
  if (!normalized) return false
  if (/^(remote|hybrid|onsite|sf|nyc|new york|los angeles|la|bay area|us|usa)\b.{0,80}\b(only|preferred|works|fine|ok|okay)?[.!\s]*$/i.test(normalized)) {
    return true
  }
  if (/\b(still|also|actually|for this|about this|constraint|preference|prefer|need|cannot|can't|won't|wouldn'?t)\b(?=.*\b(remote|relocat\w*|location|salary|comp|visa|sponsor|h-?1b|opt|work authorization|authorized|range)\b)/i.test(normalized)) {
    return true
  }
  return false
}

function isRecentTerminalFollowupReply(reply: string): boolean {
  if (isExplicitNewIntentAfterTerminal(reply)) return false
  return (
    isLikelyPrescreenContinuationReply(reply) ||
    isShortTerminalAck(reply) ||
    isPostTerminalConstraintUpdate(reply)
  )
}

function hasActiveUserPostMatchRetention(user: Record<string, unknown> | undefined): boolean {
  const raw = user?.postMatchRetention
  if (!raw || typeof raw !== "object") return false
  const stage = (raw as { stage?: unknown }).stage
  return typeof stage === "string" && stage !== "complete"
}

// thin-Claire's post-terminal matching OFFER copy ("want me to pull a few other design roles?",
// "i can line up other roles", "want me to surface more matches"). Used to detect that a following
// bare affirmative is ACCEPTING an offer (→ fire find_match), not acking the terminal.
const MATCH_OFFER_RE_A =
  /\b(?:pull|line\s*up|surface|show\s+you|send\s+you|find\s+you|round\s+up)\b[^?]{0,55}\b(?:roles?|jobs?|positions?|openings?|matches|opportunities)\b/i
const MATCH_OFFER_RE_B =
  /\bwant\s+me\s+to\b[^?]{0,75}\b(?:roles?|jobs?|positions?|design|pull|matches|openings?|opportunities)\b/i

/**
 * True when a roles/matches OFFER we sent is the candidate's most recent context (within the
 * recent-terminal window). Reads recent pa-outbound (no orderBy → no composite index needed; sorts
 * in memory). Best-effort; false on any error.
 */
async function hasRecentMatchOfferForUser(
  db: Firestore,
  userId: string,
  nowMs: number,
): Promise<boolean> {
  try {
    const snap = await db.collection("pa-outbound").where("userId", "==", userId).limit(25).get()
    const rows = (snap.docs ?? [])
      .map((d) => d.data() as Record<string, unknown>)
      .filter((r) => typeof r.createdAt === "string")
      .sort((a, b) => Date.parse(String(b.createdAt)) - Date.parse(String(a.createdAt)))
      .slice(0, 6)
    for (const r of rows) {
      const ageMs = nowMs - Date.parse(String(r.createdAt))
      if (ageMs > RECENT_TERMINAL_PRESCREEN_GUARD_MS) continue
      const body = String(r.body ?? "")
      if (MATCH_OFFER_RE_A.test(body) || MATCH_OFFER_RE_B.test(body)) return true
    }
    return false
  } catch {
    return false
  }
}

async function shouldHandleRecentTerminalSession(args: {
  db: Firestore
  userId: string
  replyText: string
  terminal?: string | null
  /** The terminal outcome is held for human review (auto-draft path) — see live bug 2026-06-19. */
  pendingReview?: boolean
  log: (event: string, payload: Record<string, unknown>) => void
}): Promise<boolean> {
  let user: Record<string, unknown> | undefined
  try {
    const snap = await args.db.collection("pa-users").doc(args.userId).get()
    user = snap.data() as Record<string, unknown> | undefined
  } catch (err) {
    args.log("prescreen.turn.recent_terminal_user_lookup_failed", {
      userId: args.userId,
      error: err instanceof Error ? err.message : String(err),
    })
  }
  if (isPrescreenOutcomeExplanationRequest(args.replyText)) return true
  // OFFER-ACCEPTANCE ESCAPE (live 2026-06-23, Andrea 8PpvzWN0BSYhe6dKXh71): after a terminal,
  // thin-Claire often makes a post-terminal matching OFFER ("want me to pull a few other design
  // roles?"). A bare "yes" accepting it was classified as a terminal-ack (isShortTerminalAck) and
  // SWALLOWED by this guard → the candidate said yes and got silence. When a short affirmative
  // follows a roles offer we just made, yield to runtime so thin-Claire fires find_match. This wins
  // even over pending-review ownership — an accepted offer is a deliberate request, not unsolicited.
  if (
    isShortTerminalAck(args.replyText) &&
    (await hasRecentMatchOfferForUser(args.db, args.userId, Date.now()))
  ) {
    args.log("prescreen.turn.recent_terminal_yielded_to_accepted_match_offer", {
      userId: args.userId,
      terminal: args.terminal ?? null,
    })
    return false
  }
  // PENDING-REVIEW THREAD OWNERSHIP (live bug 2026-06-19): while a just-terminated outcome (PASS or
  // NOT_PASS) is held for human review, prescreen owns the thread within the recent-terminal window so
  // thin-Claire does NOT re-engage with unsolicited matching offers ("say yes and i'll pull roles") +
  // duplicates. The ONE escape hatch is an EXPLICIT fresh job-search / new-intent ask from the
  // candidate — that is a deliberate request, not an unsolicited re-engagement, so we yield to runtime.
  if (args.pendingReview && !isExplicitNewIntentAfterTerminal(args.replyText)) {
    args.log("prescreen.turn.recent_terminal_owned_pending_review", {
      userId: args.userId,
      terminal: args.terminal ?? null,
    })
    return true
  }
  if (hasActiveUserPostMatchRetention(user)) {
    args.log("prescreen.turn.recent_terminal_guard_yielded_to_post_match_retention", {
      userId: args.userId,
      stage: (user?.postMatchRetention as { stage?: unknown } | undefined)?.stage ?? null,
    })
    return false
  }
  if (args.terminal === "PASS" && !isExplicitNewIntentAfterTerminal(args.replyText)) return true
  if (isRecentTerminalFollowupReply(args.replyText)) return true
  if (!hasIncompleteOnboardingQuestion(user)) {
    args.log("prescreen.turn.recent_terminal_guard_yielded_to_runtime", {
      userId: args.userId,
      reason: "not_prescreen_followup",
    })
    return false
  }
  args.log("prescreen.turn.recent_terminal_guard_yielded_to_onboarding", {
    userId: args.userId,
    onboardingState: user?.onboardingState ?? null,
    currentQId: (user?.pipelineState as Record<string, unknown> | undefined)?.currentQId ?? null,
  })
  return false
}

/**
 * Entry called from paMessageCoalescer before Claire dispatch. Returns
 * handled=false when no active prescreen session → coalescer continues
 * to Claire.
 */
export async function runPrescreenTurnIfActive(
  args: RunPrescreenTurnArgs
): Promise<RunPrescreenTurnResult> {
  const log = args.log ?? (() => {})
  const sendSms = args.sendSms ?? sendRuntimeApprovedIMessage
  const terminalAction = args.runTerminalAction ?? runPrescreenTerminalAction
  const intakeActive = await isLayoffIntakeActiveForUser(args.db, args.userId)
  const wantsOutcomeExplanation = isPrescreenOutcomeExplanationRequest(args.replyText)
  if (intakeActive && !wantsOutcomeExplanation) {
    log("prescreen.turn.yielded_to_layoff_onboarding", { userId: args.userId })
    return { handled: false }
  }
  let lookup = await findActiveSession(args.db, args.userId, { log })
  if (lookup.kind === "none") {
    lookup = await findRecentTerminalSession(args.db, args.userId, { log })
  }
  if (intakeActive && lookup.kind !== "recent_terminal") {
    log("prescreen.turn.yielded_to_layoff_onboarding", { userId: args.userId })
    return { handled: false }
  }
  if (lookup.kind === "none") return { handled: false }

  const safetyBlock = await maybeHandlePrescreenSafetyBlock({
    db: args.db,
    userId: args.userId,
    toE164: args.toE164,
    replyText: args.replyText,
    sessionId: lookup.sessionId,
    sendSms,
    log,
  })
  if (safetyBlock) return safetyBlock

  // ── VOICE-CALL GATE (Adam 2026-06-19, live E2E) ──────────────────────────────────────────────────
  // An explicit phone-prescreen request ("I want to prescreen <role> on phone call"), or a yes/no
  // answering a LIVE voice-call offer, must be owned by Claire's voice tools — NOT scored as a
  // text-prescreen answer. This handler runs BEFORE the thin-Claire voice path (cutover.ts) in BOTH the
  // coalescer (paMessageCoalescer step 3a) and the direct onPaInbound path, so without this yield an
  // active prescreen session swallows the request into the keyword/agentic reducer. That was the live
  // failure: "I want to prescreen Sekai … on phone call" got a text prescreen question instead of the
  // "can I call you now?" offer. We yield the turn (handled:false) WITHOUT writing anything to the
  // session — the cutover voice handlers (offer / resolve) then run. Dev-phone-only, matching the voice
  // lane's own gate; non-dev phones keep the text-prescreen path byte-for-byte.
  if (isClaireVoiceDevPhone(args.toE164)) {
    if (isExplicitVoicePrescreenRequest(args.replyText)) {
      log("prescreen.turn.yielded_to_voice_call", {
        userId: args.userId,
        sessionId: lookup.sessionId,
        reason: "explicit_voice_prescreen_request",
      })
      return { handled: false, sessionId: lookup.sessionId }
    }
    const callAnswer = parseLowInfoCallConfirmation(args.replyText)
    if (callAnswer !== null) {
      try {
        const { hasPendingVoiceCallOfferForUser } = await import("./claire-agent/tools/voice-call-tools.js")
        if (await hasPendingVoiceCallOfferForUser(args.db, args.userId, Date.now())) {
          log("prescreen.turn.yielded_to_voice_call", {
            userId: args.userId,
            sessionId: lookup.sessionId,
            reason: "pending_offer_resolution",
          })
          return { handled: false, sessionId: lookup.sessionId }
        }
      } catch (err) {
        log("prescreen.turn.voice_offer_check_failed", {
          userId: args.userId,
          sessionId: lookup.sessionId,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }
  }

  if (lookup.kind === "recent_terminal") {
    // Fetch the session up-front so the guard can see whether the terminal outcome is held for
    // human review. A pending-review session MUST keep ownership of the thread (within the recent-
    // terminal window) so thin-Claire does NOT re-engage with unsolicited matching offers on a turn
    // whose verdict has not yet been committed (live bug 2026-06-19: a HARD_STOP held for review was
    // followed by "say yes and i'll pull roles" matching re-engagement + duplicates).
    const sessionRef = args.db.collection("pa-prescreen-sessions").doc(lookup.sessionId)
    const sessSnap = await sessionRef.get()
    const sessData = (sessSnap.data() ?? {}) as Record<string, unknown>
    const pendingReview = sessData.terminalActionPendingReview === true
    const shouldGuard = await shouldHandleRecentTerminalSession({
      db: args.db,
      userId: args.userId,
      replyText: args.replyText,
      terminal: lookup.terminal,
      pendingReview,
      log,
    })
    if (!shouldGuard) return { handled: false }
    const alreadyAcked = typeof sessData.postTerminalFollowupAckAt === "string"
    const nowIso = new Date().toISOString()

    // ── VOICE POST-CALL JOB-REC OPT-IN (Adam 2026-06-19) ─────────────────────────────────────────
    // The voice post-call followup (paVoicePostCallFollowup) asked "want me to pull a few roles that
    // fit?" and flagged this session. Resolve the yes/no HERE — before the pending-review / retention
    // machinery — so a yes deterministically fires the SAME find_match recs the FAIL terminal uses
    // (the opt-in previously dead-ended with no consumer). The flag is only ever set by the voice
    // followup, so this is inert for text-only prescreens. An ambiguous reply leaves the flag and
    // falls through to normal handling.
    if (sessData.voicePostCallJobRecOptInPending === true) {
      const optIn = parseLowInfoCallConfirmation(args.replyText)
      if (optIn !== null) {
        await sessionRef.set(
          {
            voicePostCallJobRecOptInPending: false,
            voicePostCallJobRecOptInResolvedAt: nowIso,
            updatedAt: nowIso,
          },
          { merge: true },
        )
        await sessionRef.collection("turns").add({
          qId: "terminal",
          reply: args.replyText,
          action: { kind: "voice_post_call_job_rec_opt_in", confirmed: optIn },
          ts: nowIso,
        })
        if (optIn) {
          const text = "on it — pulling a few roles that fit your screen now 🔍"
          try {
            await sendSms({
              to: args.toE164,
              content: text,
              userId: args.userId,
              db: args.db,
              runtimeSource: "pa_prescreen_runtime",
              idempotencyKey: `voice_post_call_optin_yes:${lookup.sessionId}`,
            })
          } catch (err) {
            log("prescreen.turn.voice_post_call_optin_send_failed", {
              sessionId: lookup.sessionId,
              error: err instanceof Error ? err.message : String(err),
            })
          }
          const fire = args.fireJobRecs ?? defaultGenerateJobRecs
          try {
            await fire({ userId: args.userId, toE164: args.toE164, lang: args.lang ?? "en" })
          } catch (err) {
            log("prescreen.turn.voice_post_call_optin_recs_failed", {
              sessionId: lookup.sessionId,
              error: err instanceof Error ? err.message : String(err),
            })
          }
          log("prescreen.turn.voice_post_call_optin_recs_fired", {
            sessionId: lookup.sessionId,
            userId: args.userId,
          })
          return { handled: true, sessionId: lookup.sessionId, terminal: lookup.terminal, textSent: text }
        }
        const declineText =
          "no problem — your screen's on file, and i'll reach out when something strong comes up."
        try {
          await sendSms({
            to: args.toE164,
            content: declineText,
            userId: args.userId,
            db: args.db,
            runtimeSource: "pa_prescreen_runtime",
            idempotencyKey: `voice_post_call_optin_no:${lookup.sessionId}`,
          })
        } catch (err) {
          log("prescreen.turn.voice_post_call_optin_send_failed", {
            sessionId: lookup.sessionId,
            error: err instanceof Error ? err.message : String(err),
          })
        }
        log("prescreen.turn.voice_post_call_optin_declined", {
          sessionId: lookup.sessionId,
          userId: args.userId,
        })
        return { handled: true, sessionId: lookup.sessionId, terminal: lookup.terminal, textSent: declineText }
      }
    }

    if (pendingReview) {
      const text = pendingReviewFollowupAckText(args.lang ?? "en", lookup.terminal)
      await sessionRef.collection("turns").add({
        qId: "terminal",
        reply: args.replyText,
        action: {
          kind: "post_terminal_followup",
          terminal: lookup.terminal,
          reason: "pending_wekruit_team_review",
        },
        ts: nowIso,
      })
      await sendSms({
        to: args.toE164,
        content: text,
        userId: args.userId,
        db: args.db,
        runtimeSource: "pa_prescreen_runtime",
        idempotencyKey: `prescreen_pending_review_ack:${lookup.sessionId}:${stablePrescreenSendKey(args.replyText, text)}`,
      })
      await sessionRef.set({ reviewPendingFollowupAt: nowIso, updatedAt: nowIso }, { merge: true })
      log("prescreen.turn.recent_terminal_pending_review_ack_sent", {
        sessionId: lookup.sessionId,
        userId: args.userId,
        terminal: lookup.terminal,
      })
      return {
        handled: true,
        sessionId: lookup.sessionId,
        terminal: lookup.terminal,
        textSent: text,
      }
    }
    // ── RETENTION HANDOFF (canary, Adam 2026-06-05) ──────────────────────────────────────────────
    // A recently-terminal / PAUSED session turn (the Sai branch) is answered by the THIN context-complete
    // agent (buildCandidateContext) — NOT canned text (recentTerminalCourtesyAckText / retention prompt /
    // outcome-explanation) + regex intent. The terminal, retain action, and any match were ALREADY fired
    // deterministically by the reducer; this only changes WHO answers next + WITH WHAT CONTEXT. Placed
    // AFTER the terminalActionPendingReview guard (above) so a genuinely under-review outcome still gets
    // the deterministic WeKruit-team review ack (never a thin answer that might imply a decision).
    // Non-canary keeps EVERY legacy branch below byte-for-byte. Dev cohort only (NOT swept by the
    // onboarding PA_ONBOARDING_RAMP_ALL prod env) — ramps separately on Adam's say-so.
    if (isPrescreenRetentionHandoffCanary(args.userId)) {
      log("prescreen.turn.recent_terminal_deferred_to_thin", {
        sessionId: lookup.sessionId,
        userId: args.userId,
        terminal: lookup.terminal,
      })
      return { handled: false }
    }
    if (isPrescreenOutcomeExplanationRequest(args.replyText)) {
      const text = recentTerminalOutcomeExplanationText(args.lang ?? "en", lookup.terminal, sessData)
      await sessionRef.collection("turns").add({
        qId: "terminal",
        reply: args.replyText,
        action: {
          kind: "post_terminal_outcome_explanation",
          terminal: lookup.terminal,
          reason: "candidate_requested_fit_feedback",
        },
        ts: nowIso,
      })
      await sendSms({
        to: args.toE164,
        content: text,
        userId: args.userId,
        db: args.db,
        runtimeSource: "pa_prescreen_runtime",
        idempotencyKey: `prescreen_outcome_explanation:${lookup.sessionId}:${stablePrescreenSendKey(args.replyText, text)}`,
      })
      await sessionRef.set({ outcomeExplanationFollowupAt: nowIso, updatedAt: nowIso }, { merge: true })
      log("prescreen.turn.recent_terminal_outcome_explanation_sent", {
        sessionId: lookup.sessionId,
        userId: args.userId,
        terminal: lookup.terminal,
      })
      return {
        handled: true,
        sessionId: lookup.sessionId,
        terminal: lookup.terminal,
        textSent: text,
      }
    }
    // ── STALE-TIMEOUT PAUSE FOLLOW-UP (Adam 2026-06-12, Invoko PM live failure) ───────────────────
    // A reply that lands shortly after a boundary=timeout / manual_review_required PAUSE must NOT get
    // the retention prompt's matching offer ("I can help find jobs…") — that screen was closed by
    // STALENESS, nothing was submitted, and the truthful next step is the restart path the expiry
    // notice already promised. Universal (copy-accuracy/safety): replaces a state-contradicting offer.
    if (lookup.terminal === "PAUSE" && isStaleClosedPrescreenSession(sessData)) {
      const text = staleTimeoutFollowupText(args.lang ?? "en")
      await sessionRef.collection("turns").add({
        qId: "terminal",
        reply: args.replyText,
        action: {
          kind: "post_terminal_followup",
          terminal: lookup.terminal,
          reason: "stale_timeout_pause_restart_offer",
        },
        ts: nowIso,
      })
      try {
        await sendSms({
          to: args.toE164,
          content: text,
          userId: args.userId,
          db: args.db,
          runtimeSource: "pa_prescreen_runtime",
          idempotencyKey: `prescreen_stale_timeout_followup:${lookup.sessionId}:${stablePrescreenSendKey(args.replyText, text)}`,
        })
        await sessionRef.set({ postTerminalFollowupAckAt: nowIso, updatedAt: nowIso }, { merge: true })
      } catch (err) {
        log("prescreen.turn.stale_timeout_followup_send_failed", {
          sessionId: lookup.sessionId,
          error: err instanceof Error ? err.message : String(err),
        })
      }
      log("prescreen.turn.stale_timeout_followup_sent", {
        sessionId: lookup.sessionId,
        userId: args.userId,
        terminal: lookup.terminal,
      })
      return {
        handled: true,
        sessionId: lookup.sessionId,
        terminal: lookup.terminal,
        textSent: text,
      }
    }
    const retention = sessData.postPrescreenRetention && typeof sessData.postPrescreenRetention === "object"
      ? sessData.postPrescreenRetention as Record<string, unknown>
      : null
    const retentionStage = typeof retention?.stage === "string" ? retention.stage : null

    await sessionRef.collection("turns").add({
      qId: "terminal",
      reply: args.replyText,
      action: {
        kind: retentionStage === "await_basic_onboarding" || retentionStage === "await_daily_opt_in" || !alreadyAcked
          ? "post_prescreen_retention"
          : "post_terminal_followup",
        terminal: lookup.terminal,
        reason: "recent_ended_prescreen_session",
      },
      ts: nowIso,
    })

    let text: string | undefined
    if (retentionStage === "await_basic_onboarding" || retentionStage === "await_daily_opt_in" || !alreadyAcked) {
      // POST-TERMINAL MATCHING IS OPT-IN (Adam 2026-06-15 live bug): a courtesy ack
      // of the pending review ("Sure. Looking forward for the update.", "sounds
      // good", "thanks", "ok") must NOT bridge into matching.
      //
      // TWO STAGES:
      //   (a) FIRST post-terminal reply (proceed prompt NOT yet asked): Claire only
      //       sent the handoff/next-step note. A bare ack here is acknowledging the
      //       review, NOT requesting matches — require an EXPLICIT matching request;
      //       otherwise send the OFFER ("Do you want to proceed?"). This is the seam
      //       that fired "pulling a few fresh matches 🔍" on a courtesy ack.
      //   (b) Proceed prompt WAS asked (stage await_basic_onboarding/await_daily_opt_in):
      //       the candidate is directly answering "Do you want to proceed?", so a bare
      //       "yes"/"sure"/"ok" is a legitimate opt-in to that explicit offer.
      const proceedPromptAlreadyAsked =
        retentionStage === "await_basic_onboarding" || retentionStage === "await_daily_opt_in"
      const matchIntent = detectPostTerminalMatchingIntent(args.replyText)
      let yn: "yes" | "no" | "ambiguous" = matchIntent
      // ONLY when the explicit proceed offer was already asked AND the intent is
      // ambiguous (not an explicit yes/no), a SHORT bare affirmative answering that
      // offer counts as opt-in. An explicit "no" / explicit match request is kept.
      if (yn === "ambiguous" && proceedPromptAlreadyAsked) {
        yn = detectSimpleYesNoForProceedOffer(args.replyText)
      }
      if (yn === "ambiguous") {
        text = postPrescreenOnboardingPrompt(args.lang ?? "en", lookup.terminal)
        try {
          await sendSms({
            to: args.toE164,
            content: text,
            userId: args.userId,
            db: args.db,
            runtimeSource: "pa_prescreen_runtime",
            idempotencyKey: `prescreen_retention_prompt:${lookup.sessionId}`,
          })
          await sessionRef.set(
            {
              postTerminalFollowupAckAt: nowIso,
              updatedAt: nowIso,
              postPrescreenRetention: {
                stage: "await_basic_onboarding",
                terminal: lookup.terminal,
                startedAt: typeof retention?.startedAt === "string" ? retention.startedAt : nowIso,
                updatedAt: nowIso,
              },
            },
            { merge: true },
          )
        } catch (err) {
          log("prescreen.turn.post_prescreen_retention_prompt_failed", {
            sessionId: lookup.sessionId,
            error: err instanceof Error ? err.message : String(err),
          })
        }
      } else {
        if (yn === "yes") {
          try {
            text = await startSharedOnboardingAfterPrescreen({
              db: args.db,
              userId: args.userId,
              toE164: args.toE164,
              nowIso,
              sendSms,
              log,
              sessionId: lookup.sessionId,
              fireJobRecs: args.fireJobRecs,
            })
          } catch (err) {
            text = "Great — thanks for completing the role screen. What kind of next role would actually be worth your time?"
            log("prescreen.turn.post_prescreen_onboarding_start_failed", {
              sessionId: lookup.sessionId,
              error: err instanceof Error ? err.message : String(err),
            })
            await sendSms({
              to: args.toE164,
              content: text,
              userId: args.userId,
              db: args.db,
              runtimeSource: "pa_prescreen_runtime",
              idempotencyKey: `prescreen_retention_yes_fallback:${lookup.sessionId}`,
            })
          }
        } else {
          text = "No problem. We’ll keep this role screen complete. If you want help with broader matches later, just tell me what you’re looking for here."
          try {
            await sendSms({
              to: args.toE164,
              content: text,
              userId: args.userId,
              db: args.db,
              runtimeSource: "pa_prescreen_runtime",
              idempotencyKey: `prescreen_retention_no:${lookup.sessionId}`,
            })
          } catch (err) {
            log("prescreen.turn.post_prescreen_retention_no_send_failed", {
              sessionId: lookup.sessionId,
              error: err instanceof Error ? err.message : String(err),
            })
          }
        }
        await sessionRef.set(
          {
            postTerminalFollowupAckAt: nowIso,
            updatedAt: nowIso,
            postPrescreenRetention: {
              stage: yn === "yes" ? "onboarding_started" : "onboarding_declined",
              terminal: lookup.terminal,
              basicOnboardingOptIn: yn === "yes",
              startedAt: typeof retention?.startedAt === "string" ? retention.startedAt : nowIso,
              updatedAt: nowIso,
            },
          },
          { merge: true },
        )
      }
    } else if (!alreadyAcked) {
      text = recentTerminalSessionText(args.lang ?? "en", lookup.terminal)
      try {
        await sendSms({
          to: args.toE164,
          content: text,
          userId: args.userId,
          db: args.db,
          runtimeSource: "pa_prescreen_runtime",
          idempotencyKey: `prescreen_recent_terminal:${lookup.sessionId}`,
        })
        await sessionRef.set({ postTerminalFollowupAckAt: nowIso, updatedAt: nowIso }, { merge: true })
      } catch (err) {
        log("prescreen.turn.recent_terminal_ack_send_failed", {
          sessionId: lookup.sessionId,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }
    if (!text) {
      text = recentTerminalCourtesyAckText(args.lang ?? "en")
      try {
        await sendSms({
          to: args.toE164,
          content: text,
          userId: args.userId,
          db: args.db,
          runtimeSource: "pa_prescreen_runtime",
          idempotencyKey: `prescreen_recent_terminal_ack:${lookup.sessionId}:${stablePrescreenSendKey(args.replyText, text)}`,
        })
      } catch (err) {
        log("prescreen.turn.recent_terminal_ack_send_failed", {
          sessionId: lookup.sessionId,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }

    log("prescreen.turn.recent_terminal_guard_handled", {
      sessionId: lookup.sessionId,
      userId: args.userId,
      terminal: lookup.terminal,
      acked: Boolean(text),
    })
    return {
      handled: true,
      sessionId: lookup.sessionId,
      terminal: lookup.terminal,
      textSent: text,
    }
  }
  if (lookup.kind === "expired") {
    const sessionRef = args.db.collection("pa-prescreen-sessions").doc(lookup.sessionId)
    // IDEMPOTENCY GATE (Adam 2026-06-21 #1): notify EXACTLY ONCE. A session that already carries
    // expiryNoticeSentAt has told the candidate — do NOT re-send the timeout notice on a later turn
    // that still resolves to this (now-terminal) session. expiryNoticeSentAt is the one-time gate.
    let alreadyNotified = false
    try {
      const snap = await sessionRef.get()
      alreadyNotified = typeof snap.data()?.expiryNoticeSentAt === "string"
    } catch {
      /* fail-open → treat as not-yet-notified; the send idempotencyKey is the secondary guard */
    }
    try {
      await terminalAction({
        db: args.db,
        sessionId: lookup.sessionId,
        terminal: "PAUSE",
        userId: args.userId,
        jobId: lookup.jobId,
        toE164: args.toE164,
        lang: args.lang ?? "en",
        log,
      })
    } catch (err) {
      log("prescreen.turn.expired_terminal_action_failed", {
        sessionId: lookup.sessionId,
        error: err instanceof Error ? err.message : String(err),
      })
    }
    const text = expiredSessionText(args.lang ?? "en")
    if (alreadyNotified) {
      log("prescreen.turn.expired_notice_already_sent", { sessionId: lookup.sessionId })
      // Already told them once — let this turn fall through to triage/matching so their CURRENT
      // message intent (e.g. "yes" to job recs) still gets a coherent reply downstream.
      return { handled: false, sessionId: lookup.sessionId, terminal: "PAUSE" }
    }
    let noticeSent = false
    try {
      await sendSms({
        to: args.toE164,
        content: text,
        userId: args.userId,
        db: args.db,
        runtimeSource: "pa_prescreen_runtime",
        idempotencyKey: `prescreen_expired:${lookup.sessionId}`,
      })
      noticeSent = true
    } catch (err) {
      log("prescreen.turn.expired_notice_send_failed", {
        sessionId: lookup.sessionId,
        error: err instanceof Error ? err.message : String(err),
      })
    }
    if (noticeSent) {
      // Stamp the one-time gate ONLY after the notice actually went out (a failed send leaves it
      // unset so a retry can still notify).
      try {
        await sessionRef.set({ expiryNoticeSentAt: new Date().toISOString() }, { merge: true })
      } catch (err) {
        log("prescreen.turn.expired_notice_stamp_failed", {
          sessionId: lookup.sessionId,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }
    return { handled: true, sessionId: lookup.sessionId, terminal: "PAUSE", textSent: text }
  }

  const sessionId = lookup.sessionId

  const store = new FirestorePreScreenStore(args.db)
  const state = await store.load(sessionId)
  if (!state) return { handled: false }

  // Pull cfgSnapshot persisted at session start
  const sessRaw = await args.db.collection("pa-prescreen-sessions").doc(sessionId).get()
  const activeQIdRaw = sessRaw.data()?.currentQId
  const activeQId = typeof activeQIdRaw === "string" ? activeQIdRaw : null
  const loadedTerminal = state.terminal ?? null
  if (loadedTerminal !== null || !activeQId) {
    log("prescreen.turn.stale_terminal_session_ignored", {
      userId: args.userId,
      sessionId,
      terminal: loadedTerminal,
      currentQId: activeQId,
    })
    return { handled: false, sessionId, terminal: loadedTerminal }
  }
  const cfgSnapshot = sessRaw.data()?.cfgSnapshot as
    | { questions: Array<{ qId: string; prompt: { zh: string; en: string }; clarifyPrompt: { zh: string; en: string }; keywords: KeywordSpec[] }> }
    | undefined
  if (!cfgSnapshot?.questions) {
    log("prescreen.turn.no_config", { sessionId })
    return { handled: false }
  }

  // ── MID-SCREEN STATUS / IDENTITY QUESTIONS (Adam 2026-06-12, priority 1+2; isClaireEntryUxCanary) ──
  // "is the screening over?" / "is this for the Invoko PM role?" mid-screen used to be fed to the
  // judge and SCORED as evidence for the pending question (the G1 consumed-tangent hole). For the
  // entry-UX cohort, answer these deterministically from session STATE (cfgSnapshot job title/company +
  // the pending question), do NOT score, and continue the screen in the same reply — the screen keeps
  // OWNERSHIP, no matching offer, no review claim. Non-canary keeps the legacy path byte-for-byte.
  // Detection is deliberately narrow (short interrogatives that NAME the screen/role) so a real answer
  // that merely contains a question mark never matches; any miss falls through to the normal pipeline.
  if (isClaireEntryUxCanary(args.userId)) {
    const statusKind = isPrescreenRoleIdentityQuestion(args.replyText)
      ? ("role_identity" as const)
      : isPrescreenScreenStatusQuestion(args.replyText)
        ? ("screen_over" as const)
        : null
    if (statusKind) {
      const activeQuestion = cfgSnapshot.questions.find((q) => q.qId === activeQId)
      const pendingPrompt =
        activeQuestion?.prompt?.[args.lang ?? "en"] ?? activeQuestion?.prompt?.en ?? ""
      const cfgMeta = sessRaw.data()?.cfgSnapshot as Record<string, unknown> | undefined
      const text = composePrescreenStatusAnswer({
        kind: statusKind,
        ...(typeof cfgMeta?.jobTitle === "string" && cfgMeta.jobTitle.trim()
          ? { jobTitle: cfgMeta.jobTitle.trim() }
          : {}),
        ...(typeof cfgMeta?.company === "string" && cfgMeta.company.trim()
          ? { company: cfgMeta.company.trim() }
          : {}),
        pendingPrompt,
      })
      const nowIso = new Date().toISOString()
      await args.db
        .collection("pa-prescreen-sessions")
        .doc(sessionId)
        .collection("turns")
        .add({
          qId: activeQId,
          reply: args.replyText,
          action: { kind: "status_answered", reason: statusKind },
          ts: nowIso,
        })
      // Refresh updatedAt: a status question is real engagement — it must not bleed the expiry clock.
      await args.db
        .collection("pa-prescreen-sessions")
        .doc(sessionId)
        .set({ updatedAt: nowIso }, { merge: true })
      try {
        await sendSms({
          to: args.toE164,
          content: text,
          userId: args.userId,
          db: args.db,
          runtimeSource: "pa_prescreen_runtime",
          idempotencyKey: `prescreen_status_answer:${sessionId}:${stablePrescreenSendKey(args.replyText, text)}`,
        })
      } catch (err) {
        log("prescreen.turn.status_answer_send_failed", {
          sessionId,
          error: err instanceof Error ? err.message : String(err),
        })
      }
      log("prescreen.turn.status_question_answered", {
        sessionId,
        userId: args.userId,
        kind: statusKind,
        currentQId: activeQId,
      })
      return { handled: true, sessionId, terminal: null, textSent: text }
    }
  }

  // USER-EXIT MEANING-EXTRACTION (canary, Adam 2026-06-05): `isUserExitPrescreenReply` is a REGEX that
  // classified the candidate's text → "exit" — and it mis-fired on Sai's ON-TOPIC role answer ("UX
  // designer, product designer with 5 or less years of experience"), force-PAUSING an active screen mid-
  // answer. For the dev cohort we do NOT let the regex decide: skip this branch so the turn drops into the
  // normal active-turn pipeline below (the agentic prescreen path / the deterministic reducer), where the
  // LLM judges whether the reply is a real exit vs an answer. The reducer/handler still OWNS the PAUSE
  // state write (on a genuine exit the agentic exit path drives the same deterministic terminal write) —
  // the LLM only signals intent, never writes terminal state. Non-canary keeps the regex exit byte-for-byte.
  if (!isPrescreenRetentionHandoffCanary(args.userId) && isUserExitPrescreenReply(args.replyText)) {
    const nowIso = new Date().toISOString()
    await args.db
      .collection("pa-prescreen-sessions")
      .doc(sessionId)
      .set(
        {
          terminal: "PAUSE",
          terminalReason: "user_exit",
          currentQId: null,
          updatedAt: nowIso,
          workSession: {
            ...(state.workSession ?? { kind: "job_prescreen" }),
            kind: "job_prescreen",
            status: "ended",
            endedAt: nowIso,
            boundary: "user_exit",
          },
        },
        { merge: true },
      )
    await args.db
      .collection("pa-prescreen-sessions")
      .doc(sessionId)
      .collection("turns")
      .add({
        qId: activeQId ?? "terminal",
        reply: args.replyText,
        action: { kind: "terminal", terminal: "PAUSE", reason: "user_exit" },
        ts: nowIso,
      })
    try {
      await terminalAction({
        db: args.db,
        sessionId,
        terminal: "PAUSE",
        userId: args.userId,
        jobId: state.jobId,
        toE164: args.toE164,
        lang: args.lang ?? "en",
        log,
      })
    } catch (err) {
      log("prescreen.user_exit_terminal_action_failed", {
        sessionId,
        error: err instanceof Error ? err.message : String(err),
      })
    }
    const text = userExitSessionText(args.lang ?? "en")
    try {
      await sendSms({
        to: args.toE164,
        content: text,
        userId: args.userId,
        db: args.db,
        runtimeSource: "pa_prescreen_runtime",
        idempotencyKey: `prescreen_user_exit:${sessionId}`,
      })
    } catch (err) {
      log("prescreen.user_exit_notice_send_failed", {
        sessionId,
        error: err instanceof Error ? err.message : String(err),
      })
    }
    log("prescreen.turn.user_exit", { sessionId, userId: args.userId })
    return { handled: true, sessionId, terminal: "PAUSE", textSent: text }
  }

  // Build PreScreenQuestion bindings with production LLM caller. Best-effort
  // candidate context (résumé/profile) so the judge credits proven evidence
  // and the clarify composer stops re-asking what the profile already proves.
  const candidateContext = await buildPrescreenCandidateContext(args.db, args.userId)
  const caller = args.keywordSetCaller ?? makeProductionKeywordSetCaller(candidateContext)
  const questions: Record<string, PreScreenQuestion> = {}
  for (const q of cfgSnapshot.questions) {
    questions[q.qId] = {
      qId: q.qId,
      prompt: q.prompt,
      clarifyPrompt: q.clarifyPrompt,
      judge: new KeywordSetJudge({
        questionId: q.qId,
        keywords: q.keywords,
        questionPrompt: q.prompt.en,
        llmCaller: caller,
        candidateContext,
      }),
    }
  }
  const pipeline = new PreScreenPipeline({
    questions,
    store,
    log,
    composeClarify: args.clarifyComposer ?? makeProductionClarifyComposer(candidateContext),
  })
  const runReducerTurn = (reply: string) =>
    pipeline.runTurn({
      sessionId,
      reply,
      lang: args.lang ?? "en",
      nowIso: new Date().toISOString(),
      judgeCtx: { userId: args.userId, turnId: `t_${Date.now()}` },
    })

  // ── Image-proof guard (live victim 2026-06-19) ───────────────────────────
  // A candidate answered a scoring question with ONLY a screenshot (3 analytics
  // images) and no text → the reply reached the judge empty → scored 0 →
  // HARD_STOP. That's an unfair rejection for someone whose only sin was
  // sending an image. When an image arrives with no usable text on a real
  // scoring question, ask for the text/link INSTEAD of scoring it — never
  // advance, never terminal. The outbox idempotency key (per session+qId) keeps
  // a candidate who spams images from being re-pinged. Vision/OCR extraction
  // (reuse cv-ingest, needs ANTHROPIC_API_KEY) can later slot in here to read
  // the screenshot directly; until then the ask-guard is the correctness floor.
  if (
    isLikelyImageMediaUrl(args.mediaUrl) &&
    args.replyText.trim().length < 3 &&
    questions[activeQId] !== undefined
  ) {
    const askText =
      "i can't read a screenshot directly here — can you paste the key numbers/text (or a link) so it counts toward your screen? that way i log it properly and it's credited."
    try {
      await sendSms({
        to: args.toE164,
        content: askText,
        userId: args.userId,
        db: args.db,
        runtimeSource: "pa_prescreen_runtime",
        idempotencyKey: `prescreen_image_ask:${sessionId}:${activeQId}`,
      })
    } catch (err) {
      log("prescreen.turn.image_ask_send_failed", {
        sessionId,
        error: err instanceof Error ? err.message : String(err),
      })
    }
    try {
      await args.db
        .collection("pa-prescreen-sessions")
        .doc(sessionId)
        .collection("turns")
        .add({
          qId: activeQId,
          reply: `[image attachment: ${args.mediaUrl ?? ""}]`,
          action: { kind: "image_proof_ask", reason: "image_only_reply_no_text" },
          ts: new Date().toISOString(),
        })
    } catch {
      // observability only — never block
    }
    log("prescreen.turn.image_proof_ask", { sessionId, activeQId })
    return { handled: true, sessionId, terminal: null, textSent: askText }
  }

  // ── P3 scoped prescreen agent (flag `paAgenticPrescreenEnabled`, default OFF)
  // Flag OFF (default) → this whole block is skipped and the deterministic
  // reducer turn below runs byte-for-byte unchanged (zero regression).
  // Flag ON → a scoped agent composes the ASK + routes the reply; its ONLY
  // FSM-write path is `record_prescreen_answer` → runReducerTurn (the reducer
  // stays the controller). A tangent is held (pending question re-asked) and we
  // return early. ANY agent error → fall through (fail open) to the reducer.
  const agenticOn = await isAgenticPrescreenEnabled(args.db, args.userId)
  if (agenticOn) {
    try {
      const activePrompt =
        questions[activeQId]?.prompt?.[args.lang ?? "en"] ??
        questions[activeQId]?.prompt?.en ??
        ""
      const agentic = await runAgenticPrescreenTurn({
        replyText: args.replyText,
        lang: args.lang ?? "en",
        questionPrompt: activePrompt,
        runTurn: (reply) => runReducerTurn(reply) as Promise<AgenticRunTurnResult>,
        log,
        // T4 (tracing): group the prescreen leg with its conversation (groupId=sessionId) + attach userId.
        sessionId,
        userId: args.userId,
      })
      if (agentic.routed === "tangent") {
        // Pending question HELD — reducer NOT touched. Answer the tangent (or
        // re-ask the pending question if the agent produced no usable text),
        // record an observability turn, and short-circuit.
        const reAsk = activePrompt
        const text = agentic.tangentText?.trim()
          ? `${agentic.tangentText.trim()}${reAsk ? `\n\n${reAsk}` : ""}`
          : reAsk
        await args.db
          .collection("pa-prescreen-sessions")
          .doc(sessionId)
          .collection("turns")
          .add({
            qId: activeQId,
            reply: args.replyText,
            action: { kind: "agentic_tangent_held", reason: "off_topic_pending_held" },
            ts: new Date().toISOString(),
          })
        if (text) {
          try {
            await sendSms({
              to: args.toE164,
              content: text,
              userId: args.userId,
              db: args.db,
              runtimeSource: "pa_prescreen_runtime",
              idempotencyKey: `prescreen_agentic_tangent:${sessionId}:${activeQId}:${stablePrescreenSendKey(args.replyText, text)}`,
            })
          } catch (err) {
            log("prescreen.turn.agentic_tangent_send_failed", {
              sessionId,
              error: err instanceof Error ? err.message : String(err),
            })
          }
        }
        log("prescreen.turn.agentic_tangent_held", { sessionId, currentQId: activeQId })
        return { handled: true, sessionId, terminal: null, textSent: text }
      }
      // routed === "answered": the reducer already ran. Fall through to the
      // SHARED downstream path with the reducer's result (turn record +
      // idempotent ASK send + terminal commit) unchanged.
      const result = agentic.result as unknown as Awaited<ReturnType<typeof runReducerTurn>>
      return await finalizePrescreenTurnResult({ args, sessionId, activeQId, cfgSnapshot, sendSms, log, result })
    } catch (err) {
      log("prescreen.turn.agentic_fail_open", {
        sessionId,
        error: err instanceof Error ? err.message : String(err),
      })
      // fall through to deterministic path
    }
  }

  const result = await runReducerTurn(args.replyText)
  return await finalizePrescreenTurnResult({ args, sessionId, activeQId, cfgSnapshot, sendSms, log, result })
}

/**
 * Shared downstream commit for a completed reducer turn — used by BOTH the
 * deterministic path (flag OFF) and the agentic "answered" path (flag ON). The
 * agent toolset never reaches here, so the TERMINAL commit + idempotency keys
 * stay outside the LLM's control and identical across both paths.
 */
async function finalizePrescreenTurnResult(params: {
  args: RunPrescreenTurnArgs
  sessionId: string
  activeQId: string
  cfgSnapshot: { questions: Array<{ qId: string; prompt: { zh: string; en: string }; clarifyPrompt: { zh: string; en: string }; keywords: KeywordSpec[] }> }
  sendSms: RuntimeSmsSender
  log: (event: string, payload: Record<string, unknown>) => void
  result: Awaited<ReturnType<PreScreenPipeline["runTurn"]>>
}): Promise<RunPrescreenTurnResult> {
  const { args, sessionId, activeQId, cfgSnapshot, sendSms, log, result } = params

  // Persist a turn record for dashboard observability
  const turnQId = prescreenTurnRecordQId(result.action, activeQId)
  const scored = prescreenTurnRecordScored(result.state, turnQId)
  await args.db
    .collection("pa-prescreen-sessions")
    .doc(sessionId)
    .collection("turns")
    .add({
      qId: turnQId,
      reply: args.replyText,
      ...(scored ? { scored } : {}),
      action: result.action,
      ts: new Date().toISOString(),
    })

  // ── Mirror the turn into pa-messages (2026-06-21, P2 cross-pipeline) ───────
  // Prescreen turns previously lived ONLY in pa-prescreen-sessions/{id}/turns,
  // so the conversation extractor (reads pa-messages by userId) and thin-Claire
  // never saw the screen — the runner started blind to what the candidate just
  // told the screen. Mirror the inbound reply (role:user) + the outbound text
  // (role:assistant) as the SAME pa-messages shape cutover.ts writes. Idempotent
  // on content; fail-open (never block the turn). Carries the prescreen
  // sessionId in rawMeta for audit.
  try {
    const mirrorIso = new Date().toISOString()
    const replyText = args.replyText.trim()
    if (replyText.length > 0) {
      const userMsgId = `prescreen-msg-user:${sessionId}:${turnQId}:${stablePrescreenSendKey(replyText)}`
      await args.db.collection(PA_COLLECTIONS.messages).doc(userMsgId).set({
        id: userMsgId,
        sessionId,
        userId: args.userId,
        role: "user",
        body: replyText,
        createdAt: mirrorIso,
        idempotencyKey: userMsgId,
        rawMeta: { source: "prescreen_persist", prescreenSessionId: sessionId, qId: turnQId },
      })
    }
    if (result.text && result.text.trim().length > 0) {
      const asstMsgId = `prescreen-msg-asst:${sessionId}:${turnQId}:${stablePrescreenSendKey(result.text)}`
      await args.db.collection(PA_COLLECTIONS.messages).doc(asstMsgId).set({
        id: asstMsgId,
        sessionId,
        userId: args.userId,
        role: "assistant",
        body: result.text.trim(),
        createdAt: mirrorIso,
        idempotencyKey: asstMsgId,
        rawMeta: { source: "prescreen_persist", prescreenSessionId: sessionId, qId: turnQId },
      })
    }
  } catch (mirrorErr) {
    log("prescreen.turn.pa_messages_mirror_failed", {
      sessionId,
      error: mirrorErr instanceof Error ? mirrorErr.message : String(mirrorErr),
    })
  }

  // DEFAULT AI-acceleration question (Adam directive) — ASK-ONCE persist on the LEGACY/FSM path.
  // When the appended q_ai_acceleration was the question just answered on this turn (it is appended
  // LAST, so this is normally the terminal-driving turn), dual-write the answer with the SAME writers
  // the thin path uses (process-tools.ts): the generalized cross-session store
  // pa-users.prescreenSharedAnswers["ai_usage"] (sole writer) PLUS the back-compat skip tag
  // tags.aiAccelerationUsage. Best-effort; a write failure NEVER blocks the verdict. The AI question is
  // non-gating (weight 0 / GOOD_TO_HAVE), so this only persists fluency — it does not affect PASS/FAIL.
  await persistLegacyAiQuestionAnswer({ args, sessionId, activeQId, result, log })

  const reviewTerminal =
    result.action.kind === "terminal" ? prescreenHumanReviewTerminal(result.action.terminal) : null
  let textSent = result.text

  if (result.text && !reviewTerminal) {
    try {
      await sendSms({
        to: args.toE164,
        content: result.text,
        userId: args.userId,
        db: args.db,
        runtimeSource: "pa_prescreen_runtime",
        idempotencyKey: `prescreen_turn:${sessionId}:${turnQId}:${stablePrescreenSendKey(args.replyText, result.text)}`,
      })
    } catch (err) {
      log("prescreen.turn.send_failed", {
        sessionId,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  log("prescreen.turn.handled", {
    sessionId,
    action: result.action.kind,
    terminal: result.state.terminal,
  })

  // Screening eval invariant: terminal scoring creates a review artifact and a
  // neutral pending-review acknowledgement only. Employment-impacting downstream
  // actions are behind operator commit via paReviewEvaluationAttempt.
  if (
    result.action.kind === "terminal" &&
    (result.action.terminal === "PASS" ||
      result.action.terminal === "FAIL" ||
      result.action.terminal === "HARD_STOP" ||
      result.action.terminal === "PAUSE")
  ) {
    const terminalAt = result.state.updatedAt ?? new Date().toISOString()
    if (reviewTerminal) {
      const finalized = await finalizePrescreenForHumanReview({
        db: args.db,
        state: result.state,
        cfgSnapshot,
        terminal: reviewTerminal,
        toE164: args.toE164,
        lang: args.lang ?? "en",
        sendSms,
        markReviewPending: args.markReviewPending,
        log,
      })
      textSent = finalized.pendingAckText
    } else {
      await writePrescreenMemoryUpdate({
        db: args.db,
        sessionId,
        userId: args.userId,
        jobId: result.state.jobId,
        terminal: result.action.terminal,
        occurredAt: terminalAt,
        log,
      })
    }
    await markUserPrescreenWorkSessionEnded({
      db: args.db,
      userId: args.userId,
      sessionId,
      jobId: result.state.jobId,
      terminal: result.action.terminal,
      nowIso: terminalAt,
    }).catch((err) => {
      log("prescreen.turn.user_work_session_end_failed", {
        sessionId,
        error: err instanceof Error ? err.message : String(err),
      })
    })
  }

  return {
    handled: true,
    sessionId,
    terminal: result.state.terminal,
    textSent,
  }
}

/**
 * ASK-ONCE persist for the legacy/FSM default AI-acceleration question. Mirrors the thin path's
 * dual-write in claire-agent/tools/process-tools.ts so BOTH paths feed the same cross-session store.
 * Fires only on the turn that just answered q_ai_acceleration (activeQId === AI_QUESTION_QID and the
 * Q now has an answer on record). Idempotent in practice: the AI Q is answered exactly once per
 * session (last question), and the merge writer is recency-guarded. Best-effort — never throws.
 */
async function persistLegacyAiQuestionAnswer(params: {
  args: RunPrescreenTurnArgs
  sessionId: string
  activeQId: string
  result: Awaited<ReturnType<PreScreenPipeline["runTurn"]>>
  log: (event: string, payload: Record<string, unknown>) => void
}): Promise<void> {
  const { args, sessionId, activeQId, result, log } = params
  const logOpt = (event: string, payload?: Record<string, unknown>) => log(event, payload ?? {})
  if (activeQId !== AI_QUESTION_QID) return
  const qState = result.state.questions?.[AI_QUESTION_QID]
  // Only persist once the AI question is actually answered this turn (answeredAt stamped). A clarify
  // round leaves answeredAt unset → skip until it resolves.
  if (!qState || typeof qState.answeredAt !== "string") return
  const reply = Array.isArray(qState.evidenceReplies)
    ? qState.evidenceReplies.join(" ").trim()
    : (args.replyText ?? "").trim()
  if (!reply) return
  const nowIso = new Date().toISOString()
  try {
    if (isRegisteredSharedKey(AI_USAGE_SHARED_KEY)) {
      await mergeUserPrescreenSharedAnswers(
        args.db,
        args.userId,
        {
          sharedKey: AI_USAGE_SHARED_KEY,
          reply,
          evidenceReplies: [reply],
          ...(typeof qState.finalS === "number" ? { finalS: qState.finalS } : {}),
          sourceSessionId: sessionId,
          sourceJobId: result.state.jobId,
          answeredAt: nowIso,
          updatedAt: nowIso,
        },
        { nowIso, log: logOpt },
      )
    }
  } catch (err) {
    log("prescreen.legacy_ai_question.shared_answer_write_error", {
      sessionId,
      error: err instanceof Error ? err.message : String(err),
    })
  }
  // BACK-COMPAT skip signal (migration window) — keep tags.aiAccelerationUsage warm so the legacy
  // shouldSkipAiQuestion branch + any reader still skips on the next session. Drop once carry-over is
  // the sole read path.
  try {
    await applyPartialUserTags(
      args.db,
      args.userId,
      { aiAccelerationUsage: { value: reply, updatedAt: nowIso } } as PartialUserTags,
      { source: "chat", nowIso, log: logOpt },
    )
  } catch (err) {
    log("prescreen.legacy_ai_question.tag_write_error", {
      sessionId,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

// Graceful endings (Adam 2026-06-10): a closed screen is never an exit from the marketplace —
// zero ding on the candidate, restart anytime, and Claire keeps matching them meanwhile.
// KEEP IN SYNC with the duplicates in packages/pa-orchestrator/src/prescreen/runner.ts.
function expiredSessionText(_lang: "zh" | "en"): string {
  return "heads up — this role screen timed out, so i closed it instead of mixing old answers into a stale screen. zero ding on you. reply \"restart screen\" and i'll start a fresh run for this role."
}

function userExitSessionText(_lang: "zh" | "en"): string {
  return "no problem — i paused this role screen and kept everything you've shared on your profile. pick it back up anytime from the job page (or just ask me), and i'll keep matching you to other roles in the meantime."
}

function recentTerminalSessionText(lang: "zh" | "en", terminal?: string | null): string {
  return postPrescreenOnboardingPrompt(lang, terminal)
}

// STALE-TIMEOUT follow-up (Adam 2026-06-12): truthful state + the restart path. NEVER an
// "under review" claim (nothing was submitted) and NEVER a matching offer in the same breath.
function staleTimeoutFollowupText(_lang: "zh" | "en"): string {
  return "that role screen timed out earlier, so i closed it — nothing went to the hiring team, and it's zero ding on you. reply \"restart screen\" and i'll start a fresh run for that role, or ask me anything else."
}

/**
 * MID-SCREEN "is the screening over / are we done?" detector (Adam 2026-06-12 priority 2).
 * Deliberately NARROW: a short interrogative that names the screen/interview (or the bare
 * "are we done?" shapes) — a substantive ANSWER that merely contains a question mark must
 * never match (it falls through to the judge). Intent ROUTING at a deterministic seam, not
 * tagging — same class as the existing post-terminal intent helpers in this file.
 */
export function isPrescreenScreenStatusQuestion(reply: string): boolean {
  const body = reply.trim()
  if (!body || body.length > 200) return false
  const lower = body.toLowerCase()
  const asksQuestion = /[?？]/.test(body) || /^(is|are|was|am i|do i|how many)\b/.test(lower)
  if (!asksQuestion) return false
  if (
    /\b(is|are)\s+(the\s+|this\s+|that\s+)?(screen(ing)?|interview|prescreen|pre-screen)\b[^.!?]*\b(over|done|finished|complete|completed|wrapped(\s+up)?)\b/.test(lower)
  ) {
    return true
  }
  if (/^(is\s+(it|this|that)\s+(over|done|finished)|are\s+we\s+(done|finished)|is\s+that\s+(it|all|everything|the\s+end)|was\s+that\s+(it|all|the\s+last\s+question))\b/.test(lower)) {
    return true
  }
  return /\bhow\s+many\s+(more\s+)?questions?\b|\bquestions?\s+(are\s+)?left\b|\b(any|more)\s+questions?\s+(left|to\s+go)\b|\bis\s+(this|that)\s+the\s+last\s+question\b/.test(lower)
}

/**
 * MID-SCREEN "is this for the <X> role? / which job is this for?" detector (Adam 2026-06-12
 * priority 2 — the live "is this for Invoko PM?" shape). Same narrowness contract as above.
 */
export function isPrescreenRoleIdentityQuestion(reply: string): boolean {
  const body = reply.trim()
  if (!body || body.length > 200) return false
  const lower = body.toLowerCase()
  const asksQuestion = /[?？]/.test(body) || /^(is|was|which|what|who)\b/.test(lower)
  if (!asksQuestion) return false
  if (/^(is|was)\s+(this|that|it)\s+((screen|screening|interview|one)\s+)?for\b/.test(lower)) return true
  if (/\b(what|which)\s+(role|job|position|company)\s+(is|was)\s+(this|that|it)\s+for\b/.test(lower)) return true
  if (/\b(what|which)\s+(role|job|position|company)\s+am\s+i\s+(interviewing|screening|being\s+screened)\s+for\b/.test(lower)) return true
  return /\bwho\s+is\s+this\s+(screen(ing)?|interview)\s+(for|with)\b/.test(lower)
}

/** State-accurate mid-screen status reply: truth + continue the screen (Adam priority 2 copy). */
export function composePrescreenStatusAnswer(args: {
  kind: "screen_over" | "role_identity"
  jobTitle?: string
  company?: string
  pendingPrompt: string
}): string {
  const role = [args.jobTitle, args.company].filter(Boolean).join(" @ ") || "this role"
  const pending = args.pendingPrompt.trim()
  if (args.kind === "role_identity") {
    return pending
      ? `yep — this screen is for ${role}. ${pending}`
      : `yep — this screen is for ${role}.`
  }
  return pending
    ? `not yet — still a couple of questions to go for ${role}. next one: ${pending}`
    : `not yet — almost there for ${role}.`
}

function recentTerminalCourtesyAckText(_lang: "zh" | "en"): string {
  return "You're welcome — I’ll keep this role screen closed. If you need anything later, message me here."
}

function recentTerminalOutcomeExplanationText(
  _lang: "zh" | "en",
  terminal: string | null | undefined,
  session: Record<string, unknown>,
): string {
  const cfg = session.cfgSnapshot && typeof session.cfgSnapshot === "object"
    ? session.cfgSnapshot as Record<string, unknown>
    : {}
  const jobTitle = cleanOutcomeText(cfg.jobTitle, 80) ?? "this role"
  const company = cleanOutcomeText(cfg.company, 80)
  const roleLabel = company ? `${jobTitle} at ${company}` : jobTitle
  const strongest = strongestPrescreenSignal(session)
  const weakest = weakestPrescreenSignal(session)
  const terminalLabel = terminal === "PASS" ? "passed" : terminal === "PAUSE" ? "paused" : "ended"

  const strongText = strongest
    ? `Your strongest signal was ${strongest.label}${strongest.summary ? `: ${strongest.summary}` : ""}. `
    : ""
  const weakText = weakest
    ? `The main gap was ${weakest.label}${weakest.summary ? `: ${weakest.summary}` : ""}. `
    : "The main gap was that the evidence stayed too general. "
  return `For ${roleLabel}, this screen is ${terminalLabel}. ${strongText}${weakText}To improve fit next time, give one concrete example with what you personally owned, the implementation or tradeoff you handled, how you validated it, and the result. I’ll keep using what you shared for better-aligned roles.`
}

function cleanOutcomeText(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null
  const clean = value.replace(/\s+/g, " ").trim()
  return clean ? clean.slice(0, max) : null
}

function prescreenQuestionLabel(qId: string): string {
  return qId
    .replace(/_/g, " ")
    .trim()
}

function cleanOutcomeSummary(value: unknown, max: number): string | null {
  return cleanOutcomeText(value, max)?.replace(/[.。]+$/g, "") ?? null
}

function prescreenSignalRows(session: Record<string, unknown>): Array<{
  qId: string
  label: string
  score: number
  confidence: number
  summary: string | null
}> {
  const questions = session.questions && typeof session.questions === "object"
    ? session.questions as Record<string, unknown>
    : {}
  const rows: Array<{ qId: string; label: string; score: number; confidence: number; summary: string | null }> = []
  for (const [qId, raw] of Object.entries(questions)) {
    if (!raw || typeof raw !== "object") continue
    const q = raw as Record<string, unknown>
    const scored = q.scored && typeof q.scored === "object" ? q.scored as Record<string, unknown> : null
    const aggregate = scored?.aggregate && typeof scored.aggregate === "object"
      ? scored.aggregate as Record<string, unknown>
      : null
    const score = typeof q.finalS === "number"
      ? q.finalS
      : typeof aggregate?.s === "number"
        ? aggregate.s
        : Number.NaN
    if (!Number.isFinite(score)) continue
    const confidence = typeof q.finalC === "number"
      ? q.finalC
      : typeof aggregate?.c === "number"
        ? aggregate.c
        : Number.NaN
    rows.push({
      qId,
      label: prescreenQuestionLabel(qId),
      score,
      confidence: Number.isFinite(confidence) ? confidence : 0,
      summary: cleanOutcomeSummary(aggregate?.summary, 140),
    })
  }
  return rows
}

function strongestPrescreenSignal(session: Record<string, unknown>) {
  return prescreenSignalRows(session)
    .sort((a, b) => b.score - a.score || b.confidence - a.confidence)[0] ?? null
}

function weakestPrescreenSignal(session: Record<string, unknown>) {
  return prescreenSignalRows(session)
    .filter((row) => row.score < 0.8 || row.confidence < 0.7)
    .sort((a, b) => a.score - b.score || a.confidence - b.confidence)[0] ??
    prescreenSignalRows(session).sort((a, b) => a.score - b.score || a.confidence - b.confidence)[0] ??
    null
}
