/**
 * send-rec-card.ts — wire the rec-card CACHED-IMAGE model to the durable
 * outbound send path.
 *
 * ARCHITECTURE (Adam 2026-05-31): the card IMAGE is pre-generated + CACHED per
 * job on `matching-jobs/{jobId}.recCardMediaUrl` (a permanent, non-signed,
 * `.png`-terminated Sendblue CDN URL). At send time we just READ that URL — no
 * render/upload in the happy path. If the cache is missing we LAZY-GENERATE once
 * (fail-open) and persist it for next time.
 *
 * We then enqueue ONE runtime-approved `pa-outbound` row carrying `mediaUrl` +
 * the per-candidate text caption (Claire's voice). The paSendblueOutbox CF
 * consumes it and POSTs Sendblue with the image attachment.
 *
 * FAIL-OPEN by contract: returns `{ sent: false }` on any failure (flag off,
 * no phone, no cached card + lazy-gen miss, enqueue error) so the caller's
 * existing TEXT recommendation is unaffected. Never throws.
 *
 * Idempotency: the media row key is `rec-card-<userId>-<jobId>-<ymd>` so a
 * retry of the same rec on the same day dedupes to one attachment.
 */

import type { Firestore } from "firebase-admin/firestore"
import { enqueueOutbound } from "@pa/pa-broker"
import {
  isJobRecCardEnabled,
  buildRecCardCaption,
  generateRecCardForJob,
  type GenerateRecCardResult,
} from "./job-rec-card.js"
import { buildRecCardPayload, type CardCompanySource, type CardJobSource, type CardReasonSource } from "./card-payload.js"
import { isSendblueAcceptableMediaUrl, type SendblueMediaCreds } from "./upload-card.js"

/** The matching-jobs field carrying the cached Sendblue media URL. */
export const REC_CARD_MEDIA_URL_FIELD = "recCardMediaUrl"
export const REC_CARD_CONTENT_HASH_FIELD = "recCardContentHash"

export type SendRecCardDeps = {
  db: Firestore
  /** Resolve the candidate's E.164 — production wires getUser from @pa/pa-persistence. */
  getPhoneE164: (db: Firestore, userId: string) => Promise<string | null>
  /** Sendblue media-upload creds for the lazy-gen fallback. Absent → no lazy gen. */
  sendblueCreds?: SendblueMediaCreds
  /** Seam: read the cached media URL for a job. Defaults to a matching-jobs point-read. */
  loadCachedMediaUrl?: (db: Firestore, jobId: string) => Promise<string | null>
  /** Seam: HEAD-check a cached media URL is still alive (non-200 → regenerate). Defaults to a real HEAD. */
  checkMediaUrlLive?: (url: string) => Promise<boolean>
  /** Seam: lazy-generate + persist a card. Defaults to generateRecCardForJob + write-back. */
  lazyGenerate?: (input: {
    db: Firestore
    jobId: string
    job: CardJobSource
    creds: SendblueMediaCreds
    log: (event: string, payload?: Record<string, unknown>) => void
  }) => Promise<string | null>
  /** Seam: load the company doc for caption/lazy-gen. Defaults to a pa-companies read. */
  loadCompany?: (db: Firestore, job: CardJobSource, jobId: string) => Promise<CardCompanySource | null>
  /** Optional explicit Sendblue sender line for thread continuity. */
  fromNumber?: string
  log?: (event: string, payload?: Record<string, unknown>) => void
  env?: NodeJS.ProcessEnv
  /** Override the YYYYMMDD stamp used in the idempotency key (tests). */
  todayYmd?: () => string
}

function defaultYmd(): string {
  const d = new Date()
  return (
    d.getUTCFullYear().toString().padStart(4, "0") +
    (d.getUTCMonth() + 1).toString().padStart(2, "0") +
    d.getUTCDate().toString().padStart(2, "0")
  )
}

export type SendRecCardResult = {
  sent: boolean
  reason?: string
  mediaUrl?: string
  outboundId?: string
}

/**
 * Default cached-media-URL reader — point-read `matching-jobs/{jobId}`. Best-
 * effort: any miss/error returns null (caller lazy-generates or sends nothing).
 */
async function defaultLoadCachedMediaUrl(db: Firestore, jobId: string): Promise<string | null> {
  try {
    const snap = await db.collection("matching-jobs").doc(jobId).get()
    if (!snap.exists) return null
    const v = (snap.data() as Record<string, unknown> | undefined)?.[REC_CARD_MEDIA_URL_FIELD]
    return typeof v === "string" && v.trim() ? v.trim() : null
  } catch {
    return null
  }
}

/**
 * Liveness HEAD-check for a cached media URL. Sendblue fetches the media_url at delivery time; if it
 * 404s (a CDN object that expired) it silently DROPS the image and still reports DELIVERED — the
 * "delivered but no picture" bug (Adam 2026-05-31). A non-200 here treats the cache as STALE so the
 * caller re-generates a fresh Sendblue-CDN url. Fail-CLOSED on network error (treat as not-live →
 * regenerate) is wrong (regen storms on transient blips) so we fail-OPEN: an errored HEAD returns
 * `true` (send the cached url anyway). 3s timeout so a slow HEAD can't stall the send.
 */
async function defaultCheckMediaUrlLive(url: string): Promise<boolean> {
  try {
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), 3000)
    try {
      const r = await fetch(url, { method: "HEAD", signal: ctrl.signal })
      return r.status === 200
    } finally {
      clearTimeout(t)
    }
  } catch {
    return true // fail-open: network/HEAD error → don't force a regen
  }
}

/**
 * Default company loader for caption + lazy-gen (pa-companies/{normName}).
 */
async function defaultLoadCompany(
  db: Firestore,
  job: CardJobSource,
): Promise<CardCompanySource | null> {
  const companyName = (job.companyName ?? "").trim()
  if (!companyName) return null
  try {
    const { normalizeCompanyName } = await import("@pa/core-types")
    const key = normalizeCompanyName(companyName)
    if (!key) return null
    const snap = await db.collection("pa-companies").doc(key).get()
    if (snap.exists) return (snap.data() as CardCompanySource) ?? null
  } catch {
    /* job-only */
  }
  return null
}

/**
 * Persist a freshly-generated rec-card media URL back to matching-jobs/{jobId} so the NEXT resolve is a
 * pure cache read (no render/upload). This is the writeback that was reported as "not persisting" (every
 * send re-lazy-generated). Exported + isolated so the round-trip is directly unit-testable.
 *
 * Closes the round-trip deliberately: it writes the EXACT field the cache READ uses
 * (REC_CARD_MEDIA_URL_FIELD), to the SAME matching-jobs/{jobId} doc `defaultLoadCachedMediaUrl` reads,
 * with `merge:true` so it never clobbers the rest of the job doc. AWAITED + an explicit success event so
 * a prod miss is diagnosable (a failure was previously only logged on throw, hiding a silent
 * "wrote-but-didn't-stick"). Best-effort: a write failure is swallowed (the image THIS turn is
 * unaffected; only the next-turn cache benefit is lost).
 */
export async function persistRecCardMediaUrl(
  db: Firestore,
  jobId: string,
  gen: { mediaUrl: string; contentHash: string },
  log: (event: string, payload?: Record<string, unknown>) => void = () => {},
): Promise<boolean> {
  try {
    await db
      .collection("matching-jobs")
      .doc(jobId)
      .set(
        {
          [REC_CARD_MEDIA_URL_FIELD]: gen.mediaUrl,
          [REC_CARD_CONTENT_HASH_FIELD]: gen.contentHash,
          recCardGeneratedAt: new Date().toISOString(),
        },
        { merge: true },
      )
    log("rec_card.lazy_gen_persisted", { jobId, mediaUrl: gen.mediaUrl })
    return true
  } catch (e) {
    log("rec_card.lazy_gen_persist_failed", {
      jobId,
      error: e instanceof Error ? e.message : String(e),
    })
    return false
  }
}

/**
 * Default lazy-gen: render+upload+persist the cached card for a job that has
 * none yet, then return its media URL. Fail-open → null. Writes the URL +
 * content hash back to matching-jobs (via persistRecCardMediaUrl) so the next
 * send is a pure cache read.
 */
async function defaultLazyGenerate(input: {
  db: Firestore
  jobId: string
  job: CardJobSource
  creds: SendblueMediaCreds
  log: (event: string, payload?: Record<string, unknown>) => void
  loadCompany?: (db: Firestore, job: CardJobSource, jobId: string) => Promise<CardCompanySource | null>
}): Promise<string | null> {
  const loadCompany = input.loadCompany ?? defaultLoadCompany
  let company: CardCompanySource | null = null
  try {
    company = await loadCompany(input.db, input.job, input.jobId)
  } catch {
    /* job-only */
  }
  const gen: GenerateRecCardResult | null = await generateRecCardForJob({
    jobId: input.jobId,
    job: input.job,
    company,
    deps: { creds: input.creds, log: input.log },
  })
  if (!gen) return null
  await persistRecCardMediaUrl(input.db, input.jobId, gen, input.log)
  return gen.mediaUrl
}

/**
 * Inputs for `resolveRecCardMediaUrl` — the PURE media-URL resolver. Same seams as
 * `maybeSendRecCard` minus everything to do with enqueuing/caption (getPhoneE164, fromNumber,
 * todayYmd) — resolving the image is independent of WHO/WHEN we send it.
 */
export type ResolveRecCardMediaUrlInput = {
  jobId: string
  job: CardJobSource
  /** Seam: read the cached media URL for a job. Defaults to a matching-jobs point-read. */
  loadCachedMediaUrl?: (db: Firestore, jobId: string) => Promise<string | null>
  /** Seam: HEAD-check a cached media URL is still alive (non-200 → regenerate). Defaults to a real HEAD. */
  checkMediaUrlLive?: (url: string) => Promise<boolean>
  /** Seam: lazy-generate + persist a card. Defaults to generateRecCardForJob + write-back. */
  lazyGenerate?: SendRecCardDeps["lazyGenerate"]
  /** Seam: load the company doc for lazy-gen. Defaults to a pa-companies read. */
  loadCompany?: SendRecCardDeps["loadCompany"]
  /** Sendblue media-upload creds for the lazy-gen fallback. Absent → no lazy gen (cache-read only). */
  sendblueCreds?: SendblueMediaCreds
  log?: (event: string, payload?: Record<string, unknown>) => void
}

/**
 * Resolve the Sendblue-acceptable media URL for ONE job's rec card — WITHOUT enqueuing anything.
 *
 * This is the pure side of the rec-card model (extracted 2026-06-04 so makeV16FindMatch can attach
 * the image INLINE to the role's caption bubble instead of enqueuing a separate, once/day, racing
 * media row). Pipeline (identical to `maybeSendRecCard`'s old inline logic):
 *   1. CACHE READ   — matching-jobs/{jobId}.recCardMediaUrl (the happy path; no render/upload).
 *   2. SHAPE GUARD  — reject a non-Sendblue-acceptable cached url (a legacy Firebase token url is
 *                     HTTP-200-live yet silently DROPPED by Sendblue) as a MISS, but only when there
 *                     are creds to re-host (else keep it — a maybe-dropped image beats an unfillable miss).
 *   3. LIVENESS     — HEAD-check a Sendblue-CDN url (a 404'd object is dropped on an otherwise-DELIVERED
 *                     send); a stale url is a MISS, again only when creds exist.
 *   4. LAZY GEN     — when the cache is empty/stale/wrong-shape AND creds exist, render+upload a fresh
 *                     Sendblue-CDN url and PERSIST it to matching-jobs/{jobId}.recCardMediaUrl so the
 *                     NEXT resolve is a pure cache read (the writeback fix — see defaultLazyGenerate).
 *
 * Returns the url, or null on any miss (no creds to fill, un-renderable, error). FAIL-OPEN — never throws.
 */
export async function resolveRecCardMediaUrl(
  db: Firestore,
  input: ResolveRecCardMediaUrlInput,
): Promise<string | null> {
  const log = input.log ?? (() => {})
  try {
    // 1. CACHE READ — the happy path. No render/upload.
    const loadCached = input.loadCachedMediaUrl ?? defaultLoadCachedMediaUrl
    let mediaUrl = await loadCached(db, input.jobId)

    // 1a. SHAPE GUARD — a cached url can be PERFECTLY LIVE (HTTP 200) yet still get SILENTLY DROPPED by
    // Sendblue because its SHAPE is wrong (a legacy Firebase token url is signed + not extension-
    // terminated). Reject any non-Sendblue-acceptable url as a cache MISS so the lazy-gen below re-uploads
    // a fresh Sendblue-CDN url. Only when there are creds to regenerate (no creds → keep the url).
    if (mediaUrl && input.sendblueCreds && !isSendblueAcceptableMediaUrl(mediaUrl)) {
      log("rec_card.cached_url_wrong_shape", { jobId: input.jobId, mediaUrl })
      mediaUrl = null
    }

    // 1b. LIVENESS — a cached Sendblue-CDN url can expire (404); Sendblue then silently drops the image on
    // an otherwise-DELIVERED send. HEAD-check it; a stale url is a cache MISS so lazy-gen re-uploads a fresh
    // one. Only when there's a url AND creds to regenerate.
    if (mediaUrl && input.sendblueCreds) {
      const checkLive = input.checkMediaUrlLive ?? defaultCheckMediaUrlLive
      const live = await checkLive(mediaUrl)
      if (!live) {
        log("rec_card.cached_url_stale", { jobId: input.jobId })
        mediaUrl = null
      }
    }

    // 2. LAZY GEN — only when the cache is empty (or stale/wrong-shape) AND creds are available. The
    // default writes the fresh url back to matching-jobs/{jobId} so the NEXT resolve is a pure cache read.
    if (!mediaUrl && input.sendblueCreds) {
      const lazyGen =
        input.lazyGenerate ??
        ((args) =>
          defaultLazyGenerate({
            ...args,
            ...(input.loadCompany ? { loadCompany: input.loadCompany } : {}),
          }))
      mediaUrl = await lazyGen({
        db,
        jobId: input.jobId,
        job: input.job,
        creds: input.sendblueCreds,
        log,
      })
      if (mediaUrl) log("rec_card.lazy_generated", { jobId: input.jobId })
    }

    return mediaUrl ?? null
  } catch (err) {
    // FAIL-OPEN — resolving an image must never throw into the find_match turn.
    log("rec_card.resolve_failed", {
      jobId: input.jobId,
      error: err instanceof Error ? err.message : String(err),
    })
    return null
  }
}

/**
 * Send a rec card for the top matched job using the CACHED image. Returns
 * `{ sent: false }` on any miss so the caller still sends the text rec.
 *
 * `reasons` (per-candidate "why") affect ONLY the text caption — never the
 * cached image — so the same image serves every candidate.
 *
 * RETAINED for back-compat + tests; makeV16FindMatch no longer uses it (it
 * resolves the url via `resolveRecCardMediaUrl` and sends the image INLINE on
 * the role caption bubble). The cache-read/shape-guard/liveness/lazy-gen logic
 * is now delegated to `resolveRecCardMediaUrl` (single source of truth).
 */
export async function maybeSendRecCard(input: {
  userId: string
  jobId: string
  job: CardJobSource
  reasons?: CardReasonSource | null
  /**
   * Caption verbosity (Adam 2026-06-04 multi-card batch). "full" (default) = the
   * prescreen-pitch caption; "lean" = role headline + apply link only, used for
   * the 2nd+ card so the same pitch paragraph isn't repeated under every image.
   */
  captionMode?: "full" | "lean"
  deps: SendRecCardDeps
}): Promise<SendRecCardResult> {
  const { deps } = input
  const log = deps.log ?? (() => {})
  const env = deps.env ?? process.env

  if (!isJobRecCardEnabled(env)) {
    return { sent: false, reason: "flag_off" }
  }

  try {
    const toE164 = (await deps.getPhoneE164(deps.db, input.userId))?.trim() || ""
    if (!toE164) {
      log("rec_card.no_phone", { userId: input.userId })
      return { sent: false, reason: "no_phone" }
    }

    // CACHE READ → shape-guard → liveness → lazy-gen (+ persist), all via the shared resolver so the
    // logic lives in ONE place (resolveRecCardMediaUrl) — the same path makeV16FindMatch uses to attach
    // the image INLINE. Returns a Sendblue-acceptable url, or null on any miss.
    const mediaUrl = await resolveRecCardMediaUrl(deps.db, {
      jobId: input.jobId,
      job: input.job,
      ...(deps.loadCachedMediaUrl ? { loadCachedMediaUrl: deps.loadCachedMediaUrl } : {}),
      ...(deps.checkMediaUrlLive ? { checkMediaUrlLive: deps.checkMediaUrlLive } : {}),
      ...(deps.lazyGenerate ? { lazyGenerate: deps.lazyGenerate } : {}),
      ...(deps.loadCompany ? { loadCompany: deps.loadCompany } : {}),
      ...(deps.sendblueCreds ? { sendblueCreds: deps.sendblueCreds } : {}),
      log,
    })

    if (!mediaUrl) {
      log("rec_card.no_cached_card", { userId: input.userId, jobId: input.jobId })
      return { sent: false, reason: "card_unavailable" }
    }

    // 3. CAPTION — per-candidate text (Claire's voice + apply link). The image
    // is job-level; the caption is the only candidate-specific part of the send.
    const loadCompany = deps.loadCompany ?? defaultLoadCompany
    let company: CardCompanySource | null = null
    try {
      company = await loadCompany(deps.db, input.job, input.jobId)
    } catch {
      /* job-only caption */
    }
    const payload = buildRecCardPayload({
      job: input.job,
      company,
      reasons: input.reasons ?? null,
    })
    if (!payload) {
      log("rec_card.caption_unrenderable", { userId: input.userId, jobId: input.jobId })
      return { sent: false, reason: "card_unavailable" }
    }
    const caption = buildRecCardCaption(payload, input.captionMode ?? "full")

    const ymd = (deps.todayYmd ?? defaultYmd)()
    const idempotencyKey = `rec-card-${input.userId}-${input.jobId}-${ymd}`
    const { id, created } = await enqueueOutbound(deps.db, {
      userId: input.userId,
      toE164,
      body: caption,
      mediaUrl,
      idempotencyKey,
      ...(deps.fromNumber ? { fromNumber: deps.fromNumber } : {}),
      runtimeApproved: true,
      runtimeSource: "pa_orchestrator",
    })

    log("rec_card.enqueued", {
      userId: input.userId,
      jobId: input.jobId,
      outboundId: id,
      created,
      mediaUrl,
    })
    return { sent: true, mediaUrl, outboundId: id }
  } catch (err) {
    // FAIL-OPEN — a card-send hiccup must never break the text rec.
    log("rec_card.send_failed_fallback_to_text", {
      userId: input.userId,
      jobId: input.jobId,
      error: err instanceof Error ? err.message : String(err),
    })
    return { sent: false, reason: "error" }
  }
}
