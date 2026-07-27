/**
 * Lightweight in-memory Firestore mock that satisfies the `Firestore`
 * surface area used by the job-rec package: `collection().doc().set/get`,
 * `collection().where().where().orderBy().limit().get()`, and
 * `runTransaction`. Not a general-purpose Firestore stub — intentionally
 * narrow so tests fail loudly if production code starts using a feature
 * the mock doesn't implement.
 */

import type { Firestore } from "firebase-admin/firestore"

type DocSnap = {
  id: string
  exists: boolean
  data: () => Record<string, unknown> | undefined
  ref: { id: string; collectionPath: string }
}

export class MockFirestore {
  /** collectionPath -> docId -> data */
  store: Map<string, Map<string, Record<string, unknown>>> = new Map()
  writeLog: { path: string; id: string; data: Record<string, unknown>; mode: "set" | "merge" | "delete" }[] = []

  private getColl(path: string): Map<string, Record<string, unknown>> {
    let m = this.store.get(path)
    if (!m) {
      m = new Map()
      this.store.set(path, m)
    }
    return m
  }

  collection(path: string): Coll {
    return new Coll(this, path)
  }

  async getAll(...refs: DocRef[]): Promise<DocSnap[]> {
    return Promise.all(refs.map((ref) => ref.get()))
  }

  async runTransaction<T>(cb: (tx: Tx) => Promise<T>): Promise<T> {
    const tx = new Tx(this)
    return cb(tx)
  }
}

class DocRef {
  constructor(private mfs: MockFirestore, public collectionPath: string, public id: string) {}

  async set(data: Record<string, unknown>, opts?: { merge?: boolean }): Promise<void> {
    const coll = (this.mfs as unknown as { getColl: (p: string) => Map<string, Record<string, unknown>> })
      .getColl(this.collectionPath)
    if (opts?.merge && coll.has(this.id)) {
      coll.set(this.id, { ...(coll.get(this.id) ?? {}), ...data })
    } else {
      coll.set(this.id, { ...data })
    }
    this.mfs.writeLog.push({
      path: this.collectionPath,
      id: this.id,
      data: { ...data },
      mode: opts?.merge ? "merge" : "set",
    })
  }

  /** Single-use credentials (OAuth codes) are consumed by deleting them, not by flagging them. */
  async delete(): Promise<void> {
    const coll = (this.mfs as unknown as { getColl: (p: string) => Map<string, Record<string, unknown>> })
      .getColl(this.collectionPath)
    coll.delete(this.id)
    this.mfs.writeLog.push({ path: this.collectionPath, id: this.id, data: {}, mode: "delete" })
  }

  async get(): Promise<DocSnap> {
    const coll = (this.mfs as unknown as { getColl: (p: string) => Map<string, Record<string, unknown>> })
      .getColl(this.collectionPath)
    const exists = coll.has(this.id)
    const data = coll.get(this.id)
    return {
      id: this.id,
      exists,
      data: () => (exists ? { ...data! } : undefined),
      ref: { id: this.id, collectionPath: this.collectionPath },
    }
  }

  // Subcollection → a distinct collection keyed by the composite Firestore path
  // `${parentCollection}/${docId}/${subPath}`, mirroring real Firestore so
  // pa-user-job-recommendations/{uid}/jobs is isolated per-user.
  collection(subPath: string): Coll {
    return new Coll(this.mfs, `${this.collectionPath}/${this.id}/${subPath}`)
  }
}

type Filter = { field: string; op: "==" | "<=" | "in"; value: unknown }
type Order = { field: string; dir: "asc" | "desc" }
class Query {
  constructor(
    protected mfs: MockFirestore,
    protected collectionPath: string,
    protected filters: Filter[] = [],
    protected orders: Order[] = [],
    protected lim: number = 0,
    protected startAfterValues?: unknown[]
  ) {}

  where(field: string, op: "==" | "<=" | "in", value: unknown): Query {
    return new Query(this.mfs, this.collectionPath, [...this.filters, { field, op, value }], this.orders, this.lim, this.startAfterValues)
  }

  orderBy(field: string, dir: "asc" | "desc" = "asc"): Query {
    return new Query(this.mfs, this.collectionPath, this.filters, [...this.orders, { field, dir }], this.lim, this.startAfterValues)
  }

  limit(n: number): Query {
    return new Query(this.mfs, this.collectionPath, this.filters, this.orders, n, this.startAfterValues)
  }

  // Tuple cursor over the orderBy fields — strict-after semantics like real
  // Firestore, string-compared like the ISO timestamps / doc ids production
  // code paginates on. `__name__` resolves to the document id.
  startAfter(...values: unknown[]): Query {
    return new Query(this.mfs, this.collectionPath, this.filters, this.orders, this.lim, values)
  }

  // Field-mask pass-through: production code only narrows the payload, so
  // returning full docs keeps the mock simple without changing behavior.
  select(..._fields: string[]): Query {
    return new Query(this.mfs, this.collectionPath, this.filters, this.orders, this.lim, this.startAfterValues)
  }

  count(): { get: () => Promise<{ data: () => { count: number } }> } {
    const unlimited = new Query(this.mfs, this.collectionPath, this.filters, this.orders, 0, this.startAfterValues)
    return {
      get: async () => {
        const res = await unlimited.get()
        return { data: () => ({ count: res.size }) }
      },
    }
  }

  private orderValue(id: string, data: Record<string, unknown>, field: string): unknown {
    return field === "__name__" ? id : data[field]
  }

  private compareForOrder(a: unknown, b: unknown, dir: "asc" | "desc"): number {
    if (typeof a !== "string" || typeof b !== "string") return 0
    return dir === "desc" ? b.localeCompare(a) : a.localeCompare(b)
  }

  async get(): Promise<{ docs: DocSnap[]; size: number; empty: boolean }> {
    const coll = (this.mfs as unknown as { getColl: (p: string) => Map<string, Record<string, unknown>> })
      .getColl(this.collectionPath)
    const all = [...coll.entries()]
    let rows = all.filter(([, v]) =>
      this.filters.every((f) => {
        const got = (v as Record<string, unknown>)[f.field]
        if (f.op === "==") return got === f.value
        if (f.op === "<=") return typeof got === "string" && typeof f.value === "string" && got <= f.value
        if (f.op === "in") return Array.isArray(f.value) && f.value.includes(got)
        return false
      })
    )
    if (this.orders.length > 0) {
      rows.sort(([aId, a], [bId, b]) => {
        for (const order of this.orders) {
          const cmp = this.compareForOrder(
            this.orderValue(aId, a as Record<string, unknown>, order.field),
            this.orderValue(bId, b as Record<string, unknown>, order.field),
            order.dir,
          )
          if (cmp !== 0) return cmp
        }
        return 0
      })
    }
    if (this.startAfterValues !== undefined && this.orders.length > 0) {
      const cursor = this.startAfterValues
      rows = rows.filter(([id, v]) => {
        for (let i = 0; i < cursor.length && i < this.orders.length; i += 1) {
          const order = this.orders[i]!
          const got = this.orderValue(id, v as Record<string, unknown>, order.field)
          if (typeof got !== "string" || typeof cursor[i] !== "string") return false
          const cmp = this.compareForOrder(got, cursor[i], order.dir)
          if (cmp !== 0) return cmp > 0
        }
        return false
      })
    }
    if (this.lim > 0) rows = rows.slice(0, this.lim)
    const docs = rows.map(([id, v]) => ({
      id,
      exists: true,
      data: () => ({ ...v }),
      ref: { id, collectionPath: this.collectionPath },
    }))
    return { docs, size: docs.length, empty: docs.length === 0 }
  }
}

class Coll extends Query {
  constructor(mfs: MockFirestore, collectionPath: string) {
    super(mfs, collectionPath, [], [], 0)
  }
  doc(id?: string): DocRef {
    const docId = id ?? `auto-${Math.random().toString(36).slice(2, 10)}`
    return new DocRef(this.mfs, this.collectionPath, docId)
  }

  // Mirrors firebase-admin `CollectionReference.add` — auto-id doc + set.
  async add(data: Record<string, unknown>): Promise<DocRef> {
    const ref = this.doc()
    await ref.set(data)
    return ref
  }
}

class Tx {
  constructor(private mfs: MockFirestore) {}
  async get(ref: DocRef | DocSnap | { id: string; collectionPath: string }): Promise<DocSnap> {
    if ("get" in ref && typeof (ref as DocRef).get === "function") {
      return (ref as DocRef).get()
    }
    const doc = ref as { id: string; collectionPath: string }
    const docRef = new DocRef(this.mfs, doc.collectionPath, doc.id)
    return docRef.get()
  }
  set(ref: DocRef | { id: string; collectionPath: string }, data: Record<string, unknown>): void {
    if ("set" in ref && typeof (ref as DocRef).set === "function") {
      void (ref as DocRef).set(data)
      return
    }
    const doc = ref as { id: string; collectionPath: string }
    void new DocRef(this.mfs, doc.collectionPath, doc.id).set(data)
  }
  update(ref: DocRef | { id: string; collectionPath: string }, data: Record<string, unknown>): void {
    this.set(ref, data)
  }
}

export function asFirestore(m: MockFirestore): Firestore {
  return m as unknown as Firestore
}
