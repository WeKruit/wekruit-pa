import assert from "node:assert/strict"
import { describe, it } from "node:test"
import type { Firestore } from "firebase-admin/firestore"

import {
  consumeApprovedDevice,
  createDevice,
  decideDevice,
  digestsEqual,
  generateUserCode,
  mintToken,
  normalizeUserCode,
  resolveToken,
  sha256,
  WKJOBS_DEVICE_CODES,
  WKJOBS_TOKENS,
} from "./store.js"

/**
 * In-memory Firestore double covering the shapes store.ts uses: point
 * get/set/update, single-field equality queries, and transactions.
 */
function makeFakeDb() {
  const docs = new Map<string, Record<string, unknown>>()

  function makeDocRef(coll: string, id: string) {
    const key = `${coll}/${id}`
    const ref = {
      _key: key,
      id,
      async get() {
        const data = docs.get(key)
        return { exists: data !== undefined, data: () => data, id, ref }
      },
      async set(data: Record<string, unknown>) {
        docs.set(key, { ...data })
      },
      async update(data: Record<string, unknown>) {
        docs.set(key, { ...(docs.get(key) ?? {}), ...data })
      },
    }
    return ref
  }

  const db = {
    collection(name: string) {
      return {
        doc(id: string) {
          return makeDocRef(name, id)
        },
        where(field: string, _op: string, value: unknown) {
          return {
            limit(n: number) {
              return {
                async get() {
                  const matched = [...docs.entries()]
                    .filter(([key, data]) => key.startsWith(`${name}/`) && data[field] === value)
                    .slice(0, n)
                    .map(([key, data]) => {
                      const id = key.slice(name.length + 1)
                      return { id, data: () => data, ref: makeDocRef(name, id) }
                    })
                  return { docs: matched, empty: matched.length === 0 }
                },
              }
            },
          }
        },
      }
    },
    async runTransaction<T>(fn: (t: unknown) => Promise<T>): Promise<T> {
      const t = {
        async get(ref: { get(): Promise<unknown> }) {
          return ref.get()
        },
        update(ref: { _key: string }, data: Record<string, unknown>) {
          docs.set(ref._key, { ...(docs.get(ref._key) ?? {}), ...data })
        },
        set(ref: { _key: string }, data: Record<string, unknown>) {
          docs.set(ref._key, { ...data })
        },
      }
      return fn(t)
    },
  } as unknown as Firestore

  return { db, docs }
}

const T0 = 1_800_000_000_000

describe("user codes", () => {
  it("emits codes the CLI contract accepts", () => {
    for (let i = 0; i < 200; i += 1) {
      assert.match(generateUserCode(), /^[A-Z0-9-]{6,12}$/)
    }
  })

  it("omits glyphs people confuse when reading a code aloud", () => {
    const joined = Array.from({ length: 200 }, () => generateUserCode()).join("")
    for (const confusable of ["0", "O", "1", "I", "L", "2", "Z", "5", "S", "8", "B"]) {
      assert.equal(joined.includes(confusable), false, `code alphabet leaked ${confusable}`)
    }
  })

  it("forgives case, spacing and the cosmetic hyphen", () => {
    assert.equal(normalizeUserCode("acde-fghj"), "ACDE-FGHJ")
    assert.equal(normalizeUserCode("  ACDEFGHJ "), "ACDE-FGHJ")
    assert.equal(normalizeUserCode("AC DE FG HJ"), "ACDE-FGHJ")
  })

  it("rejects wrong length and out-of-alphabet input", () => {
    assert.equal(normalizeUserCode("ACDE-FGH"), null)
    assert.equal(normalizeUserCode("ACDE-FGHJK"), null)
    assert.equal(normalizeUserCode("ACDE-FGH0"), null)
  })
})

describe("digestsEqual", () => {
  it("matches identical digests and rejects differing ones", () => {
    assert.equal(digestsEqual(sha256("a"), sha256("a")), true)
    assert.equal(digestsEqual(sha256("a"), sha256("b")), false)
    assert.equal(digestsEqual(sha256("a"), "short"), false)
  })
})

describe("createDevice", () => {
  it("never persists the device code or user code in the clear", async () => {
    const { db, docs } = makeFakeDb()
    const created = await createDevice(db, {
      client: "wkjobs-cli",
      provider: "linkedin",
      now: () => T0,
    })

    const stored = JSON.stringify([...docs.entries()])
    assert.equal(stored.includes(created.deviceCode), false, "device code stored in clear")
    assert.equal(stored.includes(created.userCode), false, "user code stored in clear")

    const record = docs.get(`${WKJOBS_DEVICE_CODES}/${sha256(created.deviceCode)}`)
    assert.ok(record, "device record is keyed by the device-code digest")
    assert.equal(record.status, "pending")
    assert.equal(record.userCodeHash, sha256(created.userCode))
  })

  it("expires within ten minutes, per the contract", async () => {
    const { db, docs } = makeFakeDb()
    const created = await createDevice(db, {
      client: "wkjobs-cli",
      provider: "linkedin",
      now: () => T0,
    })
    const record = docs.get(`${WKJOBS_DEVICE_CODES}/${sha256(created.deviceCode)}`)!
    const ttlMs = Date.parse(String(record.expiresAt)) - T0
    assert.ok(ttlMs > 0 && ttlMs <= 10 * 60 * 1000, `ttl was ${ttlMs}ms`)
    assert.equal(created.expiresInSec, 600)
  })
})

describe("device polling", () => {
  it("reports authorization_pending before a human decides", async () => {
    const { db } = makeFakeDb()
    const created = await createDevice(db, { client: "wkjobs-cli", provider: "linkedin", now: () => T0 })
    const outcome = await consumeApprovedDevice(db, created.deviceCode, { now: () => T0 + 1000 })
    assert.deepEqual(outcome, { status: "authorization_pending" })
  })

  it("returns slow_down when a client polls faster than the interval", async () => {
    const { db } = makeFakeDb()
    const created = await createDevice(db, { client: "wkjobs-cli", provider: "linkedin", now: () => T0 })
    await consumeApprovedDevice(db, created.deviceCode, { now: () => T0 + 1_000 })
    const hot = await consumeApprovedDevice(db, created.deviceCode, { now: () => T0 + 1_500 })
    assert.equal(hot.status, "slow_down")
  })

  it("authorizes once approved, then refuses to authorize twice", async () => {
    const { db } = makeFakeDb()
    const created = await createDevice(db, { client: "wkjobs-cli", provider: "linkedin", now: () => T0 })
    await decideDevice(db, {
      userCode: created.userCode,
      candidateId: "cand-123456",
      approve: true,
      now: () => T0 + 5_000,
    })

    const first = await consumeApprovedDevice(db, created.deviceCode, { now: () => T0 + 10_000 })
    assert.deepEqual(first, { status: "approved", candidateId: "cand-123456" })

    // Single-use: a replay of the same device code must not mint a second token.
    const second = await consumeApprovedDevice(db, created.deviceCode, { now: () => T0 + 20_000 })
    assert.equal(second.status, "expired_token")
  })

  it("reports access_denied when the human declines", async () => {
    const { db } = makeFakeDb()
    const created = await createDevice(db, { client: "wkjobs-cli", provider: "linkedin", now: () => T0 })
    await decideDevice(db, {
      userCode: created.userCode,
      candidateId: "cand-123456",
      approve: false,
      now: () => T0 + 5_000,
    })
    const outcome = await consumeApprovedDevice(db, created.deviceCode, { now: () => T0 + 10_000 })
    assert.deepEqual(outcome, { status: "access_denied" })
  })

  it("expires after the TTL even if it was approved", async () => {
    const { db } = makeFakeDb()
    const created = await createDevice(db, { client: "wkjobs-cli", provider: "linkedin", now: () => T0 })
    await decideDevice(db, {
      userCode: created.userCode,
      candidateId: "cand-123456",
      approve: true,
      now: () => T0 + 5_000,
    })
    const outcome = await consumeApprovedDevice(db, created.deviceCode, { now: () => T0 + 601_000 })
    assert.deepEqual(outcome, { status: "expired_token" })
  })

  it("treats an unknown device code as expired rather than confirming it exists", async () => {
    const { db } = makeFakeDb()
    const outcome = await consumeApprovedDevice(db, "not-a-real-device-code", { now: () => T0 })
    assert.deepEqual(outcome, { status: "expired_token" })
  })
})

describe("decideDevice", () => {
  it("rejects an unknown user code", async () => {
    const { db } = makeFakeDb()
    const result = await decideDevice(db, {
      userCode: "ACDE-FGHJ",
      candidateId: "cand-123456",
      approve: true,
      now: () => T0,
    })
    assert.deepEqual(result, { ok: false, reason: "unknown_code" })
  })

  it("refuses to re-decide an already-decided code", async () => {
    const { db } = makeFakeDb()
    const created = await createDevice(db, { client: "wkjobs-cli", provider: "linkedin", now: () => T0 })
    const first = await decideDevice(db, {
      userCode: created.userCode,
      candidateId: "cand-111111",
      approve: true,
      now: () => T0 + 1_000,
    })
    assert.deepEqual(first, { ok: true })

    // A second approval must not repoint an outstanding code at another candidate.
    const second = await decideDevice(db, {
      userCode: created.userCode,
      candidateId: "cand-222222",
      approve: true,
      now: () => T0 + 2_000,
    })
    assert.deepEqual(second, { ok: false, reason: "already_decided" })

    const outcome = await consumeApprovedDevice(db, created.deviceCode, { now: () => T0 + 10_000 })
    assert.deepEqual(outcome, { status: "approved", candidateId: "cand-111111" })
  })

  it("rejects an expired code", async () => {
    const { db } = makeFakeDb()
    const created = await createDevice(db, { client: "wkjobs-cli", provider: "linkedin", now: () => T0 })
    const result = await decideDevice(db, {
      userCode: created.userCode,
      candidateId: "cand-123456",
      approve: true,
      now: () => T0 + 601_000,
    })
    assert.deepEqual(result, { ok: false, reason: "expired" })
  })
})

describe("tokens", () => {
  it("stores only a digest and resolves the plaintext back to the candidate", async () => {
    const { db, docs } = makeFakeDb()
    const token = await mintToken(db, { candidateId: "cand-123456", now: () => T0 })

    assert.equal(JSON.stringify([...docs.entries()]).includes(token), false, "token stored in clear")
    assert.ok(docs.get(`${WKJOBS_TOKENS}/${sha256(token)}`))

    const record = await resolveToken(db, token, { now: () => T0 + 1_000 })
    assert.equal(record?.candidateId, "cand-123456")
  })

  it("rejects an unknown or revoked token", async () => {
    const { db, docs } = makeFakeDb()
    assert.equal(await resolveToken(db, "wkj_nope", { now: () => T0 }), null)

    const token = await mintToken(db, { candidateId: "cand-123456", now: () => T0 })
    docs.set(`${WKJOBS_TOKENS}/${sha256(token)}`, {
      ...docs.get(`${WKJOBS_TOKENS}/${sha256(token)}`)!,
      revokedAt: new Date(T0).toISOString(),
    })
    assert.equal(await resolveToken(db, token, { now: () => T0 + 1_000 }), null)
  })
})
