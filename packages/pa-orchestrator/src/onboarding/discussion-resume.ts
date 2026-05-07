/**
 * iter35 G2 — ResumeDiscussionPhase concrete impl.
 *
 * Adam directive 2026-05-07 (GOAL-onboarding-refactor.md G2):
 *   resume / LinkedIn URL are NOT deterministic questions. They are
 *   DiscussionPhase: ack → state=processing → user msg "稍等" → analysis
 *   fired async → handover.
 *
 * Lifecycle (inherited from `DiscussionPhase`):
 *
 *   q_resume_asked   ─── PDF arrives ──▶ q_resume_processing
 *      (idle)              │                  (cv-ingest running)
 *                          ▼
 *                    sendImmediateAck:
 *                    "got it, reading through your resume..."
 *                          │
 *                          ▼
 *                    kickoffAsyncWork:
 *                    deps.kickoffCvIngest({userId, rawPayload})
 *                    [fire-and-forget; cv-ingest is async]
 *
 *   q_resume_processing ─── user msg arrives ──▶ q_resume_processing (no advance)
 *                                │
 *                                ▼
 *                          sendHoldMessage (random rotation):
 *                          "稍等一下，还在读简历"
 *                          "马上就好"
 *                          "再给我几秒"
 *
 *   q_resume_processing ─── cv-ingest done callback ──▶ q_resume_done
 *                                │
 *                                ▼
 *                          persistAnalysis: deps.writeUserTagsFromCv
 *                          sendAnalysis: deps.composeCvAnalysis (LLM summary)
 *
 *   q_resume_processing ─── cv-ingest failed callback ──▶ q_resume_processing (retry-prompt)
 *                                │
 *                                ▼
 *                          sendErrorMessage:
 *                          "couldn't read your resume — can you resend?"
 *
 * Dependency injection:
 *   All side-effecting collaborators (LLM calls, Firestore writes, the
 *   actual cv-ingest invocation, the outbound message sender) are passed
 *   in as `deps` via constructor. The phase itself is pure orchestration —
 *   easy to unit-test by stubbing each dep.
 *
 * Wiring (handled in P7-4 + orchestrator-deps.ts):
 *   - `kickoffCvIngest` wraps the existing `ingestCv()` call from
 *     apps/functions/src/cv-ingest/cv-ingest.ts (mediaUrl extracted from
 *     `input.rawPayload`)
 *   - `writeUserTagsFromCv` wraps `mergeUserTags` / `defaultWriteUserTags`
 *     (already wired in cv-ingest itself; ResumeDiscussionPhase deferring
 *     to deps lets the dispatcher choose whether to skip — useful in tests)
 *   - `composeCvAnalysis` wraps the existing cv-summary composer
 *     (`composeCvSummary` in pa-orchestrator/src/cv-summary.ts)
 *   - `setOnboardingState` wraps `applyOnboardingStep` (or the new
 *     pipeline-state writer post-iter34 P3)
 *   - `send` wraps the outbound message helper that the dispatcher uses
 *     (sendDirect in onboarding-deterministic.ts)
 */

import type { OnboardingState } from "@pa/core-types"
import { DiscussionPhase, type AsyncResult, type PhaseInput } from "./discussion-phase.js"

/**
 * Dependency contract for ResumeDiscussionPhase. All heavy collaborators
 * are injected so the phase stays pure orchestration. Tests stub each
 * function; production wiring lives in orchestrator-deps.ts.
 */
export interface ResumeDiscussionDeps {
  /**
   * Send a single outbound message to the user. Concrete impl wraps the
   * `sendDirect` helper used elsewhere in onboarding-deterministic.ts.
   */
  send(input: PhaseInput, text: string): Promise<void>

  /**
   * Kick off the cv-ingest async worker. Fire-and-forget — implementation
   * extracts mediaUrl from `input.rawPayload` and calls `ingestCv()`.
   * Errors are logged inside the impl; this method MUST resolve quickly
   * (no awaiting cv-ingest's full LLM round trip).
   */
  kickoffCvIngest(input: PhaseInput): Promise<void>

  /**
   * Persist the parsed CV → pa-users.tags via the canonical mergeUserTags
   * writer. `parsed` is the full parsedCandidateResumes row payload.
   */
  writeUserTagsFromCv(userId: string, parsed: unknown, db: unknown): Promise<void>

  /**
   * Compose the user-facing CV analysis message (e.g. "I see you have
   * Python + 3yr at Tesla — building self-driving — does that match?").
   * Returns the rendered string ready to send.
   */
  composeCvAnalysis(input: PhaseInput, parsed: unknown): Promise<string>

  /**
   * Update the user's onboardingState. Concrete impl wraps
   * `applyOnboardingStep` (or pipeline-state save in iter34+ flow).
   */
  setOnboardingState(userId: string, state: OnboardingState, db: unknown): Promise<void>
}

/**
 * Random hold-message rotation. Exposed as module-level fn so tests can
 * stub the RNG without touching Math.random globally. Concrete phase
 * always picks one variant per turn — variants intentionally short.
 */
export function pickHoldMessage(lang: "zh" | "en", rand: () => number = Math.random): string {
  const variants =
    lang === "zh"
      ? ["稍等一下，还在读简历", "马上就好，还在读", "再给我几秒"]
      : [
          "hold on, still reading your resume",
          "almost there, still parsing",
          "give me a few more seconds",
        ]
  const idx = Math.floor(rand() * variants.length)
  return variants[idx] ?? variants[0]!
}

/**
 * Random RNG injection for testability. Default `Math.random`. Tests
 * can pass a deterministic counter.
 */
export interface ResumeDiscussionOpts {
  /** Override RNG used by `pickHoldMessage`. Tests pass a stub. */
  rand?: () => number
}

export class ResumeDiscussionPhase extends DiscussionPhase {
  readonly phaseId = "resume" as const
  readonly entryStates = ["q_resume_asked"] as const satisfies readonly OnboardingState[]
  readonly processingState: OnboardingState = "q_resume_processing"
  readonly completeState: OnboardingState = "q_resume_done"

  constructor(
    private readonly deps: ResumeDiscussionDeps,
    private readonly opts: ResumeDiscussionOpts = {}
  ) {
    super()
  }

  protected async sendImmediateAck(input: PhaseInput): Promise<void> {
    const text =
      input.lang === "zh"
        ? "收到, 让我读一下你的简历..."
        : "got it, reading through your resume..."
    await this.deps.send(input, text)
  }

  protected async kickoffAsyncWork(input: PhaseInput): Promise<void> {
    await this.deps.kickoffCvIngest(input)
  }

  protected async sendHoldMessage(input: PhaseInput): Promise<void> {
    const text = pickHoldMessage(input.lang, this.opts.rand)
    await this.deps.send(input, text)
  }

  protected async sendErrorMessage(input: PhaseInput, _result: AsyncResult): Promise<void> {
    const text =
      input.lang === "zh"
        ? "简历读取失败了，能再发一次吗?"
        : "couldn't read your resume — can you resend?"
    await this.deps.send(input, text)
  }

  protected async persistAnalysis(
    userId: string,
    result: AsyncResult,
    db: unknown
  ): Promise<void> {
    await this.deps.writeUserTagsFromCv(userId, result.data, db)
  }

  protected async sendAnalysis(input: PhaseInput, result: AsyncResult): Promise<void> {
    const text = await this.deps.composeCvAnalysis(input, result.data)
    await this.deps.send(input, text)
  }

  protected async setState(userId: string, state: OnboardingState, db: unknown): Promise<void> {
    await this.deps.setOnboardingState(userId, state, db)
  }
}
