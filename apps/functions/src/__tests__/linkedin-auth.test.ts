import assert from "node:assert/strict"
import test from "node:test"
import {
  buildLinkedinState,
  isAllowedReturnTo,
  parseLinkedinState,
} from "../linkedin-auth.js"

test("LinkedIn OAuth state accepts signed candidate connector state", () => {
  const now = Date.now()
  const raw = buildLinkedinState(
    {
      returnTo: "https://wekruit.com/me/profile",
      ts: now,
      mode: "connect",
      provider: "linkedin",
      firebaseUid: "firebase-1",
      candidateId: "cand-1",
    },
    "secret",
  )

  const parsed = parseLinkedinState(raw, "secret", now)
  assert.deepEqual(parsed, {
    returnTo: "https://wekruit.com/me/profile",
    ts: now,
    mode: "connect",
    provider: "linkedin",
    firebaseUid: "firebase-1",
    candidateId: "cand-1",
  })
})

test("LinkedIn OAuth state rejects tampering and stale connector state", () => {
  const now = Date.now()
  const raw = buildLinkedinState(
    {
      returnTo: "https://wekruit.com/me/profile",
      ts: now,
      mode: "connect",
      provider: "linkedin",
      firebaseUid: "firebase-1",
      candidateId: "cand-1",
    },
    "secret",
  )

  assert.equal(parseLinkedinState(`${raw}x`, "secret", now), null)
  assert.equal(parseLinkedinState(raw, "secret", now + 11 * 60 * 1000), null)
})

test("LinkedIn connector return targets stay on WeKruit-owned origins", () => {
  assert.equal(isAllowedReturnTo("https://wekruit.com/me/profile"), true)
  assert.equal(isAllowedReturnTo("https://candidate.wekruit.com/me/profile"), true)
  assert.equal(isAllowedReturnTo("https://evil.example/me/profile"), false)
})
