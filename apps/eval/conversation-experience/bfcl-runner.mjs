#!/usr/bin/env node
/**
 * BFCL-style conversation-quality eval — real LLM, ADVISORY (never blocks CI).
 * ══════════════════════════════════════════════════════════════════════════
 *
 * Per .planning/AGENTIC-ARCHITECTURE.md §9, BFCL (Berkeley Function Calling
 * Leaderboard) is the reference for the conversation layer because it scores
 * **irrelevance/abstention** (knowing when NOT to call a tool) as a first-class
 * metric. Our old regex router is a poor abstention detector; this eval measures
 * whether the real model + tool descriptions is a BETTER one — the receipt that
 * justifies deleting the regex routers in P1+.
 *
 * It runs the REAL @openai/agents loop (the same SDK packages/agent-runtime
 * wraps) with the REAL connector registry as the tool surface, and a recorder
 * `execute` that captures the chosen tool {name, args} without hitting Firestore.
 *
 * Metrics (all ADVISORY — this runner exits 0 even on misses; it prints a
 * scorecard that flags follow-ups; the deterministic gate is process-intact):
 *   • tool-choice  — does the model pick the right connector? (AST {name} + optional args subset)
 *   • abstention   — when the correct action is NO tool call, does it abstain?
 *   • delivery     — tapback vs text vs no-reply classification.
 *
 * Setup: real key PA_OPENAI_AGENT_API_KEY / OPENAI_API_KEY in .env, built dist.
 * Costs a few cents per fixture. Run:  node apps/eval/conversation-experience/bfcl-runner.mjs
 */
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { createRequire } from "node:module"
import { repoRootFrom, loadDotEnv, loadJsonFixtures, importDist } from "./harness-lib.mjs"

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = repoRootFrom(import.meta.url)
const MODEL = process.env.PA_AGENT_MODEL?.trim() || "gpt-5.4-nano"

// Claire triage-mode tool surface for the baseline. Mirrors the connectors a
// job-search/triage turn would expose (buildTurnTools maps allowedConnectors →
// tools the same way). Keep these to names present in connectorRegistry.
const TRIAGE_ALLOWLIST = ["find-match", "set-matching-preferences", "set-daily-job-recommendation-subscription", "remember-fact", "save-job-profile", "schedule-interview"]

const SYSTEM_PROMPT = [
  "You are Claire, a warm, concise job-search companion who texts like a friend.",
  "You have tools. Call a tool ONLY when the user is actually asking for the thing that tool does",
  "(finding/recommending jobs, persisting a durable matching preference/constraint, managing a daily-recs subscription, saving a fact).",
  "For casual conversation, emotional support, small talk, or meta questions about you, DO NOT call any tool — just reply in text.",
  "When unsure whether a tool is warranted, prefer NOT calling one.",
].join(" ")

function loadAgentsSdk() {
  // @openai/agents + openai are deps of packages/agent-runtime, not apps/eval.
  const req = createRequire(join(REPO_ROOT, "packages", "agent-runtime", "package.json"))
  const sdk = req("@openai/agents")
  const OpenAI = req("openai").default ?? req("openai")
  return { sdk, OpenAI }
}

function loadZod() {
  const req = createRequire(join(REPO_ROOT, "packages", "pa-connectors", "package.json"))
  return req("zod")
}

// @openai/agents-core REQUIRES strict mode for Zod params, but the connector
// inputSchemas have optional fields → strict 400s. Convert Zod→JSON-schema and
// pass it non-strict so we can measure routing with the real param surface.
function toNonStrictJsonSchema(z, zodSchema) {
  try {
    const js = z.toJSONSchema(zodSchema, { target: "draft-2020-12" })
    delete js.$schema
    return js
  } catch {
    return { type: "object", properties: {}, additionalProperties: true }
  }
}

function configureClient(sdk, OpenAI, apiKey) {
  const baseURL = process.env.PA_OPENAI_AGENT_BASE_URL?.trim() || "https://api.openai.com/v1"
  const client = new OpenAI({ apiKey, baseURL })
  sdk.setDefaultOpenAIClient(client)
  sdk.setOpenAIAPI("responses")
  if (apiKey) sdk.setDefaultOpenAIKey(apiKey)
  return client
}

function buildTools(sdk, z, registry, recorder) {
  const tools = []
  for (const name of TRIAGE_ALLOWLIST) {
    const def = registry[name]
    if (!def) continue
    // NOTE: the production adapter's buildSdkTools passes the raw Zod schema with
    // no strict override, so the live agent path would 400 on these connectors
    // (optional fields are not strict-compatible). P1 (run(agent) drives
    // job-search) must resolve this for real. Here we pass a non-strict JSON
    // schema to MEASURE the model's routing/abstention.
    tools.push(
      sdk.tool({
        name,
        description: def.description,
        parameters: toNonStrictJsonSchema(z, def.inputSchema),
        strict: false,
        execute: async (args) => {
          recorder.calls.push({ name, args })
          return "ok" // stub — we only need the routing decision, not the side effect
        },
      }),
    )
  }
  return tools
}

function isSubset(expected, actual) {
  if (expected == null) return true
  if (typeof expected !== "object") return JSON.stringify(expected) === JSON.stringify(actual)
  if (actual == null || typeof actual !== "object") return false
  for (const [k, v] of Object.entries(expected)) {
    if (!isSubset(v, actual[k])) return false
  }
  return true
}

async function runToolChoiceFixture(sdk, z, registry, fx) {
  const recorder = { calls: [] }
  const tools = buildTools(sdk, z, registry, recorder)
  const agent = new sdk.Agent({
    name: "Claire",
    instructions: fx.system ? `${SYSTEM_PROMPT}\n${fx.system}` : SYSTEM_PROMPT,
    model: MODEL,
    modelSettings: { toolChoice: "auto", parallelToolCalls: false },
    tools,
  })
  const input = fx.context ? `${fx.context}\n\nUser: ${fx.turn}` : fx.turn
  let finalText = ""
  try {
    const res = await sdk.run(agent, input)
    finalText = String(res?.finalOutput ?? "").trim()
  } catch (e) {
    return { ok: false, detail: `run threw: ${e?.message ?? e}`, chosen: null, finalText: "" }
  }
  const chosen = recorder.calls[0] ?? null
  const expectTool = fx.expect.tool ?? null

  if (expectTool === null) {
    // abstention case
    const ok = chosen === null
    return { ok, detail: ok ? "abstained (no tool) ✓" : `expected ABSTAIN, but called '${chosen.name}'`, chosen, finalText }
  }
  if (!chosen) return { ok: false, detail: `expected tool '${expectTool}', but model ABSTAINED (no call)`, chosen, finalText }
  if (chosen.name !== expectTool) return { ok: false, detail: `tool expected '${expectTool}', got '${chosen.name}'`, chosen, finalText }
  if (fx.expect.args_contains && !isSubset(fx.expect.args_contains, chosen.args)) {
    return { ok: false, detail: `tool '${chosen.name}' ok but args missing subset ${JSON.stringify(fx.expect.args_contains)} (got ${JSON.stringify(chosen.args)})`, chosen, finalText }
  }
  return { ok: true, detail: `called '${chosen.name}' ✓`, chosen, finalText }
}

async function runDeliveryFixture(client, fx) {
  const prompt = [
    "You decide how a texting assistant (iMessage) should respond to the user's latest message.",
    "Options:",
    "  - 'text'    : send a substantive written reply (the message needs words).",
    "  - 'tapback' : just a quick reaction (like 👍/❤️) with NO words — for low-information acks while already processing.",
    "  - 'no_reply': send nothing (the message does not warrant any response).",
    fx.context ? `Context: ${fx.context}` : "",
    `User's latest message: "${fx.turn}"`,
    'Return JSON only: { "mode": "text" | "tapback" | "no_reply" }.',
  ].filter(Boolean).join("\n")
  let raw = "{}"
  try {
    const resp = await client.chat.completions.create({
      model: MODEL,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: "You are a precise classifier. JSON only." },
        { role: "user", content: prompt },
      ],
    })
    raw = resp.choices?.[0]?.message?.content ?? "{}"
  } catch (e) {
    return { ok: false, detail: `delivery call threw: ${e?.message ?? e}`, chosen: null }
  }
  let mode = null
  try {
    mode = JSON.parse(raw).mode
  } catch {
    return { ok: false, detail: `delivery returned non-JSON: ${raw.slice(0, 80)}`, chosen: null }
  }
  const accepted = fx.expect.modes ?? [fx.expect.mode]
  const ok = accepted.includes(mode)
  return { ok, detail: ok ? `delivery=${mode} ✓` : `delivery expected ${JSON.stringify(accepted)}, got '${mode}'`, chosen: mode }
}

async function main() {
  loadDotEnv(REPO_ROOT)
  const apiKey = (process.env.PA_OPENAI_AGENT_API_KEY ?? process.env.OPENAI_API_KEY ?? "").trim()
  if (!apiKey.startsWith("sk-")) {
    console.error("SETUP ERROR: no real OpenAI key (PA_OPENAI_AGENT_API_KEY / OPENAI_API_KEY) in .env")
    process.exit(2)
  }
  let registry
  let sdk
  let OpenAI
  let z
  try {
    ;({ connectorRegistry: registry } = await importDist(REPO_ROOT, "packages/pa-connectors/dist/index.js"))
    ;({ sdk, OpenAI } = loadAgentsSdk())
    z = loadZod()
  } catch (e) {
    console.error(`SETUP ERROR: ${e?.message ?? e}`)
    process.exit(2)
  }
  const client = configureClient(sdk, OpenAI, apiKey)

  const fixtures = loadJsonFixtures(join(__dirname, "bfcl-fixtures"))
  if (fixtures.length === 0) {
    console.error("No bfcl-fixtures found")
    process.exit(2)
  }

  const tally = { tool_choice: { ok: 0, n: 0 }, abstention: { ok: 0, n: 0 }, delivery: { ok: 0, n: 0 } }
  console.log(`BFCL conversation-quality eval — model=${MODEL} (ADVISORY; does not block)\n`)
  for (const { name, fixture } of fixtures) {
    let res
    if (fixture.kind === "delivery") {
      res = await runDeliveryFixture(client, fixture)
      tally.delivery.n++
      if (res.ok) tally.delivery.ok++
    } else {
      // tool_choice (expect.tool set) OR abstention (expect.tool === null)
      const bucket = fixture.expect?.tool == null ? "abstention" : "tool_choice"
      res = await runToolChoiceFixture(sdk, z, registry, fixture)
      tally[bucket].n++
      if (res.ok) tally[bucket].ok++
    }
    console.log(`${res.ok ? "ok  " : "MISS"} ${name}  [${fixture.kind}] — ${res.detail}`)
  }

  const pct = (b) => (b.n === 0 ? "n/a" : `${b.ok}/${b.n} (${Math.round((100 * b.ok) / b.n)}%)`)
  console.log("\n── BFCL baseline scorecard (advisory) ──")
  console.log(`  tool-choice accuracy : ${pct(tally.tool_choice)}`)
  console.log(`  abstention accuracy  : ${pct(tally.abstention)}`)
  console.log(`  delivery accuracy    : ${pct(tally.delivery)}`)
  console.log("\n(advisory layer — exit 0 regardless of misses; the hard gate is process-intact-runner.mjs)")
  process.exit(0)
}

main().catch((e) => {
  console.error("bfcl-runner crashed:", e)
  process.exit(2)
})
