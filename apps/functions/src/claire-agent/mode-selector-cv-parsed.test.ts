/**
 * mode-selector-cv-parsed.test.ts — the find_match-not-before-parse seam (c1b8782d).
 *
 * REQUIRED OUTCOME (Adam): a résumé DROP → ONE quick ack → parse async → the THIN pitch composes FROM
 * the parsed data → offer/run find_match AFTER. find_match must NEVER be offered/run before parsed data
 * exists. The deterministic 抓手 for "pitch + offer find_match" is `ModeDecision.postParsePitch`:
 *   - it is set ONLY when `cvParsedTrigger === true` (the resume_parse_completed re-entry — parsed data
 *     now EXISTS), so the prompt swaps the generic kickoff for the PART-2 proactive pitch that OFFERs
 *     find_match.
 *   - on a bare résumé-DROP turn (inline media present, NO parse yet → cutover passes
 *     `cvParsedTrigger:false`), postParsePitch is ABSENT → no pitch-from-nothing, no find_match offer.
 *     (The cutover separately sets `resumeJustDropped` to make that turn a single ACK bubble.)
 *
 * Pre-fix mode-selector had no cvParsedTrigger handling at all — every résumé turn was just plain
 * triage/onboarding with NO postParsePitch, which is exactly why the proactive pitch never ran. These
 * tests pin the post-fix invariant: postParsePitch tracks cvParsedTrigger, never the bare drop turn.
 *
 * Run: node --import tsx --test apps/functions/src/claire-agent/mode-selector-cv-parsed.test.ts
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { selectClaireMode } from "./mode-selector.js"

const USERS = "pa-users"
const PRESCREEN_SESSIONS = "pa-prescreen-sessions"

/**
 * Firestore stub covering exactly what selectClaireMode touches on the no-active-prescreen + complete-
 * profile path: the prescreen where-chain (returns EMPTY → no active screen) and a pa-users doc read.
 * No write paths are exercised (a returning/complete profile never bootstraps).
 */
function makeDb(userDoc: Record<string, unknown>) {
  return {
    collection(name: string) {
      if (name === PRESCREEN_SESSIONS) {
        const chain = {
          where: () => chain,
          limit: () => chain,
          async get() {
            return { empty: true, docs: [] as unknown[] }
          },
        }
        return chain
      }
      if (name === USERS) {
        return {
          doc() {
            return {
              async get() {
                return { exists: true, data: () => userDoc }
              },
            }
          },
        }
      }
      throw new Error(`unexpected collection ${name}`)
    },
  } as never
}

/** A returning candidate whose onboarding is COMPLETE → routes through the triage branch. */
const COMPLETE_USER: Record<string, unknown> = {
  onboardingState: "complete",
  sharedOnboarding: { status: "complete", completed: true, answers: { main_goal: "x" } },
}

test("cvParsedTrigger=true (parse re-entry) → postParsePitch is SET (pitch composes + OFFERs find_match AFTER parse)", async () => {
  const decision = await selectClaireMode({
    db: makeDb(COMPLETE_USER),
    userId: "u_complete",
    inboundText: "[resume just finished parsing]",
    cvParsedTrigger: true,
  })
  assert.equal(decision.deferToLegacy ?? false, false, "the re-entry must be handled by thin, not deferred")
  assert.equal(decision.mode, "triage", "a complete/returning profile pitches in triage mode")
  assert.equal(decision.postParsePitch, true, "the parse re-entry MUST set postParsePitch (pitch + offer find_match)")
})

test("cvParsedTrigger=false (bare résumé-DROP turn, no parse yet) → postParsePitch is ABSENT (no find_match offer before parse)", async () => {
  // This mirrors the cutover passing cvParsedTrigger:false on the inline-media drop turn (the parse
  // runs async; the offer waits for the resume_parse_completed re-entry).
  const decision = await selectClaireMode({
    db: makeDb(COMPLETE_USER),
    userId: "u_complete",
    inboundText: "(here is my resume)",
    cvParsedTrigger: false,
  })
  assert.equal(decision.mode, "triage")
  assert.ok(
    !decision.postParsePitch,
    "WITHOUT the parse re-entry there is no parsed data yet → the pitch+find_match-offer directive MUST NOT fire",
  )
})

test("the cvParsedTrigger flag is the ONLY switch — same user, same turn text, opposite trigger flips postParsePitch", async () => {
  // Swap-test: the only difference between the two calls is cvParsedTrigger, so postParsePitch must be
  // a pure function of it (no leakage from other state into the find_match-offering pitch).
  const on = await selectClaireMode({
    db: makeDb(COMPLETE_USER),
    userId: "u_complete",
    inboundText: "same text",
    cvParsedTrigger: true,
  })
  const off = await selectClaireMode({
    db: makeDb(COMPLETE_USER),
    userId: "u_complete",
    inboundText: "same text",
    cvParsedTrigger: false,
  })
  assert.equal(on.postParsePitch, true)
  assert.ok(!off.postParsePitch)
})

test("an undefined cvParsedTrigger (ordinary turn) never sets postParsePitch", async () => {
  const decision = await selectClaireMode({
    db: makeDb(COMPLETE_USER),
    userId: "u_complete",
    inboundText: "what roles do you have?",
    // cvParsedTrigger omitted entirely
  })
  assert.ok(!decision.postParsePitch, "an ordinary triage turn must never carry the post-parse pitch directive")
})
