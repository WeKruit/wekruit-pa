import { readFileSync } from "node:fs"
import admin from "firebase-admin"
let raw = readFileSync(".env","utf8").match(/^FIREBASE_SERVICE_ACCOUNT_JSON=(.*)$/m)[1].trim()
if ((raw.startsWith("'")&&raw.endsWith("'"))||(raw.startsWith('"')&&raw.endsWith('"'))) raw=raw.slice(1,-1)
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)), projectId: "wekruit-5f89b" })
const db=admin.firestore()
const r=await db.collection("pa-users").where("phoneE164","==","+19257918082").get()
const d=r.docs[0].data()
console.log("ycPeopleMatchRecent:", JSON.stringify(d.ycPeopleMatchRecent??[],null,0))
console.log("ycPeopleMatchLastAt:", d.ycPeopleMatchLastAt)
console.log("ycPeopleMatchSent  :", (d.ycPeopleMatchSent??[]).length)
// pool: how many investors exist at all?
const pool=await db.collection("pa-external-candidate-records").where("ycPool","==",true).get().catch(async()=>
  await db.collection("pa-external-candidate-records").limit(3000).get())
console.log("\npool docs scanned:", pool.size)
let pt={}, n=0
for(const p of pool.docs){const x=p.data(); const types=x.ycPersonType??x.personType??[]
  if(Array.isArray(types)&&types.length){n++; for(const t of types) pt[t]=(pt[t]??0)+1}}
console.log("records with personType:", n)
console.log("personType histogram:", JSON.stringify(pt))
process.exit(0)
