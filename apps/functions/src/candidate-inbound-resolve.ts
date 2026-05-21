import type { Firestore } from "firebase-admin/firestore"
import { PA_COLLECTIONS } from "@pa/core-types"
import { hashCandidateHandle, linkCandidateHandle } from "@pa/pa-persistence"
import { parseHelloWekruitOpener } from "@pa/pa-orchestrator"
import { isE164 } from "./sendblue/handle-format.js"

async function lookupUserByPhoneE164(db: Firestore, phoneE164: string): Promise<string | null> {
  // Identity hardening 2026-05-20 — defense in depth against email-based
  // senders that slip past the webhook gate. Never query pa-users on a
  // non-E.164 string; never write a non-E.164 handle to candidate-handles.
  if (!isE164(phoneE164)) return null
  try {
    const snap = await db.collection(PA_COLLECTIONS.users).where("phoneE164", "==", phoneE164).limit(1).get()
    if (!snap.empty) return snap.docs[0]!.id
  } catch {
    // Fall through to handle fallback.
  }
  try {
    const { handleId } = hashCandidateHandle("phone", phoneE164)
    const snap = await db.collection(PA_COLLECTIONS.candidateHandles).doc(handleId).get()
    if (!snap.exists) return null
    const candidateId = snap.data()?.candidateId
    return typeof candidateId === "string" && candidateId.trim() ? candidateId : null
  } catch {
    return null
  }
}

async function bindPhoneToCandidate(
  db: Firestore,
  candidateId: string,
  phoneE164: string,
): Promise<void> {
  const isoNow = new Date().toISOString()

  // Identity hardening 2026-05-21 — guard order matters. The previous
  // implementation wrote `pa-users.phoneE164` BEFORE running the handle
  // conflict check, so a phone already owned by another candidate would
  // throw `identity_conflict:` AFTER pa-users had already been polluted
  // with the conflicting phone. Two reordered checks now run first:
  //
  //   (1) `pa-users/{candidateId}.phoneE164` exists and differs from the
  //       opener phone → reject. Enforces the "one pa-users = one phone"
  //       invariant Adam locked 2026-05-21.
  //   (2) `linkCandidateHandle` throws `identity_conflict` when the phone
  //       hash is already linked to a different candidate.
  //
  // Only after BOTH succeed do we stamp `pa-users.phoneE164`.
  const userRef = db.collection(PA_COLLECTIONS.users).doc(candidateId)
  const userSnap = await userRef.get()
  const existingPhone =
    userSnap.exists && typeof userSnap.data()?.phoneE164 === "string"
      ? (userSnap.data()!.phoneE164 as string)
      : null
  if (existingPhone && existingPhone !== phoneE164) {
    throw new Error(
      `identity_conflict:pa_users_phone_mismatch:${candidateId}:existing_${existingPhone}_attempted_${phoneE164}`,
    )
  }

  // linkCandidateHandle handles the cross-candidate handle reuse case —
  // throws `identity_conflict:` when the phone hash already points at a
  // different candidateId. Re-throw so the caller (resolveInboundUserId)
  // surfaces it to the orchestrator and we DON'T touch pa-users.
  await linkCandidateHandle(db, {
    candidateId,
    kind: "phone",
    value: phoneE164,
    source: "candidate",
    deliverable: true,
    now: isoNow,
    evidence: [{ source: "system", summary: "Hello WeKruit opener phone bind" }],
  })

  await userRef.set(
    { phoneE164, updatedAt: isoNow },
    { merge: true },
  )
}

/**
 * Resolve pa-users/{id} for an inbound Sendblue message. Primary path: phoneE164
 * on pa-users. Fallback: `Hello, WeKruit! <candidateId>` opener binds phone when
 * the candidate registered without a phone on the web form.
 */
export async function resolveInboundUserId(
  db: Firestore,
  phoneE164: string,
  inboundText?: string,
): Promise<string | null> {
  // Identity hardening 2026-05-20 — same defense as lookupUserByPhoneE164.
  // Non-E.164 senders are rejected at webhook entry; this guard ensures
  // any direct caller of resolveInboundUserId stays safe too.
  if (!isE164(phoneE164)) return null

  const byPhone = await lookupUserByPhoneE164(db, phoneE164)
  if (byPhone) return byPhone

  const trimmedText = typeof inboundText === "string" ? inboundText.trim() : ""
  if (!trimmedText) return null

  const parsed = parseHelloWekruitOpener(trimmedText)
  if (!parsed?.candidateId) return null

  const userRef = db.collection(PA_COLLECTIONS.users).doc(parsed.candidateId)
  const userSnap = await userRef.get()
  if (!userSnap.exists) return null

  await bindPhoneToCandidate(db, parsed.candidateId, phoneE164)
  return parsed.candidateId
}

/** Back-compat wrapper used where inbound text is unavailable. */
export async function defaultLookupUserByPhone(db: Firestore, phoneE164: string): Promise<string | null> {
  return resolveInboundUserId(db, phoneE164)
}
