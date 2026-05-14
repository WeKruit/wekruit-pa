import type { Firestore } from "firebase-admin/firestore"
import {
  PA_COLLECTIONS,
  createCandidateJobMatchId,
  createCandidateJobStateId,
  createEmployerVisibleProfileId,
  type CandidateJobMatch,
} from "../../../packages/core-types/src/index.js"

export const now = "2026-05-13T12:00:00.000Z"
export const directCandidateId = "cand-s7-direct"
export const outboundCandidateId = "cand-s7-outbound"
export const defaultJobId = "job-s7-product-engineer"
export const PRESCREEN_SESSIONS = "pa-prescreen-sessions"

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
  update: (data: Record<string, unknown>) => Promise<void>
  collection: (subcollectionName: string) => CollectionRef
}

type CollectionRef = {
  doc: (id?: string) => DocRef
  where: (field: string, op: "==", value: unknown) => QueryRef
  orderBy: (field: string, dir?: "asc" | "desc") => QueryRef
  limit: (count: number) => QueryRef
  get: () => Promise<QuerySnapshot>
}

type QueryRef = CollectionRef

export function makeStore(): Store {
  return new Map([
    ...Object.values(PA_COLLECTIONS).map((name) => [name, new Map()] as const),
    [PRESCREEN_SESSIONS, new Map()] as const,
  ])
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
          throw new Error(`already_exists:${collectionName}/${id}`)
        }
        col(collectionName).set(id, { ...data })
      },
      async set(data, opts) {
        const current = col(collectionName).get(id)
        col(collectionName).set(id, opts?.merge && current ? { ...current, ...data } : { ...data })
      },
      async update(data) {
        const current = col(collectionName).get(id)
        if (!current) throw new Error(`not_found:${collectionName}/${id}`)
        col(collectionName).set(id, { ...current, ...data })
      },
      collection(subcollectionName: string) {
        return collection(`${collectionName}/${id}/${subcollectionName}`)
      },
    }
  }

  function query(
    collectionName: string,
    filters: Array<{ field: string; value: unknown }>,
    order: { field: string; dir: "asc" | "desc" } | undefined,
    max: number | undefined
  ): QueryRef {
    return {
      doc(id = `auto-${Math.random().toString(36).slice(2)}`) {
        return docRef(collectionName, id)
      },
      where(field: string, op: "==", value: unknown) {
        if (op !== "==") throw new Error(`unsupported_fake_firestore_query:${op}`)
        return query(collectionName, [...filters, { field, value }], order, max)
      },
      orderBy(field: string, dir: "asc" | "desc" = "asc") {
        return query(collectionName, filters, { field, dir }, max)
      },
      limit(count: number) {
        return query(collectionName, filters, order, count)
      },
      async get() {
        let rows = [...col(collectionName).entries()]
          .filter(([, data]) => filters.every((filter) => data[filter.field] === filter.value))
        if (order) {
          rows = rows.sort(([, a], [, b]) => {
            const av = a[order.field]
            const bv = b[order.field]
            if (typeof av === "string" && typeof bv === "string") {
              return order.dir === "desc" ? bv.localeCompare(av) : av.localeCompare(bv)
            }
            return 0
          })
        }
        if (max !== undefined) rows = rows.slice(0, max)
        const docs = rows.map(([id, data]) => ({ exists: true, id, data: () => data }))
        return { empty: docs.length === 0, docs }
      },
    }
  }

  function collection(collectionName: string): CollectionRef {
    return query(collectionName, [], undefined, undefined)
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

export function seedPrescreenSession(
  store: Store,
  input: {
    sessionId: string
    candidateId: string
    jobId?: string
    terminal?: "PASS" | "FAIL" | "HARD_STOP" | "PAUSE"
    terminalReason?: string
  }
) {
  col(store, PRESCREEN_SESSIONS).set(input.sessionId, {
    sessionId: input.sessionId,
    userId: input.candidateId,
    jobId: input.jobId ?? defaultJobId,
    terminal: input.terminal ?? null,
    terminalReason: input.terminalReason ?? "S7 eval terminal reason",
    score: input.terminal === "PASS" ? 3 : 0,
    scoreMax: 3,
    createdAt: now,
    updatedAt: now,
  })
  col(store, `${PRESCREEN_SESSIONS}/${input.sessionId}/turns`).set(`${input.sessionId}-turn-1`, {
    id: `${input.sessionId}-turn-1`,
    qId: "q_react_experience",
    reply: "I shipped React production systems. candidate@example.com",
    action: { kind: input.terminal ? "terminal" : "next_question" },
    ts: now,
  })
}

function col(store: Store, collectionName: string): Map<string, Record<string, unknown>> {
  if (!store.has(collectionName)) store.set(collectionName, new Map())
  return store.get(collectionName)!
}

export function seedOutboundState(store: Store, candidateId = outboundCandidateId, jobId = defaultJobId) {
  col(store, PA_COLLECTIONS.candidateJobStates).set(createCandidateJobStateId(candidateId, jobId), {
    id: createCandidateJobStateId(candidateId, jobId),
    candidateId,
    jobId,
    state: "outbound_sent",
    stateUpdatedAt: now,
    latestMatchId: createCandidateJobMatchId(candidateId, jobId),
  })
  col(store, PA_COLLECTIONS.outboundInvites).set(`invite-${candidateId}`, {
    inviteId: `invite-${candidateId}`,
    candidateId,
    jobId,
    status: "sent",
    dryRun: true,
    createdAt: now,
  })
}

export function seedMatch(
  store: Store,
  over: Partial<CandidateJobMatch> = {}
): CandidateJobMatch {
  const candidateId = over.candidateId ?? directCandidateId
  const jobId = over.jobId ?? defaultJobId
  const match: CandidateJobMatch = {
    matchId: createCandidateJobMatchId(candidateId, jobId),
    candidateId,
    jobId,
    direction: "job_to_candidate",
    matchVersion: "s7-eval",
    jobEnrichmentVersion: "job-enrich-v1",
    computedAt: now,
    scoreBreakdown: { skills: { score: 0.01, weight: 1, summary: "Low score fixture" } },
    matchedSignals: [],
    blockedSignals: [],
    candidateLifecycleStateAtMatch: "retained",
    candidateTagsUpdatedAt: now,
    hardFilterResult: "soft_block",
    finalScore: 0.01,
    reasons: ["low score fixture should not block first interview"],
    risks: ["weak initial match"],
    missingInfo: [],
    recommendedAction: "hitl_review",
    evidence: [{ source: "job_match", summary: "S7 low match fixture" }],
    createdAt: now,
    ...over,
  }
  col(store, PA_COLLECTIONS.candidateJobMatches).set(match.matchId, match as unknown as Record<string, unknown>)
  return match
}

export function snapshotId(jobId = defaultJobId, candidateId = directCandidateId): string {
  return createEmployerVisibleProfileId(jobId, candidateId)
}
