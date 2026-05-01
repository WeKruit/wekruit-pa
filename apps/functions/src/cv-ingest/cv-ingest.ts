/**
 * Stream D — CV ingestion pipeline.
 *
 * Triggered fire-and-forget from the Sendblue webhook (apps/functions/src/sendblue/webhook.ts)
 * the moment an inbound iMessage with `media_url` is received. Path:
 *
 *   1. HTTP-fetch the PDF (30 s timeout)
 *   2. pdf-parse → text (capped to first ~50 pages / 100 KB to bound LLM cost)
 *   3. OpenAI Structured Output (gpt-5.4-nano + JSON Schema) → typed profile
 *   4. Firestore write to `parsedCandidateResumes/{auto-id}` matching the
 *      shape used by the existing 44 docs (candidateProfile / experiences / education)
 *
 * Architectural pivot 2026-04-30: Claire IS the recruiter — there is no
 * separate RecruiterAgent. This pipeline only writes the document; the
 * orchestrator's systemPrompt assembly (packages/pa-orchestrator) joins the
 * most-recent doc into Claire's prompt so she has CV context across turns.
 *
 * NEVER throws — every error path returns `{ ok: false, reason }`. The
 * webhook caller does fire-and-forget; an unhandled rejection would only
 * pollute the CF logs.
 */

import type { Firestore } from "firebase-admin/firestore"

export type IngestCvInput = {
  userId: string
  mediaUrl: string
  sessionId?: string
}

export type IngestCvResult =
  | { ok: true; resumeId: string }
  | { ok: false; reason: string }

export type CandidateProfile = {
  name: string | null
  email: string | null
  phone: string | null
  linkedIn: string | null
  location: string
  skills: string[]
}

export type Experience = {
  company: string
  title: string
  startDate: string
  endDate: string | null
  location: string
  description: string
}

export type Education = {
  school: string
  degree: string
  field: string | null
  startDate: string | null
  endDate: string | null
}

export type StructuredCv = {
  candidateProfile: CandidateProfile
  experiences: Experience[]
  education: Education[]
}

export type IngestCvDeps = {
  /** Optional in production (resolved via getFirestore()); inject for tests. */
  db?: Firestore
  /** Inject for tests; defaults to global fetch + AbortController + 30 s timeout. */
  fetchPdf?: (url: string) => Promise<{ bytes: Uint8Array; contentType?: string }>
  /** Inject for tests; defaults to pdf-parse npm extraction. */
  parsePdf?: (bytes: Uint8Array) => Promise<{ text: string; numPages?: number }>
  /** Inject for tests; defaults to OpenAI Responses API + json_schema. */
  llmExtract?: (text: string) => Promise<{
    parsed: StructuredCv
    usage?: { input_tokens?: number; output_tokens?: number; total_tokens?: number }
  }>
  /** Inject for tests; defaults to () => new Date().toISOString(). */
  nowIso?: () => string
  /** Logger (no-op default). */
  log?: (event: string, payload?: Record<string, unknown>) => void
}

const PARSED_RESUMES_COLLECTION = "parsedCandidateResumes"
const FETCH_TIMEOUT_MS = 30_000
const MAX_PDF_PAGES = 50
const MAX_TEXT_BYTES = 100_000 // 100 KB cap to bound LLM cost
const LLM_MODEL = "gpt-5.4-nano"

// --- Default fetch ---------------------------------------------------------

async function defaultFetchPdf(url: string): Promise<{ bytes: Uint8Array; contentType?: string }> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS)
  try {
    const r = await fetch(url, { signal: ctrl.signal })
    if (!r.ok) {
      throw new Error(`HTTP ${r.status} ${r.statusText}`)
    }
    const buf = await r.arrayBuffer()
    return { bytes: new Uint8Array(buf), contentType: r.headers.get("content-type") ?? undefined }
  } finally {
    clearTimeout(timer)
  }
}

// --- Default pdf-parse -----------------------------------------------------
// pdf-parse@1.1.1 has a debug-mode init bug: requiring the package root
// triggers a test-fixture read (`./test/data/05-versions-space.pdf` ENOENT
// in production bundles). Importing the inner lib path bypasses that hazard.

async function defaultParsePdf(bytes: Uint8Array): Promise<{ text: string; numPages?: number }> {
  // ESM dynamic import of the CJS sub-path — esbuild bundles correctly.
  const mod = (await import("pdf-parse/lib/pdf-parse.js")) as unknown as {
    default: (data: Buffer, opts?: { max?: number }) => Promise<{ text: string; numpages: number }>
  }
  const fn = mod.default
  const buf = Buffer.from(bytes)
  const result = await fn(buf, { max: MAX_PDF_PAGES })
  return { text: result.text ?? "", numPages: result.numpages }
}

// --- Default LLM extraction ------------------------------------------------

const CV_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["candidateProfile", "experiences", "education"],
  properties: {
    candidateProfile: {
      type: "object",
      additionalProperties: false,
      required: ["name", "email", "phone", "linkedIn", "location", "skills"],
      properties: {
        name: { type: ["string", "null"] },
        email: { type: ["string", "null"] },
        phone: { type: ["string", "null"] },
        linkedIn: { type: ["string", "null"] },
        location: { type: "string" },
        skills: { type: "array", items: { type: "string" } },
      },
    },
    experiences: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["company", "title", "startDate", "endDate", "location", "description"],
        properties: {
          company: { type: "string" },
          title: { type: "string" },
          startDate: { type: "string" },
          endDate: { type: ["string", "null"] },
          location: { type: "string" },
          description: { type: "string" },
        },
      },
    },
    education: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["school", "degree", "field", "startDate", "endDate"],
        properties: {
          school: { type: "string" },
          degree: { type: "string" },
          field: { type: ["string", "null"] },
          startDate: { type: ["string", "null"] },
          endDate: { type: ["string", "null"] },
        },
      },
    },
  },
} as const

const SYSTEM_PROMPT =
  "You are a resume parser. Extract structured data from the CV text. Be accurate; null when unknown."

async function defaultLlmExtract(text: string): Promise<{
  parsed: StructuredCv
  usage?: { input_tokens?: number; output_tokens?: number; total_tokens?: number }
}> {
  const apiKey =
    process.env.PA_OPENAI_AGENT_API_KEY?.trim() || process.env.OPENAI_API_KEY?.trim() || ""
  if (!apiKey) throw new Error("missing_api_key")
  const baseURL =
    process.env.PA_OPENAI_AGENT_BASE_URL?.trim() || "https://api.openai.com/v1"
  // Lazy import keeps module load cheap (cv-ingest is rarely-hit path).
  const { default: OpenAI } = (await import("openai")) as unknown as {
    default: new (init: { apiKey: string; baseURL?: string }) => {
      responses: {
        create: (req: Record<string, unknown>) => Promise<{
          output_text?: string
          output?: Array<{ content?: Array<{ text?: string }> }>
          usage?: { input_tokens?: number; output_tokens?: number; total_tokens?: number }
        }>
      }
    }
  }
  const client = new OpenAI({ apiKey, baseURL })
  const resp = await client.responses.create({
    model: LLM_MODEL,
    input: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: text },
    ],
    text: {
      format: {
        type: "json_schema",
        name: "candidate_profile",
        schema: CV_JSON_SCHEMA,
        strict: true,
      },
    },
  })
  // The Responses API exposes the structured payload in either output_text
  // or the first output[].content[].text — defensively check both.
  const outputText =
    typeof resp.output_text === "string" && resp.output_text.length > 0
      ? resp.output_text
      : Array.isArray(resp.output) && resp.output[0]?.content?.[0]?.text
        ? resp.output[0]!.content![0]!.text!
        : ""
  if (!outputText) throw new Error("empty_llm_output")
  const parsed = JSON.parse(outputText) as StructuredCv
  return { parsed, usage: resp.usage }
}

// --- Validation ------------------------------------------------------------

function isStringOrNull(v: unknown): v is string | null {
  return v === null || typeof v === "string"
}
function isStringArr(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string")
}
function validateStructuredCv(raw: unknown): StructuredCv {
  if (!raw || typeof raw !== "object") throw new Error("not_object")
  const o = raw as Record<string, unknown>
  const cp = o.candidateProfile as Record<string, unknown> | undefined
  if (!cp || typeof cp !== "object") throw new Error("missing_candidateProfile")
  if (!isStringOrNull(cp.name)) throw new Error("bad_name")
  if (!isStringOrNull(cp.email)) throw new Error("bad_email")
  if (!isStringOrNull(cp.phone)) throw new Error("bad_phone")
  if (!isStringOrNull(cp.linkedIn)) throw new Error("bad_linkedIn")
  if (typeof cp.location !== "string") throw new Error("bad_location")
  if (!isStringArr(cp.skills)) throw new Error("bad_skills")
  if (!Array.isArray(o.experiences)) throw new Error("missing_experiences")
  for (const e of o.experiences as unknown[]) {
    const r = e as Record<string, unknown>
    if (typeof r.company !== "string") throw new Error("bad_experience.company")
    if (typeof r.title !== "string") throw new Error("bad_experience.title")
    if (typeof r.startDate !== "string") throw new Error("bad_experience.startDate")
    if (!isStringOrNull(r.endDate)) throw new Error("bad_experience.endDate")
    if (typeof r.location !== "string") throw new Error("bad_experience.location")
    if (typeof r.description !== "string") throw new Error("bad_experience.description")
  }
  if (!Array.isArray(o.education)) throw new Error("missing_education")
  for (const e of o.education as unknown[]) {
    const r = e as Record<string, unknown>
    if (typeof r.school !== "string") throw new Error("bad_education.school")
    if (typeof r.degree !== "string") throw new Error("bad_education.degree")
    if (!isStringOrNull(r.field)) throw new Error("bad_education.field")
    if (!isStringOrNull(r.startDate)) throw new Error("bad_education.startDate")
    if (!isStringOrNull(r.endDate)) throw new Error("bad_education.endDate")
  }
  return o as unknown as StructuredCv
}

function deriveOriginalFileName(mediaUrl: string): string {
  try {
    const u = new URL(mediaUrl)
    const tail = u.pathname.split("/").pop() ?? ""
    return tail || "resume.pdf"
  } catch {
    const tail = mediaUrl.split("/").pop() ?? ""
    return tail || "resume.pdf"
  }
}

// --- Public entry point ----------------------------------------------------

export async function ingestCv(
  args: IngestCvInput,
  deps?: IngestCvDeps
): Promise<IngestCvResult> {
  // Resolve a Firestore handle when caller didn't inject one (production
  // path from the webhook fire-and-forget). Test paths pass deps.db.
  let db: Firestore | undefined = deps?.db
  if (!db) {
    try {
      const mod = (await import("firebase-admin/firestore")) as {
        getFirestore: () => Firestore
      }
      db = mod.getFirestore()
    } catch (err) {
      // No admin SDK available (e.g. unit harness without deps.db) —
      // treat as configuration failure.
      ;(deps?.log ?? (() => {}))("pa.cv_ingest.error", {
        stage: "init",
        error: err instanceof Error ? err.message : String(err),
      })
      return { ok: false, reason: "no_firestore" }
    }
  }
  const dbHandle: Firestore = db
  const log = deps?.log ?? (() => {})
  const nowIso = deps?.nowIso ?? (() => new Date().toISOString())
  const fetchPdf = deps?.fetchPdf ?? defaultFetchPdf
  const parsePdf = deps?.parsePdf ?? defaultParsePdf
  const llmExtract = deps?.llmExtract ?? defaultLlmExtract

  if (!args || typeof args !== "object" || !args.userId || !args.mediaUrl) {
    return { ok: false, reason: "invalid_input" }
  }

  // 1. Download
  let bytes: Uint8Array
  try {
    const downloaded = await fetchPdf(args.mediaUrl)
    bytes = downloaded.bytes
  } catch (err) {
    log("pa.cv_ingest.error", {
      stage: "download",
      error: err instanceof Error ? err.message : String(err),
      userId: args.userId,
    })
    return { ok: false, reason: "download_failed" }
  }

  // 2. PDF text extraction
  let text: string
  try {
    const out = await parsePdf(bytes)
    text = (out.text ?? "").slice(0, MAX_TEXT_BYTES)
    if (!text.trim()) {
      log("pa.cv_ingest.error", { stage: "parse", error: "empty_text", userId: args.userId })
      return { ok: false, reason: "pdf_parse_failed" }
    }
  } catch (err) {
    log("pa.cv_ingest.error", {
      stage: "parse",
      error: err instanceof Error ? err.message : String(err),
      userId: args.userId,
    })
    return { ok: false, reason: "pdf_parse_failed" }
  }

  // 3. LLM structured extraction
  let parsed: StructuredCv
  let usage: { input_tokens?: number; output_tokens?: number; total_tokens?: number } | undefined
  try {
    const out = await llmExtract(text)
    parsed = validateStructuredCv(out.parsed)
    usage = out.usage
  } catch (err) {
    log("pa.cv_ingest.error", {
      stage: "llm",
      error: err instanceof Error ? err.message : String(err),
      userId: args.userId,
    })
    return { ok: false, reason: "llm_parse_failed" }
  }

  // Cost-tracking telemetry — input/output token counts feed cost
  // dashboards. Estimated $0.0005-0.002 per CV with gpt-5.4-nano.
  log("pa.cv_ingest.cost", {
    userId: args.userId,
    inputTokens: usage?.input_tokens,
    outputTokens: usage?.output_tokens,
    totalTokens: usage?.total_tokens,
    model: LLM_MODEL,
  })

  // 4. Firestore write
  try {
    const ts = nowIso()
    const doc = {
      userId: args.userId,
      candidateProfile: parsed.candidateProfile,
      experiences: parsed.experiences,
      education: parsed.education,
      originalFileName: deriveOriginalFileName(args.mediaUrl),
      fileType: "application/pdf",
      studentFrom: null,
      sessionId: args.sessionId ?? null,
      mediaUrl: args.mediaUrl,
      ingestedAt: ts,
      ingestedVia: "imessage-attachment",
      // Match existing 44-doc convention: createdAt is a Firestore Timestamp.
      // Firestore Admin SDK accepts a Date here and converts server-side.
      createdAt: new Date(ts),
    }
    const ref = await dbHandle.collection(PARSED_RESUMES_COLLECTION).add(doc)
    log("pa.cv_ingest.ok", { userId: args.userId, resumeId: ref.id })
    return { ok: true, resumeId: ref.id }
  } catch (err) {
    log("pa.cv_ingest.error", {
      stage: "firestore",
      error: err instanceof Error ? err.message : String(err),
      userId: args.userId,
    })
    return { ok: false, reason: "firestore_write_failed" }
  }
}
