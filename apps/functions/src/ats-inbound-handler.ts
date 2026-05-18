/**
 * v1.9 Phase 86 — paAtsInboundWebhook core handler.
 *
 * Pure-ish orchestrator (Firestore-injected for tests). Receives the parsed
 * `CanonicalApplicant` + adapter source, then:
 *
 *   1. Resolve external job → internal pa-jobs jobId via
 *      pa-jobs-external-mapping/{source}/{externalId}
 *   2. 7-day idempotency check on
 *      pa-ats-invite-idempotency/{source}_{externalJobId}_{applicantId}
 *   3. If a resume is present, bind it through cv-ingest identity resolution
 *      before invite. Otherwise find-or-create pa-users by email.
 *   5. Hand off ATS context to Claire runtime; no direct outbound invite
 *   6. Stamp idempotency + write audit event
 */

import type { Firestore } from "firebase-admin/firestore"
import { FieldValue } from "firebase-admin/firestore"
import type { CanonicalApplicant } from "./ats-adapters/types.js"

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000

export interface AtsInboundDeps {
  db: Firestore
  /** Runtime handoff. Must not send directly; onPaInbound owns candidate text. */
  enqueueRuntimeInvite: (args: {
    toE164: string
    userId: string
    jobIdInternal: string
    eventKind: string
    idempotencyKey: string
    context: Record<string, unknown>
  }) => Promise<{ ok: boolean; eventId?: string; reason?: string }>
  /** @deprecated direct send path is disabled; kept out of deps intentionally. */
  sendInvite?: never
  /** Resume binder (calls cv-ingest HTTP) before ATS invite is sent. */
  bindResume?: (args: {
    userId: string
    resumeUrl?: string
    resumeBase64?: string
    source: string
    employerEmailHint?: string
    atsApplicantId?: string
  }) => Promise<void | { ok: boolean; reason?: string; userId?: string }>
  /** Audit emitter. */
  audit: (event: Record<string, unknown>) => Promise<void>
  log?: (event: string, payload: Record<string, unknown>) => void
  now?: () => number
}

export type AtsInboundOutcome =
  | { kind: "ok"; userId: string; jobIdInternal: string }
  | { kind: "deduped"; reason: string }
  | { kind: "rejected"; reason: string }
  | { kind: "no_internal_job"; jobIdExternal: string }
  | { kind: "runtime_handoff_failed"; reason: string }

export async function handleAtsInbound(
  applicant: CanonicalApplicant,
  deps: AtsInboundDeps
): Promise<AtsInboundOutcome> {
  const log = deps.log ?? (() => undefined)
  const now = (deps.now ?? Date.now)()

  // ── 1. Resolve external → internal job ────────────────────────────────
  const mappingRef = deps.db
    .collection("pa-jobs-external-mapping")
    .doc(`${applicant.source}_${applicant.jobIdExternal}`)
  const mappingSnap = await mappingRef.get()
  if (!mappingSnap.exists) {
    await deps.audit({
      kind: "ats_inbound.no_internal_job",
      source: applicant.source,
      jobIdExternal: applicant.jobIdExternal,
    })
    return { kind: "no_internal_job", jobIdExternal: applicant.jobIdExternal }
  }
  const jobIdInternal = mappingSnap.data()?.jobIdInternal as string | undefined
  if (!jobIdInternal) {
    return { kind: "no_internal_job", jobIdExternal: applicant.jobIdExternal }
  }

  // ── 2. 7-day idempotency ──────────────────────────────────────────────
  const idemKey = `${applicant.source}_${applicant.jobIdExternal}_${applicant.applicantId}`
  const idemRef = deps.db.collection("pa-ats-invite-idempotency").doc(idemKey)
  const idemSnap = await idemRef.get()
  const lastFiredMs = idemSnap.data()?.lastFiredMs as number | undefined
  if (typeof lastFiredMs === "number" && now - lastFiredMs < SEVEN_DAYS_MS) {
    log("ats_inbound.deduped", { idemKey, sinceMs: now - lastFiredMs })
    await deps.audit({
      kind: "ats_inbound.deduped",
      source: applicant.source,
      jobIdExternal: applicant.jobIdExternal,
      applicantId: applicant.applicantId,
      sinceMs: now - lastFiredMs,
    })
    return { kind: "deduped", reason: "within_7d_window" }
  }

  // ── 3. Resolve candidate identity before outbound invite ──────────────
  const emailLower = applicant.email.toLowerCase()
  let userId: string | null = null
  let createdUser = false
  const hasResume = Boolean(applicant.resumeUrl || applicant.resumeBase64)
  if (deps.bindResume && hasResume) {
    const tempUserId = `ats_${applicant.source}_${applicant.applicantId}`.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 80)
    try {
      const bindResult = await deps.bindResume({
        userId: tempUserId,
        resumeUrl: applicant.resumeUrl,
        resumeBase64: applicant.resumeBase64,
        source: `ats:${applicant.source}`,
        employerEmailHint: applicant.email,
        atsApplicantId: `${applicant.source}:${applicant.applicantId}`,
      })
      if (bindResult && bindResult.ok === false) {
        await deps.audit({
          kind: "ats_inbound.identity_rejected",
          source: applicant.source,
          jobIdExternal: applicant.jobIdExternal,
          applicantId: applicant.applicantId,
          reason: bindResult.reason ?? "resume_bind_failed",
        })
        return { kind: "rejected", reason: bindResult.reason ?? "resume_bind_failed" }
      }
      if (bindResult && bindResult.ok === true && bindResult.userId) {
        userId = bindResult.userId
      }
    } catch (err) {
      log("ats_inbound.bind_resume_failed", {
        error: err instanceof Error ? err.message : String(err),
        applicantId: applicant.applicantId,
      })
      await deps.audit({
        kind: "ats_inbound.identity_rejected",
        source: applicant.source,
        jobIdExternal: applicant.jobIdExternal,
        applicantId: applicant.applicantId,
        reason: "resume_bind_failed",
      })
      return { kind: "rejected", reason: "resume_bind_failed" }
    }
  }

  if (!userId) {
    const existingSnap = await deps.db
      .collection("pa-users")
      .where("emailLower", "==", emailLower)
      .limit(1)
      .get()

    if (!existingSnap.empty) {
      userId = existingSnap.docs[0].id
    } else {
      const newDoc = deps.db.collection("pa-users").doc()
      userId = newDoc.id
      await newDoc.set({
        email: applicant.email,
        emailLower,
        legalName: applicant.name,
        phone: applicant.phone ?? null,
        signupSource: `ats:${applicant.source}`,
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      })
      createdUser = true
    }
  }

  const userSnap = await deps.db.collection("pa-users").doc(userId).get()
  createdUser = createdUser || !userSnap.exists
  await deps.db.collection("pa-users").doc(userId).set(
    {
      email: applicant.email,
      emailLower,
      legalName: applicant.name,
      phone: applicant.phone ?? null,
      signupSource: `ats:${applicant.source}`,
      updatedAt: FieldValue.serverTimestamp(),
      ...(userSnap.exists ? {} : { createdAt: FieldValue.serverTimestamp() }),
    },
    { merge: true }
  )

  // ── 5. Build runtime handoff context ──────────────────────────────────
  const jobSnap = await deps.db.collection("pa-jobs").doc(jobIdInternal).get()
  const cfg = (jobSnap.data()?.prescreenConfig ?? {}) as {
    jobTitle?: string
    company?: string
  }
  const jobTitle = cfg.jobTitle ?? "the role"
  const company = cfg.company ?? "the employer"
  if (!applicant.phone) {
    await deps.audit({
      kind: "ats_inbound.no_phone_skipped",
      source: applicant.source,
      jobIdExternal: applicant.jobIdExternal,
      applicantId: applicant.applicantId,
      userId,
    })
    // Stamp idempotency anyway so we don't retry endlessly.
    await idemRef.set({
      lastFiredMs: now,
      idemKey,
      source: applicant.source,
      jobIdExternal: applicant.jobIdExternal,
      applicantId: applicant.applicantId,
      userId,
      result: "no_phone",
      updatedAt: new Date(now).toISOString(),
    })
    return { kind: "rejected", reason: "no_phone_for_outbound_invite" }
  }

  // v1.9 G2 fix — stamp pending trigger doc keyed by phone so the
  // candidate's first reply (e.g. "START") synthesizes the WeKruit_<jobId>_
  // <userId>_Job trigger context. 24h expiry.
  try {
    const expiresAtMs = now + 24 * 60 * 60 * 1000
    await deps.db.collection("pa-ats-pending-trigger").doc(applicant.phone).set({
      phoneE164: applicant.phone,
      jobId: jobIdInternal,
      userId,
      source: applicant.source,
      expiresAtMs,
      createdAt: new Date(now).toISOString(),
    })
  } catch (err) {
    log("ats_inbound.pending_trigger_stamp_failed", {
      userId,
      error: err instanceof Error ? err.message : String(err),
    })
  }

  let runtimeOk = false
  let runtimeEventId: string | undefined
  let runtimeReason: string | undefined
  try {
    const r = await deps.enqueueRuntimeInvite({
      toE164: applicant.phone,
      userId,
      jobIdInternal,
      eventKind: "ats_applicant_received",
      idempotencyKey: idemKey,
      context: {
        source: applicant.source,
        applicantId: applicant.applicantId,
        jobIdExternal: applicant.jobIdExternal,
        jobIdInternal,
        candidateName: applicant.name,
        candidateEmail: applicant.email,
        jobTitle,
        company,
        suggestedIntent:
          "The candidate applied through an ATS source. Decide whether to invite them into the WeKruit/Claire screen, using their established language and prior conversation context.",
      },
    })
    runtimeOk = r.ok
    runtimeEventId = r.eventId
    runtimeReason = r.reason
  } catch (err) {
    log("ats_inbound.runtime_handoff_threw", {
      userId,
      error: err instanceof Error ? err.message : String(err),
    })
  }

  // ── 6. Stamp idempotency + audit ──────────────────────────────────────
  await idemRef.set({
    lastFiredMs: now,
    idemKey,
    source: applicant.source,
    jobIdExternal: applicant.jobIdExternal,
    applicantId: applicant.applicantId,
    userId,
    jobIdInternal,
    runtimeOk,
    ...(runtimeEventId ? { runtimeEventId } : {}),
    ...(runtimeReason ? { runtimeReason } : {}),
    createdUser,
    updatedAt: new Date(now).toISOString(),
  })
  await deps.audit({
    kind: "ats_inbound.runtime_handoff",
    source: applicant.source,
    jobIdExternal: applicant.jobIdExternal,
    applicantId: applicant.applicantId,
    userId,
    jobIdInternal,
    runtimeOk,
    ...(runtimeEventId ? { runtimeEventId } : {}),
    ...(runtimeReason ? { runtimeReason } : {}),
    createdUser,
  })
  log("ats_inbound.runtime_handoff", { userId, jobIdInternal, runtimeOk, runtimeEventId, runtimeReason })

  if (!runtimeOk) return { kind: "runtime_handoff_failed", reason: runtimeReason ?? "runtime_handoff_failed" }
  return { kind: "ok", userId, jobIdInternal }
}
