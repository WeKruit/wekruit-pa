/**
 * paAnthropicKeyHealth — Anthropic key early-warning Cloud Function.
 *
 * 2026-06-14 (Adam alerting initiative): only OpenAI had key-health monitoring
 * (paOpenAiKeyHealth). An Anthropic key revocation / credit exhaustion was
 * discovered only via downstream LLM-task failure. This mirrors the OpenAI
 * monitor: every ~30 min, cheap health-ping (GET /v1/models) with the live
 * ANTHROPIC_API_KEY.
 *   - 401 authentication_error → 🚨 "Anthropic key DEAD/revoked"
 *   - 429 / billing            → 🚨 "Anthropic credit/quota exhausted"
 *   - 5xx / network            → no page (transient)
 *
 * Dispatch via notifyOps (email → operators + Slack). Dedup: pa-alerts/{date-kind}
 * (one alert per kind per UTC day). Fail-open: NEVER throws.
 *
 * SECURITY: never logs a key value — only a redacted prefix + status code.
 */

import { onSchedule } from "firebase-functions/v2/scheduler"
import { logger } from "firebase-functions/v2"
import { getFirestore, type Firestore } from "firebase-admin/firestore"
import { notifyOps } from "./lib/ops-alert.js"
import {
  ANTHROPIC_API_KEY,
  MAILGUN_SECRETS,
  PA_SLACK_ALERT_WEBHOOK,
} from "./orchestrator-deps.js"

const ANTHROPIC_BASE_URL = "https://api.anthropic.com/v1"
const ANTHROPIC_VERSION = "2023-06-01"
const ALERTS_COLLECTION = "pa-alerts"

export type AnthropicKeyVerdict = "ok" | "revoked" | "quota-exhausted" | "unknown"
export type AnthropicAlertKind = "anthropic-key-revoked" | "anthropic-key-quota-exhausted"

/** Classify the health-ping result into a verdict (pure, unit-testable). */
export function classifyAnthropicPing(input: { status: number; body?: string }): {
  verdict: AnthropicKeyVerdict
  errorType?: string
} {
  const { status } = input
  let errorType: string | undefined
  try {
    if (input.body) {
      const j = JSON.parse(input.body) as { error?: { type?: string } }
      errorType = j.error?.type
    }
  } catch {
    /* non-JSON body */
  }
  if (status === 200) return { verdict: "ok" }
  if (status === 401 || status === 403) return { verdict: "revoked", errorType }
  // Anthropic returns 400 invalid_request_error / 429 for credit-balance-too-low.
  if (status === 429 || errorType === "billing_error" || /credit/i.test(errorType ?? "")) {
    return { verdict: "quota-exhausted", errorType }
  }
  return { verdict: "unknown", errorType }
}

export function isPageableAnthropicVerdict(v: AnthropicKeyVerdict): v is "revoked" | "quota-exhausted" {
  return v === "revoked" || v === "quota-exhausted"
}

export function anthropicKeyPrefix(key: string | undefined): string {
  if (!key) return "(none)"
  const t = key.trim()
  if (t.length < 12) return "(short)"
  return `${t.slice(0, 11)}…`
}

export interface AnthropicKeyHealthDeps {
  apiKey: string
  fetchImpl?: typeof fetch
  notify?: typeof notifyOps
  /** Dedupe gate — true iff this is the first alert of this kind today. */
  claimAlert?: (kind: AnthropicAlertKind, nowMs: number) => Promise<boolean>
  now?: () => number
  log?: (msg: string, ctx?: Record<string, unknown>) => void
}

export interface AnthropicKeyHealthResult {
  verdict: AnthropicKeyVerdict | "skipped"
  keyPrefix: string
  alertsFired: AnthropicAlertKind[]
  alertsDeduped: AnthropicAlertKind[]
}

export async function runAnthropicKeyHealth(
  deps: AnthropicKeyHealthDeps
): Promise<AnthropicKeyHealthResult> {
  const log = deps.log ?? (() => {})
  const now = deps.now ?? (() => Date.now())
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch
  const notify = deps.notify ?? notifyOps
  const claimAlert = deps.claimAlert ?? (async () => true)
  const prefix = anthropicKeyPrefix(deps.apiKey)
  const alertsFired: AnthropicAlertKind[] = []
  const alertsDeduped: AnthropicAlertKind[] = []

  const key = (deps.apiKey ?? "").trim()
  if (!key || key === "__UNSET__") {
    log("anthropic_key_health.no_key", { keyPrefix: prefix })
    return { verdict: "skipped", keyPrefix: prefix, alertsFired, alertsDeduped }
  }

  const dispatch = async (kind: AnthropicAlertKind, title: string, message: string): Promise<void> => {
    let first = true
    try {
      first = await claimAlert(kind, now())
    } catch {
      first = true // dedupe store down → fail open (alert)
    }
    if (!first) {
      alertsDeduped.push(kind)
      return
    }
    try {
      await notify({ level: "error", title, message, fields: [{ name: "key", value: prefix }] })
    } catch {
      /* alert never throws */
    }
    alertsFired.push(kind)
    log("anthropic_key_health.alert_fired", { kind, title })
  }

  let verdict: AnthropicKeyVerdict = "unknown"
  try {
    const res = await fetchImpl(`${ANTHROPIC_BASE_URL}/models`, {
      method: "GET",
      headers: { "x-api-key": key, "anthropic-version": ANTHROPIC_VERSION },
    })
    let body = ""
    try {
      body = await res.text()
    } catch {
      /* classify on status alone */
    }
    const classified = classifyAnthropicPing({ status: res.status, body })
    verdict = classified.verdict
    log("anthropic_key_health.ping", { status: res.status, verdict, errorType: classified.errorType, keyPrefix: prefix })
    if (isPageableAnthropicVerdict(verdict)) {
      if (verdict === "revoked") {
        await dispatch(
          "anthropic-key-revoked",
          "Anthropic key DEAD / revoked",
          "ANTHROPIC_API_KEY health-ping returned 401/403. Anthropic fallback tiers " +
            "(resume parser, JD-rel weights, sponsorship inference, nuanced reasons) are failing. Rotate the key.",
        )
      } else {
        await dispatch(
          "anthropic-key-quota-exhausted",
          "Anthropic credit/quota exhausted",
          "ANTHROPIC_API_KEY health-ping returned 429 / billing error. The org credit balance is drained — top up.",
        )
      }
    }
  } catch (err) {
    log("anthropic_key_health.ping_threw", { err: err instanceof Error ? err.message : String(err), keyPrefix: prefix })
    verdict = "unknown" // network blip → fail open, no page
  }

  return { verdict, keyPrefix: prefix, alertsFired, alertsDeduped }
}

/** Atomic per-kind/day dedupe on pa-alerts/{yyyy-mm-dd-<kind>}. */
export function makeAnthropicClaimAlert(
  db: Firestore
): (kind: AnthropicAlertKind, nowMs: number) => Promise<boolean> {
  return async (kind, nowMs) => {
    const id = `${new Date(nowMs).toISOString().slice(0, 10)}-${kind}`
    const ref = db.collection(ALERTS_COLLECTION).doc(id)
    return db.runTransaction(async (tx) => {
      const snap = await tx.get(ref)
      if (snap.exists) return false
      tx.set(ref, {
        alertId: id,
        kind,
        type: `anthropic-key-health:${kind}`,
        firstSeenAt: new Date(nowMs).toISOString(),
      })
      return true
    })
  }
}

export const paAnthropicKeyHealth = onSchedule(
  {
    // Every 2h (12/day): Anthropic is a FALLBACK tier — if its key dies, the
    // OpenAI primary still serves, so 2h detection is plenty (vs OpenAI's 30min).
    schedule: "0 */2 * * *",
    timeZone: "UTC",
    memory: "512MiB",
    timeoutSeconds: 60,
    region: "us-central1",
    secrets: [ANTHROPIC_API_KEY, PA_SLACK_ALERT_WEBHOOK, ...MAILGUN_SECRETS],
    retryCount: 0,
  },
  async () => {
    try {
      const apiKey = (() => {
        try {
          return (ANTHROPIC_API_KEY.value() ?? "").trim()
        } catch {
          return (process.env.ANTHROPIC_API_KEY ?? "").trim()
        }
      })()
      const db = getFirestore()
      const result = await runAnthropicKeyHealth({
        apiKey,
        claimAlert: makeAnthropicClaimAlert(db),
        log: (msg, ctx) => logger.info(`[anthropic-key-health] ${msg}`, ctx ?? {}),
      })
      logger.info("[anthropic-key-health] done", result)
    } catch (err) {
      logger.error("[anthropic-key-health] fatal_guard", {
        err: err instanceof Error ? err.message : String(err),
      })
    }
  }
)
