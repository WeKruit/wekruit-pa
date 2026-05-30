/**
 * job-rec-card.ts — the render→host→send orchestrator seam.
 *
 * `maybeBuildRecCard()` is the single entry point the rec-delivery paths call.
 * It is FAIL-OPEN by contract: any failure (flag off, un-renderable payload,
 * render error, upload error) returns null, and the caller falls back to the
 * existing TEXT recommendation. It must NEVER throw into the send path (RC2).
 *
 * Flag/env gate: `PA_JOB_REC_CARD_ENABLED` must be "1"/"true" for the card to
 * render. This keeps the new media path dark until Adam flips it on — the brief
 * is PR-first, no deploy, no flag flip.
 */

import type { Firestore } from "firebase-admin/firestore"
import {
  buildRecCardPayload,
  type CardCompanySource,
  type CardJobSource,
  type CardReasonSource,
  type RecCardPayload,
} from "./card-payload.js"
import { renderRecCardPng } from "./render-card.js"
import { uploadRecCardPng, type CardStorage } from "./upload-card.js"

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

/**
 * Render + host a rec card for one matched job. Returns null on ANY failure
 * (flag off / un-renderable / render / upload) so the caller can fall back to
 * text. Never throws.
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
