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

test("candidate public job routes stay on the candidate host", () => {
  assert.match(source, /<Route path="\/j\/:jobId" element=\{<PublicJob \/>\} \/>/)
  assert.doesNotMatch(source, /Canonical host = apex `wekruit\.com`/)
  assert.doesNotMatch(source, /host === "candidate\.wekruit\.com"[\s\S]*window\.location\.pathname\.startsWith\("\/j\/"\)[\s\S]*window\.location\.replace\(target\)/)
})
