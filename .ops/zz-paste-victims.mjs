// READ-ONLY. Full inbound/outbound/turn history for named victims. No composite indexes needed.
import { readFileSync } from "node:fs"
import admin from "firebase-admin"
let raw = readFileSync(process.env.PA_ENV_PATH, "utf8").match(/^FIREBASE_SERVICE_ACCOUNT_JSON=(.*)$/m)[1].trim()
if ((raw.startsWith("'") && raw.endsWith("'")) || (raw.startsWith('"') && raw.endsWith('"'))) raw = raw.slice(1, -1)
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)), projectId: "wekruit-5f89b" })
const db = admin.firestore()

const PHONES = (process.env.PHONES ?? "+14126269523,+19142521902").split(",")
const short = (v, n = 150) => JSON.stringify(String(v ?? "").slice(0, n))

for (const phone of PHONES) {
  console.log("=".repeat(110))
  console.log("PHONE", phone)
  const us = await db.collection("pa-users").where("phoneE164", "==", phone).get()
  if (us.empty) { console.log("  NO pa-users row"); continue }
  for (const d of us.docs) {
    const u = d.data()
    console.log(` uid=${d.id}  name=${u.displayName}`)
    console.log(`   linkedinUrl=${u.linkedinUrl}  oauthLinked=${u.linkedinOauthLinked}`)
    console.log(`   coresignalEmployeeId=${u.coresignalEmployeeId ?? "-"}  expHi=${Array.isArray(u.experienceHighlights) ? u.experienceHighlights.length : "-"}  latestResume=${u.latestResumeArtifactId ?? "-"}`)
    console.log(`   linkedinEnrichedAt=${u.linkedinEnrichedAt ?? "-"} src=${u.linkedinEnrichSource ?? "-"}  pitchedAt=${u.pitchedAt ?? "-"}`)
    console.log(`   ycIntake=${JSON.stringify(u.ycIntake ?? null)}   enrichmentInFlight=${JSON.stringify(u.enrichmentInFlight ?? null)}`)

    const dump = async (coll, textKeys, extra) => {
      const s = await db.collection(coll).where("userId", "==", d.id).get().catch((e) => { console.log(`   ${coll} ERR ${e.code}`); return { docs: [] } })
      const rows = s.docs.map((x) => ({ _id: x.id, ...x.data() }))
        .sort((a, b) => String(a.createdAt ?? "").localeCompare(String(b.createdAt ?? "")))
      console.log(`   --- ${coll} (${rows.length}) ---`)
      for (const r of rows.slice(-25)) {
        const t = textKeys.map((k) => r[k]).find((v) => typeof v === "string" && v)
        console.log(`     ${String(r.createdAt ?? "").slice(5, 19)} ${extra(r)} ${short(t)}`)
      }
    }
    await dump("pa-messages", ["text", "body", "content"], (r) => `role=${r.role ?? "-"} dir=${r.direction ?? "-"}`)
    await dump("pa-inbound-events", ["text", "body", "content"], (r) => `${r._id.slice(0, 12)} st=${r.status} by=${r.handledBy ?? "-"} rt=${r.rawMeta?.runtimeEvent ?? "-"}/${r.rawMeta?.runtimeEventKind ?? "-"}`)
    await dump("pa-outbound", ["body", "content", "text"], (r) => `[${r.status}]`)
    await dump("pa-turns", ["finalText"], (r) => `mode=${r.mode ?? "-"} pat=${r.pattern ?? "-"} tool=${r.deliveredViaTool ?? "-"} calls=${JSON.stringify(r.toolCalls ?? r.toolNames ?? null)}\n        IN=${short(r.inboundText ?? r.userText, 110)}\n       `)
  }
}
process.exit(0)
