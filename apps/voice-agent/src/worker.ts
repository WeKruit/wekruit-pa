/**
 * v2.1 S2 — LiveKit Agents worker bootstrap.
 *
 * Why a thin wrapper:
 *   - The voice worker depends on `@livekit/agents` (Node SDK), Deepgram,
 *     Silero, and the OpenAI plugin pointing at the shim. Installing those
 *     for unit tests bloats CI; we keep the SDK import here behind a lazy
 *     dynamic-import so `cli.ts --help` and the unit test suite stay green
 *     without a network install of the LiveKit SDK on the test runner.
 *   - Production (LiveKit Cloud managed agent hosting, L12) provides the
 *     SDK at runtime per `livekit.toml`.
 *
 * Wire diagram (production):
 *   LiveKit room (dispatched by S3 with `bookingId` in metadata)
 *     ↓
 *   defineAgent → entry(ctx)
 *     ↓
 *   parse bookingId from ctx.room.metadata
 *     ↓
 *   loadVoiceContext(bookingId)  ← S1B context loaders
 *     ↓
 *   new AgentSession({
 *     vad: silero.VAD.load(),
 *     turnDetection: new MultilingualModel(),   // adaptive endpointing (Lock L7)
 *     stt: deepgram.STT({ model: "nova-3" }),
 *     llm: openai.LLM({ base_url: WEKRUIT_LLM_SHIM_URL + "/v1",
 *                       model: "wekruit-prescreen-v1",
 *                       api_key: "unused-localhost" }),
 *     tts: deepgram.TTS({ model: "aura-2" }),
 *   })
 *     ↓
 *   registerEventHandlers(session, room, sinks)   ← L7
 *     ↓
 *   session.start({ agent, room })
 *     ↓
 *   session.say(buildConsentPrompt(ctx))           ← L8
 */

import { createTurnLoop, type VoicePipelineLite } from "./turn-loop.js"
import {
  registerEventHandlers,
  type RegisterSinks,
} from "./event-handlers.js"
import { buildConsentPrompt } from "./consent-prompt.js"
import { emitConsentSpokenAudit } from "./consent-audit.js"
import type { VoiceCallContext } from "./voice-context-types.js"

export interface StartWorkerOpts {
  /** Test seam — supply an alternative `defineAgent` impl. */
  defineAgent?: (def: { entry: (ctx: AgentRuntimeCtx) => Promise<void> }) => unknown
  /** Test seam — supply pre-loaded context (skips Firestore reads). */
  loadContext?: (bookingId: string) => Promise<VoiceCallContext>
  /** Test seam — pipeline factory. */
  buildPipeline?: () => Promise<VoicePipelineLite>
  /** Optional logger. */
  log?: (event: string, payload: Record<string, unknown>) => void
}

interface AgentRuntimeCtx {
  room: {
    metadata?: string
    on: (event: string, listener: (...args: unknown[]) => void) => unknown
    off?: (event: string, listener: (...args: unknown[]) => void) => unknown
  }
}

/**
 * Production entry. Lazy-imports `@livekit/agents` + plugins so the file
 * itself is safe to load in unit tests (the heavy imports happen inside
 * `start()`).
 *
 * `defineAgent` here is the LiveKit-side primitive that registers our
 * worker with the managed agent host. We expose a thin overridable hook
 * for tests.
 */
export async function startWorker(opts: StartWorkerOpts = {}): Promise<void> {
  const log = opts.log ?? ((event, payload) => {
    console.log(`[voice-agent] ${event}`, payload)
  })

  // ── Validate env (fail fast in prod; tests inject `defineAgent`) ────────
  if (!opts.defineAgent) {
    requireEnv([
      "LIVEKIT_URL",
      "LIVEKIT_API_KEY",
      "LIVEKIT_API_SECRET",
      "DEEPGRAM_API_KEY",
      "WEKRUIT_LLM_SHIM_URL",
    ])
  }

  // S1A flag-flip — voice bridge always streams via the shim when the
  // shim is in `orchestrator` mode. The variable is read at call time by
  // `runAgentTurnStream`, so we set it here at worker start.
  if (!process.env.PA_AGENT_RUNTIME_STREAM_ENABLED) {
    process.env.PA_AGENT_RUNTIME_STREAM_ENABLED = "true"
  }

  // Lazy-import the LiveKit SDK only when we're booting for real.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let livekitMod: any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let sileroMod: any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let deepgramMod: any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let openaiPluginMod: any

  if (!opts.defineAgent) {
    livekitMod = await import("@livekit/agents")
    sileroMod = await import("@livekit/agents-plugin-silero")
    deepgramMod = await import("@livekit/agents-plugin-deepgram")
    openaiPluginMod = await import("@livekit/agents-plugin-openai")
  }

  const defineAgent =
    opts.defineAgent ??
    ((def: { entry: (ctx: AgentRuntimeCtx) => Promise<void> }) =>
      livekitMod.defineAgent(def))

  const loadContext = opts.loadContext ?? defaultLoadContext

  // ── The actual LiveKit Agent definition ─────────────────────────────────
  const agent = defineAgent({
    entry: async (ctx: AgentRuntimeCtx) => {
      const bookingId = readBookingId(ctx.room.metadata)
      log("voice.worker.entry", { bookingId })

      const callContext = await loadContext(bookingId)
      if (callContext.jobBrief.dead === true) {
        log("voice.worker.dead_job_abort", {
          bookingId,
          jobId: callContext.jobBrief.jobId,
        })
        return
      }

      const pipeline = opts.buildPipeline
        ? await opts.buildPipeline()
        : await defaultBuildPipeline()

      const turnLoop = createTurnLoop({
        pipeline,
        context: callContext,
        log,
      })

      // ── Build AgentSession via SDK ───────────────────────────────────────
      // Adaptive turn detection — MultilingualModel from the LiveKit SDK
      // owns endpointing decisions internally. We DO NOT pass a numeric
      // endpointing delay anywhere; the adaptive model is the policy.
      // (Lock L7 anti-hardcode; see __tests__/no-min-endpointing.test.ts.)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let session: any
      if (!opts.defineAgent) {
        const { voice, inference } = livekitMod
        const vad = await sileroMod.VAD.load()
        const turnDetection = new voice.MultilingualModel()
        const stt = new deepgramMod.STT({ model: "nova-3" })
        const tts = new deepgramMod.TTS({ model: "aura-2" })
        const llm = new openaiPluginMod.LLM({
          base_url: `${process.env.WEKRUIT_LLM_SHIM_URL}/v1`,
          model: "wekruit-prescreen-v1",
          api_key: "unused-localhost",
        })
        // inference fallback (LK Cloud-managed) — kept inert; we use our
        // shim-routed LLM as canonical.
        void inference
        session = new voice.AgentSession({ vad, turnDetection, stt, llm, tts })
      } else {
        // Test path: callers provide their own session via global hook
        // when overriding defineAgent. The default test-seam doesn't need
        // a real session.
        session = (globalThis as Record<string, unknown>).__voiceAgentTestSession ?? {
          on: () => {},
          off: () => {},
          say: async (_text: string) => {},
          start: async () => {},
        }
      }

      // ── Wire 7 event handlers (L7) ───────────────────────────────────────
      const sinks: RegisterSinks = {
        log,
        async onUserSpeechCommitted({ transcript, lang }) {
          const out = await turnLoop.onUserCommit({
            reply: transcript,
            nowIso: new Date().toISOString(),
            lang: lang === "zh" ? "zh" : "en",
          })
          if (out.speakText.length > 0) {
            await session.say(out.speakText)
          }
        },
        onConversationItemAdded(p) {
          log("voice.conversation_item_added", { role: p.role, len: p.textContent.length })
        },
        onAgentFalseInterruption(p) {
          log("voice.agent_false_interruption", { resumed: p.resumed })
        },
        onParticipantDisconnected(p) {
          log("voice.participant_disconnected", { identity: p.identity ?? "" })
        },
        onError(p) {
          log("voice.error", {
            message: p.message ?? p.error?.message ?? "unknown",
          })
        },
        onSessionUsageUpdated(p) {
          log("voice.session_usage_updated", {
            modelUsageCount: p.modelUsage.length,
          })
        },
        onClose(p) {
          log("voice.close", { reason: p.reason ?? "" })
        },
        shutdown: async () => {
          log("voice.shutdown", { bookingId })
          try {
            await session.aclose?.()
          } catch {
            // best effort
          }
        },
      }

      registerEventHandlers(session, ctx.room as never, sinks)

      // ── Start the session ────────────────────────────────────────────────
      await session.start?.({ agent, room: ctx.room })

      // ── L8 recording consent — first utterance ──────────────────────────
      const consentLine = buildConsentPrompt(callContext)
      await session.say?.(consentLine)
      log("voice.consent_prompt_spoken", { bookingId, lang: callContext.userProfile.preferredLang ?? "en" })
      // S5 — structured TCPA audit log capturing the consent-disclosure
      // moment (paired with the prior-consent verification in
      // voice-tcpa-checks/{bookingId}_<runId>).
      emitConsentSpokenAudit(callContext, consentLine, log)
    },
  })

  // Expose for test introspection.
  ;(globalThis as Record<string, unknown>).__voiceAgent = agent

  log("voice.worker.defined", {})
}

function requireEnv(names: string[]): void {
  const missing = names.filter((n) => !process.env[n])
  if (missing.length > 0) {
    throw new Error(`Missing required env: ${missing.join(", ")}`)
  }
}

function readBookingId(metadata?: string): string {
  if (!metadata) {
    throw new Error("Room metadata missing — S3 must set bookingId on dial")
  }
  try {
    const parsed = JSON.parse(metadata) as { bookingId?: string }
    if (typeof parsed.bookingId === "string" && parsed.bookingId.length > 0) {
      return parsed.bookingId
    }
  } catch {
    // not JSON — fall through
  }
  if (metadata.length > 0) return metadata
  throw new Error("Room metadata does not carry bookingId")
}

/**
 * Default context loader — placeholder that throws until S3 wires the
 * Firestore-backed loader. Tests inject `opts.loadContext` directly. The
 * production path will route through a Cloud-Function callable that fans
 * out to S1B's `loadUserProfileForVoice` / `loadJobBriefForVoice` /
 * `loadPrescreenConfigForVoice` and returns the assembled `VoiceCallContext`.
 */
async function defaultLoadContext(_bookingId: string): Promise<VoiceCallContext> {
  throw new Error(
    "voice-agent: default loadContext not implemented — S3 will wire context-callable; tests must inject opts.loadContext"
  )
}

async function defaultBuildPipeline(): Promise<VoicePipelineLite> {
  throw new Error(
    "voice-agent: default buildPipeline not implemented — S3/S5 will wire PreScreenPipeline via @pa/pa-orchestrator; tests inject opts.buildPipeline"
  )
}
