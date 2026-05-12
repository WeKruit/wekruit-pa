/**
 * v1.8 Phase 76 — voice-mode injection tests.
 */
import test from "node:test"
import assert from "node:assert/strict"

import {
  ALL_VOICE_MODES,
  assertProfessionalModeMarker,
  getVoiceModePrefix,
  injectVoiceModePrefix,
} from "../voice-mode.js"

test("Phase 76: casual_onboarding returns empty prefix (preserves prefix-cache)", () => {
  assert.equal(getVoiceModePrefix("casual_onboarding", "zh"), "")
  assert.equal(getVoiceModePrefix("casual_onboarding", "en"), "")
})

test("Phase 76: professional_prescreen zh prefix includes register rules", () => {
  const p = getVoiceModePrefix("professional_prescreen", "zh")
  assert.ok(p.includes("[VOICE MODE: PROFESSIONAL PRE-SCREENING]"))
  assert.ok(p.includes("Claire"))
  assert.ok(p.includes("WeKruit"))
  assert.ok(p.includes("禁用表情符号"))
})

test("Phase 76: professional_prescreen en prefix includes register rules", () => {
  const p = getVoiceModePrefix("professional_prescreen", "en")
  assert.ok(p.includes("[VOICE MODE: PROFESSIONAL PRE-SCREENING]"))
  assert.ok(p.includes("No emoji"))
  assert.ok(p.includes("Could you describe"))
})

test("Phase 76: injectVoiceModePrefix returns original on casual (no cache busting)", () => {
  const orig = "You are Claire."
  const out = injectVoiceModePrefix(orig, "casual_onboarding", "zh")
  assert.equal(out, orig)
})

test("Phase 76: injectVoiceModePrefix prepends professional prefix", () => {
  const orig = "You are Claire."
  const out = injectVoiceModePrefix(orig, "professional_prescreen", "en")
  assert.ok(out.startsWith("[VOICE MODE: PROFESSIONAL PRE-SCREENING]"))
  assert.ok(out.endsWith("You are Claire."))
  // newline separator preserved
  assert.ok(out.includes("\n\nYou are Claire."))
})

test("Phase 76: assertProfessionalModeMarker detects rendered prompt", () => {
  const rendered = injectVoiceModePrefix("system stuff", "professional_prescreen", "en")
  assert.equal(assertProfessionalModeMarker(rendered), true)
  assert.equal(assertProfessionalModeMarker("just system stuff"), false)
})

test("Phase 76: ALL_VOICE_MODES enumerates exactly two modes", () => {
  assert.equal(ALL_VOICE_MODES.length, 2)
  assert.deepEqual(ALL_VOICE_MODES, ["casual_onboarding", "professional_prescreen"])
})
