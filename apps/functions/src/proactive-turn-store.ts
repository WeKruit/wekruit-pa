/**
 * Phase 22 — Firestore-backed ProactiveTurnStore adapter.
 *
 * Scheduled proactive jobs are external events. They hand structured facts to
 * Claire runtime and never create candidate-visible text or sendable outbox
 * rows directly.
 */
import { randomUUID } from "node:crypto"
import { type Firestore } from "firebase-admin/firestore"
import { PA_COLLECTIONS } from "@pa/core-types"
import type { ProactiveTurnStore } from "@pa/pa-orchestrator"
import { enqueueRuntimeEventHandoff } from "./runtime-event-handoff.js"

export function createFirestoreProactiveTurnStore(db: Firestore): ProactiveTurnStore {
  const nowIso = () => new Date().toISOString()

  return {
    async enqueueRuntimeEvent(userId, input) {
      const result = await enqueueRuntimeEventHandoff(db, {
        userId,
        source: "proactive_scheduled",
        eventKind: input.eventKind,
        idempotencyKey: input.idempotencyKey,
        requireExistingSession: true,
        context: input.context,
      })
      return result.ok
        ? { ok: true, runtimeEventId: result.eventId, created: result.created }
        : { ok: false, reason: result.reason }
    },

    async writeAuditEvent(row) {
      // Keep fireWindowHash top-level so checkFireWindowExists can match it
      // directly without unpacking audit metadata.
      // appendAuditEvent only persists known fields (id, kind, message, meta, etc.) —
      // write the doc directly to include jobId, triggerType, fireWindowHash, runtimeEventId
      // at the top level for Firestore queries.
      const id = randomUUID()
      await db.collection(PA_COLLECTIONS.auditEvents).doc(id).set({
        id,
        createdAt: nowIso(),
        kind: row["kind"],
        message: `${row["kind"]}: job ${row["jobId"]} type ${row["triggerType"]}`,
        userId: row["userId"] as string,
        actor: "orchestrator",
        jobId: row["jobId"],
        triggerType: row["triggerType"],
        fireWindowHash: row["fireWindowHash"],
        runtimeEventId: row["runtimeEventId"],
        runtimeEventCreated: row["runtimeEventCreated"],
        runtimeReason: row["runtimeReason"],
      })
    },

    async updateJobStatus(jobId, patch) {
      await db.collection(PA_COLLECTIONS.scheduledJobs).doc(jobId).set(
        { ...patch, updatedAt: nowIso() },
        { merge: true }
      )
    },

    async rearmJob(jobId, nextFireAt) {
      await db.collection(PA_COLLECTIONS.scheduledJobs).doc(jobId).set(
        {
          status: "pending",
          nextFireAt,
          dueAt: nextFireAt, // Phase 7 compat
          updatedAt: nowIso(),
        },
        { merge: true }
      )
    },
    log: (...args) => console.log(nowIso(), "[proactive-turn-store]", ...args),
    // Phase 24.5 — Firestore handle for flag-backed PA_PROACTIVE_DISABLED check.
    db,
  }
}
