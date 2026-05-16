/**
 * Minimal in-memory Firestore double for S4 telemetry tests.
 *
 * Supports the narrow surface S4 needs:
 *   - `collection(path).doc(id).set(data, { merge?: boolean })`
 *   - `collection(path).doc(id).get()`
 *   - `collection(path).doc(id).collection(subPath)...` (subcollections)
 *   - `collection(path).where(field, ">=" | "==" | "<=", value)`
 *       .orderBy(field, "desc" | "asc")
 *       .limit(n).get()`
 *
 * Each `collection().doc()` returns a fresh ref but state is keyed by
 * the absolute path so subcollections behave correctly.
 *
 * Kept local to the S4 test dir to avoid bleeding new features into the
 * shared `job-rec/__tests__/mock-firestore.ts` which other tests depend on.
 */

import type { Firestore } from "firebase-admin/firestore"

type Row = Record<string, unknown>

export class FakeFirestore {
  /** absolute collection path -> docId -> data */
  store: Map<string, Map<string, Row>> = new Map()
  writeLog: { path: string; id: string; data: Row; mode: "set" | "merge" }[] = []

  collection(path: string): FakeColl {
    return new FakeColl(this, path)
  }

  _getColl(path: string): Map<string, Row> {
    let m = this.store.get(path)
    if (!m) {
      m = new Map()
      this.store.set(path, m)
    }
    return m
  }
}

type FilterOp = "==" | "<=" | ">=" | ">" | "<" | "in"
type Filter = { field: string; op: FilterOp; value: unknown }

class FakeQuery {
  constructor(
    protected fs: FakeFirestore,
    protected path: string,
    protected filters: Filter[] = [],
    protected orderField?: string,
    protected orderDir: "asc" | "desc" = "asc",
    protected lim: number = 0,
  ) {}

  where(field: string, op: FilterOp, value: unknown): FakeQuery {
    return new FakeQuery(
      this.fs,
      this.path,
      [...this.filters, { field, op, value }],
      this.orderField,
      this.orderDir,
      this.lim,
    )
  }

  orderBy(field: string, dir: "asc" | "desc" = "asc"): FakeQuery {
    return new FakeQuery(this.fs, this.path, this.filters, field, dir, this.lim)
  }

  limit(n: number): FakeQuery {
    return new FakeQuery(this.fs, this.path, this.filters, this.orderField, this.orderDir, n)
  }

  async get(): Promise<{
    docs: { id: string; data: () => Row; exists: boolean }[]
    size: number
    empty: boolean
  }> {
    const coll = this.fs._getColl(this.path)
    let rows = [...coll.entries()].filter(([, v]) =>
      this.filters.every((f) => matchFilter(v[f.field], f.op, f.value)),
    )
    if (this.orderField) {
      rows.sort(([, a], [, b]) => {
        const av = a[this.orderField!]
        const bv = b[this.orderField!]
        if (typeof av === "number" && typeof bv === "number") {
          return this.orderDir === "desc" ? bv - av : av - bv
        }
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
    }))
    return { docs, size: docs.length, empty: docs.length === 0 }
  }
}

function matchFilter(got: unknown, op: FilterOp, want: unknown): boolean {
  if (op === "==") return got === want
  if (op === "in") return Array.isArray(want) && want.includes(got)
  if (typeof got === "number" && typeof want === "number") {
    if (op === ">=") return got >= want
    if (op === ">") return got > want
    if (op === "<=") return got <= want
    if (op === "<") return got < want
  }
  if (typeof got === "string" && typeof want === "string") {
    if (op === ">=") return got >= want
    if (op === "<=") return got <= want
  }
  return false
}

class FakeColl extends FakeQuery {
  constructor(fs: FakeFirestore, path: string) {
    super(fs, path, [], undefined, "asc", 0)
  }
  doc(id?: string): FakeDocRef {
    const did = id ?? `auto-${Math.random().toString(36).slice(2, 10)}`
    return new FakeDocRef(this.fs, this.path, did)
  }
}

class FakeDocRef {
  constructor(public fs: FakeFirestore, public collPath: string, public id: string) {}

  async set(data: Row, opts?: { merge?: boolean }): Promise<void> {
    const coll = this.fs._getColl(this.collPath)
    if (opts?.merge && coll.has(this.id)) {
      coll.set(this.id, { ...(coll.get(this.id) ?? {}), ...data })
    } else {
      coll.set(this.id, { ...data })
    }
    this.fs.writeLog.push({
      path: this.collPath,
      id: this.id,
      data: { ...data },
      mode: opts?.merge ? "merge" : "set",
    })
  }

  async get(): Promise<{ id: string; exists: boolean; data: () => Row | undefined }> {
    const coll = this.fs._getColl(this.collPath)
    const exists = coll.has(this.id)
    const data = coll.get(this.id)
    return {
      id: this.id,
      exists,
      data: () => (exists && data ? { ...data } : undefined),
    }
  }

  collection(sub: string): FakeColl {
    return new FakeColl(this.fs, `${this.collPath}/${this.id}/${sub}`)
  }
}

export function asFirestore(f: FakeFirestore): Firestore {
  return f as unknown as Firestore
}
