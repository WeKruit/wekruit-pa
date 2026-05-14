/**
 * Header auto-detect — drives the loose-CSV / xlsx ingest path.
 *
 * Fixtures are real Lessie export headers (snapshot 2026-05-14 from
 * `~/Downloads/lessie_export*.xlsx`). Each export uses the same 6 stable
 * headers plus 1 title alias + 1 location field + N per-rubric criterion
 * columns. The mapper must:
 *   - bind Name / Link / Email / Company / Headline / (Title|Job Title)
 *   - bind Country/Region OR collapse Country+State+City via the virtual
 *     `__locationParts__` sentinel
 *   - leave every rubric column in `rubricColumns` verbatim
 *   - capture the score column separately so the dashboard can show it
 *     without polluting `mapping`
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { inferColumnMapping, classifyRubricCell } from "./auto-map.js"

const LESSIE_RUST_HEADERS = [
  "Name",
  "Link",
  "Email",
  "Match",
  "Title",
  "Company",
  "Headline",
  "Country/Region",
  "Solana Expertise",
  "Rust Proficiency",
  "United States",
  "Smart Contract Security",
  "2+ Years",
  "Backend Engineering",
  "Fintech Background",
]

const LESSIE_DESIGN_HEADERS_SPLIT_LOCATION = [
  "Name",
  "Link",
  "Email",
  "Match",
  "Title",
  "Company",
  "Headline",
  "Country",
  "State",
  "City",
  "Design Role",
  "US Location",
  "Exclusions",
  "Consumer Design",
  "Early-Career",
  "Portfolio & Skills",
  "Education",
]

const LESSIE_ANDROID_HEADERS = [
  "Name",
  "Link",
  "Email",
  "Match",
  "Company",
  "Title",
  "Headline",
  "Country/Region",
  "Fintech / Financial",
  "Android Engineer Title",
  "Not Non-Engineer",
  "US-Based",
  "4+ Years Mobile",
  "Kotlin & Android Stack",
  "Founding Engineer",
]

test("inferColumnMapping — Lessie Rust export binds 6 stable cols + rubric remainder", () => {
  const r = inferColumnMapping(LESSIE_RUST_HEADERS)
  assert.equal(r.mapping.name, "Name")
  assert.equal(r.mapping.linkedinUrl, "Link")
  assert.equal(r.mapping.email, "Email")
  assert.equal(r.mapping.currentTitle, "Title")
  assert.equal(r.mapping.currentCompany, "Company")
  assert.equal(r.mapping.location, "Country/Region")
  assert.equal(r.matchScoreColumn, "Match")
  // Headline does NOT get mapped to a canonical field; it becomes rubric.
  assert.ok(
    r.rubricColumns.includes("Headline"),
    "Headline should fall through to rubric",
  )
  assert.ok(r.rubricColumns.includes("Solana Expertise"))
  assert.ok(r.rubricColumns.includes("Rust Proficiency"))
  assert.ok(r.rubricColumns.includes("Smart Contract Security"))
  assert.equal(r.ambiguous.length, 0)
})

test("inferColumnMapping — split Country/State/City collapses into virtual location", () => {
  const r = inferColumnMapping(LESSIE_DESIGN_HEADERS_SPLIT_LOCATION)
  assert.equal(r.mapping.location, "__locationParts__")
  assert.ok(r.locationParts)
  assert.equal(r.locationParts?.country, "Country")
  assert.equal(r.locationParts?.state, "State")
  assert.equal(r.locationParts?.city, "City")
  // Rubric still captures everything else.
  assert.ok(r.rubricColumns.includes("Design Role"))
  assert.ok(r.rubricColumns.includes("Portfolio & Skills"))
})

test("inferColumnMapping — accepts Title OR Job Title as currentTitle", () => {
  const withJobTitle = inferColumnMapping([
    "Name",
    "Link",
    "Email",
    "Match",
    "Company",
    "Headline",
    "Job Title",
    "Country/Region",
    "Engineering Role",
  ])
  assert.equal(withJobTitle.mapping.currentTitle, "Job Title")
})

test("inferColumnMapping — Android headers leave rubric columns verbatim", () => {
  const r = inferColumnMapping(LESSIE_ANDROID_HEADERS)
  assert.equal(r.mapping.name, "Name")
  assert.equal(r.mapping.linkedinUrl, "Link")
  // Order preserved.
  const expected = [
    "Headline",
    "Fintech / Financial",
    "Android Engineer Title",
    "Not Non-Engineer",
    "US-Based",
    "4+ Years Mobile",
    "Kotlin & Android Stack",
    "Founding Engineer",
  ]
  for (const h of expected) assert.ok(r.rubricColumns.includes(h), `missing ${h}`)
})

test("classifyRubricCell — recognizes ✅ / ❌ / Pass / Fail prefixes", () => {
  assert.equal(classifyRubricCell("✅ Strong Rust 5+yrs").passed, true)
  assert.equal(classifyRubricCell("❌ No production Solana").passed, false)
  assert.equal(classifyRubricCell("Pass — has 4 years Android").passed, true)
  assert.equal(classifyRubricCell("Fail: not in US").passed, false)
  assert.equal(classifyRubricCell("Some reasoning prose").passed, null)
  assert.equal(classifyRubricCell("0.82").passed, null)
  assert.equal(classifyRubricCell("").passed, null)
})
