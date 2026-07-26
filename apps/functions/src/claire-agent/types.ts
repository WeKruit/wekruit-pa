/**
 * claire-agent shared contract types (Wave 0).
 *
 * These are the stable import surface the swarm workstreams build against.
 * Each tool/reducer defines its own internal state types in its own file;
 * this module holds only the cross-file contract.
 */
import type { Firestore } from "firebase-admin/firestore"

export type ClaireLang = "en" | "zh"

/**
 * Process mode the deterministic mode-selector reducer picks each turn
 * (AGENTIC-ARCHITECTURE §1). Scopes WRITE tools; read/answer tools stay global.
 */
export type ClaireMode = "triage" | "onboarding" | "prescreen"

/** iMessage tapback reactions Sendblue supports (send-reaction.ts). */
export type ClaireReaction =
  | "love"
  | "like"
  | "laugh"
  | "emphasize"
  | "dislike"
  | "question"

/** What the inbound handler (or proactive trigger) hands the thin agent. */
export interface ClaireTurnInput {
  userId: string
  sessionId: string
  /** inbound message text (empty for a proactive/outbound-initiated turn). */
  text: string
  /** Sendblue handle of the inbound message — required to tapback it. */
  inboundMessageHandle?: string
  /** candidate phone (E.164) for outbound. */
  toE164?: string
  lang?: ClaireLang
  /** inbound event id, for outbound correlation + idempotency. */
  inboundEventId?: string
}

/**
 * Channel side-effect seam. Production impl = Sendblue (typing/reaction) +
 * `pa-outbound` enqueue (text). Evals inject a recording stub that captures the
 * exact event sequence (mirrors the POC fake channel).
 *
 * `markRead`: Sendblue has no read-receipt endpoint, so the production impl
 * fires an immediate typing indicator as the closest read signal.
 */
export interface ClaireTransport {
  markRead(): Promise<void>
  typing(): Promise<void>
  sendStatus(text: string): Promise<void>
  /**
   * opts carries multi-bubble ordering: seq (0-based position) + paced (emit already spaced it).
   * `mediaUrl` rides an image attachment WITH this text bubble (the rec-card image inline on its
   * role caption) — forwarded to enqueueOutbound's mediaUrl. The send stays a single durable,
   * ordered pa-outbound row, so the image is delivered IN-ORDER with its caption (not a decoupled
   * once/day row that races the recs).
   */
  /** `allowRepeat` opts out of the outbox 5-minute identical-body guard — for fixed template copy
   *  that is correct to repeat (a re-pasted LinkedIn link must be acked again, not swallowed). */
  sendText(
    text: string,
    opts?: { seq?: number; paced?: boolean; mediaUrl?: string; allowRepeat?: boolean },
  ): Promise<void>
  tapback(reaction: ClaireReaction): Promise<void>
  noReply(reason: string): Promise<void>
}

/** Ranked-match result the find-match tool returns to the LLM. */
export interface FindMatchResult {
  ok: boolean
  recCount: number
  /** formatted lines: "Title @ Company\n<applyUrl>" (collab lines also carry the WeKruit_..._Job token). */
  jobs: string[]
  reason: string | null
  snapshotTags?: Record<string, unknown>
  /**
   * Structured WeKruit collab/partner roles in THIS batch — used to build the DETERMINISTIC prescreen
   * offer (the LLM repeatedly dropped it). prescreenReady = the role has a live prescreenConfig, so its
   * jobs[] line carries a start token. Adam 2026-06-01: any match with a collab role MUST offer the screen.
   */
  collab?: Array<{ jobId: string; title: string; company: string; prescreenReady: boolean }>
  /**
   * The role lines as ORDERED delivery rows, one per `jobs[]` entry (same order), each optionally
   * carrying its rec-card image `mediaUrl`. A COLLAB role row carries its image (Adam 2026-06-04: the
   * image rides INLINE on the role caption, ordered + per-turn); an open-market row is text-only. When
   * absent (no cardDeps / image allowlist), deliverRecBubbles falls back to `jobs[]` (text-only).
   * The prescreen offer is NOT in here — deliverRecBubbles appends it LAST.
   */
  deliverRows?: Array<{ text: string; mediaUrl?: string }>
}

/**
 * Dependency-injected context every tool/reducer closes over. Evals inject
 * stub `db` / `transport` / `findMatch` so no deploy is needed to test.
 */
export interface ClaireToolContext {
  db: Firestore
  userId: string
  sessionId: string
  lang: ClaireLang
  transport: ClaireTransport
  /** model id for the in-tool LLM judge (prescreen scoring). */
  judgeModel: string
  /** active job id for prescreen config lookup (when in a prescreen flow). */
  jobId?: string
  /**
   * candidate phone (E.164) for the current inbound turn. Threaded from
   * ClaireTurnInput.toE164 so the by-name prescreen tool (begin_collab_prescreen)
   * can hand it to runPreScreenForUser exactly like the copy-paste trigger does.
   * Absent on a proactive/outbound-initiated turn → the tool falls back to the
   * candidate's stored pa-users.phoneE164.
   */
  toE164?: string
  /**
   * The candidate's text for THIS turn, verbatim. Threaded so a tool can fall back to what the
   * person actually just said instead of trusting the model to have copied it into an argument.
   * Absent on a proactive/outbound-initiated turn (there is no inbound text).
   *
   * Added for `match_yc_people`: measured 2026-07-25 over a real-model probe, 11 of 16 post-intake
   * asks that named a target ("fintech", "robotics", "RL") were sent with EVERY argument null,
   * because the tool description sanctions an empty call as "match from what they already told
   * you". The matcher then fell back to their stored intake answer and silently matched the wrong
   * thing — no error, bubbles delivered normally, and from the logs it looks like a healthy match.
   */
  userText?: string
  log: (event: string, payload?: Record<string, unknown>) => void
  nowIso: () => string
  /**
   * find-match backend (queryMatchingJobsV16), injected to keep the cross-app
   * import boundary clean and to let evals stub the catalog.
   */
  findMatch?: (args: {
    userId: string
    requestedCount?: number | null
  }) => Promise<FindMatchResult>
  /**
   * Optional seam for the by-name prescreen tool (begin_collab_prescreen). Production leaves this
   * undefined → the tool calls the REAL legacy runPreScreenForUser (the SAME session-start the
   * copy-paste WeKruit_<jobId>_<userId>_Job trigger uses). Evals inject a stub so the resolver +
   * tool can be driven offline without enqueuing a real outbound. Mirrors the findMatch DI pattern.
   */
  beginPrescreen?: (args: {
    jobId: string
    userId: string
    toE164: string
  }) => Promise<{ ok: boolean; reason?: string; sessionId: string }>
}

/**
 * 2A — per-turn token usage summed from the SDK run() result's rawResponses[*].usage.
 * The live thin path calls run() directly (NOT @pa/agent-runtime's extractUsage), so this
 * is the thin path's own usage shape. `cachedInputTokens` is the prompt-cache telemetry
 * (the cached-prefix portion of inputTokens) — ~0 until byte-stable instructions (2B) cache.
 */
export type ClaireTurnUsage = {
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
  cachedInputTokens?: number
  /** model-call iterations this turn (~= rawResponses length). */
  turnsUsed?: number
}

export type ClaireRunResult = {
  finalText: string
  toolCalls: string[]
  deliveredViaTool: boolean
  /** 2A — best-effort per-turn token usage (absent on tripwire/error paths). */
  usage?: ClaireTurnUsage
  /** which model actually SERVED the reply: the primary CLAIRE_MODEL, or CLAIRE_FALLBACK_MODEL when
   *  the provider-fallback retry produced it. Absent on the happy path is fine (defaults to primary). */
  servedByModel?: string
  /** coarse code for a turn that errored / used the fallback (e.g. "primary_model_threw_fallback_
   *  recovered", "primary_and_fallback_threw", "claire_run_timeout", "claire_circuit_open"). Absent
   *  on a clean primary-served turn. Persisted to the decision trace for Firestore debuggability. */
  errorCode?: string
  /** the underlying provider error message(s) for the errored/fallback turn (absent on a clean turn). */
  errorMessage?: string
}

/** Workstream stub marker — throws so an unfilled seam fails loudly, never silently. */
export function notImplemented(workstream: string, what: string): never {
  throw new Error(`[claire-agent] not implemented (${workstream}): ${what}`)
}
