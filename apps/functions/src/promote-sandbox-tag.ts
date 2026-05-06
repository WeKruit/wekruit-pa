/**
 * v1.6 Phase 59 — `paPromoteSandboxTag` admin-only callable.
 *
 * Adam-locked decisions (CLAUDE.md v1.6 design lock):
 *  - D16: industry vocab is **add-able by admin** via dashboard. Sandbox
 *    `proposedTags` (open) → review → admin promote-to-canonical. Firestore
 *    `pa-canonical-tags` overlay.
 *  - D5: NO abbreviations — `validateCanonicalToken` rejects.
 *
 * Endpoint shape (matches DASH-02):
 *
 *   Input  { vocab: 'industry-sector', token: string, action: 'promote' | 'reject' }
 *   Output { ok: true, token, status }   on success
 *   Throws HttpsError("invalid-argument" | "permission-denied" | ...) otherwise
 *
 * Auth: Firebase Auth custom claim `admin: true` OR `data.adminToken` matches
 * `PA_ADMIN_TOKEN` (mirrors `paBackfillMatchingJobsAtsUrl` convention).
 *
 * Side effects per call:
 *  - Upserts `pa-canonical-tags/{vocab}__{token}` overlay doc (`status` set
 *    to `promoted` | `rejected`, `promotedAt` | `rejectedAt`, actorUid).
 *  - Appends one audit row to `pa-canonical-tags-audit`.
 *
 * Architecture: handler logic lives in `runPromoteSandboxTag` (pure,
 * deps-injected) so unit tests can drive it without booting firebase-admin.
 * The onCall wrapper at the bottom is a thin shim that wires production deps.
 */
import { onCall, HttpsError } from "firebase-functions/v2/https"
import { defineSecret } from "firebase-functions/params"
import { logger } from "firebase-functions/v2"
import { getFirestore } from "firebase-admin/firestore"
import { z } from "zod"
import {
  validateCanonicalToken,
  INDUSTRY_SECTOR_VOCAB,
  CANONICAL_OVERLAY_COLLECTION,
  overlayDocId,
  type OverlaySupportedVocab,
} from "@wekruit/shared-tags"

// PA_ADMIN_TOKEN — same secret already used by paAdminBootstrap +
// paBackfillMatchingJobsAtsUrl. Lets scripted invocations pass the token
// via `data.adminToken` as a fallback to the Firebase Auth admin claim.
const PA_ADMIN_TOKEN = defineSecret("PA_ADMIN_TOKEN")

const AUDIT_COLLECTION = "pa-canonical-tags-audit"

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export const PromoteSandboxTagInputSchema = z.object({
  vocab: z.literal("industry-sector"), // only industrySector add-able per D16
  token: z.string().min(2).max(64),
  action: z.enum(["promote", "reject"]),
  /** Optional admin-token fallback for non-Firebase-Auth scripted callers. */
  adminToken: z.string().optional(),
})
export type PromoteSandboxTagInput = z.infer<typeof PromoteSandboxTagInputSchema>

export type PromoteSandboxTagResult =
  | { ok: true; token: string; status: "promoted" | "rejected" | "already_canonical" }

// ---------------------------------------------------------------------------
// Pure handler — testable without firebase-admin boot
// ---------------------------------------------------------------------------

export interface PromoteSandboxTagDeps {
  /** Upsert overlay doc at `pa-canonical-tags/{vocab}__{token}`. */
  setOverlayDoc: (docId: string, data: Record<string, unknown>) => Promise<void>
  /** Append one audit row. */
  addAuditEvent: (data: Record<string, unknown>) => Promise<void>
  /** ISO timestamp factory (injectable for tests). */
  now: () => string
  /** Test-overridable static vocab so we can simulate `already_canonical`. */
  staticVocab?: readonly string[]
  log?: (...args: unknown[]) => void
}

export async function runPromoteSandboxTag(
  input: PromoteSandboxTagInput,
  actorUid: string,
  deps: PromoteSandboxTagDeps,
): Promise<PromoteSandboxTagResult> {
  const { vocab, token, action } = input

  // Token format gate — reject abbreviations + non-canonical chars.
  const validation = validateCanonicalToken(token, vocab)
  if (!validation.ok) {
    throw new HttpsError("invalid-argument", validation.reason ?? "invalid token")
  }

  const staticVocab = deps.staticVocab ?? INDUSTRY_SECTOR_VOCAB
  const docId = overlayDocId(vocab as OverlaySupportedVocab, token)
  const now = deps.now()

  if (action === "promote") {
    // Idempotent: already-canonical tokens skip the write.
    if ((staticVocab as readonly string[]).includes(token)) {
      deps.log?.("pa.canonical_tags.skip_already_canonical", { vocab, token, by: actorUid })
      return { ok: true, token, status: "already_canonical" }
    }
    await deps.setOverlayDoc(docId, {
      vocab,
      token,
      status: "promoted",
      promotedAt: now,
      promotedBy: actorUid,
    })
    await deps.addAuditEvent({
      eventType: "promote",
      vocab,
      token,
      actorUid,
      timestamp: now,
    })
    deps.log?.("pa.canonical_tags.promoted", { vocab, token, by: actorUid })
    return { ok: true, token, status: "promoted" }
  }

  // action === "reject"
  await deps.setOverlayDoc(docId, {
    vocab,
    token,
    status: "rejected",
    rejectedAt: now,
    rejectedBy: actorUid,
  })
  await deps.addAuditEvent({
    eventType: "reject",
    vocab,
    token,
    actorUid,
    timestamp: now,
  })
  deps.log?.("pa.canonical_tags.rejected", { vocab, token, by: actorUid })
  return { ok: true, token, status: "rejected" }
}

// ---------------------------------------------------------------------------
// Admin auth gate (Firebase Auth custom claim OR PA_ADMIN_TOKEN fallback)
// ---------------------------------------------------------------------------

export function authorizeAdminCallable(req: {
  auth?: { token?: { admin?: unknown } }
  data?: unknown
}): { uid: string } {
  const claim = req.auth?.token?.admin
  const uid = (req as { auth?: { uid?: string } }).auth?.uid ?? ""
  if (claim === true || claim === "true") {
    return { uid: uid || "admin-claim" }
  }

  const dataObj =
    req.data && typeof req.data === "object" ? (req.data as Record<string, unknown>) : {}
  const provided = typeof dataObj.adminToken === "string" ? dataObj.adminToken.trim() : ""
  const expected = (process.env.PA_ADMIN_TOKEN ?? "").trim()
  if (expected && provided && provided === expected) {
    return { uid: uid || "admin-token" }
  }

  throw new HttpsError("permission-denied", "admin only")
}

// ---------------------------------------------------------------------------
// Production CF — thin shim over runPromoteSandboxTag.
// ---------------------------------------------------------------------------

export const paPromoteSandboxTag = onCall(
  {
    region: "us-central1",
    memory: "256MiB",
    secrets: [PA_ADMIN_TOKEN],
  },
  async (req): Promise<PromoteSandboxTagResult> => {
    const { uid } = authorizeAdminCallable(
      req as { auth?: { token?: { admin?: unknown } }; data?: unknown },
    )
    const parsed = PromoteSandboxTagInputSchema.safeParse(req.data)
    if (!parsed.success) {
      throw new HttpsError("invalid-argument", parsed.error.message)
    }

    const db = getFirestore()
    return runPromoteSandboxTag(parsed.data, uid, {
      setOverlayDoc: async (docId, data) => {
        await db.collection(CANONICAL_OVERLAY_COLLECTION).doc(docId).set(data, { merge: true })
      },
      addAuditEvent: async (data) => {
        await db.collection(AUDIT_COLLECTION).add(data)
      },
      now: () => new Date().toISOString(),
      log: (...args) => logger.info("[promote-sandbox-tag]", ...args),
    })
  },
)
