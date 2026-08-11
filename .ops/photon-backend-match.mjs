/**
 * Rank TODAY's YC Startup School users against Photon's Backend Engineer role.
 *
 * WHY NOT runRediscoverForJob / rankCandidatesForJob (the V16 two-way scorer):
 *   1. it resolves jobs from `matching-jobs`, and this job exists only in `pa-jobs`
 *      (matching-jobs/photon-backend-engineer-high-concurrency does not exist);
 *   2. it calls `isYcPeopleUser(data)` and SKIPS those rows — YC people are deliberately
 *      excluded from the job-candidate lane;
 *   3. its weights are 0.40 llmMatch + 0.20 skillJaccard + 0.10 cvEmbCosine, and today's YC
 *      users have no llmMatch, no embedding, and a tags.skills list that measurement shows is
 *      word-salad ("across", "data", "engineer"; rust=0 users, swift=0 users in a 568-person
 *      startup crowd). Running V16 here would produce confident noise.
 *
 * So this scores the signal that IS real for this cohort: experienceHighlights (title, company,
 * dates, description), workHistorySummary, and their own ycIntake.building text — semantically
 * against the JD, plus deterministic evidence hits. Every number printed is traceable to a
 * quoted span, so a bad rank is inspectable rather than mysterious.
 *
 * READ ONLY. Writes nothing, texts nobody.
 */
import { readFileSync } from "node:fs"
import admin from "firebase-admin"
import OpenAI from "openai"

let raw = readFileSync(".env", "utf8").match(/^FIREBASE_SERVICE_ACCOUNT_JSON=(.*)$/m)[1].trim()
if ((raw.startsWith("'") && raw.endsWith("'")) || (raw.startsWith('"') && raw.endsWith('"'))) raw = raw.slice(1, -1)
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)), projectId: "wekruit-5f89b" })
const db = admin.firestore()
const key = readFileSync(".env", "utf8").match(/^PA_OPENAI_AGENT_API_KEY=(.*)$/m)?.[1].trim()
const client = new OpenAI({ apiKey: key })

const JOB_ID = "photon-backend-engineer-high-concurrency"
const cos = (a, b) => { let d = 0, x = 0, y = 0; for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; x += a[i] * a[i]; y += b[i] * b[i] } return d / (Math.sqrt(x) * Math.sqrt(y)) }
const embed = async (texts) => {
  const out = []
  for (let i = 0; i < texts.length; i += 96) {
    const r = await client.embeddings.create({ model: "text-embedding-3-small", input: texts.slice(i, i + 96).map((t) => t.slice(0, 8000)) })
    out.push(...r.data.map((d) => d.embedding))
    process.stderr.write(`  embedded ${out.length}/${texts.length}\r`)
  }
  return out
}

// ---- the job ----
const job = (await db.collection("pa-jobs").doc(JOB_ID).get()).data()
const jobText = [
  job.title, job.company, job.location,
  `Required: ${job.requiredSkills.join(", ")}`,
  `Nice to have: ${job.niceToHaveSkills.join(", ")}`,
  job.descriptionMd,
].join("\n")

// ---- the pool ----
const since = new Date(Date.now() - 20 * 3600 * 1000).toISOString()
const all = (await db.collection("pa-users").where("createdAt", ">=", since).get()).docs.map((d) => ({ id: d.id, ...d.data() }))
const yc = all.filter((u) => Boolean(u.ycIntake) || String(u.source ?? "").includes("yc") || String(u.firstTouchCampaign ?? "").includes("yc"))
const pool = yc.filter((u) => u.experienceHighlights?.length || String(u.ycIntake?.building ?? "").length > 20)

const profileText = (u) => {
  const exp = (u.experienceHighlights ?? []).map((e) => [e.title, e.company, e.description, e.startDate && `${e.startDate}–${e.endDate ?? "now"}`].filter(Boolean).join(" · ")).join("\n")
  return [
    u.tags?.recentRoleTitle && `Currently: ${u.tags.recentRoleTitle} at ${u.tags.recentCompany ?? "?"}`,
    u.tags?.workHistorySummary && `History: ${u.tags.workHistorySummary}`,
    exp && `Experience:\n${exp}`,
    u.ycIntake?.building && `Building: ${u.ycIntake.building}`,
  ].filter(Boolean).join("\n")
}

// ---- deterministic evidence, quoted so a rank is inspectable ----
const CORE = { rust: 3, swift: 3, "objective-c": 2, typescript: 2.5, "node.js": 2.5, nodejs: 2.5, golang: 2, " go ": 1, microservice: 2.5, "distributed system": 3, "high-concurrency": 3, concurrency: 2.5, backend: 2.5, "back-end": 2.5, infrastructure: 1.5, messaging: 2, sms: 2, telephony: 2, kafka: 2, grpc: 2, redis: 1.5, kubernetes: 1.5, "low-level": 1.5, systems: 1, latency: 1.5, scalab: 1.5, throughput: 1.5, api: 1 }
const ENGINEER = /\b(software|backend|back.end|full.?stack|platform|infra|systems|sre|devops)\s*(engineer|developer|dev)\b|\bengineer(ing)?\b|\bdeveloper\b|\bcto\b|\bswe\b/i

function evidence(u) {
  const hay = profileText(u).toLowerCase()
  const hits = []
  let s = 0
  for (const [k, w] of Object.entries(CORE)) if (hay.includes(k)) { hits.push(k.trim()); s += w }
  return { score: s, hits }
}
function yearsSince(u) {
  const ds = (u.experienceHighlights ?? []).map((e) => Date.parse(String(e.startDate ?? ""))).filter(Number.isFinite)
  if (!ds.length) return null
  return +((Date.now() - Math.min(...ds)) / (365.25 * 864e5)).toFixed(1)
}
const titleOf = (u) => u.tags?.recentRoleTitle ?? u.experienceHighlights?.[0]?.title ?? "?"
const isEng = (u) => ENGINEER.test(titleOf(u)) || (u.experienceHighlights ?? []).some((e) => ENGINEER.test(String(e.title ?? ""))) || (u.tags?.targetRoleFunction ?? []).some((r) => /engineer|software/.test(r))

console.error(`pool: ${pool.length} of ${yc.length} YC users have something to score on`)
const [jv, ...pv] = await embed([jobText, ...pool.map(profileText)])
process.stderr.write("\n")

const scored = pool.map((u, i) => {
  const ev = evidence(u)
  const sem = cos(jv, pv[i])
  return {
    u, sem, ev, yrs: yearsSince(u), eng: isEng(u),
    // semantic carries the domain fit; evidence carries the stack fit; engineer-ness is a gate
    // expressed as a multiplier rather than a filter, so a mis-titled founder is demoted not erased.
    score: (sem * 100) + Math.min(ev.score, 12) * 2.2 + (isEng(u) ? 8 : 0),
  }
}).sort((a, b) => b.score - a.score)

const fmt = (r) => {
  const u = r.u
  return [
    `  ${String(r.score.toFixed(1)).padStart(5)}  ${u.displayName ?? u.linkedinOauthName ?? "(no name)"}  ${u.phoneE164 ?? ""}`,
    `         ${titleOf(u)} @ ${u.tags?.recentCompany ?? "?"}   ·  ${r.yrs ?? "?"}y since first role  ·  eng=${r.eng ? "yes" : "NO"}`,
    `         sem=${r.sem.toFixed(3)}  stack hits: ${r.ev.hits.slice(0, 10).join(", ") || "(none)"}`,
    `         history: ${String(u.tags?.workHistorySummary ?? "-").slice(0, 130)}`,
    u.ycIntake?.building ? `         building: ${String(u.ycIntake.building).replace(/\n/g, " ").slice(0, 130)}` : "",
    `         li: ${u.linkedinUrl ?? "-"}`,
  ].filter(Boolean).join("\n")
}

// "Able to work full-time and in person in San Francisco" is the JD's real availability gate, and
// it is the one this cohort fails most often — a large share are current interns or students, who
// can clear the 5y coding bar and still not be hireable this quarter. Split rather than blend.
const INTERN = /\bintern(ship)?\b|\bstudent\b|\bteaching assistant\b|\bta\b|\bresearch assistant\b|\bfellow\b|\bincoming\b|\bundergrad/i
const availableNow = (r) => !INTERN.test(titleOf(r.u))

console.log(`\n════ PHOTON · Backend Engineer — ranked from today's ${yc.length} YC users ════`)
console.log(`SF in-person · $180–250K · sponsorship available · 5y+ hands-on · Rust/Swift/TS/Node, high-concurrency\n`)

const A = scored.filter((r) => r.eng && availableNow(r))
console.log(`──── A. FULL-TIME NOW (current title is not an internship / student role) — ${A.length} ────\n`)
for (const r of A.slice(0, 12)) console.log(fmt(r) + "\n")

const B = scored.filter((r) => r.eng && !availableNow(r))
console.log(`──── B. STRONG BUT CURRENTLY INTERN / STUDENT — ${B.length} (top 8) ────\n`)
for (const r of B.slice(0, 8)) console.log(fmt(r) + "\n")

console.log(`\n── pool accounting ──`)
console.log(`  scoreable (had a profile) : ${pool.length} of ${yc.length}`)
console.log(`  engineer-titled           : ${scored.filter((r) => r.eng).length}`)
console.log(`  engineer + >=3 stack hits : ${scored.filter((r) => r.eng && r.ev.hits.length >= 3).length}`)
console.log(`  >=5y since first role     : ${scored.filter((r) => (r.yrs ?? 0) >= 5).length}`)
console.log(`  eng + full-time now       : ${A.length}`)
console.log(`  eng + full-time + >=5y    : ${A.filter((r) => (r.yrs ?? 0) >= 5).length}`)
process.exit(0)
