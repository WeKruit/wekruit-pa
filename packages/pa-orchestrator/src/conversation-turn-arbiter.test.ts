import assert from "node:assert/strict"
import test from "node:test"

import {
  decideConversationTurnOwner,
  isSavedPreferenceSummaryQuestion,
  summarizeConversationTurnTrace,
  type TurnContext,
} from "./conversation-turn-arbiter.js"
import {
  TURN_INTENT_VOCAB,
  type TurnIntentLabel,
  type TurnIntentResult,
} from "./turn-intent-extractor.js"

/**
 * Build a validated-looking `TurnIntentResult` with the named labels present at
 * high confidence and everything else absent. Mirrors what
 * `validateTurnIntentResult` produces, so arbiter tests can drive the LLM path
 * without a live model.
 */
function llmIntent(
  present: Partial<Record<TurnIntentLabel, number>>,
  extra: Partial<Pick<TurnIntentResult, "preferencePolarity" | "evidence">> = {},
): TurnIntentResult {
  const labels = {} as TurnIntentResult["labels"]
  for (const label of TURN_INTENT_VOCAB) {
    const conf = present[label]
    labels[label] = conf !== undefined ? { present: true, confidence: conf } : { present: false, confidence: 0 }
  }
  return {
    available: true,
    labels,
    evidence: extra.evidence ?? "",
    ...(extra.preferencePolarity ? { preferencePolarity: extra.preferencePolarity } : {}),
  }
}

function baseContext(overrides: Partial<TurnContext> = {}): TurnContext {
  return {
    turnId: "turn-1",
    userId: "u1",
    inbound: {
      text: "hi",
      createdAt: "2026-05-26T22:39:04.000Z",
      channel: "imessage",
    },
    recentMessages: [],
    recentOutbound: [],
    ...overrides,
  }
}

test("arbiter routes Rain fit-improvement question to prescreen outcome explainer instead of shared onboarding", () => {
  const decision = decideConversationTurnOwner(baseContext({
    inbound: {
      text: "Could you help me understand how I could have improved my fit for the above role at Rain?",
      createdAt: "2026-05-26T22:39:04.000Z",
      channel: "imessage",
    },
    sharedOnboarding: {
      active: true,
      currentQuestionId: "industry_interest",
    },
    prescreenEvidence: {
      sessionId: "ps-rain",
      jobId: "rain-product-manager-cards-95ae1a01",
      terminal: "PAUSE",
      summary:
        "Strong PM role fit: end-to-end ownership, integrations, and 3X lead lift. Mentions technical data-flow design and failure handling; lacks concrete implementation depth.",
      evidenceTags: ["product_management", "technical_depth_gap"],
    },
  }))

  assert.equal(decision.selectedOwner, "prescreen_outcome_explainer")
  assert.equal(decision.intentFrames[0]?.intent, "prescreen_outcome_question")
  assert.ok(decision.requiredTools.includes("load_prescreen_evidence"))
  assert.ok(decision.forbiddenMutations.includes("sharedOnboarding.answers.industry_interest"))
  assert.ok(
    decision.rejectedOwners.some((owner) =>
      owner.owner === "shared_onboarding" && /not an answer/i.test(owner.reason)
    ),
  )
})

test("arbiter treats negative role feedback as durable preference before matching", () => {
  const decision = decideConversationTurnOwner(baseContext({
    inbound: {
      text: "Not software developer roles. Product and strategy only, please.",
      createdAt: "2026-05-26T23:01:00.000Z",
      channel: "imessage",
    },
    recentOutbound: [{ role: "assistant", body: "I found two software developer roles.", createdAt: "2026-05-26T23:00:00.000Z" }],
  }))

  assert.equal(decision.selectedOwner, "durable_preference_update")
  assert.equal(decision.intentFrames[0]?.scope, "durable")
  assert.ok(decision.requiredTools.includes("semantic_preference_extraction"))
  assert.deepEqual(decision.orderedActions.map((action) => action.kind), [
    "extract_durable_preferences",
    "commit_memory",
  ])
})

test("arbiter keeps active prescreen answers in the active workflow", () => {
  const decision = decideConversationTurnOwner(baseContext({
    inbound: {
      text: "I designed the CRM sync schema and added retry jobs for failed writes.",
      createdAt: "2026-05-26T22:37:00.000Z",
      channel: "imessage",
    },
    activeWorkflow: {
      kind: "job_prescreen",
      status: "active",
      currentQuestionId: "technical_depth",
    },
  }))

  assert.equal(decision.selectedOwner, "active_workflow")
  assert.equal(decision.intentFrames[0]?.intent, "active_workflow_answer")
  assert.ok(decision.requiredTools.includes("prescreen_turn_handler"))
})

test("arbiter blocks ambiguous shared-onboarding non-answers from advancing the active slot", () => {
  const decision = decideConversationTurnOwner(baseContext({
    inbound: {
      text: "I am not sure what you mean by that.",
      createdAt: "2026-05-26T23:05:00.000Z",
      channel: "imessage",
    },
    sharedOnboarding: {
      active: true,
      currentQuestionId: "location_relocation",
    },
  }))

  assert.equal(decision.selectedOwner, "shared_onboarding")
  assert.ok(decision.forbiddenMutations.includes("sharedOnboarding.answers.location_relocation"))
  assert.deepEqual(decision.orderedActions.map((action) => action.kind), ["clarify_shared_onboarding"])
  assert.ok(
    decision.rejectedOwners.some((owner) =>
      owner.owner === "shared_onboarding" && /not an answer/i.test(owner.reason)
    ),
  )
})

test("arbiter accepts concrete shared-onboarding role and special-context answers", () => {
  const mainGoal = decideConversationTurnOwner(baseContext({
    inbound: {
      text: "Software engineering, ideally backend or platform.",
      createdAt: "2026-05-26T23:06:00.000Z",
      channel: "imessage",
    },
    sharedOnboarding: {
      active: true,
      currentQuestionId: "main_goal",
    },
  }))
  const specialContext = decideConversationTurnOwner(baseContext({
    inbound: {
      text: "I need to move fast because severance ends soon, and backend systems are my strongest area.",
      createdAt: "2026-05-26T23:07:00.000Z",
      channel: "imessage",
    },
    sharedOnboarding: {
      active: true,
      currentQuestionId: "special_context",
    },
  }))

  assert.equal(mainGoal.selectedOwner, "shared_onboarding")
  assert.ok(mainGoal.requiredTools.includes("shared_onboarding_writer"))
  assert.equal(specialContext.selectedOwner, "shared_onboarding")
  assert.ok(specialContext.requiredTools.includes("shared_onboarding_writer"))
})

test("arbiter keeps shared-onboarding Q5 answers ahead of durable preference wording", () => {
  const decision = decideConversationTurnOwner(baseContext({
    inbound: {
      text: "No hard constraints. I can start in 2-4 weeks; prefer product-heavy roles.",
      createdAt: "2026-05-27T21:29:48.559Z",
      channel: "imessage",
    },
    sharedOnboarding: {
      active: true,
      currentQuestionId: "special_context",
    },
  }))

  assert.equal(decision.selectedOwner, "shared_onboarding")
  assert.deepEqual(decision.orderedActions.map((action) => action.kind), [
    "write_shared_onboarding_answer",
    "extract_durable_preferences",
    "commit_memory",
  ])
  assert.ok(decision.requiredTools.includes("shared_onboarding_writer"))
})

test("arbiter orders multi-intent prescreen explanation before durable preference commit", () => {
  const decision = decideConversationTurnOwner(baseContext({
    inbound: {
      text: "Why was Rain paused, and please stop sending software developer roles; product strategy only.",
      createdAt: "2026-05-26T23:08:00.000Z",
      channel: "imessage",
    },
    sharedOnboarding: {
      active: true,
      currentQuestionId: "industry_interest",
    },
    prescreenEvidence: {
      sessionId: "ps-rain",
      jobId: "rain-product-manager-cards-95ae1a01",
      terminal: "PAUSE",
      summary: "Good product evidence; technical implementation depth was still thin.",
      evidenceTags: ["technical_depth_gap"],
    },
  }))

  assert.equal(decision.selectedOwner, "prescreen_outcome_explainer")
  assert.deepEqual(decision.orderedActions.map((action) => action.kind), [
    "answer_prescreen_outcome",
    "extract_durable_preferences",
    "commit_memory",
  ])
})

test("arbiter keeps explicit recommendation questions ahead of durable preference commit", () => {
  const decision = decideConversationTurnOwner(baseContext({
    inbound: {
      text: "Why did you recommend the Constant Contact co-op? I prefer early-stage fullstack roles over internships.",
      createdAt: "2026-05-26T23:08:30.000Z",
      channel: "imessage",
    },
    recentOutbound: [
      {
        role: "assistant",
        body: "One role worth checking: Constant Contact co-op.",
        createdAt: "2026-05-26T23:08:00.000Z",
      },
    ],
  }))

  assert.equal(decision.selectedOwner, "explicit_explanation")
  assert.deepEqual(decision.orderedActions.map((action) => action.kind), [
    "fallback_reply",
    "extract_durable_preferences",
    "commit_memory",
  ])
})

test("saved-preference summary detector catches saved-for-matching wording without explicit preference keyword", () => {
  assert.equal(
    isSavedPreferenceSummaryQuestion("What do you have saved for matching right now?"),
    true,
  )
})

test("arbiter routes system-control sentinels to safety_control so they never get a tapback", () => {
  for (const sentinel of ["__PA_RESET__", "__PA_FIND_MATCH__"]) {
    const decision = decideConversationTurnOwner(baseContext({
      inbound: {
        text: sentinel,
        createdAt: "2026-05-27T22:39:04.000Z",
        channel: "imessage",
      },
    }))

    assert.equal(decision.selectedOwner, "safety_control", `${sentinel} should route to safety_control`)
    assert.equal(decision.intentFrames[0]?.intent, "safety_control")
    assert.deepEqual(decision.orderedActions.map((action) => action.kind), ["safety_control"])
  }
})

test("arbiter trace records the state machine and selected owner", () => {
  const decision = decideConversationTurnOwner(baseContext({
    inbound: {
      text: "Fintech and AI infrastructure.",
      createdAt: "2026-05-26T23:09:00.000Z",
      channel: "imessage",
    },
    sharedOnboarding: {
      active: true,
      currentQuestionId: "industry_interest",
    },
  }))
  const trace = summarizeConversationTurnTrace(baseContext(), decision)

  assert.equal(decision.selectedOwner, "shared_onboarding")
  assert.deepEqual(trace.states, [
    "received",
    "context_loaded",
    "intent_framed",
    "owner_arbitrated",
    "action_planned",
    "tools_executed",
    "memory_committed",
    "outbound_composed",
    "completed",
  ])
  assert.equal(trace.decision.selectedOwner, "shared_onboarding")
})

// ──────────────────────────────────────────────────────────────────────────
// Target A — regex→LLM-intent migration. The LLM supplies MEANING labels; the
// deterministic cascade + STATE guards still own routing. These tests drive the
// LLM path by injecting a validated `llmIntent` into the context.
// ──────────────────────────────────────────────────────────────────────────

test("LLM path: job_search_request label routes to job_search owner", () => {
  const decision = decideConversationTurnOwner(baseContext({
    inbound: { text: "got anything new for me", channel: "imessage" },
    llmIntent: llmIntent({ job_search_request: 0.9 }),
  }))

  assert.equal(decision.selectedOwner, "job_search")
  assert.equal(decision.intentFrames[0]?.intent, "job_search_request")
  assert.ok(decision.requiredTools.includes("generate_job_recommendations"))
})

test("LLM path: durable_preference_update + job_search_request co-occurrence orders memory before search", () => {
  const decision = decideConversationTurnOwner(baseContext({
    inbound: { text: "stop the SWE stuff, I want product roles — and find me some", channel: "imessage" },
    llmIntent: llmIntent(
      { durable_preference_update: 0.88, job_search_request: 0.81 },
      { preferencePolarity: "negative" },
    ),
  }))

  assert.equal(decision.selectedOwner, "durable_preference_update")
  assert.deepEqual(decision.orderedActions.map((a) => a.kind), [
    "extract_durable_preferences",
    "commit_memory",
    "run_job_search",
  ])
  assert.ok(decision.requiredTools.includes("semantic_preference_extraction"))
  assert.ok(decision.requiredTools.includes("generate_job_recommendations"))
})

test("LLM path: meta_question label routes to explicit_explanation", () => {
  const decision = decideConversationTurnOwner(baseContext({
    inbound: { text: "remind me what you have on file for me", channel: "imessage" },
    llmIntent: llmIntent({ meta_question: 0.8, saved_preference_recall: 0.83 }),
  }))

  assert.equal(decision.selectedOwner, "explicit_explanation")
  assert.equal(decision.intentFrames[0]?.intent, "explicit_meta_question")
})

test("LLM path: prescreen_outcome_question still requires prescreenEvidence STATE guard", () => {
  // LLM says outcome question, but NO evidence on record → must NOT route to the
  // prescreen explainer; falls through to the meta-question explanation owner.
  const noEvidence = decideConversationTurnOwner(baseContext({
    inbound: { text: "how could I have done better on that one", channel: "imessage" },
    llmIntent: llmIntent({ prescreen_outcome_question: 0.9, meta_question: 0.7 }),
  }))
  assert.equal(noEvidence.selectedOwner, "explicit_explanation")
  assert.ok(noEvidence.intentFrames.every((f) => f.intent !== "prescreen_outcome_question"))

  // Same labels WITH evidence → routes to the prescreen explainer.
  const withEvidence = decideConversationTurnOwner(baseContext({
    inbound: { text: "how could I have done better on that one", channel: "imessage" },
    llmIntent: llmIntent({ prescreen_outcome_question: 0.9, meta_question: 0.7 }),
    prescreenEvidence: {
      sessionId: "ps-1",
      jobId: "rain-pm",
      terminal: "PAUSE",
      summary: "Strong PM signals; technical depth thin.",
      evidenceTags: ["technical_depth_gap"],
    },
  }))
  assert.equal(withEvidence.selectedOwner, "prescreen_outcome_explainer")
  assert.equal(withEvidence.intentFrames[0]?.intent, "prescreen_outcome_question")
  assert.ok(withEvidence.requiredTools.includes("load_prescreen_evidence"))
})

test("LLM path: low-confidence label (<0.6) is ignored → falls back to fallback_claire", () => {
  const decision = decideConversationTurnOwner(baseContext({
    inbound: { text: "hmm", channel: "imessage" },
    llmIntent: llmIntent({ job_search_request: 0.4 }),
  }))
  assert.equal(decision.selectedOwner, "fallback_claire")
})

test("LLM path A8: shared-onboarding answer routing keyed on injected judge boolean, no keyword bank", () => {
  // A reply that the regex slot-answer bank would REJECT for industry_interest,
  // but the LLM judge accepts → must route to shared_onboarding and write.
  const accepted = decideConversationTurnOwner(baseContext({
    inbound: { text: "the climate-tech and ocean space, honestly", channel: "imessage" },
    sharedOnboarding: { active: true, currentQuestionId: "industry_interest" },
    sharedOnboardingAnswerAccepted: true,
    llmIntent: llmIntent({}),
  }))
  assert.equal(accepted.selectedOwner, "shared_onboarding")
  assert.ok(accepted.requiredTools.includes("shared_onboarding_writer"))
  assert.deepEqual(accepted.orderedActions.map((a) => a.kind), ["write_shared_onboarding_answer"])

  // Same text but the judge REJECTS it → slot is suppressed and the active slot
  // re-asks (clarification), proving the keyword bank is NOT consulted.
  const rejected = decideConversationTurnOwner(baseContext({
    inbound: { text: "the climate-tech and ocean space, honestly", channel: "imessage" },
    sharedOnboarding: { active: true, currentQuestionId: "industry_interest" },
    sharedOnboardingAnswerAccepted: false,
    llmIntent: llmIntent({ confusion: 0.7 }),
  }))
  assert.equal(rejected.selectedOwner, "shared_onboarding")
  assert.ok(rejected.forbiddenMutations.includes("sharedOnboarding.answers.industry_interest"))
  assert.deepEqual(rejected.orderedActions.map((a) => a.kind), ["clarify_shared_onboarding"])
})

test("LLM path: SAFETY/marker regexes still fire under the LLM branch", () => {
  // The LLM is told NOT to classify control/privacy; the kept regex must still
  // route a system-control sentinel to safety_control even with llmIntent set.
  const decision = decideConversationTurnOwner(baseContext({
    inbound: { text: "__PA_RESET__", channel: "imessage" },
    llmIntent: llmIntent({}),
  }))
  assert.equal(decision.selectedOwner, "safety_control")
  assert.deepEqual(decision.orderedActions.map((a) => a.kind), ["safety_control"])
})

test("fail-open: unavailable LLM intent reproduces the regex-path owner (parity)", () => {
  // The negative-role-feedback case from the regex suite, but with an
  // UNAVAILABLE sentinel attached. Must produce the identical decision as the
  // pure-regex path (off-flag / LLM-down behavior == today).
  const inbound = {
    text: "Not software developer roles. Product and strategy only, please.",
    createdAt: "2026-05-26T23:01:00.000Z",
    channel: "imessage",
  }
  const recentOutbound = [{ role: "assistant" as const, body: "I found two software developer roles.", createdAt: "2026-05-26T23:00:00.000Z" }]

  const regexPath = decideConversationTurnOwner(baseContext({ inbound, recentOutbound }))
  const unavailable: TurnIntentResult = {
    available: false,
    labels: llmIntent({}).labels,
    evidence: "",
  }
  const failOpen = decideConversationTurnOwner(baseContext({ inbound, recentOutbound, llmIntent: unavailable }))

  assert.equal(failOpen.selectedOwner, regexPath.selectedOwner)
  assert.deepEqual(
    failOpen.orderedActions.map((a) => a.kind),
    regexPath.orderedActions.map((a) => a.kind),
  )
  assert.equal(failOpen.selectedOwner, "durable_preference_update")
})

test("off-flag: no llmIntent on context keeps the deterministic regex path", () => {
  // The job-search regex case with NO llmIntent — proves the default (non-canary)
  // path is unchanged.
  const decision = decideConversationTurnOwner(baseContext({
    inbound: { text: "find me some remote backend roles", channel: "imessage" },
  }))
  assert.equal(decision.selectedOwner, "job_search")
  assert.equal(decision.intentFrames[0]?.intent, "job_search_request")
})
