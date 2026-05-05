/**
 * FirestorePipelineStateProvider — production-grade state persistence.
 *
 * Stores the entire PipelineState as a subdoc on pa-users/{userId} under
 * a single field `pipelineState`. This keeps the new pipeline state
 * SEPARATE from the legacy `onboardingState` / `onboardingProbeAttempts`
 * / `systemFlags` so the migration can be feature-flagged with safe
 * rollback (just toggle the flag — no schema migration needed).
 *
 * Future: a backfill tool reads legacy fields → derives pipelineState for
 * users who started onboarding before the flag flip. Until then, users
 * partway through legacy onboarding finish via the legacy path; only NEW
 * users land on the pipeline.
 *
 * Race-safety: incrementAttempt uses a Firestore transaction. load/save
 * are read-modify-write — caller MUST not concurrently start two turns
 * for the same user. iMessage inbound coalescer already guarantees this
 * (paMessageCoalescer flushes one batch at a time per user).
 */
import type { PipelineState, PipelineStateProvider } from "./pipeline.js"
import { emptyPipelineState } from "./pipeline.js"

/** Minimal subset of Firestore shape we depend on. */
interface FirestoreLike {
  collection(name: string): {
    doc(id: string): {
      get(): Promise<{ exists: boolean; data(): unknown }>
      set(data: Record<string, unknown>, opts?: { merge: boolean }): Promise<unknown>
    }
  }
  runTransaction<T>(fn: (tx: FirestoreTxLike) => Promise<T>): Promise<T>
}

interface FirestoreTxLike {
  get(ref: ReturnType<FirestoreLike["collection"]>["doc"] extends (id: string) => infer R ? R : never): Promise<{
    exists: boolean
    data(): unknown
  }>
  set(
    ref: ReturnType<FirestoreLike["collection"]>["doc"] extends (id: string) => infer R ? R : never,
    data: Record<string, unknown>,
    opts?: { merge: boolean }
  ): unknown
}

export interface FirestoreStateProviderOpts {
  db: FirestoreLike
  /** User collection name. Default "pa-users". */
  collectionName?: string
  /** Field on the user doc storing PipelineState. Default "pipelineState". */
  fieldName?: string
}

export class FirestorePipelineStateProvider implements PipelineStateProvider {
  constructor(private readonly opts: FirestoreStateProviderOpts) {}

  private get coll() {
    return (this.opts.collectionName ?? "pa-users")
  }
  private get field() {
    return (this.opts.fieldName ?? "pipelineState")
  }

  async load(userId: string): Promise<PipelineState> {
    try {
      const snap = await this.opts.db.collection(this.coll).doc(userId).get()
      if (!snap.exists) return emptyPipelineState()
      const data = (snap.data() ?? {}) as Record<string, unknown>
      const stored = data[this.field] as PipelineState | undefined
      if (!stored) return emptyPipelineState()
      // Defensive: fill in any missing fields from a fresh empty state.
      const fresh = emptyPipelineState()
      return { ...fresh, ...stored, collected: { ...stored.collected }, attempts: { ...stored.attempts } }
    } catch {
      return emptyPipelineState()
    }
  }

  async save(userId: string, state: PipelineState): Promise<void> {
    await this.opts.db.collection(this.coll).doc(userId).set(
      { [this.field]: state, updatedAt: new Date().toISOString() },
      { merge: true }
    )
  }

  async incrementAttempt(userId: string, qId: string): Promise<number> {
    return this.opts.db.runTransaction(async (tx) => {
      const ref = this.opts.db.collection(this.coll).doc(userId)
      // tx.get expects a Firestore DocumentReference; the typing here is a
      // structural approximation. Production firebase-admin returns the
      // matching type, so this works at runtime.
      const snap = await tx.get(ref as unknown as Parameters<typeof tx.get>[0])
      const data = (snap.exists ? snap.data() : {}) as Record<string, unknown>
      const stored = (data[this.field] ?? emptyPipelineState()) as PipelineState
      const attempts = { ...(stored.attempts ?? {}) }
      attempts[qId] = (attempts[qId] ?? 0) + 1
      const updated: PipelineState = { ...emptyPipelineState(), ...stored, attempts }
      tx.set(
        ref as unknown as Parameters<typeof tx.set>[0],
        { [this.field]: updated, updatedAt: new Date().toISOString() },
        { merge: true }
      )
      return attempts[qId]!
    })
  }
}
