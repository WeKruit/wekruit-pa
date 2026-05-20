import test from "node:test"
import assert from "node:assert/strict"
import type { CoresignalEmployeeCollectV2 } from "@pa/external-supply"
import {
  CORESIGNAL_COLLECT_V2_ADAPTER_VERSION,
  CORESIGNAL_COLLECT_V2_SIGNATURE,
  normalizeCoresignalCollectV2,
  parseCoresignalCollectV2Export,
} from "./coresignal-collect-v2.js"

function baseEmployee(overrides: Partial<CoresignalEmployeeCollectV2> = {}): CoresignalEmployeeCollectV2 {
  return {
    id: 725992096,
    full_name: "Yue H.",
    headline: "Tech Recruiter | AI-driven",
    linkedin_url: "https://www.linkedin.com/in/yue-h-69a807130",
    primary_professional_email: "yh@intelliprogroup.com",
    professional_emails_collection: [],
    experience: [
      {
        company_name: "IntelliPro",
        position_title: "Tech Recruiter",
        date_from: "2022-01",
        duration_months: 24,
      },
    ],
    education: [],
    inferred_skills: ["talent acquisition", "sourcing"],
    historical_skills: ["sourcing", "recruiting"],
    location_full: "San Francisco Bay Area, California, United States",
    ...overrides,
  } as CoresignalEmployeeCollectV2
}

test("signature is coresignal_collect_v2 + adapter version", () => {
  assert.equal(CORESIGNAL_COLLECT_V2_SIGNATURE.source, "coresignal_collect_v2")
  assert.equal(
    CORESIGNAL_COLLECT_V2_SIGNATURE.adapterVersion,
    CORESIGNAL_COLLECT_V2_ADAPTER_VERSION,
  )
  assert.ok(CORESIGNAL_COLLECT_V2_SIGNATURE.requiredKeys.includes("linkedin_url"))
})

test("normalize — happy path produces ok status + canonical url + emails + skills dedup", () => {
  const draft = normalizeCoresignalCollectV2(baseEmployee())
  assert.equal(draft.source, "coresignal_collect_v2")
  assert.equal(draft.normalizationStatus, "ok")
  assert.equal(draft.identityResolutionStatus, "pending")
  assert.equal(
    draft.canonicalLinkedInUrl,
    "https://www.linkedin.com/in/yue-h-69a807130",
  )
  assert.ok(draft.linkedinProfileHash)
  assert.equal(draft.emails.length, 1)
  assert.equal(draft.emails[0].value, "yh@intelliprogroup.com")
  assert.ok(draft.emails[0].hash)
  assert.equal(draft.name, "Yue H.")
  assert.equal(draft.currentTitle, "Tech Recruiter | AI-driven")
  assert.equal(draft.currentCompany, "IntelliPro")
  assert.equal(draft.experience.length, 1)
  assert.equal(draft.experience[0].company, "IntelliPro")
  assert.equal(draft.experience[0].title, "Tech Recruiter")
  assert.equal(draft.experience[0].durationMonths, 24)
  // skills lowercased + deduped (sourcing appears twice, once each list)
  assert.deepEqual(draft.sourceTags.sort(), [
    "recruiting",
    "sourcing",
    "talent acquisition",
  ])
})

test("normalize — active_experience_title preferred over headline when present", () => {
  const draft = normalizeCoresignalCollectV2(
    baseEmployee({
      active_experience_title: "Senior Software Engineer",
      headline: "Engineer | Looking for next role",
    }),
  )
  assert.equal(draft.currentTitle, "Senior Software Engineer")
})

test("normalize — falls back to headline when active_experience_title missing", () => {
  const draft = normalizeCoresignalCollectV2(
    baseEmployee({
      active_experience_title: null,
      headline: "Senior Recruiter",
    }),
  )
  assert.equal(draft.currentTitle, "Senior Recruiter")
})

test("normalize — multiple emails from collection dedup against primary", () => {
  const draft = normalizeCoresignalCollectV2(
    baseEmployee({
      primary_professional_email: "yh@intelliprogroup.com",
      professional_emails_collection: [
        { professional_email: "YH@intelliprogroup.com", order_of_priority: 1 },
        { professional_email: "yue.h@gmail.com", order_of_priority: 2 },
      ],
    }),
  )
  // normalizeEmail lowercases, so duplicates merge
  assert.equal(draft.emails.length, 2)
  assert.deepEqual(draft.emails.map((e) => e.value).sort(), [
    "yh@intelliprogroup.com",
    "yue.h@gmail.com",
  ])
})

test("normalize — no linkedin + no email → failed status", () => {
  const draft = normalizeCoresignalCollectV2(
    baseEmployee({
      linkedin_url: null,
      primary_professional_email: null,
      professional_emails_collection: [],
    }),
  )
  assert.equal(draft.normalizationStatus, "failed")
  assert.equal(draft.emails.length, 0)
  assert.equal(draft.canonicalLinkedInUrl, undefined)
})

test("normalize — only linkedin (no email) → ok with identity signal", () => {
  const draft = normalizeCoresignalCollectV2(
    baseEmployee({
      primary_professional_email: null,
      professional_emails_collection: [],
    }),
  )
  assert.equal(draft.normalizationStatus, "ok")
  assert.equal(draft.emails.length, 0)
  assert.ok(draft.canonicalLinkedInUrl)
})

test("normalize — invalid linkedin URL → partial status with error", () => {
  const draft = normalizeCoresignalCollectV2(
    baseEmployee({ linkedin_url: "not a url at all" }),
  )
  assert.equal(draft.normalizationStatus, "partial")
  assert.ok(draft.normalizationErrors?.includes("linkedin_url_invalid"))
})

test("normalize — experience entries missing company OR title are dropped", () => {
  const draft = normalizeCoresignalCollectV2(
    baseEmployee({
      experience: [
        { company_name: "Real Co", position_title: "Real Title" },
        { company_name: null, position_title: "Orphan Title" },
        { company_name: "Orphan Co", position_title: null },
        { company_name: "", position_title: "" },
      ],
    }),
  )
  assert.equal(draft.experience.length, 1)
  assert.equal(draft.experience[0].company, "Real Co")
})

test("normalize — education maps institution + degree + endYear", () => {
  const draft = normalizeCoresignalCollectV2(
    baseEmployee({
      education: [
        {
          institution_name: "Stanford University",
          degree: "MS Computer Science",
          date_to_year: 2018,
        },
        { institution_name: null, degree: "Should be dropped" },
      ],
    }),
  )
  assert.equal(draft.education.length, 1)
  assert.equal(draft.education[0].school, "Stanford University")
  assert.equal(draft.education[0].degree, "MS Computer Science")
  assert.equal(draft.education[0].endYear, 2018)
})

test("normalize — location_full preferred, falls back to city+state+country", () => {
  const draftFull = normalizeCoresignalCollectV2(
    baseEmployee({ location_full: "Austin, Texas, US" }),
  )
  assert.equal(draftFull.location, "Austin, Texas, US")

  const draftFallback = normalizeCoresignalCollectV2(
    baseEmployee({
      location_full: null,
      location_city: "Austin",
      location_state: "Texas",
      location_country: "United States",
    }),
  )
  assert.equal(draftFallback.location, "Austin, Texas, United States")
})

test("normalize — currentCompany taken from experience[0].company_name", () => {
  const draft = normalizeCoresignalCollectV2(
    baseEmployee({
      experience: [
        { company_name: "Most Recent Co", position_title: "VP" },
        { company_name: "Earlier Co", position_title: "Director" },
      ],
    }),
  )
  assert.equal(draft.currentCompany, "Most Recent Co")
})

test("normalize — rawPayload preserves full original input", () => {
  const input = baseEmployee({ summary: "long summary text here" })
  const draft = normalizeCoresignalCollectV2(input)
  assert.equal(
    (draft.rawPayload as Record<string, unknown>).summary,
    "long summary text here",
  )
  assert.equal((draft.rawPayload as Record<string, unknown>).id, 725992096)
})

test("parseCoresignalCollectV2Export — accepts array directly", () => {
  const drafts = parseCoresignalCollectV2Export([
    baseEmployee(),
    baseEmployee({ id: 757303208, full_name: "Tamara Goginava" }),
  ])
  assert.equal(drafts.length, 2)
  assert.equal(drafts[0].name, "Yue H.")
  assert.equal(drafts[1].name, "Tamara Goginava")
})

test("parseCoresignalCollectV2Export — accepts JSON string", () => {
  const json = JSON.stringify([baseEmployee()])
  const drafts = parseCoresignalCollectV2Export(json)
  assert.equal(drafts.length, 1)
  assert.equal(drafts[0].name, "Yue H.")
})

test("parseCoresignalCollectV2Export — rejects non-array string", () => {
  assert.throws(
    () => parseCoresignalCollectV2Export(JSON.stringify({ id: 1 })),
    /coresignal_collect_v2_input_not_array/,
  )
})
