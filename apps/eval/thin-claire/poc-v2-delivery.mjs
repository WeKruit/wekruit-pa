#!/usr/bin/env node
/**
 * THIN CLAIRE POC v2 — agent + tools + memory + DELIVERY LAYER, ~260 lines.
 * No deploy. Real gpt-5.4-nano. Asserts side-effects in-process.
 *
 * Proves the two things still open:
 *   (1) Humanizer/slang = PROMPT, not 9.5k LOC post-processing.
 *   (2) Delivery (mark-read / typing / tapback-vs-text-vs-no-reply /
 *       send-one-then-wait-then-next) = a deterministic REFLEX (mark-read,
 *       typing) + LLM-DECIDED TOOLS (react_to_user / send_status / no_reply),
 *       NOT a 1000-line regex action-arbiter.
 *
 * Every outward action lands in `sb` (a fake Sendblue) so we can ASSERT the
 * exact channel side-effects per turn: markRead, typing, status bubble, text
 * bubble(s), tapback, or nothing. This is the eval — see runEval() at bottom.
 *
 * Run: node thin-claire-v2.mjs           # interactive-style trace
 *      node thin-claire-v2.mjs --eval    # assertion harness, exit 0/1
 */
import { Agent, run, tool, MemorySession } from "@openai/agents"
import { z } from "zod"
import { readFileSync } from "node:fs"

for (const line of readFileSync("/Users/adam/Desktop/WeKruit/wekruit-pa/.env", "utf8").split("\n")) {
  const m = line.match(/^(PA_OPENAI_AGENT_API_KEY|OPENAI_API_KEY)=(.*)$/)
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim()
}
if (!process.env.OPENAI_API_KEY) process.env.OPENAI_API_KEY = process.env.PA_OPENAI_AGENT_API_KEY

// ── fake Sendblue: every channel side-effect recorded here (the assertable seam) ──
function makeChannel() {
  const events = [] // {kind:'mark_read'|'typing'|'status'|'text'|'tapback'|'no_reply', value?}
  return {
    events,
    markRead() { events.push({ kind: "mark_read" }) },
    typing() { events.push({ kind: "typing" }) },
    sendStatus(t) { events.push({ kind: "status", value: t }) },
    sendText(t) { events.push({ kind: "text", value: t }) },
    tapback(r) { events.push({ kind: "tapback", value: r }) },
    noReply() { events.push({ kind: "no_reply" }) },
    reset() { events.length = 0 },
    summary() { return events.map((e) => (e.value ? `${e.kind}(${String(e.value).slice(0, 40)})` : e.kind)).join(" → ") },
  }
}

// ── DB stands in for pa-users.tags ──
function makeDb() { return { tags: { targetRoleFunction: ["software_engineering"], targetJobType: ["internship"] } } }
const ROLE_VOCAB = ["software_engineering", "product_management", "data_analysis", "design", "marketing", "sales"]

// ── tools that DECIDE delivery (LLM picks; execute = deterministic channel write) ──
function buildTools(db, sb) {
  const setPrefs = tool({
    name: "set_matching_preferences",
    description:
      "Persist durable role/job-type/location prefs before matching. 'only X / switch to X' → onlyRoleFunctions (REPLACE). " +
      "'avoid Y / done with Y / not interested in Y' → avoidRoleFunctions.",
    parameters: z.object({
      onlyRoleFunctions: z.array(z.enum(ROLE_VOCAB)).nullable(),
      avoidRoleFunctions: z.array(z.enum(ROLE_VOCAB)).nullable(),
      jobType: z.array(z.enum(["full_time", "internship", "contract", "new_graduate"])).nullable(),
      locations: z.array(z.string()).nullable(),
    }),
    async execute({ onlyRoleFunctions, avoidRoleFunctions, jobType, locations }) {
      const t = db.tags
      if (onlyRoleFunctions?.length) t.targetRoleFunction = [...onlyRoleFunctions]
      if (avoidRoleFunctions?.length) {
        const a = new Set(avoidRoleFunctions)
        t.negativeRoleFunction = [...a]
        t.targetRoleFunction = (t.targetRoleFunction ?? []).filter((r) => !a.has(r))
      }
      if (jobType?.length) t.targetJobType = [...jobType]
      if (locations?.length) t.targetLocations = [...locations]
      return { ok: true, tags: t }
    },
  })

  const FAKE_JOBS = [
    { title: "Senior Product Manager", company: "Stripe", roleFunction: "product_management", jobType: "full_time" },
    { title: "Backend SWE", company: "Spate", roleFunction: "software_engineering", jobType: "full_time" },
    { title: "Product Strategy Lead", company: "Ramp", roleFunction: "product_management", jobType: "full_time" },
  ]
  const findMatch = tool({
    name: "find_match",
    description: "Find ranked roles from the catalog (slow). Use when they ask for roles/recommendations.",
    parameters: z.object({ requestedCount: z.number().int().min(1).max(5).nullable() }),
    async execute({ requestedCount }) {
      sb._findMatchCalled = true
      const t = db.tags, want = new Set(t.targetRoleFunction ?? []), avoid = new Set(t.negativeRoleFunction ?? [])
      const wt = new Set(t.targetJobType ?? [])
      const jobs = FAKE_JOBS.filter((j) => want.has(j.roleFunction) && !avoid.has(j.roleFunction) && (wt.size === 0 || wt.has(j.jobType))).slice(0, requestedCount ?? 2)
      return { ok: true, snapshotTags: { targetRoleFunction: t.targetRoleFunction, negativeRoleFunction: [...avoid] }, recCount: jobs.length, jobs: jobs.map((j) => `${j.title} @ ${j.company}`) }
    },
  })

  // ── DELIVERY TOOLS — the LLM chooses how to deliver (replaces the regex arbiter) ──
  const reactToUser = tool({
    name: "react_to_user",
    description:
      "Tapback (heart/like/laugh) the user's last message INSTEAD of a text reply. Use ONLY for low-information acks " +
      "('sure','ok','yes','👍') when no answer/tool is needed — especially while you're already processing something. " +
      "Do NOT use for substantive questions.",
    parameters: z.object({ reaction: z.enum(["love", "like", "laugh", "emphasize"]) }),
    async execute({ reaction }) { sb.tapback(reaction); return { ok: true, delivered: `tapback:${reaction}` } },
  })
  const sendStatusThenContinue = tool({
    name: "send_status_then_continue",
    description:
      "Send a quick one-line status bubble NOW ('sure, one sec…') before a slow tool, so the user isn't left waiting. " +
      "Use right before find_match when matching may take a moment. After this, call the slow tool, then reply with the result.",
    parameters: z.object({ status: z.string() }),
    async execute({ status }) { sb.sendStatus(status); return { ok: true } },
  })
  const noReply = tool({
    name: "no_reply",
    description: "Deliberately send NOTHING (not even a tapback). Use only when the user's message needs no acknowledgement at all.",
    parameters: z.object({ reason: z.string() }),
    async execute({ reason }) { sb.noReply(); return { ok: true, reason } },
  })
  return [setPrefs, findMatch, reactToUser, sendStatusThenContinue, noReply]
}

// ── REFLEX: typing before slow tool — SDK event-emitter (fires BEFORE execute) ──
// Real API in @openai/agents 0.8.5 is `agent.on('agent_tool_start', cb)`, NOT an
// AgentHooks method override. Verified firing order: agent_tool_start → execute.
function wireTypingReflex(agent, sb) {
  agent.on("agent_tool_start", (_ctx, _agentOrTool, maybeTool) => {
    const name = maybeTool?.name ?? _agentOrTool?.name
    if (name === "find_match") sb.typing()
  })
}

const INSTRUCTIONS = [
  "You are Claire, a warm concise recruiter friend on iMessage. Text like a real friend:",
  "short (1-2 sentences), lowercase-ok, use 2025 slang naturally (lfg, cooked, lock in, 卷, 摆烂) matching their register,",
  "no markdown, no repeated openers, never say you're an AI.",
  "Persist durable prefs with set_matching_preferences BEFORE matching ('only X'=replace, 'avoid Y'=negative).",
  "When they ask for roles: call send_status_then_continue first (quick 'one sec'), THEN find_match, THEN tell them the results.",
  "DELIVERY: for a low-info ack like 'sure'/'ok' while you're mid-task, prefer react_to_user (a tapback) over a text reply.",
  "For a substantive question, reply in text — never tapback those. If truly nothing is needed, you may no_reply.",
  "Don't claim you saved something you didn't.",
].join(" ")

function makeAgent(db, sb) {
  const agent = new Agent({ name: "Claire", model: "gpt-5.4-nano", instructions: INSTRUCTIONS, tools: buildTools(db, sb) })
  wireTypingReflex(agent, sb) // 3-line reflex: typing before the slow find_match tool
  return agent
}

// ── one inbound turn = mark-read reflex (always, pre-LLM) → run → text bubble if finalOutput ──
async function handleInbound(agent, session, sb, text) {
  sb.markRead() // ← deterministic reflex: every inbound, immediately, before the model
  const res = await run(agent, text, { session })
  const out = String(res.finalOutput ?? "").trim()
  // if the model produced prose AND didn't already deliver via a delivery tool, send it as text
  const deliveredViaTool = sb.events.some((e) => ["tapback", "no_reply"].includes(e.kind))
  if (out && !deliveredViaTool) sb.sendText(out)
  return out
}

async function runTrace() {
  const db = makeDb(), sb = makeChannel(), agent = makeAgent(db, sb), session = new MemorySession("poc2")
  const turns = [
    "actually I'm done with pure software engineering — only product strategy / PM roles, full-time, SF or remote",
    "can you recommend me some roles?",
    "sure",
    "wait why did you pick those?",
  ]
  console.log("INITIAL tags:", JSON.stringify(db.tags))
  for (const text of turns) {
    sb.reset()
    const out = await handleInbound(agent, session, sb, text)
    console.log(`\n── "${text}"`)
    console.log("   channel:", sb.summary())
    console.log("   tags:", JSON.stringify(db.tags))
  }
}

// ── EVAL HARNESS — assert channel side-effects per scenario, no deploy ──
async function runEval() {
  const cases = [
    {
      name: "avoid-SWE switch removes SWE + writes negative",
      turns: ["I'm done with pure software engineering — only product strategy / PM, full-time, SF or remote"],
      assert: (db, sb) => {
        const r = db.tags.targetRoleFunction ?? []
        if (r.includes("software_engineering")) return "SWE still in positive set"
        if (!r.includes("product_management")) return "product_management missing"
        if (!(db.tags.negativeRoleFunction ?? []).includes("software_engineering")) return "negativeRoleFunction missing SWE"
        if ((db.tags.targetJobType ?? []).includes("internship")) return "internship not dropped"
        return null
      },
    },
    {
      name: "recommend → mark-read + status + result, never hangs (typing fires iff find_match runs)",
      pre: (db) => { db.tags = { targetRoleFunction: ["product_management"], targetJobType: ["full_time"] } },
      turns: ["can you recommend me some roles?"],
      assert: (db, sb) => {
        const k = sb.events.map((e) => e.kind)
        if (!k.includes("mark_read")) return "no mark-read reflex"
        if (!k.includes("status")) return "no status bubble before slow tool"
        if (!k.includes("text")) return "no final result text (hung?)"
        // typing is a hook that fires ONLY when find_match actually executes; if the
        // model answered without re-calling it, that's fine — assert the conditional.
        const calledFindMatch = sb._findMatchCalled === true
        if (calledFindMatch && !k.includes("typing")) return "find_match ran but typing reflex did not fire"
        return null
      },
    },
    {
      name: "low-info 'sure' while processing → tapback, not text",
      pre: (db) => { db.tags = { targetRoleFunction: ["product_management"] } },
      priming: ["can you recommend me some roles?"], // sets "mid-task" context
      turns: ["sure"],
      assert: (db, sb) => {
        const k = sb.events.map((e) => e.kind)
        if (!k.includes("mark_read")) return "no mark-read"
        if (k.includes("text")) return "sent a text reply to a low-info ack (should tapback/no-reply)"
        if (!k.includes("tapback") && !k.includes("no_reply")) return "neither tapback nor no_reply for 'sure'"
        return null
      },
    },
    {
      name: "substantive question → text, never a bare tapback",
      pre: (db) => { db.tags = { targetRoleFunction: ["product_management"] } },
      turns: ["wait what do you actually know about my background?"],
      assert: (db, sb) => {
        const k = sb.events.map((e) => e.kind)
        if (k.includes("tapback") && !k.includes("text")) return "tapback-only on a substantive question"
        if (!k.includes("text")) return "no text answer to a substantive question"
        return null
      },
    },
  ]
  let fails = 0
  for (const c of cases) {
    const db = makeDb(), sb = makeChannel(), agent = makeAgent(db, sb), session = new MemorySession(`eval-${c.name}`)
    if (c.pre) c.pre(db)
    for (const p of c.priming ?? []) { sb.reset(); await handleInbound(agent, session, sb, p) }
    sb.reset()
    for (const t of c.turns) await handleInbound(agent, session, sb, t)
    const err = c.assert(db, sb)
    if (err) { console.log(`FAIL  ${c.name}\n        → ${err}\n        channel: ${sb.summary()}\n        tags: ${JSON.stringify(db.tags)}`); fails++ }
    else console.log(`PASS  ${c.name}   [${sb.summary()}]`)
  }
  console.log(`\n${fails === 0 ? "ALL PASS ✅ — thin agent does delivery decisions + reflexes + reducer, no deploy" : `${fails} FAILED`}`)
  process.exit(fails === 0 ? 0 : 1)
}

if (process.argv.includes("--eval")) await runEval()
else await runTrace()
