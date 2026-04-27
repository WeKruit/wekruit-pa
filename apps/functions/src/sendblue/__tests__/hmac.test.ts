import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { createHmac } from "node:crypto"

import { verifySendblueSignature } from "../hmac.js"

const SECRET = "test-secret-do-not-use"
const RAW_BODY = '{"event":"receive","content":"hello","from_number":"+15551234567"}'

function sign(body: string, secret: string): string {
  return createHmac("sha256", secret).update(body, "utf8").digest("hex")
}

describe("verifySendblueSignature", () => {
  it("returns true when HMAC of raw body + secret matches header (hex SHA-256)", () => {
    const sig = sign(RAW_BODY, SECRET)
    assert.equal(verifySendblueSignature(RAW_BODY, sig, SECRET), true)
  })

  it("returns false when body is tampered after signing", () => {
    const sig = sign(RAW_BODY, SECRET)
    const tampered = RAW_BODY.replace("hello", "evilll")
    assert.equal(verifySendblueSignature(tampered, sig, SECRET), false)
  })

  it("returns false when secret is wrong", () => {
    const sig = sign(RAW_BODY, "different-secret")
    assert.equal(verifySendblueSignature(RAW_BODY, sig, SECRET), false)
  })

  it("returns false when header is missing or empty", () => {
    assert.equal(verifySendblueSignature(RAW_BODY, undefined, SECRET), false)
    assert.equal(verifySendblueSignature(RAW_BODY, "", SECRET), false)
    assert.equal(verifySendblueSignature(RAW_BODY, null as unknown as string, SECRET), false)
  })

  it("returns false on equal-length-but-wrong-byte (timing-safe equality, not string ===)", () => {
    const sig = sign(RAW_BODY, SECRET)
    // Flip a single hex char while preserving length.
    const flipped = sig[0] === "a" ? "b" + sig.slice(1) : "a" + sig.slice(1)
    assert.equal(flipped.length, sig.length)
    assert.equal(verifySendblueSignature(RAW_BODY, flipped, SECRET), false)
  })

  it("accepts hex encoding (per 21-CONTRACT-NOTES.md §2)", () => {
    const sig = createHmac("sha256", SECRET).update(RAW_BODY, "utf8").digest("hex")
    // hex strings only contain 0-9a-f and are 64 chars for SHA-256
    assert.match(sig, /^[0-9a-f]{64}$/)
    assert.equal(verifySendblueSignature(RAW_BODY, sig, SECRET), true)
  })

  it("accepts Buffer raw body (Firebase Functions onRequest exposes req.rawBody as Buffer)", () => {
    const buf = Buffer.from(RAW_BODY, "utf8")
    const sig = sign(RAW_BODY, SECRET)
    assert.equal(verifySendblueSignature(buf, sig, SECRET), true)
  })

  it("does not throw on malformed inputs", () => {
    assert.doesNotThrow(() => verifySendblueSignature("", "", ""))
    assert.doesNotThrow(() => verifySendblueSignature(RAW_BODY, "not-hex-zzz", SECRET))
  })
})
