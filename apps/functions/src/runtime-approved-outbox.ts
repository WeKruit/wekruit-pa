import { createHash } from "node:crypto"
import type { Firestore } from "firebase-admin/firestore"
import { enqueueOutbound } from "@pa/pa-broker"

export type RuntimeApprovedIMessageInput = {
  db: Firestore
  userId: string
  to: string
  content: string
  runtimeSource: string
  idempotencyKey?: string
}

export type RuntimeApprovedIMessageResult = {
  outboundId: string
  created: boolean
}

function fallbackIdempotencyKey(input: RuntimeApprovedIMessageInput): string {
  const hash = createHash("sha256")
    .update(`${input.runtimeSource}|${input.userId}|${input.to}|${input.content}`, "utf8")
    .digest("hex")
  return `${input.runtimeSource}:${input.userId}:${hash.slice(0, 32)}`
}

export async function enqueueRuntimeApprovedIMessage(
  input: RuntimeApprovedIMessageInput,
): Promise<RuntimeApprovedIMessageResult> {
  const idempotencyKey = input.idempotencyKey?.trim() || fallbackIdempotencyKey(input)
  const result = await enqueueOutbound(input.db, {
    userId: input.userId,
    toE164: input.to,
    body: input.content,
    idempotencyKey,
    runtimeApproved: true,
    runtimeSource: input.runtimeSource,
  })
  return { outboundId: result.id, created: result.created }
}

export async function sendRuntimeApprovedIMessage(args: {
  db?: Firestore
  userId?: string
  to: string
  content: string
  runtimeSource?: string
  idempotencyKey?: string
}): Promise<RuntimeApprovedIMessageResult> {
  if (!args.db) throw new Error("runtime-approved send requires Firestore db")
  if (!args.userId) throw new Error("runtime-approved send requires userId")
  return enqueueRuntimeApprovedIMessage({
    db: args.db,
    userId: args.userId,
    to: args.to,
    content: args.content,
    runtimeSource: args.runtimeSource ?? "pa_runtime",
    idempotencyKey: args.idempotencyKey,
  })
}
