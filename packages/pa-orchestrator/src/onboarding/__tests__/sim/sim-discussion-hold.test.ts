/**
 * Layer 2 sim — DiscussionPhase mid-process hold (Bug A regression check).
 *
 * P7-6 task: while q_resume_processing, user msg → hold reply (NOT
 * duplicate ack — Bug A regression).
 *
 * Bug A historical context (commit 6f16db7 / 3327d47): the old codepath had
 * a race where the cv-wait synthetic event re-emitted the "got it, reading
 * through your resume..." prompt twice, even after the user had already
 * uploaded the PDF and gotten the first ack. The DiscussionPhase abstraction
 * fixes this by separating onArtifactReceived (1× ack) from
 * onMessageWhileProcessing (always emits hold, never ack).
 *
 * Tests:
 *   1. onArtifactReceived → onMessageWhileProcessing × 3 — only 1 ack ever
 *      emitted; 3 distinct hold messages emitted (rotation works during
 *      hold loop too).
 *   2. cv-ingest is kicked off EXACTLY ONCE — never re-kicked on hold turns.
 *   3. State stays at q_resume_processing throughout the hold loop (no
 *      premature transition to done).
 *   4. After 3 holds, then onWorkComplete → state finally moves to done
 *      and ack is STILL never re-emitted.
 */
import test from "node:test"
import assert from "node:assert/strict"

import {
  ResumeDiscussionPhase,
  type ResumeDiscussionDeps,
} from "../../discussion-resume.js"
import type { PhaseInput, AsyncResult } from "../../discussion-phase.js"
import type { OnboardingState } from "@pa/core-types"

interface Recorder {
  sends: string[]
  states: OnboardingState[]
  kickoffs: number
  deps: ResumeDiscussionDeps
}

function makeRecorder(composeOutput = "analysis text"): Recorder {
  const sends: string[] = []
  const states: OnboardingState[] = []
  let kickoffs = 0
  const deps: ResumeDiscussionDeps = {
    async send(_input, text) { sends.push(text) },
    async kickoffCvIngest(_input) { kickoffs++ },
    async writeUserTagsFromCv() {},
    async composeCvAnalysis() { return composeOutput },
    async setOnboardingState(_userId, state) { states.push(state) },
  }
  return {
    sends,
    states,
    get kickoffs() { return kickoffs },
    deps,
  } as Recorder
}

function makeInput(over: Partial<PhaseInput> = {}): PhaseInput {
  return {
    userId: "u_hold",
    turnId: "t1",
    lang: "en",
    rawPayload: { attachments: [{ url: "https://x/cv.pdf" }] },
    db: {},
    log: () => {},
    ...over,
  }
}

test("sim/discussion-hold: 3 hold turns → 1 ack + 3 holds, NEVER re-emits ack (Bug A regression)", async () => {
  const rec = makeRecorder()
  // Stub RNG to cycle through the 3 hold variants deterministically.
  let rngCall = 0
  const rng = () => {
    const r = [0, 0.4, 0.8][rngCall % 3]!
    rngCall++
    return r
  }
  const phase = new ResumeDiscussionPhase(rec.deps, { rand: rng })

  // Step 1: artifact received — fires ack.
  await phase.onArtifactReceived(makeInput({ turnId: "t-art" }))

  // Steps 2-4: user pings 3 times during processing. Each call should emit
  // a hold message, NOT another ack.
  await phase.onMessageWhileProcessing(makeInput({ turnId: "t-h1" }))
  await phase.onMessageWhileProcessing(makeInput({ turnId: "t-h2" }))
  await phase.onMessageWhileProcessing(makeInput({ turnId: "t-h3" }))

  // Total sends: 1 ack + 3 holds = 4.
  assert.equal(rec.sends.length, 4, "1 ack + 3 holds = 4 messages")

  // Bug A regression: ack only ever appears at index 0.
  const ackPattern = /reading through your resume/i
  const ackOccurrences = rec.sends.filter((t) => ackPattern.test(t)).length
  assert.equal(ackOccurrences, 1, "ack emitted EXACTLY once — never duplicated")

  // The 3 holds must use 3 distinct phrasings (rotation works during loop).
  const holds = rec.sends.slice(1)
  const distinct = new Set(holds)
  assert.equal(distinct.size, 3, `3 distinct hold phrasings — got ${distinct.size}`)

  // cv-ingest kickoff happened exactly once — never re-kicked on holds.
  assert.equal(rec.kickoffs, 1, "cv-ingest kicked off EXACTLY once")

  // State only transitioned to processing once.
  assert.deepEqual(
    rec.states,
    ["q_resume_processing"],
    "state stays at processing throughout hold loop"
  )
})

test("sim/discussion-hold: after holds + completion → final state done, ack STILL not re-emitted", async () => {
  const rec = makeRecorder("summary text")
  const phase = new ResumeDiscussionPhase(rec.deps, { rand: () => 0 })

  await phase.onArtifactReceived(makeInput())
  await phase.onMessageWhileProcessing(makeInput({ turnId: "t-h1" }))
  await phase.onMessageWhileProcessing(makeInput({ turnId: "t-h2" }))

  const result: AsyncResult = { ok: true, data: { topSkills: ["TS"] } }
  await phase.onWorkComplete(makeInput({ turnId: "t-done" }), result)

  // Sends: ack, hold, hold, summary = 4.
  assert.equal(rec.sends.length, 4)
  assert.equal(
    rec.sends.filter((t) => /reading through your resume/i.test(t)).length,
    1,
    "ack still appears exactly once after full lifecycle"
  )
  assert.equal(rec.sends[3], "summary text", "final = summary")

  assert.deepEqual(
    rec.states,
    ["q_resume_processing", "q_resume_done"],
    "state: idle → processing → done (only 2 transitions across full flow)"
  )
  assert.equal(rec.kickoffs, 1, "kickoff once across entire flow")
})

test("sim/discussion-hold: pure-hold loop (no completion) → state never advances past processing", async () => {
  const rec = makeRecorder()
  const phase = new ResumeDiscussionPhase(rec.deps, { rand: () => 0 })

  await phase.onArtifactReceived(makeInput())
  for (let i = 0; i < 5; i++) {
    await phase.onMessageWhileProcessing(makeInput({ turnId: `t-${i}` }))
  }

  assert.deepEqual(
    rec.states,
    ["q_resume_processing"],
    "no transition to done without onWorkComplete"
  )
  // 1 ack + 5 holds.
  assert.equal(rec.sends.length, 6)
  assert.equal(
    rec.sends.filter((t) => /reading through your resume/i.test(t)).length,
    1,
    "ack once across 5-hold loop"
  )
})
