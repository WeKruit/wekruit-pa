// @ts-nocheck - source contract test runs with node --test via tsx.
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import test from "node:test"

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(resolve(here, "auth-redirect-bootstrap.ts"), "utf8")
const firebaseSource = readFileSync(resolve(here, "firebase.ts"), "utf8")

test("auth bootstrap does not blank public pages when Firebase env is absent", () => {
  assert.match(firebaseSource, /export function hasFirebaseConfig\(\): boolean/)
  assert.match(source, /hasFirebaseConfig\(\)[\s\S]*getRedirectResult\(auth\(\)\)\.catch\(\(\) => null\)/)
  assert.match(source, /hasFirebaseConfig\(\)[\s\S]*bootstrapSsoFromCookie\(\)\.catch\(\(\) => null\)/)
  assert.match(source, /if \(hasFirebaseConfig\(\)\) registerSsoCookieRefresh\(\)/)
})
