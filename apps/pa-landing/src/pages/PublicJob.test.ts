// @ts-nocheck - landing app typecheck only includes Vite/browser types; this file runs with node --test via tsx.
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import test from "node:test"

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(resolve(here, "PublicJob.tsx"), "utf8")

test("PublicJob frames role entry as Claire-first passed-profile flow", () => {
  assert.doesNotMatch(source, /Meet the hiring manager/)
  assert.doesNotMatch(source, /interview \$\{seats === 1 \? "seat" : "seats"\} this week/)
  assert.doesNotMatch(source, />\s*Interview for this job\s*</)
  assert.doesNotMatch(source, /See open interviews/)
  assert.match(source, /Passed profile to hiring team/)
  assert.match(source, /Claire interview \$\{seats === 1 \? "slot" : "slots"\} this week/)
  assert.match(source, /Start Claire interview/)
})
