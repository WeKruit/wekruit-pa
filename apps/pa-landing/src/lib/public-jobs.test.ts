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
