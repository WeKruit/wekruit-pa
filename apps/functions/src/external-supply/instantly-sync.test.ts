/**
 * Wave C Block F2 — Instantly sync callable tests.
 *
 * Covers:
 *  - Admin auth gate.
 *  - dry_run happy path: sync record persists dryRunPayload + status.
 *  - Live happy path: addLeadToList called + plan bumped to "sent".
 *  - Live mode with env disabled → downgrades to dry_run.
 *  - Live mode with API key missing → downgrades to dry_run.
 *  - Suppression at callable entry (post-approve opt_out) → sync record
 *    persists with status="suppressed", Instantly never called.
 *  - Plan not approved → failed-precondition.
 *  - Client throw on live → sync_failed status + plan bumped to failed.
 *  - Invalid args.
 */

import assert from "node:assert/strict"
import test from "node:test"
import { HttpsError } from "firebase-functions/v2/https"
import type { Firestore } from "firebase-admin/firestore"
import {
  PA_COLLECTIONS,
  type CandidateProfile,
  type OutreachPlan,
} from "@pa/core-types"
import type { AddLeadToListInput, InstantlyClient } from "@pa/external-supply"
import { runSyncPlanToInstantly } from "./instantly-sync.js"

const NOW = "2026-05-13T12:00:00.000Z"
const ADMIN_AUTH = {
  uid: "operator-1",
  token: { email: "admin@wekruit.com", email_verified: true },
}

type Store = Map<string, Map<string, Record<string, unknown>>>

function ensureCol(store: Store, name: string): Map<string, Record<string, unknown>> {
  if (!store.has(name)) store.set(name, new Map())
  return store.get(name)!
}

function makeStore(): Store {
  const map: Store = new Map()
  for (const name of Object.values(PA_COLLECTIONS)) map.set(name, new Map())
  return map
}

function makeFakeFirestore(store: Store = makeStore()): { db: Firestore; store: Store } {
  function docRef(collectionName: string, id: string) {
    return {
      id,
      async get() {
        const data = ensureCol(store, collectionName).get(id)
        return { exists: data !== undefined, id, data: () => data }
      },
      async set(data: Record<string, unknown>, opts?: { merge?: boolean }) {
        const col = ensureCol(store, collectionName)
        const current = col.get(id)
        col.set(id, opts?.merge && current ? { ...current, ...data } : { ...data })
      },
    }
  }
  function collection(collectionName: string) {
    return {
      doc(id: string) {
        return docRef(collectionName, id)
      },
      where(field: string, _op: string, value: unknown) {
        const entries = Array.from(ensureCol(store, collectionName).entries()).filter(
          ([, data]) => data[field] === value,
        )
        return {
          async get() {
            return {
              empty: entries.length === 0,
              docs: entries.map(([id, data]) => ({ id, data: () => data })),
            }
          },
        }
      },
    }
  }
  const db = { collection } as unknown as Firestore
  return { db, store }
}

function seedApprovedPlan(
  store: Store,
  over: Partial<OutreachPlan> = {},
): OutreachPlan {
  const plan: OutreachPlan = {
    planId: "plan-1",
    candidateId: "c1",
    companyId: "co1",
    jobId: "j1",
    evaluationId: "e1",
    tier: "tier_2_personal_email",
    channelDecision: "personal_email",
    personalizedHook: "Hi Ada, custom hook.",
    emailSubject: "Quick chat?",
    emailBody: "Hi Ada, ...",
    approvalStatus: "approved",
    approvedBy: "operator-1",
    approvedAt: NOW,
    suppressionGateResult: {
      allow: true,
      blockedReasons: [],
    },
    evidence: [],
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  }
  ensureCol(store, PA_COLLECTIONS.outreachPlans).set(plan.planId, plan as unknown as Record<string, unknown>)
  return plan
}

function seedProfile(store: Store, candidateId: string, over: Partial<CandidateProfile> = {}) {
  ensureCol(store, PA_COLLECTIONS.users).set(candidateId, {
    candidateId,
    candidateLifecycleState: "profile_ready",
    createdAt: NOW,
    outreach: { status: "allowed" },
    ...over,
  })
}

function seedEmailHandle(store: Store, candidateId: string, email: string) {
  ensureCol(store, PA_COLLECTIONS.candidateHandles).set(`handle-${candidateId}`, {
    handleId: `handle-${candidateId}`,
    candidateId,
    kind: "email",
    handleHash: "h".repeat(32),
    normalizedValue: email,
    source: "external_sourcing",
    createdAt: NOW,
  })
}

function captureClient() {
  const calls: { input: AddLeadToListInput; mode: "dry_run" | "live" }[] = []
  let nextLeadId = "lead-success"
  let shouldThrow = false
  const client: InstantlyClient = {
    async addLeadToList(input, opts) {
      calls.push({ input, mode: opts.mode })
      if (shouldThrow) {
        throw new Error("instantly_request_failed:500")
      }
      if (opts.mode === "dry_run") return { payload: input }
      return { payload: input, result: { instantlyLeadId: nextLeadId, raw: {} } }
    },
    async listCampaigns() {
      return []
    },
    async getLead() {
      return {}
    },
    async markUnsubscribed() {
      // noop
    },
  }
  return {
    client,
    calls,
    setLeadId(id: string) {
      nextLeadId = id
    },
    setThrow(v: boolean) {
      shouldThrow = v
    },
  }
}

// ---------------------------------------------------------------------------
// Auth + invalid args
// ---------------------------------------------------------------------------

test("syncPlanToInstantly — rejects unauthenticated", async () => {
  const { db } = makeFakeFirestore()
  await assert.rejects(
    () =>
      runSyncPlanToInstantly(
        { planId: "p", mode: "dry_run" },
        undefined,
        { db, now: () => NOW },
      ),
    (err) => err instanceof HttpsError && err.code === "unauthenticated",
  )
})

test("syncPlanToInstantly — invalid mode rejected", async () => {
  const { db } = makeFakeFirestore()
  await assert.rejects(
    () =>
      runSyncPlanToInstantly(
        { planId: "p", mode: "shadow" },
        ADMIN_AUTH,
        { db, now: () => NOW },
      ),
    (err) => err instanceof HttpsError && err.code === "invalid-argument",
  )
})

// ---------------------------------------------------------------------------
// State guards
// ---------------------------------------------------------------------------

test("syncPlanToInstantly — plan in draft rejects with failed-precondition", async () => {
  const { db, store } = makeFakeFirestore()
  seedApprovedPlan(store, { approvalStatus: "draft" })
  await assert.rejects(
    () =>
      runSyncPlanToInstantly(
        { planId: "plan-1", mode: "dry_run" },
        ADMIN_AUTH,
        { db, now: () => NOW },
      ),
    (err) => err instanceof HttpsError && err.code === "failed-precondition",
  )
})

// ---------------------------------------------------------------------------
// dry_run happy path
// ---------------------------------------------------------------------------

test("syncPlanToInstantly — dry_run persists payload + status, plan unchanged", async () => {
  const { db, store } = makeFakeFirestore()
  seedApprovedPlan(store)
  seedProfile(store, "c1")
  seedEmailHandle(store, "c1", "ada@example.com")
  const cap = captureClient()

  const out = await runSyncPlanToInstantly(
    { planId: "plan-1", mode: "dry_run", listId: "list-1", campaignId: "camp-1" },
    ADMIN_AUTH,
    {
      db,
      now: () => NOW,
      newId: () => "sync-1",
      makeClient: () => cap.client,
    },
  )
  assert.equal(out.syncStatus, "dry_run_planned")
  assert.equal(out.mode, "dry_run")
  assert.equal(cap.calls.length, 1)
  assert.equal(cap.calls[0]!.mode, "dry_run")
  assert.equal(cap.calls[0]!.input.email, "ada@example.com")
  assert.equal(cap.calls[0]!.input.listId, "list-1")
  assert.equal(cap.calls[0]!.input.campaignId, "camp-1")
  const persisted = ensureCol(store, PA_COLLECTIONS.instantlySyncRecords).get("sync-1")
  assert.ok(persisted)
  assert.equal(persisted!.syncStatus, "dry_run_planned")
  assert.ok(persisted!.dryRunPayload)
  // Plan still approved.
  const plan = ensureCol(store, PA_COLLECTIONS.outreachPlans).get("plan-1")
  assert.equal(plan!.approvalStatus, "approved")
})

// ---------------------------------------------------------------------------
// live happy path
// ---------------------------------------------------------------------------

test("syncPlanToInstantly — live happy path bumps plan to sent + persists synced record", async () => {
  const { db, store } = makeFakeFirestore()
  seedApprovedPlan(store)
  seedProfile(store, "c1")
  seedEmailHandle(store, "c1", "ada@example.com")
  const cap = captureClient()
  cap.setLeadId("ll-live")

  const env = {
    EXTERNAL_SUPPLY_LIVE_OUTREACH_ENABLED: "true",
    INSTANTLY_API_KEY: "real-key",
  }
  const out = await runSyncPlanToInstantly(
    { planId: "plan-1", mode: "live", listId: "list-live", campaignId: "camp-live" },
    ADMIN_AUTH,
    {
      db,
      now: () => NOW,
      newId: () => "sync-live",
      readEnv: (k) => env[k as keyof typeof env],
      makeClient: () => cap.client,
    },
  )
  assert.equal(out.syncStatus, "synced")
  assert.equal(out.mode, "live")
  assert.equal(out.instantlyLeadId, "ll-live")
  assert.equal(cap.calls[0]!.mode, "live")
  const persisted = ensureCol(store, PA_COLLECTIONS.instantlySyncRecords).get("sync-live")
  assert.equal(persisted!.syncStatus, "synced")
  assert.equal(persisted!.instantlyLeadId, "ll-live")
  const plan = ensureCol(store, PA_COLLECTIONS.outreachPlans).get("plan-1")
  assert.equal(plan!.approvalStatus, "sent")
})

// ---------------------------------------------------------------------------
// Env-gate downgrades
// ---------------------------------------------------------------------------

test("syncPlanToInstantly — live mode without env flag silently downgrades to dry_run", async () => {
  const { db, store } = makeFakeFirestore()
  seedApprovedPlan(store)
  seedProfile(store, "c1")
  seedEmailHandle(store, "c1", "ada@example.com")
  const cap = captureClient()
  const out = await runSyncPlanToInstantly(
    { planId: "plan-1", mode: "live", listId: "l" },
    ADMIN_AUTH,
    {
      db,
      now: () => NOW,
      newId: () => "sync-dg",
      readEnv: (k) => (k === "INSTANTLY_API_KEY" ? "key" : undefined),
      makeClient: () => cap.client,
    },
  )
  assert.equal(out.syncStatus, "dry_run_planned")
  assert.equal(out.mode, "dry_run")
  assert.equal(out.downgraded, true)
  assert.equal(out.downgradedReason, "live_outreach_flag_disabled")
  // Plan still approved.
  const plan = ensureCol(store, PA_COLLECTIONS.outreachPlans).get("plan-1")
  assert.equal(plan!.approvalStatus, "approved")
})

test("syncPlanToInstantly — live mode without API key silently downgrades", async () => {
  const { db, store } = makeFakeFirestore()
  seedApprovedPlan(store)
  seedProfile(store, "c1")
  seedEmailHandle(store, "c1", "ada@example.com")
  const cap = captureClient()
  const out = await runSyncPlanToInstantly(
    { planId: "plan-1", mode: "live", listId: "l" },
    ADMIN_AUTH,
    {
      db,
      now: () => NOW,
      newId: () => "sync-dg",
      readEnv: (k) => (k === "EXTERNAL_SUPPLY_LIVE_OUTREACH_ENABLED" ? "true" : undefined),
      makeClient: () => cap.client,
    },
  )
  assert.equal(out.syncStatus, "dry_run_planned")
  assert.equal(out.downgraded, true)
  assert.equal(out.downgradedReason, "instantly_api_key_missing")
})

// ---------------------------------------------------------------------------
// Suppression at callable entry
// ---------------------------------------------------------------------------

test("syncPlanToInstantly — fresh opt_out suppresses at entry; Instantly never called", async () => {
  const { db, store } = makeFakeFirestore()
  seedApprovedPlan(store)
  // Candidate opted out AFTER plan was approved.
  seedProfile(store, "c1", { outreach: { status: "opted_out" } })
  seedEmailHandle(store, "c1", "ada@example.com")
  const cap = captureClient()
  const out = await runSyncPlanToInstantly(
    { planId: "plan-1", mode: "dry_run", listId: "l" },
    ADMIN_AUTH,
    {
      db,
      now: () => NOW,
      newId: () => "sync-supp",
      makeClient: () => cap.client,
    },
  )
  assert.equal(out.syncStatus, "suppressed")
  assert.equal(cap.calls.length, 0, "Instantly client must NOT be called when suppressed")
  const persisted = ensureCol(store, PA_COLLECTIONS.instantlySyncRecords).get("sync-supp")
  assert.equal(persisted!.syncStatus, "suppressed")
  assert.ok((persisted!.error as string).includes("opted_out"))
})

// ---------------------------------------------------------------------------
// Live failure
// ---------------------------------------------------------------------------

test("syncPlanToInstantly — live throw is captured as sync_failed + plan bumped to failed", async () => {
  const { db, store } = makeFakeFirestore()
  seedApprovedPlan(store)
  seedProfile(store, "c1")
  seedEmailHandle(store, "c1", "ada@example.com")
  const cap = captureClient()
  cap.setThrow(true)
  const env = {
    EXTERNAL_SUPPLY_LIVE_OUTREACH_ENABLED: "true",
    INSTANTLY_API_KEY: "real-key",
  }
  const out = await runSyncPlanToInstantly(
    { planId: "plan-1", mode: "live", listId: "l" },
    ADMIN_AUTH,
    {
      db,
      now: () => NOW,
      newId: () => "sync-fail",
      readEnv: (k) => env[k as keyof typeof env],
      makeClient: () => cap.client,
    },
  )
  assert.equal(out.syncStatus, "sync_failed")
  const persisted = ensureCol(store, PA_COLLECTIONS.instantlySyncRecords).get("sync-fail")
  assert.equal(persisted!.syncStatus, "sync_failed")
  assert.ok((persisted!.error as string).length > 0)
  const plan = ensureCol(store, PA_COLLECTIONS.outreachPlans).get("plan-1")
  assert.equal(plan!.approvalStatus, "failed")
})
