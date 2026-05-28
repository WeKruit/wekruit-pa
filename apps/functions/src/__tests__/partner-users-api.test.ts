import assert from "node:assert/strict"
import test from "node:test"

import { __test_verifyPartnerKey, __test_PARTNER_KEY_RE } from "../partner-users-api.js"

const KEYS_CSV = "key_layoffhedge_abc123def456,key_layoffheaven_xyz789"

test("verifyPartnerKey rejects missing api key", () => {
  const res = __test_verifyPartnerKey(undefined, undefined, KEYS_CSV, "*")
  assert.deepEqual(res, { ok: false, reason: "missing_api_key" })
})

test("verifyPartnerKey rejects malformed key shape", () => {
  const res = __test_verifyPartnerKey("not_a_key", undefined, KEYS_CSV, "*")
  assert.deepEqual(res, { ok: false, reason: "invalid_api_key_format" })
})

test("verifyPartnerKey rejects key not in CSV", () => {
  const res = __test_verifyPartnerKey("key_layoffhedge_wrongtail", undefined, KEYS_CSV, "*")
  assert.deepEqual(res, { ok: false, reason: "invalid_api_key" })
})

test("verifyPartnerKey rejects key whose prefix is not a PaUserSource", () => {
  // Add a key whose source slug isn't in PA_USER_SOURCES enum.
  const csv = "key_unknownpartner_abc123"
  const res = __test_verifyPartnerKey("key_unknownpartner_abc123", undefined, csv, "*")
  assert.deepEqual(res, { ok: false, reason: "key_partner_mismatch" })
})

test("verifyPartnerKey accepts valid layoffhedge key and returns partnerSource", () => {
  const res = __test_verifyPartnerKey("key_layoffhedge_abc123def456", undefined, KEYS_CSV, "*")
  assert.deepEqual(res, { ok: true, partnerSource: "layoffhedge" })
})

test("verifyPartnerKey enforces origin allowlist when set", () => {
  const allowlist = "https://layoffhedge.com,https://staging.layoffhedge.com"
  const ok = __test_verifyPartnerKey(
    "key_layoffhedge_abc123def456",
    "https://layoffhedge.com",
    KEYS_CSV,
    allowlist,
  )
  assert.deepEqual(ok, { ok: true, partnerSource: "layoffhedge" })

  const blocked = __test_verifyPartnerKey(
    "key_layoffhedge_abc123def456",
    "https://evil.example",
    KEYS_CSV,
    allowlist,
  )
  assert.deepEqual(blocked, { ok: false, reason: "origin_not_allowed" })
})

test("verifyPartnerKey server-to-server (no Origin) accepted on key alone", () => {
  const allowlist = "https://layoffhedge.com"
  const res = __test_verifyPartnerKey(
    "key_layoffhedge_abc123def456",
    undefined, // no Origin header
    KEYS_CSV,
    allowlist,
  )
  assert.deepEqual(res, { ok: true, partnerSource: "layoffhedge" })
})

test("PARTNER_KEY_RE captures multi-word slugs", () => {
  // Future partner with underscore in slug, e.g. `external_supply`
  const match = __test_PARTNER_KEY_RE.exec("key_external_supply_abc123")
  assert.ok(match)
  assert.equal(match![1], "external_supply")
})
