// @ts-nocheck - landing app typecheck only includes Vite/browser types; this file runs with node --test via tsx.
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import test from "node:test"

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(resolve(here, "Legal.tsx"), "utf8")

test("Legal keeps privacy copy readable in the candidate site shell", () => {
  assert.match(source, /body\.legal-bg \{[\s\S]*background: #fff;/)
  assert.match(source, /\.legal-h1,\s*\.legal-h2 \{ color: #0f172a; \}/)
  assert.match(source, /\.legal-section p,\s*\.legal-section li \{ color: #1e293b; \}/)

  assert.doesNotMatch(source, /prefers-color-scheme:\s*dark/)
  assert.doesNotMatch(source, /body\.legal-bg \{ background: #0a0a0a/)
})
