import { getFirestore, type Firestore } from "firebase-admin/firestore"
import { defineSecret } from "firebase-functions/params"
import { HttpsError, onCall } from "firebase-functions/v2/https"
import { z } from "zod"
import { PA_COLLECTIONS } from "@pa/core-types"
import { authorizeAdminCallable } from "./promote-sandbox-tag.js"

const PA_ADMIN_TOKEN = defineSecret("PA_ADMIN_TOKEN")

export const AdminIdentityConflictsInputSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("resolve"),
    conflictIds: z.array(z.string().min(1)).min(1).max(200),
    status: z.enum(["resolved", "dismissed"]),
    note: z.string().transform((value) => value.trim()).pipe(z.string().max(2_000)).optional(),
    adminToken: z.string().optional(),
  }),
  z.object({
    action: z.literal("counts"),
    adminToken: z.string().optional(),
  }),
])
export type AdminIdentityConflictsInput = z.infer<typeof AdminIdentityConflictsInputSchema>

export type AdminIdentityConflictsResolveResult = {
  ok: true
  action: "resolve"
  status: "resolved" | "dismissed"
  updated: number
  skipped: number
}

export type AdminIdentityConflictsCountsResult = {
  ok: true
  action: "counts"
  total: number
  byStatus: Record<string, number>
  byHandleKind: Record<string, number>
}

export type AdminIdentityConflictsResult =
  | AdminIdentityConflictsResolveResult
  | AdminIdentityConflictsCountsResult

function bump(record: Record<string, number>, key: string): void {
  record[key] = (record[key] ?? 0) + 1
}

async function runCounts(db: Firestore): Promise<AdminIdentityConflictsCountsResult> {
  const snap = await db
    .collection(PA_COLLECTIONS.candidateIdentityConflicts)
    .select("status", "handleKind")
    .get()
  const byStatus: Record<string, number> = {}
  const byHandleKind: Record<string, number> = {}
  for (const doc of snap.docs) {
    const raw = (doc.data() ?? {}) as Record<string, unknown>
    bump(byStatus, typeof raw.status === "string" && raw.status ? raw.status : "open")
    bump(byHandleKind, typeof raw.handleKind === "string" && raw.handleKind ? raw.handleKind : "unknown")
  }
  return { ok: true, action: "counts", total: snap.size, byStatus, byHandleKind }
}

async function runResolve(
  db: Firestore,
  input: Extract<AdminIdentityConflictsInput, { action: "resolve" }>,
  deps: { now?: () => string; actorEmail?: string },
): Promise<AdminIdentityConflictsResolveResult> {
  const ts = deps.now?.() ?? new Date().toISOString()
  const resolvedBy = deps.actorEmail?.trim() || "admin_token"
  const note = input.note?.trim()
  let updated = 0
  let skipped = 0
  for (const conflictId of Array.from(new Set(input.conflictIds))) {
    const ref = db.collection(PA_COLLECTIONS.candidateIdentityConflicts).doc(conflictId)
    const snap = await ref.get()
    if (!snap.exists) {
      skipped += 1
      continue
    }
    const raw = (snap.data() ?? {}) as Record<string, unknown>
    if (raw.status === input.status) {
      skipped += 1
      continue
    }
    await ref.set(
      {
        status: input.status,
        resolvedAt: ts,
        resolvedBy,
        updatedAt: ts,
        ...(note ? { resolutionNote: note } : {}),
      },
      { merge: true },
    )
    updated += 1
  }
  return { ok: true, action: "resolve", status: input.status, updated, skipped }
}

export async function runAdminIdentityConflicts(
  raw: unknown,
  deps: { db: Firestore; now?: () => string; actorEmail?: string },
): Promise<AdminIdentityConflictsResult> {
  const parsed = AdminIdentityConflictsInputSchema.safeParse(raw)
  if (!parsed.success) {
    throw new HttpsError("invalid-argument", parsed.error.message)
  }
  if (parsed.data.action === "counts") {
    return runCounts(deps.db)
  }
  return runResolve(deps.db, parsed.data, deps)
}

export const paAdminIdentityConflictsResolve = onCall(
  { region: "us-central1", memory: "256MiB", timeoutSeconds: 60, maxInstances: 1, secrets: [PA_ADMIN_TOKEN] },
  async (req) => {
    authorizeAdminCallable(req as { auth?: { token?: { admin?: unknown } }; data?: unknown })
    const actorEmail = typeof req.auth?.token?.email === "string" ? req.auth.token.email : undefined
    return runAdminIdentityConflicts(req.data, { db: getFirestore(), actorEmail })
  },
)
