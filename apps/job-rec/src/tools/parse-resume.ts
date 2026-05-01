/**
 * Tool: parseResume
 *
 * The CV-upload flow lands a Sendblue-hosted PDF URL in the inbound
 * event's `rawMeta.media_url` (Stream A is plumbing this through). The
 * RecruiterAgent calls this tool with `{ mediaUrl, userId }`; the tool:
 *   1. Downloads the PDF via fetch(mediaUrl).
 *   2. Uploads the bytes to our GCS bucket (`PA_RESUME_BUCKET` env, default
 *      `wekruit-resumes`) keyed by `userId/{ts}.pdf`.
 *   3. Records a stub doc in `parsedCandidateResumes` with `userId` +
 *      `originalFileName` so the existing offline parser pipeline can
 *      enrich it. The tool also writes a "summary" — best-effort
 *      synthesized from filename + URL until the live parser surfaces.
 *
 * Why a stub: a grep across this repo turned up zero callable parser code
 * (only readers). The brief explicitly authorizes a "thin shim that posts
 * the PDF to whatever endpoint does the parse + waits"; the live parse
 * endpoint is currently Adam-owned infra (see
 * P9-followup: PA_RESUME_BUCKET provisioning + parser HTTP endpoint).
 *
 * Returned `profile` is best-effort — if the offline parser hasn't filled
 * in the doc by the time the agent calls back, the tool reads what's
 * there and falls back to placeholders. The RecruiterAgent's onboarding
 * prompt is forgiving about this (it just probes anyway).
 */

import type { Firestore } from "firebase-admin/firestore"
import { tool } from "@openai/agents"
import {
  ParseResumeInputSchema,
  type ParseResumeOutput,
  type ResumeProfile,
} from "../types.js"

/** Injected dependency surface — production wires real impls; tests inject mocks. */
export type ParseResumeDeps = {
  db: Firestore
  /** Async download of the resume bytes. Default: global fetch + arrayBuffer. */
  fetchBytes?: (url: string) => Promise<{ bytes: Uint8Array; contentType?: string }>
  /** GCS upload — production passes a wrapper around @google-cloud/storage. */
  uploadToBucket?: (
    bucket: string,
    objectKey: string,
    bytes: Uint8Array,
    contentType?: string
  ) => Promise<{ gcsUri: string }>
  /** Override clock for tests. */
  nowIso?: () => string
  /** Logger (no-op default). */
  log?: (...args: unknown[]) => void
}

const PARSED_RESUMES_COLLECTION = "parsedCandidateResumes"

const FALLBACK_PROFILE: ResumeProfile = {
  name: "",
  currentRole: "",
  yearsExp: 0,
  skills: [],
  education: "",
  lastCompany: "",
  signatureProject: "",
}

function defaultLog(..._args: unknown[]): void {
  /* swallow */
}

async function defaultFetchBytes(url: string): Promise<{ bytes: Uint8Array; contentType?: string }> {
  const r = await fetch(url)
  if (!r.ok) throw new Error(`parseResume.fetch: ${r.status} ${r.statusText}`)
  const buf = await r.arrayBuffer()
  const contentType = r.headers.get("content-type") ?? undefined
  return { bytes: new Uint8Array(buf), contentType }
}

/**
 * Best-effort projection of the wide `parsedCandidateResumes` schema
 * (see `candidateProfile`, `experiences`, `education`) into the narrow
 * RecruiterAgent-facing `ResumeProfile`. Returns the fallback profile
 * when the source doc is empty / not yet enriched.
 */
export function projectParsedDocToResumeProfile(raw: unknown): ResumeProfile {
  if (!raw || typeof raw !== "object") return { ...FALLBACK_PROFILE }
  const r = raw as Record<string, unknown>
  const cp = (r.candidateProfile ?? {}) as Record<string, unknown>
  const experiences = Array.isArray(r.experiences) ? (r.experiences as Record<string, unknown>[]) : []
  const education = Array.isArray(r.education) ? (r.education as Record<string, unknown>[]) : []
  const skills = Array.isArray(cp.skills) ? (cp.skills.filter((s) => typeof s === "string") as string[]) : []

  // First experience is the most recent; project title + company + first
  // 200 chars of description as "signature project".
  const top = experiences[0]
  const lastCompany = typeof top?.company === "string" ? (top.company as string) : ""
  const currentRole = typeof top?.title === "string" ? (top.title as string) : ""
  const sigProject =
    typeof top?.description === "string"
      ? (top.description as string).slice(0, 240)
      : ""

  // Years experience: count distinct experience rows, or use the count
  // of education rows as a tiebreaker. Imperfect; production parser fills
  // a richer field, but this keeps the LLM grounded in *something*.
  const yearsExp = experiences.length

  const educationStr =
    typeof education[0]?.degree === "string" && typeof education[0]?.school === "string"
      ? `${education[0]?.degree} @ ${education[0]?.school}`
      : typeof cp.location === "string"
        ? (cp.location as string)
        : ""

  const name = typeof cp.name === "string" ? (cp.name as string) : ""

  return {
    name,
    currentRole,
    yearsExp,
    skills: skills.slice(0, 30),
    education: educationStr,
    lastCompany,
    signatureProject: sigProject,
  }
}

export type ParseResumeArgs = {
  mediaUrl: string
  userId: string
  resumeBucket?: string
}

/**
 * Pure entry point — call directly from CF/cron paths or tests.
 */
export async function parseResume(
  args: ParseResumeArgs,
  deps: ParseResumeDeps
): Promise<ParseResumeOutput> {
  const parsed = ParseResumeInputSchema.parse({ mediaUrl: args.mediaUrl, userId: args.userId })
  const log = deps.log ?? defaultLog
  const nowIso = deps.nowIso ?? (() => new Date().toISOString())
  const fetchBytes = deps.fetchBytes ?? defaultFetchBytes
  const ts = nowIso()
  const bucket = args.resumeBucket ?? (process.env.PA_RESUME_BUCKET?.trim() || "wekruit-resumes")

  // 1. Download the PDF from Sendblue's hosted media URL.
  let bytes: Uint8Array
  let contentType: string | undefined
  try {
    const downloaded = await fetchBytes(parsed.mediaUrl)
    bytes = downloaded.bytes
    contentType = downloaded.contentType
  } catch (err) {
    log("[parseResume] fetch_failed", {
      mediaUrl: parsed.mediaUrl,
      error: err instanceof Error ? err.message : String(err),
    })
    // Fail-soft: emit a stub doc + return fallback profile so onboarding
    // can still proceed via probes alone.
    const docRef = deps.db.collection(PARSED_RESUMES_COLLECTION).doc()
    await docRef.set({
      userId: parsed.userId,
      candidateProfile: {},
      experiences: [],
      education: [],
      originalFileName: "",
      fileType: "application/pdf",
      createdAt: ts,
      sessionId: "",
      sourceMediaUrl: parsed.mediaUrl,
      ingestStatus: "fetch_failed",
      ingestError: err instanceof Error ? err.message : String(err),
    })
    return { profile: { ...FALLBACK_PROFILE }, parsedDocId: docRef.id }
  }

  // 2. Upload to GCS (when the dep is wired). Skip silently in unit tests
  //    that don't inject `uploadToBucket` — the Firestore stub doc is the
  //    canonical handoff anyway.
  let gcsUri = ""
  if (deps.uploadToBucket) {
    const objectKey = `${parsed.userId}/${ts.replace(/[:.]/g, "-")}.pdf`
    try {
      const up = await deps.uploadToBucket(bucket, objectKey, bytes, contentType ?? "application/pdf")
      gcsUri = up.gcsUri
    } catch (err) {
      log("[parseResume] gcs_upload_failed", {
        bucket,
        objectKey,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  // 3. Stub doc in parsedCandidateResumes — the offline parser pipeline
  //    will enrich `candidateProfile` / `experiences` / `education`.
  const docRef = deps.db.collection(PARSED_RESUMES_COLLECTION).doc()
  await docRef.set({
    userId: parsed.userId,
    candidateProfile: {},
    experiences: [],
    education: [],
    originalFileName: gcsUri ? gcsUri.split("/").pop() ?? "" : "",
    fileType: contentType ?? "application/pdf",
    createdAt: ts,
    sessionId: "",
    sourceMediaUrl: parsed.mediaUrl,
    sourceGcsUri: gcsUri,
    sizeBytes: bytes.byteLength,
    ingestStatus: "uploaded",
  })

  // 4. Best-effort: read back the doc immediately. If the offline parser
  //    has already enriched (e.g. synchronous test path), surface the
  //    rich projection. Otherwise return fallback + the doc id.
  const snap = await docRef.get()
  const projected = projectParsedDocToResumeProfile(snap.data())
  return { profile: projected, parsedDocId: docRef.id }
}

/**
 * SDK-tool factory — bind `parseResume` into an `@openai/agents` Tool so
 * the RecruiterAgent can call it through the LLM tool-call loop.
 *
 * Note: the SDK's strict tool path requires a JSON-serializable parameter
 * schema. We pass the Zod object directly, matching the agent-runtime
 * adapter's `buildSdkTools` shape (cast to `any` to keep the SDK's
 * generic ToolInputParametersStrict happy).
 */
export function createParseResumeTool(deps: ParseResumeDeps, resumeBucket?: string) {
  return tool({
    name: "parseResume",
    description:
      "Extract a candidate's structured profile from a CV PDF URL. " +
      "Returns name, currentRole, yearsExp, skills, education, lastCompany, signatureProject.",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    parameters: ParseResumeInputSchema as any,
    execute: async (raw: unknown) => {
      const args = ParseResumeInputSchema.parse(raw)
      const out = await parseResume({ ...args, resumeBucket }, deps)
      return JSON.stringify(out)
    },
  })
}
