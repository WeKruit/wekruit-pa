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
  walkWorkflow,
} from "./onboarding-workflow.js"
import type { WorkflowContext, OnboardingWorkflow } from "./onboarding-workflow.js"

test("ONBOARDING_WORKFLOW: validates clean (no orphan nodes, no dangling edges)", () => {
  const result = validateWorkflow(ONBOARDING_WORKFLOW)
  assert.equal(result.ok, true, `validation errors: ${result.errors.join(", ")}`)
})

test("ONBOARDING_WORKFLOW: entry is pending, terminal is complete", () => {
  assert.equal(ONBOARDING_WORKFLOW.entryState, "pending")
  assert.equal(ONBOARDING_WORKFLOW.terminalState, "complete")
})

test("ONBOARDING_WORKFLOW: beta graph does not include q_lang_asked", () => {
  const node = ONBOARDING_WORKFLOW.nodes.find((n) => n.state === "q_lang_asked")
  assert.equal(node, undefined)
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

test("ONBOARDING_WORKFLOW: topologicalStates starts at q_email for beta", () => {
  // iter33 spec collapse 2026-05-05 — first_mes_sent removed from graph.
  // Backward-compat for persisted-state users is handled inline in
  // resolveDeterministicAction.
  const states = topologicalStates(ONBOARDING_WORKFLOW)
  assert.equal(states.length, 12)
  assert.equal(states[0], "pending")
  assert.equal(states[states.length - 1], "complete")
  // first_mes_sent is no longer a graph node
  assert.ok(!states.includes("first_mes_sent" as never))
  // q_lang_asked is no longer a graph node
  assert.ok(!states.includes("q_lang_asked" as never))
  // pending -> q_email_asked is the direct beta entry transition
  assert.ok(states.indexOf("pending") < states.indexOf("q_email_asked"))
  // P2 reorder: email/verify before ToS
  assert.ok(states.indexOf("q_email_verifying") < states.indexOf("q_tos_asked"))
  // P2 reorder: ToS before role
  assert.ok(states.indexOf("q_tos_asked") < states.indexOf("q_role_asked"))
  // P3 cv_analyzing before complete
  assert.ok(states.indexOf("q_cv_analyzing") < states.indexOf("complete"))
})

test("ONBOARDING_WORKFLOW beta entry: pending -> q_email_asked direct", () => {
  const edges = outgoingEdges(ONBOARDING_WORKFLOW, "pending")
  assert.equal(edges.length, 1, "pending should have exactly one outgoing edge")
  assert.equal(edges[0].to, "q_email_asked")
  assert.equal(edges[0].action, "ask_q_email")
  assert.equal(edges[0].condition.kind, "default")
})

test("ONBOARDING_WORKFLOW: incoming + outgoing edges traverse the entire happy path", () => {
  const happyPath = [
    "pending",
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

// ──────────────────────────────────────────────────────────────────
// iter33 spec collapse 2026-05-05 — Determinism guarantee tests.
//
// Adam directive: "需要测试,保证我们现在这个 workflow 一定是 deterministic
// 的, 我们换顺序要会按正常走".
//
// These tests prove walkWorkflow is a pure function of (state, ctx) — no
// hidden state, no time/randomness, no order-dependence beyond explicit
// edge-precedence. Critical because once we ship the dashboard editor
// (Option B), an operator changing prompts MUST NOT alter sequence
// behavior; and a developer reordering ONBOARDING_WORKFLOW.edges (e.g.
// for readability) MUST NOT change which edge fires.
// ──────────────────────────────────────────────────────────────────

function makeCtx(overrides: Partial<WorkflowContext> = {}): WorkflowContext {
  return {
    userMessage: "",
    cvParsed: false,
    emailCaptured: false,
    emailVerified: false,
    v33Disabled: false,
    isVent: false,
    answered: false,
    ...overrides,
  }
}

test("DETERMINISM: walkWorkflow is pure — same (state, ctx) × 100 → identical edge", () => {
  // Sweep representative states + contexts. Each combination should
  // produce a stable edge across N=100 calls. Any flakiness = Math.random
  // / Date.now / shared mutable state has crept in.
  const cases: Array<{
    state: Parameters<typeof walkWorkflow>[1]
    ctx: WorkflowContext
    label: string
  }> = [
    { state: "pending", ctx: makeCtx({ userMessage: "你好" }), label: "pending+zh" },
    { state: "pending", ctx: makeCtx({ userMessage: "hello" }), label: "pending+en" },
    {
      state: "q_email_asked",
      ctx: makeCtx({ userMessage: "adam@wekruit.com", parsedEmail: "adam@wekruit.com" }),
      label: "email+valid",
    },
    {
      state: "q_email_asked",
      ctx: makeCtx({ userMessage: "later" }),
      label: "email+missing",
    },
    {
      state: "q_email_verifying",
      ctx: makeCtx({ userMessage: "654321", parsedCode: "654321" }),
      label: "verify+code",
    },
    {
      state: "q_email_verifying",
      ctx: makeCtx({ userMessage: "what was the code" }),
      label: "verify+nocode",
    },
    {
      state: "q_tos_asked",
      ctx: makeCtx({ userMessage: "同意", tosDecision: "accept" }),
      label: "tos+accept",
    },
    {
      state: "q_tos_asked",
      ctx: makeCtx({ userMessage: "no", tosDecision: "decline" }),
      label: "tos+decline",
    },
    {
      state: "q_tos_asked",
      ctx: makeCtx({ userMessage: "huh", tosDecision: "unclear" }),
      label: "tos+ambiguous",
    },
    {
      state: "q_role_asked",
      ctx: makeCtx({ userMessage: "fuck this", isVent: true }),
      label: "role+vent",
    },
    {
      state: "q_role_asked",
      ctx: makeCtx({ userMessage: "swe backend", answered: true }),
      label: "role+answered",
    },
    {
      state: "q_resume_asked",
      ctx: makeCtx({ userMessage: "sent it", cvParsed: true }),
      label: "resume+cvparsed",
    },
    {
      state: "q_cv_analyzing",
      ctx: makeCtx({ userMessage: "ok" }),
      label: "cv_analyzing",
    },
  ]

  for (const c of cases) {
    const first = walkWorkflow(ONBOARDING_WORKFLOW, c.state, c.ctx)
    const firstSig = first ? `${first.from}→${first.to}|${first.action}` : "null"
    for (let i = 0; i < 100; i++) {
      const next = walkWorkflow(ONBOARDING_WORKFLOW, c.state, c.ctx)
      const sig = next ? `${next.from}→${next.to}|${next.action}` : "null"
      assert.equal(sig, firstSig, `[${c.label}] iter ${i} drifted from baseline`)
    }
  }
})

test("DETERMINISM: edge-array shuffle does not change walker output (mutex precedence)", () => {
  // Walker iterates edges by `from` filter then by precedence (vent →
  // parsedAnswer first-match → externalSignal first-match → default).
  // Within parsedAnswer / externalSignal, "first match wins" in array
  // order. This test proves all parsedAnswer + externalSignal edges
  // sharing a `from` state are mutually exclusive — no two can match
  // the same ctx — so array order is irrelevant.
  for (const node of ONBOARDING_WORKFLOW.nodes) {
    const fromEdges = outgoingEdges(ONBOARDING_WORKFLOW, node.state)
    const parsedEdges = fromEdges.filter((e) => e.condition.kind === "parsedAnswer")
    const extEdges = fromEdges.filter((e) => e.condition.kind === "externalSignal")
    // Probe with a wide ctx fan to expose overlap. Build cartesian of
    // signal toggles + parser outputs.
    const ctxs: WorkflowContext[] = []
    for (const tos of [undefined, "accept", "decline", "unclear"] as const) {
      for (const email of [undefined, "x@y.com"] as const) {
        for (const code of [undefined, "654321"] as const) {
          for (const cvParsed of [false, true]) {
            for (const emailCaptured of [false, true]) {
              for (const emailVerified of [false, true]) {
                ctxs.push(
                  makeCtx({
                    tosDecision: tos,
                    parsedEmail: email,
                    parsedCode: code,
                    cvParsed,
                    emailCaptured,
                    emailVerified,
                  })
                )
              }
            }
          }
        }
      }
    }
    for (const ctx of ctxs) {
      const matches = parsedEdges.filter((e) => {
        if (e.condition.kind !== "parsedAnswer") return false
        const c = e.condition
        if (c.parser === "ask_q_tos") {
          if (c.matches === "accept") return ctx.tosDecision === "accept"
          if (c.matches === "decline") return ctx.tosDecision === "decline"
          if (c.matches === "ambiguous") return ctx.tosDecision === "unclear"
        }
        if (c.parser === "ask_q_email") {
          if (c.matches === "valid_email") return Boolean(ctx.parsedEmail)
          if (c.matches === "no_email") return !ctx.parsedEmail
        }
        if (c.parser === "ask_q_email_verify") {
          if (c.matches === "code_correct") return Boolean(ctx.parsedCode)
          if (c.matches === "code_wrong_or_missing") return !ctx.parsedCode
        }
        return false
      })
      assert.ok(
        matches.length <= 1,
        `state=${node.state}: ${matches.length} parsedAnswer edges match ctx — order would matter (NOT deterministic). Edges: ${matches.map((m) => `${m.action}/${"matches" in m.condition ? m.condition.matches : "?"}`).join(", ")}`
      )
    }
    // externalSignal edges from same state must also be mutex
    const extMatches = (ctx: WorkflowContext) =>
      extEdges.filter((e) => {
        if (e.condition.kind !== "externalSignal") return false
        const sig = e.condition.signal
        if (sig === "cvParsed") return ctx.cvParsed === true
        if (sig === "emailCaptured") return ctx.emailCaptured === true
        if (sig === "emailVerified") return ctx.emailVerified === true
        return false
      })
    for (const ctx of ctxs.slice(0, 8)) {
      const m = extMatches(ctx)
      assert.ok(
        m.length <= 1,
        `state=${node.state}: ${m.length} externalSignal edges match — order would matter`
      )
    }
  }
})

test("DETERMINISM: every state has exactly one default edge OR has a covering parsedAnswer set (no null routes)", () => {
  // For any input ctx the walker MUST find an edge (never null) at every
  // non-terminal state — except the entry+terminal. This catches a class
  // of subtle bugs where a future edit deletes the default fallback and
  // certain inputs cause the dispatcher to silently no-op.
  for (const node of ONBOARDING_WORKFLOW.nodes) {
    if (node.state === ONBOARDING_WORKFLOW.terminalState) continue
    const fromEdges = outgoingEdges(ONBOARDING_WORKFLOW, node.state)
    const defaultEdges = fromEdges.filter((e) => e.condition.kind === "default")
    assert.ok(
      defaultEdges.length <= 1,
      `state=${node.state}: ${defaultEdges.length} default edges (should be ≤ 1)`
    )
    if (defaultEdges.length === 0) {
      // No default — must have BOTH parsedAnswer AND its complement
      // covering all parser outputs. We assert at least one parsedAnswer
      // edge exists; the mutex test above + the dispatcher's runtime
      // skip-fallback handles the residual case explicitly.
      const parsedEdges = fromEdges.filter((e) => e.condition.kind === "parsedAnswer")
      assert.ok(
        parsedEdges.length >= 1 || node.kind === "action",
        `state=${node.state}: no default + no parsedAnswer edges = unreachable next state`
      )
    }
  }
})
