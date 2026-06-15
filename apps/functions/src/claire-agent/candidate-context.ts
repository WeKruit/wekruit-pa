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
import { isStaleClosedPrescreenSession } from "../prescreen-staleness.js"
import { hasResumeOrLinkedInProfileSignal } from "../prescreen-terminal-action.js"

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
  /** Closed by STALENESS (boundary=timeout / expired_inactive_prescreen_session / manual_review_required):
   *  NOTHING was submitted — never "under review", never an auto-matching trigger (Adam 2026-06-12). */
  staleClosed: boolean
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
    staleClosed: isStaleClosedPrescreenSession(data),
    retentionStage: typeof retention?.stage === "string" ? retention.stage : null,
    endedAtMs,
  }
}

/** Candidate-context label for a terminal, for the rendered block. Exported for unit tests. */
export function terminalLabel(s: CandidateScreenSession): string {
  if (s.terminal === null) return "in progress (not finished)"
  if (s.terminal === "PASS") return s.pendingReview ? "PASSED (under WeKruit team review - outcome not final)" : "passed"
  if (s.terminal === "PAUSE") {
    // STALE-CLOSED (Adam 2026-06-12, Invoko PM live failure): a timeout/manual-review PAUSE never
    // reached the team — the label must make "under review" inexpressible and name the restart path.
    if (s.staleClosed) {
      return "TIMED OUT (auto-closed after inactivity — NOT a rejection, NOT under review, nothing was submitted; they can reply 'restart screen' to start a fresh run)"
    }
    return s.terminalReason === "user_exit"
      ? "PAUSED (you stepped away mid-screen — not a rejection, not under review)"
      : "PAUSED (not a rejection, not under review)"
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
 * the model knows the candidate has been screened for these roles. Returns "" when there are no
 * screens (nothing to add this turn).
 *
 * STATE-AWARE DIRECTIVES (Adam 2026-06-12, Invoko PM live failure +12026571666):
 *   - an ACTIVE screen OWNS the conversation: no matching offers until terminal;
 *   - a STALE-CLOSED (timed-out) screen gets the 'restart screen' path, never a matching offer
 *     in the same breath and NEVER an "under review" claim;
 *   - matching is offered only AFTER a real terminal (PASS / FAIL / HARD_STOP, or a deliberate
 *     user-exit pause);
 *   - candidate copy never says "human review" — it is always the WeKruit team / hiring team.
 *
 * Exported for unit tests; `opts.profileSignalOnFile` threads the résumé/LinkedIn presence so a
 * rejected candidate with nothing on file is asked to add it (so future collab roles can be pitched
 * without repeating screens) before any rec offer.
 */
export function renderPrescreenContextText(
  screens: CandidateScreenSession[],
  opts?: { profileSignalOnFile?: boolean },
): string {
  if (!screens.length) return ""
  const lines = screens.map(renderScreenLine)
  const anyPendingReview = screens.some((s) => s.pendingReview)
  const activeScreen = screens.find((s) => s.terminal === null) ?? null
  const mostRecentTerminal = screens.find((s) => s.terminal !== null) ?? null
  const staleTimedOut = !activeScreen && mostRecentTerminal?.terminal === "PAUSE" && mostRecentTerminal.staleClosed
  const rejectedTerminal =
    !activeScreen &&
    (mostRecentTerminal?.terminal === "FAIL" || mostRecentTerminal?.terminal === "HARD_STOP")
  const realTerminal =
    !activeScreen &&
    mostRecentTerminal !== null &&
    (mostRecentTerminal.terminal === "PASS" || rejectedTerminal || (mostRecentTerminal.terminal === "PAUSE" && !mostRecentTerminal.staleClosed))
  // The MOST RECENT terminal being under WeKruit-team review is the handoff the
  // candidate just acked — suppress the matching offer for that turn so a courtesy
  // ack ("looking forward to the update") can't bridge into matching. An OLDER
  // screen still under review (while the most recent is settled) does NOT suppress
  // the offer — matching off the latest settled terminal is still fine (Adam
  // 2026-06-15 post-terminal opt-in; T8 keeps offering off a settled PAUSE).
  const mostRecentPendingReview = !activeScreen && mostRecentTerminal?.pendingReview === true

  const activeRoleLabel = activeScreen
    ? [activeScreen.jobTitle, activeScreen.company].filter(Boolean).join(" @ ") || activeScreen.jobId || "this role"
    : ""

  return [
    "PRIOR JOB SCREENS (most recent first):",
    ...lines,
    // ── SCREEN OWNERSHIP: an active screen suspends matching entirely (Adam priority 1). ──
    activeScreen
      ? [
          `AN ACTIVE SCREEN IS IN PROGRESS (${activeRoleLabel}) — the screen OWNS this conversation until it reaches a terminal.`,
          "Do NOT offer job matching, do NOT call find_match, and do NOT ask 'want me to pull roles?' while it is open.",
          "If they ask whether the screening is over: say not yet and continue with the pending question.",
          `If they ask which role/company this screen is for: it is ${activeRoleLabel} — confirm that and continue the screen.`,
          "A tangent question gets a brief answer, then return to the pending screen question.",
        ].join(" ")
      : "",
    "You have been screened for these roles before. A PAUSED or DID-NOT-PASS screen is for ONE job only —",
    "the candidate stays in the pool and can be matched to OTHER jobs. If the candidate asks why a screen",
    "paused or didn't pass, explain HONESTLY and kindly from the lines above (name what was strong, what",
    "was borderline, and that paused/not-passed is not a rejection) — NEVER invent a reason.",
    // ── STATUS HONESTY (Adam priority 2): under-review claims must be grounded in pendingReview. ──
    "STATUS HONESTY: ONLY a screen explicitly marked 'under WeKruit team review' above may be described as",
    "being reviewed. A TIMED-OUT or PAUSED screen was NEVER submitted — never say it is under review,",
    "submitted, or being looked at. Never use the words 'human review' with the candidate — say the",
    "WeKruit team or the hiring team (the screen helps pitch them to the hiring manager).",
    anyPendingReview
      ? "One outcome is still UNDER WEKRUIT TEAM REVIEW: do NOT claim a final decision (never say they passed or failed) - say the WeKruit team is reviewing it and you'll text them the next step."
      : "",
    // ── STALE TIMEOUT (Adam priorities 2+4): restart path, NO matching offer in the same turn. ──
    staleTimedOut
      ? [
          "THEIR MOST RECENT SCREEN TIMED OUT (auto-closed from inactivity — see above). If they ask about it",
          "or want to continue: tell them it timed out (zero ding on them) and they can reply 'restart screen'",
          "to pick it back up fresh. Do NOT offer job matching or 'want me to pull roles?' on this turn, and do",
          "NOT send recommendations off the back of the timeout — matching resumes only if THEY ask for roles.",
        ].join(" ")
      : "",
    // ── POST-TERMINAL MATCHING IS OPT-IN (Adam priority 3 + 2026-06-15 live bug). ──
    // While an outcome is UNDER WEKRUIT TEAM REVIEW, do NOT even put matching on the
    // table in the same breath — just hold warmly. The candidate's polite ack of the
    // review ("sure", "sounds good", "looking forward to the update") is NOT a request
    // to match, and must NEVER trigger find_match.
    realTerminal && !staleTimedOut && mostRecentPendingReview
      ? [
          "Their most recent screen is still under WeKruit team review. Do NOT offer job matching or call find_match this turn.",
          "If the candidate sends a polite acknowledgment of the review ('sure', 'sounds good', 'thanks', 'ok',",
          "'looking forward to the update'), that is an ACK — reply with a warm, brief hold (you've got their",
          "screen, the team is reviewing it, you'll text the next step) and ask for NOTHING. Do NOT say 'pulling",
          "matches' and do NOT call find_match. Matching only resumes if they LATER explicitly ask for roles.",
        ].join(" ")
      : "",
    realTerminal && !staleTimedOut && !mostRecentPendingReview
      ? [
          "Their screens are settled (no active screen), so matching is back on the table — but matching is OPT-IN.",
          "If the candidate states a target role, seniority, or constraint, CAPTURE it (record_onboarding_answer /",
          "set_matching_preferences — map their words to the canonical enum yourself) and OFFER to find OTHER",
          "matching roles ONCE, framed naturally — e.g. 'I can use your resume/LinkedIn to find better-fit roles'.",
          "Then call find_match ONLY when the candidate EXPLICITLY asks for roles — a clear matching request like",
          "'yes pull roles', 'show me jobs', 'find me matches', 'what else do you have', 'recommend roles'. A bare",
          "COURTESY ACKNOWLEDGMENT ('sure', 'ok', 'sounds good', 'thanks', 'looking forward to the update', a",
          "tapback/emoji) is NOT a matching request — reply with a warm, brief acknowledgment and do NOT call",
          "find_match. When in doubt, ask once more rather than auto-matching. Do NOT re-pitch the paused/failed",
          "job. Do not echo their answer back as the whole reply.",
          rejectedTerminal && opts?.profileSignalOnFile === false
            ? "They have NO resume or LinkedIn on file: before recommendations, suggest adding one so future collaboration roles can be pitched with their real background instead of repeating screens — then ask if they want recommendations."
            : "",
        ]
          .filter(Boolean)
          .join(" ")
      : "",
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
  // (2026-06-12) The same read also derives `profileSignalOnFile` (résumé/LinkedIn presence) for the
  // post-rejection "add your resume/LinkedIn" suggestion — shared check with the terminal action.
  let profileSignalOnFile = true // fail-soft default: when the read fails, do NOT nag for a résumé
  try {
    const userSnap = await db.collection("pa-users").doc(userId).get()
    const userData = (userSnap.data() ?? {}) as Record<string, unknown>
    profileSignalOnFile = hasResumeOrLinkedInProfileSignal(userData)
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
  const prescreenContextText = renderPrescreenContextText(screens, { profileSignalOnFile })

  return { userId, globalContextText, screens, mostRecentTerminal, prescreenContextText }
}
