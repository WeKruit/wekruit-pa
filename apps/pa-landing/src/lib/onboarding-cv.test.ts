// @ts-nocheck - landing app typecheck only includes Vite/browser types; this file runs with node --test via tsx.
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import test from "node:test"

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(resolve(here, "onboarding-cv.ts"), "utf8")

test("onboarding resume upload avoids status-code fallback errors", () => {
  assert.doesNotMatch(source, /Upload failed \(\$\{res\.status\}\)/)
  assert.match(source, /Resume upload did not finish\. Message Claire and we'll attach it to your profile\./)
})
