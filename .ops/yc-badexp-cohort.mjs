/** Users who RECEIVED a message damaged by the invented guard / internal-narration leak. */
import { readFileSync } from "node:fs"
import admin from "firebase-admin"
let raw = readFileSync(".env","utf8").match(/^FIREBASE_SERVICE_ACCOUNT_JSON=(.*)$/m)[1].trim()
if ((raw.startsWith("'")&&raw.endsWith("'"))||(raw.startsWith('"')&&raw.endsWith('"'))) raw=raw.slice(1,-1)
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)), projectId: "wekruit-5f89b" })
const db = admin.firestore()
const LEAKS = ["on your screen","previous batch","nothing new came through","i tried to pull",
  "can't send another batch","cant send another batch","go deeper on","go deeper with","dive deeper",
  "still on their screen","i don't want to spam","i dont want to spam","already viewing"]
const since = new Date(Date.now()-10*3600*1000).toISOString()
const o = await db.collection("pa-outbound").where("createdAt",">=",since).get()
const hit = new Map()
for (const d of o.docs) {
  const x = d.data()
  if (x.status !== "sent" && x.status !== "delivered") continue
  const b = String(x.body ?? "").toLowerCase()
  const which = LEAKS.filter(p => b.includes(p))
  if (!which.length) continue
  if (!hit.has(x.userId)) hit.set(x.userId, { n: 0, phrases: new Set(), last: "" })
  const h = hit.get(x.userId); h.n++; which.forEach(p=>h.phrases.add(p))
  if (String(x.createdAt) > h.last) h.last = String(x.createdAt)
}
console.log(`BAD-EXPERIENCE COHORT (received a leaked/refusal message): ${hit.size} users`)
const rows = []
for (const [uid,h] of hit) {
  const u = (await db.collection("pa-users").doc(uid).get()).data() ?? {}
  rows.push({ uid, phone: u.phoneE164 ?? "-", n: h.n, last: h.last, dnc: u.doNotContact===true, phrases: [...h.phrases].slice(0,2).join(" | ") })
}
rows.sort((a,b)=>b.n-a.n)
for (const r of rows) console.log(`  ${r.phone} ${String(r.n).padStart(2)}x ${r.dnc?"[paused]":"       "} ${r.phrases}`)
process.exit(0)
