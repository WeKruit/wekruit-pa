import { readFileSync } from "node:fs"
import admin from "firebase-admin"
let raw = readFileSync(process.env.PA_ENV_PATH,"utf8").match(/^FIREBASE_SERVICE_ACCOUNT_JSON=(.*)$/m)[1].trim()
if ((raw.startsWith("'")&&raw.endsWith("'"))||(raw.startsWith('"')&&raw.endsWith('"'))) raw=raw.slice(1,-1)
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)), projectId: "wekruit-5f89b" })
const db = admin.firestore()
const ids = ["1d89ed3c-d5ee-4217-8278-4015e8dd1c59"]
const since = new Date(Date.now()-3*3600*1000).toISOString()
const t = await db.collection("pa-turns").where("createdAt",">=",since).orderBy("createdAt","desc").limit(40).get().catch(async()=> {
  return await db.collection("pa-turns").orderBy("createdAt","desc").limit(40).get()
})
let errs=0
for (const d of t.docs) {
  const x=d.data()
  const err = x.error ?? x.err ?? x.failure
  const tools = (x.toolCalls ?? x.tools ?? []).map(c=>c.name ?? c).join(",")
  const final = String(x.finalText ?? x.text ?? "")
  if (err || (!final && !tools)) {
    errs++
    console.log(`${String(x.createdAt).slice(11,19)} uid=${String(x.userId??"").slice(0,8)} tools=[${tools}] final="${final.slice(0,40)}" ERR=${String(err).slice(0,180)}`)
  }
}
console.log(`\nscanned=${t.size} problem turns=${errs}`)
process.exit(0)
