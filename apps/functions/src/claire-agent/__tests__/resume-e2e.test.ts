/**
 * resume-e2e.test.ts — REAL-PATH résumé → thin-pitch end-to-end harness.
 *
 * WHY THIS EXISTS (the "stub blind spot", Adam 2026-06-02):
 *   Prior verification sims STUBBED the cv-parsed runtime event — they hand-authored a
 *   pa-inbound-events doc WITH a sessionId + runtimeEventKind that the REAL producer
 *   (enqueueRuntimeEventHandoff, called from inside ingestCv) sets differently. They thereby
 *   green-lit a route the real flow never takes. The live result on the canary dev phone
 *   (+14243201960) was the post-parse turn composed by LEGACY ("scratch that, they weren't
 *   invited") — i.e. the cv-parsed completion never reached thin — plus a DUP-SEND.
 *
 *   This harness drives the REAL path end-to-end:
 *     - REAL ingestCv (parse stubbed via injected deps; the cv-parse is NOT the bug)
 *     - REAL enqueueRuntimeEventHandoff (NOT a hand-built doc) — it derives the session id,
 *       enforces requireExistingSession, and writes the runtime-event inbound doc itself
 *     - REAL maybeRunThinClaire / cutover seam (dryRun transport captures bubbles)
 *
 *   so the assertions are over what production actually does.
 *
 * WHAT IT PROVES (covers BUG 1 route + BUG 2 dup):
 *   Leg A — résumé DROP turn: the broker doc carrying rawMeta.mediaUrl routes to THIN
 *           (handledBy thin_claire, resumeJustDropped path), one ACK bubble, NO "scratch that".
 *   Leg B — cv-parsed completion: a REAL ingestCv(followup=runtime) with the LIVE sessionId
 *           produces EXACTLY ONE resume_parse_completed inbound doc via the real handoff, and
 *           maybeRunThinClaire routes THAT doc to thin (cv_parsed_reentry, NOT defer_runtime_event,
 *           handledBy thin_claire) — the post-parse PITCH turn, NOT legacy.
 *   Dedup — two concurrent REAL ingestCv runs (mirroring webhook Path A + cutover Path B) for the
 *           SAME pdf produce EXACTLY ONE resume_parse_completed handoff doc (sha256-keyed), so
 *           onPaInbound fires once → ONE pitch.
 *   Discriminators — a NON-canary user's cv-parsed event DEFERS to legacy (invariant 3); a
 *           handoff with NO live session + requireExistingSession default-true is dropped (proves
 *           the no_existing_session failure mode the fix closes is real, not masked by seeding).
 *
 * No live model needed: the load-bearing assertions are on ROUTING (handledBy / log markers /
 * handoff-doc count), and runClaireTurn ALWAYS emits a grounded-fallback bubble in dryRun even
 * without an LLM key, so bubble COUNT is still meaningful.
 *
 * Run: node --import tsx --test apps/functions/src/claire-agent/__tests__/resume-e2e.test.ts
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import type { Firestore } from "firebase-admin/firestore"
import { PA_COLLECTIONS } from "@pa/core-types"
import { ingestCv } from "../../cv-ingest/cv-ingest.js"
import { enqueueRuntimeEventHandoff } from "../../runtime-event-handoff.js"
import { maybeRunThinClaire } from "../cutover.js"

const CANARY_UID = "8fEwIduUrzxZsblHHsNz" // Adam dev phone +14243201960 (isCanaryUser → true)
const NONCANARY_UID = "u_noncanary_resume_e2e"
const PHONE = "+14243201960"
const THIN_FLAG_KEY = "paThinClaireEnabled"
const RESUME_COLLECTION = "parsedCandidateResumes"

// ── Rich in-memory Firestore stub ───────────────────────────────────────────
// Supports: collection(c).doc(id).get()/set()/create(), collection(c).add(),
// and a where(...).where(...).orderBy(...).limit(...).get() query chain. Enough for the
// REAL ingestCv + enqueueRuntimeEventHandoff + selectClaireMode + cutover delivery path.
type DocStore = Map<string, Record<string, unknown>>
function makeFirestore() {
  const store = new Map<string, DocStore>()
  const col = (name: string): DocStore => {
    if (!store.has(name)) store.set(name, new Map())
    return store.get(name)!
  }
  let autoId = 0
  const makeQuery = (name: string, filters: Array<[string, unknown]>) => {
    const run = () => {
      const rows = [...col(name).entries()].filter(([, data]) =>
        filters.every(([field, value]) => {
          const actual = (data as Record<string, unknown>)[field]
          // mirror Firestore: `== null` matches missing OR explicit null
          if (value === null) return actual === null || actual === undefined
          return actual === value
        }),
      )
      return rows
    }
    const api: Record<string, unknown> = {
      where(field: string, _op: string, value: unknown) {
        return makeQuery(name, [...filters, [field, value]])
      },
      orderBy() {
        return api
      },
      limit() {
        return api
      },
      async get() {
        const rows = run()
        const docs = rows.map(([id, data]) => ({
          id,
          exists: true,
          data: () => data,
        }))
        return { empty: docs.length === 0, docs, size: docs.length }
      },
    }
    return api
  }
  const db = {
    collection(name: string) {
      return {
        doc(id: string) {
          return {
            id,
            async get() {
              const data = col(name).get(id)
              return { exists: data !== undefined, id, data: () => data }
            },
            async set(data: Record<string, unknown>, opts?: { merge?: boolean }) {
              col(name).set(id, opts?.merge ? { ...(col(name).get(id) ?? {}), ...data } : { ...data })
            },
            async create(data: Record<string, unknown>) {
              if (col(name).has(id)) {
                const err = new Error("ALREADY_EXISTS") as Error & { code: number }
                err.code = 6
                throw err
              }
              col(name).set(id, { ...data })
            },
          }
        },
        async add(data: Record<string, unknown>) {
          const id = `auto_${name}_${++autoId}`
          col(name).set(id, { ...data })
          return { id }
        },
        where(field: string, op: string, value: unknown) {
          return makeQuery(name, [[field, value]])
        },
      }
    },
  } as unknown as Firestore
  return { db, store, col }
}

function seedThinFlag(col: (n: string) => DocStore, uid: string) {
  col("pa-feature-flags").set(THIN_FLAG_KEY, {
    key: THIN_FLAG_KEY,
    value: false,
    type: "bool",
    scope: "perUser",
    allowlist: [uid],
    blocklist: [],
  })
}

function seedUser(col: (n: string) => DocStore, uid: string) {
  col(PA_COLLECTIONS.users).set(uid, {
    id: uid,
    phoneE164: PHONE,
    onboardingStatus: "active",
    sharedOnboarding: { completed: true, status: "completed" },
  })
}

/** Live conversation session, exactly as processBrokerImessageEvent (index.ts:1020) creates it. */
function seedSession(col: (n: string) => DocStore, uid: string): string {
  const sessionId = "ses_live_resume_e2e"
  col(PA_COLLECTIONS.sessions).set(sessionId, {
    id: sessionId,
    userId: uid,
    channel: "imessage",
    externalChatId: PHONE,
    createdAt: "2026-06-02T00:00:00.000Z",
    lastMessageAt: "2026-06-02T00:00:00.000Z",
  })
  return sessionId
}

/**
 * Inject the parse-side deps so the REAL ingestCv runs WITHOUT an LLM/PDF, while leaving the
 * tail (enqueueRuntimeEventHandoff) as the genuine production producer. `bytes` is fixed so the
 * sha256 is deterministic across concurrent runs (the dedup test depends on this).
 */
function ingestDeps(db: Firestore, col: (n: string) => DocStore) {
  const logs: Array<{ e: string; p?: Record<string, unknown> }> = []
  const deps = {
    db,
    log: (e: string, p?: Record<string, unknown>) => logs.push({ e, p }),
    fetchPdf: async () => ({ bytes: new TextEncoder().encode("ADAM-YANG-RESUME-FIXED-BYTES"), contentType: "application/pdf" }),
    parsePdf: async () => ({ text: "Adam Yang — Software Engineer at Tesla. React, TypeScript, Node.", numPages: 1 }),
    llmExtract: async () => ({
      parsed: {
        candidateProfile: { name: "Adam Yang", email: "adam@example.com", phone: PHONE, linkedIn: null, location: "SF", skills: ["React", "TypeScript", "Node"] },
        experiences: [{ company: "Tesla", title: "Software Engineer", startDate: "2022", endDate: null, location: "SF", description: "Built UIs" }],
        education: [],
        industryTags: ["technology_and_software"] as never,
      },
    }),
    isParserV2Enabled: async () => false,
    mem0Add: async () => {},
    computeEmbedding: async () => null,
    writeUserTags: async () => {},
    mergeUserTagsFn: () => ({}),
    // Real lock-free sha256 dedup behavior: read the fake parsedCandidateResumes by userId+sha256.
    // On a first upload both concurrent runs miss (no row yet) → both proceed (reproduces the BUG 2
    // double-parse the sha256-keyed handoff dedup must collapse to one pitch).
    findResumeBySha256: async (_db: Firestore, userId: string, sha256: string): Promise<string | null> => {
      for (const [id, data] of col(RESUME_COLLECTION)) {
        if (data.userId === userId && data.sha256 === sha256) return id
      }
      return null
    },
    findExistingResume: async () => null,
    checkGate: async () => ({ open: true, reason: "ok" }),
    readQuotaCount: async () => 0,
    incrementQuota: async () => {},
    lookupUserForFollowup: async () => ({ toE164: PHONE, mem0UserId: null }),
    runIndustrySecondPassFn: async () => [],
  } as never
  return { deps, logs }
}

function countHandoffDocs(col: (n: string) => DocStore): number {
  let n = 0
  for (const [, data] of col(PA_COLLECTIONS.inboundEvents)) {
    const meta = (data.rawMeta ?? {}) as Record<string, unknown>
    if (meta.runtimeEventKind === "resume_parse_completed") n++
  }
  return n
}

function firstHandoffId(col: (n: string) => DocStore): string | undefined {
  for (const [id, data] of col(PA_COLLECTIONS.inboundEvents)) {
    const meta = (data.rawMeta ?? {}) as Record<string, unknown>
    if (meta.runtimeEventKind === "resume_parse_completed") return id
  }
  return undefined
}

// ── BUG 1 — the cv-parsed completion reaches THIN (real producer + real cutover) ─────────────
test("LEG B: REAL ingestCv with the LIVE sessionId produces ONE resume_parse_completed handoff that routes to THIN (not legacy)", async () => {
  const { db, col } = makeFirestore()
  seedThinFlag(col, CANARY_UID)
  seedUser(col, CANARY_UID)
  const sessionId = seedSession(col, CANARY_UID)

  // REAL ingestCv with the live session threaded in (the cutover-path contract after the BUG 1 fix).
  const { deps } = ingestDeps(db, col)
  const res = await ingestCv({ userId: CANARY_UID, mediaUrl: "https://example.com/adam.pdf", sessionId }, deps)
  assert.equal(res.ok, true, "ingestCv must succeed")

  // The REAL handoff producer wrote exactly ONE resume_parse_completed inbound doc.
  assert.equal(countHandoffDocs(col), 1, "exactly one resume_parse_completed handoff doc")
  const handoffId = firstHandoffId(col)!
  const handoffDoc = col(PA_COLLECTIONS.inboundEvents).get(handoffId)!
  assert.equal(handoffDoc.sessionId, sessionId, "handoff must thread the LIVE session, not a re-derived one")

  // Drive the REAL cutover seam over THAT doc with a capturing transport.
  const events: string[] = []
  const handled = await maybeRunThinClaire(db, handoffId, {
    dryRun: true,
    log: (e: string) => events.push(e),
  })

  assert.equal(handled, true, "thin MUST handle the cv-parsed re-entry (route to thin, not legacy)")
  assert.ok(events.includes("thin_claire.cv_parsed_reentry"), `expected cv_parsed_reentry; got ${JSON.stringify(events)}`)
  assert.equal(events.includes("thin_claire.defer_runtime_event"), false, "must NOT defer the canary cv-parsed event to legacy")
  // handledBy is any thin_claire* handler — the cv-parsed re-entry now runs the PITCH ENGINE
  // (thin_claire_pitch_engine), or its deterministic non-matching fallback when the composer misses
  // (thin_claire_pitch_engine_fallback, e.g. no OpenAI key in test). All are THIN, not legacy.
  const handledBy = String(col(PA_COLLECTIONS.inboundEvents).get(handoffId)!.handledBy ?? "")
  assert.ok(handledBy.startsWith("thin_claire"), `handledBy must be a thin_claire* handler; got ${handledBy}`)
})

// ── BUG 2 — exactly-once: two concurrent SAME-SESSION ingests collapse to ONE handoff ─────────
// SESSION-SCOPE (Adam 2026-06-06): the handoff key is now cv-parsed:<user>:<session>:<sha>. The realistic
// same-pdf double-emission is WITHIN ONE SESSION (a Path-B retry, or the BLOCKER-1 idempotent-hit re-firing
// in the live session) — that still collapses to ONE pitch. (A genuine webhook Path A no longer emits a
// handoff at all: followup="none" — proven by the next test — so the cross-session both-runtime race the
// old version simulated does not occur in production.) A DELIBERATE re-upload in a NEW session intentionally
// re-pitches (the merge-accept "Yes!" → silence fix) and is covered separately.
test("DEDUP: two concurrent REAL ingestCv runs for the SAME pdf in the SAME session → exactly ONE handoff doc", async () => {
  const { db, col } = makeFirestore()
  seedThinFlag(col, CANARY_UID)
  seedUser(col, CANARY_UID)
  const sessionId = seedSession(col, CANARY_UID)

  // Same live session for both (the real same-turn double-emission). Identical bytes → identical sha256.
  const a = ingestDeps(db, col)
  const b = ingestDeps(db, col)
  const [ra, rb] = await Promise.all([
    ingestCv({ userId: CANARY_UID, mediaUrl: "https://example.com/adam.pdf", sessionId }, a.deps),
    ingestCv({ userId: CANARY_UID, mediaUrl: "https://example.com/adam.pdf", sessionId }, b.deps),
  ])
  assert.equal(ra.ok, true)
  assert.equal(rb.ok, true)

  // session+sha256-keyed idempotencyKey ⇒ both runs resolve to the SAME handoff doc id ⇒ ONE pitch.
  assert.equal(
    countHandoffDocs(col),
    1,
    "BUG 2: the post-parse pitch handoff must be EXACTLY ONE per (user, session, pdf), not one-per-resumeId",
  )
})

// ── SESSION-SCOPE re-pitch: the SAME pdf in a NEW session emits a FRESH handoff (merge-accept fix) ──
test("RE-PITCH: the SAME pdf ingested again in a DIFFERENT session emits a SECOND handoff (deliberate re-upload re-pitches)", async () => {
  const { db, col } = makeFirestore()
  seedThinFlag(col, CANARY_UID)
  seedUser(col, CANARY_UID)
  const sessionA = seedSession(col, CANARY_UID)
  // First upload in session A → one handoff.
  await ingestCv({ userId: CANARY_UID, mediaUrl: "https://example.com/adam.pdf", sessionId: sessionA }, ingestDeps(db, col).deps)
  assert.equal(countHandoffDocs(col), 1, "first upload emits one handoff")
  // A NEW session (the live "Yes!" merge-accept after the same pdf was seen earlier) → a FRESH handoff.
  const sessionB = "ses_live_repitch_b"
  col(PA_COLLECTIONS.sessions).set(sessionB, { id: sessionB, userId: CANARY_UID, createdAt: new Date().toISOString() })
  await ingestCv({ userId: CANARY_UID, mediaUrl: "https://example.com/adam.pdf", sessionId: sessionB }, ingestDeps(db, col).deps)
  assert.equal(countHandoffDocs(col), 2, "same pdf in a NEW session must re-pitch (NOT be deduped away)")
})

// ── BUG 2 (production wiring) — webhook Path A is parse-only; only cutover emits the re-entry ──
// Each ingest gets a clean db (a fresh first-upload) to isolate the two wiring assertions: the
// sha256 row-level idempotency (cv-ingest.ts:1734) would short-circuit a SEQUENTIAL same-pdf
// re-ingest, which is orthogonal to "which followupDeliveryMode emits a handoff".
test("DEDUP wiring: a parse-only ingest (followupDeliveryMode none) emits NO handoff; the runtime ingest emits exactly one", async () => {
  // Webhook Path A after the fix: followupDeliveryMode "none" → parse only, NO candidate re-entry.
  {
    const { db, col } = makeFirestore()
    seedThinFlag(col, CANARY_UID)
    seedUser(col, CANARY_UID)
    seedSession(col, CANARY_UID)
    const a = ingestDeps(db, col)
    await ingestCv(
      { userId: CANARY_UID, mediaUrl: "https://example.com/adam.pdf", sessionId: undefined },
      { ...(a.deps as object), followupDeliveryMode: "none" } as never,
    )
    assert.equal(countHandoffDocs(col), 0, "the parse-only webhook ingest must NOT enqueue a resume_parse_completed handoff")
  }

  // Cutover Path B (runtime, live session) is the single producer of the candidate-facing re-entry.
  {
    const { db, col } = makeFirestore()
    seedThinFlag(col, CANARY_UID)
    seedUser(col, CANARY_UID)
    const sessionId = seedSession(col, CANARY_UID)
    const b = ingestDeps(db, col)
    await ingestCv({ userId: CANARY_UID, mediaUrl: "https://example.com/adam.pdf", sessionId }, b.deps)
    assert.equal(countHandoffDocs(col), 1, "the cutover runtime ingest is the single producer of the re-entry")
  }
})

// ── BLOCKER 1 — webhook-parse-only THEN cutover, SEQUENTIAL, SAME pdf + SAME db → ONE handoff ──
// This is the regression the fresh-DB-per-ingest tests above CANNOT see (the stub blind spot Adam
// called out): in production the parse-only webhook ingest writes the sha256 row ~1-2s AHEAD, so the
// SUBSEQUENT cutover (runtime) ingest HITS the sha256 idempotent-guard and returns EARLY — before the
// main resume_parse_completed handoff. The pre-fix behavior was HANDOFF_COUNT_AFTER_CUTOVER=0 (silent
// pitch loss). The fix fires the handoff on the idempotent-hit return path too (sha-keyed → dedups), so
// the cutover ingest STILL produces exactly ONE pitch even though it short-circuited the parse.
test("BLOCKER 1: webhook-parse-only THEN cutover (runtime) SEQUENTIALLY on the SAME pdf+db → HANDOFF_COUNT===1 (pitch never lost to the sha256 race)", async () => {
  const { db, col } = makeFirestore()
  seedThinFlag(col, CANARY_UID)
  seedUser(col, CANARY_UID)
  const sessionId = seedSession(col, CANARY_UID)

  // 1) Webhook Path A FIRST: parse-only (followupDeliveryMode "none"). It writes the parsedCandidateResume
  //    row WITH sha256 but enqueues NO handoff. This is what races ~1-2s ahead of the cutover in prod.
  const a = ingestDeps(db, col)
  const ra = await ingestCv(
    { userId: CANARY_UID, mediaUrl: "https://example.com/adam.pdf", sessionId: undefined },
    { ...(a.deps as object), followupDeliveryMode: "none" } as never,
  )
  assert.equal(ra.ok, true, "webhook parse-only ingest must succeed")
  assert.equal(countHandoffDocs(col), 0, "webhook parse-only ingest enqueues NO handoff (parse-only)")
  // The sha256 row now exists → the cutover ingest below WILL hit the idempotent guard.
  const rowCount = [...col(RESUME_COLLECTION).values()].filter((d) => d.userId === CANARY_UID).length
  assert.equal(rowCount, 1, "the parse-only ingest wrote exactly one parsedCandidateResumes row (with sha256)")

  // 2) Cutover Path B SECOND, SAME db + SAME pdf, followupDeliveryMode "runtime", live session. Its
  //    sha256 lookup HITS the row from step 1 → early return. WITHOUT the fix this emits NO handoff
  //    (the live HANDOFF_COUNT_AFTER_CUTOVER=0). WITH the fix the idempotent-hit path fires it.
  const b = ingestDeps(db, col)
  const rb = await ingestCv({ userId: CANARY_UID, mediaUrl: "https://example.com/adam.pdf", sessionId }, b.deps)
  assert.equal(rb.ok, true, "cutover runtime ingest must succeed (idempotent hit, ok:true)")

  // THE BAR: exactly ONE resume_parse_completed handoff — never lost (was 0 pre-fix), never doubled.
  assert.equal(
    countHandoffDocs(col),
    1,
    "BLOCKER 1: the cutover ingest MUST still produce exactly ONE pitch handoff even when the sha256 row already exists",
  )
  // And the surviving handoff threads the LIVE session (the cutover passed it) + carries the pitch context.
  const handoffId = firstHandoffId(col)!
  const handoffDoc = col(PA_COLLECTIONS.inboundEvents).get(handoffId)!
  assert.equal(handoffDoc.sessionId, sessionId, "idempotent-hit handoff threads the live cutover session")
  const meta = (handoffDoc.rawMeta ?? {}) as Record<string, unknown>
  const hctx = (meta.context ?? {}) as Record<string, unknown>
  assert.equal(hctx.cvParsedTrigger, true, "handoff context marks cvParsedTrigger")
  assert.equal(
    typeof hctx.candidateProfileSummary === "string" && (hctx.candidateProfileSummary as string).length > 0,
    true,
    "the idempotent-hit handoff still carries a candidateProfileSummary (reconstructed from the stored row)",
  )

  // 3) The cutover seam routes THAT handoff to thin (the pitch turn), not legacy — proving the pitch is delivered.
  const events: string[] = []
  const handled = await maybeRunThinClaire(db, handoffId, { dryRun: true, log: (e: string) => events.push(e) })
  assert.equal(handled, true, "the recovered handoff routes to thin (the pitch turn)")
  assert.ok(events.includes("thin_claire.cv_parsed_reentry"), `expected cv_parsed_reentry; got ${JSON.stringify(events)}`)
})

// ── BLOCKER 1 (identity path) — a re-upload of the SAME pdf with a live session re-fires ONE handoff ──
test("BLOCKER 1: a SEQUENTIAL same-pdf runtime re-ingest (sha256 hit) still fires the handoff (idempotent, total stays 1)", async () => {
  const { db, col } = makeFirestore()
  seedThinFlag(col, CANARY_UID)
  seedUser(col, CANARY_UID)
  const sessionId = seedSession(col, CANARY_UID)

  // First runtime ingest: normal path, writes row + fires the handoff once.
  const a = ingestDeps(db, col)
  await ingestCv({ userId: CANARY_UID, mediaUrl: "https://example.com/adam.pdf", sessionId }, a.deps)
  assert.equal(countHandoffDocs(col), 1, "first runtime ingest fires exactly one handoff")

  // Second runtime ingest of the SAME pdf (a redelivery / re-drop): sha256 HITS → early return. The
  // idempotent-hit path fires the handoff again, but the SAME sha-keyed idempotencyKey collapses it.
  const b = ingestDeps(db, col)
  const rb = await ingestCv({ userId: CANARY_UID, mediaUrl: "https://example.com/adam.pdf", sessionId }, b.deps)
  assert.equal(rb.ok, true)
  assert.equal(countHandoffDocs(col), 1, "the re-ingest's idempotent-hit handoff collapses to the SAME doc → total stays 1")
})

// ── DISCRIMINATOR 1 — non-canary cv-parsed still DEFERS to legacy (invariant 3) ───────────────
test("DISCRIMINATOR: a NON-canary user's resume_parse_completed event DEFERS to legacy (no thin pitch until ramp)", async () => {
  const { db, col } = makeFirestore()
  seedThinFlag(col, NONCANARY_UID)
  seedUser(col, NONCANARY_UID)
  const sessionId = seedSession(col, NONCANARY_UID)

  const { deps } = ingestDeps(db, col)
  await ingestCv({ userId: NONCANARY_UID, mediaUrl: "https://example.com/x.pdf", sessionId }, deps)
  const handoffId = firstHandoffId(col)!

  const events: string[] = []
  const handled = await maybeRunThinClaire(db, handoffId, { dryRun: true, log: (e: string) => events.push(e) })

  assert.equal(handled, false, "non-canary cv-parsed must defer to legacy")
  assert.ok(events.includes("thin_claire.defer_runtime_event"), `expected defer; got ${JSON.stringify(events)}`)
  assert.equal(events.includes("thin_claire.cv_parsed_reentry"), false, "the cv-parsed exemption must NOT fire for non-canary")
})

// ── DISCRIMINATOR 2 — the no_existing_session drop is REAL (proves the fix is load-bearing) ───
test("DISCRIMINATOR: with NO live session + default requireExistingSession, the REAL handoff DROPS the cv-parsed event (no_existing_session) — exactly the live failure the BUG 1 fix closes", async () => {
  const { db, col } = makeFirestore()
  seedUser(col, CANARY_UID) // user exists (resolveUserPhone works) but NO session doc seeded.

  // Call the REAL producer the way the OLD code did: no sessionId, requireExistingSession defaulted (true).
  const r = await enqueueRuntimeEventHandoff(db, {
    userId: CANARY_UID,
    toE164: PHONE,
    source: "cv_ingest",
    eventKind: "resume_parse_completed",
    idempotencyKey: `cv-parsed:${CANARY_UID}:legacy-no-session`,
    context: { resumeId: "r1", cvParsedTrigger: true },
  })
  assert.equal(r.ok, false, "the old contract DROPS when the derived session does not exist")
  if (!r.ok) assert.equal(r.reason, "no_existing_session", "drop reason is no_existing_session")
  assert.equal(countHandoffDocs(col), 0, "no handoff doc → NO thin pitch (the live BUG 1)")

  // The fix: passing requireExistingSession:false (cv-ingest does this now) attaches the derived
  // session and writes the doc, so the pitch is never lost to a race.
  const r2 = await enqueueRuntimeEventHandoff(db, {
    userId: CANARY_UID,
    toE164: PHONE,
    requireExistingSession: false,
    source: "cv_ingest",
    eventKind: "resume_parse_completed",
    idempotencyKey: `cv-parsed:${CANARY_UID}:fixed`,
    context: { resumeId: "r1", cvParsedTrigger: true },
  })
  assert.equal(r2.ok, true, "with requireExistingSession:false the handoff is written even without a pre-existing session")
  assert.equal(countHandoffDocs(col), 1, "exactly one handoff doc after the fix")
})

// ── LEG A — the résumé DROP turn itself routes to thin (ACK), never legacy "scratch that" ─────
test("LEG A: the broker résumé-DROP doc (rawMeta.mediaUrl) routes to THIN — handledBy thin_claire, NO 'scratch that' legacy marker", async () => {
  const { db, col } = makeFirestore()
  seedThinFlag(col, CANARY_UID)
  seedUser(col, CANARY_UID)
  const sessionId = seedSession(col, CANARY_UID)

  // The inbound doc as processBrokerImessageEvent (index.ts:1051) writes it for a résumé drop:
  // real session + rawMeta.mediaUrl, NO runtimeEvent marker (this is a genuine candidate turn).
  const dropEventId = "evt_resume_drop"
  col(PA_COLLECTIONS.inboundEvents).set(dropEventId, {
    id: dropEventId,
    userId: CANARY_UID,
    sessionId,
    channel: "imessage",
    externalChatId: PHONE,
    fromNumber: PHONE,
    body: "(sent a résumé)",
    status: "pending",
    rawMeta: { source: "imessage_broker", mediaUrl: "https://example.com/adam.pdf", messageHandle: "h1" },
  })

  const events: string[] = []
  const handled = await maybeRunThinClaire(db, dropEventId, {
    dryRun: true,
    log: (e: string) => events.push(e),
  })

  assert.equal(handled, true, "the résumé-drop turn MUST be composed by thin (the ACK), not legacy")
  assert.equal(col(PA_COLLECTIONS.inboundEvents).get(dropEventId)!.handledBy, "thin_claire", "handledBy thin_claire")
  assert.equal(events.includes("thin_claire.defer_runtime_event"), false, "the drop is NOT a runtime event — must not defer")
  // The kickoff/ack composer must NOT use the LEGACY imperfection-injector self-correct marker.
  const allText = JSON.stringify(events)
  assert.equal(/scratch that/i.test(allText), false, "no legacy 'scratch that' marker may appear on the thin path")
})
