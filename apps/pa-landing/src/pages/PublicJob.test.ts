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
  assert.doesNotMatch(source, /job\.interviewSeats \?\? 3/)
  assert.doesNotMatch(source, /interviewSeats: job\.interviewSeats \?\? \(\(h % 4\) \+ 1\)/)
  assert.doesNotMatch(source, /Claire interview \$\{seats === 1 \? "slot" : "slots"\} this week/)
  assert.doesNotMatch(source, /See Claire-ready roles/)
  assert.doesNotMatch(source, /It may have filled or been pulled back\./)
  assert.doesNotMatch(source, />\s*Interview for this job\s*</)
  assert.doesNotMatch(source, /See open interviews/)
  assert.match(source, /Passed profile to hiring team/)
  assert.match(source, /Claire starts with the role interview/)
  assert.match(source, /See public roles/)
  assert.match(source, /Start Claire interview/)
})

test("PublicJob resume upload avoids internal configuration errors", () => {
  assert.doesNotMatch(source, /CV ingest endpoint is not configured/)
  assert.match(source, /Resume upload is temporarily unavailable\. Message Claire and we'll attach it to this role\./)
})

test("PublicJob resume upload avoids status-code fallback errors", () => {
  assert.doesNotMatch(source, /Upload failed \(\$\{res\.status\}\)/)
  assert.doesNotMatch(source, /Upload failed \(\$\{status\}\)\. Try again\./)
  assert.match(source, /Resume upload did not finish\. Message Claire and we'll attach it to this role\./)
})
