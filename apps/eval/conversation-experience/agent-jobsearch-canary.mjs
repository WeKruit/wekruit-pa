#!/usr/bin/env node
/**
 * P1 agent-path job-search canary — the real-LLM proof that gates the P1-C
 * deletion of the regex job_search router.
 * ════════════════════════════════════════════════════════════════════════
 *
 * Per AGENTIC-ARCHITECTURE.md §12 ("never delete a hand-written layer until a
 * real-LLM eval proves the model+prompt self-does it"), this canary proves that
 * the AGENT path (run(agent) + the find-match connector), NOT the regex handler,
 * drives a job-search turn AND preserves the Adam-bug invariant: the matcher sees
 * the POST-reducer canonical tags, not the stale onboarding tags.
 *
 * Flow (real model, no mock of the model):
 *   seed pa-users.tags = ["software_engineering"], onboardingState=complete
 *   turn 1: REAL maybeRunExtractor("done with pure SWE, only product, full-time")
 *           → durable_preference reducer commits product-only tags (P0-proven)
 *   turn 2: REAL run(agent) with the find-match tool (strict Zod from the registry,
 *           Hermes description). The find-match execute reads pa-users.tags from the
 *           seeded store (exactly what the production findMatch hook does) and records
 *           the snapshot. The model must CALL find-match.
 *
 * Asserts (the gate):
 *   1. the model called find-match (agent self-routes job-search — no regex)
 *   2. the tags find-match SAW include product_management and EXCLUDE software_engineering
 *      (post-reducer, not stale — the Adam-bug invariant)
 *
 * Exit 0 = green (gate satisfied). 1 = failed. 2 = setup error. Real-LLM, so run
 * twice for confidence; this is the targeted "model self-does it" proof for P1-C.
 */
import { createRequire } from "node:module"
import { pathToFileURL } from "node:url"
import { repoRootFrom, loadDotEnv, importDist } from "./harness-lib.mjs"

const REPO_ROOT = repoRootFrom(import.meta.url)
const MODEL = process.env.PA_AGENT_MODEL?.trim() || "gpt-5.4-nano"
const USER = "test_user_p1_canary"

function makeStore() {
  const cols = new Map()
  const col = (n) => (cols.has(n) ? cols.get(n) : (cols.set(n, new Map()), cols.get(n)))
  return {
    collection: (n) => ({
      doc: (id) => ({
        get: async () => ({ exists: col(n).has(id), data: () => col(n).get(id) ?? undefined }),
        set: async (data, opts) => {
          const cur = col(n).get(id) ?? {}
          col(n).set(id, opts?.merge ? { ...cur, ...data } : data)
        },
      }),
      add: async (data) => { const id = `auto-${col(n).size}`; col(n).set(id, data); return { id } },
    }),
  }
}

async function main() {
  loadDotEnv(REPO_ROOT)
  const apiKey = (process.env.PA_OPENAI_AGENT_API_KEY ?? process.env.OPENAI_API_KEY ?? "").trim()
  if (!apiKey.startsWith("sk-")) { console.error("SETUP ERROR: no OpenAI key"); process.exit(2) }

  let maybeRunExtractor, connectorRegistry, sdk, OpenAI
  try {
    ;({ maybeRunExtractor } = await importDist(REPO_ROOT, "packages/pa-orchestrator/dist/conversation-extractor-runtime.js"))
    ;({ connectorRegistry } = await importDist(REPO_ROOT, "packages/pa-connectors/dist/index.js"))
    const req = createRequire(`${REPO_ROOT}/packages/agent-runtime/package.json`)
    sdk = req("@openai/agents")
    OpenAI = req("openai").default ?? req("openai")
  } catch (e) { console.error(`SETUP ERROR: ${e?.message ?? e}`); process.exit(2) }

  sdk.setDefaultOpenAIClient(new OpenAI({ apiKey, baseURL: process.env.PA_OPENAI_AGENT_BASE_URL?.trim() || "https://api.openai.com/v1" }))
  sdk.setOpenAIAPI("responses")
  sdk.setDefaultOpenAIKey(apiKey)

  const db = makeStore()
  await db.collection("pa-users").doc(USER).set({ tags: { targetRoleFunction: ["software_engineering"], targetJobType: ["internship"], careerStage: "intern" }, onboardingState: "complete" })
  const readTags = async () => (await db.collection("pa-users").doc(USER).get()).data()?.tags ?? {}

  const fails = []

  // ── turn 1: durable preference update through the REAL production seam ──
  await maybeRunExtractor({
    db, userId: USER,
    recentMessages: [{ role: "user", body: "actually I'm done with pure software engineering — only product strategy / PM roles now, full-time", createdAt: new Date().toISOString() }],
    existingTags: await readTags(), onboardingState: "complete", userMsgsThisBatch: 1, forceTrigger: "intent_signal", log: () => {},
  })
  const postReducerTags = await readTags()
  console.log(`turn 1 (durable pref) → tags: ${JSON.stringify(postReducerTags.targetRoleFunction)}`)
  if ((postReducerTags.targetRoleFunction ?? []).includes("software_engineering")) {
    // Not fatal to the agent-path proof itself, but note it (this is the P5/lock-5 surface).
    console.log("  note: software_engineering still present after reducer (lock-#5 territory; see negative-axis-baseline)")
  }

  // ── turn 2: agent drives job-search; find-match reads post-reducer tags ──
  let snapshotSeen = null
  let called = false
  const findMatchDef = connectorRegistry["find-match"]
  const tool = sdk.tool({
    name: "find-match",
    description: findMatchDef.description,
    parameters: findMatchDef.inputSchema, // strict Zod (now .nullable() — P1 fix)
    execute: async () => {
      called = true
      snapshotSeen = (await db.collection("pa-users").doc(USER).get()).data()?.tags ?? {} // what the production hook reads
      return JSON.stringify({ ok: true, source: "find-match", jobCount: 2, summary: "found 2", reason: null, message: "two roles fit" })
    },
  })
  const agent = new sdk.Agent({
    name: "Claire",
    instructions: "You are Claire, a warm job-search assistant. When the user asks to see jobs/matches, call find-match. Do not ask clarifying questions first.",
    model: MODEL,
    modelSettings: { toolChoice: "auto" },
    tools: [tool],
  })
  let finalText = ""
  try {
    const res = await sdk.run(agent, "ok cool — now find me some matches")
    finalText = String(res?.finalOutput ?? "").trim()
  } catch (e) { fails.push(`run(agent) threw: ${e?.message ?? e}`) }

  console.log(`turn 2 (agent) → find-match called=${called}; snapshot find-match saw: ${JSON.stringify(snapshotSeen?.targetRoleFunction)}`)
  console.log(`  agent reply: ${finalText.slice(0, 120)}`)

  // Gate assertions
  if (!called) fails.push("AGENT DID NOT CALL find-match (regex would be needed) — agent path not proven")
  if (called) {
    const seen = snapshotSeen?.targetRoleFunction ?? []
    if (!seen.includes("product_management")) fails.push(`find-match saw STALE tags: targetRoleFunction=${JSON.stringify(seen)} (expected to include product_management — post-reducer)`)
    if (seen.includes("software_engineering")) fails.push(`find-match saw software_engineering (lock-#5 additive gap leaked into the matcher input: ${JSON.stringify(seen)})`)
  }

  console.log("")
  if (fails.length) {
    console.error("AGENT-PATH CANARY FAILED:")
    for (const f of fails) console.error(`  - ${f}`)
    process.exit(1)
  }
  console.log("AGENT-PATH CANARY GREEN ✓ — agent self-routes job-search via find-match AND the matcher saw the post-reducer tags (product_management, no stale software_engineering). Gate satisfied for the P1-C regex deletion.")
}

main().catch((e) => { console.error("canary crashed:", e); process.exit(2) })
