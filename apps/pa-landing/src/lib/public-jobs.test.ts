// @ts-nocheck - landing app typecheck only includes Vite/browser types; this file runs with node --test via tsx.
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import test from "node:test"
import { formatPublicJobType } from "./public-job-labels.js"

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(resolve(here, "public-jobs.ts"), "utf8")

test("formatPublicJobType presents backend job type enums as candidate-facing labels", () => {
  assert.equal(formatPublicJobType("full_time"), "Full-time")
  assert.equal(formatPublicJobType("part-time"), "Part-time")
  assert.equal(formatPublicJobType("CONTRACT"), "Contract")
  assert.equal(formatPublicJobType("remote_flexible"), "Remote flexible")
  assert.equal(formatPublicJobType("  "), undefined)
})

test("toPublicJobOpening formats public job type before exposing it to candidate surfaces", () => {
  assert.match(source, /import \{ formatPublicJobType \} from "\.\/public-job-labels\.js"/)
  assert.match(source, /jobType: formatPublicJobType\(raw\.jobType \?\? raw\.prescreenConfig\?\.jobType\)/)
  assert.doesNotMatch(source, /jobType: raw\.jobType/)
})

test("Landing hero and Market direct line share ONE cached raw pa-jobs snapshot", () => {
  // The raw 48-doc publicVisible read is the most expensive client fetch on
  // the candidate site. Both surfaces must consume the SAME TanStack key +
  // fetcher (each with its own `select`) so landing → market costs one read
  // per 6h window instead of two.
  assert.match(source, /export const PUBLIC_PA_JOBS_RAW_LIMIT = 48/)
  assert.match(
    source,
    /export const PUBLIC_PA_JOBS_RAW_QUERY_KEY = \["pa-jobs-hero", PUBLIC_PA_JOBS_RAW_LIMIT\] as const/,
  )

  const landingSource = readFileSync(resolve(here, "../pages/Landing.tsx"), "utf8")
  const marketSource = readFileSync(resolve(here, "../pages/Market.tsx"), "utf8")
  for (const pageSource of [landingSource, marketSource]) {
    assert.match(pageSource, /queryKey: PUBLIC_PA_JOBS_RAW_QUERY_KEY/)
    assert.match(pageSource, /queryFn: \(\) => fetchPublicPaJobsRaw\(PUBLIC_PA_JOBS_RAW_LIMIT\)/)
  }
  // Neither page re-issues its own ad-hoc publicVisible getDocs read.
  assert.doesNotMatch(landingSource, /getDocs\(/)
  assert.doesNotMatch(marketSource, /getDocs\(/)
})
