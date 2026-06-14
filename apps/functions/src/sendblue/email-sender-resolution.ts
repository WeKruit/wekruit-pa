/**
 * Email-Apple-ID sender resolution (SEV 2026-06-11).
 *
 * iPhones configured with "Start New Conversations From: Apple ID" send
 * iMessage with an EMAIL sender handle (e.g. `ppoojan455@gmail.com`).
 * Sendblue delivers these webhooks fine, but the 2026-05-20 E.164 sender
 * gate (GH #142) silently rejected every one — ~10 real candidates'
 * prescreen triggers, verification codes, and follow-ups vaporized.
 *
 * Sendblue REST has NO outbound path to email handles (vendor-confirmed:
 * the plan also blocks outbound to handles that never texted in). So the
 * only reply channel for an email-sender user is their KNOWN E.164 phone
 * from their pa-users doc. This module resolves the email sender to a
 * `pa-users/{uid}` + canonical phone so the webhook can rewrite the inbound
 * onto the phone and let the existing pipeline run unchanged.
 *
 * Resolution arms IN ORDER (first hit wins), all point-reads / simple
 * queries, fail-soft null:
 *   a. uid token in text — prescreen trigger `WeKruit_<jobId>_<userId>_Job`
 *      or verification/kickoff opener ("Hi, WeKruit, my verification code
 *      is <uid>" / "Hello, WeKruit! <uid>" / "Hi, WeKruit! <uid>"). Reuses
 *      the REAL production parsers (`parseHelloWekruitOpener` +
 *      `parsePrescreenCandidateId` — the same pair `resolveInboundUserId`
 *      trusts), never a re-written regex. The named pa-users doc must EXIST.
 *   b. existing binding — `pa-candidate-handles` hashed email handle doc
 *      (point read), else `pa-users` where emailLower/email == normalized
 *      handle (limit 2; 2+ matches → ambiguous → null, never guess).
 */

import { createHash } from "node:crypto"
import type { Firestore } from "firebase-admin/firestore"
import { PA_COLLECTIONS } from "@pa/core-types"
import { enqueueOutbound, inboundEventDocId } from "@pa/pa-broker"
import { hashCandidateHandle, linkCandidateHandle } from "@pa/pa-persistence"
import { parseHelloWekruitOpener } from "@pa/pa-orchestrator"
import { parsePrescreenCandidateId } from "../candidate-inbound-resolve.js"
import { isE164 } from "./handle-format.js"

export type EmailSenderResolutionMethod =
  /** Arm a — uid token in the message text (strongest, deterministic). */
  | "uid_token"
  /** Arm b1 — existing pa-candidate-handles email binding. */
  | "handle_binding"
  /** Arm b2 — unique pa-users email/emailLower match. */
  | "users_email"

export type EmailSenderResolution = {
  userId: string
  /** Canonical E.164 phone from the resolved pa-users doc; null when absent/invalid. */
  phoneE164: string | null
  method: EmailSenderResolutionMethod
}

type Log = (...args: unknown[]) => void

function userPhoneE164(data: Record<string, unknown> | undefined): string | null {
  const phone = typeof data?.phoneE164 === "string" ? data.phoneE164.trim() : ""
  return isE164(phone) ? phone : null
}

/**
 * Resolve an email-Apple-ID sender to a known candidate. Fail-soft: any
 * read error falls through to the next arm / returns null — the caller
 * treats null as "unresolved" (reject + audit + ops review item).
 */
export async function resolveEmailSender(
  db: Firestore,
  input: { emailHandle: string; text: string; log?: Log },
): Promise<EmailSenderResolution | null> {
  const log = input.log ?? (() => undefined)
  const emailHandle = input.emailHandle.trim().toLowerCase()
  if (!emailHandle) return null
  const text = typeof input.text === "string" ? input.text : ""

  // ---- arm a: uid token in text (strongest, deterministic) ---------------
  try {
    const token =
      parseHelloWekruitOpener(text)?.candidateId ?? parsePrescreenCandidateId(text)
    if (token) {
      const snap = await db.collection(PA_COLLECTIONS.users).doc(token).get()
      if (snap.exists) {
        return {
          userId: snap.id,
          phoneE164: userPhoneE164(snap.data() as Record<string, unknown> | undefined),
          method: "uid_token",
        }
      }
      log("[sendblue][email-sender] uid token names unknown pa-users doc — falling through", {
        token,
      })
    }
  } catch (err) {
    log("[sendblue][email-sender] uid-token arm failed (non-fatal)",
      err instanceof Error ? err.message : String(err))
  }

  // ---- arm b1: existing pa-candidate-handles email binding ---------------
  try {
    const { handleId } = hashCandidateHandle("email", emailHandle)
    const handleSnap = await db.collection(PA_COLLECTIONS.candidateHandles).doc(handleId).get()
    const candidateId = handleSnap.exists ? handleSnap.data()?.candidateId : undefined
    if (typeof candidateId === "string" && candidateId.trim()) {
      const userSnap = await db.collection(PA_COLLECTIONS.users).doc(candidateId.trim()).get()
      if (userSnap.exists) {
        return {
          userId: userSnap.id,
          phoneE164: userPhoneE164(userSnap.data() as Record<string, unknown> | undefined),
          method: "handle_binding",
        }
      }
    }
  } catch (err) {
    log("[sendblue][email-sender] handle-binding arm failed (non-fatal)",
      err instanceof Error ? err.message : String(err))
  }

  // ---- arm b2: pa-users email match (limit 2 — ambiguity never guesses) --
  // `emailLower` is the canonical lowercase column (ATS/bulk paths); `email`
  // covers older rows that only stamped the raw value. The handle is already
  // lowercased so an `email ==` match implies the doc stored it lowercase.
  try {
    for (const field of ["emailLower", "email"] as const) {
      const snap = await db
        .collection(PA_COLLECTIONS.users)
        .where(field, "==", emailHandle)
        .limit(2)
        .get()
      if (snap.empty) continue
      if (snap.docs.length > 1) {
        log("[sendblue][email-sender] ambiguous pa-users email match — refusing to guess", {
          field,
          count: snap.docs.length,
        })
        return null
      }
      const doc = snap.docs[0]!
      return {
        userId: doc.id,
        phoneE164: userPhoneE164(doc.data() as Record<string, unknown> | undefined),
        method: "users_email",
      }
    }
  } catch (err) {
    log("[sendblue][email-sender] users-email arm failed (non-fatal)",
      err instanceof Error ? err.message : String(err))
  }

  return null
}

/**
 * Idempotently bind the email handle to the resolved candidate via the
 * canonical `linkCandidateHandle` writer (same path phone handles use).
 * Best-effort: an existing same-candidate binding is a no-op; a binding
 * owned by a DIFFERENT candidate throws `identity_conflict:` AFTER
 * `recordIdentityConflict` has already written the HITL review doc — we
 * swallow it here so the inbound is never dropped over bookkeeping.
 */
export async function bindEmailSenderHandle(
  db: Firestore,
  input: {
    userId: string
    emailHandle: string
    messageHandle: string
    method: EmailSenderResolutionMethod
    log?: Log
  },
): Promise<void> {
  const log = input.log ?? (() => undefined)
  try {
    await linkCandidateHandle(db, {
      candidateId: input.userId,
      kind: "email",
      value: input.emailHandle,
      // Closed CandidateHandleSource enum — "sendblue" is the transport this
      // evidence arrived on; the resolution provenance lives in evidence.
      source: "sendblue",
      evidence: [
        {
          source: "system",
          summary: "email_sender_resolution",
          ...(input.messageHandle ? { refId: input.messageHandle } : {}),
          meta: { method: input.method },
        },
      ],
    })
  } catch (err) {
    log("[sendblue][email-sender] handle bind failed (non-fatal)",
      err instanceof Error ? err.message : String(err))
  }
}

export type EmailSenderReviewKind =
  | "email_sender_unresolved"
  | "email_sender_resolved_no_phone"

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex")
}

function maskEmail(email: string): string {
  const [localRaw, domainRaw] = email.split("@")
  const local = localRaw ?? ""
  const domain = domainRaw ?? ""
  if (!local || !domain) return "***"
  return `${local[0]}***@${domain}`
}

/**
 * Ops review item for the HITL identity queue (`pa-candidate-identity-conflicts`
 * — the same collection `identity_conflict:` errors land in, surfaced on
 * /admin/identity-conflicts). Written RAW (no core-types schema parse): the
 * `kind` strings here are additive and the admin surface reads raw docs, so
 * we avoid widening the shared `IdentityConflictKindSchema` enum from a
 * webhook hotfix. Deterministic doc id on (kind, email hash) so repeat texts
 * from the same unresolved sender collapse onto ONE open item. Fail-soft.
 */
export async function createEmailSenderReviewItem(
  db: Firestore,
  input: {
    kind: EmailSenderReviewKind
    emailHandle: string
    messageHandle: string
    userId?: string
    log?: Log
  },
): Promise<void> {
  const log = input.log ?? (() => undefined)
  try {
    const { handleId, handleHash } = hashCandidateHandle("email", input.emailHandle)
    const conflictId = `identity_conflict_${sha256Hex(`${input.kind}|${handleHash}`).slice(0, 32)}`
    const ref = db.collection(PA_COLLECTIONS.candidateIdentityConflicts).doc(conflictId)
    const existing = await ref.get()
    if (existing.exists) return
    await ref.set({
      conflictId,
      kind: input.kind,
      status: "open",
      handleKind: "email",
      handleId,
      handleHash,
      ...(input.userId ? { primaryCandidateId: input.userId } : {}),
      evidence: [
        {
          source: "system",
          summary: `Email-Apple-ID sender inbound (${input.kind})`,
          ...(input.messageHandle ? { refId: input.messageHandle } : {}),
        },
      ],
      payloadRedacted: { emailMasked: maskEmail(input.emailHandle) },
      createdAt: new Date().toISOString(),
    })
  } catch (err) {
    log("[sendblue][email-sender] review item write failed (non-fatal)",
      err instanceof Error ? err.message : String(err))
  }
}

// ─── Switch-to-phone guidance (Adam + Sendblue support, 2026-06-13) ─────────
//
// REPLACES the rewrite-onto-phone behavior that GUARANTEED silence. When an
// iPhone has "Start New Conversations From: Apple ID/Email", inbound arrives
// with an EMAIL from_number and our outbound to that person's PHONE is blocked
// by the inbound-only plan (RULE-1 / 400 INBOUND_ONLY_PLAN) — every reply
// vaporized (live: Sylvia +15419084350, Poojan). The phone never texted us, so
// it has no consent and no reachable channel.
//
// What IS allowed on the inbound-only plan: replying INTO THE EXACT THREAD that
// just texted us — i.e. back to the EMAIL handle. Sendblue's send-message API
// takes the recipient in `number`; `sendImessage`/`normalizePeer` preserve an
// email handle verbatim, so the reply lands in the email iMessage thread. We
// send ONE deterministic guidance bubble asking the candidate to flip
// "Start New Conversations From" to their phone number, then text us again. We
// do NOT proceed into pitch/prescreen this turn (they're not reachable on phone
// yet). Identity is still resolved/bound so the next phone-origin text is
// recognized.
//
// runtimeSource = "pa_identity_notice": this is the canonical exemption for a
// reply INTO the inbound thread (the email handle just texted us). The key
// difference from the prior connect-phone violation is the recipient — the
// EMAIL handle, never a rewritten phone.

/** Cooldown before the SAME email handle may receive the guidance again. */
export const SWITCH_TO_PHONE_GUIDANCE_COOLDOWN_MS = 24 * 60 * 60 * 1000

/**
 * Candidate-facing guidance copy (warm, Claire voice). Deterministic — a
 * compliance/identity notice, not LLM prose. The Apple support link is included
 * because the existing identity-notice copy patterns carry actionable links.
 */
export const SWITCH_TO_PHONE_GUIDANCE_TEXT =
  "hey! i got your message 🙏 quick thing — your iMessage is sending from your email, " +
  "and i can only text you back on your phone number. on your iPhone: Settings → Apps → " +
  "Messages → Send & Receive → under “Start New Conversations From” tap your phone " +
  "number. then text me again and i’ll jump right in. (more: https://support.apple.com/en-us/101744)"

/** Marker collection — one doc per email handle records the last guidance send. */
export const PA_EMAIL_SWITCH_GUIDANCE_COLLECTION = "pa-email-switch-guidance"

function switchGuidanceDocId(emailHandle: string): string {
  const { handleHash } = hashCandidateHandle("email", emailHandle)
  return `email_switch_to_phone_${handleHash.slice(0, 40)}`
}

/**
 * Idempotency / cooldown check for the switch-to-phone guidance. Returns true
 * when guidance should be sent (no prior send, or the last send is older than
 * the cooldown). Fail-OPEN on a read error is wrong here (it would spam on a
 * transient outage), so we fail-CLOSED: an unreadable marker → skip this turn.
 */
export async function shouldSendSwitchToPhoneGuidance(
  db: Firestore,
  input: { emailHandle: string; nowMs?: number; log?: Log },
): Promise<boolean> {
  const log = input.log ?? (() => undefined)
  const emailHandle = input.emailHandle.trim().toLowerCase()
  if (!emailHandle) return false
  const nowMs = typeof input.nowMs === "number" ? input.nowMs : Date.now()
  try {
    const snap = await db
      .collection(PA_EMAIL_SWITCH_GUIDANCE_COLLECTION)
      .doc(switchGuidanceDocId(emailHandle))
      .get()
    if (!snap.exists) return true
    const lastSentAtMs = Number((snap.data() as { lastSentAtMs?: unknown })?.lastSentAtMs ?? 0)
    if (!Number.isFinite(lastSentAtMs) || lastSentAtMs <= 0) return true
    return nowMs - lastSentAtMs >= SWITCH_TO_PHONE_GUIDANCE_COOLDOWN_MS
  } catch (err) {
    log("[sendblue][email-sender] guidance dedup read failed (fail-closed, skip)",
      err instanceof Error ? err.message : String(err))
    return false
  }
}

/** Stamp the guidance marker so a repeat text within the cooldown stays silent. */
async function recordSwitchToPhoneGuidanceSent(
  db: Firestore,
  input: { emailHandle: string; nowMs: number; log?: Log },
): Promise<void> {
  const log = input.log ?? (() => undefined)
  const emailHandle = input.emailHandle.trim().toLowerCase()
  try {
    await db
      .collection(PA_EMAIL_SWITCH_GUIDANCE_COLLECTION)
      .doc(switchGuidanceDocId(emailHandle))
      .set(
        {
          handleId: hashCandidateHandle("email", emailHandle).handleId,
          handleHash: hashCandidateHandle("email", emailHandle).handleHash,
          lastSentAtMs: input.nowMs,
          lastSentAt: new Date(input.nowMs).toISOString(),
          emailMasked: maskEmail(emailHandle),
        },
        { merge: true },
      )
  } catch (err) {
    log("[sendblue][email-sender] guidance marker write failed (non-fatal)",
      err instanceof Error ? err.message : String(err))
  }
}

export type SwitchToPhoneGuidanceResult =
  | { sent: true }
  | { sent: false; reason: "cooldown" | "evidence_write_failed" | "enqueue_failed" }

/**
 * Enqueue ONE switch-to-phone guidance reply INTO the inbound email thread.
 *
 * The outbox RULE-1 gate refuses to POST to a recipient with no prior inbound
 * evidence. The email handle DID just text us, so we FIRST write a completed
 * `pa-inbound-events` evidence row whose actual transport sender (rawSenderHandle
 * + original.from_number) IS the email handle — the same shape the trigger path
 * writes — so `hasPriorInboundEvidence(emailHandle)` passes and the reply lands.
 * Then we enqueue the guidance to `toE164 = emailHandle` and stamp the dedup
 * marker. Best-effort throughout; never throws.
 *
 * `userId` is the resolved candidate when known, else the email handle (so the
 * outbound row + evidence have a stable owner key for an unrecognized sender).
 */
/**
 * Write a completed `pa-inbound-events` evidence row recording that THIS email
 * handle texted us, so the outbox RULE-1 consent gate (`hasPriorInboundEvidence`)
 * permits a reply INTO the email thread. Mirrors the trigger-evidence shape:
 * the ACTUAL transport sender (rawSenderHandle + original.from_number) IS the
 * email handle, so the gate's provider-field preference resolves to EMAIL
 * consent (exactly the handle we reply to) and never to a profile phone.
 * Idempotent on the inbound message handle. Returns false on a real write
 * failure (caller must not POST without consent evidence).
 */
export async function ensureEmailInboundEvidence(
  db: Firestore,
  input: { emailHandle: string; messageHandle: string; toNumber?: string; service?: string; reason?: string; nowMs?: number; log?: Log },
): Promise<boolean> {
  const log = input.log ?? (() => undefined)
  const emailHandle = input.emailHandle.trim().toLowerCase()
  const nowMs = typeof input.nowMs === "number" ? input.nowMs : Date.now()
  const evidenceKey = `sendblue-${input.messageHandle}`
  const evidenceId = inboundEventDocId(evidenceKey)
  try {
    const nowIso = new Date(nowMs).toISOString()
    await db
      .collection(PA_COLLECTIONS.inboundEvents)
      .doc(evidenceId)
      .create({
        id: evidenceId,
        channel: "imessage",
        status: "completed",
        idempotencyKey: evidenceKey,
        rawPayload: {
          kind: "imessage",
          source: "sendblue",
          fromNumber: emailHandle,
          toNumber: input.toNumber,
          text: `[${input.reason ?? "email_inbound_evidence"}]`,
          chatId: `iMessage;-;${emailHandle}`,
          messageHandle: input.messageHandle,
          service: input.service ?? "iMessage",
          participant: emailHandle,
          rawSenderHandle: emailHandle,
          original: { from_number: emailHandle },
        },
        createdAt: nowIso,
        updatedAt: nowIso,
        attemptCount: 0,
        maxAttempts: 0,
        correlationId: input.messageHandle,
        completedReason: input.reason ?? "email_inbound_evidence",
      })
    return true
  } catch (err) {
    // code 6 = ALREADY_EXISTS — a retry; the row is there, proceed.
    if ((err as { code?: number }).code === 6) return true
    log("[sendblue][email-sender] inbound evidence write failed",
      err instanceof Error ? err.message : String(err))
    return false
  }
}

export async function sendSwitchToPhoneGuidance(
  db: Firestore,
  input: {
    emailHandle: string
    messageHandle: string
    toNumber?: string
    userId?: string
    service?: string
    nowMs?: number
    log?: Log
  },
): Promise<SwitchToPhoneGuidanceResult> {
  const log = input.log ?? (() => undefined)
  const emailHandle = input.emailHandle.trim().toLowerCase()
  const nowMs = typeof input.nowMs === "number" ? input.nowMs : Date.now()
  const ownerId = input.userId?.trim() || emailHandle

  // Inbound evidence FIRST — the outbox consent gate reads it before POSTing.
  const evidenceOk = await ensureEmailInboundEvidence(db, {
    emailHandle,
    messageHandle: input.messageHandle,
    ...(input.toNumber ? { toNumber: input.toNumber } : {}),
    ...(input.service ? { service: input.service } : {}),
    reason: "email_switch_to_phone_guidance",
    nowMs,
    log,
  })
  if (!evidenceOk) return { sent: false, reason: "evidence_write_failed" }

  try {
    await enqueueOutbound(db, {
      userId: ownerId,
      toE164: emailHandle,
      body: SWITCH_TO_PHONE_GUIDANCE_TEXT,
      idempotencyKey: `out-sendblue-email-switch-${switchGuidanceDocId(emailHandle)}`,
      runtimeApproved: true,
      runtimeSource: "pa_identity_notice",
    })
  } catch (err) {
    log("[sendblue][email-sender] guidance enqueue failed",
      err instanceof Error ? err.message : String(err))
    return { sent: false, reason: "enqueue_failed" }
  }

  await recordSwitchToPhoneGuidanceSent(db, { emailHandle, nowMs, log })
  return { sent: true }
}
