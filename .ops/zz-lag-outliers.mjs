/**
 * READ-ONLY: lag percentiles for a window PLUS the slowest rows named.
 *   PA_ENV_PATH=$PWD/.env node .ops/zz-lag-outliers.mjs [mins]
 */
import { readFileSync } from "node:fs"
import admin from "firebase-admin"
let raw = readFileSync(process.env.PA_ENV_PATH, "utf8").match(/^FIREBASE_SERVICE_ACCOUNT_JSON=(.*)$/m)[1].trim()
if ((raw.startsWith("'") && raw.endsWith("'")) || (raw.startsWith('"') && raw.endsWith('"'))) raw = raw.slice(1, -1)
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)), projectId: "wekruit-5f89b" })
const db = admin.firestore()
const mins = Number(process.argv[2] ?? 15)
const since = new Date(Date.now() - mins * 60 * 1000).toISOString()
const o = await db.collection("pa-outbound").where("createdAt", ">=", since).get()
const rows = []
for (const d of o.docs) {
  const r = d.data()
  const c = Date.parse(r.createdAt ?? "")
  const s = Date.parse(r.sendblueDeliveredAt ?? r.sentAt ?? r.updatedAt ?? "")
  if (Number.isFinite(c) && Number.isFinite(s) && s >= c) {
    rows.push({ id: d.id, lag: (s - c) / 1000, createdAt: r.createdAt, sentAt: r.sendblueDeliveredAt ?? r.sentAt ?? r.updatedAt, uid: r.userId, status: r.status, body: String(r.body ?? "").replace(/\n/g, " ").slice(0, 60) })
  }
}
rows.sort((a, b) => a.lag - b.lag)
const lags = rows.map((r) => r.lag)
const p = (q) => lags[Math.floor(lags.length * q)]?.toFixed(1)
console.log(`last ${mins} min (since ${since}): rows=${o.size} measured=${lags.length}`)
console.log(`  p50=${p(0.5)}s p90=${p(0.9)}s p99=${p(0.99)}s max=${lags[lags.length - 1]?.toFixed(1)}s`)
console.log(`  slowest 5:`)
for (const r of rows.slice(-5)) console.log(`    ${r.lag.toFixed(1)}s created=${r.createdAt} sent=${r.sentAt} status=${r.status} uid=${r.uid} "${r.body}"`)
process.exit(0)
