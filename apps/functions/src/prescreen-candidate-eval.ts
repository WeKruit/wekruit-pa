/**
 * prescreen-candidate-eval.ts — enrich + checklist-evaluate a prescreen candidate.
 *
 * Today a prescreen only evaluates the CONVERSATION. This adds the SAME pipeline the
 * recruiter-submission eval uses: take the candidate's LinkedIn/résumé, enrich via
 * Coresignal (through the unified `pa-coresignal-cache` store — a candidate already
 * pulled is NOT re-fetched), and judge them against the JOB'S checklist
 * (hard/fit/anti/bonus + background pillars). The result is stored per-session on
 * `review.candidateChecklistEval` and folded into the rejection/next-step draft.
 *
 * Per (candidate × job): a candidate can have many prescreen sessions for different
 * jobs; each session is judged against THAT job's checklist (the Coresignal pull is
 * shared via the cache, the judgment is fresh per job).
 *
 * ADVISORY ONLY — never changes the prescreen terminal / status. It informs the
 * operator + the draft; the FSM + human review still own the decision. Fail-open:
 * any error leaves the session untouched.
 *
 * Fires from `paPrescreenCandidateEval` (onDocumentWritten on pa-prescreen-sessions)
 * the moment a session enters pending HITL review.
 */
import { onDocumentWritten } from "firebase-functions/v2/firestore"
import { defineSecret } from "firebase-functions/params"
import { getFirestore, type Firestore } from "firebase-admin/firestore"
import { logger } from "firebase-functions/v2"
import { callWithFallback } from "@pa/pa-resume-parser"
import {
  searchEmployeeIdByLinkedinUrl,
  fetchEmployeeCollect,
} from "@pa/external-supply"
import { getOrFetchCoresignalByLinkedin } from "./lib/coresignal-cache.js"
import { getAnthropicConfig, getOpenAIConfig } from "./lib/llm-providers.js"
import { ANTHROPIC_API_KEY } from "./orchestrator-deps.js"
import {
  buildResearchFromEmployee,
  buildSchoolPriorNote,
  extractChecklistGroups,
  renderChecklist,
  roleFunctionsOf,
  looksLikeLinkedinUrl,
  EVAL_JUDGMENT_JSON_SCHEMA,
  EvalJudgmentSchema,
  type SubmissionAiEvaluation,
  type SubmissionEvalResearch,
} from "./recruiter-submission-eval.js"
import { generateAndStorePrescreenAutoDraft } from "./evaluation-attempts.js"
import { runPrescreenEngagementSignal } from "./prescreen-engagement-signal.js"

const PA_OPENAI_AGENT_API_KEY = defineSecret("PA_OPENAI_AGENT_API_KEY")
const CORESIGNAL_API_KEY = defineSecret("CORESIGNAL_API_KEY")

const SESSIONS = "pa-prescreen-sessions"
const USERS = "pa-users"
const JOBS = "pa-jobs"

/** Per-item AI assessment of one checklist requirement (mirrors the recruiter page). */
export type ChecklistItemDetail = {
  /** met = hard/fit/bonus satisfied · gap = required item the candidate didn't show · flag = anti-signal present · clear = anti-signal absent. */
  status: "met" | "gap" | "flag" | "clear"
  text: string
}
export type ChecklistGroupDetail = {
  kind: "hard" | "fit" | "bonus" | "anti"
  heading: string
  items: ChecklistItemDetail[]
}

/** The per-(candidate×job) profile checklist evaluation, stored on the session. */
export type PrescreenCandidateChecklistEval = SubmissionAiEvaluation & {
  jobId: string
  candidateId: string
  /** True when ANY profile evidence (Coresignal/LinkedIn OR résumé/merged profile) was available; false = transcript only. */
  enriched: boolean
  /** The FULL job checklist, each item marked with the AI's per-item verdict — for the dashboard to show requirements in parallel. */
  checklistDetail: ChecklistGroupDetail[]
}

const normItem = (s: string): string => s.toLowerCase().replace(/\s+/g, " ").trim()

/** Mark every job-checklist item with the AI's verdict (gap/flag from the judge, else met/clear). */
function buildChecklistDetail(
  groups: Array<{ kind: "hard" | "fit" | "bonus" | "anti"; heading: string; items: Array<{ id: string; text: string }> }>,
  judged: { checklist: { hard: { gaps: string[] }; fit: { gaps: string[] }; bonus: { gaps: string[] }; anti: { flags: string[] } } },
): ChecklistGroupDetail[] {
  return groups.map((g) => {
    const misses = (g.kind === "anti" ? judged.checklist.anti.flags : judged.checklist[g.kind].gaps).map(normItem)
    return {
      kind: g.kind,
      heading: g.heading,
      items: g.items.map((it) => {
        const t = normItem(it.text)
        const hit = misses.some((m) => m === t || m.includes(t) || t.includes(m))
        return { text: it.text, status: g.kind === "anti" ? (hit ? "flag" : "clear") : hit ? "gap" : "met" }
      }),
    }
  })
}

const PRESCREEN_JUDGE_SYSTEM_PROMPT = `You are WeKruit's SUPER CRITICAL prescreen candidate evaluator. A candidate COMPLETED a WeKruit prescreen interview for a specific role. Evaluate them against the job rubric using BOTH (a) their enriched profile research (Coresignal / LinkedIn / resume) and (b) the prescreen transcript. There are NO recruiter self-claims here — judge purely from the evidence in the research + transcript.

Rules:
- Independently assess EVERY hard (must-have) item. An item counts as met ONLY when the research or transcript contains concrete supporting evidence (named companies, durations, specific work). Unmet or unverifiable hard items go in checklist.hard.gaps, listed by their exact item text.
- Apply the same evidence bar to fit and bonus items; list unmet/unverifiable item texts in their gaps arrays.
- For anti-signal items, flagged = items that plausibly apply to this candidate (from research OR transcript); list their exact item texts in checklist.anti.flags.
- met/total (and flagged/total) must tally the rubric items per group; total = number of items in that group.
- Be stingy. verdict "advance" ONLY when checklist.hard.gaps is empty AND the supporting evidence is concrete. Thin/generic/unverifiable evidence is "borderline". Clear hard gaps or applicable anti-signals push toward "reject".
- confidence is 0..1 — how confident you are given the evidence quality (note: if there is NO profile research and only a thin transcript, confidence should be low).
- reasons: short concrete bullets citing the specific evidence (or its absence) that drove the verdict.
- Also independently assess the candidate's BACKGROUND pillars from the research + transcript, and output \`background\` with one of strong / weak / unknown per pillar plus short \`evidence\`:
  - school: "strong" for a target / well-known / brand-name university; "weak" for a real but non-target / lesser-known school. "unknown" ONLY when there is genuinely NO education info anywhere in the research/résumé/transcript. If ANY school is named, you MUST choose "strong" or "weak" (never "unknown") and name that school in \`evidence\` — an unranked or unfamiliar school is "weak", not "unknown".
  - degree: "strong" for a relevant degree/field for this role; "weak" if mismatched; "unknown" if absent.
  - company: "strong" if the candidate has worked at fast-growing startups or strong / brand-name tech companies; "weak" if only unknown / no-name employers (a named-but-unfamiliar employer is "weak", not "unknown"); "unknown" only if no work history at all.
  - gpa: ALMOST ALWAYS "unknown". Set "strong"/"weak" ONLY if the transcript/resume explicitly states a GPA. NEVER infer GPA from the school.
- Output STRICT JSON matching the schema. Nothing else.`

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : ""
}

function renderResearch(research: SubmissionEvalResearch | undefined): string {
  if (!research) return "(no Coresignal/LinkedIn profile research available — judge from the transcript only)"
  const lines: string[] = []
  if (research.headline) lines.push(`headline: ${research.headline}`)
  for (const c of research.companies.slice(0, 8)) {
    lines.push(`- ${c.role ?? "role"} @ ${c.name}${c.years ? ` (${c.years})` : ""}`)
  }
  for (const e of research.education.slice(0, 6)) {
    lines.push(`- education: ${e.school}${e.degree ? ` — ${e.degree}` : ""}`)
  }
  if (research.signals.length > 0) lines.push(`signals: ${research.signals.slice(0, 8).join("; ")}`)
  if (research.risks.length > 0) lines.push(`risks: ${research.risks.slice(0, 6).join("; ")}`)
  return lines.join("\n")
}

/**
 * The candidate's stored profile evidence — the MERGED LinkedIn+résumé experience
 * (`pa-users.experienceHighlights`, written by the merge-at-source pipeline) PLUS the
 * parsed résumé (`parsedCandidateResumes`). This is how a candidate who came in with
 * ONLY a résumé (no LinkedIn / no live Coresignal match) still gets a profile eval, and
 * a candidate with both is judged on the merged picture. Fail-open: "" when none.
 */
async function loadResumeEvidence(
  db: Firestore,
  user: Record<string, unknown>,
  candidateId: string,
): Promise<{ text: string; schools: string[] }> {
  const lines: string[] = []
  const schools: string[] = []
  try {
    const highlights = Array.isArray(user.experienceHighlights) ? user.experienceHighlights : []
    for (const raw of highlights.slice(0, 12)) {
      const h = (raw ?? {}) as Record<string, unknown>
      const title = str(h.title)
      const company = str(h.company)
      if (!title && !company) continue
      const span = str(h.startDate)
        ? ` (${str(h.startDate)}${h.currentRole === true ? "–present" : str(h.endDate) ? `–${str(h.endDate)}` : ""})`
        : ""
      lines.push(`- ${title || "role"} @ ${company || "?"}${span}${str(h.sourceLabel) ? ` [${str(h.sourceLabel)}]` : ""}`)
    }
  } catch {
    /* ignore */
  }
  try {
    const snap = await db.collection("parsedCandidateResumes").where("userId", "==", candidateId).limit(4).get()
    const docs = snap.docs.map((d) => d.data() as Record<string, unknown>)
    docs.sort((a, b) => String(b.createdAt ?? b.ingestedAt ?? "").localeCompare(String(a.createdAt ?? a.ingestedAt ?? "")))
    const resume = docs[0]
    if (resume) {
      const yoe = resume.totalYearsExperience
      if (typeof yoe === "number") lines.push(`résumé total YOE: ${yoe}`)
      for (const raw of (Array.isArray(resume.experiences) ? resume.experiences : Array.isArray(resume.workHistory) ? resume.workHistory : []).slice(0, 8)) {
        const e = (raw ?? {}) as Record<string, unknown>
        const title = str(e.title) || str(e.role) || str(e.position)
        const company = str(e.company) || str(e.companyName) || str(e.organization)
        if (!title && !company) continue
        lines.push(`- résumé: ${title || "role"} @ ${company || "?"}${str(e.duration) || str(e.dates) ? ` (${str(e.duration) || str(e.dates)})` : ""}`)
      }
      for (const raw of (Array.isArray(resume.education) ? resume.education : []).slice(0, 6)) {
        const e = (raw ?? {}) as Record<string, unknown>
        const school = str(e.school) || str(e.institution_name) || str(e.institution)
        if (!school) continue
        schools.push(school)
        lines.push(`- résumé education: ${school}${str(e.degree) ? ` — ${str(e.degree)}` : ""}`)
      }
      const topSkills = Array.isArray(resume.topSkills) ? resume.topSkills : []
      const skills = topSkills.map((s) => (typeof s === "string" ? s : str((s as { value?: unknown })?.value))).filter(Boolean).slice(0, 12)
      if (skills.length > 0) lines.push(`résumé skills: ${skills.join(", ")}`)
    }
  } catch {
    /* ignore — fail-open */
  }
  return { text: lines.join("\n").slice(0, 3_000), schools }
}

async function loadTranscript(db: Firestore, sessionId: string): Promise<string> {
  try {
    const snap = await db.collection(SESSIONS).doc(sessionId).collection("turns").orderBy("ts", "asc").limit(20).get()
    const lines = snap.docs.map((d) => {
      const t = d.data() as { qId?: string; reply?: string; scored?: { aggregate?: { summary?: string } } }
      const qId = str(t.qId) || "q"
      const reply = str(t.reply)
      const summary = str(t.scored?.aggregate?.summary)
      return reply || summary ? `${qId}: "${reply.slice(0, 240)}"${summary ? ` [scored: ${summary.slice(0, 160)}]` : ""}` : ""
    })
    return lines.filter(Boolean).join("\n").slice(0, 4_000) || "(no transcript captured)"
  } catch {
    return "(transcript unavailable)"
  }
}

/** One-line operator-facing summary of the checklist eval (folded into the draft). */
export function summarizeChecklistEval(e: PrescreenCandidateChecklistEval): string {
  const c = e.checklist
  const gaps = c.hard.gaps.slice(0, 3).join("; ")
  const flags = c.anti.flags.slice(0, 3).join("; ")
  const bg = `school=${e.background.school.verdict} degree=${e.background.degree.verdict} company=${e.background.company.verdict} gpa=${e.background.gpa.verdict}`
  return [
    `Profile checklist eval (${e.enriched ? "profile-grounded: LinkedIn/Coresignal + résumé" : "transcript-only — no profile on file"}): verdict=${e.verdict} (conf ${e.confidence.toFixed(2)}).`,
    `Hard ${c.hard.met}/${c.hard.total}${gaps ? ` — gaps: ${gaps}` : ""}. Fit ${c.fit.met}/${c.fit.total}. Bonus ${c.bonus.met}/${c.bonus.total}. Anti ${c.anti.flagged} flag(s)${flags ? `: ${flags}` : ""}.`,
    `Background: ${bg}.`,
    e.summary ? `Summary: ${e.summary}` : "",
  ].filter(Boolean).join(" ")
}

export interface PrescreenCandidateEvalDeps {
  db: Firestore
  callJudge: (args: {
    systemPrompt: string
    userText: string
    schemaName: string
    schema: Record<string, unknown>
  }) => Promise<{ rawJson: string; usedModel: string }>
  research: {
    apiKey: string | null
    searchEmployeeIdByLinkedinUrl: typeof searchEmployeeIdByLinkedinUrl
    fetchEmployeeCollect: typeof fetchEmployeeCollect
  }
  now?: () => string
  /** Re-draft seam — after the eval is stored, fold it into the autoDraft. */
  regenerateDraft?: typeof generateAndStorePrescreenAutoDraft
  log?: (event: string, fields?: Record<string, unknown>) => void
}

export type PrescreenCandidateEvalResult = {
  status: "skipped_no_session" | "skipped_not_pending" | "skipped_existing" | "skipped_no_job_checklist" | "written" | "error"
  sessionId: string
  eval?: PrescreenCandidateChecklistEval
}

/**
 * Enrich + checklist-judge ONE prescreen session against its job's rubric, store the
 * result on `review.candidateChecklistEval`, and fold it into the autoDraft. Advisory,
 * idempotent (skips if already evaluated), fail-open.
 */
export async function runPrescreenCandidateEval(
  sessionId: string,
  deps: PrescreenCandidateEvalDeps,
  opts: { force?: boolean } = {},
): Promise<PrescreenCandidateEvalResult> {
  const log = deps.log ?? (() => {})
  const now = deps.now?.() ?? new Date().toISOString()
  try {
    const sessionSnap = await deps.db.collection(SESSIONS).doc(sessionId).get()
    if (!sessionSnap.exists) return { status: "skipped_no_session", sessionId }
    const session = (sessionSnap.data() ?? {}) as Record<string, unknown>
    if (session.terminalActionPendingReview !== true) return { status: "skipped_not_pending", sessionId }
    const review = (session.review ?? {}) as Record<string, unknown>
    if (review.candidateChecklistEval && !opts.force) return { status: "skipped_existing", sessionId }

    const candidateId = str(session.userId)
    const jobId = str(session.jobId)
    if (!candidateId || !jobId) return { status: "skipped_no_session", sessionId }

    const [userSnap, jobSnap] = await Promise.all([
      deps.db.collection(USERS).doc(candidateId).get(),
      deps.db.collection(JOBS).doc(jobId).get(),
    ])
    const user = (userSnap.data() ?? {}) as Record<string, unknown>
    const job = (jobSnap.data() ?? {}) as Record<string, unknown>
    const groups = extractChecklistGroups(job)
    if (groups.length === 0) return { status: "skipped_no_job_checklist", sessionId }

    // Enrich (cache-aware): the candidate's LinkedIn → Coresignal. Shared across this
    // candidate's other job sessions via the unified store (no re-fetch).
    const linkedinUrl = str(user.linkedinUrl) || str((user.identity as Record<string, unknown> | undefined)?.linkedinUrl)
    let research: SubmissionEvalResearch | undefined
    if (looksLikeLinkedinUrl(linkedinUrl)) {
      const employee = await getOrFetchCoresignalByLinkedin({
        db: deps.db,
        link: linkedinUrl,
        apiKey: deps.research.apiKey,
        now,
        source: "prescreen_candidate_eval",
        search: deps.research.searchEmployeeIdByLinkedinUrl,
        fetch: deps.research.fetchEmployeeCollect,
        log: (event, fields) => log(event, { sessionId, ...(fields ?? {}) }),
      })
      research = employee ? buildResearchFromEmployee(employee) : undefined
    } else {
      log("prescreen_eval.no_linkedin", { sessionId, candidateId })
    }

    const [transcript, resume] = await Promise.all([
      loadTranscript(deps.db, sessionId),
      loadResumeEvidence(deps.db, user, candidateId),
    ])
    const resumeEvidence = resume.text
    const hasProfileEvidence = Boolean(research) || resumeEvidence.length > 0
    // Role-aware school-strength prior (advisory soft signal for the school pillar; never a
    // gate). Schools from Coresignal research + résumé; scoped to the job's roleFunction lens.
    const schoolPriorNote = buildSchoolPriorNote(
      [...(research?.education ?? []).map((e) => e.school), ...resume.schools],
      roleFunctionsOf(job),
    )
    const recruiterBoard = (job.recruiterBoard ?? {}) as Record<string, unknown>
    const label = (recruiterBoard.label ?? {}) as Record<string, unknown>
    const roleLine = [str(label.title) || str(job.title), str(label.company) || str(job.company)].filter(Boolean).join(" @ ")

    const userText = [
      roleLine ? `Role: ${roleLine}` : null,
      "",
      "Job rubric checklist (judge the candidate against ALL the evidence below — Coresignal research + résumé/merged profile + transcript; there are NO recruiter claims here):",
      renderChecklist(groups, {}),
      "",
      "Candidate Coresignal (LinkedIn) research:",
      renderResearch(research),
      "",
      "Candidate résumé / merged LinkedIn+résumé profile:",
      resumeEvidence || "(no résumé / merged profile on file)",
      "",
      schoolPriorNote
        ? "School-strength prior (ADVISORY — WeKruit role-aware target-school list; a SOFT signal, NEVER a gate or reject reason):\n" + schoolPriorNote
        : null,
      schoolPriorNote ? "" : null,
      "Prescreen transcript:",
      transcript,
    ].filter((l): l is string => l !== null).join("\n")

    const judged = await deps.callJudge({
      systemPrompt: PRESCREEN_JUDGE_SYSTEM_PROMPT,
      userText,
      schemaName: "PrescreenCandidateChecklistEval",
      schema: EVAL_JUDGMENT_JSON_SCHEMA as unknown as Record<string, unknown>,
    })
    const parsed = EvalJudgmentSchema.parse(JSON.parse(judged.rawJson))

    const evaluation: PrescreenCandidateChecklistEval = {
      ...parsed,
      ...(research ? { research } : {}),
      enriched: hasProfileEvidence,
      checklistDetail: buildChecklistDetail(groups, parsed),
      jobId,
      candidateId,
      evaluatedAt: now,
      model: judged.usedModel,
      version: "submission-eval-v2",
    }

    await deps.db.collection(SESSIONS).doc(sessionId).set(
      { review: { candidateChecklistEval: evaluation, updatedAt: now }, updatedAt: now },
      { merge: true },
    )
    log("prescreen_eval.written", { sessionId, verdict: parsed.verdict, enriched: Boolean(research) })

    // Fold the profile checklist eval into the rejection/next-step draft so the
    // operator-only notes combine the TRANSCRIPT eval + the PROFILE checklist eval.
    const terminal = str(review.proposedTerminal) || str(session.terminal)
    if (terminal === "PASS" || terminal === "FAIL" || terminal === "HARD_STOP") {
      await (deps.regenerateDraft ?? generateAndStorePrescreenAutoDraft)({
        db: deps.db,
        sessionId,
        candidateId,
        jobId,
        attemptId: str(session.evaluationAttemptId) || str(review.evaluationAttemptId) || undefined,
        terminal,
        proposedTerminal: terminal,
        score: typeof session.score === "number" ? session.score : undefined,
        scoreMax: typeof session.scoreMax === "number" ? session.scoreMax : undefined,
        threshold: typeof session.threshold === "number" ? session.threshold : undefined,
        now,
        // STABLE screen date: terminal-fired time, else session createdAt (screen start) —
        // NOT updatedAt (mutated by any later write, incl. a re-eval).
        screenDateIso: str(session.terminalActionFiredAt) || str(session.createdAt) || now,
        candidateChecklistSummary: summarizeChecklistEval(evaluation),
        force: true,
        log: (event, fields) => log(`redraft.${event}`, fields),
      })
    }

    return { status: "written", sessionId, eval: evaluation }
  } catch (err) {
    log("prescreen_eval.error", { sessionId, error: err instanceof Error ? err.message : String(err) })
    return { status: "error", sessionId }
  }
}

// ---------------------------------------------------------------------------
// CF trigger
// ---------------------------------------------------------------------------

function pendingReviewJustEntered(
  before: Record<string, unknown> | undefined,
  after: Record<string, unknown> | undefined,
): boolean {
  if (!after) return false
  if (after.terminalActionPendingReview !== true) return false
  // already evaluated → the handler is idempotent, but skip the write churn
  if ((after.review as Record<string, unknown> | undefined)?.candidateChecklistEval) return false
  // fire on the transition INTO pending (or first-seen pending)
  return before?.terminalActionPendingReview !== true
}

export const paPrescreenCandidateEval = onDocumentWritten(
  {
    document: "pa-prescreen-sessions/{sessionId}",
    region: "us-central1",
    memory: "512MiB",
    timeoutSeconds: 300,
    secrets: [PA_OPENAI_AGENT_API_KEY, ANTHROPIC_API_KEY, CORESIGNAL_API_KEY],
  },
  async (event) => {
    const before = event.data?.before?.data() as Record<string, unknown> | undefined
    const after = event.data?.after?.data() as Record<string, unknown> | undefined
    if (!pendingReviewJustEntered(before, after)) return

    // Advisory engagement (effort) signal — pure metric over the candidate's replies,
    // no LLM/Coresignal. Runs independently so a session with no job checklist (which
    // skips the checklist eval below) still gets an engagement signal. Fail-open.
    await runPrescreenEngagementSignal(event.params.sessionId, {
      db: getFirestore(),
      log: (e2, f) => logger.info(`[prescreen-engagement] ${e2}`, f ?? {}),
    })

    for (const s of [PA_OPENAI_AGENT_API_KEY, CORESIGNAL_API_KEY] as const) {
      try {
        const v = s.value().trim()
        if (v) process.env[s.name] = v
      } catch {
        /* unset → judge / enrich fail open */
      }
    }
    try {
      const a = ANTHROPIC_API_KEY.value().trim()
      if (a && a !== "__UNSET__") process.env.ANTHROPIC_API_KEY = a
    } catch {
      /* no anthropic fallback */
    }

    const openai = getOpenAIConfig()
    const anthropic = getAnthropicConfig()
    let coresignalKey: string | null = null
    try {
      coresignalKey = CORESIGNAL_API_KEY.value().trim() || null
    } catch {
      coresignalKey = null
    }

    const result = await runPrescreenCandidateEval(event.params.sessionId, {
      db: getFirestore(),
      callJudge: async (args) => {
        if (!openai.apiKey) throw new Error("PA_OPENAI_AGENT_API_KEY missing")
        const out = await callWithFallback({
          apiKey: openai.apiKey,
          baseURL: openai.baseURL,
          anthropicApiKey: anthropic.apiKey ?? undefined,
          systemPrompt: args.systemPrompt,
          userText: args.userText,
          schemaName: args.schemaName,
          schema: args.schema,
        })
        return { rawJson: out.rawJson, usedModel: out.usedModel ?? "unknown" }
      },
      research: {
        apiKey: coresignalKey,
        searchEmployeeIdByLinkedinUrl,
        fetchEmployeeCollect,
      },
      log: (event2, fields) => logger.info(`[prescreen-candidate-eval] ${event2}`, fields ?? {}),
    })
    logger.info("[prescreen-candidate-eval] done", { sessionId: event.params.sessionId, status: result.status })
  },
)
