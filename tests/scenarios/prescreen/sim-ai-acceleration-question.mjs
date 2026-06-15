#!/usr/bin/env node
/**
 * sim-ai-acceleration-question.mjs — IN-PROCESS sim of the DEFAULT AI-acceleration question
 * (Adam directive): every thin prescreen session asks ONE open-ended, role-tailored "how do you
 * use AI to accelerate your work?" question, captured GLOBALLY, SKIPPED if already answered.
 *
 * Drives the REAL production seam deterministically (NO network, NO LLM):
 *   - buildThinPrescreenSeed (the live injection point, mode-selector.ts) — appends + tailors
 *   - ask_next_prescreen_question tool (process-tools.ts) — surfaces the asked prompt verbatim
 *   - applyPartialUserTags (the D8 sole writer) — persists tags.aiAccelerationUsage
 *   - shouldSkipAiQuestion (the cross-session skip signal) — screen 2 is SKIPPED
 *
 * The LLM judge inside score_prescreen_answer is NOT exercised here (it needs the network); the
 * scoring/non-gating math is proven hermetically in prescreen-ai-question.test.ts. This sim proves
 * the OBSERVABLE candidate experience: the tailored question is ASKED on screen 1 and SKIPPED on
 * screen 2 once captured, end-to-end through production modules.
 *
 * Run: node --import tsx tests/scenarios/prescreen/sim-ai-acceleration-question.mjs
 */
import { buildThinPrescreenSeed } from "../../../apps/functions/src/claire-agent/prescreen-config.ts"
import {
  AI_QUESTION_QID,
  roleFunctionFromJob,
  shouldSkipAiQuestion,
} from "../../../apps/functions/src/claire-agent/prescreen-ai-question.ts"
import { buildProcessTools, emptyProcessStore } from "../../../apps/functions/src/claire-agent/tools/process-tools.ts"
import { applyPartialUserTags } from "../../../packages/pa-orchestrator/src/index.ts"

// ── in-memory Firestore fake (deep-merge to mirror Firestore set({merge:true})) ─────────────────
function deepMerge(base, patch) {
  const out = { ...base }
  for (const [k, v] of Object.entries(patch)) {
    const cur = out[k]
    if (v && typeof v === "object" && !Array.isArray(v) && cur && typeof cur === "object" && !Array.isArray(cur)) {
      out[k] = deepMerge(cur, v)
    } else out[k] = v
  }
  return out
}
function makeDb(seed = {}) {
  const store = new Map(Object.entries(seed))
  const docRef = (col, id) => ({
    id,
    async get() {
      const path = `${col}/${id}`
      return { exists: store.has(path), id, data: () => store.get(path) }
    },
    async set(data, opts) {
      const path = `${col}/${id}`
      store.set(path, opts?.merge ? deepMerge(store.get(path) ?? {}, data) : { ...data })
    },
  })
  return {
    db: { collection: (col) => ({ doc: (id) => docRef(col, id) }) },
    store,
  }
}

let failures = 0
function expect(label, cond) {
  console.log(`   ${cond ? "✅" : "❌ FAIL"} ${label}`)
  if (!cond) failures++
}

/** Invoke an @openai/agents tool (signature: invoke(runContext, inputJsonString)). */
async function invokeAsk(toolObj) {
  const r = await toolObj.invoke({}, "{}")
  return typeof r === "string" ? JSON.parse(r) : r
}

// A SWE job (screen 1) and a LATER design job (screen 2) for the SAME candidate.
const SWE_JOB = {
  roleFunction: ["software_engineering"],
  prescreenConfig: {
    questions: [
      {
        qId: "q_core",
        type: "MUST_HAVE",
        prompt: { en: "Walk me through a feature you shipped end-to-end recently." },
        clarifyPrompt: { en: "Your role, the stack, the outcome." },
        keywords: [{ hint: "Shipped a real user-facing feature.", weight: 1, keyword: "shipped" }],
      },
    ],
  },
}
const DESIGN_JOB = {
  roleFunction: ["creatives_and_design"],
  prescreenConfig: {
    questions: [
      {
        qId: "q_design_core",
        type: "MUST_HAVE",
        prompt: { en: "Show me a design you owned end-to-end." },
        clarifyPrompt: { en: "The problem, your process, the outcome." },
        keywords: [{ hint: "Owned a design end-to-end.", weight: 1, keyword: "owned_design" }],
      },
    ],
  },
}

const UID = "cand_ai_sim"

// ── helper: build the live thin seed exactly as mode-selector does ───────────────────────────────
async function buildSeedForScreen(db, store, job, sessionDoc) {
  const userSnap = await db.collection("pa-users").doc(UID).get()
  const userTags = userSnap.exists ? userSnap.data()?.tags ?? null : null
  // prior-session AI score backup (scan the fake store the way mode-selector's helper does)
  let priorAi = false
  for (const [path, data] of store.entries()) {
    if (!path.startsWith("pa-prescreen-sessions/")) continue
    const scored = data.scored ?? data.scores
    if (scored && typeof scored === "object" && AI_QUESTION_QID in scored) priorAi = true
  }
  const append = !shouldSkipAiQuestion(userTags, priorAi)
  return buildThinPrescreenSeed(job.prescreenConfig, sessionDoc ?? null, "en", {
    append,
    roleFunction: roleFunctionFromJob(job, job.prescreenConfig),
  })
}

console.log("══════════════════════════════════════════════════════════════════════")
console.log("SCREEN 1 — SWE candidate, fresh (never answered the AI question)")
console.log("══════════════════════════════════════════════════════════════════════")
const { db, store } = makeDb({ [`pa-users/${UID}`]: { userId: UID } })

let aiPromptAsked = ""
{
  const seed = await buildSeedForScreen(db, store, SWE_JOB, null)
  expect("AI question appended LAST after the job's real question", seed.questionIds.join(",") === `q_core,${AI_QUESTION_QID}`)
  expect("AI question is informational (non-gating)", (seed.prescreen.informational ?? []).includes(AI_QUESTION_QID))

  // Drive the REAL ask_next tool over the seeded store to surface what the candidate is ASKED.
  const procStore = emptyProcessStore()
  procStore.prescreen = seed.prescreen
  const ctx = {
    db, userId: UID, sessionId: "s1", nowIso: () => "2026-06-14T00:00:00.000Z", log: () => {},
    judgeModel: "gpt-4.1-mini", processStore: procStore,
  }
  const tools = buildProcessTools(ctx, seed.prompts, seed.judgeContext)
  const askNext = tools.find((t) => t.name === "ask_next_prescreen_question")

  // Q1 (the job's real question)
  const q1 = await invokeAsk(askNext)
  console.log(`  CLAIRE (Q1): ${q1.prompt}`)
  expect("Q1 is the job's real question", /shipped a feature|shipped end-to-end/i.test(q1.prompt))

  // Simulate Q1 being scored (skip the LLM judge — record directly into the FSM store, as the
  // reducer would), so ask_next now hands the AI question.
  procStore.prescreen.scores.q_core = { score: 0.8, evidence: "shipped a checkout flow" }

  const q2 = await invokeAsk(askNext)
  aiPromptAsked = q2.prompt
  console.log(`  CLAIRE (Q2 = AI): ${q2.prompt}`)
  expect("Q2 is the AI question", q2.pending === AI_QUESTION_QID)
  expect("AI prompt is ENGINEER-tailored (software_engineering)", /engineering work/i.test(q2.prompt))
  expect("AI prompt is open-ended (asks for tools + example)", /tools and workflows/i.test(q2.prompt) && /example/i.test(q2.prompt))
}

console.log("\n  CANDIDATE answers the AI question → persist globally (applyPartialUserTags):")
{
  const answer = "I use Cursor + Claude for scaffolding and tests, and an internal RAG bot for docs. Last sprint I shipped a webhook retry queue ~2x faster by pairing with the agent on the edge cases."
  const w = await applyPartialUserTags(
    db, UID,
    { aiAccelerationUsage: { value: answer, updatedAt: "2026-06-14T00:05:00.000Z" } },
    { source: "chat", nowIso: () => "2026-06-14T00:05:00.000Z" },
  )
  expect("tag write ok", w.ok === true)
  const persisted = store.get(`pa-users/${UID}`)?.tags?.aiAccelerationUsage?.value
  console.log(`  USER: ${answer}`)
  console.log(`  PERSISTED tags.aiAccelerationUsage.value = "${(persisted ?? "").slice(0, 60)}…"`)
  expect("tags.aiAccelerationUsage.value persisted verbatim", persisted === answer)
}

console.log("\n══════════════════════════════════════════════════════════════════════")
console.log("SCREEN 2 — SAME candidate, DIFFERENT (design) role, LATER")
console.log("══════════════════════════════════════════════════════════════════════")
{
  const seed = await buildSeedForScreen(db, store, DESIGN_JOB, null)
  console.log(`  Seed questionIds: [${seed.questionIds.join(", ")}]`)
  expect("AI question SKIPPED (already answered) — not appended", !seed.questionIds.includes(AI_QUESTION_QID))
  expect("only the design job's real question is asked", seed.questionIds.join(",") === "q_design_core")
  expect("no informational set on the skipped screen", seed.prescreen.informational === undefined)

  // Drive ask_next to prove the candidate is NOT asked the AI question again.
  const procStore = emptyProcessStore()
  procStore.prescreen = seed.prescreen
  const ctx = {
    db, userId: UID, sessionId: "s2", nowIso: () => "2026-06-20T00:00:00.000Z", log: () => {},
    judgeModel: "gpt-4.1-mini", processStore: procStore,
  }
  const tools = buildProcessTools(ctx, seed.prompts, seed.judgeContext)
  const askNext = tools.find((t) => t.name === "ask_next_prescreen_question")
  const q1 = await invokeAsk(askNext)
  console.log(`  CLAIRE (Q1): ${q1.prompt}`)
  procStore.prescreen.scores.q_design_core = { score: 0.7 }
  const next = await invokeAsk(askNext)
  console.log(`  CLAIRE (next after design Q1): ${JSON.stringify(next)}`)
  expect("after the design question, NO AI question is asked again", next.pending !== AI_QUESTION_QID)
  expect("AI prompt asked on screen 1 is NOT re-asked on screen 2", (next.prompt ?? "") !== aiPromptAsked)
}

console.log("\n──────────────────────────────────────────────────────────────────────")
if (failures > 0) {
  console.log(`RESULT: ${failures} expectation(s) FAILED`)
  process.exit(1)
}
console.log("RESULT: all expectations passed")
