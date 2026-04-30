/**
 * Phase 29 T4 — orchestrator handbook integration test.
 *
 * Verifies the new T4 wire-in:
 *   1. loadHandbookV2(slug) → composeSystemPrompt → expected fixed-order
 *      composition string when pa-handbooks/{slug} v1 exists
 *   2. fallback chain: v2 missing OR composed empty → orchestrator
 *      reads agent.systemPrompt
 *   3. cache: 2nd loadHandbookV2 of same slug is a hit (mirrors
 *      pa-persistence test, sanity check via loader re-export surface)
 *
 * The orchestrator's internal block under packages/pa-orchestrator/src/
 * index.ts uses the SAME loadHandbookV2 + composeSystemPrompt re-exports;
 * exercising them here at the loader boundary is the same code path the
 * runtime takes (one less mocking layer than stubbing `runAgentTurn`).
 */
import assert from "node:assert/strict"
import test from "node:test"
import type { Firestore } from "firebase-admin/firestore"
import {
  _clearHandbookCache,
  _getHandbookCacheStats,
  composeSystemPrompt,
  DEFAULT_HANDBOOK_SLUG,
  HANDBOOK_RENDER_ORDER,
  loadHandbook,
  saveHandbook,
} from "../handbook/loader.js"

// ---------------------------------------------------------------------------
// Inline Firestore double — minimal subset of what loadHandbook + saveHandbook
// touch. Same shape as packages/pa-persistence/src/handbook.test.ts; copied
// (rather than re-exported) so this test is self-contained and doesn't
// depend on test-file ordering or require pa-persistence to ship test code.
// ---------------------------------------------------------------------------

interface FakeStore {
  docs: Map<string, Map<string, Record<string, unknown>>>
  subDocs: Map<string, Map<string, Record<string, unknown>>>
}

function makeFakeFirestore() {
  const store: FakeStore = { docs: new Map(), subDocs: new Map() }
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
                const rows = Array.from(submap.entries()).map(([id, data]) => ({ id, data }))
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
                  docs: sliced.map((r) => ({ id: r.id, data: () => r.data })),
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
        async get(ref: { _col?: string; _id: string; _isDoc?: true; _isSubDoc?: true; _parentCol?: string; _parentDoc?: string; _subCol?: string }) {
          if (ref._isSubDoc) {
            const m = subMap(ref._parentCol!, ref._parentDoc!, ref._subCol!)
            const v = m.get(ref._id)
            return { exists: v !== undefined, data: () => v }
          }
          const v = collMap(ref._col!).get(ref._id)
          return { exists: v !== undefined, data: () => v }
        },
        set(ref: { _col?: string; _id: string; _isDoc?: true; _isSubDoc?: true; _parentCol?: string; _parentDoc?: string; _subCol?: string }, v: Record<string, unknown>) {
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
        if (w.kind === "doc") collMap(w.col).set(w.id, w.v)
        else subMap(w.parentCol, w.parentDoc, w.subCol).set(w.id, w.v)
      }
      return result
    },
  }
  return { db: db as unknown as Firestore, store }
}

// ---------------------------------------------------------------------------
// Reproduction of the orchestrator's T4 fallback chain — same logic that
// processInboundEvent applies, extracted as a pure function so we can
// black-box test it without the entire SDK turn machinery.
// ---------------------------------------------------------------------------

async function resolveSystemPrompt(opts: {
  db: Firestore | null
  agent: { id: string; systemPrompt: string; handbookSlug?: string }
}): Promise<{
  source: "v2" | "inline"
  systemPrompt: string
}> {
  let composed: string | null = null
  if (opts.db != null) {
    const slug = opts.agent.handbookSlug ?? DEFAULT_HANDBOOK_SLUG
    try {
      const handbook = await loadHandbook(opts.db, slug)
      if (handbook) {
        const c = composeSystemPrompt(handbook).trim()
        if (c.length > 0) composed = c
      }
    } catch {
      // swallow — fall through to inline
    }
  }
  if (composed != null) return { source: "v2", systemPrompt: composed }
  return { source: "inline", systemPrompt: opts.agent.systemPrompt }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("T4: handbook v1 present → systemPrompt matches fixed-order composition", async () => {
  _clearHandbookCache()
  const { db } = makeFakeFirestore()
  await saveHandbook(
    db,
    "claire",
    {
      identity: "Claire — short identity.",
      hard_rules: ["never violate user trust"],
      default_posture: "stay short.",
      never_5: ["never probe", "never coach"],
      escape_hatch: "explicit ask → 1 take.",
      tone_flavors: { celebrate: "牛 / lfg" },
      human_tells: ["uhh", "nvm"],
      vocab: { allowed: ["卷", "lfg"], banned: ["首先"] },
      playbooks: {
        headhunter: {
          name: "headhunter",
          trigger: "JD ping",
          steps: ["read", "1 take"],
          exitCondition: "topic change",
        },
      },
    },
    { actor: "test", reason: "T4 integration seed" }
  )
  const out = await resolveSystemPrompt({
    db,
    agent: { id: "default", systemPrompt: "INLINE FALLBACK SHOULD NOT APPEAR", handbookSlug: "claire" },
  })
  assert.equal(out.source, "v2")
  assert.match(out.systemPrompt, /# IDENTITY\nClaire — short identity\./)
  assert.match(out.systemPrompt, /# HARD RULES\n1\. never violate user trust/)
  assert.match(out.systemPrompt, /# DEFAULT POSTURE\nstay short\./)
  assert.match(out.systemPrompt, /# NEVERs\n1\. never probe\n2\. never coach/)
  assert.match(out.systemPrompt, /# ESCAPE HATCH\nexplicit ask → 1 take\./)
  assert.match(out.systemPrompt, /# VOCAB\nAllowed: 卷 \/ lfg\nBanned: 首先/)
  assert.match(out.systemPrompt, /# HUMAN TELLS\n1\. uhh\n2\. nvm/)
  assert.match(out.systemPrompt, /# TONE FLAVORS\ncelebrate: 牛 \/ lfg/)
  assert.match(out.systemPrompt, /# PLAYBOOKS\n## headhunter/)
  // Order check: identity precedes every other header.
  for (const h of [
    "# HARD RULES",
    "# DEFAULT POSTURE",
    "# NEVERs",
    "# ESCAPE HATCH",
    "# VOCAB",
    "# HUMAN TELLS",
    "# TONE FLAVORS",
    "# PLAYBOOKS",
  ]) {
    assert.ok(
      out.systemPrompt.indexOf("# IDENTITY") < out.systemPrompt.indexOf(h),
      `IDENTITY must precede ${h}`
    )
  }
  // Inline systemPrompt must NOT appear in output.
  assert.ok(
    !out.systemPrompt.includes("INLINE FALLBACK"),
    "v2 path must not leak inline systemPrompt"
  )
})

test("T4: handbook missing → fall back to agent.systemPrompt inline", async () => {
  _clearHandbookCache()
  const { db } = makeFakeFirestore()
  // No saveHandbook call → pa-handbooks/claire absent
  const out = await resolveSystemPrompt({
    db,
    agent: { id: "default", systemPrompt: "INLINE Bible v7.4 here", handbookSlug: "claire" },
  })
  assert.equal(out.source, "inline")
  assert.equal(out.systemPrompt, "INLINE Bible v7.4 here")
})

test("T4: handbook present but composed empty → fall back to inline", async () => {
  _clearHandbookCache()
  const { db } = makeFakeFirestore()
  // Save a handbook with all sections empty.
  await saveHandbook(
    db,
    "claire",
    {
      identity: "",
      hard_rules: [],
      default_posture: "",
      never_5: [],
      escape_hatch: "",
      tone_flavors: {},
      human_tells: [],
      vocab: { allowed: [], banned: [] },
      playbooks: {},
    },
    { actor: "test", reason: "empty seed (degenerate)" }
  )
  const out = await resolveSystemPrompt({
    db,
    agent: { id: "default", systemPrompt: "INLINE fallback", handbookSlug: "claire" },
  })
  assert.equal(out.source, "inline")
  assert.equal(out.systemPrompt, "INLINE fallback")
})

test("T4: agent.handbookSlug absent → falls through to default 'claire'", async () => {
  _clearHandbookCache()
  const { db } = makeFakeFirestore()
  await saveHandbook(
    db,
    DEFAULT_HANDBOOK_SLUG,
    {
      identity: "default-slug identity",
      hard_rules: [],
      default_posture: "",
      never_5: [],
      escape_hatch: "",
      tone_flavors: {},
      human_tells: [],
      vocab: { allowed: [], banned: [] },
      playbooks: {},
    },
    { actor: "test", reason: "default slug seed" }
  )
  const out = await resolveSystemPrompt({
    db,
    // NB: no handbookSlug field
    agent: { id: "default", systemPrompt: "INLINE" },
  })
  assert.equal(out.source, "v2")
  assert.match(out.systemPrompt, /default-slug identity/)
})

test("T4: db missing → fall back to inline (degraded mode)", async () => {
  _clearHandbookCache()
  const out = await resolveSystemPrompt({
    db: null,
    agent: { id: "default", systemPrompt: "INLINE Bible (degraded)", handbookSlug: "claire" },
  })
  assert.equal(out.source, "inline")
  assert.equal(out.systemPrompt, "INLINE Bible (degraded)")
})

test("T4: 2nd loadHandbook hits the 30s TTL cache", async () => {
  _clearHandbookCache()
  const { db } = makeFakeFirestore()
  await saveHandbook(
    db,
    "claire",
    {
      identity: "x",
      hard_rules: [],
      default_posture: "",
      never_5: [],
      escape_hatch: "",
      tone_flavors: {},
      human_tells: [],
      vocab: { allowed: [], banned: [] },
      playbooks: {},
    },
    { actor: "t", reason: "cache test" }
  )
  // saveHandbook invalidates cache, so first load is a miss.
  await loadHandbook(db, "claire")
  await loadHandbook(db, "claire")
  await loadHandbook(db, "claire")
  const stats = _getHandbookCacheStats()
  assert.equal(stats.misses, 1, "only first load misses")
  assert.equal(stats.hits, 2, "2nd + 3rd loads hit cache")
})

test("T4: HANDBOOK_RENDER_ORDER constant exposed via loader (sanity)", () => {
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
