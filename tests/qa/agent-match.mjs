#!/usr/bin/env node
/**
 * Phase 50 — Agent-Match
 *
 * Imports the *built* hard-filter + startup-boost from
 * apps/job-rec/dist/ and feeds each persona through them against a fixed
 * mock-job pool. This is the *only* QA agent that exercises real v1.5
 * shipping code (Phase 43 hard-filter + Phase 43.5 startup boost) — the
 * other three are static voice/contract checks.
 *
 * Mock job pool covers all persona-relevant slices:
 *   - Senior-track (filtered out for college-student / new-grad)
 *   - No-sponsorship marker (filtered out for sponsorship_needed)
 *   - sponsorship === false on corpus (also filtered for sponsorship_needed)
 *   - Research-keyword (kept ONLY when researchOriented === true)
 *   - Startup company (≤500 emp) and FAANG company (boost signals)
 *   - Bay Area + remote + NYC location coverage
 *
 * Per-persona assertions check the persona's `expected_assertions` flags:
 *   - hard_filter_drops_senior         → no SENIOR_TITLE_REGEX in result
 *   - hard_filter_drops_no_sponsorship → no NO_SPONSORSHIP / sponsorship=false
 *   - hard_filter_keeps_research       → all results carry research keywords
 *   - startup_boost_positive           → startup jobs ranked above FAANG
 *   - startup_boost_negative           → FAANG ranked above startup (for prefersStartup=false)
 *   - no_yoe_violation                 → no senior result for low yoeRange
 *
 * Pure deterministic. No Firestore, no LLM, no network.
 */
import { argv, exit } from "node:process"
import { resolve, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { existsSync } from "node:fs"

import { loadAllPersonas, loadPersonaById } from "./lib-personas.mjs"
import { writeAgentReport } from "./lib-report.mjs"

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(__dirname, "..", "..")
const DIST_HARD = resolve(REPO_ROOT, "apps/job-rec/dist/tools/query-matching-jobs.js")
const DIST_BOOST = resolve(REPO_ROOT, "apps/job-rec/dist/cross-encoder-rerank.js")

const distExists = existsSync(DIST_HARD) && existsSync(DIST_BOOST)
if (!distExists) {
  console.error(
    "[agent-match] apps/job-rec/dist/ missing — run `npm run build -w @pa/job-rec` first.\n" +
      "Falling back to fixture-shape-only validation."
  )
}

let applyHardFiltersWithFallback, applyStartupBoost, userPreferStartup,
    SENIOR_TITLE_REGEX, NO_SPONSORSHIP_KEYWORDS_REGEX, RESEARCH_KEYWORDS_REGEX
if (distExists) {
  ;({ applyHardFiltersWithFallback, SENIOR_TITLE_REGEX, NO_SPONSORSHIP_KEYWORDS_REGEX, RESEARCH_KEYWORDS_REGEX } =
    await import(DIST_HARD))
  ;({ applyStartupBoost, userPreferStartup } = await import(DIST_BOOST))
}

// ---------------- mock job pool ----------------

const MOCK_JOBS = [
  // 1 senior — should be dropped for new-grad / college-student
  {
    id: "j1-senior-faang",
    companyName: "Google",
    jobTitle: "Senior Software Engineer",
    salaryMax: 350000, salaryMin: 250000,
    locationRaw: "Mountain View, CA",
    primaryUrl: "https://careers.google.com/j1",
    industry: "tech",
    sponsorship: true,
    requiredSkills: ["go", "kubernetes"],
    companyEmployeeCount: 180000,
  },
  // 2 mid-level FAANG, sponsorship ok
  {
    id: "j2-mid-faang",
    companyName: "Meta",
    jobTitle: "Software Engineer",
    salaryMax: 250000, salaryMin: 180000,
    locationRaw: "San Francisco, CA",
    primaryUrl: "https://careers.meta.com/j2",
    industry: "tech",
    sponsorship: true,
    requiredSkills: ["python", "react"],
    companyEmployeeCount: 75000,
  },
  // 3 startup PM job, no sponsorship needed
  {
    id: "j3-startup-pm",
    companyName: "Lattice Labs",
    jobTitle: "Product Manager",
    salaryMax: 200000, salaryMin: 160000,
    locationRaw: "San Francisco, CA",
    primaryUrl: "https://lattice.com/j3",
    industry: "b2b",
    sponsorship: true,
    requiredSkills: ["product", "sql"],
    companyEmployeeCount: 80,
  },
  // 4 startup junior SWE (good for new-grad)
  {
    id: "j4-startup-jr-swe",
    companyName: "Linear",
    jobTitle: "Junior Software Engineer",
    salaryMax: 160000, salaryMin: 120000,
    locationRaw: "Remote (US)",
    primaryUrl: "https://linear.app/j4",
    industry: "tech",
    sponsorship: true,
    requiredSkills: ["typescript", "react"],
    companyEmployeeCount: 100,
  },
  // 5 no-sponsorship-marker job
  {
    id: "j5-no-sponsor",
    companyName: "Defense Co",
    jobTitle: "Software Engineer",
    salaryMax: 180000, salaryMin: 130000,
    locationRaw: "Arlington, VA",
    primaryUrl: "https://example.com/j5",
    industry: "b2b",
    sponsorship: false,
    requiredSkills: ["clearance required", "us citizenship required"],
    companyEmployeeCount: 5000,
  },
  // 6 research scientist FAANG (research-only filter keeps this)
  {
    id: "j6-research-faang",
    companyName: "Google",
    jobTitle: "Research Scientist",
    salaryMax: 400000, salaryMin: 300000,
    locationRaw: "Mountain View, CA",
    primaryUrl: "https://careers.google.com/j6",
    industry: "tech",
    sponsorship: true,
    requiredSkills: ["pytorch", "research"],
    companyEmployeeCount: 180000,
  },
  // 7 NYC fintech mid-level
  {
    id: "j7-nyc-fintech",
    companyName: "Stripe",
    jobTitle: "Product Manager",
    salaryMax: 240000, salaryMin: 180000,
    locationRaw: "New York, NY",
    primaryUrl: "https://stripe.com/j7",
    industry: "fintech",
    sponsorship: true,
    requiredSkills: ["product", "fintech"],
    companyEmployeeCount: 7000,
  },
  // 8 startup founding engineer
  {
    id: "j8-founding-eng",
    companyName: "TinyAI",
    jobTitle: "Founding Engineer",
    salaryMax: 220000, salaryMin: 160000,
    locationRaw: "San Francisco, CA",
    primaryUrl: "https://tinyai.com/j8",
    industry: "tech",
    sponsorship: false,
    requiredSkills: ["typescript", "rust"],
    companyEmployeeCount: 8,
  },
  // 9 staff/lead (senior keyword) — drop for new grads
  {
    id: "j9-staff",
    companyName: "Snowflake",
    jobTitle: "Staff Engineer",
    salaryMax: 380000, salaryMin: 280000,
    locationRaw: "San Mateo, CA",
    primaryUrl: "https://snowflake.com/j9",
    industry: "b2b",
    sponsorship: true,
    requiredSkills: ["distributed systems"],
    companyEmployeeCount: 7000,
  },
  // 10 design role (consumer)
  {
    id: "j10-design",
    companyName: "Airbnb",
    jobTitle: "Senior Product Designer",
    salaryMax: 240000, salaryMin: 180000,
    locationRaw: "San Francisco, CA",
    primaryUrl: "https://careers.airbnb.com/j10",
    industry: "consumer",
    sponsorship: true,
    requiredSkills: ["figma", "design systems"],
    companyEmployeeCount: 7000,
  },
]

// ---------------- per-persona judge ----------------

const FAANG_NAMES = new Set(["google", "meta", "amazon", "apple", "microsoft", "snowflake"])

function profileOf(persona) {
  return {
    statedPreferences: persona.statedPreferences,
    experiences: (persona.cv?.experiences ?? []).map((e) => ({
      startDate: e.startDate,
      endDate: e.endDate,
    })),
  }
}

function assertPersonaWithDist(persona) {
  const issues = []
  let pass = true
  let p0Bad = false

  const profile = profileOf(persona)
  const result = applyHardFiltersWithFallback(profile, MOCK_JOBS, [], 5, new Date("2026-05-02"))
  const surviving = result.jobs

  // 1) hard_filter_drops_senior
  if (persona.expected_assertions?.hard_filter_drops_senior) {
    const seniors = surviving.filter((j) => SENIOR_TITLE_REGEX.test(j.jobTitle))
    if (seniors.length > 0) {
      pass = false; p0Bad = true
      issues.push(`P0 senior leakage: ${seniors.map((j) => j.id).join(",")}`)
    }
  }

  // 2) hard_filter_drops_no_sponsorship
  if (persona.expected_assertions?.hard_filter_drops_no_sponsorship) {
    const nosponsor = surviving.filter(
      (j) =>
        j.sponsorship === false ||
        NO_SPONSORSHIP_KEYWORDS_REGEX.test([j.jobTitle ?? "", ...(j.requiredSkills ?? [])].join(" "))
    )
    if (nosponsor.length > 0) {
      pass = false; p0Bad = true
      issues.push(`P0 no-sponsorship leakage: ${nosponsor.map((j) => j.id).join(",")}`)
    }
  }

  // 3) hard_filter_keeps_research
  if (persona.expected_assertions?.hard_filter_keeps_research) {
    const nonResearch = surviving.filter(
      (j) => !RESEARCH_KEYWORDS_REGEX.test([j.jobTitle ?? "", ...(j.requiredSkills ?? [])].join(" "))
    )
    if (nonResearch.length > 0) {
      pass = false; p0Bad = true
      issues.push(`P0 research filter leakage: ${nonResearch.map((j) => j.id).join(",")}`)
    }
  }

  // 4) startup_boost_positive — top entry should be a startup if any survive
  if (persona.expected_assertions?.startup_boost_positive) {
    const userSig = userPreferStartup({
      statedPreferences: persona.statedPreferences,
      cvExperiences: (persona.cv?.experiences ?? []).map((e) => ({
        company: e.company,
        title: e.title,
        startDate: e.startDate,
        endDate: e.endDate,
        companyEmployeeCount: e.companyEmployeeCount,
      })),
    })
    const boosted = applyStartupBoost(surviving, userSig)
    if (boosted.jobs.length > 0) {
      const top = boosted.jobs[0]
      const topIsStartup = (top.companyEmployeeCount ?? Infinity) < 500
      const topIsFaang = FAANG_NAMES.has((top.companyName ?? "").toLowerCase())
      if (topIsFaang && !topIsStartup) {
        pass = false; p0Bad = true
        issues.push(`P0 startup-boost-positive: top result is FAANG ${top.companyName} (${top.id})`)
      }
    }
  }

  // 5) startup_boost_negative — FAANG should rank above startup
  if (persona.expected_assertions?.startup_boost_negative) {
    const userSig = userPreferStartup({
      statedPreferences: persona.statedPreferences,
      cvExperiences: (persona.cv?.experiences ?? []).map((e) => ({
        company: e.company,
        title: e.title,
        startDate: e.startDate,
        endDate: e.endDate,
        companyEmployeeCount: e.companyEmployeeCount,
      })),
    })
    const boosted = applyStartupBoost(surviving, userSig)
    // For prefersStartup=false the boost should down-weight startups vs FAANG.
    // We accept either: FAANG appears before startup in ranked list OR there
    // are no startups in result (filter already removed them upstream).
    const idx = (id) => boosted.jobs.findIndex((j) => j.id === id)
    const firstStartupIdx = boosted.jobs.findIndex((j) => (j.companyEmployeeCount ?? Infinity) < 500)
    const firstFaangIdx = boosted.jobs.findIndex((j) =>
      FAANG_NAMES.has((j.companyName ?? "").toLowerCase())
    )
    if (firstStartupIdx !== -1 && firstFaangIdx !== -1 && firstStartupIdx < firstFaangIdx) {
      pass = false; p0Bad = true
      issues.push(`P0 startup-boost-negative: startup ${boosted.jobs[firstStartupIdx].id} ranked above FAANG ${boosted.jobs[firstFaangIdx].id}`)
    }
  }

  // 6) no_yoe_violation — for low yoeRange, no senior in result
  if (persona.expected_assertions?.no_yoe_violation) {
    const yoeMax = persona.statedPreferences?.yoeRange?.[1]
    if (typeof yoeMax === "number" && yoeMax < 1) {
      const seniors = surviving.filter((j) => SENIOR_TITLE_REGEX.test(j.jobTitle))
      if (seniors.length > 0) {
        pass = false; p0Bad = true
        issues.push(`P0 yoe violation: senior survived for yoeMax=${yoeMax}`)
      }
    }
  }

  const summary = `surv=${surviving.length} relax=${result.relaxLevel} fb=${result.fallbackMode}`
  return {
    persona: persona.id,
    language: persona.language,
    pass,
    p0: p0Bad,
    details: pass ? `ok ${summary}` : issues.join("; "),
  }
}

function assertPersonaShapeOnly(persona) {
  // Fallback when dist isn't built — just smoke-check the persona has the
  // hard-filter-relevant fields populated.
  const issues = []
  let pass = true
  const sp = persona.statedPreferences ?? {}
  if (!sp.visaStatus) issues.push("missing visaStatus")
  if (!Array.isArray(sp.yoeRange)) issues.push("missing yoeRange")
  if (issues.length) pass = false
  return {
    persona: persona.id,
    language: persona.language,
    pass,
    p0: !pass,
    details: pass ? "shape ok (dist not built; deep checks skipped)" : issues.join("; "),
  }
}

// ---------------- main ----------------

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
  console.error("agent-match: no personas loaded")
  exit(2)
}

const judge = distExists ? assertPersonaWithDist : assertPersonaShapeOnly
const results = personas.map(judge)
const notes = distExists
  ? "Mode: DEEP — imported applyHardFiltersWithFallback + applyStartupBoost from apps/job-rec/dist/."
  : "Mode: SHAPE-only — apps/job-rec/dist/ not present; run `npm run build -w @pa/job-rec` to enable deep checks."
const summary = writeAgentReport({ runId: opts.runId, agent: "match", results, notes })

console.log(`[agent-match] ${summary.overall} — ${summary.passCount}/${summary.total} pass, ${summary.p0Failures} P0 fails`)
console.log(`[agent-match] report: ${summary.path}`)
exit(summary.overall === "PASS" ? 0 : 1)
