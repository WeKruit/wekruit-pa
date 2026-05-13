import assert from "node:assert/strict"
import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import test from "node:test"

const repoRoot = new URL("../../../", import.meta.url)
const scanRoots = [
  "apps/functions/src/outreach",
  "tests/eval/s6-outreach-platform",
]

async function listFiles(dir: string): Promise<string[]> {
  const entries = await readdir(new URL(dir + "/", repoRoot), { withFileTypes: true })
  const files: string[] = []
  for (const entry of entries) {
    const relative = join(dir, entry.name)
    if (entry.isDirectory()) {
      files.push(...await listFiles(relative))
    } else if (/\.(ts|tsx|js|mjs)$/.test(entry.name)) {
      files.push(relative)
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

test("S6 outreach path has no direct provider send or legacy bulk route", async () => {
  const files = (await Promise.all(scanRoots.map(listFiles))).flat()
  const forbidden = [
    { label: "direct provider client import", pattern: /sendblue-client\.js/ },
    { label: "direct provider send function", pattern: /\bsendI[m]essage\b/ },
    { label: "direct provider API URL", pattern: /api\.sendblue\.(?:co|com)\/api\/send-/ },
    { label: "legacy reverse-match path", pattern: new RegExp("\\bpa" + "ReverseMatch\\b") },
    { label: "legacy bulk notify path", pattern: new RegExp("\\bbulk" + "Notify\\b") },
  ]
  const violations: string[] = []

  for (const file of files) {
    const source = await readFile(new URL(file, repoRoot), "utf8")
    const scanned = withoutCommentsAndStrings(source)
    for (const rule of forbidden) {
      if (rule.pattern.test(scanned)) {
        violations.push(`${file}: ${rule.label}`)
      }
    }
  }

  assert.deepEqual(violations, [])
})
