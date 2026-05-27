import type { Firestore } from "firebase-admin/firestore"
import { createInboundEvent, enqueueOutbound, inboundEventDocId } from "@pa/pa-broker"

const WEKRUIT_SENDER = "+17174919939"
const PRESCREEN_TOKEN_RE = /WeKruit_([A-Za-z0-9-]+)_([A-Za-z0-9_-]+)_Job/i
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

  return result
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
  const outbound = payload.is_outbound === true || from === WEKRUIT_SENDER
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

async function recoverPrescreenTrigger(
  deps: ConversationRecoveryDeps,
  conversation: Conversation,
  token: RegExpMatchArray,
  caseId: string,
  now: Date
): Promise<"recovered" | "needs_operator_review" | "error"> {
  const inbound = conversation.latestInbound!
  const [, jobId, userId] = token as [string, string, string]
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
