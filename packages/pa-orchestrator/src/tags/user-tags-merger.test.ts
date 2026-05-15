/**
 * iter34 H.1 — Unit tests for mergeUserTags.
 *
 * Coverage:
 *   - full input → fields populated end-to-end
 *   - skills FULL (no truncation; >12 retained)
 *   - skill normalization (lowercase, dedupe, whitespace collapse)
 *   - industryEnum priority chain (cv.industryTags → targetRole → skill
 *     sniff → ["other"])
 *   - recentRoleTitle / recentCompany from workHistory[0] (preferred) or
 *     experiences[0] (legacy fallback)
 *   - workHistorySummary 1-line composition + 200-char soft cap
 *   - embedding pass-through (1536d only)
 *   - StatedPreferences echo + boolean→enum mapping (prefersStartup) +
 *     visa-token rename
 *   - schemaVersion + bookkeeping timestamps
 *   - empty input → minimal valid shape
 *   - zod schema parses generated output
 */

import assert from "node:assert/strict"
import test from "node:test"
import {
  mergeUserTags,
  USER_TAGS_SCHEMA_VERSION,
  UserTagsSchema,
  type UserTagsInput,
} from "./user-tags-merger.js"
import type { StatedPreferences } from "@pa/core-types"

// ---------------------------------------------------------------------------
// happy path
// ---------------------------------------------------------------------------

test("mergeUserTags: full input populates every field across CV + chat sources", () => {
  const input: UserTagsInput = {
    cv: {
      candidateProfile: {
        name: "Adam Goh",
        skills: ["Python", "TypeScript", "react"],
      },
      workHistory: [
        { title: "SWE Intern", company: "Tesla", skills: ["Python", "AWS"] },
        { title: "Delivery Driver", company: "OFO", skills: [] },
      ],
      industryTags: ["tech_software", "ai_ml"],
      embedding: new Array(1536).fill(0.01),
      embeddingModel: "text-embedding-3-small",
      embeddingComputedAt: "2026-05-05T00:00:00.000Z",
    },
    statedPreferences: {
      targetRole: ["swe"],
      yoeRange: [0, 1],
      visaStatus: "opt",
      prefersStartup: true,
      targetLocations: ["sf", "remote"],
      preferredLang: "zh",
    },
    cvUpdatedAt: "2026-05-05T01:00:00.000Z",
    chatUpdatedAt: "2026-05-05T02:00:00.000Z",
  }
  const out = mergeUserTags(input)

  // Skills — full bag, lowercased, deduplicated, AWS pulled in from workHistory.
  // Phase 61 — skills are now Phase 52 SkillEntry objects with bucket /
  // proficiency / evidenceCount / baseWeight defaults.
  assert.deepEqual(
    out.skills.map((s) => s.name),
    ["python", "typescript", "react", "aws"]
  )
  // Phase 52 buckets — auto-inferred via inferSkillBucket heuristic.
  assert.equal(out.skills[0]!.bucket, "programming_languages") // python
  assert.equal(out.skills[2]!.bucket, "frameworks_and_libraries") // react
  assert.equal(out.skills[3]!.bucket, "cloud_and_infrastructure") // aws
  // baseWeight defaults to 1.0 (Phase 56 V16 needs this for skill jaccard)
  assert.equal(out.skills[0]!.baseWeight, 1.0)
  assert.equal(out.skills[0]!.proficiency, "intermediate")
  assert.equal(out.skills[0]!.evidenceCount, 1)
  // Industry — direct from CV.industryTags.
  assert.deepEqual(out.industryEnum, ["tech_software", "ai_ml"])
  assert.equal(out.recentRoleTitle, "SWE Intern")
  assert.equal(out.recentCompany, "Tesla")
  assert.equal(out.workHistorySummary, "SWE Intern @ Tesla; Delivery Driver @ OFO")
  assert.equal(out.embedding!.length, 1536)
  assert.equal(out.embeddingModel, "text-embedding-3-small")
  assert.equal(out.embeddingComputedAt, "2026-05-05T00:00:00.000Z")
  assert.deepEqual(out.targetRole, ["swe"])
  assert.deepEqual(out.yoeRange, [0, 1])
  assert.equal(out.visaStatus, "opt")
  assert.equal(out.prefersStartup, "startup")
  assert.deepEqual(out.targetLocations, ["sf", "remote"])
  assert.equal(out.preferredLang, "zh")
  assert.equal(out.lastUpdatedFromCv, "2026-05-05T01:00:00.000Z")
  assert.equal(out.lastUpdatedFromChat, "2026-05-05T02:00:00.000Z")
  assert.equal(out.schemaVersion, USER_TAGS_SCHEMA_VERSION)
})

// ---------------------------------------------------------------------------
// skills: full + dedupe + normalize
// ---------------------------------------------------------------------------

test("mergeUserTags: skills retains ALL CV skills (no 12-cap truncation)", () => {
  const skillCount = 30
  const skills = Array.from({ length: skillCount }, (_, i) => `Skill_${i}`)
  const out = mergeUserTags({
    cv: { candidateProfile: { skills } },
  })
  assert.equal(out.skills.length, skillCount, "expected full skill bag, no cap")
  // Lowercased + canonicalized via canonicalizeSkillName.
  assert.equal(out.skills[0]!.name, "skill_0")
  assert.equal(out.skills[skillCount - 1]!.name, `skill_${skillCount - 1}`)
})

test("mergeUserTags: skills lowercase + dedupe + whitespace collapse", () => {
  const out = mergeUserTags({
    cv: {
      candidateProfile: { skills: ["Python", "PYTHON", "  python  ", "Type Script", "  Type   Script  "] },
      workHistory: [{ skills: ["python", "REACT"] }],
    },
  })
  // python (3 forms collapsed → 1), type_script (whitespace→underscore via
  // canonicalizeSkillName, 2 forms → 1), react (1).
  assert.deepEqual(
    out.skills.map((s) => s.name),
    ["python", "type_script", "react"]
  )
})

test("mergeUserTags: skills empty when CV has neither candidateProfile nor workHistory skills", () => {
  const out = mergeUserTags({ cv: { candidateProfile: { name: "X" } } })
  assert.deepEqual(out.skills, [])
})

// ---------------------------------------------------------------------------
// industryEnum priority chain
// ---------------------------------------------------------------------------

test("mergeUserTags: industryTags=['other'] + targetRole=['swe'] → fallback to roleToIndustryBuckets", () => {
  const out = mergeUserTags({
    cv: { industryTags: ["other"] },
    statedPreferences: { targetRole: ["swe"] },
  })
  // swe → tech_software, ai_ml, fintech_finance, tech_hardware
  assert.deepEqual(out.industryEnum, [
    "tech_software",
    "ai_ml",
    "fintech_finance",
    "tech_hardware",
  ])
})

test("mergeUserTags: empty industryTags + no targetRole + skills include 'react' → infer ['tech_software']", () => {
  const out = mergeUserTags({
    cv: { candidateProfile: { skills: ["React", "RandomSkill"] }, industryTags: [] },
  })
  assert.deepEqual(out.industryEnum, ["tech_software"])
})

test("mergeUserTags: empty cv + empty statedPreferences → industryEnum = ['other']", () => {
  const out = mergeUserTags({})
  assert.deepEqual(out.industryEnum, ["other"])
})

test("mergeUserTags: industryTags=['tech_software','other'] → drops 'other', keeps tech_software", () => {
  const out = mergeUserTags({
    cv: { industryTags: ["tech_software", "other"] },
  })
  assert.deepEqual(out.industryEnum, ["tech_software"])
})

test("mergeUserTags: industryTags wins over targetRole when both present (CV is canonical signal)", () => {
  const out = mergeUserTags({
    cv: { industryTags: ["healthcare_biotech"] },
    statedPreferences: { targetRole: ["swe"] }, // would otherwise expand to 4 buckets
  })
  assert.deepEqual(out.industryEnum, ["healthcare_biotech"])
})

test("mergeUserTags: targetRole=['founder'] (no-filter signal) falls through to skill sniff", () => {
  // founder → roleToIndustryBuckets returns undefined; should NOT short-circuit
  // to ["founder"] industry. Falls through to skills tech-token sniff.
  const out = mergeUserTags({
    cv: { candidateProfile: { skills: ["JavaScript"] }, industryTags: [] },
    statedPreferences: { targetRole: ["founder"] },
  })
  assert.deepEqual(out.industryEnum, ["tech_software"])
})

test("mergeUserTags: targetRole=['founder'] + no skill signal → ['other']", () => {
  const out = mergeUserTags({
    statedPreferences: { targetRole: ["founder"] },
  })
  assert.deepEqual(out.industryEnum, ["other"])
})

// ---------------------------------------------------------------------------
// recentRoleTitle / recentCompany / workHistorySummary
// ---------------------------------------------------------------------------

test("mergeUserTags: workHistory[0] preferred over experiences[0] for recentRoleTitle / recentCompany", () => {
  const out = mergeUserTags({
    cv: {
      workHistory: [{ title: "Staff SWE", company: "Stripe" }],
      experiences: [{ title: "Junior Dev", company: "OldCo" }],
    },
  })
  assert.equal(out.recentRoleTitle, "Staff SWE")
  assert.equal(out.recentCompany, "Stripe")
})

test("mergeUserTags: experiences[0] used when workHistory absent (legacy v1 CV)", () => {
  const out = mergeUserTags({
    cv: {
      experiences: [{ title: "Senior Engineer", company: "Legacy Corp" }],
    },
  })
  assert.equal(out.recentRoleTitle, "Senior Engineer")
  assert.equal(out.recentCompany, "Legacy Corp")
})

test("mergeUserTags: workHistory entry with `role` (alt key) honored when title absent", () => {
  const out = mergeUserTags({
    cv: { workHistory: [{ role: "Lead Eng", company: "Acme" }] },
  })
  assert.equal(out.recentRoleTitle, "Lead Eng")
})

test("mergeUserTags: workHistorySummary joins first 3 roles with '; '", () => {
  const out = mergeUserTags({
    cv: {
      workHistory: [
        { title: "SWE", company: "Tesla" },
        { title: "Driver", company: "OFO" },
        { title: "Founder", company: "AI Study" },
        { title: "Should Not Appear", company: "X" }, // 4th — sliced
      ],
    },
  })
  assert.equal(out.workHistorySummary, "SWE @ Tesla; Driver @ OFO; Founder @ AI Study")
  assert.ok(out.workHistorySummary!.length <= 200)
})

test("mergeUserTags: workHistorySummary soft-cap at 200 chars (truncated with …)", () => {
  const long = "X".repeat(80)
  const out = mergeUserTags({
    cv: {
      workHistory: [
        { title: long, company: "C1" },
        { title: long, company: "C2" },
        { title: long, company: "C3" },
      ],
    },
  })
  assert.ok(out.workHistorySummary!.length <= 200)
  assert.ok(out.workHistorySummary!.endsWith("…"))
})

test("mergeUserTags: workHistorySummary missing when no roles in either workHistory or experiences", () => {
  const out = mergeUserTags({ cv: { candidateProfile: { skills: ["x"] } } })
  assert.equal(out.workHistorySummary, undefined)
})

test("mergeUserTags: workHistorySummary handles partial roles (title only / company only)", () => {
  const out = mergeUserTags({
    cv: {
      workHistory: [
        { title: "Solo Title" }, // no company
        { company: "Solo Company" }, // no title
      ],
    },
  })
  assert.equal(out.workHistorySummary, "Solo Title; Solo Company")
})

// ---------------------------------------------------------------------------
// embedding pass-through
// ---------------------------------------------------------------------------

test("mergeUserTags: embedding pass-through when 1536-dim", () => {
  const vec = new Array(1536).fill(0.5)
  const out = mergeUserTags({
    cv: { embedding: vec, embeddingModel: "text-embedding-3-small" },
  })
  assert.equal(out.embedding!.length, 1536)
  assert.equal(out.embedding![0], 0.5)
  assert.equal(out.embeddingModel, "text-embedding-3-small")
})

test("mergeUserTags: embedding dropped when wrong dimension (defensive)", () => {
  const out = mergeUserTags({
    cv: { embedding: new Array(512).fill(0) },
  })
  assert.equal(out.embedding, undefined)
  assert.equal(out.embeddingModel, undefined)
})

test("mergeUserTags: embedding absent when CV has no embedding field", () => {
  const out = mergeUserTags({
    cv: { candidateProfile: { skills: ["x"] } },
  })
  assert.equal(out.embedding, undefined)
})

// ---------------------------------------------------------------------------
// chat fields pass-through + value mapping
// ---------------------------------------------------------------------------

test("mergeUserTags: prefersStartup boolean → enum mapping", () => {
  const cases: Array<[StatedPreferences["prefersStartup"], string | undefined]> = [
    [true, "startup"],
    [false, "bigtech"],
    [null, "either"],
    [undefined, undefined],
  ]
  for (const [input, expected] of cases) {
    const out = mergeUserTags({ statedPreferences: { prefersStartup: input } })
    assert.equal(
      out.prefersStartup,
      expected,
      `prefersStartup: ${String(input)} → expected ${String(expected)}, got ${String(out.prefersStartup)}`
    )
  }
})

test("mergeUserTags: visaStatus 'sponsorship_needed' → 'sponsor_needed' rename", () => {
  const out = mergeUserTags({ statedPreferences: { visaStatus: "sponsorship_needed" } })
  assert.equal(out.visaStatus, "sponsor_needed")
})

test("mergeUserTags: visaStatus 'unknown' → 'other' rename", () => {
  const out = mergeUserTags({ statedPreferences: { visaStatus: "unknown" } })
  assert.equal(out.visaStatus, "other")
})

test("mergeUserTags: visaStatus pass-through for canonical tokens", () => {
  for (const v of ["citizen", "gc", "opt", "h1b"] as const) {
    const out = mergeUserTags({ statedPreferences: { visaStatus: v } })
    assert.equal(out.visaStatus, v)
  }
})

test("mergeUserTags: preferredLang 'mixed' → undefined (downgrade to runtime detect)", () => {
  const out = mergeUserTags({ statedPreferences: { preferredLang: "mixed" } })
  assert.equal(out.preferredLang, undefined)
})

test("mergeUserTags: preferredLang from input overrides statedPreferences", () => {
  const out = mergeUserTags({
    preferredLang: "en",
    statedPreferences: { preferredLang: "zh" },
  })
  assert.equal(out.preferredLang, "en")
})

test("mergeUserTags: yoeRange tuple pass-through", () => {
  const out = mergeUserTags({ statedPreferences: { yoeRange: [3, 5] } })
  assert.deepEqual(out.yoeRange, [3, 5])
})

test("mergeUserTags: targetLocations pass-through", () => {
  const out = mergeUserTags({ statedPreferences: { targetLocations: ["nyc", "sf"] } })
  assert.deepEqual(out.targetLocations, ["nyc", "sf"])
})

test("mergeUserTags: targetCountry pass-through", () => {
  const out = mergeUserTags({ statedPreferences: { targetCountry: ["usa"] } })
  assert.deepEqual(out.targetCountry, ["usa"])
})

// ---------------------------------------------------------------------------
// bookkeeping
// ---------------------------------------------------------------------------

test("mergeUserTags: schemaVersion always set", () => {
  const out = mergeUserTags({})
  assert.equal(out.schemaVersion, USER_TAGS_SCHEMA_VERSION)
  assert.equal(out.schemaVersion, 1)
})

test("mergeUserTags: lastUpdatedFromCv set only when cv input present", () => {
  const out1 = mergeUserTags({
    cv: { candidateProfile: { skills: ["x"] } },
    cvUpdatedAt: "2026-05-05T00:00:00.000Z",
  })
  assert.equal(out1.lastUpdatedFromCv, "2026-05-05T00:00:00.000Z")

  const out2 = mergeUserTags({ cvUpdatedAt: "2026-05-05T00:00:00.000Z" })
  assert.equal(out2.lastUpdatedFromCv, undefined, "cv absent → lastUpdatedFromCv unset")
})

test("mergeUserTags: lastUpdatedFromChat set only when statedPreferences input present", () => {
  const out1 = mergeUserTags({
    statedPreferences: { targetRole: ["swe"] },
    chatUpdatedAt: "2026-05-05T00:00:00.000Z",
  })
  assert.equal(out1.lastUpdatedFromChat, "2026-05-05T00:00:00.000Z")

  const out2 = mergeUserTags({ chatUpdatedAt: "2026-05-05T00:00:00.000Z" })
  assert.equal(out2.lastUpdatedFromChat, undefined, "statedPreferences absent → lastUpdatedFromChat unset")
})

// ---------------------------------------------------------------------------
// purity / defensiveness
// ---------------------------------------------------------------------------

test("mergeUserTags: empty input produces minimal valid shape", () => {
  const out = mergeUserTags({})
  assert.deepEqual(out.skills, [])
  assert.deepEqual(out.industryEnum, ["other"])
  assert.equal(out.schemaVersion, USER_TAGS_SCHEMA_VERSION)
  assert.equal(out.recentRoleTitle, undefined)
  assert.equal(out.embedding, undefined)
  assert.equal(out.targetRole, undefined)
})

test("mergeUserTags: does NOT mutate input (CV)", () => {
  const cv = {
    candidateProfile: { skills: ["Python"] },
    workHistory: [{ title: "X", company: "Y", skills: ["Java"] }],
    industryTags: ["tech_software"],
  }
  const cvSnap = JSON.parse(JSON.stringify(cv))
  mergeUserTags({ cv })
  assert.deepEqual(cv, cvSnap, "input cv must not be mutated")
})

test("mergeUserTags: does NOT mutate input (statedPreferences)", () => {
  const sp: StatedPreferences = {
    targetRole: ["swe"],
    targetLocations: ["sf"],
    yoeRange: [0, 2],
    prefersStartup: true,
    visaStatus: "opt",
  }
  const snap = JSON.parse(JSON.stringify(sp))
  mergeUserTags({ statedPreferences: sp })
  assert.deepEqual(sp, snap, "input statedPreferences must not be mutated")
})

test("mergeUserTags: targetRole array reference is COPIED (not aliased) so caller mutations do not leak in", () => {
  const sp: StatedPreferences = { targetRole: ["swe"], targetLocations: ["sf"] }
  const out = mergeUserTags({ statedPreferences: sp })
  // Mutate input AFTER merge — output should be unaffected.
  sp.targetRole!.push("pm")
  sp.targetLocations!.push("nyc")
  assert.deepEqual(out.targetRole, ["swe"])
  assert.deepEqual(out.targetLocations, ["sf"])
})

// ---------------------------------------------------------------------------
// zod schema parity
// ---------------------------------------------------------------------------

test("UserTagsSchema parses output of a fully-populated mergeUserTags call", () => {
  const out = mergeUserTags({
    cv: {
      candidateProfile: { skills: ["python", "typescript"] },
      workHistory: [{ title: "SWE", company: "Tesla" }],
      industryTags: ["tech_software"],
      embedding: new Array(1536).fill(0.1),
      embeddingModel: "test",
    },
    statedPreferences: {
      targetRole: ["swe"],
      yoeRange: [0, 1],
      visaStatus: "opt",
      prefersStartup: true,
      targetLocations: ["sf"],
      preferredLang: "zh",
    },
    cvUpdatedAt: "2026-05-05T00:00:00.000Z",
    chatUpdatedAt: "2026-05-05T00:00:00.000Z",
  })
  // .parse throws on schema violation — passing means shape matches.
  const parsed = UserTagsSchema.parse(out)
  assert.equal(parsed.schemaVersion, 1)
  assert.equal(parsed.skills.length, 2)
})

test("UserTagsSchema accepts Level 1 salary and company-size tags written after prescreen", () => {
  const parsed = UserTagsSchema.safeParse({
    skills: [],
    industryEnum: ["other"],
    minSalary: 150000,
    companySize: "early_startup",
    schemaVersion: USER_TAGS_SCHEMA_VERSION,
  })
  assert.equal(parsed.success, true)
})

test("UserTagsSchema parses empty-input output (defaults shape)", () => {
  const out = mergeUserTags({})
  const parsed = UserTagsSchema.parse(out)
  assert.deepEqual(parsed.skills, [])
  assert.deepEqual(parsed.industryEnum, ["other"])
})
