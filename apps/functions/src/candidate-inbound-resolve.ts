import type { Firestore } from "firebase-admin/firestore"
import { PA_COLLECTIONS } from "@pa/core-types"
import { hashCandidateHandle, linkCandidateHandle, mergeCandidatesByPhone } from "@pa/pa-persistence"
import { parseHelloWekruitOpener, isBindCode } from "@pa/pa-orchestrator"
import { resolveAndConsumeBindCode } from "./bind-code.js"
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
// Prescreen token parser. Accepts BOTH forms (2026-06-13):
//   - JOB-ONLY (NEW, minted today): `WeKruit_<jobId>_Job` — no uid. Identity is
//     phone-is-auth; the token only carries the job. This is the corruption-
//     proof form (no fragile Firebase push-id uid in page→Messages transit).
//   - JOB+UID (LEGACY, back-compat for tokens already in flight):
//     `WeKruit_<jobId>_<uid>_Job`.
// jobId is `[a-z0-9-]+` (normalizeCompanyName: every non-alnum collapses to `-`,
// NO underscores) so the optional uid segment is unambiguous: the jobId capture
// can never swallow a `_`, so a single `_<seg>` before `_Job` is always the uid.
const PRESCREEN_TOKEN_RE = /WeKruit_([A-Za-z0-9-]+)(?:_([A-Za-z0-9_-]+))?_Job/i
type CandidatePhoneMatch = { id: string; data: Record<string, unknown> }

/**
 * Extract the userId from a prescreen token. Returns the uid for the LEGACY
 * `WeKruit_<jobId>_<userId>_Job` form, or `null` for the new JOB-ONLY
 * `WeKruit_<jobId>_Job` form (phone-is-auth — no uid in the token) AND for the
 * BIND-CODE form `WeKruit_<jobId>_<bindCode>_Job` (2026-06-14): the bindCode is
 * NOT a candidateId — it must be resolved+consumed against pa-bind-codes async
 * (see resolveInboundUserId's bindCode arm), so this synchronous uid extractor
 * deliberately returns null for it (a bindCode is never a directly-usable uid).
 * Exported (2026-06-11) so email-sender resolution reuses the EXACT parser this
 * resolver already trusts for uid extraction — never a re-written regex.
 */
export function parsePrescreenCandidateId(text: string): string | null {
  const match = text.match(PRESCREEN_TOKEN_RE)
  const seg = match?.[2]?.trim()
  if (!seg) return null
  // Bind-code-shaped segment is an opaque code, not a uid → null (resolved async).
  if (isBindCode(seg)) return null
  return seg
}

async function lookupUserByPhoneE164(db: Firestore, phoneE164: string): Promise<string | null> {
  // Identity hardening 2026-05-20 — defense in depth against email-based
  // senders that slip past the webhook gate. Never query pa-users on a
  // non-E.164 string; never write a non-E.164 handle to candidate-handles.
  if (!isE164(phoneE164)) return null
  try {
    // Identity hardening 2026-05-28 — the "1 phone = 1 pa-users" invariant is
    // enforced on the write path, but legacy/orphan duplicates can still exist
    // (e.g. a later resume upload that created a second doc on the dev phone).
    // We must NEVER take `snap.docs[0]` blind: Firestore's implicit order is
    // doc-name asc, so a newer orphan whose id sorts first would hijack the
    // thread (latent flap). Fetch a bounded set and pick DETERMINISTICALLY.
    const limit = phoneE164 === DEV_BYPASS_PHONE ? 25 : 10
    const snap = await db.collection(PA_COLLECTIONS.users).where("phoneE164", "==", phoneE164).limit(limit).get()
    if (!snap.empty) {
      const matches = snap.docs.map((doc) => ({
        id: doc.id,
        data: (doc.data() ?? {}) as Record<string, unknown>,
      }))
      if (matches.length > 1) {
        // Structured multi-match alert for ops — one phone resolving to >1
        // pa-users is an identity-dup that should be deduped (see
        // .ops/dedup-dev-phone.mjs). Greppable single-line warning.
        warnPhoneMultiMatch(phoneE164, matches)
        if (phoneE164 === DEV_BYPASS_PHONE) {
          const handleOwner = await lookupPhoneHandleOwner(db, phoneE164)
          return chooseDevBypassPhoneMatch(matches, handleOwner)
        }
        return choosePhoneMatchDeterministic(matches)
      }
      return matches[0]!.id
    }
  } catch {
    // Fall through to handle fallback.
  }
  return lookupPhoneHandleOwner(db, phoneE164)
}

/**
 * Deterministic tiebreak for the production (non-dev) path when a phone
 * resolves to more than one pa-users doc. Stable + observable, and chosen so
 * it never silently flips an established thread to a newer orphan:
 *
 *   1. oldest `createdAt` ascending — the FIRST profile that owned this phone
 *      wins. This is immutable, so resolution is stable across turns, and it
 *      matches the established live thread (the original profile, not a later
 *      duplicate created by a stray resume upload).
 *   2. most-recent `updatedAt` descending — only a tiebreak when createdAt is
 *      equal/absent; favors the genuinely active doc without the orphan-flip
 *      risk that `claireConversationStartedAt` would introduce (a later
 *      duplicate can have a newer conversation-start timestamp).
 *   3. doc id ascending — final stable tiebreak so the result is fully
 *      deterministic even with no timestamps at all.
 */
function choosePhoneMatchDeterministic(matches: CandidatePhoneMatch[]): string {
  const ranked = [...matches]
    .map((match) => ({
      id: match.id,
      createdAtMs: timestampMs(match.data.createdAt),
      updatedAtMs: timestampMs(match.data.updatedAt),
    }))
    .sort((a, b) => {
      // createdAt asc; missing createdAt (0) sorts LAST so a dated original
      // always beats an undated orphan.
      const aCreated = a.createdAtMs || Number.POSITIVE_INFINITY
      const bCreated = b.createdAtMs || Number.POSITIVE_INFINITY
      if (aCreated !== bCreated) return aCreated - bCreated
      if (b.updatedAtMs !== a.updatedAtMs) return b.updatedAtMs - a.updatedAtMs
      return a.id.localeCompare(b.id)
    })
  return ranked[0]!.id
}

function warnPhoneMultiMatch(phoneE164: string, matches: CandidatePhoneMatch[]): void {
  const ids = matches.map((m) => m.id).join(",")
  // Last 4 digits only — never log a full phone number.
  const phoneTail = phoneE164.slice(-4)
  console.warn(
    `candidate-inbound-resolve phone_multi_match phone_tail=${phoneTail} count=${matches.length} ids=${ids}`,
  )
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

type BindOutcome =
  | { bound: true; candidateId: string }
  // The texted phone is a DIFFERENT entity than the opener-named profile (the
  // named profile already owns a different valid phone, OR the texted phone is
  // already owned by another entity). Do NOT bind/merge across two different
  // numbers. Caller resolves by phone (the unique key).
  | { bound: false; reason: "phone_mismatch_different_entity" | "texted_phone_owned_by_other_entity" }

async function bindPhoneToCandidate(
  db: Firestore,
  candidateId: string,
  phoneE164: string,
  opts: {
    releaseCompetingUsers?: boolean
    reassignConflictingHandle?: boolean
    /**
     * The candidate was resolved via a VALID, consumed single-use bind-code
     * (minted in their own web session, pasted from their phone) → the texting
     * phone is proven to belong to this candidate. When true, an UNVERIFIED
     * résumé-derived phone (`phoneE164Source === "cv_parsed"`) on the profile
     * must NOT block the real SMS phone — overwrite it. Without this, a résumé's
     * stale/typo'd phone silently blocked the actual texter (live 2026-06-15:
     * José +17869150039, Aniket +918971155200 — résumé phone ≠ texting phone →
     * "can't start from this phone" → dead silence). A VERIFIED phone or a
     * phone genuinely owned by another entity still blocks.
     */
    bindCodeProven?: boolean
  } = {},
): Promise<BindOutcome> {
  const isoNow = new Date().toISOString()

  // PHONE = UNIQUE IDENTITY KEY (Adam 2026-05-29 policy refinement). The
  // canonical entity is keyed by phone number — NOT email, NOT the userId in
  // the opener. Strict mode (default, every phone except DEV_BYPASS_PHONE):
  //
  //   - Named profile has NO valid phone yet (website registration before
  //     first text, or a malformed legacy value like "+081...") AND the texted
  //     phone is not already owned by someone else → this is the candidate's
  //     first deliverable number → BIND it. (Normal opener flow.)
  //   - Named profile's existing valid phone == texted phone → re-text → no-op
  //     bind (recognize the existing entity, keep all handles).
  //   - Named profile's existing valid phone DIFFERS from the texted phone →
  //     DIFFERENT entity. "Cannot take it." DO NOT bind.
  //   - Texted phone is already owned by ANOTHER entity → the phone (the unique
  //     key) belongs to that entity. The opener token is stale/wrong; DO NOT
  //     hijack the phone for the named profile. Resolve by phone instead.
  //
  // In all "do not bind" cases we return {bound:false} so the caller resolves
  // the texted phone to ITS OWN entity (or treats it as a fresh candidate).
  // We NEVER throw → never leave the inbound event stuck `running`.
  //
  // Same-phone signup-duplicate merging is handled upstream in
  // resolveInboundUserId step 1 (mergeCandidatesByPhone) — strictly one phone.
  //
  // `opts.releaseCompetingUsers` opts INTO the relaxed dev/admin behavior
  // (DEV_BYPASS_PHONE only): the cross-entity guard is skipped and the existing
  // release-and-reassign code path runs instead. UNCHANGED.
  if (!opts.releaseCompetingUsers) {
    const userRef = db.collection(PA_COLLECTIONS.users).doc(candidateId)
    const userSnap = await userRef.get()
    const existingPhone =
      userSnap.exists && typeof userSnap.data()?.phoneE164 === "string"
        ? (userSnap.data()!.phoneE164 as string)
        : null
    // An UNVERIFIED résumé-extracted phone (cv-ingest writes phoneE164 +
    // phoneE164Source:"cv_parsed", with NO verified handle) is a best-effort
    // guess, NOT a real binding. When the candidate was proven by a consumed
    // bind-code, the real texting phone wins over that guess — otherwise a
    // résumé's stale/typo'd number permanently locks the candidate out of SMS.
    const existingPhoneSource =
      userSnap.exists && typeof userSnap.data()?.phoneE164Source === "string"
        ? (userSnap.data()!.phoneE164Source as string)
        : null
    // Adam 2026-06-16: "only lock whatever phone texted us, not from the résumé."
    // A cv_parsed phone is an unverified résumé guess and NEVER blocks the real
    // texting phone — ANY inbound phone is the real customer and wins (not just a
    // bind-code-proven one). cv-ingest no longer writes phoneE164 at all, so this
    // only matters for LEGACY rows still carrying a cv_parsed phoneE164; they
    // self-heal on the candidate's next inbound. A VERIFIED differing phone still
    // blocks (genuine different entity).
    const existingPhoneIsUnverifiedResumeGuess = existingPhoneSource === "cv_parsed"
    if (
      existingPhone &&
      existingPhone !== phoneE164 &&
      isE164(existingPhone) &&
      !existingPhoneIsUnverifiedResumeGuess
    ) {
      // Different VERIFIED phone = different entity. Never cross-bind/merge.
      return { bound: false, reason: "phone_mismatch_different_entity" }
    }

    // Texted phone already owned by a DIFFERENT entity (handle or pa-users
    // row) → phone is the unique key → resolve to that owner, never the opener
    // token's named profile. (mergeCandidatesByPhone upstream already collapsed
    // any genuine same-phone duplicates, so a survivor here is a real other
    // entity, not a fold target.)
    if (await isPhoneOwnedByOtherEntity(db, phoneE164, candidateId)) {
      return { bound: false, reason: "texted_phone_owned_by_other_entity" }
    }
  }

  // Relaxed mode only (DEV_BYPASS_PHONE): release any OTHER pa-users that
  // currently hold this phone so the opener can take ownership cleanly. Never
  // invoked in the production candidate-supply path.
  if (opts.releaseCompetingUsers) {
    const snap = await db.collection(PA_COLLECTIONS.users).where("phoneE164", "==", phoneE164).get()
    await Promise.all(
      snap.docs
        .filter((doc) => doc.id !== candidateId)
        .map((doc) => releaseDevBypassPhoneOwner(db, doc.id, doc.data(), isoNow)),
    )
  }

  await db.collection(PA_COLLECTIONS.users).doc(candidateId).set(
    // phoneE164Source flips to the real SMS bind so an earlier unverified
    // "cv_parsed" résumé guess is no longer treated as authoritative.
    { phoneE164, phoneE164Source: "sms_bind", updatedAt: isoNow },
    { merge: true },
  )

  // linkCandidateHandle throws `identity_conflict:` when the phone hash already
  // points at a different candidateId. In strict mode that can only happen for
  // the SAME phone already owned elsewhere — but the cross-entity guard above
  // only allows us here when the texted phone is this profile's own phone (or
  // the profile had no valid phone). A conflict at this point means a sparse
  // duplicate handle row; reassign it to this candidate rather than throw (which
  // is what previously left the inbound event stuck `running`). The relaxed
  // dev-bypass path also reassigns.
  const reassignHandle = opts.reassignConflictingHandle || !opts.releaseCompetingUsers
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
      if (reassignHandle) {
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
  return { bound: true, candidateId }
}

/**
 * True when `phoneE164` is already a deliverable identity of a DIFFERENT
 * candidate than `candidateId` — via the hashed phone handle index OR a direct
 * `pa-users.phoneE164` row. Phone is the unique key: if it belongs to someone
 * else, the opener token naming a different profile must not steal it.
 */
async function isPhoneOwnedByOtherEntity(
  db: Firestore,
  phoneE164: string,
  candidateId: string,
): Promise<boolean> {
  try {
    const { handleId } = hashCandidateHandle("phone", phoneE164)
    const handleSnap = await db.collection(PA_COLLECTIONS.candidateHandles).doc(handleId).get()
    const owner = handleSnap.exists ? handleSnap.data()?.candidateId : undefined
    if (typeof owner === "string" && owner && owner !== candidateId) return true
  } catch {
    /* fall through to pa-users scan */
  }
  try {
    const competing = await db
      .collection(PA_COLLECTIONS.users)
      .where("phoneE164", "==", phoneE164)
      .limit(2)
      .get()
    if (competing.docs.some((d) => d.id !== candidateId)) return true
  } catch {
    /* ignore */
  }
  return false
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
 * Bind policy (Adam 2026-05-29 — PHONE IS THE UNIQUE IDENTITY KEY):
 *   The canonical entity is keyed by the phone number — not email, not the
 *   userId in the opener.
 *   - DEV_BYPASS_PHONE (+14243201960) → relaxed: release prior owner +
 *     reassign handle. Adam's test phone. UNCHANGED.
 *   - All other phones:
 *       1. COLLAPSE same-phone signup duplicates — if the named profile's own
 *          current phone is shared by >1 pa-users (the two-emails-one-phone
 *          double signup), merge them (oldest createdAt canonical, keep both
 *          emails + both userIds). Strictly one phone → one entity.
 *       2. BIND the texted phone to the named profile ONLY when that profile
 *          has no valid phone yet OR already owns the texted phone (re-text).
 *          When the named profile's existing valid phone DIFFERS from the
 *          texted phone → DIFFERENT entity → do NOT bind, do NOT cross-merge.
 *          The texted phone resolves to ITS OWN entity by phone lookup (or
 *          null → fresh candidate keyed by that phone).
 *   Never throws identity_conflict → never leaves the inbound event stuck
 *   `running`.
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
  // NEW (2026-06-13): the website-first BIND opener now carries a transit-safe
  // opaque CODE (pa-bind-codes/<CODE> → candidateId), not a raw uid. Resolve +
  // consume it (single-use, 24h TTL) → candidateId, then bind the texted phone
  // to that candidate via the same machinery as the uid/legacy path. A failed
  // code (unknown/expired/used/bad-shape) does NOT bind here — it falls through
  // to the phone lookup (→ null for a brand-new website-first phone), and the
  // caller surfaces a graceful "re-tap the link" notice (see resolveBindOpener
  // + onPaInbound). Never a silent wrong-account bind.
  let resolvedFromBindCode: string | null = null
  if (parsed?.bindCode) {
    try {
      const consumed = await resolveAndConsumeBindCode(db, parsed.bindCode, phoneE164)
      if (consumed.ok) resolvedFromBindCode = consumed.candidateId
    } catch {
      /* best-effort — fall through to phone lookup, never throw */
    }
  }
  const tokenCandidateId =
    resolvedFromBindCode ?? parsed?.candidateId ?? (trimmedText ? parsePrescreenCandidateId(trimmedText) : null)
  if (tokenCandidateId) {
    const userRef = db.collection(PA_COLLECTIONS.users).doc(tokenCandidateId)
    const userSnap = await userRef.get()
    if (!userSnap.exists) {
      // Opener names an unknown profile — resolve by the texted phone instead
      // (phone is the unique key). Falls through below.
    } else {
      const isDevBypass = phoneE164 === DEV_BYPASS_PHONE
      let candidateId = tokenCandidateId

      if (!isDevBypass) {
        // Step 1 — collapse same-phone signup duplicates of the named profile.
        // (Yogesh: Uu3Ze + ECyf both hold +18303265553 → merge into the older
        //  one.) Best-effort: a merge failure must never block delivery.
        const existingPhone =
          typeof userSnap.data()?.phoneE164 === "string" ? (userSnap.data()!.phoneE164 as string) : null
        if (existingPhone && isE164(existingPhone)) {
          try {
            const dupMerge = await mergeCandidatesByPhone(db, {
              phoneE164: existingPhone,
              canonicalCandidateIdHint: tokenCandidateId,
              actor: "system",
              reason: "Same-phone signup duplicate collapse (phone = unique key)",
            })
            if (dupMerge.merged && dupMerge.canonicalCandidateId) {
              candidateId = dupMerge.canonicalCandidateId
            }
          } catch {
            /* best-effort dedup — fall through to bind */
          }
        }
      }

      // Step 2 — bind the texted phone to the named profile, IFF it is the
      // same entity (same/empty phone). Different phone → do NOT cross-bind.
      const outcome = await bindPhoneToCandidate(db, candidateId, phoneE164, isDevBypass
        ? { releaseCompetingUsers: true, reassignConflictingHandle: true }
        // A consumed bind-code proves the texting phone belongs to this
        // candidate → let the real phone override an unverified résumé guess.
        : { bindCodeProven: Boolean(resolvedFromBindCode) })
      if (outcome.bound) return outcome.candidateId
      // bound:false → the texted phone is a DIFFERENT entity than the opener's
      // named profile. Resolve by the texted phone (its own entity), never the
      // opener-named one. Falls through to the phone lookup below.
    }
  }

  // Phone is the unique key: resolve the texted number to its own entity.
  const byPhone = await lookupUserByPhoneE164(db, phoneE164)
  if (byPhone) return byPhone

  return null
}

/** Back-compat wrapper used where inbound text is unavailable. */
export async function defaultLookupUserByPhone(db: Firestore, phoneE164: string): Promise<string | null> {
  return resolveInboundUserId(db, phoneE164)
}
