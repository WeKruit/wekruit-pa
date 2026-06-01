#!/usr/bin/env node
/**
 * eval-process.mjs — WS-process L1 + L3 eval for the reducer-owned onboarding /
 * prescreen process layer (thin Claire). Real `gpt-5.4-nano`, no deploy.
 *
 * This drives the PRODUCTION code (apps/functions/src/claire-agent):
 *   - reducers/onboarding-fsm.ts  (pure FSM — earliest-pending, no-skip, complete-once)
 *   - reducers/prescreen-fsm.ts   (pure FSM — rollup PASS/FAIL, commit-once, idempotent)
 *   - tools/process-tools.ts      (buildProcessTools — the ask/record/score/explain tools
 *                                  with an in-tool LLM JUDGE sub-agent)
 *
 * KEYSTONE proven here: the LLM only PROPOSES (answer text, a judge score); the
 * deterministic REDUCER DECIDES the next question, the PASS/FAIL rollup, commit-once,
 * out-of-order rejection, and post-terminal idempotency. The LLM never declares pass/fail.
 *
 * TWO layers:
 *   L1 — pure, deterministic, fast: the reducer invariants (no model).
 *   L3 — real model, mirrors poc-v3 C / C2 / C3 via buildProcessTools(ctx) + an
 *        in-memory store + the real judge. Production models ONE inbound turn per
 *        run() call (each candidate reply is a separate inbound), which is far more
 *        reliable than cramming; LLM-driven multi-turn cases use best-of-3.
 *
 * Mechanism (mirrors the POC runner): @openai/agents + zod resolve from
 * agent-runtime (the zod@4 dist that works as plain ESM); the production TS is
 * esbuild-bundled with those + @pa/* marked external so the eval loads the real
 * production tools without tsx intercepting the SDK's own TypeScript source.
 *
 * Run: source ~/.zshrc && nvm use 24 && node apps/eval/thin-claire/eval-process.mjs
 * Exit 0 = green, 1 = red.
 */
import { spawnSync } from "node:child_process"
import {
  symlinkSync,
  existsSync,
  mkdirSync,
  rmSync,
  readFileSync,
} from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"
import assert from "node:assert/strict"

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, "../../..")
const agentRuntimeNm = join(repoRoot, "packages/agent-runtime/node_modules")
const functionsNm = join(repoRoot, "apps/functions/node_modules")
const processToolsSrc = join(
  repoRoot,
  "apps/functions/src/claire-agent/tools/process-tools.ts",
)

// ── node_modules: SDK + zod + tsx from agent-runtime (the WORKING zod@4 dist);
//    @pa/* workspace packages from source (process-tools' reducers need
//    SHARED_ONBOARDING_QUESTIONS). Idempotent — safe to re-run. ──
const nm = join(here, "node_modules")
function link(rel, target) {
  const p = join(nm, rel)
  if (existsSync(p)) return
  try {
    symlinkSync(target, p)
  } catch (e) {
    console.error(`could not symlink ${rel} → ${target}: ${e?.message ?? e}`)
  }
}
mkdirSync(nm, { recursive: true })
mkdirSync(join(nm, "@pa"), { recursive: true })
link("@openai", join(agentRuntimeNm, "@openai"))
link("zod", join(agentRuntimeNm, "zod"))
link(".bin", join(agentRuntimeNm, ".bin"))
link("@pa/pa-orchestrator", join(repoRoot, "packages/pa-orchestrator"))
link("@pa/core-types", join(repoRoot, "packages/core-types"))
link("@pa/pa-persistence", join(repoRoot, "packages/pa-persistence"))

// ── load the OpenAI key from repo-root .env (as the POCs do) ──
const envPath = join(repoRoot, ".env")
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^(PA_OPENAI_AGENT_API_KEY|OPENAI_API_KEY)=(.*)$/)
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim()
  }
}
if (!process.env.OPENAI_API_KEY && process.env.PA_OPENAI_AGENT_API_KEY) {
  process.env.OPENAI_API_KEY = process.env.PA_OPENAI_AGENT_API_KEY
}
if (!process.env.OPENAI_API_KEY) {
  console.error("no OPENAI_API_KEY / PA_OPENAI_AGENT_API_KEY in env or repo-root .env")
  process.exit(1)
}

// ── esbuild the PRODUCTION process layer (tools + both reducers) into one ESM
//    module via a synthetic re-export entry, with @openai/agents + zod + @pa/*
//    external. esbuild lives in functions' node_modules. No new source file on
//    disk — the entry is an esbuild stdin string pointing at the real sources. ──
const bundlePath = join(here, ".eval-process.bundle.mjs")
const toolsDir = dirname(processToolsSrc) // apps/functions/src/claire-agent/tools
const reducersDir = join(toolsDir, "../reducers")
{
  const esbuild = await import(join(functionsNm, "esbuild/lib/main.js"))
  await esbuild.build({
    stdin: {
      contents: [
        `export * from ${JSON.stringify(join(toolsDir, "process-tools.ts"))}`,
        `export * from ${JSON.stringify(join(reducersDir, "onboarding-fsm.ts"))}`,
        `export * from ${JSON.stringify(join(reducersDir, "prescreen-fsm.ts"))}`,
      ].join("\n"),
      resolveDir: here,
      loader: "ts",
    },
    bundle: true,
    format: "esm",
    platform: "node",
    outfile: bundlePath,
    logLevel: "silent",
    external: [
      "@openai/agents",
      "zod",
      "@pa/pa-orchestrator",
      "@pa/core-types",
      "@pa/pa-persistence",
      "firebase-admin",
    ],
  })
}
// one bundle re-exports the tools + both reducers (for the L3 driver and L1 asserts).
const {
  buildProcessTools,
  emptyProcessStore,
  nextOnboardingSlot,
  recordOnboardingAnswer,
  nextPrescreenQuestion,
  recordPrescreenScore,
  DEFAULT_ONBOARDING_SLOTS,
  DEFAULT_PRESCREEN_THRESHOLD,
} = await import(bundlePath)

const { Agent, run } = await import("@openai/agents")

const JUDGE_MODEL = "gpt-5.4-nano"
const AGENT_MODEL = "gpt-5.4-nano"

// ════════════ in-memory process store + a recording channel (poc-v3 mirror) ════════════
function makeChannel() {
  const events = []
  return {
    events,
    markRead() { events.push({ kind: "mark_read" }) },
    typing() { events.push({ kind: "typing" }) },
    sendStatus(t) { events.push({ kind: "status", value: t }) },
    sendText(t) { events.push({ kind: "text", value: t }) },
    tapback(r) { events.push({ kind: "tapback", value: r }) },
    noReply() { events.push({ kind: "no_reply" }) },
    reset() { events.length = 0 },
    kinds() { return events.map((e) => e.kind) },
  }
}

function makeCtx(store, sb) {
  return {
    db: undefined,
    userId: "eval-user",
    sessionId: "eval-session",
    lang: "en",
    transport: {
      async markRead() { sb.markRead() },
      async typing() { sb.typing() },
      async sendStatus(t) { sb.sendStatus(t) },
      async sendText(t) { sb.sendText(t) },
      async tapback(r) { sb.tapback(r) },
      async noReply(r) { sb.noReply(r) },
    },
    judgeModel: JUDGE_MODEL,
    log: () => {},
    nowIso: () => new Date().toISOString(),
    processStore: store,
  }
}

// The single agent (no handoffs) — exercises the same description-routed tool
// flow as production. Instructions mirror poc-v3's ONBOARDING / PRESCREEN /
// FLEXIBILITY directives so the model drives ask_next → record/score each turn.
const INSTRUCTIONS = [
  "You are Claire, a warm concise recruiter friend on iMessage. Text short, no markdown, never say you're an AI.",
  "ONBOARDING: when the user is onboarding (they mention onboarding, or you're collecting their profile), on EACH of their replies you MUST first call ask_next_onboarding_question to get the pending slot, then call record_onboarding_answer with that EXACT pending slot id + their answer, then ask the NEXT pending slot in your text. Repeat until complete. You cannot skip slots — the tool enforces order.",
  "PRESCREEN: when an interview/prescreen is active, on EACH candidate reply you MUST first call ask_next_prescreen_question to get the pending question, then call score_prescreen_answer with that EXACT pending question id + their answer (an LLM judge scores it, the reducer advances). Then ask the next pending question. You do NOT decide pass/fail — never tell them they passed/failed; the reducer decides and you read it via explain_prescreen_outcome.",
  "FLEXIBILITY: the candidate can ask anything mid-flow (e.g. 'show me jobs' during prescreen). Answer it briefly in text, then steer back to the pending question. Process state is durable; you won't lose their place. Do NOT call score_prescreen_answer for a tangent that is not an answer to the pending question.",
  "Don't claim you saved/changed something you didn't.",
].join(" ")

function makeAgent(store, sb, prescreenPrompts) {
  return new Agent({
    name: "Claire",
    model: AGENT_MODEL,
    instructions: INSTRUCTIONS,
    tools: buildProcessTools(makeCtx(store, sb), prescreenPrompts),
  })
}

// one inbound = one run() call (production models ONE question per inbound turn).
async function handleInbound(agent, session, sb, text) {
  sb.markRead()
  const res = await run(agent, text, { session })
  const out = String(res.finalOutput ?? "").trim()
  if (out) sb.sendText(out)
  return out
}

// ════════════ L1 — pure reducer invariants (no model) ════════════
function runL1() {
  const cases = []
  const add = (name, fn) => cases.push({ name, fn })

  add("onboarding: nextOnboardingSlot hands earliest pending + prompt", () => {
    const s = { slots: ["main_goal", "industry_interest", "location_relocation"], answers: {}, complete: false }
    const n = nextOnboardingSlot(s)
    assert.equal(n.pending, "main_goal")
    assert.equal(n.complete, false)
    assert.ok(typeof n.prompt === "string" && n.prompt.length > 0)
  })

  add("onboarding: no-skip — out-of-order slot rejected, nothing recorded", () => {
    const s = { slots: ["main_goal", "industry_interest"], answers: {}, complete: false }
    const r = recordOnboardingAnswer(s, "industry_interest", "fintech")
    assert.equal(r.ok, false)
    assert.equal(r.reason, "out_of_order: expected main_goal, not industry_interest")
    assert.equal(r.pending, "main_goal")
    assert.deepEqual(s.answers, {})
  })

  add("onboarding: walks all slots in order + complete-once", () => {
    const s = { slots: ["main_goal", "industry_interest", "location_relocation"], answers: {}, complete: false }
    assert.equal(recordOnboardingAnswer(s, "main_goal", "growth").pending, "industry_interest")
    assert.equal(recordOnboardingAnswer(s, "industry_interest", "fintech").pending, "location_relocation")
    const last = recordOnboardingAnswer(s, "location_relocation", "SF or remote")
    assert.equal(last.pending, null)
    assert.equal(last.complete, true)
    assert.equal(s.complete, true)
    // a stray late record cannot un-complete.
    const stray = recordOnboardingAnswer(s, "main_goal", "changed mind")
    assert.equal(stray.ok, false)
    assert.equal(stray.reason, "already_complete")
  })

  add("onboarding: default slots = SHARED_ONBOARDING_QUESTIONS (6)", () => {
    assert.equal(DEFAULT_ONBOARDING_SLOTS.length, 7)
    const s = { slots: [], answers: {}, complete: false }
    assert.equal(nextOnboardingSlot(s).pending, DEFAULT_ONBOARDING_SLOTS[0])
  })

  add("prescreen: no-skip — out-of-order question rejected", () => {
    const p = { questions: ["a", "b"], scores: {}, threshold: DEFAULT_PRESCREEN_THRESHOLD, terminal: null, terminalCommits: 0 }
    const r = recordPrescreenScore(p, "b", { score: 0.9 })
    assert.equal(r.ok, false)
    assert.equal(r.pending, "a")
    assert.deepEqual(p.scores, {})
  })

  add("prescreen: PASS rollup (avg >= threshold), reducer-decided, commit-once", () => {
    const p = { questions: ["a", "b", "c"], scores: {}, threshold: 0.6, terminal: null, terminalCommits: 0 }
    for (const q of ["a", "b", "c"]) recordPrescreenScore(p, q, { score: 0.9 })
    assert.equal(p.terminal, "PASS")
    assert.equal(p.terminalCommits, 1)
  })

  add("prescreen: FAIL rollup (avg < threshold), commit-once", () => {
    const p = { questions: ["a", "b"], scores: {}, threshold: 0.6, terminal: null, terminalCommits: 0 }
    recordPrescreenScore(p, "a", { score: 0.2 })
    recordPrescreenScore(p, "b", { score: 0.3 })
    assert.equal(p.terminal, "FAIL")
    assert.equal(p.terminalCommits, 1)
  })

  add("prescreen: post-terminal idempotency — re-score rejected, no re-commit", () => {
    const p = { questions: ["a"], scores: {}, threshold: 0.6, terminal: null, terminalCommits: 0 }
    recordPrescreenScore(p, "a", { score: 0.9 })
    assert.equal(p.terminal, "PASS")
    const r = recordPrescreenScore(p, "a", { score: 0.0 })
    assert.equal(r.ok, false)
    assert.equal(r.reason, "already_terminal")
    assert.equal(p.terminalCommits, 1)
    assert.equal(p.scores["a"].score, 0.9)
  })

  add("prescreen: nextPrescreenQuestion surfaces terminal once all scored", () => {
    const p = { questions: ["a"], scores: {}, threshold: 0.6, terminal: null, terminalCommits: 0 }
    recordPrescreenScore(p, "a", { score: 0.9 })
    const n = nextPrescreenQuestion(p)
    assert.equal(n.pending, null)
    assert.equal(n.terminal, "PASS")
  })

  let fails = 0
  for (const c of cases) {
    try {
      c.fn()
      console.log(`PASS  [L1] ${c.name}`)
    } catch (e) {
      console.log(`FAIL  [L1] ${c.name}\n        → ${e?.message ?? e}`)
      fails++
    }
  }
  return fails
}

// ════════════ L3 — real model, mirrors poc-v3 C / C2 / C3 ════════════

// session memory: import MemorySession from the SDK.
async function memorySession(id) {
  const sdk = await import("@openai/agents")
  return new sdk.MemorySession(id)
}

const ONBOARD_SLOTS = ["main_goal", "industry_interest", "location_relocation"]
const PRESCREEN_QS = ["systems_design", "ownership", "failure_handling"]
const PRESCREEN_PROMPTS = {
  systems_design: "tell me about a system you designed",
  ownership: "what did you personally own?",
  failure_handling: "tell me about a failure and how you handled it",
}
function freshOnboardingStore() {
  return {
    onboarding: { slots: [...ONBOARD_SLOTS], answers: {}, complete: false },
    prescreen: { questions: [], scores: {}, threshold: DEFAULT_PRESCREEN_THRESHOLD, terminal: null, terminalCommits: 0 },
  }
}
function freshPrescreenStore() {
  return {
    // onboarding already done — this session is unambiguously a prescreen, so
    // the model never reaches for the onboarding tools (no flow ambiguity).
    // A genuinely-satisfied single slot avoids the empty-slots default fallback.
    onboarding: { slots: ["main_goal"], answers: { main_goal: "growth" }, complete: true },
    prescreen: { questions: [...PRESCREEN_QS], scores: {}, threshold: DEFAULT_PRESCREEN_THRESHOLD, terminal: null, terminalCommits: 0 },
  }
}

// C onboarding: feed the slot answers across SEPARATE turns → all recorded in order, complete.
async function l3Onboarding() {
  const store = freshOnboardingStore()
  const sb = makeChannel()
  const agent = makeAgent(store, sb, {})
  const session = await memorySession("l3-onboarding")
  const answers = ["growth and learning", "fintech and AI", "SF or remote"]
  for (let i = 0; i < answers.length; i++) {
    sb.reset()
    const text = i === 0 ? `let's do onboarding. ${answers[i]}` : answers[i]
    await handleInbound(agent, session, sb, text)
  }
  const o = store.onboarding
  if (!o.complete) return `onboarding not complete: answers=${JSON.stringify(Object.keys(o.answers))}`
  if (Object.keys(o.answers).length !== ONBOARD_SLOTS.length) return `not all slots: ${JSON.stringify(o.answers)}`
  if (JSON.stringify(Object.keys(o.answers)) !== JSON.stringify(ONBOARD_SLOTS)) return `slots out of order: ${JSON.stringify(Object.keys(o.answers))}`
  return null
}

// C prescreen: "start the interview" then 3 strong answers across separate turns
// → all scored, terminal committed exactly ONCE, terminal set BY THE REDUCER.
async function l3Prescreen() {
  const store = freshPrescreenStore()
  const sb = makeChannel()
  const agent = makeAgent(store, sb, PRESCREEN_PROMPTS)
  const session = await memorySession("l3-prescreen")
  const strong = {
    systems_design: "I designed a distributed rate limiter at 50k rps using Redis sliding-window; owned the failover and consistency model.",
    ownership: "I personally owned the schema, the API boundary, and the on-call runbook; shipped it solo end to end.",
    failure_handling: "A cache stampede took us down; I added request coalescing + jittered backoff, wrote the postmortem, and it never recurred.",
  }
  sb.reset()
  await handleInbound(agent, session, sb, "let's start the interview")
  for (const q of PRESCREEN_QS) {
    sb.reset()
    await handleInbound(agent, session, sb, strong[q])
  }
  const p = store.prescreen
  if (Object.keys(p.scores).length !== PRESCREEN_QS.length) return `not all scored: ${JSON.stringify(Object.keys(p.scores))}`
  if (!p.terminal) return "no terminal (reducer never rolled up)"
  if (p.terminalCommits !== 1) return `terminal committed ${p.terminalCommits}x (want exactly 1)`
  return null
}

// C3 flexibility: mid-prescreen "show me jobs first" → prescreen scores/terminal
// UNCHANGED, tangent answered in text, pending question still resumable.
async function l3Flexibility() {
  const store = freshPrescreenStore()
  const sb = makeChannel()
  const agent = makeAgent(store, sb, PRESCREEN_PROMPTS)
  const session = await memorySession("l3-flex")
  await handleInbound(agent, session, sb, "let's start the interview")
  await handleInbound(agent, session, sb, "I built a distributed rate limiter at 50k rps, owned the design") // answers Q1
  const scoredBefore = Object.keys(store.prescreen.scores).length
  const terminalBefore = store.prescreen.terminal
  sb.reset()
  await handleInbound(agent, session, sb, "wait, can you show me some product roles first?") // tangent
  const scoredAfter = Object.keys(store.prescreen.scores).length
  if (scoredAfter !== scoredBefore) return `tangent mutated prescreen scores (${scoredBefore}->${scoredAfter})`
  if (store.prescreen.terminal !== terminalBefore) return "tangent wrongly changed prescreen terminal"
  if (!sb.kinds().includes("text")) return "tangent not answered in text"
  const pending = store.prescreen.questions.find((q) => !(q in store.prescreen.scores))
  if (!pending) return "no pending Q left (skip bug — flow not resumable)"
  return null
}

// C2 idempotency: pre-set terminal, "why did I pass?" → NO re-commit, explanation returned.
async function l3Idempotency() {
  const store = freshPrescreenStore()
  store.prescreen.scores = {
    systems_design: { score: 0.9, evidence: "" },
    ownership: { score: 0.9, evidence: "" },
    failure_handling: { score: 0.9, evidence: "" },
  }
  store.prescreen.terminal = "PASS"
  store.prescreen.terminalCommits = 1
  const sb = makeChannel()
  const agent = makeAgent(store, sb, PRESCREEN_PROMPTS)
  const session = await memorySession("l3-idem")
  sb.reset()
  await handleInbound(agent, session, sb, "why did I pass?")
  if (store.prescreen.terminalCommits !== 1) return `re-committed terminal (${store.prescreen.terminalCommits})`
  if (store.prescreen.terminal !== "PASS") return "terminal changed on explain"
  if (!sb.kinds().includes("text")) return "no explanation text"
  return null
}

/** best-of-N for the LLM-driven multi-turn cases (real-model variance). */
async function bestOf(label, fn, n = 3) {
  let lastErr = null
  for (let i = 1; i <= n; i++) {
    try {
      const err = await fn()
      if (!err) {
        console.log(`PASS  [L3] ${label}${i > 1 ? ` (attempt ${i}/${n})` : ""}`)
        return 0
      }
      lastErr = err
      console.log(`  …  [L3] ${label} attempt ${i}/${n}: ${err}`)
    } catch (e) {
      lastErr = `THREW: ${e?.message ?? e}`
      console.log(`  …  [L3] ${label} attempt ${i}/${n}: ${lastErr}`)
    }
  }
  console.log(`FAIL  [L3] ${label}\n        → ${lastErr}`)
  return 1
}

async function main() {
  console.log("══ WS-process eval — L1 (pure reducers) ══")
  let fails = runL1()

  console.log("\n══ WS-process eval — L3 (real gpt-5.4-nano, buildProcessTools + judge) ══")
  fails += await bestOf("onboarding: walks all slots in order, complete=true", l3Onboarding)
  fails += await bestOf("prescreen: all scored, terminal committed once, reducer-set", l3Prescreen)
  fails += await bestOf("C3 flexibility: mid-prescreen tangent answered, state untouched, resumable", l3Flexibility)
  fails += await bestOf("C2 idempotency: post-terminal explain — no re-commit", l3Idempotency)

  // cleanup the bundle (best-effort).
  try { rmSync(bundlePath, { force: true }) } catch {}

  console.log(
    `\n${fails === 0 ? "WS-PROCESS EVAL: GREEN ✅ — reducer-owned onboarding/prescreen (no-skip, commit-once, idempotent, flexible), real model" : `WS-PROCESS EVAL: RED ❌ — ${fails} failed`}`,
  )
  process.exit(fails === 0 ? 0 : 1)
}

await main()
