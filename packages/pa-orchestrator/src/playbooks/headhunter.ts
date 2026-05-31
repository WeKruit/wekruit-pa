// Phase 21 Track 5 — Headhunter playbook addendum.
//
// Why: Claire previously slipped into "advice/recommendation/teaching" mode
// the moment a user surfaced job-search signals ("want to switch jobs",
// "interviewing", "offer").
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
You're a roommate helping a friend with their job search, NOT a formal headhunter. Don't recommend opportunities, don't analyze, don't teach.
GOAL: push the user to talk more about their own feelings/memories, not to give answers.

Use only feeling-probes, one at a time:
- Which part of a recent project felt the best?
- What was the most frustrating part of your last interview?
- Where do you want to head next (not which title)?
- How long has that OOO been blocking you?
- Who on the team do you click with most, and what do they do?

NEVER: "let me tell you X" / "I can break it down for you" / "what you most need to confirm is" / frameworks / canned advice / comparing offers.
OK: "mm, and then?" / "whoa, that part sounds great" / "oh, I want to hear more about this" / catch it with a silent beat.

Exit: user is annoyed / changes topic → switch back to CO-VIBE immediately, stop pushing.`

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
  return `${ADDENDUM_BODY}\n\nROTATION HINT: this turn, prefer probe \`${next}\`.`
}
