/**
 * Shared live counts for the operator work queues ("what do I do today").
 *
 * One hook feeds both the Overview "Today" panel and the sidebar HITL
 * badges. Every source is a cheap read — Firestore count() aggregates
 * (getCountFromServer) where rules allow a direct client query, or the
 * smallest existing callable/list read where they do not:
 *
 * - prescreenPending: pa-prescreen-sessions where terminalActionPendingReview == true
 * - identityOpen: pa-candidate-identity-conflicts where status == "open"
 * - enrichmentDrafts: collectionGroup("enrichment") where status in [draft, needs_review];
 *   falls back to counting the same latest-100 fetch the review page uses
 *   when the filtered collection-group count needs a missing index
 *   (enrichmentDraftsApprox flags the sampled number).
 * - recruiterNew: pa-recruiter-submissions where status in [submitted, new, reviewing]
 *   ("submitted" is the creation status recruiter-board-fn stamps).
 * - pendingOutbound: paPendingOutboundAdmin list(status=pending) length — the
 *   collection has no client read rule, so the callable the page uses is the
 *   cheapest allowed read.
 * - layoffPending: layoff_employers where verificationStatus == "pending"
 *   (openRegisterEmployer stamps "pending" on every signup).
 *
 * Counts are independent (Promise.allSettled): a failing source reports
 * null instead of blanking the others. All subscribers share one
 * module-level snapshot and one poller (refresh on first subscribe +
 * every 120s while any subscriber is mounted), so the sidebar badge and
 * the Today card for the same queue can never disagree.
 */
import {
  collection,
  collectionGroup,
  getCountFromServer,
  getDocs,
  limit,
  orderBy,
  query,
  where,
  type Query,
} from "firebase/firestore"
import { useSyncExternalStore } from "react"
import { db } from "./firebase.js"
import { listPendingOutbound } from "./pending-outbound-api.js"

export type WorkQueueCounts = {
  prescreenPending: number | null
  identityOpen: number | null
  enrichmentDrafts: number | null
  enrichmentDraftsApprox: boolean
  recruiterNew: number | null
  pendingOutbound: number | null
  layoffPending: number | null
  loading: boolean
}

const REFRESH_MS = 120_000
const ENRICHMENT_REVIEW_STATUSES = ["draft", "needs_review"]
const RECRUITER_NEW_STATUSES = ["submitted", "new", "reviewing"]

async function count(q: Query): Promise<number> {
  const snap = await getCountFromServer(q)
  return snap.data().count
}

function fetchPrescreenPending(): Promise<number> {
  return count(
    query(
      collection(db(), "pa-prescreen-sessions"),
      where("terminalActionPendingReview", "==", true)
    )
  )
}

function fetchIdentityOpen(): Promise<number> {
  return count(
    query(collection(db(), "pa-candidate-identity-conflicts"), where("status", "==", "open"))
  )
}

async function fetchEnrichmentDrafts(): Promise<{ count: number; approx: boolean }> {
  try {
    const n = await count(
      query(collectionGroup(db(), "enrichment"), where("status", "in", ENRICHMENT_REVIEW_STATUSES))
    )
    return { count: n, approx: false }
  } catch {
    // Filtered collection-group count needs a collection-group index that may
    // not exist; fall back to the latest-100 fetch the review page already does.
    const snap = await getDocs(
      query(collectionGroup(db(), "enrichment"), orderBy("updatedAt", "desc"), limit(100))
    )
    const n = snap.docs.filter((d) =>
      ENRICHMENT_REVIEW_STATUSES.includes(String(d.data().status))
    ).length
    return { count: n, approx: true }
  }
}

function fetchRecruiterNew(): Promise<number> {
  return count(
    query(
      collection(db(), "pa-recruiter-submissions"),
      where("status", "in", RECRUITER_NEW_STATUSES)
    )
  )
}

async function fetchPendingOutbound(): Promise<number> {
  const rows = await listPendingOutbound("pending", 200)
  return rows.length
}

function fetchLayoffPending(): Promise<number> {
  return count(
    query(collection(db(), "layoff_employers"), where("verificationStatus", "==", "pending"))
  )
}

function settled(result: PromiseSettledResult<number>): number | null {
  return result.status === "fulfilled" ? result.value : null
}

const INITIAL: WorkQueueCounts = {
  prescreenPending: null,
  identityOpen: null,
  enrichmentDrafts: null,
  enrichmentDraftsApprox: false,
  recruiterNew: null,
  pendingOutbound: null,
  layoffPending: null,
  loading: true,
}

let snapshot: WorkQueueCounts = INITIAL
const subscribers = new Set<() => void>()
let intervalId: number | null = null
let inFlight = false

async function refreshCounts(): Promise<void> {
  if (inFlight) return
  inFlight = true
  try {
    const [prescreen, identity, enrichment, recruiter, outbound, layoff] =
      await Promise.allSettled([
        fetchPrescreenPending(),
        fetchIdentityOpen(),
        fetchEnrichmentDrafts(),
        fetchRecruiterNew(),
        fetchPendingOutbound(),
        fetchLayoffPending(),
      ])
    if (subscribers.size === 0) return
    snapshot = {
      prescreenPending: settled(prescreen),
      identityOpen: settled(identity),
      enrichmentDrafts: enrichment.status === "fulfilled" ? enrichment.value.count : null,
      enrichmentDraftsApprox: enrichment.status === "fulfilled" ? enrichment.value.approx : false,
      recruiterNew: settled(recruiter),
      pendingOutbound: settled(outbound),
      layoffPending: settled(layoff),
      loading: false,
    }
    for (const notify of subscribers) notify()
  } finally {
    inFlight = false
  }
}

function subscribe(notify: () => void): () => void {
  subscribers.add(notify)
  if (subscribers.size === 1) {
    void refreshCounts()
    intervalId = window.setInterval(() => void refreshCounts(), REFRESH_MS)
  }
  return () => {
    subscribers.delete(notify)
    if (subscribers.size === 0 && intervalId !== null) {
      window.clearInterval(intervalId)
      intervalId = null
    }
  }
}

function getSnapshot(): WorkQueueCounts {
  return snapshot
}

export function useWorkQueueCounts(): WorkQueueCounts {
  return useSyncExternalStore(subscribe, getSnapshot)
}
