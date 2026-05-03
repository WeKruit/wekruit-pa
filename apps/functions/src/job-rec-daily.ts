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
import {
  runDailyJobRecBatch,
  defaultUserEmbedFetcher,
  fetchTopKFromCluster,
} from "@pa/job-rec"
import { getFlag } from "@pa/pa-persistence"
import { logTokenSpend } from "./instrumentation/cost-logger.js"

/**
 * Stream G1 — Production user-embedding computer. When daily-batch's
 * fetcher returns no cached embedding for a user with a parsed resume,
 * this lazy-computes via OpenAI text-embedding-3-small (1536-d) and
 * caches back to parsedCandidateResumes/{resumeId}.embedding for next
 * day's run. Fail-open: any error → return null → daily-batch falls
 * back to legacy keyword rank. Never throws.
 */
async function defaultUserEmbedComputer(
  db: Firestore,
  userId: string,
  resumeId: string,
  resumeText: string
): Promise<number[] | null> {
  try {
    const apiKey =
      process.env.PA_OPENAI_AGENT_API_KEY?.trim() ||
      process.env.OPENAI_API_KEY?.trim() ||
      ""
    if (!apiKey) {
      logger.warn("[job-rec-daily] embed_compute_no_key", { userId })
      return null
    }
    const { default: OpenAI } = await import("openai")
    const client = new OpenAI({ apiKey })
    const resp = await client.embeddings.create({
      model: "text-embedding-3-small",
      input: resumeText.slice(0, 8000),
    })
    const vec = resp.data?.[0]?.embedding
    if (!vec || vec.length === 0) {
      logger.warn("[job-rec-daily] embed_compute_empty_response", { userId })
      return null
    }
    // Backlog #23 — cost-ledger wiring. Emit pa.spend.daily so the daily
    // metric reflects OpenAI embedding spend (~$0.02 / 1M input tokens at
    // 2026-Q1). Token count surfaced via resp.usage.prompt_tokens; falls
    // back to char-based estimate (4 chars/token) when usage absent.
    try {
      const usage = (resp as { usage?: { prompt_tokens?: number; total_tokens?: number } }).usage
      const tokens =
        usage?.prompt_tokens ?? usage?.total_tokens ?? Math.ceil(resumeText.slice(0, 8000).length / 4)
      logTokenSpend({
        kind: "embedding",
        service: "openai",
        model: "text-embedding-3-small",
        inputTokens: tokens,
        count: 1,
        labels: { caller: "job-rec-daily", userId, resumeId },
      })
    } catch {
      /* fail-open: cost-ledger never blocks production path */
    }
    // Cache write-back. Best-effort; don't block return on Firestore success.
    void db
      .collection("parsedCandidateResumes")
      .doc(resumeId)
      .set(
        {
          embedding: vec,
          embeddingModel: "text-embedding-3-small",
          embeddingDim: vec.length,
          embeddingComputedAt: new Date().toISOString(),
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
    return vec
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
    memory: "512MiB",
    timeoutSeconds: 540,
    retryCount: 0,
  },
  async () => {
    const db = getFirestore()
    try {
      const result = await runDailyJobRecBatch({
        db,
        getFlag: (db, key, ctx, defaultValue) => getFlag(db, key, ctx, defaultValue),
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
  }
)
