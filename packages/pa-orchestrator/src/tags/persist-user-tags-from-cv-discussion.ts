/**
 * Resume discussion completion — persist merged `pa-users.tags` from the
 * parsed CV row when cv-ingest (or E2E synthetic `[cv-parsed]`) fires.
 *
 * `discussionPayload` is usually the inbound `rawMeta` from
 * `detectCvParsedEvent`: includes `triggerResumeId` OR a nested full CV blob.
 */

import type { Firestore } from "firebase-admin/firestore"
import {
  mergeUserTags,
  type UserTagsCvInput,
  type UserTagsInput,
} from "./user-tags-merger.js"
import { writeUserTagsFull } from "./user-tags-writer.js"

const PA_USERS = "pa-users"
const PARSED_CV = "parsedCandidateResumes"

async function resolveParsedCvRow(
  db: Firestore,
  discussionPayload: unknown
): Promise<Record<string, unknown> | null> {
  if (!discussionPayload || typeof discussionPayload !== "object") return null
  const p = discussionPayload as Record<string, unknown>
  const id = typeof p.triggerResumeId === "string" ? p.triggerResumeId.trim() : ""
  if (id) {
    const snap = await db.collection(PARSED_CV).doc(id).get()
    return snap.exists ? (snap.data() as Record<string, unknown>) : null
  }
  if ("candidateProfile" in p || "workHistory" in p || "topSkills" in p) {
    return p
  }
  const inner = p.data
  if (
    inner &&
    typeof inner === "object" &&
    ("candidateProfile" in inner || "workHistory" in inner || "topSkills" in inner)
  ) {
    return inner as Record<string, unknown>
  }
  return null
}

export async function persistUserTagsFromResumeDiscussionData(
  db: Firestore,
  userId: string,
  discussionPayload: unknown,
  log: (event: string, payload?: Record<string, unknown>) => void
): Promise<void> {
  const ts = new Date().toISOString()
  try {
    const row = await resolveParsedCvRow(db, discussionPayload)
    if (!row) {
      log("pa.onboarding.discussion.tags_skip", { userId, reason: "no_cv_row" })
      return
    }

    let userData: Record<string, unknown> | undefined
    try {
      const u = await db.collection(PA_USERS).doc(userId).get()
      if (u.exists) userData = u.data() as Record<string, unknown>
    } catch (err) {
      log("pa.onboarding.discussion.tags_user_read_err", {
        userId,
        error: err instanceof Error ? err.message : String(err),
      })
    }

    const statedPrefs = userData?.statedPreferences as UserTagsInput["statedPreferences"] | undefined
    const preferredLang =
      typeof userData?.preferredLang === "string"
        ? (userData.preferredLang as UserTagsInput["preferredLang"])
        : undefined

    const cp = row.candidateProfile as Record<string, unknown> | undefined
    const skillsFromProfile = Array.isArray(cp?.skills) ? cp.skills : undefined
    const topSkills = Array.isArray(row.topSkills) ? (row.topSkills as unknown[]) : undefined
    const candSkills =
      skillsFromProfile && skillsFromProfile.length > 0 ? skillsFromProfile : topSkills

    const cv: UserTagsCvInput = {}
    if (candSkills && candSkills.length > 0) {
      cv.candidateProfile = {
        skills: candSkills as NonNullable<UserTagsCvInput["candidateProfile"]>["skills"],
      }
    }
    if (Array.isArray(row.workHistory) && row.workHistory.length > 0) {
      cv.workHistory = row.workHistory as UserTagsCvInput["workHistory"]
    }
    if (Array.isArray(row.experiences) && row.experiences.length > 0) {
      cv.experiences = row.experiences as UserTagsCvInput["experiences"]
    }
    if (Array.isArray(row.industryTags) && row.industryTags.length > 0) {
      cv.industryTags = row.industryTags as string[]
    }
    if (Array.isArray(row.industrySector) && row.industrySector.length > 0) {
      cv.industrySector = row.industrySector as string[]
    }
    if (Array.isArray(row.relevantIndustry) && row.relevantIndustry.length > 0) {
      cv.relevantIndustry = row.relevantIndustry as string[]
    }
    if (Array.isArray(row.relevantSpecialization) && row.relevantSpecialization.length > 0) {
      cv.relevantSpecialization = row.relevantSpecialization as string[]
    }
    if (Array.isArray(row.proposedTags) && row.proposedTags.length > 0) {
      cv.proposedTags = row.proposedTags as string[]
    }
    const emb = row.embedding
    if (Array.isArray(emb) && emb.length === 1536) {
      cv.embedding = emb as number[]
      if (typeof row.embeddingModel === "string") cv.embeddingModel = row.embeddingModel
      if (typeof row.embeddingComputedAt === "string") cv.embeddingComputedAt = row.embeddingComputedAt
    }

    const hasCvSignal = Object.keys(cv).length > 0
    const merged = mergeUserTags({
      cv: hasCvSignal ? cv : undefined,
      statedPreferences: statedPrefs,
      preferredLang,
      cvUpdatedAt: ts,
    })

    await writeUserTagsFull(db, userId, merged as Record<string, unknown>, {
      source: "cv",
      log: (e, p) => log(e, p),
      nowIso: ts,
    })
  } catch (err) {
    log("pa.onboarding.discussion.tags_persist_error", {
      userId,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}
