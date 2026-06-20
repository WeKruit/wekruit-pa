// @ts-nocheck - landing app typecheck only includes Vite/browser types; this file runs with node --test via tsx.
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import test from "node:test"
import { formatPublicJobType } from "./public-job-labels.js"
import { stripVisaLines } from "./public-job-description.js"

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(resolve(here, "public-jobs.ts"), "utf8")

test("stripVisaLines removes the JD visa/sponsorship logistics line", () => {
  const md = [
    "## Logistics",
    "- Location: Remote or San Francisco, CA",
    "- Visa: OPT / H-1B sponsorship available",
    "- Level: New grad / early career",
    "- Team: Small, fast-shipping founding team",
  ].join("\n")
  const out = stripVisaLines(md) ?? ""
  assert.doesNotMatch(out, /Visa/i)
  assert.doesNotMatch(out, /sponsorship available/i)
  assert.doesNotMatch(out, /OPT \/ H-1B/i)
  // Sibling logistics survive.
  assert.match(out, /Location: Remote or San Francisco/)
  assert.match(out, /Level: New grad/)
  assert.match(out, /Team: Small, fast-shipping/)
})

test("stripVisaLines drops bold/heading visa fields and dedicated visa sections", () => {
  assert.doesNotMatch(stripVisaLines("**Visa:** H1B sponsorship available") ?? "", /Visa/i)
  assert.doesNotMatch(stripVisaLines("- Sponsorship: Yes") ?? "", /Sponsorship/i)
  assert.doesNotMatch(stripVisaLines("- Work Authorization: US only") ?? "", /Work Authorization/i)
  const section = ["## Visa", "We sponsor OPT and H-1B.", "## About", "Great team."].join("\n")
  const out = stripVisaLines(section) ?? ""
  assert.doesNotMatch(out, /sponsor OPT/i)
  assert.match(out, /About/)
  assert.match(out, /Great team/)
})

test("stripVisaLines removes inline visa/work-authorization clauses (not just fields)", () => {
  // Real live JD form (Invoko Product Designer) — an inline clause, no colon.
  const md = [
    "Ship-iterate mindset",
    "",
    "US work authorization required · Visa sponsorship + OPT/CPT eligible",
    "",
    "About the team",
  ].join("\n")
  const out = stripVisaLines(md) ?? ""
  assert.doesNotMatch(out, /work authorization/i)
  assert.doesNotMatch(out, /sponsorship/i)
  assert.doesNotMatch(out, /OPT\/CPT/i)
  assert.match(out, /Ship-iterate mindset/)
  assert.match(out, /About the team/)
})

test("stripVisaLines removes short authorization bullets", () => {
  assert.doesNotMatch(stripVisaLines("- Authorized to work in the US") ?? "", /Authorized to work/i)
  assert.doesNotMatch(stripVisaLines("- H-1B and green card holders welcome") ?? "", /green card/i)
  assert.doesNotMatch(stripVisaLines("- No visa sponsorship for this role") ?? "", /sponsorship/i)
})

test("stripVisaLines drops a short standalone sponsorship sentence", () => {
  // Policy: no visa shown. A short clause that is *about* sponsorship goes,
  // even without a colon. (Long paragraphs are still protected — see below.)
  const prose = "Sponsorship is something we figure out per candidate."
  assert.equal(stripVisaLines(prose), "")
})

test("stripVisaLines does not drop non-visa content with visa-adjacent substrings", () => {
  // lowercase "opt-in"/"options" are NOT the OPT visa acronym (case-sensitive).
  assert.match(stripVisaLines("- Design opt-in flows and onboarding options") ?? "", /opt-in flows/)
  // A long paragraph that mentions sponsorship once is kept (> 25 words).
  const para =
    "We are a small team that cares deeply about craft and we will happily sponsor the right person " +
    "but only after we have built real trust together over many shipped projects and shared wins along the way."
  assert.equal(stripVisaLines(para), para)
})

test("formatPublicJobType presents backend job type enums as candidate-facing labels", () => {
  assert.equal(formatPublicJobType("full_time"), "Full-time")
  assert.equal(formatPublicJobType("part-time"), "Part-time")
  assert.equal(formatPublicJobType("CONTRACT"), "Contract")
  assert.equal(formatPublicJobType("remote_flexible"), "Remote flexible")
  assert.equal(formatPublicJobType("  "), undefined)
})

test("toPublicJobOpening formats public job type before exposing it to candidate surfaces", () => {
  assert.match(source, /import \{ formatPublicJobType \} from "\.\/public-job-labels\.js"/)
  assert.match(source, /jobType: formatPublicJobType\(raw\.jobType \?\? raw\.prescreenConfig\?\.jobType\)/)
  assert.doesNotMatch(source, /jobType: raw\.jobType/)
})

test("Landing hero and Market direct line share ONE cached raw pa-jobs snapshot", () => {
  // The raw 48-doc publicVisible read is the most expensive client fetch on
  // the candidate site. Both surfaces must consume the SAME TanStack key +
  // fetcher (each with its own `select`) so landing → market costs one read
  // per 6h window instead of two.
  assert.match(source, /export const PUBLIC_PA_JOBS_RAW_LIMIT = 48/)
  assert.match(
    source,
    /export const PUBLIC_PA_JOBS_RAW_QUERY_KEY = \["pa-jobs-hero", PUBLIC_PA_JOBS_RAW_LIMIT\] as const/,
  )

  const landingSource = readFileSync(resolve(here, "../pages/Landing.tsx"), "utf8")
  const marketSource = readFileSync(resolve(here, "../pages/Market.tsx"), "utf8")
  for (const pageSource of [landingSource, marketSource]) {
    assert.match(pageSource, /queryKey: PUBLIC_PA_JOBS_RAW_QUERY_KEY/)
    assert.match(pageSource, /queryFn: \(\) => fetchPublicPaJobsRaw\(PUBLIC_PA_JOBS_RAW_LIMIT\)/)
  }
  // Neither page re-issues its own ad-hoc publicVisible getDocs read.
  assert.doesNotMatch(landingSource, /getDocs\(/)
  assert.doesNotMatch(marketSource, /getDocs\(/)
})
