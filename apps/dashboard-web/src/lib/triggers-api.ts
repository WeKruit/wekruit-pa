/**
 * Phase 22 — Thin Firestore wrapper for pa_scheduled_jobs CRUD.
 *
 * D-01: triggers are user-owned — all reads/writes filter by `userId`.
 * D-04: uses existing pa_scheduled_jobs collection.
 * Phase 7 compat: writes both `nextFireAt` AND legacy `dueAt`.
 */
import {
  collection,
  doc,
  getDocs,
  orderBy,
  query,
  setDoc,
  updateDoc,
  where,
} from "firebase/firestore"
import { PA_COLLECTIONS } from "@pa/core-types"
import type { ProactiveScheduledJob, ProactiveTriggerType } from "@pa/core-types"
import { db } from "./firebase.js"

// ---------------------------------------------------------------------------
// Input types for create
// ---------------------------------------------------------------------------

export type TimeAnchorInput = {
  triggerType: "time_anchor"
  eventLabel: string
  eventAtMs: number
  leadTimeSec: number
}

export type SilenceAnchorInput = {
  triggerType: "silence_anchor"
  windowSec: number
  lastUserMsgAtMs: number
}

export type ApplicationFollowupInput = {
  triggerType: "application_followup"
  companyName: string
  jobTitle: string
  appliedAtMs: number
  followupAfterSec: number
}

export type CreateTriggerInput = TimeAnchorInput | SilenceAnchorInput | ApplicationFollowupInput

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function computeNextFireAt(input: CreateTriggerInput): number {
  switch (input.triggerType) {
    case "time_anchor":
      return input.eventAtMs - input.leadTimeSec * 1000
    case "silence_anchor":
      return input.lastUserMsgAtMs + input.windowSec * 1000
    case "application_followup":
      return input.appliedAtMs + input.followupAfterSec * 1000
  }
}

function buildContext(input: CreateTriggerInput): ProactiveScheduledJob["context"] {
  switch (input.triggerType) {
    case "time_anchor":
      return {
        triggerType: "time_anchor",
        eventLabel: input.eventLabel,
        eventAt: input.eventAtMs,
        leadTimeSec: input.leadTimeSec,
      }
    case "silence_anchor":
      return {
        triggerType: "silence_anchor",
        windowSec: input.windowSec,
        lastUserMsgAt: input.lastUserMsgAtMs,
      }
    case "application_followup":
      return {
        triggerType: "application_followup",
        companyName: input.companyName,
        jobTitle: input.jobTitle,
        appliedAt: input.appliedAtMs,
        followupAfterSec: input.followupAfterSec,
      }
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Load all triggers for the signed-in user, sorted by nextFireAt ascending. */
export async function listUserTriggers(uid: string): Promise<ProactiveScheduledJob[]> {
  const snap = await getDocs(
    query(
      collection(db(), PA_COLLECTIONS.scheduledJobs),
      where("userId", "==", uid),
      orderBy("nextFireAt", "asc")
    )
  )
  return snap.docs.map((d) => ({ jobId: d.id, ...d.data() } as ProactiveScheduledJob))
}

/** Create a new trigger for the signed-in user. */
export async function createTrigger(uid: string, input: CreateTriggerInput): Promise<string> {
  const jobId = crypto.randomUUID()
  const now = new Date().toISOString()
  const nextFireAtMs = computeNextFireAt(input)
  const nextFireAt = new Date(nextFireAtMs).toISOString()
  const recurrence = input.triggerType === "silence_anchor" ? "silence_rearm" : "once"

  const job: ProactiveScheduledJob = {
    jobId,
    userId: uid,
    triggerType: input.triggerType as ProactiveTriggerType,
    nextFireAt,
    dueAt: nextFireAt, // Phase 7 compat — always write both
    recurrence,
    context: buildContext(input),
    status: "pending",
    createdAt: now,
    attempts: 0,
    maxAttempts: 3,
    backoffSec: 60,
  }

  await setDoc(doc(db(), PA_COLLECTIONS.scheduledJobs, jobId), job)
  return jobId
}

/** Cancel a specific trigger. Writes pa_audit_events row via the dashboard. */
export async function cancelTrigger(uid: string, jobId: string): Promise<void> {
  // Verify ownership via userId filter — do not update without confirming userId match
  const snap = await getDocs(
    query(
      collection(db(), PA_COLLECTIONS.scheduledJobs),
      where("userId", "==", uid),
      where("__name__", "==", jobId)
    )
  )
  if (snap.empty) {
    throw new Error(`Trigger ${jobId} not found for user ${uid}`)
  }
  await updateDoc(doc(db(), PA_COLLECTIONS.scheduledJobs, jobId), {
    status: "cancelled_by_user",
    updatedAt: new Date().toISOString(),
  })
  // Write audit event — fire and forget (dashboard best-effort)
  try {
    const auditId = crypto.randomUUID()
    await setDoc(doc(db(), PA_COLLECTIONS.auditEvents, auditId), {
      id: auditId,
      kind: "proactive_cancel",
      message: `User cancelled trigger ${jobId} via /triggers dashboard`,
      userId: uid,
      actor: "operator",
      meta: { jobId, source: "dashboard" },
      createdAt: new Date().toISOString(),
    })
  } catch {
    // Non-fatal — cancellation succeeded even if audit write fails
  }
}
