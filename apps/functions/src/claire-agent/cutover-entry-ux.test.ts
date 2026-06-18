/**
 * cutover-entry-ux.test.ts — ENTRY-UX PRD slices at the cutover seam (Builder B, 2026-06-12).
 *
 * Producer contract (website-entry/website-entry-event.ts): website entry emits the SAME
 * eventKind "resume_parse_completed" the cv-parsed re-entry already consumes, with
 * context.websiteEntry=true (+ jobIdContext for a job-page/market entry). These tests prove the
 * CONSUMER side:
 *
 *  1. websiteEntry + jobIdContext → the EXISTING prescreen start path runs (screen first, §2.6.4 —
 *     Q1 direct, NO general pitch), allowMatchedBypass like the string-token rule.
 *  2. websiteEntry WITHOUT job context → the existing pitch-engine turn (here: deterministic
 *     fallback ack, since the stub has no composable profile) — same §2.1 posture as SMS entry.
 *  3. Deterministic mid-enrich hold: a real "hi" while enrichmentInFlight → ONE sendStatus hold,
 *     event completed as thin_claire_enrichment_hold, once-only stamp written.
 *
 * Stub Firestore: doc get/set per collection; unknown docs read as absent; NO .where support —
 * selectClaireMode's prescreen probe and compose-pitch's resume query fail-safe, exactly like the
 * other cutover tests.
 *
 * Run: node --import tsx --test apps/functions/src/claire-agent/cutover-entry-ux.test.ts
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { maybeRunThinClaire } from "./cutover.js"

const INBOUND = "pa-inbound-events"
const FLAGS = "pa-feature-flags"
const USERS = "pa-users"
const MESSAGES = "pa-messages"
const OUTBOUND = "pa-outbound"
const VOICE_OFFERS = "pa-voice-call-offers"
const OUTBOUND_BOOKINGS = "outbound-bookings"
const THIN_FLAG = "paThinClaireEnabled"
const CANARY_UID = "8fEwIduUrzxZsblHHsNz" // Adam dev phone — in CANARY_UIDS (entry-UX cohort)

type DocData = Record<string, unknown>

function makeDb(seed: Record<string, Record<string, DocData>>) {
  const store: Record<string, Record<string, DocData>> = JSON.parse(JSON.stringify(seed))
  return {
    store,
    db: {
      collection(name: string) {
        return {
          doc(id: string) {
            return {
              async get() {
                const data = store[name]?.[id]
                return { exists: data !== undefined, data: () => data }
              },
              async set(patch: DocData) {
                store[name] = store[name] ?? {}
                store[name][id] = { ...(store[name][id] ?? {}), ...patch }
              },
            }
          },
        }
      },
    } as never,
  }
}

function thinFlagFor(uid: string): DocData {
  return { key: THIN_FLAG, value: false, type: "bool", scope: "perUser", allowlist: [uid], blocklist: [] }
}

function websiteEntryEvent(eventId: string, context: DocData): DocData {
  return {
    userId: CANARY_UID,
    sessionId: "ses_web",
    body: "[system-event:website_entry:resume_parse_completed]\nAn external product event arrived.",
    fromNumber: "+14243201960",
    rawMeta: {
      source: "runtime_event_handoff",
      runtimeEvent: true,
      runtimeEventSource: "website_entry",
      runtimeEventKind: "resume_parse_completed",
      context,
    },
  }
}

function spyLog() {
  const events: string[] = []
  return { events, log: (e: string) => events.push(e) }
}

test("websiteEntry + jobIdContext → EXISTING prescreen start (screen first, §2.6.4), NO general pitch", async () => {
  const eventId = "evt_web_role_entry"
  const { db, store } = makeDb({
    [INBOUND]: {
      [eventId]: websiteEntryEvent(eventId, {
        cvParsedTrigger: true,
        websiteEntry: true,
        enrichmentSource: "resume",
        jobIdContext: "job-role-9",
        pitchAlreadySent: false,
      }),
    },
    [FLAGS]: { [THIN_FLAG]: thinFlagFor(CANARY_UID) },
    [USERS]: { [CANARY_UID]: {} },
  })
  const { events, log } = spyLog()
  const starts: Array<Record<string, unknown>> = []

  const handled = await maybeRunThinClaire(db, eventId, {
    log,
    dryRun: true,
    runPreScreenOverride: async (a) => {
      starts.push(a as never)
      return { ok: true, reason: "started", sessionId: "ps_web", firstQuestionSent: true }
    },
  })

  assert.equal(handled, true, "thin owns the website role-context completion")
  assert.equal(events.includes("thin_claire.defer_runtime_event"), false)
  assert.equal(starts.length, 1, "the EXISTING start path runs exactly once")
  assert.equal((starts[0] as { jobId?: string }).jobId, "job-role-9")
  assert.equal((starts[0] as { userId?: string }).userId, CANARY_UID)
  assert.equal(
    (starts[0] as { allowMatchedBypass?: boolean }).allowMatchedBypass,
    true,
    "job-page entry is self-authorizing — mirrors the string-token matched-gate bypass",
  )
  assert.equal(
    events.includes("thin_claire.pitch_engine.sent") || events.includes("thin_claire.pitch_engine.fallback_sent"),
    false,
    "§2.6.4: no general candidate pitch before Q1 on a role entry",
  )
  const inbound = store[INBOUND]![eventId]!
  assert.equal(inbound.status, "completed")
  assert.equal(inbound.handledBy, "thin_claire_website_entry_prescreen")
})

test("websiteEntry + jobIdContext + readiness_hold result is recorded as handled (hold owned by the start path)", async () => {
  const eventId = "evt_web_role_hold"
  const { db, store } = makeDb({
    [INBOUND]: {
      [eventId]: websiteEntryEvent(eventId, {
        websiteEntry: true,
        enrichmentSource: "linkedin",
        jobIdContext: "job-role-9",
      }),
    },
    [FLAGS]: { [THIN_FLAG]: thinFlagFor(CANARY_UID) },
    [USERS]: { [CANARY_UID]: {} },
  })
  const { log } = spyLog()

  const handled = await maybeRunThinClaire(db, eventId, {
    log,
    dryRun: true,
    runPreScreenOverride: async () => ({
      ok: false,
      reason: "readiness_hold",
      sessionId: "ps_hold",
      firstQuestionSent: false,
    }),
  })

  assert.equal(handled, true)
  const inbound = store[INBOUND]![eventId]! as { websiteEntryPrescreen?: { reason?: string } }
  assert.equal(inbound.websiteEntryPrescreen?.reason, "readiness_hold")
})

test("websiteEntry WITHOUT job context → the existing pitch-engine turn (general entry, §2.1 posture)", async () => {
  const eventId = "evt_web_general_entry"
  const { db, store } = makeDb({
    [INBOUND]: {
      [eventId]: websiteEntryEvent(eventId, {
        cvParsedTrigger: true,
        websiteEntry: true,
        enrichmentSource: "resume",
        jobIdContext: null,
        pitchAlreadySent: false,
      }),
    },
    [FLAGS]: { [THIN_FLAG]: thinFlagFor(CANARY_UID) },
    // Empty profile → composePitchTurn misses → the DETERMINISTIC honest fallback ack sends
    // (never the agent, never auto-match) — proving the turn rides the existing pitch seam.
    [USERS]: { [CANARY_UID]: {} },
  })
  const { events, log } = spyLog()
  const starts: Array<Record<string, unknown>> = []

  const handled = await maybeRunThinClaire(db, eventId, {
    log,
    dryRun: true,
    runPreScreenOverride: async (a) => {
      starts.push(a as never)
      return { ok: true, reason: "started", sessionId: "ps_x", firstQuestionSent: true }
    },
  })

  assert.equal(handled, true)
  assert.equal(starts.length, 0, "no role context → no prescreen start")
  assert.ok(
    events.includes("thin_claire.pitch_engine.sent") || events.includes("thin_claire.pitch_engine.fallback_sent"),
    `general website entry must ride the pitch engine; got ${JSON.stringify(events)}`,
  )
  const inbound = store[INBOUND]![eventId]!
  assert.match(String(inbound.handledBy), /^thin_claire_pitch_engine/)
})

test("mid-enrich 'hi' → ONE deterministic hold (sendStatus), event completed, once-only stamp written", async () => {
  const eventId = "evt_hold_hi"
  const startedAt = new Date(Date.now() - 5_000).toISOString()
  const { db, store } = makeDb({
    [INBOUND]: {
      [eventId]: {
        userId: CANARY_UID,
        sessionId: "ses_hold",
        body: "hi",
        fromNumber: "+14243201960",
        rawMeta: { source: "sendblue_webhook" },
      },
    },
    [FLAGS]: { [THIN_FLAG]: thinFlagFor(CANARY_UID) },
    [USERS]: {
      [CANARY_UID]: { enrichmentInFlight: true, enrichmentStartedAt: startedAt },
    },
  })
  const { events, log } = spyLog()

  const handled = await maybeRunThinClaire(db, eventId, { log, dryRun: true })

  assert.equal(handled, true, "the hold turn is owned by thin")
  assert.ok(
    events.includes("thin_claire.enrichment_hold.sent"),
    `expected hold-sent log; got ${JSON.stringify(events)}`,
  )
  const inbound = store[INBOUND]![eventId]!
  assert.equal(inbound.status, "completed")
  assert.equal(inbound.handledBy, "thin_claire_enrichment_hold")
  const user = store[USERS]![CANARY_UID]!
  assert.equal(typeof user.enrichmentHoldNoticeAt, "string", "once-only stamp written for this window")
  assert.ok(
    Date.parse(String(user.enrichmentHoldNoticeAt)) >= Date.parse(startedAt),
    "stamp covers the CURRENT enrichment window",
  )
})

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// ENTRY-UX FIX ROUND 1 — §2.6.3 candidate-visible safe-fallback continue + resume-don't-restart.
// These paths need equality `.where` queries + `create`/`delete` (start lock, supersede, active-
// session guard), so they use a RICHER stub than makeDb above (which deliberately omits .where).
// ─────────────────────────────────────────────────────────────────────────────────────────────────

const SF_PRESCREEN_CONFIG = {
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
      prompt: { en: "Walk me through a product you designed end-to-end recently.", zh: "Walk me through a product you designed end-to-end recently." },
      clarifyPrompt: { en: "Pick the closest project.", zh: "Pick the closest project." },
      keywords: [{ keyword: "shipped_design", weight: 1, hint: "end-to-end design shipping" }],
    },
  ],
}

function makeQueryableDb(seed: Record<string, DocData>) {
  const docs = new Map<string, DocData>()
  for (const [path, data] of Object.entries(seed)) docs.set(path, JSON.parse(JSON.stringify(data)))

  const isPlain = (v: unknown): v is DocData => Boolean(v) && typeof v === "object" && !Array.isArray(v)
  const deepMerge = (prev: DocData, next: DocData): DocData => {
    const out: DocData = { ...prev }
    for (const [k, v] of Object.entries(next)) {
      out[k] = isPlain(v) && isPlain(out[k]) ? deepMerge(out[k] as DocData, v) : v
    }
    return out
  }

  function docRef(collection: string, id: string) {
    const path = `${collection}/${id}`
    return {
      id,
      async get() {
        const data = docs.get(path)
        return { exists: data !== undefined, data: () => data }
      },
      async set(data: DocData, options?: { merge?: boolean }) {
        const prev = docs.get(path)
        docs.set(path, options?.merge ? deepMerge(prev ?? {}, data) : JSON.parse(JSON.stringify(data)))
      },
      async update(data: DocData) {
        const prev = docs.get(path)
        if (prev === undefined) {
          const err = new Error(`not-found:${path}`) as Error & { code?: number }
          err.code = 5
          throw err
        }
        docs.set(path, deepMerge(prev, data))
      },
      async create(data: DocData) {
        if (docs.get(path) !== undefined) {
          const err = new Error(`already-exists:${path}`) as Error & { code?: number }
          err.code = 6
          throw err
        }
        docs.set(path, JSON.parse(JSON.stringify(data)))
      },
      async delete() {
        docs.delete(path)
      },
    }
  }

  function makeQuery(collection: string) {
    const filters: Array<{ field: string; value: unknown }> = []
    let max = Infinity
    const q = {
      where(field: string, _op: string, value: unknown) {
        filters.push({ field, value })
        return q
      },
      limit(n: number) {
        max = n
        return q
      },
      async get() {
        const out: Array<{ id: string; data: () => DocData; ref: ReturnType<typeof docRef> }> = []
        for (const [path, data] of docs.entries()) {
          if (!path.startsWith(`${collection}/`)) continue
          if (!filters.every((f) => ((data as DocData)[f.field] ?? null) === f.value)) continue
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
    collection(name: string) {
      const query = makeQuery(name)
      return {
        doc: (id: string) => docRef(name, id),
        where: (...a: [string, string, unknown]) => query.where(...a),
        limit: (n: number) => query.limit(n),
      }
    },
    async runTransaction(fn: (tx: unknown) => Promise<unknown>) {
      const tx = {
        get: (ref: { get: () => Promise<unknown> }) => ref.get(),
        set: (ref: { set: (d: DocData, o?: { merge?: boolean }) => Promise<void> }, data: DocData, opts?: { merge?: boolean }) => {
          void ref.set(data, opts)
          return tx
        },
        update: (ref: { update: (d: DocData) => Promise<void> }, data: DocData) => {
          void ref.update(data)
          return tx
        },
      }
      return await fn(tx)
    },
  }
  return { db: db as never, docs }
}

test("§2.6.3 SAFE-FALLBACK CONTINUE: candidate text while pendingPrescreenStart=waiting_profile → screen starts NOW (no strand)", async () => {
  const eventId = "evt_safe_fallback_reply"
  const now = new Date().toISOString()
  const { db, docs } = makeQueryableDb({
    [`${FLAGS}/${THIN_FLAG}`]: thinFlagFor(CANARY_UID),
    [`${USERS}/${CANARY_UID}`]: {
      enrichmentInFlight: true, // completion event lost — marker still up
      enrichmentStartedAt: now,
      pendingPrescreenStart: {
        status: "waiting_profile",
        reason: "enrichment_in_flight",
        userId: CANARY_UID,
        jobId: "job-sf",
        toE164: "+14243201960",
        sourceRequestedUserId: null,
        allowMatchedBypass: true,
        createdAt: now,
        updatedAt: now,
      },
    },
    "pa-jobs/job-sf": { title: "Product Designer", prescreenConfig: SF_PRESCREEN_CONFIG },
    [`${INBOUND}/${eventId}`]: {
      userId: CANARY_UID,
      sessionId: "ses_sf",
      body: "ok let's just start",
      fromNumber: "+14243201960",
      rawMeta: { source: "sendblue_webhook" },
    },
  })
  const { events, log } = spyLog()

  const handled = await maybeRunThinClaire(db, eventId, { log, dryRun: true })

  assert.equal(handled, true, "thin owns the safe-fallback turn")
  const inbound = docs.get(`${INBOUND}/${eventId}`)! as {
    handledBy?: string
    pendingPrescreenStart?: { ok?: boolean; reason?: string; jobId?: string }
  }
  assert.equal(inbound.handledBy, "thin_claire_prescreen_safe_fallback_start")
  assert.equal(inbound.pendingPrescreenStart?.ok, true)
  assert.equal(inbound.pendingPrescreenStart?.reason, "started")
  assert.equal(inbound.pendingPrescreenStart?.jobId, "job-sf")
  assert.ok(events.includes("thin_claire.prescreen_safe_fallback_start"))
  const user = docs.get(`${USERS}/${CANARY_UID}`)! as { pendingPrescreenStart?: { status?: string } }
  assert.equal(user.pendingPrescreenStart?.status, "started", "pending start durably resolved")
  const session = [...docs.keys()].find((p) => p.startsWith("pa-prescreen-sessions/") && !p.includes("-lock"))
  assert.ok(session, "a REAL prescreen session exists after the fallback continue")
  assert.equal(
    events.includes("thin_claire.enrichment_hold.sent"),
    false,
    "the reply starts the screen — it must NOT burn another hold bubble",
  )
})

test("RESUME-DON'T-RESTART: role-entry completion while a screen for the SAME job is already ACTIVE → no second start / no second Q1", async () => {
  const eventId = "evt_completion_after_fallback"
  const { db, docs } = makeQueryableDb({
    [`${FLAGS}/${THIN_FLAG}`]: thinFlagFor(CANARY_UID),
    [`${USERS}/${CANARY_UID}`]: {
      // pending already resolved by the safe-fallback continue
      pendingPrescreenStart: { status: "started", jobId: "job-sf", sessionId: "ps_live" },
    },
    "pa-jobs/job-sf": { title: "Product Designer", prescreenConfig: SF_PRESCREEN_CONFIG },
    "pa-prescreen-sessions/ps_live": {
      sessionId: "ps_live",
      userId: CANARY_UID,
      jobId: "job-sf",
      terminal: null,
      currentQId: "q_design_shipping",
      workSession: { kind: "job_prescreen", status: "active" },
    },
    [`${INBOUND}/${eventId}`]: websiteEntryEvent(eventId, {
      cvParsedTrigger: true,
      websiteEntry: true,
      enrichmentSource: "resume",
      jobIdContext: "job-sf",
      pitchAlreadySent: false,
    }),
  })
  const { events, log } = spyLog()
  const starts: Array<Record<string, unknown>> = []

  const handled = await maybeRunThinClaire(db, eventId, {
    log,
    dryRun: true,
    runPreScreenOverride: async (a) => {
      starts.push(a as never)
      return { ok: true, reason: "started", sessionId: "ps_dup", firstQuestionSent: true }
    },
  })

  assert.equal(handled, true)
  assert.equal(starts.length, 0, "the live session must NOT be superseded by a re-fired completion")
  const inbound = docs.get(`${INBOUND}/${eventId}`)! as {
    handledBy?: string
    websiteEntryPrescreen?: { reason?: string; sessionId?: string }
  }
  assert.equal(inbound.handledBy, "thin_claire_website_entry_prescreen")
  assert.equal(inbound.websiteEntryPrescreen?.reason, "already_active")
  assert.equal(inbound.websiteEntryPrescreen?.sessionId, "ps_live")
  assert.ok(events.includes("thin_claire.website_entry.prescreen_already_active"))
  // and the original active session is untouched
  const live = docs.get("pa-prescreen-sessions/ps_live")! as { terminal?: unknown }
  assert.equal(live.terminal, null)
})

test("phone-prescreen bare 'sure' after role choice sends clarification, not matching", async () => {
  const eventId = "evt_voice_ack_sure"
  const sessionId = "ses_voice_ack"
  const assistantBody =
    "got you - that's the Martini Agent Engineer screen. looks like that one's already completed, so we can't restart it, but i can help you pick another matched engineering role to run next. which one do you want: Sekai AI Agent Engineer (Coding Agent), Maximor Staff SWE, or Sekai Technical Lead?"
  const { db, docs } = makeQueryableDb({
    [`${FLAGS}/${THIN_FLAG}`]: thinFlagFor(CANARY_UID),
    [`${USERS}/${CANARY_UID}`]: { phoneE164: "+14243201960" },
    [`${MESSAGES}/m_voice_ack_prev`]: {
      sessionId,
      userId: CANARY_UID,
      role: "assistant",
      body: assistantBody,
      createdAt: "2026-06-18T20:03:00.000Z",
      rawMeta: { source: "pa-outbound" },
    },
    [`${INBOUND}/${eventId}`]: {
      userId: CANARY_UID,
      sessionId,
      body: "Sure",
      fromNumber: "+14243201960",
      rawMeta: { source: "sendblue_webhook" },
    },
  })
  const { events, log } = spyLog()

  const handled = await maybeRunThinClaire(db, eventId, { log })

  assert.equal(handled, true)
  const inbound = docs.get(`${INBOUND}/${eventId}`)! as { status?: string; handledBy?: string }
  assert.equal(inbound.status, "completed")
  assert.equal(inbound.handledBy, "thin_claire_voice_ack_clarifier")
  assert.ok(events.includes("thin_claire.voice_ack_clarifier.sent"))

  const outboundRows = [...docs.entries()].filter(([path]) => path.startsWith(`${OUTBOUND}/`))
  assert.equal(outboundRows.length, 1, "clarifier is the only outbound row; find_match did not run")
  assert.match(String(outboundRows[0]![1].body ?? ""), /not as a request for new jobs/)
  assert.match(String(outboundRows[0]![1].body ?? ""), /Sekai AI Agent Engineer/)
})

test("explicit phone prescreen request resolves the named role and sends ONLY the call offer", async () => {
  const eventId = "evt_voice_prescreen_named_role"
  const sessionId = "ses_voice_named_role"
  const { db, docs } = makeQueryableDb({
    [`${FLAGS}/${THIN_FLAG}`]: thinFlagFor(CANARY_UID),
    [`${USERS}/${CANARY_UID}`]: {
      phoneE164: "+14243201960",
      lastCollabRoles: [
        { jobId: "job-sekai-agent", company: "Sekai", title: "AI Agent Engineer (Coding Agent)" },
        { jobId: "job-sekai-lead", company: "Sekai", title: "Technical Lead" },
      ],
    },
    [`${INBOUND}/${eventId}`]: {
      userId: CANARY_UID,
      sessionId,
      body: "I want to prescreen Sekai AI Agent Engineer on phone call",
      fromNumber: "+14243201960",
      rawMeta: { source: "sendblue_webhook" },
    },
  })
  const { events, log } = spyLog()

  const handled = await maybeRunThinClaire(db, eventId, { log })

  assert.equal(handled, true)
  assert.ok(events.includes("thin_claire.voice_prescreen.offer_sent"))
  const inbound = docs.get(`${INBOUND}/${eventId}`)! as {
    handledBy?: string
    voicePrescreenRequest?: { jobId?: string; offerOk?: boolean }
  }
  assert.equal(inbound.handledBy, "thin_claire_voice_prescreen_offer")
  assert.equal(inbound.voicePrescreenRequest?.jobId, "job-sekai-agent")
  assert.equal(inbound.voicePrescreenRequest?.offerOk, true)

  const outboundRows = [...docs.entries()].filter(([path]) => path.startsWith(`${OUTBOUND}/`))
  assert.equal(outboundRows.length, 1, "only the confirmation ask is sent")
  const body = String(outboundRows[0]![1].body ?? "")
  assert.match(body, /Want to do the prescreen as a quick call now/)
  assert.match(body, /ending in 1960/)
  assert.doesNotMatch(body, /starting|pull roles|jobId|matched set/i)

  const offers = [...docs.entries()].filter(([path]) => path.startsWith(`${VOICE_OFFERS}/`))
  assert.equal(offers.length, 1, "one pending offer is created")
  const offer = offers[0]![1] as { status?: string; purpose?: string; paJobId?: string; matchedRoleValidatedAt?: string }
  assert.equal(offer.status, "pending")
  assert.equal(offer.purpose, "prescreen")
  assert.equal(offer.paJobId, "job-sekai-agent")
  assert.equal(typeof offer.matchedRoleValidatedAt, "string")

  const bookings = [...docs.entries()].filter(([path]) => path.startsWith(`${OUTBOUND_BOOKINGS}/`))
  assert.equal(bookings.length, 0, "no call is dialed until a later explicit yes")
})

test("ambiguous explicit phone prescreen request asks which role and creates no call offer", async () => {
  const eventId = "evt_voice_prescreen_ambiguous"
  const sessionId = "ses_voice_ambiguous"
  const { db, docs } = makeQueryableDb({
    [`${FLAGS}/${THIN_FLAG}`]: thinFlagFor(CANARY_UID),
    [`${USERS}/${CANARY_UID}`]: {
      phoneE164: "+14243201960",
      lastCollabRoles: [
        { jobId: "job-sekai-agent", company: "Sekai", title: "AI Agent Engineer (Coding Agent)" },
        { jobId: "job-sekai-lead", company: "Sekai", title: "Technical Lead" },
      ],
    },
    [`${INBOUND}/${eventId}`]: {
      userId: CANARY_UID,
      sessionId,
      body: "I want to do a phone prescreen with Sekai",
      fromNumber: "+14243201960",
      rawMeta: { source: "sendblue_webhook" },
    },
  })
  const { events, log } = spyLog()

  const handled = await maybeRunThinClaire(db, eventId, { log })

  assert.equal(handled, true)
  assert.ok(events.includes("thin_claire.voice_prescreen.role_clarifier_sent"))
  const inbound = docs.get(`${INBOUND}/${eventId}`)! as { handledBy?: string }
  assert.equal(inbound.handledBy, "thin_claire_voice_prescreen_role_clarifier")

  const outboundRows = [...docs.entries()].filter(([path]) => path.startsWith(`${OUTBOUND}/`))
  assert.equal(outboundRows.length, 1)
  const body = String(outboundRows[0]![1].body ?? "")
  assert.match(body, /Which role should I call you about/)
  assert.match(body, /AI Agent Engineer \(Coding Agent\) @ Sekai/)
  assert.match(body, /Technical Lead @ Sekai/)
  assert.doesNotMatch(body, /pull roles|jobId|matched set/i)

  const offers = [...docs.entries()].filter(([path]) => path.startsWith(`${VOICE_OFFERS}/`))
  assert.equal(offers.length, 0)
  const bookings = [...docs.entries()].filter(([path]) => path.startsWith(`${OUTBOUND_BOOKINGS}/`))
  assert.equal(bookings.length, 0)
})
