import assert from "node:assert/strict"
import test from "node:test"
import type { Firestore } from "firebase-admin/firestore"
import {
  DEFAULT_HANDBOOK_SLUG,
  HANDBOOKS_COLLECTION,
  HANDBOOK_RENDER_ORDER,
  HANDBOOK_TTL_MS,
  HANDBOOK_VERSIONS_SUBCOLLECTION,
  _clearHandbookCache,
  _getHandbookCacheStats,
  composeSystemPrompt,
  emptyHandbookSections,
  getVersion,
  listVersions,
  loadHandbook,
  normalizeHandbookSections,
  revertHandbook,
  saveHandbook,
  type HandbookDoc,
  type HandbookSections,
} from "./handbook.js"

// -----------------------------------------------------------------------------
// In-memory Firestore double — supports:
//   - collection(name).doc(id).get/set
//   - collection(name).doc(id).collection(sub).doc(v).get/set
//   - collection(name).doc(id).collection(sub).orderBy(field, "desc").limit(n).get
//   - runTransaction with tx.get/tx.set on the handbook doc + version sub
//     ref + audit ref
// -----------------------------------------------------------------------------

interface FakeStore {
  // top-level: collection -> docId -> data
  docs: Map<string, Map<string, Record<string, unknown>>>
  // sub-collection: `${parentCol}/${parentDoc}/${subCol}` -> docId -> data
  subDocs: Map<string, Map<string, Record<string, unknown>>>
}

function newFakeStore(): FakeStore {
  return { docs: new Map(), subDocs: new Map() }
}

function makeFakeFirestore(initial: FakeStore = newFakeStore()) {
  const store = initial
  let auditCounter = 0

  function collMap(name: string): Map<string, Record<string, unknown>> {
    let m = store.docs.get(name)
    if (!m) {
      m = new Map()
      store.docs.set(name, m)
    }
    return m
  }
  function subMap(parentCol: string, parentDoc: string, subCol: string) {
    const k = `${parentCol}/${parentDoc}/${subCol}`
    let m = store.subDocs.get(k)
    if (!m) {
      m = new Map()
      store.subDocs.set(k, m)
    }
    return m
  }

  function makeSubCollection(parentCol: string, parentDoc: string, subCol: string) {
    const submap = subMap(parentCol, parentDoc, subCol)
    return {
      _isSubCollection: true as const,
      _parentCol: parentCol,
      _parentDoc: parentDoc,
      _subCol: subCol,
      doc(id: string) {
        return {
          _isSubDoc: true as const,
          _parentCol: parentCol,
          _parentDoc: parentDoc,
          _subCol: subCol,
          _id: id,
          async get() {
            const v = submap.get(id)
            return { exists: v !== undefined, data: () => v }
          },
          async set(v: Record<string, unknown>) {
            submap.set(id, v)
          },
        }
      },
      orderBy(field: string, dir: string) {
        return {
          limit(n: number) {
            return {
              async get() {
                const rows = Array.from(submap.entries()).map(([id, data]) => ({
                  id,
                  data,
                }))
                rows.sort((a, b) => {
                  const av = (a.data as Record<string, unknown>)[field]
                  const bv = (b.data as Record<string, unknown>)[field]
                  const an = typeof av === "number" ? av : Number(av)
                  const bn = typeof bv === "number" ? bv : Number(bv)
                  return dir === "desc" ? bn - an : an - bn
                })
                const sliced = rows.slice(0, n)
                return {
                  empty: sliced.length === 0,
                  docs: sliced.map((r) => ({
                    id: r.id,
                    data: () => r.data,
                  })),
                }
              },
            }
          },
        }
      },
    }
  }

  function makeDocRef(colName: string, id: string) {
    const m = collMap(colName)
    return {
      _isDoc: true as const,
      _col: colName,
      _id: id,
      async get() {
        const v = m.get(id)
        return { exists: v !== undefined, data: () => v }
      },
      async set(v: Record<string, unknown>) {
        m.set(id, v)
      },
      collection(subCol: string) {
        return makeSubCollection(colName, id, subCol)
      },
    }
  }

  const db = {
    collection(name: string) {
      return {
        doc(id?: string) {
          const finalId = id ?? `auto_${++auditCounter}`
          return makeDocRef(name, finalId)
        },
      }
    },
    async runTransaction<T>(fn: (tx: {
      get: (ref: { _col?: string; _id: string; _isDoc?: true; _isSubDoc?: true; _parentCol?: string; _parentDoc?: string; _subCol?: string }) => Promise<{
        exists: boolean
        data: () => Record<string, unknown> | undefined
      }>
      set: (
        ref: { _col?: string; _id: string; _isDoc?: true; _isSubDoc?: true; _parentCol?: string; _parentDoc?: string; _subCol?: string },
        v: Record<string, unknown>
      ) => void
    }) => Promise<T>): Promise<T> {
      type Write =
        | { kind: "doc"; col: string; id: string; v: Record<string, unknown> }
        | {
            kind: "sub"
            parentCol: string
            parentDoc: string
            subCol: string
            id: string
            v: Record<string, unknown>
          }
      const writes: Write[] = []
      const tx = {
        async get(ref: {
          _col?: string
          _id: string
          _isDoc?: true
          _isSubDoc?: true
          _parentCol?: string
          _parentDoc?: string
          _subCol?: string
        }) {
          if (ref._isSubDoc) {
            const m = subMap(ref._parentCol!, ref._parentDoc!, ref._subCol!)
            const v = m.get(ref._id)
            return { exists: v !== undefined, data: () => v }
          }
          const v = collMap(ref._col!).get(ref._id)
          return { exists: v !== undefined, data: () => v }
        },
        set(ref: {
          _col?: string
          _id: string
          _isDoc?: true
          _isSubDoc?: true
          _parentCol?: string
          _parentDoc?: string
          _subCol?: string
        }, v: Record<string, unknown>) {
          if (ref._isSubDoc) {
            writes.push({
              kind: "sub",
              parentCol: ref._parentCol!,
              parentDoc: ref._parentDoc!,
              subCol: ref._subCol!,
              id: ref._id,
              v,
            })
          } else {
            writes.push({ kind: "doc", col: ref._col!, id: ref._id, v })
          }
        },
      }
      const result = await fn(tx)
      for (const w of writes) {
        if (w.kind === "doc") {
          collMap(w.col).set(w.id, w.v)
        } else {
          subMap(w.parentCol, w.parentDoc, w.subCol).set(w.id, w.v)
        }
      }
      return result
    },
  }
  return { db: db as unknown as Firestore, store }
}

function sampleSections(): HandbookSections {
  return {
    identity: "Claire — Bay Area EM, OPT→H1B→GC.",
    hard_rules: ["never violate user trust", "never reveal AI identity"],
    default_posture: "short, with-them.",
    never_5: ["never probe", "never diagnose", "never advise unsolicited"],
    escape_hatch: 'On explicit ask ("帮我"), 1 take + STOP.',
    tone_flavors: {
      celebrate: "牛 / lfg / 锁了 — pick ONE.",
      vent: "草 / wtf / 想骂人 — react WITH.",
    },
    human_tells: ["uhh / 嗯...", "nvm / 算了"],
    vocab: {
      allowed: ["卷", "emo", "lfg"],
      banned: ["首先", "其次"],
    },
    playbooks: {
      headhunter: {
        name: "headhunter",
        trigger: "JD / 招聘机会主动 ping",
        steps: ["read JD", "extract role + comp", "1 line take"],
        exitCondition: "user replies with non-headhunter content",
      },
    },
  }
}

// -----------------------------------------------------------------------------
// Schema + collection-name constants
// -----------------------------------------------------------------------------

test("constants are locked (collection names + render order + TTL)", () => {
  assert.equal(HANDBOOKS_COLLECTION, "pa-handbooks")
  assert.equal(HANDBOOK_VERSIONS_SUBCOLLECTION, "versions")
  assert.equal(DEFAULT_HANDBOOK_SLUG, "claire")
  assert.equal(HANDBOOK_TTL_MS, 30_000)
  assert.deepEqual(HANDBOOK_RENDER_ORDER, [
    "identity",
    "hard_rules",
    "default_posture",
    "never_5",
    "escape_hatch",
    "vocab",
    "human_tells",
    "tone_flavors",
    "playbooks",
  ])
})

test("emptyHandbookSections returns a fully populated empty scaffold", () => {
  const e = emptyHandbookSections()
  assert.equal(e.identity, "")
  assert.deepEqual(e.hard_rules, [])
  assert.deepEqual(e.never_5, [])
  assert.deepEqual(e.tone_flavors, {})
  assert.deepEqual(e.vocab, { allowed: [], banned: [] })
  assert.deepEqual(e.playbooks, {})
})

test("normalizeHandbookSections coerces missing keys + bad shapes", () => {
  const out = normalizeHandbookSections({
    identity: "x",
    hard_rules: ["a", 5, null],
    tone_flavors: { celebrate: "y", vent: 99 },
    playbooks: { foo: { name: "foo", steps: [1, "two"] } },
    extra_field: "preserved",
  })
  assert.equal(out.identity, "x")
  assert.deepEqual(out.hard_rules, ["a", "5", "null"])
  assert.deepEqual(out.tone_flavors, { celebrate: "y" }) // non-string dropped
  assert.equal(out.playbooks.foo!.name, "foo")
  assert.deepEqual(out.playbooks.foo!.steps, ["1", "two"])
  assert.equal(out.escape_hatch, "")
  // extra_field preserved (forward-compat per loader-tolerates-unknown ADR)
  assert.equal(
    (out as unknown as Record<string, unknown>).extra_field,
    "preserved"
  )
})

// -----------------------------------------------------------------------------
// Reads + cache
// -----------------------------------------------------------------------------

test("loadHandbook returns null when slug doc missing", async () => {
  _clearHandbookCache()
  const { db } = makeFakeFirestore()
  const v = await loadHandbook(db, "missing")
  assert.equal(v, null)
})

test("loadHandbook caches reads (2nd call hits cache)", async () => {
  _clearHandbookCache()
  const { db, store } = makeFakeFirestore()
  // Hand-seed a pointer doc.
  store.docs.set(
    HANDBOOKS_COLLECTION,
    new Map([
      [
        "claire",
        {
          slug: "claire",
          version: 1,
          sections: sampleSections(),
          updatedBy: "adam",
          updatedAt: "2026-04-29T00:00:00.000Z",
          reason: "init",
        },
      ],
    ])
  )
  await loadHandbook(db, "claire")
  await loadHandbook(db, "claire")
  const stats = _getHandbookCacheStats()
  assert.equal(stats.hits, 1)
  assert.equal(stats.misses, 1)
})

test("loadHandbook TTL expires and forces re-read", async () => {
  _clearHandbookCache()
  const { db, store } = makeFakeFirestore()
  store.docs.set(
    HANDBOOKS_COLLECTION,
    new Map([
      [
        "claire",
        {
          slug: "claire",
          version: 1,
          sections: sampleSections(),
          updatedBy: "adam",
          updatedAt: "x",
          reason: "init",
        },
      ],
    ])
  )
  await loadHandbook(db, "claire", 5) // 5ms TTL
  await new Promise((r) => setTimeout(r, 15))
  await loadHandbook(db, "claire", 5)
  const stats = _getHandbookCacheStats()
  assert.equal(stats.hits, 0)
  assert.equal(stats.misses, 2)
})

test("loadHandbook ≥95% cache hit rate over 1000 calls (10 distinct slugs)", async () => {
  _clearHandbookCache()
  const { db, store } = makeFakeFirestore()
  const m = new Map<string, Record<string, unknown>>()
  for (let i = 0; i < 10; i++) {
    m.set(`s${i}`, {
      slug: `s${i}`,
      version: 1,
      sections: sampleSections(),
      updatedBy: "x",
      updatedAt: "y",
      reason: "z",
    })
  }
  store.docs.set(HANDBOOKS_COLLECTION, m)
  for (let i = 0; i < 1000; i++) {
    await loadHandbook(db, `s${i % 10}`)
  }
  const stats = _getHandbookCacheStats()
  assert.ok(
    stats.hitRate >= 0.95,
    `hit-rate ${stats.hitRate.toFixed(3)} below 0.95 (hits=${stats.hits} misses=${stats.misses})`
  )
})

// -----------------------------------------------------------------------------
// Writes — saveHandbook + version sub-collection + audit
// -----------------------------------------------------------------------------

test("saveHandbook v1: writes pointer + versions/1 + handbook.create audit row", async () => {
  _clearHandbookCache()
  const { db, store } = makeFakeFirestore()
  const persisted = await saveHandbook(db, "claire", sampleSections(), {
    actor: "adam@wekruit.com",
    reason: "initial seed",
  })
  assert.equal(persisted.version, 1)
  assert.equal(persisted.slug, "claire")
  assert.equal(persisted.updatedBy, "adam@wekruit.com")
  assert.equal(persisted.reason, "initial seed")
  // Pointer doc present.
  const ptr = store.docs.get(HANDBOOKS_COLLECTION)?.get("claire") as
    | HandbookDoc
    | undefined
  assert.ok(ptr, "pointer doc written")
  assert.equal(ptr!.version, 1)
  // Immutable version snapshot present at versions/1.
  const subKey = `${HANDBOOKS_COLLECTION}/claire/${HANDBOOK_VERSIONS_SUBCOLLECTION}`
  const snap1 = store.subDocs.get(subKey)?.get("1")
  assert.ok(snap1, "versions/1 snapshot written")
  assert.equal((snap1 as HandbookDoc).version, 1)
  // Audit row present.
  const audit = store.docs.get("pa-audit-events")
  assert.ok(audit && audit.size === 1, "audit row written")
  const auditRow = Array.from(audit!.values())[0]!
  assert.equal(auditRow.action, "handbook.create")
  assert.equal(auditRow.key, "claire")
  assert.equal(auditRow.actor, "adam@wekruit.com")
})

test("saveHandbook v2: bumps version + writes versions/2 + handbook.update audit", async () => {
  _clearHandbookCache()
  const { db, store } = makeFakeFirestore()
  await saveHandbook(db, "claire", sampleSections(), {
    actor: "adam",
    reason: "v1 seed",
  })
  const next = sampleSections()
  next.identity = "Claire v2"
  const v2 = await saveHandbook(db, "claire", next, {
    actor: "adam",
    reason: "v2 tweak",
  })
  assert.equal(v2.version, 2)
  assert.equal(v2.sections.identity, "Claire v2")
  // versions/1 still present + immutable; versions/2 also present.
  const subKey = `${HANDBOOKS_COLLECTION}/claire/${HANDBOOK_VERSIONS_SUBCOLLECTION}`
  const submap = store.subDocs.get(subKey)
  assert.equal(submap?.size, 2)
  const v1Snap = submap?.get("1") as HandbookDoc
  const v2Snap = submap?.get("2") as HandbookDoc
  assert.equal(v1Snap.version, 1)
  assert.equal(v2Snap.version, 2)
  // Audit log: 2 rows, second is `.update`.
  const audit = store.docs.get("pa-audit-events")
  assert.equal(audit?.size, 2)
  const rows = Array.from(audit!.values())
  assert.equal(rows[0]!.action, "handbook.create")
  assert.equal(rows[1]!.action, "handbook.update")
})

test("saveHandbook: optimistic concurrency — wrong expectedVersion throws", async () => {
  _clearHandbookCache()
  const { db } = makeFakeFirestore()
  await saveHandbook(db, "claire", sampleSections(), {
    actor: "a",
    reason: "v1",
  })
  // Save with stale expected.
  await assert.rejects(
    () =>
      saveHandbook(db, "claire", sampleSections(), {
        actor: "a",
        reason: "v2",
        expectedVersion: 0,
      }),
    /stale version/
  )
})

test("saveHandbook: missing reason throws (audit guarantee)", async () => {
  _clearHandbookCache()
  const { db } = makeFakeFirestore()
  await assert.rejects(
    () =>
      saveHandbook(db, "claire", sampleSections(), {
        actor: "a",
        reason: "   ",
      }),
    /reason is required/
  )
})

test("saveHandbook: cache invalidated after write (next load sees v2)", async () => {
  _clearHandbookCache()
  const { db } = makeFakeFirestore()
  await saveHandbook(db, "claire", sampleSections(), {
    actor: "a",
    reason: "v1",
  })
  const a = await loadHandbook(db, "claire")
  assert.equal(a?.version, 1)
  const next = sampleSections()
  next.identity = "v2"
  await saveHandbook(db, "claire", next, { actor: "a", reason: "v2" })
  const b = await loadHandbook(db, "claire")
  assert.equal(b?.version, 2)
  assert.equal(b?.sections.identity, "v2")
})

// -----------------------------------------------------------------------------
// listVersions + getVersion
// -----------------------------------------------------------------------------

test("listVersions returns snapshots newest-first", async () => {
  _clearHandbookCache()
  const { db } = makeFakeFirestore()
  await saveHandbook(db, "claire", sampleSections(), {
    actor: "a",
    reason: "v1",
  })
  await saveHandbook(db, "claire", sampleSections(), {
    actor: "a",
    reason: "v2",
  })
  await saveHandbook(db, "claire", sampleSections(), {
    actor: "a",
    reason: "v3",
  })
  const rows = await listVersions(db, "claire")
  assert.equal(rows.length, 3)
  assert.equal(rows[0]!.version, 3)
  assert.equal(rows[1]!.version, 2)
  assert.equal(rows[2]!.version, 1)
})

test("getVersion returns immutable snapshot", async () => {
  _clearHandbookCache()
  const { db } = makeFakeFirestore()
  await saveHandbook(db, "claire", sampleSections(), {
    actor: "a",
    reason: "v1",
  })
  const v = await getVersion(db, "claire", 1)
  assert.ok(v)
  assert.equal(v!.version, 1)
})

// -----------------------------------------------------------------------------
// revertHandbook
// -----------------------------------------------------------------------------

test("revertHandbook: reads versions/{target} and writes new v+1", async () => {
  _clearHandbookCache()
  const { db, store } = makeFakeFirestore()
  // v1 — original
  await saveHandbook(db, "claire", sampleSections(), {
    actor: "a",
    reason: "v1",
  })
  // v2 — modified identity
  const next = sampleSections()
  next.identity = "BROKEN v2"
  await saveHandbook(db, "claire", next, { actor: "a", reason: "v2 tweak" })
  // Revert to v1 → produces v3 with v1 sections
  const reverted = await revertHandbook(db, "claire", 1, {
    actor: "ops@wekruit.com",
    reason: "rollback bad tweak",
  })
  assert.equal(reverted.version, 3)
  assert.equal(reverted.sections.identity, "Claire — Bay Area EM, OPT→H1B→GC.")
  assert.match(reverted.reason, /rollback bad tweak/)
  // Pointer is now v3.
  const ptr = store.docs.get(HANDBOOKS_COLLECTION)?.get("claire") as HandbookDoc
  assert.equal(ptr.version, 3)
  // versions/3 exists.
  const subKey = `${HANDBOOKS_COLLECTION}/claire/${HANDBOOK_VERSIONS_SUBCOLLECTION}`
  assert.ok(store.subDocs.get(subKey)?.has("3"))
  // Audit: 3 rows, last is .revert.
  const audit = store.docs.get("pa-audit-events")
  const rows = Array.from(audit!.values())
  assert.equal(rows[2]!.action, "handbook.revert")
  assert.equal(rows[2]!.revertedToVersion, 1)
})

test("revertHandbook: missing target version throws", async () => {
  _clearHandbookCache()
  const { db } = makeFakeFirestore()
  await saveHandbook(db, "claire", sampleSections(), {
    actor: "a",
    reason: "v1",
  })
  await assert.rejects(
    () => revertHandbook(db, "claire", 99, { actor: "a", reason: "x" }),
    /no version 99/
  )
})

// -----------------------------------------------------------------------------
// composeSystemPrompt — fixed-order render
// -----------------------------------------------------------------------------

test("composeSystemPrompt: respects HANDBOOK_RENDER_ORDER + skips empties", () => {
  const handbook: HandbookDoc = {
    slug: "claire",
    version: 1,
    sections: sampleSections(),
    updatedBy: "a",
    updatedAt: "x",
    reason: "y",
  }
  const out = composeSystemPrompt(handbook)
  // Header presence + order.
  const idxIdentity = out.indexOf("# IDENTITY")
  const idxHardRules = out.indexOf("# HARD RULES")
  const idxDefaultPosture = out.indexOf("# DEFAULT POSTURE")
  const idxNevers = out.indexOf("# NEVERs")
  const idxEscape = out.indexOf("# ESCAPE HATCH")
  const idxVocab = out.indexOf("# VOCAB")
  const idxHumanTells = out.indexOf("# HUMAN TELLS")
  const idxToneFlavors = out.indexOf("# TONE FLAVORS")
  const idxPlaybooks = out.indexOf("# PLAYBOOKS")
  for (const i of [
    idxIdentity,
    idxHardRules,
    idxDefaultPosture,
    idxNevers,
    idxEscape,
    idxVocab,
    idxHumanTells,
    idxToneFlavors,
    idxPlaybooks,
  ]) {
    assert.ok(i >= 0, "header present")
  }
  assert.ok(idxIdentity < idxHardRules, "identity before hard_rules")
  assert.ok(idxHardRules < idxDefaultPosture, "hard_rules before default_posture")
  assert.ok(idxDefaultPosture < idxNevers, "default_posture before never_5")
  assert.ok(idxNevers < idxEscape, "never_5 before escape_hatch")
  assert.ok(idxEscape < idxVocab, "escape_hatch before vocab")
  assert.ok(idxVocab < idxHumanTells, "vocab before human_tells")
  assert.ok(idxHumanTells < idxToneFlavors, "human_tells before tone_flavors")
  assert.ok(idxToneFlavors < idxPlaybooks, "tone_flavors before playbooks")
  // Content sanity — playbook headhunter rendered with steps.
  assert.match(out, /headhunter/)
  assert.match(out, /Trigger: JD/)
})

test("composeSystemPrompt: empty sections produce no header (no orphan #)", () => {
  const handbook: HandbookDoc = {
    slug: "claire",
    version: 1,
    sections: emptyHandbookSections(),
    updatedBy: "a",
    updatedAt: "x",
    reason: "y",
  }
  const out = composeSystemPrompt(handbook)
  assert.equal(out, "")
})

test("composeSystemPrompt: identity-only renders just identity block", () => {
  const sections = emptyHandbookSections()
  sections.identity = "Claire."
  const handbook: HandbookDoc = {
    slug: "claire",
    version: 1,
    sections,
    updatedBy: "a",
    updatedAt: "x",
    reason: "y",
  }
  assert.equal(composeSystemPrompt(handbook), "# IDENTITY\nClaire.")
})

test("composeSystemPrompt: hard_rules + never_5 numbered list rendering", () => {
  const sections = emptyHandbookSections()
  sections.hard_rules = ["rule a", "rule b"]
  sections.never_5 = ["never x", "never y"]
  const handbook: HandbookDoc = {
    slug: "claire",
    version: 1,
    sections,
    updatedBy: "a",
    updatedAt: "x",
    reason: "y",
  }
  const out = composeSystemPrompt(handbook)
  assert.match(out, /1\. rule a/)
  assert.match(out, /2\. rule b/)
  assert.match(out, /1\. never x/)
  assert.match(out, /2\. never y/)
})
