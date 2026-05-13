/**
 * v2.0 External Supply V1 — Wave E — In-memory Firestore fake shared
 * across the end-to-end test + future regression harnesses.
 *
 * The shape mirrors what every external-supply handler / persister actually
 * touches:
 *   - `db.collection(name).doc(id)` with `.get()` / `.set(data, {merge?})`.
 *   - `db.collection(name).add(data)` → returns `{ id }` (used by the
 *     outreach tool-call audit writer).
 *   - `db.collection(name).where(field, op, value)` returning `.get()` and
 *     `.limit(n).get()`; equality is the only operator V1 callers rely on
 *     and the only one we implement.
 *   - `db.batch()` returning a Firestore-WriteBatch-shaped object whose
 *     `.commit()` flushes every queued `.set()` / `.update()` / `.delete()`.
 *
 * This is intentionally NOT a full Firestore emulator — it's the smallest
 * shape that lets the production handlers run end-to-end against
 * deterministic in-process state.
 */
import type { Firestore } from "firebase-admin/firestore"
import { PA_COLLECTIONS } from "@pa/core-types"

export type FakeStore = Map<string, Map<string, Record<string, unknown>>>

/**
 * Build an empty store seeded with every collection name we expect to read
 * from. Adapters / handlers that touch additional collections (e.g.
 * `pa-jobs`, `pa-companies`, `pa-tool-calls`) get lazily-created sub-maps
 * via `ensureCol`.
 */
export function makeFakeStore(): FakeStore {
  const store: FakeStore = new Map()
  for (const name of Object.values(PA_COLLECTIONS)) {
    store.set(name, new Map())
  }
  // Collections written via raw string (NOT in PA_COLLECTIONS).
  store.set("pa-jobs", new Map())
  store.set("pa-companies", new Map())
  return store
}

export function ensureCol(
  store: FakeStore,
  name: string,
): Map<string, Record<string, unknown>> {
  if (!store.has(name)) store.set(name, new Map())
  return store.get(name)!
}

interface DocRef {
  id: string
  _collectionName: string
  _id: string
  get(): Promise<{
    exists: boolean
    id: string
    data: () => Record<string, unknown> | undefined
  }>
  set(
    data: Record<string, unknown>,
    opts?: { merge?: boolean },
  ): Promise<void>
}

export interface FakeFirestore {
  db: Firestore
  store: FakeStore
}

export function makeFakeFirestore(store: FakeStore = makeFakeStore()): FakeFirestore {
  let autoId = 0

  function nextAutoId(): string {
    autoId += 1
    return `auto-${autoId}`
  }

  function docRef(collectionName: string, id?: string): DocRef {
    const docId = id ?? nextAutoId()
    return {
      id: docId,
      _collectionName: collectionName,
      _id: docId,
      async get() {
        const data = ensureCol(store, collectionName).get(docId)
        return { exists: data !== undefined, id: docId, data: () => data }
      },
      async set(data, opts) {
        const col = ensureCol(store, collectionName)
        const current = col.get(docId)
        col.set(
          docId,
          opts?.merge && current ? { ...current, ...data } : { ...data },
        )
      },
    }
  }

  type EqualityFilter = { field: string; value: unknown }

  function makeQueryChain(collectionName: string, filters: EqualityFilter[]) {
    const matchedEntries = () =>
      Array.from(ensureCol(store, collectionName).entries()).filter(
        ([, data]) =>
          filters.every(({ field, value }) => readNested(data, field) === value),
      )
    const snapshot = (limit?: number) => {
      let entries = matchedEntries()
      if (typeof limit === "number") entries = entries.slice(0, limit)
      return {
        empty: entries.length === 0,
        docs: entries.map(([id, data]) => ({
          id,
          data: () => data,
        })),
      }
    }
    return {
      where(field: string, op: string, value: unknown) {
        if (op !== "==") {
          throw new Error(
            `firestore-fake: unsupported operator ${op}; only "==" is implemented`,
          )
        }
        return makeQueryChain(collectionName, [...filters, { field, value }])
      },
      async get() {
        return snapshot()
      },
      limit(n: number) {
        return {
          async get() {
            return snapshot(n)
          },
        }
      },
      orderBy(_orderField: string, _dir?: "asc" | "desc") {
        return {
          async get() {
            return snapshot()
          },
          limit(n: number) {
            return {
              async get() {
                return snapshot(n)
              },
            }
          },
        }
      },
    }
  }

  function collection(collectionName: string) {
    return {
      doc(id?: string) {
        return docRef(collectionName, id)
      },
      async add(data: Record<string, unknown>) {
        const id = nextAutoId()
        ensureCol(store, collectionName).set(id, { ...data })
        return { id }
      },
      where(field: string, op: string, value: unknown) {
        if (op !== "==") {
          throw new Error(
            `firestore-fake: unsupported operator ${op}; only "==" is implemented`,
          )
        }
        return makeQueryChain(collectionName, [{ field, value }])
      },
    }
  }

  function batch() {
    const writes: Array<{
      ref: DocRef
      data: Record<string, unknown>
      opts?: { merge?: boolean }
    }> = []
    return {
      set(
        ref: DocRef,
        data: Record<string, unknown>,
        opts?: { merge?: boolean },
      ) {
        writes.push({ ref, data, opts })
      },
      update(ref: DocRef, data: Record<string, unknown>) {
        writes.push({ ref, data, opts: { merge: true } })
      },
      delete(ref: DocRef) {
        // Soft-delete — remove the underlying doc from the store.
        ensureCol(store, ref._collectionName).delete(ref._id)
      },
      async commit() {
        for (const write of writes) {
          await write.ref.set(write.data, write.opts)
        }
      },
    }
  }

  async function runTransaction<T>(
    fn: (tx: {
      get: (
        ref: DocRef,
      ) => Promise<{ exists: boolean; id: string; data: () => Record<string, unknown> | undefined }>
      set: (
        ref: DocRef,
        data: Record<string, unknown>,
        opts?: { merge?: boolean },
      ) => void
    }) => Promise<T>,
  ): Promise<T> {
    const writes: Array<{
      ref: DocRef
      data: Record<string, unknown>
      opts?: { merge?: boolean }
    }> = []
    const tx = {
      async get(ref: DocRef) {
        return ref.get()
      },
      set(ref: DocRef, data: Record<string, unknown>, opts?: { merge?: boolean }) {
        writes.push({ ref, data, opts })
      },
    }
    const result = await fn(tx)
    for (const w of writes) {
      await w.ref.set(w.data, w.opts)
    }
    return result
  }

  const db = {
    collection,
    batch,
    runTransaction,
  } as unknown as Firestore

  return { db, store }
}

/**
 * Resolve a possibly-dotted field path against a flat Firestore doc shape.
 * Supports the `rawFileRef.sha256` style query used by the import handler.
 */
function readNested(data: Record<string, unknown>, path: string): unknown {
  if (!path.includes(".")) return data[path]
  let current: unknown = data
  for (const segment of path.split(".")) {
    if (current === null || current === undefined || typeof current !== "object") {
      return undefined
    }
    current = (current as Record<string, unknown>)[segment]
  }
  return current
}
