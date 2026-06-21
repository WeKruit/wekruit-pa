/**
 * v2.2 — Voice-side HTTP callable CFs.
 *
 *   paVoiceCallContext     — assembles a VoiceCallContext for a bookingId
 *                            by fanning out to the S1B loaders.
 *   paVoicePrescreenTurn   — runs the channel-agnostic runPrescreenTurn
 *                            for a single voice-side turn.
 *   paVoiceOnboardingTurn  — runs the shared onboarding reducer with
 *                            outbound suppressed and returns text for TTS.
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
import { createHash } from "node:crypto"
import {
  createFirestoreOrchestratorStore,
  FirestoreSessionFinder,
  FirestoreTurnRecorder,
  runOnboardingPipelineTurn,
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

type VoicePurpose = "prescreen" | "onboarding"

function checkAuth(req: { get: (h: string) => string | undefined }, expected: string): boolean {
  if (!expected) return true // dev / unconfigured → permissive
  const got = (req.get("X-Wekruit-Voice-CF-Secret") ?? "").trim()
  return got === expected
}

function stableTurnDocId(input: {
  bookingId: string
  userId: string
  nowIso: string
  reply: string
}): string {
  return createHash("sha256")
    .update(`${input.bookingId}|${input.userId}|${input.nowIso}|${input.reply}`)
    .digest("hex")
    .slice(0, 32)
}

async function persistVoiceTurn(
  db: FirebaseFirestore.Firestore,
  input: {
    bookingId: string
    sessionId: string
    userId: string
    purpose: VoicePurpose
    userTranscript: string
    claireReply: string | null
    action: Record<string, unknown>
    createdAt: string
  },
): Promise<void> {
  const turnId = stableTurnDocId({
    bookingId: input.bookingId,
    userId: input.userId,
    nowIso: input.createdAt,
    reply: input.userTranscript,
  })
  await db
    .collection("outbound-bookings")
    .doc(input.bookingId)
    .collection("turns")
    .doc(turnId)
    .set(
      {
        turnId,
        bookingId: input.bookingId,
        sessionId: input.sessionId,
        userId: input.userId,
        purpose: input.purpose,
        userTranscript: input.userTranscript,
        claireReply: input.claireReply,
        action: input.action,
        createdAt: input.createdAt,
      },
      { merge: true },
    )
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
    maxInstances: 1,
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
    // Canonical fields are paUserId/paJobId (match dialOutbound.ts).
    // Fall back to legacy userId/jobId for any older docs.
    const userId =
      (typeof booking.paUserId === "string" && booking.paUserId) ||
      (typeof booking.userId === "string" && booking.userId) ||
      ""
    const purpose: VoicePurpose = booking.purpose === "onboarding" ? "onboarding" : "prescreen"
    if (!userId) {
      res.status(400).json({ ok: false, reason: "booking_missing_user" })
      return
    }

    try {
      if (purpose === "onboarding") {
        const userProfile = await loadUserProfileForVoice(db, userId)
        res.status(200).json({
          ok: true,
          bookingId,
          purpose,
          userProfile,
        })
        return
      }
      const jobId =
        (typeof booking.paJobId === "string" && booking.paJobId) ||
        (typeof booking.jobId === "string" && booking.jobId) ||
        ""
      if (!jobId) {
        res.status(400).json({ ok: false, reason: "booking_missing_job" })
        return
      }
      const prescreenSessionId =
        (typeof booking.prescreenSessionId === "string" && booking.prescreenSessionId) ||
        bookingId
      const [userProfile, jobBrief, prescreenConfig] = await Promise.all([
        loadUserProfileForVoice(db, userId),
        loadJobBriefForVoice(db, jobId),
        loadPrescreenConfigForVoice(db, jobId),
      ])
      res.status(200).json({
        ok: true,
        bookingId,
        purpose,
        prescreenSessionId,
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
      bookingId?: string
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

    const action =
      result.lifecycle.kind === "active_turn"
        ? result.lifecycle.pipelineResult.action
        : { kind: result.lifecycle.kind }
    try {
      await persistVoiceTurn(db, {
        bookingId: body.bookingId ?? body.sessionId,
        sessionId: body.sessionId,
        userId: body.userId,
        purpose: "prescreen",
        userTranscript: body.reply,
        claireReply: result.text,
        action: action as Record<string, unknown>,
        createdAt: body.nowIso,
      })
    } catch (err) {
      logger.error("paVoicePrescreenTurn:turn_persist_failed", {
        bookingId: body.bookingId ?? body.sessionId,
        sessionId: body.sessionId,
        error: err instanceof Error ? err.message : String(err),
      })
    }

    res.status(200).json({
      ok: true,
      lifecycleKind: result.lifecycle.kind,
      text: result.text,
      action,
      ...(result.terminalAction ? { terminalAction: result.terminalAction } : {}),
    })
  },
)

/* ────────────────────────────────────────────────────────────────────────── */
/* paVoiceOnboardingTurn                                                      */
/* ────────────────────────────────────────────────────────────────────────── */

export const paVoiceOnboardingTurn: HttpsFunction = onRequest(
  {
    secrets: [PA_VOICE_CF_SECRET],
    cors: false,
    region: "us-central1",
    memory: "512MiB",
    timeoutSeconds: 120,
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
      bookingId?: string
      sessionId?: string
      userId?: string
      reply?: string
      lang?: "zh" | "en"
      nowIso?: string
    }
    if (
      typeof body.bookingId !== "string" ||
      typeof body.sessionId !== "string" ||
      typeof body.userId !== "string" ||
      typeof body.reply !== "string" ||
      typeof body.nowIso !== "string"
    ) {
      res.status(400).json({ ok: false, reason: "missing_fields" })
      return
    }
    const bookingId = body.bookingId
    const sessionId = body.sessionId
    const userId = body.userId
    const reply = body.reply
    const nowIso = body.nowIso

    const db = getFirestore()
    const store = createFirestoreOrchestratorStore(db)
    const emitted: string[] = []
    const turnId = stableTurnDocId({
      bookingId,
      userId,
      nowIso,
      reply,
    })
    let result: Awaited<ReturnType<typeof runOnboardingPipelineTurn>>
    try {
      result = await runOnboardingPipelineTurn({
        event: {
          id: `voice-${turnId}`,
          userId,
          sessionId,
          channel: "other",
          externalChatId: bookingId,
          from: "voice",
          body: reply,
          status: "running",
          createdAt: nowIso,
          idempotencyKey: `voice-onboarding:${bookingId}:${turnId}`,
          rawMeta: {
            source: "voice",
            bookingId,
            purpose: "onboarding",
            lang: body.lang ?? "en",
          },
        },
        turnId,
        agent: { id: "claire-voice-onboarding", name: "Claire Voice Onboarding" } as never,
        suppressOutbound: true,
        deps: {
          appendMessage: async (args) => {
            emitted.push(args.body)
            await store.appendMessage(args)
          },
          enqueueOutbound: async () => undefined,
          applyOnboarding: store.applyOnboarding,
          getOnboardingUser: store.getOnboardingUser,
          nowIso: () => nowIso,
          log: (event, payload) => logger.info(event, payload),
          db,
        },
      })
    } catch (err) {
      logger.error("paVoiceOnboardingTurn:runner_failed", {
        bookingId,
        sessionId,
        error: err instanceof Error ? err.message : String(err),
      })
      res.status(500).json({ ok: false, reason: "runner_failed" })
      return
    }

    const completed = result.raw?.completed === true
    const halted = result.raw?.halted === true
    const action: Record<string, unknown> = completed
      ? { kind: "complete", reason: "onboarding_completed" }
      : halted
        ? { kind: "terminal", terminal: "HALT", reason: "onboarding_halted" }
        : { kind: "advance", currentQId: result.raw?.currentQId ?? null }
    const text = emitted.join(" ").trim() || (completed ? "That's it — thank you." : "")

    try {
      await persistVoiceTurn(db, {
        bookingId,
        sessionId,
        userId,
        purpose: "onboarding",
        userTranscript: reply,
        claireReply: text || null,
        action,
        createdAt: nowIso,
      })
    } catch (err) {
      logger.error("paVoiceOnboardingTurn:turn_persist_failed", {
        bookingId,
        sessionId,
        error: err instanceof Error ? err.message : String(err),
      })
    }

    res.status(200).json({
      ok: true,
      lifecycleKind: "onboarding_turn",
      text,
      action,
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
