/**
 * Phase 37 T3 — prompt-directive serialization tests.
 */
import assert from "node:assert/strict"
import test from "node:test"

import {
  STAGE_GLOSS_EN,
  STAGE_GLOSS_ZH,
  buildFsmDirective,
} from "./prompt-directive.js"

test("buildFsmDirective — basic shape contains all 6 lines", () => {
  const out = buildFsmDirective({
    uxState: "SoftConcerned",
    stage: "Comforting",
    allowedStrategies: ["Reflection", "Affirmation", "SelfDisclosure"],
    preferredNext: "Reflection",
  })
  assert.match(out, /^\[FSM-DIRECTIVE\]/)
  assert.match(out, /\[\/FSM-DIRECTIVE\]$/)
  assert.match(out, /current_ux_state: SoftConcerned/)
  assert.match(out, /current_stage: Comforting/)
  assert.match(out, /allowed_strategies: Reflection, Affirmation, SelfDisclosure/)
  assert.match(out, /preferred_next: Reflection/)
  assert.match(out, /note: /)
})

test("buildFsmDirective — gloss is English even when legacy zh lang passed", () => {
  const out = buildFsmDirective(
    {
      uxState: "QuietWitness",
      stage: "Action",
      allowedStrategies: ["Reflection", "Affirmation"],
      preferredNext: "Reflection",
    },
    { userLang: "zh" }
  )
  // Product is English-only — output must never contain Chinese.
  assert.ok(!/[一-鿿]/.test(out), `did not expect zh chars in: ${out}`)
})

test("buildFsmDirective — bilingual gloss en (default)", () => {
  const out = buildFsmDirective({
    uxState: "WarmCurious",
    stage: "Exploration",
    allowedStrategies: ["Question", "Restatement", "Reflection"],
    preferredNext: "Question",
  })
  // en gloss uses ASCII
  assert.ok(!/[一-鿿]/.test(out), `did not expect zh chars in: ${out}`)
})

test("buildFsmDirective — empty allowed-set falls back to Other", () => {
  const out = buildFsmDirective({
    uxState: "QuietWitness",
    stage: "Action",
    allowedStrategies: [],
    preferredNext: "Other",
  })
  assert.match(out, /allowed_strategies: Other/)
})

test("buildFsmDirective — accepts ReadonlySet for allowedStrategies", () => {
  const set = new Set(["Reflection", "Affirmation"] as const)
  const out = buildFsmDirective({
    uxState: "SoftConcerned",
    stage: "Comforting",
    allowedStrategies: set,
    preferredNext: "Reflection",
  })
  assert.match(out, /allowed_strategies: Reflection, Affirmation/)
})

test("STAGE_GLOSS_EN — every (uxState × stage) has gloss", () => {
  for (const ux of [
    "WarmCurious",
    "PlayfulTease",
    "SoftConcerned",
    "FirmDirect",
    "QuietWitness",
  ] as const) {
    for (const st of ["Exploration", "Comforting", "Action"] as const) {
      const g = STAGE_GLOSS_EN[ux][st]
      assert.ok(typeof g === "string" && g.length > 0, `missing en gloss ${ux}/${st}`)
    }
  }
})

test("STAGE_GLOSS_ZH — legacy alias still has a gloss for every (uxState × stage)", () => {
  for (const ux of [
    "WarmCurious",
    "PlayfulTease",
    "SoftConcerned",
    "FirmDirect",
    "QuietWitness",
  ] as const) {
    for (const st of ["Exploration", "Comforting", "Action"] as const) {
      const g = STAGE_GLOSS_ZH[ux][st]
      assert.ok(typeof g === "string" && g.length > 0, `missing gloss ${ux}/${st}`)
      // Product is English-only — the legacy alias resolves to English glosses.
      assert.ok(!/[一-鿿]/.test(g), `gloss should be English: ${g}`)
    }
  }
})

test("buildFsmDirective — QuietWitness gloss EXPLICITLY warns NO advice", () => {
  const out = buildFsmDirective(
    {
      uxState: "QuietWitness",
      stage: "Action",
      allowedStrategies: ["Reflection", "Affirmation"],
      preferredNext: "Reflection",
    },
    { userLang: "en" }
  )
  // en gloss for QuietWitness/Action should reference "NEVER suggest action"
  assert.match(out, /NEVER suggest action/)
})
