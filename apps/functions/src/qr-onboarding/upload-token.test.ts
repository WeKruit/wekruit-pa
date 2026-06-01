/**
 * Tests for tokenized resume-upload links (the UNAUTH QR upload path).
 */
import { describe, it } from "node:test"
import assert from "node:assert/strict"
import type { Firestore } from "firebase-admin/firestore"
import { PA_COLLECTIONS } from "@pa/core-types"
import {
  issueCvUploadToken,
  verifyCvUploadToken,
  markCvUploadTokenUsed,
  buildCvUploadLink,
  getOrIssueCvUploadLink,
  CV_UPLOAD_TOKEN_TTL_MS,
} from "./upload-token.js"

type DocData = Record<string, unknown>

class FakeFirestore {
  readonly store = new Map<string, Map<string, DocData>>()
  collection(path: string) {
    const coll = this.store.get(path) ?? new Map<string, DocData>()
    this.store.set(path, coll)
    return {
      doc: (id: string) => ({
        async get() {
          const data = coll.get(id)
          return { id, exists: data !== undefined, data: () => data }
        },
        async set(data: DocData, opts?: { merge?: boolean }) {
          const prev = coll.get(id) ?? {}
          coll.set(id, opts?.merge ? { ...prev, ...data } : data)
        },
      }),
      where(field: string, _op: string, value: unknown) {
        const rows = [...coll.entries()]
          .filter(([, d]) => d[field] === value)
          .map(([id, d]) => ({ id, data: () => d }))
        return {
          limit: (n: number) => ({
            async get() {
              return { docs: rows.slice(0, n) }
            },
          }),
        }
      },
    }
  }
}

function fakeDb(): Firestore {
  return new FakeFirestore() as unknown as Firestore
}

describe("issue + verify", () => {
  it("issues a token that verifies to its userId", async () => {
    const db = fakeDb()
    const token = await issueCvUploadToken(db, "user-1")
    const v = await verifyCvUploadToken(db, token)
    assert.equal(v.ok, true)
    assert.equal(v.ok && v.userId, "user-1")
  })

  it("rejects a missing / unknown token", async () => {
    const db = fakeDb()
    assert.deepEqual(await verifyCvUploadToken(db, ""), { ok: false, reason: "missing_token" })
    assert.deepEqual(await verifyCvUploadToken(db, "nope"), { ok: false, reason: "unknown_token" })
  })

  it("rejects an expired token", async () => {
    const db = fakeDb()
    const t0 = Date.now() - CV_UPLOAD_TOKEN_TTL_MS - 1000
    const token = await issueCvUploadToken(db, "user-2", t0)
    const v = await verifyCvUploadToken(db, token, Date.now())
    assert.deepEqual(v, { ok: false, reason: "token_expired" })
  })

  it("rejects a used token (single-use)", async () => {
    const db = fakeDb()
    const token = await issueCvUploadToken(db, "user-3")
    await markCvUploadTokenUsed(db, token)
    const v = await verifyCvUploadToken(db, token)
    assert.deepEqual(v, { ok: false, reason: "token_used" })
  })
})

describe("buildCvUploadLink", () => {
  it("builds a wekruit.com/upload?token= link", () => {
    assert.equal(buildCvUploadLink("abc123"), "https://wekruit.com/upload?token=abc123")
  })
})

describe("getOrIssueCvUploadLink", () => {
  it("reuses an existing unused, unexpired token instead of minting a new one", async () => {
    const db = fakeDb()
    const link1 = await getOrIssueCvUploadLink(db, "user-r")
    const link2 = await getOrIssueCvUploadLink(db, "user-r")
    assert.ok(link1)
    assert.equal(link1, link2, "second call reuses the same token")
    // exactly one token doc exists for this user
    const coll = (db as unknown as FakeFirestore).store.get(PA_COLLECTIONS.cvUploadTokens)!
    const forUser = [...coll.values()].filter((d) => d.userId === "user-r")
    assert.equal(forUser.length, 1)
  })

  it("issues a fresh token when the only existing one is used", async () => {
    const db = fakeDb()
    const first = await getOrIssueCvUploadLink(db, "user-u")
    const token = first!.split("token=")[1]!
    await markCvUploadTokenUsed(db, token)
    const second = await getOrIssueCvUploadLink(db, "user-u")
    assert.notEqual(second, first)
  })
})
