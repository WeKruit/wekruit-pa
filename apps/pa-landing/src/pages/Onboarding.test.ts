// @ts-nocheck - source contract test for the Vite page.
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import test from "node:test"

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(resolve(here, "Onboarding.tsx"), "utf8")

test("job-origin onboarding is framed as Claire role continuity, not bare registration", () => {
  assert.match(source, /returnJobId/)
  assert.match(source, /Profile \+ role context/)
  assert.match(source, /Claire role interview/)
  assert.match(source, /role context stays attached/)
  assert.match(source, /same role interview/)
  assert.doesNotMatch(source, /Register \+ resume/)
  assert.doesNotMatch(source, /Step 1 · Register/)
})

test("duplicate onboarding avoids reset-style visible actions", () => {
  assert.match(source, /Use latest info/)
  assert.match(source, /Replace your old info with what you just entered/)
  assert.doesNotMatch(source, />Start fresh</)
  assert.doesNotMatch(source, /<strong[^>]*>Start fresh<\/strong>/)
})
