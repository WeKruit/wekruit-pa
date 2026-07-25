/**
 * READ-ONLY verification: every inbound message today carrying a linkedin.com/in/ URL,
 * split BEFORE vs AFTER a deploy timestamp, with enrich / pitch / URL-replacement / pool state.
 *
 *   PA_ENV_PATH=$PWD/.env DEPLOY_AT=2026-07-25T17:55:00Z node .ops/zz-verify-paste.mjs
 */
import { readFileSync } from "node:fs"
import admin from "firebase-admin"
let raw = readFileSync(process.env.PA_ENV_PATH, "utf8").match(/^FIREBASE_SERVICE_ACCOUNT_JSON=(.*)$/m)[1].trim()
if ((raw.startsWith("'") && raw.endsWith("'")) || (raw.startsWith('"') && raw.endsWith('"'))) raw = raw.slice(1, -1)
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)), projectId: "wekruit-5f89b" })
const db = admin.firestore()

const DEPLOY_AT = process.env.DEPLOY_AT ?? new Date().toISOString()
const SINCE = process.env.SINCE ?? "2026-07-25T00:00:00Z"
console.log(`window since=${SINCE}   deploy boundary=${DEPLOY_AT}\n`)

const msgs = await db.collection("pa-messages").where("createdAt", ">=", SINCE).get()
const pastes = []
for (const d of msgs.docs) {
  const m = d.data()
  const dir = m.direction ?? (m.role === "user" ? "inbound" : "outbound")
  if (dir !== "inbound" && m.role !== "user") continue
  const text = String(m.text ?? m.body ?? m.content ?? "")
  if (!/linkedin\.com\/in\//i.test(text)) continue
  pastes.push({ id: d.id, userId: m.userId, at: String(m.createdAt ?? ""), text })
}
pastes.sort((a, b) => a.at.localeCompare(b.at))
console.log(`inbound messages carrying linkedin.com/in/ : ${pastes.length}`)
const before = pastes.filter((p) => p.at < DEPLOY_AT)
const after = pastes.filter((p) => p.at >= DEPLOY_AT)
console.log(`  BEFORE deploy: ${before.length}   AFTER deploy: ${after.length}\n`)

const outSnap = await db.collection("pa-outbound").where("createdAt", ">=", SINCE).get()
const outByUser = new Map()
for (const d of outSnap.docs) {
  const x = d.data()
  if (!outByUser.has(x.userId)) outByUser.set(x.userId, [])
  outByUser.get(x.userId).push({ id: d.id, ...x })
}

const report = async (label, list) => {
  console.log(`===================== ${label} (${list.length}) =====================`)
  const seen = new Set()
  for (const p of list) {
    const key = `${p.userId}|${p.at}`
    if (seen.has(key)) continue
    seen.add(key)
    const u = (await db.collection("pa-users").doc(p.userId).get()).data() ?? {}
    const li = String(u.linkedinUrl ?? "")
    const placeholder = li.includes("/oauth-linked/")
    const expCount = Array.isArray(u.experienceHighlights) ? u.experienceHighlights.length : 0
    const csid = typeof u.coresignalEmployeeId === "number" ? u.coresignalEmployeeId : null
    const pool = await db.collection("pa-external-candidate-records").doc(`yc-user:${p.userId}`).get()
    const poolData = pool.exists ? pool.data() : null
    const rows = (outByUser.get(p.userId) ?? []).filter((r) => String(r.createdAt ?? "") >= p.at)
    rows.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))
    console.log(`\n-- ${p.at.slice(11, 19)}  uid=${p.userId}  ${u.phoneE164 ?? "-"}  ${u.displayName ?? "-"}`)
    console.log(`   pasted: "${p.text.replace(/\n/g, " ").slice(0, 90)}"`)
    console.log(`   ENRICHED: experienceHighlights=${expCount} coresignalEmployeeId=${csid ?? "-"}  => ${expCount > 0 || csid !== null ? "YES" : "NO"}`)
    console.log(`   linkedinUrl: ${li || "(empty)"}  => ${placeholder ? "STILL PLACEHOLDER" : li ? "REAL URL" : "EMPTY"}`)
    console.log(`   POOL yc-user:${p.userId}: ${poolData ? `PRESENT cohort=${poolData.enrichment?.cohort} title="${poolData.currentTitle ?? "-"}"` : "ABSENT"}`)
    console.log(`   outbound after paste (${rows.length}):`)
    for (const r of rows.slice(0, 6)) {
      console.log(`     ${String(r.createdAt).slice(11, 19)} status=${r.status} "${String(r.body ?? "").replace(/\n/g, " ").slice(0, 120)}"`)
    }
  }
  console.log("")
}

await report("BEFORE DEPLOY", before)
await report("AFTER DEPLOY", after)
process.exit(0)
