import type { Firestore } from "firebase-admin/firestore"
import { FieldValue } from "firebase-admin/firestore"
import { createHash } from "node:crypto"
import { PA_COLLECTIONS } from "@pa/core-types"
import {
  WEKRUIT_LAYOFF_SOURCE,
  WEKRUIT_CANDIDATE_SOURCE,
  type WekruitSignupSource,
} from "@pa/pa-orchestrator"
import { hashStringToUint } from "./sendblue/pool.js"

export const LAYOFF_SMS_TRIGGER_TEXT = "WeKruit_LAID_OFF"
export const CANDIDATE_SMS_TRIGGER_TEXT = "WeKruit_CANDIDATE_HI"

function triggerTextFor(source: WekruitSignupSource): string {
  return source === WEKRUIT_LAYOFF_SOURCE ? LAYOFF_SMS_TRIGGER_TEXT : CANDIDATE_SMS_TRIGGER_TEXT
}

export type RunLayoffSmsStartArgs = {
  db: Firestore
  userId: string
  toE164: string
  /** Defaults to WEKRUIT_LAYOFF_SOURCE for back-compat with existing callers. */
  source?: WekruitSignupSource
  runRuntimeKickoff?: (args: {
    db: Firestore
    userId: string
    toE164: string
    startedAt: string
    source: WekruitSignupSource
  }) => Promise<{ eventId: string; outboundId?: string }>
  log?: (event: string, payload?: Record<string, unknown>) => void
}

export type RunLayoffSmsStartResult =
  | {
      ok: true
      kickoffOutboundId: string
      kickoffCreated: boolean
      sourceTag: WekruitSignupSource
    }
  | { ok: false; reason: "user_not_found" | "missing_phone" }

function phoneIndexId(e164: string): string {
  return `p_${hashStringToUint(e164).toString(36)}`
}

export function buildOnboardingStartedFields(
  nowIso: string,
  source: WekruitSignupSource = WEKRUIT_LAYOFF_SOURCE,
): Record<string, unknown> {
  const isLayoff = source === WEKRUIT_LAYOFF_SOURCE
  const trigger = triggerTextFor(source)
  const fields: Record<string, unknown> = {
    onboardingStatus: "invited",
    onboardingState: "pending",
    pipelineState: {
      currentQId: null,
      collected: {},
      attempts: {},
      halted: null,
      completed: false,
    },
    workSession: {
      kind: isLayoff ? "layoff_onboarding" : "normal_onboarding",
      status: "active",
      startedAt: nowIso,
      boundary: trigger,
    },
  }
  if (isLayoff) fields.layoffOnboardingStartedAt = nowIso
  else fields.candidateOnboardingStartedAt = nowIso
  return fields
}

/** Back-compat alias — existing callers still want the layoff-flavored fields. */
export function buildLayoffOnboardingStartedFields(nowIso: string): Record<string, unknown> {
  return buildOnboardingStartedFields(nowIso, WEKRUIT_LAYOFF_SOURCE)
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
  source: WekruitSignupSource
}): Promise<{ eventId: string; outboundId?: string }> {
  const { processInboundEvent, createFirestoreOrchestratorStore } = await import("@pa/pa-orchestrator")
  const { makeOrchestratorDeps } = await import("./orchestrator-deps.js")
  const sessionId = sessionDocId(args.userId, "imessage", args.toE164)
  const eventPrefix = args.source === WEKRUIT_LAYOFF_SOURCE ? "layoff_runtime" : "candidate_runtime"
  const idemPrefix = args.source === WEKRUIT_LAYOFF_SOURCE ? "layoff-runtime" : "candidate-runtime"
  const triggerSource =
    args.source === WEKRUIT_LAYOFF_SOURCE ? "layoff_runtime_trigger" : "candidate_runtime_trigger"
  const trigger = triggerTextFor(args.source)
  const eventId = `${eventPrefix}_${hashStringToUint(`${args.userId}:${args.startedAt}`).toString(36)}`
  const idempotencyKey = `${idemPrefix}:${args.userId}:${args.startedAt}`
  const event = {
    id: eventId,
    userId: args.userId,
    sessionId,
    channel: "imessage" as const,
    externalChatId: args.toE164,
    from: args.toE164,
    body: trigger,
    status: "pending" as const,
    createdAt: args.startedAt,
    idempotencyKey,
    rawMeta: {
      source: triggerSource,
      trigger,
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
 * Shared kickoff path for both layoff.wekruit.com and candidate.wekruit.com.
 * The product invariant is one pa-users row, one source flag, one Claire opener.
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

  const source: WekruitSignupSource = args.source ?? WEKRUIT_LAYOFF_SOURCE
  const isLayoff = source === WEKRUIT_LAYOFF_SOURCE

  const startedAt = new Date().toISOString()
  const startedFields = buildOnboardingStartedFields(startedAt, source)
  const phoneHash = phoneIndexId(phoneE164)

  const initialPayload: Record<string, unknown> = {
    source,
    updatedAt: startedAt,
    smsState: isLayoff ? "layoff-onboarding-starting" : "candidate-onboarding-starting",
    smsThreadId: `iMessage;-;${phoneE164}`,
    ...startedFields,
  }
  if (isLayoff) {
    initialPayload.lastLaidOffAt = FieldValue.serverTimestamp()
    initialPayload.layoffContext = {
      phoneE164,
      smsTriggeredAt: FieldValue.serverTimestamp(),
    }
  } else {
    initialPayload.candidateContext = {
      phoneE164,
      smsTriggeredAt: FieldValue.serverTimestamp(),
    }
  }

  await userRef.set(initialPayload, { merge: true })
  await userRef.update({ workSession: startedFields.workSession })

  if (isLayoff) {
    await args.db.collection("layoff_phone_index").doc(phoneHash).set(
      {
        candidateId: args.userId,
        lastLaidOffAt: FieldValue.serverTimestamp(),
        phoneHash,
      },
      { merge: true },
    )
  }

  const pendingTriggerRef = args.db.collection("pa-ats-pending-trigger").doc(phoneE164)
  const deletePendingTrigger = (pendingTriggerRef as unknown as { delete?: () => Promise<unknown> }).delete
  if (typeof deletePendingTrigger === "function") {
    await deletePendingTrigger.call(pendingTriggerRef).catch(() => undefined)
  }
  if (isLayoff) {
    await supersedeActivePrescreensForLayoff(args.db, {
      candidateId: args.userId,
      nowIso: startedAt,
    })
  }

  const runtimeKickoff = await (args.runRuntimeKickoff ?? runDefaultRuntimeKickoff)({
    db: args.db,
    userId: args.userId,
    toE164: phoneE164,
    startedAt,
    source,
  })

  const followupPayload: Record<string, unknown> = {
    source,
    updatedAt: new Date().toISOString(),
    smsState: "runtime-kickoff-enqueued",
    smsKickoffAt: FieldValue.serverTimestamp(),
    smsThreadId: `iMessage;-;${phoneE164}`,
    kickoffRuntimeEventId: runtimeKickoff.eventId,
    kickoffOutboundId: runtimeKickoff.outboundId ?? runtimeKickoff.eventId,
  }
  if (isLayoff) followupPayload.lastLaidOffAt = FieldValue.serverTimestamp()
  await userRef.set(followupPayload, { merge: true })

  args.log?.(isLayoff ? "layoff.sms_start.enqueued" : "candidate.sms_start.enqueued", {
    userId: args.userId,
    kickoffRuntimeEventId: runtimeKickoff.eventId,
    kickoffOutboundId: runtimeKickoff.outboundId ?? null,
    source,
    created: true,
  })

  return {
    ok: true,
    kickoffOutboundId: runtimeKickoff.outboundId ?? runtimeKickoff.eventId,
    kickoffCreated: true,
    sourceTag: source,
  }
}
