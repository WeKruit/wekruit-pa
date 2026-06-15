// Vision/OCR text-extraction fallback for résumé PDFs.
//
// WHY (Adam 2026-06-15, live incident — Chang Shu / cathyshu@andrew.cmu.edu):
// `pdf-parse` is a pure text-layer extractor with NO OCR. It returns empty (or
// garbled CID-font) text on whole classes of "text-based" PDFs — scanned/image
// résumés, Canva/Figma/newer-export PDFs, and Type0/CID fonts lacking a proper
// ToUnicode CMap. The public job page then dead-ends the candidate with
// "We could not read this resume. Try a cleaner text-based PDF." forever — they
// can NEVER enter. A real candidate (account created, sender number assigned,
// zero parsed résumés, zero sessions) was fully blocked this way.
//
// This module is the second extractor: when the primary text layer is empty or
// looks garbled, hand the raw PDF bytes to a vision-capable model (Claude
// document block → OCR + layout reading) and recover plain text. Best-effort and
// fail-soft: no key / model error / empty result → returns null and the caller
// surfaces the original failure unchanged. NEVER throws into the ingest path.

import { getAnthropicConfig } from "../lib/llm-providers.js"

export type VisionFallbackLog = (event: string, payload?: Record<string, unknown>) => void

// Claude Sonnet reads PDFs natively (vision/OCR) — same tier the résumé parser
// already uses as its Anthropic secondary (packages/pa-resume-parser/router.ts).
const VISION_MODEL = "claude-sonnet-4-6"
// PDF document blocks are bounded by Anthropic at ~32MB / 100 pages. The ingest
// path already caps upload size well below this; keep a defensive guard anyway.
const MAX_VISION_PDF_BYTES = 24 * 1024 * 1024
const VISION_TIMEOUT_MS = 60_000

const EXTRACTION_PROMPT =
  "This is a candidate's résumé/CV as a PDF. Transcribe ALL of its text content " +
  "verbatim as plain UTF-8 text, preserving reading order (name/header first, then " +
  "each section: summary, experience, education, skills, projects). Include every " +
  "company, title, date, bullet, school, and skill exactly as written. Do not " +
  "summarize, reformat into JSON, add commentary, or omit anything. Output ONLY the " +
  "transcribed résumé text."

/**
 * Heuristic: did the primary text extractor return content we can trust?
 *
 * Catches the two deterministic failure modes that strand candidates:
 *   - empty / whitespace-only  → image/scanned PDF, or extractor returned nothing
 *   - garbled                  → CID/Type0 font without ToUnicode produces a high
 *                                ratio of replacement chars (U+FFFD) and
 *                                non-printable/non-letter noise
 *
 * Conservative by design: a false negative (we accept slightly-noisy text) just
 * keeps the cheap path; a false positive (we trigger vision on good text) only
 * costs one extra LLM call and still yields correct text. Unicode-letter aware so
 * non-Latin résumés (CJK etc.) are NOT misflagged as garbled.
 */
export function primaryTextLooksUsable(raw: string): boolean {
  const text = (raw ?? "").trim()
  if (text.length < 40) return false
  // Replacement-character density — a hallmark of broken font encoding.
  const replacements = (text.match(/�/g) ?? []).length
  if (replacements / text.length > 0.02) return false
  // Printable-content ratio: letters (any script), digits, whitespace, and
  // common punctuation. Garbled CID output is dominated by control/odd glyphs.
  let meaningful = 0
  for (const ch of text) {
    if (/[\p{L}\p{N}\s.,;:'"()/&%+@#\-–—]/u.test(ch)) meaningful++
  }
  if (meaningful / text.length < 0.7) return false
  // A real résumé has many word-like tokens; mojibake runs have ~none. Keep this
  // low — a sparse-but-real extract must pass; only true garble has <6 tokens.
  const wordTokens = (text.match(/[\p{L}\p{N}]{2,}/gu) ?? []).length
  if (wordTokens < 6) return false
  return true
}

export interface VisionExtractDeps {
  /** Test seam: override the raw Anthropic call. */
  callAnthropicPdf?: (args: {
    apiKey: string
    base64: string
    model: string
  }) => Promise<string>
}

async function defaultCallAnthropicPdf(args: {
  apiKey: string
  base64: string
  model: string
}): Promise<string> {
  const { default: Anthropic } = (await import("@anthropic-ai/sdk")) as unknown as {
    default: new (init: { apiKey: string; timeout?: number; maxRetries?: number }) => {
      messages: {
        create: (req: Record<string, unknown>) => Promise<{
          content?: Array<{ type?: string; text?: string }>
        }>
      }
    }
  }
  const client = new Anthropic({ apiKey: args.apiKey, timeout: VISION_TIMEOUT_MS, maxRetries: 1 })
  const resp = await client.messages.create({
    model: args.model,
    max_tokens: 8000,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "document",
            source: { type: "base64", media_type: "application/pdf", data: args.base64 },
          },
          { type: "text", text: EXTRACTION_PROMPT },
        ],
      },
    ],
  })
  if (!Array.isArray(resp.content)) return ""
  return resp.content
    .filter((b) => b?.type === "text" && typeof b.text === "string")
    .map((b) => b.text as string)
    .join("\n")
    .trim()
}

/**
 * Attempt to recover résumé text from PDF bytes via a vision model. Returns the
 * extracted text, or null when unavailable/unusable. Fail-soft: never throws.
 */
export async function extractResumeTextViaVision(
  bytes: Uint8Array,
  log: VisionFallbackLog,
  userId: string | undefined,
  deps?: VisionExtractDeps,
): Promise<string | null> {
  const t0 = Date.now()
  try {
    if (!bytes || bytes.length === 0) return null
    // The Anthropic document block requires a real PDF (%PDF- header). DOCX /
    // other formats would only burn a doomed call — skip them.
    if (!(bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46)) {
      log("pa.cv_ingest.vision_fallback_skipped", { reason: "not_pdf", userId })
      return null
    }
    if (bytes.length > MAX_VISION_PDF_BYTES) {
      log("pa.cv_ingest.vision_fallback_skipped", { reason: "too_large", bytes: bytes.length, userId })
      return null
    }
    const { apiKey } = getAnthropicConfig()
    const call = deps?.callAnthropicPdf ?? defaultCallAnthropicPdf
    // A real key is required only for the default (network) path; an injected
    // test seam supplies its own behavior.
    if (!apiKey && !deps?.callAnthropicPdf) {
      log("pa.cv_ingest.vision_fallback_skipped", { reason: "no_anthropic_key", userId })
      return null
    }
    const base64 = Buffer.from(bytes).toString("base64")
    const text = (await call({ apiKey: apiKey ?? "", base64, model: VISION_MODEL })).trim()
    log("pa.cv_ingest.vision_fallback", {
      ms: Date.now() - t0,
      ok: text.length > 0,
      chars: text.length,
      userId,
    })
    return text.length > 0 ? text : null
  } catch (err) {
    log("pa.cv_ingest.vision_fallback_error", {
      ms: Date.now() - t0,
      error: err instanceof Error ? err.message : String(err),
      userId,
    })
    return null
  }
}
