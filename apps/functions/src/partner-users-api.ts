/**
 * Public partner API — paPartnerUsersApi.
 *
 * Surface: GET https://wekruit.com/api/v1/partner/users
 * Auth: X-API-Key header. Keys shaped `key_<partnerSource>_<random>` —
 * the prefix is parsed to derive the `pa-users.source` filter, so each
 * key is scoped to exactly one partner's data.
 *
 * Spec: docs/superpowers/specs/2026-05-27-partner-users-api-design.md
 */
import { getApps, initializeApp } from "firebase-admin/app"
import { Timestamp, getFirestore, type Firestore, type Query } from "firebase-admin/firestore"
import { defineSecret } from "firebase-functions/params"
import { onRequest } from "firebase-functions/v2/https"
import { createHash } from "node:crypto"
import {
  CandidateJobStateSchema,
  PA_COLLECTIONS,
  isPaUserSource,
  type CandidateJobState,
  type PaUserSource,
} from "@pa/core-types"

if (!getApps().length) initializeApp()

// ---------------------------------------------------------------- secrets

/** CSV of partner-scoped API keys. Each `key_<source>_<random>`. */
const PA_PARTNER_USERS_API_KEYS = defineSecret("PA_PARTNER_USERS_API_KEYS")
/** Reused from paPublicOpenJobs — same browser origin allowlist applies. */
const PA_PUBLIC_COLLAB_ORIGINS = defineSecret("PA_PUBLIC_COLLAB_ORIGINS")

// ---------------------------------------------------------------- constants

const API_VERSION = "v1"
const DEFAULT_LIMIT = 50
const MAX_LIMIT = 200
const PER_USER_JOB_CAP = 50
const SNAPSHOT_TTL_MS = 60_000

// ---------------------------------------------------------------- types

interface AuthOk {
  ok: true
  partnerSource: PaUserSource
}

interface AuthFail {
  ok: false
  reason:
    | "missing_api_key"
    | "invalid_api_key"
    | "invalid_api_key_format"
    | "key_partner_mismatch"
    | "origin_not_allowed"
}

type AuthResult = AuthOk | AuthFail

// ---------------------------------------------------------------- auth

const PARTNER_KEY_RE = /^key_([a-z][a-z0-9_]+?)_[A-Za-z0-9]+$/

function constantTimeEqual(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!
  return diff === 0
}

export function verifyPartnerKey(
  apiKey: string | undefined,
  origin: string | undefined,
  keysCsv: string,
  originsCsv: string,
): AuthResult {
  if (!apiKey) return { ok: false, reason: "missing_api_key" }

  const match = PARTNER_KEY_RE.exec(apiKey)
  if (!match) return { ok: false, reason: "invalid_api_key_format" }
  const partnerSlug = match[1]!

  const keys = keysCsv.split(",").map((s) => s.trim()).filter((s) => s.length > 0)
  const apiKeyBuf = Buffer.from(apiKey)
  let matched = false
  for (const k of keys) {
    if (constantTimeEqual(apiKeyBuf, Buffer.from(k))) {
      matched = true
      break
    }
  }
  if (!matched) return { ok: false, reason: "invalid_api_key" }

  if (!isPaUserSource(partnerSlug)) return { ok: false, reason: "key_partner_mismatch" }
  const partnerSource = partnerSlug as PaUserSource

  const originsTrim = originsCsv.trim()
  if (originsTrim === "*" || originsTrim === "") return { ok: true, partnerSource }
  if (!origin) return { ok: true, partnerSource }
  const allowed = originsTrim.split(",").map((s) => s.trim()).filter((s) => s.length > 0)
  if (!allowed.includes(origin)) return { ok: false, reason: "origin_not_allowed" }
  return { ok: true, partnerSource }
}

// Internal test exports (do not call from production code).
export const __test_verifyPartnerKey = verifyPartnerKey
export const __test_PARTNER_KEY_RE = PARTNER_KEY_RE

// ---------------------------------------------------------------- handler

export const paPartnerUsersApi = onRequest(
  {
    region: "us-central1",
    memory: "512MiB",
    maxInstances: 10,
    secrets: [PA_PARTNER_USERS_API_KEYS, PA_PUBLIC_COLLAB_ORIGINS],
  },
  async (req, res) => {
    // CORS preflight — partners may call from a browser.
    res.setHeader("Access-Control-Allow-Origin", "*")
    res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS")
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-API-Key")
    res.setHeader("Access-Control-Max-Age", "3600")
    if (req.method === "OPTIONS") {
      res.status(204).end()
      return
    }
    if (req.method !== "GET") {
      res.status(405).json({ ok: false, reason: "method_not_allowed" })
      return
    }

    const apiKey = req.header("x-api-key") ?? undefined
    const origin = req.header("origin") ?? undefined
    const auth = verifyPartnerKey(
      apiKey,
      origin,
      PA_PARTNER_USERS_API_KEYS.value(),
      PA_PUBLIC_COLLAB_ORIGINS.value(),
    )
    if (!auth.ok) {
      const status = auth.reason === "origin_not_allowed" || auth.reason === "key_partner_mismatch" ? 403 : 401
      const fp = apiKey ? createHash("sha256").update(apiKey).digest("hex").slice(0, 8) : "absent"
      console.warn(`paPartnerUsersApi auth_fail reason=${auth.reason} key_fp=${fp} origin=${origin ?? "absent"}`)
      res.status(status).json({ ok: false, reason: auth.reason })
      return
    }

    // Query layer + response shaping land in Task 3 + Task 4.
    res.status(501).json({ ok: false, reason: "not_implemented" })
  },
)
