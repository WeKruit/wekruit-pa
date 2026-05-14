import { promises as fs } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..")

const exactTargets = [
  "tests/eval/s8-flywheel-hitl-eval",
  "tests/scenarios/s8-flywheel-hitl-eval",
  "apps/dashboard-web/src/App.tsx",
  "apps/dashboard-web/src/pages/FlywheelEval.tsx",
  "apps/dashboard-web/src/pages/FlywheelEval.helpers.ts",
  "apps/pa-landing/src/pages/CandidatePortal.tsx",
  "apps/pa-landing/src/lib/candidate-profile-correction.ts",
]

const generatedPrefixes = [
  "apps/functions/src",
]

const sourceExtensions = new Set([".ts", ".tsx", ".js", ".mjs", ".yaml", ".yml"])

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

async function collectGeneratedS8Files(prefix) {
  const absolute = path.join(root, prefix)
  if (!(await exists(absolute))) return []
  const files = await collectFiles(prefix)
  return files.filter((file) =>
    /(?:flywheel|eval|correction)/i.test(path.basename(file)) &&
    !file.includes(`${path.sep}__tests__${path.sep}`)
  )
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

const files = [
  ...(await Promise.all(exactTargets.map(collectFiles))).flat(),
  ...(await Promise.all(generatedPrefixes.map(collectGeneratedS8Files))).flat(),
]

const uniqueFiles = [...new Set(files)]
const violations = []

const codeRules = [
  {
    label: "S8 must not write pa-outbound",
    pattern: /PA_COLLECTIONS\s*\.\s*outbound(?!Invites)\b|collection\s*\(\s*["']pa-outbound["']\s*\)/,
  },
  {
    label: "S8 must not import direct Sendblue/manual outbound paths",
    pattern: /sendblue\/(?:outbox|sendblue-client|send-reaction|typing-indicator)|sendblue-client\.js|manualLinkedInSend|sendLinkedIn|linkedin\s*\.\s*send/i,
  },
  {
    label: "S8 must not call direct Sendblue send",
    pattern: /\bsendI[m]essage\s*\(|sendblueClient\s*\.\s*sendI[m]essage\s*\(/,
  },
  {
    label: "candidate route must not move to admin app",
    pattern: /wekruit-pa\.web\.app\/j\/|path\s*:\s*["']\/j\/|<Route\s+path=["']\/j\//,
  },
  {
    label: "admin route must not move to candidate app",
    pattern: /candidate\.wekruit\.com\/admin|pa\.wekruit\.com\/admin|wekruit-pa-landing\.web\.app\/admin/,
  },
  {
    label: "S8 must not block first interview by match score",
    pattern: /prescreen_started[\s\S]{0,240}(finalScore|matchScore|hardFilterResult|LOW_MATCH_THRESHOLD)|first_interview[\s\S]{0,240}(finalScore|matchScore|hardFilterResult|LOW_MATCH_THRESHOLD)/i,
  },
]

const payloadRules = [
  {
    label: "eval artifact must not expose raw prompt fields",
    pattern: /\b(rawPrompt|systemPrompt|developerPrompt|promptText)\b/,
  },
  {
    label: "eval artifact must not expose raw transcript fields",
    pattern: /\b(rawTranscript|transcriptRaw|fullTranscript|turnsRaw)\b/,
  },
  {
    label: "eval artifact must not expose raw contact fields",
    pattern: /\b(email|phone|linkedinUrl|rawLinkedInUrl|normalizedValue)\b/,
  },
  {
    label: "eval artifact must not expose storage locators",
    pattern: /\b(storagePath|gcsUri|resumeStorageUri|downloadUrl)\b|gs:\/\//,
  },
]

const payloadScanTargets = [
  "tests/eval/s8-flywheel-hitl-eval/fixtures.ts",
  "tests/scenarios/s8-flywheel-hitl-eval",
]

const payloadScanSet = new Set((await Promise.all(payloadScanTargets.map(collectFiles))).flat())

for (const file of uniqueFiles) {
  const source = await fs.readFile(file, "utf8")
  const scannedCode = withoutCommentsAndStrings(source)
  for (const rule of codeRules) {
    const match = rule.pattern.exec(scannedCode)
    if (match) addViolation(violations, file, scannedCode, match.index, rule.label)
  }

  if (payloadScanSet.has(file) && /EvalArtifact|evalArtifact|payloadRedacted|pa-eval-artifacts/.test(source)) {
    const payloadSurface = withoutCommentsAndStrings(source)
    for (const rule of payloadRules) {
      const match = rule.pattern.exec(payloadSurface)
      if (match) addViolation(violations, file, source, match.index, rule.label)
    }
  }
}

if (violations.length > 0) {
  console.error("S8 static guard failed:")
  for (const violation of violations) console.error(`- ${violation}`)
  process.exit(1)
}

console.log(`S8 static guard passed (${uniqueFiles.length} files scanned).`)
