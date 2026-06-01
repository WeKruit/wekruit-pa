/**
 * Phase 35 — F3 lang-lock detector.
 *
 * Detects when Claire's majority language differs from the user's
 * majority language AND the off-language token ratio in Claire's
 * reply exceeds the threshold (default 0.25 = 25% off-lang tokens).
 *
 * 25% accommodates legitimate code-switch (a CJK-frame reply carrying
 * ~30-40% en tokens is still primarily zh — that should NOT trip when the
 * user is also code-switching). Hard mismatch (user 100% zh, assistant
 * 100% en) trips at 100% off-lang.
 *
 * Action: `regenerate` — wire-in caller re-calls rewriter with explicit
 * "respond in <lang>" directive. 1 retry max; fail-open on 2nd attempt.
 *
 * Algorithm: char-level CJK vs ASCII-letter ratio (matches
 * `voice-axes.mjs:detectLang`). Off-lang token ratio = chars in the
 * off-language script / total alpha chars.
 *
 * Latency: pure text, < 5ms per call.
 */
import type { DetectorContext, DetectorResult } from "./types.js"

const DEFAULT_THRESHOLD = 0.25

function readEnvThreshold(): number {
  const raw = process.env.PA_F3_OFFLANG_THRESHOLD?.trim()
  if (!raw) return DEFAULT_THRESHOLD
  const n = Number(raw)
  if (!Number.isFinite(n) || n < 0 || n > 1) return DEFAULT_THRESHOLD
  return n
}

function isCjkChar(ch: string): boolean {
  const code = ch.codePointAt(0) ?? 0
  return (
    (code >= 0x4e00 && code <= 0x9fff) ||
    (code >= 0x3400 && code <= 0x4dbf) ||
    (code >= 0x3000 && code <= 0x303f)
  )
}

function isAsciiLetter(ch: string): boolean {
  return /[A-Za-z]/.test(ch)
}

interface LangProfile {
  cjkChars: number
  asciiAlpha: number
  total: number
  /** Majority language. Tie or empty → "en". */
  majority: "zh" | "en"
}

function profileLang(text: string): LangProfile {
  let cjkChars = 0
  let asciiAlpha = 0
  if (typeof text !== "string" || text.length === 0) {
    return { cjkChars: 0, asciiAlpha: 0, total: 0, majority: "en" }
  }
  for (const ch of text) {
    if (isCjkChar(ch)) cjkChars += 1
    else if (isAsciiLetter(ch)) asciiAlpha += 1
  }
  const total = cjkChars + asciiAlpha
  return {
    cjkChars,
    asciiAlpha,
    total,
    majority: cjkChars > asciiAlpha ? "zh" : "en",
  }
}

/**
 * F3 detector entry point. Pure text, sync.
 *
 * Trigger logic:
 * 1. Compute majority lang for user + assistant.
 * 2. If both same OR user has too few alpha chars (< 3) to determine
 *    majority confidently, return triggered=false.
 * 3. Otherwise compute off-lang ratio in assistant: minority-script
 *    chars / total alpha chars.
 * 4. Trigger if (a) majorities differ AND (b) off-lang ratio in
 *    assistant > threshold.
 */
export function detectLangLock(ctx: DetectorContext): DetectorResult {
  const start = performance.now()
  const threshold = ctx.env?.f3OffLangThreshold ?? readEnvThreshold()
  const { user, assistant } = ctx.turn

  if (!user || !assistant) {
    return {
      id: "f3_lang_lock",
      triggered: false,
      score: 0,
      reason: "no_input",
      suggested_action: null,
      latencyMs: performance.now() - start,
    }
  }

  const userProfile = profileLang(user)
  const asstProfile = profileLang(assistant)

  // Insufficient signal — short user input or assistant has no alpha.
  if (userProfile.total < 3 || asstProfile.total === 0) {
    return {
      id: "f3_lang_lock",
      triggered: false,
      score: 0,
      reason: "insufficient_signal",
      suggested_action: null,
      latencyMs: performance.now() - start,
    }
  }

  // Same majority lang → no mismatch.
  if (userProfile.majority === asstProfile.majority) {
    return {
      id: "f3_lang_lock",
      triggered: false,
      score: 0,
      reason: `same_lang_${userProfile.majority}`,
      suggested_action: null,
      latencyMs: performance.now() - start,
    }
  }

  // Majorities differ. Compute off-lang ratio in assistant: how much of
  // the assistant text is in the USER's preferred lang.
  const userLangCharsInAsst =
    userProfile.majority === "zh" ? asstProfile.cjkChars : asstProfile.asciiAlpha
  const otherLangCharsInAsst =
    userProfile.majority === "zh" ? asstProfile.asciiAlpha : asstProfile.cjkChars
  // Off-lang ratio = how much of assistant is in the WRONG (non-user) lang.
  const offLangRatio = asstProfile.total === 0 ? 0 : otherLangCharsInAsst / asstProfile.total

  // Trigger when most of assistant is in the off-language. Note: we check
  // (1 - userLangRatio) > threshold ⇔ userLangRatio < (1 - threshold).
  // For the default 0.25 threshold, we trigger when off-lang > 0.25
  // i.e. < 75% of assistant is in user's lang.
  const triggered = offLangRatio > threshold

  return {
    id: "f3_lang_lock",
    triggered,
    score: offLangRatio,
    reason: triggered
      ? `lang_mismatch_user=${userProfile.majority}_asst=${asstProfile.majority}_offlang=${offLangRatio.toFixed(3)}`
      : `lang_mismatch_within_tolerance_offlang=${offLangRatio.toFixed(3)}`,
    suggested_action: triggered ? "regenerate" : null,
    latencyMs: performance.now() - start,
  }
}
