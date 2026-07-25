import { readFileSync } from "node:fs"
import admin from "firebase-admin"
let raw = readFileSync(process.env.PA_ENV_PATH,"utf8").match(/^FIREBASE_SERVICE_ACCOUNT_JSON=(.*)$/m)[1].trim()
if ((raw.startsWith("'")&&raw.endsWith("'"))||(raw.startsWith('"')&&raw.endsWith('"'))) raw=raw.slice(1,-1)
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)), projectId: "wekruit-5f89b" })
const db=admin.firestore()
const u = await db.collection("pa-users").where("source","==","yc_startup_school").get()
let oauth=0, realUrl=0, markerOnly=0, markerEnriched=0, realEnriched=0, markerWithPic=0
for (const d of u.docs){ const x=d.data()
  if (x.linkedinOauthLinked!==true) continue
  oauth++
  const li=String(x.linkedinUrl??"")
  const enriched = Boolean(x.coresignalEmployeeId)
  if (li && !li.includes("/oauth-linked/")) { realUrl++; if(enriched) realEnriched++ }
  else { markerOnly++; if(x.linkedinOauthPicture) markerWithPic++; if(enriched) markerEnriched++ }
}
console.log(`OAuth 连接成功       ${oauth}`)
console.log(`  LinkedIn 给了真URL  ${realUrl}  → enrich 成功 ${realEnriched}  (${realUrl?Math.round(realEnriched/realUrl*100):0}%)`)
console.log(`  只有假marker        ${markerOnly}  → enrich 成功 ${markerEnriched}  (${markerOnly?Math.round(markerEnriched/markerOnly*100):0}%)`)
console.log(`     其中有头像可试    ${markerWithPic}`)
process.exit(0)
