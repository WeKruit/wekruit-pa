/**
 * mode-selector-zombie-prescreen.test.ts — the secondary (thin-Claire) active-prescreen detector
 * must honor the createdAt-keyed absolute age cap so a ZOMBIE prescreen session (terminal=null,
 * stuck on Q1, updatedAt self-refreshed by clarify-loop captures) does NOT route unrelated future
 * turns (job-rec "yes") into the prescreen runner.
 *
 * Live failure (Adam 2026-06-21): +19196415056 /
 * ps_hs-10996795-invoko-product-manager_JQct3rmfvUkCDsHypkss_… — created 06-18, updatedAt 06-21,
 * currentQId q_consumer_product_experience, never scored. The candidate moved on to job recs and
 * replied "yes" → Claire kept asking prescreen probes for days.
 *
 * Run: node --import tsx --test apps/functions/src/claire-agent/mode-selector-zombie-prescreen.test.ts
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { selectClaireMode } from "./mode-selector.js"

const NONCANARY_UID = "u_zombie_noncanary"

/**
 * Firestore stub that serves ONE non-terminal prescreen session (the zombie) plus a minimal
 * pa-users doc. Records the prescreen .ref.set() so we can assert the stale sweep, and the mode
 * decision so we can assert the turn fell through (NOT routed to prescreen).
 */
function makeDb(session: Record<string, unknown>) {
  const prescreenWrites: Array<Record<string, unknown>> = []
  let sessionData = { ...session }
  const userDoc = { tags: {} as Record<string, unknown> }

  const sessionDoc = {
    id: String(session.sessionId ?? "ps_zombie"),
    ref: {
      async set(patch: Record<string, unknown>, opts?: { merge?: boolean }) {
        prescreenWrites.push(patch)
        sessionData = opts?.merge ? { ...sessionData, ...patch } : { ...patch }
      },
    },
    data: () => sessionData,
  }

  const db = {
    collection(name: string) {
      if (name === "pa-prescreen-sessions") {
        return {
          where() {
            return this
          },
          limit() {
            return this
          },
          orderBy() {
            return this
          },
          async get() {
            // terminal==null query → returns the zombie until it is swept.
            if (sessionData.terminal === null) return { empty: false, docs: [sessionDoc] }
            return { empty: true, docs: [] }
          },
        }
      }
      // pa-users (and anything else) → minimal doc, no active onboarding.
      return {
        where() {
          return { async get() { return { empty: true, docs: [] } } }
        },
        doc() {
          return {
            async get() {
              return { exists: true, data: () => userDoc }
            },
            async set() {
              /* ignore */
            },
          }
        },
      }
    },
  } as never

  return { db, prescreenWrites: () => prescreenWrites, sessionData: () => sessionData }
}

test("mode-selector → ZOMBIE prescreen (createdAt stale, updatedAt fresh) is swept + turn NOT routed to prescreen", async () => {
  const createdStale = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString() // 3 days
  const updatedFresh = new Date(Date.now() - 30 * 1000).toISOString() // self-refreshed 30s ago
  const { db, prescreenWrites, sessionData } = makeDb({
    sessionId: "ps_zombie",
    userId: NONCANARY_UID,
    jobId: "hs-10996795-invoko-product-manager",
    terminal: null,
    currentQId: "q_consumer_product_experience",
    createdAt: createdStale,
    updatedAt: updatedFresh,
  })

  const decision = await selectClaireMode({ db, userId: NONCANARY_UID, inboundText: "yes" })

  // Turn fell through to a conversational mode (NOT prescreen / NOT deferToLegacy).
  assert.notEqual(decision.mode, "prescreen")
  assert.notEqual(decision.deferToLegacy, true)

  // Stale session swept to a terminal so it stops interfering.
  const writes = prescreenWrites()
  assert.equal(writes.length >= 1, true)
  const sd = sessionData()
  assert.equal(sd.terminal, "PAUSE")
  assert.equal(sd.terminalReason, "expired_inactive_prescreen_session")
  assert.equal(sd.currentQId, null)
})

test("mode-selector → RECENT non-terminal prescreen still defers to legacy (no regression)", async () => {
  const recent = new Date(Date.now() - 10 * 60 * 1000).toISOString() // 10min — a real sitting
  const { db } = makeDb({
    sessionId: "ps_live",
    userId: NONCANARY_UID,
    jobId: "hs-10996795-invoko-product-manager",
    terminal: null,
    currentQId: "q_consumer_product_experience",
    createdAt: recent,
    updatedAt: recent,
  })

  const decision = await selectClaireMode({ db, userId: NONCANARY_UID, inboundText: "I shipped a checkout flow" })

  // Active prescreen owns the turn — thin defers to the deterministic legacy runner (flag off → defer).
  assert.equal(decision.mode, "prescreen")
  assert.equal(decision.deferToLegacy, true)
  assert.equal(decision.jobId, "hs-10996795-invoko-product-manager")
})
