import type { Firestore } from "firebase-admin/firestore"
import { FieldValue } from "firebase-admin/firestore"
import { enqueueOutbound as defaultEnqueueOutbound } from "@pa/pa-broker"
import { PA_COLLECTIONS } from "@pa/core-types"
import { WEKRUIT_LAYOFF_SOURCE, composeLayoffFirstMessage } from "@pa/pa-orchestrator"

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
  const enqueueResult = await enqueueOutbound(args.db, {
    userId: args.userId,
    toE164: phoneE164,
    imessageChatId: `iMessage;-;${phoneE164}`,
    body,
    idempotencyKey: `wekruit_open_layoff:${args.userId}:kickoff`,
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
      layoffContext: {
        phoneE164,
        smsTriggeredAt: FieldValue.serverTimestamp(),
      },
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
