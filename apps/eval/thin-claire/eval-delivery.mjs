#!/usr/bin/env node
/**
 * eval-delivery.mjs — WS-delivery production L3 eval (real gpt-5.4-nano, exit 0/1).
 *
 * Mirrors poc-v2's 4/4 delivery contract, but drives the PRODUCTION delivery
 * layer instead of the POC's inline copy:
 *   - buildDeliveryTools(ctx)            ← apps/functions/.../tools/delivery-tools.ts
 *   - markReadReflex / wireTypingReflex  ← apps/functions/.../delivery.ts
 *   - createSendblueTransport({dryRun})  ← apps/functions/.../transport.ts  (the
 *        RECORDING ClaireTransport: every method records {kind,value} into
 *        `recordedEvents` and makes NO real Sendblue / pa-outbound call)
 *
 * To trigger the typing-before-slow-tool reflex we register a LOCAL stub tool
 * named EXACTLY "find_match" (returns a fixed result) alongside the production
 * delivery tools — the reflex keys on the tool NAME, so we don't need WS-tools'
 * real find_match.
 *
 * Asserts, per inbound turn:
 *   1. mark-read fires on EVERY inbound (markReadReflex is called before run()).
 *   2. "recommend me roles" → events include status (before find_match) + typing
 *      (find_match ran) + text result; never hangs.
 *   3. low-info "sure" after a Claire STATEMENT → tapback OR no_reply, NOT text.
 *   4. substantive question → text, never a bare tapback.
 * best-of-3 for the LLM-driven cases (loop internally). PASS/FAIL + exit(0/1).
 *
 * Run: source ~/.zshrc && nvm use 24 && node apps/eval/thin-claire/eval-delivery.mjs
 * (self-bootstraps: symlinks node_modules → agent-runtime, writes a tsx tsconfig
 *  that remaps @openai/agents + zod to the v4 graph for the production .ts files,
 *  then re-execs itself under `node --import tsx`.)
 */
import { createRequire } from "node:module"
import { fileURLToPath, pathToFileURL } from "node:url"
import { dirname, join } from "node:path"
import { tmpdir } from "node:os"
import {
  existsSync,
  symlinkSync,
  readFileSync,
  writeFileSync,
  realpathSync,
} from "node:fs"
import { spawnSync } from "node:child_process"

const here = dirname(fileURLToPath(import.meta.url))

// ── self-bootstrap: ensure node_modules symlink + tsx + path-remap tsconfig ──
const BOOTSTRAPPED = process.env.__EVAL_DELIVERY_BOOTSTRAPPED === "1"
if (!BOOTSTRAPPED) {
  const nm = join(here, "node_modules")
  const rtTarget = join(here, "../../../packages/agent-runtime/node_modules")
  if (!existsSync(nm)) {
    try {
      symlinkSync(rtTarget, nm)
    } catch (e) {
      console.error(`could not symlink node_modules → ${rtTarget}: ${e?.message ?? e}`)
    }
  }
  // Remap the bare specifiers used by the PRODUCTION delivery-tools.ts (which
  // lives under apps/functions, where zod is pinned to v3 and crashes the SDK
  // at import). Point them at agent-runtime's v4 graph — the proven POC graph.
  const rt = realpathSync(rtTarget)
  // Write to the OS temp dir (not the repo tree) so no untracked artifact with a
  // machine-specific absolute path is ever left under apps/eval/thin-claire.
  const tsconfigPath = join(tmpdir(), `claire-eval-delivery-tsconfig-${process.pid}.json`)
  writeFileSync(
    tsconfigPath,
    JSON.stringify(
      {
        compilerOptions: {
          module: "NodeNext",
          moduleResolution: "NodeNext",
          target: "ES2022",
          baseUrl: ".",
          paths: {
            "@openai/agents": [`${rt}/@openai/agents/dist/index.mjs`],
            "@openai/agents/*": [`${rt}/@openai/agents/dist/*`],
            zod: [`${rt}/zod/index.js`],
            "zod/*": [`${rt}/zod/*`],
          },
        },
      },
      null,
      2,
    ),
  )
  // Resolve tsx's ESM loader from the symlinked node_modules (root cwd has no
  // tsx). `--import <abs file url>` is robust regardless of cwd.
  const req = createRequire(join(here, "node_modules", "_eval_.js"))
  const tsxLoader = pathToFileURL(req.resolve("tsx")).href
  const r = spawnSync(
    process.execPath,
    ["--import", tsxLoader, fileURLToPath(import.meta.url)],
    {
      stdio: "inherit",
      env: {
        ...process.env,
        __EVAL_DELIVERY_BOOTSTRAPPED: "1",
        TSX_TSCONFIG_PATH: tsconfigPath,
      },
    },
  )
  process.exit(r.status ?? 1)
}

// ── from here we are running under `node --import tsx` with path remapping ──
const { Agent, run, tool, MemorySession } = await import("@openai/agents")
const { z } = await import("zod")
const { buildDeliveryTools } = await import(
  "../../../apps/functions/src/claire-agent/tools/delivery-tools.ts"
)
const { markReadReflex, wireTypingReflex, deliverFinalText } = await import(
  "../../../apps/functions/src/claire-agent/delivery.ts"
)
const { createSendblueTransport } = await import(
  "../../../apps/functions/src/claire-agent/transport.ts"
)

// ── OpenAI key from repo-root .env (same as the POCs) ──
const ENV_PATH = "/Users/adam/Desktop/WeKruit/wekruit-pa/.env"
try {
  for (const line of readFileSync(ENV_PATH, "utf8").split("\n")) {
    const m = line.match(/^(PA_OPENAI_AGENT_API_KEY|OPENAI_API_KEY)=(.*)$/)
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim()
  }
} catch {
  /* worktree may lack .env; rely on exported key */
}
if (!process.env.OPENAI_API_KEY) process.env.OPENAI_API_KEY = process.env.PA_OPENAI_AGENT_API_KEY
if (!process.env.OPENAI_API_KEY) {
  console.error("FAIL: no OPENAI_API_KEY / PA_OPENAI_AGENT_API_KEY available")
  process.exit(1)
}

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
