// @ts-nocheck - landing app typecheck only includes Vite/browser types; this file runs with node --test via tsx.
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import test from "node:test"

const here = dirname(fileURLToPath(import.meta.url))
const employersSource = readFileSync(resolve(here, "Employers.tsx"), "utf8")
const sequenceSource = readFileSync(resolve(here, "../components/Sequence.tsx"), "utf8")
const source = `${employersSource}\n${sequenceSource}`

test("Employers page frames passed-profile preview without unsupported traction claims", () => {
  assert.doesNotMatch(source, /1,247|92%|13 interviews|8 hires|≈ 6\.4 hrs|14%|86%/)
  assert.doesNotMatch(source, /Claire runs the whole funnel|whole funnel/i)
  assert.doesNotMatch(source, /passes lead to a real intro|Pass → onsite conversion/i)
  assert.doesNotMatch(source, /first intro lands on your calendar in 48 hrs/i)
  assert.doesNotMatch(source, /Hundreds of conversations a week|every credible candidate/i)
  assert.doesNotMatch(source, /Three to five passes a week|3 passes|5 passes this week|14 more candidates/i)
  assert.doesNotMatch(source, /Match \{[pc]\.score\}|Match \d+/)
  assert.match(source, /Sample passed-profile preview/)
  assert.match(source, /passed profiles plus the transcript/i)
})
