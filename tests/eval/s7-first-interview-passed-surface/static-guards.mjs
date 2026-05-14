import { promises as fs } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..")

const scanTargets = [
  "tests/eval/s7-first-interview-passed-surface",
  "apps/functions/src/admin-passed-candidates.ts",
  "apps/dashboard-web/src/pages/PassedCandidates.tsx",
  "apps/dashboard-web/src/pages/PassedCandidates.helpers.ts",
  "apps/pa-landing/src/pages/PublicJob.tsx",
  "apps/pa-landing/src/pages/CandidateMatches.tsx",
]

const sourceExtensions = new Set([".ts", ".tsx", ".js", ".mjs"])
const forbidden = [
  {
    label: "direct provider client import",
    pattern: /sendblue-client\.js/,
  },
  {
    label: "direct provider send function",
    pattern: new RegExp(String.raw`\bsendI` + String.raw`message\b`),
  },
  {
    label: "direct Sendblue API URL",
    pattern: /api\.sendblue\.(?:co|com)|sendblue\.com\/api/,
  },
  {
    label: "candidate route on admin domain",
    pattern: /wekruit-pa\.web\.app\/j\//,
  },
  {
    label: "admin route on candidate domain",
    pattern: /candidate\.wekruit\.com\/admin/,
  },
]

async function exists(filePath) {
  try {
    await fs.access(filePath)
    return true
  } catch {
    return false
  }
}

async function collectFiles(target) {
  const absolute = path.join(root, target)
  if (!(await exists(absolute))) return []
  const stat = await fs.stat(absolute)
  if (stat.isFile()) return sourceExtensions.has(path.extname(absolute)) ? [absolute] : []
  const entries = await fs.readdir(absolute, { withFileTypes: true })
  const nested = await Promise.all(entries.map((entry) => {
    const child = path.join(target, entry.name)
    if (entry.isDirectory()) return collectFiles(child)
    if (sourceExtensions.has(path.extname(entry.name))) return [path.join(root, child)]
    return []
  }))
  return nested.flat()
}

function withoutCommentsAndStrings(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "")
    .replace(/(["'`])(?:\\[\s\S]|(?!\1)[^\\])*\1/g, "\"\"")
}

function lineNumber(source, index) {
  return source.slice(0, index).split("\n").length
}

const files = (await Promise.all(scanTargets.map(collectFiles))).flat()
const failures = []

for (const file of files) {
  const source = await fs.readFile(file, "utf8")
  const scanned = withoutCommentsAndStrings(source)
  const relative = path.relative(root, file)
  for (const rule of forbidden) {
    const match = rule.pattern.exec(scanned)
    if (match) {
      failures.push(`${relative}:${lineNumber(scanned, match.index)} ${rule.label}`)
    }
  }
}

if (failures.length > 0) {
  console.error("S7 static guard failed:")
  for (const failure of failures) console.error(`- ${failure}`)
  process.exit(1)
}

console.log(`S7 static guard passed (${files.length} files scanned).`)
