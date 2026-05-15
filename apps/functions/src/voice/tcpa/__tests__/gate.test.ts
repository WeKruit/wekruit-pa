/**
 * v2.1 S5 — gate orchestrator unit tests.
 *
 * Covers:
 *   - allow path (all sub-checks pass)
 *   - DNC block in observed mode → block_observed
 *   - DNC block in blocking mode → block_enforced
 *   - quiet-hours block in blocking mode
 *   - consent-missing block in blocking mode
 *   - priority: DNC > quiet-hours > consent (first-block-wins)
 */

import { describe, it } from "node:test"
import assert from "node:assert/strict"

import { MockFirestore, asFirestore } from "../../../job-rec/__tests__/mock-firestore.js"
import { runTcpaGate } from "../gate.js"

const ALLOW_TIME = new Date("2026-05-15T19:00:00Z") // 12:00 PT, well outside quiet hours
const QUIET_PT = new Date("2026-05-16T06:00:00Z") // 23:00 PT

async function seedHappyUser(mfs: MockFirestore, uid: string): Promise<void> {
  await mfs.collection("pa-users").doc(uid).set({
    consent: {
      voiceRecording: true,
      voiceRecordingConsentAt: "2026-05-14T10:00:00Z",
    },
  })
}

describe("runTcpaGate — allow path", () => {
  it("returns allow when DNC clean + outside quiet hours + consent present", async () => {
    const mfs = new MockFirestore()
    await seedHappyUser(mfs, "u_001")
    const decision = await runTcpaGate(
      { bookingId: "bk_001", paUserId: "u_001", phoneE164: "+14155551234" },
      { fs: asFirestore(mfs), mode: "blocking", now: () => ALLOW_TIME, generateRunId: () => "run_001" },
    )
    assert.equal(decision.decision, "allow")
    assert.equal(decision.reason, undefined)
    assert.equal(decision.mode, "blocking")
    assert.equal(decision.details.dnc.blocked, false)
    assert.equal(decision.details.quietHours.blocked, false)
    assert.equal(decision.details.consent.blocked, false)
  })
})

describe("runTcpaGate — DNC blocks", () => {
  it("blocks observed mode (decision = block_observed, no enforcement)", async () => {
    const mfs = new MockFirestore()
    await seedHappyUser(mfs, "u_002")
    await mfs.collection("voice-dnc").doc("+14155551234").set({})
    const decision = await runTcpaGate(
      { bookingId: "bk_002", paUserId: "u_002", phoneE164: "+14155551234" },
      { fs: asFirestore(mfs), mode: "observed", now: () => ALLOW_TIME, generateRunId: () => "run_002" },
    )
    assert.equal(decision.decision, "block_observed")
    assert.equal(decision.reason, "dnc_listed")
    assert.equal(decision.mode, "observed")
  })

  it("blocks blocking mode (decision = block_enforced)", async () => {
    const mfs = new MockFirestore()
    await seedHappyUser(mfs, "u_003")
    await mfs.collection("voice-dnc").doc("+14155551234").set({})
    const decision = await runTcpaGate(
      { bookingId: "bk_003", paUserId: "u_003", phoneE164: "+14155551234" },
      { fs: asFirestore(mfs), mode: "blocking", now: () => ALLOW_TIME, generateRunId: () => "run_003" },
    )
    assert.equal(decision.decision, "block_enforced")
    assert.equal(decision.reason, "dnc_listed")
    assert.equal(decision.mode, "blocking")
  })
})

describe("runTcpaGate — quiet hours blocks", () => {
  it("blocking mode (decision = block_enforced, reason = quiet_hours)", async () => {
    const mfs = new MockFirestore()
    await seedHappyUser(mfs, "u_004")
    const decision = await runTcpaGate(
      { bookingId: "bk_004", paUserId: "u_004", phoneE164: "+14155551234" },
      { fs: asFirestore(mfs), mode: "blocking", now: () => QUIET_PT, generateRunId: () => "run_004" },
    )
    assert.equal(decision.decision, "block_enforced")
    assert.equal(decision.reason, "quiet_hours")
    assert.equal(decision.details.quietHours.state, "CA")
    assert.equal(decision.details.quietHours.localHour, 23)
  })

  it("observed mode logs would-block but stays block_observed", async () => {
    const mfs = new MockFirestore()
    await seedHappyUser(mfs, "u_005")
    const decision = await runTcpaGate(
      { bookingId: "bk_005", paUserId: "u_005", phoneE164: "+14155551234" },
      { fs: asFirestore(mfs), mode: "observed", now: () => QUIET_PT, generateRunId: () => "run_005" },
    )
    assert.equal(decision.decision, "block_observed")
    assert.equal(decision.reason, "quiet_hours")
  })
})

describe("runTcpaGate — consent blocks", () => {
  it("consent_missing blocks blocking mode", async () => {
    const mfs = new MockFirestore()
    // user exists but no consent map
    await mfs.collection("pa-users").doc("u_006").set({ displayName: "X" })
    const decision = await runTcpaGate(
      { bookingId: "bk_006", paUserId: "u_006", phoneE164: "+14155551234" },
      { fs: asFirestore(mfs), mode: "blocking", now: () => ALLOW_TIME, generateRunId: () => "run_006" },
    )
    assert.equal(decision.decision, "block_enforced")
    assert.equal(decision.reason, "consent_missing")
  })

  it("consent_denied blocks blocking mode", async () => {
    const mfs = new MockFirestore()
    await mfs.collection("pa-users").doc("u_007").set({
      consent: { voiceRecording: false },
    })
    const decision = await runTcpaGate(
      { bookingId: "bk_007", paUserId: "u_007", phoneE164: "+14155551234" },
      { fs: asFirestore(mfs), mode: "blocking", now: () => ALLOW_TIME, generateRunId: () => "run_007" },
    )
    assert.equal(decision.decision, "block_enforced")
    assert.equal(decision.reason, "consent_denied")
  })

  it("user_not_found blocks blocking mode", async () => {
    const mfs = new MockFirestore()
    const decision = await runTcpaGate(
      { bookingId: "bk_008", paUserId: "u_missing", phoneE164: "+14155551234" },
      { fs: asFirestore(mfs), mode: "blocking", now: () => ALLOW_TIME, generateRunId: () => "run_008" },
    )
    assert.equal(decision.decision, "block_enforced")
    assert.equal(decision.reason, "user_not_found")
  })
})

describe("runTcpaGate — priority (first-block-wins)", () => {
  it("DNC wins over quiet-hours when both would block", async () => {
    const mfs = new MockFirestore()
    await seedHappyUser(mfs, "u_009")
    await mfs.collection("voice-dnc").doc("+14155551234").set({})
    const decision = await runTcpaGate(
      { bookingId: "bk_009", paUserId: "u_009", phoneE164: "+14155551234" },
      { fs: asFirestore(mfs), mode: "blocking", now: () => QUIET_PT, generateRunId: () => "run_009" },
    )
    assert.equal(decision.reason, "dnc_listed")
    // But the audit details still record that quiet-hours would have blocked too:
    assert.equal(decision.details.dnc.blocked, true)
    assert.equal(decision.details.quietHours.blocked, true)
  })

  it("quiet-hours wins over consent when DNC clean but both others block", async () => {
    const mfs = new MockFirestore()
    // consent missing
    await mfs.collection("pa-users").doc("u_010").set({})
    const decision = await runTcpaGate(
      { bookingId: "bk_010", paUserId: "u_010", phoneE164: "+14155551234" },
      { fs: asFirestore(mfs), mode: "blocking", now: () => QUIET_PT, generateRunId: () => "run_010" },
    )
    assert.equal(decision.reason, "quiet_hours")
    assert.equal(decision.details.consent.blocked, true)
  })
})

describe("runTcpaGate — non-US phone (quiet-hours bypass)", () => {
  it("allows non-US phone even at would-be-quiet UTC time when DNC clean + consent OK", async () => {
    const mfs = new MockFirestore()
    await seedHappyUser(mfs, "u_011")
    const decision = await runTcpaGate(
      { bookingId: "bk_011", paUserId: "u_011", phoneE164: "+447911123456" },
      { fs: asFirestore(mfs), mode: "blocking", now: () => QUIET_PT, generateRunId: () => "run_011" },
    )
    assert.equal(decision.decision, "allow")
    assert.equal(decision.details.quietHours.state, "non_us")
  })
})
