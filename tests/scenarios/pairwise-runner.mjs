#!/usr/bin/env node
/**
 * Phase 18 — pairwise voice eval runner (baseline vs Voice v1 candidate).
 *
 * Bypasses the Firestore broker path used by `runner.mjs` because the goal
 * here is pure prompt comparison — not orchestrator-stack integration. We
 * call the OpenAI Responses API directly with each system prompt + the
 * scenario's last user turn and compare the replies via `judgePairwise`.
 *
 * Usage:
 *   PA_OPENAI_AGENT_API_KEY=sk-... \
 *     node tests/scenarios/pairwise-runner.mjs            # all eval-voice-*
 *   PA_OPENAI_AGENT_API_KEY=sk-... \
 *     node tests/scenarios/pairwise-runner.mjs --scenarios "eval-voice-*"
 *
 *   node tests/scenarios/pairwise-runner.mjs --dry-run   # plan only
 *
 * Cost: 2 model calls + 2 judge calls per scenario. With 6 scenarios that
 * is ~24 nano calls (~$0.05). Respects PA_EVAL_MAX_RUN_USD.
 */
import { readFile, readdir } from "node:fs/promises"
import { resolve, join, basename, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { parse as parseYaml } from "yaml"
import OpenAI from "openai"

import { runPairwise, summarizePairwise } from "./lib/pairwise.mjs"
import { judgePairwise, JUDGE_MODEL, projectJudgeCostUsd } from "./judge.mjs"

const __dirname = dirname(fileURLToPath(import.meta.url))
const SCENARIOS_DIR = resolve(__dirname, "scenarios")
const BASELINE_PATH = resolve(__dirname, "lib/voice_baseline.json")
const SEED_PATH = resolve(__dirname, "../../packages/agent-registry/src/seed.json")

const DEFAULT_MAX_USD = Number(process.env.PA_EVAL_MAX_RUN_USD ?? 5)
const DEFAULT_FILTER = "eval-voice-*"
const REPLY_MODEL = process.env.PA_PAIRWISE_REPLY_MODEL || "gpt-5.4-nano"

function parseArgs(argv) {
  const args = { dryRun: false, filter: DEFAULT_FILTER }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === "--dry-run") args.dryRun = true
    else if (a === "--scenarios") args.filter = argv[++i] ?? args.filter
    else if (a === "--gate") args.gate = Number(argv[++i])
  }
  return args
}

function globMatches(filter, name) {
  const re = new RegExp("^" + filter.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$")
  return re.test(name)
}

async function loadScenarios(filter) {
  const entries = await readdir(SCENARIOS_DIR)
  const matches = entries
    .filter((f) => (f.endsWith(".yaml") || f.endsWith(".yml")) && globMatches(filter, f))
    .sort()
  const scenarios = []
  for (const f of matches) {
    const raw = await readFile(join(SCENARIOS_DIR, f), "utf8")
    const parsed = parseYaml(raw)
    parsed.__file = f
    scenarios.push(parsed)
  }
  return scenarios
}

async function loadPrompts() {
  const baseline = JSON.parse(await readFile(BASELINE_PATH, "utf8"))
  const seed = JSON.parse(await readFile(SEED_PATH, "utf8"))
  const defaultAgent = seed.find((a) => a.id === "default") ?? seed[0]
  return {
    baseline: baseline.systemPrompt,
    candidate: defaultAgent.systemPrompt,
    candidateVersion: defaultAgent.version,
  }
}

let _openai = null
function getClient() {
  if (_openai) return _openai
  const apiKey = process.env.PA_OPENAI_AGENT_API_KEY?.trim()
  if (!apiKey) throw new Error("PA_OPENAI_AGENT_API_KEY required")
  _openai = new OpenAI({
    apiKey,
    baseURL: process.env.PA_OPENAI_AGENT_BASE_URL?.trim() || "https://api.openai.com/v1",
  })
  return _openai
}

/** Direct system+user → reply via Responses API. */
async function makeReply({ systemPrompt, userTurn, transcript }) {
  const client = getClient()
  const input = [{ role: "system", content: systemPrompt }]
  for (const t of transcript ?? []) {
    input.push({ role: t.role, content: t.content })
  }
  input.push({ role: "user", content: userTurn })
  const resp = await client.responses.create({
    model: REPLY_MODEL,
    input,
    max_output_tokens: 400,
  })
  // Extract first text item.
  const items = Array.isArray(resp.output) ? resp.output : []
  for (const item of items) {
    if (Array.isArray(item.content)) {
      for (const c of item.content) {
        if ((c.type === "output_text" || c.type === "text") && typeof c.text === "string") {
          return c.text
        }
      }
    }
  }
  return resp.output_text ?? ""
}

function makeLedger(maxUsd) {
  let total = 0
  return {
    get total() { return total },
    preflight() {
      const projected = total + projectJudgeCostUsd()
      if (projected > maxUsd) {
        return `cost ceiling ${maxUsd} would be exceeded (current ${total.toFixed(4)} + projected ${projectJudgeCostUsd().toFixed(4)})`
      }
      return null
    },
    record(c) { total += Number.isFinite(c) ? c : 0 },
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const scenarios = await loadScenarios(args.filter)
  if (scenarios.length === 0) {
    console.error(`No scenarios matched filter "${args.filter}"`)
    process.exit(2)
  }
  const prompts = await loadPrompts()

  if (args.dryRun) {
    const projected = scenarios.length * 2 * projectJudgeCostUsd() // 2 judge calls/scenario
    console.log(JSON.stringify({
      mode: "dry-run",
      scenarios: scenarios.map((s) => ({ id: s.id, file: s.__file })),
      candidateVersion: prompts.candidateVersion,
      replyModel: REPLY_MODEL,
      judgeModel: JUDGE_MODEL,
      projectedCallsPerScenario: { reply: 2, judge: 2 },
      projectedJudgeCostUsd: Number(projected.toFixed(6)),
      maxRunUsd: DEFAULT_MAX_USD,
    }, null, 2))
    return
  }

  const ledger = makeLedger(DEFAULT_MAX_USD)
  const results = []
  for (const scenario of scenarios) {
    process.stderr.write(`▶ ${scenario.__file} ... `)
    try {
      const r = await runPairwise({
        scenario,
        baselinePrompt: prompts.baseline,
        candidatePrompt: prompts.candidate,
        runReply: makeReply,
        judge: async (args) => {
          const out = await judgePairwise(args)
          ledger.record(out.costUsd)
          return out
        },
        preflight: () => ledger.preflight(),
      })
      results.push({ id: scenario.id, file: scenario.__file, ...r })
      process.stderr.write(`${r.winner}${r.autoFail ? ` (autofail:${r.autoFail})` : ""}\n`)
      if (r.aborted) {
        process.stderr.write(`[abort] ${r.aborted}\n`)
        break
      }
    } catch (err) {
      process.stderr.write(`ERROR: ${err.message ?? err}\n`)
      results.push({ id: scenario.id, file: scenario.__file, winner: "tie", error: String(err.message ?? err) })
    }
  }

  const summary = summarizePairwise(results, { gateThreshold: args.gate ?? 0.7 })
  const report = {
    candidateVersion: prompts.candidateVersion,
    replyModel: REPLY_MODEL,
    judgeModel: JUDGE_MODEL,
    summary,
    judgeCostUsd: Number(ledger.total.toFixed(6)),
    results: results.map((r) => ({
      id: r.id,
      file: r.file,
      winner: r.winner,
      baselineReply: r.baselineReply?.slice(0, 200),
      candidateReply: r.candidateReply?.slice(0, 200),
      autoFail: r.autoFail,
      judgeRationales: (r.judgeCalls ?? []).map((c) => c.rationale),
      error: r.error ?? null,
    })),
  }
  console.log(JSON.stringify(report, null, 2))
  process.exit(summary.gateMet ? 0 : 1)
}

const __isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]
if (__isMain) {
  main().catch((err) => {
    console.error("[pairwise-runner] fatal:", err)
    process.exit(1)
  })
}
