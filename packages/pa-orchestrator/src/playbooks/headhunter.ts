// Phase 21 Track 5 — Headhunter playbook addendum.
//
// Why: Claire previously slipped into "advice/recommendation/teaching" mode
// the moment a user surfaced job-search signals ("想换工作", "在面", "offer").
// Adam's voice contract says Claire is a friend/roommate — she should push
// the user to TALK ABOUT FEELINGS/MEMORIES, not deliver headhunter answers.
// This is a prompt-structure fix only: a conditional system addendum that
// activates when the orchestrator detects job-search intent. No model
// escalation, no new dependencies (per companion_voice_constraints memory).
//
// Where it slots in: orchestrator injects it as one entry of `systemInputs`,
// AFTER the Phase 18 voice reminder and BEFORE the Phase 19 mirror snippet
// (D-04 ordering preserved). See packages/pa-orchestrator/src/index.ts.

export interface HeadhunterCtx {
  /** Set to true when the orchestrator detects an active headhunter turn. */
  active: boolean
  /**
   * IDs of probes already used in this conversation thread, so we rotate
   * through the menu instead of asking the same question every turn.
   */
  lastSignals?: string[]
}

/**
 * Stable IDs for the five feeling-probes in the addendum body. The IDs are
 * the contract — order/wording of the human-readable lines may evolve, but
 * downstream call sites tag rotation history by these IDs.
 */
export const HEADHUNTER_PROBE_IDS = [
  "scenes_joy",
  "interview_pain",
  "next_direction",
  "ooo_blocker",
  "team_chemistry",
] as const

export type HeadhunterProbeId = (typeof HEADHUNTER_PROBE_IDS)[number]

const HEADHUNTER_HEADER = "# PLAYBOOK MODE: HEADHUNTER (active)"

const ADDENDUM_BODY = `${HEADHUNTER_HEADER}
你现在是帮朋友找工作的室友, NOT 正经猎头. 不推荐机会, 不分析, 不教.
GOAL: push 用户多说自己的感受/回忆, 不是给答案.

只用感受型探针, 一次问一个:
- 最近做的项目里你最爽的是哪段?
- 上次面试你最不爽的环节是啥?
- 你下一段想往哪边走/跑 (不是哪个 title)?
- 你那个 OOO 卡你多久了?
- 现在团队你处得最来的人是干啥的?

NEVER: "我来告诉你 X" / "我可以给你分析" / "你最需要确认的是" / 框架 / 八股 / 比 offer.
OK: "嗯 然后呢" / "卧 那段听着爽" / "诶 这个我想多听点" / 沉默式接住.

退出: 用户烦/转话题 → 立即切回 CO-VIBE, 不再 push.`

/**
 * Pick the next probe ID to suggest, preferring ones absent from
 * `lastSignals`. Falls back to the first probe when all five are exhausted
 * (rotation wraps; we never get stuck silent).
 */
export function pickNextProbe(lastSignals: readonly string[] = []): HeadhunterProbeId {
  const used = new Set(lastSignals)
  for (const id of HEADHUNTER_PROBE_IDS) {
    if (!used.has(id)) return id
  }
  // All five seen — rotate by dropping the oldest signal: pick whichever
  // probe was NOT the most recently used.
  const last = lastSignals[lastSignals.length - 1]
  for (const id of HEADHUNTER_PROBE_IDS) {
    if (id !== last) return id
  }
  return HEADHUNTER_PROBE_IDS[0]
}

/**
 * Returns a system-message string for injection when the headhunter
 * playbook is active; null otherwise. The string is deterministic for a
 * given (active, lastSignals) pair so tests can assert on substrings.
 */
export function headhunterAddendum(ctx: HeadhunterCtx): string | null {
  if (!ctx.active) return null
  const next = pickNextProbe(ctx.lastSignals)
  // The next-probe hint is appended as a trailing line; Claire still picks
  // freely from the five-probe menu, but the suggestion biases rotation
  // when the model would otherwise lock onto a single probe.
  return `${ADDENDUM_BODY}\n\nROTATION HINT: 这轮优先用探针 \`${next}\`.`
}
