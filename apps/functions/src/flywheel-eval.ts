import { createHash } from "node:crypto"
import { getFirestore, type Firestore } from "firebase-admin/firestore"
import { defineSecret } from "firebase-functions/params"
import { HttpsError, onCall } from "firebase-functions/v2/https"
import { onDocumentCreated } from "firebase-functions/v2/firestore"
import { z } from "zod"
import {
  CorrectionEventSchema,
  EvalArtifactSchema,
  FeedbackEventSchema,
  PA_COLLECTIONS,
  createEvalArtifactId,
  type CorrectionEvent,
  type EvalArtifact,
  type EvalArtifactKind,
  type FeedbackEvent,
} from "@pa/core-types"
import { writeEvalArtifact } from "@pa/pa-persistence"
import { authorizeAdminCallable } from "./promote-sandbox-tag.js"

const PA_ADMIN_TOKEN = defineSecret("PA_ADMIN_TOKEN")

const SAFE_STRUCTURED_KEY_RE = /^[A-Za-z0-9_.:-]{1,80}$/
const UNSAFE_KEY_RE = /(?:contact|correctiontext|email|freeform|linkedin|message|phone|prompt|raw|resume|storage|transcript)/i
const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i
const PHONE_RE = /(?:\+?\d[\s().-]*){9,}/
const LOCATOR_RE = /\b(?:gs:\/\/|https?:\/\/[^\s]*(?:linkedin\.com|storage\.googleapis\.com|firebasestorage\.googleapis\.com|storage\.cloud\.google\.com|resume|cv)[^\s]*)/i
const UNSAFE_TEXT_TOKEN_RE = /\b(?:prompt|raw|transcript)\b/i

export const FlywheelBehaviorSchema = z.enum([
  "prescreen_pass",
  "prescreen_not_pass",
  "prescreen_started",
  "candidate_declined",
  "candidate_interested",
  "outbound_delivery",
  "outbound_failure",
  "match_positive",
  "match_negative",
])
export type FlywheelBehavior = z.infer<typeof FlywheelBehaviorSchema>

const FlywheelFeedbackInputSchema = z.object({
  eventId: z.string().min(1),
  behavior: FlywheelBehaviorSchema,
  candidateId: z.string().min(1).optional(),
  jobId: z.string().min(1).optional(),
  candidateJobStateId: z.string().min(1).optional(),
  outcome: z.string().min(1).max(200).optional(),
  signals: z.record(z.unknown()).default({}),
  createdAt: z.string().min(1),
})
export type FlywheelFeedbackInput = z.input<typeof FlywheelFeedbackInputSchema>

const FlywheelSimulationInputSchema = z.object({
  scenarioRef: z.string().min(1).max(120),
  candidates: z.array(z.object({
    candidateId: z.string().min(1),
    tags: z.array(z.string()).default([]),
  })).default([]),
  jobs: z.array(z.object({
    jobId: z.string().min(1),
    tags: z.array(z.string()).default([]),
    active: z.boolean().default(true),
  })).default([]),
  events: z.array(z.object({
    kind: FlywheelBehaviorSchema,
    candidateId: z.string().min(1).optional(),
    jobId: z.string().min(1).optional(),
  })).default([]),
})
export type FlywheelSimulationInput = z.input<typeof FlywheelSimulationInputSchema>

export type FlywheelSimulationResult = {
  dryRun: true
  scenarioRef: string
  counts: {
    candidates: number
    jobs: number
    events: number
    activeJobs: number
    candidateJobPairs: number
    generatedArtifactSummaries: number
    outboundWrites: 0
  }
  artifacts: Array<{
    artifactId: string
    kind: EvalArtifactKind
    status: EvalArtifact["status"]
    sourceEventKind: FlywheelBehavior
    candidateId?: string
    jobId?: string
    payloadRedacted: Record<string, unknown>
  }>
}

const AdminFlywheelEvalSnapshotInputSchema = z.object({
  limit: z.number().int().min(1).max(100).default(25),
  adminToken: z.string().optional(),
})

export type FlywheelEvalSnapshot = {
  generatedAt: string
  filters: { limit: number }
  limit: number
  counts: {
    evalArtifacts: number
    feedbackEvents: number
    correctionEvents: number
    artifactsByKind: Record<string, number>
    artifactsByStatus: Record<string, number>
    correctionsByTarget: Record<string, number>
    correctionsByActor: Record<string, number>
    feedbackByKind: Record<string, number>
    feedbackByOutcome: Record<string, number>
    employerIntroByOutcome: Record<string, number>
  }
  recentArtifacts: Array<Pick<EvalArtifact, "artifactId" | "kind" | "status" | "candidateId" | "jobId" | "candidateJobStateId" | "createdBy" | "createdAt" | "updatedAt" | "sourceCorrectionEventIds" | "sourceFeedbackEventIds" | "payloadRedacted" | "evidence" | "latestRunResult">>
  recentCorrections: Array<Pick<CorrectionEvent, "eventId" | "targetType" | "targetId" | "actor" | "candidateId" | "jobId" | "reason" | "beforeRedacted" | "afterRedacted" | "evidence" | "createdAt">>
  recentFeedback: Array<Pick<FeedbackEvent, "eventId" | "kind" | "actor" | "outcome" | "candidateId" | "jobId" | "candidateJobStateId" | "payloadRedacted" | "evidence" | "createdAt">>
}

function stableHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16)
}

function isUnsafeString(value: string): boolean {
  return EMAIL_RE.test(value) || PHONE_RE.test(value) || LOCATOR_RE.test(value) || UNSAFE_TEXT_TOKEN_RE.test(value)
}

export function sanitizeEvalPayload(value: unknown): unknown {
  if (typeof value === "string") {
    const trimmed = value.trim()
    if (!trimmed || isUnsafeString(trimmed)) return undefined
    return trimmed.slice(0, 500)
  }
  if (typeof value === "number" || typeof value === "boolean") return value
  if (Array.isArray(value)) {
    const items = value.map(sanitizeEvalPayload).filter((item) => item !== undefined)
    return items.length > 0 ? items.slice(0, 20) : undefined
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {}
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      if (!SAFE_STRUCTURED_KEY_RE.test(key) || UNSAFE_KEY_RE.test(key)) continue
      const safe = sanitizeEvalPayload(nested)
      if (safe !== undefined) out[key] = safe
    }
    return Object.keys(out).length > 0 ? out : undefined
  }
  return undefined
}

function safeRecord(value: unknown): Record<string, unknown> {
  const sanitized = sanitizeEvalPayload(value)
  return sanitized && typeof sanitized === "object" && !Array.isArray(sanitized)
    ? sanitized as Record<string, unknown>
    : {}
}

function safeEvidence(rows: CorrectionEvent["evidence"] | FeedbackEvent["evidence"]): CorrectionEvent["evidence"] {
  return rows.map((row) => {
    const summary = sanitizeEvalPayload(row.summary)
    const refId = row.refId ? sanitizeEvalPayload(row.refId) : undefined
    return {
      source: row.source,
      summary: typeof summary === "string" ? summary : "redacted flywheel evidence",
      ...(typeof row.confidence === "number" ? { confidence: row.confidence } : {}),
      ...(typeof refId === "string" ? { refId } : {}),
    }
  })
}

function countBy<T>(rows: T[], select: (row: T) => string | undefined): Record<string, number> {
  const out: Record<string, number> = {}
  for (const row of rows) {
    const key = select(row)
    if (!key) continue
    out[key] = (out[key] ?? 0) + 1
  }
  return out
}

export function buildFlywheelFeedbackEvent(input: FlywheelFeedbackInput): FeedbackEvent {
  const parsed = FlywheelFeedbackInputSchema.parse(input)
  const payloadRedacted = {
    behavior: parsed.behavior,
    ...safeRecord(parsed.signals),
  }
  return FeedbackEventSchema.parse({
    eventId: parsed.eventId,
    kind: "candidate_behavior",
    actor: "system",
    candidateId: parsed.candidateId,
    jobId: parsed.jobId,
    candidateJobStateId: parsed.candidateJobStateId,
    outcome: parsed.outcome,
    payloadRedacted,
    evidence: [{ source: "system", summary: `Flywheel behavior: ${parsed.behavior}` }],
    createdAt: parsed.createdAt,
  })
}

export function materializeEvalArtifactForCorrection(input: {
  correction: CorrectionEvent
  kind?: EvalArtifactKind
  status?: EvalArtifact["status"]
  createdAt?: string
  updatedAt?: string
  payloadRedacted?: Record<string, unknown>
}): EvalArtifact {
  const correction = CorrectionEventSchema.parse(input.correction)
  const kind = input.kind ?? (correction.actor === "candidate" ? "candidate_profile_correction" : "correction_regression_fixture")
  return EvalArtifactSchema.parse({
    artifactId: createEvalArtifactId(kind, correction.eventId),
    kind,
    status: input.status ?? "ready",
    sourceCorrectionEventIds: [correction.eventId],
    candidateId: correction.candidateId,
    jobId: correction.jobId,
    payloadRedacted: input.payloadRedacted ?? {
      targetType: correction.targetType,
      targetId: correction.targetId,
      correctionActor: correction.actor,
      beforeRedacted: safeRecord(correction.beforeRedacted),
      afterRedacted: safeRecord(correction.afterRedacted),
      changedFieldKeys: Array.from(new Set([
        ...Object.keys(correction.beforeRedacted ?? {}),
        ...Object.keys(correction.afterRedacted ?? {}),
      ])).filter((key) => SAFE_STRUCTURED_KEY_RE.test(key) && !UNSAFE_KEY_RE.test(key)).sort(),
    },
    evidence: safeEvidence(correction.evidence),
    createdBy: correction.actor,
    createdAt: input.createdAt ?? correction.createdAt,
    updatedAt: input.updatedAt,
  })
}

export function runFlywheelMarketplaceSimulation(input: FlywheelSimulationInput): FlywheelSimulationResult {
  const parsed = FlywheelSimulationInputSchema.parse(input)
  const activeJobs = parsed.jobs.filter((job) => job.active)
  const candidateJobPairs = parsed.candidates.length * activeJobs.length
  const events = [...parsed.events].sort((a, b) =>
    `${a.kind}:${a.candidateId ?? ""}:${a.jobId ?? ""}`.localeCompare(`${b.kind}:${b.candidateId ?? ""}:${b.jobId ?? ""}`)
  )
  const artifacts = events.map((event, index) => ({
    artifactId: `sim_marketplace_simulation__${parsed.scenarioRef}__${String(index).padStart(3, "0")}`,
    kind: "marketplace_simulation" as const,
    status: "draft" as const,
    sourceEventKind: event.kind,
    ...(event.candidateId ? { candidateId: event.candidateId } : {}),
    ...(event.jobId ? { jobId: event.jobId } : {}),
    payloadRedacted: {
      scenarioRef: parsed.scenarioRef,
      eventKind: event.kind,
      candidateKnown: event.candidateId ? parsed.candidates.some((candidate) => candidate.candidateId === event.candidateId) : false,
      jobActive: event.jobId ? activeJobs.some((job) => job.jobId === event.jobId) : false,
      simulationHash: stableHash({ scenarioRef: parsed.scenarioRef, event }),
    },
  }))

  return {
    dryRun: true,
    scenarioRef: parsed.scenarioRef,
    counts: {
      candidates: parsed.candidates.length,
      jobs: parsed.jobs.length,
      events: events.length,
      activeJobs: activeJobs.length,
      candidateJobPairs,
      generatedArtifactSummaries: artifacts.length,
      outboundWrites: 0,
    },
    artifacts,
  }
}

async function loadRecent<T>(
  db: Firestore,
  collectionName: string,
  limit: number,
  parse: (data: unknown) => T | null,
): Promise<T[]> {
  const snap = await db.collection(collectionName).orderBy("createdAt", "desc").limit(limit).get()
  return snap.docs.flatMap((doc) => {
    const parsed = parse(doc.data())
    return parsed ? [parsed] : []
  })
}

export async function runAdminFlywheelEvalSnapshot(
  raw: unknown,
  deps: { db: Firestore; now?: () => string },
): Promise<FlywheelEvalSnapshot> {
  const parsed = AdminFlywheelEvalSnapshotInputSchema.safeParse(raw)
  if (!parsed.success) throw new HttpsError("invalid-argument", parsed.error.message)
  const limit = parsed.data.limit
  const [artifacts, feedback, corrections] = await Promise.all([
    loadRecent(deps.db, PA_COLLECTIONS.evalArtifacts, limit, (data) => {
      const out = EvalArtifactSchema.safeParse(data)
      return out.success ? out.data : null
    }),
    loadRecent(deps.db, PA_COLLECTIONS.feedbackEvents, limit, (data) => {
      const out = FeedbackEventSchema.safeParse(data)
      return out.success ? out.data : null
    }),
    loadRecent(deps.db, PA_COLLECTIONS.correctionEvents, limit, (data) => {
      const out = CorrectionEventSchema.safeParse(data)
      return out.success ? out.data : null
    }),
  ])

  return {
    generatedAt: deps.now?.() ?? new Date().toISOString(),
    filters: { limit },
    limit,
    counts: {
      evalArtifacts: artifacts.length,
      feedbackEvents: feedback.length,
      correctionEvents: corrections.length,
      artifactsByKind: countBy(artifacts, (artifact) => artifact.kind),
      artifactsByStatus: countBy(artifacts, (artifact) => artifact.status),
      correctionsByTarget: countBy(corrections, (correction) => correction.targetType),
      correctionsByActor: countBy(corrections, (correction) => correction.actor),
      feedbackByKind: countBy(feedback, (event) => event.kind),
      feedbackByOutcome: countBy(feedback, (event) => event.outcome),
      employerIntroByOutcome: countBy(
        feedback.filter((event) => event.kind === "employer_action"),
        (event) => event.outcome,
      ),
    },
    recentArtifacts: artifacts.map((artifact) => ({
      artifactId: artifact.artifactId,
      kind: artifact.kind,
      status: artifact.status,
      candidateId: artifact.candidateId,
      jobId: artifact.jobId,
      candidateJobStateId: artifact.candidateJobStateId,
      sourceCorrectionEventIds: artifact.sourceCorrectionEventIds,
      sourceFeedbackEventIds: artifact.sourceFeedbackEventIds,
      payloadRedacted: artifact.payloadRedacted,
      evidence: artifact.evidence,
      latestRunResult: artifact.latestRunResult,
      createdBy: artifact.createdBy,
      createdAt: artifact.createdAt,
      updatedAt: artifact.updatedAt,
    })),
    recentCorrections: corrections.map((correction) => ({
      eventId: correction.eventId,
      targetType: correction.targetType,
      targetId: correction.targetId,
      actor: correction.actor,
      candidateId: correction.candidateId,
      jobId: correction.jobId,
      reason: correction.reason,
      beforeRedacted: correction.beforeRedacted,
      afterRedacted: correction.afterRedacted,
      evidence: correction.evidence,
      createdAt: correction.createdAt,
    })),
    recentFeedback: feedback.map((event) => ({
      eventId: event.eventId,
      kind: event.kind,
      actor: event.actor,
      outcome: event.outcome,
      candidateId: event.candidateId,
      jobId: event.jobId,
      candidateJobStateId: event.candidateJobStateId,
      payloadRedacted: event.payloadRedacted,
      evidence: event.evidence,
      createdAt: event.createdAt,
    })),
  }
}

export async function handleCorrectionEventEvalArtifactCreated(
  raw: unknown,
  deps: { db: Firestore; now?: () => string },
): Promise<{ artifactId: string; created: boolean; skipped: boolean }> {
  const parsed = CorrectionEventSchema.safeParse(raw)
  if (!parsed.success) return { artifactId: "", created: false, skipped: true }
  const artifact = materializeEvalArtifactForCorrection({
    correction: parsed.data,
    createdAt: deps.now?.() ?? parsed.data.createdAt,
  })
  const result = await writeEvalArtifact(deps.db, artifact)
  return { artifactId: result.artifact.artifactId, created: result.created, skipped: false }
}

export const paAdminFlywheelEvalSnapshot = onCall(
  { region: "us-central1", memory: "256MiB", timeoutSeconds: 60, secrets: [PA_ADMIN_TOKEN] },
  async (req): Promise<FlywheelEvalSnapshot> => {
    authorizeAdminCallable(req as { auth?: { token?: { admin?: unknown } }; data?: unknown })
    return runAdminFlywheelEvalSnapshot(req.data, { db: getFirestore() })
  },
)

export const paFlywheelCorrectionEvalArtifact = onDocumentCreated(
  `${PA_COLLECTIONS.correctionEvents}/{eventId}`,
  async (event) => {
    await handleCorrectionEventEvalArtifactCreated(event.data?.data(), { db: getFirestore() })
  },
)
