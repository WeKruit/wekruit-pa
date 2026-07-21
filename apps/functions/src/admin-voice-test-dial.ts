/**
 * v2.2 W6 — admin-only callable that creates an `outbound-bookings/{id}`
 * doc seeded with `voiceState: "dialing"`, which triggers the existing
 * `dialOutbound` Firestore CF → Twilio SIP → LiveKit room → voice agent
 * (CA_CyhBjJioxJR9) with the in-process WekruitLLM.
 *
 * Backs the `/admin/voice-test-dial` dashboard form. The CF is the only
 * dashboard-side way to dial a number; it skips the bulk-resume / public-
 * application paths so internal smoke can happen with one click.
 *
 * Auth: same admin-claim + PA_ADMIN_TOKEN fallback as the other admin
 * CFs (mirrors `paAdminMatchDebug`).
 *
 * Validation:
 *   - paUserId must exist in pa-users
 *   - paJobId must exist in matching-jobs
 *   - toNumber must look like +E.164
 *   - rate limit: refuse if there's an open booking for the same
 *     paUserId+paJobId in the last 60s (prevents accidental double-dial)
 */

import { onCall, HttpsError } from "firebase-functions/v2/https"
import { defineSecret } from "firebase-functions/params"
import { getFirestore, FieldValue } from "firebase-admin/firestore"
import { randomBytes } from "node:crypto"
import { z } from "zod"

import { authorizeAdminCallable } from "./promote-sandbox-tag.js"

const PA_ADMIN_TOKEN = defineSecret("PA_ADMIN_TOKEN")

const InputSchema = z.object({
  paUserId: z.string().min(8).max(128),
  // Required only for prescreen calls; onboarding / know_you_better are not job-tied.
  paJobId: z.string().min(1).max(256).optional(),
  toNumber: z.string().regex(/^\+[1-9]\d{6,14}$/, "must be +E.164"),
  purpose: z.enum(["prescreen", "onboarding", "know_you_better"]).optional(),
  timeBudgetSec: z.number().int().positive().max(1800).optional(),
  adminToken: z.string().optional(),
})

export type AdminVoiceTestDialInput = z.infer<typeof InputSchema>

export interface AdminVoiceTestDialResult {
  ok: true
  bookingId: string
  voiceState: "dialing"
  createdAt: string
}

/**
 * 16-char bookingId — short enough to render as a LK room name without
 * exhausting the 64-char limit, long enough to be collision-resistant.
 * Prefix `vt-` so the docs are filterable from real outbound bookings.
 */
function generateBookingId(): string {
  return `vt-${randomBytes(8).toString("hex")}`
}

export const paAdminVoiceTestDial = onCall(
  {
    region: "us-central1",
    cors: true,
    secrets: [PA_ADMIN_TOKEN],
  },
  async (req): Promise<AdminVoiceTestDialResult> => {
    authorizeAdminCallable(
      req as { auth?: { token?: { admin?: unknown } }; data?: unknown },
    )
    const parsed = InputSchema.safeParse(req.data)
    if (!parsed.success) {
      throw new HttpsError("invalid-argument", parsed.error.message)
    }
    const { paUserId, paJobId, toNumber, timeBudgetSec } = parsed.data
    const purpose = parsed.data.purpose ?? "prescreen"
    if (purpose === "prescreen" && !paJobId) {
      throw new HttpsError("invalid-argument", "paJobId is required for a prescreen call")
    }

    const db = getFirestore()

    // Validate the upstream identities exist. Skip the bulk-resume /
    // anonymous-application paths; this is admin-driven smoke. The job is only
    // validated for prescreen (onboarding / know_you_better are not job-tied).
    const userSnap = await db.collection("pa-users").doc(paUserId).get()
    if (!userSnap.exists) {
      throw new HttpsError("not-found", `pa-users/${paUserId} not found`)
    }
    if (paJobId) {
      const jobSnap = await db.collection("matching-jobs").doc(paJobId).get()
      if (!jobSnap.exists) {
        throw new HttpsError("not-found", `matching-jobs/${paJobId} not found`)
      }
    }

    // Dupe-suppression — single-field equality + in-memory time filter
    // so we don't need a (paUserId, paJobId, createdAt) composite
    // Firestore index. Refuses if same user+job pair was dialed in last 60s.
    const sixtyAgoMs = Date.now() - 60_000
    const dupeSnap = await db
      .collection("outbound-bookings")
      .where("paUserId", "==", paUserId)
      .limit(20)
      .get()
    for (const d of dupeSnap.docs) {
      const data = d.data() as { paJobId?: string; purpose?: string; createdAt?: string }
      // Same user+job (prescreen) or same user+purpose (non-job calls) within 60s.
      if (paJobId ? data.paJobId !== paJobId : (data.purpose ?? "prescreen") !== purpose) continue
      const t = data.createdAt ? Date.parse(data.createdAt) : 0
      if (t >= sixtyAgoMs) {
        throw new HttpsError(
          "already-exists",
          `recent booking exists for this user (id=${d.id})`,
        )
      }
    }

    const bookingId = generateBookingId()
    const createdAt = new Date().toISOString()

    // The S3 dial gate fires on transition `before.voiceState !== "dialing"
    // → after.voiceState === "dialing"`. Creating the doc directly with
    // "dialing" satisfies that (before is undefined).
    await db.collection("outbound-bookings").doc(bookingId).set({
      paUserId,
      ...(paJobId ? { paJobId } : {}),
      purpose,
      ...(timeBudgetSec ? { timeBudgetSec } : {}),
      phoneE164: toNumber,
      voiceState: "dialing",
      voiceCallSid: null,
      voiceRoomName: null,
      voiceStartedAt: null,
      voiceEndedAt: null,
      voiceOutcome: null,
      voiceLastError: null,
      voiceCallerId: null,
      origin: "admin-voice-test-dial",
      createdAt,
      createdBy: "admin",
      // FieldValue.serverTimestamp() so range-queries on a server-side
      // timestamp still work for dashboards that filter by `createdAtTs`.
      createdAtTs: FieldValue.serverTimestamp(),
    })

    return { ok: true, bookingId, voiceState: "dialing", createdAt }
  },
)
