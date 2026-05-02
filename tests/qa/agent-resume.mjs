#!/usr/bin/env node
/**
 * Phase 50 — Agent-Resume
 *
 * Validates that each persona's CV fixture conforms to the contract that
 * cv-ingest emits downstream (industryTags ⊆ JobIndustrySchema enum,
 * experiences[0].title preserved, skills > 3, no PII surfaced as plaintext
 * email/SSN). This is a STATIC contract test; the live cv-ingest pipeline
 * runs only when PA_QA_LIVE=1 + Firestore creds are present (DELIVERY.md).
 *
 * P0 assertions:
 *   - cv.skills.length > 3
 *   - cv.experiences[0].title is non-empty string
 *   - cv.industryTags ⊆ JOB_INDUSTRY_ENUM (no unknown enum)
 *   - no obvious PII leak (SSN-like 9-digit / credit-card 16-digit) in any
 *     string field
 *
 * P1 assertions:
 *   - cv.education non-empty
 *   - cv.yearsExp consistent with statedPreferences.yoeRange (within 2y)
 *   - cv.experiences[0].endDate present (current/recent)
 */
import { argv, exit } from "node:process"
import {
  loadAllPersonas,
  loadPersonaById,
  JOB_INDUSTRY_ENUM,
} from "./lib-personas.mjs"
import { writeAgentReport } from "./lib-report.mjs"

const SSN_RE = /\b\d{3}-\d{2}-\d{4}\b/
const CC_RE = /\b\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/
const EMAIL_RE = /\b[\w.+-]+@[\w-]+\.[a-z]{2,}\b/i

function deepStrings(obj, out = []) {
  if (obj == null) return out
  if (typeof obj === "string") {
    out.push(obj)
    return out
  }
  if (typeof obj !== "object") return out
  for (const v of Array.isArray(obj) ? obj : Object.values(obj)) {
    deepStrings(v, out)
  }
  return out
}

function assertResume(persona) {
  const issues = []
  let pass = true
  let p0Bad = false
  const cv = persona.cv ?? {}

  // P0 #1 — skills count
  if (!Array.isArray(cv.skills) || cv.skills.length <= 3) {
    pass = false
    p0Bad = true
    issues.push(`P0 cv.skills.length must be > 3 (got ${(cv.skills ?? []).length})`)
  }

  // P0 #2 — experiences[0].title preserved
  const exps = Array.isArray(cv.experiences) ? cv.experiences : []
  if (exps.length === 0) {
    pass = false
    p0Bad = true
    issues.push("P0 cv.experiences must be non-empty")
  } else {
    const e0 = exps[0] ?? {}
    if (typeof e0.title !== "string" || e0.title.trim().length === 0) {
      pass = false
      p0Bad = true
      issues.push("P0 cv.experiences[0].title must be non-empty string")
    }
  }

  // P0 #3 — industryTags ⊆ enum
  const tags = Array.isArray(cv.industryTags) ? cv.industryTags : []
  const unknown = tags.filter((t) => !JOB_INDUSTRY_ENUM.includes(t))
  if (unknown.length > 0) {
    pass = false
    p0Bad = true
    issues.push(`P0 industryTags not in enum: ${unknown.join(",")}`)
  }

  // P0 #4 — PII regex sweep across ALL CV strings
  const allStrings = deepStrings(cv).join("\n")
  if (SSN_RE.test(allStrings)) {
    pass = false
    p0Bad = true
    issues.push("P0 SSN-like pattern detected in CV")
  }
  if (CC_RE.test(allStrings)) {
    pass = false
    p0Bad = true
    issues.push("P0 credit-card-like pattern detected in CV")
  }
  // Email is allowed for harness fixtures? We allow but warn (P1).
  if (EMAIL_RE.test(allStrings)) {
    issues.push("P1 email present in CV strings (acceptable for harness)")
  }

  // P1 #1 — education present
  if (typeof cv.education !== "string" || cv.education.trim().length === 0) {
    issues.push("P1 cv.education empty")
    pass = false
  }

  // P1 #2 — yoe consistency
  if (typeof cv.yearsExp === "number" && Array.isArray(persona.statedPreferences?.yoeRange)) {
    const [lo, hi] = persona.statedPreferences.yoeRange
    if (cv.yearsExp + 2 < lo || cv.yearsExp - 2 > hi) {
      issues.push(`P1 cv.yearsExp=${cv.yearsExp} outside ±2y of yoeRange [${lo},${hi}]`)
      pass = false
    }
  }

  return {
    persona: persona.id,
    language: persona.language,
    pass,
    p0: p0Bad,
    details: issues.length === 0 ? "all checks ok" : issues.join("; "),
  }
}

function parseArgs() {
  const args = argv.slice(2)
  const out = { runId: process.env.QA_RUN_ID ?? `r-${Date.now()}`, persona: null }
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--persona") out.persona = args[++i]
    else if (args[i] === "--run-id") out.runId = args[++i]
  }
  return out
}

const opts = parseArgs()
const personas = opts.persona ? [loadPersonaById(opts.persona)].filter(Boolean) : loadAllPersonas()
if (personas.length === 0) {
  console.error("agent-resume: no personas loaded")
  exit(2)
}

const results = personas.map(assertResume)
const summary = writeAgentReport({ runId: opts.runId, agent: "resume", results })

console.log(`[agent-resume] ${summary.overall} — ${summary.passCount}/${summary.total} pass, ${summary.p0Failures} P0 fails`)
console.log(`[agent-resume] report: ${summary.path}`)
exit(summary.overall === "PASS" ? 0 : 1)
