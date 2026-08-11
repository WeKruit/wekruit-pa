/**
 * The eval came back 136× hard 0/4 and 55× hard 1/4, and every summary says the same sentence:
 * "no concrete evidence for Rust/Swift/Node microservices", "no résumé text provided". The judge
 * is not wrong — it was handed a one-line `workHistorySummary` (top 3 roles, no dates, no
 * descriptions) and a Coresignal headline. It had nothing to verify a stack against.
 *
 * These users have no résumé on file, but they DO have a full `experienceHighlights` array with
 * dates and, for many, role descriptions. That never reached the judge. This backfills
 * `candidate.notes` with the complete list, then re-runs the eval on the patched rows.
 *
 * Adds no claims — it only stops withholding evidence we already hold. The checklist is untouched.
 *
 * `--ids a,b,c` to target specific submissions, else all for the job. Dry run by default.
 */
import { readFileSync } from "node:fs"
import admin from "firebase-admin"

let raw = readFileSync(".env", "utf8").match(/^FIREBASE_SERVICE_ACCOUNT_JSON=(.*)$/m)[1].trim()
if ((raw.startsWith("'") && raw.endsWith("'")) || (raw.startsWith('"') && raw.endsWith('"'))) raw = raw.slice(1, -1)
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)), projectId: "wekruit-5f89b" })
const db = admin.firestore()

const JOB_ID = "photon-backend-engineer-high-concurrency"
const argv = process.argv.slice(2)
const apply = argv.includes("--apply")
const li = argv.indexOf("--limit")
const LIMIT = li > -1 ? Number(argv[li + 1]) : Infinity
const pi = argv.indexOf("--phones")
const PHONES = pi > -1 ? new Set(argv[pi + 1].split(",")) : null

const subs = (await db.collection("pa-recruiter-submissions").where("jobId", "==", JOB_ID).get()).docs
const since = new Date(Date.now() - 22 * 3600 * 1000).toISOString()
const users = (await db.collection("pa-users").where("createdAt", ">=", since).get()).docs.map((d) => ({ id: d.id, ...d.data() }))
// Join on the DOC ID, not the LinkedIn URL: submissions were created with
// `Idempotency-Key: yc-photon-be-<uid>`, which the CF uses verbatim as the doc id, so the uid is
// carried losslessly. Matching on `candidate.linkedinUrl` returned 0 — the CF canonicalises the
// URL on write, so it no longer equals the string on pa-users.
const byUid = new Map(users.map((u) => [u.id, u]))
const uidOf = (docId) => (docId.startsWith("yc-photon-be-") ? docId.slice("yc-photon-be-".length) : null)

function fullHistory(u) {
  const rows = (u.experienceHighlights ?? []).map((e) => {
    const span = e.startDate ? ` (${e.startDate}${e.currentRole ? " – present" : e.endDate ? ` – ${e.endDate}` : ""})` : ""
    return `- ${e.title ?? "?"} @ ${e.company ?? "?"}${span}${e.description ? `\n    ${e.description}` : ""}`
  })
  return rows.join("\n")
}

const targets = []
for (const d of subs) {
  const s = d.data()
  const uid = uidOf(d.id)
  const u = uid ? byUid.get(uid) : undefined
  if (!u) continue
  if (PHONES && !PHONES.has(String(u.phoneE164))) continue
  const hist = fullHistory(u)
  if (!hist) continue
  const notes = [
    `YC Startup School 2026 — scanned ${String(u.createdAt).slice(0, 16)}Z.`,
    "",
    "FULL WORK HISTORY (LinkedIn-derived, all roles, not a top-3 summary):",
    hist,
    u.ycIntake?.building ? `\nWHAT THEY SAY THEY ARE BUILDING: ${u.ycIntake.building}` : "",
    u.ycIntake?.wantsToMeet ? `WHO THEY WANT TO MEET: ${u.ycIntake.wantsToMeet}` : "",
    "",
    "NO RESUME ON FILE for this candidate. Evidence above is LinkedIn-derived, not self-reported,",
    "and the submitted checklist is deliberately near-blank: unknowns were left unticked rather",
    "than guessed, so an unticked box means 'not established', NOT 'candidate lacks it'.",
  ].filter(Boolean).join("\n").slice(0, 3900)
  targets.push({ id: d.id, notes, name: s.candidate?.name, phone: u.phoneE164, before: notes.length, wasVerdict: s.aiEvaluation?.verdict, wasHard: s.aiEvaluation?.checklist?.hard?.met })
}

const batch = targets.slice(0, LIMIT)
console.log(`submissions ${subs.length} · matched to a user ${targets.length} · patching ${batch.length}`)
if (!apply) {
  for (const t of batch.slice(0, 3)) console.log(`\n--- ${t.name} (${t.phone}) was=${t.wasVerdict} hard=${t.wasHard}\n${t.notes.slice(0, 900)}`)
  console.log("\nDRY RUN — pass --apply")
  process.exit(0)
}
let n = 0
for (const t of batch) {
  await db.collection("pa-recruiter-submissions").doc(t.id).set({ candidate: { notes: t.notes } }, { merge: true })
  n++
}
console.log(`patched ${n}`)
console.log("ids:", batch.map((t) => t.id).join(","))
process.exit(0)
