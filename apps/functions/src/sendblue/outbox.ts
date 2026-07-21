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
import { getFlag, getDailyOutboundCount, isDailyContactKnown, incrementDailyOutbound } from "@pa/pa-persistence"
import { recordAuditEvent } from "./audit.js"
import { findSendbluePoolNumber, loadSendbluePool } from "./pool.js"
import { countRecentSendsForNumber, effectiveSendCap, sendCapWindowCutoffIso } from "./send-cap.js"
import { outboundExpiresAtTs } from "./ttl.js"
import { createHash } from "node:crypto"
import { postSlackAlert as defaultPostSlackAlert } from "../lib/slack-alert.js"
import { isSuppressed } from "../pending-outbound/suppression.js"
import { isSyntheticRecipientNumber } from "./synthetic-recipient.js"

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
  /** 2026-06-10 trust audit (fix 5) — Slack alert seam. Injected in tests; defaults to lib/slack-alert. */
  postSlackAlert?: typeof defaultPostSlackAlert
}

const STALE_SENDING_MS = 10 * 60 * 1000 // 10 minutes
const DEAD_LETTER_ATTEMPTS = 5
const SWEEP_LIMIT = 20

// ── 2026-06-10 trust audit (fix 3) — duplicate-send guard constants ─────────
/** Window inside which an identical body to the same user is a duplicate. */
const DUPLICATE_WINDOW_MS = 5 * 60 * 1000
/** Recent-row scan size (single indexed query; hashes compared client-side). */
const DUPLICATE_QUERY_LIMIT = 20
/** Short acks ("ok", "got it 👍") legitimately repeat — never dedup them. */
const DUPLICATE_MIN_BODY_LEN = 20

// ── 2026-06-10 trust audit (fix 5) — 429 rate-limit handling ────────────────
/** Consecutive HTTP-429 responses on one row before it dead-letters. */
const RATE_LIMIT_DEAD_LETTER_AFTER = 3

// ── 2026-06-11 incident RULE 1 — never outbound to a never-inbound handle ───
/**
 * Dev phones with standing send authorization (Adam +14243201960, Noah
 * +12154034668) — the ONLY phone-level exemption from the prior-inbound
 * evidence gate. NO other bypass (not pa_operator_review, not admin).
 */
export const OUTBOX_INBOUND_EVIDENCE_EXEMPT_PHONES: ReadonlySet<string> = new Set([
  "+14243201960",
  "+12154034668",
])

// ── 2026-06-19 incident — synthetic / test recipients must NEVER reach Sendblue ─
/**
 * The scenario harness (`tests/scenarios/runner.mjs`) mints synthetic users in
 * the reserved `+1999999xxxx` range and injects `harness_`-prefixed inbound
 * events. When the harness runs against the PROD project those synthetic inbound
 * rows satisfy RULE 1 (prior-inbound evidence) and the orchestrator enqueues
 * real `pa-outbound` rows — which POST to Sendblue and get rejected
 * (`INBOUND_ONLY_PLAN`) on every retry, an unsolicited-cold-text path that could
 * also hit a REAL never-inbound number.
 *
 * This is the last-line hard exclusion at the outbox choke point: any send to
 * the reserved synthetic phone range, or any row carrying an e2e/test marker, is
 * terminally blocked BEFORE any Sendblue POST. No exemption (not dev phones, not
 * runtime-approved) — synthetic numbers are never deliverable by construction.
 *
 * The reserved-range regex now lives in `./synthetic-recipient.ts`, the single
 * source of truth also enforced as a hard backstop inside every low-level
 * Sendblue `send*` function (sendImessage / typing / reaction / read-receipt),
 * so no send path — outbox OR direct transport — can reach a synthetic number.
 */
export function isSyntheticOutboundRecipient(
  toPeer: string,
  data: Record<string, unknown>,
): boolean {
  if (isSyntheticRecipientNumber(toPeer)) return true
  if ((data as { e2eTest?: unknown }).e2eTest === true) return true
  const harness = (data as { harness?: unknown }).harness
  if (harness && typeof harness === "object" && "runner" in (harness as object)) return true
  const rawMeta = (data as { rawMeta?: { harness?: unknown } }).rawMeta
  if (
    rawMeta &&
    typeof rawMeta === "object" &&
    rawMeta.harness &&
    typeof rawMeta.harness === "object"
  ) {
    return true
  }
  return false
}

/**
 * Positive-evidence cache. A handle that EVER had inbound never loses that
 * property, so caching `true` across invocations of the same container is
 * always safe. Negatives are NOT cached (the user may text in seconds later).
 */
const priorInboundEvidenceCache = new Set<string>()
export function _resetPriorInboundEvidenceCache(): void {
  priorInboundEvidenceCache.clear()
}

/**
 * RULE 1 evidence check (2026-06-11 incident — recovery sweep replayed old raw
 * webhooks through new email-sender resolution and cold-opened users' profile
 * `phoneE164` even though those owners only ever texted from Apple-ID EMAIL
 * handles → `sendblue 400: INBOUND_ONLY_PLAN`, would be unsolicited cold texts
 * on a richer plan).
 *
 * Evidence = ANY `pa-inbound-events` row whose ACTUAL transport sender handle
 * equals the outbound recipient. Prefer provider-preserved fields
 * (`rawSenderHandle`, `original.from_number`, etc.). Only fall back to the
 * canonical pipeline fields (`participant`, `fromNumber`) when the row has no
 * contradictory provider sender. This matters because email Apple-ID senders
 * are intentionally rewritten to a candidate profile phone for downstream
 * trigger resolution; that profile phone is NOT SMS/iMessage consent.
 *
 * Fail closed on query errors: if we cannot prove prior inbound, the outbox
 * must not POST to Sendblue.
 */
const INBOUND_PROVIDER_SENDER_FIELDS = [
  "rawPayload.rawSenderHandle",
  "rawPayload.original.from_number",
  "rawPayload.original.fromNumber",
  "rawPayload.original.number",
] as const

const INBOUND_CANONICAL_SENDER_FIELDS = [
  "rawPayload.participant",
  "rawPayload.fromNumber",
] as const

function readDottedField(data: Record<string, unknown>, path: string): unknown {
  let cur: unknown = data
  for (const part of path.split(".")) {
    if (!cur || typeof cur !== "object") return undefined
    cur = (cur as Record<string, unknown>)[part]
  }
  return cur
}

function normalizedNonEmptyHandles(values: unknown[]): string[] {
  const handles: string[] = []
  for (const value of values) {
    if (typeof value !== "string") continue
    const normalized = normalizePeer(value)
    if (normalized) handles.push(normalized)
  }
  return handles
}

/**
 * 2026-06-19 — a synthetic scenario-harness inbound row (`harness_` id,
 * `rawPayload.harness.runner`, or `harness:` idempotencyKey) is NOT real
 * candidate consent and must never satisfy the RULE 1 prior-inbound gate.
 */
export function isHarnessInboundEvent(data: Record<string, unknown>): boolean {
  const harness = readDottedField(data, "rawPayload.harness")
  if (harness && typeof harness === "object") return true
  const idem = data.idempotencyKey
  if (typeof idem === "string" && idem.startsWith("harness:")) return true
  return false
}

export function inboundEventMatchesOutboundHandle(data: Record<string, unknown>, toHandle: string): boolean {
  if (isHarnessInboundEvent(data)) return false
  const actualTransportHandles = normalizedNonEmptyHandles(
    INBOUND_PROVIDER_SENDER_FIELDS.map((field) => readDottedField(data, field))
  )
  if (actualTransportHandles.length > 0) {
    return actualTransportHandles.includes(toHandle)
  }

  const canonicalHandles = normalizedNonEmptyHandles(
    INBOUND_CANONICAL_SENDER_FIELDS.map((field) => readDottedField(data, field))
  )
  return canonicalHandles.includes(toHandle)
}

export async function hasPriorInboundEvidence(
  db: Firestore,
  toHandle: string,
  log: (...args: unknown[]) => void
): Promise<{ ok: boolean; checkFailed?: boolean }> {
  if (priorInboundEvidenceCache.has(toHandle)) return { ok: true }
  try {
    for (const field of INBOUND_PROVIDER_SENDER_FIELDS) {
      // eslint-disable-next-line no-await-in-loop
      const snap = await db
        .collection(PA_COLLECTIONS.inboundEvents)
        .where(field, "==", toHandle)
        .limit(5)
        .get()
      // Synthetic harness rows are not consent — exclude them (2026-06-19).
      if (snap.docs.some((doc) => !isHarnessInboundEvent(doc.data()))) {
        priorInboundEvidenceCache.add(toHandle)
        return { ok: true }
      }
    }
    for (const field of INBOUND_CANONICAL_SENDER_FIELDS) {
      // eslint-disable-next-line no-await-in-loop
      const snap = await db
        .collection(PA_COLLECTIONS.inboundEvents)
        .where(field, "==", toHandle)
        .limit(5)
        .get()
      if (snap.docs.some((doc) => inboundEventMatchesOutboundHandle(doc.data(), toHandle))) {
        priorInboundEvidenceCache.add(toHandle)
        return { ok: true }
      }
    }
    return { ok: false }
  } catch (err) {
    log("pa.outbox.inbound_evidence_check_failed (fail-closed)", {
      toHandle,
      error: err instanceof Error ? err.message : String(err),
    })
    return { ok: false, checkFailed: true }
  }
}

function maskE164(value: string): string {
  if (value.length <= 4) return "***"
  return `${value.slice(0, 2)}***${value.slice(-4)}`
}

/**
 * Idempotent ops review item for a RULE 1 block — same HITL collection +
 * doc shape as the email-sender-resolution review items
 * (`pa-candidate-identity-conflicts`, surfaced on /admin/identity-conflicts).
 * Deterministic doc id per (userId, toE164) so repeated blocked rows for the
 * same recipient collapse onto ONE open item. Fail-soft: never blocks the
 * status write.
 */
export async function createOutboundBlockedReviewItem(
  db: Firestore,
  input: {
    userId: string
    toE164: string
    outboundDocId: string
    runtimeSource?: string
    log?: (...args: unknown[]) => void
  }
): Promise<void> {
  const log = input.log ?? (() => undefined)
  try {
    const conflictId = `identity_conflict_${createHash("sha256")
      .update(`outbound_blocked_no_inbound|${input.userId}|${input.toE164}`, "utf8")
      .digest("hex")
      .slice(0, 32)}`
    const ref = db.collection(PA_COLLECTIONS.candidateIdentityConflicts).doc(conflictId)
    const existing = await ref.get()
    if (existing.exists) return
    await ref.set({
      conflictId,
      kind: "outbound_blocked_no_inbound",
      status: "open",
      handleKind: "phone",
      ...(input.userId ? { primaryCandidateId: input.userId } : {}),
      evidence: [
        {
          source: "system",
          summary:
            "Outbound blocked: recipient handle has no prior inbound message (RULE 1, 2026-06-11 incident)",
          refId: input.outboundDocId,
          ...(input.runtimeSource ? { meta: { runtimeSource: input.runtimeSource } } : {}),
        },
      ],
      payloadRedacted: { toE164Masked: maskE164(input.toE164) },
      createdAt: new Date().toISOString(),
    })
  } catch (err) {
    log("[sendblue][outbox] blocked_no_inbound review item write failed (non-fatal)",
      err instanceof Error ? err.message : String(err))
  }
}

/** Stable content hash for the duplicate guard (trimmed body). */
export function outboundBodyHash(body: string): string {
  return createHash("sha256").update(body.trim(), "utf8").digest("hex")
}

/**
 * 2026-06-10 trust audit (fix 3) — find a recently SENT row carrying the same
 * userId + identical body within DUPLICATE_WINDOW_MS. Live evidence: identical
 * bubbles delivered 2-6x within minutes (a full rec batch twice 1min apart; the
 * same question 4x in 3min) — upstream producers raced past their idempotency
 * keys, so the outbox is the last-line choke.
 *
 * Cheap by design: ONE query by userId ordered createdAt desc limit 20; body
 * hashes compared client-side (no new composite index REQUIRED — when the
 * (userId, createdAt) index is missing the orderBy query throws and we retry
 * WITHOUT orderBy + sort client-side). FAIL-OPEN: any error returns null (the
 * send proceeds as today).
 */
export async function findRecentDuplicateOutbound(
  db: Firestore,
  input: {
    userId: string
    body: string
    excludeDocId: string
    nowMs: number
    log?: (...args: unknown[]) => void
  }
): Promise<{ docId: string } | null> {
  const targetHash = outboundBodyHash(input.body)
  type Row = { id: string; data: Record<string, unknown> }
  let rows: Row[] = []
  try {
    let docs: Array<{ id: string; data: () => Record<string, unknown> | undefined }>
    try {
      const snap = await db
        .collection(OUT)
        .where("userId", "==", input.userId)
        .orderBy("createdAt", "desc")
        .limit(DUPLICATE_QUERY_LIMIT)
        .get()
      docs = snap.docs as typeof docs
    } catch {
      // Composite index missing → single-field query, sort client-side.
      const snap = await db
        .collection(OUT)
        .where("userId", "==", input.userId)
        .limit(DUPLICATE_QUERY_LIMIT * 3)
        .get()
      docs = [...(snap.docs as typeof docs)].sort((a, b) => {
        const ta = String(a.data()?.createdAt ?? "")
        const tb = String(b.data()?.createdAt ?? "")
        return tb.localeCompare(ta)
      })
      docs = docs.slice(0, DUPLICATE_QUERY_LIMIT)
    }
    rows = docs.map((d) => ({ id: d.id, data: (d.data() ?? {}) as Record<string, unknown> }))
  } catch (err) {
    input.log?.("[sendblue][outbox] duplicate-guard query failed (fail-open)",
      err instanceof Error ? err.message : String(err))
    return null
  }
  for (const row of rows) {
    if (row.id === input.excludeDocId) continue
    const status = String(row.data.status ?? "")
    if (status !== "sent" && status !== "delivered") continue
    const createdMs = Date.parse(String(row.data.sentAt ?? row.data.createdAt ?? ""))
    if (!Number.isFinite(createdMs) || input.nowMs - createdMs > DUPLICATE_WINDOW_MS) continue
    const body = typeof row.data.body === "string" ? row.data.body : ""
    if (!body) continue
    if (outboundBodyHash(body) === targetHash) return { docId: row.id }
  }
  return null
}

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

  // ---- 3a. Synthetic / test recipient hard block (2026-06-19 incident) ----
  // Reserved +1999999xxxx range or any e2e/harness-marked row is terminally
  // blocked BEFORE any duplicate guard, quota, typing, evidence check, or POST.
  // These numbers are never deliverable; the scenario harness must not leak
  // unsolicited cold texts into Sendblue when run against prod.
  if (isSyntheticOutboundRecipient(toPeer, data as Record<string, unknown>)) {
    await ref.set(
      {
        status: "blocked_synthetic_recipient",
        error: "blocked: synthetic/test recipient (reserved +1999999xxxx or e2e marker)",
        blockedBySyntheticGate: true,
        updatedAt: now().toISOString(),
        expiresAtTs: outboundExpiresAtTs(now()),
      },
      { merge: true }
    )
    log("pa.outbox.blocked_synthetic_recipient", {
      severity: "WARNING",
      docId,
      userId,
      toE164: toPeer,
      runtimeSource: String((data as { runtimeSource?: unknown }).runtimeSource ?? ""),
      idempotencyKey: typeof data.idempotencyKey === "string" ? data.idempotencyKey : null,
    })
    return
  }

  // ---- 3b. Duplicate-send guard (2026-06-10 trust audit, fix 3) ----------
  // Identical body to the same user within 5 minutes that already SENT →
  // terminal status "duplicate_skipped", no POST. Rows explicitly marked
  // `allowRepeat:true` bypass (intentional repeats), and short bodies
  // (< 20 chars — acks like "ok") legitimately repeat. FAIL-OPEN on any
  // query error so the guard can never block a legitimate send.
  const allowRepeat = (data as { allowRepeat?: unknown }).allowRepeat === true
  if (!allowRepeat && body.length >= DUPLICATE_MIN_BODY_LEN) {
    const dup = await findRecentDuplicateOutbound(deps.db, {
      userId,
      body,
      excludeDocId: docId,
      nowMs: now().getTime(),
      log,
    })
    if (dup) {
      await ref.set(
        {
          status: "duplicate_skipped",
          duplicateOfDocId: dup.docId,
          updatedAt: now().toISOString(),
          expiresAtTs: outboundExpiresAtTs(now()),
        },
        { merge: true }
      )
      log("pa.outbox.duplicate_skipped", {
        docId,
        userId,
        duplicateOfDocId: dup.docId,
        bodyHash: outboundBodyHash(body),
        body_preview: body.slice(0, 120),
      })
      return
    }
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

  // ---- 4a. Headhunter outbound (runtimeSource "headhunter_mcp") — TOCTOU
  // suppression re-check. The headhunter tool checks isSuppressed before enqueue,
  // but a candidate can opt out / STOP / file a privacy request — or ops can flip
  // the global kill switch — in the minutes a row sits pending/retrying. The
  // marketplace stop gate above does NOT cover headhunter rows (different
  // idempotency-key prefix), so re-apply the fail-closed suppression gate here at
  // dequeue, mirroring the RULE 1 choke, so a queued headhunter send honors a
  // late opt-out / kill switch before the POST.
  if (String((data as { runtimeSource?: unknown }).runtimeSource ?? "") === "headhunter_mcp") {
    const sup = await isSuppressed(deps.db, userId, { kind: "recovery" })
    if (sup.suppressed) {
      const error = `headhunter outbound suppressed at dequeue: ${sup.reason}`
      await ref.set(
        {
          status: "failed",
          error,
          blockedBySuppression: true,
          updatedAt: now().toISOString(),
          expiresAtTs: outboundExpiresAtTs(now()),
        },
        { merge: true }
      )
      logOutboundFailure(log, {
        docId,
        userId,
        idempotencyKey: typeof data.idempotencyKey === "string" ? String(data.idempotencyKey) : undefined,
        lastError: error,
        attempts: Number((data as { attemptCount?: unknown }).attemptCount ?? 0),
        body,
        terminalStatus: "failed",
      })
      return
    }
  }

  // ---- 4b. RULE 1 (2026-06-11 incident) — NEVER outbound to a handle that
  // never sent us an inbound message. This is the outbox choke point: every
  // candidate-facing send funnels through here, AFTER identity resolution and
  // BEFORE any user-visible side effect (transcript append / typing / POST).
  // Exactly two exemptions:
  //   (a) dev phones (standing authorization);
  //   (b) runtimeSource "pa_identity_notice" — direct replies into the thread
  //       the inbound JUST arrived from (by construction the handle has
  //       inbound, and the events row may not have committed yet).
  // NO other bypass — not pa_operator_review, not admin.
  const ruleOneDevPhoneExempt = OUTBOX_INBOUND_EVIDENCE_EXEMPT_PHONES.has(toPeer)
  const ruleOneIdentityNoticeExempt =
    String((data as { runtimeSource?: unknown }).runtimeSource ?? "") === "pa_identity_notice"
  if (!ruleOneDevPhoneExempt && !ruleOneIdentityNoticeExempt) {
    const evidence = await hasPriorInboundEvidence(deps.db, toPeer, log)
    if (!evidence.ok) {
      const error = evidence.checkFailed
        ? "blocked: prior inbound evidence check failed (RULE 1 fail-closed)"
        : "blocked: recipient handle has no prior inbound message (RULE 1)"
      await ref.set(
        {
          status: "blocked_no_inbound",
          error,
          updatedAt: now().toISOString(),
          expiresAtTs: outboundExpiresAtTs(now()),
        },
        { merge: true }
      )
      log("pa.outbox.blocked_no_inbound", {
        severity: "ERROR",
        docId,
        userId,
        toE164: toPeer,
        runtimeSource: String((data as { runtimeSource?: unknown }).runtimeSource ?? ""),
        idempotencyKey: typeof data.idempotencyKey === "string" ? data.idempotencyKey : null,
        body_preview: body.slice(0, 120),
      })
      await createOutboundBlockedReviewItem(deps.db, {
        userId,
        toE164: toPeer,
        outboundDocId: docId,
        runtimeSource: typeof data.runtimeSource === "string" ? data.runtimeSource : undefined,
        log,
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

  // ---- 5. Daily NEW-CONTACT quota gate (Phase 26 T2, flag-driven limit) ---
  // Counts unique phone numbers contacted today, NOT total messages. A prescreen
  // conversation with 5 Q&A rounds = 1 contact. Prevents mid-conversation drops
  // that silenced Prabhnoor+Monika on 2026-06-16 (quota hit 1000/1000 messages
  // while both were mid-prescreen → closing messages failed → "You there?").
  const quotaLimit = Number(await getFlag(deps.db, "sendblueDailyQuota", { env: process.env }, 1000))
  const alreadyKnownContact = await isDailyContactKnown(deps.db, toPeer, now())
  if (!alreadyKnownContact) {
    const currentCount = await getDailyOutboundCount(deps.db, now())
    if (currentCount >= quotaLimit) {
      try { await recordAuditEvent(deps.db, { type: "quota_hardblock", channel: "imessage_sendblue", toNumber: toPeer, reason: `new_contacts=${currentCount} limit=${quotaLimit}` }) } catch {}
      await ref.set({ status: "failed", error: `sendblue daily new-contact quota reached (${currentCount}/${quotaLimit})`, updatedAt: now().toISOString(), expiresAtTs: outboundExpiresAtTs(now()) }, { merge: true })
      logOutboundFailure(log, {
        docId,
        userId,
        idempotencyKey: typeof data.idempotencyKey === "string" ? String(data.idempotencyKey) : undefined,
        lastError: `sendblue daily new-contact quota reached (${currentCount}/${quotaLimit})`,
        attempts: Number((data as { attemptCount?: unknown }).attemptCount ?? 0),
        body,
        terminalStatus: "failed",
      })
      return
    }
    if (currentCount >= Math.floor(quotaLimit * 0.8)) {
      try { await recordAuditEvent(deps.db, { type: "quota_soft", channel: "imessage_sendblue", toNumber: toPeer, reason: `new_contacts=${currentCount} limit=${quotaLimit}` }) } catch {}
    }
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
    // ---- 5c. Per-number rolling SEND cap (Adam 2026-06-15) ---------------
    // Protect THIS line from exceeding its daily Sendblue message limit: count
    // sends in the rolling window and DEFER (revert pending → the 5-min retry
    // sweep re-sends once the window frees) at (dailySendCap − buffer). Distinct
    // from the GLOBAL daily quota above. Flag-gated + fail-open: never block a
    // send on a count error or when the number has no dailySendCap configured.
    // (`sentFromNumber` is recorded below at send time; the rolling count starts
    // empty and fills over the window — a built-in gentle ramp.)
    if (
      explicitFromNumber &&
      String(await getFlag(deps.db, "sendbluePerNumberSendCapEnabled", { env: process.env }, "1")) !== "0"
    ) {
      try {
        const poolNumber = findSendbluePoolNumber(await loadSendbluePool(deps.db), explicitFromNumber)
        const cap = poolNumber ? effectiveSendCap(poolNumber) : null
        if (poolNumber && cap !== null) {
          const cutoff = sendCapWindowCutoffIso(poolNumber, now().getTime())
          const recent = await countRecentSendsForNumber(deps.db, explicitFromNumber, cutoff)
          if (recent >= cap) {
            await ref.set(
              {
                status: "pending",
                capacityDeferred: true,
                capacityDeferredAt: now().toISOString(),
                capacityDeferredReason: `per-number send cap reached (${recent}/${cap} in window) on ${explicitFromNumber}`,
                updatedAt: now().toISOString(),
                expiresAtTs: outboundExpiresAtTs(now()),
              },
              { merge: true },
            )
            log("pa.outbox.send_cap_deferred", { docId, userId, fromNumber: explicitFromNumber, recent, cap })
            return
          }
        }
      } catch (err) {
        log(
          "[sendblue][outbox] per-number send-cap check failed (fail-open, sending)",
          err instanceof Error ? err.message : String(err),
        )
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
        // Denormalized line this message was actually sent from — powers the
        // per-number rolling send-cap count (send-cap.ts).
        ...(explicitFromNumber ? { sentFromNumber: explicitFromNumber } : {}),
        ...(messageHandle ? { messageHandle, sendblueUuid: response.uuid ?? messageHandle } : {}),
        sendblueStatus: response.status,
        ...(mediaRequested
          ? { mediaRequestedUrl: mediaRequested, mediaEchoUrl: mediaEcho, mediaDropped }
          : {}),
      },
      { merge: true }
    )
    try { await incrementDailyOutbound(deps.db, now(), toPeer) } catch {}
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
    // ---- 2026-06-10 trust audit (fix 5) — HTTP 429 rate-limit handling ----
    // 429 rides SendblueServerError (sendblue-client treats it as transient).
    // Track CONSECUTIVE 429s on the row; after 3 in a row, stop hammering the
    // rate-limited account: terminal status "dead_letter_rate_limited" + a
    // `pa.outbox.rate_capped` ERROR log + a fail-soft Slack alert.
    const is429 =
      (err instanceof SendblueServerError || err instanceof SendblueClientError) &&
      err.status === 429
    if (is429) {
      const e = err as SendblueServerError
      const prev = await ref.get()
      const prevData = prev.data() as Record<string, unknown> | undefined
      const prevAttempts = Number(prevData?.attemptCount ?? 0)
      const consecutive429Count = Number(prevData?.consecutive429Count ?? 0) + 1
      if (consecutive429Count >= RATE_LIMIT_DEAD_LETTER_AFTER) {
        await ref.set(
          {
            status: "dead_letter_rate_limited",
            error: `sendblue 429: ${e.message}`,
            attemptCount: prevAttempts + 1,
            consecutive429Count,
            deadLetteredAt: now().toISOString(),
            updatedAt: now().toISOString(),
            expiresAtTs: outboundExpiresAtTs(now()),
          },
          { merge: true }
        )
        log("pa.outbox.rate_capped", {
          severity: "ERROR",
          docId,
          userId,
          consecutive429Count,
          body_preview: body.slice(0, 120),
        })
        // Fail-soft Slack alert (helper skips silently when the webhook secret is unset).
        try {
          await (deps.postSlackAlert ?? defaultPostSlackAlert)({
            level: "error",
            title: "Sendblue rate-limit dead letter",
            message: `pa-outbound row ${docId} hit ${consecutive429Count} consecutive 429s and was dead-lettered.`,
            fields: [
              { name: "userId", value: userId },
              { name: "docId", value: docId },
            ],
          })
        } catch {
          /* alert is never load-bearing */
        }
        return
      }
      log("[sendblue][outbox] 429 — release for retry", { docId, consecutive429Count })
      await ref.set(
        {
          status: "pending",
          error: `sendblue 429: ${e.message}`,
          attemptCount: prevAttempts + 1,
          consecutive429Count,
          ...(e.retryAfter ? { retryAfter: e.retryAfter } : {}),
          updatedAt: now().toISOString(),
          expiresAtTs: outboundExpiresAtTs(now()),
        },
        { merge: true }
      )
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
          // A non-429 transient breaks the CONSECUTIVE-429 streak.
          consecutive429Count: 0,
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
