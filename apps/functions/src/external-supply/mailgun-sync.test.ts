/**
 * Tests for the Mailgun sync callable (`runSyncPlanToMailgun`).
 *
 * Mirrors the relevant Instantly-sync test scenarios but exercises the
 * Mailgun-specific dry-run payload shape + live-mode env gate.
 */

import assert from "node:assert/strict"
import test from "node:test"
import { HttpsError } from "firebase-functions/v2/https"
import type { Firestore } from "firebase-admin/firestore"
import {
  MailgunSyncRecordSchema,
  OutreachPlanSchema,
  PA_COLLECTIONS,
  type CandidateProfile,
  type OutreachPlan,
} from "@pa/core-types"
import { runSyncPlanToMailgun } from "./mailgun-sync.js"

const NOW = "2026-05-14T12:00:00.000Z"
const ADMIN_AUTH = {
  uid: "operator-1",
  token: { email: "ops@wekruit.com", email_verified: true },
}

// ---------------------------------------------------------------------------
// In-memory Firestore fake (mirror the shape used by instantly-sync.test.ts)
// ---------------------------------------------------------------------------

type Store = Map<string, Map<string, Record<string, unknown>>>

function makeStore(): Store {
  return new Map(Object.values(PA_COLLECTIONS).map((name) => [name, new Map()]))
}

function ensureCol(store: Store, name: string): Map<string, Record<string, unknown>> {
  let col = store.get(name)
  if (!col) {
    col = new Map()
    store.set(name, col)
  }
  return col
}

function makeFakeDb(store: Store): Firestore {
  const collection = (name: string) => {
    const col = ensureCol(store, name)
    const docRef = (id: string) => ({
      async get() {
        const data = col.get(id)
        return {
          exists: data !== undefined,
          data: () => data,
        }
      },
      async set(value: Record<string, unknown>, opts?: { merge?: boolean }) {
        const prior = col.get(id) ?? {}
        col.set(id, opts?.merge ? { ...prior, ...value } : value)
      },
    })
    const query = {
      where(_field: string, _op: string, _value: unknown) {
        return query
      },
      limit(_n: number) {
        return query
      },
      orderBy(_field: string, _dir?: string) {
        return query
      },
      async get() {
        return { empty: true, docs: [] as Array<{ data(): Record<string, unknown> }> }
      },
    }
    return {
      doc: docRef,
      ...query,
    }
  }
  return { collection } as unknown as Firestore
}

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function seedApprovedPlan(store: Store, over: Partial<OutreachPlan> = {}): OutreachPlan {
  const base: OutreachPlan = {
    planId: "plan-1",
    candidateId: "cand-1",
    companyId: "co-1",
    jobId: "job-1",
    evaluationId: "eval-1",
    tier: "tier_2_personal_email",
    channelDecision: "personal_email",
    personalizedHook: "I saw your recent Stripe payments work.",
    emailSubject: "Quick chat about Co-1?",
    emailBody: "Hi {firstName}, quick note about a role at Co-1.",
    approvalStatus: "approved",
    suppressionGateResult: { allow: true, blockedReasons: [] },
    evidence: [],
    createdAt: NOW,
    ...over,
  }
  ensureCol(store, PA_COLLECTIONS.outreachPlans).set(
    base.planId,
    OutreachPlanSchema.parse(base) as unknown as Record<string, unknown>,
  )
  return base
}

function seedProfile(
  store: Store,
  candidateId: string,
  over: Partial<CandidateProfile> = {},
): void {
  ensureCol(store, PA_COLLECTIONS.users).set(candidateId, {
    candidateId,
    candidateLifecycleState: "profile_ready",
    createdAt: NOW,
    linkedinUrl: "https://linkedin.com/in/cand-1",
    outreach: { status: "allowed" },
    ...over,
  } as unknown as Record<string, unknown>)
}

function seedEmailHandle(store: Store, candidateId: string, email: string): void {
  ensureCol(store, PA_COLLECTIONS.candidateHandles).set(`email__${email}`, {
    handleId: `email__${email}`,
    candidateId,
    kind: "email",
    handleHash: "h".repeat(64),
    normalizedValue: email,
    source: "external_sourcing",
    createdAt: NOW,
    verifiedAt: NOW,
  })
}

// Override the limited fake's `.where(...).get()` for the email-handle path.
// We rebuild a richer fake when we need that query to actually return rows.
function makeFakeDbWithHandles(store: Store): Firestore {
  const collection = (name: string) => {
    const col = ensureCol(store, name)
    const filters: Array<[string, string, unknown]> = []
    const builder = {
      doc(id: string) {
        return {
          async get() {
            const data = col.get(id)
            return { exists: data !== undefined, data: () => data }
          },
          async set(value: Record<string, unknown>, opts?: { merge?: boolean }) {
            const prior = col.get(id) ?? {}
            col.set(id, opts?.merge ? { ...prior, ...value } : value)
          },
        }
      },
      where(field: string, op: string, value: unknown) {
        filters.push([field, op, value])
        return builder
      },
      limit(_n: number) {
        return builder
      },
      orderBy(_f: string, _d?: string) {
        return builder
      },
      async get() {
        const docs: Array<{ data(): Record<string, unknown> }> = []
        for (const [, row] of col.entries()) {
          const match = filters.every(([f, op, v]) => {
            const left = (row as Record<string, unknown>)[f]
            return op === "==" ? left === v : true
          })
          if (match) docs.push({ data: () => row })
        }
        return { empty: docs.length === 0, docs }
      },
    }
    return builder
  }
  return { collection } as unknown as Firestore
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("rejects unauthenticated callers", async () => {
  const store = makeStore()
  const db = makeFakeDb(store)
  await assert.rejects(
    () =>
      runSyncPlanToMailgun(
        { planId: "plan-1", mode: "dry_run" },
        undefined,
        { db, now: () => NOW, newId: () => "sync-1", readEnv: () => undefined },
      ),
    (err) => err instanceof HttpsError && err.code === "unauthenticated",
  )
})

test("rejects when plan is not approved", async () => {
  const store = makeStore()
  seedApprovedPlan(store, { approvalStatus: "draft" })
  seedProfile(store, "cand-1")
  seedEmailHandle(store, "cand-1", "alice@example.test")
  const db = makeFakeDbWithHandles(store)
  await assert.rejects(
    () =>
      runSyncPlanToMailgun({ planId: "plan-1", mode: "dry_run" }, ADMIN_AUTH, {
        db,
        now: () => NOW,
        newId: () => "sync-1",
        readEnv: () => undefined,
      }),
    (err) => err instanceof HttpsError && err.code === "failed-precondition",
  )
})

test("dry-run records the exact send payload + skips network", async () => {
  const store = makeStore()
  seedApprovedPlan(store)
  seedProfile(store, "cand-1")
  seedEmailHandle(store, "cand-1", "alice@example.test")
  const db = makeFakeDbWithHandles(store)
  let sendCalled = false
  const result = await runSyncPlanToMailgun(
    { planId: "plan-1", mode: "dry_run" },
    ADMIN_AUTH,
    {
      db,
      now: () => NOW,
      newId: () => "sync-1",
      readEnv: () => undefined,
      sendMail: async () => {
        sendCalled = true
        return { ok: true, status: 200, messageId: "msg-1" }
      },
    },
  )
  assert.equal(sendCalled, false)
  assert.equal(result.syncStatus, "dry_run_planned")
  const written = ensureCol(store, PA_COLLECTIONS.mailgunSyncRecords).get("sync-1") as
    | Record<string, unknown>
    | undefined
  assert.ok(written)
  const parsed = MailgunSyncRecordSchema.parse(written)
  assert.equal(parsed.mode, "dry_run")
  assert.ok(parsed.dryRunPayload)
  assert.equal(parsed.dryRunPayload!.to, "alice@example.test")
  assert.equal(parsed.dryRunPayload!.subject, "Quick chat about Co-1?")
})

test("live mode downgrades to dry-run when env not configured", async () => {
  const store = makeStore()
  seedApprovedPlan(store)
  seedProfile(store, "cand-1")
  seedEmailHandle(store, "cand-1", "alice@example.test")
  const db = makeFakeDbWithHandles(store)
  let sendCalled = false
  const result = await runSyncPlanToMailgun(
    { planId: "plan-1", mode: "live" },
    ADMIN_AUTH,
    {
      db,
      now: () => NOW,
      newId: () => "sync-2",
      readEnv: () => undefined, // no env vars set
      sendMail: async () => {
        sendCalled = true
        return { ok: true, status: 200 }
      },
    },
  )
  assert.equal(sendCalled, false)
  assert.equal(result.mode, "dry_run")
  assert.equal(result.syncStatus, "dry_run_planned")
  assert.equal(result.downgraded, true)
  assert.equal(result.downgradedReason, "live_outreach_flag_disabled")
})

test("live mode sends via mailgun + flips plan to sent on success", async () => {
  const store = makeStore()
  seedApprovedPlan(store)
  seedProfile(store, "cand-1")
  seedEmailHandle(store, "cand-1", "alice@example.test")
  const db = makeFakeDbWithHandles(store)
  let received: { to: string; subject: string } | null = null as { to: string; subject: string } | null
  const env: Record<string, string> = {
    EXTERNAL_SUPPLY_LIVE_OUTREACH_ENABLED: "true",
    MAILGUN_API_KEY: "key-1",
    MAILGUN_DOMAIN: "mg.example.test",
    MAILGUN_FROM: "claire@mg.example.test",
  }
  const result = await runSyncPlanToMailgun(
    { planId: "plan-1", mode: "live" },
    ADMIN_AUTH,
    {
      db,
      now: () => NOW,
      newId: () => "sync-3",
      readEnv: (k) => env[k],
      sendMail: async (_cfg, input) => {
        received = { to: input.to, subject: input.subject }
        return { ok: true, status: 200, messageId: "mg-msg-1" }
      },
    },
  )
  assert.equal(result.syncStatus, "synced")
  assert.equal(result.mode, "live")
  assert.equal(result.mailgunMessageId, "mg-msg-1")
  assert.ok(received)
  assert.equal(received!.to, "alice@example.test")
  // Plan should have flipped to "sent".
  const planRow = ensureCol(store, PA_COLLECTIONS.outreachPlans).get("plan-1") as
    | Record<string, unknown>
    | undefined
  assert.ok(planRow)
  assert.equal((planRow as { approvalStatus?: string }).approvalStatus, "sent")
})

test("live mode failure records sync_failed + flips plan to failed", async () => {
  const store = makeStore()
  seedApprovedPlan(store)
  seedProfile(store, "cand-1")
  seedEmailHandle(store, "cand-1", "alice@example.test")
  const db = makeFakeDbWithHandles(store)
  const env: Record<string, string> = {
    EXTERNAL_SUPPLY_LIVE_OUTREACH_ENABLED: "true",
    MAILGUN_API_KEY: "key-1",
    MAILGUN_DOMAIN: "mg.example.test",
    MAILGUN_FROM: "claire@mg.example.test",
  }
  const result = await runSyncPlanToMailgun(
    { planId: "plan-1", mode: "live" },
    ADMIN_AUTH,
    {
      db,
      now: () => NOW,
      newId: () => "sync-4",
      readEnv: (k) => env[k],
      sendMail: async () => ({ ok: false, status: 401, rawResponse: "{\"error\":\"unauth\"}" }),
    },
  )
  assert.equal(result.syncStatus, "sync_failed")
  const planRow = ensureCol(store, PA_COLLECTIONS.outreachPlans).get("plan-1") as
    | Record<string, unknown>
    | undefined
  assert.equal((planRow as { approvalStatus?: string }).approvalStatus, "failed")
  const syncRow = ensureCol(store, PA_COLLECTIONS.mailgunSyncRecords).get("sync-4") as
    | Record<string, unknown>
    | undefined
  assert.ok(syncRow)
  assert.match(String((syncRow as { error?: string }).error), /mailgun_401/)
})
