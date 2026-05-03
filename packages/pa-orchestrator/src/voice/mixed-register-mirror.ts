/**
 * Phase 53 (v1.6 voice-quality closure) — Mixed-register lock detector +
 * conservative mirror-token append.
 *
 * Problem: F3 lang-lock (f3-lang-lock.ts) is binary majority — when the user
 * code-switches every sentence ("我是 senior on OPT") F3 collapses both sides
 * to a single majority and either passes (both zh-majority, no trigger) or
 * fires too aggressively. The runner-local mid-tier failures show Claire
 * dropping to PURE zh on mixed input, losing the user's "OPT", "PM", "TC"
 * register tokens.
 *
 * This module is intentionally narrow:
 *   1. Detect: user is mixed (both cjk≥3 AND ascii≥3) AND Claire's reply is
 *      effectively single-language (en-tokens or zh-tokens carry < 5% of the
 *      OPPOSITE script).
 *   2. Repair: extract a small set of high-signal en register tokens the
 *      user used (capitalised acronyms / known career-domain bank), and if
 *      Claire's reply contains NONE of them, append a single trailing
 *      bracket re-anchor:  "(re: OPT)" — minimal, safe, idempotent.
 *
 * We do NOT rewrite Claire's prose. Touching the body risks breaking the
 * intent / safety contracts (crisis hotline guard runs after us; we must
 * leave a clean string for it). The trailing bracket is the most boring
 * possible mirror that still nudges the LLM signal next turn (because the
 * appended token enters history, so subsequent rewriter calls see it).
 *
 * Latency: pure regex + set ops, < 1ms. Idempotent: if reply already has the
 * token, no-op.
 *
 * P7 honest-defer caveat: if this module's runner-local impact is < 1
 * additional cell pass, we keep the detector telemetry but disable the
 * mirror append via `paMixedRegisterMirrorEnabled=false`. The detector is
 * still useful as a feedback signal for prompt-engineering iterations.
 */

const CJK_RE = /[　-〿㐀-䶿一-鿿]/u
const ASCII_LETTER_RE = /[A-Za-z]/u

/**
 * High-signal en register tokens the bilingual sim users emit. Curated from
 * intent-matrix YAMLs (job_search / visa_check / resume_parse / preference
 * fixtures). Acronyms + short-form career nouns. Lowercase comparison.
 */
const REGISTER_TOKEN_BANK = new Set([
  // visa
  "opt", "h1b", "h-1b", "stem-opt", "ead", "green card", "gc", "stem", "tn", "l1",
  // role / track
  "pm", "em", "ic", "swe", "sde", "tpm", "eng", "sre", "ml", "infra", "backend",
  "frontend", "fullstack", "full-stack", "data", "ds", "research", "design",
  // comp
  "tc", "base", "rsus", "rsu", "comp", "yoe",
  // companies / orgs (common in fixtures)
  "stripe", "robinhood", "google", "meta", "amazon", "openai", "linkedin",
])

/**
 * User-mixed detection: both scripts have ≥ 3 chars AND neither dominates
 * past 90% (otherwise it's just one lang with sparse code-switch).
 */
export function isUserMixed(text: string): boolean {
  if (typeof text !== "string" || text.length < 6) return false
  let cjk = 0
  let ascii = 0
  for (const ch of text) {
    if (CJK_RE.test(ch)) cjk += 1
    else if (ASCII_LETTER_RE.test(ch)) ascii += 1
  }
  if (cjk < 3 || ascii < 3) return false
  const total = cjk + ascii
  // Reject when one script is >90% — that's a single-lang reply with sparse
  // borrowed tokens, not true mixed code-switch.
  return cjk / total >= 0.1 && ascii / total >= 0.1
}

/**
 * Reply-is-single-language: returns "zh" | "en" | "mixed" describing which
 * script dominates Claire's reply. ≥ 95% one-script counts as single-lang.
 */
export function classifyReplyRegister(text: string): "zh" | "en" | "mixed" | "empty" {
  if (typeof text !== "string" || text.length === 0) return "empty"
  let cjk = 0
  let ascii = 0
  for (const ch of text) {
    if (CJK_RE.test(ch)) cjk += 1
    else if (ASCII_LETTER_RE.test(ch)) ascii += 1
  }
  const total = cjk + ascii
  if (total === 0) return "empty"
  if (cjk / total >= 0.95) return "zh"
  if (ascii / total >= 0.95) return "en"
  return "mixed"
}

/**
 * Extract en register tokens the user actually used. We require the user
 * text to contain the token literally (case-insensitive substring) AND the
 * token to be in our bank. Returns at most `max` tokens, oldest-first by
 * occurrence. Tokens with embedded space (e.g. "green card") matched whole.
 */
export function extractRegisterTokens(userText: string, max = 2): string[] {
  if (typeof userText !== "string" || userText.length === 0) return []
  const lower = userText.toLowerCase()
  const out: string[] = []
  for (const tok of REGISTER_TOKEN_BANK) {
    if (lower.includes(tok)) {
      // Preserve original casing from user where possible.
      const re = new RegExp(
        tok.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
        "i"
      )
      const m = userText.match(re)
      out.push(m ? m[0] : tok)
      if (out.length >= max) break
    }
  }
  return out
}

export interface MixedMirrorResult {
  text: string
  applied: boolean
  /** Token we appended, if any — for telemetry. */
  appended?: string
  reason:
    | "user_not_mixed"
    | "reply_already_mixed"
    | "no_register_tokens"
    | "token_already_in_reply"
    | "appended"
    | "empty_reply"
}

/**
 * Conservative mirror append. See module-level docstring for design rationale.
 *
 * Returns `applied=true` ONLY when we actually appended a token. All other
 * paths return the original text unchanged with a diagnostic `reason`.
 */
export function applyMixedRegisterMirror(
  userText: string,
  reply: string
): MixedMirrorResult {
  if (typeof reply !== "string" || reply.trim().length === 0) {
    return { text: reply ?? "", applied: false, reason: "empty_reply" }
  }
  if (!isUserMixed(userText)) {
    return { text: reply, applied: false, reason: "user_not_mixed" }
  }
  const replyClass = classifyReplyRegister(reply)
  if (replyClass === "mixed" || replyClass === "empty") {
    // Already mirroring (or no signal) — leave alone.
    return { text: reply, applied: false, reason: "reply_already_mixed" }
  }
  const tokens = extractRegisterTokens(userText, 2)
  if (tokens.length === 0) {
    return { text: reply, applied: false, reason: "no_register_tokens" }
  }
  // Pick the FIRST token that's not already in the reply (case-insensitive).
  const replyLower = reply.toLowerCase()
  const candidate = tokens.find((t) => !replyLower.includes(t.toLowerCase()))
  if (!candidate) {
    return { text: reply, applied: false, reason: "token_already_in_reply" }
  }
  // Append "(re: TOKEN)" with a leading space — does not modify reply body.
  // We strip trailing newlines from reply first to keep the bracket adjacent.
  const trimmed = reply.replace(/\s+$/u, "")
  const next = `${trimmed} (re: ${candidate})`
  return {
    text: next,
    applied: true,
    appended: candidate,
    reason: "appended",
  }
}
