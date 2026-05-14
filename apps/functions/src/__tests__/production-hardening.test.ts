import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { HttpsError } from "firebase-functions/v2/https"
import {
  PA_COLLECTIONS,
  createOutreachStopControlId,
  createPrivacyRequestId,
} from "@pa/core-types"
import { MockFirestore, asFirestore } from "../job-rec/__tests__/mock-firestore.js"
import {
  runAdminLaunchReadinessSnapshot,
  runAdminOutreachStopControl,
  runCandidatePrivacyRequest,
} from "../production-hardening.js"

const now = "2026-05-14T12:00:00.000Z"

function json(value: unknown): string {
  return JSON.stringify(value)
}

describe("runCandidatePrivacyRequest", () => {
  it("requires candidate auth", async () => {
    const mfs = new MockFirestore()
    await assert.rejects(
      () => runCandidatePrivacyRequest({ kind: "export" }, undefined, {
        db: asFirestore(mfs),
        now: () => now,
      }),
      (err) => err instanceof HttpsError && err.code === "unauthenticated",
    )
  })

  it("writes request-only privacy intake without outbound or raw detail leakage", async () => {
    const mfs = new MockFirestore()
    await mfs.collection(PA_COLLECTIONS.candidateAuth).doc("firebase-1").set({ candidateId: "cand-1" })

    const result = await runCandidatePrivacyRequest(
      {
        kind: "delete",
        detailText: "Please delete my profile. My email is candidate@example.com",
      },
      { uid: "firebase-1" },
      { db: asFirestore(mfs), now: () => now },
    )

    assert.equal(result.ok, true)
    assert.equal(result.candidateId, "cand-1")
    assert.equal(result.kind, "delete")
    assert.equal(result.created, true)
    assert.equal(result.existingOpen, false)
    const request = mfs.store.get(PA_COLLECTIONS.privacyRequests)!.get(result.requestId)!
    assert.equal(request.status, "submitted")
    assert.equal(request.requestedBy, "candidate")
    assert.doesNotMatch(json(request), /candidate@example\.com/)
    assert.equal(mfs.store.get(PA_COLLECTIONS.outbound)?.size ?? 0, 0)

    const duplicate = await runCandidatePrivacyRequest(
      { kind: "delete", detailText: "second click" },
      { uid: "firebase-1" },
      { db: asFirestore(mfs), now: () => "2026-05-14T12:01:00.000Z" },
    )
    assert.equal(duplicate.created, false)
    assert.equal(duplicate.existingOpen, true)
    assert.equal(duplicate.requestId, result.requestId)
    assert.equal(mfs.store.get(PA_COLLECTIONS.privacyRequests)!.size, 1)
  })
})

describe("runAdminLaunchReadinessSnapshot", () => {
  it("summarizes privacy requests and global outreach stop controls", async () => {
    const mfs = new MockFirestore()
    const privacyRequestId = createPrivacyRequestId({
      candidateId: "cand-1",
      kind: "export",
      createdAt: now,
    })
    await mfs.collection(PA_COLLECTIONS.privacyRequests).doc(privacyRequestId).set({
      requestId: privacyRequestId,
      kind: "export",
      status: "submitted",
      candidateId: "cand-1",
      sourceSurface: "me_profile",
      requestedBy: "candidate",
      detailRedacted: {},
      evidence: [{ source: "system", summary: "Candidate submitted privacy request" }],
      createdAt: now,
    })
    await mfs.collection(PA_COLLECTIONS.outreachStopControls).doc("outreach_stop_global").set({
      controlId: createOutreachStopControlId({ scope: "global" }),
      scope: "global",
      paused: true,
      reason: "launch readiness pause",
      actor: "operator",
      createdAt: now,
      updatedAt: now,
    })

    const result = await runAdminLaunchReadinessSnapshot(
      { limit: 10 },
      { db: asFirestore(mfs), now: () => now },
    )

    assert.equal(result.ok, true)
    assert.equal(result.persisted, true)
    assert.equal(result.created, true)
    assert.equal(result.snapshot.status, "red")
    assert.equal(result.snapshot.counts.privacyOpen, 1)
    assert.equal(result.snapshot.counts.globalPaused, 1)
    assert.equal(result.snapshot.privacyRequests[0]!.requestId, privacyRequestId)
    assert.equal(result.snapshot.stopControls[0]!.paused, true)
    assert.equal(mfs.store.get(PA_COLLECTIONS.launchReadinessSnapshots)!.size, 1)
    assert.equal(mfs.store.get(PA_COLLECTIONS.outbound)?.size ?? 0, 0)
  })
})

describe("runAdminOutreachStopControl", () => {
  it("writes audited global stop controls without outbound side effects", async () => {
    const mfs = new MockFirestore()
    const result = await runAdminOutreachStopControl(
      { scope: "global", paused: true, reason: "manual launch pause" },
      "admin-1",
      { db: asFirestore(mfs), now: () => now },
    )

    assert.equal(result.ok, true)
    assert.equal(result.control.controlId, "outreach_stop_global")
    assert.equal(result.control.paused, true)
    assert.equal(result.previous, null)
    assert.equal(mfs.store.get(PA_COLLECTIONS.outreachStopControls)!.get("outreach_stop_global")!.paused, true)
    assert.equal(mfs.store.get(PA_COLLECTIONS.auditEvents)!.size, 1)
    assert.equal(mfs.store.get(PA_COLLECTIONS.outbound)?.size ?? 0, 0)
  })

  it("requires a pause reason", async () => {
    const mfs = new MockFirestore()
    await assert.rejects(
      () => runAdminOutreachStopControl(
        { scope: "global", paused: true },
        "admin-1",
        { db: asFirestore(mfs), now: () => now },
      ),
      (err) => err instanceof HttpsError && err.code === "invalid-argument",
    )
  })
})
