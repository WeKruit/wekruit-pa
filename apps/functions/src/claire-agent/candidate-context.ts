/**
 * candidate-context.ts — the CONTEXT-COMPLETE assembler for the post-prescreen-terminal /
 * retention turn (Adam-locked CONVERSATION-CONTEXT-FIRST-PRINCIPLE, 2026-06-05).
 *
 * THE BUG IT FIXES (Sai Spandana, +18578918525): a recently-terminal / paused prescreen turn used to
 * be answered from ONLY the session doc + canned text + regex intent (recentTerminalCourtesyAckText
 * → "You're welcome — I'll keep this role screen closed."), dropping the candidate's on-topic role
 * answer, surfacing no real reason, and never matching her to OTHER product roles.
 *
 * THE FIX: a single read-only assembler that the thin context-complete agent threads onto its prompt
 * (via the `candidateContext` channel). It unions:
 *   - the GLOBAL profile (EXACT reuse of agent.ts:loadGlobalContext — profile+tags+résumé fallback)
 *   - EVERY prescreen session for the user (active + terminal, newest-first) with the REAL terminal,
 *     terminalReason, score, and per-question strongest/weakest borderline signal
 *   - the post-terminal retention stage + pending-review flag
 * and renders a plain-English, model-ready block so the agent answers HONESTLY, captures the role
 * answer via the existing no-regex tools, and offers to find OTHER matching roles.
 *
 * CONTRACT (mirrors loadGlobalContext + loadPrescreenContext): read-only, fail-soft, NO throw — every
 * read in its own try/catch; on ANY error returns a partial (never crashes the turn). NO writes, NO
 * LLM, NO regex classifying text → intent (it only READS structured session fields). The reducer
 * (terminal/retain/match) is untouched — this module never writes state.
 */
import type { Firestore } from "firebase-admin/firestore"
import { loadGlobalContext } from "./agent.js"

const PRESCREEN_SESSIONS = "pa-prescreen-sessions"

export interface CandidateScreenSession {
  sessionId: string
  jobId: string
  jobTitle?: string
  company?: string
  /** PASS | FAIL | HARD_STOP | PAUSE | null(active). */
  terminal: string | null
  /** "user_exit" | "ratio=0.927 threshold=0.95" | "expired_inactive_prescreen_session" | … */
  terminalReason?: string
  score?: number
  /** strongest per-question signal (highest scored aggregate). */
  strongestSignal?: { qLabel: string; ratio: number }
  /** weakest per-question signal (lowest scored aggregate). */
  weakestSignal?: { qLabel: string; ratio: number }
  /** terminalActionPendingReview === true: outcome is under WeKruit team review, never claim a decision. */
  pendingReview: boolean
  /** postPrescreenRetention.stage (await_basic_onboarding / onboarding_started / …). */
  retentionStage: string | null
  endedAtMs: number | null
}

export interface CandidateContext {
  userId: string
  /** EXACT reuse of loadGlobalContext (1 read; profile+tags+résumé fallback already inside). */
  globalContextText: string
  /** ALL sessions for the user, active + terminal, newest-first. */
  screens: CandidateScreenSession[]
  mostRecentTerminal: CandidateScreenSession | null
  /** Rendered, model-ready block to thread onto runClaireTurn.candidateContext. "" when no screens. */
  prescreenContextText: string
}

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : ""
}

/** Parse a timestamp-ish value (ISO string / number / Firestore Timestamp) → ms, else null. */
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

function prescreenQuestionLabel(qId: string): string {
  return qId.replace(/_/g, " ").trim()
}

/**
 * EMPLOYER-BACKGROUND one-liner (Adam 2026-06-10) — render the derived employer-history quality
 * signals from `pa-users.tags` (employer-signals.ts seam) as ONE plain-English context line, e.g.
 * "EMPLOYER BACKGROUND: founder experience; big-tech employer history; growth-stage startup
 * history; led team of 5; honors: Top 0.1% of 390K." Returns "" when no signals exist (legacy
 * users) so the context block is byte-identical for them. Pure, display-only — never feeds
 * matching (V16 consumption is a separate Adam-gated decision).
 */
export function renderEmployerBackgroundLine(tags: Record<string, unknown>): string {
  const parts: string[] = []
  if (tags.founderRole === true) parts.push("founder/0→1 experience")
  if (tags.hasBigTechBackground === true) parts.push("big-tech employer history")
  const tier = typeof tags.employerGrowthTier === "string" ? tags.employerGrowthTier : ""
  if (tier === "growth") parts.push("growth-stage startup history")
  else if (tier === "early_stage") parts.push("early-stage startup history")
  else if (tier === "mature") parts.push("mature-company history")
  const scope =
    tags.scopeOfOwnership && typeof tags.scopeOfOwnership === "object" && !Array.isArray(tags.scopeOfOwnership)
      ? (tags.scopeOfOwnership as Record<string, unknown>)
      : null
  if (scope) {
    if (typeof scope.teamSize === "number" && Number.isFinite(scope.teamSize)) {
      parts.push(`led team of ${scope.teamSize}`)
    }
    if (typeof scope.revenue === "string" && scope.revenue.trim()) parts.push(`owned ${scope.revenue.trim()}`)
    if (typeof scope.users === "number" && Number.isFinite(scope.users)) {
      parts.push(`work served ${scope.users} users`)
    }
  }
  const honors = Array.isArray(tags.selectivitySignals)
    ? (tags.selectivitySignals as unknown[]).filter((s): s is string => typeof s === "string" && Boolean(s.trim()))
    : []
  if (honors.length) parts.push(`honors: ${honors.slice(0, 2).join(", ")}`)
  if (!parts.length) return ""
  return `EMPLOYER BACKGROUND (derived from their employer history — use to personalize, never to gate): ${parts.join("; ")}.`
}

/**
 * Per-question borderline signals from `questions{}.scored.aggregate` (the `s`/ratio field).
 * Same shape the legacy `recentTerminalOutcomeExplanationText` computed — kept here so the honest
 * "you were close on X, weaker on Y" answer is computed ONCE for the thin agent. Pure read.
 */
function computeBorderlineSignals(session: Record<string, unknown>): {
  strongest?: { qLabel: string; ratio: number }
  weakest?: { qLabel: string; ratio: number }
} {
  const questions =
    session.questions && typeof session.questions === "object"
      ? (session.questions as Record<string, unknown>)
      : {}
  const rows: Array<{ qLabel: string; ratio: number }> = []
  for (const [qId, raw] of Object.entries(questions)) {
    if (!raw || typeof raw !== "object") continue
    const q = raw as Record<string, unknown>
    const scored = q.scored && typeof q.scored === "object" ? (q.scored as Record<string, unknown>) : null
    const aggregate =
      scored?.aggregate && typeof scored.aggregate === "object"
        ? (scored.aggregate as Record<string, unknown>)
        : null
    const ratio =
      typeof q.finalS === "number" ? q.finalS : typeof aggregate?.s === "number" ? (aggregate.s as number) : Number.NaN
    if (!Number.isFinite(ratio)) continue
    rows.push({ qLabel: prescreenQuestionLabel(qId), ratio: Number((ratio as number).toFixed(3)) })
  }
  if (!rows.length) return {}
  const byScoreDesc = [...rows].sort((a, b) => b.ratio - a.ratio)
  return { strongest: byScoreDesc[0], weakest: byScoreDesc[byScoreDesc.length - 1] }
}

/** Map one raw session doc → a structured CandidateScreenSession. Pure, never throws. */
function toScreenSession(id: string, data: Record<string, unknown>): CandidateScreenSession {
  const cfg = data.cfgSnapshot && typeof data.cfgSnapshot === "object" ? (data.cfgSnapshot as Record<string, unknown>) : {}
  const workSession =
    data.workSession && typeof data.workSession === "object" ? (data.workSession as Record<string, unknown>) : undefined
  const retention =
    data.postPrescreenRetention && typeof data.postPrescreenRetention === "object"
      ? (data.postPrescreenRetention as Record<string, unknown>)
      : null
  const { strongest, weakest } = computeBorderlineSignals(data)
  const endedAtMs =
    timestampMs(workSession?.endedAt) ??
    timestampMs(data.updatedAt) ??
    timestampMs(data.completedAt) ??
    timestampMs(data.createdAt)
  return {
    sessionId: id,
    jobId: str(data.jobId),
    ...(str(cfg.jobTitle) ? { jobTitle: str(cfg.jobTitle) } : {}),
    ...(str(cfg.company) ? { company: str(cfg.company) } : {}),
    terminal: typeof data.terminal === "string" ? data.terminal : null,
    ...(str(data.terminalReason) ? { terminalReason: str(data.terminalReason) } : {}),
    ...(typeof data.score === "number" ? { score: data.score } : {}),
    ...(strongest ? { strongestSignal: strongest } : {}),
    ...(weakest ? { weakestSignal: weakest } : {}),
    pendingReview: data.terminalActionPendingReview === true,
    retentionStage: typeof retention?.stage === "string" ? retention.stage : null,
    endedAtMs,
  }
}

/** Candidate-context label for a terminal, for the rendered block. */
function terminalLabel(s: CandidateScreenSession): string {
  if (s.terminal === null) return "in progress (not finished)"
  if (s.terminal === "PASS") return s.pendingReview ? "PASSED (under WeKruit team review - outcome not final)" : "passed"
  if (s.terminal === "PAUSE") {
    return s.terminalReason === "user_exit"
      ? "PAUSED (you stepped away mid-screen — not a rejection)"
      : "PAUSED (not a rejection)"
  }
  return s.pendingReview ? "did not pass (under WeKruit team review - outcome not final)" : "did not pass"
}

/** One rendered line per prior screen for the model block. */
function renderScreenLine(s: CandidateScreenSession): string {
  const role = [s.jobTitle, s.company].filter(Boolean).join(" @ ") || s.jobId || "a role"
  let detail = ""
  // Only surface the borderline gap on a not-pass terminal (never on PASS/PAUSE — avoid implying failure).
  if (s.terminal === "FAIL" || s.terminal === "HARD_STOP") {
    if (s.strongestSignal && s.weakestSignal) {
      detail = ` — close: strongest signal ${s.strongestSignal.qLabel} ${s.strongestSignal.ratio}, weaker on ${s.weakestSignal.qLabel} ${s.weakestSignal.ratio}`
    } else if (s.weakestSignal) {
      detail = ` — close on most signals`
    }
  }
  return `- ${role} — ${terminalLabel(s)}${detail}.`
}

/**
 * Render the model-ready candidate-context block (threaded into runClaireTurn.candidateContext).
 * Plain English; names the role + terminal + real reason + borderline gap; lists sibling screens so
 * the model knows the candidate has been screened for these roles and should match OTHER matching
 * roles. Returns "" when there are no screens (nothing to add this turn).
 */
function renderPrescreenContextText(screens: CandidateScreenSession[]): string {
  if (!screens.length) return ""
  const lines = screens.map(renderScreenLine)
  const anyPendingReview = screens.some((s) => s.pendingReview)
  return [
    "PRIOR JOB SCREENS (most recent first):",
    ...lines,
    "You have been screened for these roles before. A PAUSED or DID-NOT-PASS screen is for ONE job only —",
    "the candidate stays in the pool and can be matched to OTHER jobs. If the candidate asks why a screen",
    "paused or didn't pass, explain HONESTLY and kindly from the lines above (name what was strong, what",
    "was borderline, and that paused/not-passed is not a rejection) — NEVER invent a reason.",
    anyPendingReview
      ? "One outcome is still UNDER WEKRUIT TEAM REVIEW: do NOT claim a final decision (never say they passed or failed) - say the outcome is still being reviewed."
      : "",
    "If the candidate states a target role, seniority, or constraint, CAPTURE it (record_onboarding_answer /",
    "set_matching_preferences — map their words to the canonical enum yourself) and OFFER to find OTHER",
    "matching roles (find_match). Do NOT re-pitch the paused job. Do not echo their answer back as the whole reply.",
  ]
    .filter(Boolean)
    .join("\n")
}

/**
 * Assemble the context-complete candidate context for (userId): global profile ∪ ALL prescreen
 * sessions (terminals/reasons/scores/borderline signals + retention stage). Read-only, fail-soft.
 *
 * Replaces the legacy 3× session reads (findActiveSession + findRecentTerminalSession + loadPriorScreens)
 * with ONE userId-only query (index-light; in-memory filter for non-job-prescreen worksessions).
 *
 * @param opts.toE164 forwarded to loadGlobalContext (it surfaces the one-tap connect link off the phone).
 * @param opts.jobId  optional — reserved for a per-job candidateJobState read; NOT needed for the core fix.
 */
export async function buildCandidateContext(
  db: Firestore,
  userId: string,
  opts?: { toE164?: string; jobId?: string },
): Promise<CandidateContext> {
  // (1) GLOBAL — EXACT reuse of loadGlobalContext (it is itself fail-soft / never throws).
  let globalContextText = ""
  try {
    globalContextText = await loadGlobalContext(db, userId, opts?.toE164)
  } catch {
    /* fail-soft — partial context (no global) is still useful; never crash the turn */
  }

  // (1b) EMPLOYER BACKGROUND (Adam 2026-06-10) — append the derived employer-history one-liner
  // when signals exist. Own fail-soft read (loadGlobalContext returns rendered text only); "" for
  // legacy users keeps the block byte-identical. Display/personalization only — never a gate.
  try {
    const userSnap = await db.collection("pa-users").doc(userId).get()
    const userData = (userSnap.data() ?? {}) as Record<string, unknown>
    const tags =
      userData.tags && typeof userData.tags === "object" && !Array.isArray(userData.tags)
        ? (userData.tags as Record<string, unknown>)
        : {}
    const employerLine = renderEmployerBackgroundLine(tags)
    if (employerLine) {
      globalContextText = globalContextText ? `${globalContextText}\n${employerLine}` : employerLine
    }
  } catch {
    /* fail-soft — the employer line is additive context, never crash the turn */
  }

  // (2) SESSIONS — ONE userId-only query; in-memory filter + structure.
  const screens: CandidateScreenSession[] = []
  try {
    const snap = await db.collection(PRESCREEN_SESSIONS).where("userId", "==", userId).get()
    for (const doc of snap.docs) {
      const data = doc.data() as Record<string, unknown>
      // Mirror findRecentTerminalSession: a non-job_prescreen worksession is not a screen.
      const workSession =
        data.workSession && typeof data.workSession === "object" ? (data.workSession as Record<string, unknown>) : undefined
      if (workSession && workSession.kind !== "job_prescreen") continue
      screens.push(toScreenSession(doc.id, data))
    }
    // newest-first (endedAtMs desc; unknown timestamps sort last).
    screens.sort((a, b) => (b.endedAtMs ?? -Infinity) - (a.endedAtMs ?? -Infinity))
  } catch {
    /* fail-soft — a missing index / read error must NOT break the turn; degrade to global-only */
  }

  const mostRecentTerminal = screens.find((s) => s.terminal !== null) ?? null
  const prescreenContextText = renderPrescreenContextText(screens)

  return { userId, globalContextText, screens, mostRecentTerminal, prescreenContextText }
}
