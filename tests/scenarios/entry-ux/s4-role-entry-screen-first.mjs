/**
 * S4-role-entry-screen-first — ENTRY-UX PRD §2.6 sim (round 1).
 *
 * Seeds: candidate entered from a JOB PAGE (role context = jobIdContext on the website-entry
 * runtime event / the WeKruit_<jobId>_<userId>_Job trigger token).
 *
 * LEG 1 (enrichment COMPLETE): the website role-entry completion event
 *   (eventKind=resume_parse_completed, context.websiteEntry=true + jobIdContext) is driven through
 *   the FULL production consumer seam — maybeRunThinClaire (cutover.ts) — with NO overrides:
 *   cutover routes the role continuation into the REAL runPreScreenForUser, which loads the REAL
 *   prescreen config, creates the REAL session, and sends Q1 via the REAL
 *   sendRuntimeApprovedIMessage → enqueueOutbound seam (durable pa-outbound rows on the in-memory
 *   Firestore stub — zero network: the paSendblueOutbox CF that POSTs Sendblue never runs here).
 *   Expected: Q1 directly, NO general pitch before Q1 (§2.6.4).
 *
 * LEG 2 (variant, enrichment IN FLIGHT):
 *   Turn A — the candidate's role trigger paste is driven through the REAL PrescreenTrigger.handle
 *   (sendblue/triggers/prescreen.ts — the seam one level below the file-locked router; deps wired
 *   exactly as webhook.ts:1098 wires them in production, runPreScreen → real runPreScreenForUser).
 *   pa-users carries enrichmentInFlight=true (fresh enrichmentStartedAt) → expected: ONE readiness
 *   hold bubble (PROFILE_READINESS_HOLD_COPY), pendingPrescreenStart=waiting_profile, NO session,
 *   NO Q1 (§2.6.3).
 *   Turn B — the enrichment COMPLETION runtime event through full maybeRunThinClaire → expected:
 *   resumePendingProfileReadinessPrescreenStart consumes the pending start FIRST (no double start
 *   even though the event also carries websiteEntry+jobIdContext), clears enrichmentInFlight, and
 *   Q1 goes out — still NO pitch.
 *
 * FIX ROUND 1 (2026-06-12) additions:
 *   - EVIDENCE-AWARE Q1 (§2.6.2/§2.6.5): both legs seed the parsed-resume evidence on pa-users.tags
 *     (the D8 single tag source the parse writes) and assert Q1 references it + asks for
 *     additions/corrections — never the zero-context verbatim template for a known candidate.
 *   - LEG 3 (§2.6.3 "explicit safe-fallback continue"): the hold copy advertises a candidate-visible
 *     exit; a candidate TEXT mid-hold (completion event LOST) starts the screen immediately via the
 *     real cutover safe-fallback block; the late/re-fired completion event then must NOT restart the
 *     live screen (no second Q1).
 *
 * Run (Node 24): cd apps/functions && node --import tsx ../../tests/scenarios/entry-ux/s4-role-entry-screen-first.mjs
 *
 * No commits, no deploys, no real messages, no prod Firestore — everything is in-process on the
 * in-memory stub below.
 */
import assert from "node:assert/strict"
import { maybeRunThinClaire } from "../../../apps/functions/src/claire-agent/cutover.js"
import { runPreScreenForUser } from "../../../apps/functions/src/prescreen-session-start.js"
import { PrescreenTrigger } from "../../../apps/functions/src/sendblue/triggers/prescreen.js"

const CANARY_UID = "8fEwIduUrzxZsblHHsNz" // dev cohort — in CANARY_UIDS (thin + entry-UX canary)
const PHONE = "+14243201960"
const JOB_ID = "hs-11005382-invoko-product-designer" // alnum+hyphen only (trigger regex char class)
const INBOUND = "pa-inbound-events"
const FLAGS = "pa-feature-flags"
const USERS = "pa-users"
const OUTBOUND = "pa-outbound"
const SESSIONS = "pa-prescreen-sessions"
const THIN_FLAG = "paThinClaireEnabled"

const PRESCREEN_CONFIG = {
  version: 1,
  jobTitle: "Product Designer",
  company: "Invoko",
  threshold: 0.65,
  confidenceThreshold: 0.7,
  maxClarifyRounds: 2,
  voiceMode: "professional_prescreen",
  questions: [
    {
      qId: "q_design_shipping",
      type: "MUST_HAVE",
      weight: 1,
      matchThreshold: 0.85,
      prompt: {
        en: "Walk me through a product you designed end-to-end recently — what was the problem, and what actually shipped?",
        zh: "Walk me through a product you designed end-to-end recently — what was the problem, and what actually shipped?",
      },
      clarifyPrompt: {
        en: "Pick the closest project where you owned the design from problem to ship.",
        zh: "Pick the closest project where you owned the design from problem to ship.",
      },
      keywords: [{ keyword: "shipped_design", weight: 1, hint: "end-to-end design shipping" }],
    },
    {
      qId: "q_systems_craft",
      type: "MUST_HAVE",
      weight: 1,
      matchThreshold: 0.85,
      prompt: {
        en: "How have you worked with a design system — built one, extended one, or fought one?",
        zh: "How have you worked with a design system — built one, extended one, or fought one?",
      },
      clarifyPrompt: { en: "Any concrete design-system example works.", zh: "Any concrete design-system example works." },
      keywords: [{ keyword: "design_system", weight: 1, hint: "design system work" }],
    },
  ],
}

// ── In-memory Firestore stub ──────────────────────────────────────────────────────────────────────
// doc get/set(merge: deep)/update/create(code-6)/delete + where/limit equality queries — everything
// the real cutover → runPreScreenForUser → enqueueOutbound chain touches. pa-outbound creates are
// additionally journaled IN ORDER (the verbatim transcript source).
function makeDb(seed) {
  const docs = new Map()
  for (const [path, data] of Object.entries(seed)) docs.set(path, structuredClone(data))
  /** ordered ledger of pa-outbound rows as they are created */
  const outboundLedger = []

  const isPlain = (v) => Boolean(v) && typeof v === "object" && !Array.isArray(v)
  const deepMerge = (prev, next) => {
    const out = { ...prev }
    for (const [k, v] of Object.entries(next)) {
      out[k] = isPlain(v) && isPlain(out[k]) ? deepMerge(out[k], v) : v
    }
    return out
  }

  function docRef(collection, id) {
    const path = `${collection}/${id}`
    return {
      id,
      async get() {
        const data = docs.get(path)
        return { exists: data !== undefined, data: () => (data === undefined ? undefined : data) }
      },
      async set(data, options) {
        const prev = docs.get(path)
        const next = options?.merge ? deepMerge(prev ?? {}, data) : structuredClone(data)
        docs.set(path, next)
      },
      async update(data) {
        const prev = docs.get(path)
        if (prev === undefined) {
          const err = new Error(`not-found:${path}`)
          err.code = 5
          throw err
        }
        docs.set(path, deepMerge(prev, data))
      },
      async create(data) {
        if (docs.get(path) !== undefined) {
          const err = new Error(`already-exists:${path}`)
          err.code = 6
          throw err
        }
        docs.set(path, structuredClone(data))
        if (collection === OUTBOUND) {
          outboundLedger.push({ at: new Date().toISOString(), id, ...structuredClone(data) })
        }
      },
      async delete() {
        docs.delete(path)
      },
    }
  }

  function makeQuery(collection) {
    const filters = []
    let max = Infinity
    const q = {
      where(field, _op, value) {
        filters.push({ field, value })
        return q
      },
      limit(n) {
        max = n
        return q
      },
      orderBy() {
        return q
      },
      async get() {
        const out = []
        for (const [path, data] of docs.entries()) {
          if (!path.startsWith(`${collection}/`)) continue
          if (!filters.every((f) => (data[f.field] ?? null) === f.value)) continue
          const id = path.slice(collection.length + 1)
          out.push({ id, data: () => data, ref: docRef(collection, id) })
          if (out.length >= max) break
        }
        return { empty: out.length === 0, docs: out, size: out.length }
      },
    }
    return q
  }

  const db = {
    collection(name) {
      const query = makeQuery(name)
      return {
        doc: (id) => docRef(name, id),
        where: (...a) => query.where(...a),
        limit: (...a) => query.limit(...a),
      }
    },
    // Minimal non-concurrent transaction adapter (markFirstInterviewStarted →
    // applyCandidateJobEvent uses db.runTransaction with tx.get/tx.set). The in-memory
    // store is single-threaded, so plain delegation preserves the semantics the sim needs.
    async runTransaction(fn) {
      const tx = {
        get: (ref) => ref.get(),
        set: (ref, data, opts) => {
          void ref.set(data, opts)
          return tx
        },
        update: (ref, data) => {
          void ref.update(data)
          return tx
        },
        delete: (ref) => {
          void ref.delete()
          return tx
        },
      }
      return await fn(tx)
    },
  }
  return { db, docs, outboundLedger }
}

// Parsed-resume evidence in the EXACT shape cv-ingest/Coresignal merge writes to pa-users.tags
// (the D8 single tag source) — what §2.6.2 says Claire must load + adapt the role probe with.
const EVIDENCE_TAGS = {
  targetRoleFunction: ["arts_and_design"],
  recentRoleTitle: "Senior Product Designer",
  recentCompany: "Figma",
  skills: ["design systems", "prototyping", "user research", "figma"],
}

const thinFlag = {
  key: THIN_FLAG,
  value: false,
  type: "bool",
  scope: "perUser",
  allowlist: [CANARY_UID],
  blocklist: [],
}

function websiteEntryEvent(context) {
  return {
    userId: CANARY_UID,
    sessionId: "ses_s4",
    body: "[system-event:website_entry:resume_parse_completed]\nAn external product event arrived.",
    fromNumber: PHONE,
    rawMeta: {
      source: "runtime_event_handoff",
      runtimeEvent: true,
      runtimeEventSource: "website_entry",
      runtimeEventKind: "resume_parse_completed",
      context,
    },
  }
}

function baseSeed(userDoc) {
  return {
    [`${FLAGS}/${THIN_FLAG}`]: thinFlag,
    [`${USERS}/${CANARY_UID}`]: userDoc,
    [`pa-jobs/${JOB_ID}`]: { title: "Product Designer", prescreenConfig: PRESCREEN_CONFIG },
  }
}

const transcript = []
function say(turn, who, text) {
  const at = new Date().toISOString()
  transcript.push({ at, turn, who, text })
  console.log(`[${at}] ${turn} ${who}> ${text}`)
}

function makeLog(events) {
  return (event, payload) => {
    events.push(event)
    console.log(`    · log ${event} ${payload ? JSON.stringify(payload) : ""}`)
  }
}

const failures = []
function check(name, fn) {
  try {
    fn()
    console.log(`  ✅ ${name}`)
  } catch (err) {
    failures.push(`${name}: ${err.message}`)
    console.log(`  ❌ ${name}: ${err.message}`)
  }
}

// ════════════════════════════════════════════════════════════════════════════════════════════════
// LEG 1 — role entry, enrichment COMPLETE → Q1 directly, NO general pitch
// ════════════════════════════════════════════════════════════════════════════════════════════════
console.log("\n━━ LEG 1: role entry (job page), enrichment COMPLETE ━━")
{
  const evtId = "evt_s4_role_entry_complete"
  const { db, docs, outboundLedger } = makeDb({
    ...baseSeed({
      // enrichment COMPLETE: marker explicitly false (the completion producer's end-state)
      enrichmentInFlight: false,
      displayName: "Adam",
      tags: EVIDENCE_TAGS,
    }),
    [`${INBOUND}/${evtId}`]: websiteEntryEvent({
      cvParsedTrigger: true,
      websiteEntry: true,
      enrichmentSource: "resume",
      authProvider: "google",
      resumeStatus: "parsed",
      linkedinState: "none",
      jobIdContext: JOB_ID,
      pitchAlreadySent: false,
      resumeId: "res_s4_leg1",
    }),
  })
  const events = []
  say("T1", "EVENT ", `website role-entry completion (resume parsed; jobIdContext=${JOB_ID}) → maybeRunThinClaire`)
  const handled = await maybeRunThinClaire(db, evtId, { log: makeLog(events) })
  for (const row of outboundLedger) say("T1", "CLAIRE", row.body)

  const inbound = docs.get(`${INBOUND}/${evtId}`)
  check("thin owns the role-entry completion", () => assert.equal(handled, true))
  check("handledBy = thin_claire_website_entry_prescreen", () =>
    assert.equal(inbound.handledBy, "thin_claire_website_entry_prescreen"))
  check("prescreen start ok=true reason=started", () => {
    assert.equal(inbound.websiteEntryPrescreen?.ok, true)
    assert.equal(inbound.websiteEntryPrescreen?.reason, "started")
  })
  check("exactly ONE outbound bubble (Q1, nothing else)", () => assert.equal(outboundLedger.length, 1))
  check("the bubble IS the role screen opener + Q1 (no readiness hold, no pitch prose)", () => {
    assert.match(outboundLedger[0].body, /Quick screen for Product Designer/)
    assert.match(outboundLedger[0].body, /Walk me through a product you designed end-to-end/)
  })
  check("§2.6.2/§2.6.5: Q1 is EVIDENCE-AWARE — references the parsed resume + asks for additions, not the zero-context template", () => {
    assert.match(outboundLedger[0].body, /I've already been through your resume\/profile/)
    assert.match(outboundLedger[0].body, /Senior Product Designer at Figma/)
    assert.match(outboundLedger[0].body, /design systems, prototyping, user research/)
    assert.match(outboundLedger[0].body, /fresh details, corrections, or additions/)
  })
  check("§2.6.4: NO general pitch before Q1 (no pitch_engine events)", () =>
    assert.equal(events.some((e) => e.startsWith("thin_claire.pitch_engine")), false))
  check("no enrichment-hold / readiness-hold fired", () => {
    assert.equal(events.includes("thin_claire.enrichment_hold.sent"), false)
    assert.equal(events.includes("prescreen.profile_readiness_hold"), false)
  })
  check("a REAL prescreen session was created (active work session, Q1 sent)", () => {
    const session = [...docs.entries()].find(([p]) => p.startsWith(`${SESSIONS}/`))
    assert.ok(session, "session doc exists")
    assert.equal(session[1].jobId, JOB_ID)
    assert.equal(session[1].userId, CANARY_UID)
    assert.equal(session[1].workSession?.status, "active")
  })
}

// ════════════════════════════════════════════════════════════════════════════════════════════════
// LEG 2 — variant: enrichment IN FLIGHT → ONE readiness hold, Q1 deferred until completion
// ════════════════════════════════════════════════════════════════════════════════════════════════
console.log("\n━━ LEG 2 (variant): role trigger while enrichment IN FLIGHT ━━")
{
  const startedAt = new Date(Date.now() - 10_000).toISOString()
  const { db, docs, outboundLedger } = makeDb(
    baseSeed({
      enrichmentInFlight: true,
      enrichmentStartedAt: startedAt,
      enrichmentSource: "resume",
      displayName: "Adam",
      // an earlier parse/LinkedIn merge already left evidence — the fresh parse is the one in flight
      tags: EVIDENCE_TAGS,
    }),
  )
  const eventsA = []
  const audits = []

  // Turn A — REAL PrescreenTrigger.handle, deps wired the way webhook.ts:1098 wires production
  // (runPreScreen → real runPreScreenForUser on the same db; idempotency docs on the stub).
  const trigger = new PrescreenTrigger({
    lookupUserByPhone: async (phone) => (phone === PHONE ? CANARY_UID : null),
    getLastFiredMs: async () => null,
    setLastFiredMs: async (jobId, userId, messageHandle, ms) => {
      await db
        .collection("pa-prescreen-trigger-idempotency")
        .doc(`${jobId}_${userId}_${messageHandle}`)
        .set({ lastFiredMs: ms, jobId, userId, messageHandle })
    },
    clearLastFiredMs: async () => {},
    runPreScreen: async ({ jobId, userId, toE164, sourceRequestedUserId, allowMatchedBypass }) =>
      runPreScreenForUser({
        db,
        jobId,
        userId,
        toE164,
        sourceRequestedUserId,
        allowMatchedBypass,
        log: makeLog(eventsA),
      }),
    audit: async (e) => {
      audits.push(e)
    },
    sendAccessIssueNotice: async ({ content }) => say("T2", "CLAIRE", `[access notice] ${content}`),
  })

  const triggerText = `WeKruit_${JOB_ID}_${CANARY_UID}_Job`
  say("T2", "USER  ", triggerText)
  const outcome = await trigger.handle({
    text: triggerText,
    fromNumber: PHONE,
    toNumber: "+17174919939",
    messageHandle: "mh_s4_trigger_1",
    receivedAtIso: new Date().toISOString(),
    log: makeLog(eventsA),
    hasMedia: false,
  })
  const afterTurnA = outboundLedger.length
  for (const row of outboundLedger) say("T2", "CLAIRE", row.body)

  check("trigger outcome = handled / prescreen_readiness_hold", () => {
    assert.equal(outcome.kind, "handled")
    assert.equal(outcome.action, "prescreen_readiness_hold")
  })
  check("exactly ONE readiness message, and it is the §2.6.3 hold copy", () => {
    assert.equal(afterTurnA, 1)
    assert.match(outboundLedger[0].body, /still reading through your resume\/experience/)
  })
  check("§2.6.3: the hold copy ADVERTISES the candidate-visible safe-fallback exit", () =>
    assert.match(outboundLedger[0].body, /if you'd rather not wait, just reply and i'll start the screen right away/))
  check("Q1 deferred — NO session created, NO question sent", () => {
    assert.equal([...docs.keys()].some((p) => p.startsWith(`${SESSIONS}/`)), false)
    assert.equal(outboundLedger.some((r) => /Quick screen for/.test(r.body)), false)
  })
  check("pendingPrescreenStart = waiting_profile for this job", () => {
    const user = docs.get(`${USERS}/${CANARY_UID}`)
    assert.equal(user.pendingPrescreenStart?.status, "waiting_profile")
    assert.equal(user.pendingPrescreenStart?.jobId, JOB_ID)
    assert.equal(user.pendingPrescreenStart?.reason, "enrichment_in_flight")
  })

  // Turn B — the enrichment COMPLETION runtime event, full cutover consumer.
  const evtB = "evt_s4_completion_resume"
  await db
    .collection(INBOUND)
    .doc(evtB)
    .set(
      websiteEntryEvent({
        cvParsedTrigger: true,
        websiteEntry: true,
        enrichmentSource: "resume",
        authProvider: "google",
        resumeStatus: "parsed",
        linkedinState: "none",
        jobIdContext: JOB_ID,
        pitchAlreadySent: false,
        resumeId: "res_s4_leg2",
      }),
    )
  const eventsB = []
  say("T3", "EVENT ", "enrichment completion (resume_parse_completed, same role context) → maybeRunThinClaire")
  const handledB = await maybeRunThinClaire(db, evtB, { log: makeLog(eventsB) })
  for (const row of outboundLedger.slice(afterTurnA)) say("T3", "CLAIRE", row.body)

  const inboundB = docs.get(`${INBOUND}/${evtB}`)
  const userAfter = docs.get(`${USERS}/${CANARY_UID}`)
  check("completion event handled by thin", () => assert.equal(handledB, true))
  check("pending start resumed FIRST (handledBy=thin_claire_pending_prescreen_start — no double start)", () => {
    assert.equal(inboundB.handledBy, "thin_claire_pending_prescreen_start")
    assert.equal(inboundB.pendingPrescreenStart?.ok, true)
    assert.equal(inboundB.pendingPrescreenStart?.reason, "started")
  })
  check("enrichmentInFlight cleared by the completion event", () =>
    assert.equal(userAfter.enrichmentInFlight, false))
  check("pendingPrescreenStart resolved to started", () =>
    assert.equal(userAfter.pendingPrescreenStart?.status, "started"))
  check("exactly ONE new bubble on completion = the role screen opener + Q1", () => {
    const turnB = outboundLedger.slice(afterTurnA)
    assert.equal(turnB.length, 1)
    assert.match(turnB[0].body, /Quick screen for Product Designer/)
    assert.match(turnB[0].body, /Walk me through a product you designed end-to-end/)
  })
  check("§2.6.2: the deferred Q1 KEEPS the hold's 'right context' promise — evidence-aware, additions framing", () => {
    const turnB = outboundLedger.slice(afterTurnA)
    assert.match(turnB[0].body, /I've already been through your resume\/profile/)
    assert.match(turnB[0].body, /Senior Product Designer at Figma/)
    assert.match(turnB[0].body, /fresh details, corrections, or additions/)
  })
  check("still NO general pitch anywhere in the variant (no pitch_engine events)", () =>
    assert.equal([...eventsA, ...eventsB].some((e) => e.startsWith("thin_claire.pitch_engine")), false))
  check("hold sent exactly once across both turns", () =>
    assert.equal(outboundLedger.filter((r) => /still reading through/.test(r.body)).length, 1))
  check("a REAL session exists now (created on completion, not before)", () => {
    const session = [...docs.entries()].find(([p]) => p.startsWith(`${SESSIONS}/`))
    assert.ok(session)
    assert.equal(session[1].jobId, JOB_ID)
    assert.equal(session[1].workSession?.status, "active")
  })
}

// ════════════════════════════════════════════════════════════════════════════════════════════════
// LEG 3 — §2.6.3 explicit safe-fallback continue: completion event LOST, candidate replies mid-hold
// → screen starts NOW; the late/re-fired completion event must NOT restart it (no second Q1).
// ════════════════════════════════════════════════════════════════════════════════════════════════
console.log("\n━━ LEG 3: safe-fallback continue (completion event lost, candidate replies mid-hold) ━━")
{
  const startedAt = new Date(Date.now() - 10_000).toISOString()
  const { db, docs, outboundLedger } = makeDb(
    baseSeed({
      enrichmentInFlight: true,
      enrichmentStartedAt: startedAt,
      enrichmentSource: "resume",
      displayName: "Adam",
      tags: EVIDENCE_TAGS,
    }),
  )
  const events3 = []

  // Turn A — same REAL trigger paste as LEG 2 → readiness hold.
  const trigger = new PrescreenTrigger({
    lookupUserByPhone: async (phone) => (phone === PHONE ? CANARY_UID : null),
    getLastFiredMs: async () => null,
    setLastFiredMs: async (jobId, userId, messageHandle, ms) => {
      await db
        .collection("pa-prescreen-trigger-idempotency")
        .doc(`${jobId}_${userId}_${messageHandle}`)
        .set({ lastFiredMs: ms, jobId, userId, messageHandle })
    },
    clearLastFiredMs: async () => {},
    runPreScreen: async ({ jobId, userId, toE164, sourceRequestedUserId, allowMatchedBypass }) =>
      runPreScreenForUser({
        db,
        jobId,
        userId,
        toE164,
        sourceRequestedUserId,
        allowMatchedBypass,
        log: makeLog(events3),
      }),
    audit: async () => {},
    sendAccessIssueNotice: async ({ content }) => say("T4", "CLAIRE", `[access notice] ${content}`),
  })
  say("T4", "USER  ", `WeKruit_${JOB_ID}_${CANARY_UID}_Job`)
  const holdOutcome = await trigger.handle({
    text: `WeKruit_${JOB_ID}_${CANARY_UID}_Job`,
    fromNumber: PHONE,
    toNumber: "+17174919939",
    messageHandle: "mh_s4_trigger_leg3",
    receivedAtIso: new Date().toISOString(),
    log: makeLog(events3),
    hasMedia: false,
  })
  const afterHold = outboundLedger.length
  for (const row of outboundLedger) say("T4", "CLAIRE", row.body)
  check("LEG3 Turn A: readiness hold fired (same §2.6.3 shape as LEG 2)", () => {
    assert.equal(holdOutcome.kind, "handled")
    assert.equal(holdOutcome.action, "prescreen_readiness_hold")
    assert.equal(afterHold, 1)
  })

  // Turn B — the completion event NEVER ARRIVES. The candidate takes the hold copy's advertised
  // exit and just replies. Full production consumer: maybeRunThinClaire on a plain text inbound.
  const evtReply = "evt_s4_safe_fallback_reply"
  await db.collection(INBOUND).doc(evtReply).set({
    userId: CANARY_UID,
    sessionId: "ses_s4",
    body: "ok just start",
    fromNumber: PHONE,
    rawMeta: { source: "sendblue_webhook", messageHandle: "mh_s4_reply_leg3" },
  })
  const eventsReply = []
  say("T5", "USER  ", "ok just start")
  const handledReply = await maybeRunThinClaire(db, evtReply, { log: makeLog(eventsReply) })
  const afterReply = outboundLedger.length
  for (const row of outboundLedger.slice(afterHold)) say("T5", "CLAIRE", row.body)

  const inboundReply = docs.get(`${INBOUND}/${evtReply}`)
  check("LEG3 Turn B: thin owns the mid-hold reply via the SAFE-FALLBACK seam", () => {
    assert.equal(handledReply, true)
    assert.equal(inboundReply.handledBy, "thin_claire_prescreen_safe_fallback_start")
    assert.equal(inboundReply.pendingPrescreenStart?.ok, true)
    assert.equal(inboundReply.pendingPrescreenStart?.reason, "started")
  })
  check("LEG3 Turn B: exactly ONE new bubble = Q1 NOW (no second hold, no pitch, no silence)", () => {
    const turn = outboundLedger.slice(afterHold)
    assert.equal(turn.length, 1)
    assert.match(turn[0].body, /Quick screen for Product Designer/)
    assert.match(turn[0].body, /Walk me through a product you designed end-to-end/)
    assert.equal(outboundLedger.filter((r) => /still reading through/.test(r.body)).length, 1)
  })
  check("LEG3 Turn B: pending start durably resolved + a REAL active session exists", () => {
    const user = docs.get(`${USERS}/${CANARY_UID}`)
    assert.equal(user.pendingPrescreenStart?.status, "started")
    const session = [...docs.entries()].find(([p]) => p.startsWith(`${SESSIONS}/`))
    assert.ok(session)
    assert.equal(session[1].workSession?.status, "active")
  })

  // Turn C — the completion event finally lands (late / re-fired). It must NOT restart the live
  // screen: resume-don't-restart (no supersede, no second Q1).
  const evtLate = "evt_s4_late_completion"
  await db.collection(INBOUND).doc(evtLate).set(
    websiteEntryEvent({
      cvParsedTrigger: true,
      websiteEntry: true,
      enrichmentSource: "resume",
      jobIdContext: JOB_ID,
      pitchAlreadySent: false,
      resumeId: "res_s4_leg3",
    }),
  )
  const eventsLate = []
  say("T6", "EVENT ", "LATE enrichment completion (same role context) → maybeRunThinClaire")
  const handledLate = await maybeRunThinClaire(db, evtLate, { log: makeLog(eventsLate) })
  for (const row of outboundLedger.slice(afterReply)) say("T6", "CLAIRE", row.body)

  const inboundLate = docs.get(`${INBOUND}/${evtLate}`)
  check("LEG3 Turn C: late completion handled WITHOUT restarting — already_active, zero new bubbles", () => {
    assert.equal(handledLate, true)
    assert.equal(inboundLate.handledBy, "thin_claire_website_entry_prescreen")
    assert.equal(inboundLate.websiteEntryPrescreen?.reason, "already_active")
    assert.equal(outboundLedger.length, afterReply, "no second Q1 / no duplicate opener")
  })
  check("LEG3 Turn C: the live session is untouched (one session total, still active, not superseded)", () => {
    const sessions = [...docs.entries()].filter(([p]) => p.startsWith(`${SESSIONS}/`))
    assert.equal(sessions.length, 1)
    assert.equal(sessions[0][1].terminal, null)
    assert.equal(sessions[0][1].workSession?.status, "active")
  })
}

// ── Verdict ──────────────────────────────────────────────────────────────────────────────────────
console.log("\n━━ TRANSCRIPT (verbatim outbound bubbles, in order) ━━")
for (const t of transcript) console.log(`[${t.at}] ${t.turn} ${t.who}> ${t.text}`)

if (failures.length > 0) {
  console.log(`\n❌ S4 FAILED — ${failures.length} assertion(s):`)
  for (const f of failures) console.log(`   - ${f}`)
  process.exit(1)
}
console.log("\n✅ S4-role-entry-screen-first: ALL CHECKS PASSED")
