/**
 * iter33 P5 — Onboarding workflow as introspectable graph data.
 *
 * Adam directive 2026-05-04 ("之前都得是 deterministic 的 workflow, 你可以
 * 用 openai 的 workflow 做这个事情. 但必须是 workflow 搞清楚了吗"): the
 * deterministic onboarding sequence is now expressed as a declarative
 * graph (`ONBOARDING_WORKFLOW`), separate from the imperative dispatcher
 * in `onboarding-deterministic.ts`. The dispatcher remains the executor
 * — it reads this graph to decide transitions — but downstream tooling
 * (dashboard inspector, validation, docs generator) can introspect the
 * graph directly without re-implementing the switch.
 *
 * Why graph-data-not-Agents-SDK-Handoff:
 *
 * OpenAI Agents SDK's `Handoff` + `Agent` primitives are designed for
 * LLM-driven multi-agent orchestration where each step calls a model.
 * iter32+iter33 onboarding has ZERO LLM calls in the deterministic path
 * (verify-mail Mailgun + send-cv-analysis Qwen-7B are the only LLM calls,
 * and those are leaf I/O not control-flow). Wrapping deterministic state
 * transitions in Agent + Handoff would add overhead (model calls per
 * step) without buying any LLM-routing benefit. The right primitive for
 * deterministic flow is a state graph — which is what this module makes
 * first-class.
 *
 * The graph encodes:
 *   - nodes: each `OnboardingState` value, marked entry / exit / waiting
 *   - edges: state → state transitions with the action that fires on
 *     transition + the condition (parsed user reply / cv parsed / etc.)
 *
 * The dispatcher (`resolveDeterministicAction`) decides which edge to
 * take per turn; this graph DOCUMENTS the legal edges for inspection.
 */

import type { OnboardingState } from "@pa/core-types"

// ────────────────────────────────────────────────────────────────────
// Graph types
// ────────────────────────────────────────────────────────────────────

/** Node category drives the dispatcher's decision style. */
export type WorkflowNodeKind =
  /** Entry point — first turn writes a greeting + advances. */
  | "entry"
  /** Question step — Claire asks, user replies, parser determines next. */
  | "question"
  /** Wait step — pauses for an external signal (CV parsed, email verified). */
  | "waiting"
  /** Action step — Claire produces an outbound (analysis, recs) + advances. */
  | "action"
  /** Terminal — onboarding complete, agent runtime activates next inbound. */
  | "terminal"

export type WorkflowEdgeCondition =
  /** Default unconditional transition (fires on next turn). */
  | { kind: "default" }
  /** User reply matches a parsed answer (parser key + accepted shape). */
  | { kind: "parsedAnswer"; parser: string; matches: string }
  /** External signal — referenced by name, evaluated by dispatcher. */
  | { kind: "externalSignal"; signal: string }
  /** Vent/distress detection — stays at current node. */
  | { kind: "ventDetected" }

export type WorkflowEdge = {
  from: OnboardingState | "pending"
  to: OnboardingState | "complete"
  /** Action emitted on transition (matches DeterministicAction.kind). */
  action: string
  /** Condition under which dispatcher takes this edge. */
  condition: WorkflowEdgeCondition
  /** Doc-only: 1-line description of why this edge exists. */
  description: string
}

export type WorkflowNode = {
  state: OnboardingState | "pending"
  kind: WorkflowNodeKind
  /** Doc-only: which Adam-locked iter directive introduced this node. */
  origin: string
  description: string
}

export type OnboardingWorkflow = {
  /** Where the user starts — pending state on first inbound. */
  entryState: "pending"
  /** Where the user ends — complete state hands off to agent runtime. */
  terminalState: "complete"
  nodes: WorkflowNode[]
  edges: WorkflowEdge[]
}

// ────────────────────────────────────────────────────────────────────
// Adam-locked workflow graph (iter33 P1+P2+P3+P4 sequence)
// ────────────────────────────────────────────────────────────────────

export const ONBOARDING_WORKFLOW: OnboardingWorkflow = {
  entryState: "pending",
  terminalState: "complete",
  nodes: [
    {
      state: "pending",
      kind: "entry",
      origin: "iter32 D-7",
      description: "Fresh user, never seen first_mes",
    },
    {
      state: "first_mes_sent",
      kind: "question",
      origin: "iter33 P1 (Adam 2026-05-04)",
      description: "Claire said hi; awaits any reply to advance to lang Q",
    },
    {
      state: "q_lang_asked",
      kind: "question",
      origin: "iter33 P1 (Adam 2026-05-04)",
      description: "Claire asked zh/en/mixed; permissive parser, ambiguous → mixed",
    },
    {
      state: "q_email_asked",
      kind: "question",
      origin: "iter33 P2 (Adam 2026-05-04)",
      description: "Claire asked email; valid email triggers Mailgun verify-start",
    },
    {
      state: "q_email_verifying",
      kind: "waiting",
      origin: "iter31 (Adam 2026-05-04)",
      description: "Mailgun fired, awaits user to text back the 6-digit code",
    },
    {
      state: "q_tos_asked",
      kind: "question",
      origin: "iter31 → iter33 P2 reorder (Adam 2026-05-04)",
      description: "Claire showed /legal link; accept → role probe; decline → stay",
    },
    {
      state: "q_role_asked",
      kind: "question",
      origin: "iter32",
      description: "Claire asked target role (eng/pm/research/design)",
    },
    {
      state: "q_yoe_asked",
      kind: "question",
      origin: "iter32",
      description: "Claire asked YoE (number or 'fresh out')",
    },
    {
      state: "q_visa_asked",
      kind: "question",
      origin: "iter32",
      description: "Claire asked work auth (citizen/GC/OPT/H1B/sponsorship)",
    },
    {
      state: "q_startup_pref_asked",
      kind: "question",
      origin: "iter32",
      description: "Claire asked startup-vs-bigco preference",
    },
    {
      state: "q_location_asked",
      kind: "question",
      origin: "iter32",
      description: "Claire asked target location (SF / NYC / remote / etc.)",
    },
    {
      state: "q_resume_asked",
      kind: "waiting",
      origin: "iter30 closure (Adam 2026-05-03)",
      description: "Claire asked for CV; awaits parsedCandidateResumes row",
    },
    {
      state: "q_cv_analyzing",
      kind: "action",
      origin: "iter33 P3+P4 (Adam 2026-05-04)",
      description: "Claire reads CV, sends ack + LLM analysis + 2-job-rec push",
    },
    {
      state: "complete",
      kind: "terminal",
      origin: "iter32 D-8",
      description: "All gates cleared — agent runtime activates next inbound",
    },
  ],
  edges: [
    {
      from: "pending",
      to: "first_mes_sent",
      action: "send_first_mes",
      condition: { kind: "default" },
      description: "First user inbound → Claire greeting",
    },
    {
      from: "first_mes_sent",
      to: "q_lang_asked",
      action: "ask_q_lang",
      condition: { kind: "default" },
      description: "iter33 P1: any reply triggers explicit lang preference Q",
    },
    {
      from: "q_lang_asked",
      to: "q_email_asked",
      action: "ask_q_email",
      condition: { kind: "default" },
      description: "iter33 P2 reorder: lang captured (preferredLang) → email Q",
    },
    {
      from: "q_email_asked",
      to: "q_email_verifying",
      action: "ask_q_email_verify_start",
      condition: { kind: "parsedAnswer", parser: "ask_q_email", matches: "valid_email" },
      description: "Valid email → Mailgun fires + state advances to verifying",
    },
    {
      from: "q_email_asked",
      to: "q_email_asked",
      action: "ask_q_email",
      condition: { kind: "parsedAnswer", parser: "ask_q_email", matches: "no_email" },
      description: "No parseable email → re-ask, stay",
    },
    {
      from: "q_email_verifying",
      to: "q_tos_asked",
      action: "verify_email_code",
      condition: { kind: "parsedAnswer", parser: "ask_q_email_verify", matches: "code_correct" },
      description: "iter33 P2: correct code → ToS gate (was: q_role_asked)",
    },
    {
      from: "q_email_verifying",
      to: "q_email_verifying",
      action: "ask_q_email_verify_retry",
      condition: { kind: "parsedAnswer", parser: "ask_q_email_verify", matches: "code_wrong_or_missing" },
      description: "Wrong/missing code → bump attempts, stay",
    },
    {
      from: "q_email_verifying",
      to: "q_email_verifying",
      action: "ask_q_email_verify_reissue",
      condition: { kind: "parsedAnswer", parser: "ask_q_email_verify", matches: "code_expired_or_exhausted" },
      description: "Expired/5-misses → re-fire Mailgun, stay",
    },
    {
      from: "q_tos_asked",
      to: "q_role_asked",
      action: "ask_q_role",
      condition: { kind: "parsedAnswer", parser: "ask_q_tos", matches: "accept" },
      description: "iter33 P2: accept → role probe chain (was: ask_q_email)",
    },
    {
      from: "q_tos_asked",
      to: "q_tos_asked",
      action: "ask_q_tos_decline",
      condition: { kind: "parsedAnswer", parser: "ask_q_tos", matches: "decline" },
      description: "Decline → record decline, stay (memory ingest opt-out)",
    },
    {
      from: "q_tos_asked",
      to: "q_tos_asked",
      action: "ask_q_tos_reask",
      condition: { kind: "parsedAnswer", parser: "ask_q_tos", matches: "ambiguous" },
      description: "Ambiguous → re-ask gentler, stay",
    },
    {
      from: "q_role_asked",
      to: "q_yoe_asked",
      action: "ask_q_yoe",
      condition: { kind: "parsedAnswer", parser: "ask_q_role", matches: "answered" },
      description: "Role captured → YoE",
    },
    {
      from: "q_role_asked",
      to: "q_role_asked",
      action: "ask_q_role",
      condition: { kind: "default" },
      description: "Role unclear → re-ask same",
    },
    {
      from: "q_yoe_asked",
      to: "q_visa_asked",
      action: "ask_q_visa",
      condition: { kind: "parsedAnswer", parser: "ask_q_yoe", matches: "answered" },
      description: "YoE captured → visa",
    },
    {
      from: "q_yoe_asked",
      to: "q_yoe_asked",
      action: "ask_q_yoe",
      condition: { kind: "default" },
      description: "YoE unclear → re-ask same",
    },
    {
      from: "q_visa_asked",
      to: "q_startup_pref_asked",
      action: "ask_q_startup_pref",
      condition: { kind: "parsedAnswer", parser: "ask_q_visa", matches: "answered" },
      description: "Visa captured → startup pref",
    },
    {
      from: "q_visa_asked",
      to: "q_visa_asked",
      action: "ask_q_visa",
      condition: { kind: "default" },
      description: "Visa unclear → re-ask same",
    },
    {
      from: "q_startup_pref_asked",
      to: "q_location_asked",
      action: "ask_q_location",
      condition: { kind: "parsedAnswer", parser: "ask_q_startup_pref", matches: "answered" },
      description: "Startup pref captured → location",
    },
    {
      from: "q_startup_pref_asked",
      to: "q_startup_pref_asked",
      action: "ask_q_startup_pref",
      condition: { kind: "default" },
      description: "Startup pref unclear → re-ask same",
    },
    {
      from: "q_location_asked",
      to: "q_resume_asked",
      action: "ask_q_resume",
      condition: { kind: "parsedAnswer", parser: "ask_q_location", matches: "answered" },
      description: "Location captured → CV ask",
    },
    {
      from: "q_location_asked",
      to: "q_location_asked",
      action: "ask_q_location",
      condition: { kind: "default" },
      description: "Location unclear → re-ask same",
    },
    {
      from: "q_resume_asked",
      to: "q_cv_analyzing",
      action: "send_cv_analysis",
      condition: { kind: "externalSignal", signal: "cvParsed" },
      description: "iter33 P3+P4: CV parsed → ack + LLM analysis + 2-job-rec push",
    },
    {
      from: "q_resume_asked",
      to: "q_resume_asked",
      action: "wait_for_resume_upload",
      condition: { kind: "default" },
      description: "CV not parsed yet → wait prompt, stay",
    },
    {
      from: "q_cv_analyzing",
      to: "complete",
      action: "send_cv_analysis",
      condition: { kind: "default" },
      description: "CV analysis fan finishes → terminal complete state",
    },
    // Vent edges — self-loop on vent at every node where the dispatcher's
    // priorAskedStepFromState() returns a step (i.e. Claire JUST asked
    // something specific). q_email_asked + q_email_verifying are
    // intentionally NOT in this list because the parser owns those
    // turns — vent words may legitimately appear inside an email or as
    // part of a verification code reply, and we don't want the vent
    // detector to short-circuit captured input.
    ...["q_lang_asked", "q_tos_asked", "q_role_asked", "q_yoe_asked", "q_visa_asked", "q_startup_pref_asked", "q_location_asked", "q_resume_asked"].map((s) => ({
      from: s as OnboardingState,
      to: s as OnboardingState,
      action: "vent_ack",
      condition: { kind: "ventDetected" } as const,
      description: "Vent detected → empathy ack, state stays",
    })),
  ],
}

// ────────────────────────────────────────────────────────────────────
// Introspection helpers (consumed by dashboard / validation / docs)
// ────────────────────────────────────────────────────────────────────

/** Edges leaving a state. */
export function outgoingEdges(
  workflow: OnboardingWorkflow,
  state: OnboardingState | "pending"
): WorkflowEdge[] {
  return workflow.edges.filter((e) => e.from === state)
}

/** Edges entering a state. */
export function incomingEdges(
  workflow: OnboardingWorkflow,
  state: OnboardingState | "complete"
): WorkflowEdge[] {
  return workflow.edges.filter((e) => e.to === state)
}

// ────────────────────────────────────────────────────────────────────
// Graph executor (iter33 GAP 2)
// ────────────────────────────────────────────────────────────────────

/**
 * iter33 GAP 2 — workflow context shape consumed by the graph executor
 * to evaluate edge conditions. Pure-data: tests can construct a context
 * literal without booting Firestore.
 */
export type WorkflowContext = {
  userMessage: string
  cvParsed: boolean
  emailCaptured: boolean
  emailVerified: boolean
  v33Disabled: boolean
  /** True when the user message is a vent / distress signal. */
  isVent: boolean
  /** Result of parseTosAnswer(userMessage); undefined when not at q_tos_asked. */
  tosDecision?: "accept" | "decline" | "unclear"
  /** Captured email when parser succeeded at q_email_asked. */
  parsedEmail?: string
  /** Captured 6-digit code at q_email_verifying. */
  parsedCode?: string
  /** True when userAnsweredStep returned true for the current state's parser. */
  answered: boolean
}

/**
 * Walk outgoing edges of `state` in declared order; return the first edge
 * whose condition evaluates true given `ctx`. Falls back to a `default`
 * edge if present. Returns `null` when no edge matches (caller emits
 * `skip` action — onboarding terminal).
 *
 * Edge precedence (matches dispatcher's switch order):
 *   1. ventDetected (when ctx.isVent && state has a vent self-loop)
 *   2. parsedAnswer with specific match
 *   3. externalSignal (cvParsed, emailCaptured, etc.)
 *   4. default (always last)
 */
export function walkWorkflow(
  workflow: OnboardingWorkflow,
  state: OnboardingState | "pending" | undefined,
  ctx: WorkflowContext
): WorkflowEdge | null {
  const from = state ?? "pending"
  const edges = workflow.edges.filter((e) => e.from === from)
  if (edges.length === 0) return null

  // 1) vent — short-circuits ANY parser/default edge.
  if (ctx.isVent) {
    const ventEdge = edges.find((e) => e.condition.kind === "ventDetected")
    if (ventEdge) return ventEdge
  }

  // 2) parsedAnswer — first matching edge wins.
  for (const e of edges) {
    if (e.condition.kind !== "parsedAnswer") continue
    if (matchParsedAnswer(e.condition, ctx)) return e
  }

  // 3) externalSignal — cvParsed / emailCaptured / etc.
  for (const e of edges) {
    if (e.condition.kind !== "externalSignal") continue
    if (matchExternalSignal(e.condition, ctx)) return e
  }

  // 4) default — last resort.
  const def = edges.find((e) => e.condition.kind === "default")
  if (def) return def

  return null
}

function matchParsedAnswer(
  cond: { kind: "parsedAnswer"; parser: string; matches: string },
  ctx: WorkflowContext
): boolean {
  const { parser, matches } = cond
  if (parser === "ask_q_tos") {
    if (matches === "accept") return ctx.tosDecision === "accept"
    if (matches === "decline") return ctx.tosDecision === "decline"
    if (matches === "ambiguous") return ctx.tosDecision === "unclear"
  }
  if (parser === "ask_q_email") {
    if (matches === "valid_email") return Boolean(ctx.parsedEmail)
    if (matches === "no_email") return !ctx.parsedEmail
  }
  if (parser === "ask_q_email_verify") {
    if (matches === "code_correct") return Boolean(ctx.parsedCode)
    if (matches === "code_wrong_or_missing") return !ctx.parsedCode
    // "code_expired_or_exhausted" is determined by the runner from the
    // challenge doc; the dispatcher resolver doesn't have that signal,
    // so it routes to retry and the runner re-routes to reissue when it
    // discovers expired/exhausted state.
    if (matches === "code_expired_or_exhausted") return false
  }
  if (
    parser === "ask_q_role" ||
    parser === "ask_q_yoe" ||
    parser === "ask_q_visa" ||
    parser === "ask_q_startup_pref" ||
    parser === "ask_q_location"
  ) {
    if (matches === "answered") return ctx.answered
  }
  return false
}

function matchExternalSignal(
  cond: { kind: "externalSignal"; signal: string },
  ctx: WorkflowContext
): boolean {
  if (cond.signal === "cvParsed") return ctx.cvParsed
  if (cond.signal === "emailCaptured") return ctx.emailCaptured
  if (cond.signal === "emailVerified") return ctx.emailVerified
  return false
}

/** All states in topological order from entry → terminal. */
export function topologicalStates(workflow: OnboardingWorkflow): string[] {
  return workflow.nodes.map((n) => n.state)
}

/** Validate graph: every node has either incoming edges or is the entry; every state referenced in edges exists in nodes. */
export function validateWorkflow(workflow: OnboardingWorkflow): {
  ok: boolean
  errors: string[]
} {
  const errors: string[] = []
  const stateSet = new Set(workflow.nodes.map((n) => n.state))
  for (const e of workflow.edges) {
    if (!stateSet.has(e.from)) errors.push(`edge.from "${e.from}" not in nodes`)
    if (e.to !== workflow.terminalState && !stateSet.has(e.to as OnboardingState)) {
      errors.push(`edge.to "${e.to}" not in nodes`)
    }
  }
  for (const n of workflow.nodes) {
    if (n.state === workflow.entryState) continue
    if (n.state === workflow.terminalState) continue
    const inc = incomingEdges(workflow, n.state)
    if (inc.length === 0) errors.push(`node "${n.state}" has no incoming edges`)
  }
  return { ok: errors.length === 0, errors }
}
