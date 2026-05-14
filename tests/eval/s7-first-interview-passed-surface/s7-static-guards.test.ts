import assert from "node:assert/strict"
import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import test from "node:test"

const repoRoot = new URL("../../../", import.meta.url)
const scanRoots = [
  "tests/eval/s7-first-interview-passed-surface",
  "apps/functions/src/admin-passed-candidates.ts",
  "apps/functions/src/identity/candidate-matches-api.ts",
  "apps/dashboard-web/src/pages/PassedCandidates.tsx",
  "apps/dashboard-web/src/pages/PassedCandidates.helpers.ts",
  "apps/pa-landing/src/pages/PublicJob.tsx",
  "apps/pa-landing/src/pages/CandidateMatches.tsx",
]

async function listFiles(relativePath: string): Promise<string[]> {
  const url = new URL(relativePath, repoRoot)
  const statModule = await import("node:fs/promises")
  const stat = await statModule.stat(url)
  if (stat.isFile()) return [relativePath]
  const entries = await readdir(new URL(relativePath + "/", repoRoot), { withFileTypes: true })
  const files: string[] = []
  for (const entry of entries) {
    const next = join(relativePath, entry.name)
    if (entry.isDirectory()) {
      files.push(...await listFiles(next))
    } else if (/\.(ts|tsx|js|mjs)$/.test(entry.name)) {
      files.push(next)
    }
  }
  return files
}

function withoutCommentsAndStrings(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "")
    .replace(/(["'`])(?:\\[\s\S]|(?!\1)[^\\])*\1/g, "\"\"")
}

test("S7 implementation has no broad browsing, live outbound, or domain split regressions", async () => {
  const files = (await Promise.all(scanRoots.map(listFiles))).flat()
  const violations: string[] = []
  const forbidden = [
    { label: "direct provider client import", pattern: /sendblue-client\.js/ },
    { label: "direct provider send function", pattern: /\bsendI[m]essage\b/ },
    { label: "direct Sendblue API URL", pattern: /api\.sendblue\.(?:co|com)|sendblue\.com\/api/ },
    { label: "candidate job route on admin domain", pattern: /wekruit-pa\.web\.app\/j\// },
    { label: "admin route on candidate domain", pattern: /candidate\.wekruit\.com\/admin/ },
  ]

  for (const file of files) {
    const source = await readFile(new URL(file, repoRoot), "utf8")
    const scanned = withoutCommentsAndStrings(source)
    for (const rule of forbidden) {
      if (rule.pattern.test(scanned)) violations.push(`${file}: ${rule.label}`)
    }
    if (file.includes("admin-passed-candidates") && /collection\(\s*["']pa-users["']\s*\)\s*\.where/.test(scanned)) {
      violations.push(`${file}: admin passed surface must not browse pa-users`)
    }
    if (file.includes("PassedCandidates") && /Search|Browse|Schedule|Outreach|Message|Notes/.test(scanned)) {
      violations.push(`${file}: passed surface must stay read-only and job scoped`)
    }
  }

  assert.deepEqual(violations, [])
})
