import { readFileSync } from "node:fs"
import admin from "firebase-admin"
let raw = readFileSync(process.env.PA_ENV_PATH, "utf8").match(/^FIREBASE_SERVICE_ACCOUNT_JSON=(.*)$/m)[1].trim()
if ((raw.startsWith("'") && raw.endsWith("'")) || (raw.startsWith('"') && raw.endsWith('"'))) raw = raw.slice(1,-1)
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)), projectId: "wekruit-5f89b" })
const db = admin.firestore()
const snap = await db.collection("pa-users").where("source","==","yc_startup_school").get()
const since = new Date(Date.now()-24*3600*1000).toISOString()
let withPic=0, noPic=0, realUrl=0, marker=0
for (const d of snap.docs) {
  const u=d.data(); if (String(u.createdAt??"") < since) continue
  const li=String(u.linkedinUrl??"")
  if (!li) continue
  const isMarker = li.includes("/oauth-linked/")
  if (isMarker) marker++; else realUrl++
  const pic = String(u.linkedinOauthPicture??"")
  if (pic) withPic++; else noPic++
  const enriched = Boolean(u.coresignalEmployeeId)
  if (isMarker) console.log(`${d.id.slice(0,8)} marker enriched=${enriched} pic=${pic?pic.slice(0,60):"NONE"}`)
}
console.log(`\nreal URL ${realUrl} | oauth marker ${marker} | has picture ${withPic} | no picture ${noPic}`)
process.exit(0)
