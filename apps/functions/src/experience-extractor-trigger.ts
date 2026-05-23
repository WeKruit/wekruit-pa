/**
 * EX1 PR-C — Firestore trigger that runs the experience extractor on
 * every new parsedCandidateResumes write.
 *
 * Flow:
 *   1. Trigger fires on `parsedCandidateResumes/{resumeId}` write.
 *   2. Read userId + workHistory + skills from the new doc.
 *   3. For each work-history entry, call extractWorkEntrySkills (cache-
 *      hit short-circuit applies, so repeat resumes are cheap).
 *   4. Aggregate via deriveExperienceModel.
 *   5. Write `derivedExperience` + `derivedExperienceVersion="v1"` to
 *      pa-users/{uid} (additive — never touches existing fields).
 *
 * Feature flag:
 *   Env `PA_EXPERIENCE_EXTRACTOR_LIVE=true` enables the side-effect path.
 *   When off, the trigger logs and returns without writing — useful for
 *   ramping in production without redeploying the rest of cv-ingest.
 *
 * Idempotency:
 *   Doc-level: skips when `derivedExperienceVersion === "v1"` AND
 *   `derivedExperienceContentHash === sha256(workHistory titles + dates)`
 *   already match. Otherwise re-runs and refreshes derivedExperience.
 *
 * Fail-open:
 *   Any failure logs + returns. Never crashes the cv-ingest write or
 *   any downstream consumer (parity with paMatchingJobsAutoEnrich's
 *   contract for resilient side effects).
 */

import { onDocumentWritten } from "firebase-functions/v2/firestore"
import { defineSecret } from "firebase-functions/params"
import { logger } from "firebase-functions/v2"
import { getFirestore, type Firestore } from "firebase-admin/firestore"
import { createHash } from "node:crypto"

import {
  computeEntryId,
  deriveExperienceModel,
  extractWorkEntrySkills,
  firestoreExtractionCache,
  type DeriveEntryInput,
  type WorkEntryExtractionInput,
} from "@pa/pa-experience-extractor"

const PA_OPENAI_AGENT_API_KEY = defineSecret("PA_OPENAI_AGENT_API_KEY")

const DERIVED_VERSION = "v1"

interface ParsedResumeDoc {
  userId?: unknown
  skills?: unknown
  workHistory?: unknown
}

interface RawWorkHistoryEntry {
  title?: unknown
  company?: unknown
  startDate?: unknown
  endDate?: unknown
  description?: unknown
  bullets?: unknown
  achievements?: unknown
}

function asStringOrNull(v: unknown): string | null {
  if (typeof v !== "string") return null
  const t = v.trim()
  return t.length > 0 ? t : null
}
function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return []
  return v.filter((x): x is string => typeof x === "string" && x.trim().length > 0)
}
function asWorkHistory(v: unknown): RawWorkHistoryEntry[] {
  if (!Array.isArray(v)) return []
  return v.filter((x): x is RawWorkHistoryEntry => !!x && typeof x === "object")
}

/**
 * Returns the live feature-flag state for the trigger. Env var so
 * operators can flip it without a deploy (`firebase functions:secrets:set`
 * isn't needed for a plain env var — set on the function config).
 */
export function isExperienceExtractorLive(env: NodeJS.ProcessEnv = process.env): boolean {
  return env["PA_EXPERIENCE_EXTRACTOR_LIVE"] === "true"
}

/** sha256 of normalized work-history fields → cheap content-hash gate. */
export function computeWorkHistoryHash(
  workHistory: ReadonlyArray<RawWorkHistoryEntry>
): string {
  const h = createHash("sha256")
  for (const wh of workHistory) {
    h.update(asStringOrNull(wh.title) ?? "")
    h.update("\x00")
    h.update(asStringOrNull(wh.company) ?? "")
    h.update("\x00")
    h.update(asStringOrNull(wh.startDate) ?? "")
    h.update("\x00")
    h.update(asStringOrNull(wh.endDate) ?? "")
    h.update("\x01")
  }
  return h.digest("hex").slice(0, 32)
}

export interface RunExperienceExtractorArgs {
  db: Firestore
  uid: string
  workHistory: ReadonlyArray<RawWorkHistoryEntry>
  claimedSkills: string[]
  openaiApiKey: string | undefined
  /** Override for tests; defaults to the env-var flag check. */
  isLive?: boolean
  /** Override for tests so we can pin "now". */
  now?: Date
}

export interface RunExperienceExtractorResult {
  status:
    | "disabled"
    | "no_work_history"
    | "already_at_version"
    | "written"
    | "no_extracted_entries"
  uid: string
  entriesProcessed: number
  cacheHits: number
  llmCalls: number
}

/**
 * Core handler — exported so it can be invoked directly from tests and
 * (optionally) from other side-effect chains without the Firestore
 * trigger envelope.
 */
export async function runExperienceExtractorForUser(
  args: RunExperienceExtractorArgs
): Promise<RunExperienceExtractorResult> {
  const isLive = args.isLive ?? isExperienceExtractorLive()
  if (!isLive) {
    return {
      status: "disabled",
      uid: args.uid,
      entriesProcessed: 0,
      cacheHits: 0,
      llmCalls: 0,
    }
  }
  if (args.workHistory.length === 0) {
    return {
      status: "no_work_history",
      uid: args.uid,
      entriesProcessed: 0,
      cacheHits: 0,
      llmCalls: 0,
    }
  }

  const contentHash = computeWorkHistoryHash(args.workHistory)
  const userRef = args.db.collection("pa-users").doc(args.uid)

  // Idempotency: skip if version + content hash already match.
  const existing = await userRef.get()
  const existingData = existing.exists ? (existing.data() ?? {}) : {}
  if (
    existingData["derivedExperienceVersion"] === DERIVED_VERSION &&
    existingData["derivedExperienceContentHash"] === contentHash
  ) {
    return {
      status: "already_at_version",
      uid: args.uid,
      entriesProcessed: args.workHistory.length,
      cacheHits: 0,
      llmCalls: 0,
    }
  }

  const cache = firestoreExtractionCache(args.db)
  const deriveInputs: DeriveEntryInput[] = []
  let cacheHits = 0
  let llmCalls = 0

  for (let index = 0; index < args.workHistory.length; index++) {
    const wh = args.workHistory[index]!
    const title = asStringOrNull(wh.title) ?? ""
    if (!title) continue
    const startDate = asStringOrNull(wh.startDate)
    const endDate = asStringOrNull(wh.endDate)
    const entryId = computeEntryId({ uid: args.uid, index, title, startDate })

    const input: WorkEntryExtractionInput = {
      entryId,
      title,
      company: asStringOrNull(wh.company) ?? "(unknown)",
      startDate,
      endDate,
      description: asStringOrNull(wh.description),
      bullets: asStringArray(wh.bullets),
      achievements: asStringArray(wh.achievements),
      candidateSkills: args.claimedSkills,
    }

    const { output, source } = await extractWorkEntrySkills({
      uid: args.uid,
      input,
      cache,
      openaiApiKey: args.openaiApiKey,
      now: args.now,
    })
    if (source === "cache") cacheHits++
    else llmCalls++
    deriveInputs.push({ output, startDate, endDate, title })
  }

  if (deriveInputs.length === 0) {
    return {
      status: "no_extracted_entries",
      uid: args.uid,
      entriesProcessed: 0,
      cacheHits,
      llmCalls,
    }
  }

  const derived = deriveExperienceModel({
    entries: deriveInputs,
    claimedSkills: args.claimedSkills,
    now: args.now?.toISOString(),
  })

  await userRef.set(
    {
      derivedExperience: derived,
      derivedExperienceVersion: DERIVED_VERSION,
      derivedExperienceContentHash: contentHash,
    },
    { merge: true }
  )

  return {
    status: "written",
    uid: args.uid,
    entriesProcessed: deriveInputs.length,
    cacheHits,
    llmCalls,
  }
}

/**
 * Firestore trigger: every write to `parsedCandidateResumes/{resumeId}`
 * fans out to the extractor. The handler is fail-open and feature-flagged.
 */
export const paExperienceExtractorOnParsedResume = onDocumentWritten(
  {
    document: "parsedCandidateResumes/{resumeId}",
    secrets: [PA_OPENAI_AGENT_API_KEY],
    // Side-effect path; if it takes longer than a few seconds something
    // is wrong, but give it room for slow LLM calls on big workHistories.
    timeoutSeconds: 180,
    memory: "512MiB",
  },
  async (event) => {
    const after = event.data?.after?.data() as ParsedResumeDoc | undefined
    if (!after) {
      // delete event; nothing to do
      return
    }
    const uid = asStringOrNull(after.userId)
    if (!uid) {
      logger.warn("[experience-extractor] skip_no_userId", {
        resumeId: event.params["resumeId"],
      })
      return
    }
    const claimedSkills = asStringArray(after.skills)
    const workHistory = asWorkHistory(after.workHistory)

    try {
      const result = await runExperienceExtractorForUser({
        db: getFirestore(),
        uid,
        workHistory,
        claimedSkills,
        openaiApiKey: PA_OPENAI_AGENT_API_KEY.value(),
      })
      logger.info("[experience-extractor] result", result)
    } catch (err) {
      // Fail-open: log and move on. Parity with paMatchingJobsAutoEnrich.
      logger.error("[experience-extractor] error", {
        uid,
        resumeId: event.params["resumeId"],
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }
)
