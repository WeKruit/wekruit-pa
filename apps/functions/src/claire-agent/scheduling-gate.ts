/**
 * scheduling-gate.ts — the SINGLE, widenable "is this candidate allowed to
 * schedule an interview?" resolver. No @openai/agents SDK import (deliberately
 * light) so the HITL commit path (evaluation-attempts.ts) can call it without
 * paying the agent-SDK boot cost.
 *
 * DEFAULT (today, byte-identical): scheduling is allowed ONLY for the two dev
 * uids in SCHEDULING_DEV_UIDS (Adam +14243201960, Noah +12154034668). The
 * resolver becomes WIDENABLE by adding a `paSchedulingEnabled` feature-flag check
 * (perUser allowlist, same mechanism as paThinClaireEnabled). With the flag
 * absent / off / empty allowlist — the live default — the resolver returns
 * EXACTLY today's behavior: dev-uids-only. Adam ramps scheduling to real
 * candidates by adding their uid to the flag's allowlist (per-uid ONLY — a global
 * value flip is not honored, locked rule c), NOT a code deploy.
 *
 * Ramp lever (the ONE thing Adam edits — no deploy):
 *   pa-feature-flags/paSchedulingEnabled
 *     - add a uid to `allowlist`  → that real candidate can schedule
 *   ALLOWLIST-ONLY by design (locked rule c): a global `value:true` flip is NOT a
 *   lever here — isSchedulingEligible ignores it. Ramp is strictly per-uid so one
 *   flip can never enable the whole fleet.
 *   (seed it once via paAdminBootstrap action=seedFlags; SCHEDULING_FLAG_SEED.)
 *
 * Fail-CLOSED on read error: if the flag read throws, a non-dev uid is NOT
 * widened (returns dev-uids-only result) — an outage never accidentally opens
 * scheduling/outbound to real candidates.
 */
import type { Firestore } from "firebase-admin/firestore"
import { isUserAllowlisted } from "@pa/pa-persistence"

/**
 * WRITE-action dev allowlist (Adam +14243201960 = 8fEwIduUrzxZsblHHsNz, Noah
 * +12154034668 = UKFaKdsMzzfPW2CDl5ve). Mirrors REC_CARD_UIDS in cutover.ts.
 * This is the FLOOR — always scheduling-eligible regardless of the flag. The
 * single source of truth for the dev cohort; scheduling-tools.ts re-exports it.
 */
export const SCHEDULING_DEV_UIDS = new Set<string>(["8fEwIduUrzxZsblHHsNz", "UKFaKdsMzzfPW2CDl5ve"])

/** Widenable scheduling gate flag (perUser allowlist; default OFF = dev-uids-only). */
export const SCHEDULING_FLAG_KEY = "paSchedulingEnabled"

/**
 * Seed descriptor for admin-bootstrap.ts. perUser, value:false, EMPTY allowlist
 * by design — so the seeded default is INERT (dev-uids-only). Adam ramps by
 * adding uids to the allowlist on the live doc (value:true is NOT a lever — the
 * gate is allowlist-only, locked rule c).
 */
export const SCHEDULING_FLAG_SEED = {
  key: SCHEDULING_FLAG_KEY,
  value: false,
  type: "bool" as const,
  scope: "perUser" as const,
  allowlist: [] as string[],
  blocklist: [] as string[],
}

/** True iff `userId` is a hardcoded scheduling dev uid (the floor — never widened off). */
export function isSchedulingDevUid(userId: string | null | undefined): boolean {
  return typeof userId === "string" && SCHEDULING_DEV_UIDS.has(userId)
}

/**
 * Resolve whether `userId` may schedule an interview.
 *
 *   (a) uid ∈ SCHEDULING_DEV_UIDS                                  → true (floor)
 *   (b) uid ∈ paSchedulingEnabled.allowlist (perUser bool)         → true (Adam-ramp)
 *   else                                                           → false
 *
 * ALLOWLIST-ONLY (locked rule c): a real candidate becomes eligible ONLY by being
 * added to the flag's `allowlist` per-uid. A global `value:true` flip or a
 * `paSchedulingEnabled=1` env var DOES NOT widen the gate — those blanket levers are
 * deliberately NOT honored here so one flip can never enable scheduling fleet-wide.
 * (Was a hole: the old getFlag path returned true on global value/env — QA H2.)
 *
 * `_opts` is retained for call-site back-compat (callers pass `{ env }`) but is
 * intentionally unused — env override is no longer a scheduling lever. Fail-closed:
 * a flag read error keeps a non-dev uid at false.
 */
export async function isSchedulingEligible(
  db: Firestore,
  userId: string | null | undefined,
  _opts?: { env?: NodeJS.ProcessEnv | Record<string, string | undefined> },
): Promise<boolean> {
  if (isSchedulingDevUid(userId)) return true
  if (typeof userId !== "string" || userId.length === 0) return false
  try {
    // Per-uid allowlist membership ONLY — never global value, never env override.
    return await isUserAllowlisted(db, SCHEDULING_FLAG_KEY, userId)
  } catch {
    // Fail-closed — never widen scheduling/outbound to a real candidate on a read error.
    return false
  }
}
