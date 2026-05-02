/**
 * Phase 51 (v1.5 Stream §3.1) — Deterministic crisis-ideation hotline guard.
 *
 * BACKGROUND
 * ----------
 * Up to v1.4 ship, `crisis_ideation` had NO orchestrator routing code. The
 * Bible v7.5 system-prompt directive was the only safety net; if the loader
 * degraded or the model (Qwen-7B) ignored the directive, suicidal/self-harm
 * users could receive a reply with no hotline. This module is the
 * deterministic fail-safe SECOND layer (the Bible directive remains layer 1).
 *
 * SCOPE
 * -----
 * - `detectCrisisInInput(text)` — bilingual regex bank, two-tier confidence:
 *     HIGH-confidence keywords (suicide ideation, explicit self-harm) →
 *       always trigger.
 *     LOW-confidence keywords (rhetorical-prone phrases) → trigger UNLESS
 *       a same-clause "rhetorical anchor" follows (deadline / 工作 / 这种 …).
 *   Bias: when ambiguous, trigger (FN cost > FP cost — task directive).
 *
 * - `replyContainsHotline(text)` — checks if a reply already includes any
 *   canonical hotline reference (so we don't double-append when Bible
 *   directive worked).
 *
 * - `appendHotlineIfMissing({ reply, lang })` — pure function that returns
 *   the reply unchanged if a hotline is present, else appends a friend-tone
 *   bilingual fallback line. NEVER replaces reply body.
 *
 * - `hashForAudit(text)` — sha256[:16] hex; PII-safe identifier for telemetry.
 *
 * NON-GOALS
 * ---------
 * - This module does NOT block, sanitize, or short-circuit the LLM call. It
 *   is purely a post-gen guard. Crisis users still get the empathetic LLM
 *   reply; we only guarantee a hotline trailer if the LLM forgot.
 * - This module is NOT integrated into `runSafetyCheck` (which has block
 *   semantics). It is invoked directly by the orchestrator post-rewrite.
 *
 * HOTLINE STRINGS (canonical, MUST match Bible v7.5 / migrate-bible-v7.5):
 *   ZH — `心理援助热线 400-161-9995（24h）`
 *   EN — `Crisis Text Line — text HOME to 741741`
 *   US — `988 Suicide & Crisis Lifeline` (US-specific; included in EN fallback
 *        as second-line resource)
 *   CN backup — `12320` (national health hotline)
 *
 * TELEMETRY (caller emits via store.log):
 *   event: `pa.safety.crisis_detected`
 *   fields: detectedFrom, language, confidence, inputHash, inputLength
 */

import { createHash } from "node:crypto"

// ---------------------------------------------------------------------------
// Detection — bilingual regex bank, two confidence tiers.
// ---------------------------------------------------------------------------

export type CrisisConfidence = "high" | "low"
export type CrisisLanguage = "zh" | "en" | "mixed"

/**
 * HIGH-confidence keywords — always trigger. These phrases have ~zero
 * legitimate non-crisis usage in a career-coaching context.
 */
const HIGH_CONFIDENCE_ZH: ReadonlyArray<RegExp> = [
  /自杀/,
  /自残/,
  /想死/,
  /自尽/,
  /了结(?:自己|生命)/,
  /一了百了/,
  /跳楼(?!机)/, // 跳楼 ≠ 跳楼机 (a roller-coaster ride)
  /上吊/,
  /吞药/,
  /割腕/,
  /结束(?:自己的)?(?:生命|一生)/,
]

const HIGH_CONFIDENCE_EN: ReadonlyArray<RegExp> = [
  /\bkill\s+(?:my\s*self|myself)\b/i,
  /\bkms\b/i, // common shorthand
  /\bsuicid(?:e|al|ing)\b/i,
  /\bself[-\s]?harm\b/i,
  /\bcut(?:ting)?\s+myself\b/i,
  /\boverdose\b/i,
  /\b(?:hang|hanging)\s+myself\b/i,
  /\bjump\s+off\s+(?:a\s+)?(?:bridge|building|roof)\b/i,
  /\bend\s+my\s+(?:life|existence)\b/i,
  // P7-empirical-eval gaps (recall +12% on adversarial corpus):
  /\bhow\s+many\s+(?:pills?|tylenol|advil|sleeping\s+pills?|aspirin|tablets?)\s+(?:to|would|could).*?(?:kill|overdose|od|die)/i,
  /\bno\s+point\s+(?:living|in\s+(?:living|life|going\s+on|trying))\b/i,
]

/**
 * LOW-confidence keywords — rhetorical usage exists. Trigger UNLESS a
 * rhetorical anchor follows in the same clause.
 */
const LOW_CONFIDENCE_ZH: ReadonlyArray<RegExp> = [
  /不想活/,
  /活不下去/,
  /不想活了/,
  /我撑不住了/,
  /我不行了/,
  /撑不下去了/,
]

const LOW_CONFIDENCE_EN: ReadonlyArray<RegExp> = [
  /\bcan'?t\s+go\s+on\b/i,
  /\bdon'?t\s+want\s+to\s+(?:live|exist|be\s+here)\b/i,
  /\bwant\s+to\s+die\b/i,
  /\bend\s+it\s+all\b/i,
  /\bcan'?t\s+do\s+this\s+anymore\b/i,
  /\bgive\s+up\s+on\s+life\b/i,
]

/**
 * Rhetorical anchors — phrases that, when appearing within ~30 chars after
 * a low-confidence trigger, indicate metaphorical usage ("can't go on with
 * this deadline", "活不下去这种工作日子"). These suppress the LOW signal.
 *
 * Tuned conservatively: we still err FP-side. Only short, very clear anchors.
 */
const RHETORICAL_ANCHOR_ZH: ReadonlyArray<RegExp> = [
  /(?:这种|这个|这样的|这|那)\s*(?:日子|生活|工作|项目|deadline|加班|破事|破工作|垃圾)/,
  /(?:deadline|项目|工作|加班|面试|实习|学习)/,
]

const RHETORICAL_ANCHOR_EN: ReadonlyArray<RegExp> = [
  /\b(?:this|the)\s+(?:deadline|project|interview|grind|hustle|sprint|exam|midterm|finals|quarter)\b/i,
  /\b(?:without|with)\s+(?:offers?|coffee|caffeine|sleep)\b/i,
]

/**
 * Run a low-confidence trigger with rhetorical-anchor suppression.
 * Returns `true` only if the low keyword fires AND no anchor follows
 * within `windowChars` characters of the keyword's end.
 */
function lowSignalFires(
  text: string,
  trigger: RegExp,
  anchors: ReadonlyArray<RegExp>,
  windowChars = 30
): boolean {
  const m = trigger.exec(text)
  if (!m) return false
  const end = (m.index ?? 0) + m[0].length
  const window = text.slice(end, end + windowChars)
  for (const anchor of anchors) {
    if (anchor.test(window)) return false // suppressed by rhetorical anchor
  }
  return true
}

export interface CrisisDetection {
  detected: boolean
  confidence: CrisisConfidence | null
  language: CrisisLanguage
  /** Pattern-source ids (NOT raw text) for audit logging. */
  signals: string[]
}

/**
 * Detect crisis ideation in raw user input. Pure / sync / sub-millisecond.
 * NEVER returns user text in the result — only pattern ids and metadata.
 */
export function detectCrisisInInput(text: string): CrisisDetection {
  if (!text || !text.trim()) {
    return { detected: false, confidence: null, language: "en", signals: [] }
  }
  const language = detectLanguage(text)
  const signals: string[] = []
  let highHit = false
  let lowHit = false

  // High-confidence — fire on first match per bank.
  for (const r of HIGH_CONFIDENCE_ZH) {
    if (r.test(text)) {
      signals.push(`zh_high:${r.source}`)
      highHit = true
    }
  }
  for (const r of HIGH_CONFIDENCE_EN) {
    if (r.test(text)) {
      signals.push(`en_high:${r.source}`)
      highHit = true
    }
  }

  // Low-confidence — fire only if no rhetorical anchor follows.
  if (!highHit) {
    for (const r of LOW_CONFIDENCE_ZH) {
      if (lowSignalFires(text, r, RHETORICAL_ANCHOR_ZH)) {
        signals.push(`zh_low:${r.source}`)
        lowHit = true
      }
    }
    for (const r of LOW_CONFIDENCE_EN) {
      if (lowSignalFires(text, r, RHETORICAL_ANCHOR_EN)) {
        signals.push(`en_low:${r.source}`)
        lowHit = true
      }
    }
  }

  const detected = highHit || lowHit
  const confidence: CrisisConfidence | null = highHit ? "high" : lowHit ? "low" : null
  return { detected, confidence, language, signals }
}

/**
 * Lightweight language picker mirroring `pickLangForSafety` semantics
 * but expanded with a "mixed" bucket so callers can pick a bilingual
 * hotline trailer when the user code-switched.
 *
 * Thresholds: cjk-ratio ≥ 0.5 → zh; ≤ 0.1 → en; else → mixed.
 */
export function detectLanguage(text: string): CrisisLanguage {
  if (!text) return "en"
  let cjk = 0
  let alpha = 0
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0
    if (cp >= 0x4e00 && cp <= 0x9fff) cjk++
    else if (cp >= 0x41 && cp <= 0x7a) alpha++
  }
  const total = cjk + alpha
  if (total === 0) return "en"
  const ratio = cjk / total
  if (ratio >= 0.5) return "zh"
  if (ratio <= 0.1) return "en"
  return "mixed"
}

// ---------------------------------------------------------------------------
// Output check — does the reply already contain a canonical hotline?
// ---------------------------------------------------------------------------

/**
 * Canonical hotline patterns. Matches both the formatted strings used by
 * Bible v7.5 (`心理援助热线`, `Crisis Text Line`) and the bare phone numbers
 * (`988`, `400-161-9995`, `741741`, `12320`).
 *
 * We deliberately match on numerals + organization names. `988` alone is
 * three digits and could appear by chance; we anchor it as a word boundary
 * with `\b` to avoid matching "1988" or salary "$98800".
 */
export const HOTLINE_PATTERNS: ReadonlyArray<RegExp> = [
  // ZH numbers
  /400-?161-?9995/,
  /\b12320\b/,
  // ZH org names
  /心理援助热线/,
  /心理危机/,
  // EN numbers
  /\b741741\b/,
  /\b988\b/,
  // EN org names
  /Crisis\s+Text\s+Line/i,
  /Suicide\s+(?:&|and)?\s*Crisis\s+Lifeline/i,
]

/**
 * True iff the given reply already contains at least one canonical hotline
 * reference. Used to skip the deterministic injection when the LLM (via
 * Bible v7.5) already supplied a hotline.
 */
export function replyContainsHotline(reply: string): boolean {
  if (!reply) return false
  for (const r of HOTLINE_PATTERNS) {
    if (r.test(reply)) return true
  }
  return false
}

// ---------------------------------------------------------------------------
// Friend-tone fallback templates.
// ---------------------------------------------------------------------------

/**
 * Fallback hotline trailer templates. Friend-tone, lowercase, brief.
 * Never replace the LLM body — always APPEND with a blank-line separator.
 *
 * - "zh"    — Chinese-only context (mainland-CN primary hotline).
 * - "en"    — English-only context (US Crisis Text Line + 988).
 * - "mixed" — bilingual fallback (covers code-switched inputs and uncertain
 *             locale).
 */
export const HOTLINE_TRAILERS = {
  zh: "我在这。如果你想找人说话，心理援助热线 400-161-9995（24h），随时拨。",
  en: "i'm here. if you want to talk to someone — Crisis Text Line: text HOME to 741741, or 988 (US Suicide & Crisis Lifeline). anytime.",
  mixed:
    "我在这 / i'm here. 心理援助热线 400-161-9995（24h），or text HOME to 741741 (Crisis Text Line). 随时 / anytime.",
} as const

export interface AppendHotlineInput {
  reply: string
  language: CrisisLanguage
}

export interface AppendHotlineResult {
  text: string
  appended: boolean
  reason: "already_has_hotline" | "appended" | "empty_reply"
  trailerLanguage?: CrisisLanguage
}

/**
 * If `reply` already contains a canonical hotline, return it unchanged.
 * Otherwise append the language-appropriate friend-tone trailer.
 */
export function appendHotlineIfMissing(
  input: AppendHotlineInput
): AppendHotlineResult {
  const { reply, language } = input
  if (!reply || !reply.trim()) {
    return { text: reply ?? "", appended: false, reason: "empty_reply" }
  }
  if (replyContainsHotline(reply)) {
    return { text: reply, appended: false, reason: "already_has_hotline" }
  }
  const trailer = HOTLINE_TRAILERS[language]
  // Double-newline separator preserves the original message body intact and
  // visually separates the safety trailer (helps iMessage chunk boundaries).
  const text = `${reply.trimEnd()}\n\n${trailer}`
  return { text, appended: true, reason: "appended", trailerLanguage: language }
}

// ---------------------------------------------------------------------------
// PII-safe audit hash.
// ---------------------------------------------------------------------------

/**
 * 16-hex-char sha256 prefix of input text. Used in telemetry so we can
 * correlate detections across logs without storing raw user content.
 *
 * 64 bits is enough entropy for de-duplication-grade matching at our QPS;
 * NOT a cryptographic identifier.
 */
export function hashForAudit(text: string): string {
  return createHash("sha256")
    .update(text ?? "")
    .digest("hex")
    .slice(0, 16)
}

// ---------------------------------------------------------------------------
// Public guard summary — orchestrator-facing API.
// ---------------------------------------------------------------------------

export interface CrisisGuardInput {
  userInput: string
  reply: string
}

export interface CrisisGuardResult {
  /** Final reply (possibly with hotline appended). */
  reply: string
  /** Detection details for telemetry. */
  detection: CrisisDetection
  /** True iff the trailer was appended in this turn. */
  injected: boolean
  /**
   * Why we did or did not act. Stable enum for telemetry dashboards.
   *   - `not_detected`         — input clean; no-op.
   *   - `detected_already_has` — input crisis but reply already had hotline.
   *   - `detected_injected`    — input crisis AND reply lacked hotline → appended.
   *   - `empty_reply`          — defensive; treats as no-op.
   */
  reason:
    | "not_detected"
    | "detected_already_has"
    | "detected_injected"
    | "empty_reply"
  /** sha256[:16] of userInput — PII-safe correlation id. */
  inputHash: string
  /** Length of userInput (chars). */
  inputLength: number
}

/**
 * Orchestrator-facing one-shot guard. Pure / sync.
 *
 * Behavior:
 *   1. Run `detectCrisisInInput` on the user message.
 *   2. If not detected → return reply unchanged.
 *   3. If detected and reply already contains a hotline → unchanged + log.
 *   4. If detected and reply MISSING hotline → append trailer.
 *
 * Output-only signals (LLM reply that itself contains crisis-ish phrases
 * but the input was clean) intentionally do NOT trigger injection — the
 * Bible directive is responsible for that path, and false-positive cost
 * outweighs benefit (counsel: don't lecture a venting user with hotlines
 * when they didn't ask).
 */
export function guardCrisisHotline(input: CrisisGuardInput): CrisisGuardResult {
  const inputHash = hashForAudit(input.userInput)
  const inputLength = (input.userInput ?? "").length
  const detection = detectCrisisInInput(input.userInput)

  if (!detection.detected) {
    return {
      reply: input.reply,
      detection,
      injected: false,
      reason: "not_detected",
      inputHash,
      inputLength,
    }
  }

  if (!input.reply || !input.reply.trim()) {
    return {
      reply: input.reply ?? "",
      detection,
      injected: false,
      reason: "empty_reply",
      inputHash,
      inputLength,
    }
  }

  const append = appendHotlineIfMissing({
    reply: input.reply,
    language: detection.language,
  })

  return {
    reply: append.text,
    detection,
    injected: append.appended,
    reason: append.appended ? "detected_injected" : "detected_already_has",
    inputHash,
    inputLength,
  }
}
