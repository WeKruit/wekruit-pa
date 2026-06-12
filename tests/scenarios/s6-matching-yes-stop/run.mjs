/**
 * S6-matching-yes-stop — PRD §2.7 Post-Pitch Matching Subscription UX sim (round 2).
 *
 * Flow under test (THIN Claire runtime — the production path; runner-local cannot reach it):
 *   T1  candidate (already pitched; pitch + "want me to pull roles?" offer seeded in pa-messages
 *       history) texts "yes" → expect the recommendation flow to ACTIVATE with DURABLE consent
 *       semantics: find_match fires AND the yes turn itself stamps pa-job-profiles/{uid}
 *       status:"active" + recommendationOptIn (round-1 gap §2.7.1, now fixed in matching-tools.ts).
 *   PASS-A  the REAL daily cadence (provisionCadenceAudience + runDailyJobRecBatch, scheduleSend
 *       recorder injected — nothing can actually send) → expect the user's rec send to be QUEUED.
 *   T2  SOFT stop (round-1 finding #4, previously unexercised): "can you stop sending me the job
 *       matches for now?" is NOT a carrier keyword → must pass the stop-gate, reach the agent,
 *       and the agent must pause the subscription via set_daily_subscription optedIn=false →
 *       pa-job-profiles status:"paused" + recommendationOptIn{optedIn:false}; Claire still
 *       replies (conversation continues — only recs pause; doNotContact stays false).
 *   PASS-A2  cadence again → ZERO queued sends (paused row is OUT of the status=="active"
 *       audience) and provision must NOT resurrect the paused row (idempotency contract).
 *   T3  candidate texts "stop" (bare keyword) → deterministic stop-gate (claire-agent/stop-gate.ts)
 *       at the production seam (broker/coalescer — BEFORE maybeRunThinClaire) → expect opt_out
 *       handled, doNotContact=true, exactly ONE confirmation, agent does NOT run.
 *   PASS-B  the same cadence again (cadence-due by clock) → expect ZERO queued sends for the user
 *       (doNotContact + paused), provision skip, and pending-outbound isSuppressed() = suppressed.
 *   T4  candidate texts "any update?" → stop-gate swallows silently (suppressed_opted_out, 0 sends).
 *
 * Seam fidelity notes:
 *   - Stop gate runs FIRST each turn, exactly as wired in apps/functions/src/index.ts
 *     processBrokerImessageEvent and coalesce/paMessageCoalescer.ts (documented in stop-gate.ts).
 *   - The agent turn is the REAL selectClaireMode → runClaireTurn → gpt-5.4-nano with a dryRun
 *     Sendblue transport (recordedEvents only; zero real messages).
 *   - The cadence is the REAL apps/job-rec runDailyJobRecBatch with an injected scheduleSend
 *     recorder (the Cloud-Tasks seam) — sends are recorded, never fired; sendImessage never runs.
 *   - Everything runs on an in-memory Firestore stub. No prod Firestore, no deploy, no Sendblue.
 *
 * Run (Node 24, from apps/functions so tsx picks up its tsconfig path aliases):
 *   cd apps/functions && PA_OPENAI_AGENT_API_KEY=… node --import tsx ../../tests/scenarios/s6-matching-yes-stop/run.mjs
 */
import { PA_COLLECTIONS } from "@pa/core-types"
import { selectClaireMode } from "../../../apps/functions/src/claire-agent/mode-selector.js"
import { runClaireTurn } from "../../../apps/functions/src/claire-agent/agent.js"
import { createSendblueTransport } from "../../../apps/functions/src/claire-agent/transport.js"
import { makeV16FindMatch } from "../../../apps/functions/src/claire-agent/tools/matching-tools.js"
import {
  runStopGate,
  STOP_CONFIRMATION_TEXT,
} from "../../../apps/functions/src/claire-agent/stop-gate.js"
import { isSuppressed } from "../../../apps/functions/src/pending-outbound/suppression.js"
import { provisionCadenceAudience } from "../../../apps/job-rec/src/audience-provision.js"
import { runDailyJobRecBatch } from "../../../apps/job-rec/src/daily-batch.js"

const UID = "8fEwIduUrzxZsblHHsNz"
const PHONE = "+14243201960"
const SID = "ses_s6_yes_stop"
const T0 = "2026-06-12T00:00:00.000Z"
const JOB_PROFILES = "pa-job-profiles"

// ───────────────────────── in-memory Firestore (op-aware) ─────────────────────────
function makeFirestore() {
  const store = new Map()
  const col = (name) => {
    if (!store.has(name)) store.set(name, new Map())
    return store.get(name)
  }
  let autoId = 0
  const fieldVal = (d, f) => (f.includes(".") ? f.split(".").reduce((o, k) => o?.[k], d) : d?.[f])
  const matches = (op, a, v) => {
    switch (op) {
      case "==": return a === v
      case "!=": return a !== v
      case "in": return Array.isArray(v) && v.includes(a)
      case "not-in": return Array.isArray(v) && !v.includes(a)
      case "array-contains": return Array.isArray(a) && a.includes(v)
      case "array-contains-any": return Array.isArray(a) && Array.isArray(v) && v.some((x) => a.includes(x))
      case "<": return a < v
      case "<=": return a <= v
      case ">": return a > v
      case ">=": return a >= v
      default: return false
    }
  }
  function makeQuery(name, filters, orders = [], limitN = 0) {
    const run = () => {
      let rows = [...col(name).entries()].filter(([, d]) =>
        filters.every(([f, op, v]) => matches(op, fieldVal(d, f), v)),
      )
      for (const [f, dir] of [...orders].reverse()) {
        rows = rows.sort(([, a], [, b]) => {
          const x = fieldVal(a, f), y = fieldVal(b, f)
          const c = x === y ? 0 : x < y ? -1 : 1
          return dir === "desc" ? -c : c
        })
      }
      if (limitN > 0) rows = rows.slice(0, limitN)
      return rows
    }
    const snapDocs = (rows) =>
      rows.map(([id, d]) => ({ id, exists: true, data: () => d, get: (f) => fieldVal(d, f), ref: docRef(name, id) }))
    return {
      where(f, op, v) { return makeQuery(name, [...filters, [f, op, v]], orders, limitN) },
      orderBy(f, dir = "asc") { return makeQuery(name, filters, [...orders, [f, dir]], limitN) },
      limit(n) { return makeQuery(name, filters, orders, n) },
      select() { return this },
      offset() { return this },
      startAfter() { return this },
      count() { return { async get() { return { data: () => ({ count: run().length }) } } } },
      async get() { const r = run(); return { empty: r.length === 0, size: r.length, docs: snapDocs(r) } },
    }
  }
  function docRef(name, id) {
    const docId = id ?? `auto_${++autoId}`
    return {
      id: docId,
      path: `${name}/${docId}`,
      async get() {
        const d = col(name).get(docId)
        return { id: docId, exists: !!d, data: () => d, get: (f) => fieldVal(d ?? {}, f), ref: docRef(name, docId) }
      },
      async set(data, opts) {
        const prev = opts?.merge ? (col(name).get(docId) ?? {}) : {}
        col(name).set(docId, { ...prev, ...data })
        return {}
      },
      async update(data) {
        col(name).set(docId, { ...(col(name).get(docId) ?? {}), ...data })
        return {}
      },
      async delete() { col(name).delete(docId); return {} },
      collection(sub) { return db.collection(`${name}/${docId}/${sub}`) },
    }
  }
  const db = {
    collection(name) {
      return {
        where(f, op, v) { return makeQuery(name, [[f, op, v]]) },
        orderBy(f, dir) { return makeQuery(name, []).orderBy(f, dir) },
        limit(n) { return makeQuery(name, [], [], n) },
        select() { return makeQuery(name, []) },
        count() { return makeQuery(name, []).count() },
        doc(id) { return docRef(name, id) },
        async add(data) { const r = docRef(name); await r.set(data); return r },
        async get() { return makeQuery(name, []).get() },
      }
    },
    async runTransaction(fn) {
      const tx = {
        get: (ref) => ref.get(),
        set: (ref, data, opts) => { void ref.set(data, opts); return tx },
        update: (ref, data) => { void ref.update(data); return tx },
        delete: (ref) => { void ref.delete(); return tx },
      }
      return fn(tx)
    },
    batch() {
      const ops = []
      return {
        set(ref, data, opts) { ops.push(() => ref.set(data, opts)) },
        update(ref, data) { ops.push(() => ref.update(data)) },
        delete(ref) { ops.push(() => ref.delete()) },
        async commit() { for (const op of ops) await op() },
      }
    },
  }
  return { db, col }
}

// ───────────────────────── seed: post-pitch known candidate ─────────────────────────
function seed(col) {
  col("pa-feature-flags").set("paThinClaireEnabled", {
    key: "paThinClaireEnabled", value: false, type: "bool", scope: "perUser", allowlist: [UID], blocklist: [],
  })
  col(PA_COLLECTIONS.users).set(UID, {
    id: UID,
    phoneE164: PHONE,
    displayName: "Adam Yang",
    onboardingState: "complete",
    onboardingStatus: "complete",
    sharedOnboarding: { status: "complete", completed: true },
    tags: {
      careerStage: "senior",
      targetRoleFunction: ["software_engineering"],
      targetLocations: ["san_francisco_bay_area", "remote_united_states"],
      minSalary: 180000,
      recentRoleTitle: "Senior Software Engineer",
      recentCompany: "Tesla",
      visaStatus: "citizen",
      skills: [{ name: "TypeScript" }, { name: "Kubernetes" }, { name: "Azure" }],
    },
    experienceHighlights: [
      { title: "Senior Software Engineer", company: "Tesla", description: "Backend + platform infra; TypeScript/Kubernetes/Azure." },
    ],
  })
  col(PA_COLLECTIONS.sessions).set(SID, {
    id: SID, userId: UID, channel: "imessage", externalChatId: PHONE,
    createdAt: T0, lastMessageAt: T0,
  })
  // Prior-turn transcript: the already-delivered 3-bubble pitch (PRD §2.1 contract) ending in the
  // ONE clear ask — "pull matching roles now?" — so T1 "yes" is the post-pitch subscription yes.
  const history = [
    ["user", "hi", "2026-06-12T00:00:01.000Z"],
    ["assistant", "got your LinkedIn pulled in, adam — i read through your background just now.", "2026-06-12T00:00:02.000Z"],
    ["assistant", "here's how i'd pitch you: senior software engineer (~4 yrs) at tesla, backend/platform lane — typescript + kubernetes + azure, shipped under real production constraints. that profile fits senior backend/platform roles at infra-heavy teams.", "2026-06-12T00:00:03.000Z"],
    ["assistant", "want me to pull matching roles for you now? i can text you fresh fits as they land — or tweak anything first.", "2026-06-12T00:00:04.000Z"],
  ]
  for (const [i, [role, body, createdAt]] of history.entries()) {
    col(PA_COLLECTIONS.messages).set(`seed_msg_${i}`, {
      id: `seed_msg_${i}`, sessionId: SID, userId: UID, role, body, createdAt,
    })
  }
  const jobs = [
    ["Senior Backend Engineer", "Ramp"],
    ["Platform Engineer", "Rippling"],
    ["Senior Software Engineer, Infra", "Vercel"],
  ]
  for (const [i, [title, company]] of jobs.entries()) {
    col("matching-jobs").set(`job_${i}`, {
      jobId: `job_${i}`, id: `job_${i}`, status: "active", title, company,
      companyName: company, jobTitle: title,
      roleFunction: ["software_engineering"], seniorityLevel: "senior",
      locationBuckets: ["remote_united_states"], jobType: "full_time", sponsorship: true,
      firstSeenAt: "2026-06-11T00:00:00.000Z", dead: false,
      atsApplyUrl: `https://jobs.${company.toLowerCase()}.com/role-${i}`,
      requiredSkills: ["typescript", "kubernetes"], niceToHaveSkills: ["azure"],
      salaryMin: 185000, salaryMax: 240000,
      jdSummary: `${title} building TypeScript/Kubernetes platform services.`,
    })
  }
}

// ───────────────────────── turn driver (production seam order) ─────────────────────────
const transcript = []
const ts = () => new Date().toISOString()
function say(line) { transcript.push(line); console.log(line) }

async function driveTurn(db, col, turnNo, text) {
  say(`\n[${ts()}] TURN ${turnNo} — USER> ${text}`)
  const eventId = `evt_s6_t${turnNo}`
  // 1. Deterministic stop-gate at the EXACT production seam (before any thin/legacy routing).
  const confirmations = []
  const gate = await runStopGate(
    db,
    { eventId, userId: UID, sessionId: SID, toE164: PHONE, text },
    {
      dryRun: true,
      sendConfirmation: async (body) => { confirmations.push(body) },
      filePrivacyRequest: async (nowIso) => {
        // Mirrors the default writePrivacyRequest effect (in-memory; keeps isSuppressed honest).
        col("pa-privacy-requests").set(`pr_s6_t${turnNo}`, {
          requestId: `pr_s6_t${turnNo}`, kind: "stop_outreach", candidateId: UID,
          sourceSurface: "imessage", requestedBy: "candidate", status: "submitted", createdAt: nowIso,
        })
      },
      log: () => {},
    },
  )
  for (const c of confirmations) say(`[${ts()}] TURN ${turnNo} — CLAIRE (stop-gate)> ${c}`)
  if (gate.handled) {
    if (confirmations.length === 0) say(`[${ts()}] TURN ${turnNo} — (no outbound — turn swallowed: ${gate.action})`)
    return { gate, confirmations, bubbles: [], toolCalls: [], findMatchCalled: false, agentRan: false }
  }
  // 2. REAL thin turn: selectClaireMode → runClaireTurn (dryRun transport).
  const decision = await selectClaireMode({ db, userId: UID, inboundText: text, log: () => {} })
  const transport = createSendblueTransport({
    db, toE164: PHONE, userId: UID, sessionId: SID, inboundEventId: eventId, dryRun: true,
  })
  let findMatchCalled = false
  const findMatch = makeV16FindMatch(db, undefined, undefined)
  const wrapped = async (...a) => { findMatchCalled = true; return findMatch(...a) }
  const result = await runClaireTurn(
    { userId: UID, sessionId: SID, text, toE164: PHONE, inboundEventId: eventId, lang: "en" },
    {
      db, transport, findMatch: wrapped, log: () => {}, mode: decision.mode,
      ...(decision.pendingStep ? { pendingStep: decision.pendingStep } : {}),
      ...(decision.processStore ? { processStore: decision.processStore } : {}),
      ...(decision.locationSalaryAsk ? { locationSalaryAsk: true } : {}),
      ...(decision.warmReturningGreeting ? { warmReturningGreeting: true } : {}),
    },
  )
  const bubbles = transport.recordedEvents.filter((e) => e.kind === "text").map((e) => e.value)
  for (const b of bubbles) say(`[${ts()}] TURN ${turnNo} — CLAIRE> ${b.replace(/\n/g, " ⏎ ")}`)
  const toolCalls = (result.toolCalls ?? []).map((t) =>
    typeof t === "string" ? t : (t && typeof t === "object" && (t.name ?? t.tool)) || JSON.stringify(t),
  )
  say(`[${ts()}] TURN ${turnNo} — (mode=${decision.mode} toolCalls=[${toolCalls.join(", ")}] find_match=${findMatchCalled})`)
  return { gate, confirmations, bubbles, toolCalls, findMatchCalled, agentRan: true }
}

// ───────────────────────── cadence pass (REAL provision + batch, queued-send recorder) ────
async function cadencePass(db, label, nowMs, todayYmd) {
  const queued = []
  const skipLogs = []
  const batchLog = (...args) => {
    const head = typeof args[0] === "string" ? args[0] : ""
    if (/skip|no_jobs|excluded|do_not_contact|suppress|v16/i.test(head)) skipLogs.push(head)
  }
  const provision = await provisionCadenceAudience({ db, nowMs, log: () => {} })
  const batch = await runDailyJobRecBatch({
    db,
    getFlag: async (_db, key, _ctx, defaultValue) => (key === "paJobRecEnabled" ? true : defaultValue),
    nowMs,
    todayYmd: () => todayYmd,
    scheduleSend: async ({ userId, idempotencyKey, delayMs }) => {
      queued.push({ userId, idempotencyKey, delayMs })
      return { ok: true }
    },
    log: batchLog,
  })
  say(
    `\n[${ts()}] CADENCE ${label} — provision{eligible=${provision.eligible} provisioned=${provision.provisioned} alreadyProvisioned=${provision.alreadyProvisioned} skippedDoNotContact=${provision.skippedDoNotContact}} ` +
    `batch{total=${batch.total} delivered=${batch.delivered} skippedDoNotContact=${batch.skippedDoNotContact ?? 0} skippedFlag=${batch.skippedFlag} skippedNoJobs=${batch.skippedNoJobs} skippedNotDue=${batch.skippedNotDue ?? 0} skippedCooldown=${batch.skippedCooldown ?? 0} errors=${batch.errors}} ` +
    `queuedSends=${JSON.stringify(queued)}`,
  )
  if (skipLogs.length > 0) say(`[${ts()}] CADENCE ${label} — skip-reason logs: ${[...new Set(skipLogs)].join(" | ")}`)
  return { provision, batch, queued }
}

/** New demand events between the live T1 batch and the cadence run — without these the
 *  cadence CORRECTLY refuses to re-send T1's jobs (14-day repeat-rec exclusion). */
function seedFreshJobs(col, firstSeenAt) {
  const jobs = [
    ["Staff Software Engineer, Platform", "Stripe"],
    ["Senior Infrastructure Engineer", "Datadog"],
    ["Senior Backend Engineer, Payments", "Plaid"],
  ]
  for (const [i, [title, company]] of jobs.entries()) {
    col("matching-jobs").set(`fresh_job_${i}`, {
      jobId: `fresh_job_${i}`, id: `fresh_job_${i}`, status: "active", title, company,
      companyName: company, jobTitle: title,
      roleFunction: ["software_engineering"], seniorityLevel: "senior",
      locationBuckets: ["remote_united_states"], jobType: "full_time", sponsorship: true,
      firstSeenAt, dead: false,
      atsApplyUrl: `https://jobs.${company.toLowerCase()}.com/fresh-${i}`,
      requiredSkills: ["typescript", "kubernetes"], niceToHaveSkills: ["azure"],
      salaryMin: 190000, salaryMax: 250000,
      jdSummary: `${title} — TypeScript/Kubernetes platform and infra work.`,
    })
  }
}

// ───────────────────────── run ─────────────────────────
const { db, col } = makeFirestore()
seed(col)

say(`# S6-matching-yes-stop — live sim transcript ${ts()}`)
say(`Seeded: pitched candidate (3-bubble pitch + "pull matching roles now?" offer in pa-messages); enriched tags; 3 active matching-jobs.`)

const t1 = await driveTurn(db, col, 1, "yes")
const jobProfileAfterYes = structuredClone(col(JOB_PROFILES).get(UID) ?? null)
say(`[${ts()}] STATE after T1 — pa-job-profiles/${UID} = ${JSON.stringify(jobProfileAfterYes)}`)

seedFreshJobs(col, "2026-06-14T00:00:00.000Z")
say(`[${ts()}] SEED — 3 NEW matching-jobs landed after T1 (the cadence never re-sends T1's jobs inside the 14d repeat window).`)
const passA = await cadencePass(db, "PASS-A (post-yes, T1+3d)", Date.parse(T0) + 3 * 864e5, "2026-06-15")

// T2 — SOFT pause (§2.7.3 "asks to pause job recommendations"): not a keyword, must reach the agent.
const t2 = await driveTurn(db, col, 2, "can you stop sending me the job matches for now?")
const jobProfileAfterSoftStop = structuredClone(col(JOB_PROFILES).get(UID) ?? null)
const userAfterSoftStop = structuredClone(col(PA_COLLECTIONS.users).get(UID) ?? null)
say(
  `[${ts()}] STATE after T2 — pa-job-profiles status=${jobProfileAfterSoftStop?.status} ` +
  `recommendationOptIn=${JSON.stringify(jobProfileAfterSoftStop?.recommendationOptIn ?? null)} ` +
  `doNotContact=${userAfterSoftStop?.doNotContact ?? false}`,
)

const passA2 = await cadencePass(db, "PASS-A2 (post-soft-pause, T1+6d)", Date.parse(T0) + 6 * 864e5, "2026-06-18")

const t3 = await driveTurn(db, col, 3, "stop")
const userAfterStop = col(PA_COLLECTIONS.users).get(UID)
say(`[${ts()}] STATE after T3 — doNotContact=${userAfterStop?.doNotContact} source=${userAfterStop?.doNotContactSource} privacyRequests=${col("pa-privacy-requests").size}`)

const passB = await cadencePass(db, "PASS-B (post-STOP-keyword, T1+10d)", Date.parse(T0) + 10 * 864e5, "2026-06-22")
const suppression = await isSuppressed(db, UID, { kind: "job_rec_daily" })
say(`[${ts()}] SUPPRESSION (pending-outbound/isSuppressed, kind=job_rec_daily) → suppressed=${suppression.suppressed} reason=${suppression.reason} signals=[${suppression.signals.join(", ")}]`)

const t4 = await driveTurn(db, col, 4, "any update?")

// ───────────────────────── checks ─────────────────────────
// FIX ROUND 1 (2026-06-12, PRD §2.7.1 + §3.2 + §2.9.5): the subscription check is now STRICT —
// the YES TURN ITSELF must write the durable pa-job-profiles row with a consent record
// (recommendationOptIn), not merely end up subscribed via the consent-blind cadence auto-provision.
const checks = [
  ["T1 'yes': stop-gate passed it through (not a keyword)", t1.gate.handled === false],
  ["T1 'yes': agent activated the rec flow (find_match and/or subscription tool ran)",
    t1.findMatchCalled || t1.toolCalls.includes("set_daily_subscription") || t1.toolCalls.includes("save_job_profile")],
  ["T1 'yes': Claire replied (≥1 bubble)", t1.bubbles.length > 0],
  ["§2.7.1 SUBSCRIPTION: the YES turn itself wrote pa-job-profiles status=active (tool-owned side effect, not auto-provision)",
    jobProfileAfterYes?.status === "active"],
  ["§2.9.5 CONSENT RECORD: recommendationOptIn {optedIn:true} stamped on the yes turn — readable later",
    jobProfileAfterYes?.recommendationOptIn?.optedIn === true &&
      typeof jobProfileAfterYes?.recommendationOptIn?.source === "string" &&
      typeof jobProfileAfterYes?.recommendationOptIn?.at === "string"],
  ["PASS-A: rec send QUEUED for the user while subscribed", passA.queued.some((q) => q.userId === UID)],
  // ROUND 2 — §2.7.3 SOFT path: "asks to pause job recommendations" (non-keyword) must pause the
  // SUBSCRIPTION via the agent, while Claire keeps talking (no carrier opt-out).
  ["T2 soft 'stop sending matches': stop-gate passed it through (NOT a carrier keyword)", t2.gate.handled === false && t2.agentRan === true],
  ["T2 soft: agent called set_daily_subscription", t2.toolCalls.includes("set_daily_subscription")],
  ["T2 soft: pa-job-profiles status=paused (subscription paused, not deleted)", jobProfileAfterSoftStop?.status === "paused"],
  ["T2 soft: consent record flipped — recommendationOptIn {optedIn:false} written",
    jobProfileAfterSoftStop?.recommendationOptIn?.optedIn === false],
  ["T2 soft: Claire still replied (conversation continues; only recs pause)", t2.bubbles.length > 0],
  ["T2 soft: doNotContact NOT set (soft pause ≠ carrier opt-out)", userAfterSoftStop?.doNotContact !== true],
  ["PASS-A2: ZERO rec sends queued while paused (paused row out of the active audience)", passA2.queued.length === 0],
  ["PASS-A2: provision did NOT resurrect the paused row (status stayed paused)",
    passA2.provision.provisioned === 0 && col(JOB_PROFILES).get(UID)?.status !== "active"],
  ["T3 'stop': stop-gate handled it as opt_out (agent did NOT run)", t3.gate.handled === true && t3.gate.action === "opt_out" && t3.agentRan === false],
  ["T3 'stop': doNotContact=true written (source sms_stop_keyword)", userAfterStop?.doNotContact === true && userAfterStop?.doNotContactSource === "sms_stop_keyword"],
  ["T3 'stop': exactly ONE confirmation, the compliance copy", t3.confirmations.length === 1 && t3.confirmations[0] === STOP_CONFIRMATION_TEXT],
  ["PASS-B: ZERO rec sends queued after STOP", passB.queued.length === 0],
  ["PASS-B: batch deterministically skipped the user (doNotContact or paused row out of audience)",
    (passB.batch.skippedDoNotContact ?? 0) >= 1 || passB.batch.total === 0],
  ["PASS-B: provision pre-pass refuses to (re)provision an opted-out user", passB.provision.provisioned === 0],
  ["isSuppressed(): pending-outbound gate suppresses the user post-STOP", suppression.suppressed === true],
  ["T4 post-STOP inbound: swallowed silently (suppressed_opted_out, zero sends)",
    t4.gate.handled === true && t4.gate.action === "suppressed_opted_out" && t4.bubbles.length === 0 && t4.confirmations.length === 0],
]
say("\n================ S6 MATCHING YES → STOP ================")
let pass = 0
for (const [name, ok] of checks) { say(`  ${ok ? "✅" : "❌"} ${name}`); if (ok) pass++ }
say(`\nRESULT: ${pass}/${checks.length}`)

// dump transcript for the caller to copy verbatim
import { writeFileSync } from "node:fs"
writeFileSync("/tmp/s6-transcript-raw.txt", transcript.join("\n") + "\n")
process.exit(pass === checks.length ? 0 : 1)
