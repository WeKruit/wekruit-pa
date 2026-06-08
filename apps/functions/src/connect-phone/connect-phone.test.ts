/**
 * connect-phone.test.ts — WS-3(a) verification-code lib + the two callable orchestrations.
 *
 * Drives the REAL token lib against an in-memory Firestore stub + the REAL pure handlers with
 * mocked identity seams (the seams that matter — phone resolve, handle link, merge — are NOT stubbed
 * away; they're asserted through deps so the canary gate, idempotency, and identity-conflict branch
 * are provable without a live Firestore/Sendblue).
 *
 * Run: node --import tsx --test apps/functions/src/connect-phone/connect-phone.test.ts
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import {
  issueConnectPhoneCode,
  verifyConnectPhoneCode,
  hashConnectPhoneCode,
  CONNECT_PHONE_CODE_MAX_ATTEMPTS,
} from "./connect-phone-code.js"
import { runConnectPhoneStart } from "./connect-phone-start.js"
import { runConnectPhoneVerify } from "./connect-phone-verify.js"

const CODES = "pa-connect-phone-codes"

/** In-memory Firestore stub supporting .collection().doc().get()/.set() + .where().limit().get(). */
function makeDb() {
  const store: Record<string, Record<string, Record<string, unknown>>> = {}
  function col(name: string) {
    store[name] ??= {}
    return store[name]!
  }
  const db = {
    collection(name: string) {
      const c = col(name)
      const makeQuery = (filters: Array<[string, unknown]>) => ({
        where(field: string, _op: string, value: unknown) {
          return makeQuery([...filters, [field, value]])
        },
        limit() {
          return this
        },
        async get() {
          const docs = Object.entries(c)
            .filter(([, data]) => filters.every(([f, v]) => data[f] === v))
            .map(([id, data]) => ({
              id,
              data: () => data,
              ref: {
                async set(patch: Record<string, unknown>, opts?: { merge?: boolean }) {
                  c[id] = opts?.merge ? { ...c[id], ...patch } : patch
                },
              },
            }))
          return { empty: docs.length === 0, docs }
        },
      })
      return {
        doc(id: string) {
          return {
            async get() {
              const data = c[id]
              return { exists: data !== undefined, data: () => data }
            },
            async set(patch: Record<string, unknown>, opts?: { merge?: boolean }) {
              c[id] = opts?.merge ? { ...(c[id] ?? {}), ...patch } : patch
            },
          }
        },
        where(field: string, op: string, value: unknown) {
          return makeQuery([]).where(field, op, value)
        },
      }
    },
  } as never
  return { db, store }
}

test("issue + verify happy path: correct code links to the phone candidate, then burns", async () => {
  const { db, store } = makeDb()
  const { code } = await issueConnectPhoneCode(db, {
    webFirebaseUid: "web_uid_1",
    phoneCandidateId: "cand_phone_1",
    phoneE164: "+14243201960",
  })
  assert.match(code, /^\d{6}$/)
  // Doc stores only the hash, never the plaintext.
  const docId = Object.keys(store[CODES]!)[0]!
  assert.equal(store[CODES]![docId]!.codeHash, hashConnectPhoneCode(code))
  assert.equal(store[CODES]![docId]!.code, undefined)

  const ok = await verifyConnectPhoneCode(db, { webFirebaseUid: "web_uid_1", code })
  assert.deepEqual(ok, { ok: true, phoneCandidateId: "cand_phone_1", webFirebaseUid: "web_uid_1" })
  // Single-use — a second verify with the same code now finds no outstanding code.
  const again = await verifyConnectPhoneCode(db, { webFirebaseUid: "web_uid_1", code })
  assert.equal(again.ok, false)
})

test("wrong code increments attempts; burns at the cap", async () => {
  const { db } = makeDb()
  await issueConnectPhoneCode(db, { webFirebaseUid: "web_uid_2", phoneCandidateId: "cand_2" })
  let last
  for (let i = 0; i < CONNECT_PHONE_CODE_MAX_ATTEMPTS; i++) {
    last = await verifyConnectPhoneCode(db, { webFirebaseUid: "web_uid_2", code: "000000" })
  }
  assert.equal(last?.ok, false)
  assert.equal(last && "reason" in last ? last.reason : undefined, "too_many_attempts")
})

test("expired code is rejected", async () => {
  const { db } = makeDb()
  const t0 = Date.now()
  const { code } = await issueConnectPhoneCode(
    db,
    { webFirebaseUid: "web_uid_3", phoneCandidateId: "cand_3" },
    t0,
  )
  const res = await verifyConnectPhoneCode(db, { webFirebaseUid: "web_uid_3", code }, t0 + 11 * 60 * 1000)
  assert.equal(res.ok, false)
  assert.equal("reason" in res ? res.reason : undefined, "code_expired")
})

// ── start callable ──────────────────────────────────────────────────────────

function startDeps(over: Partial<Parameters<typeof runConnectPhoneStart>[2]> = {}) {
  const calls = { issued: 0, sent: 0 }
  const deps: Parameters<typeof runConnectPhoneStart>[2] = {
    db: {} as never,
    resolveWebCandidateId: async () => "web_cand",
    resolvePhoneCandidateId: async () => "8fEwIduUrzxZsblHHsNz", // canary uid
    isCanary: (uid) => uid === "8fEwIduUrzxZsblHHsNz",
    issueCode: async () => {
      calls.issued++
      return { code: "654321" }
    },
    sendCode: async () => {
      calls.sent++
    },
    ...over,
  }
  return { deps, calls }
}

const AUTH = { uid: "web_uid", token: { email: "a@b.com", email_verified: true } }

test("start: no phone profile → no SMS, reason no_phone_profile", async () => {
  const { deps, calls } = startDeps({ resolvePhoneCandidateId: async () => null })
  const res = await runConnectPhoneStart({ phoneE164: "+14243201960" }, AUTH, deps)
  assert.deepEqual(res, { ok: false, reason: "no_phone_profile" })
  assert.equal(calls.sent, 0)
})

test("start: non-canary phone candidate → not_enabled, no SMS", async () => {
  const { deps, calls } = startDeps({
    resolvePhoneCandidateId: async () => "z_non_canary",
    isCanary: () => false,
  })
  const res = await runConnectPhoneStart({ phoneE164: "+14243201960" }, AUTH, deps)
  assert.deepEqual(res, { ok: false, reason: "not_enabled" })
  assert.equal(calls.sent, 0)
})

test("start: web + phone already the same candidate → idempotent ok, no code", async () => {
  const { deps, calls } = startDeps({
    resolveWebCandidateId: async () => "8fEwIduUrzxZsblHHsNz",
    resolvePhoneCandidateId: async () => "8fEwIduUrzxZsblHHsNz",
  })
  const res = await runConnectPhoneStart({ phoneE164: "+14243201960" }, AUTH, deps)
  assert.equal(res.ok, true)
  assert.equal(res.reason, "already_linked")
  assert.equal(calls.issued, 0)
})

test("start: canary phone candidate, distinct web → texts a code", async () => {
  const { deps, calls } = startDeps()
  const res = await runConnectPhoneStart({ phoneE164: "+14243201960" }, AUTH, deps)
  assert.equal(res.ok, true)
  assert.equal(res.codeSent, true)
  assert.equal(calls.issued, 1)
  assert.equal(calls.sent, 1)
})

test("start: rejects a missing auth uid", async () => {
  const { deps } = startDeps()
  await assert.rejects(() => runConnectPhoneStart({ phoneE164: "+14243201960" }, undefined, deps))
})

// ── verify callable ─────────────────────────────────────────────────────────

function verifyDeps(over: Partial<Parameters<typeof runConnectPhoneVerify>[2]> = {}) {
  const calls = { linked: 0, repointed: 0, merged: 0 }
  const deps: Parameters<typeof runConnectPhoneVerify>[2] = {
    db: {} as never,
    verifyCode: async () => ({ ok: true, phoneCandidateId: "cand_phone", webFirebaseUid: "web_uid" }),
    linkEmailHandle: async () => {
      calls.linked++
    },
    repointAuth: async () => {
      calls.repointed++
    },
    mergeByPhone: async () => {
      calls.merged++
    },
    ...over,
  }
  return { deps, calls }
}

test("verify: bad code → reason passthrough, no link/repoint", async () => {
  const { deps, calls } = verifyDeps({
    verifyCode: async () => ({ ok: false, reason: "code_mismatch" }),
  })
  const res = await runConnectPhoneVerify({ code: "000000" }, AUTH, deps)
  assert.deepEqual(res, { ok: false, reason: "code_mismatch" })
  assert.equal(calls.linked, 0)
  assert.equal(calls.repointed, 0)
})

test("verify: ok → links email, repoints auth, merges, returns phone candidate id", async () => {
  const { deps, calls } = verifyDeps()
  const res = await runConnectPhoneVerify({ code: "654321" }, AUTH, deps)
  assert.deepEqual(res, { ok: true, candidateId: "cand_phone" })
  assert.equal(calls.linked, 1)
  assert.equal(calls.repointed, 1)
  assert.equal(calls.merged, 1)
})

test("verify: email handle conflict → needs_review, NO repoint/merge", async () => {
  const { deps, calls } = verifyDeps({
    linkEmailHandle: async () => {
      throw new Error("identity_conflict:abc123")
    },
  })
  const res = await runConnectPhoneVerify({ code: "654321" }, AUTH, deps)
  assert.deepEqual(res, { ok: false, reason: "needs_review" })
  assert.equal(calls.repointed, 0, "must NOT repoint on a handle conflict")
  assert.equal(calls.merged, 0)
})
