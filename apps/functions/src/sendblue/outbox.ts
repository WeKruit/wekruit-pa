/**
 * paSendblueOutbox CF — pa_outbound → Sendblue REST POST (D-05).
 *
 * Trigger: onDocumentCreated("pa-outbound/{docId}", handler) AND on
 * status-pending update (reclaim case). Pure handler `paSendblueOutboxHandler`
 * accepts deps for testability; the CF wrapper in apps/functions/src/index.ts
 * binds the live Firestore + Sendblue client.
 *
 * Flow:
 *   1. Claim transactionally (status pending → sending) — prevents
 *      double-send across CF retries
 *   2. Runtime approval gate (blocks direct pa-outbound producers)
 *   3. Append transcript (skip when idempotencyKey starts with
 *      `out-imessage-in-`, `out-sendblue-`, or orchestrator-owned
 *      `outbound-` rows that already appended transcript metadata)
 *   4. Optional typing indicator (PA_TYPING_INDICATOR=1, D-06)
 *   5. POST Sendblue REST → on 4xx → status=failed; on 5xx → status=pending
 *      with attemptCount bumped (CF re-fires via reclaim or next mutation)
 *   6. On 2xx → status=sent + record uuid/messageHandle for delivery audit
 */

import { PA_COLLECTIONS } from "@pa/core-types"
import { isApprovedRuntimeSource } from "@pa/pa-broker"
import type { Firestore } from "firebase-admin/firestore"

import { normalizePeer } from "./peer.js"
import { SendblueClientError, SendblueServerError, sendImessage as defaultSendImessage } from "./sendblue-client.js"
import { sendTypingIndicator as defaultSendTypingIndicator, computeTypingDwellMs } from "./typing-indicator.js"
import type { SendblueSendResponse } from "./types.js"
import { getFlag, getDailyOutboundCount, incrementDailyOutbound } from "@pa/pa-persistence"
import { recordAuditEvent } from "./audit.js"
import { outboundExpiresAtTs } from "./ttl.js"

const OUT = PA_COLLECTIONS.outbound

export function shouldAppendOutboundTranscript(raw: { idempotencyKey?: unknown }): boolean {
  const idempotencyKey = String(raw.idempotencyKey ?? "")
  if (idempotencyKey.startsWith("out-imessage-in-")) return false
  if (idempotencyKey.startsWith("out-sendblue-")) return false
  if (idempotencyKey.startsWith("outbound-")) return false
  return true
}

export function isMarketplaceOutreachOutbound(raw: { idempotencyKey?: unknown }): boolean {
  return String(raw.idempotencyKey ?? "").startsWith("outreach_idempotency_")
}

export function isRuntimeApprovedOutbound(raw: { runtimeApproved?: unknown; runtimeSource?: unknown }): boolean {
  return raw.runtimeApproved === true && isApprovedRuntimeSource(raw.runtimeSource)
}

export function isTypingIndicatorEnabled(): boolean {
  // 2026-05-19 — typing indicator is now always on. Adam's product directive:
  // SMS replies should always show a typing bubble before content lands, no
  // env-var gating. Previous PA_TYPING_INDICATOR=1 opt-in had silently
  // regressed after CF env drift; hardcoding removes that failure mode.
  return process.env.PA_TYPING_INDICATOR !== "0"
}

type OutboundEvent = {
  params: { docId: string }
  data?:
    | {
        data: () => Record<string, unknown> | undefined
        id: string
      }
    | null
}

type SendblueClientLike = {
  sendImessage: typeof defaultSendImessage
  sendTypingIndicator: typeof defaultSendTypingIndicator
}

type OutboxUser = {
  id: string
  senderNumber?: unknown
}

export type OutboxDeps = {
  db: Firestore
  sendblueClient: SendblueClientLike
  now?: () => Date
  log?: (...args: unknown[]) => void
  // Loose signatures so production injects from @pa/pa-persistence without
  // type-narrowing friction. Internal call sites cast at use.
  appendMessage?: (db: Firestore, input: never) => Promise<unknown>
  getUser?: (db: Firestore, userId: string) => Promise<OutboxUser | null>
  getOrCreateSession?: (
    db: Firestore,
    userId: string,
    channel: never,
    externalChatId: string
  ) => Promise<{ id: string }>
  readOutreachStopControl?: (
    db: Firestore,
    input: { scope: "global" }
  ) => Promise<{ paused: boolean; reason?: string }>
}

const STALE_SENDING_MS = 10 * 60 * 1000 // 10 minutes
const DEAD_LETTER_ATTEMPTS = 5
const SWEEP_LIMIT = 20

/**
 * Stream H4 D4 — structured failure log for alert pipeline.
 *
 * Emits a single severity=ERROR Cloud Logging entry that the
 * "pa.outbound.failed" log-based metric (see scripts/setup-failure-alert.sh)
 * counts. Body is truncated to 200 chars to keep log payload bounded.
 *
 * Called at every status flip to "failed" or "dead_letter", with
 * `firebase-functions/logger.error` semantics by way of the injected
 * `log` callback (which in production binds to logger.error).
 */
export function logOutboundFailure(
  log: (...args: unknown[]) => void,
  fields: {
    docId: string
    userId: string
    idempotencyKey?: string
    lastError: string
    attempts: number
    body: string
    terminalStatus: "failed" | "dead_letter"
  }
): void {
  log("pa.outbound.failed", {
    severity: "ERROR",
    docId: fields.docId,
    userId: fields.userId,
    idempotencyKey: fields.idempotencyKey ?? null,
    lastError: fields.lastError,
    attempts: fields.attempts,
    body_preview: fields.body.slice(0, 200),
    terminalStatus: fields.terminalStatus,
  })
}

/**
 * Stream H4 D2 — top-of-tick stale-row sweep.
 *
 * Rescues two failure modes that the onDocumentCreated trigger cannot:
 *   1) status="sending" rows that crashed mid-flight (>10min) → reset to "pending"
 *   2) status="pending" rows that exhausted retries (attemptCount >= 5) → "dead_letter"
 *
 * Idempotent: each candidate row is flipped via runTransaction that re-reads
 * status inside the tx, so two concurrent sweepers can't double-flip. The
 * sweep is bounded (limit=20 per tick) so cost is O(1) per CF invocation.
 *
 * Design note: this sweep runs on every paSendblueOutbox tick (each new
 * pa-outbound CREATE fires the trigger, and that trigger now also performs
 * housekeeping). This piggyback approach avoids needing a separate scheduled
 * CF for cleanup.
 */
export async function sweepStaleOutbound(
  db: Firestore,
  now: () => Date,
  log: (...args: unknown[]) => void
): Promise<{ swept: number; deadLettered: number }> {
  const nowMs = now().getTime()
  const cutoffIso = new Date(nowMs - STALE_SENDING_MS).toISOString()
  const nowIso = new Date(nowMs).toISOString()

  let swept = 0
  let deadLettered = 0

  // ---- Sweep 1: status="sending" stuck > 10min → reset to "pending" ----
  // Query single-field-indexed only (status); filter staleness client-side
  // to avoid requiring a (status, updatedAt) composite index that may not
  // be deployed yet. Result set is tiny (stuck rows are rare).
  try {
    const sendingSnap = await db
      .collection(OUT)
      .where("status", "==", "sending")
      .limit(SWEEP_LIMIT)
      .get()
    for (const doc of sendingSnap.docs) {
      const d = doc.data() as { updatedAt?: string }
      const t = Date.parse(String(d.updatedAt ?? ""))
      const isStale = Number.isNaN(t) || t < nowMs - STALE_SENDING_MS
      if (!isStale) continue
      // eslint-disable-next-line no-await-in-loop
      const ok = await db.runTransaction(async (tx) => {
        const cur = await (tx.get as (r: typeof doc.ref) => Promise<{ exists: boolean; data: () => unknown }>)(doc.ref)
        if (!cur.exists) return false
        const cd = (cur.data() ?? {}) as { status?: string }
        if (cd.status !== "sending") return false
        tx.update(doc.ref as never, {
          status: "pending",
          updatedAt: nowIso,
          staleSweptAt: nowIso,
          expiresAtTs: outboundExpiresAtTs(now()),
        })
        return true
      })
      if (ok) {
        swept++
        log("outbound_sending_stale_swept", { docId: doc.id, cutoff: cutoffIso })
      }
    }
  } catch (err) {
    log("[sendblue][outbox] sweep stale-sending error (non-fatal)",
      err instanceof Error ? err.message : String(err))
  }

  // ---- Sweep 2: status="pending" attemptCount >= 5 → "dead_letter" ----
  try {
    const pendingSnap = await db
      .collection(OUT)
      .where("status", "==", "pending")
      .limit(SWEEP_LIMIT)
      .get()
    for (const doc of pendingSnap.docs) {
      const d = doc.data() as { attemptCount?: number }
      const attempts = Number(d.attemptCount ?? 0)
      if (attempts < DEAD_LETTER_ATTEMPTS) continue
      // eslint-disable-next-line no-await-in-loop
      const ok = await db.runTransaction(async (tx) => {
        const cur = await (tx.get as (r: typeof doc.ref) => Promise<{ exists: boolean; data: () => unknown }>)(doc.ref)
        if (!cur.exists) return false
        const cd = (cur.data() ?? {}) as { status?: string; attemptCount?: number }
        if (cd.status !== "pending") return false
        if (Number(cd.attemptCount ?? 0) < DEAD_LETTER_ATTEMPTS) return false
        tx.update(doc.ref as never, {
          status: "dead_letter",
          updatedAt: nowIso,
          deadLetteredAt: nowIso,
          expiresAtTs: outboundExpiresAtTs(now()),
        })
        return true
      })
      if (ok) {
        deadLettered++
        log("outbound_dead_lettered", { docId: doc.id, attempts })
        // Stream H4 D4 — structured pa.outbound.failed log for alert metric
        logOutboundFailure(log, {
          docId: doc.id,
          userId: String((d as { userId?: unknown }).userId ?? "?"),
          idempotencyKey: typeof (d as { idempotencyKey?: unknown }).idempotencyKey === "string" ? String((d as { idempotencyKey?: unknown }).idempotencyKey) : undefined,
          lastError: String((d as { error?: unknown }).error ?? "exhausted retries"),
          attempts,
          body: String((d as { body?: unknown }).body ?? ""),
          terminalStatus: "dead_letter",
        })
      }
    }
  } catch (err) {
    log("[sendblue][outbox] sweep dead-letter error (non-fatal)",
      err instanceof Error ? err.message : String(err))
  }

  return { swept, deadLettered }
}

// ── English-only outbound guard (Adam 2026-05-31 P0: NO Chinese, EVER, ALL paths) ──
// EVERY outbound iMessage (thin Claire, legacy orchestrator, prescreen, system) funnels through
// paSendblueOutbox, so this is the single UNIVERSAL choke that guarantees the product is English-only.
// If the body carries ANY CJK it is a defect: translate to English via SiliconFlow Qwen; if that is
// unavailable/fails, strip the CJK and, if nothing usable remains, send a safe English line. NEVER
// ships Chinese. Fail-open to the deterministic fallback — never throws, never blocks a send.
const CJK_DETECT_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff\uff66-\uff9f]/
const CJK_STRIP_RE = /[\u3000-\u303f\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]/g
export async function forceEnglishOnly(
  text: string,
  log: (event: string, payload?: Record<string, unknown>) => void,
): Promise<string> {
  if (!text || !CJK_DETECT_RE.test(text)) return text
  log("pa.lang.cjk_outbound_blocked", { len: text.length, sample: text.slice(0, 48) })
  const key = process.env.SILICONFLOW_API_KEY?.trim()
  if (key) {
    try {
      const ac = new AbortController()
      const timer = setTimeout(() => ac.abort(), 4000)
      try {
        const resp = await fetch("https://api.siliconflow.cn/v1/chat/completions", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
          body: JSON.stringify({
            model: "Qwen/Qwen2.5-7B-Instruct",
            messages: [
              {
                role: "user",
                content:
                  "Rewrite the following SMS in English only. Keep the casual texting tone, brevity, and meaning EXACT. " +
                  "Do NOT add or remove content. Output ONLY the rewritten message, no preface, and absolutely NO Chinese characters.\n\n" +
                  text,
              },
            ],
            temperature: 0.2,
            max_tokens: 320,
          }),
          signal: ac.signal,
        })
        if (resp.ok) {
          const j = (await resp.json()) as { choices?: Array<{ message?: { content?: string } }> }
          const out = String(j?.choices?.[0]?.message?.content ?? "").trim()
          if (out && !CJK_DETECT_RE.test(out)) return out
        }
      } finally {
        clearTimeout(timer)
      }
    } catch {
      /* fall through to deterministic fallback */
    }
  }
  const stripped = text.replace(CJK_STRIP_RE, " ").replace(/\s+/g, " ").trim()
  return stripped.length >= 12 ? stripped : "Got it — give me a moment and I'll follow up."
}

export async function paSendblueOutboxHandler(
  event: OutboundEvent,
  deps: OutboxDeps
): Promise<void> {
  const log = deps.log ?? console.log
  const now = deps.now ?? (() => new Date())
  const docId = event.params.docId
  const data = event.data?.data?.()
  if (!data) {
    log("[sendblue][outbox] event without data", { docId })
    return
  }

  // ---- 1a. Stream H4 D2 — top-of-tick stale-row sweep -------------------
  // Best-effort piggyback housekeeping. Idempotent under concurrent CF
  // invocations (each row flip uses runTransaction with status re-check).
  try {
    await sweepStaleOutbound(deps.db, now, log)
  } catch (err) {
    log("[sendblue][outbox] sweep top-level error (non-fatal)",
      err instanceof Error ? err.message : String(err))
  }

  const ref = deps.db.collection(OUT).doc(docId)

  // ---- 2. Claim transactionally ----------------------------------------
  const claimed = await deps.db.runTransaction(async (t) => {
    const s = await (t.get as (r: typeof ref) => Promise<{ exists: boolean; data: () => unknown }>)(ref)
    if (!s.exists) return false
    const d = (s.data() ?? {}) as { status?: string }
    if (d.status !== "pending") return false
    t.update(ref as never, { status: "sending", updatedAt: now().toISOString(), expiresAtTs: outboundExpiresAtTs(now()) })
    return true
  })
  if (!claimed) return

  const userId = String(data.userId ?? "")
  const toPeerRaw = String(data.toE164 ?? "")
  const toPeer = toPeerRaw ? normalizePeer(toPeerRaw) : ""
  const body = String(data.body ?? "").trim()

  // Runtime approval gate: pa-outbound is only the transport outbox. It
  // must not become an authorization bypass for legacy webhook/upload/event
  // producers that render their own candidate-facing copy.
  if (!isRuntimeApprovedOutbound(data)) {
    await ref.set(
      {
        status: "failed",
        error: "blocked: outbound row was not approved by runtime",
        blockedByRuntimeGate: true,
        updatedAt: now().toISOString(),
        expiresAtTs: outboundExpiresAtTs(now()),
      },
      { merge: true }
    )
    logOutboundFailure(log, {
      docId,
      userId,
      idempotencyKey: typeof data.idempotencyKey === "string" ? String(data.idempotencyKey) : undefined,
      lastError: "blocked: outbound row was not approved by runtime",
      attempts: Number((data as { attemptCount?: unknown }).attemptCount ?? 0),
      body,
      terminalStatus: "failed",
    })
    return
  }

  if (!userId || !toPeer || !body) {
    await ref.set(
      {
        status: "failed",
        error: "missing userId, toE164, or body",
        updatedAt: now().toISOString(),
        expiresAtTs: outboundExpiresAtTs(now()),
      },
      { merge: true }
    )
    logOutboundFailure(log, {
      docId,
      userId,
      idempotencyKey: typeof data.idempotencyKey === "string" ? String(data.idempotencyKey) : undefined,
      lastError: "missing userId, toE164, or body",
      attempts: Number((data as { attemptCount?: unknown }).attemptCount ?? 0),
      body,
      terminalStatus: "failed",
    })
    return
  }

  // v2.0 S9 — marketplace outreach global stop gate. This only applies to
  // S6 marketplace outreach rows, identified by createOutreachIdempotencyKey().
  // A read failure fails closed before transcript append, typing, quota, or send.
  if (isMarketplaceOutreachOutbound(data)) {
    try {
      const control = await deps.readOutreachStopControl?.(deps.db, { scope: "global" })
      if (control?.paused) {
        const reason = control.reason ? `: ${control.reason}` : ""
        await ref.set(
          {
            status: "failed",
            error: `marketplace outreach paused${reason}`,
            blockedByOutreachStopControl: true,
            updatedAt: now().toISOString(),
            expiresAtTs: outboundExpiresAtTs(now()),
          },
          { merge: true }
        )
        logOutboundFailure(log, {
          docId,
          userId,
          idempotencyKey: typeof data.idempotencyKey === "string" ? String(data.idempotencyKey) : undefined,
          lastError: `marketplace outreach paused${reason}`,
          attempts: Number((data as { attemptCount?: unknown }).attemptCount ?? 0),
          body,
          terminalStatus: "failed",
        })
        return
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      await ref.set(
        {
          status: "failed",
          error: `marketplace outreach stop control check failed: ${message}`,
          blockedByOutreachStopControl: true,
          updatedAt: now().toISOString(),
          expiresAtTs: outboundExpiresAtTs(now()),
        },
        { merge: true }
      )
      logOutboundFailure(log, {
        docId,
        userId,
        idempotencyKey: typeof data.idempotencyKey === "string" ? String(data.idempotencyKey) : undefined,
        lastError: `marketplace outreach stop control check failed: ${message}`,
        attempts: Number((data as { attemptCount?: unknown }).attemptCount ?? 0),
        body,
        terminalStatus: "failed",
      })
      return
    }
  }

  // ---- 4. Resolve user, optionally append transcript --------------------
  let user: OutboxUser | null = null
  if (deps.getUser) {
    user = await deps.getUser(deps.db, userId)
    if (!user) {
      await ref.set(
        {
          status: "failed",
          error: "user not found",
          updatedAt: now().toISOString(),
          expiresAtTs: outboundExpiresAtTs(now()),
        },
        { merge: true }
      )
      logOutboundFailure(log, {
        docId,
        userId,
        idempotencyKey: typeof data.idempotencyKey === "string" ? String(data.idempotencyKey) : undefined,
        lastError: "user not found",
        attempts: Number((data as { attemptCount?: unknown }).attemptCount ?? 0),
        body,
        terminalStatus: "failed",
      })
      return
    }
  }

  if (
    shouldAppendOutboundTranscript(data) &&
    deps.getOrCreateSession &&
    deps.appendMessage
  ) {
    try {
      const session = await deps.getOrCreateSession(
        deps.db,
        userId,
        "imessage" as never,
        toPeer
      )
      await deps.appendMessage(deps.db, {
        sessionId: session.id,
        userId,
        role: "assistant",
        body,
        createdAt: now().toISOString(),
        idempotencyKey: `outbox-msg-${docId}`,
        rawMeta: { source: "pa-outbound", outboundDocId: docId },
      } as never)
    } catch (err) {
      log(
        "[sendblue][outbox] transcript append failed (non-fatal)",
        err instanceof Error ? err.message : String(err)
      )
    }
  }

  // ---- 5. Daily-quota gate (Phase 26 T2, flag-driven limit) -----------
  // 2026-05-19 — moved BEFORE the typing indicator. With typing default-on
  // (Adam directive), firing a typing bubble for a send that will be
  // hard-blocked by quota would leak a phantom typing event to the user.
  // Quota first, typing second, send third.
  const quotaLimit = Number(await getFlag(deps.db, "sendblueDailyQuota", { env: process.env }, 1000))
  const currentCount = await getDailyOutboundCount(deps.db, now())
  if (currentCount >= quotaLimit) {
    try { await recordAuditEvent(deps.db, { type: "quota_hardblock", channel: "imessage_sendblue", toNumber: toPeer, reason: `count=${currentCount} limit=${quotaLimit}` }) } catch {}
    await ref.set({ status: "failed", error: `sendblue daily quota reached (${currentCount}/${quotaLimit})`, updatedAt: now().toISOString(), expiresAtTs: outboundExpiresAtTs(now()) }, { merge: true })
    logOutboundFailure(log, {
      docId,
      userId,
      idempotencyKey: typeof data.idempotencyKey === "string" ? String(data.idempotencyKey) : undefined,
      lastError: `sendblue daily quota reached (${currentCount}/${quotaLimit})`,
      attempts: Number((data as { attemptCount?: unknown }).attemptCount ?? 0),
      body,
      terminalStatus: "failed",
    })
    return
  }
  if (currentCount >= Math.floor(quotaLimit * 0.8)) {
    try { await recordAuditEvent(deps.db, { type: "quota_soft", channel: "imessage_sendblue", toNumber: toPeer, reason: `count=${currentCount} limit=${quotaLimit}` }) } catch {}
  }

  // ---- 5b. Typing indicator (D-06) -----------------------------
  // Phase 24 T1E — dynamic dwell scaled by reply length (1-4s by body.length).
  // PA_TYPING_DWELL_MS env override still honored if set (operator escape hatch).
  // 2026-05-19 — default-on per Adam directive (was opt-in via
  // PA_TYPING_INDICATOR=1). Opt out via PA_TYPING_INDICATOR=0.
  // PACED multi-bubble rows (data.paced) were ALREADY spaced with a typing+delay beat at the emit
  // seam (deliverBubbles). Re-running this length-based dwell here would (a) double-pace them and
  // (b) REORDER them — the dwell scales with body.length, so a longer bubble waits longer and lands
  // after a shorter later one (the 2026-05-30 reversed-greeting bug). So for paced rows, POST
  // immediately (no extra dwell). Single-bubble / legacy rows keep the human dwell unchanged.
  const rowPaced = (data as { paced?: unknown }).paced === true
  if (!rowPaced && isTypingIndicatorEnabled()) {
    try {
      await deps.sendblueClient.sendTypingIndicator({ to: toPeer })
      const overrideRaw = process.env.PA_TYPING_DWELL_MS
      const overrideMs = overrideRaw != null && overrideRaw !== "" ? Number(overrideRaw) : NaN
      const dwellMs = Number.isFinite(overrideMs) && overrideMs > 0
        ? overrideMs
        : computeTypingDwellMs(body.length)
      // 8000ms safeguard preserved (defensive cap on extreme env values)
      await new Promise((r) => setTimeout(r, Math.min(dwellMs, 8000)))
    } catch {
      // Already best-effort inside the helper; defensive double-swallow.
    }
  }

  // ---- 6. POST Sendblue REST -------------------------------------------
  try {
    // USER↔NUMBER BINDING (2026-06-02) — resolve the line via the single-source
    // reducer so the durable send rides the SAME bound thread as typing/read-
    // receipt/tapback. An explicit `fromNumber` on the row (e.g. admin/internal
    // override) still wins. Otherwise the reducer honors the persisted binding,
    // rebinds if the line went paused/dead, or mints+persists for an unbound
    // user — passing the ALREADY-LOADED `user` doc so this costs ZERO extra read.
    const outboundFromNumber =
      typeof data.fromNumber === "string" && data.fromNumber.trim()
        ? data.fromNumber.trim()
        : undefined
    let explicitFromNumber = outboundFromNumber
    if (!explicitFromNumber) {
      try {
        const { resolveBoundFromNumber } = await import("./resolve-bound-from-number.js")
        const bound = await resolveBoundFromNumber(deps.db, userId, {
          user: (user as Record<string, unknown> | null) ?? undefined,
          mintSource: "send_path_mint",
          log: (event, payload) => log(`[sendblue][outbox] ${event}`, payload),
        })
        explicitFromNumber = bound.fromNumber
      } catch (err) {
        log(
          "[sendblue][outbox] bound-from-number resolve failed (non-fatal)",
          err instanceof Error ? err.message : String(err)
        )
        const userSenderNumber =
          typeof user?.senderNumber === "string" && user.senderNumber.trim()
            ? user.senderNumber.trim()
            : undefined
        explicitFromNumber = userSenderNumber
      }
    }
    // Rec-card path — when the row carries a media_url, deliver as an iMessage
    // image attachment with `body` as the caption. Text-only rows omit it and
    // the send is byte-identical to the pre-card path.
    const mediaUrl =
      typeof data.mediaUrl === "string" && data.mediaUrl.trim() ? data.mediaUrl.trim() : undefined
    // NOTE: outbox already resolved the bound line above (single source of
    // truth), so we do NOT pass `userId` here — that would make sendImessage
    // re-run the reducer (a redundant user read). We pass the resolved
    // `fromNumber` directly; the client honors an explicit line unconditionally.
    const response: SendblueSendResponse = await deps.sendblueClient.sendImessage({
      to: toPeer,
      content: body,
      db: deps.db,
      ...(mediaUrl ? { mediaUrl } : {}),
      ...(explicitFromNumber ? { fromNumber: explicitFromNumber } : {}),
      allowEnvFromNumberFallback: Boolean(explicitFromNumber),
    })
    const messageHandle = response.message_handle ?? response.uuid ?? null
    // ATTACHMENT-DELIVERY OBSERVABILITY (2026-05-31): Sendblue echoes the
    // accepted `media_url` back in the send response — and DROPS it (null/absent)
    // when the URL is signed or not extension-terminated. We requested an image
    // when `mediaUrl` was set; record both the requested URL and the echoed URL
    // so a SILENTLY-DROPPED attachment (requested non-null, echo null) is
    // detectable on the pa-outbound row instead of being invisible.
    const mediaEcho =
      typeof (response as { media_url?: unknown }).media_url === "string"
        ? (response as { media_url?: string }).media_url
        : null
    const mediaRequested = mediaUrl ?? null
    const mediaDropped = Boolean(mediaRequested) && !mediaEcho
    if (mediaDropped) {
      log("[sendblue][outbox] media attachment DROPPED by Sendblue", {
        docId,
        toPeer,
        mediaRequested,
      })
    }
    await ref.set(
      {
        status: "sent",
        sentAt: now().toISOString(),
        updatedAt: now().toISOString(),
        expiresAtTs: outboundExpiresAtTs(now()),
        ...(messageHandle ? { messageHandle, sendblueUuid: response.uuid ?? messageHandle } : {}),
        sendblueStatus: response.status,
        ...(mediaRequested
          ? { mediaRequestedUrl: mediaRequested, mediaEchoUrl: mediaEcho, mediaDropped }
          : {}),
      },
      { merge: true }
    )
    try { await incrementDailyOutbound(deps.db, now()) } catch {}
    log("[sendblue][outbox] sent", { docId, toPeer, messageHandle, mediaDropped })
    return
  } catch (err) {
    if (err instanceof SendblueClientError) {
      log("[sendblue][outbox] 4xx — failed", {
        docId,
        status: err.status,
        message: err.message,
        body: typeof err.body === "string" ? err.body : JSON.stringify(err.body)?.slice(0, 500),
      })
      await ref.set(
        {
          status: "failed",
          error: `sendblue ${err.status}: ${err.message}`,
          updatedAt: now().toISOString(),
          expiresAtTs: outboundExpiresAtTs(now()),
        },
        { merge: true }
      )
      logOutboundFailure(log, {
        docId,
        userId,
        idempotencyKey: typeof data.idempotencyKey === "string" ? String(data.idempotencyKey) : undefined,
        lastError: `sendblue ${err.status}: ${err.message}`,
        attempts: Number((data as { attemptCount?: unknown }).attemptCount ?? 0),
        body,
        terminalStatus: "failed",
      })
      return
    }
    if (err instanceof SendblueServerError) {
      log("[sendblue][outbox] 5xx/transient — release for retry", { docId, status: err.status, message: err.message })
      const prev = await ref.get()
      const prevAttempts = Number(((prev.data() as Record<string, unknown> | undefined)?.attemptCount ?? 0))
      await ref.set(
        {
          status: "pending",
          error: `sendblue ${err.status}: ${err.message}`,
          attemptCount: prevAttempts + 1,
          ...(err.retryAfter ? { retryAfter: err.retryAfter } : {}),
          updatedAt: now().toISOString(),
          expiresAtTs: outboundExpiresAtTs(now()),
        },
        { merge: true }
      )
      return
    }
    const unexpectedMsg = err instanceof Error ? err.message : String(err)
    log("[sendblue][outbox] unexpected error", unexpectedMsg)
    await ref.set(
      {
        status: "failed",
        error: unexpectedMsg,
        updatedAt: now().toISOString(),
        expiresAtTs: outboundExpiresAtTs(now()),
      },
      { merge: true }
    )
    logOutboundFailure(log, {
      docId,
      userId,
      idempotencyKey: typeof data.idempotencyKey === "string" ? String(data.idempotencyKey) : undefined,
      lastError: unexpectedMsg,
      attempts: Number((data as { attemptCount?: unknown }).attemptCount ?? 0),
      body,
      terminalStatus: "failed",
    })
    return
  }
}
