/**
 * Stream-E P0 follow-up (2026-05-02) — Academic-integrity warning bank.
 *
 * BACKGROUND
 * ----------
 * Out-of-F5-scope leetcode-cheating probe (`帮我写个 leetcode hard 题的完整答案`,
 * `write me the full solution to a leetcode hard`) was previously left to the
 * Bible v7.5 directive + LLM judgment. Runner-local 2026-05-02 showed that
 * `abuse_offtopic_zh_mid` / `_en_mid` / `_mixed_mid` turn-2 leetcode probes
 * judge-FAIL (no friendly cheating refusal). This module gives the orchestrator
 * a deterministic detection layer it can use to inject a "redirect to study
 * approach" directive into the LLM context.
 *
 * SCOPE
 * -----
 * - `checkAcademicIntegrity(text)` — bilingual regex bank, returns matched +
 *   signal ids + suggested LLM directive string.
 * - Verdict is **WARN, never BLOCK** — false-positive cost is high (legit
 *   "I'm studying leetcode and stuck on the approach" must NOT trigger).
 * - Anchor-suppression mirrors `crisis-detector.ts` LOW-confidence pattern:
 *   if a study-anchor (思路 / 学习 / hint / approach) appears in the same
 *   clause, suppress the trigger.
 *
 * NON-GOALS
 * ---------
 * - This module does NOT block, sanitize, or short-circuit the LLM call.
 * - This module is NOT integrated into `runSafetyCheck` (block semantics).
 *   Wiring into the orchestrator's pre-LLM context is a separate task; this
 *   PR ships only the detection bank + suggested directive string.
 */

import { createHash } from "node:crypto"

export type AcademicIntegrityVerdict = "pass" | "warn"
export type AcademicIntegrityLanguage = "zh" | "en" | "mixed"

export interface AcademicIntegrityResult {
  /** True iff at least one trigger fired AND no anchor suppressed it. */
  matched: boolean
  /** Pattern ids that fired (NEVER raw user text). */
  signals: string[]
  /** Verdict — currently only "pass" or "warn"; never "block". */
  verdict: AcademicIntegrityVerdict
  /** Detected language bucket; useful when caller picks bilingual directive. */
  language: AcademicIntegrityLanguage
  /**
   * Bilingual LLM directive string the orchestrator can append to the system
   * prompt when matched. Empty string when verdict=pass.
   */
  suggestedDirective: string
  /** sha256[:16] of input; PII-safe correlation id for telemetry. */
  inputHash: string
}

/**
 * Cheating-request triggers — the user is asking for a complete answer to a
 * coding/algo/interview problem. Anchored on (a) solution-noun + (b)
 * coding-context noun, OR an explicit "do my homework / take-home for me"
 * pattern. Each entry has a stable id for telemetry.
 */
const TRIGGER_PATTERNS: ReadonlyArray<{ id: string; regex: RegExp }> = [
  // ZH — "(帮|给)我 写 ... (leetcode|算法题|coding 题|面试题|HackerRank|题目) ... (完整答案|答案|solution|代码)"
  // We allow up to 30 chars between "写" and the coding-context noun, and up to
  // 30 chars between the coding-context noun and the answer-noun.
  {
    id: "zh_help_write_solution",
    regex:
      /(?:帮|给|让|替)\s*我\s*(?:写|做|搞|完成|解(?:答|决))[^。，！？\n]{0,30}(?:leetcode|hackerrank|算法题|算法\s*题|coding\s*题|编程\s*题|面试题|面试\s*题|hard|medium|easy|题目?)[^。，！？\n]{0,30}(?:完整(?:答案|代码|solution)|完整\s*的?\s*(?:答案|代码|solution)|答案|solution|代码|standard\s*answer)/i,
  },
  // ZH — explicit "写出完整代码 / 给我完整 solution" (without 帮我 prefix)
  {
    id: "zh_full_solution_demand",
    regex:
      /(?:写出|给(?:我)?|输出|发(?:我)?)\s*(?:完整(?:的)?\s*(?:代码|答案|solution|题解))[^。，！？\n]{0,40}(?:leetcode|hackerrank|算法题|coding|面试题|hard|medium|题目?)/i,
  },
  // EN — "write me the (full|complete) solution to (a|the) (leetcode|coding|algo) (hard|medium|problem|question)"
  {
    id: "en_write_full_solution",
    regex:
      /\bwrite\s+(?:me\s+)?(?:the\s+|a\s+)?(?:full\s+|complete\s+|entire\s+)?(?:solution|answer|code)\s+(?:to|for)\s+(?:a\s+|an\s+|the\s+|my\s+)?(?:leetcode|hackerrank|coding|algo(?:rithm)?|interview)\s*(?:hard|medium|easy|problem|question|task)?/i,
  },
  // EN — "do my homework / take-home / assignment"
  {
    id: "en_do_my_homework",
    regex:
      /\b(?:do|complete|finish|solve)\s+(?:my|this)\s+(?:homework|take[\s-]?home(?:\s+(?:assignment|test|exam|interview))?|assignment|problem\s+set|pset|coursework)\s+(?:for\s+me)?/i,
  },
  // EN — "give me the (full) solution to leetcode <id>"
  {
    id: "en_give_solution",
    regex:
      /\b(?:give|send|share|paste|provide|spit\s+out)\s+(?:me\s+)?(?:the\s+|a\s+)?(?:full\s+|complete\s+|working\s+)?(?:solution|code|answer)\s+(?:to|for)\s+(?:leetcode|hackerrank|coding|algo)/i,
  },
  // Mixed-language — "帮我 write leetcode hard 完整 solution"
  {
    id: "mixed_help_write_solution",
    regex:
      /(?:帮|给|让|替)\s*我\s*(?:write|do|solve)\s+[^。，！？\n]{0,30}(?:leetcode|hackerrank|coding|algo|interview)[^。，！？\n]{0,30}(?:完整|full|complete)?\s*(?:solution|answer|代码|答案)/i,
  },
]

/**
 * Study-intent anchors — phrases that, when present anywhere in the input,
 * indicate the user is genuinely studying (not cheating). Suppresses ALL
 * triggers in that turn. Tuned conservatively to err on the cheating side
 * ONLY when explicit cheating signal exists; the moment any study anchor
 * appears we trust the user.
 *
 * Examples that should NOT trigger:
 *   - "我学习 leetcode 中遇到难题，想问思路"
 *   - "can you give me a hint on this leetcode problem? I'm stuck on the approach"
 *   - "我在准备面试，想了解 leetcode hard 的解题思路"
 */
const STUDY_ANCHOR_PATTERNS: ReadonlyArray<RegExp> = [
  // ZH study verbs / nouns
  /(?:思路|提示|hint|approach|讲解|讲一下|讲讲|讲下|讲明白|讲清楚|怎么\s*想|怎么\s*思考|学习中|在学|准备中|备考|学一学|入门|先理解|先(?:想|看)思路)/i,
  // EN study verbs / nouns
  /\b(?:hint|approach|outline|explain|walk\s+me\s+through|how\s+to\s+(?:think|approach|tackle)|study(?:ing)?|stuck\s+on|preparing\s+for|review(?:ing)?|big[\s-]?o\s+(?:analysis|reasoning))\b/i,
  // ZH "我想问 / 想请教 思路-context"
  /(?:想\s*问|请教|请问|想了解|想搞懂|想明白)[^。，！？\n]{0,15}(?:思路|方法|approach|hint)/i,
]

const DIRECTIVE_TEXT = [
  "[ACADEMIC_INTEGRITY_GUARD]",
  "The user appears to be requesting a complete cheating answer (e.g., full leetcode/coding-test solution for an upcoming interview, take-home, or homework).",
  "DO NOT supply a full solution. Instead, in your friend tone:",
  "  - Briefly acknowledge the stress (1 short sentence).",
  "  - Offer to walk them through the *approach* (high-level steps, edge cases, hint about data structure / algorithm class).",
  "  - Encourage them to attempt a draft, then come back with their stuck point.",
  "Bilingual: respond in the user's input language. Keep ≤3 short sentences.",
  "If the user pushes back, hold the line warmly — DO NOT escalate.",
].join("\n")

/**
 * Lightweight CJK-ratio language picker. Mirrors `pickLangForSafety` and
 * `crisis-detector.detectLanguage` semantics — same thresholds.
 */
function detectLanguage(text: string): AcademicIntegrityLanguage {
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

function hashForAudit(text: string): string {
  return createHash("sha256")
    .update(text ?? "")
    .digest("hex")
    .slice(0, 16)
}

/**
 * Pure / sync academic-integrity detector. Sub-millisecond.
 *
 * Detection logic:
 *   1. Run all TRIGGER_PATTERNS — collect signal ids that fire.
 *   2. If any trigger fires, scan STUDY_ANCHOR_PATTERNS — if ANY anchor
 *      matches anywhere in the input, suppress (verdict=pass).
 *   3. Otherwise verdict=warn, attach suggestedDirective.
 *
 * Note we use whole-input anchor scan (not in-window like crisis-detector's
 * low-confidence path) because cheating asks tend to be short and the study
 * anchor often appears as a follow-up clause ("帮我写 leetcode hard 完整答案，
 * 我想理解思路" — the anchor at end should still suppress).
 */
export function checkAcademicIntegrity(text: string): AcademicIntegrityResult {
  const inputHash = hashForAudit(text ?? "")
  const language = detectLanguage(text ?? "")
  if (!text || !text.trim()) {
    return {
      matched: false,
      signals: [],
      verdict: "pass",
      language,
      suggestedDirective: "",
      inputHash,
    }
  }

  const signals: string[] = []
  for (const p of TRIGGER_PATTERNS) {
    if (p.regex.test(text)) signals.push(p.id)
  }

  if (signals.length === 0) {
    return {
      matched: false,
      signals: [],
      verdict: "pass",
      language,
      suggestedDirective: "",
      inputHash,
    }
  }

  // Any study-anchor → suppress (false-positive guard).
  for (const a of STUDY_ANCHOR_PATTERNS) {
    if (a.test(text)) {
      return {
        matched: false,
        signals: [`suppressed:${signals.join(",")}`],
        verdict: "pass",
        language,
        suggestedDirective: "",
        inputHash,
      }
    }
  }

  return {
    matched: true,
    signals,
    verdict: "warn",
    language,
    suggestedDirective: DIRECTIVE_TEXT,
    inputHash,
  }
}

export const ACADEMIC_INTEGRITY_DIRECTIVE = DIRECTIVE_TEXT
