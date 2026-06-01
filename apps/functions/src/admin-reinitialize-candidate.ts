/**
 * paReinitializeCandidate — admin-only callable that resets a candidate's GLOBAL profile to a
 * fresh, just-onboarded-from-résumé state while preserving job-specific data (matched jobs,
 * prescreen sessions). Thin shim over `reinitializeCandidate` (candidate-reinit.ts), wiring the
 * canonical `clearUserMemory` with prod Qdrant creds.
 *
 * Input  { userId: string, adminToken?: string }
 * Output ReinitializeCandidateResult (archivedMessages, cleared, resumePreserved, jobRecPreserved,
 *         reEnriched, tagKeys, reEngageMode:"candidate_self_initiates")
 * Auth: Firebase Auth custom claim `admin:true` OR `data.adminToken` === PA_ADMIN_TOKEN.
 */
import { onCall, HttpsError } from "firebase-functions/v2/https"
import { defineSecret } from "firebase-functions/params"
import { logger } from "firebase-functions/v2"
import { getFirestore } from "firebase-admin/firestore"
import { clearUserMemory, resolveMem0PartitionKey } from "@pa/memory"
import { reinitializeCandidate, type ReinitializeCandidateResult } from "./candidate-reinit.js"

const QDRANT_URL = defineSecret("QDRANT_URL")
const QDRANT_API_KEY = defineSecret("QDRANT_API_KEY")
const PA_ADMIN_TOKEN = defineSecret("PA_ADMIN_TOKEN")
const QDRANT_COLLECTION = "pa_memory"

function assertAdmin(authToken: Record<string, unknown> | undefined, suppliedToken: unknown): void {
  if (authToken?.admin === true) return
  const expected = PA_ADMIN_TOKEN.value()
  if (typeof suppliedToken === "string" && expected && suppliedToken === expected) return
  throw new HttpsError("permission-denied", "admin only")
}

export const paReinitializeCandidate = onCall(
  { region: "us-central1", secrets: [QDRANT_URL, QDRANT_API_KEY, PA_ADMIN_TOKEN], timeoutSeconds: 120 },
  async (request): Promise<ReinitializeCandidateResult> => {
    assertAdmin(request.auth?.token as Record<string, unknown> | undefined, request.data?.adminToken)
    const userId = String(request.data?.userId ?? "").trim()
    if (!userId) throw new HttpsError("invalid-argument", "userId required")

    const db = getFirestore()

    // Resolve mem0 partition key from the user doc (11-IDENTITY-CONTRACT) so the Qdrant wipe scopes
    // correctly for backfilled/merged users; read BEFORE the wipe.
    let mem0PartitionKey = userId
    try {
      const snap = await db.collection("pa-users").doc(userId).get()
      if (snap.exists) mem0PartitionKey = resolveMem0PartitionKey(snap.data() as never) ?? userId
    } catch {
      /* fall back to userId */
    }

    const clearMemory = (uid: string) =>
      clearUserMemory(
        uid,
        { db, qdrantUrl: QDRANT_URL.value(), qdrantApiKey: QDRANT_API_KEY.value(), qdrantCollection: QDRANT_COLLECTION },
        { keepMessages: false, ...(mem0PartitionKey !== uid ? { mem0PartitionKey } : {}) },
      )

    const result = await reinitializeCandidate(userId, {
      db,
      clearMemory,
      log: (event, payload) => logger.info(`[reinit] ${event}`, payload ?? {}),
    })
    logger.info("[reinit] complete", { userId, archived: result.archivedMessages, reEnriched: result.reEnriched })
    return result
  },
)
