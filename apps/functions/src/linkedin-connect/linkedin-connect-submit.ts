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
  type VerifyLinkedinConnectTokenResult,
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

/**
 * Injectable seams for the pure submit handler so the orchestration (token →
 * link handle → enrich → emit → sms reroute) can be unit-tested with a mocked
 * CoreSignal + identity layer. The `onRequest` wrapper supplies the real
 * implementations; tests supply fakes. Keeping these as deps (rather than
 * direct imports inside the handler) is what makes the canary gate, the
 * fail-open paths, the runtime-event emit, and the identity-conflict branch
 * assertable without a live Firestore / CoreSignal / secret.
 */
export interface LinkedinConnectSubmitDeps {
  /** Resolve a connect token to its phone-bound userId (+ optional phone). */
  verifyToken: (token: string) => Promise<VerifyLinkedinConnectTokenResult>
  /** Link the LinkedIn handle to the known uid. Throws `identity_conflict:<id>` on A≠B. */
  linkHandle: (userId: string, canonicalUrl: string, nowIso: string) => Promise<void>
  /** Persist the canonical URL onto pa-users when empty / an OAuth marker. */
  persistUrl: (userId: string, canonicalUrl: string, nowIso: string) => Promise<void>
  /** True when this uid is in the new-behavior canary cohort. */
  isCanary: (userId: string) => boolean
  /** Trimmed CoreSignal API key ("" when the secret is absent). */
  coresignalApiKey: () => string
  /** Enrich by canonical URL via CoreSignal + mirror + tag bridge. */
  enrich: (args: {
    userId: string
    canonicalUrl: string
    apiKey: string
    nowIso: string
  }) => Promise<{ enriched: boolean }>
  /** Emit the enrichment-complete runtime event so the thin pitch fires. */
  emitRuntimeEvent: (args: {
    userId: string
    canonicalUrl: string
    enriched: boolean
    nowIso: string
  }) => Promise<void>
  /** WS-1(b): set the durable enrichment-in-flight marker so a mid-enrich inbound holds.
   *  Optional so existing tests don't have to stub it. */
  markEnrichmentInFlight?: (userId: string, nowIso: string) => Promise<void>
  /** Mark the token single-use after a successful submit. */
  markUsed: (token: string, nowIso: string) => Promise<void>
  /** Resolve the candidate phone for the sms: reroute (token phone → pa-users fallback). */
  resolvePhone: (userId: string, tokenPhone?: string) => Promise<string>
  /** Build the iOS sms: deep-link reroute body back into the thread. */
  buildSms: (phone: string, body: string) => string
  /** Clock (ISO). Defaults to wall clock. */
  nowIso?: () => string
}

/**
 * Pure orchestration for the LinkedIn one-tap connect submit. Mirrors the
 * documented CF flow exactly and NEVER throws to the caller (every failure
 * fails open so the candidate is never dead-ended). The `onRequest` wrapper is
 * a thin adapter over this.
 */
export async function handleLinkedinConnectSubmit(
  deps: LinkedinConnectSubmitDeps,
  body: LinkedinConnectSubmitBody,
): Promise<LinkedinConnectSubmitResult> {
  const nowIso = (deps.nowIso ?? (() => new Date().toISOString()))()
  const token = typeof body.token === "string" ? body.token.trim() : ""
  const linkedinUrlRaw = typeof body.linkedinUrl === "string" ? body.linkedinUrl.trim() : ""

  // 1. Resolve the token → the phone-resolved userId (server-trusted identity).
  const tokenResult = await deps.verifyToken(token)
  if (!tokenResult.ok) {
    return { ok: false, reason: tokenResult.reason }
  }
  const userId = tokenResult.userId

  // 2. Canonicalize the submitted URL.
  const canonicalUrl = canonicalizeLinkedInUrl(linkedinUrlRaw)
  if (!canonicalUrl) {
    return { ok: false, reason: "invalid_url" }
  }

  // 3. Link the linkedin handle to the KNOWN uid. A≠B → identity_conflict →
  //    needs_review, NO enrich, NO merge (v2.0 identity rule).
  try {
    await deps.linkHandle(userId, canonicalUrl, nowIso)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (msg.startsWith("identity_conflict:")) {
      logger.warn("linkedin_connect.identity_conflict", {
        userId,
        hash: linkedinHash(canonicalUrl).slice(0, 12),
      })
      return { ok: false, reason: "needs_review" }
    }
    // Any other handle-link failure must NOT dead-end the candidate — log + continue.
    logger.error("linkedin_connect.link_handle_failed", { userId, err: msg })
  }

  // Always persist the URL (covers the no-enrich degrade path).
  await deps.persistUrl(userId, canonicalUrl, nowIso)

  // 4. Enrich + emit ONLY for canary users (new product behavior gate). A
  //    non-canary token submit still links the handle + persists the URL and
  //    reroutes back to SMS — never a dead end, just no enrich/pitch yet.
  let enriched = false
  if (deps.isCanary(userId)) {
    // WS-1(b) ENRICHMENT-AWARENESS (Adam 2026-06-03): CoreSignal enrich runs synchronously here
    // but the candidate's sms: reroute fires AFTER this returns — so a fast candidate could already
    // be back in-thread. SET the durable in-flight marker so a mid-enrich inbound routes through the
    // "still pulling your info, one sec" directive. CLEARED by the resume_parse_completed re-entry
    // this CF emits (cutover clears on that turn). Best-effort; marker self-heals via TTL.
    await deps.markEnrichmentInFlight?.(userId, nowIso)
    const apiKey = deps.coresignalApiKey()
    if (apiKey) {
      try {
        const out = await deps.enrich({ userId, canonicalUrl, apiKey, nowIso })
        enriched = out.enriched
      } catch (err) {
        // CoreSignal down / rate-limited / bad payload → fail-open. Never 500.
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
    try {
      await deps.emitRuntimeEvent({ userId, canonicalUrl, enriched, nowIso })
    } catch (err) {
      logger.warn("linkedin_connect.runtime_event_failed", {
        userId,
        err: err instanceof Error ? err.message : String(err),
      })
    }
  }

  // 6. Mark the token used (single-use) + build the sms: reroute back to thread.
  await deps.markUsed(token, nowIso)

  const phone = await deps.resolvePhone(userId, tokenResult.phoneE164)
  const smsDeepLink = phone ? deps.buildSms(phone, buildLinkedinDoneOpenerBody(token)) : undefined

  return {
    ok: true,
    enriched,
    ...(smsDeepLink ? { smsDeepLink } : {}),
  }
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
    const db = getFirestore()

    const result = await handleLinkedinConnectSubmit(makeProdDeps(db), body)
    res.status(200).json(result satisfies LinkedinConnectSubmitResult)
  },
)

/**
 * Wire the pure handler to the live Firestore / identity / CoreSignal / secret
 * / runtime-event implementations. The emit mirrors the cv-ingest emit exactly
 * (eventKind="resume_parse_completed", cvParsedTrigger:true, source
 * "linkedin_connect", requireExistingSession:false, idempotent on the hash).
 */
function makeProdDeps(db: Firestore): LinkedinConnectSubmitDeps {
  return {
    verifyToken: (token) => verifyLinkedinConnectToken(db, token),
    linkHandle: async (userId, canonicalUrl, nowIso) => {
      await linkCandidateHandle(db, {
        candidateId: userId,
        kind: "linkedin",
        value: canonicalUrl,
        source: "candidate",
        verified: false,
        now: nowIso,
        evidence: [{ source: "system", summary: "Candidate self-submitted LinkedIn URL (one-tap connect)" }],
      })
    },
    persistUrl: (userId, canonicalUrl, nowIso) => persistLinkedinUrlIfEmpty(db, userId, canonicalUrl, nowIso),
    isCanary: (userId) => isCanaryUser(userId),
    coresignalApiKey: () => CORESIGNAL_API_KEY.value().trim(),
    enrich: ({ userId, canonicalUrl, apiKey, nowIso }) =>
      enrichFromCoresignal({ db, userId, canonicalUrl, apiKey, nowIso }),
    emitRuntimeEvent: async ({ userId, canonicalUrl, enriched, nowIso }) => {
      const phone = await resolvePhone(db, userId)
      if (!phone) {
        logger.warn("linkedin_connect.no_phone_for_runtime_event", { userId })
        return
      }
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
    },
    markEnrichmentInFlight: async (userId, nowIso) => {
      const { setEnrichmentInFlight } = await import("../claire-agent/enrichment-inflight.js")
      await setEnrichmentInFlight(db, userId, "linkedin", nowIso)
    },
    markUsed: (token, nowIso) => markLinkedinConnectTokenUsed(db, token, Date.parse(nowIso) || Date.now()),
    resolvePhone: (userId, tokenPhone) => resolvePhone(db, userId, tokenPhone),
    buildSms: (phone, smsBody) => buildSmsDeepLink(phone, smsBody),
  }
}
