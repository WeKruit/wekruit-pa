/**
 * READ-ONLY: how much traffic has flowed since the deploy boundary (sample-size sanity).
 *   PA_ENV_PATH=$PWD/.env DEPLOY_AT=2026-07-25T17:44:00Z node .ops/zz-postdeploy-volume.mjs
 */
import { readFileSync } from "node:fs"
import admin from "firebase-admin"
let raw = readFileSync(process.env.PA_ENV_PATH, "utf8").match(/^FIREBASE_SERVICE_ACCOUNT_JSON=(.*)$/m)[1].trim()
if ((raw.startsWith("'") && raw.endsWith("'")) || (raw.startsWith('"') && raw.endsWith('"'))) raw = raw.slice(1, -1)
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)), projectId: "wekruit-5f89b" })
const db = admin.firestore()
const AT = process.env.DEPLOY_AT ?? "2026-07-25T17:44:00Z"
const m = await db.collection("pa-messages").where("createdAt", ">=", AT).get()
let inbound = 0, assistant = 0
const users = new Set()
for (const d of m.docs) {
  const x = d.data()
  users.add(x.userId)
  if (x.role === "user" || x.direction === "inbound") inbound++
  else assistant++
}
const o = await db.collection("pa-outbound").where("createdAt", ">=", AT).get()
console.log(`since ${AT} (now ${new Date().toISOString()})`)
console.log(`  pa-messages: ${m.size}  inbound=${inbound} assistant=${assistant}  distinct users=${users.size}`)
console.log(`  pa-outbound: ${o.size}`)
process.exit(0)
