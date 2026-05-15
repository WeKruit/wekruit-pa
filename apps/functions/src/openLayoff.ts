// WeKruit Open — Cloud Function handlers.
//
// Co-located with pa-orchestrator. Reuses existing PA modules:
//   - sendblue/pool.ts        — pickFromNumber load-balancer
//   - sendblue/allowlist.ts   — normalizePeer (E.164)
//   - @pa/pa-broker           — enqueueOutbound (pa-outbound queue)
//
// SINGLE candidate collection (alignment with user instruction 2026-05-15):
//   pa-users/{candidateId}
//     phoneE164, displayName, onboardingStatus, source
//     lastLaidOffAt              ← layoff flag + timestamp (used by filter)
//     layoffContext              ← lastCompany, jobTitle, location, email, linkedin
//     senderNumber               ← sticky Sendblue pool number
//   layoff_phone_index/{p_hash}  → { candidateId, lastLaidOffAt }  (dedup index)
//   layoff_employers/{employerId}
//   pa-config/sendblue-pool      — REUSED from PA (same numbers)
//
// Kickoff = same pattern as pa-landing outreach:
//   1. pa-users upsert with `source: "WeKruit_Laid_Off"` + `lastLaidOffAt`
//   2. enqueueOutbound() drops one row; Claire takes over on candidate reply

import { onCall, HttpsError } from "firebase-functions/v2/https"
import { getFirestore, FieldValue } from "firebase-admin/firestore"
import { getApps, initializeApp } from "firebase-admin/app"

import { loadSendbluePool, pickFromNumber, sendblueGroupId, hashStringToUint } from "./sendblue/pool.js"
import { normalizePeer } from "./sendblue/allowlist.js"
import { enqueueOutbound } from "@pa/pa-broker"
import { PA_COLLECTIONS } from "@pa/core-types"

/** Source tag — drives Claire's opener variant + listing filter + analytics. */
const LAYOFF_SOURCE_TAG = "WeKruit_Laid_Off"

if (!getApps().length) initializeApp()

// ---------- Phone normalize + validate ----------

export function normalizeAndValidatePhone(raw: string): { ok: true; e164: string } | { ok: false; reason: string } {
  const e164 = normalizePeer(raw)
  if (!e164) return { ok: false, reason: "empty" }
  if (e164.includes("@")) return { ok: false, reason: "email_not_phone" }
  const digits = e164.replace(/\D/g, "")
  if (digits.length < 10) return { ok: false, reason: "too_short" }
  if (digits.length > 15) return { ok: false, reason: "too_long" }
  if (/^(\+?1?)(555)\d{7}$/.test(e164) && process.env.NODE_ENV === "production") {
    return { ok: false, reason: "test_number_not_allowed" }
  }
  return { ok: true, e164 }
}

function phoneIndexId(e164: string): string {
  return `p_${hashStringToUint(e164).toString(36)}`
}

// ---------- Layoff opener body ----------

function renderLayoffOpenerBody(input: { firstName: string; lastCompany: string }): string {
  const first = input.firstName?.trim() || "there"
  const company = input.lastCompany?.trim() || "your last company"
  return `Hey ${first}, Claire from WeKruit. Saw you signed up after the ${company} layoff — glad you found us. Got a sec to chat about what you want next?`
}

// ---------- Registration ----------

type RegisterInput = {
  firstName: string
  lastName: string
  email: string
  linkedin?: string
  lastCompany: string
  jobTitle: string
  location: string
  phone: string
  consent: boolean
  resumeFileName?: string
  /**
   * Dedup mode (default "auto"):
   *   - "auto"    → if phone exists, RETURN { duplicate: true, ... } and do not write
   *   - "reuse"   → if phone exists, reuse candidateId + refresh lastLaidOffAt only (no field overwrite)
   *   - "refresh" → if phone exists, reuse candidateId + overwrite layoffContext + refresh lastLaidOffAt
   */
  mode?: "auto" | "reuse" | "refresh"
}

export const openRegisterLayoffCandidate = onCall<RegisterInput>(
  { region: "us-central1", cors: true },
  async (req) => {
    const v = req.data
    if (!v.firstName || !v.email || !v.phone || !v.consent) {
      throw new HttpsError("invalid-argument", "Missing required fields")
    }
    const mode = v.mode ?? "auto"

    const phoneCheck = normalizeAndValidatePhone(v.phone)
    if (!phoneCheck.ok) throw new HttpsError("invalid-argument", `phone_invalid:${phoneCheck.reason}`)
    const phoneE164 = phoneCheck.e164
    const indexId = phoneIndexId(phoneE164)

    const db = getFirestore()
    const now = FieldValue.serverTimestamp()

    // Phone dedup index — controls reuse path.
    const indexRef = db.doc(`layoff_phone_index/${indexId}`)
    const indexSnap = await indexRef.get()
    let candidateId: string
    let isReregistration = false
    if (indexSnap.exists) {
      candidateId = indexSnap.data()!.candidateId as string
      isReregistration = true

      // Auto mode → return duplicate signal so the UI can show the
      // "reuse / start fresh" prompt. No writes performed.
      if (mode === "auto") {
        const userRef = db.collection(PA_COLLECTIONS.users).doc(candidateId)
        const userSnap = await userRef.get()
        const u = userSnap.data() ?? {}
        const ctx = (u.layoffContext ?? {}) as Record<string, string | null>
        const ts = u.lastLaidOffAt
        const lastLaidOffAt =
          ts && typeof (ts as { toDate?: unknown }).toDate === "function"
            ? (ts as { toDate: () => Date }).toDate().toISOString()
            : typeof ts === "string"
              ? ts
              : null
        return {
          duplicate: true,
          candidateId,
          existing: {
            firstName: ((u.displayName as string | undefined) ?? "").split(" ")[0] ?? null,
            lastCompany: ctx.lastCompany ?? null,
            jobTitle: ctx.jobTitle ?? null,
            location: ctx.location ?? null,
            lastLaidOffAt,
          },
        }
      }
    } else {
      candidateId = db.collection(PA_COLLECTIONS.users).doc().id
    }

    // Sticky from-number — deterministic hash by candidateId.
    const pool = await loadSendbluePool(db)
    const fromNumber = pickFromNumber(pool, candidateId) ?? process.env.SENDBLUE_FROM_NUMBER ?? ""
    const groupId = fromNumber ? sendblueGroupId({ number: fromNumber, status: "active" }) : "unassigned"

    // Single source of truth — pa-users.
    //   reuse   → only refresh lastLaidOffAt + source tag (no field overwrite)
    //   refresh → also overwrite layoffContext with newly submitted fields
    //   (fresh new registration) → write everything
    const userRef = db.collection(PA_COLLECTIONS.users).doc(candidateId)
    const writeLayoffContext = !isReregistration || mode === "refresh"

    const writePayload: Record<string, unknown> = {
      id: candidateId,
      phoneE164,
      source: LAYOFF_SOURCE_TAG,
      lastLaidOffAt: now,
      senderNumber: fromNumber,
      senderGroupId: groupId,
    }
    if (writeLayoffContext) {
      writePayload.displayName = `${v.firstName} ${v.lastName}`.trim() || v.firstName
      writePayload.layoffContext = {
        lastCompany: v.lastCompany,
        jobTitle: v.jobTitle,
        location: v.location,
        email: v.email,
        linkedin: v.linkedin ?? null,
        resumeFileName: v.resumeFileName ?? null,
        consent: v.consent,
      }
    }
    if (!isReregistration) {
      writePayload.onboardingStatus = "invited"
      writePayload.createdAt = new Date().toISOString()
    }

    const batch = db.batch()
    batch.set(userRef, writePayload, { merge: true })
    batch.set(indexRef, { candidateId, lastLaidOffAt: now, phoneHash: indexId }, { merge: true })

    // List-position counter (for the success screen)
    const counterRef = db.doc("layoff_meta/counters")
    const counterSnap = await counterRef.get()
    const listPosition = (counterSnap.exists ? (counterSnap.data()?.candidateCount ?? 412) : 412) + (isReregistration ? 0 : 1)
    if (!isReregistration) batch.set(counterRef, { candidateCount: listPosition }, { merge: true })

    await batch.commit()

    return {
      candidateId,
      listPosition,
      senderNumber: fromNumber,
      senderGroupId: groupId,
      isReregistration,
      mode,
    }
  },
)

// ---------- SMS kickoff (Claire opener via pa-outbound) ----------

export const openInitiateSmsPrescreen = onCall<{ candidateId: string }>(
  { region: "us-central1", cors: true },
  async (req) => {
    const { candidateId } = req.data
    const db = getFirestore()
    const userRef = db.collection(PA_COLLECTIONS.users).doc(candidateId)
    const doc = await userRef.get()
    if (!doc.exists) throw new HttpsError("not-found", "User not found")
    const u = doc.data()!
    if (u.source !== LAYOFF_SOURCE_TAG) {
      throw new HttpsError("failed-precondition", "user_not_tagged_layoff")
    }

    const ctx = (u.layoffContext ?? {}) as Record<string, string>
    const phoneE164 = u.phoneE164 as string
    const firstName = (u.displayName?.split(" ")[0] as string) ?? "there"

    const body = renderLayoffOpenerBody({ firstName, lastCompany: ctx.lastCompany ?? "your last company" })
    const idempotencyKey = `wekruit_open_layoff:${candidateId}:kickoff`
    const enqueueResult = await enqueueOutbound(db, {
      userId: candidateId,
      toE164: phoneE164,
      imessageChatId: `iMessage;-;${phoneE164}`,
      body,
      idempotencyKey,
    })

    await userRef.set(
      {
        smsState: "kickoff-enqueued",
        smsKickoffAt: FieldValue.serverTimestamp(),
        smsThreadId: `iMessage;-;${phoneE164}`,
        kickoffOutboundId: enqueueResult.id,
      },
      { merge: true },
    )

    return {
      ok: true,
      kickoffOutboundId: enqueueResult.id,
      kickoffCreated: enqueueResult.created,
      sourceTag: LAYOFF_SOURCE_TAG,
    }
  },
)

// ---------- Chat turn capture (web SMS-bubble UI; SMS turns go through PA broker) ----------

export const openSubmitChatTurn = onCall<{
  candidateId: string
  turn: { promptId: string; text: string; at?: string }
}>({ region: "us-central1", cors: true }, async (req) => {
  const { candidateId, turn } = req.data
  const db = getFirestore()
  const userRef = db.collection(PA_COLLECTIONS.users).doc(candidateId)
  await userRef.set(
    {
      [`layoffChatAnswers.${turn.promptId}`]: turn.text,
      smsLastTurnAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  )
  return { ok: true }
})

// ---------- Verified-marketplace listing (layoff-tagged users only) ----------

export const openListLayoffCandidates = onCall<{
  functions?: string[]
  verifiedOnly?: boolean
  /** Max age (days) for lastLaidOffAt — defaults to 180. */
  withinDays?: number
}>({ region: "us-central1", cors: true }, async (req) => {
  if (!req.auth) throw new HttpsError("unauthenticated", "Sign in required")
  const db = getFirestore()
  // Filter by source tag — guarantees we never spill non-layoff pa-users
  // (e.g., regular PA candidates from pa-landing) into the layoff list.
  let q: FirebaseFirestore.Query = db
    .collection(PA_COLLECTIONS.users)
    .where("source", "==", LAYOFF_SOURCE_TAG)

  const withinDays = req.data.withinDays ?? 180
  const cutoff = new Date(Date.now() - withinDays * 86400_000)
  q = q.where("lastLaidOffAt", ">=", cutoff)

  if (req.data.functions?.length) {
    q = q.where("layoffContext.function", "in", req.data.functions.slice(0, 10))
  }

  const snap = await q.limit(200).get()
  return {
    data: snap.docs.map((d) => {
      const x = d.data()
      const ctx = (x.layoffContext ?? {}) as Record<string, unknown>
      // Return a redacted marketplace card — never raw email/phone.
      return {
        id: d.id,
        firstName: (x.displayName as string)?.split(" ")[0] ?? null,
        lastInitial: (x.displayName as string)?.split(" ")[1]?.[0] ?? null,
        lastCompany: ctx.lastCompany ?? null,
        jobTitle: ctx.jobTitle ?? null,
        location: ctx.location ?? null,
        lastLaidOffAt: x.lastLaidOffAt ?? null,
        verified: x.onboardingStatus === "complete" || x.onboardingStatus === "active",
      }
    }),
  }
})

// ---------- Employer registration ----------

type EmployerInput = {
  companyName: string
  companyLinkedin: string
  workEmail: string
  stage: string
  roleAtCompany: string
  rolesHiring: string[]
}

export const openRegisterEmployer = onCall<EmployerInput>(
  { region: "us-central1", cors: true },
  async (req) => {
    const v = req.data
    if (!v.companyName || !v.workEmail) throw new HttpsError("invalid-argument", "Missing required fields")
    const db = getFirestore()
    const ref = db.collection("layoff_employers").doc()
    await ref.set({
      ...v,
      verificationStatus: "pending",
      registeredAt: FieldValue.serverTimestamp(),
    })
    return { employerId: ref.id }
  },
)
