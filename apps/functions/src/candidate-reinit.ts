/**
 * reinitializeCandidate — reset a candidate's GLOBAL profile back to a fresh, just-onboarded-from-
 * résumé state, while PRESERVING job-specific data. Implements the v2.0 principle "candidate is the
 * durable asset, job is an event": the global profile (memory, tags, conversation, onboarding) is
 * reset; job-specific data (matched jobs, prescreen sessions, candidate-job states) is kept.
 *
 * Flow (Adam spec 2026-05-29):
 *   1. ARCHIVE the conversation transcript (stored, never lost) → pa-conversation-archives.
 *   2. CACHE the parsed résumé + job-rec output (so the full reset below can't lose them).
 *   3. CLEAR the global profile via the canonical clearUserMemory (mem0/Qdrant + memory plane +
 *      transcript + user-doc reset: tags, onboardingState, displayName, derivedExperience, …).
 *   4. RESTORE the parsed résumé + job-rec output (preserve "matched jobs").
 *   5. RE-ENRICH: rebuild pa-users.tags from the parsed résumé via mergeUserTags.
 *   6. The candidate SELF-INITIATES the next conversation — we do NOT proactively outreach.
 *
 * Preserved automatically (clearUserMemory never touches them): matching-jobs (global catalog),
 * pa-prescreen-sessions, candidate-job-states, employer-visible snapshots. Explicitly cached+
 * restored: parsedCandidateResumes (résumé), pa-job-profiles + pa-job-rec-explanations (matches).
 *
 * Idempotent + fail-soft per step; returns a structured summary for operator/eval visibility.
 */
import type { Firestore } from "firebase-admin/firestore"
import { mergeUserTags as defaultMergeUserTags, type UserTagsInput } from "@pa/pa-orchestrator"

const PA_USERS = "pa-users"
const PA_MESSAGES = "pa-messages"
const CONVERSATION_ARCHIVES = "pa-conversation-archives"
const PARSED_RESUMES = "parsedCandidateResumes"
// Per-user job-rec output the full reset would wipe but the candidate's "matched jobs" depend on.
const PRESERVE_JOB_COLLECTIONS = ["pa-job-profiles", "pa-job-rec-explanations"] as const

export interface ReinitializeCandidateDeps {
  db: Firestore
  /** Canonical global wipe (mem0/Qdrant + memory plane + transcript + user-doc reset). Injected
   *  so callers bind the Qdrant creds, and tests can stub it. */
  clearMemory: (userId: string) => Promise<unknown>
  /** Defaults to @pa/pa-orchestrator mergeUserTags. */
  mergeUserTagsFn?: (input: UserTagsInput) => Record<string, unknown>
  nowIso?: () => string
  log?: (event: string, payload?: Record<string, unknown>) => void
}

export interface ReinitializeCandidateResult {
  userId: string
  archivedMessages: number
  cleared: boolean
  resumePreserved: boolean
  jobRecPreserved: Record<string, number>
  reEnriched: boolean
  tagKeys: string[]
  reEngageMode: "candidate_self_initiates"
}

/** Snapshot all docs (with refs) of a per-user collection so we can restore them after the wipe. */
async function snapshotUserDocs(
  db: Firestore,
  collection: string,
  userId: string,
): Promise<Array<{ id: string; data: Record<string, unknown> }>> {
  const out: Array<{ id: string; data: Record<string, unknown> }> = []
  const byUser = await db.collection(collection).where("userId", "==", userId).get()
  byUser.forEach((d) => out.push({ id: d.id, data: d.data() as Record<string, unknown> }))
  // parsedCandidateResumes is sometimes keyed by the uid directly (doc id == userId).
  if (out.length === 0) {
    const byId = await db.collection(collection).doc(userId).get()
    if (byId.exists) out.push({ id: byId.id, data: byId.data() as Record<string, unknown> })
  }
  return out
}

async function restoreDocs(
  db: Firestore,
  collection: string,
  docs: Array<{ id: string; data: Record<string, unknown> }>,
): Promise<number> {
  for (let i = 0; i < docs.length; i += 400) {
    const batch = db.batch()
    for (const d of docs.slice(i, i + 400)) batch.set(db.collection(collection).doc(d.id), d.data, { merge: true })
    if (docs.slice(i, i + 400).length) await batch.commit()
  }
  return docs.length
}

/** Compose mergeUserTags input from a stored parsed-résumé doc (best-effort over its fields). */
function tagsInputFromParsedResume(parsed: Record<string, unknown>): UserTagsInput {
  const skills = Array.isArray(parsed.topSkills)
    ? (parsed.topSkills as unknown[]).map((s) => (typeof s === "string" ? s : (s as { name?: string })?.name)).filter((s): s is string => !!s)
    : []
  const experiences = Array.isArray(parsed.experiences)
    ? (parsed.experiences as Array<Record<string, unknown>>).map((e) => ({
        title: typeof e.title === "string" ? e.title : "",
        company: typeof e.company === "string" ? e.company : "",
        description: typeof e.description === "string" ? e.description : "",
      }))
    : []
  const industryTags = Array.isArray(parsed.industryTags) ? (parsed.industryTags as string[]) : []
  const cv: UserTagsInput["cv"] = { candidateProfile: { skills }, experiences, industryTags }
  if (typeof parsed.totalYearsExperience === "number" && Number.isFinite(parsed.totalYearsExperience)) {
    cv.totalYearsExperience = parsed.totalYearsExperience as number
  }
  return { cv } as UserTagsInput
}

export async function reinitializeCandidate(
  userId: string,
  deps: ReinitializeCandidateDeps,
): Promise<ReinitializeCandidateResult> {
  const { db } = deps
  const log = deps.log ?? (() => {})
  const nowIso = deps.nowIso ?? (() => new Date().toISOString())
  const mergeUserTagsFn = deps.mergeUserTagsFn ?? defaultMergeUserTags
  const now = nowIso()
  log("reinit.start", { userId })

  // 1. ARCHIVE conversation (store before the wipe deletes it).
  const msgs = await db.collection(PA_MESSAGES).where("userId", "==", userId).get()
  const messages = msgs.docs.map((d) => ({ id: d.id, ...(d.data() as Record<string, unknown>) }))
  if (messages.length > 0) {
    await db.collection(CONVERSATION_ARCHIVES).add({ userId, archivedAt: now, messageCount: messages.length, reason: "reinitializeCandidate", messages })
  }
  log("reinit.archived", { userId, messageCount: messages.length })

  // 2. CACHE résumé + job-rec output (the full reset would wipe these).
  const resumeDocs = await snapshotUserDocs(db, PARSED_RESUMES, userId)
  const jobRecCache: Record<string, Array<{ id: string; data: Record<string, unknown> }>> = {}
  for (const c of PRESERVE_JOB_COLLECTIONS) jobRecCache[c] = await snapshotUserDocs(db, c, userId)

  // 3. CLEAR the global profile (canonical wipe — mem0 + memory plane + transcript + user-doc reset).
  await deps.clearMemory(userId)
  log("reinit.cleared", { userId })

  // 4. RESTORE résumé + job-rec (preserve matched jobs).
  await restoreDocs(db, PARSED_RESUMES, resumeDocs)
  const jobRecPreserved: Record<string, number> = {}
  for (const c of PRESERVE_JOB_COLLECTIONS) jobRecPreserved[c] = await restoreDocs(db, c, jobRecCache[c])

  // 5. RE-ENRICH tags from the (restored) parsed résumé.
  let reEnriched = false
  let tagKeys: string[] = []
  const parsed = resumeDocs[0]?.data
  if (parsed) {
    try {
      const tags = mergeUserTagsFn(tagsInputFromParsedResume(parsed))
      tags.schemaVersion = 2
      tags.lastUpdatedFromCv = now
      await db.collection(PA_USERS).doc(userId).set({ tags, updatedAt: now, reinitializedAt: now }, { merge: true })
      tagKeys = Object.keys(tags)
      reEnriched = true
    } catch (err) {
      log("reinit.reenrich_error", { userId, error: err instanceof Error ? err.message : String(err) })
    }
  } else {
    await db.collection(PA_USERS).doc(userId).set({ reinitializedAt: now, updatedAt: now }, { merge: true })
  }

  // 6. No proactive outreach — the candidate self-initiates the next conversation.
  log("reinit.done", { userId, reEnriched, tagKeys: tagKeys.length })
  return {
    userId,
    archivedMessages: messages.length,
    cleared: true,
    resumePreserved: resumeDocs.length > 0,
    jobRecPreserved,
    reEnriched,
    tagKeys,
    reEngageMode: "candidate_self_initiates",
  }
}
