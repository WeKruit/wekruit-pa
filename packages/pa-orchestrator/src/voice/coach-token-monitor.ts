/**
 * Phase 24 — telemetry-only coach-token monitor (T1D).
 *
 * NO TRANSFORM. Pure observation + log. Adam-locked: no negative-
 * instruction blacklists in runtime — this only collects training
 * signal for Phase 25 self-evolve cycle.
 *
 * Fail-closed: regex compile error → empty pattern set, returns
 * empty hits + console.error log. Never throws.
 *
 * FP rate on golden-50 PASS cases (validated 2026-04-27): deferred — insufficient PASS data (golden-50.jsonl not yet populated; gated to plan 07 verification)
 */

// /u flag for correct Unicode (CJK) handling; /m flag for line-anchored patterns
const COACH_PATTERNS: [RegExp, string][] = (() => {
  try {
    return [
      [/我建议你|我推荐|你应该|听起来你|保持积极心态|你的感受是合理的|我们一步一步来|不妨试试|总之要相信自己|加油哦~?|宝~|亲~/u, "zh_coach_verb"],
      [/I suggest|Maybe you should|I recommend|I hear you|I understand/u, "en_coach_verb"],
      [/^\s*[-*•]/mu, "bullet_list"],
      [/^\s*\d+[.)、]/mu, "numbered_list"],
      [/(然后|接着|再|and then).*(然后|接着|再|and then).*(然后|接着|再|and then)/u, "subordinate_chain_4plus"],
    ]
  } catch (e) {
    // fail-closed: patterns failed to compile — log and return empty
    console.error("[pa.voice.coach_token_monitor] regex compile error", e)
    return []
  }
})()

export type CoachTokenHit = { token: string; pattern: string }

/**
 * Scan `text` for coach-mode patterns.
 * Returns one hit per matching pattern (first match per pattern).
 * Token is truncated to 40 chars per Pattern 5 spec.
 * Never throws.
 */
export function detectCoachTokens(text: string): CoachTokenHit[] {
  const hits: CoachTokenHit[] = []
  for (const [re, name] of COACH_PATTERNS) {
    const match = re.exec(text)
    if (match) {
      hits.push({ token: match[0].slice(0, 40), pattern: name })
    }
  }
  return hits
}

/**
 * Telemetry tap — call between reply trim and rewriteIfOff.
 *
 * Pure observation: reads `reply`, NEVER modifies it, returns void.
 * On hits, emits `pa.voice.coach_token.observed` via `log`.
 * On zero hits, does nothing.
 * Never throws.
 *
 * @param reply   Post-trim reply text (read-only).
 * @param ctx     Structured context for log payload.
 * @param log     Log function (defaults to console.log; override for
 *                production with store.log adapter).
 */
export function tapCoachTokens(
  reply: string,
  ctx: { turnId: string; userId: string; replyLength: number },
  log: (...args: unknown[]) => void = console.log
): void {
  try {
    const hits = detectCoachTokens(reply)
    if (hits.length > 0) {
      log("pa.voice.coach_token.observed", { ...ctx, tokens: hits })
    }
  } catch (e) {
    // fail-closed: never crash orchestrator on monitor error
    console.error("[pa.voice.coach_token_monitor] tapCoachTokens error", e)
  }
}
