/**
 * employer-ats-import-reqs.ts — `paEmployerAtsImportReqs` public onCall.
 *
 * Makes the employer "Connect ATS" step's promise ("read back your open reqs")
 * literally true for PUBLIC ATS job boards.
 *
 * HONEST SCOPE: this is a READ-ONLY public-board fetch. It parses a pasted
 * board URL (or a bare "provider:org"/org handle), detects the provider +
 * org/token, GETs that provider's PUBLIC job-board API (no auth, no OAuth, no
 * API key, no secrets), normalizes the open reqs, and returns them in-memory.
 *
 * It is NOT the managed Kombo/Ashby ATS connect (that's
 * paEmployerConnectRequest) — it does not sync private candidates, perform
 * OAuth, or contact anyone. It is the "pull open reqs from your public board
 * URL" self-serve fast-path that sits ABOVE the managed-setup request form.
 *
 * The only write it makes is a lightweight audit-trail doc in
 * `pa-employer-connect-requests` (status:"reqs_pulled") so ops can see who
 * previewed which board — no candidate data, no PII.
 *
 * AUTH: public — mirrors `paEmployerConnectRequest` (cors:true, no auth/
 * app-check gate), MINUS all email/secrets machinery (a public board fetch
 * needs no secrets). The firebase-admin app is initialized globally in
 * index.ts before this module is imported.
 */
import { onCall, HttpsError } from "firebase-functions/v2/https"
import { logger } from "firebase-functions/v2"
import { getFirestore, FieldValue } from "firebase-admin/firestore"
import {
  detectAtsBoard,
  fetchPublicBoardReqs,
  type AtsBoardProvider,
  type AtsOpenReq,
} from "./ats/public-board-client.js"

// ---- Wire types -------------------------------------------------------------

export type { AtsBoardProvider, AtsOpenReq } from "./ats/public-board-client.js"

export type AtsImportReqsInput = {
  /** Pasted public board URL, or a bare "provider:org" / org handle. */
  board: string
}

export type AtsImportReqsOutput = {
  ok: boolean
  provider?: AtsBoardProvider
  org?: string
  count?: number
  /** Capped to first 50 for display. */
  reqs?: AtsOpenReq[]
  error?: string
}

// ---- Callable ---------------------------------------------------------------

const DISPLAY_CAP = 50

export const paEmployerAtsImportReqs = onCall<AtsImportReqsInput>(
  {
    region: "us-central1",
    cors: true,
    memory: "512MiB",
    timeoutSeconds: 60,
  },
  async (req): Promise<AtsImportReqsOutput> => {
    const data = req.data ?? ({} as AtsImportReqsInput)
    const board = (typeof data.board === "string" ? data.board : "").trim().slice(0, 2000)
    if (!board) {
      throw new HttpsError("invalid-argument", "board must be a non-empty board URL or org handle")
    }

    const detected = detectAtsBoard(board)
    if (!detected) {
      logger.info("paEmployerAtsImportReqs.unrecognized", { boardLen: board.length })
      return { ok: false, error: "unrecognized_board" }
    }

    const { provider, org } = detected

    logger.info("paEmployerAtsImportReqs.start", { provider, org })

    const result = await fetchPublicBoardReqs({ provider, org })

    // Audit-trail doc (best-effort — never blocks the read-back).
    try {
      const db = getFirestore()
      await db.collection("pa-employer-connect-requests").add({
        kind: "ats",
        provider,
        org,
        status: "reqs_pulled",
        reqCount: result.ok ? result.count : 0,
        fetchOk: result.ok,
        fetchError: result.ok ? null : result.error,
        source: "employer_onboarding_public_board",
        requestedAt: FieldValue.serverTimestamp(),
        requestedAtIso: new Date().toISOString(),
      })
    } catch (err) {
      logger.warn("paEmployerAtsImportReqs.audit_write_failed", {
        provider,
        org,
        err: err instanceof Error ? err.message : String(err),
      })
    }

    if (!result.ok) {
      logger.warn("paEmployerAtsImportReqs.fetch_failed", {
        provider,
        org,
        error: result.error,
      })
      return { ok: false, provider, org, error: result.error }
    }

    logger.info("paEmployerAtsImportReqs.done", {
      provider,
      org,
      count: result.count,
    })

    return {
      ok: true,
      provider,
      org,
      count: result.count,
      reqs: result.reqs.slice(0, DISPLAY_CAP),
    }
  },
)
