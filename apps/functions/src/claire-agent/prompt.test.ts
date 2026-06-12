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

// ── extractor-negation coverage (2026-06-09) ──────────────────────────────────
// Thin Claire NEVER runs the conversation extractor — capture happens ONLY when
// the LLM volunteers a set_matching_preferences call. So the PROMPT must teach
// the negation: "I am not looking for an internship" → avoidJobTypes:["internship"].
// Live victim: tags.targetJobType stayed ["internship"] (an EXACT-match hard
// filter) and only intern jobs ever matched.

test("PREFERENCES directive teaches the avoid/clear job-type negation with the internship example", () => {
  const head = buildClairePrompt({ mode: "triage", lang: "en" })
  assert.ok(head.includes("avoidJobTypes"), "avoidJobTypes field must be named")
  assert.ok(head.includes("clearTargetJobType"), "clearTargetJobType field must be named")
  assert.ok(
    /not looking for internships/i.test(head),
    "carries the canonical negation example",
  )
})

test("prescreen mode prompt instructs durable mid-screen preference capture via set_matching_preferences", () => {
  const prescreen = buildClairePrompt({ mode: "prescreen", lang: "en" })
  assert.ok(
    prescreen.includes("set_matching_preferences"),
    "prescreen FSM must allow durable preference capture mid-screen",
  )
  assert.ok(
    /answers to .* questions themselves are NOT preferences/i.test(prescreen),
    "must scope the rule: screen answers are not preferences",
  )
})

// ── 2026-06-10 trust audit (fix 2a + fix 7) — prompt hard rules ───────────────

test("DELIVERY carries the JOB-URL hard rule: never invent/alter URLs, omit when absent (fix 2a)", () => {
  const head = buildClairePrompt({ mode: "triage", lang: "en" })
  assert.ok(/JOB URLS ARE SACRED/.test(head), "the URL rule block is present")
  assert.ok(
    /NEVER invent, alter, shorten, or abbreviate a job URL/.test(head),
    "no inventing/altering URLs",
  )
  assert.ok(/omit the link line/i.test(head), "no URL → omit the link line entirely")
  assert.ok(head.includes("wekruit.com/j/1"), "names the live placeholder anti-example")
  // Present in EVERY mode (DELIVERY is part of the static head).
  for (const mode of ["onboarding", "prescreen"] as const) {
    assert.ok(/JOB URLS ARE SACRED/.test(buildClairePrompt({ mode, lang: "en" })))
  }
})

test("TRIAGE carries the never-re-ask rule for location/salary already on file (fix 7)", () => {
  const head = buildClairePrompt({ mode: "triage", lang: "en" })
  assert.ok(
    /if CONTEXT already shows targetLocations \(or any saved location\) or a salary \(minSalary\), NEVER/.test(head),
    "the hard never-re-ask rule is present",
  )
  assert.ok(
    /Acknowledge what's on file/.test(head),
    "instructs acknowledging instead of re-asking",
  )
})

// ── Adam 2026-06-12: prescreen ownership + state-accurate status copy ─────────────────────────────
test("prescreen mode locks SCREEN OWNERSHIP — no matching offers / find_match before terminal", () => {
  const prescreen = buildClairePrompt({ mode: "prescreen", lang: "en" })
  assert.ok(/SCREEN OWNERSHIP/.test(prescreen), "prescreen mode must carry the ownership rule")
  assert.ok(/MATCHING IS OFF WHILE THE SCREEN IS OPEN/.test(prescreen))
  assert.ok(/NEVER ask 'want me to pull roles\?'/.test(prescreen))
})

test("prescreen mode answers status questions from state — not yet / confirm role, never under review", () => {
  const prescreen = buildClairePrompt({ mode: "prescreen", lang: "en" })
  assert.ok(/STATUS QUESTIONS MID-SCREEN/.test(prescreen))
  assert.ok(/say NOT YET and continue with the pending/.test(prescreen))
  assert.ok(/NEVER say a still-open screen is 'under review' or submitted/.test(prescreen))
})

test("triage status copy covers timed_out/paused and bans the words 'human review'", () => {
  const triage = buildClairePrompt({ mode: "triage", lang: "en" })
  assert.ok(/STATUS = timed_out/.test(triage))
  assert.ok(/reply 'restart screen'/.test(triage))
  assert.ok(/do NOT pivot that answer into a matching offer/.test(triage))
  assert.ok(/STATUS = paused/.test(triage))
  assert.ok(/NEVER use the words 'human review'/.test(triage))
})
