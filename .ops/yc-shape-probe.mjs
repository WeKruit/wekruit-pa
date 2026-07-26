/** What fields do today's YC users ACTUALLY carry? Printing the key union beats guessing flag
 *  names — my first stats pass reported "LinkedIn OAuth 0%" against 196 enriched profiles, which
 *  is a field-name bug, not a funnel. Also samples pa-turns so unanswered can be measured by
 *  CAUSAL linkage (inboundText -> finalText) instead of a timestamp comparison that the measured
 *  -0.2s write skew makes unreliable in both directions. */
import { readFileSync } from "node:fs"
import admin from "firebase-admin"
let raw = readFileSync(".env", "utf8").match(/^FIREBASE_SERVICE_ACCOUNT_JSON=(.*)$/m)[1].trim()
if ((raw.startsWith("'") && raw.endsWith("'")) || (raw.startsWith('"') && raw.endsWith('"'))) raw = raw.slice(1, -1)
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)), projectId: "wekruit-5f89b" })
const db = admin.firestore()
const since = new Date(Date.now() - 20 * 3600 * 1000).toISOString()

const users = await db.collection("pa-users").where("createdAt", ">=", since).limit(600).get()
const freq = new Map()
for (const d of users.docs) for (const k of Object.keys(d.data())) freq.set(k, (freq.get(k) ?? 0) + 1)
console.log(`users sampled: ${users.size}`)
console.log("--- field frequency (>=5) ---")
for (const [k, v] of [...freq].sort((a, b) => b[1] - a[1])) if (v >= 5) console.log(`  ${String(v).padStart(4)}  ${k}`)

const withBg = users.docs.find((d) => Array.isArray(d.data().experienceHighlights) && d.data().experienceHighlights.length)
if (withBg) {
  const u = withBg.data()
  console.log("\n--- sample ENRICHED user (redacted) ---")
  console.log(JSON.stringify({
    linkedinUrl: u.linkedinUrl, recentRoleTitle: u.recentRoleTitle, recentCompany: u.recentCompany,
    coresignalEmployeeId: u.coresignalEmployeeId, ycIntake: u.ycIntake,
    tagKeys: Object.keys(u.tags ?? {}), skills: (u.tags?.skills ?? []).slice(0, 12),
    expCount: u.experienceHighlights?.length, exp0: u.experienceHighlights?.[0],
  }, null, 1).slice(0, 1600))
}

const turns = await db.collection("pa-turns").where("createdAt", ">=", since).limit(3).get()
console.log(`\n--- pa-turns sample (${turns.size}) ---`)
for (const d of turns.docs) {
  const t = d.data()
  console.log(JSON.stringify({ keys: Object.keys(t), userId: !!t.userId, inboundText: String(t.inboundText ?? "").slice(0, 50), finalText: String(t.finalText ?? "").slice(0, 50) }))
}
process.exit(0)
