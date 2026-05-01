/**
 * Sendblue REST client (D-05).
 *
 * Endpoint contract verified via live probe 2026-04-27:
 *   POST https://api.sendblue.co/api/send-message
 *   Headers: sb-api-key-id, sb-api-secret-key, content-type
 *
 * Free_api / sandbox plans REQUIRE `from_number` in the body. Paid dedicated
 * lines auto-populate. Caller injects via `SENDBLUE_FROM_NUMBER` env var.
 *
 * Error model:
 *   - 4xx → SendblueClientError (caller maps to pa_outbound.failed; do not retry)
 *   - 5xx → SendblueServerError (caller leaves status=pending; CF re-fires)
 *   - 429 → preserves `retry-after` for R-02 mitigation
 *   - timeout → SendblueServerError (treat as transient)
 */

import type { SendblueSendRequest, SendblueSendResponse } from "./types.js"
import {
  getSendblueBreakerState,
  recordSendblueFailure,
  recordSendblueSuccess,
  SendblueCircuitOpenError,
} from "./circuit-breaker.js"

const SEND_MESSAGE_URL = "https://api.sendblue.co/api/send-message"
const TYPING_INDICATOR_URL = "https://api.sendblue.co/api/send-message/typing-indicator"
const DEFAULT_TIMEOUT_MS = 30_000

export type SendblueCredentials = {
  apiKeyId: string
  apiSecretKey: string
  /** Optional: for free_api / sandbox plans. */
  fromNumber?: string
}

export class SendblueClientError extends Error {
  readonly status: number
  readonly body: unknown
  readonly retryAfter?: string
  constructor(status: number, message: string, body: unknown, retryAfter?: string) {
    super(message)
    this.name = "SendblueClientError"
    this.status = status
    this.body = body
    this.retryAfter = retryAfter
  }
}

export class SendblueServerError extends Error {
  readonly status: number
  readonly body: unknown
  readonly retryAfter?: string
  constructor(status: number, message: string, body: unknown, retryAfter?: string) {
    super(message)
    this.name = "SendblueServerError"
    this.status = status
    this.body = body
    this.retryAfter = retryAfter
  }
}

export function getSendblueCreds(): SendblueCredentials {
  const apiKeyId = process.env.SENDBLUE_API_KEY_ID?.trim() ?? ""
  const apiSecretKey = process.env.SENDBLUE_API_SECRET_KEY?.trim() ?? ""
  if (!apiKeyId || !apiSecretKey) {
    throw new Error("Sendblue credentials missing — SENDBLUE_API_KEY_ID / SENDBLUE_API_SECRET_KEY not set")
  }
  const fromNumber = process.env.SENDBLUE_FROM_NUMBER?.trim() || undefined
  return { apiKeyId, apiSecretKey, fromNumber }
}

async function withTimeout<T>(p: (signal: AbortSignal) => Promise<T>, ms = DEFAULT_TIMEOUT_MS): Promise<T> {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), ms)
  try {
    return await p(ctrl.signal)
  } finally {
    clearTimeout(t)
  }
}

async function readJson(resp: Response): Promise<unknown> {
  const txt = await resp.text()
  if (!txt) return null
  try {
    return JSON.parse(txt)
  } catch {
    return { raw: txt }
  }
}

export type SendImessageInput = {
  to: string
  content: string
  statusCallback?: string
}

/**
 * POST /api/send-message — primary outbound send.
 *
 * Throws SendblueClientError on 4xx (do not retry; caller marks failed).
 * Throws SendblueServerError on 5xx / network / timeout (caller retries).
 */
export async function sendImessage(
  input: SendImessageInput,
  creds: SendblueCredentials = getSendblueCreds()
): Promise<SendblueSendResponse> {
  // Phase 40 prod — fail-fast when breaker OPEN. Maps to a transient server
  // error so the outbox marks status=pending, releasing for retry; by the
  // time the row re-fires, the 60s window has elapsed and we try HALF_OPEN.
  const breakerState = getSendblueBreakerState()
  if (breakerState === "OPEN") {
    throw new SendblueServerError(
      503,
      "Sendblue circuit OPEN — fail-fast (5+ consecutive failures, 60s cooldown)",
      null
    )
  }

  const body: SendblueSendRequest = {
    number: input.to,
    content: input.content,
    ...(creds.fromNumber ? { from_number: creds.fromNumber } : {}),
    ...(input.statusCallback ? { status_callback: input.statusCallback } : {}),
  }

  let resp: Response
  try {
    resp = await withTimeout((signal) =>
      fetch(SEND_MESSAGE_URL, {
        method: "POST",
        headers: {
          "sb-api-key-id": creds.apiKeyId,
          "sb-api-secret-key": creds.apiSecretKey,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
        signal,
      })
    )
  } catch (err) {
    // Network / abort — count toward breaker AND surface as transient.
    recordSendblueFailure()
    throw new SendblueServerError(
      0,
      `Sendblue send-message network error: ${err instanceof Error ? err.message : String(err)}`,
      null
    )
  }

  const parsed = (await readJson(resp)) as Partial<SendblueSendResponse> | null
  const retryAfter = resp.headers.get("retry-after") ?? undefined

  if (resp.status >= 200 && resp.status < 300) {
    recordSendblueSuccess()
    return (parsed ?? {}) as SendblueSendResponse
  }

  const message =
    (parsed && typeof parsed === "object" && "error_message" in parsed
      ? String((parsed as { error_message?: unknown }).error_message ?? "")
      : "") ||
    (parsed && typeof parsed === "object" && "message" in parsed
      ? String((parsed as { message?: unknown }).message ?? "")
      : "") ||
    `Sendblue send-message HTTP ${resp.status}`

  if (resp.status >= 500 || resp.status === 429) {
    // Transient — record failure (counts toward breaker open) + throw retry-able.
    recordSendblueFailure()
    throw new SendblueServerError(resp.status, message, parsed, retryAfter ?? undefined)
  }
  // 4xx — caller marks failed; do NOT count toward breaker (4xx = bad payload,
  // not a Sendblue outage). e.g. unprovisioned recipient should not trip a
  // breaker that affects other valid recipients.
  throw new SendblueClientError(resp.status, message, parsed, retryAfter ?? undefined)
}
