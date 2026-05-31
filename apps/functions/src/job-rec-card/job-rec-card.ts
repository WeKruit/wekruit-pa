/**
 * job-rec-card.ts — the render→host→send orchestrator seam.
 *
 * ARCHITECTURE (Adam 2026-05-31): the rec-card IMAGE is JOB-LEVEL content only
 * (logo, title, company, stage/raise, salary, location, In-Network badge) and is
 * therefore identical for every candidate → PRE-GENERATED + CACHED per collab job
 * on `matching-jobs/{jobId}.recCardMediaUrl`. Runtime READS that cached URL — no
 * render/upload in the happy path. Per-candidate "why" lines live in Claire's TEXT
 * caption (unchanged), never in the image.
 *
 * DELIVERY FIX: the cached URL is a Sendblue-hosted, NON-signed, `.png`-terminated
 * CDN URL (uploadToSendblueMedia) — the only shape Sendblue's `media_url` accepts.
 * The previous Firebase token URL violated both Sendblue constraints and was
 * silently dropped (caption delivered, image gone).
 *
 * `generateRecCardForJob()` — the pre-gen entry (script + lazy fallback): render
 * the PNG WITH the real logo → upload to Sendblue → return { mediaUrl, contentHash }.
 * `maybeBuildRecCard()` — legacy/lazy build seam (render + Firebase host) kept for
 * back-compat + tests. Both are FAIL-OPEN: any failure returns null/undefined and
 * the caller falls back to the existing TEXT recommendation. Never throw into send.
 *
 * Flag/env gate: `PA_JOB_REC_CARD_ENABLED` must be "1"/"true" for the card to send.
 */

import { createHash } from "node:crypto"
import type { Firestore } from "firebase-admin/firestore"
import {
  buildRecCardPayload,
  type CardCompanySource,
  type CardJobSource,
  type CardReasonSource,
  type RecCardPayload,
} from "./card-payload.js"
import { renderRecCardPng } from "./render-card.js"
import {
  uploadRecCardPng,
  uploadToSendblueMedia,
  type CardStorage,
  type SendblueMediaCreds,
} from "./upload-card.js"

export const JOB_REC_CARD_ENV_FLAG = "PA_JOB_REC_CARD_ENABLED"

export function isJobRecCardEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env[JOB_REC_CARD_ENV_FLAG] ?? "").trim().toLowerCase()
  return v === "1" || v === "true" || v === "on"
}

export type RecCardResult = {
  /** Public URL Sendblue pulls as the iMessage image attachment. */
  mediaUrl: string
  /** Short text caption in Claire's voice (apply link included). */
  caption: string
  /** The payload that was rendered (surfaced for logging/tests). */
  payload: RecCardPayload
  objectPath: string
}

export type MaybeBuildRecCardDeps = {
  db: Firestore
  storage: CardStorage
  /** Seam: defaults to renderRecCardPng; tests inject a fake. */
  renderPng?: (payload: RecCardPayload) => Promise<Buffer>
  /** Seam: defaults to a company-enrichment Firestore read. */
  loadCompany?: (db: Firestore, job: CardJobSource, jobId: string) => Promise<CardCompanySource | null>
  /** Seam: defaults to a ~2s logo fetch → data: URI. Tests inject a fake. */
  fetchLogoDataUri?: (logoUrl: string) => Promise<string | null>
  log?: (event: string, payload?: Record<string, unknown>) => void
  env?: NodeJS.ProcessEnv
}

/**
 * Compose the SHORT caption that rides with the card image. Claire's voice,
 * apply link included (the brief keeps the link in the text/caption).
 */
export function buildRecCardCaption(payload: RecCardPayload): string {
  const lines = [
    `one role worth your time: ${payload.company}.`,
    "lmk if it's interesting, and why or why not.",
  ]
  if (payload.applyUrl) lines.push(payload.applyUrl)
  return lines.join("\n")
}

/**
 * Default company enrichment loader. Reads the real `pa-companies/{id}` doc
 * (doc id = normalized company name, per @pa/core-types normalizeCompanyName).
 * Best-effort: any error / miss returns null and the card renders the
 * job-only sections (title, salary, location, why-fits). No `pa-jobs.employer`
 * fallback — that block does not exist in the audited schema.
 */
async function defaultLoadCompany(
  db: Firestore,
  job: CardJobSource,
  _jobId: string,
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
    /* fall through → null (job-only card) */
  }
  return null
}

const LOGO_FETCH_TIMEOUT_MS = 2_500
const LOGO_MAX_BYTES = 512 * 1024 // 512KB cap — a favicon is a few KB.

/**
 * Fetch a remote logo URL into a `data:image/...;base64,...` URI. Follows
 * redirects (Google favicon 301s), bounded ~2.5s, size-capped. FAIL-OPEN:
 * any error / non-image / oversize → null so the renderer draws the monogram.
 * This is the ONLY place the logo is fetched — satori must never egress.
 */
export async function fetchLogoDataUri(logoUrl: string): Promise<string | null> {
  if (!/^https:\/\//.test(logoUrl)) return null
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), LOGO_FETCH_TIMEOUT_MS)
  try {
    const resp = await fetch(logoUrl, { redirect: "follow", signal: ctrl.signal })
    if (!resp.ok) return null
    const ct = (resp.headers.get("content-type") ?? "").toLowerCase()
    if (!ct.startsWith("image/")) return null
    const buf = Buffer.from(await resp.arrayBuffer())
    if (buf.length === 0 || buf.length > LOGO_MAX_BYTES) return null
    // Normalize the mime (drop charset/params).
    const mime = ct.split(";")[0]!.trim() || "image/png"
    return `data:${mime};base64,${buf.toString("base64")}`
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Hash the JOB-LEVEL card content (everything baked into the cached image —
 * NOT the per-candidate reasons). Used for idempotent pre-gen: re-render only
 * when the content actually changed.
 */
export function recCardContentHash(payload: RecCardPayload): string {
  const stable = {
    company: payload.company,
    title: payload.title,
    seniority: payload.seniority ?? null,
    stage: payload.stage ?? null,
    raiseAmount: payload.raiseAmount ?? null,
    headcount: payload.headcount ?? null,
    industry: payload.industry ?? null,
    salaryMin: payload.salaryMin ?? null,
    salaryMax: payload.salaryMax ?? null,
    location: payload.location ?? null,
    workMode: payload.workMode ?? null,
    inNetwork: payload.inNetwork ?? false,
    logoUrl: payload.logoUrl ?? null,
  }
  return createHash("sha256").update(JSON.stringify(stable)).digest("hex").slice(0, 32)
}

/** A sanitized `.png` filename for the Sendblue media upload (job-scoped). */
export function recCardFilename(jobId: string): string {
  const safe = jobId.replace(/[^a-zA-Z0-9._-]+/g, "-").slice(0, 60) || "rec-card"
  return `wk-rec-${safe}.png`
}

export type GenerateRecCardResult = {
  /** Permanent, non-signed, .png-terminated Sendblue CDN media URL. */
  mediaUrl: string
  /** Content hash of the JOB-LEVEL image (for idempotent re-gen). */
  contentHash: string
  /** Bytes of the rendered PNG (logging). */
  bytes: number
  /** The payload that was rendered. */
  payload: RecCardPayload
}

/**
 * Pre-generate the JOB-LEVEL card for one job: build the payload (no per-
 * candidate reasons), pre-fetch the logo → data URI, render the PNG, upload to
 * Sendblue's media store, and return the permanent media URL + content hash.
 *
 * Used by the generation SCRIPT (one-shot + re-runnable) AND as the runtime
 * lazy fallback when a job has no cached `recCardMediaUrl` yet. FAIL-OPEN:
 * returns null on any failure (un-renderable / render / upload). Never throws.
 *
 * NOTE: pass NO reasons — the cached image is per-job, identical for everyone.
 */
export async function generateRecCardForJob(input: {
  jobId: string
  job: CardJobSource
  company?: CardCompanySource | null
  deps: {
    creds: SendblueMediaCreds
    renderPng?: (payload: RecCardPayload) => Promise<Buffer>
    fetchLogoDataUri?: (logoUrl: string) => Promise<string | null>
    log?: (event: string, payload?: Record<string, unknown>) => void
  }
}): Promise<GenerateRecCardResult | null> {
  const { deps } = input
  const log = deps.log ?? (() => {})
  try {
    const payload = buildRecCardPayload({ job: input.job, company: input.company ?? null, reasons: null })
    if (!payload) {
      log("job_rec_card.gen.payload_unrenderable", { jobId: input.jobId })
      return null
    }

    // Pre-fetch the logo into a data: URI (fail-open → monogram).
    if (payload.logoUrl) {
      const fetchLogo = deps.fetchLogoDataUri ?? fetchLogoDataUri
      const dataUri = await fetchLogo(payload.logoUrl).catch(() => null)
      if (dataUri) payload.logoDataUri = dataUri
    }

    const renderPng = deps.renderPng ?? renderRecCardPng
    const png = await renderPng(payload)
    if (!png || png.length === 0) {
      log("job_rec_card.gen.empty_png", { jobId: input.jobId })
      return null
    }

    const mediaUrl = await uploadToSendblueMedia(png, recCardFilename(input.jobId), deps.creds)
    const contentHash = recCardContentHash(payload)
    log("job_rec_card.gen.built", {
      jobId: input.jobId,
      bytes: png.length,
      contentHash,
      hasLogo: Boolean(payload.logoDataUri),
    })
    return { mediaUrl, contentHash, bytes: png.length, payload }
  } catch (err) {
    log("job_rec_card.gen.failed", {
      jobId: input.jobId,
      error: err instanceof Error ? err.message : String(err),
    })
    return null
  }
}

/**
 * Render + host a rec card for one matched job via Firebase Storage (LEGACY
 * lazy build path; the primary path now reads the cached Sendblue URL). Returns
 * null on ANY failure so the caller can fall back to text. Never throws.
 *
 * Retained for back-compat + existing tests. Now also pre-fetches the logo into
 * a data: URI so the rendered card carries the real logo (monogram fail-open).
 */
export async function maybeBuildRecCard(input: {
  userId: string
  jobId: string
  job: CardJobSource
  reasons?: CardReasonSource | null
  deps: MaybeBuildRecCardDeps
}): Promise<RecCardResult | null> {
  const { deps } = input
  const log = deps.log ?? (() => {})
  const env = deps.env ?? process.env

  if (!isJobRecCardEnabled(env)) {
    return null
  }

  try {
    const loadCompany = deps.loadCompany ?? defaultLoadCompany
    let company: CardCompanySource | null = null
    try {
      company = await loadCompany(deps.db, input.job, input.jobId)
    } catch (err) {
      log("job_rec_card.company_load_failed", {
        userId: input.userId,
        jobId: input.jobId,
        error: err instanceof Error ? err.message : String(err),
      })
    }

    const payload = buildRecCardPayload({ job: input.job, company, reasons: input.reasons })
    if (!payload) {
      log("job_rec_card.payload_unrenderable", { userId: input.userId, jobId: input.jobId })
      return null
    }

    // Pre-fetch the logo into a data: URI (fail-open → monogram).
    if (payload.logoUrl) {
      const fetchLogo = deps.fetchLogoDataUri ?? fetchLogoDataUri
      const dataUri = await fetchLogo(payload.logoUrl).catch(() => null)
      if (dataUri) payload.logoDataUri = dataUri
    }

    const renderPng = deps.renderPng ?? renderRecCardPng
    const png = await renderPng(payload)
    if (!png || png.length === 0) {
      log("job_rec_card.empty_png", { userId: input.userId, jobId: input.jobId })
      return null
    }

    const { url, objectPath } = await uploadRecCardPng({
      storage: deps.storage,
      userId: input.userId,
      jobId: input.jobId,
      png,
    })

    log("job_rec_card.built", {
      userId: input.userId,
      jobId: input.jobId,
      bytes: png.length,
      objectPath,
    })

    return {
      mediaUrl: url,
      caption: buildRecCardCaption(payload),
      payload,
      objectPath,
    }
  } catch (err) {
    // FAIL-OPEN: a render/upload hiccup must NEVER break the send.
    log("job_rec_card.failed_fallback_to_text", {
      userId: input.userId,
      jobId: input.jobId,
      error: err instanceof Error ? err.message : String(err),
    })
    return null
  }
}
