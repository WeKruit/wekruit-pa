import { randomUUID } from "node:crypto"
import type { Firestore } from "firebase-admin/firestore"
import {
  PA_COLLECTIONS,
  createCandidateJobMatchId,
  createCandidateJobStateId,
  createOutboundInviteId,
  createOutreachDuplicateSuppressionKey,
  type CandidateJobEvent,
  type CandidateJobMatch,
  type OutboundInvite,
} from "../../../packages/core-types/src/index.js"
import type { SendblueCapacitySelection } from "../../../apps/functions/src/sendblue/pool.js"
import type {
  OutreachCandidateSnapshot,
  OutreachJobSnapshot,
} from "../../../apps/functions/src/outreach/types.js"
import type {
  PlanJobOutreachDeps,
  PlanJobOutreachInput,
} from "../../../apps/functions/src/outreach/service.js"
import { enqueueOutbound } from "../../../packages/pa-broker/src/outbound-queue.js"
import {
  markOutboundInviteQueued,
  writeOutboundInviteDecision,
} from "../../../packages/pa-persistence/src/marketplace.js"
import { reserveOutreachCapacity } from "../../../packages/pa-persistence/src/outreach-capacity.js"

export const now = "2026-05-13T12:00:00.000Z"
export const defaultCandidateId = "cand-s6-high-match"
export const defaultJobId = "job-s6-product-designer"

export type Store = Map<string, Map<string, Record<string, unknown>>>

type DocSnapshot = {
  exists: boolean
  id: string
  data: () => Record<string, unknown> | undefined
}

type QuerySnapshot = {
  empty: boolean
  docs: DocSnapshot[]
}

type DocRef = {
  id: string
  _collectionName: string
  _id: string
  get: () => Promise<DocSnapshot>
  create: (data: Record<string, unknown>) => Promise<void>
  set: (data: Record<string, unknown>, opts?: { merge?: boolean }) => Promise<void>
  collection: (subcollectionName: string) => CollectionRef
}

type CollectionRef = {
  doc: (id?: string) => DocRef
  where: (field: string, op: "==", value: unknown) => QueryRef
  get: () => Promise<QuerySnapshot>
}

type QueryRef = {
  limit: (count: number) => QueryRef
  get: () => Promise<QuerySnapshot>
}

export function makeStore(): Store {
  return new Map(Object.values(PA_COLLECTIONS).map((name) => [name, new Map()] as const))
}

export function makeFakeFirestore(store: Store = makeStore()): { db: Firestore; store: Store } {
  function col(name: string): Map<string, Record<string, unknown>> {
    if (!store.has(name)) store.set(name, new Map())
    return store.get(name)!
  }

  function docRef(collectionName: string, id: string): DocRef {
    return {
      id,
      _collectionName: collectionName,
      _id: id,
      async get() {
        const data = col(collectionName).get(id)
        return { exists: data !== undefined, id, data: () => data }
      },
      async create(data) {
        if (col(collectionName).has(id)) {
          const err = new Error("already exists") as Error & { code?: number }
          err.code = 6
          throw err
        }
        col(collectionName).set(id, { ...data })
      },
      async set(data, opts) {
        const current = col(collectionName).get(id)
        col(collectionName).set(id, opts?.merge && current ? { ...current, ...data } : { ...data })
      },
      collection(subcollectionName: string) {
        return collection(`${collectionName}/${id}/${subcollectionName}`)
      },
    }
  }

  function query(
    collectionName: string,
    filters: Array<{ field: string; value: unknown }>,
    max: number | undefined
  ): QueryRef {
    return {
      limit(count: number) {
        return query(collectionName, filters, count)
      },
      async get() {
        const docs = [...col(collectionName).entries()]
          .filter(([, data]) => filters.every((filter) => data[filter.field] === filter.value))
          .slice(0, max)
          .map(([id, data]) => ({ exists: true, id, data: () => data }))
        return { empty: docs.length === 0, docs }
      },
    }
  }

  function collection(collectionName: string): CollectionRef {
    return {
      doc(id = randomUUID()) {
        return docRef(collectionName, id)
      },
      where(field: string, op: "==", value: unknown) {
        if (op !== "==") throw new Error(`unsupported_fake_firestore_query:${op}`)
        return query(collectionName, [{ field, value }], undefined)
      },
      get() {
        return query(collectionName, [], undefined).get()
      },
    }
  }

  const db = {
    collection,
    async runTransaction<T>(fn: (tx: {
      get: (ref: DocRef) => Promise<DocSnapshot>
      set: (ref: DocRef, data: Record<string, unknown>, opts?: { merge?: boolean }) => void
      update: (ref: DocRef, data: Record<string, unknown>) => void
    }) => Promise<T>): Promise<T> {
      const writes: Array<{ ref: DocRef; data: Record<string, unknown>; opts?: { merge?: boolean } }> = []
      const tx = {
        async get(ref: DocRef) {
          const data = col(ref._collectionName).get(ref._id)
          return { exists: data !== undefined, id: ref._id, data: () => data }
        },
        set(ref: DocRef, data: Record<string, unknown>, opts?: { merge?: boolean }) {
          writes.push({ ref, data, opts })
        },
        update(ref: DocRef, data: Record<string, unknown>) {
          if (!col(ref._collectionName).has(ref._id)) {
            throw new Error(`5 NOT_FOUND: Document does not exist: ${ref._collectionName}/${ref._id}`)
          }
          writes.push({ ref, data, opts: { merge: true } })
        },
      }
      const result = await fn(tx)
      for (const write of writes) {
        const current = col(write.ref._collectionName).get(write.ref._id)
        col(write.ref._collectionName).set(
          write.ref._id,
          write.opts?.merge && current ? { ...current, ...write.data } : { ...write.data }
        )
      }
      return result
    },
  }

  return { db: db as unknown as Firestore, store }
}

export function collectionSize(store: Store, collectionName: string): number {
  return store.get(collectionName)?.size ?? 0
}

export function collectionDocs(store: Store, collectionName: string): Record<string, unknown>[] {
  return [...(store.get(collectionName)?.values() ?? [])]
}

export function match(over: Partial<CandidateJobMatch> = {}): CandidateJobMatch {
  const candidateId = over.candidateId ?? defaultCandidateId
  const jobId = over.jobId ?? defaultJobId
  const matchId = over.matchId ?? createCandidateJobMatchId(candidateId, jobId)
  return {
    matchId,
    candidateId,
    jobId,
    direction: "job_to_candidate",
    matchVersion: "s5-eval",
    jobEnrichmentVersion: "job-enrich-v1",
    computedAt: now,
    scoreBreakdown: {
      skills: { score: 0.86, weight: 0.6, summary: "React and TypeScript match" },
      location: { score: 1, weight: 0.2, summary: "Remote-compatible" },
    },
    matchedSignals: ["react", "typescript", "remote_anywhere"],
    blockedSignals: [],
    candidateLifecycleStateAtMatch: "retained",
    candidateTagsUpdatedAt: now,
    hardFilterResult: "pass",
    finalScore: 0.88,
    reasons: ["strong_skill_match"],
    risks: [],
    missingInfo: [],
    recommendedAction: "auto_outbound",
    evidence: [{ source: "job_match", summary: "S6 outreach eval match" }],
    createdAt: now,
    ...over,
  }
}

export function candidate(over: Partial<OutreachCandidateSnapshot> = {}): OutreachCandidateSnapshot {
  const candidateId = over.candidateId ?? defaultCandidateId
  return {
    candidateId,
    candidateLifecycleState: "retained",
    outreach: { status: "allowed", stickyAccountGroupId: "group-1" },
    phoneE164: "+15555550123",
    imessageChatId: `chat-${candidateId}`,
    ...over,
  }
}

export function job(over: Partial<OutreachJobSnapshot> = {}): OutreachJobSnapshot {
  return {
    jobId: defaultJobId,
    jobTitle: "Product Designer",
    companyName: "Invoko",
    roleKey: "product-designer",
    ...over,
  }
}

function capacitySnapshot(over: Partial<SendblueCapacitySelection["capacitySnapshot"]> = {}) {
  return {
    groupId: "group-1",
    fromNumber: "+15555550100",
    status: "active" as const,
    dailyCap: 10,
    usedToday: 1,
    remainingToday: 9,
    checkedAt: now,
    ...over,
  }
}

export function capacity(over: Partial<SendblueCapacitySelection> = {}): SendblueCapacitySelection {
  const snapshot = capacitySnapshot(over.capacitySnapshot)
  return {
    ok: true,
    groupId: snapshot.groupId,
    fromNumber: snapshot.fromNumber ?? "+15555550100",
    reason: "selected",
    capacitySnapshot: snapshot,
    ...over,
  } as SendblueCapacitySelection
}

export function fullCapacity(): SendblueCapacitySelection {
  return {
    ok: false,
    groupId: "group-1",
    fromNumber: "+15555550100",
    reason: "channel_capacity",
    capacitySnapshot: capacitySnapshot({
      dailyCap: 1,
      usedToday: 1,
      remainingToday: 0,
      reason: "daily cap reached",
    }),
  }
}

export function missingCapacity(): SendblueCapacitySelection {
  return {
    ok: false,
    groupId: "missing",
    reason: "missing_capacity",
    capacitySnapshot: capacitySnapshot({
      groupId: "missing",
      fromNumber: undefined,
      status: "missing",
      dailyCap: 0,
      usedToday: 0,
      remainingToday: 0,
      reason: "no capacity snapshot",
    }),
  }
}

export function warmupCapacity(): SendblueCapacitySelection {
  return {
    ok: false,
    groupId: "warmup-1",
    fromNumber: "+15555550109",
    reason: "warmup_requires_hitl",
    capacitySnapshot: capacitySnapshot({
      groupId: "warmup-1",
      fromNumber: "+15555550109",
      status: "warmup",
      dailyCap: 5,
      usedToday: 0,
      remainingToday: 5,
      reason: "warmup requires HITL",
    }),
  }
}

export function outboundInvite(
  over: Partial<OutboundInvite> & { companyName?: string; roleKey?: string } = {}
): OutboundInvite & { companyName?: string; roleKey?: string } {
  const candidateId = over.candidateId ?? defaultCandidateId
  const jobId = over.jobId ?? defaultJobId
  const matchId = over.matchId ?? createCandidateJobMatchId(candidateId, jobId)
  return {
    inviteId: over.inviteId ?? createOutboundInviteId({ candidateId, jobId, matchId }),
    candidateId,
    jobId,
    candidateJobStateId: over.candidateJobStateId ?? createCandidateJobStateId(candidateId, jobId),
    matchId,
    status: "draft",
    policyDecision: "auto_outbound",
    approvalState: "not_required",
    dryRun: true,
    policyVersion: "s6-outreach-policy-v1",
    decisionReason: "S6 outreach eval fixture",
    blockedSignals: [],
    missingInfo: [],
    stickyAccountGroupId: "group-1",
    capacitySnapshot: capacitySnapshot(),
    createdAt: now,
    ...over,
  }
}

export function candidateJobEvent(
  type: CandidateJobEvent["type"],
  over: Partial<CandidateJobEvent> = {}
): CandidateJobEvent {
  const candidateId = over.candidateId ?? defaultCandidateId
  const jobId = over.jobId ?? defaultJobId
  const prescreenFields = [
    "prescreen_started",
    "prescreen_passed",
    "prescreen_not_passed",
    "manual_pause",
  ].includes(type)
    ? { prescreenSessionId: `ps-${jobId}-${candidateId}` }
    : {}
  const employerFields =
    type === "employer_snapshot_created"
      ? { employerVisibleProfileId: `${jobId}__${candidateId}` }
      : {}
  return {
    eventId: `s6-${type}`,
    type,
    candidateId,
    jobId,
    actor: "system",
    occurredAt: now,
    evidence: [{ source: "system", summary: "S6 outreach eval event" }],
    ...prescreenFields,
    ...employerFields,
    ...over,
  } as CandidateJobEvent
}

export function liveOutreachDeps(db: Firestore): PlanJobOutreachDeps {
  return {
    writeInviteDecision: (invite) => writeOutboundInviteDecision(db, invite),
    reserveCapacity: async (input) => {
      const reserved = await reserveOutreachCapacity(db, {
        groupId: input.groupId,
        status: input.status,
        dailyCap: input.dailyCap,
        ...(input.fromNumber ? { fromNumber: input.fromNumber } : {}),
        date: new Date(input.checkedAt),
        reservationKey: input.reservationKey,
      })
      if (reserved.ok) {
        return {
          ok: true,
          groupId: reserved.snapshot.groupId,
          fromNumber: reserved.snapshot.fromNumber ?? input.fromNumber ?? "",
          reason: "selected",
          capacitySnapshot: {
            ...reserved.snapshot,
            dailyCap: reserved.snapshot.dailyCap ?? 0,
          },
        }
      }
      return {
        ok: false,
        groupId: reserved.snapshot.groupId,
        ...(reserved.snapshot.fromNumber ? { fromNumber: reserved.snapshot.fromNumber } : {}),
        reason: reserved.reason === "capacity_full" ? "channel_capacity" : "missing_capacity",
        capacitySnapshot: {
          ...reserved.snapshot,
          dailyCap: reserved.snapshot.dailyCap ?? 0,
        },
      }
    },
    enqueueOutbound: (input) => enqueueOutbound(db, input),
    markQueued: (input) => markOutboundInviteQueued(db, input),
  }
}

type S6PolicyFixture = {
  name: string
  input: PlanJobOutreachInput
  expectedDecision: "auto_outbound" | "hitl_review" | "do_not_contact" | "blocked"
  expectQueueEligible: boolean
  expectAllowQueue: boolean
  expectedSignals: string[]
}

function singleCandidateInput(over: Partial<PlanJobOutreachInput> = {}): PlanJobOutreachInput {
  return {
    job: job(),
    matches: [match()],
    candidatesById: { [defaultCandidateId]: candidate() },
    capacityByCandidateId: { [defaultCandidateId]: capacity() },
    now,
    dryRun: true,
    approvalMode: "approved",
    persistDecisions: true,
    ...over,
  }
}

export function s6Fixtures(): S6PolicyFixture[] {
  return [
    {
      name: "dry-run eligible decision is persisted but not queueable",
      input: singleCandidateInput(),
      expectedDecision: "auto_outbound",
      expectQueueEligible: true,
      expectAllowQueue: false,
      expectedSignals: [],
    },
    {
      name: "missing approval mode blocks live queue",
      input: singleCandidateInput({ dryRun: false, approvalMode: "none" }),
      expectedDecision: "auto_outbound",
      expectQueueEligible: true,
      expectAllowQueue: false,
      expectedSignals: [],
    },
    {
      name: "opted out candidate blocks outbound",
      input: singleCandidateInput({
        dryRun: false,
        candidatesById: {
          [defaultCandidateId]: candidate({
            candidateLifecycleState: "opted_out",
            outreach: { status: "opted_out", optedOutAt: "2026-05-12T12:00:00.000Z" },
          }),
        },
      }),
      expectedDecision: "blocked",
      expectQueueEligible: false,
      expectAllowQueue: false,
      expectedSignals: ["opted_out"],
    },
    {
      name: "cooldown candidate blocks outbound",
      input: singleCandidateInput({
        dryRun: false,
        candidatesById: {
          [defaultCandidateId]: candidate({
            outreach: { status: "cooldown", cooldownUntil: "2026-05-20T12:00:00.000Z" },
          }),
        },
      }),
      expectedDecision: "blocked",
      expectQueueEligible: false,
      expectAllowQueue: false,
      expectedSignals: ["cooldown_active"],
    },
    {
      name: "unreachable candidate blocks outbound",
      input: singleCandidateInput({
        dryRun: false,
        candidatesById: {
          [defaultCandidateId]: candidate({ phoneE164: undefined, imessageChatId: undefined, channels: {} }),
        },
      }),
      expectedDecision: "blocked",
      expectQueueEligible: false,
      expectAllowQueue: false,
      expectedSignals: ["unreachable"],
    },
    {
      name: "capacity full blocks outbound",
      input: singleCandidateInput({
        dryRun: false,
        capacityByCandidateId: { [defaultCandidateId]: fullCapacity() },
      }),
      expectedDecision: "blocked",
      expectQueueEligible: false,
      expectAllowQueue: false,
      expectedSignals: ["channel_capacity"],
    },
    {
      name: "warmup requires HITL instead of auto live",
      input: singleCandidateInput({
        dryRun: false,
        capacityByCandidateId: { [defaultCandidateId]: warmupCapacity() },
      }),
      expectedDecision: "hitl_review",
      expectQueueEligible: false,
      expectAllowQueue: false,
      expectedSignals: ["hitl_required", "sendblue_warmup"],
    },
    {
      name: "low match score blocks outbound only",
      input: singleCandidateInput({
        dryRun: false,
        matches: [match({ finalScore: 0.01 })],
      }),
      expectedDecision: "blocked",
      expectQueueEligible: false,
      expectAllowQueue: false,
      expectedSignals: ["low_match"],
    },
    {
      name: "S5 do_not_contact blocks outbound",
      input: singleCandidateInput({
        dryRun: false,
        matches: [match({ recommendedAction: "do_not_contact" })],
      }),
      expectedDecision: "do_not_contact",
      expectQueueEligible: false,
      expectAllowQueue: false,
      expectedSignals: ["do_not_contact"],
    },
    {
      name: "recent decline blocks repeat outreach",
      input: singleCandidateInput({
        dryRun: false,
        recentDeclinesByCandidateId: {
          [defaultCandidateId]: [
            outboundInvite({
              status: "declined",
              companyName: "Invoko",
              roleKey: "product-designer",
              createdAt: "2026-05-12T12:00:00.000Z",
            }),
          ],
        },
      }),
      expectedDecision: "blocked",
      expectQueueEligible: false,
      expectAllowQueue: false,
      expectedSignals: ["recent_decline"],
    },
    {
      name: "duplicate same company role blocks repeat outreach",
      input: singleCandidateInput({
        dryRun: false,
        existingInvitesByCandidateId: {
          [defaultCandidateId]: [
            outboundInvite({
              jobId: "job-s6-older-product-designer",
              status: "sent",
              duplicateSuppressionKey: createOutreachDuplicateSuppressionKey(
                defaultCandidateId,
                "Invoko",
                "product-designer",
              ),
              createdAt: "2026-05-12T12:00:00.000Z",
            }),
          ],
        },
      }),
      expectedDecision: "blocked",
      expectQueueEligible: false,
      expectAllowQueue: false,
      expectedSignals: ["duplicate_company_role"],
    },
  ]
}
