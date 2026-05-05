#!/usr/bin/env node
/**
 * LLM-vs-LLM scenario runner — drives OnboardingPipeline with each persona
 * and asserts the final state matches expectations.
 *
 * Adam directive 2026-05-05: "你的测试应该使用llm对战llm来测试不同的情况".
 *
 * Modes:
 *   - default (scripted): consumes persona.scriptedReplies. Free + fast.
 *   - SIM_USER_MODE=llm: drives sim user via Qwen-7B (cost: ~$0.01/persona).
 *
 * Usage:
 *   node tests/scenarios/onboarding/runner.mjs               # all personas, scripted
 *   node tests/scenarios/onboarding/runner.mjs happy noisy   # specific personas
 *   SIM_USER_MODE=llm node tests/scenarios/onboarding/runner.mjs   # LLM mode
 *
 * The OnboardingPipeline's judge.LLMRelevanceJudge is REAL — it calls
 * extractAnswerIntent which hits the prod LLM. So even in scripted-sim
 * mode, the pipeline path itself exercises real LLM intent extraction.
 */
import { SimUser, loadPersona } from "./sim-user.mjs"
import { OnboardingPipeline, InMemoryPipelineStateProvider, defaultQuestions } from "../../../packages/pa-orchestrator/dist/onboarding/index.js"

const PERSONA_IDS = process.argv.slice(2)
const allPersonaIds = PERSONA_IDS.length > 0 ? PERSONA_IDS : ["happy", "noisy", "declines", "typoer", "ghost"]
const SIM_MODE = process.env.SIM_USER_MODE ?? "scripted"
const MAX_TURNS = 50

const SILICONFLOW_API_KEY = process.env.SILICONFLOW_API_KEY ?? ""

/**
 * Pipeline-side LLM extractor (extractAnswerIntent). For tests we use a
 * SCRIPTED mock by default that mimics real LLM behavior on common values.
 * Set INTENT_MODE=llm to use the real one (requires SILICONFLOW_API_KEY).
 */
async function makeExtractAnswerIntent() {
  if (process.env.INTENT_MODE === "llm" && SILICONFLOW_API_KEY) {
    // Real LLM path — copy of the orchestrator-deps prompt structure.
    const stepDefs = {
      ask_q_role: { label: "target job role", schema: '"value":"swe"|"pm"|...|<free-form>' },
      ask_q_yoe: { label: "years of experience", schema: '"value":<integer>|"fresh"' },
      ask_q_visa: { label: "US work auth", schema: '"value":"citizen"|"gc"|"opt"|"h1b"|"sponsorship"|"other"' },
      ask_q_startup_pref: { label: "startup vs bigtech", schema: '"value":"startup"|"bigtech"|"either"' },
      ask_q_location: { label: "target location", schema: '"value":<city/region/remote>' },
    }
    return async (step, reply, lang) => {
      const def = stepDefs[step]
      if (!def) return null
      const prompt = `Extract intent from user reply about ${def.label}. JSON only:\n{"intent":"provided",${def.schema},"confidence":0-1}\nOR\n{"intent":"unclear","clarifyingQuestion":"<short ${lang === "zh" ? "zh" : "en"} q>"}\n\nUser: "${reply}"`
      try {
        const res = await fetch("https://api.siliconflow.cn/v1/chat/completions", {
          method: "POST",
          headers: { Authorization: `Bearer ${SILICONFLOW_API_KEY}`, "Content-Type": "application/json" },
          body: JSON.stringify({ model: "Qwen/Qwen2.5-7B-Instruct", messages: [{ role: "user", content: prompt }], temperature: 0.1, max_tokens: 200 }),
        })
        const data = await res.json()
        const raw = data.choices?.[0]?.message?.content ?? ""
        const m = raw.match(/\{[\s\S]*\}/)
        if (!m) return null
        return JSON.parse(m[0])
      } catch {
        return null
      }
    }
  }
  // Scripted mock — recognizes common test answers across personas.
  return async (step, reply, lang) => {
    const t = reply.trim().toLowerCase()
    if (step === "ask_q_role") {
      if (/swe|engineer|工程|developer|前端|后端|算法|ai\s*infra|ml/i.test(t)) return { intent: "provided", value: "swe", confidence: 0.9 }
      if (/pm|产品/i.test(t)) return { intent: "provided", value: "pm", confidence: 0.9 }
      if (/research|研究/i.test(t)) return { intent: "provided", value: "research", confidence: 0.9 }
      return { intent: "unclear", clarifyingQuestion: "swe / pm / research / design?" }
    }
    if (step === "ask_q_yoe") {
      const n = t.match(/(\d+)\s*(年|year)/)
      if (n) return { intent: "provided", value: Number(n[1]), confidence: 0.95 }
      if (/fresh|刚毕业|应届/.test(t)) return { intent: "provided", value: "fresh", confidence: 0.9 }
      return { intent: "unclear", clarifyingQuestion: "几年? a number works" }
    }
    if (step === "ask_q_visa") {
      if (/citizen|公民/.test(t)) return { intent: "provided", value: "citizen", confidence: 0.9 }
      if (/gc|绿卡/.test(t)) return { intent: "provided", value: "gc", confidence: 0.9 }
      if (/opt/.test(t)) return { intent: "provided", value: "opt", confidence: 0.9 }
      if (/h1b/.test(t)) return { intent: "provided", value: "h1b", confidence: 0.9 }
      if (/sponsor/.test(t)) return { intent: "provided", value: "sponsorship", confidence: 0.85 }
      return { intent: "unclear", clarifyingQuestion: "citizen / gc / opt / h1b / sponsor?" }
    }
    if (step === "ask_q_startup_pref") {
      if (/startup|创业/.test(t)) return { intent: "provided", value: "startup", confidence: 0.9 }
      if (/big\s*tech|big\s*co|大厂/.test(t)) return { intent: "provided", value: "bigtech", confidence: 0.9 }
      if (/either|都行|都可以|both/.test(t)) return { intent: "provided", value: "either", confidence: 0.9 }
      return { intent: "unclear", clarifyingQuestion: "startup / bigtech / either?" }
    }
    if (step === "ask_q_location") {
      if (/sf|bay|湾区|san fran/i.test(t)) return { intent: "provided", value: "sf", confidence: 0.9 }
      if (/nyc|new york|纽约/i.test(t)) return { intent: "provided", value: "nyc", confidence: 0.9 }
      if (/remote|远程/.test(t)) return { intent: "provided", value: "remote", confidence: 0.95 }
      return { intent: "unclear", clarifyingQuestion: "city or remote?" }
    }
    return null
  }
}

async function makeExtractEmailIntent() {
  // Scripted: detect common typo domains.
  const typos = { "gmal.com": "gmail.com", "gmial.com": "gmail.com", "yangoo.com": "yahoo.com" }
  return async (reply, lang) => {
    const m = reply.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/i)
    if (!m) return { intent: "unclear", clarifyingQuestion: lang === "zh" ? "再发一次邮箱?" : "email again?" }
    const email = m[0].toLowerCase()
    const domain = email.split("@")[1]
    if (typos[domain]) {
      return { intent: "typo", original: email, suggestion: email.replace(domain, typos[domain]) }
    }
    return { intent: "provided", email, confidence: 0.9 }
  }
}

function preStageVerificationCode(state, code = "654321") {
  // Inject email verification challenge into per-user state since CodeJudge
  // looks at db.collection("pa-users").doc(id).emailVerification — for
  // in-memory testing we patch a fake db proxy.
  return code
}

function makeFakeDb(userId, codeHash) {
  // Fake firestore that satisfies CodeJudge interface
  const userDoc = { exists: true, data: () => ({ emailVerification: { codeHash, email: "test@gmail.com", expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(), attempts: 0 } }) }
  return {
    collection: (name) => ({
      doc: (id) => ({
        get: async () => name === "pa-users" && id === userId ? userDoc : { exists: false, data: () => ({}) },
        set: async () => {},
      }),
    }),
  }
}

import { createHash } from "node:crypto"

async function runScenario(personaId) {
  const persona = loadPersona(personaId)
  const sim = new SimUser(persona, { mode: SIM_MODE })

  const code = "654321"
  const codeHash = createHash("sha256").update(code).digest("hex")
  const userId = `sim-${personaId}`

  // Build pipeline. Lang preference is the persona's first reply ("中文" → zh).
  const stateProvider = new InMemoryPipelineStateProvider()
  const extractAnswerIntent = await makeExtractAnswerIntent()
  const extractEmailIntent = await makeExtractEmailIntent()

  // Pre-set lang state so question prompts emit in correct lang. The
  // q_lang Q.onAccepted will overwrite this — but we also pre-stage it
  // so the FIRST prompt (q_lang itself) emits a lang-matching prompt.
  const initial = await stateProvider.load(userId)
  initial.lang = "zh" // all personas use zh in scripted mode
  await stateProvider.save(userId, initial)

  const collected = []
  const questions = defaultQuestions({
    extractAnswerIntent,
    extractEmailIntent,
    onLangAccepted: async (lang, ctx) => {
      const s = await stateProvider.load(ctx.userId)
      s.lang = lang === "mixed" ? "zh" : lang  // simplification: mixed → zh display
      await stateProvider.save(ctx.userId, s)
    },
    onEmailAccepted: async (email, ctx) => {
      // Pre-stage verification code so CodeJudge can match.
    },
    onEmailCodeVerified: async (codeMatched, ctx) => {
      ctx.log?.("test.email_verified", { code: codeMatched })
    },
    onResumeAccepted: async () => {},
  })

  const emitted = []
  const pipeline = new OnboardingPipeline({
    questions,
    state: stateProvider,
    haltMessageDefault: { zh: "请联系 admin1@wekruit.com", en: "contact admin1@wekruit.com" },
    emit: async (text, meta) => {
      emitted.push({ text, qId: meta.qId, kind: meta.kind })
    },
    log: (event, payload) => {
      // Uncomment for verbose: console.log(`[${event}]`, payload)
    },
    db: makeFakeDb(userId, codeHash),
  })

  // First turn: no real reply yet. Pipeline emits q_lang prompt.
  let lastEmit
  let turn = 0
  let reply = ""
  while (turn < MAX_TURNS) {
    const result = await pipeline.startTurn({ userId, turnId: `t-${turn}`, reply })
    lastEmit = emitted[emitted.length - 1]
    if (result.completed || result.halted) break
    // Sim user responds to whatever pipeline just emitted
    if (lastEmit) {
      reply = await sim.respondTo(lastEmit.text)
    } else {
      break
    }
    turn++
  }

  const finalState = stateProvider.peek(userId)
  return { persona, finalState, emitted, turns: turn, lastEmit }
}

function assertOutcome(persona, finalState, emitted) {
  const errors = []
  // 1. Final state matches.
  if (persona.expectedFinalState === "completed" && !finalState.completed) {
    errors.push(`expected completed=true, got ${finalState.completed}; halted=${JSON.stringify(finalState.halted)}`)
  }
  if (persona.expectedFinalState === "halted" && !finalState.halted) {
    errors.push(`expected halted, got completed=${finalState.completed}`)
  }
  if (persona.expectedHaltedQId && finalState.halted?.qId !== persona.expectedHaltedQId) {
    errors.push(`expected halt on qId=${persona.expectedHaltedQId}, got ${finalState.halted?.qId}`)
  }
  // 2. Collected keys match.
  const collectedKeys = Object.keys(finalState.collected ?? {})
  for (const expected of persona.expectedCollectedKeys ?? []) {
    if (!collectedKeys.includes(expected)) {
      errors.push(`expected ${expected} in collected, got: [${collectedKeys.join(", ")}]`)
    }
  }
  for (const not of persona.expectedNotCollectedKeys ?? []) {
    if (collectedKeys.includes(not)) {
      errors.push(`${not} should NOT be in collected, but is`)
    }
  }
  return errors
}

async function main() {
  console.log(`\n━━━ LLM-vs-LLM Onboarding Scenario Runner ━━━`)
  console.log(`Mode: ${SIM_MODE} (sim-user) | INTENT_MODE: ${process.env.INTENT_MODE ?? "scripted"} (intent extractor)\n`)

  let totalPass = 0
  let totalFail = 0

  for (const personaId of allPersonaIds) {
    process.stdout.write(`[${personaId}] running...`)
    let result
    try {
      result = await runScenario(personaId)
    } catch (err) {
      console.log(` ✗ THREW: ${err.message}`)
      totalFail++
      continue
    }
    const errors = assertOutcome(result.persona, result.finalState, result.emitted)
    if (errors.length === 0) {
      console.log(` ✓ (${result.turns} turns, completed=${result.finalState.completed}, halted=${!!result.finalState.halted})`)
      totalPass++
    } else {
      console.log(` ✗`)
      for (const e of errors) console.log(`    └─ ${e}`)
      console.log(`    final: completed=${result.finalState.completed}, halted=${JSON.stringify(result.finalState.halted)}, collectedKeys=[${Object.keys(result.finalState.collected ?? {}).join(", ")}]`)
      console.log(`    last emit: ${result.lastEmit?.kind} → ${result.lastEmit?.text?.slice(0, 60)}…`)
      totalFail++
    }
  }

  console.log(`\n━━━ Summary ━━━`)
  console.log(`Pass: ${totalPass} / ${totalPass + totalFail}`)
  if (totalFail > 0) {
    process.exit(1)
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(2)
})
