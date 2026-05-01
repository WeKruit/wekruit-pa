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
  let resumeId: string
  try {
    const ts = nowIso()
    const doc = {
      userId: args.userId,
      candidateProfile: parsed.candidateProfile,
      experiences: parsed.experiences,
      education: parsed.education,
      // Stream F1 — 1..3 canonical industry tags inferred from experiences.
      industryTags: parsed.industryTags,
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
    resumeId = ref.id
    log("pa.cv_ingest.ok", { userId: args.userId, resumeId: ref.id })
  } catch (err) {
    log("pa.cv_ingest.error", {
      stage: "firestore",
      error: err instanceof Error ? err.message : String(err),
      userId: args.userId,
    })
    return { ok: false, reason: "firestore_write_failed" }
  }

  // 5. Stream E side effects (E1 + E2 in parallel, both fire-and-forget,
  //    both NEVER throw). We resolve the user once + share the read.
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
    await Promise.allSettled([
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
    ])
  } else {
    log("pa.cv_followup.skipped", { reason: "no_user_record", userId: args.userId })
  }

  return { ok: true, resumeId }
}
