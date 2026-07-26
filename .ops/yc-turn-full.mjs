import { readFileSync } from "node:fs"
import admin from "firebase-admin"
let raw = readFileSync(process.env.PA_ENV_PATH,"utf8").match(/^FIREBASE_SERVICE_ACCOUNT_JSON=(.*)$/m)[1].trim()
if ((raw.startsWith("'")&&raw.endsWith("'"))||(raw.startsWith('"')&&raw.endsWith('"'))) raw=raw.slice(1,-1)
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)), projectId: "wekruit-5f89b" })
const db = admin.firestore()
const S = (v)=>{ if(!v) return "-"; if(typeof v==="string") return v; if(v._seconds) return new Date(v._seconds*1000).toISOString(); if(v.toDate) return v.toDate().toISOString(); return JSON.stringify(v) }
for (const phone of process.argv.slice(2)) {
  const us = await db.collection("pa-users").where("phoneE164","==",phone).get()
  for (const u of us.docs) {
    console.log(`\n########## ${phone} uid=${u.id} ##########`)
    const d = u.data()
    console.log("ycIntake=", JSON.stringify(d.ycIntake ?? null))
    console.log("ycPeopleMatchLastAt=", d.ycPeopleMatchLastAt ?? "-", " sentN=", (d.ycPeopleMatchSent??[]).length, " recentN=", (d.ycPeopleMatchRecent??[]).length)
    console.log("recent=", JSON.stringify((d.ycPeopleMatchRecent??[]).slice(-8)))
    const t = await db.collection("pa-turns").where("userId","==",u.id).get()
    const tl = t.docs.map(x=>({id:x.id,...x.data()})).sort((a,b)=>String(S(a.createdAt)).localeCompare(String(S(b.createdAt))))
    console.log(`--- pa-turns (${tl.length}) ---`)
    for (const x of tl) {
      console.log(`\n  [${S(x.createdAt)}] doc=${x.id}`)
      console.log("   allKeys=", Object.keys(x).join(","))
      for (const k of Object.keys(x)) {
        if (k==="id") continue
        let v = x[k]
        let s = typeof v === "object" ? JSON.stringify(v) : String(v)
        if (s.length > 700) s = s.slice(0,700)+"…"
        console.log(`     ${k} = ${s}`)
      }
    }
  }
}
process.exit(0)
