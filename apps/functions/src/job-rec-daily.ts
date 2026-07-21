/**
 * Stream B Task B4 — paJobRecDaily Cloud Function.
 *
 * Cron: every day at 09:00 PT (16:00 UTC) via firebase-functions/v2/scheduler.
 * Memory: 512MiB to match the platform floor (PA orchestrator 14MB bundle).
 *
 * Why this lives in apps/functions and not apps/job-rec: Firebase Functions
 * are deployed from `apps/functions/lib` only. The pure batch driver lives
 * in `@pa/job-rec` (greenfield package) and is imported here. The bundler
 * (apps/functions/build.mjs) inlines workspace deps so this works at deploy.
 *
 * Feature-flag gate: per-user `paJobRecEnabled` (default OFF, allowlist-driven).
 * The driver short-circuits per user when the flag returns false.
 */

import { onSchedule } from "firebase-functions/v2/scheduler"
import { logger } from "firebase-functions/v2"
import { getFirestore, type Firestore } from "firebase-admin/firestore"
import { withScheduledAlert } from "./lib/with-scheduled-alert.js"
import { MAILGUN_SECRETS, PA_SLACK_ALERT_WEBHOOK } from "./orchestrator-deps.js"
import {
  runDailyJobRecBatch,
  defaultUserEmbedFetcher,
  fetchTopKFromCluster,
  provisionCadenceAudience,
} from "@pa/job-rec"
import { getFlag } from "@pa/pa-persistence"
import { computeCvEmbedding } from "./lib/embeddings.js"
import { buildJobRecSendSpreadDeps } from "./job-rec-send-spread.js"

/**
 * Stream G1 — Production user-embedding computer. When daily-batch's
 * fetcher returns no cached embedding for a user with a parsed resume,
 * this lazy-computes via OpenAI text-embedding-3-small (1536-d) and
 * caches back to parsedCandidateResumes/{resumeId}.embedding for next
 * day's run. Fail-open: any error → return null → daily-batch falls
 * back to legacy keyword rank. Never throws.
 *
 * iter34 sprint B.9 — delegates to lib/embeddings.computeCvEmbedding so
 * cv-ingest (sync compute at parse time) and job-rec-daily (lazy fallback
 * for legacy rows) share a single OpenAI call path. Daily-batch invokes
 * this with a pre-synthesized `resumeText` string; we wrap the helper in
 * a minimal EmbeddingResumeInput so the same compute / cost-ledger path
 * runs end-to-end. The Firestore cache write-back is preserved so future
 * batches short-circuit on the cached vector.
 */
async function defaultUserEmbedComputer(
  db: Firestore,
  userId: string,
  resumeId: string,
  resumeText: string
): Promise<number[] | null> {
  try {
    // Wrap the legacy text-only contract inside the structured input the
    // shared helper expects. We surface the entire resumeText as a single
    // experience description so synthesizeCvSummaryText returns it intact
    // (≥ 20 chars triggers the embed; below that → null skip).
    const trimmed = resumeText.slice(0, 8000)
    const result = await computeCvEmbedding(
      {
        candidateProfile: { name: null },
        experiences: [{ description: trimmed }],
      },
      {
        costLabels: { caller: "job-rec-daily", userId, resumeId },
      }
    )
    if (!result) {
      logger.warn("[job-rec-daily] embed_compute_failed_or_skipped", { userId })
      return null
    }
    // Cache write-back. Best-effort; don't block return on Firestore success.
    void db
      .collection("parsedCandidateResumes")
      .doc(resumeId)
      .set(
        {
          embedding: result.vector,
          embeddingModel: result.model,
          embeddingDim: result.dim,
          embeddingComputedAt: result.computedAt,
        },
        { merge: true }
      )
      .catch((err) => {
        logger.warn("[job-rec-daily] embed_cache_writeback_failed", {
          userId,
          resumeId,
          error: err instanceof Error ? err.message : String(err),
        })
      })
    return result.vector
  } catch (err) {
    logger.error("[job-rec-daily] embed_compute_failed", {
      userId,
      error: err instanceof Error ? err.message : String(err),
    })
    return null
  }
}

export const paJobRecDaily = onSchedule(
  {
    region: "us-central1",
    schedule: "every day 09:00",
    timeZone: "America/Los_Angeles",
    // 2026-06-11: 512MiB OOM'd mid-batch on the first widened-audience run
    // (each user's V16 pass scans ~3k jobs; USER_CAP now 300). 2GiB gives the
    // batch headroom; timeout stays 540s (the run died on memory, not time).
    memory: "2GiB",
    timeoutSeconds: 540,
    retryCount: 0,
    // 2026-06-14 — alert channels so a silent batch failure pages ops.
    secrets: [PA_SLACK_ALERT_WEBHOOK, ...MAILGUN_SECRETS],
  },
  withScheduledAlert("paJobRecDaily", async () => {
    const db = getFirestore()
    try {
      // Audience widener pre-pass (2026-06-11, Adam: "every 2-3 days we should
      // send some job matching to users") — auto-provision minimal ACTIVE
      // pa-job-profiles rows for matched-ready users missing one (eligibility:
      // tags.targetRoleFunction + phoneE164 + !doNotContact + no open
      // prescreen). Idempotent (existing rows — incl. operator-paused — are
      // never touched) and ramped (≤60 new rows/run → fleet phases in over ~4
      // days). NEVER throws; the batch below always runs.
      const provisionOutcome = await provisionCadenceAudience({
        db,
        log: (event, payload) => logger.info("[job-rec-daily][provision]", event, payload ?? {}),
      })
      logger.info("[job-rec-daily] audience_provision_complete", provisionOutcome)

      // Time-spread (2026-06-02) — build the cadence/jitter/pacing deps. Loads
      // the Sendblue pool for sticky from-number + per-group dailySendCap and
      // wires Cloud Tasks delayed-enqueue when its env is present. Fail-open:
      // any gap degrades to the synchronous (still due-gated + paced) path.
      const spread = await buildJobRecSendSpreadDeps(db, {
        log: (event, payload) => logger.info("[job-rec-daily][spread]", event, payload ?? {}),
      })
      const result = await runDailyJobRecBatch({
        db,
        getFlag: (db, key, ctx, defaultValue) => getFlag(db, key, ctx, defaultValue),
        fromNumberForUser: spread.fromNumberForUser,
        numberCapacities: spread.numberCapacities,
        scheduleSend: spread.scheduleSend,
        // Stream G1 — full cascade: fetcher → computer (lazy + cache) → fallback.
        userEmbedFetcher: defaultUserEmbedFetcher,
        userEmbedComputer: defaultUserEmbedComputer,
        // Phase 51 (v1.5 / Stream-G.2) — TS-native tag cluster cache.
        // Flag-gated by paTagClusterRecEnabled; default OFF. Empty result
        // falls through to legacy queryMatchingJobs path (zero regression).
        tagClusterFetcher: (userTags, k) =>
          fetchTopKFromCluster(
            { db, log: (...args: unknown[]) => logger.info("[job-rec-daily/cluster]", ...args) },
            userTags,
            k
          ),
        log: (...args: unknown[]) => logger.info("[job-rec-daily]", ...args),
      })
      logger.info("[job-rec-daily] batch_complete", result)
    } catch (err) {
      logger.error("[job-rec-daily] fatal", {
        error: err instanceof Error ? err.message : String(err),
      })
      throw err
    }
  })
)
