// @ts-nocheck - landing app typecheck only includes Vite/browser types; this file runs with node --test via tsx.
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import test from "node:test"

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(resolve(here, "PublicJobCv.tsx"), "utf8")

test("PublicJobCv resume upload avoids internal configuration errors", () => {
  assert.doesNotMatch(source, /CV ingest endpoint not configured/)
  assert.doesNotMatch(source, /Please reach out to support/)
  assert.match(source, /Resume upload is temporarily unavailable\. Message Claire and we'll attach it to this role\./)
})
