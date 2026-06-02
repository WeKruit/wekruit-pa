// @ts-nocheck - source contract test for the React hook.
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import test from "node:test"

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(resolve(here, "candidate-portal-gate.ts"), "utf8")

test("candidate portal gate preserves profile hash targets through login", () => {
  assert.match(source, /const nextPath = `\$\{location\.pathname\}\$\{location\.search\}\$\{location\.hash\}`/)
  assert.match(source, /\[location\.pathname, location\.search, location\.hash, navigate\]/)
})
