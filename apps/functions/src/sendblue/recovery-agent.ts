import type { Firestore } from "firebase-admin/firestore"
import { createInboundEvent, enqueueOutbound, inboundEventDocId } from "@pa/pa-broker"
import { isBindCode } from "@pa/pa-orchestrator"
import { postSlackAlert as defaultPostSlackAlert } from "../lib/slack-alert.js"
import { classifyInboundReplyNeed } from "./ack-classifier.js"

// Durable marker collection written by the transport when a turn is acknowledged
// via tapback / no_reply (claire-agent/transport.ts PA_INBOUND_ACK_COLLECTION).
// Declared as a literal here (NOT imported from transport.ts) so the recovery
// sweep's boot graph never pulls the claire-agent SDK chain. MUST stay in sync.
const PA_INBOUND_ACK_COLLECTION = "pa-inbound-acks"

// 2026-06-11 CORRECTED: 717 IS the live inbound number (243/243 real inbound
// msgs in 48h arrive on it, incl. 28 brand-new contacts; 305 receives ZERO).
// The earlier dead-number theory was wrong — the real fault was the webhook's
// E.164 sender gate dropping Apple ID EMAIL senders (fixed in webhook.ts).
// ALL pool numbers must be here — `from ∈ set` is the outbound-mirror fallback
// when is_outbound is missing; a missing entry makes the recovery sweep treat
// our own sends as candidate inbound. (TODO: derive from pa-config/sendblue-pool.)
const WEKRUIT_SENDERS = new Set(["+17174919939", "+13054507715", "+16146202403"])
// Prescreen token, BOTH forms (2026-06-13): JOB-ONLY `WeKruit_<jobId>_Job` (no
// uid — phone-is-auth; group 2 undefined) and legacy `WeKruit_<jobId>_<uid>_Job`.
// jobId is hyphen-only `[A-Za-z0-9-]` (no underscore) so the optional uid is
// unambiguous. When the uid is absent the recovery path resolves identity from
// the inbound PHONE (see recoverPrescreenTrigger).
const PRESCREEN_TOKEN_RE = /WeKruit_([A-Za-z0-9-]+)(?:_([A-Za-z0-9_-]+))?_Job/i
const E164_RE = /^\+[1-9]\d{7,14}$/
const RAW_COLLECTION = "pa-sendblue-webhook-raw"
const CASE_COLLECTION = "pa-recovery-cases"
const OUTBOUND_COLLECTION = "pa-outbound"
const USERS_COLLECTION = "pa-users"
const INBOUND_COLLECTION = "pa-inbound-events"

export type RecoverySweepResult = {
  scannedRaw: number
  conversations: number
  candidates: number
  recovered: number
  verified: number
  needsOperatorReview: number
  skippedExisting: number
  errors: number
  /** 2026-06-10 trust audit (fix 11) — unanswered-inbound ops-queue rows written this run. */
  unansweredQueued?: number
}

export type StartPrescreenInput = {
  jobId: string
  userId: string
  toE164: string
}

export type StartPrescreenResult = {
  ok: boolean
  sessionId?: string
  reason?: string
}

export type ConversationRecoveryDeps = {
  db: Firestore
  now?: () => Date
  rawLimit?: number
  recoveryLimit?: number
  verifyLimit?: number
  log?: (...args: unknown[]) => void
  processInboundEventById?: (eventId: string) => Promise<void>
  startPrescreen?: (input: StartPrescreenInput) => Promise<StartPrescreenResult>
  enqueueOutbound?: typeof enqueueOutbound
  createInboundEvent?: typeof createInboundEvent
  /** Slack alert seam (tests inject a recorder); production = the shared helper. */
  postSlackAlert?: typeof defaultPostSlackAlert
  /**
   * Gate for the unanswered-inbound ALERT (NOT the ops-queue row — that always
   * writes). 2026-06-14 (Adam): DEFAULT ON. Set env `PA_UNANSWERED_ALERT_ENABLED`
   * to a falsy value (0/false/no/off) to disable; explicit dep value wins (tests).
   */
  unansweredAlertEnabled?: boolean
  /**
   * Age (ms) past which an unanswered inbound is flagged. 2026-06-14 (Adam:
   * "6h is too long"): default 60min, overridable via env `PA_UNANSWERED_AFTER_MIN`;
   * explicit dep value wins (tests).
   */
  unansweredAfterMs?: number
}

type ParsedWebhook = {
  rawId: string
  receivedAt: string
  messageAt: string
  from: string | null
  to: string | null
  peer: string
  content: string
  outbound: boolean
  status: string | null
  service: string | null
  messageHandle: string | null
  originalPayload: Record<string, unknown>
}

type Conversation = {
  phone: string
  latestInbound: ParsedWebhook | null
  latestOutbound: ParsedWebhook | null
}

type RecoveryClass =
  | "true_silent_inbound"
  | "phone_identity_mismatch"
  | "prescreen_idempotent_no_session_or_outbound"
  | "prescreen_token_needs_operator_review"
  | "ordinary_inbound_needs_operator_review"
  | "non_e164_sender_rejected"

type CaseStatus =
  | "recovered"
  | "verification_pending"
  | "verified"
  | "needs_operator_review"
  | "failed"

function emptyResult(): RecoverySweepResult {
  return {
    scannedRaw: 0,
    conversations: 0,
    candidates: 0,
    recovered: 0,
    verified: 0,
    needsOperatorReview: 0,
    skippedExisting: 0,
    errors: 0,
  }
}

export async function paConversationRecoverySweepHandler(
  deps: ConversationRecoveryDeps
): Promise<RecoverySweepResult> {
  const log = deps.log ?? console.log
  const now = deps.now ?? (() => new Date())
  const result = emptyResult()

  result.verified = await verifyPendingRecoveryCases(deps, now())

  const rawLimit = deps.rawLimit ?? 10_000
  const recoveryLimit = deps.recoveryLimit ?? 50
  let rawSnap
  try {
    rawSnap = await deps.db
      .collection(RAW_COLLECTION)
      .orderBy("receivedAt", "desc")
      .limit(rawLimit)
      .get()
  } catch (err) {
    log("[sendblue][recovery-agent] raw query failed", err instanceof Error ? err.message : String(err))
    result.errors++
    return result
  }
  result.scannedRaw = rawSnap.size ?? rawSnap.docs.length

  const conversations = buildConversations(rawSnap.docs as Array<{ id: string; data: () => Record<string, unknown> }>)
  result.conversations = conversations.size
  const candidates = [...conversations.values()]
    .filter((conversation) => {
      if (!conversation.latestInbound) return false
      if (!conversation.latestOutbound) return true
      return conversation.latestInbound.messageAt > conversation.latestOutbound.messageAt
    })
    .sort((a, b) => b.latestInbound!.messageAt.localeCompare(a.latestInbound!.messageAt))
    .slice(0, recoveryLimit)
  result.candidates = candidates.length

  for (const conversation of candidates) {
    // eslint-disable-next-line no-await-in-loop
    const outcome = await recoverConversation(deps, conversation, now())
    if (outcome === "recovered") result.recovered++
    else if (outcome === "needs_operator_review") result.needsOperatorReview++
    else if (outcome === "skipped_existing") result.skippedExisting++
    else result.errors++
  }

  // 2026-06-10 trust audit (fix 11) — unanswered-inbound ops queue. Fail-soft:
  // an error here must never break the raw-webhook recovery above.
  try {
    result.unansweredQueued = await sweepUnansweredInboundForOperatorReview(deps)
  } catch (err) {
    log("[sendblue][recovery-agent] unanswered-inbound sweep failed (non-fatal)",
      err instanceof Error ? err.message : String(err))
    result.errors++
  }

  return result
}

// ---------------------------------------------------------------------------
// 2026-06-10 trust audit (fix 11) — unanswered-inbound ops queue.
//
// Detect users whose LATEST pa-inbound-events user message is >6h old with NO
// assistant outbound (pa-outbound row) after it, and queue a
// `needs_operator_review` pa-recovery-cases row — the existing operator-review
// mechanism — rather than auto-sending anything. Deduped per
// (userId, latest-inbound-id) via the deterministic case doc id, so each
// stale inbound is queued exactly once no matter how many sweeps run.
// ---------------------------------------------------------------------------

// TUNING (2026-06-14, Adam "6h is too long"): default age threshold lowered to
// 60min. Overridable per-run (deps.unansweredAfterMs) or via env
// PA_UNANSWERED_AFTER_MIN (minutes) with no redeploy.
const DEFAULT_UNANSWERED_AFTER_MIN = 60
/** Escalate the batched alert to error-level when the oldest unanswered crosses this. */
const UNANSWERED_ESCALATE_HOURS = 12
function resolveUnansweredAfterMs(deps: ConversationRecoveryDeps): number {
  if (typeof deps.unansweredAfterMs === "number" && deps.unansweredAfterMs > 0) {
    return deps.unansweredAfterMs
  }
  const envMin = Number.parseFloat((process.env.PA_UNANSWERED_AFTER_MIN ?? "").trim())
  const minutes = Number.isFinite(envMin) && envMin > 0 ? envMin : DEFAULT_UNANSWERED_AFTER_MIN
  return minutes * 60 * 1000
}
const UNANSWERED_SCAN_LIMIT = 300
const UNANSWERED_WRITE_CAP = 25
// Sample size for the batched alert (mask + list this many users; count is exact).
const ALERT_SAMPLE_SIZE = 5
// Dashboard surface that lists needs_operator_review recovery cases.
const OPS_DASHBOARD_LINK = "https://wekruit-pa.web.app/admin/prescreen-ops"

function unansweredCaseId(userId: string, inboundEventId: string): string {
  return `unanswered_${userId}_${inboundEventId}`
}

/** Mask a phone for the alert: keep country + last 2 (e.g. +1•••••••39). */
function maskPhone(phone: string | null | undefined): string {
  const p = (phone ?? "").trim()
  if (!p) return "unknown"
  if (p.length <= 4) return p
  const cc = p.startsWith("+") ? p.slice(0, 2) : p.slice(0, 1)
  return `${cc}${"•".repeat(Math.max(3, p.length - cc.length - 2))}${p.slice(-2)}`
}

export async function sweepUnansweredInboundForOperatorReview(
  deps: ConversationRecoveryDeps
): Promise<number> {
  const log = deps.log ?? console.log
  const now = deps.now ?? (() => new Date())
  const nowMs = now().getTime()
  const afterMs = resolveUnansweredAfterMs(deps)

  let docs: Array<{ id: string; data: () => Record<string, unknown> | undefined }>
  try {
    const snap = await deps.db
      .collection(INBOUND_COLLECTION)
      .orderBy("createdAt", "desc")
      .limit(UNANSWERED_SCAN_LIMIT)
      .get()
    docs = snap.docs as typeof docs
  } catch (err) {
    log("[sendblue][recovery-agent] unanswered scan query failed", err instanceof Error ? err.message : String(err))
    return 0
  }

  // Latest inbound per user (scan is createdAt-desc so first hit wins).
  const latestByUser = new Map<string, { eventId: string; createdAt: string; data: Record<string, unknown> }>()
  for (const doc of docs) {
    const data = (doc.data() ?? {}) as Record<string, unknown>
    const userId = typeof data.userId === "string" ? data.userId : ""
    const createdAt = typeof data.createdAt === "string" ? data.createdAt : ""
    if (!userId || !createdAt) continue
    if (!latestByUser.has(userId)) latestByUser.set(userId, { eventId: doc.id, createdAt, data })
  }

  // Cases NEWLY queued THIS run — drives the batched alert (one alert per sweep,
  // never one-per-user). Each entry is alerted exactly once (alertedAt idempotency).
  const newlyQueued: Array<{ userId: string; eventId: string; phone: string | null; ageHours: number }> = []
  let queued = 0
  for (const [userId, latest] of latestByUser) {
    if (queued >= UNANSWERED_WRITE_CAP) break
    const inboundMs = Date.parse(latest.createdAt)
    if (!Number.isFinite(inboundMs) || nowMs - inboundMs <= afterMs) continue

    const caseId = unansweredCaseId(userId, latest.eventId)
    // eslint-disable-next-line no-await-in-loop
    const existing = await deps.db.collection(CASE_COLLECTION).doc(caseId).get()
    if (existing.exists) continue

    // "UNLESS something we know we don't need to respond to" (Adam): a latest
    // inbound that is a PURE ACK ('thanks'/'ok'/'👍') or STOP/opt-out genuinely
    // awaits no real reply — Claire correctly tapbacks an ack, and the STOP gate
    // owns opt-outs. Excluding them keeps the alert focused on inbound that truly
    // needs a human. A GREETING still awaits a TEXT reply (greeting carve-out), so
    // it is NOT excluded. followsClaireMessage = does any prior outbound exist for
    // this user at all (a bare ack with no preceding Claire turn = engage, not skip).
    const text = typeof latest.data.body === "string" ? latest.data.body : ""
    const phone = typeof latest.data.from === "string" ? latest.data.from : null

    // Any pa-outbound row for this user created AT/after the inbound counts as
    // an answer attempt (pending/sending included — the outbox owns delivery).
    // We ALSO use the full outbound set to know whether ANY prior Claire turn
    // exists (followsClaireMessage) for the ack classifier.
    let answered = false
    let hasAnyPriorOutbound = false
    try {
      let outDocs: Array<{ id: string; data: () => Record<string, unknown> | undefined }>
      try {
        // eslint-disable-next-line no-await-in-loop
        const outSnap = await deps.db
          .collection(OUTBOUND_COLLECTION)
          .where("userId", "==", userId)
          .orderBy("createdAt", "desc")
          .limit(5)
          .get()
        outDocs = outSnap.docs as typeof outDocs
      } catch {
        // Composite index missing → single-field query, compare client-side.
        // eslint-disable-next-line no-await-in-loop
        const outSnap = await deps.db
          .collection(OUTBOUND_COLLECTION)
          .where("userId", "==", userId)
          .limit(50)
          .get()
        outDocs = outSnap.docs as typeof outDocs
      }
      hasAnyPriorOutbound = outDocs.length > 0
      answered = outDocs.some((d) => {
        const od = (d.data() ?? {}) as Record<string, unknown>
        const createdAt = typeof od.createdAt === "string" ? od.createdAt : ""
        return Boolean(createdAt) && createdAt >= latest.createdAt
      })
    } catch (err) {
      log("[sendblue][recovery-agent] unanswered outbound check failed (skip user)", {
        userId,
        err: err instanceof Error ? err.message : String(err),
      })
      continue
    }
    if (answered) continue

    // EXCLUDE acks / STOP: those genuinely need no reply.
    const replyNeed = classifyInboundReplyNeed(text, { followsClaireMessage: hasAnyPriorOutbound })
    if (replyNeed === "pure_ack" || replyNeed === "stop") {
      log("[sendblue][recovery-agent] unanswered inbound excluded (no reply owed)", {
        userId,
        inboundEventId: latest.eventId,
        replyNeed,
      })
      continue
    }

    // EXCLUDE tapbacked / no_reply'd: Claire acknowledged this exact inbound via a
    // tapback (or a deliberate no_reply), which writes a durable pa-inbound-acks
    // marker but no pa-outbound row. That is a handled turn, not a dropped one.
    try {
      // eslint-disable-next-line no-await-in-loop
      const ackSnap = await deps.db.collection(PA_INBOUND_ACK_COLLECTION).doc(latest.eventId).get()
      if (ackSnap.exists) {
        log("[sendblue][recovery-agent] unanswered inbound excluded (acknowledged via tapback/no_reply)", {
          userId,
          inboundEventId: latest.eventId,
          via: String((ackSnap.data() as { via?: unknown } | undefined)?.via ?? ""),
        })
        continue
      }
    } catch {
      // Ack-marker read failure → fall through (better to over-alert than miss).
    }

    // eslint-disable-next-line no-await-in-loop
    await deps.db.collection(CASE_COLLECTION).doc(caseId).set(
      stripUndefined({
        id: caseId,
        className: "unanswered_inbound_needs_operator_review",
        action: "none",
        status: "needs_operator_review",
        reason: "no_assistant_outbound_after_inbound",
        userId,
        inboundEventId: latest.eventId,
        latestInboundAt: latest.createdAt,
        latestInboundText: text.slice(0, 500),
        phone,
        createdAt: now().toISOString(),
        updatedAt: now().toISOString(),
      }),
      { merge: true }
    )
    queued++
    const ageHours = Math.round(((nowMs - inboundMs) / 3_600_000) * 10) / 10
    newlyQueued.push({ userId, eventId: latest.eventId, phone, ageHours })
    log("[sendblue][recovery-agent] unanswered inbound queued for operator review", {
      caseId,
      userId,
      inboundEventId: latest.eventId,
      ageHours,
    })
  }

  // ── BATCHED ALERT ─────────────────────────────────────────────────────────
  // ONE alert summarizing the N users newly queued this run (never N alerts).
  // Idempotent: each case carries `alertedAt` after it's covered by an alert, so a
  // re-run never re-alerts the same case (the dedup-on-case-id already prevents
  // re-queue; this guards a case queued in a PRIOR run but not yet alerted, e.g. if
  // the alert was disabled then enabled). Fail-soft: the slack helper never throws
  // and silently no-ops when PA_SLACK_ALERT_WEBHOOK is unset.
  if (newlyQueued.length > 0) {
    await fireUnansweredAlert(deps, newlyQueued, now)
  }
  return queued
}

/**
 * True when the unanswered-inbound alert should fire. 2026-06-14 (Adam):
 * DEFAULT ON — only an explicit falsy env (0/false/no/off) disables it.
 * Explicit dep value always wins (tests).
 */
function unansweredAlertEnabled(deps: ConversationRecoveryDeps): boolean {
  if (typeof deps.unansweredAlertEnabled === "boolean") return deps.unansweredAlertEnabled
  const raw = (process.env.PA_UNANSWERED_ALERT_ENABLED ?? "").trim().toLowerCase()
  if (raw === "0" || raw === "false" || raw === "no" || raw === "off") return false
  return true
}

/**
 * Post ONE batched Slack alert for the unanswered users queued this run, then
 * stamp `alertedAt` on each covered case so it's never re-alerted. Opt-in gated;
 * when disabled we still stamp NOTHING and just skip (so flipping the flag on later
 * surfaces the still-open cases). Fully fail-soft.
 */
async function fireUnansweredAlert(
  deps: ConversationRecoveryDeps,
  newlyQueued: Array<{ userId: string; eventId: string; phone: string | null; ageHours: number }>,
  now: () => Date,
): Promise<void> {
  const log = deps.log ?? console.log
  if (!unansweredAlertEnabled(deps)) {
    log("[sendblue][recovery-agent] unanswered alert skipped (not opted in)", {
      count: newlyQueued.length,
    })
    return
  }
  const alert = deps.postSlackAlert ?? defaultPostSlackAlert
  const count = newlyQueued.length
  const oldest = newlyQueued.reduce((m, c) => Math.max(m, c.ageHours), 0)
  const thresholdHours = Math.round((resolveUnansweredAfterMs(deps) / 3_600_000) * 10) / 10
  // Escalate to error-level once the oldest unanswered text crosses the
  // escalation window — a candidate ghosted that long is a churn risk.
  const level: "warn" | "error" = oldest >= UNANSWERED_ESCALATE_HOURS ? "error" : "warn"
  const sample = newlyQueued
    .slice()
    .sort((a, b) => b.ageHours - a.ageHours)
    .slice(0, ALERT_SAMPLE_SIZE)
    .map((c) => `${c.userId.slice(0, 8)} (${maskPhone(c.phone)}, ${c.ageHours}h)`)
    .join("\n")

  try {
    await alert({
      level,
      title: `${count} candidate text${count === 1 ? "" : "s"} unanswered >${thresholdHours}h`,
      message:
        `${count} candidate${count === 1 ? "" : "s"} sent a message that genuinely awaits a reply ` +
        `and got none for over ${thresholdHours}h. Pure acks ('thanks'/'👍'), STOP, and tapbacked messages are excluded.`,
      fields: [
        { name: "Unanswered users", value: String(count) },
        { name: "Oldest", value: `${oldest}h` },
        { name: "Sample", value: sample || "—" },
      ],
      link: OPS_DASHBOARD_LINK,
    })
    log("[sendblue][recovery-agent] unanswered alert posted", { count, oldestHours: oldest })
  } catch (err) {
    log("[sendblue][recovery-agent] unanswered alert failed (non-fatal)", {
      err: err instanceof Error ? err.message : String(err),
    })
  }

  // Stamp `alertedAt` on every case covered by this alert. The case is deduped on
  // (userId, eventId) so it never re-queues, but the marker makes "already alerted"
  // explicit for the dashboard + future audit. Best-effort, per-case fail-soft.
  const nowIso = now().toISOString()
  for (const c of newlyQueued) {
    const caseId = unansweredCaseId(c.userId, c.eventId)
    try {
      // eslint-disable-next-line no-await-in-loop
      await deps.db.collection(CASE_COLLECTION).doc(caseId).set({ alertedAt: nowIso }, { merge: true })
    } catch {
      /* marker stamp is non-load-bearing */
    }
  }
}

function buildConversations(docs: Array<{ id: string; data: () => Record<string, unknown> }>): Map<string, Conversation> {
  const conversations = new Map<string, Conversation>()
  for (const doc of docs) {
    const parsed = parseRawWebhookDoc(doc)
    if (!parsed?.peer || !E164_RE.test(parsed.peer)) continue
    const current = conversations.get(parsed.peer) ?? {
      phone: parsed.peer,
      latestInbound: null,
      latestOutbound: null,
    }
    if (!parsed.outbound && (!current.latestInbound || parsed.messageAt > current.latestInbound.messageAt)) {
      current.latestInbound = parsed
    }
    if (parsed.outbound && (!current.latestOutbound || parsed.messageAt > current.latestOutbound.messageAt)) {
      current.latestOutbound = parsed
    }
    conversations.set(parsed.peer, current)
  }
  return conversations
}

function parseRawWebhookDoc(doc: { id: string; data: () => Record<string, unknown> }): ParsedWebhook | null {
  const data = doc.data() ?? {}
  let payload: Record<string, unknown> | null = null
  if (typeof data.bodyText === "string") {
    try {
      payload = JSON.parse(data.bodyText) as Record<string, unknown>
    } catch {
      payload = null
    }
  } else if (data.payload && typeof data.payload === "object") {
    payload = data.payload as Record<string, unknown>
  }
  if (!payload) return null

  const from = cleanString(payload.from_number, 120)
  const to = cleanString(payload.to_number, 120)
  const content = cleanString(payload.content, 4_000) ?? ""
  const outbound = payload.is_outbound === true || (from !== null && WEKRUIT_SENDERS.has(from))
  const peer = outbound ? to : from
  if (!peer) return null
  const receivedAt = cleanString(data.receivedAt, 80) ?? timestampToIso(data.receivedAt) ?? ""
  const messageAt = cleanString(payload.date_sent, 80) ?? receivedAt

  return {
    rawId: doc.id,
    receivedAt,
    messageAt,
    from,
    to,
    peer,
    content,
    outbound,
    status: cleanString(payload.status, 80),
    service: cleanString(payload.service, 40),
    messageHandle: cleanString(payload.message_handle, 240),
    originalPayload: payload,
  }
}

async function recoverConversation(
  deps: ConversationRecoveryDeps,
  conversation: Conversation,
  now: Date
): Promise<"recovered" | "needs_operator_review" | "skipped_existing" | "error"> {
  const inbound = conversation.latestInbound
  if (!inbound) return "error"
  const caseId = recoveryCaseId(inbound.rawId)
  const caseRef = deps.db.collection(CASE_COLLECTION).doc(caseId)
  const existing = await caseRef.get()
  if (existing.exists) {
    const status = String((existing.data() as { status?: unknown } | undefined)?.status ?? "")
    if (["recovered", "verification_pending", "verified", "needs_operator_review"].includes(status)) {
      return "skipped_existing"
    }
  }

  const token = inbound.content.match(PRESCREEN_TOKEN_RE)
  if (!E164_RE.test(inbound.from ?? "")) {
    await writeRecoveryCase(deps, caseId, now, inbound, {
      className: "non_e164_sender_rejected",
      action: "none",
      status: "needs_operator_review",
      reason: "non_e164_sender",
    })
    return "needs_operator_review"
  }

  if (token) {
    return recoverPrescreenTrigger(deps, conversation, token, caseId, now)
  }

  return recoverOrdinaryInbound(deps, conversation, caseId, now)
}

async function recoverOrdinaryInbound(
  deps: ConversationRecoveryDeps,
  conversation: Conversation,
  caseId: string,
  now: Date
): Promise<"recovered" | "needs_operator_review" | "error"> {
  const inbound = conversation.latestInbound!
  const handle = inbound.messageHandle
  if (!handle) {
    await writeRecoveryCase(deps, caseId, now, inbound, {
      className: "ordinary_inbound_needs_operator_review",
      action: "none",
      status: "needs_operator_review",
      reason: "missing_message_handle",
    })
    return "needs_operator_review"
  }

  const eventId = inboundEventDocId(`sendblue-${handle}`)
  const eventSnap = await deps.db.collection(INBOUND_COLLECTION).doc(eventId).get()
  if (!eventSnap.exists) {
    if (!deps.processInboundEventById) {
      await writeRecoveryCase(deps, caseId, now, inbound, {
        className: "ordinary_inbound_needs_operator_review",
        action: "none",
        status: "needs_operator_review",
        reason: "missing_inbound_event_process_not_wired",
        inboundEventId: eventId,
      })
      return "needs_operator_review"
    }

    const broker = deps.createInboundEvent ?? createInboundEvent
    const created = await broker(deps.db, {
      channel: "imessage",
      idempotencyKey: `sendblue-${handle}`,
      coalescing: true,
      rawPayload: {
        kind: "imessage",
        source: "sendblue",
        fromNumber: inbound.from,
        toNumber: inbound.to,
        text: inbound.content,
        chatId: `iMessage;-;${inbound.from}`,
        messageHandle: handle,
        service: inbound.service === "SMS" ? "SMS" : "iMessage",
        participant: inbound.from,
        original: inbound.originalPayload,
        recoveryCreatedFromRaw: true,
      },
    })
    await deps.processInboundEventById(created.id)
    await deps.db.collection(INBOUND_COLLECTION).doc(created.id).set(
      {
        coalescing: false,
        recoveryCreatedFromRaw: true,
        recoveryCaseId: caseId,
        recoveryProcessedAt: now.toISOString(),
      },
      { merge: true }
    )
    await writeRecoveryCase(deps, caseId, now, inbound, {
      className: "true_silent_inbound",
      action: "create_and_replay_inbound_event",
      status: "verification_pending",
      inboundEventId: created.id,
      inboundEventCreated: created.created,
    })
    return "recovered"
  }

  const eventData = eventSnap.data() as { status?: unknown; leaseUntil?: unknown } | undefined
  const status = typeof eventData?.status === "string" ? eventData.status : ""
  const claimable =
    status === "pending" ||
    status === "failed" ||
    ((status === "running" || status === "processing") && isLeaseExpired(eventData?.leaseUntil, now))

  if (!claimable) {
    await writeRecoveryCase(deps, caseId, now, inbound, {
      className: "ordinary_inbound_needs_operator_review",
      action: "none",
      status: "needs_operator_review",
      reason: `inbound_event_not_claimable:${status || "unknown"}`,
      inboundEventId: eventId,
    })
    return "needs_operator_review"
  }

  if (!deps.processInboundEventById) {
    await writeRecoveryCase(deps, caseId, now, inbound, {
      className: "ordinary_inbound_needs_operator_review",
      action: "none",
      status: "needs_operator_review",
      reason: "process_inbound_event_not_wired",
      inboundEventId: eventId,
    })
    return "needs_operator_review"
  }

  await deps.processInboundEventById(eventId)
  await writeRecoveryCase(deps, caseId, now, inbound, {
    className: "true_silent_inbound",
    action: "replay_inbound_event",
    status: "verification_pending",
    inboundEventId: eventId,
  })
  return "recovered"
}

/**
 * Resolve a pa-users doc id from the inbound phone (phone-is-auth identity for
 * the JOB-ONLY prescreen token, which carries no uid). Deterministic single-doc
 * pick: a phone resolving to >1 doc is an identity-dup; never silently grab
 * docs[0] (Firestore implicit order is doc-name asc → a newer orphan could
 * hijack), so we route ambiguous multi-matches to operator review by returning
 * null. Single match → that doc id.
 */
async function resolveUserIdByPhone(
  deps: ConversationRecoveryDeps,
  phoneE164: string | null,
): Promise<string | null> {
  if (!phoneE164 || !E164_RE.test(phoneE164)) return null
  try {
    const snap = await deps.db
      .collection(USERS_COLLECTION)
      .where("phoneE164", "==", phoneE164)
      .limit(2)
      .get()
    if (snap.size === 1) return snap.docs[0]!.id
  } catch {
    /* fall through → null → operator review */
  }
  return null
}

async function recoverPrescreenTrigger(
  deps: ConversationRecoveryDeps,
  conversation: Conversation,
  token: RegExpMatchArray,
  caseId: string,
  now: Date
): Promise<"recovered" | "needs_operator_review" | "error"> {
  const inbound = conversation.latestInbound!
  const [, jobId, rawSegment] = token as [string, string, string | undefined]
  // PHONE-IS-AUTH (2026-06-13): the JOB-ONLY token carries no uid; identity comes
  // from the inbound PHONE. A BIND-CODE segment (2026-06-14 website-first bridge)
  // is ALSO phone-resolved here — by the time recovery runs the code was already
  // consumed by the live webhook (which bound the phone to the web candidate), so
  // resolving by phone returns that same web candidate. A bind code is never a
  // usable uid, so we must NOT treat it as one. Legacy raw uid tokens keep using
  // the token uid (back-compat). Either way the resolved doc is verified below.
  const tokenUserId = rawSegment && isBindCode(rawSegment) ? undefined : rawSegment
  const userId = tokenUserId ?? (await resolveUserIdByPhone(deps, inbound.from))
  if (!userId) {
    await writeRecoveryCase(deps, caseId, now, inbound, {
      className: "prescreen_token_needs_operator_review",
      action: "none",
      status: "needs_operator_review",
      reason: "phone_not_resolved",
      jobId,
    })
    return "needs_operator_review"
  }
  const userSnap = await deps.db.collection(USERS_COLLECTION).doc(userId).get()
  const user = userSnap.exists ? (userSnap.data() as { phoneE164?: unknown } | undefined) : undefined
  const userPhone = cleanString(user?.phoneE164, 120)

  if (!userSnap.exists) {
    await writeRecoveryCase(deps, caseId, now, inbound, {
      className: "prescreen_token_needs_operator_review",
      action: "none",
      status: "needs_operator_review",
      reason: "target_user_missing",
      jobId,
      userId,
    })
    return "needs_operator_review"
  }

  if (userPhone && userPhone !== inbound.from) {
    const send = deps.enqueueOutbound ?? enqueueOutbound
    const outbound = await send(deps.db, {
      userId,
      toE164: inbound.from!,
      ...(inbound.to ? { fromNumber: inbound.to } : {}),
      body: "I couldn't start that screen from this phone because the link is tied to a different WeKruit profile number. Please open it from the phone number on your profile, or reply here with your name/email and I'll help reconnect it.",
      idempotencyKey: `out-sendblue-prescreen-identity-conflict-${inbound.messageHandle ?? inbound.rawId}`,
      runtimeApproved: true,
      runtimeSource: "pa_identity_notice",
    })
    await writeRecoveryCase(deps, caseId, now, inbound, {
      className: "phone_identity_mismatch",
      action: "send_identity_notice",
      status: "verification_pending",
      reason: "profile_phone_mismatch",
      jobId,
      userId,
      userPhoneE164: userPhone,
      outboundId: outbound.id,
      outboundCreated: outbound.created,
    })
    return "recovered"
  }

  const idempotencyKey = `${jobId}_${userId}_${inbound.messageHandle || "missing_message_handle"}`
  const [idempotencySnap, outboundSnap, sessionSnap, stateSnap] = await Promise.all([
    deps.db.collection("pa-prescreen-trigger-idempotency").doc(idempotencyKey).get(),
    deps.db.collection(OUTBOUND_COLLECTION).where("toE164", "==", inbound.from).limit(50).get(),
    deps.db.collection("pa-prescreen-sessions").where("userId", "==", userId).limit(50).get(),
    deps.db
      .collection("pa-candidate-job-states")
      .where("userId", "==", userId)
      .where("jobId", "==", jobId)
      .limit(20)
      .get(),
  ])
  const sessionsForJob = (sessionSnap.docs as Array<{ id: string; data: () => Record<string, unknown> }>)
    .map((doc): Record<string, unknown> & { id: string } => ({ id: doc.id, ...(doc.data() ?? {}) }))
    .filter((session) => session.jobId === jobId || session.paJobId === jobId)
  const outboundAfterInbound = (outboundSnap.docs as Array<{ id: string; data: () => Record<string, unknown> }>)
    .map((doc): Record<string, unknown> & { id: string } => ({ id: doc.id, ...(doc.data() ?? {}) }))
    .filter((outbound) => isAtOrAfter(outbound.createdAt ?? outbound.queuedAt ?? outbound.updatedAt, inbound.messageAt))

  if (idempotencySnap.exists && sessionsForJob.length === 0 && outboundAfterInbound.length === 0 && stateSnap.empty) {
    if (!deps.startPrescreen) {
      await writeRecoveryCase(deps, caseId, now, inbound, {
        className: "prescreen_idempotent_no_session_or_outbound",
        action: "none",
        status: "needs_operator_review",
        reason: "start_prescreen_not_wired",
        jobId,
        userId,
      })
      return "needs_operator_review"
    }
    const started = await deps.startPrescreen({ jobId, userId, toE164: inbound.from! })
    await writeRecoveryCase(deps, caseId, now, inbound, {
      className: "prescreen_idempotent_no_session_or_outbound",
      action: "start_prescreen",
      status: started.ok ? "recovered" : "failed",
      reason: started.reason,
      jobId,
      userId,
      prescreenSessionId: started.sessionId,
    })
    return started.ok ? "recovered" : "error"
  }

  await writeRecoveryCase(deps, caseId, now, inbound, {
    className: "prescreen_token_needs_operator_review",
    action: "none",
    status: "needs_operator_review",
    reason: "prescreen_state_not_deterministic",
    jobId,
    userId,
    idempotencyExists: idempotencySnap.exists,
    sessionCount: sessionsForJob.length,
    outboundAfterInbound: outboundAfterInbound.length,
    candidateJobStateCount: stateSnap.size,
  })
  return "needs_operator_review"
}

async function verifyPendingRecoveryCases(deps: ConversationRecoveryDeps, now: Date): Promise<number> {
  const verifyLimit = deps.verifyLimit ?? 100
  const snap = await deps.db
    .collection(CASE_COLLECTION)
    .where("status", "==", "verification_pending")
    .limit(verifyLimit)
    .get()
  let verified = 0
  let verificationRaw: ParsedWebhook[] | null = null
  for (const doc of snap.docs) {
    const data = (doc.data() ?? {}) as Record<string, unknown>
    const outboundId = cleanString(data.outboundId, 240)
    let verification: { outboundStatus?: string; sendblueStatus?: string; messageHandle?: unknown } | null = null

    if (outboundId) {
      // eslint-disable-next-line no-await-in-loop
      const outboundSnap = await deps.db.collection(OUTBOUND_COLLECTION).doc(outboundId).get()
      if (!outboundSnap.exists) continue
      const outbound = outboundSnap.data() as { status?: unknown; sendblueStatus?: unknown; messageHandle?: unknown } | undefined
      const sendblueStatus = typeof outbound?.sendblueStatus === "string" ? outbound.sendblueStatus.toUpperCase() : ""
      const outboxStatus = typeof outbound?.status === "string" ? outbound.status : ""
      if (sendblueStatus === "DELIVERED" || sendblueStatus === "SENT" || outboxStatus === "sent") {
        verification = {
          outboundStatus: outboxStatus || undefined,
          sendblueStatus: sendblueStatus || undefined,
          messageHandle: outbound?.messageHandle,
        }
      }
    } else {
      const phone = cleanString(data.phone, 120)
      const inboundAt = cleanString(data.latestInboundAt, 80)
      if (!phone || !inboundAt) continue
      if (!verificationRaw) {
        // eslint-disable-next-line no-await-in-loop
        const rawSnap = await deps.db
          .collection(RAW_COLLECTION)
          .orderBy("receivedAt", "desc")
          .limit(deps.rawLimit ?? 10_000)
          .get()
        verificationRaw = (rawSnap.docs as Array<{ id: string; data: () => Record<string, unknown> }>)
          .map(parseRawWebhookDoc)
          .filter((row): row is ParsedWebhook => Boolean(row))
      }
      const outbound = verificationRaw.find((row) =>
        row.outbound &&
        row.peer === phone &&
        row.messageAt > inboundAt &&
        isDeliveredStatus(row.status)
      )
      if (outbound) {
        verification = {
          sendblueStatus: outbound.status?.toUpperCase(),
          messageHandle: outbound.messageHandle,
        }
      }
    }

    if (verification) {
      // eslint-disable-next-line no-await-in-loop
      await deps.db.collection(CASE_COLLECTION).doc(doc.id).set(
        {
          status: "verified",
          verifiedAt: now.toISOString(),
          outboundStatus: verification.outboundStatus ?? null,
          sendblueStatus: verification.sendblueStatus ?? null,
          messageHandle: verification.messageHandle ?? null,
          updatedAt: now.toISOString(),
        },
        { merge: true }
      )
      verified++
    }
  }
  return verified
}

function isDeliveredStatus(status: string | null): boolean {
  const normalized = status?.toUpperCase()
  return normalized === "DELIVERED" || normalized === "SENT"
}

async function writeRecoveryCase(
  deps: ConversationRecoveryDeps,
  caseId: string,
  now: Date,
  inbound: ParsedWebhook,
  patch: {
    className: RecoveryClass
    action: string
    status: CaseStatus
    reason?: unknown
    [key: string]: unknown
  }
): Promise<void> {
  await deps.db.collection(CASE_COLLECTION).doc(caseId).set(
    stripUndefined({
      id: caseId,
      phone: inbound.peer,
      latestInboundRawId: inbound.rawId,
      latestInboundAt: inbound.messageAt,
      latestInboundText: inbound.content.slice(0, 500),
      messageHandle: inbound.messageHandle ?? null,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      ...patch,
    }),
    { merge: true }
  )
}

function recoveryCaseId(rawId: string): string {
  return `sendblue_${rawId}`
}

function isAtOrAfter(value: unknown, floorIso: string): boolean {
  const iso = timestampToIso(value) ?? cleanString(value, 80)
  if (!iso || !floorIso) return true
  return iso >= floorIso
}

function isLeaseExpired(value: unknown, now: Date): boolean {
  const iso = timestampToIso(value) ?? cleanString(value, 80)
  if (!iso) return true
  return iso <= now.toISOString()
}

function cleanString(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null
  const trimmed = value.trim()
  return trimmed ? trimmed.slice(0, max) : null
}

function timestampToIso(value: unknown): string | null {
  if (value && typeof (value as { toDate?: unknown }).toDate === "function") {
    return (value as { toDate: () => Date }).toDate().toISOString()
  }
  if (value && typeof (value as { _seconds?: unknown })._seconds === "number") {
    return new Date((value as { _seconds: number })._seconds * 1000).toISOString()
  }
  return null
}

function stripUndefined(input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) out[key] = value
  }
  return out
}
