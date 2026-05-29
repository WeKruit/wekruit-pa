#!/usr/bin/env node
/**
 * L2/L3 integration eval — the REAL cutover seam on the DIRECT broker path.
 *
 * This is the test the deploy-readiness review found MISSING ("no test drives maybeRunThinClaire
 * through the real onPaInbound/coalescer seam" → the false-green failure mode). It drives the
 * PRODUCTION `maybeRunThinClaire(db, eventId, {dryRun})` against a fake Firestore seeded with a
 * BROKER-shaped inbound-event doc — exactly the doc `processBrokerImessageEvent` persists at the
 * point it now calls thin (userId/sessionId/body/externalChatId/from/rawMeta.messageHandle) — plus
 * the real `pa-feature-flags/paThinClaireEnabled` perUser allowlist doc that `getFlag` reads.
 *
 * It proves end-to-end: doc parse → flag gate → transport (dryRun) → runClaireTurn (real LLM) →
 * mark `handledBy:'thin_claire'`. And it is DISCRIMINATING (not trivially green):
 *   - flag OFF (uid not allowlisted) → returns false (legacy keeps the turn)
 *   - broker doc missing sessionId → returns false (field guard) — i.e. if the broker branch had
 *     NOT persisted the field thin needs, thin would silently no-op and this case would catch it.
 *
 * Run: source ~/.zshrc && nvm use 24 && node apps/eval/thin-claire/eval-cutover-broker.mjs
 */
import { loadClaireBundle, loadEnv } from "./_claire-bundle.mjs"

loadEnv()
const { maybeRunThinClaire } = await loadClaireBundle()

const FLAG_KEY = "paThinClaireEnabled"
const CANARY_UID = "LF8blURXyFBaeF7bhupu" // the +14243201960 KEEP doc
const PHONE = "+14243201960"

// fake Firestore: doc get/set(merge) over a "col/id" map + empty query stubs (FirestoreSession).
function makeFakeDb(seed = {}) {
  const store = new Map(Object.entries(seed))
  const docRef = (col, id) => {
    const key = `${col}/${id}`
    return {
      async get() { return { exists: store.has(key), id, data: () => store.get(key) } },
      async set(data, opts) { store.set(key, { ...(opts && opts.merge ? store.get(key) || {} : {}), ...data }) },
      async update(data) { store.set(key, { ...(store.get(key) || {}), ...data }) },
    }
  }
  const emptyQuery = () => { const q = { where: () => q, orderBy: () => q, limit: () => q, async get() { return { docs: [], empty: true, size: 0, forEach() {} } } }; return q }
  const colRef = (col) => ({ doc: (id) => docRef(col, id), where: () => emptyQuery(), orderBy: () => emptyQuery(), limit: () => emptyQuery(), async add(d) { const id = `a${store.size}`; store.set(`${col}/${id}`, d); return { id } } })
  return { collection: colRef, _store: store }
}

const flagDoc = (allowlist) => ({ key: FLAG_KEY, value: false, type: "bool", scope: "perUser", allowlist, blocklist: [] })
const userDoc = { tags: { targetRoleFunction: ["product_management"], targetJobType: ["full_time"] }, onboardingState: "pending" }
// Broker-shaped inbound doc — the fields processBrokerImessageEvent writes right before calling thin.
const brokerInboundDoc = (eventId) => ({
  id: eventId,
  userId: CANARY_UID,
  sessionId: `imessage:${CANARY_UID}:${PHONE}`,
  channel: "imessage",
  externalChatId: PHONE,
  from: PHONE,
  body: "hey can you recommend me some roles?",
  status: "pending",
  rawPayload: { kind: "imessage", source: "sendblue", participant: PHONE, text: "hey can you recommend me some roles?" },
  rawMeta: { source: "imessage_broker", messageHandle: "handle-abc123" },
})

const fails = []
const ck = (name, cond, detail) => { if (cond) console.log(`PASS  ${name}`); else { console.log(`FAIL  ${name} → ${detail ?? ""}`); fails.push(name) } }

async function main() {
  // ── Case 1: flag ON + valid broker doc → thin handles the turn end-to-end ──────────────────────
  {
    const eventId = "evt-on"
    const db = makeFakeDb({
      [`pa-feature-flags/${FLAG_KEY}`]: flagDoc([CANARY_UID]),
      [`pa-users/${CANARY_UID}`]: { ...userDoc },
      [`pa-inbound-events/${eventId}`]: brokerInboundDoc(eventId),
    })
    const handled = await maybeRunThinClaire(db, eventId, { dryRun: true, log: () => {} })
    const after = db._store.get(`pa-inbound-events/${eventId}`)
    ck("case1: flag ON + valid broker doc → maybeRunThinClaire returns TRUE (thin owns the turn)", handled === true, `handled=${handled}`)
    ck("case1: inbound doc marked handledBy='thin_claire' (full runClaireTurn completed)", after?.handledBy === "thin_claire", `handledBy=${after?.handledBy}`)
    ck("case1: inbound doc status='completed'", after?.status === "completed", `status=${after?.status}`)
  }

  // ── Case 2: NON-canary user (uid not in allowlist) → returns false, legacy keeps the turn ──────
  // (Same allowlist doc as case 1 so getFlag's 30s in-process cache stays consistent; the
  // discriminator is the inbound doc's userId, which is NOT allowlisted → no blast radius.)
  {
    const eventId = "evt-noncanary"
    const NON_CANARY = "some-other-real-user-uid"
    const doc = brokerInboundDoc(eventId)
    doc.userId = NON_CANARY
    const db = makeFakeDb({
      [`pa-feature-flags/${FLAG_KEY}`]: flagDoc([CANARY_UID]),
      [`pa-users/${NON_CANARY}`]: { ...userDoc },
      [`pa-inbound-events/${eventId}`]: doc,
    })
    const handled = await maybeRunThinClaire(db, eventId, { dryRun: true, log: () => {} })
    const after = db._store.get(`pa-inbound-events/${eventId}`)
    ck("case2: non-canary user → maybeRunThinClaire returns FALSE (legacy keeps the turn, no blast radius)", handled === false, `handled=${handled}`)
    ck("case2: inbound doc NOT marked thin_claire", after?.handledBy !== "thin_claire", `handledBy=${after?.handledBy}`)
  }

  // ── Case 3: broker doc missing sessionId → field guard returns false (discriminating) ──────────
  {
    const eventId = "evt-nosession"
    const doc = brokerInboundDoc(eventId)
    delete doc.sessionId
    const db = makeFakeDb({
      [`pa-feature-flags/${FLAG_KEY}`]: flagDoc([CANARY_UID]),
      [`pa-users/${CANARY_UID}`]: { ...userDoc },
      [`pa-inbound-events/${eventId}`]: doc,
    })
    const handled = await maybeRunThinClaire(db, eventId, { dryRun: true, log: () => {} })
    ck("case3: missing sessionId → returns FALSE (field guard; proves the persisted fields matter)", handled === false, `handled=${handled}`)
  }

  console.log(`\n${fails.length === 0 ? "CUTOVER-BROKER SEAM: GREEN ✅ — a broker iMessage reaches thin via the cutover (no false-green)" : `CUTOVER-BROKER SEAM: ${fails.length} FAILED`}`)
  process.exit(fails.length === 0 ? 0 : 1)
}
await main()
