/**
 * send-rec-card.ts — wire the rec-card render→host pipeline to the durable
 * outbound send path.
 *
 * Builds + hosts the card (maybeBuildRecCard), then enqueues ONE runtime-
 * approved `pa-outbound` row carrying `media_url` + a short caption. The
 * paSendblueOutbox CF consumes it and POSTs Sendblue with the image attachment.
 *
 * FAIL-OPEN by contract: returns `{ sent: false }` on any failure (flag off,
 * no phone, render/upload error, enqueue error) so the caller's existing TEXT
 * recommendation is unaffected. Never throws.
 *
 * Idempotency: the media row key is `rec-card-<userId>-<jobId>-<ymd>` so a
 * retry of the same rec on the same day dedupes to one attachment.
 */

import type { Firestore } from "firebase-admin/firestore"
import { enqueueOutbound } from "@pa/pa-broker"
import {
  maybeBuildRecCard,
  isJobRecCardEnabled,
  type MaybeBuildRecCardDeps,
} from "./job-rec-card.js"
import type { CardJobSource, CardReasonSource } from "./card-payload.js"
import type { CardStorage } from "./upload-card.js"

export type SendRecCardDeps = {
  db: Firestore
  storage: CardStorage
  /** Resolve the candidate's E.164 — production wires getUser from @pa/pa-persistence. */
  getPhoneE164: (db: Firestore, userId: string) => Promise<string | null>
  /** Inject the card build seam (tests pass a fake render). */
  cardDeps?: Partial<MaybeBuildRecCardDeps>
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
 * Render + host + enqueue a rec card for the top matched job. Returns
 * `{ sent: false }` on any miss so the caller still sends the text rec.
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

    const card = await maybeBuildRecCard({
      userId: input.userId,
      jobId: input.jobId,
      job: input.job,
      reasons: input.reasons ?? null,
      deps: {
        db: deps.db,
        storage: deps.storage,
        log,
        env,
        ...deps.cardDeps,
      },
    })
    if (!card) {
      // maybeBuildRecCard already logged the specific failure.
      return { sent: false, reason: "card_unavailable" }
    }

    const ymd = (deps.todayYmd ?? defaultYmd)()
    const idempotencyKey = `rec-card-${input.userId}-${input.jobId}-${ymd}`
    const { id, created } = await enqueueOutbound(deps.db, {
      userId: input.userId,
      toE164,
      body: card.caption,
      mediaUrl: card.mediaUrl,
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
      mediaUrl: card.mediaUrl,
    })
    return { sent: true, mediaUrl: card.mediaUrl, outboundId: id }
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
