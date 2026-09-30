/**
 * `paAdminCoresignalAgenticSearch` — admin-only callable proxy for
 * Coresignal's /v2/agentic_search/reasoning endpoint.
 *
 * Powers the /admin/coresignal-playground dashboard page. We never expose
 * the CORESIGNAL_API_KEY to the browser; the dashboard calls this CF with
 * an admin claim, the CF forwards the request, and the raw response is
 * returned plus persisted to `coresignal_playground_runs` for audit.
 *
 * Endpoint shape (Coresignal docs lie about two fields, verified against
 * the live API on 2026-05-19):
 *   - `session_id` is REQUIRED and must be a non-empty string. The doc
 *     claims null is allowed; the live API rejects null with 422. We
 *     auto-generate a UUID when caller omits it so the playground does
 *     not have to manage session state for one-shot prompts.
 *   - `entity` is rejected as `extra_forbidden` by the live API even
 *     though the doc lists it. We drop it from the forwarded payload.
 *
 * Auth: mirrors `paAdminMatchDebug` / `paPromoteSandboxTag` — Firebase
 * Auth `admin === true` claim, with `PA_ADMIN_TOKEN` fallback for
 * scripted callers.
 */
import { randomUUID } from "node:crypto"
import { onCall, HttpsError } from "firebase-functions/v2/https"
import { defineSecret } from "firebase-functions/params"
import { logger } from "firebase-functions/v2"
import { getFirestore, type Firestore } from "firebase-admin/firestore"
import { z } from "zod"
import { authorizeAdminCallable } from "./promote-sandbox-tag.js"

const PA_ADMIN_TOKEN = defineSecret("PA_ADMIN_TOKEN")
const CORESIGNAL_API_KEY = defineSecret("CORESIGNAL_API_KEY")

const CORESIGNAL_URL =
  "https://api.coresignal.com/cdapi/v2/agentic_search/reasoning"

const RUNS_COLLECTION = "coresignal_playground_runs"
const MAX_RUNS_KEPT_PER_USER = 50

export const CoresignalAgenticInputSchema = z.object({
  prompt: z.string().min(1).max(4000),
  returnData: z.boolean().default(true),
  allowClarification: z.boolean().default(false),
  sessionId: z.string().min(1).max(128).optional(),
  limit: z.number().int().min(1).max(100).default(10),
  adminToken: z.string().optional(),
})
export type CoresignalAgenticInput = z.infer<typeof CoresignalAgenticInputSchema>

export interface CoresignalAgenticResult {
  ok: true
  sessionId: string
  request: {
    prompt: string
    returnData: boolean
    allowClarification: boolean
    limit: number
  }
  response: unknown
  latencyMs: number
  runId: string
}

/**
 * Reusable core: forward an agentic-search prompt to Coresignal, persist the run
 * for audit, return the raw response. Shared by the admin callable AND the
 * headhunter MCP `search_external_candidates` tool. Caller supplies the resolved
 * apiKey + actor uid; this function does NO auth (the caller gates).
 */
export async function runCoresignalAgenticSearch(
  input: CoresignalAgenticInput,
  deps: { db: Firestore; apiKey: string; actorUid: string },
): Promise<CoresignalAgenticResult> {
  const { db, apiKey, actorUid: uid } = deps
  const sessionId = input.sessionId ?? randomUUID()
  if (!apiKey) {
    throw new HttpsError("failed-precondition", "CORESIGNAL_API_KEY missing")
  }

  {
    const payload = {
      prompt: input.prompt,
      return_data: input.returnData,
      allow_clarification: input.allowClarification,
      session_id: sessionId,
      limit: input.limit,
    }

    const startedAt = Date.now()
    let upstreamRes: Response
    try {
      upstreamRes = await fetch(CORESIGNAL_URL, {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          apikey: apiKey,
        },
        body: JSON.stringify(payload),
      })
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      logger.error("coresignal.fetch_failed", { reason })
      throw new HttpsError("internal", `coresignal_fetch_failed: ${reason}`)
    }
    const latencyMs = Date.now() - startedAt

    const text = await upstreamRes.text()
    let parsedBody: unknown
    try {
      parsedBody = text ? JSON.parse(text) : null
    } catch {
      parsedBody = { raw: text }
    }

    if (!upstreamRes.ok) {
      logger.warn("coresignal.upstream_error", {
        status: upstreamRes.status,
        sessionId,
        body: parsedBody,
      })
      throw new HttpsError(
        upstreamRes.status === 401 || upstreamRes.status === 403
          ? "permission-denied"
          : upstreamRes.status === 422
            ? "invalid-argument"
            : "internal",
        `coresignal_${upstreamRes.status}`,
        { status: upstreamRes.status, body: parsedBody },
      )
    }

    const runRef = db.collection(RUNS_COLLECTION).doc()
    const runDoc = {
      runId: runRef.id,
      actorUid: uid,
      createdAt: new Date().toISOString(),
      sessionId,
      latencyMs,
      request: payload,
      response: parsedBody,
    }
    try {
      await runRef.set(runDoc)
    } catch (err) {
      logger.warn("coresignal.persist_failed", {
        reason: err instanceof Error ? err.message : String(err),
      })
    }

    try {
      const stale = await db
        .collection(RUNS_COLLECTION)
        .where("actorUid", "==", uid)
        .orderBy("createdAt", "desc")
        .offset(MAX_RUNS_KEPT_PER_USER)
        .limit(20)
        .get()
      if (!stale.empty) {
        const batch = db.batch()
        stale.docs.forEach((d) => batch.delete(d.ref))
        await batch.commit()
      }
    } catch {
      /* trimming is best-effort */
    }

    return {
      ok: true,
      sessionId,
      request: {
        prompt: input.prompt,
        returnData: input.returnData,
        allowClarification: input.allowClarification,
        limit: input.limit,
      },
      response: parsedBody,
      latencyMs,
      runId: runRef.id,
    }
  }
}

export const paAdminCoresignalAgenticSearch = onCall<CoresignalAgenticInput>(
  {
    region: "us-central1",
    memory: "512MiB",
    timeoutSeconds: 180,
    secrets: [PA_ADMIN_TOKEN, CORESIGNAL_API_KEY],
  },
  async (req): Promise<CoresignalAgenticResult> => {
    const { uid } = authorizeAdminCallable(
      req as { auth?: { token?: { admin?: unknown } }; data?: unknown },
    )
    const parsed = CoresignalAgenticInputSchema.safeParse(req.data)
    if (!parsed.success) {
      throw new HttpsError("invalid-argument", parsed.error.message)
    }
    return runCoresignalAgenticSearch(parsed.data, {
      db: getFirestore(),
      apiKey: CORESIGNAL_API_KEY.value(),
      actorUid: uid,
    })
  },
)
