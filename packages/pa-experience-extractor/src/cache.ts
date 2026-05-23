/**
 * Phase EX1 PR-A — Firestore subcollection cache for per-entry
 * extractions, with a clean test seam.
 *
 * Storage layout (plan §5):
 *   pa-users/{uid}/workEntries/{entryId}  ← document = WorkEntryExtractionOutput
 *
 * The cache abstraction is small and dependency-injected so unit tests
 * can swap in an in-memory implementation. `firestoreExtractionCache`
 * is the production binding.
 */

import type { Firestore } from "firebase-admin/firestore"
import { workEntryExtractionOutput } from "./schema.js"
import type { WorkEntryExtractionOutput } from "./types.js"

export interface ExtractionCache {
  read(uid: string, entryId: string): Promise<WorkEntryExtractionOutput | null>
  write(uid: string, value: WorkEntryExtractionOutput): Promise<void>
}

/** Constants kept here so the migration script can re-derive the path. */
export const USERS_COLLECTION = "pa-users"
export const WORK_ENTRIES_SUBCOLLECTION = "workEntries"

export function workEntryDocPath(uid: string, entryId: string): string {
  return `${USERS_COLLECTION}/${uid}/${WORK_ENTRIES_SUBCOLLECTION}/${entryId}`
}

/**
 * Production cache: reads/writes Firestore.
 *
 * The Firestore instance is passed in (rather than imported from a
 * singleton) so unit tests can substitute a mock — and so apps that
 * already have a `Firestore` handle don't re-initialize the SDK.
 */
export function firestoreExtractionCache(db: Firestore): ExtractionCache {
  return {
    async read(uid, entryId) {
      const snap = await db
        .collection(USERS_COLLECTION)
        .doc(uid)
        .collection(WORK_ENTRIES_SUBCOLLECTION)
        .doc(entryId)
        .get()
      if (!snap.exists) return null
      const data = snap.data()
      if (!data) return null
      const parsed = workEntryExtractionOutput.safeParse(data)
      // Malformed cache → treat as miss so we re-extract rather than
      // serve garbage. The malformed doc will be overwritten on write.
      if (!parsed.success) return null
      return parsed.data
    },
    async write(uid, value) {
      await db
        .collection(USERS_COLLECTION)
        .doc(uid)
        .collection(WORK_ENTRIES_SUBCOLLECTION)
        .doc(value.entryId)
        .set(value, { merge: true })
    },
  }
}

/**
 * In-memory cache. Used in unit tests and by `--dry-run` migration mode
 * (where we want to cost the LLM calls but not persist).
 */
export function inMemoryExtractionCache(
  seed?: Record<string, WorkEntryExtractionOutput>
): ExtractionCache & {
  readonly store: Map<string, WorkEntryExtractionOutput>
} {
  const store = new Map<string, WorkEntryExtractionOutput>()
  if (seed) {
    for (const [k, v] of Object.entries(seed)) store.set(k, v)
  }
  return {
    store,
    async read(uid, entryId) {
      return store.get(`${uid}::${entryId}`) ?? null
    },
    async write(uid, value) {
      store.set(`${uid}::${value.entryId}`, value)
    },
  }
}
