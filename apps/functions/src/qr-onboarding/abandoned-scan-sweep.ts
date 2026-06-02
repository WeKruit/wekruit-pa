/**
 * paQrScanAbandonedSweep — scheduled decrement sweep for abandoned QR scans.
 *
 * The scan-time number pick increments the per-group new-user counter at PICK
 * time (doc §3.2/§3.5) to defuse the two-scanners race. The cost is that a
 * scanner who reserved a number but never sent ("abandoned scan") still consumes
 * a slot. This hourly sweep returns those slots: for each `pa-qr-scan-pending`
 * doc still `status:'pending'` past the TTL it decrements that group's counter
 * and marks the doc 'abandoned'.
 */
import { onSchedule } from "firebase-functions/v2/scheduler"
import { getFirestore } from "firebase-admin/firestore"
import * as logger from "firebase-functions/logger"
import { decrementAssignedNewUsers } from "../sendblue/pool.js"
import { sweepAbandonedQrScans } from "./scan.js"

export const paQrScanAbandonedSweep = onSchedule(
  {
    schedule: "every 60 minutes",
    region: "us-central1",
    memory: "256MiB",
    timeoutSeconds: 120,
  },
  async () => {
    const db = getFirestore()
    try {
      const result = await sweepAbandonedQrScans(db, (groupId) =>
        decrementAssignedNewUsers(db, groupId)
      )
      if (result.scanned > 0 || result.errors > 0) {
        logger.info("paQrScanAbandonedSweep tick", result)
      }
    } catch (err) {
      logger.error("paQrScanAbandonedSweep fatal", {
        err: err instanceof Error ? err.message : String(err),
      })
    }
  }
)
