/**
 * employer-match-pilot-req.ts — `paEmployerMatchPilotReq` public onCall.
 *
 * Powers Step 7 ("Launch") of the customer-facing employer onboarding wizard
 * (apps/pa-landing/.../EmployerOnboarding.tsx). After a pilot req is persisted
 * at Step 6 sign-off (paEmployerCreatePilotReq dual-writes matching-jobs/{reqId}
 * + pa-jobs/{reqId}), the Launch step calls this to show the employer a REAL,
 * consent-safe pool-match COUNT — "we scanned your retained pool, N look like
 * potential fits" — instead of a vague "we'll match next".
 *
 * It delegates to the SAME pure runner the admin match-debug callable uses
 * (`runAdminJobMatchDebug` in admin-match-debug.ts) which loads the
 * roleFunction-relevant candidate pool (limit 600), runs the collab-aware
 * ranker (skips the ats-url/staleness job-side hard blocks for WeKruit
 * collaborative pilot reqs — important because pilot reqs have atsApplyUrl:null),
 * and slices to the top 50. We then project COUNTS ONLY.
 *
 * CONSENT + PII SAFETY (CLAUDE.md v2.0 Product Rule #6 — "employer dashboard
 * only shows passed candidate profiles"): the runner's `candidates[]` array
 * carries PII (displayName, candidateId, candidateTagSnapshot). NONE of that
 * crosses this public, unauthenticated callable boundary. We aggregate
 * server-side and return integer tallies + one boolean ONLY. No names, emails,
 * ids, tags, transcripts, or per-candidate rows ever leave this function.
 *
 * HONEST SCOPE: the V16 `llmMatch` term (0.40 weight) is sourced from the
 * nightly `pa-user-rerank-cache`, which has no entry for a brand-new pilot req
 * until `paLlmRerankNightly` (04:00 UTC) runs. So these counts are an EARLY /
 * APPROXIMATE fit estimate that refines overnight — surfaced via the
 * `scoringPending` flag (true if any returned candidate's risks include
 * 'llm_score_unavailable'). This callable does NOT contact candidates.
 *
 * AUTH: public — mirrors `paEmployerCreatePilotReq` (cors:true, no auth /
 * app-check gate, no PA_ADMIN_TOKEN). We deliberately do NOT reuse the
 * admin-gated `paAdminJobMatchDebug` callable from the public site. The
 * firebase-admin app is initialized globally in index.ts before import.
 */
import { onCall, HttpsError } from "firebase-functions/v2/https"
import { logger } from "firebase-functions/v2"
import { getFirestore } from "firebase-admin/firestore"
import { runAdminJobMatchDebug } from "./admin-match-debug.js"

// ---- Wire types -------------------------------------------------------------

export type EmployerMatchPilotReqInput = {
  /** The reqId written to matching-jobs/{reqId} by paEmployerCreatePilotReq. */
  reqId: string
}

export type EmployerMatchPilotReqOutput = {
  /** Role-relevant candidates scanned from the retained pool (pool size). */
  roleRelevantLoaded: number
  /** Top-N ranked candidates returned by the scorer (capped at 50). */
  ranked: number
  /** Ranked candidates the matcher would NOT mark do_not_contact (potential fits). */
  potentialFits: number
  /**
   * True when at least one returned candidate is still missing its nightly LLM
   * rerank score (risks includes 'llm_score_unavailable') — counts are an early
   * estimate that refines after paLlmRerankNightly runs.
   */
  scoringPending: boolean
}

export const paEmployerMatchPilotReq = onCall<EmployerMatchPilotReqInput>(
  {
    region: "us-central1",
    cors: true,
    // Bumped to 512MiB (matches paAdminJobMatchDebug) — the runner loads up to
    // 600 candidates and ranks them.
    memory: "512MiB",
    timeoutSeconds: 60,
  },
  async (req): Promise<EmployerMatchPilotReqOutput> => {
    const data = req.data ?? ({} as EmployerMatchPilotReqInput)
    const reqId = (data.reqId ?? "").trim()
    if (!reqId) throw new HttpsError("invalid-argument", "reqId is required")

    const db = getFirestore()

    // Delegate to the shared pure runner. It is Firestore-only (no extra
    // secrets) and throws HttpsError('not-found') when the job is missing.
    const result = await runAdminJobMatchDebug({ jobId: reqId, limit: 50 }, { db })

    // COUNTS-ONLY projection — never touch displayName / candidateId / tags.
    const roleRelevantLoaded = result.candidatePool.totalLoaded
    const ranked = result.candidatePool.totalReturned

    let potentialFits = 0
    let scoringPending = false
    for (const c of result.candidates) {
      if (c.recommendedAction !== "do_not_contact") potentialFits += 1
      if (Array.isArray(c.risks) && c.risks.includes("llm_score_unavailable")) {
        scoringPending = true
      }
    }

    logger.info("paEmployerMatchPilotReq.counts", {
      reqId,
      roleRelevantLoaded,
      ranked,
      potentialFits,
      scoringPending,
    })

    return { roleRelevantLoaded, ranked, potentialFits, scoringPending }
  },
)
