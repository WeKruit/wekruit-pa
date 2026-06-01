// @ts-nocheck - landing app typecheck only includes Vite/browser types; this file runs with node --test via tsx.
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import test from "node:test"

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(resolve(here, "Refer.tsx"), "utf8")

test("ReferPage gates the signed-in referral dashboard before rendering connector state", () => {
  assert.match(source, /signedIn: boolean \| null/)
  assert.match(source, /signedIn === false/)
  assert.match(source, /<Navigate to="\/login\?next=%2Fme%2Frefer" replace \/>/)
  assert.doesNotMatch(source, /humanizeSlug/)
})
