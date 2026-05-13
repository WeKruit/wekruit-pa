import { promises as fs } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..")

const scanTargets = [
  "apps/functions/src/outreach",
  "apps/functions/src/sendblue/pool.ts",
  "packages/pa-persistence/src/outreach-capacity.ts",
  "packages/pa-persistence/src/outbound-quota.ts",
]

const sourceExtensions = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".mjs"])

const forbidden = [
  {
    label: "direct Sendblue client import",
    pattern: new RegExp(String.raw`from\s+["'][^"']*sendblue-` + String.raw`client(?:\.js)?["']`),
  },
  {
    label: "direct Sendblue outbox handler import",
    pattern: new RegExp(String.raw`from\s+["'][^"']*sendblue\/` + String.raw`outbox(?:\.js)?["']`),
  },
  {
    label: "direct Sendblue reaction or typing provider import",
    pattern: new RegExp(String.raw`from\s+["'][^"']*sendblue\/(?:send-` + String.raw`reaction|typing-indicator)(?:\.js)?["']`),
  },
  {
    label: "direct Sendblue REST endpoint",
    pattern: new RegExp(String.raw`api\.sendblue\.co|sendblue\.com\/api|SEND_` + String.raw`MESSAGE_URL`),
  },
  {
    label: "direct Sendblue send call",
    pattern: new RegExp(String.raw`\bsendI` + String.raw`message\s*\(|\bsendblueClient\s*\.\s*sendI` + String.raw`message\s*\(`),
  },
  {
    label: "direct pa-outbound collection write outside broker/outbox",
    pattern: /PA_COLLECTIONS\.outbound(?!Invites)|collection\(\s*["']pa-outbound["']\s*\)/,
  },
  {
    label: "legacy paReverseMatch must not be the S6 primary path",
    pattern: new RegExp(String.raw`\bpa` + String.raw`ReverseMatch\b`),
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
  const nested = await Promise.all(
    entries.map((entry) => {
      const child = path.join(target, entry.name)
      if (entry.isDirectory()) return collectFiles(child)
      if (sourceExtensions.has(path.extname(entry.name))) return [path.join(root, child)]
      return []
    })
  )
  return nested.flat()
}

function lineNumber(source, index) {
  return source.slice(0, index).split("\n").length
}

const files = (await Promise.all(scanTargets.map(collectFiles))).flat()
const failures = []

for (const file of files) {
  const source = await fs.readFile(file, "utf8")
  const relative = path.relative(root, file)
  for (const rule of forbidden) {
    const match = rule.pattern.exec(source)
    if (match) {
      failures.push(`${relative}:${lineNumber(source, match.index)} ${rule.label}`)
    }
  }
}

if (failures.length > 0) {
  console.error("S6 static guard failed:")
  for (const failure of failures) console.error(`- ${failure}`)
  process.exit(1)
}

console.log(`S6 static guard passed (${files.length} files scanned).`)
