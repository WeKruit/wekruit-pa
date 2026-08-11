// READ-ONLY. Full-day paste funnel + who is STILL stranded + inputs the extractor misses.
import { readFileSync } from "node:fs"
import admin from "firebase-admin"
let raw = readFileSync(process.env.PA_ENV_PATH, "utf8").match(/^FIREBASE_SERVICE_ACCOUNT_JSON=(.*)$/m)[1].trim()
if ((raw.startsWith("'") && raw.endsWith("'")) || (raw.startsWith('"') && raw.endsWith('"'))) raw = raw.slice(1, -1)
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)), projectId: "wekruit-5f89b" })
const db = admin.firestore()

// exact replica of extractLinkedinProfileUrl's regex
const RE = /(?:https?:\/\/)?(?:[a-z0-9-]+\.)?linkedin\.com\/in\/[^\s<>"')\]]+/i

const all = await db.collection("pa-inbound-events").where("createdAt", ">=", "2026-07-25T00:00:00.000Z").get()
const rows = all.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))

const li = rows.filter((r) => RE.test(String(r.text ?? r.body ?? "")))
const users = new Map()
for (const r of li) { if (!users.has(r.userId)) users.set(r.userId, []) ; users.get(r.userId).push(r) }

console.log(`DISTINCT USERS WHO PASTED A linkedin.com/in/ URL TODAY: ${users.size}  (${li.length} messages)\n`)
let strandedList = []
for (const [uid, evs] of users) {
  const u = (await db.collection("pa-users").doc(uid).get()).data() ?? {}
  const enriched = typeof u.coresignalEmployeeId === "number" || (Array.isArray(u.experienceHighlights) && u.experienceHighlights.length > 0)
  const pitched = !!u.pitchedAt
  const viaHook = evs.some((e) => String(e.handledBy ?? "").includes("linkedin_url_pasted"))
  const suppressed = evs.some((e) => e.routedTo === "stop_gate_suppressed_opted_out")
  const placeholder = String(u.linkedinUrl ?? "").includes("/oauth-linked/")
  const line = `${String(u.phoneE164 ?? "?").padEnd(15)} first=${String(evs[0].createdAt).slice(11, 19)} hook=${viaHook ? "Y" : "-"} paused=${suppressed ? "Y" : "-"} enriched=${enriched ? "Y" : "N"} pitched=${pitched ? "Y" : "N"} placeholderUrl=${placeholder ? "Y" : "-"} enrichSrc=${u.linkedinEnrichSource ?? "-"}@${String(u.linkedinEnrichedAt ?? "").slice(11, 19)}`
  console.log(line)
  if (!enriched || !pitched) strandedList.push({ uid, phone: u.phoneE164, line, evs })
}
console.log(`\n=== STILL STRANDED (no background and/or no pitch): ${strandedList.length} ===`)
for (const s of strandedList) {
  console.log(` ${s.line}`)
  for (const e of s.evs) console.log(`     ${String(e.createdAt).slice(11, 19)} by=${e.handledBy ?? "—"} routedTo=${e.routedTo ?? "-"} ${JSON.stringify(String(e.text ?? e.body ?? "").slice(0, 90))}`)
}

// Inputs the extractor MISSES: text mentions linkedin but has no /in/ URL the regex accepts.
console.log(`\n=== inbound mentioning "linkedin" that the extractor REJECTS ===`)
const miss = rows.filter((r) => {
  const t = String(r.text ?? r.body ?? "")
  return /linkedin/i.test(t) && !RE.test(t) && t.length < 300
})
for (const r of miss) console.log(`  ${String(r.createdAt).slice(11, 19)} ${String(r.from ?? "").padEnd(15)} ${JSON.stringify(t2(r))}`)
function t2(r) { return String(r.text ?? r.body ?? "").slice(0, 130) }
process.exit(0)
