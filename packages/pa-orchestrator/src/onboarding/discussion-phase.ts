/**
 * iter35 G2 — DiscussionPhase abstract base.
 *
 * Adam directive 2026-05-07 (GOAL-onboarding-refactor.md G2):
 *   "resume / LinkedIn URL are NOT deterministic questions, they are
 *    DiscussionPhase: ack → state=processing → user msg 稍等 → analysis
 *    fired async → handover"
 *
 * A DiscussionPhase is qualitatively different from a Question:
 *
 *   - **Question**: synchronous round-trip — user reply in, judge call,
 *     accept/reject, advance. Wraps in milliseconds.
 *   - **DiscussionPhase**: long-running async work (cv-ingest LLM parse,
 *     LinkedIn scrape, etc.). Spans multiple inbound events: artifact
 *     receipt → wait → completion → analysis.
 *
 * Three lifecycle hooks:
 *
 *   1. `onArtifactReceived(input)` — first inbound carrying the artifact
 *      (PDF attachment, URL, etc.). Sends immediate ack ("got it, reading
 *      through your resume..."), flips state to `processingState`, kicks
 *      off the async worker. Returns immediately — does NOT block.
 *
 *   2. `onMessageWhileProcessing(input)` — any inbound that lands while
 *      state === `processingState`. Sends a polite hold message ("稍等一下
 *      还在读") so the user knows we're not ignoring them. Crucially does
 *      NOT re-fire the ack (Bug A regression — old code sent the
 *      "waiting" prompt twice when the synthetic [cv-parsed] event raced
 *      with a follow-up user message).
 *
 *   3. `onWorkComplete(input, result)` — async worker callback. Persists
 *      the result, sends the analysis message, advances to `completeState`.
 *      On `result.ok === false`, sends an error recovery message instead
 *      and stays at `processingState` (or transitions back; concrete phase
 *      decides via `sendErrorMessage`).
 *
 * Concrete phases (e.g. `ResumeDiscussionPhase`) override the per-phase
 * customization hooks. Dependency injection is via constructor — the
 * abstract base never imports cv-ingest, Firestore, or any heavy
 * infrastructure.
 *
 * NEVER import this module from production runtime without checking
 * the wiring layer (orchestrator-deps.ts) — the dispatch into a
 * DiscussionPhase is the responsibility of the main onboarding
 * dispatcher (onboarding-deterministic.ts) post P7-4 integration.
 */

import type { OnboardingState } from "@pa/core-types"
import type { Lang } from "./question.js"

/**
 * Phase lifecycle stage. Mirrors the underlying state-machine but at the
 * DiscussionPhase abstraction level — useful for telemetry and tests.
 *
 *   - "idle": no artifact yet (state === one of `entryStates`)
 *   - "processing": artifact received, async worker running
 *   - "complete": analysis sent, phase done
 */
export type PhaseState = "idle" | "processing" | "complete"

/**
 * Per-turn input handed to every phase hook. Mirrors the JudgeCtx contract
 * for consistency with Question, but adds:
 *   - `userMessage` — the user's text reply (when the inbound IS a text
 *     reply; for raw artifact uploads this may be empty/undefined)
 *   - `lang` — the locked preferred language (zh|en) — used to pick the
 *     localized message variant.
 *   - `db` — Firestore handle (loose-typed; matches the rest of pa-orch).
 */
export interface PhaseInput {
  userId: string
  turnId: string
  /** iMessage raw event payload, if available (e.g. for media_url access). */
  rawPayload?: unknown
  /** User's text reply, if any. Pure-attachment inbounds may be empty. */
  userMessage?: string
  /** Locked preferred language for outgoing messages. */
  lang: Lang
  /** Firestore handle (loose-typed). */
  db?: unknown
  /** Telemetry hook. */
  log?(event: string, payload: Record<string, unknown>): void
}

/**
 * Result of the async worker. `ok=true` → `data` carries the parsed
 * payload (e.g. parsedCandidateResumes row for cv-ingest). `ok=false`
 * → `error` carries a human-readable failure reason for telemetry; the
 * concrete phase decides what to surface to the user via `sendErrorMessage`.
 */
export interface AsyncResult {
  ok: boolean
  data?: unknown
  error?: string
}

/**
 * Abstract base for long-running discussion phases. Concrete subclasses
 * implement the per-phase customization hooks (ack message, async
 * kickoff, persistence, analysis composition). The lifecycle methods
 * `onArtifactReceived`, `onMessageWhileProcessing`, `onWorkComplete` are
 * intentionally NOT abstract — they orchestrate the standard ack →
 * processing → analysis flow that ALL discussion phases share. Subclasses
 * SHOULD NOT override them; if your phase needs a different lifecycle,
 * write a different abstract base.
 *
 * Generic over the artifact-domain (resume PDF, LinkedIn URL, etc.) is
 * intentionally NOT parameterized — phases differ in their inputs and
 * outputs in ways that don't compose cleanly into a single TParam. We
 * use `unknown` for `result.data` and rely on each concrete phase's
 * `persistAnalysis`/`sendAnalysis` to narrow.
 */
export abstract class DiscussionPhase {
  /** Stable identifier ("resume", "linkedin_url", ...). Used in logs. */
  abstract readonly phaseId: string

  /**
   * Onboarding states from which this phase can be entered. The dispatcher
   * routes inbounds to `onArtifactReceived` only when the user is in one
   * of these states AND an artifact is present. Typically a single state
   * (e.g. "q_resume_asked"); listed as readonly array for future
   * multi-entry phases.
   */
  abstract readonly entryStates: readonly OnboardingState[]

  /** State while async work is running (e.g. "q_resume_processing"). */
  abstract readonly processingState: OnboardingState

  /** State after analysis sent (e.g. "q_resume_done"). */
  abstract readonly completeState: OnboardingState

  /**
   * Step 1 — artifact arrived (PDF, URL, etc.). Sends immediate ack,
   * transitions to processingState, kicks off async worker.
   *
   * Idempotency contract: this MUST be safe to call exactly once per
   * artifact. The dispatcher is responsible for dedup (the existing
   * Bug A v2 transactional dedup gate at onboarding-deterministic.ts
   * lines 1556-1576 will be re-purposed in P7-4 to gate this entry).
   */
  async onArtifactReceived(input: PhaseInput): Promise<void> {
    await this.sendImmediateAck(input)
    await this.setState(input.userId, this.processingState, input.db)
    await this.kickoffAsyncWork(input)
    input.log?.("pa.onboarding.discussion.artifact_received", {
      phaseId: this.phaseId,
      userId: input.userId,
      turnId: input.turnId,
    })
  }

  /**
   * Step 2 — user sends another message while still processing. Sends a
   * polite hold reply ONLY (Bug A regression check: do NOT re-fire the
   * ack from `sendImmediateAck`).
   */
  async onMessageWhileProcessing(input: PhaseInput): Promise<void> {
    await this.sendHoldMessage(input)
    input.log?.("pa.onboarding.discussion.processing_hold", {
      phaseId: this.phaseId,
      userId: input.userId,
      turnId: input.turnId,
    })
  }

  /**
   * Step 3 — async worker callback: work done. On success, persists +
   * sends analysis + transitions to completeState. On failure, sends
   * error message and stays at processingState (recovery is the
   * responsibility of the dispatcher / next inbound). The phase does NOT
   * decide retry policy — that's a higher-level concern.
   */
  async onWorkComplete(input: PhaseInput, result: AsyncResult): Promise<void> {
    if (!result.ok) {
      await this.sendErrorMessage(input, result)
      input.log?.("pa.onboarding.discussion.work_failed", {
        phaseId: this.phaseId,
        userId: input.userId,
        turnId: input.turnId,
        error: result.error,
      })
      return
    }
    await this.persistAnalysis(input.userId, result, input.db)
    await this.sendAnalysis(input, result)
    await this.setState(input.userId, this.completeState, input.db)
    input.log?.("pa.onboarding.discussion.work_complete", {
      phaseId: this.phaseId,
      userId: input.userId,
      turnId: input.turnId,
    })
  }

  // ----------------------------------------------------------------------
  // Per-phase customization (subclasses implement)
  // ----------------------------------------------------------------------

  /** Generic state transition helper. Concrete phase wires its setOnboardingState dep. */
  protected abstract setState(
    userId: string,
    state: OnboardingState,
    db: unknown
  ): Promise<void>

  /** Send the immediate ack on artifact receipt ("got it, reading..."). */
  protected abstract sendImmediateAck(input: PhaseInput): Promise<void>

  /** Kick off async worker (cv-ingest, LinkedIn scrape, etc). Fire-and-forget. */
  protected abstract kickoffAsyncWork(input: PhaseInput): Promise<void>

  /** Send the hold message when user pings during processing ("稍等"). */
  protected abstract sendHoldMessage(input: PhaseInput): Promise<void>

  /** Send error recovery message on worker failure ("couldn't read, resend?"). */
  protected abstract sendErrorMessage(input: PhaseInput, result: AsyncResult): Promise<void>

  /** Persist the parsed payload (e.g. write user tags from CV). */
  protected abstract persistAnalysis(
    userId: string,
    result: AsyncResult,
    db: unknown
  ): Promise<void>

  /** Send the analysis message to the user (CV summary, etc.). */
  protected abstract sendAnalysis(input: PhaseInput, result: AsyncResult): Promise<void>
}
