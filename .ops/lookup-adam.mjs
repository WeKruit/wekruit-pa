import { readFileSync } from "node:fs"
import admin from "firebase-admin"
let raw = readFileSync(process.env.PA_ENV_PATH, "utf8").match(/^FIREBASE_SERVICE_ACCOUNT_JSON=(.*)$/m)[1].trim()
if ((raw.startsWith("'") && raw.endsWith("'")) || (raw.startsWith('"') && raw.endsWith('"'))) raw = raw.slice(1, -1)
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)), projectId: "wekruit-5f89b" })
const db = admin.firestore()
const seen = new Map()
for (const [f, v] of [["phoneE164", "+14243201960"], ["email", "indolencorlol@gmail.com"]]) {
  const r = await db.collection("pa-users").where(f, "==", v).get().catch(() => ({ docs: [] }))
  r.docs.forEach((d) => seen.set(d.id, d.data()))
  console.log(`${f}=${v} -> ${r.docs.map((d) => d.id).join(", ") || "(none)"}`)
}
for (const [id, u] of seen) {
  console.log(`\n--- pa-users/${id}`)
  console.log(`  phone=${u.phoneE164} email=${u.email ?? "-"} source=${u.source ?? "-"} campaign=${u.firstTouchCampaign ?? "-"}`)
  console.log(`  ycEventEntryAt=${u.ycEventEntryAt ?? "-"}  ycIntake=${JSON.stringify(u.ycIntake ?? null)}`)
  console.log(`  ycPeopleMatchSent=${(u.ycPeopleMatchSent ?? []).length} people   pitchedAt=${u.pitchedAt ?? "-"}`)
  console.log(`  displayName=${u.displayName ?? "-"} highlights=${(u.experienceHighlights ?? []).length} skills=${(u.tags?.skills ?? []).length}`)
  console.log(`  senderNumber=${u.senderNumber ?? "-"} onboardingState=${u.onboardingState ?? "-"}`)
  const msgs = await db.collection("pa-messages").where("userId", "==", id).get().catch(() => ({ size: 0 }))
  const out = await db.collection("pa-outbound").where("userId", "==", id).get().catch(() => ({ size: 0 }))
  console.log(`  pa-messages=${msgs.size}  pa-outbound=${out.size}`)
}
process.exit(0)
