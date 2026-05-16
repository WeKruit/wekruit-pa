/**
 * v2.1 S6 — Voice metrics adapter (S4 contract).
 *
 * Reads `voice-call-metrics/{callSid}` (per-call row) and the S4
 * `paAdminVoiceTelemetryAggregate` callable for aggregated rollups.
 *
 * Aggregate response shape (per MILESTONE v2.1 S4):
 *   {
 *     sampleSize: number,
 *     p50TtfaMs: number,
 *     p95TtfaMs: number,
 *     falseCommitRate: number,    // 0..1
 *     falseInterruptRate: number, // 0..1
 *     costPerCallUsd: number,     // mean
 *     agentTalkRatio: number,
 *   }
 *
 * Live mode lazy-imports `firebase-admin` to invoke the callable via
 * Functions. Mock mode returns canned rows. No top-level side effects.
 */

/** Make a synthetic aggregate from per-call rows (used by mock + driver). */
export function aggregateRows(rows) {
  const n = rows.length
  if (n === 0) {
    return {
      sampleSize: 0,
      p50TtfaMs: 0,
      p95TtfaMs: 0,
      falseCommitRate: 0,
      falseInterruptRate: 0,
      costPerCallUsd: 0,
      agentTalkRatio: 0,
    }
  }
  const ttfas = rows.map((r) => r.ttfaMs ?? 0).sort((a, b) => a - b)
  const p50 = ttfas[Math.floor(n * 0.5)]
  const p95 = ttfas[Math.min(n - 1, Math.floor(n * 0.95))]
  const fc = rows.reduce((s, r) => s + (r.falseCommit ? 1 : 0), 0) / n
  const fi = rows.reduce((s, r) => s + (r.falseInterrupt ? 1 : 0), 0) / n
  const cost = rows.reduce((s, r) => s + (r.costUsd ?? 0), 0) / n
  const ratio = rows.reduce((s, r) => s + (r.agentTalkRatio ?? 0), 0) / n
  return {
    sampleSize: n,
    p50TtfaMs: p50,
    p95TtfaMs: p95,
    falseCommitRate: fc,
    falseInterruptRate: fi,
    costPerCallUsd: cost,
    agentTalkRatio: ratio,
  }
}

/** Mock metrics adapter — returns canned per-call rows + computed aggregate. */
export function createMockMetricsAdapter(rowsByCallSid = {}) {
  return {
    kind: "mock",
    async readCallMetrics(callSid) {
      return rowsByCallSid[callSid] ? { ...rowsByCallSid[callSid] } : null
    },
    async fetchAggregate(callSids) {
      const rows = callSids
        .map((sid) => rowsByCallSid[sid])
        .filter((r) => r !== undefined)
      return aggregateRows(rows)
    },
  }
}

/** Live metrics adapter — wraps firebase-admin Firestore + callable. */
export async function createLiveMetricsAdapter() {
  // eslint-disable-next-line import/no-unresolved
  const admin = await import("firebase-admin")
  if (admin.default.apps.length === 0) {
    admin.default.initializeApp({
      credential: admin.default.credential.applicationDefault(),
    })
  }
  const db = admin.default.firestore()
  return {
    kind: "live",
    async readCallMetrics(callSid) {
      const snap = await db.collection("voice-call-metrics").doc(callSid).get()
      return snap.exists ? snap.data() : null
    },
    async fetchAggregate(callSids) {
      // Query rows directly — S4's aggregate callable is admin-only and
      // production-bound; smoke driver runs offline-after-call and so
      // computes the aggregate locally from the same rows.
      if (callSids.length === 0) return aggregateRows([])
      const rows = []
      for (const sid of callSids) {
        const snap = await db.collection("voice-call-metrics").doc(sid).get()
        if (snap.exists) rows.push(snap.data())
      }
      return aggregateRows(rows)
    },
  }
}

/** Threshold check against Done-criteria (S6 ACCEPTANCE.md). */
export function checkThresholds(aggregate, opts = {}) {
  const p50Max = opts.p50TtfaMaxMs ?? 1500
  const costMax = opts.costMaxUsd ?? 1.0
  const fcMax = opts.falseCommitMax ?? 0.1
  const fiMax = opts.falseInterruptMax ?? 0.05
  return {
    p50TtfaPass: aggregate.p50TtfaMs < p50Max,
    costPerCallPass: aggregate.costPerCallUsd < costMax,
    falseCommitPass: aggregate.falseCommitRate < fcMax,
    falseInterruptPass: aggregate.falseInterruptRate < fiMax,
  }
}
