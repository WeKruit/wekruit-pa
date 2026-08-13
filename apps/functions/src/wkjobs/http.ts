/**
 * `paWkJobsApi` — the backend the `wkjobs` CLI talks to.
 *
 * Routes (all JSON, all under /v1 so the CLI's `apiBase` is the function URL):
 *   POST /v1/device/code    → start a device authorization
 *   POST /v1/device/token   → poll it; returns an opaque wkjobs bearer token
 *   POST /v1/device/approve → browser-side approval (Firebase ID token)
 *   GET  /v1/me             → the candidate behind a wkjobs token
 *
 * Identity is never taken from the client. `/v1/device/approve` derives the
 * candidate from the caller's verified Firebase session via the existing
 * `pa-candidate-auth` mapping — the same seam the website login writes — so the
 * CLI can neither name a candidate nor smuggle one through the browser.
 *
 * This function is strictly additive: it reads `pa-candidate-auth` and
 * `pa-users`, and writes only to its own `pa-wkjobs-*` collections.
 */
import { getAuth } from "firebase-admin/auth"
import { getFirestore, type Firestore } from "firebase-admin/firestore"
import { defineString } from "firebase-functions/params"
import { logger } from "firebase-functions/v2"
import { onRequest } from "firebase-functions/v2/https"
import { PA_COLLECTIONS } from "@pa/core-types"
import { checkAndIncrementRateLimit } from "@pa/pa-persistence"
import {
  consumeApprovedDevice,
  createDevice,
  decideDevice,
  mintToken,
  recordConsent,
  resolveToken,
  WKJOBS_CONSENT_VERSION,
} from "./store.js"

/**
 * Where the human approves the device. Parameterized rather than hardcoded so
 * moving the approval page (or pointing it at a staging host) is a config
 * change, not a redeploy of new code.
 */
const WKJOBS_VERIFICATION_URL = defineString("WKJOBS_VERIFICATION_URL", {
  default: "https://wekruit.com/wkjobs",
})

/** Browser origins allowed to call /v1/device/approve. */
const APPROVE_ALLOWED_ORIGINS = new Set([
  "https://wekruit.com",
  "https://www.wekruit.com",
  "https://candidate.wekruit.com",
  "https://pa.wekruit.com",
])

interface Json {
  [key: string]: unknown
}

function clientIp(req: { headers: Record<string, unknown>; ip?: string }): string {
  const forwarded = req.headers["x-forwarded-for"]
  const first = typeof forwarded === "string" ? forwarded.split(",")[0]?.trim() : undefined
  return first || req.ip || "unknown"
}

function maskEmail(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  const email = value.trim().toLowerCase()
  const [local, domain] = email.split("@")
  if (!local || !domain) return undefined
  return `${local[0]}***@${domain}`
}

function resumeStatusOf(user: Json): "none" | "processing" | "parsed" | "failed" {
  const raw = user.resumeStatus
  if (raw === "parsed" || raw === "processing" || raw === "failed") return raw
  return user.latestResumeArtifactId ? "parsed" : "none"
}

async function candidateIdForIdToken(db: Firestore, idToken: string): Promise<string | null> {
  const decoded = await getAuth().verifyIdToken(idToken, true)
  const snap = await db.collection(PA_COLLECTIONS.candidateAuth).doc(decoded.uid).get()
  const candidateId = snap.data()?.candidateId
  return typeof candidateId === "string" && candidateId.trim() ? candidateId.trim() : null
}

export const paWkJobsApi = onRequest(
  { region: "us-central1", memory: "256MiB", timeoutSeconds: 30, cors: false },
  async (req, res) => {
    res.set("Cache-Control", "no-store")

    const origin = typeof req.headers.origin === "string" ? req.headers.origin : ""
    if (origin && APPROVE_ALLOWED_ORIGINS.has(origin)) {
      res.set("Access-Control-Allow-Origin", origin)
      res.set("Vary", "Origin")
      res.set("Access-Control-Allow-Headers", "authorization, content-type")
      res.set("Access-Control-Allow-Methods", "POST, OPTIONS")
    }
    if (req.method === "OPTIONS") {
      res.status(204).send("")
      return
    }

    // Firebase strips the function name from the path, so `/v1/device/code`
    // arrives as-is regardless of whether it was reached by function URL or
    // hosting rewrite.
    const path = (req.path || "/").replace(/\/+$/, "") || "/"
    const db = getFirestore()

    try {
      if (req.method === "POST" && path === "/v1/device/code") {
        await handleDeviceCode(db, req, res)
        return
      }
      if (req.method === "POST" && path === "/v1/device/token") {
        await handleDeviceToken(db, req, res)
        return
      }
      if (req.method === "POST" && path === "/v1/device/approve") {
        await handleDeviceApprove(db, req, res)
        return
      }
      if (req.method === "GET" && path === "/v1/me") {
        await handleMe(db, req, res)
        return
      }
      res.status(404).json({ reason: "not_found" })
    } catch (err) {
      logger.error("[paWkJobsApi] request failed", {
        path,
        method: req.method,
        error: err instanceof Error ? err.message : String(err),
      })
      res.status(500).json({ reason: "internal_error" })
    }
  },
)

async function handleDeviceCode(
  db: Firestore,
  req: { body: unknown; headers: Record<string, unknown>; ip?: string },
  res: { status: (n: number) => { json: (b: Json) => void } },
): Promise<void> {
  const body = (req.body ?? {}) as Json
  const client = typeof body.client === "string" ? body.client.slice(0, 64) : ""
  const provider = typeof body.provider === "string" ? body.provider.slice(0, 32) : ""
  if (client !== "wkjobs-cli" || provider !== "linkedin") {
    res.status(400).json({ reason: "unsupported_client" })
    return
  }

  const limit = await checkAndIncrementRateLimit(db, `wkjobs_code_${clientIp(req)}`, {
    limit: 10,
    windowSec: 300,
  })
  if (!limit.allowed) {
    res.status(429).json({ reason: "rate_limited" })
    return
  }

  const created = await createDevice(db, { client, provider })
  const verificationUrl = WKJOBS_VERIFICATION_URL.value()
  res.status(200).json({
    device_code: created.deviceCode,
    user_code: created.userCode,
    verification_url: verificationUrl,
    verification_url_complete: `${verificationUrl}?user_code=${encodeURIComponent(created.userCode)}`,
    interval: created.intervalSec,
    expires_in: created.expiresInSec,
  })
}

async function handleDeviceToken(
  db: Firestore,
  req: { body: unknown },
  res: { status: (n: number) => { json: (b: Json) => void } },
): Promise<void> {
  const body = (req.body ?? {}) as Json
  const deviceCode = typeof body.device_code === "string" ? body.device_code : ""
  if (!deviceCode) {
    res.status(400).json({ reason: "missing_device_code" })
    return
  }

  const outcome = await consumeApprovedDevice(db, deviceCode)
  if (outcome.status === "slow_down") {
    res.status(200).json({ status: "slow_down", interval: outcome.intervalSec })
    return
  }
  if (outcome.status !== "approved") {
    res.status(200).json({ status: outcome.status })
    return
  }

  const accessToken = await mintToken(db, { candidateId: outcome.candidateId })
  res.status(200).json({
    status: "authorized",
    access_token: accessToken,
    token_type: "Bearer",
    candidate_id: outcome.candidateId,
    provider: "linkedin",
  })
}

async function handleDeviceApprove(
  db: Firestore,
  req: { body: unknown; headers: Record<string, unknown> },
  res: { status: (n: number) => { json: (b: Json) => void } },
): Promise<void> {
  const authorization = typeof req.headers.authorization === "string" ? req.headers.authorization : ""
  const idToken = authorization.startsWith("Bearer ") ? authorization.slice(7).trim() : ""
  if (!idToken) {
    res.status(401).json({ reason: "sign_in_required" })
    return
  }

  let candidateId: string | null
  try {
    candidateId = await candidateIdForIdToken(db, idToken)
  } catch {
    res.status(401).json({ reason: "sign_in_required" })
    return
  }
  if (!candidateId) {
    // Signed in, but the LinkedIn candidate claim never completed.
    res.status(403).json({ reason: "no_candidate_profile" })
    return
  }

  const body = (req.body ?? {}) as Json
  const userCode = typeof body.user_code === "string" ? body.user_code : ""
  const approve = body.approve !== false

  // Consent gates approval only. Declining needs no agreement — refusing to
  // connect must never require accepting terms first.
  if (approve && body.consent_version !== WKJOBS_CONSENT_VERSION) {
    res.status(400).json({ reason: "consent_required", consent_version: WKJOBS_CONSENT_VERSION })
    return
  }

  const result = await decideDevice(db, { userCode, candidateId, approve })
  if (!result.ok) {
    res.status(result.reason === "unknown_code" ? 404 : 409).json({ reason: result.reason })
    return
  }

  // Recorded after the decision sticks, so a failed approval never leaves a
  // consent record for a connection that did not happen.
  if (approve) {
    await recordConsent(db, { candidateId, version: WKJOBS_CONSENT_VERSION })
  }
  res.status(200).json({ ok: true, approved: approve })
}

async function handleMe(
  db: Firestore,
  req: { headers: Record<string, unknown> },
  res: { status: (n: number) => { json: (b: Json) => void } },
): Promise<void> {
  const authorization = typeof req.headers.authorization === "string" ? req.headers.authorization : ""
  const token = authorization.startsWith("Bearer ") ? authorization.slice(7).trim() : ""
  if (!token) {
    res.status(401).json({ reason: "unauthorized" })
    return
  }

  const record = await resolveToken(db, token)
  if (!record) {
    res.status(401).json({ reason: "unauthorized" })
    return
  }

  const snap = await db.collection(PA_COLLECTIONS.users).doc(record.candidateId).get()
  const user = (snap.data() ?? {}) as Json
  const displayName =
    (typeof user.name === "string" && user.name) ||
    (typeof user.linkedinOauthName === "string" && user.linkedinOauthName) ||
    undefined

  res.status(200).json({
    candidate_id: record.candidateId,
    provider: "linkedin",
    ...(displayName ? { display_name: displayName.slice(0, 200) } : {}),
    ...(maskEmail(user.email) ? { email_masked: maskEmail(user.email) } : {}),
    linkedin_connected: user.linkedinOauthLinked === true,
    resume_status: resumeStatusOf(user),
    ...(typeof user.source === "string" ? { source: user.source.slice(0, 80) } : {}),
  })
}
