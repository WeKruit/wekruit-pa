/**
 * Tests for tokenized LinkedIn one-tap connect links (UNAUTH candidate path).
 */
import { describe, it } from "node:test"
import assert from "node:assert/strict"
import type { Firestore } from "firebase-admin/firestore"
import { PA_COLLECTIONS } from "@pa/core-types"
import {
  issueLinkedinConnectToken,
  verifyLinkedinConnectToken,
  markLinkedinConnectTokenUsed,
  buildConnectLinkedinLink,
  getOrIssueLinkedinConnectLink,
  LINKEDIN_CONNECT_TOKEN_TTL_MS,
} from "./connect-token.js"

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
  it("issues a token that verifies to its userId (+ phone)", async () => {
    const db = fakeDb()
    const token = await issueLinkedinConnectToken(db, "user-1", "+14243201960")
    const v = await verifyLinkedinConnectToken(db, token)
    assert.equal(v.ok, true)
    assert.equal(v.ok && v.userId, "user-1")
    assert.equal(v.ok && v.phoneE164, "+14243201960")
  })

  it("verifies without a phone when none was stored", async () => {
    const db = fakeDb()
    const token = await issueLinkedinConnectToken(db, "user-np")
    const v = await verifyLinkedinConnectToken(db, token)
    assert.equal(v.ok, true)
    assert.equal(v.ok && v.phoneE164, undefined)
  })

  it("rejects a missing / unknown token", async () => {
    const db = fakeDb()
    assert.deepEqual(await verifyLinkedinConnectToken(db, ""), { ok: false, reason: "missing_token" })
    assert.deepEqual(await verifyLinkedinConnectToken(db, "nope"), { ok: false, reason: "unknown_token" })
  })

  it("rejects an expired token", async () => {
    const db = fakeDb()
    const t0 = Date.now() - LINKEDIN_CONNECT_TOKEN_TTL_MS - 1000
    const token = await issueLinkedinConnectToken(db, "user-2", undefined, t0)
    const v = await verifyLinkedinConnectToken(db, token, Date.now())
    assert.deepEqual(v, { ok: false, reason: "token_expired" })
  })

  it("rejects a used token (single-use)", async () => {
    const db = fakeDb()
    const token = await issueLinkedinConnectToken(db, "user-3")
    await markLinkedinConnectTokenUsed(db, token)
    const v = await verifyLinkedinConnectToken(db, token)
    assert.deepEqual(v, { ok: false, reason: "token_used" })
  })
})

describe("buildConnectLinkedinLink", () => {
  it("builds a candidate.wekruit.com/connect-linkedin?token= link", () => {
    assert.equal(
      buildConnectLinkedinLink("abc123"),
      "https://candidate.wekruit.com/connect-linkedin?token=abc123",
    )
  })
})

describe("getOrIssueLinkedinConnectLink", () => {
  it("reuses an existing unused, unexpired token instead of minting a new one", async () => {
    const db = fakeDb()
    const link1 = await getOrIssueLinkedinConnectLink(db, "user-r")
    const link2 = await getOrIssueLinkedinConnectLink(db, "user-r")
    assert.ok(link1)
    assert.equal(link1, link2, "second call reuses the same token")
    const coll = (db as unknown as FakeFirestore).store.get(PA_COLLECTIONS.linkedinConnectTokens)!
    const forUser = [...coll.values()].filter((d) => d.userId === "user-r")
    assert.equal(forUser.length, 1)
  })

  it("issues a fresh token when the only existing one is used", async () => {
    const db = fakeDb()
    const first = await getOrIssueLinkedinConnectLink(db, "user-u")
    const token = first!.split("token=")[1]!
    await markLinkedinConnectTokenUsed(db, token)
    const second = await getOrIssueLinkedinConnectLink(db, "user-u")
    assert.notEqual(second, first)
  })
})
