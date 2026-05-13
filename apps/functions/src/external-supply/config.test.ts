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

test("getExternalSupplyConfig — both true when env set", () => {
  const out = runGetExternalSupplyConfig({}, ADMIN_AUTH, {
    readEnv: envMap({
      EXTERNAL_SUPPLY_LIVE_OUTREACH_ENABLED: "true",
      INSTANTLY_API_KEY: "k-123",
    }),
  })
  assert.deepEqual(out, { liveOutreachEnabled: true, instantlyConfigured: true })
})

test("getExternalSupplyConfig — both false when env unset", () => {
  const out = runGetExternalSupplyConfig({}, ADMIN_AUTH, { readEnv: envMap({}) })
  assert.deepEqual(out, { liveOutreachEnabled: false, instantlyConfigured: false })
})

test("getExternalSupplyConfig — mixed env states", () => {
  const out1 = runGetExternalSupplyConfig({}, ADMIN_AUTH, {
    readEnv: envMap({ EXTERNAL_SUPPLY_LIVE_OUTREACH_ENABLED: "true" }),
  })
  assert.deepEqual(out1, { liveOutreachEnabled: true, instantlyConfigured: false })

  const out2 = runGetExternalSupplyConfig({}, ADMIN_AUTH, {
    readEnv: envMap({ INSTANTLY_API_KEY: "k-abc" }),
  })
  assert.deepEqual(out2, { liveOutreachEnabled: false, instantlyConfigured: true })

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
