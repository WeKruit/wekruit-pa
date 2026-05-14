import assert from "node:assert/strict"
import test from "node:test"
import {
  LaunchReadinessSnapshotSchema,
  OutreachStopControlSchema,
  PA_COLLECTIONS,
  PrivacyRequestSchema,
} from "../../../packages/core-types/src/index.js"
import {
  launchReadinessSnapshotFixture,
  noContactCountManifest,
  outreachStopControlFixture,
  privacyRequestFixture,
} from "./fixtures.js"

const unsafeText = /@|linkedin\.com|gs:\/\/|\+1555|rawPrompt|systemPrompt|rawTranscript|fullTranscript|resumeStorageUri/i

test("S9 privacy requests are request-only redacted queue records", () => {
  const request = PrivacyRequestSchema.parse(privacyRequestFixture())

  assert.equal(PA_COLLECTIONS.privacyRequests, "pa-privacy-requests")
  assert.equal(request.kind, "delete")
  assert.equal(request.status, "submitted")
  assert.equal(request.requestedBy, "candidate")
  assert.doesNotMatch(JSON.stringify(request), unsafeText)
  assert.equal("deletedAt" in request, false)
  assert.equal("exportUrl" in request, false)
})

test("S9 launch readiness snapshots carry counts and gate state without raw PII", () => {
  const snapshot = LaunchReadinessSnapshotSchema.parse(launchReadinessSnapshotFixture())

  assert.equal(PA_COLLECTIONS.launchReadinessSnapshots, "pa-launch-readiness-snapshots")
  assert.equal(snapshot.status, "yellow")
  assert.equal(snapshot.counts.privacyOpen, 1)
  assert.equal(snapshot.counts.globalPaused, 1)
  assert.deepEqual(snapshot.privacyRequests.map((row) => row.kind), ["delete"])
  assert.deepEqual(snapshot.stopControls.map((row) => row.scope), ["global"])
  assert.doesNotMatch(JSON.stringify(snapshot), unsafeText)
})

test("S9 outreach stop controls require explicit pause reasons and reject raw contact data", () => {
  const control = OutreachStopControlSchema.parse(outreachStopControlFixture())

  assert.equal(PA_COLLECTIONS.outreachStopControls, "pa-outreach-stop-controls")
  assert.equal(control.scope, "global")
  assert.equal(control.paused, true)
  assert.throws(
    () => OutreachStopControlSchema.parse(outreachStopControlFixture({ reason: undefined })),
    /paused outreach stop control requires a reason/,
  )
  assert.throws(
    () => OutreachStopControlSchema.parse(outreachStopControlFixture({ reason: "call +15555550100" })),
    /raw PII/,
  )
})

test("S9 dry-run count manifest records no approved live send or destructive privacy action", () => {
  assert.equal(noContactCountManifest.approvedLiveSend, false)
  assert.equal(noContactCountManifest.approvedDestructivePrivacyAction, false)
  assert.deepEqual(noContactCountManifest.before, noContactCountManifest.after)
})
