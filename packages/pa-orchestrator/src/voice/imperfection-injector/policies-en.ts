/**
 * Phase 36 — English imperfection policies.
 *
 * Ordered policy bank — type priority enforced by ARRAY ORDER:
 *   self_correct (highest) → hesitate → clarify → uncertainty (lowest)
 *
 * **CRITICAL**: every marker here MUST be disjoint from
 * `tests/scenarios/lib/voice-axes.mjs:FILLER_BLACKLIST_EN`. The
 * `policies-en.test.ts` anti-blacklist guard fails the build if any
 * collision sneaks in. NEVER inject FILLER_BLACKLIST phrases.
 *
 * Markers were chosen as NEW human tells distinct from the blacklist:
 * - `hmm`, `uh` — soft hesitation (not "It's important to" template)
 * - `wait no, ` — self-correct (not "I'll remember that" tic)
 * - `let me think,` — thinking marker (not "Of course")
 * - `actually,` — clarifying interrupt
 * - `oh —` — clarifying recall (not "Got it" filler)
 * - `not sure if`, `I mean` — uncertainty hedge
 *
 * Lameris 2412.12710 caution applies: 30% high-arm cap. Per-marker
 * `weight` keeps any single phrase from dominating.
 */
import type { Policy } from "./types.js"

/**
 * Ordered EN policy bank. ARRAY ORDER IS THE PRIORITY — do not reorder
 * without updating type-priority tests.
 */
export const POLICIES_EN: Policy[] = [
  // self_correct (highest priority)
  { type: "self_correct", marker: "wait no — ", separator: "", lang: "en", weight: 1 },
  { type: "self_correct", marker: "scratch that, ", separator: "", lang: "en", weight: 1 },

  // hesitate
  { type: "hesitate", marker: "hmm, ", separator: "", lang: "en", weight: 2 },
  { type: "hesitate", marker: "uh, ", separator: "", lang: "en", weight: 1 },
  { type: "hesitate", marker: "let me think — ", separator: "", lang: "en", weight: 1 },

  // clarify
  { type: "clarify", marker: "actually, ", separator: "", lang: "en", weight: 1 },
  { type: "clarify", marker: "oh — ", separator: "", lang: "en", weight: 1 },

  // uncertainty (lowest priority)
  { type: "uncertainty", marker: "not sure if, ", separator: "", lang: "en", weight: 1 },
  { type: "uncertainty", marker: "I mean, ", separator: "", lang: "en", weight: 1 },
]
