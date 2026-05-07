/**
 * v1.8 — paMatchingJobsAutoEnrich Firestore trigger.
 *
 * Why this exists: macmini→Firestore sync CF (core-service `matching-api`)
 * does NOT derive roleFunction/industrySector/relevantTags/skills/jobType
 * /locationBuckets. Every nightly sync writes 6500+ docs with these fields
 * undefined → V16 hard filter drops everything. We can't easily modify the
 * sync CF (source not on local disk; only deployed zip survives).
 *
 * Fix: trigger on every matching-jobs write. If the doc lacks LLM-canonical
 * tags (or has stale enricherVersion), call paEnrichJobTags inline + update.
 * Loop-safe: trigger checks `enricherVersion === ENRICHER_VERSION` and bails.
 *
 * Cost: ~$0.0005 per new/changed doc. Pipeline writes ~6500 active docs/day,
 * but enricherVersion gate ensures we don't re-enrich unchanged docs after
 * trigger's own update.
 */

import { onDocumentWritten } from "firebase-functions/v2/firestore"
import { defineSecret } from "firebase-functions/params"
import { logger } from "firebase-functions/v2"
import { getFirestore } from "firebase-admin/firestore"
import { enrichJobTags } from "@pa/job-tag-enricher"
import { ANTHROPIC_API_KEY } from "./orchestrator-deps.js"

const PA_OPENAI_AGENT_API_KEY = defineSecret("PA_OPENAI_AGENT_API_KEY")

const ENRICHER_VERSION = "v1.8.1"

interface MatchingJobDoc {
  status?: string
  roleTitle?: string | null
  companyName?: string | null
  jobDescription?: string | null
  locationRaw?: string | null
  sourceRepo?: string | null
  contentHash?: string | null
  roleFunction?: string[] | null
  industrySector?: string[] | null
  relevantTags?: string[] | null
  requiredSkills?: unknown[] | null
  seniorityLevel?: string | null
  locationBuckets?: string[] | null
  jobType?: string | null
  enricherVersion?: string | null
  enricherContentHash?: string | null
}

function needsEnrichment(doc: MatchingJobDoc | undefined): boolean {
  if (!doc) return false
  if (doc.status !== "active") return false
  // Already enriched at current version + same content_hash → skip
  if (
    doc.enricherVersion === ENRICHER_VERSION &&
    doc.enricherContentHash === doc.contentHash
  ) {
    return false
  }
  // Need title to enrich
  if (!doc.roleTitle || doc.roleTitle.trim().length === 0) return false
  return true
}

export const paMatchingJobsAutoEnrich = onDocumentWritten(
  {
    document: "matching-jobs/{jobId}",
    region: "us-central1",
    secrets: [PA_OPENAI_AGENT_API_KEY, ANTHROPIC_API_KEY],
    cpu: 1,
    memory: "512MiB",
    timeoutSeconds: 60,
    // Concurrency keeps cost predictable per pipeline-sync burst.
    concurrency: 20,
  },
  async (event) => {
    const after = event.data?.after.data() as MatchingJobDoc | undefined
    const jobId = event.params.jobId

    if (!needsEnrichment(after)) {
      return
    }

    // Re-export to env for downstream library use
    const openAiKey = PA_OPENAI_AGENT_API_KEY.value().trim()
    if (openAiKey) process.env.PA_OPENAI_AGENT_API_KEY = openAiKey
    const anthropicKey = ANTHROPIC_API_KEY.value().trim()
    if (anthropicKey) process.env.ANTHROPIC_API_KEY = anthropicKey

    try {
      const result = await enrichJobTags({
        title: after!.roleTitle ?? "",
        companyName: after!.companyName ?? null,
        jobDescription: after!.jobDescription ?? null,
        locationRaw: after!.locationRaw ?? null,
        sourceRepo: after!.sourceRepo ?? null,
      })
      const t = result.tags

      const update: Record<string, unknown> = {
        roleFunction: t.roleFunction ?? [],
        industrySector: t.industrySector ?? [],
        relevantTags: t.relevantTags ?? [],
        requiredSkills: t.skills ?? [],
        locationBuckets: t.locationBuckets ?? after!.locationBuckets ?? [],
        jobType: t.jobType ?? after!.jobType ?? "other",
        enricherVersion: ENRICHER_VERSION,
        enricherContentHash: after!.contentHash ?? null,
        enricherEnrichedAt: new Date().toISOString(),
        enricherModelUsed: result.modelUsed ?? null,
        enricherTier: result.usedTier ?? null,
      }
      // Only override seniorityLevel if scraper hadn't computed one
      if (t.seniorityLevel && (!after!.seniorityLevel || after!.seniorityLevel === "mid_level")) {
        update.seniorityLevel = t.seniorityLevel
      }

      const db = getFirestore()
      await db.collection("matching-jobs").doc(jobId).update(update)

      logger.info("[auto-enrich] ok", {
        jobId,
        title: after!.roleTitle,
        roleFunction: t.roleFunction,
        skillsCount: (t.skills ?? []).length,
        modelUsed: result.modelUsed,
      })
    } catch (err) {
      logger.warn("[auto-enrich] failed — leaving doc as-is", {
        jobId,
        title: after!.roleTitle,
        error: err instanceof Error ? err.message : String(err),
      })
      // Don't throw — failed enrichment is recoverable on next pipeline run.
    }
  }
)
