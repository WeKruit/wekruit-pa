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

test("PublicJobCv never dead-ends with the receipt script — routes into the job continuation CTA", () => {
  // ENTRY-UX-PRD §1/§2.3.5: "Resume uploaded. You can close this tab." is the
  // canonical banned receipt dead-end. Success must continue with Claire.
  assert.doesNotMatch(source, /You can close this tab/)
  assert.match(source, /navigate\(`\/j\/\$\{publicJobId\}`, \{ replace: true \}\)/)
  assert.match(source, /continue with Claire/)
})

test("PublicJobCv resume upload avoids status-code and raw exception fallback errors", () => {
  assert.doesNotMatch(source, /Upload failed \(\$\{res\.status\}\)/)
  assert.doesNotMatch(source, /err instanceof Error \? err\.message : String\(err\)/)
  assert.match(source, /Resume upload did not finish\. Message Claire and we'll attach it to this role\./)
})
