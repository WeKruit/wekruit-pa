/**
 * Prescreen-NURTURE — scheduled Cloud Function.
 *
 * `paPrescreenNurtureScheduler` runs hourly: enumerates candidates with an
 * ongoing prescreen awaiting WeKruit review and, when the cadence says a
 * check-in is due, writes pending `pa-scheduled-jobs` rows that the existing
 * `paProactiveSweep` CF picks up and dispatches (Claire composes the actual
 * check-in copy in her voice).
 *
 * Gated on `paPrescreenNurtureEnabled` (default OFF) inside `scheduleNurtures`,
 * so this CF is inert until the flag is ramped. Fail-open: never throws into
 * the scheduler tick.
 */

import { onSchedule } from "firebase-functions/v2/scheduler"
import { logger } from "firebase-functions/v2"
import { getFirestore } from "firebase-admin/firestore"
import {
  scheduleNurtures,
  createFirestoreNurtureSchedulerStore,
} from "./prescreen-nurture-scheduler.js"

export const paPrescreenNurtureScheduler = onSchedule(
  {
    schedule: "every 60 minutes",
    region: "us-central1",
    memory: "512MiB",
    timeoutSeconds: 120,
    maxInstances: 1,
    retryCount: 0,
  },
  async () => {
    try {
      const db = getFirestore()
      const store = createFirestoreNurtureSchedulerStore(db, (...args) =>
        logger.info("[prescreen-nurture-scheduler]", ...args)
      )
      const result = await scheduleNurtures(store)
      if (!result.skipped && (result.scheduled > 0 || result.enumerated > 0)) {
        logger.info("[prescreen-nurture-scheduler] tick", result)
      }
    } catch (err) {
      logger.error("[prescreen-nurture-scheduler] fatal", {
        err: err instanceof Error ? err.message : String(err),
      })
    }
  }
)
