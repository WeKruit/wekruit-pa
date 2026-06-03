// @ts-nocheck - landing app typecheck only includes Vite/browser types; this file runs with node --test via tsx.
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import test from "node:test"

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(resolve(here, "main.tsx"), "utf8")

test("candidate routes expose privacy as a first-class signed-in surface", () => {
  assert.match(source, /import \{ CandidateMe, CandidateProfile, CandidateMatches, CandidatePrivacy \} from "\.\/pages\/CandidatePortal\.js"/)
  assert.match(source, /<Route path="\/me\/privacy" element=\{<CandidatePrivacy \/>\} \/>/)
})
