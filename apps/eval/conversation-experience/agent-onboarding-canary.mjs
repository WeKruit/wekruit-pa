#!/usr/bin/env node
/**
 * P4 scoped-onboarding-agent canary — real-LLM gate for the onboarding migration.
 * ════════════════════════════════════════════════════════════════════════════
 *
 * Mirrors the P3 prescreen canary for shared-onboarding (AGENTIC-ARCHITECTURE.md
 * §1/§5). Proves a SCOPED onboarding agent runs the slot flow while the
 * deterministic reducer (the pure SHARED_ONBOARDING_QUESTIONS order +
 * resolveNextSharedOnboardingQuestionId + projectSharedOnboardingAnswer) stays the
 * controller:
 *   - the LLM asks the current slot naturally + ROUTES the reply to a scoped
 *     `record_onboarding_answer` tool that projects the answer (durable tags) and
 *     advances the slot via resolveNext (reducer-controlled — no slot skip);
 *   - the LLM has NO tool to set currentQuestionId / skip slots / complete;
 *   - a TANGENT routes to a global `explain_context` tool → slot HELD (no advance).
 *
 * Scenario A: on-slot answer → record → slot advances main_goal→culture_stage +
 *             durable tags/memoryFact projected.
 * Scenario B: tangent → explain (no record) → slot held.
 *
 * Exit 0 = green (gate for the live shared-onboarding handler injection).
 */
import { createRequire } from "node:module"
import { pathToFileURL } from "node:url"
import { repoRootFrom, loadDotEnv, importDist } from "./harness-lib.mjs"

const REPO_ROOT = repoRootFrom(import.meta.url)
const MODEL = process.env.PA_AGENT_MODEL?.trim() || "gpt-5.4-nano"

async function main() {
  loadDotEnv(REPO_ROOT)
  const apiKey = (process.env.PA_OPENAI_AGENT_API_KEY ?? process.env.OPENAI_API_KEY ?? "").trim()
  if (!apiKey.startsWith("sk-")) { console.error("SETUP ERROR: no OpenAI key"); process.exit(2) }

  let ob, sdk, OpenAI
  try {
    ob = await importDist(REPO_ROOT, "packages/pa-orchestrator/dist/shared-onboarding.js")
    const req = createRequire(`${REPO_ROOT}/packages/agent-runtime/package.json`)
    sdk = req("@openai/agents"); OpenAI = req("openai").default ?? req("openai")
  } catch (e) { console.error(`SETUP ERROR: ${e?.message ?? e}`); process.exit(2) }

  sdk.setDefaultOpenAIClient(new OpenAI({ apiKey, baseURL: process.env.PA_OPENAI_AGENT_BASE_URL?.trim() || "https://api.openai.com/v1" }))
  sdk.setOpenAIAPI("responses"); sdk.setDefaultOpenAIKey(apiKey)

  const { SHARED_ONBOARDING_QUESTIONS, resolveNextSharedOnboardingQuestionId, projectSharedOnboardingAnswer } = ob
  const order = SHARED_ONBOARDING_QUESTIONS.map((q) => q.id)

  // reducer-owned slot state; the LLM can only move it via record_onboarding_answer
  const slot = { current: order[0], tags: {}, lastMemoryFact: null }
  let recordCalls = 0, explainCalls = 0
  const tools = [
    sdk.tool({
      name: "record_onboarding_answer",
      description: "Submit the candidate's reply AS THE ANSWER to the current onboarding question. The reducer projects it into durable profile tags and advances to the next slot. Call ONLY when the candidate actually answered the current question.",
      parameters: { type: "object", properties: { reply: { type: "string" } }, required: ["reply"], additionalProperties: false },
      strict: false,
      execute: async (a) => {
        recordCalls++
        const proj = projectSharedOnboardingAnswer(slot.current, String(a?.reply ?? ""))
        slot.tags = { ...slot.tags, ...(proj.tags ?? {}) }
        slot.lastMemoryFact = proj.memoryFact ?? null
        const nx = resolveNextSharedOnboardingQuestionId(slot.current) // reducer advances
        slot.current = nx.completed ? "__complete__" : nx.nextQuestionId
        return JSON.stringify({ advancedTo: slot.current })
      },
    }),
    sdk.tool({
      name: "explain_context",
      description: "Answer an OFF-TOPIC / tangent question from the candidate (NOT an answer to the current onboarding question). Does NOT advance onboarding.",
      parameters: { type: "object", properties: { topic: { type: "string" } }, required: ["topic"], additionalProperties: false },
      strict: false,
      execute: async () => { explainCalls++; return JSON.stringify({ answered: true, note: "tangent; slot unchanged" }) },
    }),
  ]
  const instr = "You are Claire onboarding a new candidate. The current question is: 'What's your main goal in your job search right now?' If the user's message ANSWERS that, call record_onboarding_answer with their reply. If it's off-topic (a tangent), call explain_context. Never skip the question."
  const agent = new sdk.Agent({ name: "Claire-onboarding", instructions: instr, model: MODEL, modelSettings: { toolChoice: "auto" }, tools })

  const fails = []

  // Scenario A: on-slot answer → record → reducer advances
  const before = slot.current
  await sdk.run(agent, "Honestly I want to move into senior product management roles at an AI startup, ideally remote.")
  if (recordCalls < 1) fails.push("Scenario A: agent did NOT call record_onboarding_answer for an on-question reply")
  if (slot.current === before) fails.push(`Scenario A: reducer did not advance the slot from '${before}'`)
  const projectedTags = Object.keys(slot.tags).length > 0 || typeof slot.lastMemoryFact === "string"
  if (!projectedTags) fails.push("Scenario A: no durable projection (tags/memoryFact) captured")
  console.log(`A: record=${recordCalls} slot ${before} -> ${slot.current}; projected keys=${Object.keys(slot.tags).join(",") || "(memoryFact only)"}`)

  // Scenario B: tangent → explain (no record) → slot held
  const recB = recordCalls, slotB = slot.current
  await sdk.run(agent, "wait — is WeKruit going to share my info with recruiters I haven't approved?")
  if (recordCalls > recB) fails.push("Scenario B: agent called record_onboarding_answer on a TANGENT (slot should be held)")
  if (slot.current !== slotB) fails.push(`Scenario B: slot NOT held across tangent ('${slotB}' -> '${slot.current}')`)
  console.log(`B: explain=${explainCalls} record(unchanged)=${recordCalls === recB} slot held=${slot.current === slotB}`)

  if (fails.length) { console.error("\nP4 ONBOARDING CANARY FAILED:"); for (const f of fails) console.error(`  - ${f}`); process.exit(1) }
  console.log("\nP4 ONBOARDING CANARY GREEN ✓ — scoped agent routes answers to the reducer (which advances the slot + projects durable tags) and tangents to the global tool (slot held); the LLM has no skip/complete tool, so the reducer stays the controller.")
}
main().catch((e) => { console.error("canary crashed:", e); process.exit(2) })
