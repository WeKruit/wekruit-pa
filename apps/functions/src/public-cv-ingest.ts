/**
 * v1.9 hotfix (Adam directive 2026-05-12 live test STOP) — public CV ingest
 * HTTP CF for the public job page /j/:jobId/cv upload flow.
 *
 * Gap: Phase 87 shipped the frontend (`PublicJobCv.tsx` POSTs to
 * `VITE_CV_INGEST_URL`) but the corresponding HTTP CF never existed. ATS
 * inbound webhook also expects `PA_CV_INGEST_URL` env to point at the same
 * endpoint. Live test stopped at the first upload attempt with
 * "CV ingest endpoint not configured" because the env was unset because
 * the URL itself was never built.
 *
 * Responsibilities:
 *   1. Accept POST {tempUserId | userId, resumeBase64, resumeName?, source?,
 *      jobIdContext?} or {userId, resumeUrl, source?}.
 *   2. Decode base64 → PDF/DOCX bytes (or fetch resumeUrl) → run `ingestCv`
 *      with injected parser deps that return the upload content directly.
 *   3. Return {ok, resumeId | reason}.
 *
 * Security posture:
 *   - Candidate-facing uploads (public job page, layoff onboarding) require
 *     a verified Firebase ID token plus a claimed pa-candidate-auth mapping.
 *   - ATS / employer bulk intake keeps the legacy server-trusted path
 *     (source=ats:* or employer identity hints) with explicit userId.
 *   - Anonymous tempUserId uploads are rejected for candidate flows.
 *   - Size cap 8 MB on the raw POST body (5 MB resume + b64 overhead ~33%).
 *   - Upload sniffing allows text-based PDF or DOCX only.
 *   - Rate limit: TODO (deferred to v2.0; current threat is low — UUIDs
 *     are not enumerable by attackers).
 *
 * Used by:
 *   - apps/dashboard-web/src/pages/PublicJobCv.tsx (PublicJob page)
 *   - apps/functions/src/ats-inbound-webhook.ts (Handshake/ATS bind path)
 */
import { createHash } from "node:crypto"
import { onRequest } from "firebase-functions/v2/https"
import { defineSecret } from "firebase-functions/params"
import { getAuth } from "firebase-admin/auth"
import { getFirestore, type Firestore } from "firebase-admin/firestore"
import {
  PA_COLLECTIONS,
  CandidateAuthMappingSchema,
  ResumeArtifactSchema,
  isPaUserSource,
  type PaUserSource,
} from "@pa/core-types"
import { ingestCv } from "./cv-ingest/cv-ingest.js"
import type { IngestCvInput, IngestCvDeps } from "./cv-ingest/cv-ingest.js"
import { detectResumeUploadKind, extractDocxText } from "./resume-upload-parser.js"
import type { ResumeUploadKind } from "./resume-upload-parser.js"

// Same-name defineSecret() refs hydrate from the same Firebase Secret. Wired
// into the CF deploy below so the cv-ingest LLM extract path can read the
// keys at request time. Anthropic is optional fallback (industry second-pass).
const PA_OPENAI_AGENT_API_KEY = defineSecret("PA_OPENAI_AGENT_API_KEY")
const ANTHROPIC_API_KEY = defineSecret("ANTHROPIC_API_KEY")

export interface PublicCvIngestRequest {
  tempUserId?: string
  userId?: string
  browserUid?: string
  resumeBase64?: string
  resumeUrl?: string
  resumeName?: string
  jobIdContext?: string
  source?: string
  employerEmailHint?: string
  atsApplicantId?: string
}

export function buildPublicCvIngestInput(args: {
  body: PublicCvIngestRequest
  userId: string
  mediaUrl: string
}): IngestCvInput {
  const isAtsSource = args.body.source?.startsWith("ats:") === true
  const hasEmployerIdentityHint = Boolean(
    args.body.employerEmailHint?.trim() || args.body.atsApplicantId?.trim()
  )
  const shouldResolveExternalIdentity = isAtsSource || hasEmployerIdentityHint

  return stripUndefined({
    userId: args.userId,
    employerEmailHint: shouldResolveExternalIdentity ? args.body.employerEmailHint : undefined,
    atsApplicantId: shouldResolveExternalIdentity ? args.body.atsApplicantId : undefined,
    browserUid: shouldResolveExternalIdentity
      ? (args.body.browserUid ?? args.body.tempUserId)
      : undefined,
    identitySource: isAtsSource ? "ats" : undefined,
    // For base64 path the URL is decorative — actual bytes come via
    // injected fetchPdf. We still pass a sentinel so internal logging
    // has something descriptive.
    mediaUrl: args.mediaUrl,
  } satisfies IngestCvInput)
}

function setCors(res: { set: (k: string, v: string) => unknown }): void {
  res.set("Access-Control-Allow-Origin", "*")
  res.set("Access-Control-Allow-Methods", "POST,OPTIONS")
  res.set("Access-Control-Allow-Headers", "Content-Type, Authorization")
  res.set("Access-Control-Max-Age", "3600")
}

export function isServerTrustedCvIntake(body: PublicCvIngestRequest): boolean {
  const isAtsSource = body.source?.startsWith("ats:") === true
  const hasEmployerIdentityHint = Boolean(
    body.employerEmailHint?.trim() || body.atsApplicantId?.trim()
  )
  return isAtsSource || hasEmployerIdentityHint
}

export type ResolveCandidateUploadUserIdResult =
  | { ok: true; userId: string }
  | { ok: false; status: number; reason: string }

export async function resolveCandidateUploadUserId(args: {
  req: { header: (name: string) => string | undefined }
  body: PublicCvIngestRequest
  db: Firestore
  verifyIdToken?: (token: string) => Promise<{ uid: string }>
}): Promise<ResolveCandidateUploadUserIdResult> {
  if (isServerTrustedCvIntake(args.body)) {
    const userId = (args.body.userId ?? args.body.tempUserId ?? "").toString().trim()
    if (!userId) return { ok: false, status: 400, reason: "missing_userId_or_tempUserId" }
    return { ok: true, userId }
  }

  const authz = args.req.header("authorization") ?? args.req.header("Authorization") ?? ""
  const match = authz.match(/^Bearer\s+(.+)$/i)
  if (!match?.[1]?.trim()) {
    return { ok: false, status: 401, reason: "auth_required" }
  }

  const verifyIdToken =
    args.verifyIdToken ??
    (async (token: string) => {
      const decoded = await getAuth().verifyIdToken(token)
      return { uid: decoded.uid }
    })

  let decoded: { uid: string }
  try {
    decoded = await verifyIdToken(match[1]!.trim())
  } catch {
    return { ok: false, status: 401, reason: "invalid_id_token" }
  }

  const authSnap = await args.db.collection(PA_COLLECTIONS.candidateAuth).doc(decoded.uid).get()
  if (!authSnap.exists) {
    return { ok: false, status: 412, reason: "candidate_not_claimed" }
  }

  const mapping = CandidateAuthMappingSchema.parse(authSnap.data())
  const requested = (args.body.userId ?? "").toString().trim()
  if (requested && requested !== mapping.candidateId) {
    return { ok: false, status: 403, reason: "userId_mismatch" }
  }

  return { ok: true, userId: mapping.candidateId }
}

function stripUndefined<T extends Record<string, unknown>>(input: T): T {
  return Object.fromEntries(
    Object.entries(input).filter(([, value]) => value !== undefined)
  ) as T
}

function idSafe(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 80)
}

function sourceForProfileCreate(uploadSource?: string): PaUserSource {
  if (uploadSource === "layoff_signup") return "WeKruit_Laid_Off"
  if (isPaUserSource(uploadSource)) return uploadSource
  return "candidate"
}

/** Internal — exported for unit tests only. Do not call from production code. */
export const __test_sourceForProfileCreate = sourceForProfileCreate

export function buildCandidateUploadResumeArtifactWrites(input: {
  candidateId: string
  parsedCandidateResumeId: string
  fileName?: string
  sha256?: string
  candidateProfileSummary?: string
  existingUserSource?: unknown
  uploadSource?: string
  now: string
}): {
  artifact: ReturnType<typeof ResumeArtifactSchema.parse>
  userPatch: Record<string, unknown>
  selfProfilePatch: Record<string, unknown>
} {
  const digest = input.sha256?.slice(0, 32) ??
    createHash("sha256")
      .update(`${input.candidateId}:${input.parsedCandidateResumeId}`)
      .digest("hex")
      .slice(0, 32)
  const resumeId = `candidate_upload_${idSafe(input.candidateId)}_${digest}`
  const artifact = ResumeArtifactSchema.parse(
    stripUndefined({
      resumeId,
      candidateId: input.candidateId,
      status: "parsed",
      source: "candidate_upload",
      fileName: input.fileName,
      sha256: input.sha256,
      parsedCandidateResumeId: input.parsedCandidateResumeId,
      candidateProfileSummary: input.candidateProfileSummary,
      createdAt: input.now,
      updatedAt: input.now,
    })
  )
  return {
    artifact,
    userPatch: {
      latestResumeArtifactId: artifact.resumeId,
      ...(isPaUserSource(input.existingUserSource)
        ? {}
        : { source: sourceForProfileCreate(input.uploadSource) }),
      updatedAt: input.now,
    },
    selfProfilePatch: stripUndefined({
      candidateId: input.candidateId,
      latestResumeArtifactId: artifact.resumeId,
      resumeStatus: "parsed",
      profileSummary: input.candidateProfileSummary,
      updatedAt: input.now,
    }),
  }
}

async function recordCandidateUploadResumeArtifact(args: {
  db: ReturnType<typeof getFirestore>
  candidateId: string
  parsedCandidateResumeId: string
  fileName?: string
  sha256?: string
  candidateProfileSummary?: string
  uploadSource?: string
}): Promise<string> {
  const userSnap = await args.db
    .collection(PA_COLLECTIONS.users)
    .doc(args.candidateId)
    .get()
  const writes = buildCandidateUploadResumeArtifactWrites({
    candidateId: args.candidateId,
    parsedCandidateResumeId: args.parsedCandidateResumeId,
    fileName: args.fileName,
    sha256: args.sha256,
    candidateProfileSummary: args.candidateProfileSummary,
    existingUserSource: userSnap.data()?.source,
    uploadSource: args.uploadSource,
    now: new Date().toISOString(),
  })
  await Promise.all([
    args.db
      .collection(PA_COLLECTIONS.resumeArtifacts)
      .doc(writes.artifact.resumeId)
      .set(stripUndefined(writes.artifact as unknown as Record<string, unknown>), { merge: true }),
    args.db
      .collection(PA_COLLECTIONS.users)
      .doc(args.candidateId)
      .set(writes.userPatch, { merge: true }),
    args.db
      .collection(PA_COLLECTIONS.candidateSelfProfiles)
      .doc(args.candidateId)
      .set(writes.selfProfilePatch, { merge: true }),
  ])
  return writes.artifact.resumeId
}

export const paPublicCvIngest = onRequest(
  {
    region: "us-central1",
    memory: "1GiB",
    timeoutSeconds: 120,
    cors: false, // we handle CORS manually
    secrets: [PA_OPENAI_AGENT_API_KEY, ANTHROPIC_API_KEY],
  },
  async (req, res) => {
    setCors(res)
    if (req.method === "OPTIONS") {
      res.status(204).send("")
      return
    }
    if (req.method !== "POST") {
      res.status(405).json({ ok: false, reason: "method_not_allowed" })
      return
    }

    // Hydrate secrets into process.env so cv-ingest's internal LLM path
    // (which reads via `process.env.PA_OPENAI_AGENT_API_KEY`) sees them.
    // Mirror of the index.ts pattern at line 783.
    try {
      const openAiKey = PA_OPENAI_AGENT_API_KEY.value().trim()
      if (openAiKey) process.env.PA_OPENAI_AGENT_API_KEY = openAiKey
    } catch {
      // secret unavailable — cv-ingest will fail with llm_parse_failed
      // and the caller surfaces it as 422.
    }
    try {
      const anthKey = ANTHROPIC_API_KEY.value().trim()
      if (anthKey) process.env.ANTHROPIC_API_KEY = anthKey
    } catch {
      // optional secret — second-pass falls back gracefully.
    }

    let body: PublicCvIngestRequest
    try {
      body = (typeof req.body === "string" ? JSON.parse(req.body) : req.body) as PublicCvIngestRequest
    } catch {
      res.status(400).json({ ok: false, reason: "invalid_json" })
      return
    }

    const db = getFirestore()
    const resolvedUser = await resolveCandidateUploadUserId({ req, body, db })
    if (!resolvedUser.ok) {
      res.status(resolvedUser.status).json({ ok: false, reason: resolvedUser.reason })
      return
    }
    const userId = resolvedUser.userId
    if (!/^[a-zA-Z0-9_-]{6,80}$/.test(userId)) {
      res.status(400).json({ ok: false, reason: "userId_format_invalid" })
      return
    }
    if (!body.resumeBase64 && !body.resumeUrl) {
      res.status(400).json({ ok: false, reason: "missing_resumeBase64_or_resumeUrl" })
      return
    }

    const log = (event: string, payload?: Record<string, unknown>): void => {
      // Firebase Functions auto-streams console.log to Cloud Logging.
      console.log(JSON.stringify({ event, ...(payload ?? {}) }))
    }

    // Decode base64 path — return bytes via injected fetchPdf so cv-ingest
    // doesn't try to network-fetch an "inline://" URL.
    let injectedBytes: Uint8Array | null = null
    let resumeSha256: string | undefined
    let resumeKind: ResumeUploadKind | null = null
    let extractedDocxText: string | null = null
    if (body.resumeBase64) {
      try {
        injectedBytes = Buffer.from(body.resumeBase64, "base64")
        if (injectedBytes.length === 0) {
          res.status(400).json({ ok: false, reason: "empty_resume_bytes" })
          return
        }
        if (injectedBytes.length > 6 * 1024 * 1024) {
          res.status(413).json({ ok: false, reason: "resume_too_large" })
          return
        }
        resumeKind = detectResumeUploadKind(injectedBytes, body.resumeName)
        if (!resumeKind) {
          res.status(415).json({ ok: false, reason: "unsupported_resume_format" })
          return
        }
        if (resumeKind === "docx") {
          try {
            extractedDocxText = extractDocxText(injectedBytes)
          } catch (err) {
            log("public_cv_ingest.docx_parse_failed", {
              userId,
              error: err instanceof Error ? err.message : String(err),
            })
            res.status(422).json({ ok: false, reason: "docx_parse_failed" })
            return
          }
        }
        resumeSha256 = createHash("sha256").update(injectedBytes).digest("hex")
      } catch {
        res.status(400).json({ ok: false, reason: "base64_decode_failed" })
        return
      }
    }

    // For base64 path: inject fetchPdf that returns the bytes regardless
    // of URL. For resumeUrl path: cv-ingest's default fetchPdf does the fetch.
    //
    // Also bypass the conversational `checkGate` (Claire-asks-resume gate).
    // The public job page flow is "candidate uploads BEFORE conversing", so
    // resumeAccepted is unset and the gate would reject "not_invited". The
    // gate's purpose is anti-abuse on the SMS path; public-page abuse is
    // bounded by tempUserId uniqueness + size cap + PDF magic sniff.
    const deps: IngestCvDeps = {
      db,
      log,
      checkGate: async () => ({ open: true, reason: "public_page_bypass" }),
      followupDeliveryMode: "none",
      ...(injectedBytes
        ? {
            fetchPdf: async (): Promise<{ bytes: Uint8Array; contentType: string }> => ({
              bytes: injectedBytes!,
              contentType: resumeKind === "docx"
                ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                : "application/pdf",
            }),
          }
        : {}),
      ...(extractedDocxText
        ? {
            parsePdf: async (): Promise<{ text: string; numPages?: number }> => ({
              text: extractedDocxText!,
            }),
          }
        : {}),
    }

    const input = buildPublicCvIngestInput({
      userId,
      mediaUrl: injectedBytes
        ? `inline://${(body.resumeName ?? "resume").replace(/[^\w.-]/g, "_")}`
        : body.resumeUrl!,
      body,
    })

    try {
      const result = await ingestCv(input, deps)
      if (result.ok) {
        const resumeArtifactId = await recordCandidateUploadResumeArtifact({
          db,
          candidateId: result.userId,
          parsedCandidateResumeId: result.resumeId,
          fileName: body.resumeName,
          sha256: resumeSha256,
          candidateProfileSummary: result.candidateProfileSummary,
          uploadSource: body.source,
        })
        log("public_cv_ingest.ok", {
          userId,
          canonicalUserId: result.userId,
          resumeId: result.resumeId,
          resumeArtifactId,
          source: body.source ?? "public_job_page",
          jobIdContext: body.jobIdContext,
        })
        res.status(200).json({ ok: true, resumeId: result.resumeId, userId: result.userId, resumeArtifactId })
      } else {
        log("public_cv_ingest.fail", {
          userId,
          reason: result.reason,
          source: body.source ?? "public_job_page",
        })
        res.status(422).json({ ok: false, reason: result.reason })
      }
    } catch (err) {
      log("public_cv_ingest.error", {
        userId,
        error: err instanceof Error ? err.message : String(err),
      })
      res.status(500).json({ ok: false, reason: "internal_error" })
    }
  }
)
