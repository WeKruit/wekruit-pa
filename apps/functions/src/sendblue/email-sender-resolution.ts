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
