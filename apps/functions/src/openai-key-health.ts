/**
 * paOpenAiKeyHealth — OpenAI key early-warning Cloud Function (deliverable #1).
 *
 * Incident: .planning/INCIDENT-2026-06-01-openai-rotation-hardening.md
 *
 * On 2026-06-01 OpenAI auto-revoked the org's shared key. Every OpenAI-bound CF
 * 401'd at once and we had NO early warning — we learned from user-facing
 * failures. This scheduled CF closes that gap:
 *
 *   1. Every ~30 min: cheap health-ping with the live PA_OPENAI_AGENT_API_KEY
 *      (GET /v1/models). Classify the result:
 *        - 401 invalid_api_key   → 🚨 "OpenAI key DEAD/revoked"  (Slack + email)
 *        - 429 insufficient_quota→ 🚨 "OpenAI quota exhausted"    (Slack + email)
 *        - 429 rate_limit / 5xx  → no page (key still alive / transient)
 *   2. Once per UTC day: poll the Costs API (GET /v1/organization/costs) and
 *      alert at ≥80% of a configurable monthly budget — BEFORE the hard quota.
 *
 * Reuses: PA_SLACK_ALERT_WEBHOOK + postSlackAlert + Mailgun (orchestrator-deps).
 * Dedupe: `pa-alerts/{yyyy-mm-dd-<kind>}` — one alert per kind per UTC day.
 * Fail-open: the function NEVER throws; every error path logs + returns.
 *
 * SECURITY: never logs/echoes a key value. The key is read from a secret and
 * passed straight into the Authorization header; only redacted prefixes /
 * status codes / hashes appear in logs + alerts.
 *
 * Architecture mirrors paQaEvaluatorWeekly: pure `runOpenAiKeyHealth(deps)` for
 * tests + a thin `onSchedule` production shim wiring real secrets/fetch/Firestore.
 */

import { onSchedule } from "firebase-functions/v2/scheduler"
import { defineSecret } from "firebase-functions/params"
import { logger } from "firebase-functions/v2"
import { getFirestore, type Firestore } from "firebase-admin/firestore"

import {
  classifyKeyPing,
  decideBudgetAlert,
  parseCostsResponse,
  isPageableVerdict,
  redactSecrets,
  alertDedupeId,
  DEFAULT_MONTHLY_BUDGET_USD,
  type KeyHealthVerdict,
} from "./lib/openai-key-health-logic.js"
import { postSlackAlert } from "./lib/slack-alert.js"
import { sendMailgun, type MailgunConfig } from "./email/mailgun.js"
import {
  MAILGUN_API_KEY,
  MAILGUN_DOMAIN,
  MAILGUN_FROM,
  MAILGUN_REGION,
  PA_SLACK_ALERT_WEBHOOK,
} from "./orchestrator-deps.js"

// ---------------------------------------------------------------------------
// Secrets
// ---------------------------------------------------------------------------

const PA_OPENAI_AGENT_API_KEY = defineSecret("PA_OPENAI_AGENT_API_KEY")
/**
 * Org-level ADMIN key for the Costs API (sk-proj- project keys are NOT
 * sufficient — see incident §5). Optional: when unset, the health-ping still
 * runs and only the daily costs poll is skipped.
 */
const OPENAI_ADMIN_KEY = defineSecret("OPENAI_ADMIN_KEY")

const ALERTS_COLLECTION = "pa-alerts"
const ALERT_EMAIL_TO = "developers@wekruit.com"

// ---------------------------------------------------------------------------
// Types / deps seam
// ---------------------------------------------------------------------------

export type AlertKind = "key-revoked" | "key-quota-exhausted" | "budget-warning"

export interface KeyHealthAlert {
  kind: AlertKind
  level: "warn" | "error"
  title: string
  message: string
}

export interface OpenAiKeyHealthResult {
  verdict: KeyHealthVerdict | "skipped"
  /** Redacted prefix of the key we pinged (never the value). */
  keyPrefix: string
  budgetChecked: boolean
  monthToDateUsd?: number
  alertsFired: AlertKind[]
  alertsDeduped: AlertKind[]
}

export interface OpenAiKeyHealthDeps {
  /** The live key value — read from secret in production; redacted for logs. */
  apiKey: string
  /** Org admin key for the Costs API. Empty string = skip costs poll. */
  adminKey?: string
  /** Configured monthly budget (USD). */
  monthlyBudgetUsd?: number
  /** Inject for tests. Defaults to globalThis.fetch. */
  fetchImpl?: typeof fetch
  /** Has today's costs poll already run? (true on most 30-min ticks). */
  shouldPollCosts?: boolean
  /** Slack webhook URL (already resolved from secret/env). */
  slackWebhookUrl?: string
  /** Mailgun config (already resolved from secrets). undefined = skip email. */
  mailgun?: MailgunConfig
  /** Dedupe gate — returns true if this is the FIRST alert of this kind today. */
  claimAlert?: (kind: AlertKind, nowMs: number) => Promise<boolean>
  now?: () => number
  log?: (msg: string, ctx?: Record<string, unknown>) => void
  errorLog?: (msg: string, ctx?: Record<string, unknown>) => void
}

const OPENAI_BASE_URL = "https://api.openai.com/v1"

/** Length-capped redacted prefix for a key (for logs only; never the value). */
export function keyPrefix(key: string | undefined): string {
  if (!key) return "(none)"
  const trimmed = key.trim()
  if (trimmed.length < 12) return "(short)"
  return `${trimmed.slice(0, 11)}…`
}

// ---------------------------------------------------------------------------
// Main driver — pure-ish (all IO injected)
// ---------------------------------------------------------------------------

export async function runOpenAiKeyHealth(
  deps: OpenAiKeyHealthDeps
): Promise<OpenAiKeyHealthResult> {
  const log = deps.log ?? (() => {})
  const errorLog = deps.errorLog ?? log
  const now = deps.now ?? (() => Date.now())
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch
  const monthlyBudgetUsd = deps.monthlyBudgetUsd ?? DEFAULT_MONTHLY_BUDGET_USD
  const claimAlert = deps.claimAlert ?? (async () => true)

  const prefix = keyPrefix(deps.apiKey)
  const alertsFired: AlertKind[] = []
  const alertsDeduped: AlertKind[] = []

  // --- helper: dispatch a deduped alert via Slack + Mailgun (best-effort) ---
  const dispatch = async (alert: KeyHealthAlert): Promise<void> => {
    let first = true
    try {
      first = await claimAlert(alert.kind, now())
    } catch (err) {
      // If the dedupe store is unreachable, fail OPEN (still alert) — a missed
      // page is worse than a duplicate during an outage.
      errorLog("openai_key_health.dedupe_claim_failed", {
        kind: alert.kind,
        err: redactSecrets(String(err)).slice(0, 200),
      })
      first = true
    }
    if (!first) {
      alertsDeduped.push(alert.kind)
      log("openai_key_health.alert_deduped", { kind: alert.kind })
      return
    }

    // Slack (no-op when webhook unset — postSlackAlert handles that).
    try {
      await postSlackAlert(
        {
          level: alert.level,
          title: alert.title,
          message: alert.message,
          fields: [{ name: "key", value: prefix }],
        },
        deps.slackWebhookUrl ? { webhookUrl: deps.slackWebhookUrl } : undefined
      )
    } catch (err) {
      errorLog("openai_key_health.slack_failed", {
        kind: alert.kind,
        err: redactSecrets(String(err)).slice(0, 200),
      })
    }

    // Mailgun (best-effort; only when configured).
    if (deps.mailgun) {
      try {
        await sendMailgun(deps.mailgun, {
          to: ALERT_EMAIL_TO,
          subject: `[openai-key-health] ${alert.title}`,
          text: `${alert.message}\n\nKey: ${prefix}\nRotate: bash scripts/rotate-openai-key.mjs --apply`,
        })
      } catch (err) {
        errorLog("openai_key_health.email_failed", {
          kind: alert.kind,
          err: redactSecrets(String(err)).slice(0, 200),
        })
      }
    }

    alertsFired.push(alert.kind)
    log("openai_key_health.alert_fired", { kind: alert.kind, title: alert.title })
  }

  // --- 1. Health-ping (GET /v1/models) -------------------------------------
  if (!deps.apiKey || deps.apiKey.trim().length === 0 || deps.apiKey.trim() === "__UNSET__") {
    errorLog("openai_key_health.no_key", { keyPrefix: prefix })
    return {
      verdict: "skipped",
      keyPrefix: prefix,
      budgetChecked: false,
      alertsFired,
      alertsDeduped,
    }
  }

  let verdict: KeyHealthVerdict = "unknown"
  try {
    const res = await fetchImpl(`${OPENAI_BASE_URL}/models`, {
      method: "GET",
      headers: { Authorization: `Bearer ${deps.apiKey.trim()}` },
    })
    let body = ""
    try {
      body = await res.text()
    } catch {
      /* body read failure — classify on status alone */
    }
    const classified = classifyKeyPing({ status: res.status, body })
    verdict = classified.verdict
    log("openai_key_health.ping", {
      status: res.status,
      verdict,
      errorCode: classified.errorCode,
      keyPrefix: prefix,
    })

    if (isPageableVerdict(verdict)) {
      if (verdict === "revoked") {
        await dispatch({
          kind: "key-revoked",
          level: "error",
          title: "OpenAI key DEAD / revoked",
          message:
            `PA_OPENAI_AGENT_API_KEY health-ping returned 401 (${classified.errorCode}). ` +
            `Every OpenAI-bound function is failing. Rotate now: ` +
            `\`bash scripts/rotate-openai-key.mjs --apply\` (or sync-openai-key.mjs).`,
        })
      } else {
        await dispatch({
          kind: "key-quota-exhausted",
          level: "error",
          title: "OpenAI quota exhausted",
          message:
            `PA_OPENAI_AGENT_API_KEY health-ping returned 429 insufficient_quota. ` +
            `The org's prepaid credit balance is drained — top up or raise the cap. ` +
            `(The key is still valid; this is a billing stop, not a revoke.)`,
        })
      }
    }
  } catch (err) {
    // Network error → fail-open. Don't page on a transient blip.
    errorLog("openai_key_health.ping_threw", {
      err: redactSecrets(String(err)).slice(0, 200),
      keyPrefix: prefix,
    })
    verdict = "unknown"
  }

  // --- 2. Daily Costs-API poll (≥80% pre-quota warning) --------------------
  let budgetChecked = false
  let monthToDateUsd: number | undefined
  const adminKey = (deps.adminKey ?? "").trim()
  const shouldPoll = deps.shouldPollCosts !== false // default true; skip only when explicitly false
  if (shouldPoll && adminKey && adminKey !== "__UNSET__") {
    try {
      const startOfMonth = monthStartUnix(now())
      const url =
        `${OPENAI_BASE_URL}/organization/costs?start_time=${startOfMonth}&limit=180`
      const res = await fetchImpl(url, {
        method: "GET",
        headers: { Authorization: `Bearer ${adminKey}` },
      })
      if (res.ok) {
        let json: unknown = {}
        try {
          json = await res.json()
        } catch {
          /* parse failure → treated as 0 spend below */
        }
        monthToDateUsd = parseCostsResponse(json)
        budgetChecked = true
        const decision = decideBudgetAlert({ monthToDateUsd, monthlyBudgetUsd })
        log("openai_key_health.costs", {
          monthToDateUsd,
          monthlyBudgetUsd,
          fractionUsed: decision.fractionUsed,
          severity: decision.severity,
        })
        if (decision.shouldAlert) {
          await dispatch({
            kind: "budget-warning",
            level: decision.severity === "over" ? "error" : "warn",
            title:
              decision.severity === "over"
                ? "OpenAI spend OVER monthly budget"
                : "OpenAI spend ≥80% of monthly budget",
            message:
              `Month-to-date spend $${monthToDateUsd.toFixed(2)} of ` +
              `$${monthlyBudgetUsd.toFixed(0)} budget ` +
              `(${(decision.fractionUsed * 100).toFixed(0)}%). ` +
              `This is the pre-quota early warning — investigate before the ` +
              `org's prepaid credit balance hard-stops every service.`,
          })
        }
      } else {
        log("openai_key_health.costs_http_error", { status: res.status })
      }
    } catch (err) {
      errorLog("openai_key_health.costs_threw", {
        err: redactSecrets(String(err)).slice(0, 200),
      })
    }
  } else {
    log("openai_key_health.costs_skipped", {
      reason: !shouldPoll ? "not_daily_tick" : adminKey ? "admin_key_unset_sentinel" : "no_admin_key",
    })
  }

  return {
    verdict,
    keyPrefix: prefix,
    budgetChecked,
    monthToDateUsd,
    alertsFired,
    alertsDeduped,
  }
}

/** Unix-seconds timestamp for 00:00:00 UTC on the 1st of the current month. */
export function monthStartUnix(nowMs: number): number {
  const d = new Date(nowMs)
  return Math.floor(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) / 1000)
}

// ---------------------------------------------------------------------------
// Production dedupe — first-writer-wins on pa-alerts/{yyyy-mm-dd-<kind>}
// ---------------------------------------------------------------------------

/**
 * Atomically claim the day's alert slot for `kind`. Uses a Firestore
 * transaction so two concurrent CF instances can't both fire. Returns true iff
 * THIS call created the doc (i.e. it's the first alert of this kind today).
 */
export function makeFirestoreClaimAlert(
  db: Firestore
): (kind: AlertKind, nowMs: number) => Promise<boolean> {
  return async (kind, nowMs) => {
    const id = alertDedupeId(kind, nowMs)
    const ref = db.collection(ALERTS_COLLECTION).doc(id)
    return db.runTransaction(async (tx) => {
      const snap = await tx.get(ref)
      if (snap.exists) return false
      tx.set(ref, {
        alertId: id,
        kind,
        type: `openai-key-health:${kind}`,
        firstSeenAt: new Date(nowMs).toISOString(),
        message: `OpenAI key-health alert (${kind}) — see logs / Slack.`,
      })
      return true
    })
  }
}

// ---------------------------------------------------------------------------
// Daily-tick gate — only the first tick of each UTC day polls Costs
// ---------------------------------------------------------------------------

/**
 * Atomically claim the day's costs-poll slot. Returns true iff THIS tick is the
 * first of the UTC day (so a 30-min schedule only hits the Costs API once/day).
 */
async function claimDailyCostsPoll(db: Firestore, nowMs: number): Promise<boolean> {
  const id = `${new Date(nowMs).toISOString().slice(0, 10)}-costs-poll`
  const ref = db.collection(ALERTS_COLLECTION).doc(id)
  try {
    return await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref)
      if (snap.exists) return false
      tx.set(ref, {
        alertId: id,
        kind: "costs-poll-marker",
        firstSeenAt: new Date(nowMs).toISOString(),
      })
      return true
    })
  } catch {
    // If the marker store is unreachable, skip the costs poll this tick rather
    // than hammer the Costs API on every 30-min tick.
    return false
  }
}

// ---------------------------------------------------------------------------
// Cloud Function — every 30 minutes.
// ---------------------------------------------------------------------------

function resolveSlackWebhook(): string {
  const isReal = (v: string) => v.length > 0 && v !== "__UNSET__"
  try {
    const secretVal = (PA_SLACK_ALERT_WEBHOOK.value() ?? "").trim()
    if (isReal(secretVal)) return secretVal
  } catch {
    /* not provisioned — fall through */
  }
  const env = (process.env.PA_SLACK_ALERT_WEBHOOK ?? "").trim()
  return isReal(env) ? env : ""
}

function resolveMailgun(): MailgunConfig | undefined {
  try {
    const apiKey = (MAILGUN_API_KEY.value() ?? "").trim()
    const domain = (MAILGUN_DOMAIN.value() ?? "").trim()
    const from = (MAILGUN_FROM.value() ?? "").trim()
    const regionRaw = (MAILGUN_REGION.value() ?? "us").trim()
    const region: "us" | "eu" = regionRaw === "eu" ? "eu" : "us"
    if (apiKey && domain && from) return { apiKey, domain, from, region }
  } catch {
    /* secrets not provisioned — skip email */
  }
  return undefined
}

export const paOpenAiKeyHealth = onSchedule(
  {
    schedule: "every 30 minutes",
    timeZone: "UTC",
    memory: "512MiB",
    timeoutSeconds: 60,
    region: "us-central1",
    secrets: [
      PA_OPENAI_AGENT_API_KEY,
      OPENAI_ADMIN_KEY,
      MAILGUN_API_KEY,
      MAILGUN_DOMAIN,
      MAILGUN_FROM,
      MAILGUN_REGION,
      PA_SLACK_ALERT_WEBHOOK,
    ],
    retryCount: 0,
  },
  async () => {
    // Wrap the entire body — this CF must NEVER throw (fail-open).
    try {
      const apiKey = (() => {
        try {
          return (PA_OPENAI_AGENT_API_KEY.value() ?? "").trim()
        } catch {
          return (process.env.PA_OPENAI_AGENT_API_KEY ?? "").trim()
        }
      })()
      const adminKey = (() => {
        try {
          return (OPENAI_ADMIN_KEY.value() ?? "").trim()
        } catch {
          return (process.env.OPENAI_ADMIN_KEY ?? "").trim()
        }
      })()

      const budgetEnv = Number.parseFloat(
        (process.env.PA_OPENAI_MONTHLY_BUDGET_USD ?? "").trim()
      )
      const monthlyBudgetUsd =
        Number.isFinite(budgetEnv) && budgetEnv > 0 ? budgetEnv : DEFAULT_MONTHLY_BUDGET_USD

      const db = getFirestore()
      const nowMs = Date.now()
      // Only the first tick of each UTC day actually hits the Costs API.
      const shouldPollCosts = await claimDailyCostsPoll(db, nowMs)

      const result = await runOpenAiKeyHealth({
        apiKey,
        adminKey,
        monthlyBudgetUsd,
        shouldPollCosts,
        slackWebhookUrl: resolveSlackWebhook() || undefined,
        mailgun: resolveMailgun(),
        claimAlert: makeFirestoreClaimAlert(db),
        now: () => nowMs,
        log: (msg, ctx) => logger.info(`[openai-key-health] ${msg}`, ctx ?? {}),
        errorLog: (msg, ctx) => logger.error(`[openai-key-health] ${msg}`, ctx ?? {}),
      })

      logger.info("[openai-key-health] done", {
        verdict: result.verdict,
        keyPrefix: result.keyPrefix,
        budgetChecked: result.budgetChecked,
        monthToDateUsd: result.monthToDateUsd,
        alertsFired: result.alertsFired,
        alertsDeduped: result.alertsDeduped,
      })
    } catch (err) {
      // Absolute last-resort guard — never let the scheduler see a throw.
      logger.error("[openai-key-health] fatal_guard", {
        err: redactSecrets(String(err)).slice(0, 200),
      })
    }
  }
)
