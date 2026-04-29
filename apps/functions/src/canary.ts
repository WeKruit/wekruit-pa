/**
 * paWebhookCanary — Phase 33 Task 3.
 *
 * Scheduled CF that periodically POSTs a synthetic payload to the
 * paSendblueWebhook with a valid signing secret to verify the full path:
 *   1. Webhook reachable (Cloud Run not cold-stuck)
 *   2. Signing-secret verify still accepts the configured secret
 *   3. Handler returns 200 (i.e. recent deploy did not break the contract)
 *
 * The canary uses a sentinel `from_number` (`+10000000000`) that the
 * webhook short-circuits — no inbound event enqueued, no LLM call, no
 * Sendblue charge. Result written to `pa-canary-runs/{timestamp}` and
 * surfaced in the ops dashboard.
 *
 * Schedule: every 30 minutes. Cost: ~48 invocations/day × ~1s each →
 * negligible Cloud Run minutes.
 */

import { onSchedule } from "firebase-functions/v2/scheduler"
import { defineSecret } from "firebase-functions/params"
import { logger } from "firebase-functions/v2"
import { getApps, initializeApp } from "firebase-admin/app"
import { getFirestore } from "firebase-admin/firestore"

export const CANARY_FROM_NUMBER = "+10000000000"

const SENDBLUE_WEBHOOK_SIGNING_SECRET = defineSecret("SENDBLUE_WEBHOOK_SIGNING_SECRET")

const WEBHOOK_URL =
  process.env.PA_CANARY_WEBHOOK_URL ??
  "https://pasendbluewebhook-evm6xq7jyq-uc.a.run.app"

type CanaryResult = {
  ok: boolean
  statusCode: number
  latencyMs: number
  error?: string
  receivedAt: string
}

export async function runCanary(opts: {
  webhookUrl?: string
  secret: string
  fetch?: typeof globalThis.fetch
  now?: () => number
}): Promise<CanaryResult> {
  const fetchFn = opts.fetch ?? globalThis.fetch
  const now = opts.now ?? Date.now
  const url = opts.webhookUrl ?? WEBHOOK_URL
  const start = now()

  const payload = {
    message_handle: `canary-${start}`,
    from_number: CANARY_FROM_NUMBER,
    number: CANARY_FROM_NUMBER,
    content: "__CANARY_PING__",
    is_outbound: false,
    received_at: new Date(start).toISOString(),
  }

  try {
    const res = await fetchFn(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "sb-signing-secret": opts.secret,
      },
      body: JSON.stringify(payload),
    })
    const latencyMs = now() - start
    const ok = res.status === 200
    return {
      ok,
      statusCode: res.status,
      latencyMs,
      error: ok ? undefined : `unexpected status ${res.status}`,
      receivedAt: new Date(start).toISOString(),
    }
  } catch (err) {
    const latencyMs = now() - start
    return {
      ok: false,
      statusCode: 0,
      latencyMs,
      error: err instanceof Error ? err.message : String(err),
      receivedAt: new Date(start).toISOString(),
    }
  }
}

export const paWebhookCanary = onSchedule(
  {
    schedule: "every 30 minutes",
    timeZone: "America/Los_Angeles",
    region: "us-central1",
    memory: "256MiB",
    timeoutSeconds: 60,
    secrets: [SENDBLUE_WEBHOOK_SIGNING_SECRET],
  },
  async () => {
    if (!getApps().length) initializeApp()
    const db = getFirestore()
    const result = await runCanary({ secret: SENDBLUE_WEBHOOK_SIGNING_SECRET.value() })

    const docId = `${result.receivedAt.replace(/[:.]/g, "-")}-${result.ok ? "ok" : "fail"}`
    try {
      await db.collection("pa-canary-runs").doc(docId).set({
        ...result,
        // 14-day TTL — canary history is operationally useful but not
        // long-term audit material.
        expiresAt: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
      })
    } catch (writeErr) {
      logger.warn("[canary] firestore write failed", {
        msg: writeErr instanceof Error ? writeErr.message : String(writeErr),
      })
    }

    if (!result.ok) {
      // Emit at ERROR severity so it shows up in the Cloud Logging dashboard
      // CF-error-rate panel and any alert policy bound to it.
      logger.error("[canary] webhook health check FAILED", {
        statusCode: result.statusCode,
        latencyMs: result.latencyMs,
        error: result.error,
      })
    } else {
      logger.info("[canary] webhook health check ok", {
        latencyMs: result.latencyMs,
      })
    }
  }
)
