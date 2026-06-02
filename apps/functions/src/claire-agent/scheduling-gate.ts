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
 * candidates by editing the flag's allowlist (or flipping its value), NOT a code
 * deploy.
 *
 * Ramp lever (the ONE thing Adam edits — no deploy):
 *   pa-feature-flags/paSchedulingEnabled
 *     - add a uid to `allowlist`  → that real candidate can schedule
 *     - set `value: true` (global perUser default) → all candidates can schedule
 *   (seed it once via paAdminBootstrap action=seedFlags; SCHEDULING_FLAG_SEED.)
 *
 * Fail-CLOSED on read error: if the flag read throws, a non-dev uid is NOT
 * widened (returns dev-uids-only result) — an outage never accidentally opens
 * scheduling/outbound to real candidates.
 */
import type { Firestore } from "firebase-admin/firestore"
import { getFlag } from "@pa/pa-persistence"

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
 * adding uids to the allowlist (or flipping value:true) on the live doc.
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
 *   (a) uid ∈ SCHEDULING_DEV_UIDS                         → true (unchanged floor)
 *   (b) getFlag(paSchedulingEnabled, {userId}) === true   → true (Adam-ramp)
 *   else                                                  → false
 *
 * At the live default (flag absent / value:false / empty allowlist) this returns
 * EXACTLY today's behavior: true only for the dev uids. Fail-closed: a flag read
 * error keeps a non-dev uid at false. Pass `env` so the `paSchedulingEnabled=1`
 * emergency env override works in evals/tests (same convention as the other flags).
 */
export async function isSchedulingEligible(
  db: Firestore,
  userId: string | null | undefined,
  opts?: { env?: NodeJS.ProcessEnv | Record<string, string | undefined> },
): Promise<boolean> {
  if (isSchedulingDevUid(userId)) return true
  if (typeof userId !== "string" || userId.length === 0) return false
  try {
    const value = await getFlag(
      db,
      SCHEDULING_FLAG_KEY,
      { userId, ...(opts?.env ? { env: opts.env } : {}) },
      false,
    )
    return value === true
  } catch {
    // Fail-closed — never widen scheduling/outbound to a real candidate on a read error.
    return false
  }
}
