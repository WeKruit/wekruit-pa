/**
 * paAdminDeleteUser — admin-only callable that COMPLETELY removes a candidate
 * from Firestore (true blank slate for testing). This is FAR more destructive
 * than COLD reinit (`.ops/reinit-user-cold.mjs` / `paReinitializeCandidate`,
 * which RESET fields): this HARD-DELETES the `pa-users/{uid}` doc itself plus
 * every per-user / identity-index doc keyed by or referencing the uid, and
 * wipes the user's mem0/Qdrant memory partition. Irreversible.
 *
 * Auth: HARD-gated server-side on the caller's Firebase Auth token email
 * ending in `@wekruit.com` (mirrors the dashboard's Google-sign-in gate, but
 * the server gate is the security boundary — never trust the UI). A
 * PA_ADMIN_TOKEN fallback is supported for scripted ops callers.
 *
 * Endpoint shape:
 *
 *   Input  { userId?, phoneE164?, confirm }
 *   Output { ok: true, deleted: { collection: count, ... }, userId, phoneE164 }
 *
 * Resolution + safety:
 *  - Resolve the target by `userId` OR by `phoneE164` (pa-users where
 *    phoneE164 == input). If MULTIPLE pa-users hold the phone, we DO NOT guess
 *    — we return them all and require an explicit `userId` (failed-precondition
 *    "ambiguous_phone").
 *  - `confirm` must EXACTLY equal the resolved user's `phoneE164` (the admin
 *    must type the phone back) — else failed-precondition "confirm_mismatch".
 *  - Idempotent: deleting an already-deleted user returns ok with zero counts,
 *    never throws.
 *
 * Architecture: deletion logic lives in `runAdminDeleteUser` (pure,
 * deps-injected) so unit tests drive it without a live Firestore. The onCall
 * wrapper at the bottom is a thin shim that wires production deps (Admin SDK
 * Firestore + the canonical `clearUserMemory` for mem0/Qdrant).
 */
import { onCall, HttpsError } from "firebase-functions/v2/https"
import { defineSecret } from "firebase-functions/params"
import { logger } from "firebase-functions/v2"
import { getFirestore } from "firebase-admin/firestore"
import type { Firestore } from "firebase-admin/firestore"
import { z } from "zod"
import { clearUserMemory, resolveMem0PartitionKey } from "@pa/memory"

// Reused secrets — same trio the reinit CF binds. Qdrant creds drive the mem0
// memory-partition wipe; PA_ADMIN_TOKEN is the scripted-caller fallback gate.
const QDRANT_URL = defineSecret("QDRANT_URL")
const QDRANT_API_KEY = defineSecret("QDRANT_API_KEY")
const PA_ADMIN_TOKEN = defineSecret("PA_ADMIN_TOKEN")
const QDRANT_COLLECTION = "pa_memory"

const PA_USERS = "pa-users"
const AUDIT_COLLECTION = "pa-audit-events"

// Firestore batched-write hard cap.
const BATCH_LIMIT = 500
// Keep a safe margin below the 500 cap.
const CHUNK = 400

// ---------------------------------------------------------------------------
// Collection inventory — discovered from `.ops/reinit-user-cold.mjs`,
// `packages/memory/src/admin.ts` (clearUserMemory), `packages/pa-persistence/
// src/identity.ts` (handle/identity indexes + mergeCandidatesByPhone fold
// list), and the token collections in `apps/functions/src/{linkedin-connect,
// qr-onboarding,connect-phone}`. Grouped by the field we query on.
// ---------------------------------------------------------------------------

/**
 * Collections whose rows carry a `userId` field == the uid. Bounded query +
 * chunked batch delete. (parsedCandidateResumes ALSO matches on candidateId —
 * see USER_SCOPED_BY_CANDIDATE_ID below; dedup is on doc id.)
 */
export const USER_SCOPED_BY_USER_ID = [
  "pa-messages",
  "pa-sessions",
  "pa-prescreen-sessions",
  "pa-agent-turns",
  "pa-turns",
  "pa-inbound-events",
  "pa-outbound",
  "pa-conversation-archives",
  "pa-message-archives",
  "pa-conversation-summaries",
  "pa-memory-facts",
  "pa-memory-actions",
  "pa-memory-events",
  "pa-memory-profiles",
  "pa-memory-evolution-events",
  "pa-surprise-events",
  "pa-tag-events",
  "pa-tapback-events",
  "pa-scheduled-jobs",
  "pa-tool-calls",
  "pa-abuse-events",
  "pa-rate-limits",
  "pa-cv-pending",
  "pa-job-profiles",
  "pa-job-rec-explanations",
  "pa-pending-outbound",
  "pa-interview-bookings",
  "parsedCandidateResumes",
  // Per-user single-use tokens (random doc id, `userId` field).
  "pa-cv-upload-tokens",
  "pa-linkedin-connect-tokens",
] as const

/**
 * Collections whose rows carry a `candidateId` field == the uid (v2.0
 * marketplace + identity index). candidateId IS the pa-users doc id.
 */
export const USER_SCOPED_BY_CANDIDATE_ID = [
  "pa-candidate-handles",
  "pa-candidate-job-states",
  "pa-candidate-job-matches",
  "pa-employer-visible-profiles",
  "pa-outbound-invites",
  "pa-feedback-events",
  "pa-correction-events",
  "pa-candidate-identity-events",
  "pa-candidate-source-links",
  "parsedCandidateResumes",
] as const

/**
 * Collections whose DOC ID == the uid (delete the single doc directly).
 * candidateAuth is keyed by firebaseUid, NOT uid — handled separately by
 * querying `candidateId == uid`.
 */
export const USER_KEYED_BY_DOC_ID = [
  PA_USERS,
  "pa-candidate-self-profiles",
] as const

/** Collections keyed by `pa-user:{uid}` root doc with an `items` subcollection. */
const ENTITY_TAGS_COLLECTION = "pa-entity-tags"
/** Per-user job recommendations: doc id == uid, with a `jobs` subcollection. */
const USER_JOB_RECS_COLLECTION = "pa-user-job-recommendations"
const USER_JOB_RECS_SUBCOLLECTION = "jobs"
/** Firebase-uid-keyed auth mapping (query candidateId == uid to find rows). */
const CANDIDATE_AUTH_COLLECTION = "pa-candidate-auth"
/** Connect-phone codes carry phoneCandidateId == uid (query, not doc id). */
const CONNECT_PHONE_CODES_COLLECTION = "pa-connect-phone-codes"

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export const AdminDeleteUserInputSchema = z
  .object({
    userId: z.string().min(8).optional(),
    phoneE164: z.string().min(6).optional(),
    /** Must equal the resolved user's phoneE164 (typed-back confirmation). */
    confirm: z.string().min(1),
    /** Scripted-admin fallback (mirrors paReinitializeCandidate). */
    adminToken: z.string().optional(),
  })
  .refine((v) => Boolean(v.userId) || Boolean(v.phoneE164), {
    message: "userId_or_phone_required",
  })
export type AdminDeleteUserInput = z.infer<typeof AdminDeleteUserInputSchema>

export interface AdminDeleteUserResult {
  ok: true
  deleted: Record<string, number>
  userId: string
  phoneE164: string | null
}

/** Lightweight projection returned when a phone resolves to >1 pa-users. */
export interface AdminDeleteUserMatch {
  userId: string
  phoneE164: string | null
  displayName: string | null
  email: string | null
  createdAt: string | null
}

// ---------------------------------------------------------------------------
// Deps (injectable for tests)
// ---------------------------------------------------------------------------

export interface AdminDeleteUserDeps {
  db: Firestore
  /** Canonical mem0/Qdrant memory wipe. Best-effort — failure never blocks the
   *  Firestore hard delete. Injected so tests can stub + so the CF binds creds. */
  clearMemory: (userId: string, mem0PartitionKey?: string) => Promise<unknown>
  now: () => string
  /** Actor identity for the audit row (admin email or token sentinel). */
  actor: string
  log?: (event: string, payload?: Record<string, unknown>) => void
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function cleanString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null
}

/** Delete every doc in a collection where `field == uid`. Chunked batches. */
async function deleteByField(
  db: Firestore,
  collection: string,
  field: string,
  uid: string,
): Promise<number> {
  let snap
  try {
    snap = await db.collection(collection).where(field, "==", uid).get()
  } catch {
    // A missing composite index (or absent collection) must not abort the whole
    // delete — other surfaces still wipe. Treated as zero rows.
    return 0
  }
  const refs = snap.docs.map((d) => d.ref)
  await deleteRefs(db, refs)
  return refs.length
}

/** Delete a list of doc refs in chunked batches (Firestore 500/batch cap). */
async function deleteRefs(
  db: Firestore,
  refs: Array<FirebaseFirestore.DocumentReference>,
): Promise<void> {
  for (let i = 0; i < refs.length; i += CHUNK) {
    const batch = db.batch()
    for (const ref of refs.slice(i, i + CHUNK)) batch.delete(ref)
    if (refs.slice(i, i + CHUNK).length > 0) await batch.commit()
  }
}

/** Delete a per-user root doc plus a named subcollection under it. */
async function deleteRootWithSubcollection(
  db: Firestore,
  collection: string,
  uid: string,
  subcollection: string,
): Promise<number> {
  const rootRef = db.collection(collection).doc(uid)
  let count = 0
  try {
    const subSnap = await rootRef.collection(subcollection).get()
    await deleteRefs(db, subSnap.docs.map((d) => d.ref))
    count += subSnap.docs.length
  } catch {
    /* subcollection read optional */
  }
  try {
    const rootSnap = await rootRef.get()
    if (rootSnap.exists) {
      await rootRef.delete()
      count += 1
    }
  } catch {
    /* .delete() is a no-op on a missing doc */
  }
  return count
}

// ---------------------------------------------------------------------------
// Resolution — by userId OR phone (with multi-doc disambiguation)
// ---------------------------------------------------------------------------

export type ResolveTargetResult =
  | { kind: "resolved"; userId: string; phoneE164: string | null; data: Record<string, unknown> }
  | { kind: "not_found" }
  | { kind: "ambiguous"; matches: AdminDeleteUserMatch[] }

function projectMatch(id: string, data: Record<string, unknown>): AdminDeleteUserMatch {
  return {
    userId: id,
    phoneE164: cleanString(data.phoneE164),
    displayName: cleanString(data.displayName) ?? cleanString(data.name) ?? cleanString(data.legalName),
    email: cleanString(data.email),
    createdAt: cleanString(data.createdAt),
  }
}

export async function resolveDeleteTarget(
  db: Firestore,
  input: { userId?: string; phoneE164?: string },
): Promise<ResolveTargetResult> {
  // userId wins — direct doc lookup, no ambiguity.
  if (input.userId) {
    const snap = await db.collection(PA_USERS).doc(input.userId).get()
    if (!snap.exists) return { kind: "not_found" }
    const data = (snap.data() ?? {}) as Record<string, unknown>
    return { kind: "resolved", userId: snap.id, phoneE164: cleanString(data.phoneE164), data }
  }

  // phone lookup — may return 0, 1, or many.
  const phone = (input.phoneE164 ?? "").trim()
  const snap = await db.collection(PA_USERS).where("phoneE164", "==", phone).limit(25).get()
  if (snap.empty) return { kind: "not_found" }
  if (snap.docs.length > 1) {
    return { kind: "ambiguous", matches: snap.docs.map((d) => projectMatch(d.id, (d.data() ?? {}) as Record<string, unknown>)) }
  }
  const doc = snap.docs[0]!
  const data = (doc.data() ?? {}) as Record<string, unknown>
  return { kind: "resolved", userId: doc.id, phoneE164: cleanString(data.phoneE164), data }
}

// ---------------------------------------------------------------------------
// Pure handler — hard-delete everything for a resolved uid
// ---------------------------------------------------------------------------

export async function runAdminDeleteUser(
  input: AdminDeleteUserInput,
  deps: AdminDeleteUserDeps,
): Promise<AdminDeleteUserResult> {
  const { db } = deps
  const log = deps.log ?? (() => {})
  const now = deps.now()

  const resolved = await resolveDeleteTarget(db, { userId: input.userId, phoneE164: input.phoneE164 })

  if (resolved.kind === "ambiguous") {
    throw new HttpsError("failed-precondition", "ambiguous_phone", { matches: resolved.matches })
  }

  if (resolved.kind === "not_found") {
    // Idempotent: a never-existed / already-deleted user is a no-op success.
    // We still clear the memory partition (best-effort) since Qdrant points can
    // outlive a deleted Firestore doc, and we never require confirm to match a
    // phone we cannot read.
    log("admin_delete_user.not_found_noop", { userId: input.userId ?? null, phoneE164: input.phoneE164 ?? null })
    const targetUid = input.userId ?? null
    if (targetUid) {
      await deps.clearMemory(targetUid).catch(() => undefined)
    }
    return { ok: true, deleted: zeroDeletedSummary(), userId: targetUid ?? "", phoneE164: null }
  }

  const uid = resolved.userId
  const phoneE164 = resolved.phoneE164

  // CONFIRM gate — the admin must type back the resolved phone exactly. When the
  // user has no phone on file, confirm must be the literal "no-phone" sentinel
  // so the destructive action is never a silent empty-string pass.
  const expectedConfirm = phoneE164 ?? "no-phone"
  if (input.confirm.trim() !== expectedConfirm) {
    throw new HttpsError("failed-precondition", "confirm_mismatch")
  }

  log("admin_delete_user.start", { uid, phoneE164, actor: deps.actor })

  const deleted: Record<string, number> = {}

  // 1. userId-keyed collections.
  for (const collection of USER_SCOPED_BY_USER_ID) {
    deleted[collection] = (deleted[collection] ?? 0) + (await deleteByField(db, collection, "userId", uid))
  }

  // 2. candidateId-keyed collections (marketplace + identity index).
  for (const collection of USER_SCOPED_BY_CANDIDATE_ID) {
    deleted[collection] = (deleted[collection] ?? 0) + (await deleteByField(db, collection, "candidateId", uid))
  }

  // 3. candidateAuth — keyed by firebaseUid; find rows mapping TO this uid.
  deleted[CANDIDATE_AUTH_COLLECTION] = await deleteByField(db, CANDIDATE_AUTH_COLLECTION, "candidateId", uid)

  // 4. connect-phone codes — phoneCandidateId references the uid.
  deleted[CONNECT_PHONE_CODES_COLLECTION] = await deleteByField(
    db,
    CONNECT_PHONE_CODES_COLLECTION,
    "phoneCandidateId",
    uid,
  )

  // 5. entity-tags root doc + items subcollection.
  deleted[ENTITY_TAGS_COLLECTION] = await deleteRootWithSubcollection(
    db,
    ENTITY_TAGS_COLLECTION,
    `pa-user:${uid}`,
    "items",
  )

  // 6. per-user job-recommendations root + jobs subcollection.
  deleted[USER_JOB_RECS_COLLECTION] = await deleteRootWithSubcollection(
    db,
    USER_JOB_RECS_COLLECTION,
    uid,
    USER_JOB_RECS_SUBCOLLECTION,
  )

  // 7. doc-id-keyed singletons (pa-users itself LAST so resolution above worked).
  for (const collection of USER_KEYED_BY_DOC_ID) {
    const ref = db.collection(collection).doc(uid)
    let existed = false
    try {
      const snap = await ref.get()
      existed = snap.exists
    } catch {
      /* treat read failure as absent */
    }
    if (existed) {
      await ref.delete()
    }
    deleted[collection] = (deleted[collection] ?? 0) + (existed ? 1 : 0)
  }

  // 8. mem0 / Qdrant memory partition — best-effort, never blocks the delete.
  let mem0Cleared = 0
  try {
    const partitionKey = resolveMem0PartitionKey(resolved.data as never) ?? uid
    await deps.clearMemory(uid, partitionKey !== uid ? partitionKey : undefined)
    mem0Cleared = 1
  } catch (err) {
    log("admin_delete_user.mem0_clear_failed", { uid, error: err instanceof Error ? err.message : String(err) })
  }
  deleted["mem0/qdrant"] = mem0Cleared

  // 9. Audit row — who deleted whom (PII-light: store the uid + masked phone).
  try {
    await db.collection(AUDIT_COLLECTION).add({
      action: "admin.delete_user",
      userId: uid,
      phoneTail: phoneE164 ? phoneE164.slice(-4) : null,
      actor: deps.actor,
      deletedSummary: deleted,
      createdAt: now,
    })
  } catch (err) {
    log("admin_delete_user.audit_write_failed", { uid, error: err instanceof Error ? err.message : String(err) })
  }

  log("admin_delete_user.done", { uid, deleted })
  return { ok: true, deleted, userId: uid, phoneE164 }
}

/** Zero-count summary for the idempotent already-deleted path. */
function zeroDeletedSummary(): Record<string, number> {
  const out: Record<string, number> = {}
  for (const c of USER_SCOPED_BY_USER_ID) out[c] = 0
  for (const c of USER_SCOPED_BY_CANDIDATE_ID) out[c] = 0
  for (const c of USER_KEYED_BY_DOC_ID) out[c] = 0
  out[CANDIDATE_AUTH_COLLECTION] = 0
  out[CONNECT_PHONE_CODES_COLLECTION] = 0
  out[ENTITY_TAGS_COLLECTION] = 0
  out[USER_JOB_RECS_COLLECTION] = 0
  out["mem0/qdrant"] = 0
  return out
}

// ---------------------------------------------------------------------------
// Admin auth gate — @wekruit.com email OR PA_ADMIN_TOKEN fallback
// ---------------------------------------------------------------------------

/**
 * Hard server-side gate. The dashboard restricts to `@wekruit.com` Google
 * sign-in, but the UI gate is convenience only — THIS is the security boundary.
 * Returns the actor identity (email or token sentinel) for the audit row.
 */
export function authorizeWekruitAdmin(req: {
  auth?: { token?: { email?: unknown; email_verified?: unknown; admin?: unknown }; uid?: string }
  data?: unknown
}): { actor: string } {
  const token = req.auth?.token
  const email = typeof token?.email === "string" ? token.email.trim().toLowerCase() : ""
  const verified = token?.email_verified === true || token?.email_verified === "true"
  if (email.endsWith("@wekruit.com") && verified) {
    return { actor: email }
  }
  // Some custom-claim admin tokens (scripted) carry admin:true without an email.
  if (token?.admin === true || token?.admin === "true") {
    return { actor: req.auth?.uid ? `admin:${req.auth.uid}` : "admin-claim" }
  }

  const dataObj = req.data && typeof req.data === "object" ? (req.data as Record<string, unknown>) : {}
  const provided = typeof dataObj.adminToken === "string" ? dataObj.adminToken.trim() : ""
  const expected = (process.env.PA_ADMIN_TOKEN ?? "").trim()
  if (expected && provided && provided === expected) {
    return { actor: "admin-token" }
  }

  throw new HttpsError("permission-denied", "wekruit_admin_only")
}

// ---------------------------------------------------------------------------
// Production CF — thin shim over runAdminDeleteUser.
// ---------------------------------------------------------------------------

export const paAdminDeleteUser = onCall(
  {
    region: "us-central1",
    memory: "512MiB",
    timeoutSeconds: 120,
    secrets: [QDRANT_URL, QDRANT_API_KEY, PA_ADMIN_TOKEN],
  },
  async (req): Promise<AdminDeleteUserResult> => {
    const { actor } = authorizeWekruitAdmin(
      req as {
        auth?: { token?: { email?: unknown; email_verified?: unknown; admin?: unknown }; uid?: string }
        data?: unknown
      },
    )
    const parsed = AdminDeleteUserInputSchema.safeParse(req.data)
    if (!parsed.success) {
      throw new HttpsError("invalid-argument", parsed.error.message)
    }

    const db = getFirestore()
    return runAdminDeleteUser(parsed.data, {
      db,
      clearMemory: (uid, mem0PartitionKey) =>
        clearUserMemory(
          uid,
          {
            db,
            qdrantUrl: QDRANT_URL.value(),
            qdrantApiKey: QDRANT_API_KEY.value(),
            qdrantCollection: QDRANT_COLLECTION,
          },
          // keepMessages true: we delete pa-messages ourselves above; this call
          // is ONLY to wipe the Qdrant memory partition + memory-plane docs that
          // outlive the user. (clearUserMemory's user-doc reset is moot — the
          // pa-users doc is hard-deleted.)
          { keepMessages: true, ...(mem0PartitionKey ? { mem0PartitionKey } : {}) },
        ),
      now: () => new Date().toISOString(),
      actor,
      log: (event, payload) => logger.info(`[admin-delete-user] ${event}`, payload ?? {}),
    })
  },
)
