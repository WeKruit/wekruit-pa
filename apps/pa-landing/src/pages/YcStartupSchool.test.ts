// @ts-nocheck - landing app typecheck only includes Vite/browser types; this file runs with node --test via tsx.
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import test from "node:test"

const here = dirname(fileURLToPath(import.meta.url))
const pageSource = readFileSync(resolve(here, "YcStartupSchool.tsx"), "utf8")
const mainSource = readFileSync(resolve(here, "../main.tsx"), "utf8")

test("/yc-startup route is registered on the wekruit.com bundle", () => {
  assert.match(mainSource, /path="\/yc-startup" element=\{<YcStartupSchool \/>\}/)
  // Candidate-facing route stays out of the layoff host allowlist — the
  // layoffRoutes block must NOT gain it (layoff is a standalone product).
  const layoffBlock = mainSource.slice(mainSource.indexOf("const layoffRoutes"), mainSource.indexOf("const fullRoutes"))
  assert.doesNotMatch(layoffBlock, /yc-startup/)
})

test("YC page funnels into the EXISTING onboarding flow with yc attribution", () => {
  assert.match(pageSource, /\/onboarding\?source=\$\{YC_SOURCE\}/)
  assert.match(pageSource, /"yc_startup_school"/)
  assert.match(pageSource, /stickExplicitSource\(YC_SOURCE\)/)
  // Reuse mandate: founder cards ride the shared cached pa-jobs raw query, no
  // bespoke Firestore read.
  assert.match(pageSource, /PUBLIC_PA_JOBS_RAW_QUERY_KEY/)
  assert.match(pageSource, /fetchPublicPaJobsRaw/)
})

test("YC page fabricates no proof, scarcity, or YC affiliation", () => {
  assert.doesNotMatch(pageSource, /hand-select/i)
  assert.doesNotMatch(pageSource, /official/i)
  assert.doesNotMatch(pageSource, /days to launch/i)
  assert.doesNotMatch(pageSource, /seats? (fill|left|remaining)/i)
  assert.match(pageSource, /NOT AFFILIATED WITH Y COMBINATOR/)
  // Honest empty state — no invented startup counts.
  assert.match(pageSource, /No public roles are open right now/)
})
