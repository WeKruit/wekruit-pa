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
  sendText(text: string): Promise<void>
  tapback(reaction: ClaireReaction): Promise<void>
  noReply(reason: string): Promise<void>
}

/** Ranked-match result the find-match tool returns to the LLM. */
export interface FindMatchResult {
  ok: boolean
  recCount: number
  /** formatted lines: "Title @ Company\n<applyUrl>". */
  jobs: string[]
  reason: string | null
  snapshotTags?: Record<string, unknown>
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
}

export type ClaireRunResult = {
  finalText: string
  toolCalls: string[]
  deliveredViaTool: boolean
}

/** Workstream stub marker — throws so an unfilled seam fails loudly, never silently. */
export function notImplemented(workstream: string, what: string): never {
  throw new Error(`[claire-agent] not implemented (${workstream}): ${what}`)
}
