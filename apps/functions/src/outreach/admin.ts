import { getFirestore, type Firestore, type Query } from "firebase-admin/firestore"
import { defineSecret } from "firebase-functions/params"
import { HttpsError, onCall } from "firebase-functions/v2/https"
import { z } from "zod"
import {
  OutboundInviteSchema,
  PA_COLLECTIONS,
  type OutboundInvite,
  type OutboundInviteCapacitySnapshot,
} from "@pa/core-types"
import { authorizeAdminCallable } from "../promote-sandbox-tag.js"

const PA_ADMIN_TOKEN = defineSecret("PA_ADMIN_TOKEN")

export const AdminOutreachOpsSnapshotInputSchema = z.object({
  jobId: z.string().min(1).optional(),
  status: z.string().min(1).optional(),
  approvalState: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(200).default(50),
  adminToken: z.string().optional(),
})
export type AdminOutreachOpsSnapshotInput = z.infer<typeof AdminOutreachOpsSnapshotInputSchema>

export type OutreachOpsInviteRow = {
  inviteId: string
  candidateId: string
  candidateDisplayName: string
  jobId: string
  jobTitle: string
  companyName: string
  matchId?: string
  recommendedAction?: string
  finalScore?: number
  policyDecision: OutboundInvite["policyDecision"]
  approvalState: OutboundInvite["approvalState"]
  status: OutboundInvite["status"]
  dryRun: boolean
  decisionReason: string
  blockedSignals: string[]
  cooldownUntil?: string
  stickyAccountGroupId?: string
  capacitySnapshot?: OutboundInviteCapacitySnapshot
  outboundId?: string
  sendblueStatus?: string
  lastError?: string
  createdAt: string
  updatedAt?: string
}

export type OutreachOpsSnapshot = {
  generatedAt: string
  filters: {
    jobId?: string
    status?: string
    approvalState?: string
    limit: number
  }
  summary: {
    totalInvites: number
    allowed: number
    blocked: number
    pendingApproval: number
    approved: number
    queued: number
    sent: number
    delivered: number
    failed: number
    deadLetter: number
    dryRun: number
    capacityBlocked: number
    cooldownBlocked: number
    optOutBlocked: number
    duplicateBlocked: number
  }
  jobs: Array<{
    jobId: string
    jobTitle: string
    companyName: string
    pendingInvites: number
    blockedInvites: number
    queuedInvites: number
  }>
  invites: OutreachOpsInviteRow[]
  capacity: OutboundInviteCapacitySnapshot[]
  failures: OutreachOpsInviteRow[]
  approvalBatches: Array<{ batchId: string; pendingInvites: number; createdAt: string }>
}

function cleanString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

function cleanNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

type OutreachOpsJobMeta = {
  jobTitle?: string
  companyName?: string
}

function jobMetaFromRaw(raw: Record<string, unknown> | undefined): OutreachOpsJobMeta {
  if (!raw) return {}
  return {
    jobTitle: cleanString(raw.roleTitle) ?? cleanString(raw.jobTitle) ?? cleanString(raw.title),
    companyName: cleanString(raw.companyName),
  }
}

function inviteRow(
  invite: OutboundInvite,
  raw: Record<string, unknown>,
  jobMeta: OutreachOpsJobMeta = {}
): OutreachOpsInviteRow {
  return {
    inviteId: invite.inviteId,
    candidateId: invite.candidateId,
    candidateDisplayName: cleanString(raw.candidateDisplayName) ?? invite.candidateId,
    jobId: invite.jobId,
    jobTitle: jobMeta.jobTitle ?? cleanString(raw.jobTitle) ?? cleanString(raw.title) ?? invite.jobId,
    companyName: jobMeta.companyName ?? cleanString(raw.companyName) ?? "Unknown company",
    ...(invite.matchId ? { matchId: invite.matchId } : {}),
    recommendedAction: cleanString(raw.recommendedAction),
    finalScore: cleanNumber(raw.finalScore),
    policyDecision: invite.policyDecision,
    approvalState: invite.approvalState,
    status: invite.status,
    dryRun: invite.dryRun,
    decisionReason: invite.decisionReason,
    blockedSignals: invite.blockedSignals,
    ...(invite.cooldownUntil ? { cooldownUntil: invite.cooldownUntil } : {}),
    ...(invite.stickyAccountGroupId ? { stickyAccountGroupId: invite.stickyAccountGroupId } : {}),
    ...(invite.capacitySnapshot ? { capacitySnapshot: invite.capacitySnapshot } : {}),
    ...(invite.outboundId ? { outboundId: invite.outboundId } : {}),
    sendblueStatus: invite.providerStatus,
    lastError: invite.lastError,
    createdAt: invite.createdAt,
    updatedAt: invite.updatedAt,
  }
}

function emptySummary(): OutreachOpsSnapshot["summary"] {
  return {
    totalInvites: 0,
    allowed: 0,
    blocked: 0,
    pendingApproval: 0,
    approved: 0,
    queued: 0,
    sent: 0,
    delivered: 0,
    failed: 0,
    deadLetter: 0,
    dryRun: 0,
    capacityBlocked: 0,
    cooldownBlocked: 0,
    optOutBlocked: 0,
    duplicateBlocked: 0,
  }
}

function summarize(rows: OutreachOpsInviteRow[]): OutreachOpsSnapshot["summary"] {
  const summary = emptySummary()
  for (const row of rows) {
    summary.totalInvites += 1
    if (row.policyDecision === "auto_outbound") summary.allowed += 1
    if (row.policyDecision === "blocked" || row.policyDecision === "do_not_contact") summary.blocked += 1
    if (row.approvalState === "pending") summary.pendingApproval += 1
    if (row.approvalState === "approved") summary.approved += 1
    if (row.status === "queued") summary.queued += 1
    if (row.status === "sent") summary.sent += 1
    if (row.status === "delivered") summary.delivered += 1
    if (row.status === "failed") summary.failed += 1
    if (row.status === "dead_letter") summary.deadLetter += 1
    if (row.dryRun) summary.dryRun += 1
    if (row.blockedSignals.some((signal) => signal.includes("capacity"))) summary.capacityBlocked += 1
    if (row.blockedSignals.some((signal) => signal.includes("cooldown"))) summary.cooldownBlocked += 1
    if (row.blockedSignals.some((signal) => signal.includes("opted_out") || signal.includes("outreach_blocked"))) summary.optOutBlocked += 1
    if (row.blockedSignals.some((signal) => signal.includes("duplicate"))) summary.duplicateBlocked += 1
  }
  return summary
}

function sortRows(rows: OutreachOpsInviteRow[]): OutreachOpsInviteRow[] {
  return [...rows].sort((a, b) => (b.updatedAt ?? b.createdAt).localeCompare(a.updatedAt ?? a.createdAt))
}

export async function runAdminOutreachOpsSnapshot(
  raw: unknown,
  deps: { db: Firestore; now?: () => string }
): Promise<OutreachOpsSnapshot> {
  const parsed = AdminOutreachOpsSnapshotInputSchema.safeParse(raw)
  if (!parsed.success) {
    throw new HttpsError("invalid-argument", parsed.error.message)
  }

  let query: Query = deps.db.collection(PA_COLLECTIONS.outboundInvites)
  if (parsed.data.jobId) {
    query = query.where("jobId", "==", parsed.data.jobId)
  }
  const snap = await query.limit(Math.max(parsed.data.limit * 3, parsed.data.limit)).get()
  const parsedInvites = snap.docs.flatMap((doc) => {
    const rawInvite = doc.data() as Record<string, unknown>
    const invite = OutboundInviteSchema.safeParse(rawInvite)
    return invite.success ? [{ invite: invite.data, rawInvite }] : []
  })
  const jobMetaEntries = await Promise.all(
    [...new Set(parsedInvites.map((entry) => entry.invite.jobId))].map(async (jobId) => {
      const jobSnap = await deps.db.collection(PA_COLLECTIONS.jobs).doc(jobId).get()
      return [jobId, jobMetaFromRaw(jobSnap.exists ? jobSnap.data() as Record<string, unknown> : undefined)] as const
    })
  )
  const jobMetaById = new Map(jobMetaEntries)
  const rows = sortRows(
    parsedInvites.flatMap(({ invite, rawInvite }) => {
      const row = inviteRow(invite, rawInvite, jobMetaById.get(invite.jobId))
      if (parsed.data.status && row.status !== parsed.data.status) return []
      if (parsed.data.approvalState && row.approvalState !== parsed.data.approvalState) return []
      return [row]
    })
  ).slice(0, parsed.data.limit)

  const jobsById = new Map<string, OutreachOpsSnapshot["jobs"][number]>()
  for (const row of rows) {
    const existing = jobsById.get(row.jobId) ?? {
      jobId: row.jobId,
      jobTitle: row.jobTitle,
      companyName: row.companyName,
      pendingInvites: 0,
      blockedInvites: 0,
      queuedInvites: 0,
    }
    if (row.approvalState === "pending") existing.pendingInvites += 1
    if (row.policyDecision === "blocked" || row.policyDecision === "do_not_contact") existing.blockedInvites += 1
    if (row.status === "queued") existing.queuedInvites += 1
    jobsById.set(row.jobId, existing)
  }

  const capacityByGroup = new Map<string, OutboundInviteCapacitySnapshot>()
  for (const row of rows) {
    if (row.capacitySnapshot) capacityByGroup.set(row.capacitySnapshot.groupId, row.capacitySnapshot)
  }
  const pendingRows = rows.filter((row) => row.approvalState === "pending")
  return {
    generatedAt: deps.now?.() ?? new Date().toISOString(),
    filters: {
      ...(parsed.data.jobId ? { jobId: parsed.data.jobId } : {}),
      ...(parsed.data.status ? { status: parsed.data.status } : {}),
      ...(parsed.data.approvalState ? { approvalState: parsed.data.approvalState } : {}),
      limit: parsed.data.limit,
    },
    summary: summarize(rows),
    jobs: [...jobsById.values()],
    invites: rows,
    capacity: [...capacityByGroup.values()],
    failures: rows.filter((row) => row.status === "failed" || row.status === "dead_letter"),
    approvalBatches: pendingRows.length > 0
      ? [{ batchId: "pending-review", pendingInvites: pendingRows.length, createdAt: pendingRows[pendingRows.length - 1]!.createdAt }]
      : [],
  }
}

export const paAdminOutreachOpsSnapshot = onCall(
  { region: "us-central1", memory: "256MiB", secrets: [PA_ADMIN_TOKEN] },
  async (req) => {
    authorizeAdminCallable(req as { auth?: { token?: { admin?: unknown } }; data?: unknown })
    return runAdminOutreachOpsSnapshot(req.data, { db: getFirestore() })
  }
)
