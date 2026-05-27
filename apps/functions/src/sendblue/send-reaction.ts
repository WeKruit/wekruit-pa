/**
 * Sendblue Reactions API — outbound wrapper (BUG #6 sister-feature).
 *
 * Endpoint: POST https://api.sendblue.com/api/send-reaction
 * Headers:  sb-api-key-id, sb-api-secret-key, content-type
 * Body:     { from_number, message_handle, reaction }
 *
 * Reaction values (per Sendblue docs): love | like | dislike | laugh |
 * emphasize | question. Mirrors Apple's iMessage tapback verbs.
 *
 * Constraints (per Sendblue docs 2026-04):
 *   - iMessage-only (SMS recipients reject).
 *   - Target message must be recent (within ~7 days of receipt).
 *
 * Error model — same shape as sendImessage but key="sendblue-reaction" so a
 * reaction outage does NOT trip the primary message breaker (and vice versa).
 * A flaky reactions endpoint shouldn't black out outbound messaging.
 */

import {
  getSendblueBreakerState,
  recordSendblueFailure,
  recordSendblueSuccess,
} from "./circuit-breaker.js"
import {
  getSendblueCreds,
  SendblueClientError,
  SendblueServerError,
  type SendblueCredentials,
} from "./sendblue-client.js"

const SEND_REACTION_URL = "https://api.sendblue.com/api/send-reaction"
const REACTION_BREAKER_KEY = "sendblue-reaction"
const DEFAULT_TIMEOUT_MS = 30_000

export type SendReactionInput = {
  to: string
  messageHandle: string
  reaction: "love" | "like" | "dislike" | "laugh" | "emphasize" | "question"
  /** Explicit sender line for the conversation thread. */
  fromNumber?: string
  /**
   * Optional user id for pool-aware sender selection when no explicit sender
   * was supplied. Same user id resolves to the same public Sendblue line.
   */
  userId?: string
  /** Firestore handle for pool lookup; lazily resolved when omitted. */
  db?: import("firebase-admin/firestore").Firestore
  /** Default true for backwards compatibility; public runtime passes false. */
  allowEnvFromNumberFallback?: boolean
}

export type SendReactionResponse = {
  status?: string
  message_handle?: string
  uuid?: string
  error_message?: string
  [key: string]: unknown
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

/**
 * POST /api/send-reaction.
 *
 * Throws SendblueClientError on 4xx (caller marks failed; do not retry).
 * Throws SendblueServerError on 5xx / 429 / network / timeout (caller retries).
 * Throws SendblueServerError(503) when reaction breaker is OPEN.
 */
export async function sendReaction(
  input: SendReactionInput,
  creds: SendblueCredentials = getSendblueCreds()
): Promise<SendReactionResponse> {
  // Fail-fast when breaker OPEN (reactions-specific key — won't blackout
  // primary message path).
  const breakerState = getSendblueBreakerState(REACTION_BREAKER_KEY)
  if (breakerState === "OPEN") {
    throw new SendblueServerError(
      503,
      "Sendblue reaction circuit OPEN — fail-fast (5+ consecutive failures, 60s cooldown)",
      null
    )
  }

  if (!input.messageHandle) {
    // Bad request — guard before paying network cost.
    throw new SendblueClientError(400, "send-reaction: messageHandle required", null)
  }
  if (!input.to) {
    throw new SendblueClientError(400, "send-reaction: to (recipient number) required", null)
  }

  const resolvedFromNumber = await resolveReactionFromNumber(input, creds)

  const body = {
    number: input.to,
    message_handle: input.messageHandle,
    reaction: input.reaction,
    ...(resolvedFromNumber ? { from_number: resolvedFromNumber } : {}),
  }

  let resp: Response
  try {
    resp = await withTimeout((signal) =>
      fetch(SEND_REACTION_URL, {
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
    recordSendblueFailure(REACTION_BREAKER_KEY)
    throw new SendblueServerError(
      0,
      `Sendblue send-reaction network error: ${err instanceof Error ? err.message : String(err)}`,
      null
    )
  }

  const parsed = (await readJson(resp)) as Partial<SendReactionResponse> | null
  const retryAfter = resp.headers.get("retry-after") ?? undefined

  if (resp.status >= 200 && resp.status < 300) {
    recordSendblueSuccess(REACTION_BREAKER_KEY)
    return (parsed ?? {}) as SendReactionResponse
  }

  const message =
    (parsed && typeof parsed === "object" && "error_message" in parsed
      ? String((parsed as { error_message?: unknown }).error_message ?? "")
      : "") ||
    (parsed && typeof parsed === "object" && "message" in parsed
      ? String((parsed as { message?: unknown }).message ?? "")
      : "") ||
    `Sendblue send-reaction HTTP ${resp.status}`

  if (resp.status >= 500 || resp.status === 429) {
    recordSendblueFailure(REACTION_BREAKER_KEY)
    throw new SendblueServerError(resp.status, message, parsed, retryAfter ?? undefined)
  }
  // 4xx — bad payload (e.g. message_handle expired). Don't trip breaker.
  throw new SendblueClientError(resp.status, message, parsed, retryAfter ?? undefined)
}

async function resolveReactionFromNumber(
  input: SendReactionInput,
  creds: SendblueCredentials
): Promise<string | undefined> {
  const explicit = input.fromNumber?.trim()
  if (explicit) return explicit

  if (input.userId) {
    try {
      const { loadSendbluePool, pickFromNumber } = await import("./pool.js")
      const { getFirestore } = await import("firebase-admin/firestore")
      const db = input.db ?? getFirestore()
      const picked = pickFromNumber(await loadSendbluePool(db), input.userId)
      if (picked) return picked
    } catch {
      // Pool lookup failure falls through to the caller-approved fallback.
    }
  }

  return input.allowEnvFromNumberFallback === false ? undefined : creds.fromNumber
}
