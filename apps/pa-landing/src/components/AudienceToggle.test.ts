// @ts-nocheck - landing app typecheck only includes Vite/browser types; this file runs with node --test via tsx.
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import test from "node:test"

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(resolve(here, "AudienceToggle.tsx"), "utf8")
const styles = readFileSync(resolve(here, "../styles/wekruit-pages.css"), "utf8")

test("AudienceToggle keeps full accessible labels while using shorter mobile text", () => {
  assert.match(source, /aria-label="For candidates"/)
  assert.match(source, /aria-label="For companies"/)
  assert.match(source, /className="wk-aud__full">For candidates<\/span>/)
  assert.match(source, /className="wk-aud__full">For companies<\/span>/)
  assert.match(source, /className="wk-aud__short" aria-hidden="true">Candidates<\/span>/)
  assert.match(source, /className="wk-aud__short" aria-hidden="true">Companies<\/span>/)

  assert.match(styles, /\.wk-aud__short \{ display: none; \}/)
  assert.match(styles, /@media \(max-width: 480px\) \{[\s\S]*\.wk-aud__full \{ display: none; \}/)
  assert.match(styles, /@media \(max-width: 480px\) \{[\s\S]*\.wk-aud__short \{ display: inline; \}/)
})
