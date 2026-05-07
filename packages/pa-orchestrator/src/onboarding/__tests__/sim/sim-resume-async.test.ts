/**
 * Layer 2 sim — DiscussionPhase resume lifecycle (full async flow).
 *
 * P7-6 task: attachment → ack → wait msg "稍等" → cv-parsed → analysis →
 * handover. Verifies the ack-then-async-then-analysis sequence (DOD #4).
 *
 * Lifecycle order asserted:
 *   1. onArtifactReceived sends ack ("reading through your resume")
 *   2. State transitions to q_resume_processing
 *   3. cv-ingest worker is kicked off (fire-and-forget)
 *   4. While processing, mid-process user msg → onMessageWhileProcessing
 *      sends hold ("稍等") — but does NOT re-fire ack
 *   5. cv-ingest worker callback → onWorkComplete
 *      - persistAnalysis writes user tags
 *      - sendAnalysis sends summary message
 *      - state advances to complete
 *
 * This complements the existing discussion-resume.test.ts unit coverage by
 * testing them in INTEGRATION sequence (not just per-method) and asserting
 * the full message ordering.
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
  sends: Array<{ text: string; turnId: string }>
  states: OnboardingState[]
  kickoffs: number
  writeTagsCalls: Array<{ userId: string; parsed: unknown }>
  composeCalls: number
  deps: ResumeDiscussionDeps
}

function makeRecorder(opts: { composeOutput?: string } = {}): Recorder {
  const sends: Recorder["sends"] = []
  const states: OnboardingState[] = []
  const writeTagsCalls: Recorder["writeTagsCalls"] = []
  let kickoffs = 0
  let composeCalls = 0
  const composeOutput =
    opts.composeOutput ?? "I see you have TypeScript + 3yr at WeKruit — match?"

  const deps: ResumeDiscussionDeps = {
    async send(input, text) {
      sends.push({ text, turnId: input.turnId })
    },
    async kickoffCvIngest(_input) {
      kickoffs++
    },
    async writeUserTagsFromCv(userId, parsed, _db) {
      writeTagsCalls.push({ userId, parsed })
    },
    async composeCvAnalysis(_input, _parsed) {
      composeCalls++
      return composeOutput
    },
    async setOnboardingState(_userId, state, _db) {
      states.push(state)
    },
  }

  return {
    sends,
    states,
    get kickoffs() {
      return kickoffs
    },
    writeTagsCalls,
    get composeCalls() {
      return composeCalls
    },
    deps,
  } as Recorder
}

function makeInput(over: Partial<PhaseInput> = {}): PhaseInput {
  return {
    userId: "user_sim_resume",
    turnId: "t1",
    lang: "en",
    rawPayload: { attachments: [{ url: "https://x.com/cv.pdf" }] },
    db: {},
    log: () => {},
    ...over,
  }
}

test("sim/resume-async: full lifecycle (ack → hold → analysis) — message order + state transitions", async () => {
  const rec = makeRecorder({ composeOutput: "summary: TS + 3yr WeKruit" })
  const phase = new ResumeDiscussionPhase(rec.deps, { rand: () => 0 })

  // Turn 1: PDF attachment received.
  await phase.onArtifactReceived(makeInput({ turnId: "t1" }))

  // Turn 2: user pings during processing.
  await phase.onMessageWhileProcessing(makeInput({ turnId: "t2", userMessage: "still there?" }))

  // Turn 3: cv-ingest finishes, callback fires onWorkComplete.
  const result: AsyncResult = {
    ok: true,
    data: { topSkills: ["TypeScript"], experiences: [{ company: "WeKruit" }] },
  }
  await phase.onWorkComplete(makeInput({ turnId: "t3" }), result)

  // Assert message order: ack → hold → analysis. Three sends total.
  assert.equal(rec.sends.length, 3, "exactly 3 outbound messages across lifecycle")
  assert.match(rec.sends[0]!.text, /reading through your resume/i, "msg 1 = ack")
  assert.match(
    rec.sends[1]!.text,
    /(hold on|almost there|few more seconds)/i,
    "msg 2 = hold (rotation)"
  )
  assert.equal(rec.sends[2]!.text, "summary: TS + 3yr WeKruit", "msg 3 = analysis")

  // Assert state machine: idle → processing → complete (2 transitions only).
  assert.deepEqual(
    rec.states,
    ["q_resume_processing", "complete"],
    "state: idle → processing → done"
  )

  // Assert cv-ingest kicked off exactly once (NOT re-kicked on hold turn).
  assert.equal(rec.kickoffs, 1, "cv-ingest kicked exactly once")

  // Assert tags persisted exactly once on success.
  assert.equal(rec.writeTagsCalls.length, 1)
  assert.deepEqual(rec.writeTagsCalls[0]?.parsed, result.data, "parsed payload persisted")
})

test("sim/resume-async: zh language path — Chinese ack + hold + analysis", async () => {
  const rec = makeRecorder({ composeOutput: "看到你 3 年经验" })
  const phase = new ResumeDiscussionPhase(rec.deps, { rand: () => 0 })

  await phase.onArtifactReceived(makeInput({ lang: "zh", turnId: "tz1" }))
  await phase.onMessageWhileProcessing(makeInput({ lang: "zh", turnId: "tz2" }))
  await phase.onWorkComplete(
    makeInput({ lang: "zh", turnId: "tz3" }),
    { ok: true, data: {} }
  )

  assert.equal(rec.sends.length, 3)
  assert.match(rec.sends[0]!.text, /读一下你的简历/, "zh ack")
  assert.match(rec.sends[1]!.text, /稍等|马上|再给我/, "zh hold")
  assert.equal(rec.sends[2]!.text, "看到你 3 年经验", "zh analysis")
})

test("sim/resume-async: cv-ingest failure → error message + no advance", async () => {
  const rec = makeRecorder()
  const phase = new ResumeDiscussionPhase(rec.deps)

  await phase.onArtifactReceived(makeInput({ turnId: "tf1" }))
  // Simulate cv-ingest failed callback.
  await phase.onWorkComplete(
    makeInput({ turnId: "tf2" }),
    { ok: false, error: "pdf_5xx" }
  )

  // 1 ack + 1 error message = 2 sends.
  assert.equal(rec.sends.length, 2)
  assert.match(rec.sends[0]!.text, /reading through/i, "msg 1 = ack")
  assert.match(rec.sends[1]!.text, /can you resend|couldn't read/i, "msg 2 = error")

  // State only transitioned to processing (no done on failure).
  assert.deepEqual(rec.states, ["q_resume_processing"], "stays at processing on failure")
  assert.equal(rec.writeTagsCalls.length, 0, "no tags persisted on failure")
  assert.equal(rec.composeCalls, 0, "no analysis composed on failure")
})
