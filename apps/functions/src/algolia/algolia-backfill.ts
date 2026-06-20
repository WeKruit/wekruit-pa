/**
 * `paAlgoliaBackfill` — admin callable that (re)indexes the whole pool into
 * Algolia: all recruiter submissions and/or all pa-users. Run once after the
 * secrets are set; thereafter the sync triggers keep the indexes fresh.
 */
import { getFirestore } from "firebase-admin/firestore"
import { defineSecret } from "firebase-functions/params"
import { HttpsError, onCall } from "firebase-functions/v2/https"
import { logger } from "firebase-functions/v2"
import { z } from "zod"
import { authorizeAdminCallable } from "../promote-sandbox-tag.js"
import {
  SUBMISSIONS_INDEX,
  CANDIDATES_INDEX,
  toSubmissionRecord,
  toCandidateRecord,
} from "./algolia-records.js"
import { algoliaSaveObjects } from "./algolia-rest.js"

const PA_ADMIN_TOKEN = defineSecret("PA_ADMIN_TOKEN")
const ALGOLIA_APP_ID = defineSecret("ALGOLIA_APP_ID")
const ALGOLIA_ADMIN_KEY = defineSecret("ALGOLIA_ADMIN_KEY")

const SUBMISSION_FIELDS = [
  "submitter.name",
  "submitter.email",
  "candidate.name",
  "candidate.email",
  "candidate.link",
  "jobId",
  "inboundJobId",
  "jobTitleSnapshot",
  "companyLabelSnapshot",
  "status",
  "score",
  "createdAt",
  "sheetSyncError",
]
const CANDIDATE_FIELDS = [
  "displayName",
  "email",
  "phoneE164",
  "linkedinUrl",
  "signupSource",
  "source",
  "firstSignupEntry",
  "candidateLifecycleState",
  "onboardingStatus",
  "latestResumeArtifactId",
  "piiConsentAt",
  "mem0UserId",
  "testMode",
  "isDemo",
  "demoSourcePool",
  "outreach",
  "globalTags",
  "experience",
  "createdAt",
]

const Input = z.object({
  target: z.enum(["submissions", "candidates", "both"]).nullish(),
  adminToken: z.string().nullish(),
})

export const paAlgoliaBackfill = onCall(
  {
    region: "us-central1",
    memory: "1GiB",
    timeoutSeconds: 540,
    secrets: [PA_ADMIN_TOKEN, ALGOLIA_APP_ID, ALGOLIA_ADMIN_KEY],
  },
  async (req) => {
    authorizeAdminCallable(req as { auth?: { token?: { admin?: unknown } }; data?: unknown })
    const parsed = Input.safeParse(req.data ?? {})
    if (!parsed.success) throw new HttpsError("invalid-argument", parsed.error.message)
    const target = parsed.data.target ?? "both"
    const db = getFirestore()
    const out: Record<string, unknown> = {}
    try {
      if (target === "submissions" || target === "both") {
        const snap = await db.collection("pa-recruiter-submissions").select(...SUBMISSION_FIELDS).limit(20_000).get()
        const records = snap.docs.map((d) => toSubmissionRecord(d.id, d.data() as Record<string, unknown>))
        out.submissions = await algoliaSaveObjects(SUBMISSIONS_INDEX, records)
        out.submissionsScanned = snap.size
      }
      if (target === "candidates" || target === "both") {
        const snap = await db.collection("pa-users").select(...CANDIDATE_FIELDS).limit(20_000).get()
        const records = snap.docs.map((d) => toCandidateRecord(d.id, d.data() as Record<string, unknown>))
        out.candidates = await algoliaSaveObjects(CANDIDATES_INDEX, records)
        out.candidatesScanned = snap.size
      }
      return out
    } catch (err) {
      logger.error("[algolia] backfill failed", err)
      throw new HttpsError("internal", `algolia backfill failed: ${String(err).slice(0, 200)}`)
    }
  },
)
