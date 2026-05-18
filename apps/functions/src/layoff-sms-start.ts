import type { Firestore } from "firebase-admin/firestore"
import { FieldValue } from "firebase-admin/firestore"
import { createHash } from "node:crypto"
import { PA_COLLECTIONS } from "@pa/core-types"
import { WEKRUIT_LAYOFF_SOURCE } from "@pa/pa-orchestrator"
import { hashStringToUint } from "./sendblue/pool.js"

export const LAYOFF_SMS_TRIGGER_TEXT = "WeKruit_LAID_OFF"

export type RunLayoffSmsStartArgs = {
  db: Firestore
  userId: string
  toE164: string
  runRuntimeKickoff?: (args: {
    db: Firestore
    userId: string
    toE164: string
    startedAt: string
  }) => Promise<{ eventId: string; outboundId?: string }>
  log?: (event: string, payload?: Record<string, unknown>) => void
}

export type RunLayoffSmsStartResult =
  | {
      ok: true
      kickoffOutboundId: string
      kickoffCreated: boolean
      sourceTag: typeof WEKRUIT_LAYOFF_SOURCE
    }
  | { ok: false; reason: "user_not_found" | "missing_phone" }

function phoneIndexId(e164: string): string {
  return `p_${hashStringToUint(e164).toString(36)}`
}

export function buildLayoffOnboardingStartedFields(nowIso: string): Record<string, unknown> {
  return {
    onboardingStatus: "invited",
    onboardingState: "pending",
    pipelineState: {
      currentQId: null,
      collected: {},
      attempts: {},
      halted: null,
      completed: false,
    },
    layoffOnboardingStartedAt: nowIso,
    workSession: {
      kind: "layoff_onboarding",
      status: "active",
      startedAt: nowIso,
      boundary: LAYOFF_SMS_TRIGGER_TEXT,
    },
  }
}

function sessionDocId(userId: string, channel: "imessage", externalChatId: string): string {
  const h = createHash("sha256").update(`${userId}|${channel}|${externalChatId}`).digest("hex")
  return `ses_${h.slice(0, 32)}`
}

async function runDefaultRuntimeKickoff(args: {
  db: Firestore
  userId: string
  toE164: string
  startedAt: string
}): Promise<{ eventId: string; outboundId?: string }> {
  const { processInboundEvent, createFirestoreOrchestratorStore } = await import("@pa/pa-orchestrator")
  const { makeOrchestratorDeps } = await import("./orchestrator-deps.js")
  const sessionId = sessionDocId(args.userId, "imessage", args.toE164)
  const eventId = `layoff_runtime_${hashStringToUint(`${args.userId}:${args.startedAt}`).toString(36)}`
  const idempotencyKey = `layoff-runtime:${args.userId}:${args.startedAt}`
  const event = {
    id: eventId,
    userId: args.userId,
    sessionId,
    channel: "imessage" as const,
    externalChatId: args.toE164,
    from: args.toE164,
    body: LAYOFF_SMS_TRIGGER_TEXT,
    status: "pending" as const,
    createdAt: args.startedAt,
    idempotencyKey,
    rawMeta: {
      source: "layoff_runtime_trigger",
      trigger: LAYOFF_SMS_TRIGGER_TEXT,
    },
  }

  await processInboundEvent(event, createFirestoreOrchestratorStore(args.db, makeOrchestratorDeps()))

  let outboundId: string | undefined
  try {
    const snap = await args.db
      .collection(PA_COLLECTIONS.outbound)
      .where("idempotencyKey", "==", `outbound-onboarding-${eventId}`)
      .limit(1)
      .get()
    outboundId = snap.docs[0]?.id
  } catch {
    outboundId = undefined
  }
  return { eventId, ...(outboundId ? { outboundId } : {}) }
}

export function isLayoffIntakeActiveDoc(data: unknown): boolean {
  if (!data || typeof data !== "object") return false
  const doc = data as Record<string, unknown>
  const workSession = doc.workSession && typeof doc.workSession === "object"
    ? doc.workSession as Record<string, unknown>
    : null
  if (workSession?.kind === "layoff_onboarding" && workSession.status === "active") return true
  return doc.source === WEKRUIT_LAYOFF_SOURCE && doc.onboardingState !== "complete"
}

export async function isLayoffIntakeActiveForUser(db: Firestore, userId: string): Promise<boolean> {
  if (!userId) return false
  const snap = await db.collection(PA_COLLECTIONS.users).doc(userId).get()
  return isLayoffIntakeActiveDoc(snap.data())
}

export async function supersedeActivePrescreensForLayoff(
  db: Firestore,
  input: { candidateId: string; nowIso: string },
): Promise<void> {
  const sessionsCollection = db.collection("pa-prescreen-sessions")
  if (typeof (sessionsCollection as unknown as { where?: unknown }).where !== "function") return
  const snap = await sessionsCollection
    .where("userId", "==", input.candidateId)
    .where("terminal", "==", null)
    .get()
  await Promise.all(
    snap.docs.map((doc) =>
      doc.ref.set(
        {
          terminal: "PAUSE",
          terminalReason: "superseded_by_layoff_onboarding",
          currentQId: null,
          supersededAt: input.nowIso,
          updatedAt: input.nowIso,
          workSession: {
            kind: "job_prescreen",
            status: "ended",
            endedAt: input.nowIso,
            boundary: "superseded",
            supersededBy: "layoff_onboarding",
          },
        },
        { merge: true },
      ),
    ),
  )
}

/**
 * Shared layoff kickoff path for both layoff.wekruit.com callables and the
 * inbound SMS trigger. The product invariant is one pa-users row, one source
 * flag, one Claire opener.
 */
export async function runLayoffSmsStart(
  args: RunLayoffSmsStartArgs,
): Promise<RunLayoffSmsStartResult> {
  const userRef = args.db.collection(PA_COLLECTIONS.users).doc(args.userId)
  const userSnap = await userRef.get()
  if (!userSnap.exists) return { ok: false, reason: "user_not_found" }

  const user = userSnap.data() as Record<string, unknown>
  const phoneE164 = args.toE164 || (typeof user.phoneE164 === "string" ? user.phoneE164 : "")
  if (!phoneE164) return { ok: false, reason: "missing_phone" }

  const startedAt = new Date().toISOString()
  const startedFields = buildLayoffOnboardingStartedFields(startedAt)
  const phoneHash = phoneIndexId(phoneE164)

  await userRef.set(
    {
      source: WEKRUIT_LAYOFF_SOURCE,
      lastLaidOffAt: FieldValue.serverTimestamp(),
      updatedAt: startedAt,
      smsState: "layoff-onboarding-starting",
      smsThreadId: `iMessage;-;${phoneE164}`,
      layoffContext: {
        phoneE164,
        smsTriggeredAt: FieldValue.serverTimestamp(),
      },
      ...startedFields,
    },
    { merge: true },
  )
  await userRef.update({ workSession: startedFields.workSession })
  await args.db.collection("layoff_phone_index").doc(phoneHash).set(
    {
      candidateId: args.userId,
      lastLaidOffAt: FieldValue.serverTimestamp(),
      phoneHash,
    },
    { merge: true },
  )
  const pendingTriggerRef = args.db.collection("pa-ats-pending-trigger").doc(phoneE164)
  const deletePendingTrigger = (pendingTriggerRef as unknown as { delete?: () => Promise<unknown> }).delete
  if (typeof deletePendingTrigger === "function") {
    await deletePendingTrigger.call(pendingTriggerRef).catch(() => undefined)
  }
  await supersedeActivePrescreensForLayoff(args.db, {
    candidateId: args.userId,
    nowIso: startedAt,
  })

  const runtimeKickoff = await (args.runRuntimeKickoff ?? runDefaultRuntimeKickoff)({
    db: args.db,
    userId: args.userId,
    toE164: phoneE164,
    startedAt,
  })

  await userRef.set(
    {
      source: WEKRUIT_LAYOFF_SOURCE,
      lastLaidOffAt: FieldValue.serverTimestamp(),
      updatedAt: new Date().toISOString(),
      smsState: "runtime-kickoff-enqueued",
      smsKickoffAt: FieldValue.serverTimestamp(),
      smsThreadId: `iMessage;-;${phoneE164}`,
      kickoffRuntimeEventId: runtimeKickoff.eventId,
      kickoffOutboundId: runtimeKickoff.outboundId ?? runtimeKickoff.eventId,
    },
    { merge: true },
  )

  args.log?.("layoff.sms_start.enqueued", {
    userId: args.userId,
    kickoffRuntimeEventId: runtimeKickoff.eventId,
    kickoffOutboundId: runtimeKickoff.outboundId ?? null,
    created: true,
  })

  return {
    ok: true,
    kickoffOutboundId: runtimeKickoff.outboundId ?? runtimeKickoff.eventId,
    kickoffCreated: true,
    sourceTag: WEKRUIT_LAYOFF_SOURCE,
  }
}
