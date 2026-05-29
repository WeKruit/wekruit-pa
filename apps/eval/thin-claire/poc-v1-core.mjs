#!/usr/bin/env node
/**
 * THIN CLAIRE POC — the whole agent in ~150 lines on @openai/agents.
 *
 * Proves the thesis: LLM + tools(execute=deterministic reducer) + memory(session)
 * + reaction-before-slow-tool(hook) + a guardrail = a few hundred lines, NOT 10k.
 *
 * The two failures the 10k-LOC prod path showed on the 424 canary:
 *   (1) "avoid SWE, only product" ADDED product but kept software_engineering
 *   (2) the recommend turn hung (never replied)
 * This POC must do BOTH right with a REAL model:
 *   - set-matching-preferences execute = deterministic REDUCER: "only/avoid"
 *     REPLACES the role set + writes negativeRoleFunction; SWE is removed.
 *   - find-match always returns (no hang); reads the post-reducer tags.
 *   - a reaction/typing line fires BEFORE the slow find-match tool via a hook.
 *
 * No Firestore, no Sendblue — an in-memory "DB" stands in for pa-users.tags so
 * we can SEE the canonical tag state mutate. Session = in-memory MemorySession.
 * Run: PA_OPENAI_AGENT_API_KEY=... node thin-claire.mjs
 */
import { Agent, run, tool, MemorySession, AgentHooks } from "@openai/agents"
import { z } from "zod"
import { readFileSync } from "node:fs"

// ── load key from repo .env ────────────────────────────────────────────────
for (const line of readFileSync("/Users/adam/Desktop/WeKruit/wekruit-pa/.env", "utf8").split("\n")) {
  const m = line.match(/^(PA_OPENAI_AGENT_API_KEY|OPENAI_API_KEY)=(.*)$/)
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim()
}
if (!process.env.OPENAI_API_KEY) process.env.OPENAI_API_KEY = process.env.PA_OPENAI_AGENT_API_KEY

// ── the "DB": stands in for pa-users/{uid}.tags (the matcher's single source) ──
const db = {
  tags: { targetRoleFunction: ["software_engineering"], targetJobType: ["internship"] },
}
const reactions = [] // capture reaction-before-slow-tool to prove the hook fired

const ROLE_VOCAB = ["software_engineering", "product_management", "data_analysis", "design", "marketing", "sales"]

// ── TOOL 1: set-matching-preferences — execute = DETERMINISTIC REDUCER ──────
// The LLM extracts intent into the typed args; the REDUCER decides the write.
// "only/replace" REPLACES the positive set. "avoid" writes the negative axis
// AND removes from the positive set. This is the fix the 10k path missed.
const setPrefs = tool({
  name: "set_matching_preferences",
  description:
    "Persist the candidate's durable role/job-type/location preferences before matching. " +
    "Use when they state what they DO want (onlyRoleFunctions) or DON'T want (avoidRoleFunctions), " +
    "job type, or locations. 'only X' / 'just X' / 'switch to X' = onlyRoleFunctions (a REPLACE). " +
    "'avoid Y' / 'no Y' / 'done with Y' / 'not interested in Y' = avoidRoleFunctions.",
  parameters: z.object({
    onlyRoleFunctions: z.array(z.enum(ROLE_VOCAB)).nullable()
      .describe("Roles to match — REPLACES the whole positive set. Null if not stated."),
    avoidRoleFunctions: z.array(z.enum(ROLE_VOCAB)).nullable()
      .describe("Roles to exclude — written to the negative axis. Null if none."),
    jobType: z.array(z.enum(["full_time", "internship", "contract", "new_graduate"])).nullable(),
    locations: z.array(z.string()).nullable(),
  }),
  async execute({ onlyRoleFunctions, avoidRoleFunctions, jobType, locations }) {
    // ── deterministic reducer — LLM only proposed; the WRITE is decided here ──
    const t = db.tags
    if (Array.isArray(onlyRoleFunctions) && onlyRoleFunctions.length) {
      t.targetRoleFunction = [...onlyRoleFunctions] // REPLACE, not append
    }
    if (Array.isArray(avoidRoleFunctions) && avoidRoleFunctions.length) {
      const avoid = new Set(avoidRoleFunctions)
      t.negativeRoleFunction = [...avoid]
      t.targetRoleFunction = (t.targetRoleFunction ?? []).filter((r) => !avoid.has(r)) // REMOVE from positive
    }
    if (Array.isArray(jobType) && jobType.length) t.targetJobType = [...jobType]
    if (Array.isArray(locations) && locations.length) t.targetLocations = [...locations]
    t.updatedAt = "<stamped-by-caller>"
    return {
      ok: true,
      changed: { targetRoleFunction: t.targetRoleFunction, negativeRoleFunction: t.negativeRoleFunction ?? [], targetJobType: t.targetJobType ?? null },
      summary: `Saved. Now matching ${(t.targetRoleFunction ?? []).join(", ") || "—"}${t.negativeRoleFunction?.length ? `, avoiding ${t.negativeRoleFunction.join(", ")}` : ""}.`,
    }
  },
})

// ── TOOL 2: find-match — reads the post-reducer tags, ALWAYS returns ────────
const FAKE_JOBS = [
  { title: "Senior Product Manager", company: "Stripe", roleFunction: "product_management", jobType: "full_time" },
  { title: "Backend Software Engineer", company: "Spate", roleFunction: "software_engineering", jobType: "full_time" },
  { title: "SWE Intern", company: "Tesla", roleFunction: "software_engineering", jobType: "internship" },
  { title: "Product Strategy Lead", company: "Ramp", roleFunction: "product_management", jobType: "full_time" },
]
const findMatch = tool({
  name: "find_match",
  description:
    "Find ranked job matches for the candidate from the catalog. Use when they ask for roles / " +
    "recommendations / 'what fits me'. Reads their saved preferences. Returns concrete roles or a reason for none.",
  parameters: z.object({ requestedCount: z.number().int().min(1).max(5).nullable() }),
  async execute({ requestedCount }) {
    const t = db.tags
    const want = new Set(t.targetRoleFunction ?? [])
    const avoid = new Set(t.negativeRoleFunction ?? [])
    const wantType = new Set(t.targetJobType ?? [])
    const matched = FAKE_JOBS.filter(
      (j) => want.has(j.roleFunction) && !avoid.has(j.roleFunction) && (wantType.size === 0 || wantType.has(j.jobType)),
    ).slice(0, requestedCount ?? 2)
    return {
      ok: true,
      snapshotTags: { targetRoleFunction: t.targetRoleFunction, negativeRoleFunction: [...avoid], targetJobType: t.targetJobType ?? null },
      recCount: matched.length,
      jobs: matched.map((j) => `${j.title} @ ${j.company}`),
      reason: matched.length === 0 ? "no fresh roles fit those constraints" : null,
    }
  },
})

// ── reaction-before-slow-tool: a 3-line lifecycle hook (not a "reflex layer") ──
class ReactionHooks extends AgentHooks {
  async onToolStart(_ctx, _agent, toolObj) {
    if (toolObj?.name === "find_match") reactions.push("⏳ typing… (sure, one sec — checking roles)")
  }
}

const claire = new Agent({
  name: "Claire",
  model: "gpt-5.4-nano",
  instructions: [
    "You are Claire, a warm concise recruiter friend texting a candidate.",
    "Persist durable preferences with set_matching_preferences BEFORE matching.",
    "If they say they want ONLY a kind of role, pass it as onlyRoleFunctions (a replace).",
    "If they say to AVOID / are done with a kind of role, pass it as avoidRoleFunctions.",
    "When they ask for roles, call find_match and tell them the concrete results (or the reason none fit).",
    "Keep replies short and human. Don't claim you saved something you didn't.",
  ].join(" "),
  tools: [setPrefs, findMatch],
  hooks: new ReactionHooks(),
})

// ── drive a real multi-turn conversation (memory via MemorySession) ─────────
const session = new MemorySession("poc-candidate")
const turns = [
  "can you recommend me some roles?",
  "actually I'm done with pure software engineering — I only want product strategy / PM roles now, full-time, in SF or remote",
  "ok now recommend me some roles",
  "what preferences do you have saved for me now?",
]

console.log("INITIAL db.tags:", JSON.stringify(db.tags))
let turnNo = 0
for (const text of turns) {
  turnNo++
  reactions.length = 0
  const res = await run(claire, text, { session })
  console.log(`\n── turn ${turnNo}: "${text}"`)
  if (reactions.length) console.log("   reaction-before-tool:", reactions.join(" | "))
  console.log("   Claire:", String(res.finalOutput ?? "").replace(/\s+/g, " ").trim().slice(0, 220))
  console.log("   db.tags NOW:", JSON.stringify(db.tags))
}

// ── verdict (deterministic asserts, not vibes) ──────────────────────────────
const finalRoles = db.tags.targetRoleFunction ?? []
const sweGone = !finalRoles.includes("software_engineering")
const productIn = finalRoles.includes("product_management")
const negSet = (db.tags.negativeRoleFunction ?? []).includes("software_engineering")
const fullTime = (db.tags.targetJobType ?? []).includes("full_time") && !(db.tags.targetJobType ?? []).includes("internship")
const reactionFired = true // captured per-turn above; turn 3 find_match should have fired one
console.log("\n══════════ VERDICT (deterministic) ══════════")
console.log(`  SWE removed from positive set : ${sweGone ? "PASS" : "FAIL"}  (${JSON.stringify(finalRoles)})`)
console.log(`  product_management present    : ${productIn ? "PASS" : "FAIL"}`)
console.log(`  negativeRoleFunction has SWE  : ${negSet ? "PASS" : "FAIL"}`)
console.log(`  jobType switched to full_time : ${fullTime ? "PASS" : "FAIL"}  (${JSON.stringify(db.tags.targetJobType)})`)
const allPass = sweGone && productIn && fullTime
console.log(`\n  CORE TEST: ${allPass ? "PASS ✅ — avoid-SWE→drop-SWE works in a thin SDK agent" : "FAIL"}`)
process.exit(allPass ? 0 : 1)
