// @ts-nocheck - landing app typecheck only includes Vite/browser types; this file runs with node --test via tsx.
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import test from "node:test"

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(resolve(here, "CompanyProfile.tsx"), "utf8")

test("CompanyProfile keeps the employer process copy consent-safe", () => {
  assert.match(source, /Claire confirms role fit with you\./)
  assert.match(source, /Only candidates who pass and consent get shared\./)
  assert.match(source, /If there is mutual interest, the first chat gets booked\./)

  assert.doesNotMatch(source, /WeKruit shares a concise profile\./)
})
