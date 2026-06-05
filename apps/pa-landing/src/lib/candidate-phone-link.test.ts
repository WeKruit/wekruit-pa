// @ts-nocheck - source-contract test for browser-only Firebase helpers.
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import test from "node:test"

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(resolve(here, "candidate-phone-link.ts"), "utf8")

test("candidate phone verification switches portal cache to the verified phone candidate", () => {
  assert.match(source, /import \{ auth, functions \} from "\.\/firebase\.js"/)
  assert.match(source, /import \{ clearPortalCache, mergePortalCache \} from "\.\/portal-cache\.js"/)
  assert.match(source, /rememberStoredValue\(ONBOARDING_CANDIDATE_ID_KEY, result\.data\.candidateId\)/)
  assert.match(source, /const firebaseUid = auth\(\)\.currentUser\?\.uid/)
  assert.match(source, /clearPortalCache\(firebaseUid\)/)
  assert.match(source, /portalReady: true/)
  assert.match(source, /candidateId: result\.data\.candidateId/)
})
