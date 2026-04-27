/**
 * Sendblue native typing-indicator API (CHANNEL-07, D-06).
 *
 * Replaces Phase 15 chunked typing simulation on the Sendblue path.
 * Best-effort: log + swallow errors. Typing indicators are UX, never block
 * the actual send.
 */

import { getSendblueCreds, type SendblueCredentials } from "./sendblue-client.js"

const TYPING_URL = "https://api.sendblue.co/api/send-message/typing-indicator"
const TYPING_TIMEOUT_MS = 5_000

export type TypingIndicatorInput = {
  to: string
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
        ...(creds.fromNumber ? { from_number: creds.fromNumber } : {}),
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
  return process.env.PA_TYPING_INDICATOR === "1"
}
