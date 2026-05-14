import { promises as fs } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..")

const exactTargets = [
  "apps/functions/src/production-hardening.ts",
  "apps/functions/src/index.ts",
  "apps/functions/src/outreach/service.ts",
  "apps/functions/src/sendblue/outbox.ts",
  "apps/dashboard-web/src/App.tsx",
  "apps/dashboard-web/src/lib/launch-readiness-api.ts",
  "apps/dashboard-web/src/pages/LaunchReadiness.tsx",
  "apps/dashboard-web/src/pages/LaunchReadinessView.tsx",
  "apps/dashboard-web/src/pages/__tests__/LaunchReadiness.test.ts",
  "apps/pa-landing/src/App.tsx",
  "apps/pa-landing/src/pages/CandidatePortal.tsx",
  "apps/pa-landing/src/lib/candidate-privacy-request.ts",
  "apps/pa-landing/src/lib/candidate-privacy-request.test.ts",
  "tests/eval/s9-production-hardening-scale",
  "tests/scenarios/s9-production-hardening-scale",
]

const sourceExtensions = new Set([".ts", ".tsx", ".js", ".mjs", ".yaml", ".yml", ".md"])

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

function addViolation(violations, file, source, index, label) {
  violations.push(`${path.relative(root, file)}:${lineNumber(source, index)} ${label}`)
}

function requireOrder(violations, file, source, earlierPattern, laterPattern, label) {
  const earlier = source.search(earlierPattern)
  const later = source.search(laterPattern)
  if (earlier < 0 || later < 0 || earlier > later) {
    violations.push(`${path.relative(root, file)}:1 ${label}`)
  }
}

const uniqueFiles = [...new Set((await Promise.all(exactTargets.map(collectFiles))).flat())]
const violations = []

const destructiveRules = [
  { label: "S9 must not perform destructive Firestore deletes", pattern: /\b(?:deleteDoc|recursiveDelete)\s*\(|\.\s*delete\s*\(|bulkWriter\s*\.\s*delete\s*\(/ },
  { label: "S9 must not generate direct export materialization", pattern: /\b(?:signedUrl|createReadStream|downloadUrl|exportUrl)\b/ },
  { label: "S9 privacy/readiness code must not send provider messages", pattern: /\b(?:sendI[m]essage|sendblueClient|manualLinkedInSend|sendLinkedIn|instantlySyncLive)\b/ },
]

const piiPayloadRules = [
  { label: "S9 artifacts must not expose raw email fields", pattern: /\b(?:email|rawEmail|normalizedEmail)\b/i },
  { label: "S9 artifacts must not expose raw phone fields", pattern: /\b(?:phone|rawPhone|normalizedPhone)\b/i },
  { label: "S9 artifacts must not expose raw LinkedIn fields", pattern: /\b(?:linkedinUrl|rawLinkedInUrl|normalizedLinkedInUrl)\b/i },
  { label: "S9 artifacts must not expose raw prompt or transcript fields", pattern: /\b(?:rawPrompt|systemPrompt|developerPrompt|promptText|rawTranscript|fullTranscript|turnsRaw)\b/i },
  { label: "S9 artifacts must not expose resume storage locators", pattern: /\b(?:storagePath|gcsUri|resumeStorageUri|downloadUrl)\b|gs:\/\//i },
]

for (const file of uniqueFiles) {
  const relative = path.relative(root, file)
  const source = await fs.readFile(file, "utf8")
  const stripped = withoutCommentsAndStrings(source)

  if (
    relative === "apps/functions/src/production-hardening.ts" ||
    relative.includes("candidate-privacy-request") ||
    relative.includes("LaunchReadiness") ||
    relative.startsWith("tests/scenarios/s9-production-hardening-scale")
  ) {
    for (const rule of destructiveRules) {
      const match = rule.pattern.exec(stripped)
      if (match) addViolation(violations, file, stripped, match.index, rule.label)
    }
  }

  if (
    relative === "tests/eval/s9-production-hardening-scale/fixtures.ts" ||
    relative.startsWith("tests/scenarios/s9-production-hardening-scale")
  ) {
    for (const rule of piiPayloadRules) {
      const match = rule.pattern.exec(stripped)
      if (match) addViolation(violations, file, stripped, match.index, rule.label)
    }
  }

  if (relative === "apps/dashboard-web/src/App.tsx") {
    const adminCandidateRoute = /<Route\s+path=["']\/j\/|wekruit-pa\.web\.app\/j\//.exec(source)
    if (adminCandidateRoute) addViolation(violations, file, source, adminCandidateRoute.index, "candidate routes must not move to admin hosting")
    if (!/<Route path="\/admin\/launch-readiness" element={<LaunchReadiness \/>} \/>/.test(source)) {
      violations.push(`${relative}:1 /admin/launch-readiness route is not wired`)
    }
  }

  if (relative === "apps/pa-landing/src/App.tsx") {
    const candidateAdminRoute = /<Route\s+path=["']\/admin|candidate\.wekruit\.com\/admin|pa\.wekruit\.com\/admin/.exec(source)
    if (candidateAdminRoute) addViolation(violations, file, source, candidateAdminRoute.index, "admin routes must not move to candidate hosting")
  }
}

const sendblueOutbox = await fs.readFile(path.join(root, "apps/functions/src/sendblue/outbox.ts"), "utf8")
requireOrder(
  violations,
  path.join(root, "apps/functions/src/sendblue/outbox.ts"),
  sendblueOutbox,
  /await deps\.readOutreachStopControl\?\.\(deps\.db,\s*\{\s*scope:\s*"global"\s*\}\)/,
  /deps\.sendblueClient\.sendImessage\s*\(/,
  "Sendblue marketplace stop-control read must happen before provider send",
)
if (!/idempotencyKey[\s\S]{0,120}startsWith\("outreach_idempotency_"\)/.test(sendblueOutbox)) {
  violations.push("apps/functions/src/sendblue/outbox.ts:1 marketplace outbound rows must be scoped by outreach idempotency prefix")
}

const outreachService = await fs.readFile(path.join(root, "apps/functions/src/outreach/service.ts"), "utf8")
requireOrder(
  violations,
  path.join(root, "apps/functions/src/outreach/service.ts"),
  outreachService,
  /globalStopControl = await deps\.readOutreachStopControl\(\{\s*scope:\s*"global"\s*\}\)/,
  /await deps\.reserveCapacity\(/,
  "Outreach planning stop-control read must happen before capacity reservation",
)
if (!/outreach_stop_control_check_failed/.test(outreachService)) {
  violations.push("apps/functions/src/outreach/service.ts:1 outreach read errors must fail closed")
}

if (violations.length > 0) {
  console.error("S9 static guard failed:")
  for (const violation of violations) console.error(`- ${violation}`)
  process.exit(1)
}

console.log(`S9 static guard passed (${uniqueFiles.length} files scanned).`)
