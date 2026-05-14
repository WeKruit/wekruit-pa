/**
 * Wave C Block F2 — getExternalSupplyConfig callable tests.
 *
 * Covers:
 *  - Admin auth gate rejects non-wekruit callers.
 *  - Both flags true when env vars set.
 *  - Both flags false when env unset.
 *  - Mixed: live flag true but key missing → instantlyConfigured=false.
 */

import assert from "node:assert/strict"
import test from "node:test"
import { HttpsError } from "firebase-functions/v2/https"
import { runGetExternalSupplyConfig } from "./config.js"

const ADMIN_AUTH = {
  uid: "operator-1",
  token: { email: "admin@wekruit.com", email_verified: true },
}

function envMap(map: Record<string, string | undefined>) {
  return (key: string) => map[key]
}

test("getExternalSupplyConfig rejects unauthenticated", () => {
  assert.throws(
    () => runGetExternalSupplyConfig({}, undefined, { readEnv: envMap({}) }),
    (err) => err instanceof HttpsError && err.code === "unauthenticated",
  )
})

test("getExternalSupplyConfig rejects non-wekruit email", () => {
  assert.throws(
    () =>
      runGetExternalSupplyConfig(
        {},
        { uid: "x", token: { email: "outsider@gmail.com", email_verified: true } },
        { readEnv: envMap({}) },
      ),
    (err) => err instanceof HttpsError && err.code === "permission-denied",
  )
})

test("getExternalSupplyConfig — fully configured (live + both providers)", () => {
  const out = runGetExternalSupplyConfig({}, ADMIN_AUTH, {
    readEnv: envMap({
      EXTERNAL_SUPPLY_LIVE_OUTREACH_ENABLED: "true",
      INSTANTLY_API_KEY: "k-123",
      MAILGUN_API_KEY: "mg-key",
      MAILGUN_DOMAIN: "mg.wekruit.com",
      MAILGUN_FROM: "claire@mg.wekruit.com",
    }),
  })
  assert.deepEqual(out, {
    liveOutreachEnabled: true,
    instantlyConfigured: true,
    mailgunConfigured: true,
    defaultEmailProvider: "mailgun",
  })
})

test("getExternalSupplyConfig — nothing configured", () => {
  const out = runGetExternalSupplyConfig({}, ADMIN_AUTH, { readEnv: envMap({}) })
  assert.deepEqual(out, {
    liveOutreachEnabled: false,
    instantlyConfigured: false,
    mailgunConfigured: false,
    defaultEmailProvider: "mailgun",
  })
})

test("getExternalSupplyConfig — mixed env states", () => {
  const out1 = runGetExternalSupplyConfig({}, ADMIN_AUTH, {
    readEnv: envMap({ EXTERNAL_SUPPLY_LIVE_OUTREACH_ENABLED: "true" }),
  })
  assert.equal(out1.liveOutreachEnabled, true)
  assert.equal(out1.instantlyConfigured, false)
  assert.equal(out1.mailgunConfigured, false)

  const out2 = runGetExternalSupplyConfig({}, ADMIN_AUTH, {
    readEnv: envMap({ INSTANTLY_API_KEY: "k-abc" }),
  })
  assert.equal(out2.instantlyConfigured, true)
  assert.equal(out2.mailgunConfigured, false)

  // Mailgun requires all three secrets to flip configured=true.
  const out2a = runGetExternalSupplyConfig({}, ADMIN_AUTH, {
    readEnv: envMap({ MAILGUN_API_KEY: "k", MAILGUN_DOMAIN: "d" /* MAILGUN_FROM missing */ }),
  })
  assert.equal(out2a.mailgunConfigured, false)
  const out2b = runGetExternalSupplyConfig({}, ADMIN_AUTH, {
    readEnv: envMap({
      MAILGUN_API_KEY: "k",
      MAILGUN_DOMAIN: "d",
      MAILGUN_FROM: "claire@d",
    }),
  })
  assert.equal(out2b.mailgunConfigured, true)

  // Empty string treated as unset.
  const out3 = runGetExternalSupplyConfig({}, ADMIN_AUTH, {
    readEnv: envMap({ INSTANTLY_API_KEY: "   " }),
  })
  assert.equal(out3.instantlyConfigured, false)

  // String literal not exactly "true" treated as false.
  const out4 = runGetExternalSupplyConfig({}, ADMIN_AUTH, {
    readEnv: envMap({ EXTERNAL_SUPPLY_LIVE_OUTREACH_ENABLED: "yes" }),
  })
  assert.equal(out4.liveOutreachEnabled, false)
})
