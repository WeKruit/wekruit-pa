/**
 * v1.5 Stream-G.2 / Phase 51 — paJobRecClusterRebuild Cloud Function.
 *
 * Trigger: onDocumentCreated("pa-events/{id}") emitted by
 * apps/functions/src/matching-pipeline-complete.ts:354-373 after a
 * successful Mac mini scrape+enrich+embed pipeline run lands new jobs.
 *
 * Filters:
 *   - eventKind === "matching:pipeline:completed" — other event kinds noop
 *   - paTagClusterRecEnabled feature flag — default OFF; ramp 1% → 100%
 *
 * Idempotency: forwards the pa-events doc's `runId` to rebuildClusters,
 * which short-circuits per-cluster writes when the existing doc already
 * carries that runId (rare-but-possible Firestore retries on the same
 * source event).
 *
 * Cost: ~5k Firestore reads (paginated active corpus scan) + ~30 writes
 * per invocation. Free tier ample.
 *
 * Architecture: handler logic lives in `handleClusterRebuildEvent` (pure,
 * deps-injected) so unit tests can drive it without booting firebase-admin.
 * The onDocumentCreated wrapper at the bottom is a thin shim that wires
 * production deps (getFirestore + getFlag).
 */

import type { Firestore } from "firebase-admin/firestore"
import { onDocumentCreated } from "firebase-functions/v2/firestore"
import { logger } from "firebase-functions/v2"
import { getFirestore } from "firebase-admin/firestore"
import { getFlag } from "@pa/pa-persistence"
import {
  rebuildClusters,
  PA_TAG_CLUSTER_REC_FLAG_KEY,
  type RebuildClustersOutcome,
} from "@pa/job-rec"

/** Eventkind value matching-pipeline-complete.ts emits on success. */
export const TARGET_EVENT_KIND = "matching:pipeline:completed"

export type ClusterRebuildHandlerInput = {
  /** pa-events doc payload — typically {eventKind, runId, ...}. */
  eventData: { eventKind?: string; runId?: string } | undefined
  /** pa-events doc id (event.params.id). */
  eventId: string
}

export type ClusterRebuildHandlerDeps = {
  db: Firestore
  /** Inject test-friendly flag reader; production passes through to @pa/pa-persistence. */
  isFlagOn: () => Promise<boolean>
  log?: (...args: unknown[]) => void
  errorLog?: (...args: unknown[]) => void
}

export type ClusterRebuildHandlerResult =
  | { kind: "skipped_event_kind" }
  | { kind: "skipped_flag_off"; runId: string | null }
  | { kind: "rebuilt"; runId: string | null; outcome: RebuildClustersOutcome }
  | { kind: "errored"; runId: string | null; error: string }

/**
 * Pure handler. Returns one of four outcomes for assertion in tests; no
 * throws (retry-storms against pa-events docs are wasteful — next pipeline
 * run will re-trigger anyway).
 */
export async function handleClusterRebuildEvent(
  input: ClusterRebuildHandlerInput,
  deps: ClusterRebuildHandlerDeps
): Promise<ClusterRebuildHandlerResult> {
  const log = deps.log ?? (() => {})
  const errorLog = deps.errorLog ?? log

  const data = input.eventData
  if (!data || data.eventKind !== TARGET_EVENT_KIND) {
    return { kind: "skipped_event_kind" }
  }

  const runId =
    typeof data.runId === "string" && data.runId.length > 0 ? data.runId : null

  let flagOn = false
  try {
    flagOn = await deps.isFlagOn()
  } catch (err) {
    errorLog("paJobRecClusterRebuild flag_read_failed", {
      error: err instanceof Error ? err.message : String(err),
    })
  }
  if (!flagOn) {
    log("paJobRecClusterRebuild flag_off_skipping", {
      eventId: input.eventId,
      runId,
    })
    return { kind: "skipped_flag_off", runId }
  }

  try {
    const outcome = await rebuildClusters({
      db: deps.db,
      runId,
      log,
    })
    log("paJobRecClusterRebuild rebuild_complete", {
      eventId: input.eventId,
      runId,
      ...outcome,
    })
    return { kind: "rebuilt", runId, outcome }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    errorLog("paJobRecClusterRebuild fatal", {
      eventId: input.eventId,
      runId,
      error: msg,
    })
    return { kind: "errored", runId, error: msg }
  }
}

// ---------------------------------------------------------------------------
// Production CF — thin shim over handleClusterRebuildEvent.
// ---------------------------------------------------------------------------

export const paJobRecClusterRebuild = onDocumentCreated(
  {
    document: "pa-events/{id}",
    region: "us-central1",
    memory: "512MiB",
    timeoutSeconds: 540,
    concurrency: 1,
    retry: false,
  },
  async (event) => {
    const snap = event.data
    if (!snap) {
      logger.warn("paJobRecClusterRebuild fired without snapshot", {
        id: event.params.id,
      })
      return
    }
    const data = snap.data() as
      | { eventKind?: string; runId?: string }
      | undefined
    await handleClusterRebuildEvent(
      { eventData: data, eventId: event.params.id },
      {
        db: getFirestore(),
        isFlagOn: async () =>
          Boolean(
            await getFlag(
              getFirestore(),
              PA_TAG_CLUSTER_REC_FLAG_KEY,
              { env: process.env },
              false
            )
          ),
        log: (...args: unknown[]) => logger.info("[cluster-rebuild]", ...args),
        errorLog: (...args: unknown[]) => logger.error("[cluster-rebuild]", ...args),
      }
    )
  }
)
