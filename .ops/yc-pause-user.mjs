/**
 * Pause Claire for ONE user: doNotContact=true makes the deterministic STOP gate in onPaInbound
 * swallow every non-START inbound silently, so no further reply can go out. Reversible — unset the
 * flag (or the user texts START). Records why + who, so this is never mistaken for a real opt-out.
 */
import { readFileSync } from "node:fs"
import admin from "firebase-admin"
let raw = readFileSync(".env","utf8").match(/^FIREBASE_SERVICE_ACCOUNT_JSON=(.*)$/m)[1].trim()
if ((raw.startsWith("'")&&raw.endsWith("'"))||(raw.startsWith('"')&&raw.endsWith('"'))) raw=raw.slice(1,-1)
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)), projectId: "wekruit-5f89b" })
const db = admin.firestore()
const phone = process.argv[2], on = process.argv[3] !== "--off"
const r = await db.collection("pa-users").where("phoneE164","==",phone).get()
if (r.empty) { console.log("no user for", phone); process.exit(1) }
const d = r.docs[0]
await d.ref.set({
  doNotContact: on,
  operatorPause: on ? { at: new Date().toISOString(), by: "adam", reason: "yc-event quality pause, not a user opt-out" } : admin.firestore.FieldValue.delete(),
}, { merge: true })
const after = (await d.ref.get()).data()
console.log(`${phone} uid=${d.id} doNotContact=${after.doNotContact} (${on ? "PAUSED — Claire will not reply" : "resumed"})`)
process.exit(0)
