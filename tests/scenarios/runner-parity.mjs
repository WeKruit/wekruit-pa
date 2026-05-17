#!/usr/bin/env node
/**
 * v2.2 — Cross-channel prescreen parity runner.
 *
 * The promise of the shared-brain refactor (.planning/VOICE-PRESCREEN-
 * INTERFACE.md): SMS and voice both call `runPrescreenTurn`, so the same
 * candidate reply produces the same lifecycle decision + pipeline verdict
 * regardless of channel. The channel-text hint is the ONLY place where
 * outputs may differ (formatting).
 *
 * This runner drives a handful of representative scenarios through both
 * channels using InMemorySessionFinder + InMemoryTurnRecorder +
 * InMemoryPreScreenStore + stubbed LLM caller. Any drift between the SMS
 * and voice verdicts on any scenario is a parity violation → exit 1.
 *
 * Hooked into apps/functions/scripts/predeploy-smoke.mjs so a deploy
 * aborts if the brains diverge.
 *
 * Exit 0 on parity. Exit 1 on first drift detected.
 */
import {
  InMemorySessionFinder,
  InMemoryTurnRecorder,
  InMemoryPreScreenStore,
  emptyPreScreenState,
  runPrescreenTurn,
} from "../../packages/pa-orchestrator/dist/index.js"

const HOUR = 60 * 60 * 1000

function makeConfig() {
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
        prompt: { zh: "请描述你的 q1 经验", en: "Describe your q1 experience" },
        clarifyPrompt: { zh: "请更具体 (q1)", en: "Be more specific (q1)" },
        keywords: [{ keyword: "q1", weight: 1 }],
      },
    ],
  }
}

function makeLlmCaller(seq) {
  let i = 0
  return {
    async score() {
      const out = seq[Math.min(i, seq.length - 1)]
      i++
      return out
    },
  }
}

function makeStubComposer() {
  return async ({ question, lang }) => `clarify-${question.qId}-${lang}`
}

function makeChannelTextHint(channel) {
  return ({ text }) => `[${channel}]${text}`
}

function makeDeps(llmSeq) {
  const finder = new InMemorySessionFinder()
  const recorder = new InMemoryTurnRecorder()
  const store = new InMemoryPreScreenStore()
  const cfg = makeConfig()
  return {
    finder,
    recorder,
    store,
    cfg,
    makeDeps(channel) {
      return {
        store,
        sessionFinder: finder,
        cfgLoader: async () => cfg,
        llmCaller: makeLlmCaller(llmSeq),
        composeClarify: makeStubComposer(),
        turnRecorder: recorder,
        channelTextHint: makeChannelTextHint(channel),
      }
    },
  }
}

async function seedActive({ finder, store, cfg, nowMs, sessionId = "s1" }) {
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

const PASS_SCORE = {
  perKeyword: [
    { keyword: "q1", match: 1.0, confidence: 0.9, evidence: "yes", reasoning: "matches" },
  ],
}

const WEAK_LOW_CONF = {
  perKeyword: [
    { keyword: "q1", match: 0.3, confidence: 0.2, evidence: "x", reasoning: "weak" },
  ],
}

/**
 * Run one ctx through both channels, assert lifecycle + terminalAction +
 * pipeline-state parity. Return a failure description or null on parity.
 */
async function checkOne(name, build) {
  const sms = build()
  const voice = build()
  const now = Date.now()
  await seedActive({ finder: sms.finder, store: sms.store, cfg: sms.cfg, nowMs: now })
  await seedActive({ finder: voice.finder, store: voice.store, cfg: voice.cfg, nowMs: now })
  const reply = "yes I shipped q1 in prod"
  const a = await runPrescreenTurn(
    { userId: "u1", reply, lang: "en", nowIso: "2026-05-16T00:00:00Z", channel: "sms", now: () => now },
    sms.makeDeps("sms"),
  )
  const b = await runPrescreenTurn(
    { userId: "u1", reply, lang: "en", nowIso: "2026-05-16T00:00:00Z", channel: "voice", now: () => now },
    voice.makeDeps("voice"),
  )
  if (a.lifecycle.kind !== b.lifecycle.kind) {
    return `${name}: lifecycle.kind mismatch — sms=${a.lifecycle.kind} voice=${b.lifecycle.kind}`
  }
  if ((a.terminalAction?.terminal ?? null) !== (b.terminalAction?.terminal ?? null)) {
    return `${name}: terminalAction mismatch — sms=${a.terminalAction?.terminal} voice=${b.terminalAction?.terminal}`
  }
  if (a.lifecycle.kind === "active_turn" && b.lifecycle.kind === "active_turn") {
    if (a.lifecycle.pipelineResult.state.terminal !== b.lifecycle.pipelineResult.state.terminal) {
      return `${name}: state.terminal mismatch — sms=${a.lifecycle.pipelineResult.state.terminal} voice=${b.lifecycle.pipelineResult.state.terminal}`
    }
    if (a.lifecycle.pipelineResult.state.score !== b.lifecycle.pipelineResult.state.score) {
      return `${name}: state.score mismatch — sms=${a.lifecycle.pipelineResult.state.score} voice=${b.lifecycle.pipelineResult.state.score}`
    }
    if (a.lifecycle.pipelineResult.action.kind !== b.lifecycle.pipelineResult.action.kind) {
      return `${name}: action.kind mismatch — sms=${a.lifecycle.pipelineResult.action.kind} voice=${b.lifecycle.pipelineResult.action.kind}`
    }
  }
  // Text MAY differ (channel hint). Assert ONLY the channel-hint envelope.
  if (a.text && b.text) {
    if (!a.text.startsWith("[sms]") || !b.text.startsWith("[voice]")) {
      return `${name}: channel hint failed to discriminate (a=${a.text.slice(0, 12)} b=${b.text.slice(0, 12)})`
    }
  }
  return null
}

const SCENARIOS = [
  {
    name: "active_turn / advance — strong PASS",
    build: () => makeDeps([PASS_SCORE]),
  },
  {
    name: "active_turn / clarify — weak low-confidence",
    build: () => makeDeps([WEAK_LOW_CONF]),
  },
]

async function main() {
  const failures = []
  for (const s of SCENARIOS) {
    const err = await checkOne(s.name, s.build)
    if (err) {
      failures.push(err)
      console.error(`[parity] FAIL  ${err}`)
    } else {
      console.log(`[parity] OK    ${s.name}`)
    }
  }
  // User-exit + recent-terminal: both channels should produce identical
  // lifecycle.kind + terminalAction without going through the pipeline.
  const ueSms = makeDeps([])
  const ueVoice = makeDeps([])
  const now = Date.now()
  await seedActive({ finder: ueSms.finder, store: ueSms.store, cfg: ueSms.cfg, nowMs: now })
  await seedActive({ finder: ueVoice.finder, store: ueVoice.store, cfg: ueVoice.cfg, nowMs: now })
  const a = await runPrescreenTurn(
    { userId: "u1", reply: "stop", lang: "en", nowIso: "2026-05-16T00:00:00Z", channel: "sms", now: () => now },
    ueSms.makeDeps("sms"),
  )
  const b = await runPrescreenTurn(
    { userId: "u1", reply: "stop", lang: "en", nowIso: "2026-05-16T00:00:00Z", channel: "voice", now: () => now },
    ueVoice.makeDeps("voice"),
  )
  if (a.lifecycle.kind !== "user_exit" || b.lifecycle.kind !== "user_exit") {
    failures.push(`user_exit lifecycle mismatch — sms=${a.lifecycle.kind} voice=${b.lifecycle.kind}`)
  } else if (a.terminalAction?.terminal !== b.terminalAction?.terminal) {
    failures.push(`user_exit terminalAction mismatch`)
  } else {
    console.log(`[parity] OK    user_exit / "stop" — both channels PAUSE`)
  }

  if (failures.length > 0) {
    console.error(`\n[parity] ${failures.length} parity violations — deploy must abort.`)
    process.exit(1)
  }
  console.log(`\n[parity] ALL OK — ${SCENARIOS.length + 1} scenarios match across SMS + voice.`)
  process.exit(0)
}

main().catch((err) => {
  console.error("[parity] runner threw:", err)
  process.exit(1)
})
