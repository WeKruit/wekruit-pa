import { test } from "node:test"
import assert from "node:assert/strict"

import { createTurnLoop, type VoicePipelineLite } from "../turn-loop.js"
import type { VoiceCallContext } from "../voice-context-types.js"

function makeContext(piiConsent?: string): VoiceCallContext {
  return {
    bookingId: "bk-test-1",
    userProfile: {
      userId: "u-1",
      preferredLang: "en",
      piiConsentAt: piiConsent,
      missingFields: [],
    },
    jobBrief: {
      jobId: "j-1",
      jobTitle: "Solutions Engineer",
      companyName: "WeKruit",
      missingFields: [],
    },
    prescreenConfig: {
      jobId: "j-1",
      version: 1,
      jobTitle: "Solutions Engineer",
      threshold: 0.5,
      confidenceThreshold: 0.5,
      maxClarifyRounds: 2,
      voiceMode: "professional_prescreen",
      questions: [
        {
          qId: "q1",
          type: "experience",
          prompt: { en: "Tell me about your most recent role." },
        },
      ],
      parsedFromZod: true,
      missingFields: [],
    },
  }
}

test("turn-loop: invokes pipeline.runTurn once per onUserCommit", async () => {
  let calls = 0
  const pipeline: VoicePipelineLite = {
    async runTurn(input) {
      calls++
      assert.equal(input.sessionId, "bk-test-1")
      assert.equal(input.reply, "I lead a frontend team.")
      assert.equal(input.lang, "en")
      return {
        text: "Got it — frontend lead.",
        action: { kind: "advance", fromQId: "q1", toQId: "q2" },
      }
    },
  }
  const turnLoop = createTurnLoop({
    pipeline,
    context: makeContext("2026-05-01T00:00:00Z"),
  })
  const out = await turnLoop.onUserCommit({
    reply: "I lead a frontend team.",
    nowIso: "2026-05-15T00:00:00Z",
  })
  assert.equal(calls, 1)
  assert.equal(out.speakText, "Got it — frontend lead.")
  assert.equal(out.redacted, false)
  assert.equal(out.action.kind, "advance")
})

test("turn-loop: PII redaction applied without consent", async () => {
  const pipeline: VoicePipelineLite = {
    async runTurn() {
      return {
        text: "Send your resume to careers@example.com — thanks.",
        action: { kind: "advance", fromQId: "q1", toQId: "q2" },
      }
    },
  }
  const turnLoop = createTurnLoop({
    pipeline,
    context: makeContext(/* no consent */),
  })
  const out = await turnLoop.onUserCommit({
    reply: "ok",
    nowIso: "2026-05-15T00:00:00Z",
  })
  assert.equal(out.redacted, true)
  assert.match(out.speakText, /\[sms_handoff:email:0\]/)
  assert.equal(out.smsHandoffTokens.length, 1)
})

test("turn-loop: onTurn metric hook fires with action + redacted flag", async () => {
  const events: unknown[] = []
  const pipeline: VoicePipelineLite = {
    async runTurn() {
      return {
        text: "Got it.",
        action: { kind: "terminal", terminal: "PASS", reason: "all_qs_pass" },
      }
    },
  }
  const turnLoop = createTurnLoop({
    pipeline,
    context: makeContext("2026-05-01"),
    onTurn: (e) => events.push(e),
  })
  await turnLoop.onUserCommit({
    reply: "yes",
    nowIso: "2026-05-15T00:00:00Z",
  })
  assert.equal(events.length, 1)
  const ev = events[0] as { action: { kind: string }; redacted: boolean }
  assert.equal(ev.action.kind, "terminal")
  assert.equal(ev.redacted, false)
})

test("turn-loop: onTurn throw does NOT crash the turn", async () => {
  const pipeline: VoicePipelineLite = {
    async runTurn() {
      return {
        text: "ok",
        action: { kind: "advance", fromQId: "q1", toQId: "q2" },
      }
    },
  }
  const turnLoop = createTurnLoop({
    pipeline,
    context: makeContext("2026-05-01"),
    onTurn: () => {
      throw new Error("metric writer down")
    },
  })
  const out = await turnLoop.onUserCommit({
    reply: "x",
    nowIso: "2026-05-15T00:00:00Z",
  })
  assert.equal(out.speakText, "ok")
})

test("turn-loop: preferredLang defaults from profile when input.lang absent", async () => {
  let seenLang: string | undefined
  const pipeline: VoicePipelineLite = {
    async runTurn(input) {
      seenLang = input.lang
      return { text: "好的。", action: { kind: "advance", fromQId: "q1", toQId: "q2" } }
    },
  }
  const ctx = makeContext("2026-05-01")
  ctx.userProfile.preferredLang = "zh"
  const turnLoop = createTurnLoop({ pipeline, context: ctx })
  await turnLoop.onUserCommit({ reply: "嗨", nowIso: "2026-05-15T00:00:00Z" })
  assert.equal(seenLang, "zh")
})

test("turn-loop: input.lang override beats profile", async () => {
  let seenLang: string | undefined
  const pipeline: VoicePipelineLite = {
    async runTurn(input) {
      seenLang = input.lang
      return { text: "OK", action: { kind: "advance", fromQId: "q1", toQId: "q2" } }
    },
  }
  const ctx = makeContext("2026-05-01")
  ctx.userProfile.preferredLang = "zh"
  const turnLoop = createTurnLoop({ pipeline, context: ctx })
  await turnLoop.onUserCommit({
    reply: "x",
    nowIso: "2026-05-15T00:00:00Z",
    lang: "en",
  })
  assert.equal(seenLang, "en")
})

test("turn-loop: emitChars reports length of speakText", async () => {
  let recordedChars = -1
  const pipeline: VoicePipelineLite = {
    async runTurn() {
      return {
        text: "abcde",
        action: { kind: "advance", fromQId: "q1", toQId: "q2" },
      }
    },
  }
  const turnLoop = createTurnLoop({
    pipeline,
    context: makeContext("2026-05-01"),
    onTurn: (e) => {
      recordedChars = e.emitChars
    },
  })
  await turnLoop.onUserCommit({ reply: "x", nowIso: "2026-05-15T00:00:00Z" })
  assert.equal(recordedChars, 5)
})

test("turn-loop: pipelineLatencyMs is non-negative", async () => {
  let latency = -1
  const pipeline: VoicePipelineLite = {
    async runTurn() {
      // small async pause
      await new Promise((r) => setTimeout(r, 1))
      return {
        text: "y",
        action: { kind: "advance", fromQId: "q1", toQId: "q2" },
      }
    },
  }
  const turnLoop = createTurnLoop({
    pipeline,
    context: makeContext("2026-05-01"),
    onTurn: (e) => {
      latency = e.pipelineLatencyMs
    },
  })
  await turnLoop.onUserCommit({ reply: "x", nowIso: "2026-05-15T00:00:00Z" })
  assert.ok(latency >= 0, `latency=${latency}`)
})
