/**
 * prompt.test.ts — 2B byte-stable instructions for prompt caching.
 *
 * buildClairePrompt must be the STATIC head only: identical bytes regardless of the per-turn
 * dynamic inputs (canary / globalContext / prescreenContext / non-onboarding pendingStep), so the
 * provider can serve it from a cached prefix every turn. buildClaireTurnContext carries 100% of that
 * per-turn variance (re-injected as a trailing system item by agent.ts). These guards prove the head
 * is byte-stable and the dynamic block is information-preserving (nothing dropped, just repositioned).
 */
import { strict as assert } from "node:assert"
import { test } from "node:test"
import { buildClairePrompt, buildClaireTurnContext } from "./prompt.js"

test("buildClairePrompt head is byte-IDENTICAL regardless of per-turn dynamic inputs", () => {
  const bare = buildClairePrompt({ mode: "triage", lang: "en" })
  const UNIQUE_CONTEXT = "ZZZ_UNIQUE_GLOBAL_CONTEXT_MARKER"
  const withDynamics = buildClairePrompt({
    mode: "triage",
    lang: "en",
    canary: true,
    globalContext: UNIQUE_CONTEXT,
    prescreenContext: "ZZZ_UNIQUE_PRESCREEN_MARKER",
    pendingStep: "ZZZ_UNIQUE_PENDING_MARKER",
  })
  // The head must NOT change when dynamic fields are supplied — that is the cache invariant.
  assert.equal(bare, withDynamics)
  // And the dynamic content must NOT have leaked into the head.
  assert.ok(!bare.includes(UNIQUE_CONTEXT))
  assert.ok(!bare.includes("ZZZ_UNIQUE_PRESCREEN_MARKER"))
  assert.ok(!bare.includes("ZZZ_UNIQUE_PENDING_MARKER"))
  // The trailing "CONTEXT — " injection prefix is a turn-context concern, not in the head.
  assert.ok(!bare.includes("CONTEXT — "))
})

test("buildClairePrompt head does NOT carry the canary tapback block (moved to turn context)", () => {
  const head = buildClairePrompt({ mode: "triage", lang: "en", canary: true })
  assert.ok(!head.includes("TAPBACKS — react like a real person"))
})

test("buildClaireTurnContext carries the moved dynamic block (info-preserving)", () => {
  const ctx = buildClaireTurnContext({
    mode: "triage",
    lang: "en",
    canary: true,
    globalContext: "roles: software_engineering",
    pendingStep: "ask about salary",
  })
  assert.ok(ctx.includes("CONTEXT — roles: software_engineering"))
  assert.ok(ctx.includes("TAPBACKS — react like a real person"))
  assert.ok(ctx.includes("PENDING STEP to resume after any tangent: ask about salary."))
})

test("buildClaireTurnContext is empty when there is nothing dynamic this turn", () => {
  assert.equal(buildClaireTurnContext({ mode: "triage", lang: "en" }), "")
})

test("turn context surfaces prescreenContext ONLY in prescreen mode", () => {
  const inTriage = buildClaireTurnContext({
    mode: "triage",
    lang: "en",
    prescreenContext: "PRESCREEN CONTEXT: secret",
  })
  assert.ok(!inTriage.includes("PRESCREEN CONTEXT"))
  const inPrescreen = buildClaireTurnContext({
    mode: "prescreen",
    lang: "en",
    prescreenContext: "PRESCREEN CONTEXT: secret",
  })
  assert.ok(inPrescreen.includes("PRESCREEN CONTEXT: secret"))
})

test("turn context surfaces candidateContext in ANY mode (post-prescreen retention handoff)", () => {
  // Unlike prescreenContext (gated on mode==='prescreen'), the prescreen-seam retention block must reach
  // the prompt in triage/onboarding too — a post-terminal turn is NEVER 'prescreen' mode. This is the
  // load-bearing difference for the Sai fix: the agent must know the screen history regardless of mode.
  const block = "PRIOR JOB SCREENS (most recent first):\n- Product Designer @ Invoko — PAUSED."
  for (const mode of ["triage", "onboarding", "prescreen"] as const) {
    const ctx = buildClaireTurnContext({ mode, lang: "en", candidateContext: block })
    assert.ok(ctx.includes("PRIOR JOB SCREENS"), `candidateContext must render in ${mode} mode`)
  }
})

test("onboarding pendingStep stays in the head (mode shape), NOT the turn context", () => {
  // In onboarding the next question is part of the directive shape; the turn context must not
  // ALSO emit a 'PENDING STEP to resume' reminder (that is only for non-onboarding modes).
  const ctx = buildClaireTurnContext({ mode: "onboarding", lang: "en", pendingStep: "what's your target role?" })
  assert.ok(!ctx.includes("PENDING STEP to resume"))
})

test("grounding prose no longer references CONTEXT as positioned 'above'", () => {
  // After 2B the CONTEXT arrives as a trailing system message, so the onboarding compliment and
  // prescreen probe prose must not say it is 'above'. Guards the grounding-coupling fix.
  const onboarding = buildClairePrompt({ mode: "onboarding", lang: "en", awaitingAnswer: false })
  assert.ok(!onboarding.includes("work history (use THIS) "))
  assert.ok(onboarding.includes("CONTEXT provided"))
  const prescreen = buildClairePrompt({ mode: "prescreen", lang: "en" })
  assert.ok(!prescreen.includes("PRIOR prescreen sessions, above)"))
  assert.ok(prescreen.includes("PRESCREEN CONTEXT provided this turn"))
})
