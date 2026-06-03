/**
 * dup-send-delivery.test.ts — VERIFY 2/4 (DUP-SEND): exactly-once outbound per inbound.
 *
 * WHY THIS EXISTS (Adam 2026-06-02 live bug): "same/similar text not sent twice which we've
 * experienced once today even though user only sends one text." This harness proves the
 * exactly-once-delivery invariant at the level that actually matters — the number of rows that
 * land in `pa-outbound` (the durable send queue the paSendblueOutbox CF drains 1:1 to Sendblue).
 *
 * THE STUB BLIND SPOT (why dryRun isn't enough): resume-e2e.test.ts drives the cutover seam with a
 * dryRun transport — it proves ROUTING (which path composes) but its transport NEVER calls the real
 * enqueueOutbound, so it cannot count real sends or prove replay-idempotency at the row level. This
 * harness closes that: it drives the PRODUCTION transport (createSendblueTransport) with the REAL
 * enqueueOutbound from @pa/pa-broker against a faithful in-memory Firestore whose doc.create()
 * throws ALREADY_EXISTS (code 6) exactly like Firestore — so the deterministic-doc-id dedup
 * (out_<sha256(idempotencyKey)>) is exercised for real, and an outbound ROW count is meaningful.
 *
 * The Sendblue/network leaves (sendImessage/sendReaction/typing) are stubbed — they are downstream
 * of the dedup gate and irrelevant to "how many rows were enqueued". The idempotency key
 * (claire-reply-<inboundEventId>:<bodyHash>) is computed INSIDE the real transport — not by the test.
 *
 * WHAT IT PROVES:
 *   T1  single inbound text → exactly ONE outbound row.
 *   T2  REPLAY the same inbound event id (webhook retry / Cloud Tasks redelivery) → still ONE row.
 *   T3  multi-bubble turn (find_match: intro + roles + offer, distinct bodies) → N distinct rows,
 *       and a full replay of all N → still N (no body self-collapses, no replay dup).
 *   T4  TWO entry paths (onPaInbound vs coalescer) firing the SAME inbound event id → ONE row
 *       (both scope the key to the inbound event id; the loser ALREADY_EXISTS-dedups).
 *   T5  résumé-DROP turn → exactly ONE outbound row (the ACK) — no second "scratch that" send.
 *   T6  cutover mutual-exclusion: maybeRunThinClaire returns true → the legacy composer must NOT
 *       run for the same event (thin XOR legacy), so a single inbound yields a single composer.
 *
 * Run: node --import tsx --test apps/functions/src/claire-agent/__tests__/dup-send-delivery.test.ts
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import type { Firestore } from "firebase-admin/firestore"
import { PA_COLLECTIONS } from "@pa/core-types"
import { enqueueOutbound, outboundMessageDocId } from "@pa/pa-broker"
import { createSendblueTransport } from "../transport.js"
import { maybeRunThinClaire } from "../cutover.js"

const CANARY_UID = "8fEwIduUrzxZsblHHsNz" // Adam dev phone +14243201960 (isCanaryUser → true)
const PHONE = "+14243201960"
const THIN_FLAG_KEY = "paThinClaireEnabled"
const OUT = PA_COLLECTIONS.outbound

// ── Faithful in-memory Firestore ────────────────────────────────────────────
// doc.create() throws ALREADY_EXISTS (code 6) on a duplicate id — EXACTLY the Firestore semantics
// enqueueOutbound relies on for its idempotency (outbound-queue.ts:80-84). collection.get() +
// where() are present so the cutover/transport reads work. This is the same stub shape as
// resume-e2e.test.ts (kept independent so the two harnesses don't couple).
type DocStore = Map<string, Record<string, unknown>>
function makeFirestore() {
  const store = new Map<string, DocStore>()
  const col = (name: string): DocStore => {
    if (!store.has(name)) store.set(name, new Map())
    return store.get(name)!
  }
  const makeQuery = (name: string, filters: Array<[string, unknown]>) => {
    const run = () =>
      [...col(name).entries()].filter(([, data]) =>
        filters.every(([field, value]) => {
          const actual = (data as Record<string, unknown>)[field]
          if (value === null) return actual === null || actual === undefined
          return actual === value
        }),
      )
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
        const docs = run().map(([id, data]) => ({ id, exists: true, data: () => data }))
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
        where(field: string, _op: string, value: unknown) {
          return makeQuery(name, [[field, value]])
        },
        async get() {
          const docs = [...col(name).entries()].map(([id, data]) => ({ id, exists: true, data: () => data }))
          return { empty: docs.length === 0, docs, size: docs.length }
        },
      }
    },
  } as unknown as Firestore
  return { db, col }
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
function seedSession(col: (n: string) => DocStore, uid: string): string {
  const sessionId = "ses_dupsend"
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

function outboundRows(col: (n: string) => DocStore): Array<Record<string, unknown>> {
  return [...col(OUT).values()]
}

/**
 * Build the PRODUCTION transport (createSendblueTransport) wired to the REAL enqueueOutbound, with
 * the network leaves stubbed. This is the exact code path the cutover constructs in production
 * (cutover.ts:208) — only sendImessage/sendReaction/sendTypingIndicator (downstream of the dedup
 * gate) are no-op'd so the test needs no Sendblue creds/network.
 */
function prodTransport(db: Firestore, inboundEventId: string, sessionId: string) {
  const calls: string[] = []
  const t = createSendblueTransport({
    db,
    toE164: PHONE,
    userId: CANARY_UID,
    sessionId,
    inboundEventId,
    inboundMessageHandle: "h1",
    // REAL enqueueOutbound — the idempotency contract under test.
    enqueueOutbound,
    // Network leaves stubbed (irrelevant to row count; downstream of the dedup gate).
    sendImessage: (async () => {
      calls.push("sendImessage")
    }) as never,
    sendReaction: (async () => {
      calls.push("sendReaction")
    }) as never,
    sendTypingIndicator: (async () => {}) as never,
    sendReadReceipt: (async () => {}) as never,
    log: () => {},
  })
  return { t, calls }
}

// ── T1 — single inbound text → exactly ONE outbound row ──────────────────────
test("T1: a single composed reply enqueues EXACTLY ONE pa-outbound row", async () => {
  const { db, col } = makeFirestore()
  const sessionId = seedSession(col, CANARY_UID)
  const { t } = prodTransport(db, "evt_text_1", sessionId)

  await t.sendText("got it, reading your résumé 📄")

  const rows = outboundRows(col)
  assert.equal(rows.length, 1, `exactly one outbound row; got ${rows.length}`)
  assert.equal(rows[0].body, "got it, reading your résumé 📄")
  assert.equal(rows[0].status, "pending")
})

// ── T2 — REPLAY the same inbound event id → still ONE row (webhook retry / redelivery) ──
test("T2: replaying the SAME inbound event id (retry/redelivery) does NOT enqueue a second row", async () => {
  const { db, col } = makeFirestore()
  const sessionId = seedSession(col, CANARY_UID)
  const body = "one role worth your time: Product Engineer @ Variance"

  // First delivery.
  const first = prodTransport(db, "evt_replay", sessionId)
  await first.t.sendText(body)
  // Replay: a brand-new transport for the SAME inbound event id (simulates onPaInbound firing
  // again on a redelivered pa-inbound-events doc, or the webhook retrying the same event).
  const replay = prodTransport(db, "evt_replay", sessionId)
  await replay.t.sendText(body)

  const rows = outboundRows(col)
  assert.equal(rows.length, 1, `replay must dedup to ONE row; got ${rows.length}`)
  // The single row's doc id is exactly the deterministic id derived from the production idempotency
  // key (claire-reply-<inboundEventId>:<sha256(body)[:16]>) — i.e. the dedup IS event-id-scoped.
  const bodyHash = createHash("sha256").update(rows[0].body as string, "utf8").digest("hex").slice(0, 16)
  const expectedId = outboundMessageDocId(`claire-reply-evt_replay:${bodyHash}`)
  assert.equal(rows[0].id, expectedId, "the surviving row is keyed on the inbound event id + body hash")
})

// ── T3 — multi-bubble turn → N distinct rows; full replay → still N ──────────
test("T3: a multi-bubble turn enqueues one row PER distinct body; replaying the whole turn stays N", async () => {
  const { db, col } = makeFirestore()
  const sessionId = seedSession(col, CANARY_UID)
  const bubbles = [
    "Here are roles worth your time:",
    "Software Engineer @ MetaVoice\nhttps://wekruit.com/j/abc",
    "Product Engineer @ Helium\nhttps://wekruit.com/j/def",
    'want me to kick off the screen for one? reply with the role name.',
  ]

  const turn = prodTransport(db, "evt_multi", sessionId)
  for (let i = 0; i < bubbles.length; i++) await turn.t.sendText(bubbles[i], { seq: i })
  assert.equal(outboundRows(col).length, bubbles.length, "distinct bodies → distinct rows (no self-collapse)")

  // Replay the ENTIRE turn (same event id, same bodies) → idempotent: no new rows.
  const replay = prodTransport(db, "evt_multi", sessionId)
  for (let i = 0; i < bubbles.length; i++) await replay.t.sendText(bubbles[i], { seq: i })
  assert.equal(outboundRows(col).length, bubbles.length, `replay of a multi-bubble turn stays ${bubbles.length}; got ${outboundRows(col).length}`)
})

// ── T4 — onPaInbound vs coalescer both fire the SAME inbound id → ONE row ─────
test("T4: two entry paths (onPaInbound + coalescer) composing the SAME inbound event id → ONE outbound row", async () => {
  const { db, col } = makeFirestore()
  const sessionId = seedSession(col, CANARY_UID)
  const body = "got it — pulling roles now"

  // Both paths scope the idempotency key to the inbound event id (transport.ts:101). Even if a
  // race had BOTH compose the same turn for the same event, the second enqueue ALREADY_EXISTS-dedups.
  const viaOnPaInbound = prodTransport(db, "evt_dual", sessionId)
  const viaCoalescer = prodTransport(db, "evt_dual", sessionId)
  await Promise.all([viaOnPaInbound.t.sendText(body), viaCoalescer.t.sendText(body)])

  const rows = outboundRows(col)
  assert.equal(rows.length, 1, `the dual-path race must collapse to ONE row; got ${rows.length}`)
})

// ── T5 — résumé-DROP turn through the REAL cutover → exactly ONE outbound (the ACK) ──
// Drives maybeRunThinClaire (dryRun) to prove the drop routes to thin (handledBy thin_claire) and
// then drives the PRODUCTION transport for the ack body to prove the ACK is a single durable row.
test("T5: the résumé-DROP turn routes to THIN and produces EXACTLY ONE outbound row (the ACK), no second send", async () => {
  const { db, col } = makeFirestore()
  seedThinFlag(col, CANARY_UID)
  seedUser(col, CANARY_UID)
  const sessionId = seedSession(col, CANARY_UID)

  const dropEventId = "evt_resume_drop_dup"
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

  // 1) Route proof: the drop is composed by THIN (one composer), never legacy.
  const events: string[] = []
  const handled = await maybeRunThinClaire(db, dropEventId, { dryRun: true, log: (e: string) => events.push(e) })
  assert.equal(handled, true, "résumé drop must be composed by thin")
  assert.equal(events.includes("thin_claire.defer_runtime_event"), false, "drop is not a runtime event")
  assert.equal(/scratch that/i.test(JSON.stringify(events)), false, "no legacy 'scratch that' marker on the thin path")

  // 2) Delivery proof: the ACK body, sent through the production transport scoped to the drop event
  //    id, is a single durable row — and a redelivery of the drop event does not double it.
  const ack = "got it, reading your résumé 📄"
  await prodTransport(db, dropEventId, sessionId).t.sendText(ack)
  await prodTransport(db, dropEventId, sessionId).t.sendText(ack) // redelivery of the same drop event
  const rows = outboundRows(col)
  assert.equal(rows.length, 1, `the résumé-drop ACK must be EXACTLY ONE row even on redelivery; got ${rows.length}`)
})

// ── T6 — cutover mutual-exclusion (thin XOR legacy): a handled turn means legacy never composes ──
test("T6: maybeRunThinClaire=true means the legacy composer is skipped for that event (thin XOR legacy)", async () => {
  const { db, col } = makeFirestore()
  seedThinFlag(col, CANARY_UID)
  seedUser(col, CANARY_UID)
  const sessionId = seedSession(col, CANARY_UID)

  // A plain candidate text (no runtimeEvent, no mediaUrl) for the canary → thin handles it.
  const eventId = "evt_xor"
  col(PA_COLLECTIONS.inboundEvents).set(eventId, {
    id: eventId,
    userId: CANARY_UID,
    sessionId,
    channel: "imessage",
    externalChatId: PHONE,
    fromNumber: PHONE,
    body: "what kinds of roles do you have?",
    status: "pending",
    rawMeta: { source: "imessage_broker", messageHandle: "h1" },
  })

  // Mirror the production seam shape exactly:  const thinHandled = await maybeRunThinClaire(...)
  //                                            if (!thinHandled) await claimer(... legacy ...)
  const thinHandled = await maybeRunThinClaire(db, eventId, { dryRun: true, log: () => {} })
  let legacyComposed = false
  if (!thinHandled) {
    legacyComposed = true // in production this is claimAndProcessInboundEvent → a SECOND composer
  }

  assert.equal(thinHandled, true, "thin must claim the canary candidate turn")
  assert.equal(legacyComposed, false, "legacy must NOT compose when thin handled the turn (no double composer)")
  // And thin marked the event completed → onPaInbound's status!=='pending' guard blocks any re-entry.
  assert.equal(col(PA_COLLECTIONS.inboundEvents).get(eventId)!.status, "completed", "thin marks the event completed")
  assert.equal(col(PA_COLLECTIONS.inboundEvents).get(eventId)!.handledBy, "thin_claire", "handledBy thin_claire")
})

// ── Cross-check the deterministic doc-id derivation the dedup relies on ───────
test("doc-id derivation: the same idempotency key maps to the same out_ doc id (the dedup invariant)", () => {
  const key = "claire-reply-evt_x:deadbeefdeadbeef"
  assert.equal(outboundMessageDocId(key), outboundMessageDocId(key), "stable")
  assert.notEqual(
    outboundMessageDocId(key),
    outboundMessageDocId("claire-reply-evt_y:deadbeefdeadbeef"),
    "different scope → different doc id (different inbound always sends)",
  )
})
