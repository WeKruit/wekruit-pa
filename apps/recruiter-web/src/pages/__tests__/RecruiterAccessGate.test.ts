// @ts-nocheck - source-contract test runs with node --test via tsx.
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import test from "node:test"

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(resolve(here, "../RecruiterBoard.tsx"), "utf8")

test("Recruiter access gate lets users leave the recruiter-only app for public WeKruit", () => {
  assert.doesNotMatch(source, new RegExp('<Link to="/" className="rb-access__link">Back to WeKruit</Link>'))
  assert.match(source, new RegExp('<a href="https://candidate\\.wekruit\\.com/" className="rb-access__link">Back to WeKruit</a>'))
})
