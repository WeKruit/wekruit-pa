/**
 * Phase 54 (USER-TAG-03 / extends Phase 53 PARSE-07) — CV-confirm reply parser.
 *
 * Parses a user's reply to the post-parse Claire confirm message ("看了你的简历
 * — you've done X, used Y, recent industries Z. 对吗？"). Two outcomes:
 *
 *   1. User confirms ("对" / "yes" / "looks right") — `confirmAccepted = true`,
 *      no field corrections.
 *   2. User corrects ("我也做过 React 和 TypeScript" / "actually I'm targeting
 *      fintech not crypto") — extracts `correctedSkills[]`, `correctedIndustries[]`,
 *      `correctedRoles[]`, plus optional `correctionFreeform`.
 *
 * Uses gpt-5.4-nano via OpenAI Responses API (mirrors `defaultLlmFollowup`
 * pattern). Returns a strict zod-validated object. Fail-open: any error
 * resolves to `{ confirmAccepted: false, correctionFreeform: replyText }`
 * so the caller can still log + surface to admin.
 */

import { z } from "zod"

const PARSE_MODEL = "gpt-5.4-nano"

export const CvConfirmReplySchema = z.object({
  /** True when the user accepted the summary verbatim. */
  confirmAccepted: z.boolean(),
  /** Lowercased skill tokens the user added (max 12). */
  correctedSkills: z.array(z.string()).optional(),
  /** Lowercased industry hints the user clarified (max 6). */
  correctedIndustries: z.array(z.string()).optional(),
  /** Lowercased role-function hints (max 6). */
  correctedRoles: z.array(z.string()).optional(),
  /** Free-text remainder of the user's reply, for audit/log. */
  correctionFreeform: z.string().nullable().optional(),
})

export type CvConfirmReply = z.infer<typeof CvConfirmReplySchema>

const SYSTEM_PROMPT =
  "You parse a user's reply to a CV-summary confirmation message. " +
  "Return STRICT JSON: { confirmAccepted: bool, correctedSkills?: string[], correctedIndustries?: string[], correctedRoles?: string[], correctionFreeform: string | null }.\n\n" +
  "Rules:\n" +
  "- confirmAccepted=true ONLY when reply is a clear acceptance like 对/对的/yes/对啊/looks right/sounds good/没错/correct (no new info added).\n" +
  "- If user adds skills (\"我也做过 React\" / \"used Python too\"): put them in correctedSkills (lowercased, snake_case if multi-word, e.g. ['react', 'machine_learning']).\n" +
  "- If user clarifies industry (\"我其实做过 fintech\" / \"actually I'm in healthtech\"): put canonical hints in correctedIndustries (lowercased, snake_case).\n" +
  "- If user clarifies target role (\"我想做 PM\" / \"I'm targeting data engineer\"): put canonical hints in correctedRoles (lowercased, snake_case, e.g. ['product_management']).\n" +
  "- correctionFreeform: full original reply text, max 500 chars (use null when reply is just a confirm token).\n" +
  "- Output JSON ONLY. No markdown, no commentary. Empty arrays omitted (not null).\n" +
  "- Skill / role / industry token max counts: skills 12, industries 6, roles 6."

export interface ParseUserCorrectionArgs {
  /** Raw user reply text. */
  replyText: string
  /** OpenAI API key. Caller resolves from env. */
  apiKey: string
  /** Optional baseURL override. */
  baseURL?: string
  /** Test seam — replace the OpenAI call with a stub. */
  llmCall?: (args: {
    apiKey: string
    baseURL?: string
    system: string
    user: string
  }) => Promise<string>
  /** Logger — defaults to no-op. */
  log?: (event: string, payload?: Record<string, unknown>) => void
}

/**
 * Default OpenAI Responses API call. Mirrors `defaultLlmFollowup` shape.
 */
async function defaultLlmCall(args: {
  apiKey: string
  baseURL?: string
  system: string
  user: string
}): Promise<string> {
  const { default: OpenAI } = (await import("openai")) as unknown as {
    default: new (init: { apiKey: string; baseURL?: string }) => {
      responses: {
        create: (req: Record<string, unknown>) => Promise<{
          output_text?: string
          output?: Array<{ content?: Array<{ text?: string }> }>
        }>
      }
    }
  }
  const client = new OpenAI({
    apiKey: args.apiKey,
    baseURL: args.baseURL ?? "https://api.openai.com/v1",
  })
  const resp = await client.responses.create({
    model: PARSE_MODEL,
    input: [
      { role: "system", content: args.system },
      { role: "user", content: args.user },
    ],
    text: { format: { type: "json_object" } } as Record<string, unknown>,
  } as Record<string, unknown>)
  if (typeof resp.output_text === "string" && resp.output_text.length > 0) {
    return resp.output_text
  }
  if (Array.isArray(resp.output) && resp.output[0]?.content?.[0]?.text) {
    return resp.output[0]!.content![0]!.text!
  }
  throw new Error("empty_llm_output")
}

/**
 * Parse a user's CV-confirm reply. Returns a normalized, zod-validated
 * `CvConfirmReply`. NEVER throws — failures resolve to a safe default
 * (`confirmAccepted: false`, freeform = replyText).
 */
export async function parseUserCorrection(
  args: ParseUserCorrectionArgs
): Promise<CvConfirmReply> {
  const log = args.log ?? (() => {})
  const replyText = (args.replyText ?? "").trim()

  // Cheap heuristic — if reply is empty or pure-emoji, treat as ambiguous
  // confirmation but log for forensic.
  if (!replyText) {
    log("pa.cv_confirm_reply.empty_reply")
    return { confirmAccepted: false, correctionFreeform: null }
  }
  if (!args.apiKey) {
    log("pa.cv_confirm_reply.missing_api_key")
    return { confirmAccepted: false, correctionFreeform: replyText }
  }

  const llmCall = args.llmCall ?? defaultLlmCall
  let raw: string
  try {
    raw = await llmCall({
      apiKey: args.apiKey,
      baseURL: args.baseURL,
      system: SYSTEM_PROMPT,
      user: replyText,
    })
  } catch (err) {
    log("pa.cv_confirm_reply.llm_error", {
      error: err instanceof Error ? err.message : String(err),
    })
    return { confirmAccepted: false, correctionFreeform: replyText }
  }

  // Parse + validate.
  let parsedJson: unknown
  try {
    parsedJson = JSON.parse(raw)
  } catch (err) {
    log("pa.cv_confirm_reply.json_parse_error", {
      raw: raw.slice(0, 200),
      error: err instanceof Error ? err.message : String(err),
    })
    return { confirmAccepted: false, correctionFreeform: replyText }
  }

  const result = CvConfirmReplySchema.safeParse(parsedJson)
  if (!result.success) {
    log("pa.cv_confirm_reply.schema_error", {
      issues: result.error.issues.slice(0, 3),
    })
    return { confirmAccepted: false, correctionFreeform: replyText }
  }

  // Defensive normalization — clip arrays to limits, strip empty strings.
  const out: CvConfirmReply = {
    confirmAccepted: result.data.confirmAccepted,
  }
  const cleanArr = (arr: string[] | undefined, cap: number): string[] | undefined => {
    if (!Array.isArray(arr)) return undefined
    const cleaned: string[] = []
    const seen = new Set<string>()
    for (const v of arr) {
      if (typeof v !== "string") continue
      const norm = v.trim().toLowerCase().replace(/\s+/g, "_")
      if (!norm || seen.has(norm)) continue
      seen.add(norm)
      cleaned.push(norm)
      if (cleaned.length >= cap) break
    }
    return cleaned.length > 0 ? cleaned : undefined
  }
  const skills = cleanArr(result.data.correctedSkills, 12)
  if (skills) out.correctedSkills = skills
  const industries = cleanArr(result.data.correctedIndustries, 6)
  if (industries) out.correctedIndustries = industries
  const roles = cleanArr(result.data.correctedRoles, 6)
  if (roles) out.correctedRoles = roles
  out.correctionFreeform = result.data.correctionFreeform ?? null

  return out
}
