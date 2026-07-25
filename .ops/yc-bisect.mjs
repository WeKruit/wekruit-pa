import { readFileSync } from "node:fs"
import admin from "firebase-admin"
import * as O from "../packages/pa-orchestrator/dist/index.js"
let raw = readFileSync(".env","utf8").match(/^FIREBASE_SERVICE_ACCOUNT_JSON=(.*)$/m)[1].trim()
if ((raw.startsWith("'")&&raw.endsWith("'"))||(raw.startsWith('"')&&raw.endsWith('"'))) raw=raw.slice(1,-1)
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)), projectId: "wekruit-5f89b" })
const t = await admin.firestore().collection("pa-turns").where("userId","==","199b7601-85ef-4dcf-8758-6019cfe6f0e6").get()
const txt = t.docs.map(d=>d.data()).sort((a,b)=>String(a.createdAt).localeCompare(String(b.createdAt)))[1].inboundText
const norm = txt.trim().toLowerCase().replace(/[_-]+/g," ").replace(/[^a-z0-9一-鿿]+/g," ").replace(/\s+/g," ").trim()
console.log("norm len:", norm.length, "| first 120:", JSON.stringify(norm.slice(0,120)))
for (const [n, f] of [["parseHelloWekruitOpener",O.parseHelloWekruitOpener],["isWekruitJobOpener",O.isWekruitJobOpener],["parseLinkedinDoneOpener",O.parseLinkedinDoneOpener]]) {
  try { console.log(`  ${n} →`, JSON.stringify(f?.(txt))) } catch(e){ console.log(`  ${n} ERR`, String(e).slice(0,60)) }
}
console.log("  re yc-open  →", /^(?:hey |hi |hello )?i ?m at yc startup school/.test(norm))
console.log("  re greeting →", /^(?:hello|hi|hey|yo|sup)(?:\s+(?:wekruit|claire))?$/.test(norm))
console.log("  empty?      →", !norm)
process.exit(0)
