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
 * Stream E (post-write side effects, both fire-and-forget, both kill-switched):
 *   E1. Findings follow-up — gpt-5.4-nano produces a 2-3 sentence Claire-voice
 *       message referencing the CV; enqueued onto `pa-outbound/out-cvfindings-{resumeId}`
 *       (idempotent via Firestore `.create()`). The existing `paSendblueOutbox`
 *       Firestore trigger picks it up + sends.
 *   E2. Mem0 long-term memory write — the parsed CV summary is written to the
 *       same Qdrant `pa-memory` partition the orchestrator uses, so future
 *       semantic retrieval (e.g. "looking for fintech jobs") surfaces it.
 *
 * Architectural pivot 2026-04-30: Claire IS the recruiter — there is no
 * separate RecruiterAgent. This pipeline only writes the document; the
 * orchestrator's systemPrompt assembly (packages/pa-orchestrator) joins the
 * most-recent doc into Claire's prompt so she has CV context across turns.
 *
 * NEVER throws — every error path returns `{ ok: false, reason }`. The
 * webhook caller does fire-and-forget; an unhandled rejection would only
 * pollute the CF logs. The Stream E side effects use `Promise.allSettled`
 * + per-branch try/catch so a Mem0 outage CANNOT taint E1, and an LLM
 * failure CANNOT taint the parsedCandidateResumes write.
 */

import type { Firestore } from "firebase-admin/firestore"
import {
  INDUSTRY_TAGS,
  mapToCanonicalIndustry,
  type IndustryTag,
} from "./industry-tags.js"
import { checkResumeGate } from "./cv-gate.js"
import {
  isQuotaExhausted,
  readQuotaCount,
  incrementQuota,
} from "./cv-quota.js"
import {
  fetchPdfWithSizeCap,
  PdfSizeError,
  MAX_PDF_BYTES,
} from "./cv-size-cap.js"
import {
  computeCvEmbedding,
  type ComputeCvEmbeddingResult,
  type EmbeddingResumeInput,
} from "../lib/embeddings.js"

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
  /** Stream F1 — 1-3 industry tags inferred from experiences. Always present (≥ 1, ≤ 3). */
  industryTags: IndustryTag[]
}

/** Stream E — minimal user shape needed for follow-up + Mem0 partition. */
export type CvFollowupUser = {
  toE164: string | null
  mem0UserId: string | null
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

  // ---- Stream E injectables (all optional; production paths default-wired) ----

  /**
   * Inject for tests. Defaults to a one-shot OpenAI Responses API call
   * (gpt-5.4-nano) producing a 2-3 sentence Claire-voice follow-up.
   */
  llmFollowup?: (parsed: StructuredCv) => Promise<string>
  /**
   * Inject for tests. Defaults to a Firestore `.doc(id).create()` write
   * onto the `pa-outbound` collection (idempotent — duplicate ids fail the
   * `create` and the caller logs + skips).
   */
  enqueueOutboundFollowup?: (
    db: Firestore,
    docId: string,
    payload: Record<string, unknown>
  ) => Promise<void>
  /**
   * Inject for tests. Defaults to `mem0Add` from `@pa/memory` with config
   * read from process env at call time.
   */
  mem0Add?: (args: {
    userId: string
    partitionKey: string
    factBody: string
  }) => Promise<void>
  /**
   * Inject for tests. Defaults to a Firestore lookup of `pa-users/{userId}`
   * returning the fields needed by E1 (toE164) and E2 (mem0UserId).
   */
  lookupUserForFollowup?: (db: Firestore, userId: string) => Promise<CvFollowupUser | null>

  // ---- Stream H3 — second-CV detection + overwrite-prompt UX ----
  //
  // Flag-gated (paCvOverwritePromptEnabled, default OFF). When the user
  // already has a parsedCandidateResumes row AND the flag is ON, we DO NOT
  // write the new CV directly. Instead we stage it in `pa-cv-pending` and
  // enqueue an outbound iMessage asking whether to replace the previous
  // version (❤️ tapback = replace, 🤔 = supplement). 24-hour TTL fallback
  // auto-promotes (replace) via runPendingCvTtlSweep.

  /**
   * Inject for tests. Defaults to a Firestore feature-flag lookup via
   * @pa/pa-persistence's getFlag. Resolves the flag for THIS user.
   */
  isFlagEnabled?: (db: Firestore, key: string, userId: string) => Promise<boolean>
  /**
   * Inject for tests. Defaults to a Firestore query of
   * `parsedCandidateResumes` where `userId == X`, ordered by `createdAt`
   * desc, limit 1 (filters out rows with `archived == true`). Returns the
   * most recent NON-archived doc, or null when the user has none.
   */
  findExistingResume?: (
    db: Firestore,
    userId: string
  ) => Promise<{ id: string; data: Record<string, unknown> } | null>
  /**
   * Inject for tests. Defaults to a Firestore `.doc(newResumeId).create()`
   * write on the `pa-cv-pending` collection. Idempotent (duplicate id
   * throws ALREADY_EXISTS, caller catches + logs).
   */
  enqueueCvOverwritePending?: (
    db: Firestore,
    newResumeId: string,
    payload: Record<string, unknown>
  ) => Promise<void>

  // ---- iter30 WS1 — gate / quota injectables -----------------------------
  //
  // Defaults wire to the real Firestore-backed implementations. Pre-iter30
  // tests use simple in-memory db stubs that never populate `resumeAccepted`
  // / `resumeParseCount` — to keep them green during ramp, we expose
  // overridable predicates here. The CHECKED-IN webhook path uses the
  // defaults; manually-constructed integration tests (cv-overwrite, etc.)
  // pass override fns that always succeed (gate open, quota=0).

  /**
   * Returns gate state. Default: checkResumeGate from cv-gate.ts. Override
   * to bypass for tests without setting up Firestore docs.
   */
  checkGate?: (
    db: Firestore,
    userId: string,
    nowIso: string
  ) => Promise<{ open: boolean; reason: string }>
  /** Override for tests. Default: readQuotaCount from cv-quota.ts. */
  readQuotaCount?: (db: Firestore, userId: string) => Promise<number>
  /** Override for tests. Default: incrementQuota from cv-quota.ts. */
  incrementQuota?: (db: Firestore, userId: string, nowIso: string) => Promise<void>
  /** Override for tests. Default: defaultIsParserV2Enabled (Firestore flag). */
  isParserV2Enabled?: (db: Firestore, userId: string) => Promise<boolean>
  /**
   * Override for tests. Default: parseResumeText from @pa/pa-resume-parser.
   * Test paths can produce a stub ParserV2Output without hitting OpenAI.
   */
  parserV2Extract?: (
    text: string,
    log: (event: string, payload?: Record<string, unknown>) => void
  ) => Promise<{
    parsed: import("@pa/pa-resume-parser").ParsedResumeData
    usedTier: import("@pa/pa-resume-parser").Tier
    usedModel: string
    usage?: { input_tokens?: number; output_tokens?: number; total_tokens?: number }
  }>
  /** Skip quota / gate enforcement entirely. Tests use this; production never. */
  skipLimitEnforcement?: boolean

  // ---- iter34 sprint B.9 — synchronous CV embedding compute -------------
  //
  // Default: lib/embeddings.ts → OpenAI text-embedding-3-small. Injected
  // for tests so we can simulate OpenAI throws / empty vectors without
  // mocking the global SDK. Returns null on any failure → ingestCv MUST
  // NOT block the parsedCandidateResumes write on embedding success.
  /** Inject for tests. Default: lib/embeddings.computeCvEmbedding. */
  computeEmbedding?: (
    input: EmbeddingResumeInput
  ) => Promise<ComputeCvEmbeddingResult | null>
}

const PARSED_RESUMES_COLLECTION = "parsedCandidateResumes"
const FETCH_TIMEOUT_MS = 30_000
const MAX_PDF_PAGES = 50
const MAX_TEXT_BYTES = 100_000 // 100 KB cap to bound LLM cost
const LLM_MODEL = "gpt-5.4-nano"

// Stream E
const OUTBOUND_COLLECTION = "pa-outbound"
const FOLLOWUP_DOC_PREFIX = "out-cvfindings-"
const PA_USERS_COLLECTION = "pa-users"

// Stream H3 — second-CV overwrite UX
export const CV_OVERWRITE_FLAG_KEY = "paCvOverwritePromptEnabled"
export const CV_PENDING_COLLECTION = "pa-cv-pending"
export const CV_OVERWRITE_OUTBOUND_PREFIX = "out-cv-overwrite-"

// iter30 WS1 — feature flag for parseResume v2 (3-tier retry chain).
// When ON for this user, we route through @pa/pa-resume-parser instead of
// the legacy single-shot defaultLlmExtract. Default OFF; ramp staff first.
export const RESUME_PARSER_V2_FLAG_KEY = "paResumeParserV2"

// iter30 WS1 — Claire-voice rejection bodies for the 3 limit-rejected paths.
// Idempotent on `out-cv-reject-{userId}-{YYYYMMDD}-{reason}` per detail-plan §5.4.
export const CV_REJECT_OUTBOUND_PREFIX = "out-cv-reject-"
const CV_REJECT_TEXTS: Record<"not_invited" | "quota_exhausted" | "pdf_too_large", { zh: string; en: string }> = {
  not_invited: {
    zh: "我还没问你要简历呢，先聊聊呗～你想找啥方向?",
    en: "haven't asked for your resume yet — wanna chat first about what you're looking for?",
  },
  quota_exhausted: {
    zh: "我已经看过你两份简历了😅 这次咱们口头聊聊吧 — 现在卡在哪个环节?",
    en: "I've read two of your resumes already — let's just talk this time. Where are you stuck?",
  },
  pdf_too_large: {
    zh: "诶，你这简历是不是图片版的? 文件太大了 (>5MB)，发个文字版 PDF 给我看看~",
    en: "is your resume an image PDF? too big to read (>5MB) — can you send a text-based one?",
  },
}
const CV_PENDING_TTL_MS = 24 * 60 * 60 * 1000 // 24 hours
const CV_OVERWRITE_PROMPT_BODY =
  "欸看到你又发了份新简历 — 替代之前那份吗？回复 ❤️ = 替代旧的，🤔 = 当作另一个版本参考 (24 小时后默认替代)"

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
  required: ["candidateProfile", "experiences", "education", "industryTags"],
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
    industryTags: {
      type: "array",
      // 1..3 inclusive. The validator clamps + falls back to ["other"] when
      // the LLM emits anything else, so this is informational for the
      // structured-output contract.
      minItems: 1,
      maxItems: 3,
      items: {
        type: "string",
        enum: [...INDUSTRY_TAGS],
      },
    },
  },
} as const

const SYSTEM_PROMPT =
  "You are a resume parser. Extract structured data from the CV text. Be accurate; null when unknown. " +
  "For industryTags, return 1-3 BEST-MATCH industry buckets from this fixed list (in priority order, no duplicates): " +
  INDUSTRY_TAGS.join(", ") +
  ". Choose based on the candidate's most recent / most senior experience. Use 'other' only when no other tag fits."

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
  // industryTags: defensive — clamp to enum + max 3, fall back to ["other"]
  // when the LLM emits unknown / empty / malformed values. Never throw on
  // industry alone; this field is enrichment, not core CV data.
  const rawTags = Array.isArray(o.industryTags) ? o.industryTags : []
  const seen = new Set<IndustryTag>()
  const tags: IndustryTag[] = []
  for (const t of rawTags) {
    if (typeof t !== "string") continue
    const canonical = mapToCanonicalIndustry(t)
    // mapToCanonicalIndustry never returns "other" unless the input is
    // actually unknown — preserve that signal instead of dedupe-skipping it.
    if (!seen.has(canonical)) {
      seen.add(canonical)
      tags.push(canonical)
      if (tags.length >= 3) break
    }
  }
  if (tags.length === 0) tags.push("other")
  ;(o as unknown as StructuredCv).industryTags = tags
  return o as unknown as StructuredCv
}

// ---------------------------------------------------------------------------
// iter34 sprint A.1 — topSkills compute (ghost-field fix)
//
// Before this sprint, `parsedCandidateResumes/{id}` documents never wrote a
// `topSkills` field, but `orchestrator-deps.generateJobRecs` reads it as a
// signal for SWE / role-specific matching. The fallback was the 10-bucket
// `industryTags`, which is far too coarse for a SWE candidate ("tech" bucket
// matches every other role in tech). Result: SWE candidates were perpetually
// fanning out to 10 buckets and the job-rec quality warning fired.
//
// computeTopSkills now derives the field at write time. Sources:
//   1. v2 parser path: `workHistory[].skills` (if present — defensive read;
//      the current ParsedResumeData schema doesn't carry per-experience
//      skills, but we tolerate future extensions without code changes).
//   2. `candidateProfile.skills` (LLM-extracted; both v1 and v2 paths
//      populate this — v2 via adaptV2ToStructuredCv).
//
// Frequency = number of times the same normalized skill appears across all
// sources (a skill listed under three jobs ranks above one listed once).
// Output is normalized (trim + lowercase), deduped, filtered (empty / single-
// char / numeric-only dropped), and capped at 12.
// ---------------------------------------------------------------------------

const TOP_SKILLS_CAP = 12

/** Coerce arbitrary v2 workHistory shapes into a safe `string[]`. */
function readSkillsField(entry: unknown): string[] {
  if (!entry || typeof entry !== "object") return []
  const v = (entry as Record<string, unknown>).skills
  if (!Array.isArray(v)) return []
  return v.filter((x): x is string => typeof x === "string")
}

function normalizeSkill(raw: string): string | null {
  const trimmed = raw.trim().toLowerCase()
  if (trimmed.length <= 1) return null
  // Drop pure-numeric tokens ("2024", "10") — those are dates / years not
  // skills. Keep alphanumeric tokens like "ec2" or "es6".
  if (/^[0-9]+$/.test(trimmed)) return null
  return trimmed
}

export function computeTopSkills(args: {
  candidateProfileSkills?: readonly string[]
  workHistory?: ReadonlyArray<unknown>
}): string[] {
  const counts = new Map<string, number>()
  const order: string[] = [] // insertion order tiebreak (stable sort)

  const ingest = (raw: unknown): void => {
    if (typeof raw !== "string") return
    const norm = normalizeSkill(raw)
    if (!norm) return
    if (!counts.has(norm)) {
      counts.set(norm, 1)
      order.push(norm)
    } else {
      counts.set(norm, counts.get(norm)! + 1)
    }
  }

  // Source 1 — v2 workHistory[].skills (defensive; field may not exist).
  if (Array.isArray(args.workHistory)) {
    for (const w of args.workHistory) {
      for (const s of readSkillsField(w)) ingest(s)
    }
  }
  // Source 2 — candidateProfile.skills (always present after validation).
  if (Array.isArray(args.candidateProfileSkills)) {
    for (const s of args.candidateProfileSkills) ingest(s)
  }

  // Sort by descending frequency; ties broken by first-seen order so
  // candidateProfile order is preserved when nothing else differentiates.
  const sorted = order
    .slice()
    .sort((a, b) => {
      const da = counts.get(b)! - counts.get(a)!
      if (da !== 0) return da
      return order.indexOf(a) - order.indexOf(b)
    })
  return sorted.slice(0, TOP_SKILLS_CAP)
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

// ---------------------------------------------------------------------------
// Stream E — kill-switch readers
// ---------------------------------------------------------------------------

function envFlagTrue(name: string): boolean {
  const raw = process.env[name]
  if (typeof raw !== "string") return false
  const v = raw.trim().toLowerCase()
  return v === "true" || v === "1" || v === "on" || v === "yes"
}

function followupKillSwitchOn(): boolean {
  return envFlagTrue("PA_CV_FINDINGS_FOLLOWUP_DISABLED")
}

function mem0KillSwitchOn(): boolean {
  return envFlagTrue("PA_CV_MEM0_WRITE_DISABLED")
}

// ---------------------------------------------------------------------------
// Stream E — language detection (Chinese vs English vs default)
// ---------------------------------------------------------------------------

/**
 * Returns "zh" when the structured CV has more CJK characters than ASCII
 * letters in the concatenated profile + experience text. Otherwise "en".
 * Used to bias LLM follow-up + Mem0 fact wording. Cheap; no network.
 */
export function detectCvLang(parsed: StructuredCv): "zh" | "en" {
  const blob = [
    parsed.candidateProfile.name ?? "",
    parsed.candidateProfile.location ?? "",
    parsed.candidateProfile.skills.join(" "),
    ...parsed.experiences.flatMap((e) => [e.company, e.title, e.location, e.description]),
    ...parsed.education.flatMap((e) => [e.school, e.degree, e.field ?? ""]),
  ].join(" ")
  let cjk = 0
  let ascii = 0
  for (const ch of blob) {
    const code = ch.codePointAt(0) ?? 0
    if (code >= 0x4e00 && code <= 0x9fff) cjk++
    else if ((code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a)) ascii++
  }
  return cjk > ascii ? "zh" : "en"
}

// ---------------------------------------------------------------------------
// Stream E1 — findings follow-up LLM + outbound enqueue
// ---------------------------------------------------------------------------

const FOLLOWUP_SYSTEM_PROMPT =
  "You are Claire (柯莱儿/小柯) — Bay Area EM, ride-or-die roommate. " +
  "User just uploaded a resume; you've already sent a quick tapback ❤️. " +
  "Now reply with ONE short follow-up that:\n" +
  "1. References 2-3 specific things from their CV (last role, company, or signature project — pick what's most distinctive)\n" +
  "2. Asks ONE forward question about job direction (大厂/startup, industry, sponsorship — pick ONE)\n" +
  "3. ≤3 sentences total. Roommate-style, NOT formal. No markdown. No emoji unless natural. " +
  "Use language matching the resume (zh CV → zh reply, en CV → en reply, mixed → user-language).\n\n" +
  "HARD RULES (Bible v7.5.2 — apply to ALL output):\n" +
  "- ≤3 sentences. No markdown headers, no bullet lists, no bold/italic.\n" +
  "- No parens around URLs. No emoji spam. No formal disclaimers.\n" +
  "- Never break character. Never include meta commentary about the CV parsing."

async function defaultLlmFollowup(parsed: StructuredCv): Promise<string> {
  const apiKey =
    process.env.PA_OPENAI_AGENT_API_KEY?.trim() || process.env.OPENAI_API_KEY?.trim() || ""
  if (!apiKey) throw new Error("missing_api_key")
  const baseURL =
    process.env.PA_OPENAI_AGENT_BASE_URL?.trim() || "https://api.openai.com/v1"
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
  const client = new OpenAI({ apiKey, baseURL })
  // Trim experiences to top 3 — most LLM cost + most relevance is at the top.
  const userPayload = JSON.stringify({
    candidateProfile: parsed.candidateProfile,
    experiences: parsed.experiences.slice(0, 3),
    education: parsed.education,
  })
  const resp = await client.responses.create({
    model: LLM_MODEL,
    input: [
      { role: "system", content: FOLLOWUP_SYSTEM_PROMPT },
      { role: "user", content: userPayload },
    ],
  })
  const outputText =
    typeof resp.output_text === "string" && resp.output_text.length > 0
      ? resp.output_text
      : Array.isArray(resp.output) && resp.output[0]?.content?.[0]?.text
        ? resp.output[0]!.content![0]!.text!
        : ""
  if (!outputText) throw new Error("empty_llm_output")
  return outputText
}

async function defaultEnqueueOutboundFollowup(
  db: Firestore,
  docId: string,
  payload: Record<string, unknown>
): Promise<void> {
  // .create() throws ALREADY_EXISTS on duplicate id — exactly the
  // idempotency semantics we want. Caller catches + logs + skips.
  await db.collection(OUTBOUND_COLLECTION).doc(docId).create(payload)
}

async function defaultLookupUserForFollowup(
  db: Firestore,
  userId: string
): Promise<CvFollowupUser | null> {
  try {
    const snap = await db.collection(PA_USERS_COLLECTION).doc(userId).get()
    if (!snap.exists) return null
    const d = snap.data() as Record<string, unknown> | undefined
    if (!d) return null
    const phone = typeof d.phoneE164 === "string" && d.phoneE164.length > 0 ? d.phoneE164 : null
    const mem0 =
      typeof d.mem0UserId === "string" && d.mem0UserId.trim().length > 0
        ? (d.mem0UserId as string).trim()
        : null
    return { toE164: phone, mem0UserId: mem0 }
  } catch {
    return null
  }
}

/**
 * E1 runner — fire-and-forget LLM follow-up + outbound enqueue.
 * NEVER throws. All error paths log + return.
 */
async function runFindingsFollowup(args: {
  db: Firestore
  userId: string
  resumeId: string
  parsed: StructuredCv
  user: CvFollowupUser
  llmFollowup: NonNullable<IngestCvDeps["llmFollowup"]>
  enqueueOutboundFollowup: NonNullable<IngestCvDeps["enqueueOutboundFollowup"]>
  nowIso: () => string
  log: (event: string, payload?: Record<string, unknown>) => void
}): Promise<void> {
  if (followupKillSwitchOn()) {
    args.log("pa.cv_followup.skipped", { reason: "kill_switch", userId: args.userId })
    return
  }
  if (!args.user.toE164) {
    args.log("pa.cv_followup.skipped", { reason: "no_phone", userId: args.userId })
    return
  }
  // 1. LLM call
  let raw: string
  try {
    raw = await args.llmFollowup(args.parsed)
  } catch (err) {
    args.log("pa.cv_followup.error", {
      stage: "llm",
      error: err instanceof Error ? err.message : String(err),
      userId: args.userId,
    })
    return
  }
  // 2. Light normalize via @pa/pa-orchestrator's normalizer (strip markdown,
  //    UTM, length cap). Lazy import keeps module load cheap.
  let body: string
  try {
    const mod = (await import("@pa/pa-orchestrator")) as {
      normalizeForIMessage: (
        input: string,
        opts?: { maxLength?: number }
      ) => { text: string }
    }
    body = mod.normalizeForIMessage(raw, { maxLength: 600 }).text.trim()
  } catch (err) {
    args.log("pa.cv_followup.error", {
      stage: "normalize",
      error: err instanceof Error ? err.message : String(err),
      userId: args.userId,
    })
    return
  }
  if (!body) {
    args.log("pa.cv_followup.skipped", { reason: "empty_after_normalize", userId: args.userId })
    return
  }
  // 3. Enqueue (idempotent via .create())
  const docId = `${FOLLOWUP_DOC_PREFIX}${args.resumeId}`
  const ts = args.nowIso()
  const payload: Record<string, unknown> = {
    id: docId,
    userId: args.userId,
    toE164: args.user.toE164,
    body,
    status: "pending",
    createdAt: ts,
    createdBy: "cv-ingest-followup",
    idempotencyKey: args.resumeId,
    attempts: 0,
  }
  try {
    await args.enqueueOutboundFollowup(args.db, docId, payload)
    args.log("pa.cv_followup.enqueued", { docId, userId: args.userId, resumeId: args.resumeId })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    // Firestore ALREADY_EXISTS → idempotent skip, not a real error.
    const isDup = /already.?exists|6 ALREADY_EXISTS/i.test(msg)
    args.log(isDup ? "pa.cv_followup.idempotent_skip" : "pa.cv_followup.error", {
      stage: "enqueue",
      error: msg,
      userId: args.userId,
      docId,
    })
  }
}

// ---------------------------------------------------------------------------
// Stream E2 — Mem0 long-term memory write
// ---------------------------------------------------------------------------

/**
 * Build a one-line "user CV summary" fact body. Bilingual: zh template when
 * the CV is mostly Chinese, English otherwise. The body is fed to mem0Add
 * as a USER message; mem0's own LLM extraction layer condenses + dedupes
 * against existing Qdrant vectors.
 */
export function buildCvFactBody(parsed: StructuredCv): string {
  const lang = detectCvLang(parsed)
  const name = parsed.candidateProfile.name ?? "Unknown"
  const top = parsed.experiences[0]
  const skills = parsed.candidateProfile.skills.slice(0, 8)
  const eduList = parsed.education
    .map((e) => {
      const s = e.school || ""
      const d = e.degree || ""
      return [s, d].filter(Boolean).join(" ")
    })
    .filter(Boolean)
    .join("; ")

  if (lang === "zh") {
    const role = top
      ? `${top.title} at ${top.company} (${top.startDate || "?"}–${top.endDate || "present"})`
      : "(无工作经历)"
    return (
      `用户简历摘要: ${name} — currently/last ${role}. ` +
      `主要技能: ${skills.length ? skills.join(", ") : "(未列出)"}. ` +
      `教育: ${eduList || "(未列出)"}.`
    )
  }
  const role = top
    ? `${top.title} at ${top.company} (${top.startDate || "?"}–${top.endDate || "present"})`
    : "(no listed experience)"
  return (
    `User resume summary: ${name} — currently/last ${role}. ` +
    `Skills: ${skills.length ? skills.join(", ") : "(none listed)"}. ` +
    `Education: ${eduList || "(none listed)"}.`
  )
}

/**
 * Default Mem0 writer. Resolves env config + partition key, calls mem0Add.
 * Throws when mem0 is unconfigured or the call fails — caller catches.
 */
async function defaultMem0Add(args: {
  userId: string
  partitionKey: string
  factBody: string
}): Promise<void> {
  const memMod = (await import("@pa/memory")) as unknown as {
    mem0Add: (
      cfg: Record<string, unknown>,
      messages: { role: "user" | "assistant"; content: string }[],
      userId: string
    ) => Promise<void>
    isMem0EnvConfigured: () => boolean
  }
  if (!memMod.isMem0EnvConfigured()) throw new Error("mem0_not_configured")
  // Read config from env via the same envTrim pattern as stacked.ts. We
  // rebuild a Mem0Config inline (rather than calling the package's private
  // helper) — fields match `Mem0Config` in packages/memory/src/mem0.ts.
  const envTrim = (k: string): string | undefined => {
    const v = process.env[k]?.trim()
    return v && v.length > 0 ? v : undefined
  }
  const apiKey = envTrim("SILICONFLOW_API_KEY") || envTrim("MEM0_LLM_API_KEY")
  const qdrantUrl = envTrim("QDRANT_URL")
  const qdrantApiKey = envTrim("QDRANT_API_KEY")
  if (!apiKey || !qdrantUrl || !qdrantApiKey) throw new Error("mem0_not_configured")
  const cfg: Record<string, unknown> = {
    apiKey,
    baseUrl: envTrim("MEM0_LLM_BASE_URL") ?? envTrim("OPENAI_BASE_URL"),
    llmModel: envTrim("MEM0_LLM_MODEL"),
    embedModel: envTrim("MEM0_EMBED_MODEL"),
    embeddingDims: (() => {
      const d = envTrim("MEM0_EMBED_DIMS")
      if (!d) return undefined
      const n = Number(d)
      return Number.isFinite(n) ? n : undefined
    })(),
    qdrantUrl,
    qdrantApiKey,
    qdrantCollection: envTrim("MEM0_QDRANT_COLLECTION"),
  }
  await memMod.mem0Add(
    cfg as never,
    [{ role: "user", content: args.factBody }],
    args.partitionKey
  )
}

/**
 * E2 runner — fire-and-forget Mem0 fact write.
 * NEVER throws. All error paths log + return.
 */
async function runMem0Write(args: {
  userId: string
  resumeId: string
  parsed: StructuredCv
  user: CvFollowupUser
  mem0Add: NonNullable<IngestCvDeps["mem0Add"]>
  log: (event: string, payload?: Record<string, unknown>) => void
}): Promise<void> {
  if (mem0KillSwitchOn()) {
    args.log("pa.cv_mem0.skipped", { reason: "kill_switch", userId: args.userId })
    return
  }
  // Resolve the same partition key the orchestrator uses. Inline impl
  // mirrors `resolveMem0PartitionKey` from `@pa/memory` — empty / null /
  // whitespace-only mem0UserId falls back to userId.
  const trimmed =
    typeof args.user.mem0UserId === "string" ? args.user.mem0UserId.trim() : ""
  const partitionKey = trimmed.length > 0 ? trimmed : args.userId

  const factBody = buildCvFactBody(args.parsed)
  try {
    await args.mem0Add({ userId: args.userId, partitionKey, factBody })
    args.log("pa.cv_mem0.ok", {
      userId: args.userId,
      partitionKey,
      resumeId: args.resumeId,
      factLen: factBody.length,
    })
  } catch (err) {
    args.log("pa.cv_mem0.error", {
      error: err instanceof Error ? err.message : String(err),
      userId: args.userId,
      resumeId: args.resumeId,
    })
  }
}

// ---------------------------------------------------------------------------
// Stream H3 — second-CV detection + overwrite UX defaults
// ---------------------------------------------------------------------------

async function defaultIsFlagEnabled(
  db: Firestore,
  key: string,
  userId: string
): Promise<boolean> {
  // Lazy import — pa-persistence pulls in firebase-admin types we already
  // have, but keeps cv-ingest module-load cheap when the flag path isn't hit.
  try {
    const mod = (await import("@pa/pa-persistence")) as {
      getFlag: (
        db: Firestore,
        key: string,
        ctx: { userId?: string },
        defaultValue?: boolean
      ) => Promise<boolean | number | string>
    }
    const v = await mod.getFlag(db, key, { userId }, false)
    return v === true
  } catch {
    // Flag-system unavailable → treat as OFF (backward-compat: existing
    // single-bucket flow runs unchanged).
    return false
  }
}

async function defaultFindExistingResume(
  db: Firestore,
  userId: string
): Promise<{ id: string; data: Record<string, unknown> } | null> {
  // Strategy: query userId == X order by createdAt desc limit 1. We
  // intentionally read +1 extra row so we can skip an `archived: true`
  // doc without a second roundtrip when the most-recent slot was
  // tombstoned by a previous overwrite. (Indexed query needed in
  // production; falls back to in-memory filter when the composite
  // index isn't ready.)
  type DocLike = {
    id: string
    data(): Record<string, unknown> | undefined
  }
  type SnapLike = { docs: DocLike[] }
  let snap: SnapLike
  try {
    const q = db
      .collection(PARSED_RESUMES_COLLECTION)
      .where("userId", "==", userId)
      .orderBy("createdAt", "desc")
      .limit(5)
    snap = (await (q as unknown as { get: () => Promise<SnapLike> }).get()) as SnapLike
  } catch {
    // Index-missing fallback — full-scan filter (small N per user).
    try {
      const q = db
        .collection(PARSED_RESUMES_COLLECTION)
        .where("userId", "==", userId)
        .limit(20)
      snap = (await (q as unknown as { get: () => Promise<SnapLike> }).get()) as SnapLike
    } catch {
      return null
    }
  }
  for (const d of snap.docs) {
    const data = d.data() ?? {}
    if (data["archived"] === true) continue
    return { id: d.id, data }
  }
  return null
}

async function defaultEnqueueCvOverwritePending(
  db: Firestore,
  newResumeId: string,
  payload: Record<string, unknown>
): Promise<void> {
  // .create() throws ALREADY_EXISTS on duplicate id — exactly the
  // idempotency semantics we want. Caller catches + logs + skips.
  await db.collection(CV_PENDING_COLLECTION).doc(newResumeId).create(payload)
}

// ---------------------------------------------------------------------------
// iter30 WS1 — limit-rejection outbound enqueue + parser-v2 adapter
// ---------------------------------------------------------------------------

function ymdUtc(iso: string): string {
  return iso.slice(0, 10).replace(/-/g, "")
}

/**
 * Pick rejection language. We don't have access to a stable user-language
 * preference here yet (no resume parsed → no `detectCvLang` path), so we
 * default to bilingual zh/en with `\n` separator. This matches Claire's
 * usual code-switch fallback.
 */
function buildRejectionBody(reason: "not_invited" | "quota_exhausted" | "pdf_too_large"): string {
  const t = CV_REJECT_TEXTS[reason]
  return `${t.zh}\n${t.en}`
}

async function enqueueLimitRejection(args: {
  db: Firestore
  userId: string
  reason: "not_invited" | "quota_exhausted" | "pdf_too_large"
  toE164: string | null
  nowIso: string
  enqueueOutboundFollowup: NonNullable<IngestCvDeps["enqueueOutboundFollowup"]>
  log: (event: string, payload?: Record<string, unknown>) => void
}): Promise<void> {
  if (!args.toE164) {
    args.log("pa.cv_reject.skipped", { reason: "no_phone", userId: args.userId, kind: args.reason })
    return
  }
  const docId = `${CV_REJECT_OUTBOUND_PREFIX}${args.userId}-${ymdUtc(args.nowIso)}-${args.reason}`
  const body = buildRejectionBody(args.reason)
  try {
    await args.enqueueOutboundFollowup(args.db, docId, {
      id: docId,
      userId: args.userId,
      toE164: args.toE164,
      body,
      status: "pending",
      createdAt: args.nowIso,
      createdBy: "cv-ingest-reject",
      idempotencyKey: docId,
      rejectReason: args.reason,
      attempts: 0,
    })
    args.log("pa.cv_reject.enqueued", { userId: args.userId, kind: args.reason, docId })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    const isDup = /already.?exists|6 ALREADY_EXISTS/i.test(msg)
    args.log(isDup ? "pa.cv_reject.idempotent_skip" : "pa.cv_reject.error", {
      stage: "enqueue",
      kind: args.reason,
      userId: args.userId,
      error: msg,
    })
  }
}

/**
 * Adapter from `@pa/pa-resume-parser` v2 output to legacy `StructuredCv`
 * shape so the rest of cv-ingest (Firestore write, Stream E1, Stream E2,
 * etc.) is unchanged. The richer v2 fields (inferredAnswers, projects,
 * etc.) are also written to Firestore alongside the legacy ones for
 * downstream consumers.
 */
type ParserV2Output = {
  parsed: import("@pa/pa-resume-parser").ParsedResumeData
  usedTier: import("@pa/pa-resume-parser").Tier
  usedModel: string
  usage?: { input_tokens?: number; output_tokens?: number; total_tokens?: number }
}

function adaptV2ToStructuredCv(v2: ParserV2Output["parsed"]): StructuredCv {
  const candidateProfile: CandidateProfile = {
    name: v2.fullName,
    email: v2.email,
    phone: v2.phone,
    linkedIn: null,
    location: v2.location ?? "",
    skills: v2.skills,
  }
  const experiences: Experience[] = v2.workHistory.map((w) => ({
    company: w.company,
    title: w.title,
    startDate: w.startDate ?? "",
    endDate: w.endDate ?? null,
    location: w.location ?? "",
    description: w.description ?? (w.bullets.length > 0 ? w.bullets.join(" ") : ""),
  }))
  const education: Education[] = v2.education.map((e) => ({
    school: e.school,
    degree: e.degree,
    field: e.fieldOfStudy ?? e.major ?? null,
    startDate: e.startDate ?? null,
    endDate: e.endDate ?? null,
  }))
  // Reuse industry-tag heuristic: feed top-3 experience companies+titles to
  // mapToCanonicalIndustry. v2 parser doesn't emit industryTags directly.
  const seen = new Set<IndustryTag>()
  const tags: IndustryTag[] = []
  for (const w of v2.workHistory.slice(0, 3)) {
    const blob = `${w.company} ${w.title}`
    const t = mapToCanonicalIndustry(blob)
    if (!seen.has(t)) {
      seen.add(t)
      tags.push(t)
      if (tags.length >= 3) break
    }
  }
  if (tags.length === 0) tags.push("other")
  return { candidateProfile, experiences, education, industryTags: tags }
}

async function defaultParserV2Extract(text: string, log: (e: string, p?: Record<string, unknown>) => void): Promise<ParserV2Output> {
  const mod = (await import("@pa/pa-resume-parser")) as {
    parseResumeText: typeof import("@pa/pa-resume-parser").parseResumeText
  }
  const result = await mod.parseResumeText({
    resumeText: text,
    log,
  })
  return result
}

async function defaultIsParserV2Enabled(
  db: Firestore,
  userId: string
): Promise<boolean> {
  try {
    const mod = (await import("@pa/pa-persistence")) as {
      getFlag: (
        db: Firestore,
        key: string,
        ctx: { userId?: string },
        defaultValue?: boolean
      ) => Promise<boolean | number | string>
    }
    const v = await mod.getFlag(db, RESUME_PARSER_V2_FLAG_KEY, { userId }, false)
    return v === true
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

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
  const llmFollowup = deps?.llmFollowup ?? defaultLlmFollowup
  const enqueueOutboundFollowup =
    deps?.enqueueOutboundFollowup ?? defaultEnqueueOutboundFollowup
  const mem0AddFn = deps?.mem0Add ?? defaultMem0Add
  const lookupUserForFollowup =
    deps?.lookupUserForFollowup ?? defaultLookupUserForFollowup
  // Stream H3 — second-CV overwrite UX (flag-gated, default OFF).
  const isFlagEnabled = deps?.isFlagEnabled ?? defaultIsFlagEnabled
  const findExistingResume = deps?.findExistingResume ?? defaultFindExistingResume
  const enqueueCvOverwritePending =
    deps?.enqueueCvOverwritePending ?? defaultEnqueueCvOverwritePending

  // iter30 WS1 — gate / quota / parser-v2 overrides (test seam)
  const skipLimits = deps?.skipLimitEnforcement === true
  const checkGate = deps?.checkGate ?? checkResumeGate
  const readQuota = deps?.readQuotaCount ?? readQuotaCount
  const writeQuotaIncrement = deps?.incrementQuota ?? incrementQuota
  const isParserV2EnabledFn = deps?.isParserV2Enabled ?? defaultIsParserV2Enabled
  const parserV2ExtractFn =
    deps?.parserV2Extract ??
    ((text: string, l: (e: string, p?: Record<string, unknown>) => void) =>
      defaultParserV2Extract(text, l))
  // iter34 sprint B.9 — sync embedding compute (test-injectable). Default
  // wires to lib/embeddings.computeCvEmbedding which uses OPENAI_API_KEY.
  const computeEmbedding = deps?.computeEmbedding ?? computeCvEmbedding

  if (!args || typeof args !== "object" || !args.userId || !args.mediaUrl) {
    return { ok: false, reason: "invalid_input" }
  }

  // ─────────────────────────────────────────────────────────────────
  // iter30 WS1 — 4-limit gate stack (entry, before download).
  //   gate (resumeAccepted+grace) → quota (lifetime cap=2) → size (5MB).
  //   parser retry chain is the 4th limit and lives inside the parser.
  //
  //   On rejection, we enqueue a Claire-voice rejection iMessage
  //   (idempotent per-user-per-day-per-reason) before returning.
  // ─────────────────────────────────────────────────────────────────

  // Helper to send rejection then return — pulled into a closure so the
  // user-lookup happens once.
  const sendRejectAndReturn = async (
    reason: "not_invited" | "quota_exhausted" | "pdf_too_large"
  ): Promise<IngestCvResult> => {
    let user: CvFollowupUser | null = null
    try {
      user = await lookupUserForFollowup(dbHandle, args.userId)
    } catch {
      user = null
    }
    await enqueueLimitRejection({
      db: dbHandle,
      userId: args.userId,
      reason,
      toE164: user?.toE164 ?? null,
      nowIso: nowIso(),
      enqueueOutboundFollowup,
      log,
    })
    return { ok: false, reason }
  }

  // Limit 1: gate (resumeAccepted flag OR kill-switch OR grace window).
  if (!skipLimits) {
    try {
      const gate = await checkGate(dbHandle, args.userId, nowIso())
      log("pa.cv_ingest.gate_check", {
        userId: args.userId,
        open: gate.open,
        reason: gate.reason,
      })
      if (!gate.open) {
        return await sendRejectAndReturn("not_invited")
      }
    } catch (err) {
      log("pa.cv_ingest.gate_error", {
        userId: args.userId,
        error: err instanceof Error ? err.message : String(err),
      })
      return await sendRejectAndReturn("not_invited")
    }

    // Limit 2: lifetime quota cap (default = 2).
    try {
      const count = await readQuota(dbHandle, args.userId)
      log("pa.cv_ingest.quota_check", { userId: args.userId, count })
      if (isQuotaExhausted(count)) {
        return await sendRejectAndReturn("quota_exhausted")
      }
    } catch (err) {
      log("pa.cv_ingest.quota_error", {
        userId: args.userId,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  // 1. Download (with size cap when caller didn't override fetchPdf).
  // We default to fetchPdfWithSizeCap; tests can still inject deps.fetchPdf.
  let bytes: Uint8Array
  try {
    if (deps?.fetchPdf) {
      const downloaded = await deps.fetchPdf(args.mediaUrl)
      bytes = downloaded.bytes
    } else {
      const downloaded = await fetchPdfWithSizeCap(args.mediaUrl)
      bytes = downloaded.bytes
    }
  } catch (err) {
    if (err instanceof PdfSizeError) {
      log("pa.cv_ingest.size_cap_rejected", {
        userId: args.userId,
        observed: err.observedBytes,
        limit: MAX_PDF_BYTES,
      })
      return await sendRejectAndReturn("pdf_too_large")
    }
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

  // 3. LLM structured extraction.
  //
  // iter30 WS1 — paResumeParserV2 flag toggles between:
  //   - v2: @pa/pa-resume-parser (3-tier retry chain, structured output,
  //         qaBank → Mem0 + tag-event coupling). Default OFF.
  //   - v1: legacy single-shot defaultLlmExtract (backward compat).
  let parserV2On = false
  try {
    parserV2On = await isParserV2EnabledFn(dbHandle, args.userId)
  } catch {
    parserV2On = false
  }
  let parsed: StructuredCv
  let usage: { input_tokens?: number; output_tokens?: number; total_tokens?: number } | undefined
  let v2Output: ParserV2Output | null = null
  let usedTier: string | undefined
  let usedModel: string = LLM_MODEL
  try {
    if (parserV2On && !deps?.llmExtract) {
      v2Output = await parserV2ExtractFn(text, log)
      parsed = adaptV2ToStructuredCv(v2Output.parsed)
      usage = v2Output.usage
      usedTier = v2Output.usedTier
      usedModel = v2Output.usedModel
    } else {
      const out = await llmExtract(text)
      parsed = validateStructuredCv(out.parsed)
      usage = out.usage
    }
  } catch (err) {
    log("pa.cv_ingest.error", {
      stage: "llm",
      error: err instanceof Error ? err.message : String(err),
      userId: args.userId,
      parserV2: parserV2On,
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
    model: usedModel,
    parserV2: parserV2On,
    tier: usedTier,
  })

  // iter34 sprint B.9 — compute topSkills + embedding ONCE (shared by H3
  // staged path and legacy direct-write path). Embedding is sync so a brand
  // new user has a semantic signal the same day they onboard. NEVER throws;
  // returns null on any failure (no API key, network error, etc.) and the
  // doc is written without the embedding fields. Daily-batch then picks up
  // the empty doc on next run as a fallback (zero-regression contract).
  const sharedTopSkills = computeTopSkills({
    candidateProfileSkills: parsed.candidateProfile.skills,
    workHistory: v2Output ? v2Output.parsed.workHistory : undefined,
  })
  let embedResult: ComputeCvEmbeddingResult | null = null
  try {
    embedResult = await computeEmbedding({
      candidateProfile: parsed.candidateProfile,
      experiences: parsed.experiences,
      education: parsed.education,
      industryTags: parsed.industryTags,
      topSkills: sharedTopSkills,
    })
    if (embedResult) {
      log("pa.cv_ingest.embedding_computed", {
        userId: args.userId,
        dim: embedResult.dim,
        model: embedResult.model,
      })
    } else {
      log("pa.cv_ingest.embedding_skipped", {
        userId: args.userId,
        reason: "compute_returned_null",
      })
    }
  } catch (err) {
    // Defensive — computeCvEmbedding contract is "never throws", but if a
    // test injectable misbehaves we still must not block the doc write.
    log("pa.cv_ingest.embedding_error", {
      userId: args.userId,
      error: err instanceof Error ? err.message : String(err),
    })
    embedResult = null
  }

  // 4. Stream H3 gate — feature-flag + existing-resume detection.
  //    When BOTH are true (flag ON AND user has ≥1 prior resume), we DO NOT
  //    write parsedCandidateResumes yet. Stage in pa-cv-pending and prompt
  //    the user via outbound iMessage. Otherwise fall through to the
  //    direct-write path (backward compat).
  let h3FlagOn = false
  let prior: { id: string; data: Record<string, unknown> } | null = null
  try {
    h3FlagOn = await isFlagEnabled(dbHandle, CV_OVERWRITE_FLAG_KEY, args.userId)
  } catch (err) {
    // Flag read failure → treat as OFF (graceful degrade to legacy path).
    log("pa.cv_overwrite.flag_read_error", {
      userId: args.userId,
      error: err instanceof Error ? err.message : String(err),
    })
    h3FlagOn = false
  }
  if (h3FlagOn) {
    try {
      prior = await findExistingResume(dbHandle, args.userId)
    } catch (err) {
      log("pa.cv_overwrite.lookup_error", {
        userId: args.userId,
        error: err instanceof Error ? err.message : String(err),
      })
      prior = null
    }
  }
  if (h3FlagOn && prior) {
    // Flag ON + existing → stage + prompt path.
    const ts = nowIso()
    // Reserve a NEW Firestore auto-id for the eventual promoted row. We
    // only allocate the id; we DO NOT write parsedCandidateResumes here.
    const newResumeId = dbHandle.collection(PARSED_RESUMES_COLLECTION).doc().id
    const expireAt = new Date(new Date(ts).getTime() + CV_PENDING_TTL_MS).toISOString()
    // iter34 A.1 — derive topSkills so the staged → promoted row also
    // carries the field that orchestrator-deps.generateJobRecs reads.
    // iter34 sprint B.9 — sharedTopSkills (computed above) reused so the
    // staged + promoted rows match the legacy direct-write field set.
    const stagedDoc: Record<string, unknown> = {
      userId: args.userId,
      candidateProfile: parsed.candidateProfile,
      experiences: parsed.experiences,
      education: parsed.education,
      industryTags: parsed.industryTags,
      topSkills: sharedTopSkills,
      originalFileName: deriveOriginalFileName(args.mediaUrl),
      fileType: "application/pdf",
      studentFrom: null,
      sessionId: args.sessionId ?? null,
      mediaUrl: args.mediaUrl,
      ingestedAt: ts,
      ingestedVia: "imessage-attachment",
      // No `createdAt` Timestamp here — only set on promote, so the row
      // doesn't accidentally enter the "most recent" sort window.
    }
    // iter34 sprint B.9 — carry the embedding into the staged doc so when
    // the user accepts the overwrite prompt, the promoted parsedCandidate-
    // Resumes row already has semantic-rerank signal on day 1.
    if (embedResult) {
      stagedDoc.embedding = embedResult.vector
      stagedDoc.embeddingModel = embedResult.model
      stagedDoc.embeddingDim = embedResult.dim
      stagedDoc.embeddingComputedAt = embedResult.computedAt
    }
    // Stage pending (idempotent on auto-id collision, which won't happen
    // in practice — id is server-allocated).
    let pendingWritten = false
    try {
      await enqueueCvOverwritePending(dbHandle, newResumeId, {
        newResumeId,
        previousResumeId: prior.id,
        userId: args.userId,
        expireAt,
        createdAt: ts,
        parsedDoc: stagedDoc,
        status: "awaiting_user",
      })
      pendingWritten = true
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      const isDup = /already.?exists|6 ALREADY_EXISTS/i.test(msg)
      log(isDup ? "pa.cv_overwrite.pending_idempotent_skip" : "pa.cv_overwrite.error", {
        stage: "pending",
        error: msg,
        userId: args.userId,
        newResumeId,
      })
      if (!isDup) {
        // Real failure → fall through to legacy write so we don't drop
        // the CV silently. Legacy path is the safe baseline.
        h3FlagOn = false
      }
    }
    if (pendingWritten) {
      // Enqueue outbound prompt (idempotent docId per newResumeId).
      const promptDocId = `${CV_OVERWRITE_OUTBOUND_PREFIX}${newResumeId}`
      let userForPrompt: CvFollowupUser | null = null
      try {
        userForPrompt = await lookupUserForFollowup(dbHandle, args.userId)
      } catch (err) {
        log("pa.cv_overwrite.user_lookup_error", {
          userId: args.userId,
          error: err instanceof Error ? err.message : String(err),
        })
      }
      if (userForPrompt?.toE164) {
        try {
          await enqueueOutboundFollowup(dbHandle, promptDocId, {
            id: promptDocId,
            userId: args.userId,
            toE164: userForPrompt.toE164,
            body: CV_OVERWRITE_PROMPT_BODY,
            status: "pending",
            createdAt: ts,
            createdBy: "cv-overwrite-prompt",
            idempotencyKey: newResumeId,
            attempts: 0,
            // Carry resumeIds in rawMeta so the tapback handler can resolve
            // the pending row without re-querying by docId pattern.
            rawMeta: {
              cvOverwrite: {
                newResumeId,
                previousResumeId: prior.id,
              },
            },
          })
          log("pa.cv_overwrite.prompt_enqueued", {
            userId: args.userId,
            newResumeId,
            previousResumeId: prior.id,
            docId: promptDocId,
          })
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          const isDup = /already.?exists|6 ALREADY_EXISTS/i.test(msg)
          log(
            isDup ? "pa.cv_overwrite.prompt_idempotent_skip" : "pa.cv_overwrite.error",
            {
              stage: "prompt_enqueue",
              error: msg,
              userId: args.userId,
              docId: promptDocId,
            }
          )
        }
      } else {
        log("pa.cv_overwrite.prompt_skipped", {
          reason: "no_phone",
          userId: args.userId,
          newResumeId,
        })
      }
      // H3 short-circuits — DO NOT run E1/E2 side effects on a staged CV;
      // those run after promote. Caller gets the would-be resumeId so
      // logs are still traceable, but ok=true reflects the staged state.
      return { ok: true, resumeId: newResumeId }
    }
    // Fell through (pendingWritten === false AND h3FlagOn flipped to false)
    // → continue to legacy write below. Variables `prior` / `newResumeId`
    // are local only and not referenced further.
  }

  // 5. Firestore write (legacy single-bucket path — backward compat when
  //    flag OFF or no prior resume exists).
  let resumeId: string
  try {
    const ts = nowIso()
    // iter34 A.1 — derive topSkills (was a ghost field — written by no one,
    // read by orchestrator-deps.generateJobRecs). Frequency-ranked + capped
    // at 12 from candidateProfile.skills + (when v2) workHistory[].skills.
    // iter34 sprint B.9 — sharedTopSkills computed once above; reused here
    // so the legacy + H3 staged rows carry the same field set.
    const baseDoc: Record<string, unknown> = {
      userId: args.userId,
      candidateProfile: parsed.candidateProfile,
      experiences: parsed.experiences,
      education: parsed.education,
      // Stream F1 — 1..3 canonical industry tags inferred from experiences.
      industryTags: parsed.industryTags,
      // iter34 A.1 — flat top-level field consumed by job-rec.
      topSkills: sharedTopSkills,
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
    // iter34 sprint B.9 — sync embedding fields. When computeEmbedding
    // failed (no API key, OpenAI down, etc.), these stay absent and the
    // daily-batch lazy-compute path (job-rec-daily.defaultUserEmbedComputer)
    // backfills on the next 09:00 PT run.
    if (embedResult) {
      baseDoc.embedding = embedResult.vector
      baseDoc.embeddingModel = embedResult.model
      baseDoc.embeddingDim = embedResult.dim
      baseDoc.embeddingComputedAt = embedResult.computedAt
    }
    // iter30 WS1 — when parser-v2 ran, persist the rich v2 fields alongside
    // the legacy projection. Downstream consumers (job-rec, dashboard) can
    // opt in to the v2 fields without breaking on missing data.
    if (v2Output) {
      baseDoc.parserVersion = "v2"
      baseDoc.parserTier = v2Output.usedTier
      baseDoc.parserModel = v2Output.usedModel
      baseDoc.workHistory = v2Output.parsed.workHistory
      baseDoc.projects = v2Output.parsed.projects
      baseDoc.certifications = v2Output.parsed.certifications
      baseDoc.languages = v2Output.parsed.languages
      baseDoc.awards = v2Output.parsed.awards
      baseDoc.volunteerWork = v2Output.parsed.volunteerWork
      baseDoc.websites = v2Output.parsed.websites
      baseDoc.totalYearsExperience = v2Output.parsed.totalYearsExperience
      baseDoc.workAuthorization = v2Output.parsed.workAuthorization
      baseDoc.parseConfidence = v2Output.parsed.parseConfidence
      baseDoc.inferredAnswers = v2Output.parsed.inferredAnswers
    } else {
      baseDoc.parserVersion = "v1"
    }
    const ref = await dbHandle.collection(PARSED_RESUMES_COLLECTION).add(baseDoc)
    resumeId = ref.id
    log("pa.cv_ingest.ok", {
      userId: args.userId,
      resumeId: ref.id,
      parserVersion: v2Output ? "v2" : "v1",
    })
  } catch (err) {
    log("pa.cv_ingest.error", {
      stage: "firestore",
      error: err instanceof Error ? err.message : String(err),
      userId: args.userId,
    })
    return { ok: false, reason: "firestore_write_failed" }
  }

  // iter30 WS1 — atomic quota increment AFTER successful write. Failure
  // here is logged + tolerated (off-by-one acceptable per detail-plan §5.3).
  if (!skipLimits) {
    try {
      await writeQuotaIncrement(dbHandle, args.userId, nowIso())
    } catch (err) {
      log("pa.cv_ingest.quota_increment_error", {
        userId: args.userId,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  // 6. Stream E side effects (E1 + E2 + E3 in parallel, fire-and-forget,
  //    all NEVER throw). We resolve the user once + share the read.
  let user: CvFollowupUser | null = null
  try {
    user = await lookupUserForFollowup(dbHandle, args.userId)
  } catch (err) {
    log("pa.cv_followup.error", {
      stage: "user_lookup",
      error: err instanceof Error ? err.message : String(err),
      userId: args.userId,
    })
  }
  if (user) {
    const branches: Array<Promise<unknown>> = [
      runFindingsFollowup({
        db: dbHandle,
        userId: args.userId,
        resumeId,
        parsed,
        user,
        llmFollowup,
        enqueueOutboundFollowup,
        nowIso,
        log,
      }),
      runMem0Write({
        userId: args.userId,
        resumeId,
        parsed,
        user,
        mem0Add: mem0AddFn,
        log,
      }),
    ]
    // iter30 WS1 — Stream E3: qaBank → Mem0 with metadata + tag-event coupling.
    // Only runs when parser v2 produced inferredAnswers. Failure is silent
    // (the Mem0 fact body and outbound followup are already written).
    if (v2Output && v2Output.parsed.inferredAnswers.length > 0) {
      branches.push(
        runQaBankToMem0({
          db: dbHandle,
          userId: args.userId,
          partitionKey: user.mem0UserId ?? args.userId,
          resumeId,
          inferredAnswers: v2Output.parsed.inferredAnswers,
          nowIso,
          log,
        })
      )
    }
    await Promise.allSettled(branches)
  } else {
    log("pa.cv_followup.skipped", { reason: "no_user_record", userId: args.userId })
  }

  return { ok: true, resumeId }
}

// ---------------------------------------------------------------------------
// Stream E3 — qaBank → Mem0 + tag-event coupling
// ---------------------------------------------------------------------------

async function runQaBankToMem0(args: {
  db: Firestore
  userId: string
  partitionKey: string
  resumeId: string
  inferredAnswers: import("@pa/pa-resume-parser").InferredAnswer[]
  nowIso: () => string
  log: (event: string, payload?: Record<string, unknown>) => void
}): Promise<void> {
  if (mem0KillSwitchOn()) {
    args.log("pa.cv_qabank.skipped", { reason: "kill_switch", userId: args.userId })
    return
  }
  let parserMod: typeof import("@pa/pa-resume-parser")
  try {
    parserMod = (await import("@pa/pa-resume-parser")) as typeof import("@pa/pa-resume-parser")
  } catch (err) {
    args.log("pa.cv_qabank.error", {
      stage: "parser_import",
      userId: args.userId,
      error: err instanceof Error ? err.message : String(err),
    })
    return
  }

  // Adapter: writeQaBankToMem0 expects callbacks that hide the Mem0 config.
  const memMod = (await import("@pa/memory")) as unknown as {
    mem0Add: (
      cfg: Record<string, unknown>,
      messages: { role: "user" | "assistant"; content: string }[],
      userId: string,
      options?: { metadata?: Record<string, unknown>; agentId?: string }
    ) => Promise<void>
    mem0Search: (
      cfg: Record<string, unknown>,
      query: string,
      userId: string
    ) => Promise<string[]>
    isMem0EnvConfigured: () => boolean
  }
  if (!memMod.isMem0EnvConfigured()) {
    args.log("pa.cv_qabank.skipped", { reason: "mem0_not_configured", userId: args.userId })
    return
  }

  const envTrim = (k: string): string | undefined => {
    const v = process.env[k]?.trim()
    return v && v.length > 0 ? v : undefined
  }
  const apiKey = envTrim("SILICONFLOW_API_KEY") || envTrim("MEM0_LLM_API_KEY")
  const qdrantUrl = envTrim("QDRANT_URL")
  const qdrantApiKey = envTrim("QDRANT_API_KEY")
  if (!apiKey || !qdrantUrl || !qdrantApiKey) {
    args.log("pa.cv_qabank.skipped", { reason: "mem0_env_missing", userId: args.userId })
    return
  }
  const cfg: Record<string, unknown> = {
    apiKey,
    baseUrl: envTrim("MEM0_LLM_BASE_URL") ?? envTrim("OPENAI_BASE_URL"),
    llmModel: envTrim("MEM0_LLM_MODEL"),
    embedModel: envTrim("MEM0_EMBED_MODEL"),
    qdrantUrl,
    qdrantApiKey,
    qdrantCollection: envTrim("MEM0_QDRANT_COLLECTION"),
  }

  // Adapter: writeQaBankToMem0 expects a `Mem0AddAdapter`-shaped callback.
  // We bridge it to memMod.mem0Add with the qaBank metadata.
  const mem0AddAdapter = async (a: {
    userId: string
    partitionKey: string
    question: string
    answer: string
    metadata: Record<string, string | number | boolean>
  }): Promise<void> => {
    const text = `Q: ${a.question}\nA: ${a.answer}`
    await memMod.mem0Add(
      cfg,
      [{ role: "user", content: text }],
      a.partitionKey,
      {
        metadata: a.metadata,
        agentId: "claire",
      }
    )
  }

  const mem0SearchAdapter = async (a: {
    partitionKey: string
    query: string
  }): Promise<string[]> => {
    return memMod.mem0Search(cfg, a.query, a.partitionKey)
  }

  // Tag-event adapter using @wekruit/shared-tags (Wave 1 merged).
  let recordTagEventAdapter: typeof parserMod.writeQaBankToMem0 extends (a: { recordTagEvent?: infer T }) => unknown ? T : never
  try {
    const tagsMod = (await import("@wekruit/shared-tags")) as typeof import("@wekruit/shared-tags")
    recordTagEventAdapter = (async (e: {
      userId: string
      rawTag: string
      source: "pa-cv-ingest"
      sourceField?: string
      sourceDocId?: string
      evidence?: string
    }) => {
      await tagsMod.recordTagEvent(
        {
          userId: e.userId,
          rawTag: e.rawTag,
          source: e.source,
          sourceField: e.sourceField,
          sourceDocId: e.sourceDocId,
          type: "preference",
          evidence: e.evidence,
        },
        { firestore: args.db as unknown as import("@wekruit/shared-tags").FirestoreLike }
      )
    }) as typeof recordTagEventAdapter
  } catch (err) {
    args.log("pa.cv_qabank.tag_module_error", {
      userId: args.userId,
      error: err instanceof Error ? err.message : String(err),
    })
    recordTagEventAdapter = undefined as unknown as typeof recordTagEventAdapter
  }

  try {
    const r = await parserMod.writeQaBankToMem0({
      userId: args.userId,
      partitionKey: args.partitionKey,
      resumeId: args.resumeId,
      inferredAnswers: args.inferredAnswers,
      mem0Add: mem0AddAdapter,
      mem0Search: mem0SearchAdapter,
      recordTagEvent: recordTagEventAdapter as unknown as Parameters<
        typeof parserMod.writeQaBankToMem0
      >[0]["recordTagEvent"],
      nowIso: args.nowIso,
      log: args.log,
    })
    args.log("pa.cv_qabank.summary", {
      userId: args.userId,
      resumeId: args.resumeId,
      written: r.written,
      skippedDedupe: r.skippedDedupe,
      errored: r.errored,
      tagEventsRecorded: r.tagEventsRecorded,
    })
  } catch (err) {
    args.log("pa.cv_qabank.error", {
      stage: "writeQaBank",
      userId: args.userId,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}
