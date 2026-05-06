/**
 * v1.7 Phase 69 — Shared Slack alert helper.
 *
 * REQ-IDs: SECRETS-01, SECRETS-02, SECRETS-03
 *
 * Single entry point for posting alert messages to a Slack incoming-webhook URL.
 * All callers MUST go through `postSlackAlert` so we have one place to:
 *   - Render a consistent header + level emoji + structured fields/links.
 *   - Fail-graceful when `PA_SLACK_ALERT_WEBHOOK` is unset (skip silently — never throw).
 *   - Defense-in-depth: callers keep Mailgun fallbacks alongside Slack.
 *
 * Webhook URL is sourced from `process.env.PA_SLACK_ALERT_WEBHOOK`. Adam holds
 * the actual webhook secret and provisions it via:
 *   echo -n "https://hooks.slack.com/..." | \
 *     firebase functions:secrets:set PA_SLACK_ALERT_WEBHOOK \
 *     --project wekruit-5f89b --data-file=-
 *
 * Until the secret lands, every call returns `{ posted: false, reason: ... }`
 * and emits a `pa.slack.alert_skipped` info-log so we can audit pre-launch
 * behaviour without polluting error budgets.
 */

import { logger } from "firebase-functions/v2"

export interface SlackAlertField {
  name: string
  value: string
}

export interface SlackAlertInput {
  level: "warn" | "error" | "info"
  title: string
  message: string
  fields?: SlackAlertField[]
  link?: string
}

export interface SlackAlertResult {
  posted: boolean
  reason?: string
}

/** Injection seam for tests; production uses `globalThis.fetch`. */
export type SlackFetchImpl = typeof fetch

export interface PostSlackAlertOptions {
  /** Override fetch (tests). Defaults to `globalThis.fetch`. */
  fetchImpl?: SlackFetchImpl
  /** Override webhook URL (tests). Defaults to `process.env.PA_SLACK_ALERT_WEBHOOK`. */
  webhookUrl?: string
}

const LEVEL_EMOJI: Record<SlackAlertInput["level"], string> = {
  error: "🚨",
  warn: "⚠️",
  info: "ℹ️",
}

/**
 * Post an alert to Slack. Never throws — every failure path returns a clean
 * `{ posted: false, reason }` so callers can branch on telemetry without a
 * surrounding try/catch.
 */
/**
 * Sentinel string Adam uses for placeholder secret versions in
 * Secret Manager (so `firebase deploy` doesn't fail when the secret exists
 * with no provisioned value yet). Treated as "unset" at runtime.
 */
export const PA_SECRET_UNSET_SENTINEL = "__UNSET__"

export async function postSlackAlert(
  input: SlackAlertInput,
  opts?: PostSlackAlertOptions
): Promise<SlackAlertResult> {
  const raw = (opts?.webhookUrl ?? process.env.PA_SLACK_ALERT_WEBHOOK ?? "").trim()
  // Sentinel = treat as unset. Adam provisions the real URL via
  // `firebase functions:secrets:set PA_SLACK_ALERT_WEBHOOK`.
  const url = raw === PA_SECRET_UNSET_SENTINEL ? "" : raw
  if (!url) {
    logger.info("pa.slack.alert_skipped", {
      reason: "no_webhook_env",
      title: input.title,
    })
    return { posted: false, reason: "PA_SLACK_ALERT_WEBHOOK not set" }
  }

  const emoji = LEVEL_EMOJI[input.level]
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const blocks: any[] = [
    {
      type: "header",
      text: { type: "plain_text", text: `${emoji} ${input.title}` },
    },
    {
      type: "section",
      text: { type: "mrkdwn", text: input.message },
    },
  ]
  if (input.fields && input.fields.length > 0) {
    blocks.push({
      type: "section",
      fields: input.fields.map((f) => ({
        type: "mrkdwn",
        text: `*${f.name}:*\n${f.value}`,
      })),
    })
  }
  if (input.link) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: `<${input.link}|View details>` },
    })
  }

  const fetchImpl = opts?.fetchImpl ?? globalThis.fetch
  try {
    const res = await fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: input.title, blocks }),
    })
    if (!res.ok) {
      logger.warn("pa.slack.alert_failed", {
        status: res.status,
        title: input.title,
      })
      return { posted: false, reason: `http_${res.status}` }
    }
    return { posted: true }
  } catch (err) {
    logger.warn("pa.slack.alert_error", {
      err: err instanceof Error ? err.message : String(err),
      title: input.title,
    })
    return { posted: false, reason: "fetch_error" }
  }
}
