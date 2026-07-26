/**
 * Re-process the messages that never got an answer (Adam 2026-07-25: "process their message now").
 *
 * These users sent something real and got nothing back — either the window guard refused the call,
 * the YC lane dropped, or they were caught by the fleet pause. All of those causes are now fixed and
 * deployed, so the right recovery is to run their message through the REAL pipeline again rather
 * than hand-writing replies: same webhook, same agent, same delivery.
 *
 * Mechanism (same as the email-sender SEV recovery): `pa-sendblue-webhook-raw` stores the original
 * body AND the original `sb-signing-secret` header, so the payload can be re-POSTed verbatim. The
 * inbound row is keyed `sendblue-<message_handle>`, so the FIRST processing already claimed it — the
 * claim doc is cleared for exactly the messages we replay, or the webhook would dedup and no-op.
 *
 * SAFETY
 *   - dry run by default; `--apply` also requires `--yes-adam-said-go`.
 *   - only users whose LAST message is theirs AND who have no outbound row created after it.
 *   - skips anyone opted out / still paused.
 *   - backs up every inbound-event doc it clears to .ops/reprocess-backup-<ts>.json first.
 *   - `--limit N` to canary.
 */
import { readFileSync, writeFileSync } from "node:fs"
import admin from "firebase-admin"

let raw = readFileSync(".env", "utf8").match(/^FIREBASE_SERVICE_ACCOUNT_JSON=(.*)$/m)[1].trim()
if ((raw.startsWith("'") && raw.endsWith("'")) || (raw.startsWith('"') && raw.endsWith('"'))) raw = raw.slice(1, -1)
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)), projectId: "wekruit-5f89b" })
const db = admin.firestore()

const args = process.argv.slice(2)
const apply = args.includes("--apply") && args.includes("--yes-adam-said-go")
const armed = args.includes("--apply")
const li = args.indexOf("--limit")
const limit = li > -1 ? Number(args[li + 1]) : Number.POSITIVE_INFINITY
const WEBHOOK = process.env.REPLAY_WEBHOOK_URL ?? "https://us-central1-wekruit-5f89b.cloudfunctions.net/paSendblueWebhook"

const sinceIso = new Date(Date.now() - 8 * 3600 * 1000).toISOString()

// 1. who is unanswered
const msgs = await db.collection("pa-messages").where("createdAt", ">=", sinceIso).get()
const byUser = new Map()
for (const d of msgs.docs) {
  const x = d.data()
  if (!byUser.has(x.userId)) byUser.set(x.userId, [])
  byUser.get(x.userId).push(x)
}
const targets = []
for (const [uid, list] of byUser) {
  list.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))
  const last = list[list.length - 1]
  if ((last.direction ?? last.role) !== "user") continue
  const ob = await db.collection("pa-outbound").where("userId", "==", uid).get()
  if (ob.docs.some((x) => String(x.data().createdAt ?? "") > String(last.createdAt))) continue
  const u = (await db.collection("pa-users").doc(uid).get()).data() ?? {}
  if (u.doNotContact === true) continue // still paused or genuinely opted out — never text them
  if (!u.phoneE164) continue
  targets.push({ uid, phone: u.phoneE164, at: String(last.createdAt), text: String(last.text ?? last.body ?? "") })
}
targets.sort((a, b) => a.at.localeCompare(b.at))

// 2. find each one's raw webhook payload (match on sender + content)
const rawSnap = await db.collection("pa-sendblue-webhook-raw").where("receivedAt", ">=", sinceIso).get()
const rawRows = rawSnap.docs.map((d) => ({ id: d.id, ...d.data() }))
const plan = []
for (const t of targets) {
  const hit = rawRows.find((r) => {
    try {
      const b = JSON.parse(String(r.bodyText))
      if (b.is_outbound === true) return false
      const from = String(b.from_number ?? b.number ?? "")
      return from.replace(/[^0-9+]/g, "") === t.phone && String(b.content ?? "").trim() === t.text.trim()
    } catch {
      return false
    }
  })
  if (!hit) continue
  const body = JSON.parse(String(hit.bodyText))
  const handle = String(body.message_handle ?? "")
  plan.push({ ...t, rawId: hit.id, handle, headers: hit.headers ?? {}, bodyText: String(hit.bodyText) })
}

console.log(`unanswered users: ${targets.length}`)
console.log(`with a replayable raw payload: ${plan.length}`)
console.log(`missing raw payload (cannot replay): ${targets.length - plan.length}`)
const batch = plan.slice(0, limit)
console.log(`\nwould replay: ${batch.length}${Number.isFinite(limit) ? ` (--limit ${limit})` : ""}`)
for (const p of batch.slice(0, 12)) console.log(`  ${p.at.slice(11, 19)} ${p.phone} "${p.text.replace(/\n/g, " ").slice(0, 56)}"`)
if (batch.length > 12) console.log(`  … +${batch.length - 12} more`)

if (!apply) {
  console.log(armed
    ? "\nREFUSED: --apply needs --yes-adam-said-go (this texts real users)."
    : "\nDRY RUN. To send: --apply --yes-adam-said-go [--limit N]")
  process.exit(0)
}

// 3. back up, clear the claim, re-POST
const backup = []
for (const p of batch) {
  const ref = db.collection("pa-inbound-events").doc(`sendblue-${p.handle}`)
  const snap = await ref.get()
  if (snap.exists) backup.push({ id: ref.id, data: snap.data() })
}
const backupPath = `.ops/reprocess-backup-${Date.now()}.json`
writeFileSync(backupPath, JSON.stringify(backup, null, 2))
console.log(`\nbacked up ${backup.length} inbound-event docs → ${backupPath}`)

let ok = 0, fail = 0
for (const p of batch) {
  try {
    await db.collection("pa-inbound-events").doc(`sendblue-${p.handle}`).delete().catch(() => {})
    const headers = { "content-type": "application/json" }
    if (p.headers["sb-signing-secret"]) headers["sb-signing-secret"] = p.headers["sb-signing-secret"]
    const res = await fetch(WEBHOOK, { method: "POST", headers, body: p.bodyText })
    if (res.ok) ok++
    else { fail++; console.log(`  FAIL ${p.phone} → ${res.status} ${(await res.text()).slice(0, 80)}`) }
    await new Promise((r) => setTimeout(r, 400)) // gentle on the fleet
  } catch (e) {
    fail++
    console.log(`  ERR ${p.phone} → ${String(e).slice(0, 80)}`)
  }
}
console.log(`\nREPLAYED ok=${ok} fail=${fail}`)
process.exit(0)
