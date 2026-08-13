/**
 * READ-ONLY: one user's recent pa-outbound rows with created/sent timestamps + lag.
 *   PA_ENV_PATH=$PWD/.env node .ops/zz-user-outbound.mjs <uid> [sinceIso]
 */
import { readFileSync } from "node:fs"
import admin from "firebase-admin"
let raw = readFileSync(process.env.PA_ENV_PATH, "utf8").match(/^FIREBASE_SERVICE_ACCOUNT_JSON=(.*)$/m)[1].trim()
if ((raw.startsWith("'") && raw.endsWith("'")) || (raw.startsWith('"') && raw.endsWith('"'))) raw = raw.slice(1, -1)
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)), projectId: "wekruit-5f89b" })
const db = admin.firestore()
const uid = process.argv[2]
const since = process.argv[3] ?? "2026-07-25T17:00:00Z"
const u = (await db.collection("pa-users").doc(uid).get()).data() ?? {}
console.log(`uid=${uid} phone=${u.phoneE164 ?? "-"} name=${u.displayName ?? "-"}`)
const o = await db.collection("pa-outbound").where("userId", "==", uid).where("createdAt", ">=", since).get()
const rows = o.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))
for (const r of rows) {
  const c = Date.parse(r.createdAt ?? "")
  const s = Date.parse(r.sendblueDeliveredAt ?? r.sentAt ?? r.updatedAt ?? "")
  const lag = Number.isFinite(c) && Number.isFinite(s) ? ((s - c) / 1000).toFixed(1) : "-"
  console.log(`  created=${String(r.createdAt).slice(11, 23)} sent=${String(r.sendblueDeliveredAt ?? r.sentAt ?? r.updatedAt ?? "-").slice(11, 23)} lag=${lag}s status=${r.status} seq=${r.sequenceIndex ?? "-"} err=${String(r.error ?? "-").slice(0, 50)} "${String(r.body ?? "").replace(/\n/g, " ").slice(0, 70)}"`)
}
process.exit(0)
