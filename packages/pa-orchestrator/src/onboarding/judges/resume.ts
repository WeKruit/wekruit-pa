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

    // No attachment. Check decline.
    const t = reply.trim()
    if (DECLINE_RE_ZH.test(t) || DECLINE_RE_EN.test(t)) {
      return { accept: false, reason: "declined" }
    }

    return { accept: false, reason: "irrelevant" }
  }
}
