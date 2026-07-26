/** Re-run the eval on the notes-patched submissions via the admin callable (the trigger is
 *  onDocumentCreated and never re-fires). Loops in bounded pages until done. */
import { readFileSync } from "node:fs"
import admin from "firebase-admin"
const env = readFileSync(".env","utf8")
let raw = env.match(/^FIREBASE_SERVICE_ACCOUNT_JSON=(.*)$/m)[1].trim()
if ((raw.startsWith("'")&&raw.endsWith("'"))||(raw.startsWith('"')&&raw.endsWith('"'))) raw=raw.slice(1,-1)
const token = env.match(/^PA_ADMIN_TOKEN=(.*)$/m)[1].trim().replace(/^['"]|['"]$/g,"")
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)), projectId: "wekruit-5f89b" })
const db = admin.firestore()
const URL_ = "https://us-central1-wekruit-5f89b.cloudfunctions.net/paAdminReevaluateRecruiterSubmissions"

const subs = (await db.collection("pa-recruiter-submissions").where("jobId","==","photon-backend-engineer-high-concurrency").get()).docs
const ids = subs.filter(d=>d.id.startsWith("yc-photon-be-")).map(d=>d.id)
console.log(`re-evaluating ${ids.length}`)
const CHUNK = Number(process.env.CHUNK ?? 40)
let done=0
for (let i=0;i<ids.length;i+=CHUNK) {
  const slice = ids.slice(i,i+CHUNK)
  const res = await fetch(URL_,{method:"POST",headers:{"content-type":"application/json"},
    body: JSON.stringify({data:{ids:slice,maxReeval:CHUNK,concurrency:6,adminToken:token}})})
  const j = await res.json().catch(()=>({}))
  const r = j.result ?? j
  done += slice.length
  console.log(`  ${done}/${ids.length}  http=${res.status} reevaluated=${r.reevaluated ?? r.count ?? "?"} ${r.error??j.error?.message??""}`)
}
process.exit(0)
