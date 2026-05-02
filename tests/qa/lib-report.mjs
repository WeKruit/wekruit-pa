/**
 * Phase 50 — shared per-agent REPORT.md writer.
 * Each agent writes a markdown file to tests/qa/.results/<run-id>/<agent>/REPORT.md
 * with a uniform header so the aggregator can grep for PASS/FAIL counts.
 */
import { mkdirSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = dirname(fileURLToPath(import.meta.url))
export const RESULTS_ROOT = resolve(__dirname, ".results")

export function ensureDir(p) {
  mkdirSync(p, { recursive: true })
}

/**
 * @param {object} args
 * @param {string} args.runId
 * @param {string} args.agent       e.g. "ux", "resume", "convo", "match"
 * @param {Array<{ persona: string, language: 'zh'|'en', pass: boolean, p0: boolean, details: string }>} args.results
 * @param {string} [args.notes]
 * @returns {string} full path of the written REPORT.md
 */
export function writeAgentReport({ runId, agent, results, notes = "" }) {
  const dir = resolve(RESULTS_ROOT, runId, agent)
  ensureDir(dir)
  const passCount = results.filter((r) => r.pass).length
  const total = results.length
  const p0Failures = results.filter((r) => !r.pass && r.p0).length
  const overall = p0Failures === 0 ? "PASS" : "FAIL"

  const lines = []
  lines.push(`# QA Agent: ${agent}`)
  lines.push("")
  lines.push(`- runId: \`${runId}\``)
  lines.push(`- agent: \`${agent}\``)
  lines.push(`- result: **${overall}**`)
  lines.push(`- personas: ${total}`)
  lines.push(`- pass: ${passCount}`)
  lines.push(`- fail: ${total - passCount}`)
  lines.push(`- P0 failures: ${p0Failures}`)
  lines.push(`- generatedAt: ${new Date().toISOString()}`)
  if (notes) {
    lines.push("")
    lines.push("## Notes")
    lines.push(notes)
  }
  lines.push("")
  lines.push("## Per-persona")
  lines.push("")
  lines.push("| persona | lang | pass | P0 | details |")
  lines.push("|---------|------|------|----|---------|")
  for (const r of results) {
    const passMark = r.pass ? "OK" : "FAIL"
    const p0Mark = r.p0 ? "yes" : "no"
    const details = (r.details ?? "").replace(/\|/g, "/").slice(0, 240)
    lines.push(`| ${r.persona} | ${r.language} | ${passMark} | ${p0Mark} | ${details} |`)
  }
  lines.push("")

  const path = resolve(dir, "REPORT.md")
  writeFileSync(path, lines.join("\n"), "utf8")
  return { path, overall, passCount, total, p0Failures }
}
