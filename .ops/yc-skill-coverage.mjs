/**
 * Do today's YC users actually have a usable SKILLS profile? (Adam 2026-07-25)
 *
 * Answers three separate questions that get conflated:
 *   1. coverage  — how many have any skills at all
 *   2. depth     — how many skills, and from what evidence
 *   3. signal    — are the skills DISCRIMINATIVE, or the same generic list on everyone
 *
 * (3) is the one that matters for matching. A 60-skill list that is identical across 200 people
 * carries zero ranking information no matter how "complete" it looks.
 */
import { readFileSync } from "node:fs"
import admin from "firebase-admin"
let raw = readFileSync(".env", "utf8").match(/^FIREBASE_SERVICE_ACCOUNT_JSON=(.*)$/m)[1].trim()
if ((raw.startsWith("'") && raw.endsWith("'")) || (raw.startsWith('"') && raw.endsWith('"'))) raw = raw.slice(1, -1)
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)), projectId: "wekruit-5f89b" })
const db = admin.firestore()
const since = new Date(Date.now() - 20 * 3600 * 1000).toISOString()

const users = (await db.collection("pa-users").where("createdAt", ">=", since).get()).docs.map((d) => ({ id: d.id, ...d.data() }))
const yc = users.filter((u) => Boolean(u.ycIntake) || String(u.source ?? "").includes("yc") || String(u.firstTouchCampaign ?? "").includes("yc"))

const skillNames = (u) => (u.tags?.skills ?? []).map((s) => String(s.name ?? s).toLowerCase())
const withSkills = yc.filter((u) => skillNames(u).length > 0)
const counts = withSkills.map((u) => skillNames(u).length).sort((a, b) => a - b)
const q = (p) => counts[Math.floor(counts.length * p)] ?? 0

console.log(`YC users today: ${yc.length}`)
console.log(`\n── 1. COVERAGE ──`)
console.log(`  tags.skills present        ${withSkills.length} (${Math.round(withSkills.length / yc.length * 100)}%)`)
console.log(`  experienceHighlights       ${yc.filter((u) => u.experienceHighlights?.length).length}`)
console.log(`  recentRoleTitle            ${yc.filter((u) => u.tags?.recentRoleTitle || u.recentRoleTitle).length}`)
console.log(`  workHistorySummary         ${yc.filter((u) => u.tags?.workHistorySummary).length}`)
console.log(`  ycIntake.building text     ${yc.filter((u) => u.ycIntake?.building).length}`)

console.log(`\n── 2. DEPTH (skills per user) ──`)
console.log(`  min=${counts[0]} p25=${q(.25)} p50=${q(.5)} p75=${q(.75)} p90=${q(.9)} max=${counts.at(-1)}`)
const ev = new Map()
for (const u of withSkills) for (const s of (u.tags?.skills ?? [])) ev.set(s.evidenceCount ?? 0, (ev.get(s.evidenceCount ?? 0) ?? 0) + 1)
console.log(`  evidenceCount histogram    ${[...ev].sort((a, b) => a[0] - b[0]).slice(0, 6).map(([k, v]) => `${k}:${v}`).join("  ")}`)

console.log(`\n── 3. SIGNAL (discriminative?) ──`)
const freq = new Map()
for (const u of withSkills) for (const n of new Set(skillNames(u))) freq.set(n, (freq.get(n) ?? 0) + 1)
const top = [...freq].sort((a, b) => b[1] - a[1])
console.log(`  distinct skill tokens      ${freq.size}`)
console.log(`  most common:`)
for (const [k, v] of top.slice(0, 12)) console.log(`     ${String(Math.round(v / withSkills.length * 100)).padStart(3)}%  ${k}`)
const ubiquitous = top.filter(([, v]) => v / withSkills.length > 0.8).length
console.log(`  tokens on >80% of users    ${ubiquitous}   <- carry no ranking signal`)

console.log(`\n── backend-relevant tokens present in the pool ──`)
for (const k of ["rust", "swift", "typescript", "node_js", "nodejs", "node", "microservices", "distributed_systems", "backend_development", "golang", "go", "kubernetes", "python", "software_engineering", "api_development", "system_design", "concurrency"]) {
  const v = freq.get(k)
  if (v) console.log(`     ${String(v).padStart(3)} users  ${k}`)
}
process.exit(0)
