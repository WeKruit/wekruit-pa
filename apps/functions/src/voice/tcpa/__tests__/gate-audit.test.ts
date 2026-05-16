/**
 * v2.1 S5 — gate audit-row tests.
 *
 * Every run of `runTcpaGate` MUST write a row to `voice-tcpa-checks/{auditId}`
 * regardless of decision or mode. Audit row carries the full sub-check
 * details + decision + mode + timestamp for forensics.
 */

import { describe, it } from "node:test"
import assert from "node:assert/strict"

import { MockFirestore, asFirestore } from "../../../job-rec/__tests__/mock-firestore.js"
import { runTcpaGate } from "../gate.js"

const NOW = new Date("2026-05-15T19:00:00Z") // not quiet hours anywhere US

async function seedHappyUser(mfs: MockFirestore, uid: string): Promise<void> {
  await mfs.collection("pa-users").doc(uid).set({
    consent: { voiceRecording: true, voiceRecordingConsentAt: "2026-05-14T10:00:00Z" },
  })
}

function findAuditRows(mfs: MockFirestore): Array<{ id: string; data: Record<string, unknown> }> {
  return mfs.writeLog
    .filter((w) => w.path === "voice-tcpa-checks")
    .map((w) => ({ id: w.id, data: w.data }))
}

describe("voice-tcpa-checks audit write", () => {
  it("writes row on allow decision", async () => {
    const mfs = new MockFirestore()
    await seedHappyUser(mfs, "u_001")
    await runTcpaGate(
      { bookingId: "bk_001", paUserId: "u_001", phoneE164: "+14155551234" },
      { fs: asFirestore(mfs), mode: "blocking", now: () => NOW, generateRunId: () => "run_001" },
    )
    const rows = findAuditRows(mfs)
    assert.equal(rows.length, 1)
    assert.equal(rows[0]!.id, "bk_001_run_001")
    assert.equal(rows[0]!.data.bookingId, "bk_001")
    assert.equal(rows[0]!.data.decision, "allow")
    assert.equal(rows[0]!.data.mode, "blocking")
    assert.equal(rows[0]!.data.reason, null)
    assert.equal(rows[0]!.data.checkedAt, NOW.toISOString())
    assert.equal(rows[0]!.data.runId, "run_001")
    assert.ok(rows[0]!.data.details, "details map populated")
  })

  it("writes row on block_observed (no booking touched)", async () => {
    const mfs = new MockFirestore()
    await seedHappyUser(mfs, "u_002")
    await mfs.collection("voice-dnc").doc("+14155551234").set({})
    await runTcpaGate(
      { bookingId: "bk_002", paUserId: "u_002", phoneE164: "+14155551234" },
      { fs: asFirestore(mfs), mode: "observed", now: () => NOW, generateRunId: () => "run_002" },
    )
    const rows = findAuditRows(mfs)
    assert.equal(rows.length, 1)
    assert.equal(rows[0]!.data.decision, "block_observed")
    assert.equal(rows[0]!.data.mode, "observed")
    assert.equal(rows[0]!.data.reason, "dnc_listed")
    // No write to outbound-bookings here — caller's applyTcpaGate handles that.
    const bookingWrites = mfs.writeLog.filter((w) => w.path === "outbound-bookings")
    assert.equal(bookingWrites.length, 0)
  })

  it("writes row on block_enforced", async () => {
    const mfs = new MockFirestore()
    await seedHappyUser(mfs, "u_003")
    await mfs.collection("voice-dnc").doc("+14155551234").set({})
    await runTcpaGate(
      { bookingId: "bk_003", paUserId: "u_003", phoneE164: "+14155551234" },
      { fs: asFirestore(mfs), mode: "blocking", now: () => NOW, generateRunId: () => "run_003" },
    )
    const rows = findAuditRows(mfs)
    assert.equal(rows.length, 1)
    assert.equal(rows[0]!.data.decision, "block_enforced")
    assert.equal(rows[0]!.data.reason, "dnc_listed")
  })

  it("writes separate rows on repeated gate runs (unique runId per call)", async () => {
    const mfs = new MockFirestore()
    await seedHappyUser(mfs, "u_004")
    let n = 0
    const deps = {
      fs: asFirestore(mfs),
      mode: "blocking" as const,
      now: () => NOW,
      generateRunId: () => `run_00${++n}`,
    }
    await runTcpaGate({ bookingId: "bk_004", paUserId: "u_004", phoneE164: "+14155551234" }, deps)
    await runTcpaGate({ bookingId: "bk_004", paUserId: "u_004", phoneE164: "+14155551234" }, deps)
    const rows = findAuditRows(mfs)
    assert.equal(rows.length, 2)
    assert.equal(rows[0]!.id, "bk_004_run_001")
    assert.equal(rows[1]!.id, "bk_004_run_002")
  })

  it("audit details captures all three sub-check raw results, even when first-block-wins", async () => {
    const mfs = new MockFirestore()
    // user has no consent map
    await mfs.collection("pa-users").doc("u_005").set({})
    await mfs.collection("voice-dnc").doc("+14155551234").set({})
    const QUIET = new Date("2026-05-16T06:00:00Z") // 23:00 PT (quiet)
    await runTcpaGate(
      { bookingId: "bk_005", paUserId: "u_005", phoneE164: "+14155551234" },
      { fs: asFirestore(mfs), mode: "blocking", now: () => QUIET, generateRunId: () => "run_005" },
    )
    const rows = findAuditRows(mfs)
    const details = rows[0]!.data.details as Record<string, { blocked: boolean }>
    assert.equal(details.dnc.blocked, true)
    assert.equal(details.quietHours.blocked, true)
    assert.equal(details.consent.blocked, true)
    // But reason is the first-blocker (DNC):
    assert.equal(rows[0]!.data.reason, "dnc_listed")
  })
})
