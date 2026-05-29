// @ts-nocheck - landing app typecheck only includes Vite/browser types; this file runs with node --test via tsx.
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import test from "node:test"

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(resolve(here, "CandidatePortal.tsx"), "utf8")

test("CandidatePortal renders review decisions only inside committed pipeline rows", () => {
  assert.match(source, /reviewDecision/)
  assert.match(source, /CandidateReviewDecision/)
  assert.match(source, /shouldShowReviewDecision/)
  assert.match(source, /profile stays active/i)
  assert.match(source, /decisionReason/)
  assert.match(source, /recommendedActions/)
  assert.doesNotMatch(source, /employer_visible/)
})

test("CandidatePortal does not show unimplemented account connectors as connectable", () => {
  assert.doesNotMatch(source, /label: "GitHub"/)
  assert.doesNotMatch(source, /label: "Cal\.com"/)
  assert.doesNotMatch(source, /wkv2-conn__btn--connect/)
  assert.doesNotMatch(source, />Connect</)
  assert.doesNotMatch(source, />Manage</)
})
