/**
 * merge-resume-confirm.test.ts — MERGE-not-overwrite for a NEW/additional résumé (Adam-LOCKED 2026-06-05).
 *
 * Drives the PRODUCTION seam (maybeRunThinClaire / cutover) against an in-memory Firestore stub, with the
 * LLM classifier + ingestCv injected via deps (the "eval must drive the real seam" rule — no stand-in
 * merge). Asserts:
 *   - an ADDITIONAL résumé (prior parsed-résumé row exists) → MERGE-framed confirm, NOT overwrite, NO
 *     immediate ingest, pending staged awaiting_confirm.
 *   - accept (LLM intent, no regex) → ingestCv fires ONCE with the staged mediaUrl + live session +
 *     skipLimitEnforcement → which (in prod, with the cv-ingest:2397 canary guard off) MERGES via
 *     runUserTagsMerge → resume_parse_completed → composePitchTurn. Never a replace.
 *   - decline → keep current profile; unclear → fall through (pending stays open).
 *   - FIRST résumé (no prior) keeps today's zero-friction immediate-ingest + ack (golden baseline).
 *   - cohort + flag guards (canary vs non-canary; H3 gate vs canary).
 *
 * Run: node --import tsx --test apps/functions/src/claire-agent/__tests__/merge-resume-confirm.test.ts
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { maybeRunThinClaire } from "../cutover.js"
import {
  MERGE_CONFIRM_BUBBLE,
  MERGE_ACCEPT_ACK,
  MERGE_DECLINE_REPLY,
  MERGE_PENDING_COLLECTION,
  hasPriorParsedResume,
  readOpenMergePending,
  stageMergePending,
  type MergeConfirmClassification,
} from "../merge-resume-confirm.js"
import { isCanaryUser } from "../canary.js"

const INBOUND = "pa-inbound-events"
const FLAG = "pa-feature-flags"
const USERS = "pa-users"
const PARSED = "parsedCandidateResumes"
const THIN_FLAG_KEY = "paThinClaireEnabled"
const CANARY_UID = "8fEwIduUrzxZsblHHsNz" // Adam — in CANARY_UIDS

/**
 * In-memory Firestore stub supporting the methods the merge-confirm path uses:
 *   .collection(c).doc(id).get()/.set(data,{merge})
 *   .collection(c).where('userId','==',x).orderBy('createdAt','desc').limit(n).get()
 *   .collection(c).where(...).limit(n).get()  (index-fallback)
 * Mode-selector / agent reads degrade gracefully (missing docs → undefined), and the merge-confirm
 * branches all RETURN true before reaching the heavy agent, so a partial stub is sufficient.
 */
function makeDb(seed: {
  collections?: Record<string, Record<string, Record<string, unknown>>>
}) {
  const store: Record<string, Record<string, Record<string, unknown>>> = {}
  for (const [c, docs] of Object.entries(seed.collections ?? {})) {
    store[c] = {}
    for (const [id, d] of Object.entries(docs)) store[c]![id] = { ...d }
  }
  const ensure = (c: string) => (store[c] ??= {})

  function makeQuery(coll: string, filters: Array<[string, string, unknown]>, lim: number | null) {
    return {
      where(field: string, op: string, val: unknown) {
        return makeQuery(coll, [...filters, [field, op, val]], lim)
      },
      orderBy(_field: string, _dir?: string) {
        return makeQuery(coll, filters, lim)
      },
      limit(n: number) {
        return makeQuery(coll, filters, n)
      },
      async get() {
        const all = Object.entries(ensure(coll))
        const matched = all.filter(([, data]) =>
          filters.every(([f, op, v]) => (op === "==" ? data[f] === v : true)),
        )
        const sliced = lim != null ? matched.slice(0, lim) : matched
        return {
          docs: sliced.map(([id, data]) => ({ id, data: () => data })),
        }
      },
    }
  }

  const db = {
    collection(name: string) {
      return {
        where(field: string, op: string, val: unknown) {
          return makeQuery(name, [[field, op, val]], null)
        },
        orderBy(_field: string, _dir?: string) {
          return makeQuery(name, [], null)
        },
        limit(n: number) {
          return makeQuery(name, [], n)
        },
        doc(id: string) {
          return {
            id,
            async get() {
              const data = ensure(name)[id]
              return { exists: data !== undefined, data: () => data }
            },
            async set(data: Record<string, unknown>, opts?: { merge?: boolean }) {
              const cur = ensure(name)[id]
              ensure(name)[id] =
                opts?.merge && cur ? { ...cur, ...data } : { ...data }
            },
            async delete() {
              delete ensure(name)[id]
            },
          }
        },
      }
    },
    __store: store,
  }
  return db as never as import("firebase-admin/firestore").Firestore & { __store: typeof store }
}

function inboundDoc(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    userId: CANARY_UID,
    sessionId: "ses_live",
    body: "",
    fromNumber: "+14243201960",
    rawMeta: {},
    ...over,
  }
}

function thinFlagDoc(uid: string): Record<string, unknown> {
  return {
    key: THIN_FLAG_KEY,
    value: false,
    type: "bool",
    scope: "perUser",
    allowlist: [uid],
    blocklist: [],
  }
}

function spyLog() {
  const events: Array<{ e: string; p?: Record<string, unknown> }> = []
  return {
    events,
    names: () => events.map((x) => x.e),
    log: (e: string, p?: Record<string, unknown>) => events.push({ e, p }),
  }
}

// Most tests run RAMPED (isCanaryUser → true for any uid) so we use UNIQUE uids (fresh getFlag cache)
// while still exercising the canary path. M9 flips it off explicitly.
function withRampAll<T>(fn: () => Promise<T>): Promise<T> {
  const prev = process.env.PA_ONBOARDING_RAMP_ALL
  process.env.PA_ONBOARDING_RAMP_ALL = "1"
  return fn().finally(() => {
    if (prev === undefined) delete process.env.PA_ONBOARDING_RAMP_ALL
    else process.env.PA_ONBOARDING_RAMP_ALL = prev
  })
}

const classifier = (intent: MergeConfirmClassification["intent"], confidence = 0.95) =>
  async () => ({ intent, confidence })

// ── Constant/copy invariants (load-bearing: merge-framed, never overwrite/replace) ──────────────────
test("MERGE confirm copy is merge-framed and contains NO 'overwrite'/'replace'", () => {
  const lower = MERGE_CONFIRM_BUBBLE.toLowerCase()
  assert.ok(lower.includes("fold it into your profile") && lower.includes("re-pitch"))
  assert.ok(!lower.includes("overwrite"), "must not say overwrite")
  assert.ok(!lower.includes("replace"), "must not say replace")
  assert.equal(MERGE_ACCEPT_ACK, "got your résumé — let me read through it 📄, one sec!")
  assert.ok(MERGE_DECLINE_REPLY.toLowerCase().includes("keeping your current profile"))
})

// ── M1: additional résumé → MERGE confirm, no ingest, pending staged ────────────────────────────────
test("M1: LinkedIn-bound canary drops résumé-only → MERGE confirm, NO ingest, pending awaiting_confirm", () =>
  withRampAll(async () => {
    const uid = `m1_${Date.now()}`
    const eventId = "evt_m1"
    const db = makeDb({
      collections: {
        [INBOUND]: { [eventId]: inboundDoc({ userId: uid, rawMeta: { mediaUrl: "https://x/cv.pdf" } }) },
        [FLAG]: { [THIN_FLAG_KEY]: thinFlagDoc(uid) },
        // Coresignal mirror row → prior parsed résumé exists.
        [PARSED]: { prior1: { userId: uid, createdAt: new Date(), source: "coresignal_collect_v2" } },
      },
    })
    const { names, log } = spyLog()
    let ingestCalls = 0
    const handled = await maybeRunThinClaire(db, eventId, {
      log,
      dryRun: true,
      mergeConfirmClassifier: classifier("unclear"),
      ingestCvOverride: async () => {
        ingestCalls++
        return { ok: true }
      },
    })
    assert.equal(handled, true)
    assert.equal(ingestCalls, 0, "must NOT ingest yet on an additional résumé")
    assert.ok(names().includes("thin_claire.merge_confirm.staged"), `got ${JSON.stringify(names())}`)
    const pending = await readOpenMergePending(db, uid)
    assert.ok(pending, "pending must be staged awaiting_confirm")
    assert.equal(pending!.mediaUrl, "https://x/cv.pdf")
    // handledBy marker proves the MERGE-confirm path owned the turn (NOT overwrite, NOT immediate ingest).
    assert.equal(db.__store[INBOUND]![eventId]!.handledBy, "thin_claire_merge_confirm")
    // No overwrite event was emitted (we never wrote a pa-cv-pending row nor a resume_overwrite_pending).
    assert.equal(db.__store["pa-cv-pending"], undefined)
  }))

// ── M2 + M3 + M4: accept → ingest once (merge wiring), repitch handoff implied ──────────────────────
test("M2: accept reply → ingestCv fires ONCE with staged mediaUrl + live session + skipLimitEnforcement", () =>
  withRampAll(async () => {
    const uid = `m2_${Date.now()}`
    const eventId = "evt_m2_accept"
    const db = makeDb({
      collections: {
        [INBOUND]: { [eventId]: inboundDoc({ userId: uid, body: "yes go for it" }) },
        [FLAG]: { [THIN_FLAG_KEY]: thinFlagDoc(uid) },
        [USERS]: { [uid]: { phoneE164: "+14243201960" } },
      },
    })
    // Stage an open pending (as if M1 already ran).
    await stageMergePending(db, {
      userId: uid,
      mediaUrl: "https://x/cv.pdf",
      sessionId: "ses_staged",
      nowIso: new Date().toISOString(),
    })
    const { names } = spyLog()
    const calls: Array<{ input: Record<string, unknown>; opts: Record<string, unknown> }> = []
    const handled = await maybeRunThinClaire(db, eventId, {
      log: spyLog().log,
      dryRun: true,
      mergeConfirmClassifier: classifier("accept_merge", 0.95),
      ingestCvOverride: async (input, opts) => {
        calls.push({ input: input as Record<string, unknown>, opts: opts as Record<string, unknown> })
        return { ok: true, resumeId: "r_new" }
      },
    })
    void names
    assert.equal(handled, true)
    assert.equal(calls.length, 1, "ingestCv must fire exactly once on accept")
    assert.equal(calls[0]!.input.mediaUrl, "https://x/cv.pdf", "staged mediaUrl")
    assert.equal(calls[0]!.input.sessionId, "ses_staged", "live/staged session")
    assert.equal(calls[0]!.opts.skipLimitEnforcement, true)
    assert.equal(db.__store[INBOUND]![eventId]!.handledBy, "thin_claire_merge_accept")
    const pendingDoc = db.__store[MERGE_PENDING_COLLECTION]![uid]!
    assert.equal(pendingDoc.status, "accepted", "pending → accepted (terminal)")
  }))

// ── M6: decline → no ingest, keep profile ───────────────────────────────────────────────────────────
test("M6: decline reply → NO ingest; pending declined; keep-current-profile reply", () =>
  withRampAll(async () => {
    const uid = `m6_${Date.now()}`
    const eventId = "evt_m6_decline"
    const db = makeDb({
      collections: {
        [INBOUND]: { [eventId]: inboundDoc({ userId: uid, body: "actually no, keep it" }) },
        [FLAG]: { [THIN_FLAG_KEY]: thinFlagDoc(uid) },
        [USERS]: { [uid]: { phoneE164: "+14243201960" } },
      },
    })
    await stageMergePending(db, {
      userId: uid,
      mediaUrl: "https://x/cv.pdf",
      sessionId: "ses_staged",
      nowIso: new Date().toISOString(),
    })
    let ingestCalls = 0
    const handled = await maybeRunThinClaire(db, eventId, {
      log: spyLog().log,
      dryRun: true,
      mergeConfirmClassifier: classifier("decline_merge", 0.9),
      ingestCvOverride: async () => {
        ingestCalls++
        return { ok: true }
      },
    })
    assert.equal(handled, true)
    assert.equal(ingestCalls, 0, "decline must NOT ingest")
    assert.equal(db.__store[INBOUND]![eventId]!.handledBy, "thin_claire_merge_decline")
    assert.equal(db.__store[MERGE_PENDING_COLLECTION]![uid]!.status, "declined")
  }))

// ── M7: unclear → fall through to normal triage (pending stays open) ────────────────────────────────
test("M7: unrelated reply → unclear → falls through (no ingest, pending stays open)", () =>
  withRampAll(async () => {
    const uid = `m7_${Date.now()}`
    const eventId = "evt_m7_unclear"
    const db = makeDb({
      collections: {
        [INBOUND]: { [eventId]: inboundDoc({ userId: uid, body: "what's the salary range?" }) },
        [FLAG]: { [THIN_FLAG_KEY]: thinFlagDoc(uid) },
        [USERS]: { [uid]: { phoneE164: "+14243201960" } },
      },
    })
    await stageMergePending(db, {
      userId: uid,
      mediaUrl: "https://x/cv.pdf",
      sessionId: "ses_staged",
      nowIso: new Date().toISOString(),
    })
    const { names, log } = spyLog()
    let ingestCalls = 0
    // Returns false (falls through to mode-selector/agent, which the partial stub degrades → false).
    await maybeRunThinClaire(db, eventId, {
      log,
      dryRun: true,
      mergeConfirmClassifier: classifier("unclear"),
      ingestCvOverride: async () => {
        ingestCalls++
        return { ok: true }
      },
    })
    assert.equal(ingestCalls, 0, "unclear must NOT ingest")
    assert.ok(
      names().includes("thin_claire.merge_confirm.unclear_fallthrough"),
      `expected unclear fallthrough; got ${JSON.stringify(names())}`,
    )
    // Pending NOT terminal — still open for the next reply.
    const stillOpen = await readOpenMergePending(db, uid)
    assert.ok(stillOpen, "pending must stay open on unclear")
    assert.equal(stillOpen!.status, "awaiting_confirm")
  }))

// ── M8: FIRST résumé (no prior) → today's immediate-ingest + new ack (golden baseline) ──────────────
test("M8: first résumé (no prior row) → immediate ingest + new ack, no confirm gate", () =>
  withRampAll(async () => {
    const uid = `m8_${Date.now()}`
    const eventId = "evt_m8_first"
    const db = makeDb({
      collections: {
        [INBOUND]: { [eventId]: inboundDoc({ userId: uid, rawMeta: { mediaUrl: "https://x/cv.pdf" } }) },
        [FLAG]: { [THIN_FLAG_KEY]: thinFlagDoc(uid) },
        // NO parsedCandidateResumes → no prior.
      },
    })
    const { names, log } = spyLog()
    let ingestCalls = 0
    const handled = await maybeRunThinClaire(db, eventId, {
      log,
      dryRun: true,
      ingestCvOverride: async () => {
        ingestCalls++
        return { ok: true }
      },
    })
    assert.equal(handled, true)
    assert.equal(ingestCalls, 1, "first résumé ingests immediately")
    // The résumé-only ACK path owns the turn (not the merge-confirm gate).
    assert.equal(db.__store[INBOUND]![eventId]!.handledBy, "thin_claire_resume_ack")
    assert.ok(!names().includes("thin_claire.merge_confirm.staged"), "no merge-confirm for first résumé")
    // No pending staged.
    assert.equal(db.__store[MERGE_PENDING_COLLECTION], undefined)
  }))

// ── M11: résumé WITH text → immediate-ingest path (not confirm-gated) ───────────────────────────────
test("M11: additional résumé WITH accompanying text → immediate ingest (not confirm-gated)", () =>
  withRampAll(async () => {
    const uid = `m11_${Date.now()}`
    const eventId = "evt_m11_text"
    const db = makeDb({
      collections: {
        [INBOUND]: {
          [eventId]: inboundDoc({
            userId: uid,
            body: "here's my updated cv, still want NYC",
            rawMeta: { mediaUrl: "https://x/cv.pdf" },
          }),
        },
        [FLAG]: { [THIN_FLAG_KEY]: thinFlagDoc(uid) },
        [PARSED]: { prior1: { userId: uid, createdAt: new Date() } },
        [USERS]: { [uid]: { phoneE164: "+14243201960" } },
      },
    })
    const { names, log } = spyLog()
    let ingestCalls = 0
    await maybeRunThinClaire(db, eventId, {
      log,
      dryRun: true,
      mergeConfirmClassifier: classifier("unclear"),
      ingestCvOverride: async () => {
        ingestCalls++
        return { ok: true }
      },
    })
    // The résumé-with-text path fires ingestCv immediately (no merge-confirm staging).
    assert.equal(ingestCalls, 1, "résumé-with-text ingests immediately")
    assert.ok(!names().includes("thin_claire.merge_confirm.staged"), "no confirm gate when text accompanies")
    assert.equal(db.__store[MERGE_PENDING_COLLECTION], undefined)
  }))

// ── M9: NON-canary → no merge-confirm offered (cohort guard) ────────────────────────────────────────
test("M9: additional résumé but NON-canary (RAMP_ALL off) → merge-confirm NOT offered", async () => {
  const prev = process.env.PA_ONBOARDING_RAMP_ALL
  delete process.env.PA_ONBOARDING_RAMP_ALL
  try {
    const uid = `m9_noncanary_${Date.now()}` // NOT in CANARY_UIDS
    assert.equal(isCanaryUser(uid), false, "precondition: non-canary")
    const eventId = "evt_m9"
    const db = makeDb({
      collections: {
        [INBOUND]: { [eventId]: inboundDoc({ userId: uid, rawMeta: { mediaUrl: "https://x/cv.pdf" } }) },
        [FLAG]: { [THIN_FLAG_KEY]: thinFlagDoc(uid) },
        [PARSED]: { prior1: { userId: uid, createdAt: new Date() } },
      },
    })
    const { names, log } = spyLog()
    await maybeRunThinClaire(db, eventId, { log, dryRun: true })
    assert.ok(
      !names().includes("thin_claire.merge_confirm.staged"),
      "non-canary must NOT get the merge-confirm gate",
    )
    assert.equal(db.__store[MERGE_PENDING_COLLECTION], undefined)
  } finally {
    if (prev === undefined) delete process.env.PA_ONBOARDING_RAMP_ALL
    else process.env.PA_ONBOARDING_RAMP_ALL = prev
  }
})

// ── M12: TTL expiry → stale awaiting_confirm ignored (NOT auto-merged) ──────────────────────────────
test("M12: stale awaiting_confirm (past TTL) is ignored — NOT auto-merged", () =>
  withRampAll(async () => {
    const uid = `m12_${Date.now()}`
    const db = makeDb({ collections: {} })
    // Stage with a createdAt/expireAt 25h in the past.
    const past = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString()
    await stageMergePending(db, { userId: uid, mediaUrl: "https://x/cv.pdf", sessionId: null, nowIso: past })
    const open = await readOpenMergePending(db, uid)
    assert.equal(open, null, "expired pending must read as null (no auto-merge on timeout)")
  }))

// ── M13: accept processed twice → idempotent terminal ───────────────────────────────────────────────
test("M13: accept message processed twice → pending stays accepted (terminal), no re-open", () =>
  withRampAll(async () => {
    const uid = `m13_${Date.now()}`
    const eventId = "evt_m13"
    const db = makeDb({
      collections: {
        [INBOUND]: { [eventId]: inboundDoc({ userId: uid, body: "yes" }) },
        [FLAG]: { [THIN_FLAG_KEY]: thinFlagDoc(uid) },
        [USERS]: { [uid]: { phoneE164: "+14243201960" } },
      },
    })
    await stageMergePending(db, {
      userId: uid,
      mediaUrl: "https://x/cv.pdf",
      sessionId: "ses",
      nowIso: new Date().toISOString(),
    })
    let ingestCalls = 0
    const deps = {
      log: spyLog().log,
      dryRun: true as const,
      mergeConfirmClassifier: classifier("accept_merge", 0.95),
      ingestCvOverride: async () => {
        ingestCalls++
        return { ok: true }
      },
    }
    await maybeRunThinClaire(db, eventId, deps)
    assert.equal(db.__store[MERGE_PENDING_COLLECTION]![uid]!.status, "accepted")
    // Replay: the second processing finds the pending already terminal (not awaiting_confirm) → no
    // second ingest, no re-open.
    await maybeRunThinClaire(db, eventId, deps)
    assert.equal(ingestCalls, 1, "no second ingest on replay (pending already accepted)")
    assert.equal(db.__store[MERGE_PENDING_COLLECTION]![uid]!.status, "accepted")
  }))

// ── store-unit: hasPriorParsedResume skips archived rows ─────────────────────────────────────────────
test("hasPriorParsedResume: true on a live row, false when only archived rows exist", async () => {
  const uid = "u_prior"
  const dbLive = makeDb({ collections: { [PARSED]: { a: { userId: uid, createdAt: new Date() } } } })
  assert.equal(await hasPriorParsedResume(dbLive, uid), true)
  const dbArchived = makeDb({
    collections: { [PARSED]: { a: { userId: uid, createdAt: new Date(), archived: true } } },
  })
  assert.equal(await hasPriorParsedResume(dbArchived, uid), false)
  const dbNone = makeDb({ collections: {} })
  assert.equal(await hasPriorParsedResume(dbNone, uid), false)
})
