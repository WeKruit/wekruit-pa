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
 *   E1. Findings follow-up — resume parse completion is handed to Claire
 *       runtime as a system event. Runtime decides whether/how to message.
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

import { createHash } from "node:crypto"
import type { Firestore } from "firebase-admin/firestore"
import {
  INDUSTRY_TAGS,
  applyIndustryTagsFallback,
  mapToCanonicalIndustry,
  rescueIndustryWithSkillsLlm,
  type IndustryTag,
} from "./industry-tags.js"
import { isCanaryUser } from "../claire-agent/canary.js"
import {
  runIndustrySecondPass,
  type WorkHistorySummary,
} from "./industry-second-pass.js"
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
import {
  resolveCandidateIdentity as defaultResolveCandidateIdentity,
  type ResolveCandidateIdentityInput,
} from "@pa/pa-persistence"
import {
  capRelevantTags,
  validateRelevantTag,
} from "@wekruit/shared-tags"
import type {
  CandidateHandleSource,
  CandidateIdentityResolution,
} from "@pa/core-types"
// iter34 H.3b — unified user-tag store. mergeUserTags is pure; we wire it
// into the cv-ingest flow so the canonical `pa-users/{userId}.tags` doc
// stays in sync with the latest CV. H.4 worker reads this; H.3a's industry
// fallback already runs on parsed.industryTags before we hand it to the
// merger, so the merger sees the corrected tags.
import { mergeUserTags, projectTagsToGlobalTags, type UserTagsInput } from "@pa/pa-orchestrator"
import {
  mergeAndDetermineProfile,
  toSourceFromLinkedin,
  toSourceFromResume,
  type MergeAndDetermineResult as MergeAndDetermineProfileResult,
  type SourceExperience as MergeSourceExperience,
} from "../external-supply/merge-experience-profile.js"
import { enqueueRuntimeEventHandoff } from "../runtime-event-handoff.js"
import { computeResumeBaselineTagPatch } from "../lib/resume-baseline-tags.js"
import {
  autoDeriveCareerStage,
  autoDeriveTargetRoleFunction,
  type DeriveSkill,
} from "../lib/auto-derive-tags.js"

export type IngestCvInput = {
  userId: string
  mediaUrl: string
  sessionId?: string
  employerEmailHint?: string | null
  browserUid?: string | null
  atsApplicantId?: string | null
  identitySource?: CandidateHandleSource
  /**
   * v2.0 S3 bulk intake guard: require the parsed PDF itself to contain an
   * email before identity resolution or permanent writes. Employer email
   * hints remain hints; they must not create identity when the PDF is missing
   * an email.
   */
  requireExtractedEmail?: boolean
}

export type IngestCvResult =
  | {
      ok: true
      resumeId: string
      userId: string
      extractedEmail?: string
      candidateProfileSummary?: string
    }
  | {
      ok: false
      reason: string
      conflictId?: string
      extractedEmail?: string
    }

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

export type CvFollowupDeliveryMode = "runtime" | "none"

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
   * How post-parse user-visible followups are delivered.
   *
   * - runtime: write a synthetic runtime event only after a user-originated
   *   resume attachment path has completed parsing. Runtime owns language,
   *   session state, safety, and whether to send.
   * - none: update profile/tags/memory only; do not message the candidate.
   *   Public candidate-web uploads use this because the user has not started
   *   an iMessage session yet.
   */
  followupDeliveryMode?: CvFollowupDeliveryMode
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
  // ask Claire runtime whether/how to prompt about replacing the previous
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

  // ---- iter34 H.3b — unified user-tags merge + write --------------------
  //
  // Default: @pa/pa-orchestrator's mergeUserTags + Firestore
  // `pa-users/{userId}.set({tags}, {merge:true})`. Tests can stub the
  // merger to inspect args, and the writer to capture the resulting
  // payload. This path is fail-open: any failure is logged but NEVER
  // blocks the parsedCandidateResumes write or the E1/E2/E3 side effects.
  /** Inject for tests. Default: @pa/pa-orchestrator.mergeUserTags. */
  mergeUserTagsFn?: (input: UserTagsInput) => Record<string, unknown>
  /**
   * Inject for tests. Default: Firestore `pa-users/{userId}.set({tags},
   * {merge: true})`. Caller passes the merged tags object plus the
   * timestamp (already on the tags object via mergeUserTags's cvUpdatedAt).
   */
  writeUserTags?: (
    db: Firestore,
    userId: string,
    tags: Record<string, unknown>
  ) => Promise<void>

  // ---- Phase 53 (PARSE-08, PARSE-07, PARSE-09) -------------------------

  /**
   * Phase 53 (PARSE-08, D15) — Industry classification second-pass.
   * Default: `runIndustrySecondPass` from `./industry-second-pass.ts`,
   * which uses Anthropic Sonnet-4-6 and falls back to gpt-4.1-mini. Tests
   * can stub to verify the trigger condition without hitting any LLM.
   */
  runIndustrySecondPassFn?: (args: {
    cvText: string
    workHistory: ReadonlyArray<WorkHistorySummary>
    apiKey: string | undefined
    log: (event: string, payload?: Record<string, unknown>) => void
  }) => Promise<string[]>

  /**
   * Phase 53 (PARSE-09) — sha256 idempotency lookup.
   * Default: query `parsedCandidateResumes` where
   * `userId == X AND sha256 == Y`, return existing resumeId if found.
   * Tests can stub to simulate hit / miss.
   */
  findResumeBySha256?: (
    db: Firestore,
    userId: string,
    sha256: string
  ) => Promise<string | null>

  /**
   * v2.0 S2 — canonical candidate identity resolver. For public/ATS CV
   * uploads this must run after parse evidence is available and before any
   * permanent candidate writes.
   */
  resolveCandidateIdentity?: (
    db: Firestore,
    input: ResolveCandidateIdentityInput
  ) => Promise<CandidateIdentityResolution>
}

const PARSED_RESUMES_COLLECTION = "parsedCandidateResumes"
const FETCH_TIMEOUT_MS = 30_000
const MAX_PDF_PAGES = 50
const MAX_TEXT_BYTES = 100_000 // 100 KB cap to bound LLM cost
const LLM_MODEL = "gpt-5.4-nano"

// Stream E
const PA_USERS_COLLECTION = "pa-users"

function nonEmptyTrimmed(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed && trimmed.length > 0 ? trimmed : undefined
}

/**
 * v1.9 hotfix (Adam directive 2026-05-12) — normalize parsed CV phone to E.164.
 *
 * Strategy: digits-only. If 10 digits assume US/CA → prepend "+1". If 11
 * digits starting with 1 → prepend "+". If 12-15 digits → prepend "+".
 * Reject < 8 or > 15 digits.
 *
 * Adam's CV pattern "(424)-320-1960" → 4243201960 → 10 digits → "+14243201960".
 *
 * NOTE: libphonenumber-js is not in deps yet (orchestrator pii-confirm has the
 * same TODO at packages/pa-orchestrator/src/prescreen/pii-confirm.ts:18-20). v2.0
 * should swap to libphonenumber-js for international.
 */
function normalizeCvPhoneToE164(raw: string | null | undefined): string | null {
  if (!raw || typeof raw !== "string") return null
  const digits = raw.replace(/\D/g, "")
  if (digits.length < 8 || digits.length > 15) return null
  if (digits.length === 10) return `+1${digits}` // assume NANP
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`
  return `+${digits}`
}

// Stream H3 — second-CV overwrite UX
export const CV_OVERWRITE_FLAG_KEY = "paCvOverwritePromptEnabled"
export const CV_PENDING_COLLECTION = "pa-cv-pending"
export const CV_OVERWRITE_RUNTIME_PREFIX = "cv-overwrite-"

// iter30 WS1 — feature flag for parseResume v2 (3-tier retry chain).
// When ON for this user, we route through @pa/pa-resume-parser instead of
// the legacy single-shot defaultLlmExtract. Default OFF; ramp staff first.
export const RESUME_PARSER_V2_FLAG_KEY = "paResumeParserV2"

// iter30 WS1 — limit rejections are runtime events, not prewritten outbox copy.
export const CV_REJECT_RUNTIME_PREFIX = "cv-reject-"
const CV_PENDING_TTL_MS = 24 * 60 * 60 * 1000 // 24 hours

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
  ". Choose based on the candidate's most recent / most senior experience. Use 'other' only when no other tag fits.\n" +
  // iter34 H.3a — concrete tagging examples. The LLM was repeatedly emitting\n" +
  // ['other'] for SWE / AI-engineer CVs heavy on tools but light on industry words.\n" +
  "Examples (apply when the corresponding signals are present in the CV):\n" +
  "- Skills/companies include Software Engineer / SWE / Python / Java / JavaScript / TypeScript / Go / C++ / Tesla / AWS / GCP / Azure / Docker / Kubernetes → industryTags MUST include 'tech_software'.\n" +
  "- Skills/companies include ML / AI / TensorFlow / PyTorch / OpenAI / Anthropic / LangChain / LlamaIndex / CUDA → ALSO add 'ai_ml'.\n" +
  "- Skills/companies include semiconductor / firmware / FPGA / ASIC / chip design → add 'tech_hardware'.\n" +
  "- Use 'other' ONLY when none of the 9 specific buckets fit at all."

async function defaultLlmExtract(text: string): Promise<{
  parsed: StructuredCv
  usage?: { input_tokens?: number; output_tokens?: number; total_tokens?: number }
}> {
  // 2026-05-07 Adam directive — CV parse is real OpenAI. Drop
  // poisoned OPENAI_API_KEY fallback (which is SF key in prod).
  const { getOpenAIConfig } = await import("../lib/llm-providers.js")
  const cfg = getOpenAIConfig()
  if (!cfg.apiKey) throw new Error("missing_api_key")
  const apiKey = cfg.apiKey
  const baseURL = process.env.PA_OPENAI_AGENT_BASE_URL?.trim() || cfg.baseURL
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
  // iter34 H.3a — skill-token fallback. Adam's CV (SWE / Tesla / AWS / GCP /
  // Anthropic) was repeatedly LLM-tagged as ["other"]; the deterministic
  // skill-token rule rescues these cases without re-running the LLM.
  // applyIndustryTagsFallback NEVER throws and is a no-op for non-tech CVs
  // (e.g. medical-only CVs whose LLM tag was healthcare_biotech come through
  // unchanged).
  ;(o as unknown as StructuredCv).industryTags = applyIndustryTagsFallback(
    tags,
    isStringArr(cp.skills) ? cp.skills : []
  )
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
// Stream E1 — runtime handoff
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// iter34 H.3b — unified user-tags writer (default Firestore impl)
// ---------------------------------------------------------------------------

async function defaultWriteUserTags(
  db: Firestore,
  userId: string,
  tags: Record<string, unknown>
): Promise<void> {
  // Also project the canonical CV-derived tags → globalTags (the v2.0 /me surface reads
  // candidateSelfProfiles/pa-users.globalTags). Without this, a CV skills update lands in tags.skills
  // but never reaches the candidate portal. merge:true so chat-derived globalTags fields survive.
  const globalTags = projectTagsToGlobalTags(tags as Parameters<typeof projectTagsToGlobalTags>[0])
  await db.collection(PA_USERS_COLLECTION).doc(userId).set({ tags, globalTags }, { merge: true })
}

type ResumeMatchingTagSignals = {
  skills?: readonly string[]
  workHistory?: ReadonlyArray<{ title?: string | null }>
  totalYearsExperience?: number | null
  workAuthorization?: string | null
  relevantSpecialization?: readonly string[]
  proposedTags?: readonly string[]
}

function objectRecord(raw: unknown): Record<string, unknown> | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined
  return raw as Record<string, unknown>
}

function hasFilledTagAxis(tags: Record<string, unknown> | undefined, key: string): boolean {
  if (!tags) return false
  const value = tags[key]
  if (Array.isArray(value)) return value.length > 0
  if (typeof value === "string") return value.trim().length > 0
  return value !== undefined && value !== null
}

function normalizeRelevantTagCandidate(raw: unknown): string | null {
  if (typeof raw !== "string") return null
  const normalized = raw
    .trim()
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/_+/g, "_")
  if (!normalized) return null
  return validateRelevantTag(normalized).ok ? normalized : null
}

function deriveRelevantTagsFromResumeSignals(
  signals: ResumeMatchingTagSignals | undefined
): string[] {
  if (!signals) return []
  const out: string[] = []
  const seen = new Set<string>()
  const add = (raw: unknown): void => {
    const tag = normalizeRelevantTagCandidate(raw)
    if (!tag || seen.has(tag)) return
    seen.add(tag)
    out.push(tag)
  }

  for (const raw of signals.relevantSpecialization ?? []) add(raw)
  for (const raw of signals.proposedTags ?? []) add(raw)
  if (out.length === 0) {
    for (const raw of signals.skills ?? []) {
      // Single-token language/framework/database names already live in
      // `tags.skills`; only promote phrase-like resume skills into the
      // open-vocab relevantTags axis.
      if (!/[\s_-]/.test(raw)) continue
      add(raw)
    }
  }
  return capRelevantTags(out)
}

function mapWorkAuthorizationToVisaStatus(raw: string | null | undefined): string | null {
  if (!raw) return null
  const v = raw.toLowerCase().trim()
  if (!v) return null
  if (/\b(u\.?s\.?|us|american)\s+citizen(ship)?\b|\bcitizen(ship)?\b/.test(v)) {
    return "citizen"
  }
  if (/\b(green\s*card|permanent\s+resident|lawful\s+permanent|gc)\b/.test(v)) {
    // D4 canonicalization (2026-05-28): canonical `permanent_resident`, not `gc`.
    return "permanent_resident"
  }
  if (/\b(h-?1b|opt|cpt|stem\s+opt|sponsor(ship)?|visa\s+sponsor)/.test(v)) {
    return "sponsor_needed"
  }
  return null
}

function applyResumeMatchingTagProjection(args: {
  merged: Record<string, unknown>
  existingTags: Record<string, unknown> | undefined
  signals: ResumeMatchingTagSignals | undefined
}): Record<string, unknown> {
  const out = { ...args.merged }
  const keys = ["targetRoleFunction", "careerStage", "visaStatus", "relevantTags"] as const
  for (const key of keys) {
    if (hasFilledTagAxis(args.existingTags, key)) {
      delete out[key]
    }
  }
  const isFilled = (key: (typeof keys)[number]): boolean =>
    hasFilledTagAxis(args.existingTags, key) || hasFilledTagAxis(out, key)

  if (!isFilled("targetRoleFunction")) {
    const derived = autoDeriveTargetRoleFunction({
      skills: Array.isArray(out.skills) ? (out.skills as DeriveSkill[]) : [],
      workHistory: args.signals?.workHistory,
      yoeRange: args.signals?.totalYearsExperience,
    })
    if (derived.targetRoleFunction.length > 0) {
      out.targetRoleFunction = derived.targetRoleFunction
    }
  }

  if (!isFilled("careerStage")) {
    const fromResume = autoDeriveCareerStage(args.signals?.totalYearsExperience)
    const fromMergedYoe =
      fromResume ??
      (Array.isArray(out.yoeRange)
        ? autoDeriveCareerStage(out.yoeRange as [number, number])
        : null)
    if (fromMergedYoe) out.careerStage = fromMergedYoe
  }

  if (!isFilled("visaStatus")) {
    const visaStatus = mapWorkAuthorizationToVisaStatus(args.signals?.workAuthorization)
    if (visaStatus) out.visaStatus = visaStatus
  }

  if (!isFilled("relevantTags")) {
    const relevantTags = deriveRelevantTagsFromResumeSignals(args.signals)
    if (relevantTags.length > 0) out.relevantTags = relevantTags
  }

  return out
}

/**
 * Runner for the unified user-tag merge + write.
 *
 * Reads the existing pa-users doc to pick up `statedPreferences` (chat
 * answers worker writes there) and `preferredLang`, runs the H.1
 * `mergeUserTags` merger over the parsed CV + chat signals, and writes
 * the result back to `pa-users/{userId}.tags`.
 *
 * Contract: NEVER throws. Failures are logged and swallowed — the
 * parsedCandidateResumes write already succeeded; tag-store coherence
 * issues must NOT cascade and break the user-facing CV ingestion path.
 */
export async function runUserTagsMerge(args: {
  db: Firestore
  userId: string
  parsed: StructuredCv
  workHistory: ReadonlyArray<unknown> | undefined
  embedding: ComputeCvEmbeddingResult | null
  /** Phase 53 — canonical Phase 52 vocab pass-through (when v2 ran). */
  industrySector?: string[]
  relevantIndustry?: string[]
  relevantSpecialization?: string[]
  proposedTags?: string[]
  resumeMatchingTagSignals?: ResumeMatchingTagSignals
  mergeUserTagsFn: (input: UserTagsInput) => Record<string, unknown>
  writeUserTags: (
    db: Firestore,
    userId: string,
    tags: Record<string, unknown>
  ) => Promise<void>
  nowIso: () => string
  log: (event: string, payload?: Record<string, unknown>) => void
  /**
   * Injectable unified LinkedIn+résumé merge+determine (Adam 2026-06-05). Default = the real
   * gpt-5.4-mini json_schema-STRICT call. Tests stub it. When non-null, its determined facts
   * (recentRoleTitle/recentCompany/careerStage/yoeRange) override the résumé-only derivation and its
   * merged canonical timeline is written to pa-users.experienceHighlights. Fail-open: null → leave the
   * résumé-only result untouched.
   */
  mergeAndDetermine?: (input: {
    linkedinExperiences: MergeSourceExperience[]
    resumeExperiences: MergeSourceExperience[]
  }) => Promise<MergeAndDetermineProfileResult | null>
}): Promise<void> {
  // 1. Read existing user doc — statedPreferences + preferredLang flow
  //    in from the chat-answers worker (separate write side).
  let userData: Record<string, unknown> | undefined
  try {
    const snap = await args.db.collection(PA_USERS_COLLECTION).doc(args.userId).get()
    if (snap.exists) {
      userData = snap.data() as Record<string, unknown> | undefined
    }
  } catch (err) {
    args.log("pa.cv_user_tags.user_read_error", {
      userId: args.userId,
      error: err instanceof Error ? err.message : String(err),
    })
    // Soft-degrade: still merge tags from CV-only signals.
    userData = undefined
  }

  // 2. Compose mergeUserTags input. CV side carries everything we know
  //    about the parsed resume; chat side passes through statedPreferences
  //    so the unified projection captures both.
  const cvUpdatedAt = args.nowIso()
  const cvInput: UserTagsInput["cv"] = {
    candidateProfile: { skills: args.parsed.candidateProfile.skills },
    experiences: args.parsed.experiences.map((e) => ({
      title: e.title,
      company: e.company,
      description: e.description,
    })),
    industryTags: args.parsed.industryTags,
  }
  // Thread résumé YoE so the merger can reconcile careerStage (a recent
  // intern/TA title must not drag a multi-year career down to intern/student).
  if (
    typeof args.resumeMatchingTagSignals?.totalYearsExperience === "number" &&
    Number.isFinite(args.resumeMatchingTagSignals.totalYearsExperience)
  ) {
    cvInput.totalYearsExperience = args.resumeMatchingTagSignals.totalYearsExperience
  }
  // v2 workHistory carries per-job skills, used by mergeUserTags's full
  // skill bag. Tolerate the unknown[] runtime shape (caller passes the
  // raw v2 array; H.1 collectSkills filters defensively).
  if (Array.isArray(args.workHistory) && args.workHistory.length > 0) {
    cvInput.workHistory = args.workHistory as UserTagsInput["cv"] extends infer T
      ? T extends { workHistory?: infer W }
        ? W
        : never
      : never
  }
  if (args.embedding) {
    cvInput.embedding = args.embedding.vector
    cvInput.embeddingModel = args.embedding.model
    cvInput.embeddingComputedAt = args.embedding.computedAt
  }
  // Phase 53 — pass canonical Phase 52 fields through to mergeUserTags.
  if (Array.isArray(args.industrySector) && args.industrySector.length > 0) {
    cvInput.industrySector = args.industrySector
  }
  if (Array.isArray(args.relevantIndustry) && args.relevantIndustry.length > 0) {
    cvInput.relevantIndustry = args.relevantIndustry
  }
  if (Array.isArray(args.relevantSpecialization) && args.relevantSpecialization.length > 0) {
    cvInput.relevantSpecialization = args.relevantSpecialization
  }
  if (Array.isArray(args.proposedTags) && args.proposedTags.length > 0) {
    cvInput.proposedTags = args.proposedTags
  }

  const statedPrefs = (userData?.statedPreferences as UserTagsInput["statedPreferences"]) ?? undefined
  const preferredLang =
    typeof userData?.preferredLang === "string"
      ? (userData.preferredLang as UserTagsInput["preferredLang"])
      : undefined

  let merged: Record<string, unknown>
  try {
    merged = args.mergeUserTagsFn({
      cv: cvInput,
      statedPreferences: statedPrefs,
      preferredLang,
      cvUpdatedAt,
    }) as Record<string, unknown>
    const existingTags =
      userData?.tags && typeof userData.tags === "object" && !Array.isArray(userData.tags)
        ? (userData.tags as Record<string, unknown>)
        : {}
    const baseline = computeResumeBaselineTagPatch({
      existingTags,
      mergedTags: merged,
      statedPreferences: statedPrefs as Record<string, unknown> | undefined,
      parsedResume: {
        ...args.parsed,
        workHistory: Array.isArray(args.workHistory) ? args.workHistory : undefined,
        industrySector: args.industrySector,
        relevantIndustry: args.relevantIndustry,
        relevantSpecialization: args.relevantSpecialization,
        proposedTags: args.proposedTags,
      } as Record<string, unknown>,
    })
    merged = { ...merged, ...baseline.proposed }
  } catch (err) {
    args.log("pa.cv_user_tags.merge_error", {
      userId: args.userId,
      error: err instanceof Error ? err.message : String(err),
    })
    return
  }
  merged = applyResumeMatchingTagProjection({
    merged,
    existingTags: objectRecord(userData?.tags),
    signals: args.resumeMatchingTagSignals,
  })

  // DURABLE SKILLS-REGRESSION GUARD (2026-05-31) — a degraded re-parse (e.g. a reinit that fell to a
  // weak/no-tier parser) must NOT erase a richer technical skill set already on file. 8fE regressed
  // 63 real skills (c++/java/react/node/docker/k8s/aws…) → 11 prose skills (communication_skills /
  // trilingual / reward_management…) when a parserTier=undefined re-parse overwrote tags.skills.
  // Numeric, NO-REGEX: if the freshly-merged skill set is SMALLER than the one already stored, keep the
  // existing skills (a genuinely richer new résumé — MORE skills — still wins and overwrites).
  const existingSkillsForGuard = (() => {
    const t = objectRecord(userData?.tags)
    return Array.isArray(t?.skills) ? (t!.skills as unknown[]) : []
  })()
  const mergedSkills = Array.isArray(merged.skills) ? (merged.skills as unknown[]) : []
  if (existingSkillsForGuard.length > mergedSkills.length) {
    args.log("pa.cv_user_tags.skills_regression_guarded", {
      userId: args.userId,
      keptExisting: existingSkillsForGuard.length,
      rejectedNew: mergedSkills.length,
    })
    merged = { ...merged, skills: existingSkillsForGuard }
  }

  // 2.5 UNIFIED MERGE + DETERMINE (Adam 2026-06-05): "merge the experience between linkedin & resume,
  //     and ask llm to determine." When a résumé parses we have the résumé workHistory; the user's
  //     LinkedIn experiences live on pa-users.experienceHighlights (written by the Coresignal mirror).
  //     Feed BOTH to the SAME ONE gpt-5.4-mini json_schema-STRICT call so the determined facts
  //     (recentRoleTitle/recentCompany/careerStage/yoeRange) reflect the MERGED truth — fixing the bug
  //     where a stale "Software Engineer Intern" résumé title + undercounted YoE pinned careerStage to
  //     junior while LinkedIn clearly showed a current Senior role. On non-null we (a) write the merged
  //     canonical timeline to pa-users.experienceHighlights, and (b) overlay the determined facts onto
  //     `merged` (they OVERRIDE the résumé-only derivation). FAIL-OPEN: null → leave the résumé-only
  //     result untouched. Never throws (the whole runner already swallows errors).
  let mergedExperienceHighlights: Array<Record<string, unknown>> | undefined
  try {
    const linkedinHl = Array.isArray(userData?.experienceHighlights)
      ? (userData!.experienceHighlights as unknown[])
      : []
    const linkedinSources: MergeSourceExperience[] = linkedinHl
      .filter((h): h is Record<string, unknown> => Boolean(h) && typeof h === "object")
      .map((h) => toSourceFromLinkedin(h))
      .filter((s) => s.title || s.company)
    const resumeSources: MergeSourceExperience[] = (
      Array.isArray(args.workHistory) ? args.workHistory : []
    )
      .filter((w): w is Record<string, unknown> => Boolean(w) && typeof w === "object")
      .map((w) => toSourceFromResume(w))
      .filter((s) => s.title || s.company)
    if (linkedinSources.length > 0 || resumeSources.length > 0) {
      const merge = args.mergeAndDetermine ?? mergeAndDetermineProfile
      const determined = await merge({ linkedinExperiences: linkedinSources, resumeExperiences: resumeSources })
      if (determined && determined.mergedExperiences.length > 0) {
        mergedExperienceHighlights = determined.mergedExperiences.slice(0, 10).map((e) => {
          const out: Record<string, unknown> = {
            title: e.title,
            company: e.company,
            source: "merged_linkedin_resume",
            sourceLabel: "LinkedIn+Résumé",
          }
          if (e.startDate) out.startDate = e.startDate
          if (e.endDate) out.endDate = e.endDate
          if (e.isCurrent === true) out.currentRole = true
          if (e.description) out.description = e.description
          return out
        })
        // Determined facts OVERRIDE the résumé-only derivation (the whole point of the merge).
        if (determined.recentRoleTitle) merged.recentRoleTitle = determined.recentRoleTitle
        if (determined.recentCompany) merged.recentCompany = determined.recentCompany
        if (determined.careerStage) merged.careerStage = determined.careerStage
        if (determined.yoeRange) merged.yoeRange = determined.yoeRange
        // D1 — same-lane role from the merged timeline OVERRIDES the projection's regex derivation AND any
        // stale-but-filled value (this block runs AFTER applyResumeMatchingTagProjection). LLM closed-enum
        // pick is the single source; writeUserTagsFull then auto-projects it to globalTags.roleFunction.
        if (determined.roleFunction && determined.roleFunction.length > 0) {
          merged.targetRoleFunction = determined.roleFunction
        }
        args.log("pa.cv_user_tags.merged_profile", {
          userId: args.userId,
          mergedRoles: determined.mergedExperiences.length,
          recentRoleTitle: determined.recentRoleTitle ?? null,
          careerStage: determined.careerStage ?? null,
        })
      }
    }
  } catch (err) {
    args.log("pa.cv_user_tags.merge_threw", {
      userId: args.userId,
      error: err instanceof Error ? err.message : String(err),
    })
    mergedExperienceHighlights = undefined
  }

  // 3. Write `pa-users/{userId}.tags`. Merge:true preserves any tag
  //    fields the chat-answers worker may have populated (we own the
  //    CV-derived fields; they own the chat-derived ones).
  try {
    await args.writeUserTags(args.db, args.userId, merged)
    // Write the MERGED canonical experienceHighlights to the user doc (top-level, parity with the
    // Coresignal mirror's write site) so all downstream surfaces read one merged timeline. Fail-open:
    // a write error here must NOT taint the tags write success above.
    if (mergedExperienceHighlights && mergedExperienceHighlights.length > 0) {
      try {
        await args.db.collection(PA_USERS_COLLECTION).doc(args.userId).set(
          {
            experienceHighlights: mergedExperienceHighlights,
            experienceHighlightsUpdatedAt: args.nowIso(),
          },
          { merge: true },
        )
      } catch (err) {
        args.log("pa.cv_user_tags.highlights_write_error", {
          userId: args.userId,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }
    const skillsCount = Array.isArray(merged.skills) ? merged.skills.length : 0
    const industryEnum = Array.isArray(merged.industryEnum) ? merged.industryEnum : []
    args.log("pa.cv_user_tags.ok", {
      userId: args.userId,
      skillsCount,
      industryEnum,
    })
  } catch (err) {
    args.log("pa.cv_user_tags.write_error", {
      userId: args.userId,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

// ---------------------------------------------------------------------------
// #3 conversational re-enrich hook (Adam 2026-06-05)
// ---------------------------------------------------------------------------

/**
 * Re-enrich a user's canonical tags from an ALREADY-PARSED résumé (the v2
 * `ParsedResumeData`), reusing the SAME single enrich path as the attachment
 * (webhook Stream-D) and website (public-cv-ingest) flows — `runUserTagsMerge`
 * over the D8 sole writer, with the default `mergeAndDetermineProfile` call (so
 * `targetRoleFunction` / careerStage / skills are re-derived, incl. the #2
 * same-lane role override). NO parallel tag write path, NO regex.
 *
 * This exists because the `cv_parse` CHAT tool only has parsed-text in hand —
 * `ingestCv` is mediaUrl-only, so a résumé PASTED into the chat had no enrich
 * seam before this (it returned parsed text to the LLM and dead-ended). This
 * closes that gap by adapting the parsed struct + computing the embedding +
 * running the merge with production defaults. Fully fail-open: every step is
 * try/caught (and `runUserTagsMerge` itself swallows all errors), so it can be
 * fired-and-forgotten from a conversation turn without ever throwing upward.
 */
export async function reEnrichUserTagsFromParsedResume(args: {
  db: Firestore
  userId: string
  parsedV2: import("@pa/pa-resume-parser").ParsedResumeData
  nowIso?: () => string
  log?: (event: string, payload?: Record<string, unknown>) => void
  /** Test seams — default to the SAME production deps `ingestCv` wires. */
  computeEmbedding?: (
    input: Parameters<typeof computeCvEmbedding>[0],
  ) => Promise<ComputeCvEmbeddingResult | null>
  mergeUserTagsFn?: (input: UserTagsInput) => Record<string, unknown>
  writeUserTags?: (
    db: Firestore,
    userId: string,
    tags: Record<string, unknown>,
  ) => Promise<void>
  /** Injectable unified merge+determine (default = the real gpt-5.4-mini call); tests stub it. */
  mergeAndDetermine?: Parameters<typeof runUserTagsMerge>[0]["mergeAndDetermine"]
}): Promise<void> {
  const nowIso = args.nowIso ?? (() => new Date().toISOString())
  const log = args.log ?? (() => undefined)
  const computeEmbedding = args.computeEmbedding ?? computeCvEmbedding
  const mergeUserTagsFn =
    args.mergeUserTagsFn ?? ((input: UserTagsInput) => mergeUserTags(input) as Record<string, unknown>)
  const writeUserTags = args.writeUserTags ?? defaultWriteUserTags
  try {
    const parsed = adaptV2ToStructuredCv(args.parsedV2)
    const sharedTopSkills = computeTopSkills({
      candidateProfileSkills: parsed.candidateProfile.skills,
      workHistory: args.parsedV2.workHistory,
    })
    // Embedding: best-effort, same sync compute the ingest path uses. Null on any failure.
    let embedResult: ComputeCvEmbeddingResult | null = null
    try {
      embedResult = await computeEmbedding({
        candidateProfile: parsed.candidateProfile,
        experiences: parsed.experiences,
        education: parsed.education,
        industryTags: parsed.industryTags,
        topSkills: sharedTopSkills,
      })
    } catch (err) {
      log("pa.cv_reenrich.embedding_error", {
        userId: args.userId,
        error: err instanceof Error ? err.message : String(err),
      })
      embedResult = null
    }
    await runUserTagsMerge({
      db: args.db,
      userId: args.userId,
      parsed,
      workHistory: args.parsedV2.workHistory,
      embedding: embedResult,
      industrySector: args.parsedV2.relevantIndustry,
      relevantIndustry: args.parsedV2.relevantIndustry,
      relevantSpecialization: args.parsedV2.relevantSpecialization,
      proposedTags: args.parsedV2.proposedTags,
      resumeMatchingTagSignals: {
        skills: args.parsedV2.skills,
        workHistory: args.parsedV2.workHistory,
        totalYearsExperience: args.parsedV2.totalYearsExperience,
        workAuthorization: args.parsedV2.workAuthorization,
        relevantSpecialization: args.parsedV2.relevantSpecialization,
        proposedTags: args.parsedV2.proposedTags,
      },
      mergeUserTagsFn,
      writeUserTags,
      nowIso,
      log,
      ...(args.mergeAndDetermine ? { mergeAndDetermine: args.mergeAndDetermine } : {}),
    })
    log("pa.cv_reenrich.ok", { userId: args.userId })
  } catch (err) {
    // Fully fail-open — a conversational re-enrich must never surface an error.
    log("pa.cv_reenrich.error", {
      userId: args.userId,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

// ---------------------------------------------------------------------------
// Stream E2 — Mem0 long-term memory write
// ---------------------------------------------------------------------------

/**
 * Build a one-line "user CV summary" fact body (English). The body is fed to
 * mem0Add as a USER message; mem0's own LLM extraction layer condenses +
 * dedupes against existing Qdrant vectors.
 */
export function buildCvFactBody(parsed: StructuredCv): string {
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
// iter30 WS1 — limit-rejection runtime handoff + parser-v2 adapter
// ---------------------------------------------------------------------------

function ymdUtc(iso: string): string {
  return iso.slice(0, 10).replace(/-/g, "")
}

async function enqueueLimitRejection(args: {
  db: Firestore
  userId: string
  reason: "not_invited" | "quota_exhausted" | "pdf_too_large"
  toE164: string | null
  nowIso: string
  log: (event: string, payload?: Record<string, unknown>) => void
}): Promise<void> {
  if (!args.toE164) {
    args.log("pa.cv_reject.skipped", { reason: "no_phone", userId: args.userId, kind: args.reason })
    return
  }
  const idempotencyKey = `${CV_REJECT_RUNTIME_PREFIX}${args.userId}-${ymdUtc(args.nowIso)}-${args.reason}`
  try {
    const runtime = await enqueueRuntimeEventHandoff(args.db, {
      userId: args.userId,
      toE164: args.toE164,
      source: "cv_ingest",
      eventKind: "resume_ingest_rejected",
      idempotencyKey,
      nowIso: () => args.nowIso,
      context: {
        rejectReason: args.reason,
        cvIngestGate: true,
      },
    })
    args.log("pa.cv_reject.runtime_handoff", {
      userId: args.userId,
      kind: args.reason,
      runtime,
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    args.log("pa.cv_reject.error", {
      stage: "runtime_handoff",
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
  // iter34 H.3a — same skill-token fallback as the v1 path. Catches v2 CVs
  // whose top-3 work-history blobs all map to "other" but whose skills array
  // contains tech/AI tokens (Adam's CV pattern).
  const finalTags = applyIndustryTagsFallback(tags, candidateProfile.skills)
  return { candidateProfile, experiences, education, industryTags: finalTags }
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

/**
 * Phase 53 (PARSE-09) — sha256 idempotency lookup.
 *
 * Query `parsedCandidateResumes` where `userId == X AND sha256 == Y`. If
 * a doc exists, return its id; otherwise null. Skip-if-found avoids
 * re-parsing the same PDF (saves an LLM call) and prevents duplicate
 * side-effects (Claire confirm, mem0 write).
 *
 * NEVER throws — on any Firestore error returns null (treat as miss).
 */
async function defaultFindResumeBySha256(
  db: Firestore,
  userId: string,
  sha256: string
): Promise<string | null> {
  type DocLike = {
    id: string
    data(): Record<string, unknown> | undefined
  }
  type SnapLike = { docs: DocLike[]; empty?: boolean }
  try {
    const q = db
      .collection(PARSED_RESUMES_COLLECTION)
      .where("userId", "==", userId)
      .where("sha256", "==", sha256)
      .limit(1)
    const snap = (await (q as unknown as { get: () => Promise<SnapLike> }).get()) as SnapLike
    if (snap.docs.length === 0) return null
    return snap.docs[0]!.id
  } catch {
    return null
  }
}

async function defaultIsParserV2Enabled(
  db: Firestore,
  userId: string
): Promise<boolean> {
  // Phase 53 (PARSE-01, D11) — parser-v2 is now the DEFAULT path. Flag
  // is preserved as a kill-switch (set false to force legacy single-shot
  // path for a specific user). Flag-system unavailable → still default ON
  // so deployment regressions don't silently fall back to legacy path.
  try {
    const mod = (await import("@pa/pa-persistence")) as {
      getFlag: (
        db: Firestore,
        key: string,
        ctx: { userId?: string },
        defaultValue?: boolean
      ) => Promise<boolean | number | string>
    }
    const v = await mod.getFlag(db, RESUME_PARSER_V2_FLAG_KEY, { userId }, true)
    return v !== false
  } catch {
    return true
  }
}

/**
 * Build a candidateProfileSummary (the same shape `buildCvFactBody(parsed)` emits) from an
 * ALREADY-STORED parsedCandidateResumes row. Used on the sha256 idempotent-hit return path, where
 * `parsed` was never computed this run (the early return short-circuits before LLM extraction) — the
 * row that caused the hit carries `candidateProfile`/`experiences`/`education`, so we reconstruct the
 * summary from it instead of re-parsing. NEVER throws — returns "" on any read/shape error.
 */
async function summaryFromStoredResume(db: Firestore, resumeId: string): Promise<string> {
  try {
    const snap = await db.collection(PARSED_RESUMES_COLLECTION).doc(resumeId).get()
    if (!snap.exists) return ""
    const row = (snap.data() ?? {}) as Record<string, unknown>
    const cp = (row.candidateProfile ?? {}) as Record<string, unknown>
    const reconstructed = {
      candidateProfile: {
        name: typeof cp.name === "string" ? cp.name : null,
        email: typeof cp.email === "string" ? cp.email : null,
        phone: typeof cp.phone === "string" ? cp.phone : null,
        linkedIn: typeof cp.linkedIn === "string" ? cp.linkedIn : null,
        location: typeof cp.location === "string" ? cp.location : null,
        skills: Array.isArray(cp.skills)
          ? (cp.skills as unknown[]).map((s) => (typeof s === "string" ? s : "")).filter(Boolean)
          : [],
      },
      experiences: Array.isArray(row.experiences) ? (row.experiences as never[]) : [],
      education: Array.isArray(row.education) ? (row.education as never[]) : [],
      industryTags: Array.isArray(row.industryTags) ? (row.industryTags as never[]) : [],
    } as unknown as StructuredCv
    return buildCvFactBody(reconstructed)
  } catch {
    return ""
  }
}

/**
 * BLOCKER 1 FIX (Adam 2026-06-03 — "silent pitch loss" race): fire the resume_parse_completed runtime
 * handoff EXACTLY ONCE for a (user, pdf), even on the sha256 idempotent-hit early-return path.
 *
 * WHY: the webhook (Stream-D) ingest is now parse-only (followupDeliveryMode:"none") but it STILL writes
 * the parsedCandidateResumes row WITH its sha256 ~1-2s before the cutover (runtime) ingest. The cutover
 * ingest's sha256 lookup then HITS that row and returns early (cv-ingest.ts idempotent-hit) BEFORE
 * reaching the main resume_parse_completed handoff → ZERO pitch, no fallback. So we fire the handoff
 * here too, on the early return. The handoff is idempotent on the SAME sha-keyed idempotencyKey the main
 * path uses (`cv-parsed:${userId}:${pdfSha256||resumeId}`), so firing it from BOTH the early-return path
 * and the main path collapses to ONE inbound doc (existingEvent.exists → created:false). Firing twice is
 * safe; firing AT LEAST once is now guaranteed regardless of which invocation wins the sha256 race.
 *
 * NEVER throws — the idempotent-hit return must stay ok:true even if the handoff write fails.
 */
async function fireResumeParsedHandoffOnIdempotentHit(input: {
  db: Firestore
  userId: string
  resumeId: string
  pdfSha256: string
  sessionId?: string
  followupDeliveryMode: CvFollowupDeliveryMode
  candidateProfileSummary?: string
  lookupUserForFollowup: (db: Firestore, userId: string) => Promise<CvFollowupUser | null>
  log: (event: string, payload?: Record<string, unknown>) => void
}): Promise<void> {
  if (input.followupDeliveryMode !== "runtime") return
  try {
    const user = await input.lookupUserForFollowup(input.db, input.userId).catch(() => null)
    const phone = user?.toE164
    if (!phone) {
      input.log("pa.cv_followup.idempotent_hit_handoff_skipped", {
        userId: input.userId,
        resumeId: input.resumeId,
        reason: "no_phone",
      })
      return
    }
    // Same shape buildCvFactBody emits — prefer the caller-provided summary (identity path has `parsed`),
    // otherwise reconstruct from the already-stored row (non-identity path returns before LLM extraction).
    const summary =
      input.candidateProfileSummary && input.candidateProfileSummary.trim()
        ? input.candidateProfileSummary
        : await summaryFromStoredResume(input.db, input.resumeId)
    const handoffIdempotencyKey = `cv-parsed:${input.userId}:${input.pdfSha256 || input.resumeId}`
    const runtime = await enqueueRuntimeEventHandoff(input.db, {
      userId: input.userId,
      toE164: phone,
      sessionId: input.sessionId,
      requireExistingSession: false,
      source: "cv_ingest",
      eventKind: "resume_parse_completed",
      idempotencyKey: handoffIdempotencyKey,
      context: {
        resumeId: input.resumeId,
        candidateProfileSummary: summary,
        cvParsedTrigger: true,
      },
    })
    input.log("pa.cv_followup.idempotent_hit_handoff", {
      userId: input.userId,
      resumeId: input.resumeId,
      runtime,
    })
  } catch (err) {
    input.log("pa.cv_followup.idempotent_hit_handoff_failed", {
      userId: input.userId,
      resumeId: input.resumeId,
      error: err instanceof Error ? err.message : String(err),
    })
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

  // iter34 H.3b — unified user-tags merge + write (test seams).
  const mergeUserTagsFn =
    deps?.mergeUserTagsFn ??
    ((input: UserTagsInput) => mergeUserTags(input) as Record<string, unknown>)
  const writeUserTags = deps?.writeUserTags ?? defaultWriteUserTags

  // Phase 53 — second-pass + confirm-enqueue + sha256 idempotency seams.
  const runIndustrySecondPassFn =
    deps?.runIndustrySecondPassFn ??
    (async (a: {
      cvText: string
      workHistory: ReadonlyArray<WorkHistorySummary>
      apiKey: string | undefined
      log: (event: string, payload?: Record<string, unknown>) => void
    }): Promise<string[]> => {
      const out = await runIndustrySecondPass({
        cvText: a.cvText,
        workHistory: a.workHistory,
        apiKey: a.apiKey,
        log: a.log,
      })
      return out as string[]
    })
  const findResumeBySha256 =
    deps?.findResumeBySha256 ?? defaultFindResumeBySha256
  const resolveCandidateIdentity =
    deps?.resolveCandidateIdentity ?? defaultResolveCandidateIdentity
  const followupDeliveryMode = deps?.followupDeliveryMode ?? "runtime"

  if (!args || typeof args !== "object" || !args.userId || !args.mediaUrl) {
    return { ok: false, reason: "invalid_input" }
  }
  const sourceUserId = args.userId
  let userId = sourceUserId
  const identityEnabled = Boolean(
    nonEmptyTrimmed(args.browserUid) ||
      nonEmptyTrimmed(args.employerEmailHint) ||
      nonEmptyTrimmed(args.atsApplicantId) ||
      args.identitySource
  )

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

  // Phase 53 (PARSE-09) — sha256 idempotency check. Compute hash of the
  // downloaded PDF bytes and short-circuit if we've already parsed an
  // identical PDF for this user. Saves an LLM call AND prevents duplicate
  // side-effects (Claire confirm, mem0 write).
  let pdfSha256: string
  try {
    pdfSha256 = createHash("sha256").update(bytes).digest("hex")
  } catch (err) {
    // Crypto failure should be impossible in Node; defensive.
    log("pa.cv_ingest.sha256_error", {
      userId: args.userId,
      error: err instanceof Error ? err.message : String(err),
    })
    pdfSha256 = ""
  }
  const lookupExistingResumeBySha256 = async (lookupUserId: string): Promise<string | null> => {
    if (pdfSha256.length === 0) return null
    try {
      const existingId = await findResumeBySha256(dbHandle, lookupUserId, pdfSha256)
      if (existingId) {
        log("pa.cv_ingest.idempotent_hit", {
          userId: lookupUserId,
          sha256: pdfSha256,
          resumeId: existingId,
        })
        return existingId
      }
    } catch (err) {
      // Lookup failure → log + proceed (fail-open; parser will write a fresh row).
      log("pa.cv_ingest.idempotent_lookup_error", {
        userId: lookupUserId,
        sha256: pdfSha256,
        error: err instanceof Error ? err.message : String(err),
      })
    }
    return null
  }
  if (!identityEnabled) {
    const existingId = await lookupExistingResumeBySha256(userId)
    if (existingId) {
      // BLOCKER 1 FIX — the sha256 row already exists (the parse-only webhook ingest, or a prior run,
      // wrote it). The early return below skips the main resume_parse_completed handoff, so fire it
      // HERE (sha-keyed → dedups against the main path). `parsed` isn't computed on this path, so the
      // helper reconstructs the summary from the stored row.
      await fireResumeParsedHandoffOnIdempotentHit({
        db: dbHandle,
        userId,
        resumeId: existingId,
        pdfSha256,
        sessionId: args.sessionId,
        followupDeliveryMode,
        lookupUserForFollowup,
        log,
      })
      return { ok: true, resumeId: existingId, userId }
    }
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

  const extractedEmail = nonEmptyTrimmed(parsed.candidateProfile.email)
  if (args.requireExtractedEmail && !extractedEmail) {
    log("pa.cv_ingest.missing_extracted_email", {
      userId: sourceUserId,
      employerEmailHintPresent: Boolean(nonEmptyTrimmed(args.employerEmailHint)),
      atsApplicantIdPresent: Boolean(nonEmptyTrimmed(args.atsApplicantId)),
      browserUidPresent: Boolean(nonEmptyTrimmed(args.browserUid)),
    })
    return { ok: false, reason: "missing_extracted_email" }
  }

  if (identityEnabled) {
    const employerEmailHint = nonEmptyTrimmed(args.employerEmailHint)
    const browserUid = nonEmptyTrimmed(args.browserUid)
    const atsApplicantId = nonEmptyTrimmed(args.atsApplicantId)
    const parsedPhoneRaw = nonEmptyTrimmed(v2Output?.parsed.phone ?? parsed.candidateProfile.phone)
    const phoneE164 = parsedPhoneRaw ? normalizeCvPhoneToE164(parsedPhoneRaw) : undefined
    const source: CandidateHandleSource =
      args.identitySource ?? (atsApplicantId || employerEmailHint ? "ats" : "resume")
    try {
      const resolution = await resolveCandidateIdentity(dbHandle, {
        extractedEmail,
        employerEmailHint,
        phoneE164,
        browserUid,
        atsApplicantId,
        source,
        candidateIdHint: sourceUserId,
        useCandidateIdHint: false,
        now: nowIso(),
        evidence: [
          {
            source: source === "ats" ? "ats" : "resume_parse",
            summary: "CV ingest resolved canonical candidate before permanent writes",
            refId: args.mediaUrl,
          },
        ],
      })
      if (resolution.outcome === "identity_conflict") {
        log("pa.cv_ingest.identity_conflict", {
          userId: sourceUserId,
          conflictId: resolution.conflict.conflictId,
          kind: resolution.conflict.kind,
        })
        return {
          ok: false,
          reason: "identity_conflict",
          conflictId: resolution.conflict.conflictId,
          extractedEmail,
        }
      }
      // Identity hardening 2026-05-21 — `not_found` is only emitted when
      // the resolver is called with `mode: "resolve_only"`. cv-ingest
      // never sets that flag (resume parsing IS an L1 entry, so we
      // intend to create the candidate), so this branch is defensive
      // only and exists to satisfy the discriminated-union narrowing.
      if (resolution.outcome === "not_found") {
        log("pa.cv_ingest.identity_unexpected_not_found", { userId: sourceUserId })
        return { ok: false, reason: "identity_conflict", extractedEmail }
      }
      userId = resolution.candidateId
      log("pa.cv_ingest.identity_resolved", {
        sourceUserId,
        userId,
        outcome: resolution.outcome,
        source,
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      log("pa.cv_ingest.identity_error", {
        userId: sourceUserId,
        error: message,
      })
      return {
        ok: false,
        reason: message.startsWith("identity_conflict:")
          ? "identity_conflict"
          : "identity_resolution_failed",
        conflictId: message.startsWith("identity_conflict:")
          ? message.slice("identity_conflict:".length)
          : undefined,
        extractedEmail,
      }
    }

    const existingId = await lookupExistingResumeBySha256(userId)
    if (existingId) {
      // BLOCKER 1 FIX — same as the non-identity path, but `parsed` IS available here (LLM extraction
      // already ran before identity resolution), so thread its summary straight through (no row re-read).
      await fireResumeParsedHandoffOnIdempotentHit({
        db: dbHandle,
        userId,
        resumeId: existingId,
        pdfSha256,
        sessionId: args.sessionId,
        followupDeliveryMode,
        candidateProfileSummary: buildCvFactBody(parsed),
        lookupUserForFollowup,
        log,
      })
      return {
        ok: true,
        resumeId: existingId,
        userId,
        extractedEmail,
        candidateProfileSummary: buildCvFactBody(parsed),
      }
    }
  }

  // Cost-tracking telemetry — input/output token counts feed cost
  // dashboards. Estimated $0.0005-0.002 per CV with gpt-5.4-nano.
  log("pa.cv_ingest.cost", {
    userId: userId,
    inputTokens: usage?.input_tokens,
    outputTokens: usage?.output_tokens,
    totalTokens: usage?.total_tokens,
    model: usedModel,
    parserV2: parserV2On,
    tier: usedTier,
  })

  // Phase 53 (PARSE-08, D15) — Industry second-pass when primary parser
  // produced ["other"] or empty. Reduces regex reliance by asking Sonnet
  // to reason explicitly about industry classification with the canonical
  // 42-token enum embedded in the prompt. NEVER throws.
  const isOtherOnly =
    parsed.industryTags.length === 0 ||
    (parsed.industryTags.length === 1 && parsed.industryTags[0] === "other")
  if (isOtherOnly) {
    try {
      const workHistory: WorkHistorySummary[] = parsed.experiences.slice(0, 3).map((e) => ({
        title: e.title,
        company: e.company,
        description: e.description,
        location: e.location,
      }))
      // 2026-06-05 — LLM-driven industry rescue (replaces the TECH_TOKENS /
      // AI_TOKENS regex sniff for the canonical 42-token axis). For the canary
      // cohort, thread the candidate's SKILLS into the second-pass prompt so
      // the "SWE/Tesla/AWS → other" case the regex existed to rescue is now
      // caught by the LLM. Non-canary keeps the existing second-pass call
      // verbatim. Both fail OPEN to [] (caller keeps prior value); the 10-bucket
      // `industryTags` keep their applyIndustryTagsFallback baseline regardless.
      const secondPassResult = isCanaryUser(userId)
        ? await rescueIndustryWithSkillsLlm({
            cvText: text,
            skills: parsed.candidateProfile.skills,
            workHistory,
            apiKey: process.env.ANTHROPIC_API_KEY?.trim() || undefined,
            log,
            runIndustrySecondPassFn,
          })
        : await runIndustrySecondPassFn({
            cvText: text,
            workHistory,
            apiKey: process.env.ANTHROPIC_API_KEY?.trim() || undefined,
            log,
          })
      if (Array.isArray(secondPassResult) && secondPassResult.length > 0) {
        log("pa.cv_ingest.industry_second_pass.applied", {
          userId: userId,
          industries: secondPassResult,
          previousTags: parsed.industryTags,
        })
        // Phase 53 attaches Phase 52 canonical industries. Stored downstream
        // on parsedCandidateResumes.industries (separate from the legacy
        // 10-bucket industryTags), and on pa-users.tags.relevantIndustry.
        ;(v2Output as unknown as { __secondPassIndustries?: string[] } | null) &&
          ((v2Output as unknown as { __secondPassIndustries?: string[] }).__secondPassIndustries =
            secondPassResult)
        // Also propagate to relevantIndustry on the v2 parsed output (so the
        // mergeUserTags input picks them up).
        if (v2Output) {
          const existing = Array.isArray(v2Output.parsed.relevantIndustry)
            ? v2Output.parsed.relevantIndustry
            : []
          // Merge + dedupe; keep total ≤ 6.
          const merged: string[] = []
          const seen = new Set<string>()
          for (const x of [...secondPassResult, ...existing]) {
            if (typeof x !== "string" || seen.has(x)) continue
            seen.add(x)
            merged.push(x)
            if (merged.length >= 6) break
          }
          v2Output.parsed.relevantIndustry = merged
        }
      }
    } catch (err) {
      // Defensive — runIndustrySecondPass is contracted not to throw, but
      // an injected stub might. Log + continue.
      log("pa.cv_ingest.industry_second_pass.error", {
        userId: userId,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

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
        userId: userId,
        dim: embedResult.dim,
        model: embedResult.model,
      })
    } else {
      log("pa.cv_ingest.embedding_skipped", {
        userId: userId,
        reason: "compute_returned_null",
      })
    }
  } catch (err) {
    // Defensive — computeCvEmbedding contract is "never throws", but if a
    // test injectable misbehaves we still must not block the doc write.
    log("pa.cv_ingest.embedding_error", {
      userId: userId,
      error: err instanceof Error ? err.message : String(err),
    })
    embedResult = null
  }

  // 4. Stream H3 gate — feature-flag + existing-resume detection.
  //    When BOTH are true (flag ON AND user has ≥1 prior resume), we DO NOT
  //    write parsedCandidateResumes yet. Stage in pa-cv-pending and hand the
  //    prompt context to runtime. Otherwise fall through to the
  //    direct-write path (backward compat).
  let h3FlagOn = false
  let prior: { id: string; data: Record<string, unknown> } | null = null
  try {
    h3FlagOn = await isFlagEnabled(dbHandle, CV_OVERWRITE_FLAG_KEY, userId)
  } catch (err) {
    // Flag read failure → treat as OFF (graceful degrade to legacy path).
    log("pa.cv_overwrite.flag_read_error", {
      userId: userId,
      error: err instanceof Error ? err.message : String(err),
    })
    h3FlagOn = false
  }
  if (h3FlagOn) {
    try {
      prior = await findExistingResume(dbHandle, userId)
    } catch (err) {
      log("pa.cv_overwrite.lookup_error", {
        userId: userId,
        error: err instanceof Error ? err.message : String(err),
      })
      prior = null
    }
  }
  if (h3FlagOn && prior && followupDeliveryMode === "runtime") {
    // Flag ON + existing resume in an active iMessage path: stage the new
    // parsed doc and hand structured overwrite facts to runtime. Runtime owns
    // the actual candidate-visible prompt.
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
      userId: userId,
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
    // Phase 53 — sha256 idempotency token + canonical Phase 52 fields
    // also propagate through the staged path so promoted docs match the
    // legacy direct-write field set.
    if (pdfSha256 && pdfSha256.length > 0) {
      stagedDoc.sha256 = pdfSha256
    }
    if (v2Output) {
      stagedDoc.relevantIndustry = v2Output.parsed.relevantIndustry ?? []
      stagedDoc.relevantSpecialization = v2Output.parsed.relevantSpecialization ?? []
      stagedDoc.proposedTags = v2Output.parsed.proposedTags ?? []
      const secondPass = (v2Output as unknown as { __secondPassIndustries?: string[] }).__secondPassIndustries
      stagedDoc.industries =
        Array.isArray(secondPass) && secondPass.length > 0
          ? secondPass
          : (v2Output.parsed.relevantIndustry ?? [])
    } else {
      stagedDoc.relevantIndustry = []
      stagedDoc.relevantSpecialization = []
      stagedDoc.proposedTags = []
      stagedDoc.industries = []
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
        userId: userId,
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
        userId: userId,
        newResumeId,
      })
      if (!isDup) {
        // Real failure: do not message. Continue with the normal profile write
        // so the resume is not dropped.
        h3FlagOn = false
      }
    }
    if (pendingWritten) {
      let userForPrompt: CvFollowupUser | null = null
      try {
        userForPrompt = await lookupUserForFollowup(dbHandle, userId)
      } catch (err) {
        log("pa.cv_overwrite.user_lookup_error", {
          userId: userId,
          error: err instanceof Error ? err.message : String(err),
        })
      }
      if (userForPrompt?.toE164) {
        try {
          const runtime = await enqueueRuntimeEventHandoff(dbHandle, {
            userId: userId,
            toE164: userForPrompt.toE164,
            sessionId: args.sessionId,
            source: "cv_ingest",
            eventKind: "resume_overwrite_pending",
            idempotencyKey: `${CV_OVERWRITE_RUNTIME_PREFIX}${newResumeId}`,
            nowIso: () => ts,
            context: {
              cvOverwrite: {
                newResumeId,
                previousResumeId: prior.id,
              },
              pendingTtlHours: 24,
            },
          })
          log("pa.cv_overwrite.runtime_handoff", {
            userId: userId,
            newResumeId,
            previousResumeId: prior.id,
            runtime,
          })
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          log("pa.cv_overwrite.error", {
            stage: "runtime_handoff",
            error: msg,
            userId: userId,
            newResumeId,
          })
        }
      } else {
        log("pa.cv_overwrite.prompt_skipped", {
          reason: "no_phone",
          userId: userId,
          newResumeId,
        })
      }
      // H3 short-circuits — DO NOT run E1/E2 side effects on a staged CV;
      // those run after promote. Caller gets the would-be resumeId so
      // logs are still traceable, but ok=true reflects the staged state.
      return {
        ok: true,
        resumeId: newResumeId,
        userId,
        extractedEmail,
        candidateProfileSummary: buildCvFactBody(parsed),
      }
    }
    // Fell through (pendingWritten === false AND h3FlagOn flipped to false)
    // → continue to normal write below. Variables `prior` / `newResumeId`
    // are local only and not referenced further.
  }

  // 5. Firestore write (normal parsed-resume profile path when
  //    flag OFF or no prior resume exists).
  let resumeId: string
  try {
    const ts = nowIso()
    // iter34 A.1 — derive topSkills (was a ghost field — written by no one,
    // read by orchestrator-deps.generateJobRecs). Frequency-ranked + capped
    // at 12 from candidateProfile.skills + (when v2) workHistory[].skills.
    // iter34 sprint B.9 — sharedTopSkills computed once above; reused here
    // so the normal + H3 staged rows carry the same field set.
    const baseDoc: Record<string, unknown> = {
      userId: userId,
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
      // Phase 53 (PARSE-03..PARSE-05) — extended canonical fields.
      baseDoc.relevantIndustry = v2Output.parsed.relevantIndustry ?? []
      baseDoc.relevantSpecialization = v2Output.parsed.relevantSpecialization ?? []
      baseDoc.proposedTags = v2Output.parsed.proposedTags ?? []
      // Phase 53 — also expose `industries` (canonical 42-token vocab) so
      // downstream Phase 56 match query reads a single source. Falls back
      // to relevantIndustry when no second-pass override happened.
      const secondPass = (v2Output as unknown as { __secondPassIndustries?: string[] }).__secondPassIndustries
      baseDoc.industries =
        Array.isArray(secondPass) && secondPass.length > 0
          ? secondPass
          : (v2Output.parsed.relevantIndustry ?? [])
    } else {
      baseDoc.parserVersion = "v1"
      baseDoc.relevantIndustry = []
      baseDoc.relevantSpecialization = []
      baseDoc.proposedTags = []
      baseDoc.industries = []
    }
    // Phase 53 (PARSE-09) — sha256 idempotency token. Always present on
    // new docs so future re-uploads of the SAME PDF short-circuit cleanly.
    if (pdfSha256 && pdfSha256.length > 0) {
      baseDoc.sha256 = pdfSha256
    }
    const ref = await dbHandle.collection(PARSED_RESUMES_COLLECTION).add(baseDoc)
    resumeId = ref.id
    log("pa.cv_ingest.ok", {
      userId: userId,
      resumeId: ref.id,
      parserVersion: v2Output ? "v2" : "v1",
    })

    // iter34 H.3b — unified user-tags write side. Fail-open: never throws,
    // never blocks. We `await` here (rather than fire-and-forget) so the
    // resulting tags are visible to the E1/E2/E3 followups that fire in
    // parallel below — but `runUserTagsMerge` swallows ALL errors so this
    // await cannot taint the success path. Awaited because: (a) the user
    // doc lookup is shared with the Stream E branches and we want to
    // avoid double-reads; (b) tag-write failures should appear in logs
    // alongside the originating cv-ingest event, not minutes later.
    // Phase 53 — pull canonical Phase 52 fields from v2 output (and the
    // possibly-overridden second-pass industries).
    const sectorSecondPass = v2Output
      ? (v2Output as unknown as { __secondPassIndustries?: string[] }).__secondPassIndustries
      : undefined
    const industrySectorMerge: string[] | undefined =
      Array.isArray(sectorSecondPass) && sectorSecondPass.length > 0
        ? sectorSecondPass
        : v2Output?.parsed.relevantIndustry
    await runUserTagsMerge({
      db: dbHandle,
      userId: userId,
      parsed,
      workHistory: v2Output?.parsed.workHistory,
      embedding: embedResult,
      industrySector: industrySectorMerge,
      relevantIndustry: v2Output?.parsed.relevantIndustry,
      relevantSpecialization: v2Output?.parsed.relevantSpecialization,
      proposedTags: v2Output?.parsed.proposedTags,
      resumeMatchingTagSignals: v2Output
        ? {
            skills: v2Output.parsed.skills,
            workHistory: v2Output.parsed.workHistory,
            totalYearsExperience: v2Output.parsed.totalYearsExperience,
            workAuthorization: v2Output.parsed.workAuthorization,
            relevantSpecialization: v2Output.parsed.relevantSpecialization,
            proposedTags: v2Output.parsed.proposedTags,
          }
        : undefined,
      mergeUserTagsFn,
      writeUserTags,
      nowIso,
      log,
    })

    // v1.9 hotfix (Adam directive 2026-05-12) — write phoneE164 from parsed CV
    // phone to pa-users, only if not already set. Enables:
    //   - ATS Pattern B (CV → match/runtime event) without prior inbound.
    //   - Pattern A returning user where PII was not yet collected but CV is.
    // Never overwrite an existing phone (PII-confirmed user-provided phone wins).
    // Fail-open: never throws, never blocks parsedCandidateResumes write success.
    const parsedPhoneRaw = v2Output?.parsed.phone ?? parsed.candidateProfile.phone ?? null
    if (parsedPhoneRaw) {
      try {
        const normalized = normalizeCvPhoneToE164(parsedPhoneRaw)
        if (normalized) {
          const userRef = dbHandle.collection(PA_USERS_COLLECTION).doc(userId)
          const userSnap = await userRef.get()
          const existingPhone = userSnap.data()?.phoneE164
          if (
            !existingPhone ||
            typeof existingPhone !== "string" ||
            existingPhone.length === 0
          ) {
            await userRef.set(
              {
                phoneE164: normalized,
                phoneE164Source: "cv_parsed",
                updatedAt: nowIso(),
              },
              { merge: true }
            )
            log("pa.cv_ingest.phone_e164_written", {
              userId: userId,
              source: "cv_parsed",
              raw_len: parsedPhoneRaw.length,
            })
          }
        } else {
          log("pa.cv_ingest.phone_e164_unparseable", {
            userId: userId,
            raw_preview: parsedPhoneRaw.slice(0, 20),
          })
        }
      } catch (err) {
        log("pa.cv_ingest.phone_e164_write_failed", {
          error: err instanceof Error ? err.message : String(err),
          userId: userId,
        })
      }
    }
  } catch (err) {
    log("pa.cv_ingest.error", {
      stage: "firestore",
      error: err instanceof Error ? err.message : String(err),
      userId: userId,
    })
    return { ok: false, reason: "firestore_write_failed" }
  }

  // iter30 WS1 — atomic quota increment AFTER successful write. Failure
  // here is logged + tolerated (off-by-one acceptable per detail-plan §5.3).
  if (!skipLimits) {
    try {
      await writeQuotaIncrement(dbHandle, userId, nowIso())
    } catch (err) {
      log("pa.cv_ingest.quota_increment_error", {
        userId: userId,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  // 6. Stream E side effects (E1 + E2 + E3 in parallel, fire-and-forget,
  //    all NEVER throw). We resolve the user once + share the read.
  let user: CvFollowupUser | null = null
  try {
    user = await lookupUserForFollowup(dbHandle, userId)
  } catch (err) {
    log("pa.cv_followup.error", {
      stage: "user_lookup",
      error: err instanceof Error ? err.message : String(err),
      userId: userId,
    })
  }
  if (user) {
    const branches: Array<Promise<unknown>> = [
      runMem0Write({
        userId: userId,
        resumeId,
        parsed,
        user,
        mem0Add: mem0AddFn,
        log,
      }),
    ]
    log("pa.cv_followup.direct_outbound_removed", {
      reason: followupDeliveryMode === "none" ? "delivery_none" : "runtime_delivery",
      userId: userId,
      resumeId,
    })
    // iter30 WS1 — Stream E3: qaBank → Mem0 with metadata + tag-event coupling.
    // Only runs when parser v2 produced inferredAnswers. Failure is silent
    // (the Mem0 fact body and outbound followup are already written).
    if (v2Output && v2Output.parsed.inferredAnswers.length > 0) {
      branches.push(
        runQaBankToMem0({
          db: dbHandle,
          userId: userId,
          partitionKey: user.mem0UserId ?? userId,
          resumeId,
          inferredAnswers: v2Output.parsed.inferredAnswers,
          nowIso,
          log,
        })
      )
    }
    await Promise.allSettled(branches)

    // Fire a synthetic runtime event AFTER all CV-ingest async work
    // completes so Claire can decide the next user-visible turn with the
    // freshly-written parsedCandidateResume visible. This is a system event,
    // not user speech, so it must go through runtime-event handoff.
    if (followupDeliveryMode === "runtime") {
      try {
        const phone = user.toE164
        if (phone) {
          // BUG 2 FIX (Adam 2026-06-02): the post-parse pitch must fire AT MOST ONCE per (user, PDF).
          // One résumé drop triggers TWO concurrent ingestCv runs (webhook Stream-D + cutover); on a
          // first upload both miss the lock-free sha256 guard, each writes a DISTINCT parsedCandidateResume
          // (distinct resumeId), and a resumeId-scoped idempotencyKey produced TWO handoff docs → TWO pitch
          // turns (the "same/similar text sent twice"). Scope the handoff key to the pdf sha256 (identical
          // across both runs, computed at line ~1703) so enqueueRuntimeEventHandoff's existingEvent.exists
          // check collapses the second run to created:false → exactly ONE resume_parse_completed event →
          // ONE pitch. Fall back to resumeId only if hashing failed (empty sha would alias DISTINCT résumés).
          const handoffIdempotencyKey = `cv-parsed:${userId}:${pdfSha256 || resumeId}`
          // BUG 1 FIX (defensive): when the LIVE session is threaded in (cutover passes the real sessionId),
          // the session always exists, so requireExistingSession is moot. When NO sessionId is supplied (the
          // webhook Stream-D producer for an already-onboarded user), the derived session may not exist yet —
          // do NOT silently drop the candidate-facing re-entry: allow the handoff to attach the derived
          // session (requireExistingSession:false) so the pitch is never lost to a race. Either way exactly
          // one handoff doc is created (sha256-keyed above).
          const runtime = await enqueueRuntimeEventHandoff(dbHandle, {
            userId,
            toE164: phone,
            sessionId: args.sessionId,
            requireExistingSession: false,
            source: "cv_ingest",
            eventKind: "resume_parse_completed",
            idempotencyKey: handoffIdempotencyKey,
            context: {
              resumeId,
              candidateProfileSummary: buildCvFactBody(parsed),
              cvParsedTrigger: true,
            },
          })
          log("pa.cv_followup.synthetic_trigger_written", {
            userId: userId,
            resumeId,
            runtime,
          })
        }
      } catch (err) {
        log("pa.cv_followup.synthetic_trigger_failed", {
          userId: userId,
          resumeId,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    } else {
      log("pa.cv_followup.synthetic_trigger_skipped", {
        userId: userId,
        resumeId,
        reason: "delivery_none",
      })
    }
  } else {
    log("pa.cv_followup.skipped", { reason: "no_user_record", userId: userId })
  }

  return {
    ok: true,
    resumeId,
    userId,
    extractedEmail,
    candidateProfileSummary: buildCvFactBody(parsed),
  }
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
