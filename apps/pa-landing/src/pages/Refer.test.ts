// @ts-nocheck - landing app typecheck only includes Vite/browser types; this file runs with node --test via tsx.
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import test from "node:test"

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(resolve(here, "Refer.tsx"), "utf8")

test("ReferPage gates the signed-in referral dashboard before rendering connector state", () => {
  assert.match(source, /signedIn: boolean \| null/)
  assert.match(source, /signedIn === false/)
  assert.match(source, /<Navigate to="\/login\?next=%2Fme%2Frefer" replace \/>/)
  assert.doesNotMatch(source, /humanizeSlug/)
})

test("ReferPage avoids unsupported traction and payout-certainty claims", () => {
  assert.doesNotMatch(source, /current top earner/i)
  assert.doesNotMatch(source, /paid same week/i)
  assert.doesNotMatch(source, /Both payments are automatic/i)
  assert.doesNotMatch(source, /Refer · live/)
  assert.match(source, /Refer · tracked/)
  assert.match(source, /Rewards are tracked here after interviews and offers are confirmed\./)
  assert.match(source, /Payouts are confirmed by WeKruit ops/)
})

test("ReferPage surfaces dashboard load failures instead of silently showing an empty ledger", () => {
  assert.match(source, /error: string \| null/)
  assert.match(source, /function referralDashboardErrorMessage/)
  assert.match(source, /setError\(referralDashboardErrorMessage\(err\)\)/)
  assert.match(source, /function ReferralDashboardError\(/)
  assert.match(source, /role="alert"/)
  assert.match(source, /Your referral dashboard couldn&apos;t load/)
  assert.doesNotMatch(source, /catch \{\s*if \(!cancelled\) setData\(MOCK_PREVIEW\)/)
})
