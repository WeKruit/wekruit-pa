/**
 * linkedin-connect-submit.ts — candidate-facing LinkedIn one-tap connect CF.
 *
 * Flow (Adam spec 2026-06-03):
 *   1. Claire (thin) texts the candidate a connect link
 *      `https://candidate.wekruit.com/connect-linkedin?token=<t>`.
 *   2. The candidate confirms/submits their LinkedIn profile URL on that page.
 *   3. THIS CF (paLinkedinConnectSubmit, POST):
 *        a. verifyLinkedinConnectToken(token) → the phone-resolved userId.
 *        b. canonicalizeLinkedInUrl + linkedinHash; linkCandidateHandle to that
 *           userId (A≠B → identity_conflict → needs_review, NO enrich).
 *        c. ENRICH by URL: CoreSignal search(URL)→id→collect→normalize record→
 *           runCoresignalExperiencesMirror (writes pa-users.experienceHighlights[]
 *           — the field the thin pitch is starved of) +
 *           dualWriteLegacyUserTagsFromExternal (canonical tags, no regex).
 *        d. EMIT enqueueRuntimeEventHandoff(eventKind="resume_parse_completed",
 *           source="linkedin_connect", cvParsedTrigger:true) so the SAME thin
 *           pitch carve-out fires. requireExistingSession:false because the
 *           candidate has not yet re-entered the thread (the sms: reroute happens
 *           after this returns); the event is idempotent on its doc id.
 *        e. markLinkedinConnectTokenUsed; return { ok, smsDeepLink } so the page
 *           reroutes back into the iMessage thread.
 *
 * Graceful degrade (NEVER 500 the candidate):
 *   - CORESIGNAL_API_KEY absent / URL→id finds nothing → still link the handle +
 *     persist linkedinUrl + emit the event with whatever data exists.
 *   - identity_conflict → return { ok:false, reason:"needs_review" } 200, no enrich.
 *
 * Canary: NEW product behavior is gated to isCanaryUser (the 2 dev phones).
 * A non-canary token submit links the handle but skips enrich/emit (no-op pitch)
 * — the page still reroutes so the candidate is never dead-ended.
 *
 * PR-FIRST: new public surface — committed to claude/linkedin-onetap, NOT deployed.
 */
import { onRequest } from "firebase-functions/v2/https"
import { defineSecret } from "firebase-functions/params"
import { getFirestore, type Firestore } from "firebase-admin/firestore"
import { randomUUID } from "node:crypto"
import { logger } from "firebase-functions/v2"
import { PA_COLLECTIONS, type ExternalCandidateRecord } from "@pa/core-types"
import { linkCandidateHandle } from "@pa/pa-persistence"
import {
  canonicalizeLinkedInUrl,
  linkedinHash,
  fetchEmployeeCollect,
  searchEmployeeIdByLinkedinUrl,
  CoresignalCollectError,
} from "@pa/external-supply"
import { buildLinkedinDoneOpenerBody } from "@pa/pa-orchestrator"
import { isCanaryUser } from "../claire-agent/canary.js"
import { buildSmsDeepLink } from "../qr-onboarding/qr-start-redirect.js"
import { enqueueRuntimeEventHandoff } from "../runtime-event-handoff.js"
import {
  runCoresignalExperiencesMirror,
  makeFirestoreMirrorDeps,
} from "../external-supply/coresignal-experiences-mirror.js"
import { dualWriteLegacyUserTagsFromExternal } from "../external-supply/legacy-user-tags-bridge.js"
import { normalizeCoresignalCollectV2 } from "../external-supply/adapters/coresignal-collect-v2.js"
import {
  verifyLinkedinConnectToken,
  markLinkedinConnectTokenUsed,
} from "./connect-token.js"

const CORESIGNAL_API_KEY = defineSecret("CORESIGNAL_API_KEY")

/** Resolve a candidate's E.164 phone for the sms: reroute (pa-users fallback). */
async function resolvePhone(db: Firestore, userId: string, tokenPhone?: string): Promise<string> {
  if (tokenPhone && tokenPhone.trim()) return tokenPhone.trim()
  try {
    const snap = await db.collection(PA_COLLECTIONS.users).doc(userId).get()
    const data = (snap.data() ?? {}) as { phoneE164?: string; phone?: string }
    const raw = data.phoneE164 ?? data.phone ?? ""
    return typeof raw === "string" ? raw.trim() : ""
  } catch {
    return ""
  }
}

export interface LinkedinConnectSubmitBody {
  token?: string
  linkedinUrl?: string
}

export interface LinkedinConnectSubmitResult {
  ok: boolean
  reason?:
    | "missing_token"
    | "unknown_token"
    | "token_expired"
    | "token_used"
    | "invalid_url"
    | "needs_review"
  enriched?: boolean
  smsDeepLink?: string
}

function setCors(res: { set: (k: string, v: string) => unknown }): void {
  res.set("Access-Control-Allow-Origin", "*")
  res.set("Access-Control-Allow-Methods", "POST, OPTIONS")
  res.set("Access-Control-Allow-Headers", "Content-Type")
  res.set("Cache-Control", "no-store")
}

/**
 * Build a one-record `ExternalCandidateRecord` from a CoreSignal collect
 * response and run the SAME mirror + tag-bridge the operator batch path uses —
 * pinned to the KNOWN uid (no auto-create, no admin gate). Returns whether
 * experienceHighlights were written.
 */
async function enrichFromCoresignal(args: {
  db: Firestore
  userId: string
  canonicalUrl: string
  apiKey: string
  nowIso: string
}): Promise<{ enriched: boolean }> {
  const { db, userId, canonicalUrl, apiKey, nowIso } = args
  const employeeId = await searchEmployeeIdByLinkedinUrl(canonicalUrl, { apiKey })
  if (employeeId === null) {
    logger.info("linkedin_connect.coresignal_no_match", { userId })
    return { enriched: false }
  }
  const employee = await fetchEmployeeCollect(employeeId, { apiKey })
  const draft = normalizeCoresignalCollectV2(employee)
  const record: ExternalCandidateRecord = {
    ...draft,
    recordId: `linkedin-connect:${userId}:${employeeId}`,
    batchId: `linkedin-connect:${randomUUID()}`,
    createdAt: nowIso,
    // Pin to the known candidate; the mirror writes onto this uid directly (no
    // auto-create / admin-batch path). The handle is already linked above, so
    // this record is a "merge into the existing candidate" by construction.
    identityResolutionStatus: "merge_existing",
    resolvedUserId: userId,
  }

  // 1. experienceHighlights[] + parsedCandidateResumes + linkedinUrl (pitch data).
  const mirror = await runCoresignalExperiencesMirror(record, userId, {
    ...makeFirestoreMirrorDeps(db),
    now: () => nowIso,
    log: (e, p) => logger.info(`linkedin_connect.mirror.${e}`, p),
  })

  // 2. canonical tags (weak-fill via applyPartialUserTags — no regex, validated).
  try {
    await dualWriteLegacyUserTagsFromExternal(db, userId, record, {
      nowIso,
      log: (e, p) => logger.info(`linkedin_connect.tags.${e}`, p),
    })
  } catch (err) {
    logger.warn("linkedin_connect.tags_dual_write_failed", {
      userId,
      err: err instanceof Error ? err.message : String(err),
    })
  }

  const enriched = mirror.status === "mirrored" || mirror.status === "refreshed_existing"
  logger.info("linkedin_connect.enrich_done", { userId, mirrorStatus: mirror.status, enriched })
  return { enriched }
}

/**
 * Persist the canonical LinkedIn URL onto pa-users when the field is empty /
 * an OAuth marker — so even the no-enrich degrade path records the handle URL.
 */
async function persistLinkedinUrlIfEmpty(
  db: Firestore,
  userId: string,
  canonicalUrl: string,
  nowIso: string,
): Promise<void> {
  try {
    const ref = db.collection(PA_COLLECTIONS.users).doc(userId)
    const snap = await ref.get()
    const existing = (snap.data() ?? {}) as { linkedinUrl?: unknown }
    const cur = typeof existing.linkedinUrl === "string" ? existing.linkedinUrl.trim() : ""
    const isOauthMarker = cur.includes("/oauth-linked/")
    if (!cur || isOauthMarker) {
      await ref.set({ linkedinUrl: canonicalUrl, updatedAt: nowIso }, { merge: true })
    }
  } catch (err) {
    logger.warn("linkedin_connect.persist_url_failed", {
      userId,
      err: err instanceof Error ? err.message : String(err),
    })
  }
}

export const paLinkedinConnectSubmit = onRequest(
  {
    region: "us-central1",
    memory: "512MiB",
    timeoutSeconds: 120,
    cors: false,
    invoker: "public",
    secrets: [CORESIGNAL_API_KEY],
  },
  async (req, res): Promise<void> => {
    setCors(res)
    if (req.method === "OPTIONS") {
      res.status(204).send("")
      return
    }
    if (req.method !== "POST") {
      res.status(405).json({ ok: false, reason: "method_not_allowed" })
      return
    }

    const body = (req.body ?? {}) as LinkedinConnectSubmitBody
    const token = typeof body.token === "string" ? body.token.trim() : ""
    const linkedinUrlRaw = typeof body.linkedinUrl === "string" ? body.linkedinUrl.trim() : ""

    const db = getFirestore()
    const nowIso = new Date().toISOString()

    // 1. Resolve the token → the phone-resolved userId (server-trusted identity).
    const tokenResult = await verifyLinkedinConnectToken(db, token)
    if (!tokenResult.ok) {
      res.status(200).json({ ok: false, reason: tokenResult.reason } satisfies LinkedinConnectSubmitResult)
      return
    }
    const userId = tokenResult.userId

    // 2. Canonicalize the submitted URL.
    const canonicalUrl = canonicalizeLinkedInUrl(linkedinUrlRaw)
    if (!canonicalUrl) {
      res.status(200).json({ ok: false, reason: "invalid_url" } satisfies LinkedinConnectSubmitResult)
      return
    }

    // 3. Link the linkedin handle to the KNOWN uid. linkCandidateHandle throws
    //    `identity_conflict:<id>` (and writes the conflict doc) when the same
    //    LinkedIn hash already maps to a DIFFERENT candidate → needs_review,
    //    NO enrich, NO merge (v2.0 identity rule).
    try {
      await linkCandidateHandle(db, {
        candidateId: userId,
        kind: "linkedin",
        value: canonicalUrl,
        source: "candidate",
        verified: false,
        now: nowIso,
        evidence: [{ source: "system", summary: "Candidate self-submitted LinkedIn URL (one-tap connect)" }],
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (msg.startsWith("identity_conflict:")) {
        logger.warn("linkedin_connect.identity_conflict", { userId, hash: linkedinHash(canonicalUrl).slice(0, 12) })
        res.status(200).json({ ok: false, reason: "needs_review" } satisfies LinkedinConnectSubmitResult)
        return
      }
      // Any other handle-link failure must NOT dead-end the candidate — log + continue.
      logger.error("linkedin_connect.link_handle_failed", { userId, err: msg })
    }

    // Always persist the URL (covers the no-enrich degrade path).
    await persistLinkedinUrlIfEmpty(db, userId, canonicalUrl, nowIso)

    // 4. Enrich + emit ONLY for canary users (new product behavior gate). A
    //    non-canary token submit still links the handle + persists the URL and
    //    reroutes back to SMS — never a dead end, just no enrich/pitch yet.
    let enriched = false
    if (isCanaryUser(userId)) {
      const apiKey = CORESIGNAL_API_KEY.value().trim()
      if (apiKey) {
        try {
          const out = await enrichFromCoresignal({ db, userId, canonicalUrl, apiKey, nowIso })
          enriched = out.enriched
        } catch (err) {
          // CoreSignal down / rate-limited / bad payload → fail-open (handle is
          // linked, URL persisted, event still fires below). Never 500.
          const status = err instanceof CoresignalCollectError ? err.status : null
          logger.warn("linkedin_connect.enrich_failed_fail_open", {
            userId,
            status,
            err: err instanceof Error ? err.message : String(err),
          })
        }
      } else {
        logger.info("linkedin_connect.coresignal_key_absent_degrade", { userId })
      }

      // 5. Emit the enrichment-complete runtime event so the thin pitch fires.
      //    SAME eventKind + cvParsedTrigger the cv-ingest path uses (mirror of
      //    cv-ingest.ts emit). requireExistingSession:false — the candidate has
      //    not yet sent the SMS reroute, so no session exists; the event creates
      //    one and is idempotent on its doc id.
      try {
        const phone = await resolvePhone(db, userId, tokenResult.phoneE164)
        if (phone) {
          const runtime = await enqueueRuntimeEventHandoff(db, {
            userId,
            toE164: phone,
            source: "linkedin_connect",
            eventKind: "resume_parse_completed",
            idempotencyKey: `linkedin-enriched:${userId}:${linkedinHash(canonicalUrl)}`,
            requireExistingSession: false,
            context: {
              cvParsedTrigger: true,
              enrichmentSource: "linkedin",
              linkedinEnriched: enriched,
            },
          })
          logger.info("linkedin_connect.runtime_event", { userId, runtime })
        } else {
          logger.warn("linkedin_connect.no_phone_for_runtime_event", { userId })
        }
      } catch (err) {
        logger.warn("linkedin_connect.runtime_event_failed", {
          userId,
          err: err instanceof Error ? err.message : String(err),
        })
      }
    }

    // 6. Mark the token used (single-use) + build the sms: reroute back to thread.
    await markLinkedinConnectTokenUsed(db, token, Date.parse(nowIso) || Date.now())

    const phone = await resolvePhone(db, userId, tokenResult.phoneE164)
    const smsDeepLink = phone
      ? buildSmsDeepLink(phone, buildLinkedinDoneOpenerBody(token))
      : undefined

    res.status(200).json({
      ok: true,
      enriched,
      ...(smsDeepLink ? { smsDeepLink } : {}),
    } satisfies LinkedinConnectSubmitResult)
  },
)
