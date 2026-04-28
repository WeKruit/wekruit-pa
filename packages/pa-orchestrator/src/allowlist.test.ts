import assert from "node:assert/strict"
import test from "node:test"
import type { Firestore } from "firebase-admin/firestore"
import { PA_COLLECTIONS } from "@pa/core-types"
import {
  resolveAllowlist,
  isAllowlisted,
  recordAllowlistDeny,
} from "./allowlist.js"

type StoredDoc = Record<string, unknown>

function fakeFirestore() {
  const store = new Map<string, StoredDoc>()
  const queries: Array<{ collection: string; where: [string, string, unknown]; result: StoredDoc[] }> = []

  function setQueryResult(collection: string, field: string, op: string, value: unknown, docs: StoredDoc[]) {
    queries.push({ collection, where: [field, op, value], result: docs })
  }

  function docPath(col: string, id: string) {
    return `${col}/${id}`
  }

  const db = {
    _store: store,
    _queries: queries,
    _setQueryResult: setQueryResult,
    collection(col: string) {
      return {
        doc(id: string) {
          const path = docPath(col, id)
          return {
            path,
            async set(data: StoredDoc, opts?: { merge?: boolean }) {
              const current = store.get(path) ?? {}
              store.set(path, opts?.merge ? { ...current, ...data } : data)
            },
            async get() {
              const data = store.get(path)
              return {
                exists: data != null,
                data: () => data ?? {},
              }
            },
          }
        },
        where(field: string, op: string, value: unknown) {
          return {
            limit(_n: number) {
              return {
                async get() {
                  const q = queries.find(
                    (q) =>
                      q.collection === col &&
                      q.where[0] === field &&
                      q.where[1] === op &&
                      JSON.stringify(q.where[2]) === JSON.stringify(value)
                  )
                  const docs = q?.result ?? []
                  return {
                    empty: docs.length === 0,
                    docs: docs.map((d) => ({ data: () => d, id: String(d["id"] ?? "x") })),
                  }
                },
              }
            },
          }
        },
      }
    },
  }
  return { db: db as unknown as Firestore, store, setQueryResult }
}

// --- Test 1: resolveAllowlist returns Firestore active participants when PA_ALLOWLIST_SOURCE=firestore ---
test("resolveAllowlist returns Firestore active participants when PA_ALLOWLIST_SOURCE=firestore", async () => {
  const { db, setQueryResult } = fakeFirestore()
  process.env.PA_ALLOWLIST_SOURCE = "firestore"
  setQueryResult(PA_COLLECTIONS.betaParticipants, "status", "in", ["active"], [
    { id: "p1", contactHandle: "+14155550001", contactType: "phone", status: "active", addedAt: "2026-04-27", addedBy: "ops", userId: null, removedAt: null, notes: null, metadata: {} },
    { id: "p2", contactHandle: "test@example.com", contactType: "email", status: "active", addedAt: "2026-04-27", addedBy: "ops", userId: null, removedAt: null, notes: null, metadata: {} },
  ])
  const result = await resolveAllowlist(db)
  assert.equal(result.length, 2)
  assert.equal(result[0]!.contactHandle, "+14155550001")
  assert.equal(result[1]!.contactHandle, "test@example.com")
})

// --- Test 2: resolveAllowlist returns env-parsed list when PA_ALLOWLIST_SOURCE=env ---
test("resolveAllowlist returns env-parsed list when PA_ALLOWLIST_SOURCE=env", async () => {
  const { db } = fakeFirestore()
  process.env.PA_ALLOWLIST_SOURCE = "env"
  process.env.IMESSAGE_PEERS = "+14155551234,test@example.com"
  const result = await resolveAllowlist(db)
  assert.ok(result.some((r) => r.contactHandle === "+14155551234"))
  assert.ok(result.some((r) => r.contactHandle === "test@example.com"))
  delete process.env.IMESSAGE_PEERS
})

// --- Test 3: Firestore precedence — when PA_ALLOWLIST_SOURCE unset, Firestore wins ---
test("Firestore wins when PA_ALLOWLIST_SOURCE is unset", async () => {
  const { db, setQueryResult } = fakeFirestore()
  delete process.env.PA_ALLOWLIST_SOURCE
  process.env.IMESSAGE_PEERS = "+19990001234"
  setQueryResult(PA_COLLECTIONS.betaParticipants, "status", "in", ["active"], [
    { id: "p1", contactHandle: "+14155550099", contactType: "phone", status: "active", addedAt: "2026-04-27", addedBy: "ops", userId: null, removedAt: null, notes: null, metadata: {} },
  ])
  const result = await resolveAllowlist(db)
  // Firestore result — not the env peer
  assert.equal(result[0]!.contactHandle, "+14155550099")
  assert.ok(!result.some((r) => r.contactHandle === "+19990001234"))
  delete process.env.IMESSAGE_PEERS
})

// --- Test 4: isAllowlisted normalizes phones to E.164 last-10-digit match ---
test("isAllowlisted normalizes phones for last-10-digit match", () => {
  const list = [
    { contactHandle: "+14155550001", contactType: "phone" as const },
    { contactHandle: "claire@example.com", contactType: "email" as const },
  ]
  // Exact match
  assert.equal(isAllowlisted("+14155550001", list), true)
  // 10-digit match
  assert.equal(isAllowlisted("4155550001", list), true)
  // Non-matching phone
  assert.equal(isAllowlisted("+14155559999", list), false)
  // Email match (case-insensitive)
  assert.equal(isAllowlisted("CLAIRE@example.com", list), true)
  // Non-matching email
  assert.equal(isAllowlisted("other@example.com", list), false)
})

// --- Test 5: recordAllowlistDeny writes abuse row + audit event ---
test("recordAllowlistDeny writes pa_abuse_events row with kind=allowlist_deny and audit event", async () => {
  const { db, store } = fakeFirestore()
  // Suppress idempotency key collision by using a unique handle
  const handle = `+19999${Date.now()}`
  await recordAllowlistDeny(db, { channel: "imessage", contactHandle: handle })
  const abuseRows = [...store.keys()].filter((k) => k.startsWith(`${PA_COLLECTIONS.abuseEvents}/`))
  const auditRows = [...store.keys()].filter((k) => k.startsWith(`${PA_COLLECTIONS.auditEvents}/`))
  assert.equal(abuseRows.length, 1)
  assert.equal(auditRows.length, 1)
  const abuseDoc = store.get(abuseRows[0]!) as StoredDoc
  assert.equal(abuseDoc["kind"], "allowlist_deny")
  assert.equal(abuseDoc["channel"], "imessage")
})

// --- Test 6: recordAllowlistDeny is idempotent within 60s window ---
test("recordAllowlistDeny collapses duplicate writes within 60s window", async () => {
  const { db, store } = fakeFirestore()
  const handle = "+14155550123"
  const channel = "imessage"
  // First call — should write
  await recordAllowlistDeny(db, { channel, contactHandle: handle })
  // Second call within same 60s window (same idempotency key) — should be a no-op
  await recordAllowlistDeny(db, { channel, contactHandle: handle })
  const abuseRows = [...store.keys()].filter((k) => k.startsWith(`${PA_COLLECTIONS.abuseEvents}/`))
  // Only 1 abuse row (deduped). Idempotent SET means the key appears once.
  assert.equal(abuseRows.length, 1)
})
