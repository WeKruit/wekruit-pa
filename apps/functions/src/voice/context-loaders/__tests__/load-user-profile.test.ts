/**
 * v2.1 S1B — `loadUserProfileForVoice` unit tests.
 *
 * Covers the 3-case contract:
 *   1. happy path — fully populated `pa-users/{uid}` (top-level + tags)
 *   2. missing doc — Firestore has no entry → NotFoundError("user", uid)
 *   3. partial doc — only minimal fields → projection returns what's there,
 *      `missingFields` lists every canonical field that was absent.
 *
 * Reuses the same `MockFirestore` helper used elsewhere in apps/functions
 * (`src/job-rec/__tests__/mock-firestore.ts`).
 */

import { describe, it } from "node:test"
import assert from "node:assert/strict"

import { MockFirestore, asFirestore } from "../../../job-rec/__tests__/mock-firestore.js"
import { loadUserProfileForVoice } from "../load-user-profile.js"
import { NotFoundError } from "../types.js"

describe("loadUserProfileForVoice — happy path", () => {
  it("returns full projection with empty missingFields", async () => {
    const mfs = new MockFirestore()
    await mfs
      .collection("pa-users")
      .doc("u_full_001")
      .set({
        displayName: "Alice Liu",
        phoneE164: "+14155550100",
        email: "alice@example.com",
        candidateLifecycleState: "claimed",
        piiConsentAt: "2026-05-10T12:00:00Z",
        tagsUpdatedAt: "2026-05-14T08:30:00Z",
        contactPII: { consentedAt: "2026-05-09T00:00:00Z" }, // top-level wins
        tags: {
          preferredLang: "en",
          targetRoleFunction: ["software_engineering"],
          skills: [
            { name: "typescript", bucket: "programming_languages", baseWeight: 1.0 },
            { name: "react" },
            "graphql", // legacy string form
          ],
          recentRoleTitle: "Senior SWE",
          recentCompany: "Stripe",
          workHistorySummary: "Senior SWE @ Stripe; SWE @ Square; Intern @ Apple",
          yoeRange: [4, 6],
          visaStatus: "citizen",
          targetLocations: ["new_york", "remote"],
          minSalary: 165000,
          industrySector: ["financial_technology"],
          relevantIndustry: ["financial_technology", "consumer_internet"],
        },
      })

    const out = await loadUserProfileForVoice(asFirestore(mfs), "u_full_001")

    assert.equal(out.userId, "u_full_001")
    assert.equal(out.displayName, "Alice Liu")
    assert.equal(out.phoneE164, "+14155550100")
    assert.equal(out.email, "alice@example.com")
    assert.equal(out.lifecycleState, "claimed")
    assert.equal(out.piiConsentAt, "2026-05-10T12:00:00Z")
    assert.equal(out.preferredLang, "en")
    assert.deepEqual(out.targetRoleFunction, ["software_engineering"])
    assert.equal(out.skills?.length, 3)
    assert.equal(out.skills?.[0]?.name, "typescript")
    assert.equal(out.skills?.[0]?.bucket, "programming_languages")
    assert.equal(out.skills?.[2]?.name, "graphql") // legacy string upgraded
    assert.equal(out.recentRoleTitle, "Senior SWE")
    assert.equal(out.recentCompany, "Stripe")
    assert.equal(out.workHistorySummary, "Senior SWE @ Stripe; SWE @ Square; Intern @ Apple")
    assert.deepEqual(out.yoeRange, [4, 6])
    assert.equal(out.visaStatus, "citizen")
    assert.deepEqual(out.targetLocations, ["new_york", "remote"])
    assert.equal(out.minSalary, 165000)
    assert.deepEqual(out.industrySector, ["financial_technology"])
    assert.deepEqual(out.relevantIndustry, ["financial_technology", "consumer_internet"])
    assert.equal(out.tagsUpdatedAt, "2026-05-14T08:30:00Z")
    assert.deepEqual(out.missingFields, [])
  })
})

describe("loadUserProfileForVoice — missing doc", () => {
  it("throws NotFoundError with kind='user' when pa-users/{uid} does not exist", async () => {
    const mfs = new MockFirestore()
    await assert.rejects(
      () => loadUserProfileForVoice(asFirestore(mfs), "u_does_not_exist"),
      (err: unknown) => {
        assert.ok(err instanceof NotFoundError, "expected NotFoundError")
        assert.equal(err.kind, "user")
        assert.equal(err.id, "u_does_not_exist")
        return true
      }
    )
  })
})

describe("loadUserProfileForVoice — partial doc", () => {
  it("returns what's present and enumerates absent fields in missingFields", async () => {
    const mfs = new MockFirestore()
    // Minimal doc — only id-keyed shell + a tiny tags object. Voice path
    // should degrade gracefully: missingFields reports every canonical field
    // that was absent.
    await mfs
      .collection("pa-users")
      .doc("u_partial_001")
      .set({
        // top-level: only displayName present
        displayName: "Bob",
        tags: {
          // tags: only preferredLang present
          preferredLang: "zh",
        },
      })

    const out = await loadUserProfileForVoice(asFirestore(mfs), "u_partial_001")

    assert.equal(out.userId, "u_partial_001")
    assert.equal(out.displayName, "Bob")
    assert.equal(out.preferredLang, "zh")
    // present fields → not in missingFields
    assert.equal(out.missingFields.includes("displayName"), false)
    assert.equal(out.missingFields.includes("tags.preferredLang"), false)

    // absent fields → in missingFields (canonical names)
    for (const expected of [
      "phoneE164",
      "candidateLifecycleState",
      "piiConsentAt",
      "tags.targetRoleFunction",
      "tags.skills",
      "tags.recentRoleTitle",
      "tags.recentCompany",
      "tags.workHistorySummary",
      "tags.yoeRange",
      "tags.visaStatus",
      "tags.targetLocations",
      "tags.industrySector",
      "tags.relevantIndustry",
    ]) {
      assert.ok(
        out.missingFields.includes(expected),
        `expected missingFields to include ${expected}; got ${JSON.stringify(out.missingFields)}`
      )
    }

    // absent optional fields that are not enumerated → e.g. email, minSalary
    assert.equal(out.email, undefined)
    assert.equal(out.minSalary, undefined)
  })
})
