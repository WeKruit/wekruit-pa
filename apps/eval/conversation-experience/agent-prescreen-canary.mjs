#!/usr/bin/env node
/**
 * P3 scoped-prescreen-agent canary — real-LLM gate for the prescreen migration.
 * ════════════════════════════════════════════════════════════════════════════
 *
 * Proves (per AGENTIC-ARCHITECTURE.md §5/§0) that a SCOPED prescreen agent can run
 * the interview while the deterministic REDUCER stays the controller:
 *   - the LLM is given the pending question + scoped tools; it ROUTES the
 *     candidate's reply to `record_prescreen_answer` (which delegates to the real
 *     PreScreenPipeline.runTurn — the reducer scores + advances + may terminate);
 *   - the LLM has NO tool to set currentQId / terminal / skip qOrder, so by
 *     construction it cannot skip a question or declare the interview done;
 *   - a TANGENT (off-topic reply) is routed to the GLOBAL `explain_prescreen_context`
 *     tool (no FSM mutation) → the pending question is HELD (not advanced).
 *
 * Scenario A: on-question reply → agent calls record_prescreen_answer → reducer
 *             advances Q1→Q2 (reducer-controlled).
 * Scenario B: tangent reply → agent calls explain (not record) → currentQId held.
 *
 * Exit 0 = green (gate satisfied for the live runPrescreenTurnIfActive injection).
 */
import { createRequire } from "node:module"
import { pathToFileURL } from "node:url"
import { repoRootFrom, loadDotEnv, importDist } from "./harness-lib.mjs"

const REPO_ROOT = repoRootFrom(import.meta.url)
const MODEL = process.env.PA_AGENT_MODEL?.trim() || "gpt-5.4-nano"
const NOW = "2026-05-28T00:00:00.000Z"

function stubJudge(score) {
  return { kind: "stub-scored", async judgeScored() { return { kind: "scored", answered: true, perKeyword: [], aggregate: { s: score.s, c: score.c, summary: "stub" } } } }
}

async function main() {
  loadDotEnv(REPO_ROOT)
  const apiKey = (process.env.PA_OPENAI_AGENT_API_KEY ?? process.env.OPENAI_API_KEY ?? "").trim()
  if (!apiKey.startsWith("sk-")) { console.error("SETUP ERROR: no OpenAI key"); process.exit(2) }

  let state, pipeline, sdk, OpenAI
  try {
    state = await importDist(REPO_ROOT, "packages/pa-orchestrator/dist/prescreen/state.js")
    pipeline = await importDist(REPO_ROOT, "packages/pa-orchestrator/dist/prescreen/pipeline.js")
    const req = createRequire(`${REPO_ROOT}/packages/agent-runtime/package.json`)
    sdk = req("@openai/agents"); OpenAI = req("openai").default ?? req("openai")
  } catch (e) { console.error(`SETUP ERROR: ${e?.message ?? e}`); process.exit(2) }

  sdk.setDefaultOpenAIClient(new OpenAI({ apiKey, baseURL: process.env.PA_OPENAI_AGENT_BASE_URL?.trim() || "https://api.openai.com/v1" }))
  sdk.setOpenAIAPI("responses"); sdk.setDefaultOpenAIKey(apiKey)

  const { emptyPreScreenState, InMemoryPreScreenStore } = state
  const { PreScreenPipeline } = pipeline
  const SESSION = "ps_canary"
  const qcfg = [{ qId: "q_experience", type: "PROBING", weight: 1 }, { qId: "q_motivation", type: "PROBING", weight: 1 }]
  const store = new InMemoryPreScreenStore()
  await store.save(emptyPreScreenState({ sessionId: SESSION, userId: "u", jobId: "j", questions: qcfg, threshold: 0.6, nowIso: NOW }))
  const questions = {}
  for (const q of qcfg) questions[q.qId] = { qId: q.qId, prompt: { zh: q.qId, en: q.qId }, clarifyPrompt: { zh: "?", en: "?" }, judge: stubJudge({ s: 0.95, c: 0.95 }) }
  const ps = new PreScreenPipeline({ questions, store, log: () => {} })

  const fails = []
  let recordCalls = 0, explainCalls = 0
  let turnIdx = 0
  const tools = [
    sdk.tool({
      name: "record_prescreen_answer",
      description: "Submit the candidate's reply AS THE ANSWER to the current pre-screen question. The pre-screen reducer scores it and advances to the next question (or ends). Call this ONLY when the candidate actually answered the current question.",
      parameters: { type: "object", properties: { reply: { type: "string" } }, required: ["reply"], additionalProperties: false },
      strict: false,
      execute: async (a) => { recordCalls++; const r = await ps.runTurn({ sessionId: SESSION, reply: String(a?.reply ?? "answer"), lang: "en", nowIso: new Date(Date.parse(NOW) + (++turnIdx) * 1000).toISOString(), judgeCtx: { userId: "u", turnId: `t${turnIdx}` } }); return JSON.stringify({ action: r.action.kind }) },
    }),
    sdk.tool({
      name: "explain_prescreen_context",
      description: "Answer an OFF-TOPIC / tangent question from the candidate (e.g. about a past interview, the company, or anything that is NOT an answer to the current pre-screen question). This does NOT advance the interview.",
      parameters: { type: "object", properties: { topic: { type: "string" } }, required: ["topic"], additionalProperties: false },
      strict: false,
      execute: async () => { explainCalls++; return JSON.stringify({ answered: true, note: "tangent answered; pending question unchanged" }) },
    }),
  ]
  const instr = "You are Claire conducting a job pre-screen. The current question is: 'Tell me about your relevant experience.' If the user's message ANSWERS that question, call record_prescreen_answer with their reply. If it is off-topic (a tangent), call explain_prescreen_context, then you would re-ask. Never skip the question."
  const agent = new sdk.Agent({ name: "Claire-prescreen", instructions: instr, model: MODEL, modelSettings: { toolChoice: "auto" }, tools })

  // Scenario A: on-question answer → record → reducer advances
  const before = (await store.load(SESSION)).currentQId
  await sdk.run(agent, "Sure — I spent 3 years as a backend engineer at Stripe building payments APIs.")
  const afterA = await store.load(SESSION)
  if (recordCalls < 1) fails.push("Scenario A: agent did NOT call record_prescreen_answer for an on-question reply")
  if (afterA.currentQId === before && !afterA.terminal) fails.push(`Scenario A: reducer did not advance from '${before}' (currentQId still '${afterA.currentQId}')`)
  console.log(`A: record=${recordCalls} currentQId ${before} -> ${afterA.currentQId} terminal=${afterA.terminal}`)

  // Scenario B: tangent → explain (no record) → pending held
  const recBeforeB = recordCalls
  const qidBeforeB = afterA.currentQId
  await sdk.run(agent, "wait, actually — can you tell me why I didn't pass the Rain interview last month?")
  const afterB = await store.load(SESSION)
  if (recordCalls > recBeforeB) fails.push("Scenario B: agent called record_prescreen_answer on a TANGENT (should hold the pending question, not record/advance)")
  if (afterB.currentQId !== qidBeforeB) fails.push(`Scenario B: pending question NOT held across tangent ('${qidBeforeB}' -> '${afterB.currentQId}')`)
  console.log(`B: explain=${explainCalls} record(unchanged)=${recordCalls === recBeforeB} pending held=${afterB.currentQId === qidBeforeB}`)

  if (fails.length) { console.error("\nP3 PRESCREEN CANARY FAILED:"); for (const f of fails) console.error(`  - ${f}`); process.exit(1) }
  console.log("\nP3 PRESCREEN CANARY GREEN ✓ — scoped agent routes answers to the reducer (which advances) and tangents to the global tool (pending held); the LLM has no skip/terminal tool, so the reducer stays the controller.")
}
main().catch((e) => { console.error("canary crashed:", e); process.exit(2) })
