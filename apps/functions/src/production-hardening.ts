import { getFirestore, type Firestore } from "firebase-admin/firestore"
import { defineSecret } from "firebase-functions/params"
import { HttpsError, onCall } from "firebase-functions/v2/https"
import { z } from "zod"
import {
  LaunchReadinessSnapshotSchema,
  OutreachStopControlSchema,
  PA_COLLECTIONS,
  PrivacyRequestKindSchema,
  PrivacyRequestSchema,
  createLaunchReadinessSnapshotId,
  createPrivacyRequestId,
  type LaunchReadinessSnapshot,
  type OutreachStopControl,
  type PrivacyRequest,
} from "@pa/core-types"
import {
  writeLaunchReadinessSnapshot,
  writeOutreachStopControl,
  writePrivacyRequest,
} from "@pa/pa-persistence"
import { sanitizeEvalPayload } from "./flywheel-eval.js"
import { authorizeAdminCallable } from "./promote-sandbox-tag.js"

const PA_ADMIN_TOKEN = defineSecret("PA_ADMIN_TOKEN")

type CallableAuth = {
  uid?: string
}

const CandidatePrivacyRequestInputSchema = z.object({
  kind: PrivacyRequestKindSchema,
  detailText: z.string().trim().max(2_000).optional(),
  sourceSurface: z.literal("me_profile").default("me_profile"),
})
export type CandidatePrivacyRequestInput = z.input<typeof CandidatePrivacyRequestInputSchema>

const AdminLaunchReadinessInputSchema = z.object({
  limit: z.number().int().min(1).max(100).default(25),
  persistSnapshot: z.boolean().default(true),
  adminToken: z.string().optional(),
})

const AdminOutreachStopControlInputSchema = z
  .object({
    scope: z.enum(["global", "outreach_batch"]).default("global"),
    scopeId: z.string().trim().min(1).max(200).optional(),
    paused: z.boolean(),
    reason: z.string().trim().min(1).max(1_000).optional(),
    expiresAt: z.string().trim().min(1).optional(),
    adminToken: z.string().optional(),
  })
  .superRefine((value, ctx) => {
    if (value.scope === "global" && value.scopeId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["scopeId"],
        message: "global outreach stop control must not include scopeId",
      })
    }
    if (value.scope === "outreach_batch" && !value.scopeId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["scopeId"],
        message: "outreach_batch stop control requires scopeId",
      })
    }
    if (value.paused && !value.reason?.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["reason"],
        message: "paused outreach stop control requires a reason",
      })
    }
  })

export type CandidatePrivacyRequestResult = {
  ok: true
  candidateId: string
  requestId: string
  kind: PrivacyRequest["kind"]
  status: PrivacyRequest["status"]
  created: boolean
  existingOpen: boolean
}

export type AdminLaunchReadinessResult = {
  ok: true
  snapshot: LaunchReadinessSnapshot
  persisted: boolean
  created: boolean
}

export type AdminOutreachStopControlResult = {
  ok: true
  control: OutreachStopControl
  previous: OutreachStopControl | null
  changed: boolean
  auditEventId: string
}

function cleanString(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > max) return undefined
  return trimmed
}

function safeDetailRedacted(input: z.infer<typeof CandidatePrivacyRequestInputSchema>): Record<string, unknown> {
  const note = input.detailText ? sanitizeEvalPayload(input.detailText) : undefined
  return {
    requestKind: input.kind,
    sourceSurface: input.sourceSurface,
    ...(typeof note === "string" ? { note } : {}),
  }
}

async function getCandidateIdForAuth(db: Firestore, firebaseUid: string): Promise<string> {
  const snap = await db.collection(PA_COLLECTIONS.candidateAuth).doc(firebaseUid).get()
  if (!snap.exists) {
    throw new HttpsError("failed-precondition", "Signed-in account is not linked to a candidate profile.")
  }
  const candidateId = cleanString(snap.data()?.candidateId, 200)
  if (!candidateId) {
    throw new HttpsError("failed-precondition", "Signed-in account is not linked to a candidate profile.")
  }
  return candidateId
}

export async function runCandidatePrivacyRequest(
  data: unknown,
  auth: CallableAuth | undefined,
  deps: { db: Firestore; now?: () => string },
): Promise<CandidatePrivacyRequestResult> {
  const firebaseUid = cleanString(auth?.uid, 128)
  if (!firebaseUid) {
    throw new HttpsError("unauthenticated", "Sign in before submitting privacy requests.")
  }

  const parsed = CandidatePrivacyRequestInputSchema.safeParse(data)
  if (!parsed.success) {
    throw new HttpsError("invalid-argument", parsed.error.message)
  }

  const candidateId = await getCandidateIdForAuth(deps.db, firebaseUid)
  const createdAt = deps.now?.() ?? new Date().toISOString()
  const request = PrivacyRequestSchema.parse({
    requestId: createPrivacyRequestId({
      candidateId,
      kind: parsed.data.kind,
      createdAt,
    }),
    kind: parsed.data.kind,
    status: "submitted",
    candidateId,
    sourceSurface: parsed.data.sourceSurface,
    requestedBy: "candidate",
    detailRedacted: safeDetailRedacted(parsed.data),
    evidence: [{ source: "system", summary: "Candidate submitted privacy request from profile" }],
    createdAt,
  })
  const result = await writePrivacyRequest(deps.db, request)
  return {
    ok: true,
    candidateId,
    requestId: result.request.requestId,
    kind: result.request.kind,
    status: result.request.status,
    created: result.created,
    existingOpen: result.existingOpen,
  }
}

async function loadRecent<T>(
  db: Firestore,
  collectionName: string,
  limit: number,
  parse: (data: unknown) => T | null,
): Promise<T[]> {
  const snap = await db.collection(collectionName).limit(limit).get()
  return snap.docs.flatMap((doc) => {
    const parsed = parse(doc.data())
    return parsed ? [parsed] : []
  })
}

function newestFirst<T>(rows: T[], getTimestamp: (row: T) => string | undefined): T[] {
  return [...rows].sort((a, b) => String(getTimestamp(b) ?? "").localeCompare(String(getTimestamp(a) ?? "")))
}

export async function runAdminLaunchReadinessSnapshot(
  raw: unknown,
  deps: { db: Firestore; now?: () => string },
): Promise<AdminLaunchReadinessResult> {
  const parsed = AdminLaunchReadinessInputSchema.safeParse(raw)
  if (!parsed.success) throw new HttpsError("invalid-argument", parsed.error.message)

  const generatedAt = deps.now?.() ?? new Date().toISOString()
  const limit = parsed.data.limit
  const [privacyRowsRaw, stopControlsRaw] = await Promise.all([
    loadRecent(deps.db, PA_COLLECTIONS.privacyRequests, limit, (data) => {
      const out = PrivacyRequestSchema.safeParse(data)
      return out.success ? out.data : null
    }),
    loadRecent(deps.db, PA_COLLECTIONS.outreachStopControls, limit, (data) => {
      const out = OutreachStopControlSchema.safeParse(data)
      return out.success ? out.data : null
    }),
  ])
  const privacyRows = newestFirst(privacyRowsRaw, (row) => row.updatedAt ?? row.createdAt).slice(0, limit)
  const stopControls = newestFirst(stopControlsRaw, (row) => row.updatedAt ?? row.createdAt).slice(0, limit)
  const openPrivacy = privacyRows.filter((row) => row.status === "submitted" || row.status === "in_review")
  const pausedControls = stopControls.filter((row) => row.paused)
  const globalPaused = pausedControls.some((row) => row.scope === "global")
  const status = globalPaused ? "red" : openPrivacy.length > 0 || pausedControls.length > 0 ? "yellow" : "green"

  const snapshot = LaunchReadinessSnapshotSchema.parse({
    snapshotId: createLaunchReadinessSnapshotId(generatedAt, "admin_launch_readiness"),
    generatedAt,
    status,
    counts: {
      privacyTotal: privacyRows.length,
      privacyOpen: openPrivacy.length,
      stopControls: stopControls.length,
      pausedControls: pausedControls.length,
      globalPaused: globalPaused ? 1 : 0,
    },
    sections: [
      {
        key: "privacy_requests",
        label: "Privacy requests",
        status: openPrivacy.length > 0 ? "yellow" : "green",
        count: openPrivacy.length,
        summary: openPrivacy.length > 0
          ? `${openPrivacy.length} open privacy request(s) need operator review`
          : "No open privacy requests",
        sourceRoute: "/admin/launch-readiness",
        updatedAt: generatedAt,
      },
      {
        key: "outreach_stop_controls",
        label: "Outreach stop controls",
        status: globalPaused ? "red" : pausedControls.length > 0 ? "yellow" : "green",
        count: pausedControls.length,
        summary: globalPaused
          ? "Global marketplace outreach is paused"
          : pausedControls.length > 0
            ? `${pausedControls.length} scoped outreach stop control(s) are paused`
            : "No active outreach stop controls",
        sourceRoute: "/admin/launch-readiness",
        updatedAt: generatedAt,
      },
      {
        key: "delivery_gate",
        label: "Delivery gate",
        status: globalPaused ? "red" : "green",
        summary: globalPaused
          ? "Marketplace outreach delivery is blocked before transcript, typing, quota, and Sendblue calls"
          : "Marketplace outreach delivery gate is open",
        sourceRoute: "/admin/launch-readiness",
        updatedAt: generatedAt,
      },
    ],
    privacyRequests: privacyRows.map((row) => ({
      requestId: row.requestId,
      kind: row.kind,
      status: row.status,
      candidateId: row.candidateId,
      sourceSurface: row.sourceSurface,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    })),
    stopControls: stopControls.map((row) => ({
      controlId: row.controlId,
      scope: row.scope,
      scopeId: row.scopeId,
      paused: row.paused,
      reason: row.reason,
      updatedAt: row.updatedAt ?? row.createdAt,
    })),
    evidence: [{ source: "admin", summary: "Redacted launch readiness snapshot generated" }],
  })

  if (!parsed.data.persistSnapshot) {
    return { ok: true, snapshot, persisted: false, created: false }
  }
  const write = await writeLaunchReadinessSnapshot(deps.db, snapshot)
  return { ok: true, snapshot: write.snapshot, persisted: true, created: write.created }
}

export async function runAdminOutreachStopControl(
  raw: unknown,
  actorUid: string,
  deps: { db: Firestore; now?: () => string },
): Promise<AdminOutreachStopControlResult> {
  const parsed = AdminOutreachStopControlInputSchema.safeParse(raw)
  if (!parsed.success) throw new HttpsError("invalid-argument", parsed.error.message)
  const now = deps.now?.() ?? new Date().toISOString()
  const result = await writeOutreachStopControl(deps.db, {
    scope: parsed.data.scope,
    scopeId: parsed.data.scopeId,
    paused: parsed.data.paused,
    reason: parsed.data.reason,
    actor: "operator",
    now,
    expiresAt: parsed.data.expiresAt,
  })
  return {
    ok: true,
    control: result.control,
    previous: result.previous,
    changed: result.changed,
    auditEventId: result.auditEventId,
  }
}

export const paCandidatePrivacyRequest = onCall(
  { region: "us-central1", memory: "256MiB", timeoutSeconds: 30 },
  async (req): Promise<CandidatePrivacyRequestResult> => {
    return runCandidatePrivacyRequest(req.data, req.auth, { db: getFirestore() })
  },
)

export const paAdminLaunchReadinessSnapshot = onCall(
  { region: "us-central1", memory: "256MiB", timeoutSeconds: 60, secrets: [PA_ADMIN_TOKEN] },
  async (req): Promise<AdminLaunchReadinessResult> => {
    authorizeAdminCallable(req as { auth?: { token?: { admin?: unknown } }; data?: unknown })
    return runAdminLaunchReadinessSnapshot(req.data, { db: getFirestore() })
  },
)

export const paAdminOutreachStopControl = onCall(
  { region: "us-central1", memory: "256MiB", timeoutSeconds: 30, secrets: [PA_ADMIN_TOKEN] },
  async (req): Promise<AdminOutreachStopControlResult> => {
    const { uid } = authorizeAdminCallable(req as { auth?: { token?: { admin?: unknown } }; data?: unknown })
    return runAdminOutreachStopControl(req.data, uid || "admin", { db: getFirestore() })
  },
)
