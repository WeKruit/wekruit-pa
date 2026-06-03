// @ts-nocheck - landing app typecheck only includes Vite/browser types; this file runs with node --test via tsx.
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import test from "node:test"

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(resolve(here, "CandidateLogin.tsx"), "utf8")

test("CandidateShell does not hardcode a fake Claire SMS handoff", () => {
  assert.doesNotMatch(source, /\+18004448888/)
  assert.doesNotMatch(source, /CLAIRE_IMESSAGE_HREF/)
  assert.match(source, /buildClaireImessageHref/)
  assert.match(source, /claireHref/)
})

test("CandidateLogin sends first-time candidates into onboarding", () => {
  assert.doesNotMatch(source, /First time\?\s*<Link to="\/"/)
  assert.doesNotMatch(source, /First time\?\s*<Link/)
  assert.doesNotMatch(source, /firstTimeOnboardingHref/)
  assert.doesNotMatch(source, /onboardingBase/)
  assert.match(source, /fallback\s*=\s*isLayoffHost\(\)/)
  assert.match(source, /: onboardingDestination\(peekSource\(\)\)/)
  assert.match(source, /return parseLoginNextPath\(raw, fallback\)/)
  assert.match(source, /First time\? Continue here and Claire will start the same profile flow\./)
})

test("CandidateLogin preserves role interview context for first-time job candidates", () => {
  assert.match(source, /isPublicJobPath/)
  assert.match(source, /roleInterviewNext\s*=\s*isPublicJobPath\(nextDest\.pathname\)/)
  assert.doesNotMatch(source, /Start this role with Claire/)
  assert.match(source, /Role interview/)
  assert.match(source, /First time on this role\? Continue here and Claire will keep the role attached\./)
})

test("CandidateShell signed-in nav keeps candidates inside the operating home and market source surfaces", () => {
  assert.match(source, /\{ to: "\/me", icon: "pipeline", label: "Home" \}/)
  assert.match(source, /\{ to: "\/me\/matches", icon: "match", label: "Roles" \}/)
  assert.match(source, /\{ to: "\/market", icon: "market", label: "Market" \}/)
  assert.match(source, /\{ to: "\/me\/profile", icon: "profile", label: "Profile" \}/)
  assert.match(source, /\{ to: "\/me\/privacy", icon: "privacy", label: "Privacy" \}/)
  assert.match(source, /\{ to: "\/me\/refer", icon: "refer", label: "Refer · \$4k" \}/)
  assert.match(source, /if \(to === "\/market"\) return pathname === "\/market"/)
  assert.match(source, /if \(to === "\/me\/privacy"\) return pathname === "\/me\/privacy"/)
})

test("CandidateShell footer routes employers to the actual employer surface", () => {
  assert.match(source, /<Link to="\/employers">For employers<\/Link>/)
  assert.doesNotMatch(source, /href="https:\/\/wekruit\.com"[\s\S]*For employers/)
})

test("CandidateShell routes missing Claire-line states to a real profile action", () => {
  assert.doesNotMatch(source, /Claire line pending/)
  assert.doesNotMatch(source, /wk-sidenav__claire is-pending" aria-disabled="true"/)
  assert.match(
    source,
    /<Link to="\/me\/profile#profile-corrections" className="wk-apptopbar__claire is-pending" aria-label="Update profile">/,
  )
  assert.match(
    source,
    /<Link[\s\S]*to="\/me\/profile#profile-corrections"[\s\S]*className="wk-sidenav__claire is-pending"[\s\S]*Update profile[\s\S]*Add context for Claire/,
  )
})
