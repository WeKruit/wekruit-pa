/**
 * iter35 G2 — ResumeDiscussionPhase unit tests.
 *
 * Coverage matrix (per task DOD):
 *   1. sendImmediateAck called once on artifact receipt + state advances
 *      idle → processing
 *   2. mid-process user msg → sendHoldMessage called (NOT another
 *      sendImmediateAck — Bug A regression check)
 *   3. onWorkComplete success → persistAnalysis + sendAnalysis +
 *      state advances processing → complete
 *   4. onWorkComplete failure (result.ok=false) → sendErrorMessage,
 *      NO persistAnalysis, state stays at processing
 *   5. pickHoldMessage rotates across all variants given a stubbed RNG
 *
 * All deps stubbed — no Firestore, no LLM, no network.
 */
import { describe, it } from "node:test"
import assert from "node:assert/strict"

import {
  ResumeDiscussionPhase,
  pickHoldMessage,
  type ResumeDiscussionDeps,
} from "./discussion-resume.js"
import type { PhaseInput, AsyncResult } from "./discussion-phase.js"
import type { OnboardingState } from "@pa/core-types"

// ---------- Test scaffolding -------------------------------------------------

interface SendCall {
  text: string
  turnId: string
}
interface StateCall {
  state: OnboardingState
}
interface MakeDepsResult {
  deps: ResumeDiscussionDeps
  sends: SendCall[]
  states: StateCall[]
  kickoffCalls: number
  writeUserTagsCalls: Array<{ userId: string; parsed: unknown }>
  composeCalls: number
  /** When set, makeDeps will throw from kickoffCvIngest. */
  kickoffShouldThrow?: boolean
}

function makeDeps(opts: { composeOutput?: string } = {}): MakeDepsResult {
  const sends: SendCall[] = []
  const states: StateCall[] = []
  const writeUserTagsCalls: MakeDepsResult["writeUserTagsCalls"] = []
  let kickoffCalls = 0
  let composeCalls = 0
  const composeOutput = opts.composeOutput ?? "I see you have TS + Firestore — sound right?"

  const deps: ResumeDiscussionDeps = {
    async send(input, text) {
      sends.push({ text, turnId: input.turnId })
    },
    async kickoffCvIngest(_input) {
      kickoffCalls++
    },
    async writeUserTagsFromCv(userId, parsed, _db) {
      writeUserTagsCalls.push({ userId, parsed })
    },
    async composeCvAnalysis(_input, _parsed) {
      composeCalls++
      return composeOutput
    },
    async setOnboardingState(_userId, state, _db) {
      states.push({ state })
    },
  }

  return {
    deps,
    sends,
    states,
    get kickoffCalls() {
      return kickoffCalls
    },
    writeUserTagsCalls,
    get composeCalls() {
      return composeCalls
    },
  } as MakeDepsResult
}

function makeInput(over: Partial<PhaseInput> = {}): PhaseInput {
  return {
    userId: "user_test",
    turnId: "turn_1",
    lang: "en",
    rawPayload: { media_url: "https://example.com/cv.pdf" },
    db: {},
    log: () => {},
    ...over,
  }
}

// ---------- Tests ------------------------------------------------------------

describe("ResumeDiscussionPhase — onArtifactReceived", () => {
  it("sends immediate ack EXACTLY once + state goes idle → processing + kicks off cv-ingest", async () => {
    const tracker = makeDeps()
    const phase = new ResumeDiscussionPhase(tracker.deps)
    const input = makeInput()

    await phase.onArtifactReceived(input)

    assert.equal(tracker.sends.length, 1, "exactly one outbound send")
    assert.match(
      tracker.sends[0]!.text,
      /reading through your resume/i,
      "ack text mentions reading resume"
    )
    assert.deepEqual(
      tracker.states.map((s) => s.state),
      ["q_resume_processing"],
      "state advanced to processing"
    )
    assert.equal(tracker.kickoffCalls, 1, "cv-ingest kicked off once")
  })

  it("zh language still sends English ack (product is English-only)", async () => {
    const tracker = makeDeps()
    const phase = new ResumeDiscussionPhase(tracker.deps)
    await phase.onArtifactReceived(makeInput({ lang: "zh" }))
    assert.equal(tracker.sends.length, 1)
    assert.match(tracker.sends[0]!.text, /reading through your resume/i, "english ack")
  })
})

describe("ResumeDiscussionPhase — onMessageWhileProcessing (Bug A regression)", () => {
  it("sends hold message — NOT another ack — and does NOT re-kick cv-ingest", async () => {
    const tracker = makeDeps()
    const phase = new ResumeDiscussionPhase(tracker.deps)
    const input = makeInput({ turnId: "turn_2" })

    await phase.onMessageWhileProcessing(input)

    assert.equal(tracker.sends.length, 1, "exactly one hold message")
    // Bug A regression: we MUST NOT see "reading through" again here —
    // that's the ack that fires only on artifact receipt.
    assert.doesNotMatch(
      tracker.sends[0]!.text,
      /reading through your resume/i,
      "must NOT re-emit ack"
    )
    assert.match(
      tracker.sends[0]!.text,
      /(hold on|almost there|few more seconds)/i,
      "hold variant emitted"
    )
    assert.equal(tracker.kickoffCalls, 0, "cv-ingest NOT re-kicked")
    assert.equal(tracker.states.length, 0, "no state transition during hold")
  })

  it("zh language still picks an English hold variant (product is English-only)", async () => {
    const tracker = makeDeps()
    // RNG=0 picks index 0 ("hold on, still reading your resume")
    const phase = new ResumeDiscussionPhase(tracker.deps, { rand: () => 0 })
    await phase.onMessageWhileProcessing(makeInput({ lang: "zh" }))
    assert.equal(tracker.sends.length, 1)
    assert.match(tracker.sends[0]!.text, /(hold on|almost there|few more seconds)/i, "english hold")
  })
})

describe("ResumeDiscussionPhase — onWorkComplete (success)", () => {
  it("persists tags, sends analysis, advances processing → complete", async () => {
    const tracker = makeDeps({ composeOutput: "I see TypeScript + 3yr — match?" })
    const phase = new ResumeDiscussionPhase(tracker.deps)
    const input = makeInput({ turnId: "turn_done" })
    const parsed = { topSkills: ["TypeScript"], experiences: [{ company: "WeKruit" }] }
    const result: AsyncResult = { ok: true, data: parsed }

    await phase.onWorkComplete(input, result)

    assert.equal(tracker.writeUserTagsCalls.length, 1, "tags written once")
    assert.deepEqual(tracker.writeUserTagsCalls[0], {
      userId: "user_test",
      parsed,
    })
    assert.equal(tracker.composeCalls, 1, "compose called once")
    assert.equal(tracker.sends.length, 1, "analysis sent once")
    assert.match(tracker.sends[0]!.text, /TypeScript \+ 3yr/, "analysis text matches compose output")
    assert.deepEqual(
      tracker.states.map((s) => s.state),
      ["complete"],
      "state advanced to complete"
    )
  })
})

describe("ResumeDiscussionPhase — onWorkComplete (failure)", () => {
  it("sends error message, does NOT persist tags, does NOT advance state", async () => {
    const tracker = makeDeps()
    const phase = new ResumeDiscussionPhase(tracker.deps)
    const input = makeInput({ turnId: "turn_fail" })
    const result: AsyncResult = { ok: false, error: "pdf_fetch_5xx" }

    await phase.onWorkComplete(input, result)

    assert.equal(tracker.sends.length, 1, "one error message sent")
    assert.match(
      tracker.sends[0]!.text,
      /can you resend|couldn't read/i,
      "error text asks for resend"
    )
    assert.equal(tracker.writeUserTagsCalls.length, 0, "tags NOT written")
    assert.equal(tracker.composeCalls, 0, "compose NOT called")
    assert.equal(tracker.states.length, 0, "state NOT advanced on failure")
  })

  it("zh language still sends an English error message (product is English-only)", async () => {
    const tracker = makeDeps()
    const phase = new ResumeDiscussionPhase(tracker.deps)
    await phase.onWorkComplete(
      makeInput({ lang: "zh" }),
      { ok: false, error: "x" }
    )
    assert.equal(tracker.sends.length, 1)
    assert.match(tracker.sends[0]!.text, /couldn't read your resume/i, "english error")
  })
})

describe("ResumeDiscussionPhase — full lifecycle integration", () => {
  it("ack → hold → complete sequence (3 turns) — sends 3 distinct messages, ends at complete", async () => {
    const tracker = makeDeps({ composeOutput: "summary text" })
    // RNG=0 → first hold variant, deterministic
    const phase = new ResumeDiscussionPhase(tracker.deps, { rand: () => 0 })

    // Turn 1: artifact received
    await phase.onArtifactReceived(makeInput({ turnId: "t1" }))
    // Turn 2: user pings during processing
    await phase.onMessageWhileProcessing(makeInput({ turnId: "t2" }))
    // Turn 3: cv-ingest callback completes
    await phase.onWorkComplete(makeInput({ turnId: "t3" }), {
      ok: true,
      data: { topSkills: ["TS"] },
    })

    assert.equal(tracker.sends.length, 3, "3 outbound messages total")
    assert.match(tracker.sends[0]!.text, /reading through/i, "msg 1 = ack")
    assert.match(tracker.sends[1]!.text, /(hold on|almost|few more)/i, "msg 2 = hold")
    assert.equal(tracker.sends[2]!.text, "summary text", "msg 3 = analysis")
    assert.deepEqual(
      tracker.states.map((s) => s.state),
      ["q_resume_processing", "complete"],
      "state: idle → processing → complete (no extra transitions)"
    )
    assert.equal(tracker.kickoffCalls, 1, "cv-ingest kicked off exactly once")
  })
})

describe("pickHoldMessage", () => {
  it("rotates across all en variants given deterministic RNG", () => {
    const en0 = pickHoldMessage("en", () => 0)
    const en1 = pickHoldMessage("en", () => 0.4)
    const en2 = pickHoldMessage("en", () => 0.8)
    const set = new Set([en0, en1, en2])
    assert.equal(set.size, 3, "3 distinct en variants")
    for (const v of set) {
      assert.match(v, /(hold on|almost there|few more seconds)/i)
    }
  })
  it("rotates across all zh variants given deterministic RNG", () => {
    const zh0 = pickHoldMessage("zh", () => 0)
    const zh1 = pickHoldMessage("zh", () => 0.4)
    const zh2 = pickHoldMessage("zh", () => 0.8)
    const set = new Set([zh0, zh1, zh2])
    assert.equal(set.size, 3, "3 distinct zh variants")
  })
  it("does not crash when rand returns 0.999... (clamps to last index via floor)", () => {
    const out = pickHoldMessage("en", () => 0.9999)
    assert.ok(typeof out === "string" && out.length > 0)
  })
})
