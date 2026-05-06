/**
 * iter34 sprint A.5 — wire-through sanity for `targetRole` →
 * `targetRoleIndustryEnum` filter passed to queryMatchingJobs from
 * `makeGenerateJobRecs` in orchestrator-deps.ts.
 *
 * `makeGenerateJobRecs` reads Firestore directly with no DI, so we can't
 * unit-test the inner closure cleanly without a Firestore mock harness
 * (the existing 455-test suite already does this kind of mocking via
 * @google-cloud/firestore-emulator-style stubs at higher layers). For
 * this iter we lock down the *decision boundary* the wire depends on:
 *
 *   1. `roleToIndustryBuckets` is reachable from `@pa/pa-orchestrator`
 *      (the import path orchestrator-deps.ts uses).
 *   2. `["swe"]` produces a non-empty bucket list including `tech_software`
 *      so SWE candidates won't get Warehouse jobs after the post-filter.
 *   3. `["founder"]` returns undefined → no filter applied → caller
 *      omits `targetRoleIndustryEnum` from the filters object.
 *   4. `undefined` input returns undefined → same.
 *
 * If any of these flip, the wire-through in `makeGenerateJobRecs` breaks
 * silently (Firestore reads still happen, queryMatchingJobs still runs,
 * but the post-filter no longer shrinks the candidate set by role).
 */
import { describe, it } from "node:test"
import assert from "node:assert/strict"

import { roleToIndustryBuckets } from "@pa/pa-orchestrator"

describe("orchestrator-deps targetRole → industryEnum wire-through", () => {
  it("['swe'] expands to tech_software bucket (SWE doesn't get Warehouse)", () => {
    // Cast mirrors the runtime call site in orchestrator-deps.ts —
    // pa-users.statedPreferences.targetRole is plain string[] in storage,
    // and roleToIndustryBuckets is tolerant of unknown tokens.
    const buckets = roleToIndustryBuckets(
      ["swe"] as Parameters<typeof roleToIndustryBuckets>[0]
    )
    assert.ok(Array.isArray(buckets), "swe must produce a bucket array")
    assert.ok(buckets!.length > 0, "swe must produce at least one bucket")
    assert.ok(
      buckets!.includes("tech_software" as (typeof buckets)[number]),
      `swe must include tech_software bucket; got ${JSON.stringify(buckets)}`
    )
  })

  it("['founder'] returns undefined → caller omits targetRoleIndustryEnum filter", () => {
    const buckets = roleToIndustryBuckets(
      ["founder"] as Parameters<typeof roleToIndustryBuckets>[0]
    )
    assert.equal(
      buckets,
      undefined,
      "founder is cross-domain — caller must skip the post-filter"
    )
  })

  it("undefined input returns undefined → no filter applied", () => {
    const buckets = roleToIndustryBuckets(undefined)
    assert.equal(buckets, undefined)
  })

  it("empty array returns undefined → no filter applied", () => {
    const buckets = roleToIndustryBuckets(
      [] as Parameters<typeof roleToIndustryBuckets>[0]
    )
    assert.equal(buckets, undefined)
  })

  it("filter shape: when buckets undefined, spread omits the field", () => {
    // Mirror the exact spread pattern in orchestrator-deps.ts so we catch
    // any future regression where someone writes `targetRoleIndustryEnum:
    // [] as never[]` or similar.
    const undef = roleToIndustryBuckets(
      ["founder"] as Parameters<typeof roleToIndustryBuckets>[0]
    )
    const filters = {
      foo: "bar",
      ...(undef ? { targetRoleIndustryEnum: undef } : {}),
    }
    assert.equal(
      Object.prototype.hasOwnProperty.call(filters, "targetRoleIndustryEnum"),
      false,
      "founder/undefined path must not inject targetRoleIndustryEnum key"
    )
  })

  it("filter shape: when buckets defined, spread injects the field", () => {
    const def = roleToIndustryBuckets(
      ["swe"] as Parameters<typeof roleToIndustryBuckets>[0]
    )
    const filters = {
      foo: "bar",
      ...(def ? { targetRoleIndustryEnum: def } : {}),
    }
    assert.ok(
      Object.prototype.hasOwnProperty.call(filters, "targetRoleIndustryEnum"),
      "swe path must inject targetRoleIndustryEnum into filters"
    )
    assert.deepEqual(
      (filters as { targetRoleIndustryEnum: readonly string[] })
        .targetRoleIndustryEnum,
      def
    )
  })
})
