import assert from "node:assert/strict"
import test from "node:test"
import { createHmac } from "node:crypto"
import {
  computeUpstreamSignature,
  extractUpstreamSignatureHeader,
  verifyUpstreamSignature,
} from "../upstream-hmac.js"

const SECRET = "test-secret-abc"
const BODY = JSON.stringify({ eventKind: "interview_scheduled", userId: "u1", payload: {} })

function hmacHex(body: string, secret: string): string {
  return createHmac("sha256", secret).update(body, "utf8").digest("hex")
}

test("verifyUpstreamSignature accepts a valid signature", () => {
  const sig = hmacHex(BODY, SECRET)
  assert.equal(verifyUpstreamSignature(BODY, sig, SECRET), true)
})

test("verifyUpstreamSignature accepts sha256= prefix", () => {
  const sig = "sha256=" + hmacHex(BODY, SECRET)
  assert.equal(verifyUpstreamSignature(BODY, sig, SECRET), true)
})

test("verifyUpstreamSignature rejects wrong secret", () => {
  const sig = hmacHex(BODY, "different-secret")
  assert.equal(verifyUpstreamSignature(BODY, sig, SECRET), false)
})

test("verifyUpstreamSignature rejects empty header", () => {
  assert.equal(verifyUpstreamSignature(BODY, "", SECRET), false)
  assert.equal(verifyUpstreamSignature(BODY, undefined, SECRET), false)
  assert.equal(verifyUpstreamSignature(BODY, null, SECRET), false)
})

test("verifyUpstreamSignature rejects non-hex header", () => {
  assert.equal(verifyUpstreamSignature(BODY, "not-hex-!!!", SECRET), false)
})

test("verifyUpstreamSignature rejects empty secret", () => {
  const sig = hmacHex(BODY, SECRET)
  assert.equal(verifyUpstreamSignature(BODY, sig, ""), false)
})

test("verifyUpstreamSignature rejects body tamper", () => {
  const sig = hmacHex(BODY, SECRET)
  assert.equal(verifyUpstreamSignature(BODY + "tampered", sig, SECRET), false)
})

test("verifyUpstreamSignature handles Buffer body identically to string", () => {
  const sig = hmacHex(BODY, SECRET)
  assert.equal(verifyUpstreamSignature(Buffer.from(BODY, "utf8"), sig, SECRET), true)
})

test("computeUpstreamSignature is deterministic and matches verify path", () => {
  const sig = computeUpstreamSignature(BODY, SECRET)
  const sigAgain = computeUpstreamSignature(BODY, SECRET)
  assert.equal(sig, sigAgain)
  assert.equal(verifyUpstreamSignature(BODY, sig, SECRET), true)
})

test("extractUpstreamSignatureHeader picks first known alias", () => {
  assert.equal(
    extractUpstreamSignatureHeader({ "x-pa-upstream-signature": "abc" }),
    "abc"
  )
  assert.equal(
    extractUpstreamSignatureHeader({ "x-upstream-signature": "def" }),
    "def"
  )
  assert.equal(
    extractUpstreamSignatureHeader({ "pa-upstream-signature": "ghi" }),
    "ghi"
  )
  assert.equal(extractUpstreamSignatureHeader({}), undefined)
})

test("extractUpstreamSignatureHeader prefers x-pa-upstream-signature over fallbacks", () => {
  assert.equal(
    extractUpstreamSignatureHeader({
      "x-pa-upstream-signature": "preferred",
      "x-upstream-signature": "fallback",
    }),
    "preferred"
  )
})
