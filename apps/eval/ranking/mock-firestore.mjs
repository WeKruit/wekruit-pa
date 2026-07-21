/**
 * Lightweight in-memory Firestore mock for the offline ranking eval. Ported
 * from `apps/job-rec/src/__tests__/mock-firestore.ts` (the same surface the
 * V16 matcher tests use) so `queryMatchingJobsV16` runs against a deterministic
 * corpus with $0 cost — no Firestore, no LLM, no network.
 *
 * Implements only the surface `queryMatchingJobsV16` touches:
 *   collection().doc().set/get
 *   collection().where().where().orderBy().limit().get()
 *   subcollection enumeration (jdrel cache reads)
 *   runTransaction (unused by the matcher read path, included for parity)
 *
 * @module mock-firestore
 */

class DocRef {
  constructor(mfs, collectionPath, id) {
    this.mfs = mfs
    this.collectionPath = collectionPath
    this.id = id
  }

  async set(data, opts) {
    const coll = this.mfs._getColl(this.collectionPath)
    if (opts?.merge && coll.has(this.id)) {
      coll.set(this.id, { ...(coll.get(this.id) ?? {}), ...data })
    } else {
      coll.set(this.id, { ...data })
    }
  }

  async get() {
    const coll = this.mfs._getColl(this.collectionPath)
    const exists = coll.has(this.id)
    const data = coll.get(this.id)
    return {
      id: this.id,
      exists,
      data: () => (exists ? { ...data } : undefined),
      ref: { id: this.id, collectionPath: this.collectionPath },
    }
  }

  collection(subPath) {
    return new Coll(this.mfs, `${this.collectionPath}/${this.id}/${subPath}`)
  }
}

class Query {
  constructor(mfs, collectionPath, filters = [], orderField = undefined, orderDir = "asc", lim = 0) {
    this.mfs = mfs
    this.collectionPath = collectionPath
    this.filters = filters
    this.orderField = orderField
    this.orderDir = orderDir
    this.lim = lim
  }

  where(field, op, value) {
    return new Query(this.mfs, this.collectionPath, [...this.filters, { field, op, value }], this.orderField, this.orderDir, this.lim)
  }

  orderBy(field, dir = "asc") {
    return new Query(this.mfs, this.collectionPath, this.filters, field, dir, this.lim)
  }

  limit(n) {
    return new Query(this.mfs, this.collectionPath, this.filters, this.orderField, this.orderDir, n)
  }

  async get() {
    const coll = this.mfs._getColl(this.collectionPath)
    const all = [...coll.entries()]
    let rows = all.filter(([, v]) =>
      this.filters.every((f) => {
        const got = v[f.field]
        if (f.op === "==") return got === f.value
        if (f.op === "<=") return typeof got === "string" && typeof f.value === "string" && got <= f.value
        if (f.op === "in") return Array.isArray(f.value) && f.value.includes(got)
        if (f.op === "array-contains") return Array.isArray(got) && got.includes(f.value)
        if (f.op === "array-contains-any") {
          if (!Array.isArray(got) || !Array.isArray(f.value)) return false
          const want = new Set(f.value)
          for (const g of got) if (want.has(g)) return true
          return false
        }
        return false
      })
    )
    if (this.orderField) {
      const field = this.orderField
      rows.sort(([, a], [, b]) => {
        const av = a[field]
        const bv = b[field]
        if (typeof av === "string" && typeof bv === "string") {
          return this.orderDir === "desc" ? bv.localeCompare(av) : av.localeCompare(bv)
        }
        return 0
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
  constructor(mfs, collectionPath) {
    super(mfs, collectionPath, [], undefined, "asc", 0)
  }
  doc(id) {
    const docId = id ?? `auto-${Math.random().toString(36).slice(2, 10)}`
    return new DocRef(this.mfs, this.collectionPath, docId)
  }
}

export class MockFirestore {
  constructor() {
    /** @type {Map<string, Map<string, Record<string, unknown>>>} */
    this.store = new Map()
  }

  _getColl(path) {
    let m = this.store.get(path)
    if (!m) {
      m = new Map()
      this.store.set(path, m)
    }
    return m
  }

  collection(path) {
    return new Coll(this, path)
  }

  async runTransaction(cb) {
    const tx = {
      get: (ref) => ref.get(),
      set: (ref, data) => void ref.set(data),
      update: (ref, data) => void ref.set(data, { merge: true }),
    }
    return cb(tx)
  }
}

/** Cast the mock to the `Firestore` shape the matcher expects. */
export function asFirestore(m) {
  return m
}
