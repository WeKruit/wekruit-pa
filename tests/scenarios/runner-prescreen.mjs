#!/usr/bin/env node
/**
 * v1.8 Phase 80 — Pre-screen E2E runner.
 *
 * Drives `PreScreenPipeline.runTurn` against a YAML scenario:
 *   1. Load YAML (config + reply turns + expected terminal/score)
 *   2. Spin up InMemoryPreScreenStore + PreScreenPipeline
 *   3. Build PreScreenQuestion bindings using a per-turn STUB LLM caller
 *      (the YAML provides the canned LLM output per Q to keep the test
 *      deterministic — no live network calls)
 *   4. Replay each reply through pipeline.runTurn
 *   5. Assert final state.terminal, state.score, state.scoreMax,
 *      terminalReason contains, optional terminalCauseAt[qId].cause
 *
 * Usage:
 *   node tests/scenarios/runner-prescreen.mjs tests/scenarios/prescreen/pass.yaml
 *   node tests/scenarios/runner-prescreen.mjs tests/scenarios/prescreen/    # whole dir
 *
 * Exits 0 only when actual matches expected.
 */
import { readFile, readdir, stat } from "node:fs/promises"
import { resolve, join } from "node:path"
import { parse as parseYaml } from "yaml"

import { PreScreenPipeline } from "../../packages/pa-orchestrator/dist/prescreen/pipeline.js"
import {
  InMemoryPreScreenStore,
  emptyPreScreenState,
} from "../../packages/pa-orchestrator/dist/prescreen/state.js"
import { KeywordSetJudge } from "../../packages/pa-orchestrator/dist/onboarding/judges/keyword-set.js"
import {
  parsePrescreenConfig,
  configToStateQuestions,
} from "../../packages/pa-orchestrator/dist/prescreen/config.js"

const argv = process.argv.slice(2)
if (argv.length === 0) {
  console.error("usage: runner-prescreen.mjs <scenario.yaml | scenarios-dir>")
  process.exit(2)
}

async function loadScenarioPaths(target) {
  const s = await stat(target)
  if (s.isDirectory()) {
    const entries = await readdir(target)
    return entries
      .filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"))
      .map((f) => join(target, f))
      .sort()
  }
  return [target]
}

/**
 * Build a stub LLM caller that returns the canned per-Q output indexed by
 * the question id. Each turn in the YAML names which qId's stub to use.
 * The PreScreenPipeline currently calls `judge.judgeScored(reply)` and
 * the caller knows the question by KeywordSetJudge.spec.questionId — so
 * we close over that id when constructing.
 */
function makeStubCaller(qId, stubsByQId) {
  return {
    async score() {
      const stub = stubsByQId[qId]
      if (!stub) {
        throw new Error(`no LLM stub provided for qId=${qId}`)
      }
      return stub
    },
  }
}

function buildPipeline(scenario) {
  const cfg = parsePrescreenConfig(scenario.config)
  const store = new InMemoryPreScreenStore()
  // Build PreScreenQuestion map. Stub callers are keyed per qId so
  // every call for that Q returns the same canned output (the runner's
  // per-turn assertion still works because each Q is asked once unless
  // clarify rounds are scripted into the scenario stub).
  const stubsByQId = {}
  for (const turn of scenario.turns) {
    for (const [qId, stub] of Object.entries(turn.stub ?? {})) {
      stubsByQId[qId] = stub
    }
  }
  const questions = {}
  for (const q of cfg.questions) {
    questions[q.qId] = {
      qId: q.qId,
      prompt: q.prompt,
      clarifyPrompt: q.clarifyPrompt,
      judge: new KeywordSetJudge({
        questionId: q.qId,
        keywords: q.keywords,
        llmCaller: makeStubCaller(q.qId, stubsByQId),
      }),
    }
  }
  const pipeline = new PreScreenPipeline({ questions, store })
  return { pipeline, store, cfg }
}

async function runScenario(path) {
  const raw = await readFile(path, "utf8")
  const scenario = parseYaml(raw)
  const { pipeline, store, cfg } = buildPipeline(scenario)

  // Seed state.
  await store.save(
    emptyPreScreenState({
      sessionId: scenario.sessionId,
      userId: scenario.userId,
      jobId: scenario.jobId,
      questions: configToStateQuestions(cfg),
      threshold: cfg.threshold,
      confidenceThreshold: cfg.confidenceThreshold,
      maxClarifyRounds: cfg.maxClarifyRounds,
      nowIso: new Date().toISOString(),
    })
  )

  const results = []
  for (let i = 0; i < scenario.turns.length; i++) {
    const turn = scenario.turns[i]
    const r = await pipeline.runTurn({
      sessionId: scenario.sessionId,
      reply: turn.reply,
      lang: scenario.lang ?? "en",
      nowIso: new Date(Date.now() + i * 1000).toISOString(),
      judgeCtx: { userId: scenario.userId, turnId: `t_${i}` },
    })
    results.push({ turn: i, action: r.action })
    if (r.action.kind === "terminal") break
  }

  const finalState = await store.load(scenario.sessionId)
  if (!finalState) {
    return { ok: false, path, reason: "final state not found in store" }
  }

  const exp = scenario.expected
  const errors = []
  if (exp.terminal && finalState.terminal !== exp.terminal) {
    errors.push(`terminal: expected ${exp.terminal}, got ${finalState.terminal}`)
  }
  if (typeof exp.score === "number" && Math.abs(finalState.score - exp.score) > 0.01) {
    errors.push(`score: expected ${exp.score}, got ${finalState.score}`)
  }
  if (typeof exp.scoreMax === "number" && Math.abs(finalState.scoreMax - exp.scoreMax) > 0.01) {
    errors.push(`scoreMax: expected ${exp.scoreMax}, got ${finalState.scoreMax}`)
  }
  if (exp.reasonContains && !(finalState.terminalReason ?? "").includes(exp.reasonContains)) {
    errors.push(
      `terminalReason: expected to contain "${exp.reasonContains}", got "${finalState.terminalReason}"`
    )
  }
  if (exp.terminalCauseAt) {
    const qState = finalState.questions[exp.terminalCauseAt.qId]
    if (!qState) {
      errors.push(`terminalCauseAt.qId=${exp.terminalCauseAt.qId} not found in state.questions`)
    } else if (qState.terminalCause !== exp.terminalCauseAt.cause) {
      errors.push(
        `terminalCauseAt: expected ${exp.terminalCauseAt.cause}, got ${qState.terminalCause}`
      )
    }
  }
  return {
    ok: errors.length === 0,
    path,
    name: scenario.name,
    finalTerminal: finalState.terminal,
    finalScore: finalState.score,
    finalScoreMax: finalState.scoreMax,
    finalReason: finalState.terminalReason,
    actions: results,
    errors,
  }
}

let allOk = true
for (const target of argv) {
  const paths = await loadScenarioPaths(resolve(target))
  for (const p of paths) {
    const result = await runScenario(p)
    if (result.ok) {
      console.log(`✓ ${result.path}  →  ${result.finalTerminal}  score=${result.finalScore}/${result.finalScoreMax}`)
    } else {
      allOk = false
      console.error(`✗ ${result.path}  (${result.name})`)
      console.error(`    actual terminal: ${result.finalTerminal}`)
      console.error(`    actual score: ${result.finalScore}/${result.finalScoreMax}`)
      console.error(`    actual reason: ${result.finalReason}`)
      console.error(`    actions:`, result.actions)
      for (const e of result.errors) {
        console.error(`    - ${e}`)
      }
    }
  }
}

process.exit(allOk ? 0 : 1)
