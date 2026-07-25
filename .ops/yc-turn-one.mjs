import { readFileSync } from "node:fs"
import admin from "firebase-admin"
let raw = readFileSync(process.env.PA_ENV_PATH,"utf8").match(/^FIREBASE_SERVICE_ACCOUNT_JSON=(.*)$/m)[1].trim()
if ((raw.startsWith("'")&&raw.endsWith("'"))||(raw.startsWith('"')&&raw.endsWith('"'))) raw=raw.slice(1,-1)
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)), projectId: "wekruit-5f89b" })
const db = admin.firestore()
for (const id of process.argv.slice(2)) {
  const t = await db.collection("pa-turns").doc(id).get()
  console.log(`\n===== pa-turns/${id} exists=${t.exists} =====`)
  if (t.exists) {
    const d = t.data()
    for (const k of Object.keys(d)) {
      if (k === "toolCalls") { console.log(" toolCalls:"); (d[k]||[]).forEach((c,i)=>console.log(`   [${i}] ${c.name} args=${c.arguments}\n        out=${typeof c.output==="object"?JSON.stringify(c.output):String(c.output)}`)); continue }
      console.log(` ${k} = ${typeof d[k]==="object"?JSON.stringify(d[k]):String(d[k])}`)
    }
  }
  const e = await db.collection("pa-inbound-events").doc(id).get()
  console.log(`--- pa-inbound-events/${id} exists=${e.exists} ---`)
  if (e.exists) { const d=e.data(); for (const k of Object.keys(d)) console.log(`  ${k} = ${typeof d[k]==="object"?JSON.stringify(d[k]).slice(0,300):String(d[k]).slice(0,300)}`) }
}
process.exit(0)
