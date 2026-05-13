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
 *   3. Find-or-create pa-users by case-insensitive email
 *   4. Bind resume async (fire-and-forget call to cv-ingest if URL provided)
 *   5. Send outbound invite SMS via injected sender
 *   6. Stamp idempotency + write audit event
 *
 * Fail-graceful: resume bind failure does NOT block invite SMS.
 */

import type { Firestore } from "firebase-admin/firestore"
import { FieldValue } from "firebase-admin/firestore"
import type { CanonicalApplicant } from "./ats-adapters/types.js"

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000

export interface AtsInboundDeps {
  db: Firestore
  /** Outbound invite SMS sender. */
  sendInvite: (args: {
    to: string
    content: string
    userId: string
    jobIdInternal: string
  }) => Promise<{ ok: boolean }>
  /** Fire-and-forget resume binder (calls cv-ingest HTTP). */
  bindResume?: (args: {
    userId: string
    resumeUrl?: string
    resumeBase64?: string
    source: string
  }) => Promise<void>
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
  | { kind: "send_failed"; reason: string }

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

  // ── 3. Find-or-create user by email (case-insensitive) ────────────────
  const emailLower = applicant.email.toLowerCase()
  const existingSnap = await deps.db
    .collection("pa-users")
    .where("emailLower", "==", emailLower)
    .limit(1)
    .get()

  let userId: string
  let createdUser = false
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

  // ── 4. Resume bind (fire-and-forget) ──────────────────────────────────
  if (deps.bindResume && (applicant.resumeUrl || applicant.resumeBase64)) {
    void deps
      .bindResume({
        userId,
        resumeUrl: applicant.resumeUrl,
        resumeBase64: applicant.resumeBase64,
        source: `ats:${applicant.source}`,
      })
      .catch((err) =>
        log("ats_inbound.bind_resume_failed", {
          userId,
          error: err instanceof Error ? err.message : String(err),
        })
      )
  }

  // ── 5. Build + send outbound invite ───────────────────────────────────
  const jobSnap = await deps.db.collection("pa-jobs").doc(jobIdInternal).get()
  const cfg = (jobSnap.data()?.prescreenConfig ?? {}) as {
    jobTitle?: string
    company?: string
  }
  const jobTitle = cfg.jobTitle ?? "the role"
  const company = cfg.company ?? "the employer"
  const invite = applicant.phone
    ? `Hi ${applicant.name.split(" ")[0] || "there"}, WeKruit here on behalf of ${company} for ${jobTitle}. Reply START to begin your 5-min screen, or send "stop" to opt out.`
    : null

  if (!applicant.phone || !invite) {
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

  let sendOk = false
  try {
    const r = await deps.sendInvite({
      to: applicant.phone,
      content: invite,
      userId,
      jobIdInternal,
    })
    sendOk = r.ok
  } catch (err) {
    log("ats_inbound.send_threw", {
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
    sendOk,
    createdUser,
    updatedAt: new Date(now).toISOString(),
  })
  await deps.audit({
    kind: "ats_inbound.invited",
    source: applicant.source,
    jobIdExternal: applicant.jobIdExternal,
    applicantId: applicant.applicantId,
    userId,
    jobIdInternal,
    sendOk,
    createdUser,
  })
  log("ats_inbound.invited", { userId, jobIdInternal, sendOk })

  if (!sendOk) return { kind: "send_failed", reason: "sendblue_failed" }
  return { kind: "ok", userId, jobIdInternal }
}
