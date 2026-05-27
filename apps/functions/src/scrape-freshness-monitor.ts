/**
 * paScrapeFreshnessMonitorDaily — daily watchdog over the macmini → Firestore
 * scrape pipeline.
 *
 * Why this exists
 * ---------------
 * 2026-05-22..27: macmini was unreachable (Tailscale/power) and the scrape
 * pipeline silently stopped feeding `matching-jobs`. Five days passed before
 * anyone noticed because nothing alerted. Active pool went stale (98% > 7d)
 * but the system still answered match queries with degraded results.
 *
 * This CF runs once a day, queries the newest `syncedAt` across active
 * matching-jobs, and posts a Slack alert (via existing
 * `postSlackAlert` helper) when the freshness budget is blown:
 *
 *   - `<24h since last sync`         → quiet, info log only
 *   - `24h ≤ stale < 48h`            → Slack warn
 *   - `stale ≥ 48h`                  → Slack error  (page-style header)
 *
 * Audit
 * -----
 * Every run writes a small document to `matching-jobs-monitor-runs/{runId}`
 * so we have a queryable trail of pipeline health independent of Cloud
 * Logging retention.
 *
 * REQ-IDs:
 *   - LIVE-05 (extends v1.6 LIVE-01..04 with watchdog telemetry)
 *
 * Tests
 * -----
 * Pure logic lives in `runScrapeFreshnessMonitor` and consumes injected
 * deps (`store`, `slack`, `now`, `log`). The exported `onSchedule` CF at
 * the bottom is a thin wrapper that wires Firestore + the production
 * Slack helper. Unit tests in `scrape-freshness-monitor.test.ts` cover
 * the three threshold bands and the "no docs found" defensive path.
 */

import { onSchedule } from "firebase-functions/v2/scheduler"
import { logger } from "firebase-functions/v2"
import { getApps, initializeApp } from "firebase-admin/app"
import { getFirestore, Timestamp } from "firebase-admin/firestore"

import { postSlackAlert, type SlackAlertResult } from "./lib/slack-alert.js"

// ---------------------------------------------------------------------------
// Thresholds — tunable here in one place so future review can change cadence
// without chasing literals across the file.
// ---------------------------------------------------------------------------

const HOUR_MS = 3600 * 1000
const WARN_AGE_HOURS = 24
const ERROR_AGE_HOURS = 48
const FRESH_WINDOW_HOURS = 24 // matches macmini daily pipeline cadence

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MonitorStore {
  /** Read newest active doc by `syncedAt`. Returns ms since epoch or null. */
  readNewestSyncedAtMs: () => Promise<number | null>
  /** Count active docs whose `syncedAt` ≥ cutoffMs. */
  countActiveSyncedSince: (cutoffMs: number) => Promise<number>
  /** Persist the run record for audit. Best-effort — failure does not throw. */
  writeRunRecord: (record: ScrapeMonitorRunRecord) => Promise<void>
}

export interface ScrapeMonitorRunRecord {
  runAt: Timestamp
  newestSyncedAtMs: number | null
  hoursSinceNewest: number | null
  freshDocsLast24h: number
  severity: "ok" | "warn" | "error"
  slackPosted: boolean
  slackReason?: string
}

export interface ScrapeMonitorResult {
  newestSyncedAtMs: number | null
  hoursSinceNewest: number | null
  freshDocsLast24h: number
  severity: "ok" | "warn" | "error"
  slackPosted: boolean
  slackReason?: string
}

export interface RunScrapeFreshnessMonitorDeps {
  store: MonitorStore
  postSlack: (
    title: string,
    message: string,
    level: "warn" | "error" | "info",
    fields: { name: string; value: string }[]
  ) => Promise<SlackAlertResult>
  now: () => number
  log: (msg: string, ctx?: Record<string, unknown>) => void
}

// ---------------------------------------------------------------------------
// Pure orchestration — no Firebase imports, fully testable.
// ---------------------------------------------------------------------------

export async function runScrapeFreshnessMonitor(
  deps: RunScrapeFreshnessMonitorDeps
): Promise<ScrapeMonitorResult> {
  const { store, postSlack, now, log } = deps
  const nowMs = now()

  const newest = await store.readNewestSyncedAtMs()
  const freshCutoff = nowMs - FRESH_WINDOW_HOURS * HOUR_MS
  const fresh = await store.countActiveSyncedSince(freshCutoff)

  const hoursSinceNewest =
    newest != null ? (nowMs - newest) / HOUR_MS : null

  // Decide severity. The "no docs found" case is treated as error so it
  // cannot silently degrade like the original incident.
  let severity: "ok" | "warn" | "error" = "ok"
  if (newest == null) {
    severity = "error"
  } else if (hoursSinceNewest != null && hoursSinceNewest >= ERROR_AGE_HOURS) {
    severity = "error"
  } else if (hoursSinceNewest != null && hoursSinceNewest >= WARN_AGE_HOURS) {
    severity = "warn"
  }

  log("scrape-freshness-monitor evaluated", {
    newestSyncedAtMs: newest,
    hoursSinceNewest,
    freshDocsLast24h: fresh,
    severity,
  })

  // Slack only when stale. ok = no alert noise.
  let slackPosted = false
  let slackReason: string | undefined
  if (severity !== "ok") {
    const fields: { name: string; value: string }[] = [
      {
        name: "Newest syncedAt",
        value:
          newest != null
            ? `${new Date(newest).toISOString()} (${hoursSinceNewest!.toFixed(1)}h ago)`
            : "(none — no active jobs found)",
      },
      {
        name: "Fresh docs <24h",
        value: String(fresh),
      },
      {
        name: "Warn / Error threshold",
        value: `${WARN_AGE_HOURS}h / ${ERROR_AGE_HOURS}h`,
      },
      {
        name: "Playbook",
        value: "wekruit-pa/.planning/RUNBOOK-scrape-dead.md",
      },
    ]
    const title =
      severity === "error"
        ? "Scrape pipeline DEAD"
        : "Scrape pipeline stale (warn)"
    const message =
      severity === "error"
        ? "Macmini → Firestore scrape pipeline has not delivered fresh jobs. Match quality is degrading. Check macmini reachability + launchd jobs."
        : "Macmini → Firestore scrape pipeline is older than 24h. Investigate before it crosses the 48h DEAD threshold."

    try {
      const result = await postSlack(title, message, severity, fields)
      slackPosted = result.posted
      slackReason = result.reason
    } catch (err) {
      slackReason = err instanceof Error ? err.message : String(err)
    }
  }

  const record: ScrapeMonitorRunRecord = {
    runAt: Timestamp.fromMillis(nowMs),
    newestSyncedAtMs: newest,
    hoursSinceNewest,
    freshDocsLast24h: fresh,
    severity,
    slackPosted,
    slackReason,
  }
  await store.writeRunRecord(record).catch((err) => {
    log("scrape-freshness-monitor audit write failed", {
      err: err instanceof Error ? err.message : String(err),
    })
  })

  return {
    newestSyncedAtMs: newest,
    hoursSinceNewest,
    freshDocsLast24h: fresh,
    severity,
    slackPosted,
    slackReason,
  }
}

// ---------------------------------------------------------------------------
// Production wiring — Firestore-backed store + the real Slack helper.
// ---------------------------------------------------------------------------

function ensureAdmin() {
  if (getApps().length === 0) initializeApp()
}

export function makeFirestoreStore(): MonitorStore {
  ensureAdmin()
  const db = getFirestore()

  return {
    readNewestSyncedAtMs: async () => {
      const snap = await db
        .collection("matching-jobs")
        .where("status", "==", "active")
        .orderBy("syncedAt", "desc")
        .limit(1)
        .get()
      if (snap.empty) return null
      const v = snap.docs[0].get("syncedAt")
      if (!v) return null
      if (typeof v === "object" && typeof (v as Timestamp).toMillis === "function") {
        return (v as Timestamp).toMillis()
      }
      if (typeof v === "string") {
        const ms = Date.parse(v)
        return Number.isFinite(ms) ? ms : null
      }
      if (typeof v === "number") return v
      return null
    },
    countActiveSyncedSince: async (cutoffMs: number) => {
      const cutoff = Timestamp.fromMillis(cutoffMs)
      const snap = await db
        .collection("matching-jobs")
        .where("status", "==", "active")
        .where("syncedAt", ">=", cutoff)
        .count()
        .get()
      return snap.data().count
    },
    writeRunRecord: async (record) => {
      await db.collection("matching-jobs-monitor-runs").add(record)
    },
  }
}

// ---------------------------------------------------------------------------
// Cloud Function — daily at 12:00 UTC (after macmini's usual sync window).
// ---------------------------------------------------------------------------

export const paScrapeFreshnessMonitorDaily = onSchedule(
  {
    schedule: "0 12 * * *",
    timeZone: "UTC",
    memory: "256MiB",
    timeoutSeconds: 120,
    region: "us-central1",
    secrets: ["PA_SLACK_ALERT_WEBHOOK"],
    retryCount: 0,
  },
  async () => {
    const result = await runScrapeFreshnessMonitor({
      store: makeFirestoreStore(),
      postSlack: (title, message, level, fields) =>
        postSlackAlert({ title, message, level, fields }),
      now: () => Date.now(),
      log: (msg, ctx) =>
        logger.info(`[scrape-freshness-monitor] ${msg}`, ctx ?? {}),
    })
    logger.info("[scrape-freshness-monitor] done", result)
  }
)
