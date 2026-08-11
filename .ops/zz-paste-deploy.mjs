// READ-ONLY. (a) when did the hook's handledBy first appear? (b) fleet-pause window
// (c) every linkedin.com/in/ inbound event today with its routedTo/handledBy.
import { readFileSync } from "node:fs"
import admin from "firebase-admin"
let raw = readFileSync(process.env.PA_ENV_PATH, "utf8").match(/^FIREBASE_SERVICE_ACCOUNT_JSON=(.*)$/m)[1].trim()
if ((raw.startsWith("'") && raw.endsWith("'")) || (raw.startsWith('"') && raw.endsWith('"'))) raw = raw.slice(1, -1)
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)), projectId: "wekruit-5f89b" })
const db = admin.firestore()

const all = await db.collection("pa-inbound-events").where("createdAt", ">=", "2026-07-25T00:00:00.000Z").get()
const rows = all.docs.map((d) => ({ id: d.id, ...d.data() }))
  .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))
console.log(`pa-inbound-events today: ${rows.length}`)

const hook = rows.filter((r) => String(r.handledBy ?? "").includes("linkedin_url_pasted"))
console.log(`\n=== handledBy contains linkedin_url_pasted : ${hook.length} ===`)
for (const r of hook) console.log(`  ${String(r.createdAt).slice(11, 19)} ${r.id.slice(0, 14)} by=${r.handledBy} ${JSON.stringify(String(r.text ?? r.body ?? "").slice(0, 70))}`)

const supp = rows.filter((r) => r.routedTo === "stop_gate_suppressed_opted_out")
console.log(`\n=== routedTo=stop_gate_suppressed_opted_out : ${supp.length} ===`)
console.log(`  first ${supp[0]?.createdAt}   last ${supp[supp.length - 1]?.createdAt}`)
for (const r of supp) console.log(`  ${String(r.createdAt).slice(11, 19)} ${String(r.from ?? "").padEnd(15)} ${JSON.stringify(String(r.text ?? r.body ?? "").slice(0, 70))}`)

console.log(`\n=== every inbound event whose text has linkedin.com/in/ ===`)
const li = rows.filter((r) => /linkedin\.com\/in\//i.test(String(r.text ?? r.body ?? "")))
console.log(`count=${li.length}`)
for (const r of li) {
  console.log(`  ${String(r.createdAt).slice(11, 19)} ${String(r.from ?? "").padEnd(15)} st=${r.status} by=${String(r.handledBy ?? "—").padEnd(34)} routedTo=${r.routedTo ?? "-"}`)
  console.log(`       ${JSON.stringify(String(r.text ?? r.body ?? "").slice(0, 110))}`)
}
process.exit(0)
