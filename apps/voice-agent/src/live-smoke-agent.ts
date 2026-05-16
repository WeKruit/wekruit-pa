/**
 * Minimal live-smoke LiveKit agent.
 *
 * Joins any room that LK Cloud dispatches it to, speaks a fixed greeting
 * via Deepgram Aura-2 TTS, then bridges STT → echo → TTS so anyone in
 * the room can verify audio loop. Purely diagnostic; bypasses the full
 * PreScreenPipeline. Used by P10 to validate v2.1 SIP audio path before
 * wiring the production worker.
 *
 * Run:
 *   node --import tsx apps/voice-agent/src/live-smoke-agent.ts dev
 */
import {
  cli,
  defineAgent,
  voice,
  WorkerOptions,
  type JobContext,
} from "@livekit/agents"
import * as deepgram from "@livekit/agents-plugin-deepgram"
import * as openai from "@livekit/agents-plugin-openai"
import * as silero from "@livekit/agents-plugin-silero"
import { fileURLToPath } from "node:url"

export default defineAgent({
  entry: async (ctx: JobContext) => {
    console.log("[live-smoke-agent] entry", {
      room: ctx.room?.name,
      metadata: ctx.room?.metadata,
    })

    await ctx.connect()

    const vad = await silero.VAD.load()
    const stt = new deepgram.STT({ model: "nova-3" })
    const tts = new deepgram.TTS({ model: "aura-2-thalia-en" })
    const llm = new openai.LLM({
      baseURL: `${process.env.WEKRUIT_LLM_SHIM_URL ?? "http://127.0.0.1:8787"}/v1`,
      model: "wekruit-prescreen-v1",
      apiKey: "unused-localhost",
    })

    const session = new voice.AgentSession({
      vad,
      stt,
      llm,
      tts,
    })

    await session.start({
      agent: new voice.Agent({
        instructions:
          "You are Claire from WeKruit. This is a live SIP smoke test. Say hello, briefly confirm the call audio is working, then ask one question. Keep replies short, friendly, and English.",
      }),
      room: ctx.room,
    })

    await session.say(
      "Hi! This is Claire from WeKruit running a live audio smoke test. Can you hear me clearly?",
    )
  },
})

if (process.argv[1] && /live-smoke-agent\.(t|m?j)s$/.test(process.argv[1])) {
  cli.runApp(
    new WorkerOptions({
      agent: fileURLToPath(import.meta.url),
    }),
  )
}
