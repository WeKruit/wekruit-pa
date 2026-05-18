/**
 * Adam iter 19 — real-time mid-conversation tag write-back.
 *
 * Spec (Adam iter 17): "边聊天我们要给用户边打标，这个标记应该是实时变化的但是
 * cost不能高，要不然match就不实时了对吧。"
 *
 * Translation: as user chats, extract tags + update pa_users in real-time
 * so job match scoring uses LIVE data, not the frozen onboarding snapshot.
 * Cost must be near-zero — no LLM calls.
 *
 * APPROACH (Method C from iter 18 verdict — lowest lift, ships fastest):
 * - Re-uses the regex parsers already defined in onboarding.ts (visa,
 *   location, startup-pref, yoe). Those parsers are pure regex, sub-1ms.
 * - On EVERY inbound user message (not just onboarding), run all 4
 *   relevant parsers + merge non-null fields into pa_users.
 *   statedPreferences via Firestore merge-update.
 * - Post-turn (fire-and-forget — never blocks the LLM call). Errors
 *   logged + swallowed.
 *
 * WHAT IT EXTRACTS (per-turn):
 * - visaStatus: "sponsorship_needed" / "h1b" / "opt" / "gc" / "citizen"
 * - targetLocations: SF Bay Area / NYC / Seattle / LA / remote / raw
 * - prefersStartup: true / false / null (ambiguous)
 * - yoeRange: new-grad → [0,1] / "N years" → [N,N]
 *
 * WHAT IT DOESN'T EXTRACT (deferred — needs LLM):
 * - skill list (RAG, Python, embeddings) — too lexically diverse for regex
 * - salary expectations — would need numeric parsing + currency normalization
 * - softer preferences (research-oriented, work-life balance) — semantic
 *
 * COST PROFILE: 4 regex tests (~0.2ms) + 1 Firestore merge-write (~30ms p50,
 * BG fire-and-forget). Zero LLM tokens.
 *
 * SAFETY:
 * - Merge-only. Never overwrites existing fields with null.
 * - Idempotent: re-running on same input produces same patch.
 * - Rollback: PA_REALTIME_TAGGER_DISABLED=true skips the write.
 */
import type { Firestore } from "firebase-admin/firestore"
import type { StatedPreferences, VisaStatus } from "@pa/core-types"

// ---------------------------------------------------------------------------
// Parsers — duplicate of onboarding.ts internal parsers (kept private there
// for compile-time isolation). Re-implemented here so onboarding doesn't
// need to export internals.
// ---------------------------------------------------------------------------

function parseVisaSignal(reply: string): VisaStatus | null {
  const lower = reply.toLowerCase()
  if (/(sponsor|sponsorship|h-?1\s*b\s*later|need.*visa)/i.test(reply)) {
    return "sponsorship_needed"
  }
  if (/(h-?1\s*b|h1\b)/i.test(reply)) return "h1b"
  if (/\bOPT\b/.test(reply) || /(opt\b|stem.*opt)/i.test(lower)) return "opt"
  if (/(green\s*card|绿卡|gc\b|permanent\s*resident)/i.test(reply)) return "gc"
  if (/(citizen|公民|美国人|us\s*citizen)/i.test(reply)) return "citizen"
  return null
}

function parseLocationSignal(reply: string): string[] | null {
  const tokens: string[] = []
  if (/(remote|在家|远程|wfh)/i.test(reply)) tokens.push("remote")
  if (/(湾区|bay\s*area|sf\b|san\s*francisco)/i.test(reply)) tokens.push("SF Bay Area")
  if (/(ny\b|纽约|new\s*york|nyc)/i.test(reply)) tokens.push("NYC")
  if (/(seattle|西雅图)/i.test(reply)) tokens.push("Seattle")
  if (/(la\b|los\s*angeles|洛杉矶)/i.test(reply)) tokens.push("LA")
  return tokens.length > 0 ? Array.from(new Set(tokens)) : null
}

function parseStartupSignal(reply: string): boolean | null {
  const startupHit = /(startup|小公司|小厂|创业|early\s*stage|hustle)/i.test(reply)
  const bigcoHit = /(大厂|大公司|big[-\s]*co|big\s*tech|stable|faang|enterprise)/i.test(reply)
  if (startupHit && !bigcoHit) return true
  if (bigcoHit && !startupHit) return false
  return null
}

function parseYoeSignal(reply: string): [number, number] | null {
  if (/(刚毕业|应届|new\s*grad|fresh(\s*out)?|just\s*graduated|no\s*experience)/i.test(reply)) {
    return [0, 1]
  }
  const lower = reply.toLowerCase()
  const num = lower.match(/(\d{1,2})\s*(\+)?\s*(years?|yrs?|y\b|年)/i)
  if (num && num[1]) {
    const n = parseInt(num[1], 10)
    if (Number.isFinite(n) && n >= 0 && n <= 50) return [n, n]
  }
  return null
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export type TagExtraction = {
  visaStatus: VisaStatus | null
  targetLocations: string[] | null
  prefersStartup: boolean | null
  yoeRange: [number, number] | null
  /** True iff at least one field was extracted (non-null). */
  hasUpdate: boolean
}

/**
 * Run all 4 regex parsers on a user message. Pure, < 1ms.
 *
 * Returns extracted signals — null per field when no signal detected.
 * Caller decides whether to write the patch.
 */
export function extractTagsFromUserMessage(message: string): TagExtraction {
  if (!message || typeof message !== "string") {
    return {
      visaStatus: null,
      targetLocations: null,
      prefersStartup: null,
      yoeRange: null,
      hasUpdate: false,
    }
  }
  const visaStatus = parseVisaSignal(message)
  const targetLocations = parseLocationSignal(message)
  const prefersStartup = parseStartupSignal(message)
  const yoeRange = parseYoeSignal(message)
  const hasUpdate =
    visaStatus !== null ||
    targetLocations !== null ||
    prefersStartup !== null ||
    yoeRange !== null
  return {
    visaStatus,
    targetLocations,
    prefersStartup,
    yoeRange,
    hasUpdate,
  }
}

/**
 * Build the Firestore merge-update payload from a TagExtraction. Skips
 * fields that are null. Returns null if nothing to write.
 *
 * Output shape:
 *   { statedPreferences: { visaStatus: "h1b", targetLocations: ["NYC"] } }
 *
 * Caller does:
 *   await db.collection("pa-users").doc(userId).set(payload, { merge: true })
 */
export function buildTagWriteback(
  extraction: TagExtraction
): { statedPreferences: Partial<StatedPreferences> } | null {
  if (!extraction.hasUpdate) return null
  const sp: Partial<StatedPreferences> = {}
  if (extraction.visaStatus !== null) sp.visaStatus = extraction.visaStatus
  if (extraction.targetLocations !== null) sp.targetLocations = extraction.targetLocations
  if (extraction.prefersStartup !== null) sp.prefersStartup = extraction.prefersStartup
  if (extraction.yoeRange !== null) sp.yoeRange = extraction.yoeRange
  return { statedPreferences: sp }
}

/**
 * Fire-and-forget post-turn write-back. Catches all errors so it never
 * affects the user-facing reply path. Logs via the provided logger.
 *
 * Returns: { ran: boolean, signals: string[], skipReason?: string }
 */
export async function applyRealtimeTagWriteback(
  db: Firestore,
  userId: string,
  message: string,
  log: (event: string, payload: Record<string, unknown>) => void
): Promise<{ ran: boolean; signals: string[]; skipReason?: string }> {
  if (process.env.PA_REALTIME_TAGGER_DISABLED === "true") {
    return { ran: false, signals: [], skipReason: "rollback_flag" }
  }
  if (!userId) {
    return { ran: false, signals: [], skipReason: "no_user_id" }
  }
  try {
    const extraction = extractTagsFromUserMessage(message)
    if (!extraction.hasUpdate) {
      return { ran: false, signals: [], skipReason: "no_signal" }
    }
    const writeback = buildTagWriteback(extraction)
    if (!writeback) {
      return { ran: false, signals: [], skipReason: "no_writeback" }
    }
    const signals: string[] = []
    if (extraction.visaStatus) signals.push(`visa:${extraction.visaStatus}`)
    if (extraction.targetLocations) signals.push(`loc:${extraction.targetLocations.join(",")}`)
    if (extraction.prefersStartup !== null) signals.push(`startup:${extraction.prefersStartup}`)
    if (extraction.yoeRange) signals.push(`yoe:${extraction.yoeRange[0]}-${extraction.yoeRange[1]}`)
    await db.collection("pa-users").doc(userId).set(writeback, { merge: true })
    log("pa.realtime_tagger.applied", {
      userId,
      signals,
      writeback: writeback.statedPreferences,
    })
    return { ran: true, signals }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    log("pa.realtime_tagger.error", { userId, error: msg })
    return { ran: false, signals: [], skipReason: "write_failed" }
  }
}
