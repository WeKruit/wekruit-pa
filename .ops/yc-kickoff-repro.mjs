import { readFileSync } from "node:fs"
import admin from "firebase-admin"
import {
  isSharedOnboardingGreetingOrKickoff,
  isYcEventOpenerText,
} from "../packages/pa-orchestrator/dist/index.js"
let raw = readFileSync(process.env.PA_ENV_PATH,"utf8").match(/^FIREBASE_SERVICE_ACCOUNT_JSON=(.*)$/m)[1].trim()
if ((raw.startsWith("'")&&raw.endsWith("'"))||(raw.startsWith('"')&&raw.endsWith('"'))) raw=raw.slice(1,-1)
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)), projectId: "wekruit-5f89b" })
const db = admin.firestore()
const uid = process.argv[2]
const t = await db.collection("pa-turns").where("userId","==",uid).get()
for (const d of t.docs.sort((a,b)=>String(a.data().createdAt).localeCompare(String(b.data().createdAt)))) {
  const x = d.data()
  const text = String(x.inboundText ?? "")
  console.log(`${String(x.createdAt).slice(11,19)} len=${text.length} kickoff=${isSharedOnboardingGreetingOrKickoff(text)} ycOpener=${isYcEventOpenerText(text)} mode=${x.mode} :: ${JSON.stringify(text.slice(0,60))}`)
}
process.exit(0)
