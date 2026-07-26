import { readFileSync } from "node:fs"
import admin from "firebase-admin"
let raw = readFileSync(".env","utf8").match(/^FIREBASE_SERVICE_ACCOUNT_JSON=(.*)$/m)[1].trim()
if ((raw.startsWith("'")&&raw.endsWith("'"))||(raw.startsWith('"')&&raw.endsWith('"'))) raw=raw.slice(1,-1)
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)), projectId: "wekruit-5f89b" })
const db = admin.firestore()
const t = await db.collection("pa-turns").get()
const rows = []
for (const d of t.docs) {
  const x = d.data()
  for (const c of (x.toolCalls ?? [])) {
    if (!/match_yc_people/.test(c.name ?? "")) continue
    let a = {}
    try { a = typeof c.arguments === "string" ? JSON.parse(c.arguments) : (c.arguments ?? {}) } catch {}
    const blob = `${x.inboundText ?? ""} ${JSON.stringify(a)}`.toLowerCase()
    if (!/invest|angel|\bvc\b|venture|capital/.test(blob)) continue
    rows.push({ at: String(x.createdAt), uid: x.userId, in: String(x.inboundText ?? "").slice(0,80), a })
  }
}
rows.sort((a,b)=>a.at.localeCompare(b.at))
let setF = 0
for (const r of rows) {
  const pt = r.a?.personType
  if (Array.isArray(pt) && pt.includes("investor")) setF++
  console.log(`${r.at.slice(5,19)} ${r.uid} in="${r.in}"`)
  console.log(`   q=${JSON.stringify(r.a?.query)} pt=${JSON.stringify(pt)} sec=${JSON.stringify(r.a?.industrySector)} role=${JSON.stringify(r.a?.roleFunction)} lim=${r.a?.limit}`)
}
console.log(`\ninvestor-ish calls: ${rows.length}   personType had 'investor': ${setF}`)
process.exit(0)
