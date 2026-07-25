import { readFileSync } from "node:fs"
import admin from "firebase-admin"
let raw = readFileSync(process.env.PA_ENV_PATH,"utf8").match(/^FIREBASE_SERVICE_ACCOUNT_JSON=(.*)$/m)[1].trim()
if ((raw.startsWith("'")&&raw.endsWith("'"))||(raw.startsWith('"')&&raw.endsWith('"'))) raw=raw.slice(1,-1)
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)), projectId: "wekruit-5f89b" })
const db=admin.firestore()
const users = await db.collection("pa-users").where("source","==","yc_startup_school").get()
const rows=[]
for (const d of users.docs) {
  const u=d.data(); const n=(u.ycPeopleMatchSent??[]).length
  if (n>0) rows.push({id:d.id.slice(0,8), phone:u.phoneE164, n})
}
rows.sort((a,b)=>b.n-a.n)
console.log(`拿到过匹配的人: ${rows.length}`)
console.log(`累计推送人数分布:`)
rows.slice(0,12).forEach(r=>console.log(`  ${String(r.n).padStart(3)} 人  ${r.phone}  ${r.id}`))
const tot = rows.reduce((s,r)=>s+r.n,0)
console.log(`\n总计推送 ${tot} 人次，平均 ${(tot/rows.length).toFixed(1)} 人/用户`)
process.exit(0)
