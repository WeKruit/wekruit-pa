/**
 * Post-collect hook — fired by OnboardingPipeline after the LAST question
 * is accepted. Adam directive 2026-05-05: after collecting info and
 * enriching the resume, trigger a job match.
 *
 * Pipeline:
 *   1. Enrich resume (cv-ingest worker turns the attachment into structured
 *      data: skills, companies, titles, education).
 *   2. Trigger job match — fires the job-rec pipeline with the enriched
 *      profile + collected answers as filters.
 *
 * Both are awaited but non-fatal: pipeline marks completed=true regardless
 * so the user gets the completion message immediately. Enrich + match run
 * async; their results land in the user's job feed when ready.
 *
 * Concrete enrichResume + triggerJobMatch implementations live in apps/
 * functions (where they have access to the actual workers). This module
 * exports the FUNCTION SHAPE the runtime wires into pipeline.opts.postCollect.
 */
import type { AcceptedCtx } from "./question.js"

export interface PostCollectDeps {
  /**
   * Kicks the cv-ingest worker on the resume attachment(s) collected at
   * q_resume. Returns when the worker is ENQUEUED, not when it's done.
   * No-op when q_resume was declined (collected[q_resume] missing/empty).
   */
  enrichResume?: (
    args: {
      userId: string
      attachments: unknown // ResumeAttachment[] from judges/resume.ts
    },
    ctx: AcceptedCtx
  ) => Promise<void>
  /**
   * Triggers job match using the collected answers as filters. The actual
   * job-rec pipeline subscribes to a Firestore doc / pub-sub topic and
   * runs async; we just kick it off here.
   */
  triggerJobMatch?: (
    args: {
      userId: string
      collected: Record<string, unknown>
    },
    ctx: AcceptedCtx
  ) => Promise<void>
}

export function makePostCollectHook(deps: PostCollectDeps) {
  return async (
    collected: Record<string, unknown>,
    ctx: AcceptedCtx
  ): Promise<void> => {
    const resumeAtts = collected["q_resume"]
    if (deps.enrichResume && resumeAtts) {
      try {
        await deps.enrichResume({ userId: ctx.userId, attachments: resumeAtts }, ctx)
        ctx.log?.("pa.onboarding.post_collect.resume_enrich_kicked", {
          userId: ctx.userId,
        })
      } catch (err) {
        ctx.log?.("pa.onboarding.post_collect.resume_enrich_error", {
          userId: ctx.userId,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }
    if (deps.triggerJobMatch) {
      try {
        await deps.triggerJobMatch({ userId: ctx.userId, collected }, ctx)
        ctx.log?.("pa.onboarding.post_collect.job_match_triggered", {
          userId: ctx.userId,
          fields: Object.keys(collected),
        })
      } catch (err) {
        ctx.log?.("pa.onboarding.post_collect.job_match_error", {
          userId: ctx.userId,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }
  }
}
