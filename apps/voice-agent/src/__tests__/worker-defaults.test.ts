/**
 * v2.2 — defaultLoadContext + defaultBuildPipeline integration tests.
 *
 * These exercise the HTTPS bridge to apps/functions's paVoiceCallContext
 * and paVoicePrescreenTurn callable CFs. We mock global.fetch so no
 * network is touched. The goal is to lock down:
 *   - env-var prerequisites
 *   - secret-header propagation
 *   - error mapping
 *   - request body shape (so the orchestrator brain receives the right args)
 */
import test from "node:test"
import assert from "node:assert/strict"

import { defaultBuildPipeline, defaultLoadContext, waitForRemoteParticipant } from "../worker.js"
import type { VoiceCallContext } from "../voice-context-types.js"

interface FakeFetchCall {
  url: string
  init?: RequestInit
}

function installFakeFetch(handler: (input: FakeFetchCall) => Response | Promise<Response>) {
  const calls: FakeFetchCall[] = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (url: unknown, init?: unknown) => {
    const call: FakeFetchCall = {
      url: typeof url === "string" ? url : String(url),
      init: init as RequestInit | undefined,
    }
    calls.push(call)
    return await handler(call)
  }) as typeof fetch
  return {
    calls,
    restore: () => {
      globalThis.fetch = originalFetch
    },
  }
}

const ORIGINAL_ENV = {
  WEKRUIT_VOICE_CONTEXT_URL: process.env.WEKRUIT_VOICE_CONTEXT_URL,
  WEKRUIT_VOICE_PRESCREEN_TURN_URL: process.env.WEKRUIT_VOICE_PRESCREEN_TURN_URL,
  WEKRUIT_VOICE_ONBOARDING_TURN_URL: process.env.WEKRUIT_VOICE_ONBOARDING_TURN_URL,
  PA_VOICE_CF_SECRET: process.env.PA_VOICE_CF_SECRET,
}

function restoreEnv() {
  for (const [k, v] of Object.entries(ORIGINAL_ENV)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
}

function prescreenContext(): VoiceCallContext {
  return {
    bookingId: "b1",
    purpose: "prescreen",
    prescreenSessionId: "ps1",
    userProfile: { userId: "u1", missingFields: [] },
    jobBrief: { jobId: "j1", jobTitle: "T", companyName: "C", missingFields: [] },
    prescreenConfig: {
      jobId: "j1",
      version: 1,
      jobTitle: "T",
      threshold: 0.65,
      confidenceThreshold: 0.7,
      maxClarifyRounds: 2,
      voiceMode: "professional_prescreen",
      questions: [],
      parsedFromZod: true,
      missingFields: [],
    },
  }
}

function onboardingContext(): VoiceCallContext {
  return {
    bookingId: "b-onboard",
    purpose: "onboarding",
    userProfile: { userId: "u1", missingFields: [] },
  }
}

test("defaultLoadContext throws when WEKRUIT_VOICE_CONTEXT_URL not set", async () => {
  delete process.env.WEKRUIT_VOICE_CONTEXT_URL
  await assert.rejects(() => defaultLoadContext("b1"), /WEKRUIT_VOICE_CONTEXT_URL not set/)
  restoreEnv()
})

test("waitForRemoteParticipant resolves immediately when a SIP participant is already in the room", async () => {
  const room = {
    remoteParticipants: new Map([
      ["candidate-u1", { identity: "candidate-u1" }],
    ]),
    on() {
      throw new Error("should not subscribe when participant is already present")
    },
    off() {},
  }

  const participant = await waitForRemoteParticipant(room)
  assert.equal(participant?.identity, "candidate-u1")
})

test("waitForRemoteParticipant waits for LiveKit participantConnected before Claire speaks", async () => {
  let listener: ((participant: { identity: string }) => void) | null = null
  const room = {
    remoteParticipants: new Map(),
    on(event: string, cb: (participant: { identity: string }) => void) {
      assert.equal(event, "participantConnected")
      listener = cb
    },
    off(event: string, cb: (participant: { identity: string }) => void) {
      assert.equal(event, "participantConnected")
      assert.equal(cb, listener)
    },
  }

  const pending = waitForRemoteParticipant(room, { timeoutMs: 1_000 })
  assert.equal(typeof listener, "function")
  listener?.({ identity: "candidate-u1" })

  const participant = await pending
  assert.equal(participant?.identity, "candidate-u1")
})

test("defaultLoadContext POSTs bookingId + secret header to context CF", async () => {
  process.env.WEKRUIT_VOICE_CONTEXT_URL = "https://example.test/paVoiceCallContext"
  process.env.PA_VOICE_CF_SECRET = "shh"
  const fixture = {
    bookingId: "b1",
    purpose: "prescreen",
    prescreenSessionId: "ps1",
    userProfile: { userId: "u1", missingFields: [] },
    jobBrief: { jobId: "j1", jobTitle: "T", companyName: "C", missingFields: [] },
    prescreenConfig: {
      jobId: "j1",
      version: 1,
      jobTitle: "T",
      threshold: 0.65,
      confidenceThreshold: 0.7,
      maxClarifyRounds: 2,
      voiceMode: "professional_prescreen" as const,
      questions: [],
      parsedFromZod: true as const,
      missingFields: [],
    },
  }
  const fake = installFakeFetch(async () => new Response(JSON.stringify(fixture), { status: 200 }))
  try {
    const ctx = await defaultLoadContext("b1")
    assert.equal(fake.calls.length, 1)
    assert.equal(fake.calls[0]!.url, "https://example.test/paVoiceCallContext")
    const init = fake.calls[0]!.init!
    assert.equal(init.method, "POST")
    const headers = init.headers as Record<string, string>
    assert.equal(headers["X-Wekruit-Voice-CF-Secret"], "shh")
    const body = JSON.parse(String(init.body))
    assert.equal(body.bookingId, "b1")
    assert.equal(ctx.bookingId, "b1")
    assert.equal(ctx.purpose, "prescreen")
    if (ctx.purpose !== "prescreen") throw new Error("expected prescreen context")
    assert.equal(ctx.prescreenSessionId, "ps1")
    assert.equal(ctx.userProfile.userId, "u1")
    assert.equal(ctx.jobBrief.jobId, "j1")
  } finally {
    fake.restore()
    restoreEnv()
  }
})

test("defaultLoadContext throws on non-2xx response", async () => {
  process.env.WEKRUIT_VOICE_CONTEXT_URL = "https://example.test/paVoiceCallContext"
  const fake = installFakeFetch(async () => new Response("nope", { status: 500 }))
  try {
    await assert.rejects(() => defaultLoadContext("b1"), /paVoiceCallContext 500/)
  } finally {
    fake.restore()
    restoreEnv()
  }
})

test("defaultLoadContext accepts onboarding context without job fields", async () => {
  process.env.WEKRUIT_VOICE_CONTEXT_URL = "https://example.test/paVoiceCallContext"
  const fake = installFakeFetch(async () =>
    new Response(
      JSON.stringify({
        bookingId: "b-onboard",
        purpose: "onboarding",
        userProfile: { userId: "u1", missingFields: [] },
      }),
      { status: 200 },
    ),
  )
  try {
    const ctx = await defaultLoadContext("b-onboard")
    assert.equal(ctx.purpose, "onboarding")
    assert.equal(ctx.bookingId, "b-onboard")
    assert.equal(ctx.userProfile.userId, "u1")
  } finally {
    fake.restore()
    restoreEnv()
  }
})

test("defaultBuildPipeline throws when WEKRUIT_VOICE_PRESCREEN_TURN_URL not set", async () => {
  delete process.env.WEKRUIT_VOICE_PRESCREEN_TURN_URL
  await assert.rejects(() => defaultBuildPipeline(prescreenContext()), /WEKRUIT_VOICE_PRESCREEN_TURN_URL not set/)
  restoreEnv()
})

test("defaultBuildPipeline.runTurn POSTs the turn input + secret header", async () => {
  process.env.WEKRUIT_VOICE_PRESCREEN_TURN_URL = "https://example.test/paVoicePrescreenTurn"
  process.env.PA_VOICE_CF_SECRET = "shh"
  const fake = installFakeFetch(
    async () =>
      new Response(
        JSON.stringify({
          ok: true,
          lifecycleKind: "active_turn",
          text: "What systems did it touch?",
          action: { kind: "clarify", qId: "q1", kAfter: 1 },
        }),
        { status: 200 },
      ),
  )
  try {
    const pipeline = await defaultBuildPipeline(prescreenContext())
    const out = await pipeline.runTurn({
      sessionId: "ps1",
      reply: "I built it",
      lang: "en",
      nowIso: "2026-05-16T00:00:00Z",
      judgeCtx: { userId: "u1", turnId: "t1" },
    })
    assert.equal(fake.calls.length, 1)
    const body = JSON.parse(String(fake.calls[0]!.init!.body))
    assert.equal(body.bookingId, "b1")
    assert.equal(body.sessionId, "ps1")
    assert.equal(body.userId, "u1")
    assert.equal(body.reply, "I built it")
    assert.equal(body.lang, "en")
    assert.equal(body.nowIso, "2026-05-16T00:00:00Z")
    const headers = fake.calls[0]!.init!.headers as Record<string, string>
    assert.equal(headers["X-Wekruit-Voice-CF-Secret"], "shh")
    assert.equal(out.text, "What systems did it touch?")
    assert.equal(out.action.kind, "clarify")
  } finally {
    fake.restore()
    restoreEnv()
  }
})

test("defaultBuildPipeline.runTurn maps null text to empty string", async () => {
  process.env.WEKRUIT_VOICE_PRESCREEN_TURN_URL = "https://example.test/paVoicePrescreenTurn"
  const fake = installFakeFetch(
    async () =>
      new Response(
        JSON.stringify({
          ok: true,
          lifecycleKind: "recent_terminal_guard",
          text: null,
          action: { kind: "recent_terminal_guard" },
        }),
        { status: 200 },
      ),
  )
  try {
    const pipeline = await defaultBuildPipeline(prescreenContext())
    const out = await pipeline.runTurn({
      sessionId: "b1",
      reply: "still here",
      lang: "en",
      nowIso: "t",
      judgeCtx: { userId: "u1", turnId: "t1" },
    })
    assert.equal(out.text, "")
  } finally {
    fake.restore()
    restoreEnv()
  }
})

test("defaultBuildPipeline.runTurn throws on 5xx", async () => {
  process.env.WEKRUIT_VOICE_PRESCREEN_TURN_URL = "https://example.test/paVoicePrescreenTurn"
  const fake = installFakeFetch(async () => new Response("oops", { status: 502 }))
  try {
    const pipeline = await defaultBuildPipeline(prescreenContext())
    await assert.rejects(
      () =>
        pipeline.runTurn({
          sessionId: "b1",
          reply: "x",
          lang: "en",
          nowIso: "t",
          judgeCtx: { userId: "u1", turnId: "t1" },
        }),
      /paVoicePrescreenTurn 502/,
    )
  } finally {
    fake.restore()
    restoreEnv()
  }
})

test("defaultLoadContext omits secret header when PA_VOICE_CF_SECRET unset", async () => {
  process.env.WEKRUIT_VOICE_CONTEXT_URL = "https://example.test/paVoiceCallContext"
  delete process.env.PA_VOICE_CF_SECRET
  const fixture = {
    bookingId: "b1",
    purpose: "prescreen",
    prescreenSessionId: "ps1",
    userProfile: { userId: "u1", missingFields: [] },
    jobBrief: { jobId: "j1", jobTitle: "T", companyName: "C", missingFields: [] },
    prescreenConfig: {
      jobId: "j1",
      version: 1,
      jobTitle: "T",
      threshold: 0.65,
      confidenceThreshold: 0.7,
      maxClarifyRounds: 2,
      voiceMode: "professional_prescreen" as const,
      questions: [],
      parsedFromZod: true as const,
      missingFields: [],
    },
  }
  const fake = installFakeFetch(async () => new Response(JSON.stringify(fixture), { status: 200 }))
  try {
    await defaultLoadContext("b1")
    const headers = fake.calls[0]!.init!.headers as Record<string, string>
    assert.equal("X-Wekruit-Voice-CF-Secret" in headers, false)
  } finally {
    fake.restore()
    restoreEnv()
  }
})

test("defaultBuildPipeline routes onboarding context to onboarding callable", async () => {
  process.env.WEKRUIT_VOICE_ONBOARDING_TURN_URL = "https://example.test/paVoiceOnboardingTurn"
  process.env.PA_VOICE_CF_SECRET = "shh"
  const fake = installFakeFetch(
    async () =>
      new Response(
        JSON.stringify({
          ok: true,
          lifecycleKind: "onboarding_turn",
          text: "What kind of role are you looking for?",
          action: { kind: "advance", currentQId: "q_role" },
        }),
        { status: 200 },
      ),
  )
  try {
    const pipeline = await defaultBuildPipeline(onboardingContext())
    const out = await pipeline.runTurn({
      sessionId: "b-onboard",
      reply: "hi",
      lang: "en",
      nowIso: "2026-05-16T00:00:00Z",
      judgeCtx: { userId: "u1", turnId: "t1" },
    })
    assert.equal(fake.calls[0]!.url, "https://example.test/paVoiceOnboardingTurn")
    const body = JSON.parse(String(fake.calls[0]!.init!.body))
    assert.equal(body.bookingId, "b-onboard")
    assert.equal(body.sessionId, "b-onboard")
    assert.equal(out.action.kind, "advance")
  } finally {
    fake.restore()
    restoreEnv()
  }
})
