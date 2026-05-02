/**
 * v1.5 Stream-G.2 / Phase 51 — paJobRecClusterRebuild handler tests.
 *
 * One integration-style test exercises all three branches (eventKind
 * mismatch noop, flag-off skip, flag-on rebuild end-to-end) of the pure
 * handler `handleClusterRebuildEvent`. Production CF wrapper is a thin
 * shim over this handler so coverage here is sufficient.
 */

import test from "node:test"
import assert from "node:assert/strict"
import type { Firestore } from "firebase-admin/firestore"
import {
  handleClusterRebuildEvent,
  TARGET_EVENT_KIND,
} from "../job-rec-cluster-rebuild.js"

// -----------------------------------------------------------------------------
// In-memory Firestore double — narrow surface (collection/doc/where/orderBy/
// startAfter/limit/get + set). Mirrors the daily-batch mock-firestore but
// adds startAfter for the rebuild paginator.
// -----------------------------------------------------------------------------

interface FakeDocSnap {
  id: string
  exists: boolean
  data(): Record<string, unknown> | undefined
}

interface FakeQuery {
  where(f: string, op: string, v: unknown): FakeQuery
  orderBy(f: string, dir?: "asc" | "desc"): FakeQuery
  startAfter(v: string): FakeQuery
  limit(n: number): FakeQuery
  get(): Promise<{ docs: FakeDocSnap[]; size: number; empty: boolean }>
}

interface FakeDocRef {
  set(data: Record<string, unknown>): Promise<void>
  get(): Promise<FakeDocSnap>
}

interface FakeColl extends FakeQuery {
  doc(id?: string): FakeDocRef
}

class FakeDb {
  store = new Map<string, Map<string, Record<string, unknown>>>()
  writes: { path: string; id: string; data: Record<string, unknown> }[] = []

  private getColl(p: string): Map<string, Record<string, unknown>> {
    let m = this.store.get(p)
    if (!m) {
      m = new Map()
      this.store.set(p, m)
    }
    return m
  }

  private buildQuery(
    path: string,
    filters: { f: string; v: unknown }[],
    orderField: string | null,
    orderDir: "asc" | "desc",
    lim: number,
    startAfterVal: string | undefined
  ): FakeQuery {
    const self = this
    return {
      where(f: string, _op: string, v: unknown): FakeQuery {
        return self.buildQuery(
          path,
          [...filters, { f, v }],
          orderField,
          orderDir,
          lim,
          startAfterVal
        )
      },
      orderBy(f: string, dir: "asc" | "desc" = "asc"): FakeQuery {
        return self.buildQuery(path, filters, f, dir, lim, startAfterVal)
      },
      startAfter(v: string): FakeQuery {
        return self.buildQuery(path, filters, orderField, orderDir, lim, v)
      },
      limit(n: number): FakeQuery {
        return self.buildQuery(path, filters, orderField, orderDir, n, startAfterVal)
      },
      async get() {
        const all = [...self.getColl(path).entries()]
        let rows = all.filter(([, d]) => filters.every((f) => d[f.f] === f.v))
        if (orderField) {
          rows.sort(([, a], [, b]) => {
            const av = String(a[orderField] ?? "")
            const bv = String(b[orderField] ?? "")
            return orderDir === "desc" ? bv.localeCompare(av) : av.localeCompare(bv)
          })
        }
        if (startAfterVal !== undefined && orderField) {
          rows = rows.filter(([, d]) => {
            const v = String(d[orderField] ?? "")
            return orderDir === "desc" ? v < startAfterVal : v > startAfterVal
          })
        }
        if (lim > 0) rows = rows.slice(0, lim)
        const docs: FakeDocSnap[] = rows.map(([id, d]) => ({
          id,
          exists: true,
          data: () => ({ ...d }),
        }))
        return { docs, size: docs.length, empty: docs.length === 0 }
      },
    }
  }

  collection(path: string): FakeColl {
    const self = this
    const q = self.buildQuery(path, [], null, "asc", 0, undefined)
    const coll: FakeColl = {
      ...q,
      doc(id?: string): FakeDocRef {
        const docId = id ?? `auto-${Math.random().toString(36).slice(2, 10)}`
        return {
          async set(data: Record<string, unknown>): Promise<void> {
            self.getColl(path).set(docId, { ...data })
            self.writes.push({ path, id: docId, data: { ...data } })
          },
          async get(): Promise<FakeDocSnap> {
            const d = self.getColl(path).get(docId)
            return {
              id: docId,
              exists: d !== undefined,
              data: () => (d ? { ...d } : undefined),
            }
          },
        }
      },
    }
    return coll
  }
}

function asFirestore(f: FakeDb): Firestore {
  return f as unknown as Firestore
}

// -----------------------------------------------------------------------------
// Test: handler dispatches all three branches correctly + rebuild fires
// -----------------------------------------------------------------------------

test("paJobRecClusterRebuild handler: filters eventKind, gates on flag, rebuilds when both pass", async () => {
  // ---------- branch 1: wrong eventKind → silent noop ----------
  const fdb1 = new FakeDb()
  const out1 = await handleClusterRebuildEvent(
    { eventData: { eventKind: "other:event", runId: "r1" }, eventId: "evt-1" },
    {
      db: asFirestore(fdb1),
      isFlagOn: async () => true, // even with flag on, wrong kind skips
    }
  )
  assert.equal(out1.kind, "skipped_event_kind")

  // ---------- branch 2: matching kind, flag OFF → skipped ----------
  const fdb2 = new FakeDb()
  const out2 = await handleClusterRebuildEvent(
    {
      eventData: { eventKind: TARGET_EVENT_KIND, runId: "r2" },
      eventId: "evt-2",
    },
    {
      db: asFirestore(fdb2),
      isFlagOn: async () => false, // flag off → no rebuild
    }
  )
  assert.equal(out2.kind, "skipped_flag_off")
  if (out2.kind === "skipped_flag_off") {
    assert.equal(out2.runId, "r2")
  }

  // ---------- branch 3: matching kind + flag ON → rebuild fires ----------
  const fdb3 = new FakeDb()
  // Seed an active matching-job so rebuild has something to bucket.
  // Phase 51 alignment fix — cluster key is now (industry, sponsorshipBucket).
  // Seeding sponsorship=true so this job lands in the "sponsor" bucket.
  await fdb3.collection("matching-jobs").doc("j1").set({
    status: "active",
    industryKey: "tech_software",
    requiredSkills: ["python", "ts"],
    sponsorship: true,
    firstSeenAt: "2026-05-01",
  })
  const out3 = await handleClusterRebuildEvent(
    {
      eventData: { eventKind: TARGET_EVENT_KIND, runId: "r3" },
      eventId: "evt-3",
    },
    {
      db: asFirestore(fdb3),
      isFlagOn: async () => true,
    }
  )
  assert.equal(out3.kind, "rebuilt")
  if (out3.kind === "rebuilt") {
    assert.equal(out3.runId, "r3")
    assert.equal(out3.outcome.clusters, 1, "exactly 1 cluster bucketed")
    assert.equal(out3.outcome.jobsBucketed, 1)
    // Cluster doc was written to the v2 collection (Phase 51 alignment fix).
    const clusterWrites = fdb3.writes.filter((w) => w.path === "pa-rec-tag-clusters-v2")
    assert.equal(clusterWrites.length, 1)
    assert.equal(clusterWrites[0]!.data.lastRebuildRunId, "r3")
    // Sanity: cluster doc carries the sponsorship bucket the job mapped to.
    assert.equal(clusterWrites[0]!.data.sponsorshipBucket, "sponsor")
    assert.equal(clusterWrites[0]!.data.industryEnum, "tech_software")
  }
})
