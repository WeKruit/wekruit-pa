/**
 * Sendblue native typing-indicator API (CHANNEL-07, D-06).
 *
 * Replaces Phase 15 chunked typing simulation on the Sendblue path.
 * Best-effort: log + swallow errors. Typing indicators are UX, never block
 * the actual send.
 */

import { getSendblueCreds, type SendblueCredentials } from "./sendblue-client.js"

// Verified empirically 2026-04-27: real endpoint is /api/send-typing-indicator
// (NOT under /send-message/). Doc page is misleading.
const TYPING_URL = "https://api.sendblue.co/api/send-typing-indicator"
const TYPING_TIMEOUT_MS = 5_000

export type TypingIndicatorInput = {
  to: string
  /** the Sendblue pool line this conversation is on; falls back to creds.fromNumber.
   *  Required for multi-number pools — typing must come FROM the thread's line or
   *  Sendblue can't match it to the conversation → no typing bubble (same constraint
   *  as the read receipt). */
  fromNumber?: string
}

export async function sendTypingIndicator(
  input: TypingIndicatorInput,
  creds: SendblueCredentials = getSendblueCreds(),
  log: (...args: unknown[]) => void = console.log
): Promise<void> {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), TYPING_TIMEOUT_MS)
  try {
    const resp = await fetch(TYPING_URL, {
      method: "POST",
      headers: {
        "sb-api-key-id": creds.apiKeyId,
        "sb-api-secret-key": creds.apiSecretKey,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        number: input.to,
        ...((input.fromNumber?.trim() || creds.fromNumber)
          ? { from_number: input.fromNumber?.trim() || creds.fromNumber }
          : {}),
      }),
      signal: ctrl.signal,
    })
    if (!resp.ok) {
      const txt = await resp.text().catch(() => "")
      log("[sendblue][typing] non-2xx", resp.status, txt.slice(0, 200))
    }
  } catch (err) {
    log(
      "[sendblue][typing] swallow error",
      err instanceof Error ? err.message : String(err)
    )
  } finally {
    clearTimeout(t)
  }
}

export function isSendblueTypingIndicatorEnabled(): boolean {
  // 2026-05-19 — always on unless explicitly disabled via PA_TYPING_INDICATOR=0.
  // Mirrors apps/functions/src/sendblue/outbox.ts isTypingIndicatorEnabled().
  return process.env.PA_TYPING_INDICATOR !== "0"
}

/**
 * Phase 24 T1E — dynamic typing dwell.
 *
 * Replaces fixed PA_TYPING_DWELL_MS=2500 (Phase 21) with reply-length-
 * scaled dwell so longer replies feel like the AI is actually composing.
 *
 * Per 24-RESEARCH.md Pattern 6:
 *   ≤30 chars → 1000ms (one-liner reaction)
 *   31-100   → 2000ms (short reply)
 *   101-200  → 3000ms (medium reply)
 *   >200     → 4000ms (long technical reply)
 *
 * Capped at 4000ms — Sendblue's typing indicator auto-fades after ~3s on
 * recipient device anyway (24-RESEARCH.md "Architecture note"). Re-firing
 * mid-dwell is a Wave 2 polish item, deferred.
 */
export function computeTypingDwellMs(replyLength: number): number {
  if (replyLength <= 30) return 1000
  if (replyLength <= 100) return 2000
  if (replyLength <= 200) return 3000
  return 4000
}
