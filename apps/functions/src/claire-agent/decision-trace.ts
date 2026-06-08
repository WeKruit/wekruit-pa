/**
 * decision-trace.ts — the per-turn "why did Claire do X" record.
 *
 * cutover.ts runs ONE thin agent turn per inbound event and, today, writes a usage-only doc to
 * `pa-turns/{eventId}`. That doc answers "how many tokens" but not "why this reply". This builder
 * EXTENDS that same eventId-keyed doc into a full decision trace so a SINGLE Firestore read
 * (`pa-turns/{eventId}`) tells the whole story of a turn: the user message in, the deterministic
 * mode/pattern that won, the ordered tool calls the agent made (name → arguments → output), the
 * reply text that went out, and whether the reply was delivered via a tool / suppressed by dedup.
 *
 * PURE + FAIL-OPEN BY CONTRACT: this module builds a plain JSON-serializable doc and never touches
 * Firestore, never throws (it only reads already-resolved values + coerces defensively). The caller
 * wraps the actual `.set()` in try/catch so a trace-write failure can NEVER affect the reply — the
 * reply has already gone out by the time the trace is written.
 *
 * NO NEW PII: the only free-text fields are `inboundText` (the user's message) and `finalText` (the
 * reply) — both already persisted verbatim in `pa-messages`. Tool arguments/outputs are the model's
 * own structured calls (job ids, counts, slot names), not new candidate PII surfaces.
 */
import type { ClaireMode } from "./types.js"
import type { ClaireTurnUsage } from "./types.js"

/** One ordered tool call as captured by agent.ts `captureToolCalls` (de-blackboxed run items). */
export interface DecisionTraceToolCall {
  name: string
  /** raw JSON arguments string the model passed (as the SDK emitted it). */
  arguments?: string
  /** the tool's stringified output, when a paired function_call_output item existed. */
  output?: string
}

/**
 * The persisted per-turn decision trace. Written to `pa-turns/{eventId}` (merged onto the usage doc),
 * so one read answers "why did Claire do X this turn".
 */
export interface DecisionTrace {
  eventId: string
  userId: string
  sessionId: string
  /** the user's inbound message text (already in pa-messages; mirrored here for a single-read story). */
  inboundText: string
  /** deterministic mode the mode-selector chose (onboarding | prescreen | triage | …). */
  mode: ClaireMode
  /** best-effort coarse "pattern" label derived from the winning deterministic branch (see deriveTracePattern). */
  pattern: string
  /** ordered tool calls the agent made this turn ([] when none / not surfaced). */
  toolCalls: DecisionTraceToolCall[]
  /** the reply text delivered to the user this turn (multi-bubble joined by blank lines). */
  finalText: string
  /** true when the reply was emitted by a tool (find_match / status tool) rather than agent prose. */
  deliveredViaTool: boolean
  /** best-effort: true when the turn produced no deliverable prose AND wasn't tool-delivered (dedup/suppression). */
  suppressed: boolean
  /** per-turn token usage when it surfaced (absent on tripwire/error paths). */
  usage?: ClaireTurnUsage
  handledBy: "thin_claire"
  createdAt: string
}

export interface BuildDecisionTraceInput {
  eventId: string
  userId: string
  sessionId: string
  inboundText: string
  mode: ClaireMode
  /** the full mode-selector decision — read for the coarse pattern label (flag inspection only, no text classify). */
  decisionFlags: DecisionPatternFlags
  /** the runClaireTurn result. `toolCalls` is declared string[] on ClaireRunResult but is the
   *  ClaireToolCall[] object array at runtime (agent.ts casts it); we coerce defensively here. */
  turnResult:
    | {
        finalText?: string
        toolCalls?: unknown
        deliveredViaTool?: boolean
        usage?: ClaireTurnUsage
      }
    | undefined
  nowIso: string
}

/**
 * The subset of ModeDecision flags we inspect to derive a coarse `pattern` label. We never classify
 * the inbound TEXT — only read the deterministic flags the mode-selector already set this turn (the
 * NO-REGEX-IN-CLASSIFICATION rule is respected: this is pure flag inspection, not text → enum).
 */
export interface DecisionPatternFlags {
  mode: ClaireMode
  postParsePitch?: boolean
  offerFirstKickoff?: boolean
  linkedinJustConnected?: boolean
  locationSalaryAsk?: boolean
  gmailNudge?: boolean
  enrichmentInFlight?: boolean
  prescreenSessionId?: string
}

/**
 * Coarse, human-readable "pattern" for the turn, derived ONLY from the deterministic decision flags
 * (most-specific branch wins). This mirrors the thin redesign's prescreen/pitch/normal pattern model
 * without introducing a new field upstream. Pure; never throws.
 */
export function deriveTracePattern(flags: DecisionPatternFlags): string {
  if (flags.prescreenSessionId) return "prescreen"
  if (flags.postParsePitch) return "pitch"
  if (flags.offerFirstKickoff) return "offer_first"
  if (flags.linkedinJustConnected) return "linkedin_just_connected"
  if (flags.enrichmentInFlight) return "enrichment_in_flight"
  if (flags.locationSalaryAsk) return "location_salary_ask"
  if (flags.gmailNudge) return "gmail_nudge"
  if (flags.mode === "onboarding") return "onboarding"
  return "normal"
}

/** Coerce the runtime `toolCalls` value (object array under a string[] cast) into trace tool calls. */
function coerceToolCalls(raw: unknown): DecisionTraceToolCall[] {
  if (!Array.isArray(raw)) return []
  const out: DecisionTraceToolCall[] = []
  for (const item of raw) {
    if (item && typeof item === "object") {
      const o = item as Record<string, unknown>
      const name = typeof o.name === "string" ? o.name : ""
      if (!name) continue
      const call: DecisionTraceToolCall = { name }
      if (typeof o.arguments === "string" && o.arguments !== "") call.arguments = o.arguments
      if (typeof o.output === "string" && o.output !== "") call.output = o.output
      out.push(call)
    } else if (typeof item === "string" && item !== "") {
      // Back-compat: an older string[] shape (just tool names) still records as named calls.
      out.push({ name: item })
    }
  }
  return out
}

/**
 * Build the per-turn decision trace doc. Pure + total: any missing/odd field degrades to a safe
 * default ("" / [] / false) so this never throws. The caller persists it fail-open.
 */
export function buildDecisionTrace(input: BuildDecisionTraceInput): DecisionTrace {
  const tr = input.turnResult ?? {}
  const finalText = typeof tr.finalText === "string" ? tr.finalText : ""
  const deliveredViaTool = tr.deliveredViaTool === true
  const toolCalls = coerceToolCalls(tr.toolCalls)
  // SUPPRESSED (best-effort): the turn yielded no deliverable prose AND wasn't tool-delivered — the
  // signal a cross-turn near-dup dedup swallowed every bubble. ClaireRunResult doesn't surface
  // `suppressedAll` directly, so this is the honest derivable proxy from the fields we have.
  const suppressed = finalText.trim().length === 0 && !deliveredViaTool

  const trace: DecisionTrace = {
    eventId: input.eventId,
    userId: input.userId,
    sessionId: input.sessionId,
    inboundText: input.inboundText,
    mode: input.mode,
    pattern: deriveTracePattern(input.decisionFlags),
    toolCalls,
    finalText,
    deliveredViaTool,
    suppressed,
    handledBy: "thin_claire",
    createdAt: input.nowIso,
  }
  if (tr.usage) trace.usage = tr.usage
  return trace
}
