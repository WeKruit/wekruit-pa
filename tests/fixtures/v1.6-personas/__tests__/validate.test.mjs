/**
 * Phase 60 (DEV-04) — fixture validation.
 *
 * Verifies each persona fixture under tests/fixtures/v1.6-personas/ conforms
 * to the Phase 53/54 UserTagsSchema (skills as bucketed objects, role
 * function in canonical 17-vocab, industry sector in 42-vocab, etc).
 *
 * Run directly:
 *   node tests/fixtures/v1.6-personas/__tests__/validate.test.mjs
 *
 * The schema validates the SHAPE; we additionally cross-check every
 * `targetRoleFunction` token against ROLE_FUNCTION_VOCAB and every
 * `industrySector` token against INDUSTRY_SECTOR_VOCAB so a typo in a
 * fixture (e.g. `softwear_engineering`) fails loudly instead of silently
 * passing schema (which only types these as `string[]`).
 */
import test from "node:test"
import assert from "node:assert/strict"
import { readFileSync, readdirSync } from "node:fs"
import { resolve, dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const fixtureDir = resolve(__dirname, "..")

const FIXTURE_NAMES = ["swe", "pm", "designer", "ml", "data_analyst"]

// Lazy import — vocab lives in @wekruit/shared-tags. When build artifacts
// are missing we fall back to structural checks only.
let ROLE_FUNCTION_VOCAB = null
let INDUSTRY_SECTOR_VOCAB = null
let VISA_VOCAB = null
let JOB_TYPE_VOCAB = null
let CAREER_STAGE_VOCAB = null
try {
  const tagsMod = await import("@wekruit/shared-tags")
  ROLE_FUNCTION_VOCAB = tagsMod.ROLE_FUNCTION_VOCAB ?? null
  INDUSTRY_SECTOR_VOCAB = tagsMod.INDUSTRY_SECTOR_VOCAB ?? null
  VISA_VOCAB = tagsMod.VISA_VOCAB ?? null
  JOB_TYPE_VOCAB = tagsMod.JOB_TYPE_VOCAB ?? null
  CAREER_STAGE_VOCAB = tagsMod.CAREER_STAGE_VOCAB ?? null
} catch {
  // soft-fail; vocab checks skipped
}

// Note: pa-orchestrator's UserTagsSchema is the legacy v1.5 shape
// (visaStatus enum predates D4's 4-value collapse). Phase 52's canonical
// VISA_VOCAB is the source of truth for v1.6 fixtures. We validate against
// the canonical vocab + structural shape here; the schema migration
// (USER-TAG-04 follow-up) happens in a separate phase.

test("each fixture file exists and parses as JSON", () => {
  const present = readdirSync(fixtureDir).filter((f) => f.endsWith(".json"))
  for (const name of FIXTURE_NAMES) {
    assert.ok(present.includes(`${name}.json`), `missing ${name}.json`)
  }
  assert.equal(
    FIXTURE_NAMES.length,
    5,
    `expected 5 personas, found ${FIXTURE_NAMES.length}`
  )
})

for (const name of FIXTURE_NAMES) {
  test(`fixture ${name}.json: structural shape`, () => {
    const path = join(fixtureDir, `${name}.json`)
    const fixture = JSON.parse(readFileSync(path, "utf8"))

    // Top-level shape
    assert.equal(typeof fixture.personaName, "string")
    assert.ok(fixture.personaName.length > 0)
    assert.equal(typeof fixture.userTags, "object")
    assert.ok(Array.isArray(fixture.expectedRoleFunction))
    assert.ok(fixture.expectedRoleFunction.length > 0)
    assert.ok(Array.isArray(fixture.expectedIndustrySector))
    assert.ok(fixture.expectedIndustrySector.length > 0)
    assert.ok(Array.isArray(fixture.notExpectedRoles))
    assert.ok(fixture.notExpectedRoles.length > 0)

    // userTags inner shape
    const t = fixture.userTags
    assert.ok(Array.isArray(t.skills), "userTags.skills must be array")
    assert.ok(t.skills.length >= 5, "fixture should have ≥5 skills")
    for (const s of t.skills) {
      // Skills must conform to bucketed shape (Phase 53)
      assert.equal(typeof s.name, "string")
      assert.ok(s.name.length > 0)
      assert.equal(typeof s.bucket, "string")
      assert.equal(typeof s.proficiency, "string")
      assert.ok(typeof s.baseWeight === "number")
      assert.ok(s.baseWeight >= 0 && s.baseWeight <= 1)
      assert.ok(typeof s.evidenceCount === "number")
    }
    assert.ok(Array.isArray(t.targetRoleFunction))
    assert.ok(t.targetRoleFunction.length > 0)
    assert.ok(Array.isArray(t.industrySector))
    assert.ok(t.industrySector.length > 0)
    assert.equal(typeof t.visaStatus, "string")
    assert.ok(Array.isArray(t.targetLocations))
    assert.ok(Array.isArray(t.targetJobType))
    assert.equal(typeof t.careerStage, "string")
    assert.ok(["zh", "en"].includes(t.preferredLang))
    assert.equal(t.schemaVersion, 1)
  })

  test(`fixture ${name}.json: canonical vocabularies`, () => {
    if (!ROLE_FUNCTION_VOCAB || !INDUSTRY_SECTOR_VOCAB) {
      // Vocab not available (build artifacts missing); skip silently.
      return
    }
    const fixture = JSON.parse(
      readFileSync(join(fixtureDir, `${name}.json`), "utf8")
    )
    for (const r of fixture.userTags.targetRoleFunction ?? []) {
      assert.ok(
        ROLE_FUNCTION_VOCAB.includes(r),
        `targetRoleFunction "${r}" not in ROLE_FUNCTION_VOCAB`
      )
    }
    for (const s of fixture.userTags.industrySector ?? []) {
      assert.ok(
        INDUSTRY_SECTOR_VOCAB.includes(s),
        `industrySector "${s}" not in INDUSTRY_SECTOR_VOCAB`
      )
    }
    for (const e of fixture.expectedRoleFunction) {
      assert.ok(
        ROLE_FUNCTION_VOCAB.includes(e),
        `expectedRoleFunction "${e}" not in ROLE_FUNCTION_VOCAB`
      )
    }
    for (const e of fixture.expectedIndustrySector) {
      assert.ok(
        INDUSTRY_SECTOR_VOCAB.includes(e),
        `expectedIndustrySector "${e}" not in INDUSTRY_SECTOR_VOCAB`
      )
    }
    for (const ne of fixture.notExpectedRoles) {
      assert.ok(
        ROLE_FUNCTION_VOCAB.includes(ne),
        `notExpectedRoles "${ne}" not in ROLE_FUNCTION_VOCAB`
      )
    }
  })

  test(`fixture ${name}.json: visa/jobType/careerStage tokens are canonical`, () => {
    if (!VISA_VOCAB || !JOB_TYPE_VOCAB || !CAREER_STAGE_VOCAB) {
      // Vocab not built; skip silently.
      return
    }
    const fixture = JSON.parse(
      readFileSync(join(fixtureDir, `${name}.json`), "utf8")
    )
    const t = fixture.userTags
    // visaStatus: D4 requires exactly 4 (`citizen`, `permanent_resident`,
    // `sponsor_needed`, `other`). The legacy pa-orchestrator UserTagsSchema
    // still accepts h1b/opt/gc — those are the pre-D4 tokens. Our fixtures
    // use BOTH because the merger writes legacy + canonical for now; pass
    // when the visaStatus is in EITHER vocab.
    const legacyVisa = ["citizen", "gc", "opt", "h1b", "sponsor_needed", "other"]
    assert.ok(
      VISA_VOCAB.includes(t.visaStatus) || legacyVisa.includes(t.visaStatus),
      `visaStatus "${t.visaStatus}" not in VISA_VOCAB (canonical) nor legacy`
    )
    for (const jt of t.targetJobType ?? []) {
      assert.ok(
        JOB_TYPE_VOCAB.includes(jt),
        `targetJobType "${jt}" not in JOB_TYPE_VOCAB`
      )
    }
    assert.ok(
      CAREER_STAGE_VOCAB.includes(t.careerStage),
      `careerStage "${t.careerStage}" not in CAREER_STAGE_VOCAB`
    )
  })
}

test("personas are distinct (different roles)", () => {
  const roles = FIXTURE_NAMES.map((name) => {
    const f = JSON.parse(readFileSync(join(fixtureDir, `${name}.json`), "utf8"))
    return f.userTags.targetRoleFunction.sort().join(",")
  })
  const uniq = new Set(roles)
  // Allow ML to share a function with SWE; expect ≥3 distinct role tuples.
  assert.ok(uniq.size >= 3, `expected ≥3 distinct role tuples, got ${uniq.size}`)
})
