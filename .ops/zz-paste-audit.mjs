// READ-ONLY. Every inbound in the window whose text contains linkedin.com/in/ + full outcome.
import { readFileSync } from "node:fs"
import admin from "firebase-admin"
let raw = readFileSync(process.env.PA_ENV_PATH, "utf8").match(/^FIREBASE_SERVICE_ACCOUNT_JSON=(.*)$/m)[1].trim()
if ((raw.startsWith("'") && raw.endsWith("'")) || (raw.startsWith('"') && raw.endsWith('"'))) raw = raw.slice(1, -1)
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)), projectId: "wekruit-5f89b" })
const db = admin.firestore()

const SINCE = process.env.SINCE ?? "2026-07-24T12:00:00.000Z"

// EXACT replica of extractLinkedinProfileUrl (regex) + normalizeTypedLinkedinUrl reject rules.
// Replicated, not imported — the worktree dist is not guaranteed built.
function extractRegexMatch(text) {
  const m = /(?:https?:\/\/)?(?:[a-z0-9-]+\.)?linkedin\.com\/in\/[^\s<>"')\]]+/i.exec(text ?? "")
  if (!m) return null
  const s = m[0].replace(/[.,;:!?]+$/, "")
  if (s.includes("/oauth-linked/")) return "REJECT:oauth-placeholder"
  return s
}

const msgs = await db.collection("pa-messages").where("createdAt", ">=", SINCE).get()
console.log(`pa-messages since ${SINCE}: ${msgs.size}`)

const pastes = []
for (const d of msgs.docs) {
  const m = d.data()
  const text = String(m.text ?? m.body ?? m.content ?? "")
  if (!/linkedin\.com\/in\//i.test(text)) continue
  const isUser = m.role === "user" || m.direction === "inbound"
  if (!isUser) continue
  pastes.push({ id: d.id, userId: m.userId, at: String(m.createdAt ?? ""), text, sessionId: m.sessionId })
}
pastes.sort((a, b) => a.at.localeCompare(b.at))
console.log(`inbound carrying linkedin.com/in/: ${pastes.length}\n`)

const users = new Map()
for (const p of pastes) {
  if (!users.has(p.userId)) users.set(p.userId, (await db.collection("pa-users").doc(p.userId).get()).data() ?? {})
}

for (const p of pastes) {
  const u = users.get(p.userId)
  const out = await db.collection("pa-outbound")
    .where("userId", "==", p.userId).where("createdAt", ">=", p.at).limit(30).get()
    .catch(() => ({ docs: [] }))
  const after = out.docs.map((d) => d.data())
    .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))
  console.log("─".repeat(100))
  console.log(`${p.at}  phone=${u.phoneE164 ?? u.phone ?? "?"}  uid=${p.userId}`)
  console.log(`  TEXT      : ${JSON.stringify(p.text.slice(0, 200))}`)
  console.log(`  EXTRACTOR : ${extractRegexMatch(p.text)}`)
  console.log(`  linkedinUrl        : ${String(u.linkedinUrl ?? "-")}`)
  console.log(`  coresignalEmployeeId: ${u.coresignalEmployeeId ?? "-"}   expHighlights=${Array.isArray(u.experienceHighlights) ? u.experienceHighlights.length : "-"}`)
  console.log(`  linkedinEnrichedAt : ${u.linkedinEnrichedAt ?? "-"}   src=${u.linkedinEnrichSource ?? "-"}`)
  console.log(`  pitchedAt          : ${u.pitchedAt ?? "-"}   oauthLinked=${u.linkedinOauthLinked ?? "-"}  ycIntake.linkedinUrlAskedAt=${u.ycIntake?.linkedinUrlAskedAt ?? "-"}`)
  console.log(`  OUTBOUND AFTER PASTE (${after.length}):`)
  for (const o of after.slice(0, 8)) {
    console.log(`     ${String(o.createdAt).slice(11, 19)} [${o.status}] ${JSON.stringify(String(o.body ?? o.content ?? "").slice(0, 150))}`)
  }
  // pa-turns for that inbound
  const turns = await db.collection("pa-turns").where("userId", "==", p.userId).where("createdAt", ">=", p.at).limit(5).get().catch(() => ({ docs: [] }))
  for (const t of turns.docs) {
    const x = t.data()
    console.log(`  TURN ${String(x.createdAt).slice(11, 19)} mode=${x.mode ?? "-"} pattern=${x.pattern ?? "-"} tool=${x.deliveredViaTool ?? "-"} calls=${JSON.stringify(x.toolCalls ?? x.toolNames ?? null)}`)
    console.log(`       finalText=${JSON.stringify(String(x.finalText ?? "").slice(0, 160))}`)
  }
}
process.exit(0)
