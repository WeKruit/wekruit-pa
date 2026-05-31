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
import type { SendblueMediaCreds } from "./upload-card.js"

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
 * Default lazy-gen: render+upload+persist the cached card for a job that has
 * none yet, then return its media URL. Fail-open → null. Writes the URL +
 * content hash back to matching-jobs so the next send is a pure cache read.
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
  // Persist for next time (merge, best-effort — a write failure still returns the URL).
  try {
    await input.db
      .collection("matching-jobs")
      .doc(input.jobId)
      .set(
        {
          [REC_CARD_MEDIA_URL_FIELD]: gen.mediaUrl,
          [REC_CARD_CONTENT_HASH_FIELD]: gen.contentHash,
          recCardGeneratedAt: new Date().toISOString(),
        },
        { merge: true },
      )
  } catch (e) {
    input.log("rec_card.lazy_gen_persist_failed", {
      jobId: input.jobId,
      error: e instanceof Error ? e.message : String(e),
    })
  }
  return gen.mediaUrl
}

/**
 * Send a rec card for the top matched job using the CACHED image. Returns
 * `{ sent: false }` on any miss so the caller still sends the text rec.
 *
 * `reasons` (per-candidate "why") affect ONLY the text caption — never the
 * cached image — so the same image serves every candidate.
 */
export async function maybeSendRecCard(input: {
  userId: string
  jobId: string
  job: CardJobSource
  reasons?: CardReasonSource | null
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

    // 1. CACHE READ — the happy path. No render/upload.
    const loadCached = deps.loadCachedMediaUrl ?? defaultLoadCachedMediaUrl
    let mediaUrl = await loadCached(deps.db, input.jobId)

    // 2. LAZY GEN — only when the cache is empty AND creds are available.
    if (!mediaUrl && deps.sendblueCreds) {
      const lazyGen =
        deps.lazyGenerate ??
        ((args) =>
          defaultLazyGenerate({
            ...args,
            ...(deps.loadCompany ? { loadCompany: deps.loadCompany } : {}),
          }))
      mediaUrl = await lazyGen({
        db: deps.db,
        jobId: input.jobId,
        job: input.job,
        creds: deps.sendblueCreds,
        log,
      })
      if (mediaUrl) log("rec_card.lazy_generated", { userId: input.userId, jobId: input.jobId })
    }

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
    const caption = buildRecCardCaption(payload)

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
