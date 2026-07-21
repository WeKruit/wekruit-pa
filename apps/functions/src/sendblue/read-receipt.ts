/**
 * Sendblue native read-receipt API — marks the candidate's INBOUND iMessage as "Read"
 * (the blue "Read" label on their device), the real read receipt — NOT a typing substitute.
 *
 * Sendblue DOES support this (https://docs.sendblue.com/api-v2/read-receipts/):
 *   POST /api/mark-read  body { number, from_number }  (iMessage/RCS only, not SMS)
 *
 * Uses the same host + auth as the proven typing-indicator call (api.sendblue.co, which is the
 * base that empirically authenticates with these creds — the doc's .com host 301s to the same API).
 * Best-effort: log + swallow. A read receipt is UX, never blocks the turn.
 */
import { getSendblueCreds, type SendblueCredentials } from "./sendblue-client.js"
import { isSyntheticRecipientNumber } from "./synthetic-recipient.js"

// The official doc spells the endpoint as api.sendblue.com/api/mark-read, but the proven
// in-codebase base (typing-indicator) is api.sendblue.co. They're the same API; try the doc host
// first, fall back to the .co host the account is known to authenticate on. Best-effort either way.
const MARK_READ_URLS = [
  "https://api.sendblue.com/api/mark-read",
  "https://api.sendblue.co/api/mark-read",
]
const MARK_READ_TIMEOUT_MS = 3_000

export type ReadReceiptInput = {
  /** recipient (the candidate) E.164 — the person whose inbound message we mark read. */
  to: string
  /** the Sendblue line this conversation is on; falls back to creds.fromNumber. */
  fromNumber?: string
}

export async function sendReadReceipt(
  input: ReadReceiptInput,
  creds: SendblueCredentials = getSendblueCreds(),
  log: (...args: unknown[]) => void = console.log
): Promise<void> {
  // 2026-06-19 incident hard backstop — synthetic/test recipient NEVER posts.
  // Read receipt is best-effort UX; skip silently (no throw).
  if (isSyntheticRecipientNumber(input.to)) {
    log("[sendblue][mark-read] blocked synthetic recipient (no POST)", input.to)
    return
  }
  const fromNumber = input.fromNumber?.trim() || creds.fromNumber
  const body = JSON.stringify({
    number: input.to,
    ...(fromNumber ? { from_number: fromNumber } : {}),
  })
  // Hit both hosts in PARALLEL (one of .com/.co is right for this account) so the read receipt
  // is fast — never on the reply's critical path. Best-effort: log per host, swallow failures.
  await Promise.allSettled(
    MARK_READ_URLS.map(async (url) => {
      const ctrl = new AbortController()
      const t = setTimeout(() => ctrl.abort(), MARK_READ_TIMEOUT_MS)
      try {
        const resp = await fetch(url, {
          method: "POST",
          headers: {
            "sb-api-key-id": creds.apiKeyId,
            "sb-api-secret-key": creds.apiSecretKey,
            "content-type": "application/json",
          },
          body,
          signal: ctrl.signal,
        })
        const txt = resp.ok ? "" : await resp.text().catch(() => "")
        log(`[sendblue][mark-read] ${resp.ok ? "ok" : "non-2xx"}`, url, resp.status, txt.slice(0, 160))
      } catch (err) {
        log("[sendblue][mark-read] error", url, err instanceof Error ? err.message : String(err))
      } finally {
        clearTimeout(t)
      }
    }),
  )
}

export function isSendblueReadReceiptEnabled(): boolean {
  // On unless explicitly disabled.
  return process.env.PA_READ_RECEIPT !== "0"
}
