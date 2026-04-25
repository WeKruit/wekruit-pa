/**
 * Cloud Functions Gen 2 wrapper for the PA orchestrator.
 *
 * Topology (Sprint-1 prod):
 *   Mac iMessage worker -> Firestore `pa_inbound_events`
 *   onPaInbound (this file) -> processInboundEvent (`@pa/pa-orchestrator`)
 *     -> SiliconFlow LLM + Qdrant via `@pa/memory` mem0 OSS wrapper
 *     -> Firestore `pa_messages` + `pa_outbound`
 *   Mac iMessage worker -> sends from `pa_outbound`
 *
 * The function is idempotent: pa-orchestrator skips events already in a non-
 * `pending` status, and message writes are guarded by `idempotencyKey`.
 */
import { onDocumentCreated } from "firebase-functions/v2/firestore"
import { defineSecret } from "firebase-functions/params"
import { setGlobalOptions, logger } from "firebase-functions/v2"
import { initializeApp, getApps } from "firebase-admin/app"
import { getFirestore } from "firebase-admin/firestore"
import {
  processInboundEvent,
  createFirestoreOrchestratorStore,
} from "@pa/pa-orchestrator"
import type { InboundEvent } from "@pa/core-types"

if (!getApps().length) initializeApp()

setGlobalOptions({ region: "us-central1" })

const SILICONFLOW_API_KEY = defineSecret("SILICONFLOW_API_KEY")
const QDRANT_URL = defineSecret("QDRANT_URL")
const QDRANT_API_KEY = defineSecret("QDRANT_API_KEY")

export const onPaInbound = onDocumentCreated(
  {
    document: "pa_inbound_events/{eventId}",
    region: "us-central1",
    secrets: [SILICONFLOW_API_KEY, QDRANT_URL, QDRANT_API_KEY],
    memory: "1GiB",
    timeoutSeconds: 300,
    concurrency: 1,
  },
  async (event) => {
    const snap = event.data
    if (!snap) {
      logger.warn("onPaInbound fired without snapshot", { eventId: event.params.eventId })
      return
    }
    const data = snap.data() as InboundEvent | undefined
    if (!data) {
      logger.warn("onPaInbound fired without data", { eventId: event.params.eventId })
      return
    }
    if (data.status && data.status !== "pending") {
      logger.info("onPaInbound skipping non-pending event", {
        eventId: data.id,
        status: data.status,
      })
      return
    }

    // Re-export secret values into the env so that `@pa/memory` and
    // `@pa/agent-runtime` (which read process.env) pick them up. Cloud
    // Functions Gen 2 maps secrets into env automatically when listed in
    // `secrets`, but we also expose under MEM0_LLM_API_KEY for the OSS path.
    process.env.SILICONFLOW_API_KEY = SILICONFLOW_API_KEY.value()
    process.env.QDRANT_URL = QDRANT_URL.value()
    process.env.QDRANT_API_KEY = QDRANT_API_KEY.value()
    if (!process.env.OPENAI_API_KEY) {
      // agent-runtime's OpenAI-compatible client points at SiliconFlow.
      process.env.OPENAI_API_KEY = SILICONFLOW_API_KEY.value()
    }
    const siliconflowBase = "https://api.siliconflow.cn/v1"
    const trimOr = (v: string | undefined, fallback: string) => {
      const t = v?.trim()
      return t && t.length > 0 ? t.replace(/\/+$/, "") : fallback
    }
    process.env.OPENAI_BASE_URL = trimOr(process.env.OPENAI_BASE_URL, siliconflowBase)
    // mem0ai embedder merge does not fall back to a remote baseURL when unset — empty strings route to OpenAI.com with bge-m3 → 400 invalid model.
    process.env.MEM0_LLM_BASE_URL = trimOr(process.env.MEM0_LLM_BASE_URL, process.env.OPENAI_BASE_URL)
    process.env.MEM0_LLM_MODEL = trimOr(process.env.MEM0_LLM_MODEL, "Qwen/Qwen2.5-72B-Instruct")
    process.env.MEM0_EMBED_MODEL = trimOr(process.env.MEM0_EMBED_MODEL, "BAAI/bge-m3")
    process.env.MEM0_EMBED_DIMS = trimOr(process.env.MEM0_EMBED_DIMS, "1024")

    const db = getFirestore()
    const store = createFirestoreOrchestratorStore(db)
    try {
      await processInboundEvent(data, store)
      logger.info("onPaInbound processed", { eventId: data.id, userId: data.userId })
    } catch (err) {
      logger.error("onPaInbound failed", {
        eventId: data.id,
        userId: data.userId,
        err: err instanceof Error ? err.message : String(err),
      })
      throw err
    }
  },
)
