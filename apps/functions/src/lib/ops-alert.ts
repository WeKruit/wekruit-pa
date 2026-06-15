/**
 * ops-alert.ts — unified operational-alert primitive (Slack + email).
 *
 * 2026-06-14 (Adam directive): operational alerts route to EMAIL by default
 * (admin1@ / adam.ylol@ / noah.liu@wekruit.com), with the Slack webhook as a
 * second channel when provisioned. This is the single entry point new alerts
 * should call — it wraps `postSlackAlert` (existing) + `sendMailgun` (existing)
 * so callers don't reimplement the defense-in-depth dispatch (the pattern
 * openai-key-health.ts / paCostSummaryWeekly each hand-rolled).
 *
 * Channels resolve from process.env (Gen2 binds `defineSecret` handles into
 * process.env when listed in a function's `secrets:` array):
 *   - PA_SLACK_ALERT_WEBHOOK            → Slack incoming-webhook (optional)
 *   - MAILGUN_API_KEY/DOMAIN/FROM/REGION → Mailgun transport (optional)
 *   - PA_ALERT_EMAILS                    → comma-separated recipients
 *                                          (default = the three operators)
 *
 * Fail-soft like its dependencies: NEVER throws. Every miss returns a clean
 * status so callers can branch on telemetry without a surrounding try/catch.
 * If NEITHER channel is configured it logs `pa.ops_alert.no_channel` and returns.
 *
 * Optional dedup: pass `dedupe: { db, key }` to fire at most once per key
 * (first-writer-wins on `pa-alerts/{key}`) — use a date-stamped key
 * (e.g. `capacity-717-2026-06-14`) so a daily check doesn't email every run.
 */

import { logger } from "firebase-functions/v2"
import type { Firestore } from "firebase-admin/firestore"
import {
  postSlackAlert,
  PA_SECRET_UNSET_SENTINEL,
  type SlackAlertField,
  type SlackAlertResult,
} from "./slack-alert.js"
import { sendMailgun, type MailgunConfig, type MailgunSendResult } from "../email/mailgun.js"

/** Adam directive 2026-06-14 — default operator recipients for ops alerts. */
export const DEFAULT_OPS_ALERT_EMAILS = [
  "admin1@wekruit.com",
  "adam.ylol@wekruit.com",
] as const

const ALERTS_COLLECTION = "pa-alerts"

export interface OpsAlertInput {
  level: "warn" | "error" | "info"
  title: string
  message: string
  fields?: SlackAlertField[]
  link?: string
}

export interface OpsAlertDedupe {
  db: Firestore
  /** Stable per-alert key; date-stamp it to bound re-fires (e.g. `kind-2026-06-14`). */
  key: string
  nowMs?: number
}

export interface OpsAlertOptions {
  /** Override env recipients (tests / per-call routing). */
  emails?: string[]
  /** Override Slack webhook (tests). */
  slackWebhookUrl?: string
  /** Override Mailgun config (tests). undefined = resolve from env. */
  mailgun?: MailgunConfig | null
  /** At-most-once dedup gate. */
  dedupe?: OpsAlertDedupe
}

export interface OpsAlertResult {
  slack: SlackAlertResult | { posted: false; reason: "skipped" }
  email: (MailgunSendResult & { to: string }) | { ok: false; status: 0; reason: string }
  deduped: boolean
  anyDelivered: boolean
}

function isReal(v: string | undefined): boolean {
  const t = (v ?? "").trim()
  return t.length > 0 && t !== PA_SECRET_UNSET_SENTINEL
}

/** Comma-separated recipient list from env, else the three default operators. */
export function opsAlertRecipients(envValue?: string): string[] {
  const raw = (envValue ?? process.env.PA_ALERT_EMAILS ?? "").trim()
  if (!raw) return [...DEFAULT_OPS_ALERT_EMAILS]
  const parsed = raw
    .split(/[,;\s]+/)
    .map((s) => s.trim())
    .filter((s) => s.includes("@"))
  return parsed.length > 0 ? parsed : [...DEFAULT_OPS_ALERT_EMAILS]
}

/** Resolve Mailgun config from process.env; undefined when not fully provisioned. */
export function resolveMailgunFromEnv(): MailgunConfig | undefined {
  const apiKey = (process.env.MAILGUN_API_KEY ?? "").trim()
  const domain = (process.env.MAILGUN_DOMAIN ?? "").trim()
  const from = (process.env.MAILGUN_FROM ?? "").trim()
  if (!isReal(apiKey) || !isReal(domain) || !isReal(from)) return undefined
  const regionRaw = (process.env.MAILGUN_REGION ?? "us").trim().toLowerCase()
  const region: "us" | "eu" = regionRaw === "eu" ? "eu" : "us"
  return { apiKey, domain, from, region }
}

const LEVEL_EMOJI: Record<OpsAlertInput["level"], string> = {
  error: "🚨",
  warn: "⚠️",
  info: "ℹ️",
}

/** First-writer-wins dedup on `pa-alerts/{key}`. Fail-OPEN (alert) if the store throws. */
async function claimDedupe(d: OpsAlertDedupe): Promise<boolean> {
  const nowMs = d.nowMs ?? Date.now()
  try {
    const ref = d.db.collection(ALERTS_COLLECTION).doc(d.key)
    return await d.db.runTransaction(async (tx) => {
      const snap = await tx.get(ref)
      if (snap.exists) return false
      tx.set(ref, {
        alertId: d.key,
        type: "ops-alert",
        firstSeenAt: new Date(nowMs).toISOString(),
      })
      return true
    })
  } catch {
    // Dedup store unreachable → fail OPEN. A missed alert is worse than a dup.
    return true
  }
}

/**
 * Throttle helper: returns true iff this is the FIRST claim of `key` (so the
 * caller should alert). Use a time-bucketed key to rate-limit a repeating
 * condition, e.g. `capacity-+1717-info-2026-W24` (weekly) or
 * `unanswered-2026-06-14-21` (hourly). First-writer-wins on `pa-alerts/{key}`;
 * fail-OPEN (returns true) when the store is unreachable.
 */
export async function claimOpsAlertOnce(
  db: Firestore,
  key: string,
  nowMs?: number
): Promise<boolean> {
  return claimDedupe({ db, key, nowMs })
}

/** UTC hour bucket `YYYY-MM-DD-HH` for hourly throttle keys. */
export function hourBucket(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 13)
}

/** UTC ISO week bucket `YYYY-Www` for weekly throttle keys. */
export function isoWeekBucket(nowMs: number): string {
  const d = new Date(nowMs)
  const day = (d.getUTCDay() + 6) % 7 // Mon=0
  const thursday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day + 3))
  const firstThursday = new Date(Date.UTC(thursday.getUTCFullYear(), 0, 4))
  const week =
    1 +
    Math.round(
      ((thursday.getTime() - firstThursday.getTime()) / 86400000 -
        3 +
        ((firstThursday.getUTCDay() + 6) % 7)) /
        7
    )
  return `${thursday.getUTCFullYear()}-W${String(week).padStart(2, "0")}`
}

/**
 * Dispatch an operational alert to Slack (if configured) + email (if configured).
 * Never throws.
 */
export async function notifyOps(
  input: OpsAlertInput,
  opts?: OpsAlertOptions
): Promise<OpsAlertResult> {
  // ── dedup gate ────────────────────────────────────────────────────────────
  if (opts?.dedupe) {
    const first = await claimDedupe(opts.dedupe)
    if (!first) {
      logger.info("pa.ops_alert.deduped", { title: input.title, key: opts.dedupe.key })
      return {
        slack: { posted: false, reason: "skipped" },
        email: { ok: false, status: 0, reason: "deduped" },
        deduped: true,
        anyDelivered: false,
      }
    }
  }

  const slackUrl = opts?.slackWebhookUrl ?? process.env.PA_SLACK_ALERT_WEBHOOK
  const mailgun = opts?.mailgun === null ? undefined : opts?.mailgun ?? resolveMailgunFromEnv()
  const recipients = opts?.emails ?? opsAlertRecipients()

  if (!isReal(slackUrl) && !mailgun) {
    logger.warn("pa.ops_alert.no_channel", {
      title: input.title,
      hint: "set MAILGUN_* secrets and/or PA_SLACK_ALERT_WEBHOOK",
    })
    return {
      slack: { posted: false, reason: "skipped" },
      email: { ok: false, status: 0, reason: "no_channel" },
      deduped: false,
      anyDelivered: false,
    }
  }

  // ── Slack (no-op when webhook unset) ────────────────────────────────────────
  let slack: OpsAlertResult["slack"] = { posted: false, reason: "skipped" }
  if (isReal(slackUrl)) {
    try {
      slack = await postSlackAlert(input, { webhookUrl: slackUrl })
    } catch (err) {
      slack = { posted: false, reason: err instanceof Error ? err.message : "slack_error" }
    }
  }

  // ── Email (best-effort; only when Mailgun configured) ───────────────────────
  let email: OpsAlertResult["email"] = { ok: false, status: 0, reason: "no_mailgun" }
  if (mailgun && recipients.length > 0) {
    const to = recipients.join(", ")
    const fieldLines = (input.fields ?? []).map((f) => `${f.name}: ${f.value}`).join("\n")
    const text = [
      `${LEVEL_EMOJI[input.level]} [${input.level.toUpperCase()}] ${input.title}`,
      "",
      input.message,
      fieldLines ? `\n${fieldLines}` : "",
      input.link ? `\n${input.link}` : "",
    ]
      .filter((s) => s !== "")
      .join("\n")
    try {
      const res = await sendMailgun(mailgun, {
        to,
        subject: `[PA alert] ${input.title}`,
        text,
      })
      email = { ...res, to }
    } catch (err) {
      email = { ok: false, status: 0, reason: err instanceof Error ? err.message : "email_error" }
    }
  }

  const anyDelivered = (slack.posted === true) || ("ok" in email && email.ok === true)
  logger.info("pa.ops_alert.dispatched", {
    title: input.title,
    level: input.level,
    slackPosted: slack.posted,
    emailOk: "ok" in email ? email.ok : false,
    recipients: recipients.length,
  })
  return { slack, email, deduped: false, anyDelivered }
}
