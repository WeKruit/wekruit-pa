/**
 * Phase 36 — Chinese imperfection policies.
 *
 * Ordered policy bank — type priority enforced by ARRAY ORDER:
 *   self_correct (highest) → hesitate → clarify → uncertainty (lowest)
 *
 * **CRITICAL**: every marker here MUST be disjoint from
 * `tests/scenarios/lib/voice-axes.mjs:FILLER_BLACKLIST_ZH`. The
 * `policies-zh.test.ts` anti-blacklist guard fails the build if any
 * collision sneaks in. NEVER inject FILLER_BLACKLIST phrases — they are
 * the F2/F4 anti-pattern this whole milestone is fighting.
 *
 * Markers were chosen as NEW human tells distinct from the blacklist:
 * - `嗯…` — soft hesitation, not "好的，我记住了" template
 * - `啊不对，是…` — self-correct, not validation tic
 * - `让我想想` — thinking marker, not "让我们一起" coach phrase
 * - `等等` — clarifying interrupt
 * - `哦对了` — clarifying recall
 * - `说不清是不是` — uncertainty hedge
 *
 * Lameris 2412.12710 caution: even fine-tuned models over-produce
 * imperfection at 77%+ rates. We cap at 30% (high arm). Per-marker
 * weight tuning (D-36-2) keeps any single phrase from dominating.
 */
import type { Policy } from "./types.js"

/**
 * Ordered ZH policy bank. ARRAY ORDER IS THE PRIORITY — do not reorder
 * without updating type-priority tests.
 *
 * Each policy: `marker` is what gets prepended; `separator` lives between
 * marker and the original text; `weight` is intra-type selection weight.
 */
export const POLICIES_ZH: Policy[] = [
  // self_correct (highest priority)
  { type: "self_correct", marker: "啊不对，是", separator: "", lang: "zh", weight: 1 },
  { type: "self_correct", marker: "等下我说错了，", separator: "", lang: "zh", weight: 1 },

  // hesitate
  { type: "hesitate", marker: "嗯…", separator: "", lang: "zh", weight: 2 },
  { type: "hesitate", marker: "哦…", separator: "", lang: "zh", weight: 1 },
  { type: "hesitate", marker: "让我想想，", separator: "", lang: "zh", weight: 1 },

  // clarify
  { type: "clarify", marker: "等等，", separator: "", lang: "zh", weight: 1 },
  { type: "clarify", marker: "哦对了，", separator: "", lang: "zh", weight: 1 },

  // uncertainty (lowest priority)
  { type: "uncertainty", marker: "说不清是不是，", separator: "", lang: "zh", weight: 1 },
  { type: "uncertainty", marker: "我也不太确定，", separator: "", lang: "zh", weight: 1 },
]
