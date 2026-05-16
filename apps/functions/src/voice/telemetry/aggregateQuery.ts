/**
 * S4 — Voice telemetry aggregate query.
 *
 * Admin-claim-gated callable Cloud Function. Returns the four Done-criteria
 * thresholds plus context counts so S6 smoke gate can read a single shape:
 *
 *   - falseCommitPct        — % of turns where falseCommit=true
 *   - falseInterruptPct     — % of turns where falseInterruption=true
 *   - ttfaP50Ms / ttfaP95Ms — turn-level TTFA percentiles
 *   - avgCostUsd            — call-level mean
 *   - costCeilingHits       — count of calls finalized with status failed:cost_ceiling
 *   - agentTalkRatio        — Σ(agentResponseMs) / Σ(agentResponseMs+userUtteranceMs)
 *
 * Reads calls (`voice-call-metrics`) by `startedAt` window, then fetches
 * each call's `turns` subcollection. Bound at 1000 calls per query so we
 * don't blow Firestore reads on a long window.
 */

import { onCall, HttpsError } from "firebase-functions/v2/https"
import { defineSecret } from "firebase-functions/params"
import { getFirestore, type Firestore } from "firebase-admin/firestore"
import { z } from "zod"

import { authorizeAdminCallable } from "../../promote-sandbox-tag.js"
import {
  type VoiceCallLifecycle,
  type VoiceTurnMetric,
  VOICE_CALL_METRICS_COLLECTION,
} from "./types.js"

const PA_ADMIN_TOKEN = defineSecret("PA_ADMIN_TOKEN")

export const VoiceTelemetryAggregateInputSchema = z.object({
  windowMinutes: z.number().int().min(1).max(7 * 24 * 60).default(60),
  adminToken: z.string().optional(),
  maxCalls: z.number().int().min(1).max(2000).default(1000),
})

export type VoiceTelemetryAggregateInput = z.input<
  typeof VoiceTelemetryAggregateInputSchema
>

export interface VoiceTelemetryAggregateResult {
  windowMinutes: number
  callsConsidered: number
  turnsConsidered: number
  falseCommitPct: number | null
  falseInterruptPct: number | null
  ttfaP50Ms: number | null
  ttfaP95Ms: number | null
  avgCostUsd: number | null
  costCeilingHits: number
  agentTalkRatio: number | null
}

export interface AggregateQueryDeps {
  db: Firestore
  now?: () => number
}

/** Pure aggregator — extracted for unit-testability without onCall plumbing. */
export async function runVoiceTelemetryAggregate(
  input: { windowMinutes: number; maxCalls: number },
  deps: AggregateQueryDeps,
): Promise<VoiceTelemetryAggregateResult> {
  const now = deps.now ?? (() => Date.now())
  const cutoffMs = now() - input.windowMinutes * 60_000

  const callsSnap = await deps.db
    .collection(VOICE_CALL_METRICS_COLLECTION)
    .where("startedAt", ">=", cutoffMs)
    .orderBy("startedAt", "desc")
    .limit(input.maxCalls)
    .get()

  const callDocs = callsSnap.docs.map((d) => d.data() as VoiceCallLifecycle)

  if (callDocs.length === 0) {
    return {
      windowMinutes: input.windowMinutes,
      callsConsidered: 0,
      turnsConsidered: 0,
      falseCommitPct: null,
      falseInterruptPct: null,
      ttfaP50Ms: null,
      ttfaP95Ms: null,
      avgCostUsd: null,
      costCeilingHits: 0,
      agentTalkRatio: null,
    }
  }

  // Parallel-fetch each call's turn subcollection.
  const turnsByCall = await Promise.all(
    callDocs.map(async (c) => {
      const tSnap = await deps.db
        .collection(VOICE_CALL_METRICS_COLLECTION)
        .doc(c.voiceCallSid)
        .collection("turns")
        .get()
      return tSnap.docs.map((d) => d.data() as VoiceTurnMetric)
    }),
  )

  const turns: VoiceTurnMetric[] = turnsByCall.flat()
  const totalTurns = turns.length

  let falseCommits = 0
  let falseInterrupts = 0
  let sumAgentMs = 0
  let sumUserMs = 0
  const ttfas: number[] = []

  for (const t of turns) {
    if (t.falseCommit) falseCommits += 1
    if (t.falseInterruption) falseInterrupts += 1
    if (typeof t.agentResponseMs === "number") sumAgentMs += t.agentResponseMs
    if (typeof t.userUtteranceMs === "number") sumUserMs += t.userUtteranceMs
    if (typeof t.ttfaMs === "number" && t.ttfaMs >= 0) ttfas.push(t.ttfaMs)
  }

  let costSum = 0
  let costN = 0
  let costCeilingHits = 0
  for (const c of callDocs) {
    if (typeof c.totalCostUsd === "number") {
      costSum += c.totalCostUsd
      costN += 1
    }
    if (c.status === "failed:cost_ceiling") {
      costCeilingHits += 1
    }
  }

  return {
    windowMinutes: input.windowMinutes,
    callsConsidered: callDocs.length,
    turnsConsidered: totalTurns,
    falseCommitPct: totalTurns ? (falseCommits / totalTurns) * 100 : null,
    falseInterruptPct: totalTurns ? (falseInterrupts / totalTurns) * 100 : null,
    ttfaP50Ms: percentile(ttfas, 0.5),
    ttfaP95Ms: percentile(ttfas, 0.95),
    avgCostUsd: costN ? costSum / costN : null,
    costCeilingHits,
    agentTalkRatio:
      sumAgentMs + sumUserMs > 0 ? sumAgentMs / (sumAgentMs + sumUserMs) : null,
  }
}

function percentile(values: number[], pct: number): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const idx = Math.min(
    sorted.length - 1,
    Math.max(0, Math.floor(pct * (sorted.length - 1))),
  )
  return sorted[idx] ?? null
}

// ---------------------------------------------------------------------------
// Cloud Function entry — admin gated, thin shim over runVoiceTelemetryAggregate.
// ---------------------------------------------------------------------------

export const paAdminVoiceTelemetryAggregate = onCall(
  {
    region: "us-central1",
    memory: "256MiB",
    timeoutSeconds: 60,
    secrets: [PA_ADMIN_TOKEN],
  },
  async (req): Promise<VoiceTelemetryAggregateResult> => {
    authorizeAdminCallable(
      req as { auth?: { token?: { admin?: unknown } }; data?: unknown },
    )

    const parsed = VoiceTelemetryAggregateInputSchema.safeParse(req.data ?? {})
    if (!parsed.success) {
      throw new HttpsError("invalid-argument", parsed.error.message)
    }

    const db = getFirestore()
    return runVoiceTelemetryAggregate(
      { windowMinutes: parsed.data.windowMinutes, maxCalls: parsed.data.maxCalls },
      { db },
    )
  },
)
