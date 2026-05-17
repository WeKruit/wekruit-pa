import type { Firestore } from "firebase-admin/firestore"
import { FieldValue } from "firebase-admin/firestore"
import { enqueueOutbound as defaultEnqueueOutbound } from "@pa/pa-broker"
import { PA_COLLECTIONS } from "@pa/core-types"
import { WEKRUIT_LAYOFF_SOURCE, composeLayoffFirstMessage } from "@pa/pa-orchestrator"
import { hashStringToUint } from "./sendblue/pool.js"

export const LAYOFF_SMS_TRIGGER_TEXT = "WeKruit_LAID_OFF"

type EnqueueOutbound = typeof defaultEnqueueOutbound

export type RunLayoffSmsStartArgs = {
  db: Firestore
  userId: string
  toE164: string
  enqueueOutbound?: EnqueueOutbound
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

function firstNameFromUser(user: Record<string, unknown>): string {
  const displayName = typeof user.displayName === "string" ? user.displayName.trim() : ""
  if (displayName) return displayName.split(/\s+/)[0] ?? "there"
  const firstName = typeof user.firstName === "string" ? user.firstName.trim() : ""
  return firstName || "there"
}

function layoffContextFromUser(user: Record<string, unknown>): Record<string, unknown> {
  const ctx = user.layoffContext
  return ctx && typeof ctx === "object" && !Array.isArray(ctx)
    ? (ctx as Record<string, unknown>)
    : {}
}

function phoneIndexId(e164: string): string {
  return `p_${hashStringToUint(e164).toString(36)}`
}

export function buildLayoffOnboardingStartedFields(nowIso: string): Record<string, unknown> {
  return {
    onboardingStatus: "invited",
    onboardingState: "q_role_asked",
    pipelineState: {
      currentQId: "q_role",
      collected: {},
      attempts: {},
      halted: null,
      lang: "en",
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

  const ctx = layoffContextFromUser(user)
  const firstName = firstNameFromUser(user)
  const lastCompany = typeof ctx.lastCompany === "string" ? ctx.lastCompany : undefined
  const body = composeLayoffFirstMessage({ firstName, lastCompany })
  const enqueueOutbound = args.enqueueOutbound ?? defaultEnqueueOutbound
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

  const enqueueResult = await enqueueOutbound(args.db, {
    userId: args.userId,
    toE164: phoneE164,
    imessageChatId: `iMessage;-;${phoneE164}`,
    body,
    idempotencyKey: `wekruit_open_layoff:${args.userId}:kickoff:${startedAt}`,
  })

  await userRef.set(
    {
      source: WEKRUIT_LAYOFF_SOURCE,
      lastLaidOffAt: FieldValue.serverTimestamp(),
      updatedAt: new Date().toISOString(),
      smsState: "kickoff-enqueued",
      smsKickoffAt: FieldValue.serverTimestamp(),
      smsThreadId: `iMessage;-;${phoneE164}`,
      kickoffOutboundId: enqueueResult.id,
    },
    { merge: true },
  )

  args.log?.("layoff.sms_start.enqueued", {
    userId: args.userId,
    kickoffOutboundId: enqueueResult.id,
    created: enqueueResult.created,
  })

  return {
    ok: true,
    kickoffOutboundId: enqueueResult.id,
    kickoffCreated: enqueueResult.created,
    sourceTag: WEKRUIT_LAYOFF_SOURCE,
  }
}
