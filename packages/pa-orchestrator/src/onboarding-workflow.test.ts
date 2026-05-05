/**
 * iter33 P5 — onboarding workflow graph tests.
 */
import test from "node:test"
import assert from "node:assert/strict"
import {
  ONBOARDING_WORKFLOW,
  outgoingEdges,
  incomingEdges,
  topologicalStates,
  validateWorkflow,
} from "./onboarding-workflow.js"

test("ONBOARDING_WORKFLOW: validates clean (no orphan nodes, no dangling edges)", () => {
  const result = validateWorkflow(ONBOARDING_WORKFLOW)
  assert.equal(result.ok, true, `validation errors: ${result.errors.join(", ")}`)
})

test("ONBOARDING_WORKFLOW: entry is pending, terminal is complete", () => {
  assert.equal(ONBOARDING_WORKFLOW.entryState, "pending")
  assert.equal(ONBOARDING_WORKFLOW.terminalState, "complete")
})

test("ONBOARDING_WORKFLOW: includes iter33 P1 q_lang_asked node", () => {
  const node = ONBOARDING_WORKFLOW.nodes.find((n) => n.state === "q_lang_asked")
  assert.ok(node, "q_lang_asked node must exist")
  assert.equal(node!.kind, "question")
  assert.match(node!.origin, /iter33 P1/)
})

test("ONBOARDING_WORKFLOW: iter33 P3+P4 q_cv_analyzing node is action kind", () => {
  const node = ONBOARDING_WORKFLOW.nodes.find((n) => n.state === "q_cv_analyzing")
  assert.ok(node, "q_cv_analyzing node must exist")
  assert.equal(node!.kind, "action")
  assert.match(node!.origin, /iter33 P3\+P4/)
})

test("ONBOARDING_WORKFLOW: iter33 P2 reorder — verify_email_code lands on q_tos_asked", () => {
  const edges = outgoingEdges(ONBOARDING_WORKFLOW, "q_email_verifying")
  const verifyEdge = edges.find((e) => e.action === "verify_email_code")
  assert.ok(verifyEdge, "verify_email_code edge must exist from q_email_verifying")
  assert.equal(verifyEdge!.to, "q_tos_asked", "iter33 P2: verify success → q_tos_asked")
})

test("ONBOARDING_WORKFLOW: iter33 P2 reorder — q_tos_asked accept lands on q_role_asked", () => {
  const edges = outgoingEdges(ONBOARDING_WORKFLOW, "q_tos_asked")
  const acceptEdge = edges.find(
    (e) =>
      e.action === "ask_q_role" &&
      e.condition.kind === "parsedAnswer" &&
      e.condition.matches === "accept"
  )
  assert.ok(acceptEdge, "ToS accept edge must exist")
  assert.equal(acceptEdge!.to, "q_role_asked", "iter33 P2: accept → q_role_asked")
})

test("ONBOARDING_WORKFLOW: iter33 P1 — q_lang_asked → q_email_asked (skips ToS first)", () => {
  const edges = outgoingEdges(ONBOARDING_WORKFLOW, "q_lang_asked")
  assert.equal(edges.length, 2, "expected 2 edges from q_lang_asked (default + vent)")
  const defaultEdge = edges.find((e) => e.condition.kind === "default")
  assert.ok(defaultEdge, "default edge must exist")
  assert.equal(defaultEdge!.to, "q_email_asked")
})

test("ONBOARDING_WORKFLOW: iter33 P3+P4 — q_resume_asked + cvParsed external signal → q_cv_analyzing", () => {
  const edges = outgoingEdges(ONBOARDING_WORKFLOW, "q_resume_asked")
  const cvEdge = edges.find(
    (e) =>
      e.action === "send_cv_analysis" &&
      e.condition.kind === "externalSignal" &&
      e.condition.signal === "cvParsed"
  )
  assert.ok(cvEdge, "send_cv_analysis edge with cvParsed signal must exist")
  assert.equal(cvEdge!.to, "q_cv_analyzing")
})

test("ONBOARDING_WORKFLOW: q_cv_analyzing → complete (terminal transition)", () => {
  const edges = outgoingEdges(ONBOARDING_WORKFLOW, "q_cv_analyzing")
  const terminalEdge = edges.find((e) => e.to === "complete")
  assert.ok(terminalEdge, "q_cv_analyzing → complete edge must exist")
  assert.equal(terminalEdge!.action, "send_cv_analysis")
})

test("ONBOARDING_WORKFLOW: vent self-loop on probe nodes (parser-owned nodes excluded)", () => {
  // Vent self-loops on nodes where dispatcher's priorAskedStepFromState
  // returns a step. first_mes_sent (transitional, no user input expected),
  // q_email_asked + q_email_verifying (parser-owned — vent strings inside
  // an email body / code reply must not trigger detection), and the
  // action / terminal nodes are excluded by design.
  const ventNodes = [
    "q_lang_asked",
    "q_tos_asked",
    "q_role_asked",
    "q_yoe_asked",
    "q_visa_asked",
    "q_startup_pref_asked",
    "q_location_asked",
    "q_resume_asked",
  ]
  for (const state of ventNodes) {
    const edges = outgoingEdges(
      ONBOARDING_WORKFLOW,
      state as Parameters<typeof outgoingEdges>[1]
    )
    const ventEdge = edges.find((e) => e.condition.kind === "ventDetected")
    assert.ok(ventEdge, `${state} must have a vent self-loop edge`)
    assert.equal(ventEdge!.to, state, "vent edge must self-loop")
    assert.equal(ventEdge!.action, "vent_ack")
  }
})

test("ONBOARDING_WORKFLOW: topologicalStates includes all 13 states in order (iter33 spec collapse)", () => {
  // iter33 spec collapse 2026-05-05 — first_mes_sent removed from graph.
  // Backward-compat for persisted-state users is handled inline in
  // resolveDeterministicAction.
  const states = topologicalStates(ONBOARDING_WORKFLOW)
  assert.equal(states.length, 13)
  assert.equal(states[0], "pending")
  assert.equal(states[states.length - 1], "complete")
  // first_mes_sent is no longer a graph node
  assert.ok(!states.includes("first_mes_sent" as never))
  // pending → q_lang_asked is the new direct entry transition
  assert.ok(states.indexOf("pending") < states.indexOf("q_lang_asked"))
  // P1 lang state appears before email
  assert.ok(states.indexOf("q_lang_asked") < states.indexOf("q_email_asked"))
  // P2 reorder: email/verify before ToS
  assert.ok(states.indexOf("q_email_verifying") < states.indexOf("q_tos_asked"))
  // P2 reorder: ToS before role
  assert.ok(states.indexOf("q_tos_asked") < states.indexOf("q_role_asked"))
  // P3 cv_analyzing before complete
  assert.ok(states.indexOf("q_cv_analyzing") < states.indexOf("complete"))
})

test("ONBOARDING_WORKFLOW iter33 spec collapse: pending → q_lang_asked direct (no first_mes_sent)", () => {
  // Adam directive 2026-05-05: "reset 后发消息应该上来就是 onboard, 为什么
  // 还聊点啥". User's first iMessage → Claire's first outbound = q_lang Q
  // (which now opens with "在呢/Here" greeting in the prompt itself).
  const edges = outgoingEdges(ONBOARDING_WORKFLOW, "pending")
  assert.equal(edges.length, 1, "pending should have exactly one outgoing edge")
  assert.equal(edges[0].to, "q_lang_asked")
  assert.equal(edges[0].action, "ask_q_lang")
  assert.equal(edges[0].condition.kind, "default")
})

test("ONBOARDING_WORKFLOW: incoming + outgoing edges traverse the entire happy path", () => {
  const happyPath = [
    "pending",
    "q_lang_asked",
    "q_email_asked",
    "q_email_verifying",
    "q_tos_asked",
    "q_role_asked",
    "q_yoe_asked",
    "q_visa_asked",
    "q_startup_pref_asked",
    "q_location_asked",
    "q_resume_asked",
    "q_cv_analyzing",
    "complete",
  ] as const
  for (let i = 0; i < happyPath.length - 1; i++) {
    const from = happyPath[i]
    const to = happyPath[i + 1]
    const edges = outgoingEdges(ONBOARDING_WORKFLOW, from)
    const stepEdge = edges.find((e) => e.to === to)
    assert.ok(
      stepEdge,
      `happy-path edge ${from} → ${to} must exist`
    )
  }
})

test("ONBOARDING_WORKFLOW: validateWorkflow detects orphan node", () => {
  const broken = {
    ...ONBOARDING_WORKFLOW,
    nodes: [
      ...ONBOARDING_WORKFLOW.nodes,
      {
        state: "q_orphan" as never,
        kind: "question" as const,
        origin: "test",
        description: "no incoming edges",
      },
    ],
  }
  const result = validateWorkflow(broken)
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((e) => e.includes("q_orphan")))
})
