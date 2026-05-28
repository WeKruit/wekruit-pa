import type { Firestore } from "firebase-admin/firestore"
import { PA_COLLECTIONS } from "@pa/core-types"
import { hashCandidateHandle, linkCandidateHandle } from "@pa/pa-persistence"
import { parseHelloWekruitOpener } from "@pa/pa-orchestrator"
import { isE164 } from "./sendblue/handle-format.js"

/**
 * Adam directive 2026-05-21 — "1 email = 1 phone" invariant ENFORCED everywhere
 * EXCEPT this dev/test phone. Adam uses +14243201960 to text-test multiple
 * candidate accounts from his own iPhone; on that one number the opener is
 * allowed to release a prior owner and reassign the handle. For every other
 * number, opener-bind on a candidate that already has a different phone
 * (or on a phone already owned by another candidate) is rejected with
 * `identity_conflict:`.
 */
export const DEV_BYPASS_PHONE = "+14243201960"
const PRESCREEN_TOKEN_RE = /WeKruit_([A-Za-z0-9-]+)_([A-Za-z0-9_-]+)_Job/i
type CandidatePhoneMatch = { id: string; data: Record<string, unknown> }

function parsePrescreenCandidateId(text: string): string | null {
  const match = text.match(PRESCREEN_TOKEN_RE)
  const candidateId = match?.[2]?.trim()
  return candidateId || null
}

async function lookupUserByPhoneE164(db: Firestore, phoneE164: string): Promise<string | null> {
  // Identity hardening 2026-05-20 — defense in depth against email-based
  // senders that slip past the webhook gate. Never query pa-users on a
  // non-E.164 string; never write a non-E.164 handle to candidate-handles.
  if (!isE164(phoneE164)) return null
  try {
    const limit = phoneE164 === DEV_BYPASS_PHONE ? 25 : 1
    const snap = await db.collection(PA_COLLECTIONS.users).where("phoneE164", "==", phoneE164).limit(limit).get()
    if (!snap.empty) {
      const matches = snap.docs.map((doc) => ({
        id: doc.id,
        data: (doc.data() ?? {}) as Record<string, unknown>,
      }))
      if (phoneE164 === DEV_BYPASS_PHONE && matches.length > 1) {
        const handleOwner = await lookupPhoneHandleOwner(db, phoneE164)
        return chooseDevBypassPhoneMatch(matches, handleOwner)
      }
      return snap.docs[0]!.id
    }
  } catch {
    // Fall through to handle fallback.
  }
  return lookupPhoneHandleOwner(db, phoneE164)
}

async function lookupPhoneHandleOwner(db: Firestore, phoneE164: string): Promise<string | null> {
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

function chooseDevBypassPhoneMatch(matches: CandidatePhoneMatch[], handleOwner: string | null): string {
  const ranked = matches
    .map((match) => ({
      ...match,
      score: devBypassConversationScore(match.data, match.id === handleOwner),
      updatedAtMs: timestampMs(match.data.updatedAt),
    }))
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score
      if (b.updatedAtMs !== a.updatedAtMs) return b.updatedAtMs - a.updatedAtMs
      return a.id.localeCompare(b.id)
    })
  return ranked[0]?.id ?? handleOwner ?? matches[0]!.id
}

function devBypassConversationScore(data: Record<string, unknown>, isHandleOwner: boolean): number {
  const workSession = asRecord(data.workSession)
  const sharedOnboarding = asRecord(data.sharedOnboarding)
  const postMatchRetention = asRecord(data.postMatchRetention)

  let score = isHandleOwner ? 5 : 0
  if (workSession?.kind === "job_prescreen" && workSession.status === "active") score += 1000
  if (postMatchRetention?.stage && postMatchRetention.stage !== "complete") score += 900
  if (
    workSession?.kind === "shared_onboarding" &&
    workSession.status === "active" &&
    workSession.startSource === "post_prescreen_pass"
  ) {
    score += 700
  }
  if (workSession?.kind === "shared_onboarding" && workSession.status === "active") score += 100
  if (sharedOnboarding?.status === "active" && sharedOnboarding.completed !== true) score += 100
  return score
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function timestampMs(value: unknown): number {
  if (typeof value === "string") {
    const parsed = Date.parse(value)
    return Number.isFinite(parsed) ? parsed : 0
  }
  if (value && typeof value === "object") {
    const candidate = value as { toDate?: () => Date; _seconds?: number; seconds?: number }
    if (typeof candidate.toDate === "function") return candidate.toDate().getTime()
    if (typeof candidate._seconds === "number") return candidate._seconds * 1000
    if (typeof candidate.seconds === "number") return candidate.seconds * 1000
  }
  return 0
}

async function bindPhoneToCandidate(
  db: Firestore,
  candidateId: string,
  phoneE164: string,
  opts: { releaseCompetingUsers?: boolean; reassignConflictingHandle?: boolean } = {},
): Promise<void> {
  const isoNow = new Date().toISOString()

  // Identity hardening 2026-05-21 — strict mode (default) enforces the
  // "one pa-users = one phone" invariant Adam locked.
  //
  // Two pre-flight checks run BEFORE any write, so a rejected bind cannot
  // pollute pa-users (the previous bug — pa-users got the conflicting
  // phone written even when linkCandidateHandle threw):
  //
  //   (a) Same-candidate mismatch — `pa-users/{candidateId}.phoneE164`
  //       differs from the opener phone → reject when the existing value is
  //       itself a valid E.164 phone. Same person can't silently switch a
  //       deliverable phone via a fresh opener. Malformed legacy/profile input
  //       (for example "+081...") is not a real phone identity and must not
  //       block a Sendblue-confirmed inbound number.
  //
  //   (b) Cross-candidate handle reuse — the hashed phone handle
  //       already points at a DIFFERENT candidateId → reject. One
  //       phone can't be held by two pa-users.
  //
  // `opts.releaseCompetingUsers` opts INTO the relaxed dev/admin
  // behavior (DEV_BYPASS_PHONE only); both pre-flights are skipped and
  // the existing release-and-reassign code path runs instead.
  if (!opts.releaseCompetingUsers) {
    const userRef = db.collection(PA_COLLECTIONS.users).doc(candidateId)
    const userSnap = await userRef.get()
    const existingPhone =
      userSnap.exists && typeof userSnap.data()?.phoneE164 === "string"
        ? (userSnap.data()!.phoneE164 as string)
        : null
    if (existingPhone && existingPhone !== phoneE164 && isE164(existingPhone)) {
      throw new Error(
        `identity_conflict:pa_users_phone_mismatch:${candidateId}:existing_${existingPhone}_attempted_${phoneE164}`,
      )
    }

    const { handleId } = hashCandidateHandle("phone", phoneE164)
    const handleSnap = await db.collection(PA_COLLECTIONS.candidateHandles).doc(handleId).get()
    if (handleSnap.exists) {
      const owner = handleSnap.data()?.candidateId
      if (typeof owner === "string" && owner && owner !== candidateId) {
        throw new Error(
          `identity_conflict:phone_handle_owner_mismatch:${owner}_holds_phone_attempted_${candidateId}`,
        )
      }
    }

    // Pre-flight (c) — `pa-users` may carry `phoneE164` without a matching
    // `pa-candidate-handles` row (legacy/migrated data). Query pa-users
    // directly so the invariant holds even when the handle index is sparse.
    const competing = await db
      .collection(PA_COLLECTIONS.users)
      .where("phoneE164", "==", phoneE164)
      .limit(1)
      .get()
    if (!competing.empty && competing.docs[0]!.id !== candidateId) {
      throw new Error(
        `identity_conflict:pa_users_phone_already_taken:${competing.docs[0]!.id}_holds_phone_attempted_${candidateId}`,
      )
    }
  }

  // Relaxed mode only: release any OTHER pa-users that currently hold this
  // phone so the opener can take ownership cleanly. Used exclusively for
  // DEV_BYPASS_PHONE — never invoked in the production candidate-supply path.
  if (opts.releaseCompetingUsers) {
    const snap = await db.collection(PA_COLLECTIONS.users).where("phoneE164", "==", phoneE164).get()
    await Promise.all(
      snap.docs
        .filter((doc) => doc.id !== candidateId)
        .map((doc) => releaseDevBypassPhoneOwner(db, doc.id, doc.data(), isoNow)),
    )
  }

  await db.collection(PA_COLLECTIONS.users).doc(candidateId).set(
    { phoneE164, updatedAt: isoNow },
    { merge: true },
  )

  // linkCandidateHandle throws `identity_conflict:` when the phone hash
  // already points at a different candidateId. In strict mode we let it
  // propagate so the caller (resolveInboundUserId) surfaces the conflict.
  // In relaxed mode (`reassignConflictingHandle`), overwrite the handle
  // to point at the new candidate — the dev-bypass policy.
  await linkCandidateHandle(db, {
    candidateId,
    kind: "phone",
    value: phoneE164,
    source: "candidate",
    deliverable: true,
    now: isoNow,
    evidence: [{ source: "system", summary: "Hello WeKruit opener phone bind" }],
  }).catch((err: unknown) => {
    if (err instanceof Error && err.message.startsWith("identity_conflict:")) {
      if (opts.reassignConflictingHandle) {
        const { handleId, handleHash, normalizedValue } = hashCandidateHandle("phone", phoneE164)
        return db.collection(PA_COLLECTIONS.candidateHandles).doc(handleId).set({
          handleId,
          candidateId,
          kind: "phone",
          handleHash,
          normalizedValue,
          source: "candidate",
          verifiedAt: null,
          deliverable: true,
          createdAt: isoNow,
          updatedAt: isoNow,
        })
      }
      throw err
    }
    // Re-throw any non-identity_conflict error so we never silently
    // swallow schema/parse/network failures.
    throw err
  })
}

async function releaseDevBypassPhoneOwner(
  db: Firestore,
  userId: string,
  data: Record<string, unknown> | undefined,
  isoNow: string,
): Promise<void> {
  const daily = data?.dailyJobRecSubscribe as { optedIn?: unknown } | undefined
  const hadDailyOptIn = daily?.optedIn === true
  const hadPendingState = Boolean(data?.postMatchRetention) || Boolean(data?.collabInvitePending)
  const userPatch: Record<string, unknown> = {
    phoneE164: null,
    phoneE164Source: null,
    phoneE164ReleasedAt: isoNow,
    postMatchRetention: null,
    collabInvitePending: null,
    updatedAt: isoNow,
  }
  if (hadDailyOptIn) {
    userPatch.dailyJobRecSubscribe = {
      optedIn: false,
      optedOutAt: isoNow,
      source: "dev_phone_rebind_release",
    }
  }

  const profileRef = db.collection("pa-job-profiles").doc(userId)
  const profileSnap = await profileRef.get().catch(() => null)
  const writes: Promise<unknown>[] = [
    db.collection(PA_COLLECTIONS.users).doc(userId).update(userPatch),
  ]
  if (profileSnap?.exists || hadDailyOptIn || hadPendingState) {
    writes.push(
      profileRef.set(
        {
          userId,
          status: "paused",
          updatedAt: isoNow,
          source: "dev_phone_rebind_release",
        },
        { merge: true },
      ),
    )
  }
  await Promise.all(writes)
}

/**
 * Resolve pa-users/{id} for an inbound Sendblue message. Opener path runs
 * first — when `Hello, WeKruit! <candidateId>` is present, bind the inbound
 * phone to that candidate. Falls back to phoneE164 lookup when no opener
 * is found.
 *
 * Bind policy:
 *   - DEV_BYPASS_PHONE (+14243201960) → relaxed: release prior owner +
 *     reassign handle. Adam's test phone.
 *   - All other phones → strict: reject when the candidate already has a
 *     different phone, or when the phone is already linked to a different
 *     candidate. Enforces "1 email = 1 phone" (Adam 2026-05-21).
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

  const trimmedText = typeof inboundText === "string" ? inboundText.trim() : ""
  const parsed = trimmedText ? parseHelloWekruitOpener(trimmedText) : null
  const tokenCandidateId = parsed?.candidateId ?? (trimmedText ? parsePrescreenCandidateId(trimmedText) : null)
  if (tokenCandidateId) {
    const userRef = db.collection(PA_COLLECTIONS.users).doc(tokenCandidateId)
    const userSnap = await userRef.get()
    if (!userSnap.exists) return null

    const isDevBypass = phoneE164 === DEV_BYPASS_PHONE
    await bindPhoneToCandidate(db, tokenCandidateId, phoneE164, isDevBypass
      ? { releaseCompetingUsers: true, reassignConflictingHandle: true }
      : {})
    return tokenCandidateId
  }

  const byPhone = await lookupUserByPhoneE164(db, phoneE164)
  if (byPhone) return byPhone

  return null
}

/** Back-compat wrapper used where inbound text is unavailable. */
export async function defaultLookupUserByPhone(db: Firestore, phoneE164: string): Promise<string | null> {
  return resolveInboundUserId(db, phoneE164)
}
