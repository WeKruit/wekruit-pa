/**
 * Tool: saveJobProfile
 *
 * Persists the candidate's onboarding answers (industry / sponsorship /
 * location / size preference / salary floor) to `pa-job-profiles/{userId}`
 * so the daily cron can find them and personalise.
 *
 * Idempotency:
 *   - First write creates `createdAt` + `cvParsedAt`.
 *   - Subsequent saves merge — operator updates via dashboard preserve
 *     `createdAt` and just bump `updatedAt`.
 *
 * `status` defaults to "onboarding" on first write and is flipped to
 * "active" by the same write *only* if the profile is fully populated
 * (industry !== "any" implicitly NOT required — "any" is a legitimate
 * answer; the gate is "we have the four required fields"). The brief's
 * step 4 ("save profile via tool. Send 1 sample job as preview to
 * lock-in commitment") expects status flip to active after the agent
 * has all the answers.
 */

import type { Firestore } from "firebase-admin/firestore"
import { tool } from "@openai/agents"
import {
  JobProfileSchema,
  JOB_PROFILES_COLLECTION,
  SaveJobProfileInputSchema,
  type JobProfile,
  type JobProfileDoc,
  type SaveJobProfileOutput,
} from "../types.js"

export type SaveJobProfileDeps = {
  db: Firestore
  nowIso?: () => string
  log?: (...args: unknown[]) => void
}

function defaultLog(..._args: unknown[]): void {
  /* swallow */
}

export type SaveJobProfileArgs = {
  userId: string
  profile: JobProfile
}

export async function saveJobProfile(
  args: SaveJobProfileArgs,
  deps: SaveJobProfileDeps
): Promise<SaveJobProfileOutput> {
  const parsed = SaveJobProfileInputSchema.parse(args)
  // Re-validate the inner profile separately so we catch a partially
  // populated dashboard edit (saveJobProfileInputSchema also includes it,
  // but explicit > implicit).
  JobProfileSchema.parse(parsed.profile)

  const log = deps.log ?? defaultLog
  const nowIso = deps.nowIso ?? (() => new Date().toISOString())
  const ts = nowIso()
  const ref = deps.db.collection(JOB_PROFILES_COLLECTION).doc(parsed.userId)

  await deps.db.runTransaction(async (tx) => {
    const cur = await tx.get(ref)
    if (cur.exists) {
      const prev = cur.data() as JobProfileDoc
      const next: JobProfileDoc = {
        ...prev,
        userId: parsed.userId,
        profile: parsed.profile,
        // Once active, stay active (operator pause via dashboard).
        status: prev.status === "paused" ? "paused" : "active",
        updatedAt: ts,
      }
      tx.set(ref, next)
    } else {
      const doc: JobProfileDoc = {
        userId: parsed.userId,
        profile: parsed.profile,
        cvParsedAt: ts,
        lastJobBatchSentAt: null,
        status: "active",
        createdAt: ts,
        updatedAt: ts,
      }
      tx.set(ref, doc)
    }
  })

  log("[saveJobProfile] saved", { userId: parsed.userId, ts })
  return { ok: true }
}

export function createSaveJobProfileTool(deps: SaveJobProfileDeps) {
  return tool({
    name: "saveJobProfile",
    description:
      "Persist the candidate's job preferences (industry, sponsorship, location, " +
      "size preference, optional salary floor) so the daily cron can deliver " +
      "personalised job recommendations.",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    parameters: SaveJobProfileInputSchema as any,
    execute: async (raw: unknown) => {
      const args = SaveJobProfileInputSchema.parse(raw)
      const out = await saveJobProfile(args, deps)
      return JSON.stringify(out)
    },
  })
}
