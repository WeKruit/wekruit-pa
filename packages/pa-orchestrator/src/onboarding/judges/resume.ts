/**
 * ResumeJudge — accepts when the inbound rawPayload contains an attachment
 * (iMessage attachment or any binary the upstream pipeline classified as
 * a resume). Otherwise re-asks.
 *
 * Decline detection: explicit "no" / "skip" / "later" / "等会" / "下次"
 * → reason="declined". Pipeline can choose to skip (q_resume.onDeclined
 * advance=true) or halt depending on product policy.
 *
 * Note: actual resume parsing (PDF → text → structured fields) happens in
 * a downstream worker (cv-ingest). This judge ONLY decides whether the
 * user has SENT something resume-shaped. Acceptance triggers the worker.
 */
import type { Judge, JudgeCtx, JudgeResult, Lang } from "../question.js"

export interface ResumeAttachment {
  url?: string
  filename?: string
  mimetype?: string
  size?: number
}

export interface ResumeJudgeOpts {
  /**
   * Extracts attachments from the inbound rawPayload. Default looks at
   * iMessage shape (rawPayload.attachments[]) — override for other channels.
   */
  extractAttachments?: (rawPayload: unknown) => ResumeAttachment[]
}

const DECLINE_RE_ZH = /(不发|不传|不要|没有简历|没简历|稍后|下次|算了|改天)/
const DECLINE_RE_EN = /\b(skip|no|nope|later|maybe later|don'?t have|no resume)\b/i
const EXISTING_RESUME_RE = /\b(already|earlier|uploaded|sent|on file|already on file|resume already on file|use the resume|use (it|that|the existing|my existing|my).{0,32}resume|resume\.pdf)\b/i

function defaultExtract(rawPayload: unknown): ResumeAttachment[] {
  if (!rawPayload || typeof rawPayload !== "object") return []
  const r = rawPayload as { attachments?: unknown }
  if (!Array.isArray(r.attachments)) return []
  return r.attachments
    .filter((a): a is Record<string, unknown> => typeof a === "object" && a !== null)
    .map((a) => ({
      url: typeof a.url === "string" ? a.url : undefined,
      filename: typeof a.filename === "string" ? a.filename : undefined,
      mimetype: typeof a.mimetype === "string" ? a.mimetype : undefined,
      size: typeof a.size === "number" ? a.size : undefined,
    }))
}

async function hasParsedResumeOnFile(ctx: JudgeCtx): Promise<boolean> {
  const db = ctx.db as
    | {
        collection?: (name: string) => {
          where?: (
            field: string,
            op: "==",
            value: string
          ) => {
            limit?: (n: number) => { get?: () => Promise<{ empty?: boolean; docs?: unknown[] }> }
            get?: () => Promise<{ empty?: boolean; docs?: unknown[] }>
          }
        }
      }
    | undefined
  const collection = db?.collection?.("parsedCandidateResumes")
  const query = collection?.where?.("userId", "==", ctx.userId)
  const limited = query?.limit?.(1) ?? query
  const snap = await limited?.get?.()
  if (!snap) return false
  if (snap.empty === false) return true
  return Array.isArray(snap.docs) && snap.docs.length > 0
}

export class ResumeJudge implements Judge<ResumeAttachment[]> {
  readonly kind = "resume"

  constructor(private readonly opts: ResumeJudgeOpts = {}) {}

  async judge(
    reply: string,
    lang: Lang,
    ctx: JudgeCtx
  ): Promise<JudgeResult<ResumeAttachment[]>> {
    const extract = this.opts.extractAttachments ?? defaultExtract
    const atts = extract(ctx.rawPayload)
    if (atts.length > 0) {
      return { accept: true, value: atts, confidence: 1.0 }
    }

    const t = reply.trim()
    if (EXISTING_RESUME_RE.test(t)) {
      try {
        const hasResume = await hasParsedResumeOnFile(ctx)
        ctx.log?.("pa.onboarding.resume.existing_lookup", {
          userId: ctx.userId,
          turnId: ctx.turnId,
          hasResume,
        })
        if (hasResume) {
          return { accept: true, value: [], confidence: 0.95 }
        }
      } catch (err) {
        ctx.log?.("pa.onboarding.resume.existing_lookup_error", {
          userId: ctx.userId,
          turnId: ctx.turnId,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }

    // No attachment. Check decline.
    if (DECLINE_RE_ZH.test(t) || DECLINE_RE_EN.test(t)) {
      return { accept: false, reason: "declined" }
    }

    return { accept: false, reason: "irrelevant" }
  }
}
