import assert from "node:assert/strict"
import test from "node:test"
import { parsePaAdminContactsFromEnv, inboundFromMatchesPaAdminContacts } from "./admin-contacts.js"

test("parsePaAdminContactsFromEnv merges CONTACTS + PHONES + EMAILS without dupes", () => {
  const prev = {
    PA_ADMIN_CONTACTS: process.env.PA_ADMIN_CONTACTS,
    PA_ADMIN_PHONES: process.env.PA_ADMIN_PHONES,
    PA_ADMIN_EMAILS: process.env.PA_ADMIN_EMAILS,
  }
  try {
    process.env.PA_ADMIN_CONTACTS = "+1 415 555 0100, Ops@WEKRUIT.TEST"
    process.env.PA_ADMIN_PHONES = "(415) 555-0100"
    process.env.PA_ADMIN_EMAILS = "ops@wekruit.test, other@wekruit.test"
    const p = parsePaAdminContactsFromEnv()
    assert.equal(p.phonesNorm.length, 1)
    assert.equal(p.emailsNorm.length, 2)
    assert.ok(p.emailsNorm.includes("ops@wekruit.test"))
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
})

test("inboundFromMatchesPaAdminContacts: email exact lowercase", () => {
  const parsed = { phonesNorm: [], emailsNorm: ["boss@icloud.com"] }
  assert.equal(inboundFromMatchesPaAdminContacts("Boss@ICLOUD.com", parsed), true)
  assert.equal(inboundFromMatchesPaAdminContacts("other@icloud.com", parsed), false)
})

test("inboundFromMatchesPaAdminContacts: phone last-10 + strip zwsp", () => {
  const parsed = { phonesNorm: ["+12025559876"], emailsNorm: [] }
  assert.equal(inboundFromMatchesPaAdminContacts("+1 (202) 555‑9876", parsed), true)
  assert.equal(inboundFromMatchesPaAdminContacts("\u200B+12025559876\uFEFF", parsed), true)
})

test("inboundFromMatchesPaAdminContacts: empty parsed → false", () => {
  const parsed = { phonesNorm: [], emailsNorm: [] }
  assert.equal(inboundFromMatchesPaAdminContacts("+12025559876", parsed), false)
})
