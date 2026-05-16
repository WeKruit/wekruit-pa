/**
 * v2.2 — Voice-side HTTP callable CFs.
 *
 *   paVoiceCallContext     — assembles a VoiceCallContext for a bookingId
 *                            by fanning out to the S1B loaders.
 *   paVoicePrescreenTurn   — runs the channel-agnostic runPrescreenTurn
 *                            for a single voice-side turn.
 *
 * Voice worker (apps/voice-agent) calls these via HTTPS so the LK Cloud
 * agent bundle stays free of firebase-admin and @pa/pa-orchestrator. The
 * brain (runPrescreenTurn + KeywordSetJudge + composeClarify) is the
 * same instance the SMS handler uses (prescreen-deps.ts).
 *
 * Auth: bearer header `X-Wekruit-Voice-CF-Secret` matches
 * PA_VOICE_CF_SECRET. Worker reads this secret from its own env at
 * startup.
 */
import { onRequest, type HttpsFunction } from "firebase-functions/v2/https"
import { defineSecret } from "firebase-functions/params"
import { logger } from "firebase-functions/v2"
import { getFirestore } from "firebase-admin/firestore"
import {
  FirestoreSessionFinder,
  FirestoreTurnRecorder,
  runPrescreenTurn,
  type PrescreenChannelTextHint,
  type PrescreenConfig,
  type PrescreenRunResult,
} from "@pa/pa-orchestrator"
import {
  FirestorePreScreenStore,
  makeProductionClarifyComposer,
  makeProductionKeywordSetCaller,
} from "../prescreen-deps.js"
import {
  loadJobBriefForVoice,
  loadPrescreenConfigForVoice,
  loadUserProfileForVoice,
  NotFoundError,
} from "./context-loaders/index.js"

const PA_VOICE_CF_SECRET = defineSecret("PA_VOICE_CF_SECRET")

function checkAuth(req: { get: (h: string) => string | undefined }, expected: string): boolean {
  if (!expected) return true // dev / unconfigured → permissive
  const got = (req.get("X-Wekruit-Voice-CF-Secret") ?? "").trim()
  return got === expected
}

/* ────────────────────────────────────────────────────────────────────────── */
/* paVoiceCallContext                                                         */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * Request body: { bookingId: string }
 *
 * outbound-bookings/{bookingId} carries jobId + userId. We fan out from
 * there to the three S1B loaders and return the assembled VoiceCallContext.
 */
export const paVoiceCallContext: HttpsFunction = onRequest(
  {
    secrets: [PA_VOICE_CF_SECRET],
    cors: false,
    region: "us-central1",
    memory: "256MiB",
  },
  async (req, res) => {
    if (req.method !== "POST") {
      res.status(405).json({ ok: false, reason: "method_not_allowed" })
      return
    }
    if (!checkAuth(req as never, PA_VOICE_CF_SECRET.value().trim())) {
      res.status(401).json({ ok: false, reason: "unauthorized" })
      return
    }

    const body = (req.body ?? {}) as { bookingId?: string }
    const bookingId = typeof body.bookingId === "string" ? body.bookingId : ""
    if (!bookingId) {
      res.status(400).json({ ok: false, reason: "missing_bookingId" })
      return
    }

    const db = getFirestore()
    const bookingSnap = await db.collection("outbound-bookings").doc(bookingId).get()
    if (!bookingSnap.exists) {
      res.status(404).json({ ok: false, reason: "booking_not_found" })
      return
    }
    const booking = bookingSnap.data() as Record<string, unknown>
    const userId = typeof booking.userId === "string" ? booking.userId : ""
    const jobId = typeof booking.jobId === "string" ? booking.jobId : ""
    if (!userId || !jobId) {
      res.status(400).json({ ok: false, reason: "booking_missing_user_or_job" })
      return
    }

    try {
      const [userProfile, jobBrief, prescreenConfig] = await Promise.all([
        loadUserProfileForVoice(db, userId),
        loadJobBriefForVoice(db, jobId),
        loadPrescreenConfigForVoice(db, jobId),
      ])
      res.status(200).json({
        ok: true,
        bookingId,
        userProfile,
        jobBrief,
        prescreenConfig,
      })
    } catch (err) {
      if (err instanceof NotFoundError) {
        res.status(404).json({ ok: false, reason: "not_found", detail: String(err.message ?? err) })
        return
      }
      logger.error("paVoiceCallContext:assembly_failed", {
        bookingId,
        error: err instanceof Error ? err.message : String(err),
      })
      res.status(500).json({ ok: false, reason: "assembly_failed" })
    }
  },
)

/* ────────────────────────────────────────────────────────────────────────── */
/* paVoicePrescreenTurn                                                       */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * Request body:
 *   { sessionId: string, userId: string, reply: string,
 *     lang: "zh"|"en", nowIso: string }
 *
 * Returns:
 *   { ok: true, text: string|null, action: ..., terminalAction?: {...},
 *     lifecycleKind: string }
 */
export const paVoicePrescreenTurn: HttpsFunction = onRequest(
  {
    secrets: [PA_VOICE_CF_SECRET],
    cors: false,
    region: "us-central1",
    memory: "512MiB",
    timeoutSeconds: 60,
  },
  async (req, res) => {
    if (req.method !== "POST") {
      res.status(405).json({ ok: false, reason: "method_not_allowed" })
      return
    }
    if (!checkAuth(req as never, PA_VOICE_CF_SECRET.value().trim())) {
      res.status(401).json({ ok: false, reason: "unauthorized" })
      return
    }

    const body = (req.body ?? {}) as {
      sessionId?: string
      userId?: string
      reply?: string
      lang?: "zh" | "en"
      nowIso?: string
    }
    if (
      typeof body.sessionId !== "string" ||
      typeof body.userId !== "string" ||
      typeof body.reply !== "string" ||
      typeof body.nowIso !== "string"
    ) {
      res.status(400).json({ ok: false, reason: "missing_fields" })
      return
    }

    const db = getFirestore()
    const store = new FirestorePreScreenStore(db)
    const sessionFinder = new FirestoreSessionFinder(db)
    const turnRecorder = new FirestoreTurnRecorder(db)
    const cfgLoader = async (sessionId: string): Promise<PrescreenConfig | null> => {
      const snap = await db.collection("pa-prescreen-sessions").doc(sessionId).get()
      const cfg = snap.data()?.cfgSnapshot as PrescreenConfig | undefined
      return cfg ?? null
    }

    let result: PrescreenRunResult
    try {
      result = await runPrescreenTurn(
        {
          sessionId: body.sessionId,
          userId: body.userId,
          reply: body.reply,
          lang: body.lang ?? "en",
          nowIso: body.nowIso,
          channel: "voice",
          log: (event, payload) => logger.info(event, payload),
        },
        {
          store,
          sessionFinder,
          cfgLoader,
          llmCaller: makeProductionKeywordSetCaller(),
          composeClarify: makeProductionClarifyComposer(),
          turnRecorder,
          channelTextHint: voiceChannelTextHint,
        },
      )
    } catch (err) {
      logger.error("paVoicePrescreenTurn:runner_failed", {
        sessionId: body.sessionId,
        error: err instanceof Error ? err.message : String(err),
      })
      res.status(500).json({ ok: false, reason: "runner_failed" })
      return
    }

    res.status(200).json({
      ok: true,
      lifecycleKind: result.lifecycle.kind,
      text: result.text,
      action:
        result.lifecycle.kind === "active_turn"
          ? result.lifecycle.pipelineResult.action
          : { kind: result.lifecycle.kind },
      ...(result.terminalAction ? { terminalAction: result.terminalAction } : {}),
    })
  },
)

/* ────────────────────────────────────────────────────────────────────────── */
/* Voice channel hint                                                         */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * SMS-isms that read fine in iMessage but sound awkward over the phone get
 * lightly rewritten for TTS. Conservative — when in doubt leave the text
 * alone; the runner's text is already short.
 */
export const voiceChannelTextHint: PrescreenChannelTextHint = ({ text }) => {
  return text
    .replace(/\biMessage\b/gi, "message")
    .replace(/\btext me back\b/gi, "tell me")
    .replace(/\btext\s+me\b/gi, "tell me")
}
