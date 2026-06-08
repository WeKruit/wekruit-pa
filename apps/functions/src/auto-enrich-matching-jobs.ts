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
 *
 * v1.7 P64 sponsorship wiring (2026-05-08): the trigger was the canonical
 * inline enricher path but never populated `sponsorship`, so v1.6 D4 visa
 * hard filter was silently permissive (5.6% boolean coverage on 2000-job
 * probe pre-fix). After enrichJobTags() succeeds, we run the dedicated
 * `inferSponsorship()` two-tier helper (allowlist → LLM JD inference) and
 * write `sponsorship`, `sponsorshipSource`, `sponsorshipConfidence`,
 * `sponsorshipBackfilledAt` into the SAME Firestore update — one extra
 * Firestore read per allowlist hit, one extra LLM call per miss (graceful
 * null when keys absent). Idempotent: skip when sponsorship is already
 * boolean (trusted upstream/allowlist) and `sponsorshipBackfilledAt` is
 * stamped.
 *
 * Bumped ENRICHER_VERSION → v1.9.0 so existing docs (5500+ at v1.8.1) all
 * re-enrich on their next pipeline-sync write and pick up sponsorship.
 */

import { createHash } from "node:crypto"
import { onDocumentWritten } from "firebase-functions/v2/firestore"
import { defineSecret } from "firebase-functions/params"
import { logger } from "firebase-functions/v2"
import { getFirestore } from "firebase-admin/firestore"
import { enrichJobTags } from "@pa/job-tag-enricher"
import { ANTHROPIC_API_KEY } from "./orchestrator-deps.js"
import { inferSponsorship } from "./lib/sponsorship-inference.js"
import { isJobRecCardEnabled, pregenerateRecCardForJob } from "./job-rec-card/job-rec-card.js"

const PA_OPENAI_AGENT_API_KEY = defineSecret("PA_OPENAI_AGENT_API_KEY")
const SILICONFLOW_API_KEY = defineSecret("SILICONFLOW_API_KEY")

const ENRICHER_VERSION = "v1.9.0"

/**
 * Cost fix (2026-06-01): the upstream `contentHash` = sha256(company + RAW title)
 * churns on cosmetic title drift (emoji/case/punctuation) on every macmini
 * re-scrape, while the normalized `job_id` stays stable. That asymmetry re-fired
 * the full enrich + sponsorship pipeline on already-enriched ACTIVE jobs — ~98%
 * of daily enrichment LLM spend was recomputing the identical answer (294/300
 * sampled). We instead gate on a STABLE SEMANTIC hash computed here from the
 * LLM-relevant inputs: normalized title + normalized company + the trimmed JD
 * BODY. Cosmetic drift no longer fires; a genuine JD-body change (or a title
 * change reflected in the body) still re-enriches. This changes only WHEN we
 * enrich — never the enrichment output, any hard filter, or any match score.
 * `enricherContentHash` is still written so rollback is a one-line gate revert
 * with zero data migration.
 */
function normSemantic(s: string | null | undefined): string {
  return (s ?? "")
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}]+/gu, " ") // collapse non-alphanumeric runs (emoji/punct/space) → single space
    .replace(/\s+/g, " ")
    .trim()
}

export function computeSemanticHash(doc: MatchingJobDoc): string {
  return createHash("sha256")
    .update(
      [normSemantic(doc.roleTitle), normSemantic(doc.companyName), (doc.jobDescription ?? "").trim()].join(
        "",
      ),
    )
    .digest("hex")
}

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
  enricherSemanticHash?: string | null
  sponsorship?: boolean | null
  sponsorshipSource?: string | null
  sponsorshipConfidence?: number | null
  sponsorshipBackfilledAt?: string | null
  sponsorshipSemanticHash?: string | null
  // Collab rec-card pre-gen inputs/outputs.
  wekruitCollaborationStatus?: string | null
  isWekruitCollab?: boolean | null
  jobTitle?: string | null
  salaryMin?: number | null
  salaryMax?: number | null
  atsApplyUrl?: string | null
  primaryUrl?: string | null
  recCardMediaUrl?: string | null
  recCardContentHash?: string | null
}

export function needsEnrichment(doc: MatchingJobDoc | undefined): boolean {
  if (!doc) return false
  if (doc.status !== "active") return false
  // Already enriched at current version AND the SEMANTIC content is unchanged →
  // skip. Gating on the stable semantic hash (not the volatile upstream
  // contentHash) is the cost fix: cosmetic title/company drift on a re-scrape no
  // longer re-fires the LLM. A real JD-body change flips the hash → re-enriches.
  if (
    doc.enricherVersion === ENRICHER_VERSION &&
    doc.enricherSemanticHash === computeSemanticHash(doc)
  ) {
    return false
  }
  // Need title to enrich
  if (!doc.roleTitle || doc.roleTitle.trim().length === 0) return false
  return true
}

/**
 * Decide whether to run sponsorship inference for this doc. Skip when:
 *   - sponsorship is already an explicit boolean AND a backfill stamp exists
 *     (trusted upstream/allowlist value — don't overwrite or pay LLM cost).
 *
 * Otherwise return true to run inference. Note we DO re-attempt jobs whose
 * sponsorship is null/undefined even if `sponsorshipBackfilledAt` is set,
 * because the trigger fires on doc-content changes (new JD body) which may
 * now contain explicit sponsorship language.
 */
export function needsSponsorshipInference(doc: MatchingJobDoc | undefined): boolean {
  if (!doc) return false
  // Already inferred for this exact semantic content (INCLUDING a prior null
  // verdict) → skip. This co-gates sponsorship on the same stable hash so the
  // null-sponsorship cohort — which never sets sponsorshipBackfilledAt and thus
  // re-paid an LLM call on every re-scrape — stops churning. A real JD-body
  // change flips the hash → re-infers (new sponsorship language is still caught).
  if (doc.sponsorshipSemanticHash && doc.sponsorshipSemanticHash === computeSemanticHash(doc)) {
    return false
  }
  const s = doc.sponsorship
  if (
    (s === true || s === false) &&
    typeof doc.sponsorshipBackfilledAt === "string" &&
    doc.sponsorshipBackfilledAt.length > 0
  ) {
    return false
  }
  return true
}

export const paMatchingJobsAutoEnrich = onDocumentWritten(
  {
    document: "matching-jobs/{jobId}",
    region: "us-central1",
    secrets: [PA_OPENAI_AGENT_API_KEY, ANTHROPIC_API_KEY, SILICONFLOW_API_KEY],
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
    let siliconflowKey = ""
    try {
      siliconflowKey = SILICONFLOW_API_KEY.value().trim()
    } catch {
      // Optional secret — graceful when unset.
    }

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
        enricherContentHash: after!.contentHash ?? null, // KEEP — observability + one-line rollback
        enricherSemanticHash: computeSemanticHash(after!), // the real skip-gate (stable across cosmetic re-scrapes)
        enricherEnrichedAt: new Date().toISOString(),
        enricherModelUsed: result.modelUsed ?? null,
        enricherTier: result.usedTier ?? null,
      }
      // Only override seniorityLevel if scraper hadn't computed one
      if (t.seniorityLevel && (!after!.seniorityLevel || after!.seniorityLevel === "mid_level")) {
        update.seniorityLevel = t.seniorityLevel
      }

      const db = getFirestore()

      // P64 wiring: sponsorship inference (allowlist → LLM JD).
      // Runs AFTER enrichJobTags so we benefit from any normalized fields,
      // but uses the ORIGINAL companyName/JD as input (the inference helper
      // is robust to either). Failures never abort the enrichment write.
      if (needsSponsorshipInference(after)) {
        try {
          const sp = await inferSponsorship(
            {
              jobTitle: after!.roleTitle ?? "",
              companyName: after!.companyName ?? null,
              jobDescription: after!.jobDescription ?? null,
            },
            {
              db,
              openaiApiKey: openAiKey || undefined,
              anthropicApiKey: anthropicKey || undefined,
              siliconflowApiKey: siliconflowKey || undefined,
            },
          )
          update.sponsorship = sp.sponsorship
          update.sponsorshipSource = sp.source
          update.sponsorshipConfidence = sp.confidence
          update.sponsorshipBackfilledAt = new Date().toISOString()
          // Stamp the semantic hash even on a NULL verdict so the null cohort
          // stops re-inferring on every cosmetic re-scrape (co-gate, see needsSponsorshipInference).
          update.sponsorshipSemanticHash = computeSemanticHash(after!)
          if (typeof sp.reasoning === "string" && sp.reasoning.length > 0) {
            update.sponsorshipReasoning = sp.reasoning
          }
        } catch (spErr) {
          // inferSponsorship is documented "NEVER throws", but defensively
          // catch anyway — partial enrichment write is better than abort.
          logger.warn("[auto-enrich] sponsorship_inference_threw", {
            jobId,
            error: spErr instanceof Error ? spErr.message : String(spErr),
          })
        }
      }

      await db.collection("matching-jobs").doc(jobId).update(update)

      logger.info("[auto-enrich] ok", {
        jobId,
        title: after!.roleTitle,
        roleFunction: t.roleFunction,
        skillsCount: (t.skills ?? []).length,
        modelUsed: result.modelUsed,
        sponsorship: update.sponsorship ?? null,
        sponsorshipSource: update.sponsorshipSource ?? null,
      })

      // DURABLE rec-card pre-gen (Adam: "generate on creation"): a WeKruit collab
      // row must carry a ready recCardMediaUrl BEFORE any candidate is matched, so
      // the send path is a pure cache read (never lazy at send time). Gated to
      // collab inventory only (partner roles), idempotent (skips when the cached
      // url+hash already match this content), and FAIL-OPEN — a card-gen miss never
      // re-throws into the trigger.
      //
      // SECRET GATE: this needs Sendblue media creds (SENDBLUE_API_KEY_ID /
      // SENDBLUE_API_SECRET_KEY). They are NOT yet in this CF's `secrets:[]` array
      // (wiring prod secrets into a CF is Adam-gated). Until Adam adds them, the env
      // vars are absent → pregenerateRecCardForJob returns `skipped_no_creds` (no-op),
      // and the manual `generate-rec-cards.mjs` backfill covers existing collab cards.
      const isCollab =
        (after!.wekruitCollaborationStatus ?? null) === "collaborated" ||
        after!.isWekruitCollab === true
      if (isCollab && isJobRecCardEnabled()) {
        const apiKeyId = (process.env.SENDBLUE_API_KEY_ID ?? "").trim()
        const apiSecretKey = (process.env.SENDBLUE_API_SECRET_KEY ?? "").trim()
        if (apiKeyId && apiSecretKey) {
          try {
            // The freshly-written tag fields (update) take precedence over the
            // pre-write doc (after) for the card payload (e.g. requiredSkills).
            const cardRes = await pregenerateRecCardForJob({
              db,
              jobId,
              job: {
                companyName: after!.companyName ?? null,
                jobTitle: after!.jobTitle ?? after!.roleTitle ?? null,
                roleTitle: after!.roleTitle ?? null,
                seniorityLevel: (update.seniorityLevel as string | null) ?? after!.seniorityLevel ?? null,
                salaryMin: typeof after!.salaryMin === "number" ? after!.salaryMin : null,
                salaryMax: typeof after!.salaryMax === "number" ? after!.salaryMax : null,
                locationRaw: after!.locationRaw ?? null,
                jobType: (update.jobType as string | null) ?? after!.jobType ?? null,
                atsApplyUrl: after!.atsApplyUrl ?? null,
                primaryUrl: after!.primaryUrl ?? null,
                // requiredSkills may be bucketed Skill objects, not strings; topSkills
                // reads defensively (cleanStr drops non-strings) so a loose cast is safe.
                requiredSkills: ((update.requiredSkills ?? after!.requiredSkills ?? null) as string[] | null),
              },
              cached: {
                mediaUrl: after!.recCardMediaUrl ?? null,
                contentHash: after!.recCardContentHash ?? null,
              },
              creds: { apiKeyId, apiSecretKey },
              log: (event, payload) => logger.info(`[auto-enrich] ${event}`, payload ?? {}),
            })
            logger.info("[auto-enrich] rec_card_pregen", { jobId, status: cardRes.status })
          } catch (cardErr) {
            logger.warn("[auto-enrich] rec_card_pregen_threw", {
              jobId,
              error: cardErr instanceof Error ? cardErr.message : String(cardErr),
            })
          }
        }
      }
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
