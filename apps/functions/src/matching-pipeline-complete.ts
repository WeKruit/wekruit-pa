/**
 * v1.5 Stream-A2 / Phase 47.1 — paMatchingPipelineComplete handler.
 *
 * Mac mini cron (`scripts/daily-update.sh`) POSTs here after each daily
 * scrape+enrich+embed+sync run so wekruit-pa knows new jobs landed.
 *
 * Pipeline:
 *   1. HMAC-SHA256 verify (header `x-pa-signature`, secret
 *      PA_MATCHING_WEBHOOK_SECRET) — 401 on fail.
 *   2. Parse JSON body — 400 on malformed.
 *   3. Timestamp window check (header `x-pa-timestamp`, ±5min) — 401 on stale.
 *   4. Validate required fields (status, scrapeStartedAt, scrapeFinishedAt) — 400.
 *   5. Feature flag `paMatchingPipelineWebhookEnabled` — 503 when off.
 *   6. Per-source rate limit: soft 1/hr, hard 24/day — 429 on hard cap.
 *   7. Write `pa-matching-pipeline-runs/{runId}` doc.
 *   8. If status="success" && jobsNew > 0 → emit `pa-events` doc with
 *      eventKind="matching:pipeline:completed".
 *   9. Reply 200 {ok, runId}.
 *
 * The handler stays pure (deps-injected) so unit tests can drive it
 * without live Firestore. Production wiring lives in `index.ts`.
 *
 * Architecture rationale:
 *   - Handler lives at `apps/functions/src/matching-pipeline-complete.ts`
 *     (flat layout matches existing `upstream-event-webhook.ts` neighbour).
 *     The brief mentioned `apps/functions/src/upstream/` but no such dir
 *     exists — flattening avoids spurious dir creation. WEKRUIT-MATCHING-
 *     PATCH.md notes this so the path matches the deployed CF.
 *   - Reuses `verifyUpstreamSignature` for the HMAC primitive (same
 *     algo: hex HMAC-SHA256 over raw body). Header extraction is local
 *     because brief specifies `x-pa-signature` distinct from upstream
 *     event connector's `x-pa-upstream-signature`, and we add a separate
 *     `x-pa-timestamp` header for replay protection.
 */

import type { Firestore } from "firebase-admin/firestore"
import { getFlag } from "@pa/pa-persistence"

import { verifyUpstreamSignature } from "./upstream-hmac.js"

export const MATCHING_PIPELINE_FLAG_KEY = "paMatchingPipelineWebhookEnabled"
export const PIPELINE_RUNS_COLLECTION = "pa-matching-pipeline-runs"
export const PIPELINE_RATE_BUCKETS_COLLECTION = "pa-matching-pipeline-rate"
export const PA_EVENTS_COLLECTION = "pa-events"

/** ±5 min replay window. */
export const TIMESTAMP_WINDOW_MS = 5 * 60 * 1000

/** Soft cap (warn-log). */
export const SOFT_LIMIT_PER_HOUR = 1
/** Hard cap → 429. */
export const HARD_LIMIT_PER_DAY = 24

export type WebhookRequest = {
  rawBody?: Buffer | string
  body?: unknown
  headers: Record<string, string | string[] | undefined>
  method?: string
}

export type WebhookResponse = {
  status(code: number): WebhookResponse
  json(body: unknown): WebhookResponse
}

export type MatchingPipelineCompletePayload = {
  runId?: string
  status?: "success" | "failed" | "partial"
  scrapeStartedAt?: string
  scrapeFinishedAt?: string
  jobsScraped?: number
  jobsNew?: number
  jobsUpdated?: number
  jobsErrored?: number
  costUsd?: number
  sourceRepos?: string[]
  error?: string
  [k: string]: unknown
}

export type FailureAlertEmailInput = {
  status: "failed" | "partial"
  runId: string
  payload: MatchingPipelineCompletePayload
  receivedAt: string
}

export type FailureAlertEmailFn = (
  input: FailureAlertEmailInput
) => Promise<{ ok: boolean; reason?: string }>

export type FailureAlertSlackFn = (
  input: FailureAlertEmailInput
) => Promise<{ posted: boolean; reason?: string }>

export type MatchingPipelineCompleteDeps = {
  db: Firestore
  /** HMAC shared secret (PA_MATCHING_WEBHOOK_SECRET). */
  secret: string
  /** ISO clock; injectable for tests. */
  nowIso?: () => string
  /** Epoch ms; injectable for tests (timestamp + rate-limit). */
  nowMs?: () => number
  /** UUID factory; default randomUUID. */
  newId?: () => string
  log?: (...args: unknown[]) => void
  /**
   * Failure-path alert email dispatcher. Called when body.status is "failed"
   * or "partial" after the run doc is persisted. Optional: when undefined,
   * the failure-alert step is silently skipped (used by tests that don't
   * care about alerting). Failures inside this function are caught and
   * logged — they never block the 200 response (macmini cannot retry
   * because Mailgun is degraded; that would just blow rate-limit budget).
   */
  sendFailureAlertEmail?: FailureAlertEmailFn
  /**
   * Failure-path Slack alert dispatcher. Same contract as the email path:
   * optional, fail-graceful. When `PA_SLACK_ALERT_WEBHOOK` is unset, the
   * production wrapper passes a no-op stub so callers do not need to gate.
   */
  sendFailureAlertSlack?: FailureAlertSlackFn
}

const VALID_STATUSES = new Set(["success", "failed", "partial"])

function reply(res: WebhookResponse, status: number, body: unknown): void {
  res.status(status).json(body)
}

function safeIso(deps: MatchingPipelineCompleteDeps): string {
  return (deps.nowIso ?? (() => new Date().toISOString()))()
}

function safeNowMs(deps: MatchingPipelineCompleteDeps): number {
  return (deps.nowMs ?? (() => Date.now()))()
}

function newRunId(deps: MatchingPipelineCompleteDeps): string {
  if (deps.newId) return deps.newId()
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { randomUUID } = require("node:crypto") as { randomUUID: () => string }
  return randomUUID()
}

function extractHeader(
  headers: Record<string, string | string[] | undefined>,
  name: string
): string | undefined {
  const lc = name.toLowerCase()
  const value = headers[lc] ?? headers[name] ?? headers[name.toUpperCase()]
  if (typeof value === "string" && value.length > 0) return value
  if (Array.isArray(value) && value.length > 0 && typeof value[0] === "string") {
    return value[0]
  }
  return undefined
}

function extractSignature(
  headers: Record<string, string | string[] | undefined>
): string | undefined {
  return extractHeader(headers, "x-pa-signature")
}

function extractTimestampMs(
  headers: Record<string, string | string[] | undefined>
): number | undefined {
  const raw = extractHeader(headers, "x-pa-timestamp")
  if (!raw) return undefined
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) return undefined
  return Math.floor(n)
}

function isValidIso(v: unknown): v is string {
  if (typeof v !== "string" || v.length === 0) return false
  const t = Date.parse(v)
  return Number.isFinite(t)
}

function bucketIdFor(nowMs: number, granularity: "hour" | "day"): string {
  const date = new Date(nowMs)
  const y = date.getUTCFullYear()
  const m = String(date.getUTCMonth() + 1).padStart(2, "0")
  const d = String(date.getUTCDate()).padStart(2, "0")
  if (granularity === "day") return `day-${y}${m}${d}`
  const h = String(date.getUTCHours()).padStart(2, "0")
  return `hour-${y}${m}${d}${h}`
}

/**
 * Per-source rate-limit. Returns `{ allowed, hourCount, dayCount, hourBucket, dayBucket }`.
 * Caller emits warn log if hourCount > SOFT_LIMIT_PER_HOUR. Hard cap is dayCount > HARD_LIMIT_PER_DAY → 429.
 *
 * Implementation: increment per-source hour and day counter docs in a
 * runTransaction so concurrent calls cannot race past the hard cap.
 */
async function checkAndIncrementRateLimit(
  db: Firestore,
  sourceKey: string,
  nowMs: number
): Promise<{
  allowed: boolean
  hourCount: number
  dayCount: number
  hourBucket: string
  dayBucket: string
}> {
  const hourBucket = bucketIdFor(nowMs, "hour")
  const dayBucket = bucketIdFor(nowMs, "day")
  const hourId = `${sourceKey}__${hourBucket}`
  const dayId = `${sourceKey}__${dayBucket}`
  const hourRef = db.collection(PIPELINE_RATE_BUCKETS_COLLECTION).doc(hourId)
  const dayRef = db.collection(PIPELINE_RATE_BUCKETS_COLLECTION).doc(dayId)

  return await db.runTransaction(async (tx) => {
    const [hourSnap, daySnap] = await Promise.all([tx.get(hourRef), tx.get(dayRef)])
    const hourPrev = (hourSnap.exists ? (hourSnap.data() as { count?: number }).count : 0) ?? 0
    const dayPrev = (daySnap.exists ? (daySnap.data() as { count?: number }).count : 0) ?? 0
    const hourNext = hourPrev + 1
    const dayNext = dayPrev + 1
    if (dayNext > HARD_LIMIT_PER_DAY) {
      // Don't increment when blocking — keeps the counter honest.
      return {
        allowed: false,
        hourCount: hourPrev,
        dayCount: dayPrev,
        hourBucket,
        dayBucket,
      }
    }
    tx.set(hourRef, { count: hourNext, updatedAt: nowMs })
    tx.set(dayRef, { count: dayNext, updatedAt: nowMs })
    return {
      allowed: true,
      hourCount: hourNext,
      dayCount: dayNext,
      hourBucket,
      dayBucket,
    }
  })
}

/**
 * Compose subject + plaintext + html for failure-path alert email.
 *
 * Subject format (Adam-locked, do not change without P9 approval):
 *   "[WeKruit] 🔴 Pipeline FAILED — <runId> — <date>"  (status=failed)
 *   "[WeKruit] ⚠️ Pipeline PARTIAL — <runId> — <date>" (status=partial)
 *
 * Body bullet-list — every field that ops needs to triage without opening
 * Firestore: status, started/finished, jobs counters, errorMsg, runId,
 * source repos, plus a deep link to the Firestore run doc and Cloud Logging.
 */
export function composeFailureAlert(input: FailureAlertEmailInput): {
  subject: string
  text: string
  html: string
} {
  const { status, runId, payload, receivedAt } = input
  const dateOnly = (() => {
    const t = Date.parse(payload.scrapeFinishedAt ?? receivedAt)
    if (!Number.isFinite(t)) return "unknown-date"
    const d = new Date(t)
    return d.toISOString().slice(0, 10)
  })()
  const emoji = status === "failed" ? "🔴" : "⚠️"
  const word = status === "failed" ? "FAILED" : "PARTIAL"
  const subject = `[WeKruit] ${emoji} Pipeline ${word} — ${runId} — ${dateOnly}`

  const sourceRepos = Array.isArray(payload.sourceRepos)
    ? payload.sourceRepos.filter((s): s is string => typeof s === "string")
    : []
  const errorMsg =
    typeof payload.error === "string" && payload.error.length > 0
      ? payload.error
      : "(no error field provided)"
  const jobsScraped = typeof payload.jobsScraped === "number" ? payload.jobsScraped : 0
  const jobsNew = typeof payload.jobsNew === "number" ? payload.jobsNew : 0
  const jobsUpdated = typeof payload.jobsUpdated === "number" ? payload.jobsUpdated : 0
  const jobsErrored = typeof payload.jobsErrored === "number" ? payload.jobsErrored : 0

  // Cloud Logging deep-link (filter by runId for fast pivot to the actual
  // pipeline log line that produced this status). We always link the
  // Firestore run doc too so ops can pull the persisted record without
  // needing CLI access.
  const projectId = "wekruit-5f89b"
  const logsLink =
    `https://console.cloud.google.com/logs/query` +
    `;query=resource.type%3D%22cloud_function%22%20AND%20textPayload%3A%22${encodeURIComponent(runId)}%22` +
    `?project=${projectId}`
  const runDocLink =
    `https://console.firebase.google.com/project/${projectId}/firestore/data/~2F${PIPELINE_RUNS_COLLECTION}~2F${encodeURIComponent(runId)}`

  const lines: string[] = [
    `Pipeline ${word} — runId ${runId}`,
    "",
    `Status:           ${status}`,
    `Started:          ${payload.scrapeStartedAt ?? "(missing)"}`,
    `Finished:         ${payload.scrapeFinishedAt ?? "(missing)"}`,
    `Received at:      ${receivedAt}`,
    `Source repos:     ${sourceRepos.length > 0 ? sourceRepos.join(", ") : "(none)"}`,
    `Jobs scraped:     ${jobsScraped}`,
    `Jobs new:         ${jobsNew}`,
    `Jobs updated:     ${jobsUpdated}`,
    `Jobs errored:     ${jobsErrored}`,
    `Error message:    ${errorMsg}`,
    "",
    `Run doc:  ${runDocLink}`,
    `Logs:     ${logsLink}`,
    "",
    `— wekruit-pa paMatchingPipelineComplete`,
  ]
  const text = lines.join("\n")

  const escape = (s: string) =>
    s
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
  const html =
    `<h2 style="margin:0 0 0.4em">${emoji} Pipeline ${word} — <code>${escape(runId)}</code></h2>` +
    `<table style="border-collapse:collapse;font-family:monospace;font-size:13px">` +
    `<tr><td style="padding:2px 12px 2px 0;color:#64748b">Status</td><td>${escape(status)}</td></tr>` +
    `<tr><td style="padding:2px 12px 2px 0;color:#64748b">Started</td><td>${escape(payload.scrapeStartedAt ?? "(missing)")}</td></tr>` +
    `<tr><td style="padding:2px 12px 2px 0;color:#64748b">Finished</td><td>${escape(payload.scrapeFinishedAt ?? "(missing)")}</td></tr>` +
    `<tr><td style="padding:2px 12px 2px 0;color:#64748b">Received</td><td>${escape(receivedAt)}</td></tr>` +
    `<tr><td style="padding:2px 12px 2px 0;color:#64748b">Source repos</td><td>${escape(sourceRepos.length > 0 ? sourceRepos.join(", ") : "(none)")}</td></tr>` +
    `<tr><td style="padding:2px 12px 2px 0;color:#64748b">Jobs scraped</td><td>${jobsScraped}</td></tr>` +
    `<tr><td style="padding:2px 12px 2px 0;color:#64748b">Jobs new</td><td>${jobsNew}</td></tr>` +
    `<tr><td style="padding:2px 12px 2px 0;color:#64748b">Jobs updated</td><td>${jobsUpdated}</td></tr>` +
    `<tr><td style="padding:2px 12px 2px 0;color:#64748b">Jobs errored</td><td>${jobsErrored}</td></tr>` +
    `<tr><td style="padding:2px 12px 2px 0;color:#64748b;vertical-align:top">Error</td><td><pre style="margin:0;white-space:pre-wrap">${escape(errorMsg)}</pre></td></tr>` +
    `</table>` +
    `<p style="margin-top:1em">` +
    `<a href="${runDocLink}">Open run doc</a> · ` +
    `<a href="${logsLink}">Open logs</a>` +
    `</p>` +
    `<hr style="border:none;border-top:1px solid #e2e8f0;margin:1.2em 0">` +
    `<p style="color:#94a3b8;font-size:0.8em">wekruit-pa · paMatchingPipelineComplete</p>`

  return { subject, text, html }
}

/**
 * Pure webhook handler. Returns nothing; writes status + JSON body via res.
 */
export async function handleMatchingPipelineComplete(
  req: WebhookRequest,
  res: WebhookResponse,
  deps: MatchingPipelineCompleteDeps
): Promise<void> {
  const log = deps.log ?? console.log

  // ---- 1. HMAC verify (401 on fail) -------------------------------------
  const rawBody: Buffer | string =
    req.rawBody !== undefined
      ? req.rawBody
      : typeof req.body === "string"
        ? req.body
        : JSON.stringify(req.body ?? {})

  const sigHeader = extractSignature(req.headers ?? {})
  if (!verifyUpstreamSignature(rawBody, sigHeader, deps.secret)) {
    log("[matching-pipeline-complete] HMAC verify failed", { hasHeader: !!sigHeader })
    reply(res, 401, { ok: false, error: "invalid_signature" })
    return
  }

  // ---- 2. Parse JSON ----------------------------------------------------
  let parsed: unknown
  try {
    const text = typeof rawBody === "string" ? rawBody : rawBody.toString("utf8")
    parsed = JSON.parse(text)
  } catch {
    reply(res, 400, { ok: false, error: "malformed_body" })
    return
  }
  if (!parsed || typeof parsed !== "object") {
    reply(res, 400, { ok: false, error: "malformed_body" })
    return
  }
  const body = parsed as MatchingPipelineCompletePayload

  // ---- 3. Timestamp window (401 on stale) -------------------------------
  const tsMs = extractTimestampMs(req.headers ?? {})
  if (tsMs == null) {
    reply(res, 401, { ok: false, error: "missing_timestamp" })
    return
  }
  const nowMs = safeNowMs(deps)
  if (Math.abs(nowMs - tsMs) > TIMESTAMP_WINDOW_MS) {
    log("[matching-pipeline-complete] stale timestamp", { tsMs, nowMs })
    reply(res, 401, { ok: false, error: "stale_timestamp" })
    return
  }

  // ---- 4. Required fields (400) -----------------------------------------
  const status = typeof body.status === "string" ? body.status : ""
  if (!VALID_STATUSES.has(status)) {
    reply(res, 400, { ok: false, error: "missing_or_invalid_status" })
    return
  }
  if (!isValidIso(body.scrapeStartedAt) || !isValidIso(body.scrapeFinishedAt)) {
    reply(res, 400, { ok: false, error: "missing_or_invalid_timestamps" })
    return
  }

  // ---- 5. Flag gate (503 if disabled) ----------------------------------
  let flagOn = false
  try {
    flagOn = Boolean(
      await getFlag(deps.db, MATCHING_PIPELINE_FLAG_KEY, { env: process.env }, false)
    )
  } catch (err) {
    log(
      "[matching-pipeline-complete] flag read failed",
      err instanceof Error ? err.message : String(err)
    )
  }
  if (!flagOn) {
    reply(res, 503, { ok: false, error: "feature_disabled" })
    return
  }

  // ---- 6. Rate limit per source (429 on hard cap) -----------------------
  const sourceRepos = Array.isArray(body.sourceRepos)
    ? body.sourceRepos.filter((s): s is string => typeof s === "string" && s.length > 0)
    : []
  // Use first source as bucket key, fallback "_global". Keeps each repo
  // honest while still bounding traffic when sourceRepos missing.
  const sourceKey = sourceRepos[0] ?? "_global"
  const rl = await checkAndIncrementRateLimit(deps.db, sourceKey, nowMs)
  if (!rl.allowed) {
    log("[matching-pipeline-complete] rate-limited", {
      sourceKey,
      dayCount: rl.dayCount,
      dayBucket: rl.dayBucket,
    })
    reply(res, 429, {
      ok: false,
      error: "rate_limited",
      hardLimitPerDay: HARD_LIMIT_PER_DAY,
      dayBucket: rl.dayBucket,
    })
    return
  }
  if (rl.hourCount > SOFT_LIMIT_PER_HOUR) {
    log("[matching-pipeline-complete] soft cap exceeded (warn only)", {
      sourceKey,
      hourCount: rl.hourCount,
      hourBucket: rl.hourBucket,
    })
  }

  // ---- 7. Write pa-matching-pipeline-runs/{runId} -----------------------
  const runId =
    typeof body.runId === "string" && body.runId.length > 0 ? body.runId : newRunId(deps)
  const at = safeIso(deps)
  const runDoc: Record<string, unknown> = {
    runId,
    status,
    scrapeStartedAt: body.scrapeStartedAt,
    scrapeFinishedAt: body.scrapeFinishedAt,
    jobsScraped: typeof body.jobsScraped === "number" ? body.jobsScraped : 0,
    jobsNew: typeof body.jobsNew === "number" ? body.jobsNew : 0,
    jobsUpdated: typeof body.jobsUpdated === "number" ? body.jobsUpdated : 0,
    jobsErrored: typeof body.jobsErrored === "number" ? body.jobsErrored : 0,
    costUsd: typeof body.costUsd === "number" ? body.costUsd : 0,
    sourceRepos,
    error: typeof body.error === "string" ? body.error : null,
    receivedAt: at,
    createdAt: at,
  }
  try {
    await deps.db.collection(PIPELINE_RUNS_COLLECTION).doc(runId).set(runDoc)
  } catch (err) {
    log(
      "[matching-pipeline-complete] run write failed",
      err instanceof Error ? err.message : String(err)
    )
    reply(res, 500, { ok: false, error: "run_write_failed" })
    return
  }

  // ---- 7b. Failure-path alerts (failed | partial) -----------------------
  // Best-effort: errors here are logged but do not block the 200 response.
  // macmini already considers status=200 the contract that means "webhook
  // delivered". Mailgun/Slack flapping must not corkscrew us into the per-day
  // rate-limit ceiling via macmini retry storms.
  if (status === "failed" || status === "partial") {
    const alertInput: FailureAlertEmailInput = {
      status,
      runId,
      payload: body,
      receivedAt: at,
    }
    if (deps.sendFailureAlertEmail) {
      try {
        const r = await deps.sendFailureAlertEmail(alertInput)
        if (!r.ok) {
          log("[matching-pipeline-complete] failure_alert_email_failed", {
            runId,
            status,
            reason: r.reason,
          })
        } else {
          log("[matching-pipeline-complete] failure_alert_email_sent", {
            runId,
            status,
          })
        }
      } catch (err) {
        log(
          "[matching-pipeline-complete] failure_alert_email_threw",
          err instanceof Error ? err.message : String(err)
        )
      }
    }
    if (deps.sendFailureAlertSlack) {
      try {
        const r = await deps.sendFailureAlertSlack(alertInput)
        if (!r.posted) {
          log("[matching-pipeline-complete] failure_alert_slack_skipped", {
            runId,
            status,
            reason: r.reason,
          })
        }
      } catch (err) {
        log(
          "[matching-pipeline-complete] failure_alert_slack_threw",
          err instanceof Error ? err.message : String(err)
        )
      }
    }
  }

  // ---- 8. Emit pa-events on success + jobsNew > 0 -----------------------
  const jobsNew = typeof body.jobsNew === "number" ? body.jobsNew : 0
  if (status === "success" && jobsNew > 0) {
    try {
      await deps.db.collection(PA_EVENTS_COLLECTION).add({
        eventKind: "matching:pipeline:completed",
        runId,
        jobsNew,
        jobsUpdated: runDoc.jobsUpdated,
        sourceRepos,
        scrapeFinishedAt: body.scrapeFinishedAt,
        createdAt: at,
      })
    } catch (err) {
      // Run doc already written — emitting the event is best-effort.
      log(
        "[matching-pipeline-complete] event emit failed (non-fatal)",
        err instanceof Error ? err.message : String(err)
      )
    }
  }

  // ---- 9. Reply ---------------------------------------------------------
  reply(res, 200, { ok: true, runId })
}
