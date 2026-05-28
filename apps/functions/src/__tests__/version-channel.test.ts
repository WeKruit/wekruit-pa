/**
 * paVersionChannel core-logic tests — GET (read) / POST (set + audit).
 *
 * The CF itself (apps/functions/src/index.ts `paVersionChannel`) is a thin
 * HTTP shim (auth + CORS + method routing) over `readVersionChannel` /
 * `setVersionChannel`. Here we exercise that pure read/write logic against an
 * in-memory Firestore fake — same extract+test pattern as
 * `admin-match-debug.test.ts`.
 *
 * Run via:
 *   node --import tsx --test apps/functions/src/__tests__/version-channel.test.ts
 */
import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { PA_COLLECTIONS } from "@pa/core-types"
import {
  readVersionChannel,
  setVersionChannel,
  parseChannel,
  type VcFirestore,
} from "../version-channel.js"

// ---------------------------------------------------------------------------
// In-memory Firestore fake — only `collection().doc().get()/.set()` and
// `collection().add()`, which is all the module touches.
// ---------------------------------------------------------------------------
function makeFakeDb(seed: Record<string, Record<string, Record<string, unknown>>> = {}) {
  const store: Record<string, Record<string, Record<string, unknown>>> = {
    ...Object.fromEntries(Object.entries(seed).map(([k, v]) => [k, { ...v }])),
  }
  const added: Array<{ collection: string; row: Record<string, unknown> }> = []
  const db: VcFirestore & {
    _store: typeof store
    _added: typeof added
  } = {
    _store: store,
    _added: added,
    collection(name: string) {
      store[name] ??= {}
      const coll = store[name]!
      return {
        doc(id: string) {
          return {
            async get() {
              const data = coll[id]
              return { exists: data !== undefined, data: () => data }
            },
            async set(patch: Record<string, unknown>, opts?: { merge?: boolean }) {
              coll[id] = opts?.merge ? { ...(coll[id] ?? {}), ...patch } : { ...patch }
              return undefined
            },
          }
        },
        async add(row: Record<string, unknown>) {
          added.push({ collection: name, row })
          return { id: `audit-${added.length}` }
        },
      }
    },
  }
  return db
}

// ---------------------------------------------------------------------------
// parseChannel — closed enum guard
// ---------------------------------------------------------------------------
describe("parseChannel", () => {
  it("accepts latest / stable, rejects everything else", () => {
    assert.equal(parseChannel("latest"), "latest")
    assert.equal(parseChannel("stable"), "stable")
    assert.equal(parseChannel(" latest "), "latest")
    assert.equal(parseChannel("auto"), null)
    assert.equal(parseChannel(""), null)
    assert.equal(parseChannel(undefined), null)
    assert.equal(parseChannel(42), null)
  })
})

// ---------------------------------------------------------------------------
// GET — readVersionChannel
// ---------------------------------------------------------------------------
describe("readVersionChannel (GET)", () => {
  it("returns stable/stable for a normal user with no field", async () => {
    const db = makeFakeDb({ [PA_COLLECTIONS.users]: { u_normal: { phoneE164: "+19998887777" } } })
    const out = await readVersionChannel(db, "u_normal", {})
    assert.equal(out.userId, "u_normal")
    assert.equal(out.versionChannel, "stable")
    assert.equal(out.effectiveChannel, "stable")
    assert.equal(out.internal, false)
  })

  it("returns stored=latest and effective=latest when the user opted in", async () => {
    const db = makeFakeDb({ [PA_COLLECTIONS.users]: { u_optin: { versionChannel: "latest" } } })
    const out = await readVersionChannel(db, "u_optin", {})
    assert.equal(out.versionChannel, "latest")
    assert.equal(out.effectiveChannel, "latest")
    assert.equal(out.internal, false)
  })

  it("internal user reads stored=stable but effective=latest (allowlist override)", async () => {
    const db = makeFakeDb({ [PA_COLLECTIONS.users]: { u_int: { phoneE164: "+14243201960" } } })
    const out = await readVersionChannel(db, "u_int", {})
    assert.equal(out.versionChannel, "stable")
    assert.equal(out.effectiveChannel, "latest")
    assert.equal(out.internal, true)
  })

  it("throws a 404-shaped error for a missing user", async () => {
    const db = makeFakeDb({})
    await assert.rejects(
      () => readVersionChannel(db, "u_missing", {}),
      (err: unknown) => {
        assert.equal((err as { status?: number }).status, 404)
        return true
      },
    )
  })
})

// ---------------------------------------------------------------------------
// POST — setVersionChannel + audit
// ---------------------------------------------------------------------------
describe("setVersionChannel (POST)", () => {
  it("writes the field + audit fields and an audit row", async () => {
    const db = makeFakeDb({ [PA_COLLECTIONS.users]: { u1: {} } })
    const now = "2026-05-28T00:00:00.000Z"
    const result = await setVersionChannel(db, {
      userId: "u1",
      channel: "latest",
      reason: "canary cohort",
      setBy: "ops@wekruit.com",
      nowIso: now,
    })
    assert.deepEqual(result, {
      ok: true,
      userId: "u1",
      channel: "latest",
      versionChannelAt: now,
      setBy: "ops@wekruit.com",
      auditWritten: true,
    })
    // pa-users doc patched (merge — phoneE164 etc. preserved if present).
    const doc = db._store[PA_COLLECTIONS.users]!.u1!
    assert.equal(doc.versionChannel, "latest")
    assert.equal(doc.versionChannelAt, now)
    assert.equal(doc.versionChannelSetBy, "ops@wekruit.com")
    assert.equal(doc.versionChannelReason, "canary cohort")
    // audit row appended.
    assert.equal(db._added.length, 1)
    assert.equal(db._added[0]!.collection, PA_COLLECTIONS.auditEvents)
    assert.equal(db._added[0]!.row.kind, "version_channel")
    assert.equal(db._added[0]!.row.userId, "u1")
    assert.equal(db._added[0]!.row.actor, "ops@wekruit.com")
    assert.deepEqual(db._added[0]!.row.meta, { channel: "latest", reason: "canary cohort" })
  })

  it("set then read reflects the new channel (round-trip)", async () => {
    const db = makeFakeDb({ [PA_COLLECTIONS.users]: { u2: { phoneE164: "+15551234567" } } })
    await setVersionChannel(db, { userId: "u2", channel: "latest", setBy: "ops", nowIso: "2026-05-28T01:00:00.000Z" })
    const out = await readVersionChannel(db, "u2", {})
    assert.equal(out.versionChannel, "latest")
    assert.equal(out.effectiveChannel, "latest")
    // flip back to stable (promotion-rollback / opt-out path).
    await setVersionChannel(db, { userId: "u2", channel: "stable", setBy: "ops", nowIso: "2026-05-28T02:00:00.000Z" })
    const out2 = await readVersionChannel(db, "u2", {})
    assert.equal(out2.versionChannel, "stable")
    assert.equal(out2.effectiveChannel, "stable")
  })

  it("omits versionChannelReason when reason is blank", async () => {
    const db = makeFakeDb({ [PA_COLLECTIONS.users]: { u3: {} } })
    await setVersionChannel(db, { userId: "u3", channel: "stable", setBy: "ops", nowIso: "2026-05-28T00:00:00.000Z" })
    const doc = db._store[PA_COLLECTIONS.users]!.u3!
    assert.equal("versionChannelReason" in doc, false)
  })

  it("audit-row failure does not fail the channel write (best-effort)", async () => {
    const db = makeFakeDb({ [PA_COLLECTIONS.users]: { u4: {} } })
    // Make the audit collection's add() throw.
    const realCollection = db.collection.bind(db)
    db.collection = ((name: string) => {
      const coll = realCollection(name)
      if (name === PA_COLLECTIONS.auditEvents) {
        return { ...coll, async add() { throw new Error("audit perm denied") } }
      }
      return coll
    }) as typeof db.collection
    let auditErr: unknown = null
    const result = await setVersionChannel(db, {
      userId: "u4",
      channel: "latest",
      setBy: "ops",
      nowIso: "2026-05-28T00:00:00.000Z",
      onAuditError: (e) => { auditErr = e },
    })
    // Channel write still succeeded; auditWritten=false; hook fired.
    assert.equal(result.ok, true)
    assert.equal(result.channel, "latest")
    assert.equal(result.auditWritten, false)
    assert.equal((auditErr as Error)?.message, "audit perm denied")
    assert.equal(db._store[PA_COLLECTIONS.users]!.u4!.versionChannel, "latest")
  })
})
