#!/usr/bin/env node
/**
 * WS-delivery eval — production delivery reflexes (mark-read + typing) + LLM-decided delivery
 * tools (react/status/no-reply) + a recording (dryRun) createSendblueTransport. Mirrors poc-v2
 * 4/4. Real gpt-5.4-nano, in-process, no deploy. A LOCAL stub `find_match` tool triggers the
 * typing reflex (keyed on tool name) without WS-tools' real find_match.
 *
 * Loaded via the shared esbuild-bundle harness (_claire-bundle.mjs) so the SDK loads as compiled
 * .js on the zod@4 graph — no tsx intercepting @openai/agents-core against zod@3.
 * Run: source ~/.zshrc && nvm use 24 && node apps/eval/thin-claire/eval-delivery.mjs
 */
import { loadClaireBundle, loadEnv } from "./_claire-bundle.mjs"

loadEnv()
const {
  Agent,
  run,
  tool,
  MemorySession,
  z,
  buildDeliveryTools,
  markReadReflex,
  wireTypingReflex,
  deliverFinalText,
  createSendblueTransport,
} = await loadClaireBundle()

// ── recording transport = production createSendblueTransport in dryRun ──
// dryRun makes every method record {kind,value} into recordedEvents and skip the
// real Sendblue / pa-outbound calls. inboundMessageHandle present so tapback is
// not no-op'd. db is unused in dryRun.
function makeTransport() {
  return createSendblueTransport({
    db: {},
    toE164: "+15551230000",
    inboundMessageHandle: "msg-handle-eval",
    userId: "eval-user",
    sessionId: "eval-session",
    dryRun: true,
  })
}

function makeCtx(transport) {
  return {
    db: {},
    userId: "eval-user",
    sessionId: "eval-session",
    lang: "en",
    transport,
    judgeModel: "gpt-5.4-nano",
    log: () => {},
    nowIso: () => new Date().toISOString(),
  }
}

// LOCAL stub "find_match" (exact name) so the typing reflex (keyed on tool name)
// fires. Returns a fixed result; we do NOT need WS-tools' real find_match.
function makeFindMatchStub() {
  return tool({
    name: "find_match",
    description: "Find ranked roles from the catalog (slow). Use when they ask for roles/recommendations.",
    parameters: z.object({ requestedCount: z.number().int().min(1).max(5).nullable() }),
    async execute({ requestedCount }) {
      const jobs = [
        "Senior Product Manager @ Stripe",
        "Product Strategy Lead @ Ramp",
      ].slice(0, requestedCount ?? 2)
      return { ok: true, recCount: jobs.length, jobs }
    },
  })
}

const INSTRUCTIONS = [
  "You are Claire, a warm concise recruiter friend on iMessage. Text short (1-2 sentences), lowercase-ok,",
  "use 2025 slang naturally matching their register, no markdown, never say you're an AI.",
  "MATCHING: when they ask for roles/recommendations, call send_status_then_continue first (a quick 'one sec'),",
  "THEN call find_match, THEN tell them the results in text.",
  "DELIVERY: a low-info ack ('sure'/'ok'/'yes'/'k') when there is NOTHING new to answer → call react_to_user (a tapback) and send NO text.",
  "A substantive question → reply in text, never a bare tapback. If truly nothing is needed, you may no_reply.",
  "Don't claim you saved/changed something you didn't.",
].join(" ")

function makeAgent(ctx) {
  const agent = new Agent({
    name: "Claire",
    model: "gpt-5.4-nano",
    instructions: INSTRUCTIONS,
    tools: [...buildDeliveryTools(ctx), makeFindMatchStub()],
  })
  // production typing reflex — agent.on("agent_tool_start"), fires on find_match
  wireTypingReflex(agent, ctx)
  return agent
}

// one inbound turn: mark-read reflex (every inbound, pre-run) → run → post-run
// text via the production deliverFinalText (unless a delivery tool handled it).
async function handleInbound(agent, session, ctx, text) {
  await markReadReflex(ctx)
  const res = await run(agent, text, { session })
  const out = String(res.finalOutput ?? "").trim()
  const deliveredViaTool = ctx.transport.recordedEvents.some((e) =>
    ["tapback", "no_reply"].includes(e.kind),
  )
  await deliverFinalText(ctx, out, deliveredViaTool)
  return out
}

const kindsOf = (t) => t.recordedEvents.map((e) => e.kind)
const summary = (t) =>
  t.recordedEvents.map((e) => (e.value ? `${e.kind}(${String(e.value).slice(0, 32)})` : e.kind)).join(" → ")

// reset the recorded-events ledger between turns (mirror poc sb.reset()).
const resetLedger = (t) => {
  t.recordedEvents.length = 0
}

// ── cases ──
const CASES = [
  {
    name: "mark-read fires on EVERY inbound (deterministic reflex)",
    llm: false,
    async run() {
      const transport = makeTransport()
      const ctx = makeCtx(transport)
      const agent = makeAgent(ctx)
      const session = new MemorySession("eval-markread")
      // three different inbound turns; mark-read must lead every one.
      for (const text of ["hey", "what's up", "cool thanks"]) {
        resetLedger(transport)
        await handleInbound(agent, session, ctx, text)
        const k = kindsOf(transport)
        if (k[0] !== "mark_read") return `mark-read not first on "${text}" → ${summary(transport)}`
      }
      return null
    },
  },
  {
    name: "recommend → status (before find_match) + typing (find_match ran) + text; never hangs",
    llm: true,
    async run() {
      const transport = makeTransport()
      const ctx = makeCtx(transport)
      const agent = makeAgent(ctx)
      const session = new MemorySession("eval-recommend")
      resetLedger(transport)
      await handleInbound(agent, session, ctx, "can you recommend me some roles?")
      const k = kindsOf(transport)
      if (!k.includes("mark_read")) return `no mark-read reflex → ${summary(transport)}`
      if (!k.includes("status")) return `no status bubble before slow tool → ${summary(transport)}`
      if (!k.includes("typing")) return `find_match should have run + fired typing reflex → ${summary(transport)}`
      if (!k.includes("text")) return `no final result text (hung?) → ${summary(transport)}`
      // ordering: status must precede typing (status bubble before the slow tool)
      if (k.indexOf("status") > k.indexOf("typing"))
        return `status came AFTER typing → ${summary(transport)}`
      return null
    },
  },
  {
    name: "low-info 'sure' after a Claire STATEMENT → tapback OR no_reply, NOT text",
    llm: true,
    async run() {
      const transport = makeTransport()
      const ctx = makeCtx(transport)
      const agent = makeAgent(ctx)
      const session = new MemorySession("eval-ack")
      // prime with a Claire STATEMENT (not a question) so "sure" is a pure low-info ack.
      await handleInbound(
        agent,
        session,
        ctx,
        "cool, i'll keep an eye out and ping you when fresh product roles drop",
      )
      resetLedger(transport)
      await handleInbound(agent, session, ctx, "sure")
      const k = kindsOf(transport)
      if (k.includes("text")) return `texted a low-info ack (should tapback/no-reply) → ${summary(transport)}`
      if (!k.includes("tapback") && !k.includes("no_reply"))
        return `neither tapback nor no_reply for 'sure' → ${summary(transport)}`
      return null
    },
  },
  {
    name: "substantive question → text, never a bare tapback",
    llm: true,
    async run() {
      const transport = makeTransport()
      const ctx = makeCtx(transport)
      const agent = makeAgent(ctx)
      const session = new MemorySession("eval-substantive")
      resetLedger(transport)
      await handleInbound(agent, session, ctx, "wait what do you actually know about my background?")
      const k = kindsOf(transport)
      if (k.includes("tapback") && !k.includes("text"))
        return `tapback-only on a substantive question → ${summary(transport)}`
      if (!k.includes("text")) return `no text answer to a substantive question → ${summary(transport)}`
      return null
    },
  },
]

async function attempt(c) {
  try {
    return await c.run()
  } catch (e) {
    return `THREW: ${e?.message ?? e}`
  }
}

async function main() {
  let fails = 0
  for (const c of CASES) {
    let err
    if (c.llm) {
      // best-of-3 for the real-model cases: a true design regression fails all 3.
      err = await attempt(c)
      for (let i = 2; err && i <= 3; i++) err = await attempt(c)
    } else {
      err = await attempt(c)
    }
    if (err) {
      console.log(`FAIL  ${c.name}\n        → ${err}`)
      fails++
    } else {
      console.log(`PASS  ${c.name}`)
    }
  }
  console.log(
    `\n${fails === 0 ? "ALL PASS ✅ — production delivery reflexes + tools + recording transport (real model, no deploy)" : `${fails}/${CASES.length} FAILED`}`,
  )
  process.exit(fails === 0 ? 0 : 1)
}

await main()
