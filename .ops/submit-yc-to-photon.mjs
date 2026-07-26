/**
 * Submit today's enriched YC Startup School users to Photon · Backend Engineer on the recruiter
 * platform, so the AI eval runs on them and Adam can review the ranking in the admin UI.
 *
 * SCOPE (Adam 2026-07-26): the WHOLE YC cohort in `pa-users` minus whoever already has a Photon BE
 * submission — re-runnable, so a later signup is picked up on the next run. (The first run was
 * scoped to one 20-hour window; that slice can no longer see the cohort.) Enrichment is still
 * required: a phone-only signup with no LinkedIn gives the judge nothing to read, and submitting
 * them would only fill the board with pending/reject noise.
 * NOT the 1066-attendee `pa-external-candidate-records` YC pool.
 *
 * PATH: POSTs the real `paRecruiterSubmission` CF with `source:"api"` (the only submission source
 * that does not require recruiter auth). No hand-written Firestore docs — the CF computes the
 * score, the identity keys, and the doc id, and its create fires `paRecruiterSubmissionEval`,
 * which is the thing we actually want to run. Idempotency-Key per user makes re-runs safe.
 *
 * CHECKLIST HONESTY — the important part. The eval prompt treats recruiter ticks as CLAIMS TO
 * VERIFY, so a tick I cannot support is a lie fed straight into the judge. Every cell here is
 * derived from the candidate's own LinkedIn-derived record (experienceHighlights, workHistorySummary,
 * ycIntake.building) and anything I cannot evidence is OMITTED, not guessed. `sf_full_time`,
 * `remote_only` and `open_source` are never ticked: we have no data on any of them.
 *
 * NOBODY IS EMAILED. Recruiter notifications need a recruiterId (null here => silent by design),
 * and `submissionFeedbackNotification` returns null when `before` is null, i.e. on create.
 * WeKruit never emails candidates from the recruiter platform (locked rule).
 *
 * Dry run by default; `--apply` to send. `--limit N` to cap.
 */
import { readFileSync } from "node:fs"
import admin from "firebase-admin"

let raw = readFileSync(".env", "utf8").match(/^FIREBASE_SERVICE_ACCOUNT_JSON=(.*)$/m)[1].trim()
if ((raw.startsWith("'") && raw.endsWith("'")) || (raw.startsWith('"') && raw.endsWith('"'))) raw = raw.slice(1, -1)
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)), projectId: "wekruit-5f89b" })
const db = admin.firestore()

const ENDPOINT = "https://us-central1-wekruit-5f89b.cloudfunctions.net/paRecruiterSubmission"
const JOB_ID = "photon-backend-engineer-high-concurrency"
const SUBMITTER = { name: "WeKruit YC Sourcing (auto)", email: "admin1@wekruit.com" }

const argv = process.argv.slice(2)
const apply = argv.includes("--apply")
const li = argv.indexOf("--limit")
const LIMIT = li > -1 ? Number(argv[li + 1]) : Infinity

// ── evidence extraction (same signal set as .ops/photon-backend-match.mjs) ──
const AREA = {
  rust: /\brust\b/i,
  swift: /\bswift\b|objective-?c/i,
  ts_node: /\btypescript\b|\bnode\.?js\b|\bnest\b|\bexpress\b/i,
  microservices: /microservice|service mesh|\bgrpc\b|\bkafka\b/i,
}
const CONCURRENCY = /high.?concurrency|concurren|distributed system|throughput|\blatency\b|scalab|load balanc|thread.?safe|async|queue/i
const MESSAGING = /messag|\bsms\b|telephon|telecom|twilio|imessage|whatsapp|notification|pub.?sub|\bkafka\b/i
const RELIABILITY = /reliab|observab|on.?call|incident|monitor|\bsre\b|uptime|kubernetes|redis|performance/i

const profileText = (u) => {
  const exp = (u.experienceHighlights ?? [])
    .map((e) => [e.title, e.company, e.description].filter(Boolean).join(" · "))
    .join("\n")
  return [u.tags?.workHistorySummary, exp, u.ycIntake?.building].filter(Boolean).join("\n")
}
const yearsCoding = (u) => {
  const ds = (u.experienceHighlights ?? []).map((e) => Date.parse(String(e.startDate ?? ""))).filter(Number.isFinite)
  return ds.length ? +((Date.now() - Math.min(...ds)) / (365.25 * 864e5)).toFixed(1) : null
}

function build(u) {
  const text = profileText(u)
  const areas = Object.entries(AREA).filter(([, re]) => re.test(text)).map(([k]) => k)
  const yrs = yearsCoding(u)
  const conc = CONCURRENCY.test(text), msg = MESSAGING.test(text), rel = RELIABILITY.test(text)

  // ONE RULE: assert a positive only where the record shows it; never assert a negative from the
  // record's SILENCE. Most experienceHighlights carry title+company with no description, so "no
  // Rust found" means "we have no description to look in", not "this person can't write Rust" —
  // ticking `no` / `one_or_zero_stack` there would be absence-of-evidence dressed up as evidence-
  // of-absence, and the judge would consume it as a recruiter claim. Unknown => key omitted.
  // Every anti-signal is omitted for the same reason, and `less_than_five_years` additionally
  // because start dates undercount by design: the JD counts personal projects and open source,
  // which never appear as a dated role.
  const checklist = {}
  if (yrs !== null && yrs >= 5) checklist.five_years_programming = "yes"
  else if (yrs !== null && yrs >= 3) checklist.five_years_programming = "partial"
  if (areas.length >= 2) checklist.two_of_four_stack = "yes"
  else if (areas.length === 1) checklist.two_of_four_stack = "partial"
  if (areas.length >= 3) checklist.three_of_four_stack = "yes"
  if (conc) checklist.high_concurrency_ownership = "partial" // never "yes": inferred, not attested
  if (msg) checklist.messaging_telecom = "partial"
  if (rel) checklist.reliability_performance = "partial"
  // sf_full_time / remote_only / open_source / anti-signals: no data, deliberately never claimed.

  const areaLabel = { rust: "Rust", swift: "Swift/ObjC", ts_node: "TypeScript/Node", microservices: "microservices" }
  const evidence = [
    areas.length
      ? `Stack found on profile: ${areas.map((a) => areaLabel[a]).join(", ")}.`
      : "Profile carries roles/companies but no technical descriptions, so stack is UNVERIFIED here — please research.",
    conc ? "Concurrency/distributed/scale language present." : "",
    msg ? "Messaging/telecom signal present." : "",
    `${yrs ?? "?"}y since first listed role.`,
    "Auto-sourced from the YC Startup School pool; LinkedIn-derived, not self-reported.",
  ].filter(Boolean).join(" ").slice(0, 500)

  return {
    jobId: JOB_ID,
    source: "api",
    submitter: SUBMITTER,
    candidate: {
      name: nameOf(u) ?? "(unknown)",
      email: emailOf(u),
      link: u.linkedinUrl,
      linkedinUrl: u.linkedinUrl,
      currentRole: u.tags?.recentRoleTitle ?? u.experienceHighlights?.[0]?.title ?? "",
      currentCompany: u.tags?.recentCompany ?? "",
      yoe: yrs === null ? "" : `${yrs}`,
      notes: [
        `YC Startup School 2026 — scanned ${String(u.createdAt).slice(0, 16)}Z.`,
        // workHistorySummary is absent on the LinkedIn-only signups; fall back to the raw roles we
        // already hold so the human reviewer never opens a submission with no history in it.
        u.tags?.workHistorySummary
          ? `History: ${u.tags.workHistorySummary}`
          : (u.experienceHighlights ?? []).length
            ? `History (LinkedIn-derived roles):\n${(u.experienceHighlights ?? [])
                .map((e) => `- ${[e.title, e.company].filter(Boolean).join(" @ ")}${e.startDate ? ` (${e.startDate}${e.endDate ? ` – ${e.endDate}` : " – present"})` : ""}${e.description ? `\n    ${e.description}` : ""}`)
                .join("\n")}`
            : "",
        u.ycIntake?.building ? `Building: ${u.ycIntake.building}` : "",
        u.ycIntake?.wantsToMeet ? `Wants to meet: ${u.ycIntake.wantsToMeet}` : "",
        "Sourced automatically from the WeKruit YC pool. Checklist cells are LinkedIn-derived inferences, not recruiter attestations; unknowns are left blank.",
      ].filter(Boolean).join("\n").slice(0, 4000),
    },
    checklist,
    extraFields: { system_evidence: evidence },
    _meta: { uid: u.id, yrs, areas, phone: u.phoneE164 },
  }
}

// ── pool: the WHOLE YC cohort, not one day of it ──
// The original run was scoped to `createdAt >= now-20h` ("today's 196"). Re-running it the next
// day submits nobody, because every enriched user is older than the window — the cohort had grown
// past what one day's slice can see. The pool is now the canonical THREE-FIELD YC predicate (same
// union `runYcIntakeToday` uses; Firestore cannot OR across fields in one query), minus everyone
// who already has a submission on this job.
const [bySource, byEventEntry, byCampaign, existing] = await Promise.all([
  db.collection("pa-users").where("source", "==", "yc_startup_school").limit(5000).get(),
  db.collection("pa-users").orderBy("ycEventEntryAt", "desc").limit(5000).get(),
  db.collection("pa-users").where("firstTouchCampaign", "==", "yc-startup-school").limit(5000).get(),
  db.collection("pa-recruiter-submissions").where("jobId", "==", JOB_ID).select("candidate.linkedinUrl").get(),
])
const yc = new Map()
for (const snap of [bySource, byEventEntry, byCampaign]) {
  for (const doc of snap.docs) {
    const d = doc.data() ?? {}
    // orderBy("ycEventEntryAt") returns every doc that HAS the field — re-check the predicate so a
    // stray value can never sweep a non-YC candidate into a recruiter submission.
    const isYc = d.source === "yc_startup_school" || d.firstTouchCampaign === "yc-startup-school"
      || typeof d.ycEventEntryAt === "string" || !!d.ycIntake
    if (isYc) yc.set(doc.id, { id: doc.id, ...d })
  }
}

// Already-submitted, by BOTH keys: the `yc-photon-be-<uid>` doc id this script mints, and the
// candidate LinkedIn URL — so a person a human recruiter already submitted is not duplicated
// under an auto row. (The Idempotency-Key makes a re-POST safe anyway; this keeps the count honest
// and saves ~200 pointless round-trips.)
const doneUids = new Set()
const doneLinkedin = new Set()
const norm = (s) => String(s ?? "").toLowerCase().replace(/\/+$/, "")
for (const d of existing.docs) {
  if (d.id.startsWith("yc-photon-be-")) doneUids.add(d.id.slice("yc-photon-be-".length))
  const li = norm(d.data().candidate?.linkedinUrl)
  if (li) doneLinkedin.add(li)
}

// Names: 21 enriched users carry NO name on pa-users (LinkedIn-only signups never set displayName).
// The name is already on their YC pool record — the same Coresignal profile their experience came
// from — so read it there rather than skipping a real candidate over a missing mirror field.
const poolNameByUid = new Map()
const needName = [...yc.values()].filter((u) => !(u.displayName ?? u.linkedinOauthName))
for (let i = 0; i < needName.length; i += 300) {
  const refs = needName.slice(i, i + 300).map((u) => db.collection("pa-external-candidate-records").doc(`yc-user:${u.id}`))
  const snaps = await db.getAll(...refs)
  for (const [j, s] of snaps.entries()) {
    const n = s.exists ? s.data()?.name : null
    if (typeof n === "string" && n.trim()) poolNameByUid.set(needName[i + j].id, n.trim())
  }
}
const nameOf = (u) => u.displayName ?? u.linkedinOauthName ?? poolNameByUid.get(u.id) ?? null

// Emails: `paRecruiterSubmission` REQUIRES candidate.email (identity key — validateSubmission
// rejects with `missing_candidate_email`), and LinkedIn-only signups have none on `pa-users`.
// The Coresignal profile we ALREADY hold for them carries one for most; read it from our own cache
// (cache-only, no provider call, no new spend). Identity key only — the recruiter platform never
// emails candidates (locked rule), so this reaches nobody's inbox.
const cacheEmailByUid = new Map()
const needEmail = [...yc.values()].filter((u) => !(u.email ?? u.linkedinOauthEmail) && /linkedin\.com\/in\//i.test(String(u.linkedinUrl ?? "")))
const pickEmail = (e = {}) => [
  e.primary_professional_email, e.professional_email,
  ...(Array.isArray(e.professional_emails_collection) ? e.professional_emails_collection.map((x) => x?.professional_email ?? x?.email) : []),
  ...(Array.isArray(e.personal_emails_collection) ? e.personal_emails_collection : []),
].find((x) => typeof x === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(x))
for (const u of needEmail) {
  const url = String(u.linkedinUrl)
  let doc = null
  for (const v of new Set([url, url.replace("://linkedin", "://www.linkedin"), url.replace("://www.linkedin", "://linkedin")])) {
    const q = await db.collection("pa-coresignal-cache").where("linkedinUrl", "==", v).limit(1).get()
    if (!q.empty) { doc = q.docs[0].data(); break }
  }
  if (!doc && typeof u.coresignalEmployeeId === "number") {
    const q = await db.collection("pa-coresignal-cache").where("coresignalId", "==", u.coresignalEmployeeId).limit(1).get()
    if (!q.empty) doc = q.docs[0].data()
  }
  const em = pickEmail(doc?.employee)
  if (em) cacheEmailByUid.set(u.id, em)
}
const emailOf = (u) => u.email ?? u.linkedinOauthEmail ?? cacheEmailByUid.get(u.id) ?? null

const skipped = []
const ready = []
for (const u of yc.values()) {
  const li = typeof u.linkedinUrl === "string" ? u.linkedinUrl : ""
  if (doneUids.has(u.id) || (li && doneLinkedin.has(norm(li)))) { skipped.push({ u, why: "already submitted to this job" }); continue }
  if (u.testMode === true || u.isDemo === true) { skipped.push({ u, why: "test/demo user" }); continue }
  if (!(u.experienceHighlights?.length || typeof u.coresignalEmployeeId === "number")) { skipped.push({ u, why: "no enrichment — nothing for the judge to read" }); continue }
  // Case-insensitive: a stored `https://LinkedIn.com/in/...` is a real profile, not a placeholder.
  if (!/linkedin\.com\/in\//i.test(li)) { skipped.push({ u, why: "no real LinkedIn url (oauth placeholder)" }); continue }
  if (!nameOf(u)) { skipped.push({ u, why: "no name on user or YC pool record" }); continue }
  if (!emailOf(u)) { skipped.push({ u, why: "no email anywhere (user / YC pool / cached profile) — CF requires one" }); continue }
  ready.push(u)
}

const tally = new Map()
for (const s of skipped) tally.set(s.why, (tally.get(s.why) ?? 0) + 1)
console.log(`YC cohort ${yc.size} · submittable ${ready.length} · skipped ${skipped.length}`)
for (const [why, n] of [...tally].sort((a, b) => b[1] - a[1])) console.log(`   ${String(n).padStart(4)}× ${why}`)

const batch = ready.slice(0, LIMIT)
if (!apply) {
  console.log(`\nDRY RUN — would submit ${batch.length}. Sample payloads:\n`)
  for (const u of batch.slice(0, 3)) {
    const p = build(u)
    console.log(JSON.stringify({ candidate: p.candidate, checklist: p.checklist, extraFields: p.extraFields }, null, 1).slice(0, 1500))
    console.log("---")
  }
  console.log("\npass --apply to send")
  process.exit(0)
}

let ok = 0, dup = 0, fail = 0
const reasons = new Map()
for (const [i, u] of batch.entries()) {
  const p = build(u)
  delete p._meta
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": `yc-photon-be-${u.id}` },
    body: JSON.stringify(p),
  })
  const j = await res.json().catch(() => ({}))
  if (res.status === 200) { j.idempotent ? dup++ : ok++ }
  else if (res.status === 409) { dup++; reasons.set(j.reason, (reasons.get(j.reason) ?? 0) + 1) }
  else { fail++; reasons.set(`${res.status}:${j.reason}`, (reasons.get(`${res.status}:${j.reason}`) ?? 0) + 1) }
  if ((i + 1) % 20 === 0) console.log(`  ${i + 1}/${batch.length}  ok=${ok} dup=${dup} fail=${fail}`)
  await new Promise((r) => setTimeout(r, 120))
}
console.log(`\nDONE submitted=${ok} duplicate/conflict=${dup} failed=${fail}`)
for (const [r, n] of [...reasons].sort((a, b) => b[1] - a[1])) console.log(`   ${n}× ${r}`)
process.exit(0)
