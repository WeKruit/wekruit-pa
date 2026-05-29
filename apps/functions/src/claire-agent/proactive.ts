/**
 * proactive.ts — WS-proactive owns this file.
 *
 * OUTBOUND-INITIATED turns (cron/event, not an inbound message): post-match
 * retention, daily job-rec push, proactive follow-ups. SAME agent + tools; only the
 * trigger differs. Wraps the existing post-match-retention.ts + proactive-turn.ts +
 * daily batch CF behind a `runProactiveTurn(userId, kind)` entry that:
 *   - builds the same Agent with a proactive system-prompt directive,
 *   - emits via the same delivery tools (status/text),
 *   - dedups already-sent jobs + respects opt-out/cooldown,
 *   - is idempotent (a retry never double-sends — keyed).
 * Multi-bubble split = a prompt instruction ("split into ≤2 short bubbles") or repeated
 * send, NOT probabilistic-split.ts.
 *
 * WS-proactive: implement runProactiveTurn + its L3 side-effect eval.
 */
import type { Firestore } from "firebase-admin/firestore"
import { notImplemented } from "./types.js"

export type ProactiveKind = "post_match_retention" | "daily_job_rec" | "follow_up"

export interface RunProactiveTurnDeps {
  db: Firestore
  log?: (event: string, payload?: Record<string, unknown>) => void
}

export interface ProactiveTurnOutcome {
  sent: boolean
  reason?: string
  outboundCount: number
}

export async function runProactiveTurn(
  userId: string,
  kind: ProactiveKind,
  deps: RunProactiveTurnDeps,
): Promise<ProactiveTurnOutcome> {
  return notImplemented("WS-proactive", "proactive.runProactiveTurn")
}
