/**
 * S3 — migration script idempotency tests.
 *
 * Covers acceptance:
 *   "migration script idempotent (re-run = no double-add)"
 */

import { describe, it } from "node:test"
import assert from "node:assert/strict"

import {
  VOICE_FIELD_DEFAULTS,
  computeMigrationUpdate,
} from "../migrate-outbound-bookings-voice-fields.mjs"

describe("computeMigrationUpdate (pure)", () => {
  it("plants all 8 default fields on a bare row", () => {
    const { update, addedFields, missingIdentity } = computeMigrationUpdate({
      paUserId: "U1",
      paJobId: "J1",
    })
    assert.deepEqual(
      Object.keys(update).sort(),
      Object.keys(VOICE_FIELD_DEFAULTS).sort(),
    )
    assert.equal(addedFields.length, 8)
    assert.deepEqual(missingIdentity, [])
  })

  it("is no-op when all fields already present (re-run safety)", () => {
    const populated = {
      paUserId: "U1",
      paJobId: "J1",
      ...VOICE_FIELD_DEFAULTS,
    }
    const { update, addedFields } = computeMigrationUpdate(populated)
    assert.deepEqual(update, {})
    assert.deepEqual(addedFields, [])
  })

  it("does not overwrite an in-flight voiceState=dialing row", () => {
    const populated = {
      paUserId: "U1",
      paJobId: "J1",
      voiceState: "dialing",
      voiceCallSid: "CA-abc",
      voiceRoomName: "B-1",
      voiceStartedAt: "2026-05-15T00:00:00.000Z",
      voiceEndedAt: null,
      voiceOutcome: null,
      voiceLastError: null,
      voiceCallerId: "+14157075057",
    }
    const { update, addedFields } = computeMigrationUpdate(populated)
    assert.deepEqual(update, {})
    assert.deepEqual(addedFields, [])
  })

  it("fills only the subset of missing fields (idempotent partial migration)", () => {
    const partial = {
      paUserId: "U1",
      paJobId: "J1",
      voiceState: "queued",
      // voiceCallSid, voiceRoomName, etc absent
    }
    const { update, addedFields } = computeMigrationUpdate(partial)
    assert.ok(!("voiceState" in update), "should NOT re-touch voiceState")
    assert.ok("voiceCallSid" in update)
    assert.equal(addedFields.includes("voiceState"), false)
    assert.equal(addedFields.includes("voiceCallSid"), true)
  })

  it("reports missingIdentity when paUserId absent", () => {
    const { missingIdentity } = computeMigrationUpdate({ paJobId: "J1" })
    assert.deepEqual(missingIdentity, ["paUserId"])
  })

  it("reports missingIdentity when paJobId is empty string", () => {
    const { missingIdentity } = computeMigrationUpdate({ paUserId: "U1", paJobId: "" })
    assert.deepEqual(missingIdentity, ["paJobId"])
  })

  it("treats null/undefined doc as fully missing", () => {
    const a = computeMigrationUpdate(null)
    const b = computeMigrationUpdate(undefined)
    assert.deepEqual(a.update, {})
    assert.deepEqual(a.missingIdentity, ["paUserId", "paJobId"])
    assert.deepEqual(b.update, {})
  })

  it("re-running on output of first run produces no further fields (key idempotency assertion)", () => {
    const bare = { paUserId: "U1", paJobId: "J1" }
    const first = computeMigrationUpdate(bare)
    const afterFirstWrite = { ...bare, ...first.update }
    const second = computeMigrationUpdate(afterFirstWrite)
    assert.deepEqual(second.update, {})
    assert.equal(second.addedFields.length, 0)
  })
})
