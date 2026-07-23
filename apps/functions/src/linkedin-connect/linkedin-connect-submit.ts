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
import { candidateHasLinkedinBind, linkCandidateHandle } from "@pa/pa-persistence"
import {
  canonicalizeLinkedInUrl,
  linkedinHash,
  fetchEmployeeCollect,
  searchEmployeeIdByLinkedinUrl,
  searchEmployeeIdByPhotoAssetId,
  licdnAssetKey,
  CoresignalCollectError,
} from "@pa/external-supply"
import { isCanaryUser } from "../claire-agent/canary.js"
import { buildSmsDeepLink } from "../qr-onboarding/qr-start-redirect.js"
import { assignCandidateSenderNumber } from "../identity/candidate-sender-number.js"
import { enqueueRuntimeEventHandoff } from "../runtime-event-handoff.js"
import { enqueueOutbound } from "@pa/pa-broker"
import {
  runCoresignalExperiencesMirror,
  makeFirestoreMirrorDeps,
} from "../external-supply/coresignal-experiences-mirror.js"
import { dualWriteLegacyUserTagsFromExternal } from "../external-supply/legacy-user-tags-bridge.js"
import { normalizeCoresignalCollectV2 } from "../external-supply/adapters/coresignal-collect-v2.js"
import { getOrFetchCoresignalById } from "../lib/coresignal-cache.js"
import {
  verifyLinkedinConnectToken,
  markLinkedinConnectTokenUsed,
  type VerifyLinkedinConnectTokenResult,
} from "./connect-token.js"

const CORESIGNAL_API_KEY = defineSecret("CORESIGNAL_API_KEY")
// The connect-submit enrich runs the Coresignal experiences mirror → unified LinkedIn+résumé merge LLM
// call (getOpenAIConfig reads PA_OPENAI_AGENT_API_KEY). Bind + hydrate or the merge fail-opens to null.
const PA_OPENAI_AGENT_API_KEY = defineSecret("PA_OPENAI_AGENT_API_KEY")

/** Resolve a candidate's E.164 phone (used as the runtime-event `toE164`, NOT the sms recipient). */
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

/**
 * Resolve the RECIPIENT for the sms: reroute back into the iMessage thread.
 *
 * BUGFIX (Adam 2026-06-03, Image #21): the reroute was `sms:<candidate own phone>` — opening it
 * composed a message TO the candidate's OWN number, never reaching Claire. The recipient MUST be
 * the user's assigned WeKruit Sendblue number (the number Claire texts them FROM), so tapping Send
 * lands the "I've done LinkedIn submission <token>" opener back in the Claire thread. Honors an
 * existing senderNumber; mints a capacity-aware one for a website-origin candidate with none yet.
 */
async function resolveRerouteRecipient(db: Firestore, userId: string): Promise<string> {
  try {
    const snap = await db.collection(PA_COLLECTIONS.users).doc(userId).get()
    const { senderNumber } = await assignCandidateSenderNumber(db, userId, snap.data() ?? null)
    return (senderNumber ?? "").trim()
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
    /** Single-use connect token — the per-connect-flow idempotency key for the pitch handoff. */
    token: string
  }) => Promise<void>
  /** WS-1(b): set the durable enrichment-in-flight marker so a mid-enrich inbound holds.
   *  Optional so existing tests don't have to stub it. */
  markEnrichmentInFlight?: (userId: string, nowIso: string) => Promise<void>
  /** FIRST-TOUCH ACK (Adam 2026-07-22): text an instant "pulling your background 👀" the
   *  moment the submit lands — BEFORE the synchronous CoreSignal enrich — so the connect
   *  never feels like dead air (live test: pitch bubbles landed 10-40s after connect).
   *  Optional + fail-open so existing tests don't have to stub it. */
  sendConnectAck?: (userId: string, token: string, nowIso: string) => Promise<void>
  /** Mark the token single-use after a successful submit. */
  markUsed: (token: string, nowIso: string) => Promise<void>
  /** Resolve the sms: reroute RECIPIENT = the user's WeKruit Sendblue number (NOT their own phone). */
  resolveRerouteRecipient: (userId: string) => Promise<string>
  /** Build the iOS sms: deep-link reroute body back into the thread. */
  buildSms: (recipient: string, body: string) => string
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
    // FIRST-TOUCH ACK — before the synchronous enrich, so the tap gets instant feedback.
    try {
      await deps.sendConnectAck?.(userId, token, nowIso)
    } catch (err) {
      logger.warn("linkedin_connect.ack_failed_fail_open", {
        userId,
        err: err instanceof Error ? err.message : String(err),
      })
    }
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
      await deps.emitRuntimeEvent({ userId, canonicalUrl, enriched, nowIso, token })
    } catch (err) {
      logger.warn("linkedin_connect.runtime_event_failed", {
        userId,
        err: err instanceof Error ? err.message : String(err),
      })
    }
  }

  // 6. Mark the token used (single-use) + build the sms: reroute back to thread.
  await deps.markUsed(token, nowIso)

  const recipient = await deps.resolveRerouteRecipient(userId)
  const smsDeepLink = recipient ? deps.buildSms(recipient, "") : undefined

  return {
    ok: true,
    enriched,
    ...(smsDeepLink ? { smsDeepLink } : {}),
  }
}

/**
 * connectLinkedinProspectViaOAuth — the ONE-TAP "Login with LinkedIn" path (Adam 2026-06-03:
 * "redirect us to a LinkedIn login page directly… route back to user… mobile friendly").
 *
 * Called by paLinkedinCallback (mode="connect_prospect") AFTER LinkedIn OAuth verified the
 * candidate. Unlike the URL-paste submit, OAuth gives us a verified sub/name/email but NOT the
 * profile URL or work history (LinkedIn's "openid profile email" scope) — so this binds the
 * VERIFIED IDENTITY + sets displayName (→ Claire greets by their real name) and reroutes back into
 * the iMessage thread. Work-history depth still comes from the résumé drop OR the paste-URL flow
 * (Coresignal-by-URL) — Adam's chosen split. NEVER throws; always returns a reroute so the
 * candidate is never dead-ended.
 */
export async function connectLinkedinProspectViaOAuth(
  db: Firestore,
  input: {
    connectToken: string
    sub: string
    name?: string
    email?: string
    picture?: string
    /** The OIDC `profile` claim = the member's REAL public URL. When present, the LOGIN enriches work
     *  history via Coresignal (no paste). Absent → identity-only marker (back-compat). */
    profileUrl?: string
  },
): Promise<{ ok: boolean; reason?: string; smsDeepLink?: string; enriched?: boolean }> {
  const nowIso = new Date().toISOString()
  const tokenResult = await verifyLinkedinConnectToken(db, input.connectToken)
  if (!tokenResult.ok) {
    logger.warn("linkedin_oauth.token_invalid", { reason: tokenResult.reason })
    return { ok: false, reason: tokenResult.reason }
  }
  const userId = tokenResult.userId
  const sub = input.sub.trim()

  // ALREADY-BOUND SHORT-CIRCUIT (re-login recognition, Adam 2026-06-04): if this phone ALREADY
  // has a LinkedIn identity bound (durable handle row OR the linkedinOauthLinked flag), this is a
  // RE-login, not a first connect. A fresh enrich + resume_parse_completed handoff here re-fires a
  // FULL pitch (double-pitch the candidate already saw). Instead, keep the bind idempotent (no
  // re-link, no re-enrich, no pitch handoff), mark the token used, and reroute back into the thread
  // with the standard opener so Claire continues naturally ("you're already connected — pulling
  // your matches"). Fail-soft: candidateHasLinkedinBind never throws (read error → false → normal
  // first-connect path), so this can only SUPPRESS a duplicate, never block a genuine first bind.
  if (await candidateHasLinkedinBind(db, userId)) {
    await markLinkedinConnectTokenUsed(db, input.connectToken, Date.parse(nowIso) || Date.now())
    const recipient = await resolveRerouteRecipient(db, userId)
    const smsDeepLink = recipient
      ? buildSmsDeepLink(recipient, "")
      : undefined
    logger.info("linkedin_oauth.already_bound_reroute", { userId, hasSms: Boolean(smsDeepLink) })
    return { ok: true, enriched: false, ...(smsDeepLink ? { smsDeepLink } : {}) }
  }

  // PREFER the REAL profile URL from OIDC (so Coresignal can enrich). Fall back to the
  // "/oauth-linked/<sub>" identity marker only when LinkedIn didn't return the URL.
  const realUrl = canonicalizeLinkedInUrl(input.profileUrl ?? "")
  const handleUrl = realUrl ?? `https://www.linkedin.com/oauth-linked/${sub}`
  try {
    await linkCandidateHandle(db, {
      candidateId: userId,
      kind: "linkedin",
      value: handleUrl,
      source: "candidate",
      verified: true, // OAuth-verified identity
      now: nowIso,
      evidence: [{ source: "system", summary: "LinkedIn OAuth sign-in (one-tap connect)" }],
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    // identity_conflict is rare for an OAuth sub; either way never dead-end — log + still reroute.
    logger.warn("linkedin_oauth.link_handle_noted", { userId, err: msg })
  }
  // Persist the verified identity. displayName drives loadGlobalContext's by-name greeting; the
  // linkedinOauth* fields mirror the existing OAuth-connected shape (CandidatePortal reads them).
  try {
    const patch: Record<string, unknown> = {
      linkedinOauthLinked: true,
      linkedinOauthConnectedAt: nowIso,
      linkedinOauthSub: sub,
      linkedinUrl: handleUrl,
      updatedAt: nowIso,
    }
    const name = input.name?.trim()
    if (name) {
      patch.displayName = name
      patch.linkedinOauthName = name
    }
    if (input.email?.trim()) patch.linkedinOauthEmail = input.email.trim()
    if (input.picture?.trim()) patch.linkedinOauthPicture = input.picture.trim()
    await db.collection(PA_COLLECTIONS.users).doc(userId).set(patch, { merge: true })
  } catch (err) {
    logger.warn("linkedin_oauth.persist_failed", {
      userId,
      err: err instanceof Error ? err.message : String(err),
    })
  }

  // LinkedIn LOGIN → ENRICH (Adam 2026-06-03): with the REAL URL we run the SAME Coresignal pipeline
  // as the paste path — set the linkedin in-flight marker (drives the "pulling your LinkedIn 👀" ack),
  // pull work history, then emit the completion event so the re-entry PITCHES. Its OWN source
  // ("linkedin"), never conflated with résumé parse. Canary-gated; every step fails open (never
  // dead-ends the reroute).
  // LOGIN → ENRICH, PHOTO-FIRST (Adam 2026-06-03): OIDC always returns the profile `picture` but
  // never a URL — the licdn asset id in that photo resolves the candidate on Coresignal's
  // `employee_clean` (no paste, no URL, no partner gate). Falls back to the real URL when present.
  // Fires whenever we have EITHER signal (photo is effectively always there). Canary-gated.
  let enriched = false
  let pitchHandoffEnqueued = false
  const hasEnrichSignal = Boolean(input.picture?.trim() || realUrl)
  if (hasEnrichSignal && isCanaryUser(userId)) {
    try {
      const { setEnrichmentInFlight } = await import("../claire-agent/enrichment-inflight.js")
      await setEnrichmentInFlight(db, userId, "linkedin", nowIso)
    } catch (err) {
      logger.warn("linkedin_oauth.inflight_mark_failed", { userId, err: String(err) })
    }
    const apiKey = CORESIGNAL_API_KEY.value().trim()
    if (apiKey) {
      try {
        const out = await enrichFromCoresignal({
          db,
          userId,
          apiKey,
          nowIso,
          ...(realUrl ? { canonicalUrl: realUrl } : {}),
          ...(input.picture?.trim() ? { picture: input.picture.trim() } : {}),
        })
        enriched = out.enriched
      } catch (err) {
        const status = err instanceof CoresignalCollectError ? err.status : null
        logger.warn("linkedin_oauth.enrich_failed_fail_open", { userId, status, err: String(err) })
      }
    } else {
      logger.info("linkedin_oauth.coresignal_key_absent_degrade", { userId })
    }
    // Emit the enrichment-complete event (mirrors cv-ingest) so the re-entry pitches. enrichmentSource
    // "linkedin" keeps this distinct from a résumé parse for the ack copy + analytics.
    try {
      const toE164 = await resolvePhone(db, userId, tokenResult.phoneE164)
      if (toE164) {
        // PER-CONNECT-FLOW idempotency key (Adam 2026-06-04): key on the SINGLE-USE connectToken, NOT a
        // content hash and NOT nowIso. Why: LinkedIn/the browser double-hits this callback for ONE login
        // (~2s apart, both pass the too-late token-used guard) → keying on nowIso made each callback a
        // DISTINCT runtime-event doc → TWO pitches (live double-pitch). The connectToken is identical for
        // both callbacks of one login → the 2nd dedups (one pitch). A genuine RE-login mints a NEW token →
        // a fresh pitch (re-test works). Content hash (uid+url) would permanently block re-logins; this
        // doesn't.
        const handoff = await enqueueRuntimeEventHandoff(db, {
          userId,
          toE164,
          source: "linkedin_connect",
          eventKind: "resume_parse_completed",
          idempotencyKey: `linkedin-oauth-enriched:${userId}:${input.connectToken}`,
          requireExistingSession: false,
          context: { cvParsedTrigger: true, enrichmentSource: "linkedin", linkedinEnriched: enriched },
        })
        pitchHandoffEnqueued = handoff.ok
      }
    } catch (err) {
      logger.warn("linkedin_oauth.runtime_event_failed", { userId, err: String(err) })
    }
  }

  await markLinkedinConnectTokenUsed(db, input.connectToken, Date.parse(nowIso) || Date.now())
  // Reroute RECIPIENT = the user's WeKruit Sendblue number (NOT their own phone) — see resolveRerouteRecipient.
  // RELY ON OAUTH, NOT THE ECHO (Adam 2026-06-04): when the server-push pitch (resume_parse_completed
  // handoff) was queued, the "I've done LinkedIn submission <token>" SMS echo is redundant AND harmful —
  // it re-enters as a SEPARATE inbound that produces a duplicate "still pulling" ack (and, with the
  // marker stuck, the banned onboarding question). Drop it; the runtime event owns the pitch. Keep the
  // echo ONLY as the fallback when no server-push pitch queued (no enrich signal / non-canary).
  const recipient = pitchHandoffEnqueued ? null : await resolveRerouteRecipient(db, userId)
  const smsDeepLink = recipient
    ? buildSmsDeepLink(recipient, "")
    : undefined
  logger.info("linkedin_oauth.connected", {
    userId,
    hasName: Boolean(input.name),
    hasRealUrl: Boolean(realUrl),
    enriched,
    hasSms: Boolean(smsDeepLink),
  })
  return { ok: true, enriched, ...(smsDeepLink ? { smsDeepLink } : {}) }
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
/**
 * Resolve a candidate's CoreSignal employee id from whatever LinkedIn signal we have, PHOTO-FIRST.
 * "Sign in with LinkedIn" (OIDC) always returns a profile `picture` but never a URL — the licdn
 * asset id in that photo resolves on `employee_clean` (verified live 2026-06-03), giving us the
 * no-paste enrich path. Falls back to the canonical profile URL (paste flow) when no photo match.
 * Returns the id + which signal matched (for audit), or null when the candidate isn't in CoreSignal.
 */
export async function resolveLinkedinEmployeeId(input: {
  apiKey: string
  picture?: string | null
  canonicalUrl?: string | null
}): Promise<{ employeeId: number; via: "photo" | "url" } | null> {
  const { apiKey } = input
  const assetId = licdnAssetKey(input.picture ?? undefined)?.split(":")[0]
  if (assetId) {
    const byPhoto = await searchEmployeeIdByPhotoAssetId(assetId, { apiKey })
    if (byPhoto !== null) return { employeeId: byPhoto, via: "photo" }
  }
  const url = (input.canonicalUrl ?? "").trim()
  if (url) {
    const byUrl = await searchEmployeeIdByLinkedinUrl(url, { apiKey })
    if (byUrl !== null) return { employeeId: byUrl, via: "url" }
  }
  return null
}

/**
 * SHARED LinkedIn → Coresignal enrichment. Resolves the candidate (photo-first, URL-fallback),
 * collects their profile, and mirrors experienceHighlights + canonical tags onto pa-users. Used by
 * EVERY LinkedIn entry point: iMessage onboarding one-tap login, the /me profile connector, and the
 * paste-URL flow. No-throw contract is the caller's (each wraps in try/fail-open).
 */
export async function enrichFromCoresignal(args: {
  db: Firestore
  userId: string
  apiKey: string
  nowIso: string
  /** Resolve by URL (paste) and/or photo (OIDC login) — photo wins. At least one required. */
  canonicalUrl?: string
  picture?: string
}): Promise<{ enriched: boolean }> {
  const { db, userId, apiKey, nowIso } = args
  const resolved = await resolveLinkedinEmployeeId({
    apiKey,
    picture: args.picture,
    canonicalUrl: args.canonicalUrl,
  })
  if (resolved === null) {
    logger.info("linkedin_connect.coresignal_no_match", { userId })
    return { enriched: false }
  }
  const employeeId = resolved.employeeId
  logger.info("linkedin_connect.coresignal_resolved", { userId, employeeId, via: resolved.via })
  // Unified store: skip the collect GET when this employee was fetched before
  // (any path). Cache hit by id; miss → fetch + store keyed by canonical URL.
  const employee = await getOrFetchCoresignalById({
    db,
    id: employeeId,
    apiKey,
    now: nowIso,
    source: "linkedin_connect",
    fetch: fetchEmployeeCollect,
    link: args.canonicalUrl,
    log: (event, fields) => logger.info(`linkedin_connect.${event}`, { userId, ...(fields ?? {}) }),
  })
  if (!employee) {
    logger.info("linkedin_connect.coresignal_collect_unavailable", { userId, employeeId })
    return { enriched: false }
  }
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
    secrets: [CORESIGNAL_API_KEY, PA_OPENAI_AGENT_API_KEY],
  },
  async (req, res): Promise<void> => {
    setCors(res)
    if (req.method === "OPTIONS") {
      res.status(204).send("")
      return
    }
    // Hydrate the OpenAI key so the downstream Coresignal-mirror merge (getOpenAIConfig) can run.
    const openAiKey = PA_OPENAI_AGENT_API_KEY.value().trim()
    if (openAiKey) process.env.PA_OPENAI_AGENT_API_KEY = openAiKey
    else delete process.env.PA_OPENAI_AGENT_API_KEY
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
    sendConnectAck: async (userId, token, nowIso) => {
      const phone = await resolvePhone(db, userId)
      if (!phone) return
      // paced:true → outbox posts immediately (no length dwell); idempotency on the
      // single-use connect token → exactly one ack per connect flow, retries dedup.
      await enqueueOutbound(db, {
        userId,
        toE164: phone,
        body: "linkedin's in ✅ pulling your background now — give me a sec",
        paced: true,
        idempotencyKey: `linkedin-connect-ack:${userId}:${token}`,
        runtimeApproved: true,
        runtimeSource: "pa_orchestrator",
      })
      logger.info("linkedin_connect.ack_sent", { userId, at: nowIso })
    },
    coresignalApiKey: () => CORESIGNAL_API_KEY.value().trim(),
    enrich: ({ userId, canonicalUrl, apiKey, nowIso }) =>
      enrichFromCoresignal({ db, userId, canonicalUrl, apiKey, nowIso }),
    emitRuntimeEvent: async ({ userId, enriched, token }) => {
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
        // PER-CONNECT-FLOW key (Adam 2026-06-04): see the OAuth path — key on the single-use connectToken
        // so a double-callback of ONE submit dedups to one pitch, while a genuine re-submit pitches fresh.
        idempotencyKey: `linkedin-enriched:${userId}:${token}`,
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
    resolveRerouteRecipient: (userId) => resolveRerouteRecipient(db, userId),
    buildSms: (recipient, smsBody) => buildSmsDeepLink(recipient, smsBody),
  }
}
