#!/usr/bin/env node
/**
 * Phase 50 — QA team aggregator.
 *
 * Spawns the 4 specialized QA agents in parallel via child_process, captures
 * stdout + exit codes, then aggregates each REPORT.md into one SUMMARY.md
 * under tests/qa/.results/<run-id>/. Exits non-zero if ANY agent reports a
 * P0 failure.
 *
 * Cost: $0 in dry mode (default). Each agent does deterministic / static
 * checks against persona fixtures. Live mode (PA_QA_LIVE=1) is documented
 * in .planning/phases/50-e2e-qa-team/DELIVERY.md.
 *
 * Usage:
 *   npm run qa:v1.5
 *   node tests/qa/run-all.mjs                # full suite, dry mode
 *   PA_QA_LIVE=1 node tests/qa/run-all.mjs   # live mode (requires creds)
 */
import { spawn } from "node:child_process"
import { readFileSync, writeFileSync, existsSync } from "node:fs"
import { resolve, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { randomUUID } from "node:crypto"

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(__dirname, "..", "..")
const RUN_ID = process.env.QA_RUN_ID ?? `r-${Date.now()}-${randomUUID().slice(0, 8)}`

const AGENTS = [
  { id: "ux", script: "tests/qa/agent-ux.mjs" },
  { id: "resume", script: "tests/qa/agent-resume.mjs" },
  { id: "convo", script: "tests/qa/agent-convo.mjs" },
  { id: "match", script: "tests/qa/agent-match.mjs" },
]

function runAgent(agent) {
  return new Promise((res) => {
    const proc = spawn(
      process.execPath,
      [agent.script, "--run-id", RUN_ID],
      {
        cwd: REPO_ROOT,
        env: { ...process.env, QA_RUN_ID: RUN_ID },
        stdio: ["ignore", "pipe", "pipe"],
      }
    )
    let stdout = ""
    let stderr = ""
    proc.stdout.on("data", (d) => { stdout += d })
    proc.stderr.on("data", (d) => { stderr += d })
    proc.on("close", (code) => {
      res({ agent: agent.id, code, stdout: stdout.trim(), stderr: stderr.trim() })
    })
  })
}

console.log(`[qa:v1.5] runId=${RUN_ID} mode=${process.env.PA_QA_LIVE === "1" ? "LIVE" : "DRY"}`)
console.log(`[qa:v1.5] spawning 4 agents in parallel...`)
const t0 = Date.now()
const results = await Promise.all(AGENTS.map(runAgent))
const wallMs = Date.now() - t0
console.log(`[qa:v1.5] all agents finished in ${wallMs}ms`)

// ---------- aggregate per-agent REPORT.md ----------

const summaryLines = []
summaryLines.push(`# v1.5 QA Suite — SUMMARY`)
summaryLines.push("")
summaryLines.push(`- runId: \`${RUN_ID}\``)
summaryLines.push(`- mode: \`${process.env.PA_QA_LIVE === "1" ? "LIVE" : "DRY"}\``)
summaryLines.push(`- wallMs: ${wallMs}`)
summaryLines.push(`- generatedAt: ${new Date().toISOString()}`)
summaryLines.push(`- agents: ${AGENTS.length}`)
summaryLines.push("")

let anyP0Fail = false
let anyAgentNonZero = false
const tally = []

for (const r of results) {
  const reportPath = resolve(REPO_ROOT, "tests/qa/.results", RUN_ID, r.agent, "REPORT.md")
  let header = "missing"
  let stats = "n/a"
  let agentOverall = "FAIL"
  let langTally = { zh: { pass: 0, fail: 0 }, en: { pass: 0, fail: 0 } }
  if (existsSync(reportPath)) {
    const md = readFileSync(reportPath, "utf8")
    const m = md.match(/result:\s*\*\*(PASS|FAIL)\*\*/)
    agentOverall = m ? m[1] : "FAIL"
    const passM = md.match(/- pass:\s*(\d+)/)
    const totalM = md.match(/- personas:\s*(\d+)/)
    const p0M = md.match(/- P0 failures:\s*(\d+)/)
    const passN = passM ? Number(passM[1]) : -1
    const totalN = totalM ? Number(totalM[1]) : -1
    const p0N = p0M ? Number(p0M[1]) : -1
    stats = `${passN}/${totalN} pass, P0 fails ${p0N}`
    header = `${agentOverall}`
    if (p0N > 0) anyP0Fail = true

    // Bilingual symmetry — count pass/fail per lang from the table
    const tableLines = md.split("\n").filter((l) => l.startsWith("| ") && l.includes(" | zh ") || (l.startsWith("| ") && l.includes(" | en ")))
    for (const line of tableLines) {
      const cols = line.split("|").map((c) => c.trim())
      // | persona | lang | pass | P0 | details |
      const lang = cols[2]
      const passWord = cols[3]
      if (lang === "zh" || lang === "en") {
        if (passWord === "OK") langTally[lang].pass += 1
        else langTally[lang].fail += 1
      }
    }
  }
  if (r.code !== 0) anyAgentNonZero = true
  tally.push({ agent: r.agent, header, stats, exitCode: r.code, langTally })
}

// Build agent table
summaryLines.push("## Per-agent results")
summaryLines.push("")
summaryLines.push("| agent | result | stats | exit |")
summaryLines.push("|-------|--------|-------|------|")
for (const t of tally) {
  summaryLines.push(`| ${t.agent} | ${t.header} | ${t.stats} | ${t.exitCode} |`)
}
summaryLines.push("")

// Bilingual symmetry table
summaryLines.push("## Bilingual symmetry (per-agent zh vs en)")
summaryLines.push("")
summaryLines.push("| agent | zh pass/fail | en pass/fail | symmetric? |")
summaryLines.push("|-------|--------------|--------------|------------|")
let allSymmetric = true
for (const t of tally) {
  const zh = t.langTally.zh
  const en = t.langTally.en
  const sym = (zh.fail === 0 && en.fail === 0) || (zh.fail === en.fail)
  if (!sym) allSymmetric = false
  summaryLines.push(`| ${t.agent} | ${zh.pass}/${zh.fail} | ${en.pass}/${en.fail} | ${sym ? "yes" : "no"} |`)
}
summaryLines.push("")

// Gate
const gateOk = !anyP0Fail && !anyAgentNonZero && allSymmetric
summaryLines.push("## Gate")
summaryLines.push("")
summaryLines.push(`- any P0 failure: **${anyP0Fail}**`)
summaryLines.push(`- any agent non-zero exit: **${anyAgentNonZero}**`)
summaryLines.push(`- bilingual symmetry: **${allSymmetric ? "ok" : "BROKEN"}**`)
summaryLines.push(`- overall: **${gateOk ? "PASS" : "FAIL"}**`)
summaryLines.push("")

// Per-agent stdout dump (debugging)
summaryLines.push("## Agent stdout")
summaryLines.push("")
for (const r of results) {
  summaryLines.push(`### ${r.agent}`)
  summaryLines.push("")
  summaryLines.push("```")
  summaryLines.push(r.stdout || "(no stdout)")
  if (r.stderr) {
    summaryLines.push("--- stderr ---")
    summaryLines.push(r.stderr)
  }
  summaryLines.push("```")
  summaryLines.push("")
}

const summaryPath = resolve(REPO_ROOT, "tests/qa/.results", RUN_ID, "SUMMARY.md")
writeFileSync(summaryPath, summaryLines.join("\n"), "utf8")

console.log("")
console.log("==================== SUMMARY ====================")
for (const t of tally) {
  console.log(`  ${t.agent}: ${t.header} (${t.stats})`)
}
console.log("=================================================")
console.log(`[qa:v1.5] gate: ${gateOk ? "PASS" : "FAIL"}`)
console.log(`[qa:v1.5] summary: ${summaryPath}`)

process.exit(gateOk ? 0 : 1)
