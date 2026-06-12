/**
 * find-match-subscription.test.ts — ENTRY-UX PRD §2.7.1 / §3.2 / §2.9.5 (S6 fix, 2026-06-12).
 *
 * The candidate's post-pitch "yes" manifests as the agent's find_match call — and §2.7.1 says that
 * yes ACTIVATES the job-recommendation subscription. Before this fix the "yes" wrote NOTHING durable
 * (pa-job-profiles stayed null; the subscription only materialized via the consent-blind cadence
 * auto-provision). These guards lock in:
 *
 *   1. find_match (ok) → pa-job-profiles/{uid} row: status=active + recommendationOptIn provenance
 *      (the consent record Claire can read back for "can you keep sending matches?" — §2.9.5).
 *   2. An operator/candidate-PAUSED row is NEVER silently re-activated by an ordinary match request
 *      (set_daily_subscription optedIn=true is the explicit re-enable).
 *   3. A matcher failure (ok:false) stamps nothing.
 *   4. set_daily_subscription writes the SAME consent record on both opt-in and decline (optedIn=false
 *      → status paused), so "no" is durable and the cadence (which never touches existing rows)
 *      cannot text a candidate who declined.
 *   5. The stamp is fail-open — a Firestore error never breaks find_match's RC2 contract.
 *
 * Pure/offline — recording transport, stubbed ctx.findMatch, in-memory doc store. No SDK/LLM/network.
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { buildMatchingTools } from "./matching-tools.js"
import type { ClaireToolContext, FindMatchResult } from "../types.js"

type DocData = Record<string, unknown>

function makeDb(seed: Record<string, DocData> = {}) {
  const docs = new Map<string, DocData>()
  for (const [path, data] of Object.entries(seed)) docs.set(path, structuredClone(data))
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
        docs.set(path, options?.merge ? { ...(prev ?? {}), ...data } : structuredClone(data))
      },
    }
  }
  const db = {
    collection(name: string) {
      return { doc: (id: string) => docRef(name, id) }
    },
    async runTransaction(fn: (tx: unknown) => Promise<unknown>) {
      const tx = {
        get: (ref: { get: () => Promise<unknown> }) => ref.get(),
        set: (
          ref: { set: (d: DocData, o?: { merge?: boolean }) => Promise<void> },
          data: DocData,
          opts?: { merge?: boolean },
        ) => {
          void ref.set(data, opts)
          return tx
        },
      }
      return await fn(tx)
    },
  }
  return { db: db as never, docs }
}

function makeCtx(db: unknown, findMatch: ClaireToolContext["findMatch"]): ClaireToolContext {
  return {
    db,
    userId: "u1",
    sessionId: "s1",
    lang: "en",
    transport: {
      markRead: async () => {},
      typing: async () => {},
      sendStatus: async () => {},
      sendText: async () => {},
      tapback: async () => {},
      noReply: async () => {},
    },
    judgeModel: "gpt-4.1-mini",
    log: () => {},
    nowIso: () => "2026-06-12T00:00:00.000Z",
    findMatch,
  } as unknown as ClaireToolContext
}

function getTool(ctx: ClaireToolContext, name: string) {
  const t = buildMatchingTools(ctx).find((x) => (x as { name?: string }).name === name)
  assert.ok(t, `${name} tool must be registered`)
  return t as { invoke: (a: never, raw: string) => Promise<unknown> }
}
async function invoke(ctx: ClaireToolContext, name: string, args: unknown) {
  const raw = await getTool(ctx, name).invoke({} as never, JSON.stringify(args))
  return (typeof raw === "string" ? JSON.parse(raw) : raw) as Record<string, unknown>
}

const OK_EMPTY: FindMatchResult = { ok: true, recCount: 0, jobs: [], reason: "no fresh roles fit", collab: [] }

test("§2.7.1: 'yes' (find_match ok) writes a DURABLE consent-stamped subscription row", async () => {
  const { db, docs } = makeDb()
  const ctx = makeCtx(db, async () => OK_EMPTY)
  const out = await invoke(ctx, "find_match", { requestedCount: 3 })
  assert.equal(out.ok, true)
  const profile = docs.get("pa-job-profiles/u1") as
    | { status?: string; recommendationOptIn?: { optedIn?: boolean; source?: string; at?: string }; lastJobBatchSentAt?: unknown }
    | undefined
  assert.ok(profile, "pa-job-profiles row must exist after the consent turn — not null until cadence auto-provision")
  assert.equal(profile.status, "active")
  assert.equal(profile.recommendationOptIn?.optedIn, true)
  assert.equal(profile.recommendationOptIn?.source, "candidate_match_request")
  assert.equal(profile.recommendationOptIn?.at, "2026-06-12T00:00:00.000Z")
  assert.equal(profile.lastJobBatchSentAt, null)
})

test("a PAUSED row is NEVER silently re-activated by an ordinary match request (§2.7.3)", async () => {
  const { db, docs } = makeDb({
    "pa-job-profiles/u1": { userId: "u1", status: "paused", createdAt: "2026-06-01T00:00:00.000Z" },
  })
  const ctx = makeCtx(db, async () => OK_EMPTY)
  await invoke(ctx, "find_match", { requestedCount: 3 })
  const profile = docs.get("pa-job-profiles/u1") as { status?: string; recommendationOptIn?: { optedIn?: boolean } }
  assert.equal(profile.status, "paused", "paused stays paused — set_daily_subscription is the explicit re-enable")
  assert.equal(profile.recommendationOptIn?.optedIn, true, "the consent itself is still recorded")
})

test("matcher failure (ok:false) → NO subscription stamp", async () => {
  const { db, docs } = makeDb()
  const ctx = makeCtx(db, async () => ({ ok: false, recCount: 0, jobs: [], reason: "matcher error: boom" }))
  await invoke(ctx, "find_match", { requestedCount: 3 })
  assert.equal(docs.get("pa-job-profiles/u1"), undefined, "no consent recorded on a failed turn")
})

test("§2.9.5: set_daily_subscription records consent on DECLINE (optedIn=false → paused) and re-enable", async () => {
  const { db, docs } = makeDb()
  const ctx = makeCtx(db, async () => OK_EMPTY)

  const declined = await invoke(ctx, "set_daily_subscription", { optedIn: false })
  assert.equal(declined.ok, true)
  assert.equal(declined.jobProfileStatus, "paused")
  let profile = docs.get("pa-job-profiles/u1") as {
    status?: string
    recommendationOptIn?: { optedIn?: boolean; source?: string }
  }
  assert.equal(profile.status, "paused")
  assert.equal(profile.recommendationOptIn?.optedIn, false, "a 'no' is durable — the cadence never touches existing rows")
  assert.equal(profile.recommendationOptIn?.source, "candidate_request")

  // …and a declined candidate is NOT resubscribed by a later one-off match request,
  await invoke(ctx, "find_match", { requestedCount: 3 })
  profile = docs.get("pa-job-profiles/u1") as typeof profile
  assert.equal(profile.status, "paused")

  // …only the explicit re-enable flips it back.
  const reenabled = await invoke(ctx, "set_daily_subscription", { optedIn: true })
  assert.equal(reenabled.jobProfileStatus, "active")
  profile = docs.get("pa-job-profiles/u1") as typeof profile
  assert.equal(profile.status, "active")
  assert.equal(profile.recommendationOptIn?.optedIn, true)
})

test("RC2 fail-open: a Firestore error in the stamp never breaks find_match", async () => {
  const ctx = makeCtx({} as never, async () => OK_EMPTY) // db with no collection/runTransaction
  const out = await invoke(ctx, "find_match", { requestedCount: 3 })
  assert.equal(out.ok, true, "find_match still returns the matcher result")
})
