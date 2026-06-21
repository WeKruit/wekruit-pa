/**
 * Firestore → Algolia real-time sync triggers. Each write to a submission /
 * pa-user upserts (or deletes) its Algolia record so search stays fresh. Fail
 * open: a sync error is logged, never throws (must not break the write path).
 * No-ops until ALGOLIA_APP_ID + ALGOLIA_ADMIN_KEY secrets are set.
 */
import { onDocumentWritten } from "firebase-functions/v2/firestore"
import { defineSecret } from "firebase-functions/params"
import { logger } from "firebase-functions/v2"
import {
  SUBMISSIONS_INDEX,
  CANDIDATES_INDEX,
  toSubmissionRecord,
  toCandidateRecord,
} from "./algolia-records.js"
import { algoliaSaveObjects, algoliaDeleteObject } from "./algolia-rest.js"

const ALGOLIA_APP_ID = defineSecret("ALGOLIA_APP_ID")
const ALGOLIA_ADMIN_KEY = defineSecret("ALGOLIA_ADMIN_KEY")
const ALGOLIA_SECRETS = [ALGOLIA_APP_ID, ALGOLIA_ADMIN_KEY]

export const paAlgoliaSyncRecruiterSubmission = onDocumentWritten(
  { document: "pa-recruiter-submissions/{id}", region: "us-central1", secrets: ALGOLIA_SECRETS },
  async (event) => {
    const id = event.params.id
    const after = event.data?.after
    try {
      if (!after?.exists) {
        await algoliaDeleteObject(SUBMISSIONS_INDEX, id)
        return
      }
      await algoliaSaveObjects(SUBMISSIONS_INDEX, [
        toSubmissionRecord(id, after.data() as Record<string, unknown>),
      ])
    } catch (err) {
      logger.error("[algolia] submission sync failed", { id, error: String(err) })
    }
  },
)

export const paAlgoliaSyncCandidate = onDocumentWritten(
  { document: "pa-users/{id}", region: "us-central1", secrets: ALGOLIA_SECRETS },
  async (event) => {
    const id = event.params.id
    const after = event.data?.after
    try {
      if (!after?.exists) {
        await algoliaDeleteObject(CANDIDATES_INDEX, id)
        return
      }
      await algoliaSaveObjects(CANDIDATES_INDEX, [
        toCandidateRecord(id, after.data() as Record<string, unknown>),
      ])
    } catch (err) {
      logger.error("[algolia] candidate sync failed", { id, error: String(err) })
    }
  },
)
