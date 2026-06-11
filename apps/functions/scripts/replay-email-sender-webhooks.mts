/**
 * Victim-recovery replay for the email-Apple-ID sender SEV (2026-06-11).
 *
 * iPhones with "Start New Conversations From: Apple ID" sent iMessage with an
 * EMAIL `from_number`. Sendblue delivered the webhooks fine (stored complete
 * in `pa-sendblue-webhook-raw`) but the E.164 sender gate silently rejected
 * every one. With the gate reworked (email-sender resolution + phone rewrite),
 * the dropped messages can be recovered by re-POSTing the ORIGINAL Sendblue
 * payloads to the deployed webhook — idempotency holds because the inbound
 * row key is `sendblue-${message_handle}` and the new pipeline never created
 * one for these messages.
 *
 * SAFETY:
 *   - Default is DRY-RUN: prints what WOULD replay, sends nothing.
 *   - `--apply` actually re-POSTs. Run ONLY after the gate fix is DEPLOYED
 *     and with operator approval.
 *   - Webhook URL + signing-secret header come from env vars — never
 *     hardcoded, never read from Firebase secrets:
 *       REPLAY_WEBHOOK_URL     e.g. https://us-central1-….cloudfunctions.net/paSendblueWebhook
 *       REPLAY_SIGNING_SECRET  the `sb-signing-secret` header value
 *
 * Usage:
 *   export GOOGLE_APPLICATION_CREDENTIALS=…   # Firestore read access
 *   # dry run (default last 7 days):
 *   node --import tsx apps/functions/scripts/replay-email-sender-webhooks.mts
 *   # narrower window:
 *   node --import tsx apps/functions/scripts/replay-email-sender-webhooks.mts --since-days 3
 *   # actually replay:
 *   REPLAY_WEBHOOK_URL=… REPLAY_SIGNING_SECRET=… \
 *     node --import tsx apps/functions/scripts/replay-email-sender-webhooks.mts --apply
 */

import { initializeApp, applicationDefault } from "firebase-admin/app"
import { getFirestore } from "firebase-admin/firestore"

type RawDoc = {
  receivedAt?: string
  bodyText?: string
  headers?: Record<string, string>
}

type ReplayCandidate = {
  rawDocId: string
  receivedAt: string
  dateSent: string
  messageHandle: string
  fromNumber: string
  toNumber: string
  contentPreview: string
  payload: Record<string, unknown>
}

function parseArgs(argv: string[]): { apply: boolean; sinceDays: number } {
  let apply = false
  let sinceDays = 7
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === "--apply") apply = true
    else if (arg === "--since-days") {
      const v = Number(argv[i + 1])
      if (!Number.isFinite(v) || v <= 0) {
        console.error(`--since-days requires a positive number, got: ${argv[i + 1]}`)
        process.exit(1)
      }
      sinceDays = v
      i++
    } else if (arg === "--help" || arg === "-h") {
      console.log("Usage: replay-email-sender-webhooks.mts [--apply] [--since-days N]")
      process.exit(0)
    } else {
      console.error(`Unknown argument: ${arg}`)
      process.exit(1)
    }
  }
  return { apply, sinceDays }
}

function looksLikeEmail(value: string): boolean {
  const at = value.indexOf("@")
  if (at <= 0 || at === value.length - 1) return false
  return value.slice(at + 1).includes(".")
}

const { apply, sinceDays } = parseArgs(process.argv.slice(2))

const webhookUrl = process.env.REPLAY_WEBHOOK_URL ?? ""
const signingSecret = process.env.REPLAY_SIGNING_SECRET ?? ""
if (apply && (!webhookUrl || !signingSecret)) {
  console.error("--apply requires REPLAY_WEBHOOK_URL and REPLAY_SIGNING_SECRET env vars.")
  process.exit(1)
}

initializeApp({ credential: applicationDefault(), projectId: "wekruit-5f89b" })
const db = getFirestore()

const sinceIso = new Date(Date.now() - sinceDays * 86_400_000).toISOString()
console.log(`[replay] mode=${apply ? "APPLY" : "dry-run"} since=${sinceIso} (${sinceDays}d)`)

const rawSnap = await db.collection("pa-sendblue-webhook-raw").get()
console.log(`[replay] raw webhook rows scanned: ${rawSnap.size}`)

// Dedup by message_handle — Sendblue retries + our raw log can both duplicate.
const byHandle = new Map<string, ReplayCandidate>()
let parseFailures = 0

for (const doc of rawSnap.docs) {
  const raw = doc.data() as RawDoc
  const receivedAt = typeof raw.receivedAt === "string" ? raw.receivedAt : ""
  if (typeof raw.bodyText !== "string" || !raw.bodyText) continue

  let payload: Record<string, unknown>
  try {
    const parsed = JSON.parse(raw.bodyText)
    if (!parsed || typeof parsed !== "object") continue
    payload = parsed as Record<string, unknown>
  } catch {
    parseFailures++
    continue
  }

  // Only inbound receive events whose SENDER is an email handle.
  if (payload.is_outbound === true) continue
  const fromNumber = typeof payload.from_number === "string" ? payload.from_number.trim() : ""
  const messageHandle = typeof payload.message_handle === "string" ? payload.message_handle.trim() : ""
  if (!fromNumber || !messageHandle) continue
  if (!looksLikeEmail(fromNumber)) continue

  const dateSent = typeof payload.date_sent === "string" ? payload.date_sent : ""
  // Window filter — prefer the Sendblue device timestamp, fall back to our
  // receivedAt. Skip anything older than the window.
  const effectiveAt = dateSent || receivedAt
  if (!effectiveAt || effectiveAt < sinceIso) continue

  const candidate: ReplayCandidate = {
    rawDocId: doc.id,
    receivedAt,
    dateSent,
    messageHandle,
    fromNumber,
    toNumber: typeof payload.to_number === "string" ? payload.to_number : "",
    contentPreview: String(payload.content ?? "").slice(0, 80),
    payload,
  }
  // Keep the FIRST seen per handle (payload content is identical across
  // retries; the row choice does not matter beyond determinism).
  if (!byHandle.has(messageHandle)) byHandle.set(messageHandle, candidate)
}

const candidates = [...byHandle.values()].sort((a, b) =>
  (a.dateSent || a.receivedAt).localeCompare(b.dateSent || b.receivedAt))

console.log(`[replay] email-sender payloads in window: ${candidates.length} (dedup by message_handle; ${parseFailures} unparseable rows skipped)`)
for (const c of candidates) {
  console.log(
    `  ${c.dateSent || c.receivedAt} handle=${c.messageHandle} from=${c.fromNumber} to=${c.toNumber} | ${c.contentPreview}`,
  )
}

if (!apply) {
  console.log("[replay] DRY-RUN complete — nothing sent. Re-run with --apply (plus REPLAY_WEBHOOK_URL / REPLAY_SIGNING_SECRET) to replay.")
  process.exit(0)
}

let ok = 0
let failed = 0
for (const c of candidates) {
  const body = JSON.stringify(c.payload)
  try {
    const resp = await fetch(webhookUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        // Shared-secret mode: the webhook verifies this header value verbatim.
        "sb-signing-secret": signingSecret,
      },
      body,
    })
    const text = await resp.text()
    if (resp.ok) {
      ok++
      console.log(`[replay] OK ${resp.status} handle=${c.messageHandle} → ${text.slice(0, 160)}`)
    } else {
      failed++
      console.error(`[replay] FAIL ${resp.status} handle=${c.messageHandle} → ${text.slice(0, 200)}`)
    }
  } catch (err) {
    failed++
    console.error(`[replay] ERROR handle=${c.messageHandle}: ${err instanceof Error ? err.message : String(err)}`)
  }
  // Gentle pacing — these fan out into trigger handlers + outbound sends.
  await new Promise((resolve) => setTimeout(resolve, 1_500))
}

console.log(`[replay] done — replayed=${ok} failed=${failed} of ${candidates.length}`)
process.exit(failed > 0 ? 1 : 0)
