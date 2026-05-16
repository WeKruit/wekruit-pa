/**
 * v2.1 S5 — DNC check unit tests.
 *
 * Three contracts:
 *   - phone in `voice-dnc/{phoneE164}` → blocked
 *   - phone NOT in collection → allowed
 *   - whitespace-padded phone → normalized lookup
 */

import { describe, it } from "node:test"
import assert from "node:assert/strict"

import { MockFirestore, asFirestore } from "../../../job-rec/__tests__/mock-firestore.js"
import { checkDnc } from "../dncCheck.js"

describe("checkDnc", () => {
  it("blocks when phone is in voice-dnc collection", async () => {
    const mfs = new MockFirestore()
    await mfs.collection("voice-dnc").doc("+14155551234").set({ addedBy: "admin", reason: "carrier_dnc" })
    const res = await checkDnc("+14155551234", { fs: asFirestore(mfs) })
    assert.equal(res.blocked, true)
    assert.equal(res.reason, "dnc_listed")
    assert.equal(res.phoneE164, "+14155551234")
  })

  it("allows when phone is not in voice-dnc collection", async () => {
    const mfs = new MockFirestore()
    const res = await checkDnc("+14155556789", { fs: asFirestore(mfs) })
    assert.equal(res.blocked, false)
    assert.equal(res.reason, undefined)
    assert.equal(res.phoneE164, "+14155556789")
  })

  it("does not match a different phone (no prefix collision)", async () => {
    const mfs = new MockFirestore()
    await mfs.collection("voice-dnc").doc("+14155551234").set({})
    const res = await checkDnc("+14155551235", { fs: asFirestore(mfs) })
    assert.equal(res.blocked, false)
  })

  it("normalizes whitespace before lookup", async () => {
    const mfs = new MockFirestore()
    await mfs.collection("voice-dnc").doc("+14155551234").set({})
    const res = await checkDnc("  +14155551234  ", { fs: asFirestore(mfs) })
    assert.equal(res.blocked, true)
    assert.equal(res.phoneE164, "+14155551234")
  })

  it("returns allowed (no throw) for empty phone string", async () => {
    const mfs = new MockFirestore()
    const res = await checkDnc("", { fs: asFirestore(mfs) })
    assert.equal(res.blocked, false)
  })
})
