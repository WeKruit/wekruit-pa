/**
 * agent.ts — Wave B assembly + the inbound turn loop (the cutover entry).
 *
 * One @openai/agents Agent, dynamic mode-scoping, NO handoffs. The SDK is loaded
 * via ./sdk.js (zod@4 graph) — never a static "@openai/agents" import (BLOCKER #1).
 *
 * runClaireTurn is what the flag-gated cutover calls per inbound:
 *   mode select (deterministic) → mark-read reflex → run(agent, text, {session})
 *   with a timeout + grounded fallback (RC2: never hang) → guardrail-tripwire handling
 *   (crisis/injection) → normalize + deliver (unless a delivery tool already did).
 * Global read-context (canonical tags) is injected so "what's saved" reads tags (RC3).
 */
import { createHash } from "node:crypto"
import type { Firestore } from "firebase-admin/firestore"
import { Agent, run, InputGuardrailTripwireTriggered, configureClaireSdk, forceFlushTraces, z } from "./sdk.js"
import type {
  ClaireLang,
  ClaireMode,
  ClaireRunResult,
  ClaireToolContext,
  ClaireTransport,
  ClaireTurnInput,
  ClaireTurnUsage,
} from "./types.js"
import { buildClaireTools } from "./tools/index.js"
import { type ProcessSessionStore, type ProcessToolContext } from "./tools/process-tools.js"
import { buildClairePrompt, buildClaireTurnContext } from "./prompt.js"
import { buildClaireGuardrails } from "./guardrails.js"
import { markReadReflex, wireTypingReflex, deliverBubblesEx } from "./delivery.js"
import { isCanaryUser } from "./canary.js"
import { makeClaireSession } from "./session.js"
import { appendHotlineIfMissing } from "@pa/pa-safety"
import {
  CONNECT_LINKEDIN_LINK_BASE,
  HELLO_WEKRUIT_OPENER_PREFIX,
  HI_WEKRUIT_OPENER_PREFIX,
  LINKEDIN_DONE_OPENER_PREFIX,
  VERIFICATION_CODE_OPENER_PREFIX,
} from "@pa/pa-orchestrator"

/** Main conversation model (the per-tool LLM judge model is configured separately). */
export const CLAIRE_MODEL = "gpt-5.4-nano"

/**
 * Fallback conversation model — tried ONCE when the primary model THROWS (429 / 5xx /
 * APIConnectionError) on the inbound turn, BEFORE the user-visible hiccup copy (2026-06-20 SEV:
 * 31 OpenAI fast-throws across 13 users → 31 candidates got the "trouble on my end" copy because
 * the turn had NO model fallback). `gpt-4.1-mini` is the lowest-risk swap: SAME OpenAI client /
 * SDK shape as the primary (sdk.ts configureClaireSdk points the SDK at one OpenAI client; only
 * the model STRING differs), so the retry needs no new client wiring — and a DIFFERENT model id
 * dodges a per-model rate-limit / 5xx that just hit the primary. Mirrors the pa-resume-parser
 * router's gpt-5.4-nano → … → gpt-4.1-mini chain (router.ts). The fallback is NOT tried on a
 * guardrail tripwire (a deliberate block) or on the explicit run timeout (the timeout path is a
 * cost/latency guard, not a provider hiccup, and re-running would blow the inbound lease) — only on
 * a genuine provider throw.
 */
export const CLAIRE_FALLBACK_MODEL = "gpt-4.1-mini"

/**
 * Hard cap on the SDK agent loop (model-call iterations per inbound turn) for the
 * LIVE thin-Claire path — the `run()` calls in this file + proactive.ts.
 *
 * @openai/agents `run()` defaults to `DEFAULT_MAX_TURNS = 10` when no cap is
 * passed. Each iteration re-sends the full (uncached) ~5-6K system prompt + the
 * monotonically GROWING transcript + accumulated tool outputs, so a turn that
 * spirals toward the ceiling multiplies token cost on a compounding context —
 * the mechanism behind the 2026-06-01 runaway (~1.2B gpt-5.4-nano input tokens
 * in one day → OpenAI auto-revoked the key). Capping bounds the per-inbound
 * blast radius. Shares the SAME env knob + default as @pa/agent-runtime's
 * `resolveMaxTurns` (the OTHER, non-conversation run() path) so a single
 * `PA_AGENT_MAX_TURNS` governs BOTH. Default 8 (< the SDK's 10, room for the
 * longest legit chain: matching set-prefs→find-match→compose, or the prescreen
 * FSM load→judge→record→advance→ask). Clamped to [2,10].
 */
export function resolveClaireMaxTurns(): number {
  const raw = Number(process.env.PA_AGENT_MAX_TURNS)
  if (!Number.isFinite(raw)) return 8
  return Math.max(2, Math.min(10, Math.trunc(raw)))
}

/**
 * Structured reply contract (Adam 2026-05-30) — the agent returns its user-facing reply as an
 * ARRAY of iMessage bubbles, each sent in order via one Sendblue POST. This is the SDK-native way
 * to do multi-bubble (e.g. a compliment bubble THEN the question bubble): ONE model response, an
 * array of strings — NOT N tool calls. It directly fixes the kickoff loop, where the prompt routed
 * the compliment through `send_status_then_continue` (a filler tool that never ends the turn), so
 * the model spammed "one sec" until claire_run_timeout → "hiccupped" fallback.
 *
 * @openai/agents 0.8.5: `outputType` accepts a Zod object; `run().finalOutput` is then the parsed
 * object (result.d.ts `ResolvedAgentOutput`). Tools still loop normally; the final step emits this.
 * Built from the SDK's own zod@4 `z` (sdk.ts) so it matches the tool-param schema instance.
 */
const ClaireReplySchema = z.object({
  messages: z
    .array(z.string())
    .describe(
      "Your reply, split into iMessage bubbles SENT IN ORDER (one text each). Default to ONE " +
        "bubble. Use 2-3 ONLY for an intentional beat — e.g. a compliment bubble, THEN the question " +
        "bubble. Each element is a complete standalone message; never split mid-sentence, never put " +
        "a filler like 'one sec' here. Empty array ONLY when you delivered via a tapback/no_reply " +
        "tool and intend to send no text.",
    ),
})

/** Coerce the SDK's resolved final output into the ordered bubble array (defensive vs shape drift). */
function extractBubbles(finalOutput: unknown): string[] {
  const fromArray = (arr: unknown[]): string[] =>
    arr.map((m) => String(m ?? "").trim()).filter(Boolean)
  if (Array.isArray(finalOutput)) return fromArray(finalOutput)
  if (finalOutput && typeof finalOutput === "object") {
    const msgs = (finalOutput as { messages?: unknown }).messages
    if (Array.isArray(msgs)) return fromArray(msgs)
  }
  // Back-compat: a plain string (if a model/SDK build ever returns text instead of the schema).
  const s = String(finalOutput ?? "").trim()
  return s ? [s] : []
}

/**
 * One ordered tool call captured from the SDK RunResult — the de-blackbox payload so Adam can SEE
 * why Claire acts (which tools she called, with what args, and what came back), instead of the old
 * hardcoded empty list. `output` is filled when a paired function_call_output item existed.
 *
 * NOTE: the public `ClaireRunResult.toolCalls` is declared `string[]` in types.ts (which this run is
 * NOT allowed to edit). We populate the RICHER object shape at runtime and cast at the return
 * boundary — the SAME "compile-time type is a known lie, runtime is the real value" pattern sdk.ts
 * already uses for the zod-split. No current consumer reads `toolCalls` as `string[]` at runtime
 * (only the 4 return sites + tests, none of which index into it as strings).
 */
export type ClaireToolCall = {
  name: string
  /** raw JSON arguments string the model passed (as the SDK emitted it). */
  arguments: string
  /** the tool's stringified output, when a function_call_output item paired to this call. */
  output?: string
}

/**
 * Map @openai/agents `res.newItems` → ordered ClaireToolCall[] (de-blackbox).
 *
 * Item shapes (node_modules/@openai/agents-core/dist/items.d.ts + types/protocol.d.ts):
 *   - a tool CALL  → RunItem `{ type: "tool_call_item",        rawItem: { type: "function_call",        callId, name, arguments } }`
 *   - a tool OUTPUT→ RunItem `{ type: "tool_call_output_item", output, rawItem: { type: "function_call_result", callId, name, output } }`
 * We emit one entry per function_call in call order, then join each tool's output by matching
 * `callId` (the deterministic pairing key). Fully defensive: any drift in the item shape yields a
 * partial/empty list, never a throw — this is observability, it must never break the turn.
 */
export function captureToolCalls(newItems: unknown): ClaireToolCall[] {
  try {
    const items = Array.isArray(newItems) ? newItems : []
    const str = (v: unknown) => (typeof v === "string" ? v : v == null ? "" : String(v))
    // First pass: outputs keyed by callId (so a call maps to its result regardless of order).
    const outputs = new Map<string, string>()
    for (const it of items) {
      const item = it as { type?: unknown; output?: unknown; rawItem?: Record<string, unknown> }
      if (item?.type !== "tool_call_output_item") continue
      const raw = (item.rawItem ?? {}) as Record<string, unknown>
      const callId = str(raw.callId)
      // RunToolCallOutputItem carries the resolved output on `.output` (string | unknown); the
      // wire form also has it on rawItem.output. Prefer the top-level resolved value.
      const out = item.output !== undefined ? item.output : raw.output
      if (callId) outputs.set(callId, str(out))
    }
    // Second pass: one entry per function_call, in emission order, joined to its output.
    const calls: ClaireToolCall[] = []
    for (const it of items) {
      const item = it as { type?: unknown; rawItem?: Record<string, unknown> }
      if (item?.type !== "tool_call_item") continue
      const raw = (item.rawItem ?? {}) as Record<string, unknown>
      // Only true function tool calls carry name + arguments (hosted/computer calls differ); guard on it.
      if (raw.type !== "function_call") continue
      const name = str(raw.name)
      if (!name) continue
      const callId = str(raw.callId)
      const entry: ClaireToolCall = { name, arguments: str(raw.arguments) }
      const out = callId ? outputs.get(callId) : undefined
      if (out !== undefined && out !== "") entry.output = out
      calls.push(entry)
    }
    return calls
  } catch {
    return []
  }
}

/**
 * Hard ceiling so the turn ALWAYS replies (RC2: the prod path hung at stage=llm running).
 *
 * Raised 60s → 100s on 2026-05-30: the find_match turn calls V16, which fetches up to 3000 job
 * docs (each with a 1536-dim embedding + full JD) — ~67MB, measured at 10s warm / 80s cold. The
 * 60s ceiling killed the cold matcher mid-flight (claire_run_timeout) → stuck event, no roles.
 * 100s clears the 80s cold call with margin while staying under the inbound-event lease so a slow
 * turn can't double-fire. The real cure is the V16 `.select()` lean-fetch (drops the bulk embedding
 * load → ~2-3s); until that lands, the agent sets a "this can take a few seconds" expectation
 * before find_match (see prompt.ts) so the wait reads as work, not silence.
 */
const RUN_TIMEOUT_MS = 100_000

// ── 2026-06-10 trust audit (fix 6) — LLM-failure circuit breaker + escalating fallback copy ──
//
// (a) PER-INSTANCE breaker: 3 agent-run failures within 60s open the circuit; subsequent turns
//     fast-fail straight to the fallback copy WITHOUT invoking the LLM until the window passes.
//     INSTANCE-LOCAL by design: the counter is module state, so each Cloud Run instance trips
//     independently (no cross-instance coordination — a provider outage trips every instance
//     within a few turns anyway, and an instance-local breaker can never poison a healthy one).
// (b) PER-USER escalation: the hiccup stamp persists on the pa-users doc; when the user's
//     PREVIOUS turn also hiccupped (within HICCUP_ESCALATION_WINDOW_MS) they get honest
//     "give me a few minutes" copy instead of the identical retry-bait.
const CLAIRE_FAILURE_WINDOW_MS = 60_000
const CLAIRE_FAILURE_THRESHOLD = 3
const HICCUP_ESCALATION_WINDOW_MS = 10 * 60 * 1000

export const CLAIRE_HICCUP_COPY = "sorry, that one hiccupped on my end — mind sending that again?"
export const CLAIRE_HICCUP_ESCALATED_COPY =
  "i'm having trouble on my end right now — give me a few minutes and try again? i'll be here."

let claireRunFailureTimestamps: number[] = []

function pruneClaireFailures(nowMs: number): void {
  claireRunFailureTimestamps = claireRunFailureTimestamps.filter(
    (t) => nowMs - t <= CLAIRE_FAILURE_WINDOW_MS,
  )
}

/** Record one agent-run failure (exported for tests). */
export function noteClaireRunFailure(nowMs: number = Date.now()): void {
  claireRunFailureTimestamps.push(nowMs)
  pruneClaireFailures(nowMs)
}

/** True when the per-instance breaker is OPEN (3+ failures in the last 60s). */
export function isClaireCircuitOpen(nowMs: number = Date.now()): boolean {
  pruneClaireFailures(nowMs)
  return claireRunFailureTimestamps.length >= CLAIRE_FAILURE_THRESHOLD
}

/** Test hook — reset the per-instance breaker between cases. */
export function resetClaireRunFailures(): void {
  claireRunFailureTimestamps = []
}

/**
 * Resolve the fallback copy for a failed turn AND persist the per-user hiccup
 * stamp. Reads pa-users.claireHiccup.lastAt (one read, FAILURE path only — the
 * happy path never pays it); if the previous hiccup landed within the
 * escalation window, return the escalated copy. Never throws — any read/write
 * error degrades to the base copy.
 */
export async function resolveHiccupFallbackCopy(
  db: import("firebase-admin/firestore").Firestore,
  userId: string,
  nowMs: number,
  log: (event: string, payload?: Record<string, unknown>) => void,
): Promise<string> {
  let escalated = false
  const nowIso = new Date(nowMs).toISOString()
  try {
    const ref = db.collection("pa-users").doc(userId)
    const snap = await ref.get()
    const hiccup = (snap.exists ? (snap.data()?.claireHiccup as Record<string, unknown> | undefined) : undefined) ?? {}
    const lastMs = typeof hiccup.lastAt === "string" ? Date.parse(hiccup.lastAt) : NaN
    escalated = Number.isFinite(lastMs) && nowMs - lastMs <= HICCUP_ESCALATION_WINDOW_MS
    const count = typeof hiccup.count === "number" && Number.isFinite(hiccup.count) ? hiccup.count : 0
    await ref.set(
      { claireHiccup: { lastAt: nowIso, count: count + 1 }, updatedAt: nowIso },
      { merge: true },
    )
  } catch (e) {
    log("claire_hiccup_stamp_failed", { userId, err: e instanceof Error ? e.message : String(e) })
  }
  return escalated ? CLAIRE_HICCUP_ESCALATED_COPY : CLAIRE_HICCUP_COPY
}

export interface BuildClaireAgentOptions {
  mode: ClaireMode
  lang: ClaireLang
  pendingStep?: string
  /** onboarding: the CURRENT question text — re-asked when the candidate didn't answer. */
  currentStep?: string
  /** injected global read-context (canonical tags summary, prescreen history). */
  globalContext?: string
  /** onboarding: the slot the inbound answers (the agent records THIS slot via the tool). */
  onboardingSlot?: string
  /** onboarding: false on the kickoff turn (ask only, don't record); true once a question was asked. */
  awaitingAnswer?: boolean
  /** prescreen: qId → DIRECTION question text (passed to the FSM tools as natural-language prompts). */
  prescreenPrompts?: Record<string, string>
  /** prescreen: qId → judge rubric (keyword hints + clarify cue) the score tool grades against. */
  judgeContext?: Record<string, string>
  /** prescreen: résumé + prior-session context the prompt grounds probing questions in. */
  prescreenContext?: string
  /** cv-parsed re-entry: the résumé just parsed → swap the generic kickoff for the PART-2 pitch. */
  postParsePitch?: boolean
  /** cv-parsed re-entry (BLOCKER 2): the parsed-profile summary from the handoff context, surfaced in
   *  the turn context so the pitch turn always has the profile (never reads the marker as empty). */
  postParsePitchSummary?: string
  /** résumé-drop turn (inline media present, no parse yet) → ACK + HOLD, do NOT pitch / find_match. */
  resumeJustDropped?: boolean
  /** WS-1(b): enrichment (résumé parse / LinkedIn import) is STILL running from an EARLIER turn →
   *  the turn-context directive tells Claire to say "still pulling your info, one sec" instead of
   *  pitching/find_match/answering blind. Turn-context only (NOT the cached head). */
  enrichmentInFlight?: boolean
  /** WS-3(b): this turn MAY carry the occasional "connect Gmail on wekruit.com" nudge directive. */
  gmailNudge?: boolean
  /** LINKEDIN-DONE re-entry directive — ack by name + ask for résumé/URL (turn-context only). */
  linkedinJustConnected?: boolean
  /** CANONICAL STEP 4: the conditional pre-match location+salary ask (turn-context only). */
  locationSalaryAsk?: boolean
  /** Provider-fallback retry: override the conversation model (default CLAIRE_MODEL). Set to
   *  CLAIRE_FALLBACK_MODEL for the one-shot retry after the primary model throws. */
  modelOverride?: string
  /** DEDICATED YC LANE (Adam-LOCKED 2026-07-23): entryPosture==yc_startup_school → the agent is
   *  built WITHOUT any job-recommendation tools. Set from deps.entryPosture. */
  ycPeopleMode?: boolean
}

// The agent's terminal output when a tool already delivered the candidate-facing text: an EMPTY bubble array
// (ClaireReplySchema = { messages: string[] }, no min). Parsed by agent.processFinalOutput →
// ClaireReplySchema.parse → { messages: [] } → extractBubbles → nothing for deliverBubbles to send.
const TOOL_DELIVERED_FINAL_OUTPUT = JSON.stringify({ messages: [] })
const FINALIZING_DELIVERY_TOOLS = new Set([
  "find_match",
  "offer_voice_call",
  "resolve_voice_call_offer",
])

/**
 * SDK-native turn finalization (the Agents SDK `toolUseBehavior` ToolToFinalOutputFunction).
 *
 * Some tools send their candidate-facing message themselves, then return `delivered:true`. At that point
 * the text has ALREADY reached the candidate, so the turn is COMPLETE — we tell the SDK "this is the final output" and the agent loop
 * STOPS WITHOUT RUNNING THE LLM AGAIN (turnResolution.checkForFinalOutputFromTools → next_step_final_
 * output). That removes the generation step in which the model was talking OVER the recs — the live
 * `Senior Software Engineer @ [company] — … (US)` cards (no company data to fill the placeholder) and
 * the fabricated `WeKruit fast-track prescreen offer: <résumé company> (Software Engineering)` block
 * built from the candidate's OWN experience. This is the SDK's own tools-to-final-output mechanism,
 * NOT a deterministic clamp bolted onto the delivery layer.
 *
 * When a delivery tool did NOT deliver (no match / matcher error → `delivered:false`), or no such tool ran
 * this turn, we return NOT-final so the LLM runs again and composes the grounded no-match clarifier —
 * exactly the behavior the find_match tool description promises ("Only when delivered:false do you
 * speak"). Now ENFORCED by the runtime instead of pleaded for in the prompt.
 */
type ToolUseResult = readonly {
  readonly type?: string
  readonly tool?: { readonly name?: string }
  readonly output?: unknown
}[]
export function claireToolUseBehavior(
  _ctx: unknown,
  toolResults: ToolUseResult,
):
  | { isFinalOutput: true; isInterrupted: undefined; finalOutput: string }
  | { isFinalOutput: false; isInterrupted: undefined } {
  for (const r of toolResults ?? []) {
    if (r?.type !== "function_output") continue
    const toolName = r?.tool?.name ?? ""
    if (!FINALIZING_DELIVERY_TOOLS.has(toolName)) continue
    // r.output is the tool's return value — an object at runtime, but be defensive vs a stringified
    // form (some adapters JSON-encode the output before handing it to the behavior fn).
    let out: { delivered?: boolean } | null = null
    if (r.output && typeof r.output === "object") out = r.output as { delivered?: boolean }
    else if (typeof r.output === "string") {
      try {
        out = JSON.parse(r.output) as { delivered?: boolean }
      } catch {
        out = null
      }
    }
    if (out?.delivered === true) {
      return {
        isFinalOutput: true,
        isInterrupted: undefined,
        finalOutput: TOOL_DELIVERED_FINAL_OUTPUT,
      }
    }
  }
  return { isFinalOutput: false, isInterrupted: undefined }
}

/**
 * Deterministic per-turn OpenAI trace id: `trace_<32 lowercase hex>` over (sessionId, userId, turn stamp).
 * Printable + stable so the `trace_exported` log line bridges Cloud Logging → the exact OpenAI trace (T1/T2,
 * Adam 2026-06-06 "debug ONE conversation"). Same (sessionId,userId,iso) → same id (dedupes a redelivered
 * Sendblue webhook within the same turn stamp); groupId=sessionId groups all turns of the conversation.
 */
export function makeTurnTraceId(sessionId: string, userId: string, turnIso: string): string {
  return `trace_${createHash("sha256")
    .update(`${sessionId}:${userId}:${turnIso}`)
    .digest("hex")
    .slice(0, 32)}`
}

/** Construct the single Claire agent (tools + guardrails + persona). */
export function buildClaireAgent(ctx: ClaireToolContext, opts: BuildClaireAgentOptions) {
  configureClaireSdk()
  const guardrails = buildClaireGuardrails()
  // outputType is cast through `unknown`: apps/functions's graph types `z` as zod@3 (BLOCKER #1 in
  // sdk.ts), so the locally-typed `z.object(...)` is NOT recognized as the SDK's zod@4 `ZodObjectLike`
  // and `outputType` inference would fall back to TextOutput ("text") and reject the schema. At RUNTIME
  // this IS the real zod@4 SDK instance (sdk.ts dynamic require), so the schema is enforced correctly —
  // only the compile-time type is the known lie. Same casting philosophy as sdk.ts's value exports.
  const agentConfig = {
    name: "Claire",
    // Default = the primary model; the provider-fallback retry passes CLAIRE_FALLBACK_MODEL here so
    // the rebuilt agent hits a DIFFERENT model on the same OpenAI client (see CLAIRE_FALLBACK_MODEL).
    model: opts.modelOverride ?? CLAIRE_MODEL,
    // 2B — STATIC HEAD ONLY (byte-stable across turns so the prefix caches). The per-turn
    // dynamic block (canary tapback / globalContext / prescreenContext / non-onboarding
    // pendingStep) is re-injected as a trailing system input item in run() below, NOT here.
    // Onboarding pendingStep/currentStep/slot/awaitingAnswer ARE part of the mode shape and
    // stay in the head (stable across a given turn's inner loop, which is the cached unit).
    instructions: buildClairePrompt({
      mode: opts.mode,
      lang: opts.lang,
      pendingStep: opts.pendingStep,
      currentStep: opts.currentStep,
      onboardingSlot: opts.onboardingSlot,
      awaitingAnswer: opts.awaitingAnswer,
      prescreenPrompts: opts.prescreenPrompts,
      // canary gate for the PART 2 proactive-pitch opener (prompt.ts modeDirective). Per-user-stable,
      // so the prefix cache correctly splits canary vs non-canary cohorts. isCanaryUser already imported.
      canary: isCanaryUser(ctx.userId),
      // post-parse pitch + résumé-drop ACK directives (set by cutover for the cv-parsed re-entry /
      // the inline media-drop turn respectively; default off for every other turn).
      postParsePitch: opts.postParsePitch,
      postParsePitchSummary: opts.postParsePitchSummary,
      resumeJustDropped: opts.resumeJustDropped,
    }),
    tools: buildClaireTools(ctx, {
      prescreenPrompts: opts.prescreenPrompts,
      judgeContext: opts.judgeContext,
      // BLOCKER 3: on the post-parse pitch turn the pitch MUST be text bubbles — drop the tapback /
      // no_reply / status tools so a deliveredViaTool short-circuit can't swallow the pitch.
      forbidSuppressingDelivery: opts.postParsePitch === true,
      // DEDICATED YC LANE: omit all job-recommendation tools for YC people-matching users.
      ycPeopleMode: opts.ycPeopleMode === true,
    }),
    // Multi-bubble reply contract — finalOutput is { messages: string[] }, delivered one send each.
    outputType: ClaireReplySchema,
    // SDK-native: when find_match has already delivered the recs (delivered:true), finalize the turn
    // from the tool result so the LLM does NOT run again and hallucinate cards over the recs. On
    // no-match (delivered:false) the LLM runs again and narrates. See claireToolUseBehavior.
    toolUseBehavior: claireToolUseBehavior,
    inputGuardrails: guardrails.input,
    outputGuardrails: guardrails.output,
  }
  const agent = new Agent(agentConfig as unknown as ConstructorParameters<typeof Agent>[0])
  // typing-before-slow-tool reflex (event-emitter API, not AgentHooks — see poc README).
  wireTypingReflex(agent, ctx)
  return agent
}

/**
 * Wrap a transport to observe (a) whether a delivery TOOL (tapback/no_reply) handled the turn, and
 * (b) how many raw text bubbles ACTUALLY reached the candidate this turn — `sentTextCount`.
 *
 * sentTextCount (Adam 2026-06-04, the GENERIC never-silent backstop) is TRANSPORT-TRUTHFUL: it counts
 * every `sendText` POST from ANY path — the post-run deliverBubblesEx sends AND any tool that delivered
 * mid-run via ctx.transport.sendText (find_match's role bubbles + prescreen offer, the onboarding ask-net,
 * the linkedin-offer net). So `sentTextCount === 0` is the single, path-independent signal that NOTHING
 * reached the candidate this turn — the exact predicate the backstop needs (covers empty `messages`,
 * all-suppressed, AND tool-ran-but-silent), and it can never false-positive after a real rec send (which
 * bumps the count). markRead/typing/sendStatus are reflexes (read receipt / typing indicator / status),
 * NOT candidate-visible message bubbles, so they do NOT count.
 */
function trackTransport(inner: ClaireTransport): {
  transport: ClaireTransport
  handledViaTool: () => boolean
  sentTextCount: () => number
} {
  let viaTool = false
  let sentText = 0
  const transport: ClaireTransport = {
    markRead: () => inner.markRead(),
    typing: () => inner.typing(),
    sendStatus: (t) => inner.sendStatus(t),
    sendText: (t, opts) => {
      sentText++
      return inner.sendText(t, opts)
    },
    tapback: (r) => {
      viaTool = true
      return inner.tapback(r)
    },
    noReply: (r) => {
      viaTool = true
      return inner.noReply(r)
    },
  }
  return { transport, handledViaTool: () => viaTool, sentTextCount: () => sentText }
}

/** Read canonical pa-users.tags → a one-line global context so "what's saved" reads tags (RC3).
 *  Exported for the WS-1a gate regression test (the no-résumé upload/LinkedIn-connect offers). */
export async function loadGlobalContext(db: Firestore, userId: string, toE164?: string): Promise<string> {
  try {
    const snap = await db.collection("pa-users").doc(userId).get()
    const data = (snap.data() ?? {}) as Record<string, unknown>
    const tags = (data.tags ?? {}) as Record<string, unknown>
    const arr = (k: string) => (Array.isArray(tags[k]) ? (tags[k] as unknown[]) : [])
    const str = (v: unknown) => (typeof v === "string" ? v.trim() : "")

    // RÉSUMÉ ON FILE — the candidate's name + most-recent role + skills, so Claire can open with a
    // personalized, résumé-aware greeting ("hey Shixiang, saw you were a SWE intern at Tesla…")
    // instead of a generic "welcome" (Adam 2026-05-30). skills are objects ({name,…}) → map .name.
    const displayName = str(data.displayName)
    const firstName = displayName ? displayName.split(/\s+/)[0]! : ""
    const recentRoleTitle = str(tags.recentRoleTitle)
    const recentCompany = str(tags.recentCompany)
    const workHistorySummary = str(tags.workHistorySummary)

    // SENIORITY ANCHOR — name the LEVEL from the canonical stage + years, never "experienced".
    // Collapse a 2-wide yoe range to its MIDPOINT for the pitch (a range reads as hedging; keep the
    // raw range only for matching). "~5 yrs" reads as conviction; "~4-6 yrs" reads as "Claire's unsure."
    const careerStage = str(tags.careerStage) // student…senior…staff…founder
    const yoeRange = Array.isArray(tags.yoeRange) ? (tags.yoeRange as unknown[]) : []
    const yoeLo = typeof yoeRange[0] === "number" ? (yoeRange[0] as number) : undefined
    const yoeHi = typeof yoeRange[1] === "number" ? (yoeRange[1] as number) : undefined
    const yoeBit =
      yoeLo != null && yoeHi != null
        ? `~${Math.round((yoeLo + yoeHi) / 2)} yrs`
        : yoeLo != null
          ? `~${yoeLo} yrs`
          : ""
    const levelBits = [careerStage ? careerStage.replace(/_/g, " ") : "", yoeBit].filter(Boolean)

    // INDUSTRY ANCHOR — plain-English, never the raw enum token. relevantIndustry = where they've BEEN.
    const prettyIndustry = (t: string) => t.replace(/_and_/g, " & ").replace(/_/g, " ")
    const industrySector = arr("industrySector").map(str).filter(Boolean).map(prettyIndustry)
    const relevantIndustry = arr("relevantIndustry").map(str).filter(Boolean).map(prettyIndustry)

    // IMPACT NARRATIVE — the field the pitch MUST cite. Prefer root experienceHighlights[];
    // when absent (résumé-only / QR cohort, highlights not yet promoted to root), fall back to the
    // parsedCandidateResumes collection (a SEPARATE collection keyed by an auto-id with userId==X;
    // items carry {company,title,description} and NOT the durationMonths/companyIndustry/companyHqCountry
    // meta). THIS is what fixes skillsImpact + swap-test for the thin/résumé-only cohort (Adam 2026-06-02).
    let highlightsRaw: Array<Record<string, unknown>> = Array.isArray(data.experienceHighlights)
      ? (data.experienceHighlights as Array<Record<string, unknown>>)
      : []
    if (!highlightsRaw.some((h) => str(h?.description))) {
      try {
        const parsedSnap = await db
          .collection("parsedCandidateResumes")
          .where("userId", "==", userId)
          .orderBy("createdAt", "desc")
          .limit(1)
          .get()
        const parsed = (parsedSnap.docs[0]?.data() ?? {}) as Record<string, unknown>
        const exps = Array.isArray(parsed.experiences)
          ? (parsed.experiences as Array<Record<string, unknown>>)
          : []
        if (exps.some((e) => str(e?.description))) {
          // {company,title,description}; meta fields absent → the ownedLines mapper just omits them
          // (the `meta` join filters falsy) and roleCountries stays empty (usSilenceActive then leans
          // on visaStatus only). No schema change needed downstream.
          highlightsRaw = exps
        }
      } catch {
        /* best-effort — keep root highlights (possibly empty) on any read error (missing composite
           index, stub db in evals, etc.) → the pitch degrades to the honest-shape opener, never crashes */
      }
    }
    const ownedLines = highlightsRaw
      .filter((h) => str(h?.description)) // only roles that carry a real impact description
      .slice(0, 2)
      .map((h) => {
        const head = [str(h.title), str(h.company)].filter(Boolean).join(" @ ")
        const meta = [
          typeof h.durationMonths === "number"
            ? `${Math.round(((h.durationMonths as number) / 12) * 10) / 10}yr`
            : "",
          str(h.companyIndustry) ? prettyIndustry(str(h.companyIndustry)) : "",
        ]
          .filter(Boolean)
          .join(", ")
        return `${head}${meta ? ` (${meta})` : ""} — ${str(h.description)}`
      })

    // GUARDRAIL SIGNAL (NEVER in the pitch) — lets the US-silence guardrail actually FIRE.
    // visaStatus + whether role locations differ from the saved US targets.
    const visaStatus = str(tags.visaStatus) // citizen | permanent_resident | sponsor_needed | other
    const roleCountries = Array.from(
      new Set(highlightsRaw.map((h) => str(h.companyHqCountry)).filter(Boolean)),
    )
    const targetLocsForGuard = arr("targetLocations").map(str).filter(Boolean)
    const usTargets = targetLocsForGuard.some((l) =>
      /united_states|remote|new_york|san_francisco|usa|us\b/i.test(l),
    )
    const nonUsRoles = roleCountries.some((c) => !/united states|usa|^us$/i.test(c))
    const usSilenceActive = visaStatus === "sponsor_needed" || (usTargets && nonUsRoles)

    const skillNames = arr("skills")
      .map((s) => (typeof s === "string" ? s : str((s as Record<string, unknown> | null)?.name)))
      .filter(Boolean)
      .slice(0, 5)

    // FRESH CURRENT ROLE (Adam 2026-06-04): the derived `tags.recentRoleTitle` cache LAGS a LinkedIn
    // refresh — live, the tag still said "Software Engineer Intern" while experienceHighlights[0] was
    // "Senior Software Engineer" (currentRole=true, Feb 2026), so the opener tripped and called him an
    // intern. Source the current role from the FRESHEST signal — experienceHighlights — not the stale
    // tag: prefer the currentRole=true highlight, else the latest by startDate; fall back to the tag only
    // when no highlight carries a role. Universal fix (every returning user whose LinkedIn outpaced their
    // résumé-derived tag), and it never invents — it reads a structured field the parser already set.
    const roleStartMs = (h: Record<string, unknown>): number => {
      const s = str(h?.startDate)
      const t = s ? Date.parse(s) : NaN
      return Number.isNaN(t) ? -Infinity : t
    }
    const roledHighlights = highlightsRaw.filter((h) => str(h?.title) || str(h?.company))
    const currentHighlight =
      roledHighlights.find((h) => h?.currentRole === true) ??
      [...roledHighlights].sort((a, b) => roleStartMs(b) - roleStartMs(a))[0]
    const freshRecentTitle =
      currentHighlight && str(currentHighlight.title) ? str(currentHighlight.title) : recentRoleTitle
    const freshRecentCompany =
      currentHighlight && str(currentHighlight.company) ? str(currentHighlight.company) : recentCompany

    // CANARY-GATED enriched pitch context (Adam 2026-06-02): the richer pitch evidence
    // (grounded level, industry arc, OWNED outcomes, US-silence guardrail) only ships to
    // dev/canary users for now — the proactive-pitch OPENER that exploits it (PART 2) is
    // still in review. Normal users keep the original compliment context (legacyResumeBits)
    // so this deploy does NOT change their greeting. Widen via CANARY_UIDS when PART 2 ships.
    const enrichedResumeBits = [
      firstName ? `first name: ${firstName}` : "",
      // SENIORITY: name the level from THIS, grounded — never the word "experienced".
      levelBits.length ? `level (name it from THIS, grounded): ${levelBits.join(", ")}` : "",
      // INDUSTRY: plain-English domain anchor — never optional, even when work history is thin.
      industrySector.length ? `industry / domain (say in plain english): ${industrySector.join(", ")}` : "",
      relevantIndustry.length ? `industries they've worked in (the arc): ${relevantIndustry.join(", ")}` : "",
      // CAREER ARC — prose, the through-line.
      workHistorySummary ? `work history (the career arc): ${workHistorySummary}` : "",
      // IMPACT — the OWNED outcomes. Bubble 1 MUST cite one of these (with its number if present).
      ownedLines.length
        ? `what they OWNED (CITE ONE verbatim-ish in bubble 1, with its number): ${ownedLines.join(" | ")}`
        : "",
      freshRecentTitle || freshRecentCompany
        ? `most recent: ${[freshRecentTitle, freshRecentCompany].filter(Boolean).join(" @ ")}`
        : "",
      skillNames.length ? `top skills (reference, NOT the pitch): ${skillNames.join(", ")}` : "",
      // GUARDRAIL-ONLY line — the pitch must NEVER surface this; it only gates the US-silence rule.
      usSilenceActive
        ? `US-SILENCE GUARDRAIL = ACTIVE (work auth / non-US roles): never mention visa, sponsorship, relocation, or "based abroad" — target the saved US locations and frame the US ambition as a strength.`
        : "",
    ].filter(Boolean)
    // The original (pre-pitch) compliment context — what ALL non-canary users still get.
    const legacyResumeBits = [
      firstName ? `first name: ${firstName}` : "",
      workHistorySummary ? `work history (use THIS for the compliment): ${workHistorySummary}` : "",
      freshRecentTitle || freshRecentCompany
        ? `most recent: ${[freshRecentTitle, freshRecentCompany].filter(Boolean).join(" @ ")}`
        : "",
      skillNames.length ? `top skills (reference, NOT the compliment): ${skillNames.join(", ")}` : "",
    ].filter(Boolean)
    const resumeBits = isCanaryUser(userId) ? enrichedResumeBits : legacyResumeBits
    const resumeLine = resumeBits.length
      ? `Candidate résumé on file (use it to personalize — greet by first name, compliment what they DID from work history): ${resumeBits.join("; ")}`
      : ""

    const roles = arr("targetRoleFunction").map(str).filter(Boolean)
    const avoid = arr("negativeRoleFunction").map(str).filter(Boolean)
    const jobType = arr("targetJobType").map(str).filter(Boolean)
    const locations = arr("targetLocations").map(str).filter(Boolean)
    const prefsLine =
      !roles.length && !avoid.length && !jobType.length && !locations.length
        ? "Saved matcher preferences (canonical pa-users.tags): none set yet."
        : [
            "Saved matcher preferences — READ THESE when asked what's saved (this IS the matcher input):",
            roles.length ? `roles: ${roles.join(", ")}` : "",
            avoid.length ? `avoiding: ${avoid.join(", ")}` : "",
            jobType.length ? `job type: ${jobType.join(", ")}` : "",
            locations.length ? `locations: ${locations.join(", ")}` : "",
          ]
            .filter(Boolean)
            .join("; ")

    // Resume-less onboarding (QR / iMessage-first): when NO résumé is on file and
    // onboarding isn't done, surface a tokenized upload link so Claire can nudge it
    // ONCE (résumé is OPTIONAL FOREVER — never a gate). Token is reused across turns.
    let uploadLinkLine = ""
    // A first name alone makes `resumeLine` truthy (it always leads with "first name: …"),
    // so `Boolean(resumeLine)` over-reports "has résumé" for EVERY named candidate and wrongly
    // suppresses the no-résumé upload + LinkedIn-connect offers (WS-1a). Gate on ACTUAL résumé
    // evidence: a stored artifact OR résumé-derived content (work history, recent role/company,
    // skills, owned highlights) — never the displayName-only case.
    const hasResumeContent = Boolean(
      workHistorySummary || recentRoleTitle || recentCompany || skillNames.length || ownedLines.length,
    )
    const hasResumeOnFile = hasResumeContent || Boolean(str(data.latestResumeArtifactId))
    const onboardingDone = data.onboardingStatus === "complete" || data.onboardingStatus === "completed"
    if (!hasResumeOnFile && !onboardingDone) {
      try {
        const { getOrIssueCvUploadLink } = await import("../qr-onboarding/upload-token.js")
        const link = await getOrIssueCvUploadLink(db, userId)
        if (link) {
          uploadLinkLine = `Resume upload link (OPTIONAL nudge — mention once, never require): ${link}`
        }
      } catch {
        /* best-effort — omit the nudge on any failure */
      }
    }

    // WS-1(a) PHONE DUAL-PATH (Adam 2026-06-03): "super easy — résumé OR LinkedIn login,
    // whichever; résumé OPTIONAL if LinkedIn." Under the SAME no-résumé / onboarding-not-done
    // guard as the upload link (+ canary), surface a one-tap LinkedIn connect link so Claire can
    // offer it as the alternative to the résumé. EXACT precedent = uploadLinkLine above. The
    // connect-token is reused across turns (getOrIssueLinkedinConnectLink), and the candidate's
    // phone is carried on the token so the connect CF can sms: reroute back into THIS thread.
    // Canary-gated (dev phones only) so non-canary CONTEXT stays byte-identical.
    let connectLinkLine = ""
    // The offer is gated by the SAME coherent "we don't have their stuff yet" signal as the upload
    // link: no résumé on file AND onboarding not done (+ canary). That already covers the only case
    // a re-offer would be wrong — a LinkedIn-enriched candidate is `onboardingDone` so this stays "".
    // NOTE (2026-06-04): do NOT add a separate candidateHasLinkedinBind gate here — it was redundant
    // with !onboardingDone and created an INCONSISTENT state: a phone with a lingering pa-candidate-
    // handles linkedin row (e.g. a cold reinit that cleared the profile but not the handle) read as
    // "bound", suppressed the offer, yet the opener has no known-user branch so it fell through to the
    // stranger "drop your résumé" default. Re-login RECOGNITION belongs in the OAuth callback
    // (connectLinkedinProspectViaOAuth), not in this cold-opener line.
    // UNGATED 2026-06-16 (Adam: "LinkedIn login is proven; make it the universal
    // path"): the one-tap LinkedIn connect link is surfaced for ALL users (the
    // isCanaryUser gate is removed). The !hasResumeOnFile && !onboardingDone guard
    // stays — a LinkedIn-enriched candidate is onboardingDone so no wrong re-offer.
    if (!hasResumeOnFile && !onboardingDone) {
      try {
        const { getOrIssueLinkedinConnectLink } = await import("../linkedin-connect/connect-token.js")
        const link = await getOrIssueLinkedinConnectLink(db, userId, toE164)
        if (link) {
          connectLinkLine =
            `LinkedIn one-tap connect link = ${link} — when they have no résumé or would rather use LinkedIn, paste ` +
            "THIS exact link into your reply for them to tap (it imports their LinkedIn automatically). CRITICAL: " +
            "do NOT ask them to send/paste/share THEIR OWN LinkedIn URL or profile — that is wrong; you send " +
            "the link above to them. Optional, never required, never repeated."
        }
      } catch {
        /* best-effort — omit the offer on any failure (matches uploadLink pattern) */
      }
    }

    return [resumeLine, prefsLine, uploadLinkLine, connectLinkLine].filter(Boolean).join("\n")
  } catch {
    return ""
  }
}

export interface RunClaireTurnDeps {
  db: Firestore
  transport: ClaireTransport
  judgeModel?: string
  jobId?: string
  /** find-match backend; Wave B injects makeV16FindMatch(db). */
  findMatch?: ClaireToolContext["findMatch"]
  log?: (event: string, payload?: Record<string, unknown>) => void
  nowIso?: () => string
  /** deterministic mode from durable process state (default "triage"). */
  mode?: ClaireMode
  pendingStep?: string
  /** onboarding: the CURRENT question text — re-asked when the candidate didn't answer. */
  currentStep?: string
  /** per-turn process store seeded from durable state (mode-selector); the FSM tools read/write it. */
  processStore?: ProcessSessionStore
  /** onboarding: the slot the inbound answers (the agent records it via record_onboarding_answer). */
  onboardingSlot?: string
  /** onboarding: false on the kickoff turn (ask only); true once a question was asked. */
  awaitingAnswer?: boolean
  /** prescreen: qId → DIRECTION question text (mode-selector seeds from config). */
  prescreenPrompts?: Record<string, string>
  /** prescreen: qId → judge rubric the score tool grades against (mode-selector seeds from config). */
  judgeContext?: Record<string, string>
  /** prescreen: résumé + prior-session context for grounded probing (mode-selector builds it). */
  prescreenContext?: string
  /** prescreen: bare résumé snippet handed to the JUDGE (credits concrete, résumé-consistent answers). */
  prescreenResumeSnippet?: string
  /** prescreen: the REAL pa-prescreen-sessions doc id (for score write-back + the terminal-action fire). */
  prescreenSessionId?: string
  /** prescreen: the REAL pa-jobs job id (shared-answer write provenance). SPEC §6. */
  prescreenJobId?: string
  /** prescreen: qId → authored sharedKey (cross-session shared-answer write key). SPEC §5a. */
  prescreenSharedKeys?: Record<string, string>
  /** prescreen: qId → reference hook for a carried (pre-answered) shared question — the agent references
   *  the prior answer instead of re-asking it (SPEC §7 / decision 3). */
  prescreenCarriedReferences?: Record<string, string>
  /** cv-parsed re-entry (Adam 2026-06-02): the résumé just finished parsing → PITCH from the freshly
   *  loaded profile, then offer find_match. Set by cutover for the resume_parse_completed event (canary). */
  postParsePitch?: boolean
  /** cv-parsed re-entry (BLOCKER 2): the candidateProfileSummary the cutover read off the handoff
   *  context — threaded into the turn context so the pitch never reads the marker as an empty résumé. */
  postParsePitchSummary?: string
  /** résumé-drop turn: an inline résumé media is present + not yet parsed → ACK + HOLD (no pitch, no
   *  find_match this turn; the parse runs async, the pitch fires on the resume_parse_completed re-entry). */
  resumeJustDropped?: boolean
  /** WS-1(b): enrichment (résumé parse / LinkedIn import) kicked on an EARLIER turn is STILL running
   *  (between the ack and the resume_parse_completed event). Set by cutover from the durable
   *  enrichmentInFlight marker (canary). Drives the "still pulling your info, one sec" turn directive. */
  enrichmentInFlight?: boolean
  /** WS-3(b): this turn MAY carry the occasional "connect Gmail on wekruit.com" nudge (canary). */
  gmailNudge?: boolean
  /** LINKEDIN-DONE re-entry (Adam 2026-06-03): they just logged in with LinkedIn (identity verified,
   *  name known) but OAuth can't pull work history → directive: ack by name + ask for résumé/URL. */
  linkedinJustConnected?: boolean
  /** CANONICAL STEP 4 (Adam-LOCKED): conditional pre-match location+salary ask (set by cutover from the
   *  mode-selector only-if-both-missing gate). Drives the one short pre-match ask; defers find_match. */
  locationSalaryAsk?: boolean
  /** WARM RETURNING GREETING (Adam 2026-06-05): a KNOWN/returning candidate sent a cold greeting. Set by
   *  cutover from the mode-selector cold-start triage short-path. Drives the warm-greet-back directive —
   *  no offer kickoff, no onboarding question. */
  warmReturningGreeting?: boolean
  /** ENTRY POSTURE (Adam 2026-07-20): tone overlay keyed off the entry page (pa-users.source, set by
   *  mode-selector). yc_startup_school = founder-scene chat, no pushing, notify-on-match promise.
   *  Persona-level (NOT a deterministic pattern) — survives the anti-silence fallback strip. */
  entryPosture?: "yc_startup_school"
  /** YC EVENT INTAKE (Adam 2026-07-21): event-QR guided mini-intake — next free-text slot to
   *  ask + whether the LinkedIn one-tap offer should lead this turn. `kickoff` = first-contact
   *  turn → the deterministic event opener below owns the send (no model). */
  ycEventIntake?: {
    next: "building" | "wants_to_meet"
    offerLinkedin: boolean
    kickoff?: boolean
    nudgeLinkedin?: boolean
  }
  /** PRESCREEN-SEAM RETENTION HANDOFF (Adam 2026-06-05): the post-prescreen-terminal / retention context
   *  (buildCandidateContext.prescreenContextText) — prior screens + terminals + real reasons + borderline
   *  gaps + capture/offer-other-roles directive. Set by cutover for a post-terminal/retention turn that
   *  the prescreen handler deferred to thin (canary-gated, dev cohort only). Rendered in ANY mode. */
  candidateContext?: string
  /** COLD OFFER-FIRST KICKOFF (Adam 2026-06-03): a brand-new candidate with NO profile data. The turn
   *  sends a DETERMINISTIC offer (connect LinkedIn = recommended / drop résumé in chat / upload on site)
   *  and NO onboarding question — "pitch first", we don't interrogate; the pitch fires after they
   *  connect/drop. Set by mode-selector on the cold bootstrap turn. */
  offerFirstKickoff?: boolean
  /**
   * ANTI-SILENCE FALLBACK marker (Adam 2026-06-04, "Hi → no response, feels glitchy").
   *
   * Set ONLY by runClaireTurn's own internal re-entry when a DETERMINISTIC pattern's bubbles were
   * ALL suppressed by the cross-turn near-dup dedup (deliverBubblesEx → suppressedAll). The re-entry
   * runs the agent ONE more time on the plain user input — with every deterministic directive
   * STRIPPED (no offerFirst / postParsePitch / enrichmentInFlight / linkedinJustConnected /
   * locationSalaryAsk / gmailNudge), plain "triage" mode — so the model composes a fresh, contextual,
   * non-duplicate reply.
   *
   * LOOP GUARD: this flag is the hard cap. When set, runClaireTurn delivers the fallback's bubbles and
   * NEVER triggers another fallback (even if the fallback's own bubbles also dedup to empty). At most
   * one extra agent turn per inbound, ever. Production callers (cutover) NEVER set it.
   */
  isSuppressionFallback?: boolean
  /**
   * TEST SEAM (production omits it → real SDK `run()`): wraps the one @openai/agents `run(agent, …)`
   * call so a unit test can drive the turn loop OFFLINE — returning canned `finalOutput.messages` per
   * call. This is the ONLY way to exercise the anti-silence fallback deterministically (the SDK
   * dynamic-requires @openai/agents and hits a real model otherwise). Defaults to the real `run`.
   */
  runAgent?: (
    agent: unknown,
    runInput: unknown,
    opts: { session: unknown; maxTurns: number },
  ) => Promise<{
    finalOutput?: unknown
    rawResponses?: ReadonlyArray<unknown>
    /** the SDK RunResult's ordered run items — mapped to toolCalls (de-blackbox). Tests may omit it. */
    newItems?: ReadonlyArray<unknown>
  }>
  /**
   * TEST SEAM (production omits it): fired once with the TRACKED transport right after ctx is built, so a
   * unit test can faithfully simulate a TOOL that delivers mid-run via ctx.transport.sendText (e.g.
   * find_match's deliverRecBubbles). Those sends go through the SAME tracked wrapper the never-silent
   * backstop counts (sentTextCount) — which is exactly how production find_match registers — so a test can
   * prove the backstop does NOT fire after a real rec delivery. Never set in production code.
   */
  onToolTransportReady?: (transport: ClaireTransport) => void
}

/**
 * The QR opener is a phone-bind handshake — the bind already ran upstream
 * (resolveInboundUserId). The raw text still carries the INTERNAL userId; if it reaches the LLM the
 * greeting echoes the id as the candidate's name (Adam 2026-06-01: "why it's hey with my user id??
 * not my name"). Reduce it to the bare prefix so the agent greets résumé-aware with ZERO id leak.
 *
 * Two opener forms are stripped: the current verification-code phrasing
 * ("Hi, WeKruit, my verification code is <candidateId>") AND the legacy
 * "Hello, WeKruit! <candidateId>" form (back-compat — in-flight QR links still emit it). The
 * "WeKruit_<jobId>_<userId>_Apply" job token (prescreen kickoff) starts with neither prefix, so it
 * passes through untouched.
 */
export function sanitizeInboundForLlm(text: string): string {
  const trimmed = text.trimStart()
  // CV-PARSED RE-ENTRY (Adam 2026-06-02): the body of the resume_parse_completed runtime event is the
  // generic handoff directive '[system-event:cv_ingest:resume_parse_completed]\n…'. The LLM must NOT
  // read raw system text (and must NOT treat it as the candidate speaking). The real 'pitch now'
  // instruction is carried by the postParsePitch PROMPT directive + the freshly-loaded globalContext,
  // NOT by this body. Collapse it to a single neutral, non-empty marker (an empty user turn confuses
  // the SDK): zero raw system wording, zero uid leak. Body-format routing of a system-generated
  // marker — NOT tagging of candidate free text, so the no-regex-in-tagging rule does not apply.
  if (trimmed.startsWith("[system-event:") && trimmed.includes("resume_parse_completed"))
    return "[resume just finished parsing]"
  // LINKEDIN-DONE RE-ENTRY (2026-06-03): the candidate-emitted sms deep-link body is
  // "I've done LinkedIn submission <connectToken>". The trailing token is an opaque server-only
  // connect token (NOT PII, NOT a uid) — it MUST NOT reach the LLM (the branch's own contract).
  // Collapse to a neutral, token-free confirmation; the LinkedIn enrichment fires the same
  // resume_parse_completed event that drives the pitch (postParsePitch), so the LLM needs only
  // the plain "they connected LinkedIn" signal here. Body-format routing, not text→enum tagging.
  if (trimmed.startsWith(LINKEDIN_DONE_OPENER_PREFIX)) return "I've connected my LinkedIn."
  // The QR handshake opener must be reduced to a NEUTRAL GREETING for the LLM — never the raw
  // phrasing. Returning the bare "Hi, WeKruit, my verification code is" made the model read it as
  // a real login/verification-code request and reply "what's the full code? where are you signing
  // in?" (live regression 2026-06-02). The onboarding kickoff is driven by mode/FSM, not this text,
  // so a plain greeting is all the LLM needs (and strips the internal token → no uid leak).
  // Current built form (2026-06-02 #2): "Hi, WeKruit! <trackingId>" — a plain start greeting.
  if (trimmed.startsWith(HI_WEKRUIT_OPENER_PREFIX)) return HI_WEKRUIT_OPENER_PREFIX
  // Back-compat forms still in the wild from prior QR prints.
  if (trimmed.startsWith(VERIFICATION_CODE_OPENER_PREFIX)) return HI_WEKRUIT_OPENER_PREFIX
  if (trimmed.startsWith(HELLO_WEKRUIT_OPENER_PREFIX)) return HELLO_WEKRUIT_OPENER_PREFIX
  return text
}

/**
 * The inbound turn entry the cutover calls behind paThinClaireEnabled.
 * Always replies (timeout + grounded fallback); never hangs (RC2).
 */
export async function runClaireTurn(
  input: ClaireTurnInput,
  deps: RunClaireTurnDeps,
): Promise<ClaireRunResult> {
  const log = deps.log ?? (() => {})
  const tracked = trackTransport(deps.transport)
  const lang: ClaireLang = input.lang ?? "en"
  const ctx: ClaireToolContext = {
    db: deps.db,
    userId: input.userId,
    sessionId: input.sessionId,
    lang,
    transport: tracked.transport,
    judgeModel: deps.judgeModel ?? CLAIRE_MODEL,
    jobId: deps.jobId,
    ...(input.toE164 ? { toE164: input.toE164 } : {}),
    log,
    nowIso: deps.nowIso ?? (() => new Date().toISOString()),
    findMatch: deps.findMatch,
  }
  // Inject the per-turn process store seeded from durable state (mode-selector) so the onboarding/
  // prescreen FSM tools enforce order + write through to the canonical interface.
  if (deps.processStore) (ctx as ProcessToolContext).processStore = deps.processStore
  // prescreen: the judge rubric + résumé snippet ride on ctx (mirrors processStore), and the REAL
  // pa-prescreen-sessions doc id is threaded so the score tool writes the per-question score back to
  // the live session (resume + memory read it) — ctx.sessionId is the iMessage session, NOT this id.
  if (deps.judgeContext) (ctx as ProcessToolContext).prescreenJudgeContext = deps.judgeContext
  if (deps.prescreenResumeSnippet) (ctx as ProcessToolContext).prescreenResumeSnippet = deps.prescreenResumeSnippet
  if (deps.prescreenSessionId) (ctx as ProcessToolContext).prescreenSessionId = deps.prescreenSessionId
  // SPEC §6 — the shared-answer write seam reads jobId + qId→sharedKey off ctx to persist a finalized
  // shared question's answer to the GLOBAL cross-session store (pa-users.prescreenSharedAnswers).
  if (deps.prescreenJobId) (ctx as ProcessToolContext).prescreenJobId = deps.prescreenJobId
  if (deps.prescreenSharedKeys) (ctx as ProcessToolContext).prescreenSharedKeys = deps.prescreenSharedKeys

  // TEST SEAM: hand the tracked transport to a test so it can simulate a mid-run tool delivery through the
  // exact wrapper the never-silent backstop counts (production never sets onToolTransportReady). Fail-open.
  try { deps.onToolTransportReady?.(ctx.transport) } catch { /* test hook must never break a turn */ }

  // Tier-1 reflex: mark-read (real read receipt) + typing on EVERY inbound. FIRE-AND-FORGET —
  // these make network calls and awaiting them added seconds to the first reply. They run in
  // parallel with loadGlobalContext + run(); run() outlives them so the handler flushes them.
  void markReadReflex(ctx).catch((e) => log("markReadReflex_failed", { err: String(e) }))

  const globalContext = await loadGlobalContext(deps.db, input.userId, input.toE164)

  // COLD OFFER-FIRST KICKOFF (Adam 2026-06-03: "just ask them to connect linkedin directly, or drop the
  // résumé to chat or résumé on website, but LINKEDIN WILL BE RECOMMENDED" + "the first question
  // shouldn't show up… we PITCH first"). A brand-new candidate (no profile data) gets a DETERMINISTIC
  // offer and NO onboarding question — the pitch fires after they connect/drop (resume_parse_completed /
  // linkedin re-entry). Deterministic for the same reason as the LINKEDIN-OFFER NET: the one-tap offer
  // is the whole "super easy to start" thesis and must REACH the candidate verbatim, not depend on the
  // model (which reliably reverts to asking the onboarding question). Short-circuits the model turn.
  // The deterministic offer-first short-circuit must NEVER run on the anti-silence fallback re-entry —
  // it is itself a deterministic pattern (the class the fallback exists to escape).
  if (deps.offerFirstKickoff && deps.isSuppressionFallback !== true) {
    // LINKEDIN-ONLY COLD OPENER (Adam 2026-06-16: "LinkedIn login is proven; make
    // it the universal path"). The cold opener offers ONLY the one-tap LinkedIn
    // login link — the "drop your résumé in the chat" / "upload on the site" lines
    // are REMOVED. The connect link is now ungated upstream (loadGlobalContext, no
    // isCanaryUser), so it surfaces for ALL brand-new candidates.
    let connectUrl = /LinkedIn one-tap connect link = (https:\/\/\S+) —/.exec(globalContext)?.[1] ?? ""
    // FALLBACK: if no per-user connect link surfaced (token issue / globalContext
    // miss), still present a LinkedIn login so the opener is never link-less — the
    // whole point is LinkedIn is ALWAYS present. Last-resort = the canonical
    // candidate-domain connect surface (resolves identity on the page).
    if (!connectUrl) connectUrl = CONNECT_LINKEDIN_LINK_BASE
    // INVARIANT (Adam 2026-06-05: "no legacy target_role EVER on a cold open"):
    // once mode-selector picks offerFirstKickoff, this turn ALWAYS sends the
    // deterministic offer and NEVER falls through to the model's onboarding
    // kickoff (the legacy target_role question). ONE atomic message: back-to-back
    // Sendblue POSTs arrive out of order on-device, so a single send is the only
    // ordering guarantee.
    const parts: string[] = [
      "hey! i'm claire, your recruiter at wekruit 👋 so glad you're here.",
      `quickest way to get going — log in with LinkedIn and i'll pull your experience for you 👉 ${connectUrl}`,
      "then i'll get to work matching you and pitching you straight to the hiring managers we've got connections with 🙌",
      // SMS compliance disclosure (Adam 2026-06-10 "Stop to stop"): the FIRST-contact
      // message carries the opt-out line. Only this cold opener — not every chat reply.
      // The deterministic keyword gate lives in claire-agent/stop-gate.ts.
      "reply STOP anytime to opt out.",
    ]
    const message = parts.join("\n\n")
    await deps.transport.sendText(message).catch((e) => log("offer_first.send_failed", { err: String(e) }))
    log("offer_first_kickoff_sent", {
      hasConnect: true,
      bubbles: 1,
    })
    return { finalText: message, toolCalls: [], deliveredViaTool: true }
  }

  // YC EVENT KICKOFF (Adam 2026-07-21; deterministic per the 2026-07-22 live probe: the model turn
  // dropped the LinkedIn offer, mis-recorded the opener as the 'building' answer, and tapback-swallowed
  // a decline). First contact from the event QR → ONE atomic deterministic message: event greeting +
  // LinkedIn one-tap link + the first intake question + STOP disclosure. Mirrors offerFirstKickoff.
  if (deps.ycEventIntake?.kickoff && deps.isSuppressionFallback !== true) {
    let connectUrl = /LinkedIn one-tap connect link = (https:\/\/\S+) —/.exec(globalContext)?.[1] ?? ""
    if (!connectUrl) connectUrl = CONNECT_LINKEDIN_LINK_BASE
    const parts: string[] = [
      "hey!! welcome 🎉 i'm claire — i match startup school folks with founders who are building + hiring.",
      ...(deps.ycEventIntake.offerLinkedin
        ? [
            `quick unlock so founders see your real background: log in with LinkedIn (one tap) 👉 ${connectUrl}`,
            "while that's cooking — what are you building right now?",
          ]
        : ["so — what are you building right now?"]),
      "reply STOP anytime to opt out.",
    ]
    const message = parts.join("\n\n")
    // paced:true → the outbox posts immediately after the typing indicator (skips its
    // length-scaled dwell). First contact at the event booth must feel instant — the long
    // kickoff body was drawing the full dwell (~12s outbox-side, Adam live test 2026-07-22).
    // Single bubble → none of the multi-bubble reorder risk that bans paced on the pitch.
    await deps.transport
      .sendText(message, { paced: true })
      .catch((e) => log("yc_event_kickoff.send_failed", { err: String(e) }))
    log("yc_event_kickoff_sent", { offerLinkedin: deps.ycEventIntake.offerLinkedin })
    return { finalText: message, toolCalls: [], deliveredViaTool: true }
  }

  // ANTI-SILENCE FALLBACK (Adam 2026-06-04): on the re-entry after a deterministic pattern was fully
  // suppressed, run a PLAIN agent turn — every deterministic directive STRIPPED, plain triage mode — so
  // the model writes a fresh, contextual, non-duplicate reply instead of replaying the dropped pattern.
  const fallback = deps.isSuppressionFallback === true
  // Captured so the provider-fallback retry (catch block below) can REBUILD the same agent with only
  // the model swapped (modelOverride: CLAIRE_FALLBACK_MODEL) — identical mode/tools/guardrails/context.
  const buildOpts: BuildClaireAgentOptions = {
    mode: fallback ? "triage" : (deps.mode ?? "triage"),
    lang,
    // DEDICATED YC LANE — build the agent WITHOUT any job-recommendation tools for YC
    // people-matching users. Survives the fallback strip: a YC person must NEVER be handed job
    // tools, even on the anti-silence retry (that's why it's NOT gated on `fallback`).
    ycPeopleMode: deps.entryPosture === "yc_startup_school",
    pendingStep: fallback ? undefined : deps.pendingStep,
    currentStep: fallback ? undefined : deps.currentStep,
    globalContext,
    onboardingSlot: fallback ? undefined : deps.onboardingSlot,
    awaitingAnswer: fallback ? undefined : deps.awaitingAnswer,
    prescreenPrompts: fallback ? undefined : deps.prescreenPrompts,
    judgeContext: fallback ? undefined : deps.judgeContext,
    prescreenContext: fallback ? undefined : deps.prescreenContext,
    postParsePitch: fallback ? undefined : deps.postParsePitch,
    postParsePitchSummary: fallback ? undefined : deps.postParsePitchSummary,
    resumeJustDropped: fallback ? undefined : deps.resumeJustDropped,
    enrichmentInFlight: fallback ? undefined : deps.enrichmentInFlight,
    gmailNudge: fallback ? undefined : deps.gmailNudge,
  }
  const agent = buildClaireAgent(ctx, buildOpts)
  const session = makeClaireSession({
    db: deps.db,
    sessionId: input.sessionId,
    userId: input.userId,
  })

  // Strip the id-bearing "Hello, WeKruit! <candidateId>" handshake before it reaches the LLM (see
  // sanitizeInboundForLlm) — otherwise the greeting echoes the internal userId as the candidate's name.
  const turnText = sanitizeInboundForLlm(input.text)

  // 2B — the per-turn DYNAMIC context (canary tapback / globalContext / prescreenContext /
  // non-onboarding pendingStep). Injected as a TRAILING {role:'system'} item AFTER the
  // Session-replayed transcript so the byte-stable static head + the growing transcript cache,
  // and only this small tail is uncached. FirestoreSession.addItems skips system+user items, so
  // this ephemeral context is NEVER written to the durable transcript (it can't pollute the
  // next turn's cached prefix). Mirrors the proven default-path shape (buildAgentsInputItems).
  // On the anti-silence fallback turn, the per-turn deterministic directives are ALSO stripped — they
  // are exactly what produced the suppressed-all bubbles. The fallback turn carries only the plain
  // globalContext so the model answers the user's actual message fresh.
  const turnContext = buildClaireTurnContext({
    mode: fallback ? "triage" : (deps.mode ?? "triage"),
    lang,
    canary: isCanaryUser(ctx.userId),
    globalContext,
    pendingStep: fallback ? undefined : deps.pendingStep,
    prescreenContext: fallback ? undefined : deps.prescreenContext,
    // BLOCKER 2: surface the parsed-profile summary on the post-parse pitch turn (belt-and-suspenders
    // vs a loadGlobalContext read that raced the parse write) so the model never reads the marker empty.
    postParsePitch: fallback ? undefined : deps.postParsePitch,
    postParsePitchSummary: fallback ? undefined : deps.postParsePitchSummary,
    // WS-1(b): the enrichment-in-flight directive is a PER-TURN signal (turn-specific durable marker),
    // so it lives in the turn context (highest-salience trailing system item), NOT the cached head.
    enrichmentInFlight: fallback ? undefined : deps.enrichmentInFlight,
    // WS-3(b): the occasional Gmail-connect nudge is a per-turn directive (cooldown-gated), turn-context only.
    gmailNudge: fallback ? undefined : deps.gmailNudge,
    // LINKEDIN-DONE re-entry directive — per-turn, trailing only (ack by name + ask for résumé/URL).
    linkedinJustConnected: fallback ? undefined : deps.linkedinJustConnected,
    // CANONICAL STEP 4 — per-turn conditional pre-match ask (location+salary), trailing only.
    locationSalaryAsk: fallback ? undefined : deps.locationSalaryAsk,
    // WARM RETURNING GREETING — per-turn directive for a known candidate's cold greeting, trailing only.
    warmReturningGreeting: fallback ? undefined : deps.warmReturningGreeting,
    // ENTRY POSTURE — persona tone, NOT a deterministic pattern: survives the fallback strip so the
    // fresh reply still speaks in the entry page's voice (yc: no pushing, notify-on-match).
    entryPosture: deps.entryPosture,
    // YC EVENT INTAKE — a deterministic guided pattern: stripped on the anti-silence fallback.
    ycEventIntake: fallback ? undefined : deps.ycEventIntake,
    // PRESCREEN-SEAM RETENTION HANDOFF (Adam 2026-06-05): the post-prescreen-terminal / retention block.
    // Per-turn, trailing only, rendered in ANY mode. Stripped on the anti-silence fallback re-entry.
    candidateContext: fallback ? undefined : deps.candidateContext,
  })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const runInput: any[] = []
  if (turnContext) runInput.push({ type: "message", role: "system", content: turnContext })
  runInput.push({ type: "message", role: "user", content: turnText })

  // RunConfig naming (de-blackbox): name + group the exported traces, attach the userId as trace
  // metadata, and — IMPORTANTLY — set traceIncludeSensitiveData:false so the raw candidate message
  // bodies are NOT shipped to OpenAI's tracing backend (we want the span TREE — which tools ran, in
  // what order, guardrail decisions — not the PII). groupId=sessionId threads a conversation's turns
  // together in the trace UI. Merged into the run opts below.
  // TURN-START STAMP — captured BEFORE run() (it both feeds the cross-turn dedup below AND anchors the
  // per-turn trace). Defined here so runConfig's deterministic traceId can derive from it.
  const turnStartedAtIso = new Date().toISOString()
  // DETERMINISTIC PER-TURN traceId (T2): see makeTurnTraceId. Printable + stable, so the trace_exported
  // log line (T1, after the flush) bridges a Cloud Logging row → the exact OpenAI trace. groupId=sessionId
  // still threads all of a conversation's turns together in the trace UI.
  const turnTraceId = makeTurnTraceId(input.sessionId, input.userId, turnStartedAtIso)
  const runConfig = {
    workflowName: "claire-turn",
    groupId: input.sessionId,
    traceId: turnTraceId,
    traceMetadata: { userId: input.userId, mode: String(deps.mode ?? "") },
    traceIncludeSensitiveData: false,
  }

  // Default agent-run = the real SDK run(); a test may inject deps.runAgent to drive it offline.
  const runAgent =
    deps.runAgent ??
    ((a: unknown, ri: unknown, opts: { session: unknown; maxTurns: number }) =>
      run(a as never, ri as never, { ...runConfig, ...opts } as never) as Promise<{
        finalOutput?: unknown
        rawResponses?: ReadonlyArray<unknown>
        newItems?: ReadonlyArray<unknown>
      }>)

  let bubbles: string[] = []
  let toolCalls: ClaireToolCall[] = []
  let blocked = false
  let usage: ClaireTurnUsage | undefined
  // SECONDARY (2026-06-20): persist the turn's error state + which model served onto the decision
  // trace so a hiccup/fallback is debuggable straight from Firestore (pa-turns), not only Cloud
  // Logging — this SEV was previously diagnosable ONLY via logs because pa-turns had no error field.
  // servedByModel flips to CLAIRE_FALLBACK_MODEL when the fallback retry produces the reply.
  let servedByModel: string = CLAIRE_MODEL
  let turnErrorCode: string | undefined
  let turnErrorMessage: string | undefined
  // turnStartedAtIso is captured ABOVE (just before runConfig). It is the "cross_turn dedup keeps
  // triggering / silent turn" fix (Adam 2026-06-04): captured BEFORE run() so a tool that delivers
  // mid-run (find_match's role bubbles → outbox → a `pa-outbound` pa-messages row written DURING this
  // turn) is excluded from the cross-turn dedup's recent-sent set. Without it, the model's final bubble
  // restating a just-sent tool message near-dups its OWN send and is suppressed → silent. It is threaded
  // into deliverBubblesEx below AND anchors the per-turn trace id (turnTraceId).
  //
  // Run ONE agent against a freshly-armed timeout race. Extracted so the provider-fallback retry
  // (catch below) can re-run the SAME loop against a rebuilt agent (CLAIRE_FALLBACK_MODEL) without
  // duplicating the race/extract wiring. Each call arms its OWN timer (and clears it on settle) — a
  // shared timer would already be near-elapsed by the retry, robbing the fallback of its full budget.
  const runWith = async (agentToRun: unknown) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const res = (await Promise.race([
        // maxTurns — cost guard against the unbounded agent loop (see resolveClaireMaxTurns). Without
        // it the SDK runs up to 10 turns, each re-sending the full prompt + growing transcript (the
        // 1.2B-token runaway). 2B — array input: [trailing system context (if any), user message].
        runAgent(agentToRun, runInput, { session, maxTurns: resolveClaireMaxTurns() }),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error("claire_run_timeout")), RUN_TIMEOUT_MS)
        }),
      ])) as {
        finalOutput?: unknown
        rawResponses?: ReadonlyArray<unknown>
        newItems?: ReadonlyArray<unknown>
      }
      return res
    } finally {
      if (timer) clearTimeout(timer)
    }
  }
  // 2026-06-10 trust audit (fix 6a) — circuit OPEN (3 run failures in the last 60s on THIS
  // instance) → fast-fail to the fallback copy immediately, no LLM call. Keeps a provider
  // outage from burning 100s timeouts turn after turn while the candidate waits in silence.
  if (isClaireCircuitOpen()) {
    log("claire_circuit_fast_fail", { userId: input.userId })
    turnErrorCode = "claire_circuit_open"
    bubbles = [await resolveHiccupFallbackCopy(deps.db, input.userId, Date.now(), log)]
  } else
  try {
    const res = await runWith(agent)
    // finalOutput is the resolved ClaireReplySchema → { messages: string[] }. Each element is one
    // iMessage bubble; deliverBubbles POSTs them in order. extractBubbles is defensive vs shape drift.
    bubbles = extractBubbles(res?.finalOutput)
    // 2A — sum per-turn token usage (incl cached-prefix tokens) from rawResponses[*].usage. The
    // thin path uses run() directly (NOT @pa/agent-runtime's extractUsage), so we read it here.
    usage = extractClaireUsage(res?.rawResponses)
    // DE-BLACKBOX: capture the ordered tool calls from the SDK RunResult so the return surfaces WHY
    // Claire acted (was the old hardcoded []). Defensive — captureToolCalls never throws.
    toolCalls = captureToolCalls(res?.newItems)
  } catch (e) {
    if (e instanceof InputGuardrailTripwireTriggered) {
      blocked = true
      log("guardrail_tripwire", { userId: input.userId })
      // Crisis → supportive message + hotline. Injection → say nothing.
      const info = (
        e as unknown as { result?: { output?: { outputInfo?: { kind?: string } } } }
      )?.result?.output?.outputInfo
      if (info?.kind === "crisis") {
        const base = "i'm here for you — you're not alone."
        const safe = appendHotlineIfMissing({ reply: base, language: lang }).text.trim()
        if (safe) await deps.transport.sendText(safe).catch(() => {})
      } else {
        await deps.transport.noReply("injection_blocked").catch(() => {})
      }
      // Flush the guardrail span tree (the tripwire decision is exactly what we want exported).
      await forceFlushTraces()
      return { finalText: "", toolCalls: [], deliveredViaTool: true }
    }
    const primaryErr = e instanceof Error ? e.message : String(e)
    const isTimeout = primaryErr === "claire_run_timeout"
    log("claire_run_error", { userId: input.userId, err: primaryErr, model: CLAIRE_MODEL })

    // PROVIDER FALLBACK (2026-06-20): a genuine provider THROW from the primary model (429 / 5xx /
    // APIConnectionError) — NOT a guardrail tripwire (returned above) and NOT the explicit run
    // timeout — gets ONE retry on CLAIRE_FALLBACK_MODEL before the user-visible hiccup copy. A
    // different model on the same OpenAI client dodges a per-model rate-limit / 5xx that just hit the
    // primary, so one provider hiccup no longer = a candidate gets an error message. The timeout path
    // is left exactly as-is (re-running a slow turn would blow the inbound lease, and a timeout is a
    // latency guard, not a provider hiccup). A test may inject deps.runAgent, in which case the same
    // runAgent drives the retry (so the test controls primary-vs-fallback success per call).
    if (!isTimeout) {
      try {
        const fallbackAgent = buildClaireAgent(ctx, {
          ...buildOpts,
          modelOverride: CLAIRE_FALLBACK_MODEL,
        })
        log("claire_run_fallback_retry", { userId: input.userId, model: CLAIRE_FALLBACK_MODEL })
        const res = await runWith(fallbackAgent)
        bubbles = extractBubbles(res?.finalOutput)
        usage = extractClaireUsage(res?.rawResponses)
        toolCalls = captureToolCalls(res?.newItems)
        servedByModel = CLAIRE_FALLBACK_MODEL
        // The fallback served a REAL reply — record the recovered-from error for the trace, but do
        // NOT trip the breaker or stamp the hiccup (the candidate is getting a real answer).
        turnErrorCode = "primary_model_threw_fallback_recovered"
        turnErrorMessage = primaryErr
        log("claire_run_fallback_recovered", { userId: input.userId, model: CLAIRE_FALLBACK_MODEL })
      } catch (e2) {
        // BOTH primary and fallback threw → last-resort hiccup copy (unchanged behavior).
        const fallbackErr = e2 instanceof Error ? e2.message : String(e2)
        log("claire_run_fallback_failed", {
          userId: input.userId,
          err: fallbackErr,
          model: CLAIRE_FALLBACK_MODEL,
        })
        turnErrorCode = "primary_and_fallback_threw"
        turnErrorMessage = `${primaryErr} | fallback: ${fallbackErr}`
        // 2026-06-10 trust audit (fix 6) — feed the per-instance breaker + escalate the copy when the
        // user's previous turn also hiccupped (no identical retry-bait twice in a row). Counted ONCE
        // for the whole failed turn (primary + fallback), not per-throw.
        noteClaireRunFailure()
        bubbles = [await resolveHiccupFallbackCopy(deps.db, input.userId, Date.now(), log)]
      }
    } else {
      // RC2: explicit run timeout → straight to the grounded fallback copy (NO model retry).
      turnErrorCode = "claire_run_timeout"
      turnErrorMessage = primaryErr
      noteClaireRunFailure()
      bubbles = [await resolveHiccupFallbackCopy(deps.db, input.userId, Date.now(), log)]
    }
  }

  // DE-BLACKBOX FLUSH: the SDK's BatchTraceProcessor flushes on an unref'd 5s timer; a short CF
  // invocation can return before it fires, so the per-turn span tree (generation / function /
  // guardrail spans) is built in memory and then dropped. Force the export NOW so the trace
  // actually POSTs. Fully fail-open (forceFlushTraces swallows everything) — never blocks the turn.
  await forceFlushTraces()

  // TRACE BRIDGE (T1, Adam 2026-06-06 "add tracing so it's easier to debug ONE conversation/session"):
  // emit the trace coordinates once per turn so a Cloud Logging row maps straight to the exact OpenAI
  // trace — open https://platform.openai.com/traces and filter by groupId (= the whole conversation) or
  // jump to the single turn by traceId. The PII stays out of the export (traceIncludeSensitiveData:false);
  // this log is just identifiers.
  log("trace_exported", {
    traceId: turnTraceId,
    groupId: input.sessionId,
    userId: input.userId,
    mode: String(deps.mode ?? ""),
  })

  const deliveredViaTool = tracked.handledViaTool()
  // deliverBubblesEx normalizes each bubble (markdown/length) + caps count; one Sendblue send each.
  // It also reports `suppressedAll` — ≥1 real bubble existed but the cross-turn near-dup dedup dropped
  // EVERY one — which drives the anti-silence fallback below (instead of going silent).
  // On the anti-silence FALLBACK turn, skip cross-turn dedup so the guaranteed fresh reply can't be
  // re-suppressed (the live "fallback fires → fallback reply ALSO near-dup-suppressed → silence" bug).
  const deliverResult = await deliverBubblesEx(
    ctx,
    bubbles,
    deliveredViaTool,
    deps.isSuppressionFallback === true,
    // turnStartedAtIso → cross-turn dedup excludes rows THIS turn already wrote (a tool that delivered
    // mid-run), so the model's final bubble can never near-dup its own just-sent message → no false silent.
    turnStartedAtIso,
  ).catch((e) => {
    log("deliverBubbles_failed", { err: String(e) })
    return { sent: 0, suppressedAll: false }
  })
  const sentCount = deliverResult.sent
  const sent = sentCount > 0
  // Telemetry/test-only joined form (callers deliver via transport; eval reads recordedEvents).
  const finalText = bubbles.join("\n\n")

  // ONBOARDING ASK NET — gpt-5.4-nano intermittently calls the ask_next_onboarding_question TOOL
  // (logged onboarding.ask_next) then ENDS the turn without emitting the question as text → finalText
  // is empty → nothing is delivered → the candidate sees a read receipt and silence (the live kickoff
  // bug, 2026-05-29). If we're in onboarding, NOTHING was delivered (no text, no delivery tool, not a
  // guardrail block), surface the right question deterministically. This is canonical PROCESS content
  // (buildSharedOnboardingPrompt — the deterministic RAIL of the onboarding flow), NOT a fabricated
  // reply, so sending it when the agent skips the turn is correct.
  //
  // ADVANCE IS AGENT-OWNED (Adam 2026-05-30): the agent decides whether the candidate ANSWERED and
  // calls record_onboarding_answer (which durably advances + extracts canonical tags). We do NOT
  // force-record/force-advance whatever they typed — an irrelevant message or a question back must
  // NOT consume a slot. So the ask-net only RE-SURFACES a question: the NEXT one if the tool already
  // recorded this turn (slot advanced), otherwise the CURRENT one (slot unchanged → re-ask).
  // Tracks whether ANY net (ask-net / linkedin-offer-net) put a message on the wire after a
  // zero-bubble agent turn — so the anti-silence fallback below only fires when truly nothing went out.
  let netDelivered = false
  if (deps.mode === "onboarding" && !sent && !deliveredViaTool && !blocked) {
    const recorded = !!deps.processStore?.onboarding.answers?.[deps.onboardingSlot ?? ""]
    const q = ((recorded ? deps.pendingStep : deps.currentStep) ?? deps.pendingStep ?? "").trim()
    if (q) {
      await deps.transport
        .sendText(q)
        .catch((e) => log("onboarding.ask_net_failed", { slot: deps.onboardingSlot, err: String(e) }))
      netDelivered = true
      log("onboarding.ask_net_sent", { slot: deps.onboardingSlot, recorded })
    } else {
      log("onboarding.ask_net_no_pending", { slot: deps.onboardingSlot })
    }
  }

  // WS-1(a) LINKEDIN-OFFER NET (Adam 2026-06-03) — "super easy: résumé OR LinkedIn, whichever; résumé
  // OPTIONAL if LinkedIn." loadGlobalContext surfaces a one-tap LinkedIn connect link in the CONTEXT
  // for a canary, no-résumé, onboarding-not-done user, and the prompt INVITES the model to offer it —
  // but gpt-5.4-nano, focused on the onboarding question, near-never emits the tokenized URL and
  // instead deflects to "paste your LinkedIn" (verified 0/N in sim). The one-tap link is the entire
  // "super easy to start" thesis, so it must actually REACH the candidate, not depend on model whim.
  // Mirror the proven ONBOARDING ASK-NET above: a DETERMINISTIC append (canonical content, not a
  // fabricated reply). Gate tightly by STRUCTURED STATE (no text→enum regex): the cold-start KICKOFF
  // turn ONLY (awaitingAnswer === false → "mention once"), canary-gated by loadGlobalContext already
  // (the link is absent from globalContext for non-canary, so the extract below is empty for them),
  // and only when the model didn't already include the link. One extra optional bubble, once.
  if (
    deps.mode === "onboarding" &&
    deps.awaitingAnswer === false &&
    sent &&
    !deliveredViaTool &&
    !blocked
  ) {
    // The link rides in globalContext on the stable "...connect link = <url> —" prefix the
    // connectLinkLine writer above emits. Extract deterministically (a controlled machine-authored
    // string — NOT candidate text→enum, so the no-regex-tagging rule does not apply); empty for
    // non-canary / résumé-on-file (no link line in their context).
    const m = /connect link = (https:\/\/\S+) —/.exec(globalContext)
    const connectUrl = m?.[1] ?? ""
    const already = bubbles.some((b) => b.includes("connect-linkedin?token="))
    if (connectUrl && !already) {
      const offer =
        `oh — and if you'd rather not dig up a résumé, just tap this to connect your LinkedIn and i'll ` +
        `pull everything automatically (totally optional): ${connectUrl}`
      await deps.transport
        .sendText(offer)
        .catch((e) => log("onboarding.linkedin_offer_net_failed", { err: String(e) }))
      netDelivered = true
      log("onboarding.linkedin_offer_net_sent", {})
    }
  }

  // PRESCREEN TERMINAL FIRE — when the reducer committed a terminal THIS turn (score_prescreen_answer's
  // rollup set store.prescreen.terminal + terminalCommits>=1), fire the PROVEN legacy terminal lifecycle
  // on the REAL pa-prescreen-sessions doc: session END/workSession, candidate-job outcome, prescreen
  // memory, and on PASS the Level1 reveal + PII confirm (employer reveal). We REUSE it, not reinvent it.
  // runPrescreenTerminalAction is idempotent on `terminalActionFiredAt`, so a re-fire (a later turn, or
  // a legacy double) is a safe no-op. The thin reducer only emits PASS|FAIL — passed straight through.
  // Needs the REAL prescreen sessionId + jobId (input.userId/toE164 flow already). The score tool already
  // wrote the per-question scores + terminal back to the session doc (resume + memory read them).
  if (deps.mode === "prescreen" && deps.prescreenSessionId && deps.jobId) {
    const ps = (ctx as ProcessToolContext).processStore?.prescreen
    if (ps?.terminal && ps.terminalCommits >= 1) {
      try {
        const { runPrescreenTerminalAction } = await import("../prescreen-terminal-action.js")
        await runPrescreenTerminalAction({
          db: deps.db,
          sessionId: deps.prescreenSessionId,
          terminal: ps.terminal, // "PASS" | "FAIL"
          userId: input.userId,
          jobId: deps.jobId,
          toE164: input.toE164 ?? "",
          lang,
          log,
        })
        log("thin_prescreen.terminal_fired", { sessionId: deps.prescreenSessionId, terminal: ps.terminal })
      } catch (e) {
        log("thin_prescreen.terminal_fire_failed", {
          sessionId: deps.prescreenSessionId,
          err: e instanceof Error ? e.message : String(e),
        })
      }
      // Two-tier rejection/next-step draft (Adam 2026-06-14). NOTE: active prescreens
      // run on the deterministic FSM (mode-selector defers them), which produces the
      // inline review.autoDraft in finalizePrescreenForHumanReview — that is the path
      // that fires today. This call is a belt-and-suspenders so IF the thin agent ever
      // owns a prescreen terminal, it still produces the same review.autoDraft artifact.
      // Additive + fail-open: NEVER sends, never breaks the terminal fire above.
      try {
        const psScore = ps as unknown as { score?: number; scoreMax?: number; threshold?: number }
        const { generateAndStorePrescreenAutoDraft } = await import("../evaluation-attempts.js")
        const draftRes = await generateAndStorePrescreenAutoDraft({
          db: deps.db,
          sessionId: deps.prescreenSessionId,
          candidateId: input.userId,
          jobId: deps.jobId,
          terminal: ps.terminal,
          proposedTerminal: ps.terminal,
          score: typeof psScore.score === "number" ? psScore.score : undefined,
          scoreMax: typeof psScore.scoreMax === "number" ? psScore.scoreMax : undefined,
          threshold: typeof psScore.threshold === "number" ? psScore.threshold : undefined,
          now: new Date().toISOString(),
          log,
        })
        log("thin_prescreen.auto_draft", { sessionId: deps.prescreenSessionId, stored: draftRes.stored })
      } catch (e) {
        log("thin_prescreen.auto_draft_failed", {
          sessionId: deps.prescreenSessionId,
          err: e instanceof Error ? e.message : String(e),
        })
      }
    }
  }

  // GENERIC NEVER-SILENT BACKSTOP (Adam 2026-06-04: "where is the fallback layer where we generically
  // take in all the conversation and ask the next step so we continue instead of dead silence").
  //
  // The turn would end with ZERO bytes on the wire to the candidate — and that happens in SEVERAL shapes,
  // not just one:
  //   • A1  suppressed-all      — the model emitted ≥1 bubble but the cross-turn near-dup dedup ate ALL
  //                               of them (deliverResult.suppressedAll).
  //   • A2  empty messages      — the model emitted an EMPTY `messages` array (e.g. it over-applied the
  //                               find_match "delivered:true → say nothing" rule to the no-match case),
  //                               AND the onboarding ask-net found no pending question
  //                               (ask_net_no_pending) → nothing delivered, suppressedAll FALSE.
  //   • tool-ran-but-silent     — any mode where a tool ran but posted nothing.
  // The OLD gate keyed on `suppressedAll` ONLY, so it caught A1 but NOT A2 (the live dead-silent
  // onboarding-complete turn). The fix keys on a SINGLE transport-truthful signal instead:
  //   nothingReachedCandidate = sentTextCount === 0   (no deliverBubblesEx send AND no tool-direct send,
  //                                                     e.g. find_match's recs — so a real rec delivery,
  //                                                     which bumps the count, can NEVER false-trigger)
  //     && !netDelivered        (not the onboarding ask-net / linkedin-offer net — those sent via the raw
  //                              transport, not counted, but tracked here)
  //     && !deliveredViaTool    (not tapback-ack / no_reply / injection-blocked — INTENTIONAL silence)
  //     && !blocked             (not a guardrail crisis/injection — INTENTIONAL silence)
  //     && isSuppressionFallback !== true   (loop guard)
  // STOP / opt-out is handled deterministically UPSTREAM (cutover, before the agent) via suppressReply, so
  // it never reaches this seam. When the predicate holds, run the agent ONE more time on the plain user
  // input with every deterministic directive STRIPPED (plain triage) so the model writes a FRESH reply and
  // delivers THAT. Placed AFTER the prescreen terminal-fire so a suppressed prescreen turn STILL commits.
  //
  // LOOP GUARD (hard cap): `deps.isSuppressionFallback` gates re-entry — the recursive call sets it true,
  // and this block is skipped when it is set, so the fallback runs AT MOST ONCE per inbound. The dedup
  // thresholds + getRecentSentMessages are untouched. Fail-open: any throw is swallowed → behave as today.
  const nothingReachedCandidate =
    tracked.sentTextCount() === 0 && !netDelivered && !deliveredViaTool && !blocked
  if (nothingReachedCandidate && deps.isSuppressionFallback !== true) {
    log("claire.anti_silence_fallback.start", {
      userId: input.userId,
      mode: deps.mode ?? "triage",
      // record WHICH zero-delivery shape tripped it, for the live trace (A1 suppressed-all vs A2 empty).
      suppressedAll: deliverResult.suppressedAll,
    })
    try {
      // Re-enter on the PLAIN user input with the loop-guard flag set and EVERY deterministic directive
      // stripped (the recursive runClaireTurn also strips them by `fallback`, but we clear them here too
      // so the input is unambiguously a plain triage turn). The transport is the SAME (tracked) one, so
      // the fallback's send writes to the same outbound seam. prescreenSessionId/jobId are dropped so the
      // fallback's own (triage) turn cannot re-fire the terminal action — the original turn already did.
      const fallbackResult = await runClaireTurn(input, {
        ...deps,
        isSuppressionFallback: true,
        mode: "triage",
        pendingStep: undefined,
        currentStep: undefined,
        processStore: undefined,
        onboardingSlot: undefined,
        awaitingAnswer: undefined,
        prescreenPrompts: undefined,
        judgeContext: undefined,
        prescreenContext: undefined,
        prescreenResumeSnippet: undefined,
        prescreenSessionId: undefined,
        jobId: undefined,
        postParsePitch: undefined,
        postParsePitchSummary: undefined,
        resumeJustDropped: undefined,
        enrichmentInFlight: undefined,
        gmailNudge: undefined,
        linkedinJustConnected: undefined,
        locationSalaryAsk: undefined,
        offerFirstKickoff: undefined,
      })
      const fallbackDelivered =
        fallbackResult.deliveredViaTool || Boolean(String(fallbackResult.finalText ?? "").trim())
      log("claire.anti_silence_fallback.done", { userId: input.userId, delivered: fallbackDelivered })
      // ABSOLUTE NEVER-SILENT NET (Adam 2026-06-04: "it should never go silent if we pass to the generic
      // agent"). The fallback bypasses cross-turn dedup, so a non-empty agent reply ALWAYS lands. The only
      // remaining silence path is the generic agent itself producing NOTHING deliverable (empty output).
      // In that case send ONE plain deterministic bubble so the candidate ALWAYS hears back. Still inside
      // the loop-guard (this whole block runs at most once); fail-open on send error.
      if (!fallbackDelivered) {
        // 2026-06-10 trust audit (fix 8, "prescreen owns the thread") — the generic cold opener
        // must NEVER land mid-screen (live evidence: "what are you looking for?" fired between a
        // prescreen opener and the Q1 answer, burying the screen). When the user has an OPEN
        // prescreen work session (≤48h fresh), stay silent rather than derail it — the pending
        // prescreen question is already on their screen. Check is fail-open (read error → send).
        let openPrescreen = false
        try {
          const { userHasOpenPrescreen } = await import("@pa/job-rec")
          openPrescreen = await userHasOpenPrescreen(deps.db, input.userId, Date.now(), (e, p) =>
            log(e, p),
          )
        } catch {
          openPrescreen = false
        }
        if (openPrescreen) {
          log("claire.anti_silence_fallback.hard_net_suppressed_prescreen", { userId: input.userId })
        } else {
          const net = "hey! i'm here 👋 — what are you looking for? i can pull some roles or just chat through your search."
          await ctx.transport.sendText(net).catch(() => {})
          log("claire.anti_silence_fallback.hard_net_sent", { userId: input.userId })
        }
      }
      // Surface BOTH the original (suppressed) turn's tool calls AND the fallback turn's — the
      // observability story is "what did Claire actually DO across this inbound" (the cast through
      // unknown bridges the structured runtime shape to the string[]-declared field; see ClaireToolCall).
      const mergedToolCalls = [
        ...toolCalls,
        ...((fallbackResult.toolCalls ?? []) as unknown as ClaireToolCall[]),
      ]
      return {
        finalText: fallbackResult.finalText,
        toolCalls: mergedToolCalls as unknown as string[],
        deliveredViaTool: fallbackResult.deliveredViaTool || !fallbackDelivered,
        ...(usage ? { usage } : {}),
      }
    } catch (e) {
      // Fail-open: a fallback error must NEVER throw out of the inbound handler. Behave as today —
      // the turn is silently handled (the dedup already correctly suppressed the duplicate bubbles).
      log("claire.anti_silence_fallback.error", {
        userId: input.userId,
        err: e instanceof Error ? e.message : String(e),
      })
    }
  }

  return {
    finalText,
    // DE-BLACKBOX: the ordered tool calls the agent made this turn (was hardcoded []). The cast
    // through unknown bridges the structured ClaireToolCall[] runtime value to the string[]-declared
    // field in types.ts (not editable this run) — same compile-time-lie pattern as sdk.ts.
    toolCalls: toolCalls as unknown as string[],
    deliveredViaTool: deliveredViaTool || blocked,
    ...(usage ? { usage } : {}),
    // SECONDARY (2026-06-20): carry which model served + any error onto the result so the decision
    // trace (pa-turns/{eventId}) is debuggable from Firestore — this SEV was previously log-only.
    servedByModel,
    ...(turnErrorCode ? { errorCode: turnErrorCode } : {}),
    ...(turnErrorMessage ? { errorMessage: turnErrorMessage } : {}),
  }
}

/**
 * 2A — best-effort per-turn token usage from the SDK run() result's rawResponses[*].usage.
 * Sums input/output/total + the cached-prefix portion (camelCase `inputTokensDetails.cachedTokens`
 * OR wire `input_tokens_details.cached_tokens`). turnsUsed ~= rawResponses length. Returns undefined
 * when nothing usable surfaced (so we never write an empty usage object). Never throws.
 */
function extractClaireUsage(
  rawResponses: ReadonlyArray<unknown> | undefined,
): ClaireTurnUsage | undefined {
  try {
    const responses = rawResponses ?? []
    let inputTokens = 0
    let outputTokens = 0
    let totalTokens = 0
    let cachedInputTokens = 0
    for (const raw of responses) {
      const u = (raw as { usage?: Record<string, unknown> } | undefined)?.usage
      if (!u) continue
      const num = (v: unknown) => (typeof v === "number" ? v : 0)
      inputTokens += num(u.inputTokens)
      outputTokens += num(u.outputTokens)
      totalTokens += num(u.totalTokens)
      const details = (u.inputTokensDetails ?? u.input_tokens_details) as
        | { cachedTokens?: unknown; cached_tokens?: unknown }
        | undefined
      cachedInputTokens += num(details?.cachedTokens ?? details?.cached_tokens)
    }
    const usage: ClaireTurnUsage = {}
    if (inputTokens > 0) usage.inputTokens = inputTokens
    if (outputTokens > 0) usage.outputTokens = outputTokens
    if (totalTokens > 0) usage.totalTokens = totalTokens
    if (cachedInputTokens > 0) usage.cachedInputTokens = cachedInputTokens
    if (responses.length > 0) usage.turnsUsed = responses.length
    return Object.keys(usage).length > 0 ? usage : undefined
  } catch {
    return undefined
  }
}
