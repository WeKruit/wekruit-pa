// READ-ONLY. For every inbound handled by the pasted-LinkedIn hook: did it enrich? did it pitch?
import { readFileSync } from "node:fs"
import admin from "firebase-admin"
let raw = readFileSync(process.env.PA_ENV_PATH, "utf8").match(/^FIREBASE_SERVICE_ACCOUNT_JSON=(.*)$/m)[1].trim()
if ((raw.startsWith("'") && raw.endsWith("'")) || (raw.startsWith('"') && raw.endsWith('"'))) raw = raw.slice(1, -1)
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)), projectId: "wekruit-5f89b" })
const db = admin.firestore()

const all = await db.collection("pa-inbound-events").where("createdAt", ">=", "2026-07-25T00:00:00.000Z").get()
const rows = all.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))
const hook = rows.filter((r) => String(r.handledBy ?? "").includes("linkedin_url_pasted"))

const byUser = new Map()
for (const r of hook) {
  if (!byUser.has(r.userId)) byUser.set(r.userId, [])
  byUser.get(r.userId).push(r)
}
console.log(`hook fired ${hook.length}x across ${byUser.size} users\n`)

let enriched = 0, pitched = 0
for (const [uid, evs] of byUser) {
  const u = (await db.collection("pa-users").doc(uid).get()).data() ?? {}
  const first = evs[0].createdAt
  const ob = await db.collection("pa-outbound").where("userId", "==", uid).get().catch(() => ({ docs: [] }))
  const after = ob.docs.map((d) => d.data()).filter((x) => String(x.createdAt) >= first)
    .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))
  const isEnriched = typeof u.coresignalEmployeeId === "number" || (Array.isArray(u.experienceHighlights) && u.experienceHighlights.length > 0)
  const gotPitch = u.pitchedAt && String(u.pitchedAt) >= first
  if (isEnriched) enriched++
  if (gotPitch) pitched++
  console.log("─".repeat(105))
  console.log(`${u.phoneE164 ?? "?"}  ${u.displayName ?? "?"}   pastes=${evs.length}  first=${String(first).slice(11, 19)}`)
  console.log(`  ENRICHED=${isEnriched ? "YES" : "NO "}  csId=${u.coresignalEmployeeId ?? "-"} expHi=${Array.isArray(u.experienceHighlights) ? u.experienceHighlights.length : "-"}  enrichedAt=${String(u.linkedinEnrichedAt ?? "-").slice(11, 19)} src=${u.linkedinEnrichSource ?? "-"}`)
  console.log(`  PITCHED =${gotPitch ? "YES" : "NO "}  pitchedAt=${u.pitchedAt ?? "-"}`)
  console.log(`  linkedinUrl=${u.linkedinUrl ?? "-"}`)
  console.log(`  pastes: ${evs.map((e) => String(e.createdAt).slice(11, 19)).join(" ")}`)
  console.log(`  OUTBOUND AFTER 1ST PASTE (${after.length}):`)
  for (const o of after.slice(0, 12)) console.log(`     ${String(o.createdAt).slice(11, 19)} [${o.status}] ${JSON.stringify(String(o.body ?? o.content ?? "").slice(0, 130))}`)
}
console.log("\n" + "=".repeat(105))
console.log(`TOTAL post-hook pasters: ${byUser.size}   enriched: ${enriched}   pitched: ${pitched}`)
process.exit(0)
