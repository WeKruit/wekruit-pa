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
  assert.match(source, /First time\?\s*<Link to=\{onboardingDestination\(peekSource\(\)\)\}/)
})

test("CandidateShell signed-in nav keeps candidates inside the operating home surfaces", () => {
  assert.match(source, /\{ to: "\/me", icon: "pipeline", label: "Home" \}/)
  assert.match(source, /\{ to: "\/me\/matches", icon: "match", label: "Roles" \}/)
  assert.match(source, /\{ to: "\/me\/profile", icon: "profile", label: "Profile" \}/)
  assert.match(source, /\{ to: "\/me\/refer", icon: "refer", label: "Refer · \$4k" \}/)
  assert.doesNotMatch(source, /\{ to: "\/market", icon: "market", label: "Market" \}/)
})
