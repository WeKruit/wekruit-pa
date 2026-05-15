/**
 * Phase 52 — Canonical tag vocab tests.
 *
 * Covers REQ-IDs TAG-01..TAG-12.
 *
 * Run via: `pnpm --filter @wekruit/shared-tags test`.
 */

import { describe, it } from "node:test"
import assert from "node:assert/strict"

import {
  ROLE_FUNCTION_VOCAB,
  RoleFunctionSchema,
} from "../canonical/role-function.js"
import {
  INDUSTRY_SECTOR_VOCAB,
  IndustrySectorSchema,
} from "../canonical/industry-sector.js"
import { MAJOR_VOCAB, MajorSchema } from "../canonical/major.js"
import { VISA_VOCAB, VisaSchema } from "../canonical/visa.js"
import { JOB_TYPE_VOCAB, JobTypeSchema } from "../canonical/job-type.js"
import {
  CAREER_STAGE_VOCAB,
  CareerStageSchema,
  acceptableCareerStages,
} from "../canonical/career-stage.js"
import {
  LOCATION_VOCAB,
  LocationSchema,
  ANYWHERE_LOCATION_TOKENS,
} from "../canonical/location.js"
import {
  RELEVANT_TAG_PATTERN,
  RELEVANT_TAGS_MAX,
  RelevantTagSchema,
  RelevantTagsListSchema,
  validateRelevantTag,
  capRelevantTags,
} from "../canonical/relevant-tags.js"
import {
  SKILL_BUCKET_VOCAB,
  SkillBucketSchema,
  SkillSchema,
  makeSkill,
} from "../canonical/skills.js"
import {
  validateCanonicalToken,
  assertValidCanonicalToken,
  KNOWN_ABBREVIATIONS,
} from "../canonical/validation.js"
import {
  CanonicalTagOverlaySchema,
  resolveCanonicalVocab,
  CANONICAL_OVERLAY_COLLECTION,
  overlayDocId,
  type OverlayDb,
} from "../canonical/overlay.js"
import {
  ALL_CANONICAL_VOCABS,
  CANONICAL_VOCAB_NAMES,
} from "../canonical/registry.js"
import {
  COMPANY_STAGE_VOCAB,
  CompanyStageSchema,
} from "../canonical/company-stage.js"
import {
  COMPANY_TAG_VOCAB,
  COMPANY_TAG_PATTERN,
  CompanyTagSchema,
  CompanyTagListSchema,
} from "../canonical/company-tag.js"

// ─────────────────────────────────────────────────────────────────
// TAG-01 — roleFunction (17 jobright utm_campaign verbatim)
// ─────────────────────────────────────────────────────────────────

describe("TAG-01: roleFunction vocab", () => {
  it("has exactly 17 values", () => {
    assert.equal(ROLE_FUNCTION_VOCAB.length, 17)
  })

  it("includes core jobright utm_campaign tokens", () => {
    const set = new Set(ROLE_FUNCTION_VOCAB)
    assert.ok(set.has("software_engineering"))
    assert.ok(set.has("product_management"))
    assert.ok(set.has("legal_and_compliance"))
    assert.ok(set.has("customer_service_and_support"))
    assert.ok(set.has("public_sector_and_government"))
  })

  it("uses no abbreviations (D5)", () => {
    assert.ok(!ROLE_FUNCTION_VOCAB.includes("swe" as never))
    assert.ok(!ROLE_FUNCTION_VOCAB.includes("pm" as never))
  })

  it("RoleFunctionSchema accepts canonical and rejects unknown", () => {
    assert.equal(
      RoleFunctionSchema.safeParse("software_engineering").success,
      true,
    )
    assert.equal(RoleFunctionSchema.safeParse("swe").success, false)
    assert.equal(RoleFunctionSchema.safeParse("Software Engineering").success, false)
  })
})

// ─────────────────────────────────────────────────────────────────
// TAG-02 — industrySector (42+ spelled-out, includes 4 mandate)
// ─────────────────────────────────────────────────────────────────

describe("TAG-02: industrySector vocab", () => {
  it("has at least 42 values", () => {
    assert.ok(
      INDUSTRY_SECTOR_VOCAB.length >= 42,
      `expected >= 42, got ${INDUSTRY_SECTOR_VOCAB.length}`,
    )
  })

  it("includes the 4 D2-mandated tokens", () => {
    const set = new Set(INDUSTRY_SECTOR_VOCAB)
    assert.ok(set.has("crypto_web3_blockchain"))
    assert.ok(set.has("gaming_and_esports"))
    assert.ok(set.has("artificial_intelligence_and_machine_learning"))
    assert.ok(set.has("accessibility_and_assistive_technology"))
  })

  it("rejects abbreviated industry tokens", () => {
    assert.equal(IndustrySectorSchema.safeParse("ai").success, false)
    assert.equal(IndustrySectorSchema.safeParse("fintech").success, false)
    assert.equal(IndustrySectorSchema.safeParse("crypto").success, false)
  })

  it("accepts canonical industry tokens", () => {
    assert.equal(
      IndustrySectorSchema.safeParse("financial_technology").success,
      true,
    )
  })
})

// ─────────────────────────────────────────────────────────────────
// TAG-03 — major (45+ values, soft signal)
// ─────────────────────────────────────────────────────────────────

describe("TAG-03: major vocab", () => {
  it("has at least 45 values", () => {
    assert.ok(
      MAJOR_VOCAB.length >= 45,
      `expected >= 45, got ${MAJOR_VOCAB.length}`,
    )
  })

  it("includes core engineering majors", () => {
    const set = new Set(MAJOR_VOCAB)
    assert.ok(set.has("computer_science"))
    assert.ok(set.has("electrical_engineering"))
    assert.ok(set.has("mechanical_engineering"))
  })

  it("MajorSchema rejects unknown majors", () => {
    assert.equal(MajorSchema.safeParse("comp_sci").success, false)
  })
})

// ─────────────────────────────────────────────────────────────────
// TAG-04 — visa (exactly 4)
// ─────────────────────────────────────────────────────────────────

describe("TAG-04: visa vocab", () => {
  it("has exactly 4 values", () => {
    assert.equal(VISA_VOCAB.length, 4)
  })

  it("contains the 4 D4-locked values", () => {
    const set = new Set(VISA_VOCAB)
    assert.ok(set.has("citizen"))
    assert.ok(set.has("permanent_resident"))
    assert.ok(set.has("sponsor_needed"))
    assert.ok(set.has("other"))
  })

  it("does NOT split OPT/CPT/H1B (D4)", () => {
    const set = new Set(VISA_VOCAB) as Set<string>
    assert.ok(!set.has("opt"))
    assert.ok(!set.has("cpt"))
    assert.ok(!set.has("h1b"))
    assert.equal(VisaSchema.safeParse("opt").success, false)
    assert.equal(VisaSchema.safeParse("cpt").success, false)
    assert.equal(VisaSchema.safeParse("h1b").success, false)
  })

  it("VisaSchema accepts only the 4 canonical values", () => {
    assert.equal(VisaSchema.safeParse("citizen").success, true)
    assert.equal(VisaSchema.safeParse("permanent_resident").success, true)
    assert.equal(VisaSchema.safeParse("sponsor_needed").success, true)
    assert.equal(VisaSchema.safeParse("other").success, true)
  })
})

// ─────────────────────────────────────────────────────────────────
// TAG-05 — jobType (10)
// ─────────────────────────────────────────────────────────────────

describe("TAG-05: jobType vocab", () => {
  it("has exactly 10 values", () => {
    assert.equal(JOB_TYPE_VOCAB.length, 10)
  })

  it("includes all canonical job types", () => {
    const set = new Set(JOB_TYPE_VOCAB)
    for (const t of [
      "full_time",
      "internship",
      "new_graduate",
      "contract",
      "part_time",
      "fellowship",
      "apprenticeship",
      "freelance",
      "return_to_work_program",
      "co_op_rotation",
    ]) {
      assert.ok(set.has(t as never), `missing ${t}`)
    }
  })

  it("JobTypeSchema rejects abbreviation `ft`", () => {
    assert.equal(JobTypeSchema.safeParse("ft").success, false)
  })
})

// ─────────────────────────────────────────────────────────────────
// TAG-06 — careerStage (13)
// ─────────────────────────────────────────────────────────────────

describe("TAG-06: careerStage vocab", () => {
  it("has exactly 13 values", () => {
    assert.equal(CAREER_STAGE_VOCAB.length, 13)
  })

  it("CareerStageSchema accepts canonical stages", () => {
    assert.equal(CareerStageSchema.safeParse("entry_level").success, true)
    assert.equal(CareerStageSchema.safeParse("senior").success, true)
    assert.equal(CareerStageSchema.safeParse("c_level").success, true)
  })

  it("acceptableCareerStages window includes adjacent tier", () => {
    const r = acceptableCareerStages("entry_level")
    assert.ok(r.includes("entry_level"))
    assert.ok(r.includes("junior"))
  })
})

// ─────────────────────────────────────────────────────────────────
// TAG-07 — location (>=130)
// ─────────────────────────────────────────────────────────────────

describe("TAG-07: location vocab", () => {
  it("has at least 130 values", () => {
    assert.ok(
      LOCATION_VOCAB.length >= 130,
      `expected >= 130, got ${LOCATION_VOCAB.length}`,
    )
  })

  it("includes US/CA/EU/APAC/LATAM/MEA representative metros", () => {
    const set = new Set(LOCATION_VOCAB) as Set<string>
    assert.ok(set.has("san_francisco_bay_area"))
    assert.ok(set.has("new_york_metro"))
    assert.ok(set.has("toronto"))
    assert.ok(set.has("london_united_kingdom"))
    assert.ok(set.has("singapore"))
    assert.ok(set.has("sao_paulo"))
    assert.ok(set.has("tel_aviv"))
  })

  it("includes remote variants and anywhere bypass tokens", () => {
    const set = new Set(LOCATION_VOCAB) as Set<string>
    assert.ok(set.has("remote_united_states"))
    assert.ok(set.has("remote_global"))
    assert.ok(set.has("remote_anywhere"))
    assert.ok(ANYWHERE_LOCATION_TOKENS.has("remote_anywhere"))
    assert.ok(ANYWHERE_LOCATION_TOKENS.has("remote_global"))
  })

  it("LocationSchema rejects abbreviation `sf`", () => {
    assert.equal(LocationSchema.safeParse("sf").success, false)
    assert.equal(LocationSchema.safeParse("nyc").success, false)
  })
})

// ─────────────────────────────────────────────────────────────────
// TAG-08 — relevantTags (open vocab, max 12)
// ─────────────────────────────────────────────────────────────────

describe("TAG-08: relevantTags open-vocab", () => {
  it("max cap is 12", () => {
    assert.equal(RELEVANT_TAGS_MAX, 12)
  })

  it("pattern accepts canonical-form tokens", () => {
    assert.ok(RELEVANT_TAG_PATTERN.test("developer_tools"))
    assert.ok(RELEVANT_TAG_PATTERN.test("b2b_saas"))
    assert.ok(RELEVANT_TAG_PATTERN.test("large_language_model_training"))
  })

  it("pattern rejects spaces, uppercase, leading digit", () => {
    assert.ok(!RELEVANT_TAG_PATTERN.test("developer tools"))
    assert.ok(!RELEVANT_TAG_PATTERN.test("Developer_Tools"))
    assert.ok(!RELEVANT_TAG_PATTERN.test("3d_printing"))
  })

  it("validateRelevantTag rejects abbreviations", () => {
    const r = validateRelevantTag("swe")
    assert.equal(r.ok, false)
    assert.match(r.reason!, /abbreviation/i)
  })

  it("validateRelevantTag accepts good tag", () => {
    assert.equal(validateRelevantTag("developer_tools").ok, true)
  })

  it("RelevantTagsListSchema rejects > 12 tags", () => {
    const tags = Array.from({ length: 13 }, (_, i) => `tag_${i + 1}`)
    assert.equal(RelevantTagsListSchema.safeParse(tags).success, false)
  })

  it("RelevantTagsListSchema accepts exactly 12 tags", () => {
    const tags = Array.from({ length: 12 }, (_, i) => `tag_${i + 1}`)
    assert.equal(RelevantTagsListSchema.safeParse(tags).success, true)
  })

  it("capRelevantTags trims to 12", () => {
    const tags = Array.from({ length: 17 }, (_, i) => `tag_${i + 1}`)
    const capped = capRelevantTags(tags)
    assert.equal(capped.length, 12)
    assert.equal(capped[0], "tag_1")
    assert.equal(capped[11], "tag_12")
  })

  it("RelevantTagSchema rejects abbreviation token", () => {
    assert.equal(RelevantTagSchema.safeParse("swe").success, false)
  })
})

// ─────────────────────────────────────────────────────────────────
// TAG-09 — skills bucketed open-vocab
// ─────────────────────────────────────────────────────────────────

describe("TAG-09: skills bucketed vocab", () => {
  it("has exactly 10 buckets", () => {
    assert.equal(SKILL_BUCKET_VOCAB.length, 10)
  })

  it("SkillBucketSchema accepts canonical buckets", () => {
    assert.equal(SkillBucketSchema.safeParse("programming_languages").success, true)
    assert.equal(SkillBucketSchema.safeParse("data_and_ml").success, true)
  })

  it("SkillSchema parses a fully populated skill", () => {
    const r = SkillSchema.parse({
      name: "python",
      bucket: "programming_languages",
      proficiency: "advanced",
      evidenceCount: 5,
      baseWeight: 0.9,
    })
    assert.equal(r.name, "python")
    assert.equal(r.bucket, "programming_languages")
  })

  it("SkillSchema rejects abbreviated names", () => {
    const r = SkillSchema.safeParse({
      name: "py",
      bucket: "programming_languages",
      proficiency: "advanced",
      evidenceCount: 1,
      baseWeight: 0.5,
    })
    assert.equal(r.success, false)
  })

  it("SkillSchema rejects k8s abbreviation", () => {
    const r = SkillSchema.safeParse({
      name: "k8s",
      bucket: "cloud_and_infrastructure",
      proficiency: "advanced",
      evidenceCount: 1,
      baseWeight: 0.5,
    })
    assert.equal(r.success, false)
  })

  it("SkillSchema accepts complex names like c++ and node.js", () => {
    assert.equal(
      SkillSchema.safeParse({
        name: "c++",
        bucket: "programming_languages",
        proficiency: "intermediate",
        evidenceCount: 1,
        baseWeight: 0.5,
      }).success,
      true,
    )
    assert.equal(
      SkillSchema.safeParse({
        name: "node.js",
        bucket: "frameworks_and_libraries",
        proficiency: "intermediate",
        evidenceCount: 1,
        baseWeight: 0.5,
      }).success,
      true,
    )
  })

  it("makeSkill builds defaults", () => {
    const s = makeSkill("kubernetes", "cloud_and_infrastructure")
    assert.equal(s.name, "kubernetes")
    assert.equal(s.proficiency, "intermediate")
    assert.equal(s.baseWeight, 0.5)
    assert.equal(s.evidenceCount, 1)
  })
})

// ─────────────────────────────────────────────────────────────────
// TAG-10 — registry covers all 9 axes
// ─────────────────────────────────────────────────────────────────

describe("TAG-10: ALL_CANONICAL_VOCABS registry", () => {
  it("covers 11 canonical axes", () => {
    const expected = [
      "roleFunction",
      "industrySector",
      "major",
      "visa",
      "jobType",
      "careerStage",
      "location",
      "relevantTags",
      "skillBucket",
      "companyStage",
      "companyTag",
    ]
    for (const name of expected) {
      assert.ok(
        CANONICAL_VOCAB_NAMES.includes(name),
        `registry missing ${name}`,
      )
    }
    assert.equal(CANONICAL_VOCAB_NAMES.length, 11)
  })

  it("each entry has values + schema + matchSemantics", () => {
    for (const [name, entry] of Object.entries(ALL_CANONICAL_VOCABS)) {
      assert.equal(entry.name, name, `entry name should match key`)
      assert.ok(entry.schema, `${name} should have schema`)
      assert.ok(
        entry.matchSemantics === "hard_filter" ||
          entry.matchSemantics === "soft_score",
        `${name} matchSemantics should be hard_filter or soft_score`,
      )
    }
  })

  it("industrySector has supportsOverlay=true (D16)", () => {
    assert.equal(ALL_CANONICAL_VOCABS.industrySector.supportsOverlay, true)
  })

  it("relevantTags has isOpenVocab=true with pattern", () => {
    assert.equal(ALL_CANONICAL_VOCABS.relevantTags.isOpenVocab, true)
    assert.ok(ALL_CANONICAL_VOCABS.relevantTags.pattern instanceof RegExp)
  })

  it("major is soft_score (D3)", () => {
    assert.equal(ALL_CANONICAL_VOCABS.major.matchSemantics, "soft_score")
  })

  it("visa is hard_filter (MATCH-04)", () => {
    assert.equal(ALL_CANONICAL_VOCABS.visa.matchSemantics, "hard_filter")
  })
})

// ─────────────────────────────────────────────────────────────────
// TAG-11 — Firestore overlay schema + resolver
// ─────────────────────────────────────────────────────────────────

describe("TAG-11: Firestore overlay schema", () => {
  it("CANONICAL_OVERLAY_COLLECTION matches Adam-locked name", () => {
    assert.equal(CANONICAL_OVERLAY_COLLECTION, "pa-canonical-tags")
  })

  it("CanonicalTagOverlaySchema parses a sandbox doc", () => {
    const doc = {
      vocab: "industry-sector",
      token: "developer_tools",
      status: "sandbox",
      proposedBy: "user-abc",
      proposedAt: "2026-05-06T00:00:00.000Z",
      evidence: [
        {
          rawText: "Developer Tools",
          source: "pa-cv-ingest",
          sourceDocId: "cv-1",
        },
      ],
      promotedAt: null,
      promotedBy: null,
      count: 3,
    }
    const r = CanonicalTagOverlaySchema.parse(doc)
    assert.equal(r.token, "developer_tools")
    assert.equal(r.status, "sandbox")
  })

  it("CanonicalTagOverlaySchema rejects uppercase token", () => {
    const r = CanonicalTagOverlaySchema.safeParse({
      vocab: "industry-sector",
      token: "Developer_Tools",
      status: "sandbox",
      proposedBy: "user-abc",
      proposedAt: "2026-05-06T00:00:00.000Z",
      evidence: [],
      count: 1,
    })
    assert.equal(r.success, false)
  })

  it("CanonicalTagOverlaySchema rejects unknown status", () => {
    const r = CanonicalTagOverlaySchema.safeParse({
      vocab: "industry-sector",
      token: "developer_tools",
      status: "approved", // not in enum
      proposedBy: "user-abc",
      proposedAt: "2026-05-06T00:00:00.000Z",
      evidence: [],
      count: 1,
    })
    assert.equal(r.success, false)
  })

  it("overlayDocId returns vocab__token form", () => {
    assert.equal(
      overlayDocId("industry-sector", "developer_tools"),
      "industry-sector__developer_tools",
    )
  })

  it("resolveCanonicalVocab without db returns static only", async () => {
    const r = await resolveCanonicalVocab(
      "industry-sector",
      INDUSTRY_SECTOR_VOCAB,
    )
    assert.equal(r.length, INDUSTRY_SECTOR_VOCAB.length)
    assert.equal(r[0], INDUSTRY_SECTOR_VOCAB[0])
  })

  it("resolveCanonicalVocab merges static + promoted from db", async () => {
    const promotedDocs = [
      { data: () => ({
        vocab: "industry-sector",
        token: "developer_tools",
        status: "promoted",
        proposedBy: "admin-1",
        proposedAt: "2026-05-06T00:00:00.000Z",
        evidence: [],
        promotedAt: "2026-05-06T01:00:00.000Z",
        promotedBy: "admin-1",
        count: 5,
      }) },
      { data: () => ({
        vocab: "industry-sector",
        token: "creator_economy",
        status: "promoted",
        proposedBy: "admin-1",
        proposedAt: "2026-05-06T00:00:00.000Z",
        evidence: [],
        promotedAt: "2026-05-06T01:00:00.000Z",
        promotedBy: "admin-1",
        count: 5,
      }) },
    ]
    const fakeDb: OverlayDb = {
      collection(name: string) {
        assert.equal(name, "pa-canonical-tags")
        return {
          where(_field: string, _op: string, _value: string) {
            return {
              where(_f2: string, _o2: string, _v2: string) {
                return {
                  async get() {
                    return { docs: promotedDocs }
                  },
                }
              },
              async get() {
                return { docs: promotedDocs }
              },
            }
          },
        }
      },
    }
    const r = await resolveCanonicalVocab(
      "industry-sector",
      INDUSTRY_SECTOR_VOCAB,
      fakeDb,
    )
    assert.ok(r.length > INDUSTRY_SECTOR_VOCAB.length)
    assert.ok(r.includes("developer_tools"))
    assert.ok(r.includes("creator_economy"))
    // Static order preserved
    assert.equal(r[0], INDUSTRY_SECTOR_VOCAB[0])
  })

  it("resolveCanonicalVocab dedupes overlapping promoted tokens", async () => {
    const promotedDocs = [
      { data: () => ({
        vocab: "industry-sector",
        token: "financial_technology", // already in static vocab
        status: "promoted",
        proposedBy: "admin-1",
        proposedAt: "2026-05-06T00:00:00.000Z",
        evidence: [],
        promotedAt: "2026-05-06T01:00:00.000Z",
        promotedBy: "admin-1",
        count: 1,
      }) },
    ]
    const fakeDb: OverlayDb = {
      collection() {
        return {
          where() {
            return {
              where() {
                return {
                  async get() {
                    return { docs: promotedDocs }
                  },
                }
              },
              async get() {
                return { docs: promotedDocs }
              },
            }
          },
        }
      },
    }
    const r = await resolveCanonicalVocab(
      "industry-sector",
      INDUSTRY_SECTOR_VOCAB,
      fakeDb,
    )
    // Length should stay equal — no dupe added
    assert.equal(r.length, INDUSTRY_SECTOR_VOCAB.length)
  })

  it("resolveCanonicalVocab silently ignores invalid overlay docs", async () => {
    const promotedDocs = [
      { data: () => ({ vocab: "industry-sector" /* missing fields */ }) },
    ]
    const fakeDb: OverlayDb = {
      collection() {
        return {
          where() {
            return {
              where() {
                return {
                  async get() {
                    return { docs: promotedDocs }
                  },
                }
              },
              async get() {
                return { docs: promotedDocs }
              },
            }
          },
        }
      },
    }
    const r = await resolveCanonicalVocab(
      "industry-sector",
      INDUSTRY_SECTOR_VOCAB,
      fakeDb,
    )
    // Length should stay equal — invalid doc skipped
    assert.equal(r.length, INDUSTRY_SECTOR_VOCAB.length)
  })
})

// ─────────────────────────────────────────────────────────────────
// TAG-12 — write-time validation
// ─────────────────────────────────────────────────────────────────

describe("TAG-12: validateCanonicalToken", () => {
  it("rejects abbreviation `swe`", () => {
    const r = validateCanonicalToken("swe", "roleFunction")
    assert.equal(r.ok, false)
    assert.match(r.reason!, /abbreviation/i)
  })

  it("rejects abbreviation `pm`", () => {
    const r = validateCanonicalToken("pm", "roleFunction")
    assert.equal(r.ok, false)
    assert.match(r.reason!, /abbreviation/i)
  })

  it("rejects space `software engineering`", () => {
    const r = validateCanonicalToken(
      "software engineering",
      "roleFunction",
    )
    assert.equal(r.ok, false)
    assert.match(r.reason!, /space|underscore/i)
  })

  it("rejects uppercase `Software_Engineering`", () => {
    const r = validateCanonicalToken("Software_Engineering", "roleFunction")
    assert.equal(r.ok, false)
    assert.match(r.reason!, /lowercase/i)
  })

  it("accepts canonical `software_engineering`", () => {
    const r = validateCanonicalToken(
      "software_engineering",
      "roleFunction",
    )
    assert.equal(r.ok, true)
  })

  it("rejects empty string", () => {
    const r = validateCanonicalToken("", "roleFunction")
    assert.equal(r.ok, false)
  })

  it("rejects too-short tokens (< 3 chars)", () => {
    const r = validateCanonicalToken("ab", "roleFunction")
    assert.equal(r.ok, false)
    assert.match(r.reason!, /short|abbreviation/i)
  })

  it("rejects token starting with digit", () => {
    const r = validateCanonicalToken("3d_printing", "industrySector")
    assert.equal(r.ok, false)
  })

  it("KNOWN_ABBREVIATIONS includes core LLM-confusing tokens", () => {
    for (const a of [
      "swe",
      "pm",
      "sf",
      "nyc",
      "k8s",
      "ml",
      "ai",
      "ux",
      "ui",
      "js",
      "ts",
      "py",
    ]) {
      assert.ok(KNOWN_ABBREVIATIONS.has(a), `missing abbreviation ${a}`)
    }
  })

  it("assertValidCanonicalToken throws on bad input", () => {
    assert.throws(() => assertValidCanonicalToken("swe", "roleFunction"))
  })

  it("assertValidCanonicalToken does not throw on good input", () => {
    assertValidCanonicalToken("software_engineering", "roleFunction")
  })
})

// ─────────────────────────────────────────────────────────────────
// Phase A2 — companyStage (11 closed) + companyTag (open seed)
// ─────────────────────────────────────────────────────────────────

describe("A2: companyStage vocab", () => {
  it("has exactly 11 values", () => {
    assert.equal(COMPANY_STAGE_VOCAB.length, 11)
  })

  it("includes the locked enum tokens", () => {
    const set = new Set(COMPANY_STAGE_VOCAB)
    for (const t of [
      "pre_seed",
      "seed",
      "series_a",
      "series_b",
      "series_c",
      "series_d_plus",
      "ipo_public",
      "private_mature",
      "bootstrapped",
      "non_profit",
      "unknown",
    ]) {
      assert.ok(set.has(t as never), `missing ${t}`)
    }
  })

  it("CompanyStageSchema accepts canonical and rejects unknown", () => {
    assert.equal(CompanyStageSchema.safeParse("series_a").success, true)
    assert.equal(CompanyStageSchema.safeParse("unknown").success, true)
    assert.equal(CompanyStageSchema.safeParse("Series A").success, false)
    assert.equal(CompanyStageSchema.safeParse("late_stage").success, false)
  })
})

describe("A2: companyTag open-vocab", () => {
  it("seed list has at least 11 tokens", () => {
    assert.ok(COMPANY_TAG_VOCAB.length >= 11)
  })

  it("seed list includes the locked tokens", () => {
    const set = new Set(COMPANY_TAG_VOCAB)
    for (const t of [
      "big_tech",
      "mag_7",
      "yc_active",
      "yc_alumni",
      "unicorn",
      "ai_native",
      "fintech_unicorn",
    ]) {
      assert.ok(set.has(t as never), `missing seed token ${t}`)
    }
  })

  it("pattern accepts canonical-form tokens incl. promoted additions", () => {
    assert.ok(COMPANY_TAG_PATTERN.test("ai_native"))
    assert.ok(COMPANY_TAG_PATTERN.test("yc_alumni"))
    assert.ok(COMPANY_TAG_PATTERN.test("developer_tools_native"))
  })

  it("pattern rejects spaces, uppercase, leading digit", () => {
    assert.ok(!COMPANY_TAG_PATTERN.test("Big Tech"))
    assert.ok(!COMPANY_TAG_PATTERN.test("Big_Tech"))
    assert.ok(!COMPANY_TAG_PATTERN.test("7_eleven"))
  })

  it("CompanyTagSchema accepts seed + admin-promoted style tokens", () => {
    assert.equal(CompanyTagSchema.safeParse("big_tech").success, true)
    assert.equal(CompanyTagSchema.safeParse("emerging_robotics").success, true)
  })

  it("CompanyTagSchema rejects malformed tokens", () => {
    assert.equal(CompanyTagSchema.safeParse("Big Tech").success, false)
    assert.equal(CompanyTagSchema.safeParse("AI").success, false)
    assert.equal(CompanyTagSchema.safeParse("7eleven").success, false)
  })

  it("CompanyTagListSchema accepts arrays of valid tags", () => {
    assert.equal(
      CompanyTagListSchema.safeParse(["big_tech", "ai_native"]).success,
      true,
    )
  })

  it("registry entry has supportsOverlay=true and isOpenVocab=true", () => {
    assert.equal(ALL_CANONICAL_VOCABS.companyTag.supportsOverlay, true)
    assert.equal(ALL_CANONICAL_VOCABS.companyTag.isOpenVocab, true)
    assert.ok(ALL_CANONICAL_VOCABS.companyTag.pattern instanceof RegExp)
  })

  it("companyStage registry entry is closed-vocab soft_score", () => {
    assert.equal(ALL_CANONICAL_VOCABS.companyStage.isOpenVocab, false)
    assert.equal(
      ALL_CANONICAL_VOCABS.companyStage.matchSemantics,
      "soft_score",
    )
  })
})
