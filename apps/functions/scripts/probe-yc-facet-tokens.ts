/**
 * BEFORE/AFTER for the facet stage: legacy substring `looseHit` vs canonical-token equality.
 *
 * READ-ONLY against production. Loads the live cohort, runs each facet ask through BOTH
 * implementations, and prints hit counts side by side. The legacy implementation is COPIED IN
 * VERBATIM below and frozen — it is the baseline, so it must not move when the original is deleted.
 *
 * Two things are being measured at once and they pull in opposite directions:
 *   1. the documented false positives must go to zero ("rl" → 63 world/early people, skill "c" as a
 *      wildcard, "chi" hitting "machine learning");
 *   2. real recall must NOT collapse ("Berkeley" must still find "University of California,
 *      Berkeley"). Canonicalization that is too strict returns empty for the same reason a broken
 *      regex does, so both numbers have to be read together.
 *
 * Run:
 *   export GOOGLE_APPLICATION_CREDENTIALS=... ;
 *   node --import tsx apps/functions/scripts/probe-yc-facet-tokens.ts [cohort]
 */
import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { normalizeSkillToken } from "../src/skill-token.js"
import { YC_COHORT_2026, loadCohortPool, passesFacets, type PeoplePoolMember } from "../src/yc-people-match.js"

const require = createRequire(`${process.cwd()}/apps/functions/`)
const admin = require("firebase-admin")

// ───────────────────────── legacy implementation, frozen ─────────────────────────
// Verbatim from yc-people-match.ts @ 7e4ea1c4, before the token rewrite. Do not "fix" it.
function escapeRe(x: string): string {
  return x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}
const MIN_REVERSE_MATCH = 4
function legacyLooseHit(haystack: string[], needles: string[]): boolean {
  if (needles.length === 0) return true
  const hay = haystack.map((h) => h.trim().toLowerCase()).filter((h) => h.length > 0)
  return needles.some((n) => {
    const q = n.trim().toLowerCase()
    if (!q) return false
    return hay.some((h) => {
      if (q.length < MIN_REVERSE_MATCH) {
        if (new RegExp(`\\b${escapeRe(q)}\\b`).test(h)) return true
      } else if (h.includes(q)) return true
      if (h.length < MIN_REVERSE_MATCH) return false
      return new RegExp(`\\b${escapeRe(h)}\\b`).test(q)
    })
  })
}
function legacySkillNeedles(values: string[]): string[] {
  return values.flatMap((s) => {
    const norm = normalizeSkillToken(s)
    return norm && norm !== s.trim().toLowerCase() ? [s, norm] : [s]
  })
}
// ─────────────────────────────────────────────────────────────────────────────────

type Facet = "skills" | "schools" | "companies" | "major" | "location"

function memberValues(m: PeoplePoolMember, facet: Facet): string[] {
  if (facet === "skills") return m.skills
  if (facet === "schools") return m.schools
  if (facet === "companies") return m.companies
  if (facet === "major") return m.majors
  return m.location ? [m.location] : []
}

function legacyHits(pool: PeoplePoolMember[], facet: Facet, values: string[]): PeoplePoolMember[] {
  const needles = facet === "skills" ? legacySkillNeedles(values) : values
  return pool.filter((m) => legacyLooseHit(memberValues(m, facet), needles))
}

/** The AFTER side calls the REAL shipped facet stage — not a replica of it. */
function tokenHits(pool: PeoplePoolMember[], facet: Facet, values: string[]): PeoplePoolMember[] {
  const f = { [facet]: values } as Record<string, string[]>
  return pool.filter((m) => passesFacets(m, f, { schools: [], companies: [], majors: [] }))
}

/** The asks the brief names, plus the recall cases that must survive the fix. */
const CASES: Array<{ label: string; facet: Facet; values: string[]; want: "zero" | "recall" }> = [
  { label: 'skills "rl" (matched world/early)', facet: "skills", values: ["rl"], want: "zero" },
  { label: 'skills "c" (letter-c wildcard)', facet: "skills", values: ["c"], want: "zero" },
  { label: 'skills "chi" (hit machine learning)', facet: "skills", values: ["chi"], want: "zero" },
  { label: 'skills "art" (hit smart)', facet: "skills", values: ["art"], want: "zero" },
  { label: 'skills "ml"', facet: "skills", values: ["ml"], want: "recall" },
  { label: 'skills "machine learning"', facet: "skills", values: ["machine learning"], want: "recall" },
  { label: 'skills "reinforcement learning"', facet: "skills", values: ["reinforcement learning"], want: "recall" },
  { label: 'schools "Berkeley"', facet: "schools", values: ["Berkeley"], want: "recall" },
  { label: 'schools "Stanford"', facet: "schools", values: ["Stanford"], want: "recall" },
  { label: 'schools "MIT"', facet: "schools", values: ["MIT"], want: "recall" },
  { label: 'schools "Harvard"', facet: "schools", values: ["Harvard"], want: "recall" },
  { label: 'schools "Waterloo"', facet: "schools", values: ["Waterloo"], want: "recall" },
  { label: 'companies "Stripe"', facet: "companies", values: ["Stripe"], want: "recall" },
  { label: 'companies "ex-Stripe"', facet: "companies", values: ["ex-Stripe"], want: "recall" },
  { label: 'companies "Google"', facet: "companies", values: ["Google"], want: "recall" },
  { label: 'companies "AWS"', facet: "companies", values: ["AWS"], want: "recall" },
  { label: 'companies "Meta"', facet: "companies", values: ["Meta"], want: "recall" },
  { label: 'major "computer science"', facet: "major", values: ["computer science"], want: "recall" },
  { label: 'major "design"', facet: "major", values: ["design"], want: "recall" },
  { label: 'location "san francisco bay area"', facet: "location", values: ["san_francisco_bay_area"], want: "recall" },
  { label: 'location "new york metro"', facet: "location", values: ["new_york_metro"], want: "recall" },
]

function sample(ms: PeoplePoolMember[], facet: Facet, n = 3): string {
  return ms.slice(0, n).map((m) => `${m.name ?? m.recordId}[${memberValues(m, facet).slice(0, 2).join("/")}]`).join(", ")
}

async function main() {
  const cohort = process.argv[2] ?? YC_COHORT_2026
  admin.initializeApp({
    credential: admin.credential.cert(
      JSON.parse(readFileSync(process.env.GOOGLE_APPLICATION_CREDENTIALS!, "utf8")),
    ),
  })
  const pool = await loadCohortPool(admin.firestore(), cohort)
  console.log(`pool=${pool.length}\n`)
  console.log("want    facet ask                                    before   after   delta")
  console.log("──────────────────────────────────────────────────────────────────────────")
  const worse: string[] = []
  for (const c of CASES) {
    const before = legacyHits(pool, c.facet, c.values)
    const after = tokenHits(pool, c.facet, c.values)
    const d = after.length - before.length
    console.log(
      `${c.want === "zero" ? "ZERO" : "keep"}    ${c.label.padEnd(42)} ${String(before.length).padStart(6)}  ${String(after.length).padStart(6)}  ${d > 0 ? "+" : ""}${d}`,
    )
    if (c.want === "zero" && after.length > 0) worse.push(`${c.label}: still ${after.length} hits — ${sample(after, c.facet)}`)
    if (c.want === "recall" && after.length === 0) worse.push(`${c.label}: recall collapsed to 0 (was ${before.length})`)
    if (c.want === "recall" && before.length > 0 && after.length < before.length * 0.5) {
      worse.push(`${c.label}: recall ${before.length} → ${after.length} (<50%) — before had ${sample(before, c.facet)}`)
    }
  }
  console.log(`\n${worse.length ? "REGRESSIONS / OPEN ITEMS:" : "no regressions"}`)
  for (const w of worse) console.log(`  - ${w}`)
}

void main().then(() => process.exit(0))
