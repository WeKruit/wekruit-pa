/**
 * v2.0 External Supply V1 — Wave B Block C3 — Admin-only callable that
 * iterates a normalized batch's records, resolves identity, and runs the
 * upsert in one pass.
 *
 * Inputs: `{ batchId: string }`.
 *
 * Behavior:
 *  1. Fetch `pa-external-sourcing-batches/{batchId}`. Throw if the batch is
 *     not in `normalized` (the prior phase B step) or `resolving_identity`
 *     (a previous interrupted run we want to resume).
 *  2. Flip batch status to `resolving_identity` so the dashboard reflects
 *     in-flight work.
 *  3. Paginate `pa-external-candidate-records?batchId == batchId` 200 rows
 *     at a time. For each record where `identityResolutionStatus == "pending"`:
 *       a. `resolveExternalSupplyIdentity(db, record)`
 *       b. `upsertCandidateFromExternalRecord(db, { record, resolution, operatorUid })`
 *       c. Update the record doc with the new
 *          `identityResolutionStatus` + `resolvedUserId?` + `resolutionConflictId?`.
 *  4. Aggregate counters: `created` / `merged` / `pending` / `blocked`.
 *  5. Set batch status to `ready_for_review` (operator advances to the
 *     review queue) and write final stat counters.
 *  6. Idempotency: records already resolved are skipped; re-running the
 *     callable is safe.
 *
 * Auth: `@wekruit.com` Firebase Auth required (mirrors the existing
 * `authorizeAdminCallable` shape used by B's import callable but
 * additionally enforces the email-domain check expected for marketplace
 * admin tools).
 */

import { onCall, HttpsError } from "firebase-functions/v2/https"
import { defineSecret } from "firebase-functions/params"
import { logger } from "firebase-functions/v2"
import { getFirestore, type Firestore } from "firebase-admin/firestore"
import {
  ExternalSourcingBatchSchema,
  PA_COLLECTIONS,
  type ExternalSourcingBatch,
  type ExternalCandidateRecord,
} from "@pa/core-types"
import {
  resolveExternalSupplyIdentity,
  upsertCandidateFromExternalRecord,
} from "@pa/pa-persistence"
import { dualWriteLegacyUserTagsFromExternal } from "./legacy-user-tags-bridge.js"
// P2.5 — mirror CoreSignal experience[] into canonical parsedCandidateResumes
// collection so Claire / paReverseMatch / job-rec-daily can see CoreSignal
// candidates. Also records coresignalEmployeeId on pa-users for fast dedup.
import {
  makeFirestoreMirrorDeps,
  runCoresignalExperiencesMirror,
} from "./coresignal-experiences-mirror.js"
import { parseExternalCandidateRecordDoc } from "./record-doc.js"

const PAGE_SIZE = 200

export interface ResolveBatchIdentityResult {
  ok: true
  batchId: string
  processed: number
  created: number
  merged: number
  pending: number
  blocked: number
  skipped: number
}

export interface ResolveBatchIdentityDeps {
  db: Firestore
  now?: () => string
}

type CallableAuth = {
  uid?: string
  token?: {
    email?: unknown
    email_verified?: unknown
    admin?: unknown
  }
}

function emailFromAuth(auth: CallableAuth | undefined): string {
  const raw = auth?.token?.email
  if (typeof raw !== "string") return ""
  return raw.trim().toLowerCase()
}

/**
 * Admin gate: accepts a verified `@wekruit.com` Firebase Auth token OR a
 * `token.admin === true` custom claim (mirrors `authorizeAdminCallable`
 * fallback used by `promote-sandbox-tag.ts` for system-to-system calls).
 */
export function requireExternalSupplyAdmin(
  auth: CallableAuth | undefined
): { uid: string; email: string } {
  const uid = (auth?.uid ?? "").toString()
  if (!uid) {
    throw new HttpsError("unauthenticated", "Sign in required.")
  }
  const adminClaim = auth?.token?.admin
  if (adminClaim === true || adminClaim === "true") {
    return { uid, email: emailFromAuth(auth) || "admin-claim" }
  }
  const email = emailFromAuth(auth)
  if (!email.endsWith("@wekruit.com")) {
    throw new HttpsError("permission-denied", "Wekruit admin only.")
  }
  if (auth?.token?.email_verified === false) {
    throw new HttpsError("failed-precondition", "Verified email required.")
  }
  return { uid, email }
}

/**
 * Pure handler — extracted from the CF wrapper so it can be driven by
 * tests against an in-memory Firestore + crafted auth tokens.
 */
export async function runResolveBatchIdentity(
  data: unknown,
  auth: CallableAuth | undefined,
  deps: ResolveBatchIdentityDeps
): Promise<ResolveBatchIdentityResult> {
  const { uid } = requireExternalSupplyAdmin(auth)
  const { db } = deps
  const now = deps.now ?? (() => new Date().toISOString())

  const inputObj = data && typeof data === "object" ? (data as Record<string, unknown>) : {}
  const batchId =
    typeof inputObj.batchId === "string" && inputObj.batchId.trim().length > 0
      ? inputObj.batchId.trim()
      : null
  if (!batchId) {
    throw new HttpsError("invalid-argument", "batchId is required.")
  }

  const batchRef = db.collection(PA_COLLECTIONS.externalSourcingBatches).doc(batchId)
  const batchSnap = await batchRef.get()
  if (!batchSnap.exists) {
    throw new HttpsError("not-found", `Batch ${batchId} not found.`)
  }
  const batch = ExternalSourcingBatchSchema.parse(batchSnap.data())
  if (batch.status !== "normalized" && batch.status !== "resolving_identity") {
    throw new HttpsError(
      "failed-precondition",
      `Batch ${batchId} status=${batch.status}, expected normalized or resolving_identity.`
    )
  }

  // Flip status to in-progress so the dashboard shows resolving state.
  await batchRef.set(
    {
      status: "resolving_identity",
      updatedAt: now(),
    },
    { merge: true }
  )

  const counters = {
    processed: 0,
    created: 0,
    merged: 0,
    pending: 0,
    blocked: 0,
    skipped: 0,
  }

  // Paginate by orderBy(recordId) + cursor for stability. The in-memory
  // fake used in tests supports `where(...).orderBy(...).limit(...).get()`
  // OR returns the full set for simplicity — see test fake. We rely only
  // on `.where(...).limit(...).get()` + `.startAfter(...)` if available;
  // otherwise iterate the where().get() list (smaller batches at V1 scale).
  const recordsRef = db.collection(PA_COLLECTIONS.externalCandidateRecords)
  const snap = await recordsRef.where("batchId", "==", batchId).get()
  for (const doc of snap.docs) {
    const record = parseExternalCandidateRecordDoc(doc.data())
    if (!record) {
      counters.skipped += 1
      continue
    }
    if (record.identityResolutionStatus !== "pending") {
      counters.skipped += 1
      continue
    }
    counters.processed += 1
    try {
      const resolution = await resolveExternalSupplyIdentity(db, record, { now })
      const upsertResult = await upsertCandidateFromExternalRecord(db, {
        record,
        resolution,
        operatorUid: uid,
        now,
      })
      switch (upsertResult.status) {
        case "created":
          counters.created += 1
          break
        case "merged":
          counters.merged += 1
          break
        case "pending_review":
          counters.pending += 1
          break
        case "blocked":
          counters.blocked += 1
          break
      }
      // Wave B-C upsert wrote `pa-users.globalTags` (v2.0 canonical surface).
      // The v1.6 matching pipeline reads `pa-users.tags`, so we additionally
      // run a weak-merge dual-write through `mergeUserTags` +
      // `applyPartialUserTags` for the legacy surface. Only `create_new` /
      // `merge_existing` produce a candidateId — pending / blocked rows
      // never reach this branch.
      if (upsertResult.candidateId && (upsertResult.status === "created" || upsertResult.status === "merged")) {
        try {
          const bridge = await dualWriteLegacyUserTagsFromExternal(
            db,
            upsertResult.candidateId,
            record,
            { nowIso: now(), log: (e, p) => logger.info(`external_supply.legacy_tags.${e}`, p) }
          )
          if (bridge.wrote) {
            logger.info("external_supply.legacy_tags.dual_write_ok", {
              candidateId: upsertResult.candidateId,
              recordId: record.recordId,
              mergedKeys: bridge.mergedKeys,
              skippedKeys: bridge.skippedKeys,
            })
          }
        } catch (err) {
          // Bridge failure must NOT abort the upsert — log + continue.
          logger.error("external_supply.legacy_tags.dual_write_error", {
            candidateId: upsertResult.candidateId,
            recordId: record.recordId,
            err: err instanceof Error ? err.message : String(err),
          })
        }

        // P2.5 — mirror CoreSignal experiences into parsedCandidateResumes
        // collection. No-op for other sources. Failure must not abort upsert.
        try {
          const mirror = await runCoresignalExperiencesMirror(
            record,
            upsertResult.candidateId,
            {
              ...makeFirestoreMirrorDeps(db),
              now,
              log: (event, fields) =>
                logger.info(`external_supply.${event}`, fields),
            },
          )
          if (mirror.status === "mirrored") {
            logger.info("external_supply.coresignal_mirror.ok", {
              candidateId: upsertResult.candidateId,
              recordId: record.recordId,
            })
          }
        } catch (err) {
          logger.error("external_supply.coresignal_mirror.error", {
            candidateId: upsertResult.candidateId,
            recordId: record.recordId,
            err: err instanceof Error ? err.message : String(err),
          })
        }
      }
      const recordUpdate: Record<string, unknown> = {
        identityResolutionStatus: resolution.status,
        reviewReasons: resolution.reviewReasons,
        updatedAt: now(),
      }
      if (upsertResult.candidateId) {
        recordUpdate.resolvedUserId = upsertResult.candidateId
      }
      if (resolution.conflictId) {
        recordUpdate.resolutionConflictId = resolution.conflictId
      }
      await recordsRef.doc(record.recordId).set(
        recordUpdate,
        { merge: true }
      )
    } catch (err) {
      // Defensive — do not let a single bad row halt the batch. The error
      // surfaces in Cloud Logging and the operator can retry the row from
      // the dashboard.
      logger.error("external_supply.resolve_identity.row_failed", {
        batchId,
        recordId: record.recordId,
        err: err instanceof Error ? err.message : String(err),
      })
      counters.skipped += 1
    }
  }

  // Final batch state — operator advances from the review queue.
  await batchRef.set(
    {
      status: "ready_for_review",
      needsReviewCount: counters.pending,
      readyToProfileCount: counters.created + counters.merged,
      updatedAt: now(),
    },
    { merge: true }
  )

  return {
    ok: true,
    batchId,
    processed: counters.processed,
    created: counters.created,
    merged: counters.merged,
    pending: counters.pending,
    blocked: counters.blocked,
    skipped: counters.skipped,
  }
}

/**
 * Production CF wrapper — thin shim that grabs Firestore + delegates.
 */
// The Coresignal experiences mirror (run via runResolveBatchIdentity → runCoresignalExperiencesMirror)
// makes the unified LinkedIn+résumé merge LLM call (getOpenAIConfig reads PA_OPENAI_AGENT_API_KEY). Without
// this binding the merge fail-opens to null in this CF runtime and the determined facts are never written.
const PA_OPENAI_AGENT_API_KEY = defineSecret("PA_OPENAI_AGENT_API_KEY")

export const paExternalSupplyResolveBatchIdentity = onCall(
  {
    region: "us-central1",
    memory: "512MiB",
    timeoutSeconds: 540,
    secrets: [PA_OPENAI_AGENT_API_KEY],
  },
  async (req): Promise<ResolveBatchIdentityResult> => {
    // Hydrate process.env so the merge module's getOpenAIConfig() picks up the key (parity with the
    // index.ts résumé CFs). Empty/missing → delete so getOpenAIConfig fails open cleanly.
    const openAiKey = PA_OPENAI_AGENT_API_KEY.value().trim()
    if (openAiKey) process.env.PA_OPENAI_AGENT_API_KEY = openAiKey
    else delete process.env.PA_OPENAI_AGENT_API_KEY
    return runResolveBatchIdentity(req.data, req.auth, {
      db: getFirestore(),
    })
  }
)

// Internal re-exports for test convenience.
export type { ExternalCandidateRecord, ExternalSourcingBatch }
