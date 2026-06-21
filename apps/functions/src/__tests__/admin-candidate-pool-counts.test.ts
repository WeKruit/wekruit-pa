import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { MockFirestore, asFirestore } from "../job-rec/__tests__/mock-firestore.js"
import {
  AdminCandidatePoolCountsInputSchema,
  runAdminCandidatePoolCounts,
} from "../admin-candidate-pool-counts.js"

function seed(mfs: MockFirestore, coll: string, id: string, data: Record<string, unknown>): Promise<void> {
  return mfs.collection(coll).doc(id).set({ ...data })
}

describe("AdminCandidatePoolCountsInputSchema", () => {
  it("accepts empty + null adminToken (callable serializes omitted optionals as null)", () => {
    assert.equal(AdminCandidatePoolCountsInputSchema.safeParse({}).success, true)
    assert.equal(AdminCandidatePoolCountsInputSchema.safeParse({ adminToken: null }).success, true)
    assert.equal(AdminCandidatePoolCountsInputSchema.safeParse({ adminToken: "tok" }).success, true)
  })
})

describe("runAdminCandidatePoolCounts", () => {
  it("counts the WHOLE pool, classifies via shared logic, honors the demo/test toggle", async () => {
    const mfs = new MockFirestore()

    // 1) real candidate_account: phone (imessage) + claimed + auth mapping + phone handle
    await seed(mfs, "pa-users", "acc1", {
      phoneE164: "+14155550123",
      email: "a@gmail.com",
      candidateLifecycleState: "claimed",
    })
    await seed(mfs, "pa-candidate-auth", "auth-acc1", { candidateId: "acc1" })
    await seed(mfs, "pa-candidate-handles", "h-acc1", { kind: "phone", candidateId: "acc1" })

    // 2) internal operator (@wekruit.com) — demo/test/internal → hidden by default
    await seed(mfs, "pa-users", "internal1", {
      email: "ops@wekruit.com",
      phoneE164: "+14155550124",
      candidateLifecycleState: "claimed",
    })

    // 3) synthetic test (id prefix "qa") — hidden by default
    await seed(mfs, "pa-users", "qa-smoke-1", { phoneE164: "+14155550125" })

    // 4) external supply prospect (juicebox source-link) — NOT hidden
    await seed(mfs, "pa-users", "ext1", { email: "e@x.com" })
    await seed(mfs, "pa-candidate-source-links", "sl-ext1", { candidateId: "ext1", source: "juicebox" })

    // A non-phone handle must NOT contribute to phone-bound.
    await seed(mfs, "pa-candidate-handles", "h-email", { kind: "email", candidateId: "acc1-email-only" })

    const r = await runAdminCandidatePoolCounts({ db: asFirestore(mfs) })

    assert.equal(r.totalPaUsers, 4)

    // class breakdown — over ALL rows (toggle-independent)
    assert.equal(r.classBreakdown.accountCandidates, 1, "acc1")
    assert.equal(r.classBreakdown.externalProspects, 1, "ext1")
    assert.equal(r.classBreakdown.internalProfiles, 1, "internal1")
    assert.equal(r.classBreakdown.syntheticTests, 1, "qa-smoke-1")
    assert.equal(r.classBreakdown.demoPreviewProfiles, 0)

    // header identity cards — ALL rows but always exclude demo/test/internal.
    // Only acc1 (non-hidden) has registered/phone/handle; ext1 has none.
    assert.equal(r.identityCards.registered, 1)
    assert.equal(r.identityCards.phoneReady, 1)
    assert.equal(r.identityCards.phoneBound, 1)
    assert.equal(r.identityCards.sendblueEligible, 1)

    // default variant — hidden (internal1, qa-smoke-1) EXCLUDED → acc1 + ext1
    assert.equal(r.default.realRows, 2)
    assert.equal(r.default.byState.claimed, 1) // acc1
    assert.equal(r.default.byState.reachable, 1) // ext1 (email, no lifecycle)
    assert.equal(r.default.bySource.imessage, 1) // acc1
    assert.equal(r.default.bySource.juicebox, 1) // ext1
    assert.deepEqual(r.default.byIdentity, {
      registered: 1,
      phone_ready: 1,
      phone_bound: 1,
      sendblue_eligible: 1,
    })

    // includingHidden variant — ALL 4 rows
    assert.equal(r.includingHidden.realRows, 4)
    // phones: acc1, internal1, qa-smoke-1 all valid E.164 → 3
    assert.equal(r.includingHidden.byIdentity.phone_ready, 3)
    // sendblue stays 1 (only the real candidate_account qualifies)
    assert.equal(r.includingHidden.byIdentity.sendblue_eligible, 1)
    assert.equal(r.includingHidden.byIdentity.phone_bound, 1)
  })

  it("returns an empty-but-valid shape for an empty pool", async () => {
    const mfs = new MockFirestore()
    const r = await runAdminCandidatePoolCounts({ db: asFirestore(mfs) })
    assert.equal(r.totalPaUsers, 0)
    assert.equal(r.default.realRows, 0)
    assert.equal(r.includingHidden.realRows, 0)
    assert.equal(r.identityCards.registered, 0)
    assert.equal(r.truncated.users, false)
  })
})
