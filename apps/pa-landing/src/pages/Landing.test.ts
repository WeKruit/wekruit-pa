// @ts-nocheck - landing app typecheck only includes Vite/browser types; this file runs with node --test via tsx.
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import test from "node:test"

const here = dirname(fileURLToPath(import.meta.url))
const landingSource = readFileSync(resolve(here, "Landing.tsx"), "utf8")
const sequenceSource = readFileSync(resolve(here, "../components/Sequence.tsx"), "utf8")
const source = `${landingSource}\n${sequenceSource}`

test("Landing frames the candidate promise as Claire-first passed-profile flow", () => {
  assert.doesNotMatch(source, /interview directly with the hiring manager/i)
  assert.doesNotMatch(source, /hiring managers who want to meet you this week/i)
  assert.doesNotMatch(source, /hiring managers<\/strong> taking interviews this week/i)
  assert.doesNotMatch(source, /Claire texts back within a minute/i)
  assert.doesNotMatch(source, /interview seats fill up/i)
  assert.doesNotMatch(source, /Got <em className="wk-accent">3 interviews<\/em> in a week/i)
  assert.doesNotMatch(source, /direct first interview with the hiring manager/i)
  assert.doesNotMatch(source, /No recruiter screen|No take-home tournament|Calendar invite in 48 hours/i)
  assert.doesNotMatch(source, />\s*Interview with hiring manager\s*</i)
  assert.match(source, /Claire starts the first interview/i)
  assert.match(source, /passed profile/i)
})
