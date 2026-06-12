import test from "node:test"
import assert from "node:assert/strict"

import { ACTIVE_PRESCREEN_TIMEOUT_MS, InMemorySessionFinder } from "../session-finder.js"
import { InMemoryTurnRecorder } from "../turn-recorder.js"
import { InMemoryPreScreenStore, emptyPreScreenState } from "../state.js"
import type { KeywordSetLlmCaller, KeywordSetLlmOutput } from "../../onboarding/judges/keyword-set.js"
import type { PrescreenConfig } from "../config.js"
import {
  expiredSessionText,
  isUserExitPrescreenReply,
  prescreenTurnRecordQId,
  recentTerminalSessionText,
  runPrescreenTurn,
  userExitSessionText,
  type PrescreenChannelTextHint,
  type PrescreenRunnerDeps,
} from "../runner.js"

/* ────────────────────────────────────────────────────────────────────────── */
/* Fixtures                                                                   */
/* ────────────────────────────────────────────────────────────────────────── */

function makeConfig(): PrescreenConfig {
  return {
    version: 1,
    jobTitle: "Test Role",
    company: "TestCo",
    threshold: 0.65,
    confidenceThreshold: 0.7,
    maxClarifyRounds: 2,
    voiceMode: "professional_prescreen",
    questions: [
      {
        qId: "q1",
        type: "MUST_HAVE",
        weight: 1,
        prompt: { zh: "Describe your q1 experience", en: "Describe your q1 experience" },
        clarifyPrompt: { zh: "Be more specific (q1)", en: "Be more specific (q1)" },
        keywords: [{ keyword: "q1", weight: 1 }],
      },
    ],
  }
}

function makeLlmCaller(seq: KeywordSetLlmOutput[]): KeywordSetLlmCaller {
  let i = 0
  return {
    async score() {
      const out = seq[Math.min(i, seq.length - 1)]!
      i++
      return out
    },
  }
}

const passingScore: KeywordSetLlmOutput = {
  perKeyword: [{ keyword: "q1", match: 1.0, confidence: 0.9, evidence: "yes", reasoning: "matches" }],
}

const weakScore: KeywordSetLlmOutput = {
  perKeyword: [{ keyword: "q1", match: 0.3, confidence: 0.95, evidence: "x", reasoning: "weak" }],
}

function makeDeps(opts?: {
  llmSeq?: KeywordSetLlmOutput[]
  hint?: PrescreenChannelTextHint
  composeClarify?: PrescreenRunnerDeps["composeClarify"]
}) {
  const finder = new InMemorySessionFinder()
  const recorder = new InMemoryTurnRecorder()
  const store = new InMemoryPreScreenStore()
  const cfg = makeConfig()
  const deps: PrescreenRunnerDeps = {
    store,
    sessionFinder: finder,
    cfgLoader: async (_sid) => cfg,
    llmCaller: makeLlmCaller(opts?.llmSeq ?? [passingScore]),
    composeClarify:
      opts?.composeClarify ?? (async ({ question, lang }) => `clarify-${question.qId}-${lang}`),
    turnRecorder: recorder,
    ...(opts?.hint ? { channelTextHint: opts.hint } : {}),
  }
  return { finder, recorder, store, cfg, deps }
}

async function setupActiveSession(
  finder: InMemorySessionFinder,
  store: InMemoryPreScreenStore,
  cfg: PrescreenConfig,
  nowMs: number,
) {
  const sessionId = "s1"
  const state = emptyPreScreenState({
    sessionId,
    userId: "u1",
    jobId: "j1",
    questions: cfg.questions.map((q) => ({ qId: q.qId, type: q.type, weight: q.weight })),
    threshold: cfg.threshold,
    confidenceThreshold: cfg.confidenceThreshold,
    maxClarifyRounds: cfg.maxClarifyRounds,
    nowIso: new Date(nowMs - 60_000).toISOString(),
  })
  await store.save(state)
  finder.add({
    sessionId,
    userId: "u1",
    jobId: "j1",
    terminal: null,
    currentQId: state.currentQId,
    updatedAtMs: nowMs - 60_000,
  })
  return sessionId
}

/* ────────────────────────────────────────────────────────────────────────── */
/* user-exit predicate                                                        */
/* ────────────────────────────────────────────────────────────────────────── */

test("isUserExitPrescreenReply matches stop variants", () => {
  for (const r of ["stop", "STOP", "pause", "cancel", "  pause  ", "not now"]) {
    assert.equal(isUserExitPrescreenReply(r), true, `expected match: ${r}`)
  }
})

test("isUserExitPrescreenReply rejects non-exit replies", () => {
  for (const r of ["", "yes I built it", "stopwatch", "i paused for a sec"]) {
    assert.equal(isUserExitPrescreenReply(r), false, `expected no match: ${r}`)
  }
})

test("prescreenTurnRecordQId returns active qId for terminal action", () => {
  const id = prescreenTurnRecordQId({ kind: "terminal", terminal: "PASS", reason: "x" }, "qActive")
  assert.equal(id, "qActive")
})

test("prescreenTurnRecordQId returns clarify.qId for clarify action", () => {
  const id = prescreenTurnRecordQId({ kind: "clarify", qId: "qFoo", kAfter: 1 }, "qActive")
  assert.equal(id, "qFoo")
})

test("prescreenTurnRecordQId returns advance.fromQId for advance action", () => {
  const id = prescreenTurnRecordQId({ kind: "advance", fromQId: "qFrom", toQId: "qTo" }, "qActive")
  assert.equal(id, "qFrom")
})

test("copy is English-only regardless of lang: expired", () => {
  assert.equal(expiredSessionText("zh"), expiredSessionText("en"))
  assert.match(expiredSessionText("en"), /reply "restart screen"/)
})

test("copy is English-only regardless of lang: user-exit + recent-terminal", () => {
  assert.equal(userExitSessionText("zh"), userExitSessionText("en"))
  assert.equal(recentTerminalSessionText("zh"), recentTerminalSessionText("en"))
})

/* ────────────────────────────────────────────────────────────────────────── */
/* Lifecycle: no_active_session                                               */
/* ────────────────────────────────────────────────────────────────────────── */

test("runPrescreenTurn → no_active_session when finder returns none", async () => {
  const { deps } = makeDeps()
  const res = await runPrescreenTurn(
    { userId: "u1", reply: "hi", lang: "en", nowIso: "t", channel: "sms" },
    deps,
  )
  assert.equal(res.lifecycle.kind, "no_active_session")
  assert.equal(res.text, null)
  assert.equal(res.persisted, false)
})

/* ────────────────────────────────────────────────────────────────────────── */
/* Lifecycle: recent_terminal_guard                                           */
/* ────────────────────────────────────────────────────────────────────────── */

test("runPrescreenTurn → recent_terminal_guard not-acked emits text + ack write", async () => {
  const { finder, recorder, deps } = makeDeps()
  const now = Date.now()
  finder.add({
    sessionId: "s_passed",
    userId: "u1",
    jobId: "j1",
    terminal: "PASS",
    currentQId: null,
    updatedAtMs: now - 10 * 60 * 1000,
    endedAtMs: now - 10 * 60 * 1000,
    workSessionKind: "job_prescreen",
  })
  const res = await runPrescreenTurn(
    { userId: "u1", reply: "hi", lang: "en", nowIso: "t", channel: "sms", now: () => now },
    deps,
  )
  assert.equal(res.lifecycle.kind, "recent_terminal_guard")
  assert.ok(res.text)
  assert.match(res.text!, /role screen is done/i)
  assert.equal(recorder.getAck("s_passed"), "t")
  const recs = recorder.getRecords("s_passed")
  assert.equal(recs.length, 1)
  assert.equal(recs[0]!.action.kind, "post_terminal_followup")
})

test("runPrescreenTurn → recent_terminal_guard already-acked returns text=null", async () => {
  const { finder, recorder, deps } = makeDeps()
  const now = Date.now()
  finder.add({
    sessionId: "s_acked",
    userId: "u1",
    jobId: "j1",
    terminal: "FAIL",
    currentQId: null,
    updatedAtMs: now - 5 * 60 * 1000,
    endedAtMs: now - 5 * 60 * 1000,
    workSessionKind: "job_prescreen",
    postTerminalFollowupAckAt: new Date(now - 4 * 60 * 1000).toISOString(),
  })
  const res = await runPrescreenTurn(
    { userId: "u1", reply: "still here", lang: "en", nowIso: "t", channel: "sms", now: () => now },
    deps,
  )
  assert.equal(res.lifecycle.kind, "recent_terminal_guard")
  assert.equal(res.text, null)
  // ack stamp was NOT overwritten because we don't call mark when already acked
  assert.equal(recorder.getAck("s_acked"), undefined)
  // turn record still written (observability)
  assert.equal(recorder.getRecords("s_acked").length, 1)
})

/* ────────────────────────────────────────────────────────────────────────── */
/* Lifecycle: session_expired                                                 */
/* ────────────────────────────────────────────────────────────────────────── */

test("runPrescreenTurn → session_expired returns text + PAUSE terminalAction", async () => {
  const { finder, deps } = makeDeps()
  const now = Date.now()
  finder.add({
    sessionId: "s_old",
    userId: "u1",
    jobId: "j1",
    terminal: null,
    currentQId: "q1",
    updatedAtMs: now - ACTIVE_PRESCREEN_TIMEOUT_MS - 1000,
  })
  const res = await runPrescreenTurn(
    { userId: "u1", reply: "hi", lang: "en", nowIso: "t", channel: "sms", now: () => now },
    deps,
  )
  assert.equal(res.lifecycle.kind, "session_expired")
  assert.ok(res.text)
  assert.equal(res.terminalAction?.terminal, "PAUSE")
  assert.equal(res.terminalAction?.reason, "expired_inactive_prescreen_session")
})

/* ────────────────────────────────────────────────────────────────────────── */
/* Lifecycle: user_exit                                                       */
/* ────────────────────────────────────────────────────────────────────────── */

test("runPrescreenTurn → user_exit ('stop') flips state to PAUSE + records terminal turn", async () => {
  const { finder, recorder, store, cfg, deps } = makeDeps()
  const now = Date.now()
  const sessionId = await setupActiveSession(finder, store, cfg, now)
  const res = await runPrescreenTurn(
    { userId: "u1", reply: "stop", lang: "en", nowIso: "t", channel: "sms", now: () => now },
    deps,
  )
  assert.equal(res.lifecycle.kind, "user_exit")
  assert.equal(res.terminalAction?.terminal, "PAUSE")
  assert.equal(res.terminalAction?.reason, "user_exit")
  const state = await store.load(sessionId)
  assert.equal(state?.terminal, "PAUSE")
  assert.equal(state?.terminalReason, "user_exit")
  assert.equal(state?.currentQId, null)
  const recs = recorder.getRecords(sessionId)
  assert.equal(recs[0]!.action.kind, "terminal")
})

/* ────────────────────────────────────────────────────────────────────────── */
/* Lifecycle: stale_terminal                                                  */
/* ────────────────────────────────────────────────────────────────────────── */

test("runPrescreenTurn → stale_terminal when state.terminal already set", async () => {
  const { finder, store, cfg, deps } = makeDeps()
  const now = Date.now()
  const sessionId = await setupActiveSession(finder, store, cfg, now)
  const state = await store.load(sessionId)
  await store.save({ ...state!, terminal: "PASS", currentQId: null })
  const res = await runPrescreenTurn(
    { userId: "u1", reply: "hi", lang: "en", nowIso: "t", channel: "sms", now: () => now },
    deps,
  )
  assert.equal(res.lifecycle.kind, "stale_terminal")
  if (res.lifecycle.kind === "stale_terminal") {
    assert.equal(res.lifecycle.terminal, "PASS")
  }
  assert.equal(res.text, null)
  assert.equal(res.persisted, false)
})

test("runPrescreenTurn → cfgLoader null treats session as no_active_session", async () => {
  const { finder, store, cfg, deps } = makeDeps()
  const now = Date.now()
  await setupActiveSession(finder, store, cfg, now)
  const stubDeps: PrescreenRunnerDeps = { ...deps, cfgLoader: async () => null }
  const res = await runPrescreenTurn(
    { userId: "u1", reply: "hi", lang: "en", nowIso: "t", channel: "sms", now: () => now },
    stubDeps,
  )
  assert.equal(res.lifecycle.kind, "no_active_session")
})

/* ────────────────────────────────────────────────────────────────────────── */
/* Lifecycle: active_turn — pipeline outcomes                                 */
/* ────────────────────────────────────────────────────────────────────────── */

test("runPrescreenTurn → active_turn terminal PASS emits text + PASS terminalAction", async () => {
  const { finder, recorder, store, cfg, deps } = makeDeps({ llmSeq: [passingScore] })
  const now = Date.now()
  const sessionId = await setupActiveSession(finder, store, cfg, now)
  const res = await runPrescreenTurn(
    { userId: "u1", reply: "yes I built q1", lang: "en", nowIso: "t", channel: "sms", now: () => now },
    deps,
  )
  assert.equal(res.lifecycle.kind, "active_turn")
  assert.equal(res.terminalAction?.terminal, "PASS")
  assert.ok(res.text)
  const recs = recorder.getRecords(sessionId)
  assert.equal(recs[0]!.action.kind, "terminal")
})

test("runPrescreenTurn → active_turn clarify emits text + NO terminalAction", async () => {
  const { finder, recorder, store, cfg, deps } = makeDeps({
    llmSeq: [{ ...weakScore, perKeyword: [{ ...weakScore.perKeyword[0]!, confidence: 0.2 }] }],
  })
  const now = Date.now()
  const sessionId = await setupActiveSession(finder, store, cfg, now)
  const res = await runPrescreenTurn(
    { userId: "u1", reply: "kinda", lang: "en", nowIso: "t", channel: "sms", now: () => now },
    deps,
  )
  assert.equal(res.lifecycle.kind, "active_turn")
  assert.equal(res.terminalAction, undefined)
  assert.equal(recorder.getRecords(sessionId)[0]!.action.kind, "clarify")
})

test("runPrescreenTurn → active_turn turn record carries scored snapshot when present", async () => {
  const { finder, recorder, store, cfg, deps } = makeDeps({ llmSeq: [passingScore] })
  const now = Date.now()
  const sessionId = await setupActiveSession(finder, store, cfg, now)
  await runPrescreenTurn(
    { userId: "u1", reply: "yes", lang: "en", nowIso: "t", channel: "sms", now: () => now },
    deps,
  )
  const rec = recorder.getRecords(sessionId)[0]!
  assert.ok(rec.scored, "expected scored snapshot")
})

/* ────────────────────────────────────────────────────────────────────────── */
/* Channel text hint                                                          */
/* ────────────────────────────────────────────────────────────────────────── */

test("runPrescreenTurn → channelTextHint applied to active_turn text", async () => {
  const { finder, store, cfg, deps } = makeDeps({
    llmSeq: [passingScore],
    hint: ({ text, channel }) => `[${channel}] ${text}`,
  })
  const now = Date.now()
  await setupActiveSession(finder, store, cfg, now)
  const res = await runPrescreenTurn(
    { userId: "u1", reply: "yes", lang: "en", nowIso: "t", channel: "voice", now: () => now },
    deps,
  )
  assert.ok(res.text)
  assert.match(res.text!, /^\[voice\] /)
})

test("runPrescreenTurn → channelTextHint not invoked when pipeline text empty", async () => {
  const { finder, store, cfg, deps } = makeDeps({
    llmSeq: [passingScore],
    hint: () => "SHOULD-NOT-APPEAR",
  })
  const now = Date.now()
  // Force stale terminal so pipeline never produces text.
  await setupActiveSession(finder, store, cfg, now)
  const state = await store.load("s1")
  await store.save({ ...state!, terminal: "PASS", currentQId: null })
  const res = await runPrescreenTurn(
    { userId: "u1", reply: "hi", lang: "en", nowIso: "t", channel: "voice", now: () => now },
    deps,
  )
  assert.equal(res.text, null)
})

test("runPrescreenTurn → channelTextHint differs SMS vs voice", async () => {
  const hint: PrescreenChannelTextHint = ({ text, channel }) =>
    channel === "sms" ? `<sms>${text}` : `<voice>${text}`
  const sms = makeDeps({ llmSeq: [passingScore], hint })
  const voice = makeDeps({ llmSeq: [passingScore], hint })
  const now = Date.now()
  await setupActiveSession(sms.finder, sms.store, sms.cfg, now)
  await setupActiveSession(voice.finder, voice.store, voice.cfg, now)
  const a = await runPrescreenTurn(
    { userId: "u1", reply: "yes", lang: "en", nowIso: "t", channel: "sms", now: () => now },
    sms.deps,
  )
  const b = await runPrescreenTurn(
    { userId: "u1", reply: "yes", lang: "en", nowIso: "t", channel: "voice", now: () => now },
    voice.deps,
  )
  assert.notEqual(a.text, b.text)
  assert.match(a.text!, /^<sms>/)
  assert.match(b.text!, /^<voice>/)
})

/* ────────────────────────────────────────────────────────────────────────── */
/* Voice path: ctx.sessionId short-circuit                                    */
/* ────────────────────────────────────────────────────────────────────────── */

test("runPrescreenTurn → voice ctx.sessionId skips findForUser via loadById", async () => {
  const { finder, store, cfg, deps } = makeDeps({ llmSeq: [passingScore] })
  const now = Date.now()
  const sessionId = await setupActiveSession(finder, store, cfg, now)
  // Sanity — the active session has a fresh updatedAtMs so findForUser would also pick it.
  const res = await runPrescreenTurn(
    { sessionId, userId: "u1", reply: "yes", lang: "en", nowIso: "t", channel: "voice", now: () => now },
    deps,
  )
  assert.equal(res.lifecycle.kind, "active_turn")
})

test("runPrescreenTurn → voice ctx.sessionId on terminal-already → recent_terminal_guard", async () => {
  const { finder, store, cfg, deps } = makeDeps()
  const now = Date.now()
  const sessionId = await setupActiveSession(finder, store, cfg, now)
  finder.update(sessionId, { terminal: "PASS", currentQId: null, endedAtMs: now - 1000 })
  const res = await runPrescreenTurn(
    { sessionId, userId: "u1", reply: "hi", lang: "en", nowIso: "t", channel: "voice", now: () => now },
    deps,
  )
  assert.equal(res.lifecycle.kind, "recent_terminal_guard")
})

test("runPrescreenTurn → voice ctx.sessionId missing → no_active_session", async () => {
  const { deps } = makeDeps()
  const res = await runPrescreenTurn(
    { sessionId: "ghost", userId: "u1", reply: "hi", lang: "en", nowIso: "t", channel: "voice" },
    deps,
  )
  assert.equal(res.lifecycle.kind, "no_active_session")
})

/* ────────────────────────────────────────────────────────────────────────── */
/* Logging                                                                    */
/* ────────────────────────────────────────────────────────────────────────── */

test("runPrescreenTurn → emits prescreen.runner.* log event per branch", async () => {
  const { finder, store, cfg, deps } = makeDeps({ llmSeq: [passingScore] })
  const now = Date.now()
  await setupActiveSession(finder, store, cfg, now)
  const events: string[] = []
  await runPrescreenTurn(
    {
      userId: "u1",
      reply: "yes",
      lang: "en",
      nowIso: "t",
      channel: "sms",
      now: () => now,
      log: (event) => events.push(event),
    },
    deps,
  )
  assert.ok(events.some((e) => e === "prescreen.runner.active_turn"))
})

test("runPrescreenTurn → active_turn cross-channel parity (same input → same lifecycle kind)", async () => {
  // The promise of the refactor: SMS and voice produce identical lifecycle
  // + identical pipeline state, even though channel hint may diff text.
  const sms = makeDeps({ llmSeq: [passingScore] })
  const voice = makeDeps({ llmSeq: [passingScore] })
  const now = Date.now()
  await setupActiveSession(sms.finder, sms.store, sms.cfg, now)
  await setupActiveSession(voice.finder, voice.store, voice.cfg, now)
  const a = await runPrescreenTurn(
    { userId: "u1", reply: "yes", lang: "en", nowIso: "t", channel: "sms", now: () => now },
    sms.deps,
  )
  const b = await runPrescreenTurn(
    { userId: "u1", reply: "yes", lang: "en", nowIso: "t", channel: "voice", now: () => now },
    voice.deps,
  )
  assert.equal(a.lifecycle.kind, b.lifecycle.kind)
  assert.equal(a.terminalAction?.terminal, b.terminalAction?.terminal)
  if (a.lifecycle.kind === "active_turn" && b.lifecycle.kind === "active_turn") {
    assert.equal(
      a.lifecycle.pipelineResult.state.terminal,
      b.lifecycle.pipelineResult.state.terminal,
    )
    assert.equal(
      a.lifecycle.pipelineResult.state.score,
      b.lifecycle.pipelineResult.state.score,
    )
    assert.equal(
      a.lifecycle.pipelineResult.action.kind,
      b.lifecycle.pipelineResult.action.kind,
    )
  }
})
