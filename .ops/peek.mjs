import { readFileSync } from "node:fs"
import admin from "firebase-admin"
let raw = readFileSync(process.env.PA_ENV_PATH, "utf8").match(/^FIREBASE_SERVICE_ACCOUNT_JSON=(.*)$/m)[1].trim()
if ((raw.startsWith("'") && raw.endsWith("'")) || (raw.startsWith('"') && raw.endsWith('"'))) raw = raw.slice(1,-1)
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)), projectId: "wekruit-5f89b" })
const db = admin.firestore()
const s = await db.collection("pa-external-candidate-records").where("enrichment.cohort","==","yc_startup_school_2026").limit(400).get()
for (const d of s.docs) { const u=d.data(); const p=u.companyProfile; if (p?.ycBatch || p?.isYcBacked) { console.log(JSON.stringify({name:u.name, company:u.currentCompany, companyProfile:p}, null, 1).slice(0,900)); break } }
process.exit(0)
