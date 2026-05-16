/**
 * S3 (v2.1) — Cloud Function wrappers for outbound-voice dispatch and
 * status-callback reconciliation.
 *
 * Pure logic lives in `dialOutbound.ts` (`handleDialOutbound`) and
 * `sipWebhook.ts` (`reconcileVoiceCallback`). This file is the firebase-
 * functions glue:
 *   - `paVoiceDialOutbound` — Firestore `onDocumentWritten` trigger.
 *   - `paVoiceSipWebhook`   — HTTP `onRequest` endpoint shared by Twilio
 *     status callbacks and LiveKit room webhooks.
 *
 * Secrets used (all set via `firebase functions:secrets:set`):
 *   LIVEKIT_API_KEY
 *   LIVEKIT_API_SECRET
 *   TWILIO_SIP_PASSWORD               (not read here; the trunk auth is
 *                                      configured on the LiveKit Cloud side)
 *   PA_VOICE_WEBHOOK_SECRET           shared bearer for webhook auth
 *
 * Non-secret env (set via deploy config):
 *   LIVEKIT_URL                       wss://...livekit.cloud
 *   TWILIO_SIP_TRUNK_SID              TK...
 *   TWILIO_OUTBOUND_CALLER_IDS        comma list
 *   PA_VOICE_CALLER_ID_STRATEGY       roundrobin | sticky_user
 */

import { onDocumentWritten } from "firebase-functions/v2/firestore"
import { onRequest, type HttpsFunction } from "firebase-functions/v2/https"
import { defineSecret } from "firebase-functions/params"
import { logger } from "firebase-functions/v2"
import { getFirestore, type Firestore } from "firebase-admin/firestore"

import { handleDialOutbound } from "./dialOutbound.js"
import type { BookingDocRef } from "./dialOutbound.js"
import { reconcileVoiceCallback } from "./sipWebhook.js"
import type {
  BookingDocSnap,
  BookingTxnContext,
} from "./sipWebhook.js"
import type { OutboundBookingRow, SipClientLike, VoiceCallbackEvent } from "./types.js"
import { makeCallerIdStrategy } from "./caller-id-rotator.js"

// ─── Secrets ────────────────────────────────────────────────────────────────

const LIVEKIT_API_KEY = defineSecret("LIVEKIT_API_KEY")
const LIVEKIT_API_SECRET = defineSecret("LIVEKIT_API_SECRET")
const PA_VOICE_WEBHOOK_SECRET = defineSecret("PA_VOICE_WEBHOOK_SECRET")

// ─── LiveKit SDK adapter ────────────────────────────────────────────────────

/**
 * Lazy-loaded LiveKit `SipClient` adapter. We dynamic-import to keep the
 * cold-start path lean and so unit tests of the rest of this module do not
 * require the SDK at module load.
 *
 * The SDK's `SipClient.createSipParticipant` signature varies slightly
 * across versions; this adapter normalizes to the shim shape declared in
 * `types.ts`.
 */
async function makeRealSipClient(opts: {
  livekitUrl: string
  apiKey: string
  apiSecret: string
}): Promise<SipClientLike> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mod: any = await import("livekit-server-sdk")
  const client = new mod.SipClient(opts.livekitUrl, opts.apiKey, opts.apiSecret)
  return {
    async createSipParticipant(args) {
      // SDK v2.x positional: (sipTrunkId, number, roomName, opts).
      const info = await client.createSipParticipant(
        args.sipTrunkId,
        args.sipCallTo,
        args.roomName,
        {
          participantIdentity: args.participantIdentity,
          participantName: args.participantName,
          fromNumber: args.fromNumber,
        },
      )
      return {
        sipCallId: info?.sipCallId ?? info?.callId ?? info?.participantIdentity ?? "",
        roomName: info?.roomName ?? args.roomName,
        participantIdentity: info?.participantIdentity ?? args.participantIdentity,
      }
    },
  }
}

// ─── Firestore txn context for sipWebhook ───────────────────────────────────

function makeBookingTxnContext(db: Firestore): BookingTxnContext {
  const coll = db.collection("outbound-bookings")
  const toSnap = (doc: FirebaseFirestore.QueryDocumentSnapshot | FirebaseFirestore.DocumentSnapshot): BookingDocSnap => ({
    exists: doc.exists,
    id: doc.id,
    data: () => doc.data() as OutboundBookingRow | undefined,
    ref: {
      set: (data, opts) => doc.ref.set(data, opts ?? {}) as Promise<unknown>,
    },
  })
  return {
    async getById(id) {
      const d = await coll.doc(id).get()
      return d.exists ? toSnap(d) : null
    },
    async findByCallSid(callSid) {
      const q = await coll.where("voiceCallSid", "==", callSid).limit(1).get()
      if (q.empty) return null
      return toSnap(q.docs[0]!)
    },
    async findByRoomName(roomName) {
      const q = await coll.where("voiceRoomName", "==", roomName).limit(1).get()
      if (q.empty) return null
      return toSnap(q.docs[0]!)
    },
  }
}

// ─── paVoiceDialOutbound — Firestore trigger ────────────────────────────────

export const paVoiceDialOutbound = onDocumentWritten(
  {
    document: "outbound-bookings/{bookingId}",
    region: "us-central1",
    secrets: [LIVEKIT_API_KEY, LIVEKIT_API_SECRET],
    memory: "512MiB",
    timeoutSeconds: 60,
    concurrency: 20,
  },
  async (event) => {
    const bookingId = event.params.bookingId
    const before = event.data?.before?.data() as OutboundBookingRow | undefined
    const after = event.data?.after?.data() as OutboundBookingRow | undefined

    // Fast no-op on irrelevant writes.
    if (!after) return
    if (after.voiceState !== "dialing") return
    if (before?.voiceState === "dialing") return

    const livekitUrl = process.env.LIVEKIT_URL ?? ""
    const trunkSid = process.env.TWILIO_SIP_TRUNK_SID ?? ""
    const callerIdsEnv = process.env.TWILIO_OUTBOUND_CALLER_IDS
    const apiKey = LIVEKIT_API_KEY.value().trim()
    const apiSecret = LIVEKIT_API_SECRET.value().trim()

    if (!livekitUrl || !trunkSid || !apiKey || !apiSecret) {
      logger.error("paVoiceDialOutbound:missing_config", {
        bookingId,
        hasLivekitUrl: Boolean(livekitUrl),
        hasTrunkSid: Boolean(trunkSid),
        hasApiKey: Boolean(apiKey),
        hasApiSecret: Boolean(apiSecret),
      })
      // Mark booking failed so a human sees it.
      try {
        await getFirestore()
          .collection("outbound-bookings")
          .doc(bookingId)
          .set(
            {
              voiceState: "failed",
              voiceOutcome: "failed:config_missing",
              voiceLastError: "voice dispatch config missing (livekit/trunk/secret)",
              voiceEndedAt: new Date().toISOString(),
            },
            { merge: true },
          )
      } catch (err) {
        logger.error("paVoiceDialOutbound:config_failure_write_failed", {
          bookingId,
          error: err instanceof Error ? err.message : String(err),
        })
      }
      return
    }

    let sipClient: SipClientLike
    try {
      sipClient = await makeRealSipClient({ livekitUrl, apiKey, apiSecret })
    } catch (err) {
      logger.error("paVoiceDialOutbound:sdk_load_failed", {
        bookingId,
        error: err instanceof Error ? err.message : String(err),
      })
      return
    }

    const callerIdStrategy = makeCallerIdStrategy({
      TWILIO_OUTBOUND_CALLER_IDS: callerIdsEnv,
      PA_VOICE_CALLER_ID_STRATEGY: process.env.PA_VOICE_CALLER_ID_STRATEGY,
    })

    const db = getFirestore()
    const bookingRef: BookingDocRef = {
      set: (data, opts) => db.collection("outbound-bookings").doc(bookingId).set(data, opts ?? {}) as Promise<unknown>,
    }

    const result = await handleDialOutbound(
      { bookingId, before, after, bookingRef },
      {
        sipClient,
        callerIdStrategy,
        trunkSid,
        log: (level, msg, fields) => logger[level](msg, { ...fields }),
      },
    )
    logger.info("paVoiceDialOutbound:result", { ...result })
  },
)

// ─── paVoiceSipWebhook — HTTP CF ────────────────────────────────────────────

/**
 * Parse the incoming webhook body into a VoiceCallbackEvent. Twilio posts
 * application/x-www-form-urlencoded by default; LiveKit posts JSON. We
 * accept both.
 */
export function parseWebhookBody(req: {
  is?: (t: string) => boolean | string | null
  get?: (h: string) => string | undefined
  body: unknown
}): VoiceCallbackEvent | null {
  const body = (req.body ?? {}) as Record<string, unknown>
  // LiveKit shape — has `event` field.
  if (typeof body.event === "string" && body.room && typeof body.room === "object") {
    return body as unknown as VoiceCallbackEvent
  }
  // Twilio shape — has `CallSid` + `CallStatus`.
  if (typeof body.CallSid === "string" && typeof body.CallStatus === "string") {
    return {
      source: "twilio",
      CallSid: body.CallSid,
      CallStatus: body.CallStatus as VoiceCallbackEvent extends { source: "twilio"; CallStatus: infer S }
        ? S
        : never,
      ErrorCode: typeof body.ErrorCode === "string" ? body.ErrorCode : undefined,
      ErrorMessage: typeof body.ErrorMessage === "string" ? body.ErrorMessage : undefined,
      bookingId: typeof body.bookingId === "string" ? body.bookingId : undefined,
    }
  }
  return null
}

export const paVoiceSipWebhook: HttpsFunction = onRequest(
  {
    secrets: [PA_VOICE_WEBHOOK_SECRET],
    cors: false,
    region: "us-central1",
  },
  async (req, res) => {
    if (req.method !== "POST") {
      res.status(405).json({ ok: false, reason: "method_not_allowed" })
      return
    }
    const expected = PA_VOICE_WEBHOOK_SECRET.value().trim()
    if (expected) {
      const got = (req.get("X-Wekruit-Voice-Webhook-Secret") ?? "").trim()
      if (got !== expected) {
        res.status(401).json({ ok: false, reason: "unauthorized" })
        return
      }
    }

    const event = parseWebhookBody(req as unknown as Parameters<typeof parseWebhookBody>[0])
    if (!event) {
      res.status(400).json({ ok: false, reason: "unrecognized_body_shape" })
      return
    }

    const db = getFirestore()
    const ctx = makeBookingTxnContext(db)
    const result = await reconcileVoiceCallback(event, {
      txnContext: ctx,
      log: (level, msg, fields) => logger[level](msg, { ...fields }),
    })

    res.status(200).json({ ok: true, ...result })
  },
)
