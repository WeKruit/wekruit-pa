/**
 * v2.1 S5 — consent check unit tests.
 */

import { describe, it } from "node:test"
import assert from "node:assert/strict"

import { MockFirestore, asFirestore } from "../../../job-rec/__tests__/mock-firestore.js"
import { checkConsent } from "../consentCheck.js"

describe("checkConsent", () => {
  it("allows when consent.voiceRecording === true", async () => {
    const mfs = new MockFirestore()
    await mfs.collection("pa-users").doc("u_001").set({
      consent: {
        voiceRecording: true,
        voiceRecordingConsentAt: "2026-05-14T10:00:00Z",
      },
    })
    const res = await checkConsent("u_001", { fs: asFirestore(mfs) })
    assert.equal(res.blocked, false)
    assert.equal(res.reason, undefined)
    assert.equal(res.consentedAt, "2026-05-14T10:00:00Z")
  })

  it("blocks when consent.voiceRecording === false (consent_denied)", async () => {
    const mfs = new MockFirestore()
    await mfs.collection("pa-users").doc("u_002").set({
      consent: {
        voiceRecording: false,
        voiceRecordingConsentAt: "2026-05-14T10:00:00Z",
      },
    })
    const res = await checkConsent("u_002", { fs: asFirestore(mfs) })
    assert.equal(res.blocked, true)
    assert.equal(res.reason, "consent_denied")
    assert.equal(res.consentedAt, "2026-05-14T10:00:00Z")
  })

  it("blocks when consent map is absent (consent_missing)", async () => {
    const mfs = new MockFirestore()
    await mfs.collection("pa-users").doc("u_003").set({ displayName: "X" })
    const res = await checkConsent("u_003", { fs: asFirestore(mfs) })
    assert.equal(res.blocked, true)
    assert.equal(res.reason, "consent_missing")
    assert.equal(res.consentedAt, "")
  })

  it("blocks when consent.voiceRecording is missing (consent_missing)", async () => {
    const mfs = new MockFirestore()
    await mfs.collection("pa-users").doc("u_004").set({
      consent: { piiSharing: true }, // unrelated consent field
    })
    const res = await checkConsent("u_004", { fs: asFirestore(mfs) })
    assert.equal(res.blocked, true)
    assert.equal(res.reason, "consent_missing")
  })

  it("blocks when consent.voiceRecording is non-boolean (consent_missing)", async () => {
    const mfs = new MockFirestore()
    await mfs.collection("pa-users").doc("u_005").set({
      consent: { voiceRecording: "yes" }, // wrong type
    })
    const res = await checkConsent("u_005", { fs: asFirestore(mfs) })
    assert.equal(res.blocked, true)
    assert.equal(res.reason, "consent_missing")
  })

  it("blocks when pa-users doc does not exist (user_not_found)", async () => {
    const mfs = new MockFirestore()
    const res = await checkConsent("u_unknown", { fs: asFirestore(mfs) })
    assert.equal(res.blocked, true)
    assert.equal(res.reason, "user_not_found")
  })

  it("blocks empty userId (user_not_found, no Firestore call)", async () => {
    const mfs = new MockFirestore()
    const res = await checkConsent("   ", { fs: asFirestore(mfs) })
    assert.equal(res.blocked, true)
    assert.equal(res.reason, "user_not_found")
  })

  it("trims whitespace before lookup", async () => {
    const mfs = new MockFirestore()
    await mfs.collection("pa-users").doc("u_007").set({
      consent: { voiceRecording: true },
    })
    const res = await checkConsent("  u_007  ", { fs: asFirestore(mfs) })
    assert.equal(res.blocked, false)
  })
})
