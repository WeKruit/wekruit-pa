/**
 * Tests for transit-safe phone-binding opener codes (2026-06-13).
 *
 * Covers: mint → pa-bind-codes doc; resolve+consume single-use; reused/expired/
 * unknown/bad-shape → graceful failure (no wrong bind); same-phone idempotent
 * re-text; corrupted code (excluded glyph) → no match.
 */
import { describe, it } from "node:test"
import assert from "node:assert/strict"
import type { Firestore } from "firebase-admin/firestore"
import { PA_COLLECTIONS } from "@pa/core-types"
import {
  issueBindCode,
  resolveAndConsumeBindCode,
  generateBindCode,
  BIND_CODE_TTL_MS,
  type BindCodeDoc,
} from "./bind-code.js"
import { isBindCode } from "@pa/pa-orchestrator"

type DocData = Record<string, unknown>

/** Minimal Firestore fake with runTransaction support (single in-memory store). */
class FakeFirestore {
  readonly store = new Map<string, Map<string, DocData>>()
  private coll(path: string): Map<string, DocData> {
    const c = this.store.get(path) ?? new Map<string, DocData>()
    this.store.set(path, c)
    return c
  }
  private docRef(path: string, id: string) {
    const coll = this.coll(path)
    return {
      __path: path,
      __id: id,
      async get() {
        const data = coll.get(id)
        return { id, exists: data !== undefined, data: () => data }
      },
      async set(data: DocData, opts?: { merge?: boolean }) {
        const prev = coll.get(id) ?? {}
        coll.set(id, opts?.merge ? { ...prev, ...data } : data)
      },
    }
  }
  collection(path: string) {
    return { doc: (id: string) => this.docRef(path, id) }
  }
  async runTransaction<T>(fn: (tx: unknown) => Promise<T>): Promise<T> {
    // Serial, no real isolation — sufficient for single-threaded unit tests.
    const tx = {
      get: (ref: { get: () => Promise<unknown> }) => ref.get(),
      set: (ref: { set: (d: DocData, o?: { merge?: boolean }) => Promise<void> }, d: DocData, o?: { merge?: boolean }) => {
        void ref.set(d, o)
      },
    }
    return fn(tx)
  }
}

function fakeDb(): Firestore {
  return new FakeFirestore() as unknown as Firestore
}

describe("generateBindCode", () => {
  it("emits a transit-safe code of the canonical shape", () => {
    for (let i = 0; i < 200; i++) {
      assert.equal(isBindCode(generateBindCode()), true)
    }
  })
})

describe("issueBindCode", () => {
  it("mints a pa-bind-codes doc mapping code → candidateId (unused)", async () => {
    const db = fakeDb()
    const code = await issueBindCode(db, "cand-1")
    assert.equal(isBindCode(code), true)
    const coll = (db as unknown as FakeFirestore).store.get(PA_COLLECTIONS.bindCodes)!
    const doc = coll.get(code) as unknown as BindCodeDoc
    assert.equal(doc.candidateId, "cand-1")
    assert.equal(doc.used, false)
    assert.equal(doc.code, code)
  })

  it("rejects an empty candidateId", async () => {
    const db = fakeDb()
    await assert.rejects(() => issueBindCode(db, "  "))
  })
})

describe("resolveAndConsumeBindCode", () => {
  it("resolves a valid code → candidateId AND marks it used (single-use)", async () => {
    const db = fakeDb()
    const code = await issueBindCode(db, "cand-2")
    const r1 = await resolveAndConsumeBindCode(db, code, "+15551230000")
    assert.deepEqual(r1, { ok: true, candidateId: "cand-2" })
    // A DIFFERENT phone re-presenting the consumed code → graceful code_used (no rebind).
    const r2 = await resolveAndConsumeBindCode(db, code, "+15559990000")
    assert.deepEqual(r2, { ok: false, reason: "code_used" })
  })

  it("is idempotent for the SAME phone (retry / duplicate inbound) → still resolves", async () => {
    const db = fakeDb()
    const code = await issueBindCode(db, "cand-idem")
    const r1 = await resolveAndConsumeBindCode(db, code, "+15551112222")
    assert.deepEqual(r1, { ok: true, candidateId: "cand-idem" })
    const r2 = await resolveAndConsumeBindCode(db, code, "+15551112222")
    assert.deepEqual(r2, { ok: true, candidateId: "cand-idem" })
  })

  it("rejects an unknown code gracefully (no wrong bind)", async () => {
    const db = fakeDb()
    const r = await resolveAndConsumeBindCode(db, "ABCD2345", "+15550000000")
    assert.deepEqual(r, { ok: false, reason: "unknown_code" })
  })

  it("rejects an expired code gracefully", async () => {
    const db = fakeDb()
    const t0 = Date.now() - BIND_CODE_TTL_MS - 1000
    const code = await issueBindCode(db, "cand-exp", t0)
    const r = await resolveAndConsumeBindCode(db, code, "+15550000000", Date.now())
    assert.deepEqual(r, { ok: false, reason: "code_expired" })
  })

  it("rejects a missing code", async () => {
    const db = fakeDb()
    assert.deepEqual(await resolveAndConsumeBindCode(db, ""), { ok: false, reason: "missing_code" })
    assert.deepEqual(await resolveAndConsumeBindCode(db, undefined), { ok: false, reason: "missing_code" })
  })

  it("rejects a CORRUPTED code (excluded glyph) as bad_shape → never a wrong-account bind", async () => {
    const db = fakeDb()
    // Mint a real code, then corrupt one char into an EXCLUDED glyph (O/0/I/1/L/U).
    const real = await issueBindCode(db, "cand-corrupt")
    const corrupted = real.slice(0, -1) + "O" // O is excluded — cannot be a minted code
    // Shape guard short-circuits BEFORE any Firestore read → bad_shape, not unknown.
    const r = await resolveAndConsumeBindCode(db, corrupted, "+15550000000")
    assert.deepEqual(r, { ok: false, reason: "bad_shape" })
  })

  it("normalizes whitespace + case on read", async () => {
    const db = fakeDb()
    const code = await issueBindCode(db, "cand-norm")
    const r = await resolveAndConsumeBindCode(db, ` ${code.toLowerCase()} `, "+15550000000")
    assert.deepEqual(r, { ok: true, candidateId: "cand-norm" })
  })
})
