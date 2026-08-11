import { readFileSync } from "node:fs"
import admin from "firebase-admin"
let raw = readFileSync(process.env.PA_ENV_PATH, "utf8").match(/^FIREBASE_SERVICE_ACCOUNT_JSON=(.*)$/m)[1].trim()
if ((raw.startsWith("'")&&raw.endsWith("'"))||(raw.startsWith('"')&&raw.endsWith('"'))) raw=raw.slice(1,-1)
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)), projectId: "wekruit-5f89b" })
const db = admin.firestore()
const snap = await db.collection("pa-users").where("source","==","yc_startup_school").get()
const since = new Date(Date.now()-24*3600*1000).toISOString()
let oauthReal=0, oauthMarker=0, typedNoOauth=0
for (const d of snap.docs) {
  const u=d.data(); if (String(u.createdAt??"")<since) continue
  const li=String(u.linkedinUrl??""); if(!li) continue
  const hasOauth = Boolean(u.linkedinOauthSub)
  const isMarker = li.includes("/oauth-linked/")
  if (hasOauth && !isMarker) oauthReal++
  else if (hasOauth && isMarker) oauthMarker++
  else typedNoOauth++
}
console.log(`OAuth 且拿到真实URL   ${oauthReal}`)
console.log(`OAuth 但只有假marker  ${oauthMarker}`)
console.log(`没走OAuth（自己填的）  ${typedNoOauth}`)
process.exit(0)
