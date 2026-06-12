/**
 * connect-phone-verify.ts — WS-3(a) STEP 2: the candidate enters the texted code
 * on the website; we link the web session to the phone-resolved pa-users/{uid}.
 *
 * Flow:
 *   1. auth gate (signed-in + verified email) — the SAME web session that started.
 *   2. verifyConnectPhoneCode(webFirebaseUid, code) → the phone candidate id.
 *      Code possession (texted to the phone thread) is the bind authorization.
 *   3. link the web email handle onto the phone uid (linkCandidateHandle). A≠B
 *      handle conflict → needs_review (NO merge — v2.0 identity rule).
 *   4. repoint pa-candidate-auth(firebaseUid).candidateId → phone uid (the web
 *      session now resolves to the phone candidate).
 *   5. mergeCandidatesByPhone(phone) folds any older-canonical duplicate with
 *      merge + correction audit events (idempotent).
 *   6. return the phone candidate id so the page stores it + routes to /me.
 *
 * Identity is deterministic + audited; NEVER raw PII as a doc id.
 *
 * PR-FIRST: new public callable — committed to claude/ws1-2-3-onboarding, NOT
 * deployed. No new secret.
 */
import { onCall, HttpsError } from "firebase-functions/v2/https"
import { getFirestore, type Firestore } from "firebase-admin/firestore"
import { logger } from "firebase-functions/v2"
import { PA_COLLECTIONS } from "@pa/core-types"
import { linkCandidateHandle, mergeCandidatesByPhone } from "@pa/pa-persistence"
import { replayPendingWebsiteEntryEvent } from "../website-entry/website-entry-event.js"
import { verifyConnectPhoneCode } from "./connect-phone-code.js"

type CallableAuth = {
  uid?: string
  token?: Record<string, unknown>
}

export interface ConnectPhoneVerifyInput {
  code?: string
}

export interface ConnectPhoneVerifyResult {
  ok: boolean
  reason?:
    | "no_outstanding_code"
    | "code_expired"
    | "code_used"
    | "too_many_attempts"
    | "code_mismatch"
    | "needs_review"
  candidateId?: string
}

function cleanString(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > max) return undefined
  return trimmed
}

export interface ConnectPhoneVerifyDeps {
  db: Firestore
  /** Verify the latest outstanding code for this web uid. */
  verifyCode: (
    webFirebaseUid: string,
    code: string,
  ) => Promise<
    | { ok: true; phoneCandidateId: string; webFirebaseUid: string }
    | { ok: false; reason: ConnectPhoneVerifyResult["reason"] }
  >
  /** Link the web email handle onto the phone uid. Throws `identity_conflict:<id>` on A≠B. */
  linkEmailHandle: (phoneCandidateId: string, email: string, nowIso: string) => Promise<void>
  /** Repoint pa-candidate-auth(firebaseUid).candidateId → the phone uid. */
  repointAuth: (firebaseUid: string, phoneCandidateId: string, nowIso: string) => Promise<void>
  /** Fold any older-canonical same-phone duplicate into one canonical (audited). */
  mergeByPhone: (phoneCandidateId: string) => Promise<void>
  /** PRD §2.5.2 — replay a pending website-entry runtime event now that the
   *  phone is routable (website-first candidate who uploaded evidence before
   *  binding a phone). Best-effort; never blocks the bind. */
  replayWebsiteEntry?: (phoneCandidateId: string) => Promise<{ emitted: boolean; reason?: string }>
  nowIso?: () => string
}

export async function runConnectPhoneVerify(
  data: unknown,
  auth: CallableAuth | undefined,
  deps: ConnectPhoneVerifyDeps,
): Promise<ConnectPhoneVerifyResult> {
  const firebaseUid = cleanString(auth?.uid, 128)
  if (!firebaseUid) {
    throw new HttpsError("unauthenticated", "Sign in before verifying your phone.")
  }
  const email = cleanString(auth?.token?.email, 320)?.toLowerCase()
  if (!email || !email.includes("@")) {
    throw new HttpsError("failed-precondition", "Signed-in account has no verified email.")
  }
  if (auth?.token?.email_verified === false) {
    throw new HttpsError("failed-precondition", "Signed-in email is not verified.")
  }

  const input = data && typeof data === "object" ? (data as Record<string, unknown>) : {}
  const code = cleanString(input.code, 16)
  if (!code) return { ok: false, reason: "code_mismatch" }

  const nowIso = (deps.nowIso ?? (() => new Date().toISOString()))()

  // 1. Verify code (code possession authorizes the bind).
  const verified = await deps.verifyCode(firebaseUid, code)
  if (!verified.ok) return { ok: false, reason: verified.reason }
  const phoneCandidateId = verified.phoneCandidateId

  // 2. Link the web email handle onto the phone uid. A handle that already
  //    belongs to a DIFFERENT candidate → conflict → needs_review (no merge).
  try {
    await deps.linkEmailHandle(phoneCandidateId, email, nowIso)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (msg.startsWith("identity_conflict:")) {
      logger.warn("connect_phone.identity_conflict", { firebaseUid })
      return { ok: false, reason: "needs_review" }
    }
    // Any other link failure must NOT dead-end — log + continue (the auth
    // repoint below still binds the web session to the phone candidate).
    logger.error("connect_phone.link_email_failed", { firebaseUid, err: msg })
  }

  // 3. Repoint the web session's auth mapping to the phone candidate.
  await deps.repointAuth(firebaseUid, phoneCandidateId, nowIso)

  // 4. Fold any older-canonical same-phone duplicate (idempotent + audited).
  try {
    await deps.mergeByPhone(phoneCandidateId)
  } catch (err) {
    logger.warn("connect_phone.merge_failed", {
      err: err instanceof Error ? err.message : String(err),
    })
  }

  // 5. PRD §2.5.2 — the phone is now routable: replay any pending website-entry
  //    runtime event (evidence uploaded on the website before a phone existed)
  //    so Claire's pitch lands in the just-bound thread. Idempotent on the
  //    stored per-flow id; best-effort (a miss degrades to the §2.4 inbound
  //    continuation read).
  if (deps.replayWebsiteEntry) {
    try {
      const replay = await deps.replayWebsiteEntry(phoneCandidateId)
      logger.info("connect_phone.website_entry_replay", { ...replay })
    } catch (err) {
      logger.warn("connect_phone.website_entry_replay_failed", {
        err: err instanceof Error ? err.message : String(err),
      })
    }
  }

  return { ok: true, candidateId: phoneCandidateId }
}

function makeProdDeps(db: Firestore): ConnectPhoneVerifyDeps {
  return {
    db,
    verifyCode: (webFirebaseUid, code) => verifyConnectPhoneCode(db, { webFirebaseUid, code }),
    linkEmailHandle: async (phoneCandidateId, email, nowIso) => {
      await linkCandidateHandle(db, {
        candidateId: phoneCandidateId,
        kind: "email",
        value: email,
        source: "candidate",
        verified: true,
        deliverable: true,
        now: nowIso,
        evidence: [
          { source: "system", summary: "Web session bound to phone candidate via verification code" },
        ],
      })
    },
    repointAuth: async (firebaseUid, phoneCandidateId, nowIso) => {
      await db
        .collection(PA_COLLECTIONS.candidateAuth)
        .doc(firebaseUid)
        .set(
          { firebaseUid, candidateId: phoneCandidateId, updatedAt: nowIso, lastClaimedAt: nowIso },
          { merge: true },
        )
    },
    replayWebsiteEntry: (phoneCandidateId) => replayPendingWebsiteEntryEvent(db, phoneCandidateId),
    mergeByPhone: async (phoneCandidateId) => {
      // Resolve the phone for this candidate, then fold same-phone duplicates.
      const snap = await db.collection(PA_COLLECTIONS.users).doc(phoneCandidateId).get()
      const data = (snap.data() ?? {}) as { phoneE164?: unknown }
      const phoneE164 = typeof data.phoneE164 === "string" ? data.phoneE164.trim() : ""
      if (!phoneE164) return
      await mergeCandidatesByPhone(db, {
        phoneE164,
        canonicalCandidateIdHint: phoneCandidateId,
        actor: "system",
        reason: "Web ↔ phone bind via verification code",
      })
    },
  }
}

export const paCandidateConnectPhoneVerify = onCall(
  { region: "us-central1", memory: "512MiB", timeoutSeconds: 30 },
  async (req): Promise<ConnectPhoneVerifyResult> => {
    return runConnectPhoneVerify(req.data, req.auth, makeProdDeps(getFirestore()))
  },
)
