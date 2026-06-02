// @ts-nocheck - source-contract test runs with node --test via tsx.
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import test from "node:test"

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(resolve(here, "../LayoffEmployers.tsx"), "utf8")

test("LayoffEmployers review shows hard filters separately from notes", () => {
  assert.match(source, /hardFilters\?: string\[\]/)
  assert.match(source, /Hard filters/)
  assert.match(source, /r\.hardFilters/)
  assert.match(source, /Notes/)

  assert.doesNotMatch(source, /hard filters are optional/i)
})
