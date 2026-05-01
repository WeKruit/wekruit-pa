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
import { getFirestore } from "firebase-admin/firestore"
import { runDailyJobRecBatch } from "@pa/job-rec"
import { getFlag } from "@pa/pa-persistence"

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
        // The batch driver wants `(db, key, ctx, defaultValue)` — adapt
        // pa-persistence's `getFlag` signature directly. `getFlag` returns
        // `unknown` (boolean | number); the driver coerces to boolean.
        getFlag: (db, key, ctx, defaultValue) => getFlag(db, key, ctx, defaultValue),
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
