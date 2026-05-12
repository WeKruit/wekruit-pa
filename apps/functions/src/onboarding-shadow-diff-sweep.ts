/**
 * v1.8 Phase 81 — paOnboardingShadowDiffSweep handler.
 *
 * Daily aggregate of pa-onboarding-shadow-diff records (written when v2
 * shadow ran alongside v1 for a user). Computes mean Jaccard + diff rate
 * + state-disagreement rate per the PS10 gate criteria.
 *
 * Writes a summary doc to pa-onboarding-shadow-summaries/{YYYY-MM-DD}.
 * Adam reads the dashboard or runs the gate evaluator manually after
 * 7 days to decide if default v1 → v2 flip.
 */
import type { Firestore } from "firebase-admin/firestore"
import { evaluateShadowGate, type OnboardingShadowDiff } from "@pa/pa-orchestrator"

export interface ShadowSweepResult {
  date: string
  diffCount: number
  meanJaccard: number
  diffRate: number
  stateDisagreeRate: number
  gateWouldPass: boolean
  reason?: string
}

export async function runOnboardingShadowDiffSweep(args: {
  db: Firestore
  log?: (event: string, payload: Record<string, unknown>) => void
}): Promise<ShadowSweepResult> {
  const log = args.log ?? (() => {})
  // Aggregate the last 24h of shadow diff records.
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
  const today = new Date().toISOString().slice(0, 10)

  const snap = await args.db
    .collection("pa-onboarding-shadow-diff")
    .where("ts", ">=", since)
    .get()
  const diffs: OnboardingShadowDiff[] = snap.docs.map((d) => d.data() as OnboardingShadowDiff)
  if (diffs.length === 0) {
    const result: ShadowSweepResult = {
      date: today,
      diffCount: 0,
      meanJaccard: 0,
      diffRate: 0,
      stateDisagreeRate: 0,
      gateWouldPass: false,
      reason: "no_diffs",
    }
    await args.db.collection("pa-onboarding-shadow-summaries").doc(today).set({
      ...result,
      ts: new Date().toISOString(),
    })
    log("shadow.no_diffs", {})
    return result
  }
  const gate = evaluateShadowGate(diffs)
  const result: ShadowSweepResult = {
    date: today,
    diffCount: diffs.length,
    meanJaccard: gate.meanJaccard,
    diffRate: gate.diffRate,
    stateDisagreeRate: gate.stateDisagreeRate,
    gateWouldPass: gate.gatePassed,
    reason: gate.reason,
  }
  await args.db.collection("pa-onboarding-shadow-summaries").doc(today).set({
    ...result,
    ts: new Date().toISOString(),
  })
  log("shadow.sweep_complete", { diffCount: diffs.length, diffRate: gate.diffRate, gateWouldPass: gate.gatePassed })
  return result
}
