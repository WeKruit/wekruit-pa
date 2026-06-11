/**
 * audience-provision.ts — widen the rec-cadence audience (Adam 2026-06-11:
 * "every 2-3 days we should send some job matching to users").
 *
 * WHY THIS EXISTS
 * ---------------
 * The daily batch (`runDailyJobRecBatch`) selects ONLY `pa-job-profiles`
 * rows with `status == "active"`. Measured prod (2026-06-11): 20 active
 * profiles vs 215 pa-users with `tags.targetRoleFunction` — so the 2-3 day
 * cadence reached 20 users, not the matched-ready fleet. This pre-pass
 * AUTO-PROVISIONS a minimal active profile row for every eligible user who
 * is missing one, so the existing cadence machinery (due-gate, jitter,
 * per-number pacing, cooldown, repeat-job exclusion) covers them.
 *
 * ELIGIBILITY (deterministic, all must hold)
 * ------------------------------------------
 *   - `pa-users.tags.targetRoleFunction` non-empty array (V16 has a role axis
 *     to match on — profiles without it would only burn the corrupt-profile
 *     skip path)
 *   - `phoneE164` present (reachable over iMessage)
 *   - `doNotContact !== true` (deterministic STOP gate, 2026-06-10 — never
 *     provision an opted-out user into a proactive send audience)
 *   - no OPEN prescreen work session (prescreen owns the thread — reuse the
 *     pure `hasOpenPrescreenWorkSession` check on the already-loaded doc)
 *
 * SAFETY INVARIANTS
 * -----------------
 *   - IDEMPOTENT: existing `pa-job-profiles` rows are NEVER touched. In
 *     particular an operator-paused row (`status:"paused"`) must stay paused.
 *     Guarded twice: a pre-filter against the existing-id set AND a
 *     transactional exists-check at write time (race-proof).
 *   - RAMP: at most `maxNewProfiles` (default 60) rows created per run, in
 *     deterministic userId order, so the fleet phases in over ~4 daily runs
 *     instead of one 200-user burst on day one.
 *   - The minimal profile is the legacy "no preference" shape
 *     (`industry:"any"` etc) — matching itself reads `pa-users.tags` via the
 *     V16 cascade; this row only opts the user into the cadence loop.
 */

import type { Firestore } from "firebase-admin/firestore"
import { hasOpenPrescreenWorkSession } from "./prescreen-guard.js"
import { JOB_PROFILES_COLLECTION, type JobProfileDoc } from "./types.js"

/** Provenance marker written on every auto-provisioned profile row. */
export const AUDIENCE_PROVISION_SOURCE = "auto_cadence_2026_06"

/** Ramp cap — max NEW profile rows created per run (~4 days to cover the fleet). */
export const DEFAULT_PROVISION_CAP_PER_RUN = 60

/** Upper bound on the pa-users scan (fleet is ~450 today; generous headroom). */
export const DEFAULT_PROVISION_USER_SCAN_CAP = 5000

export type ProvisionAudienceDeps = {
  db: Firestore
  nowIso?: () => string
  nowMs?: number
  /** Ramp cap override (tests). Default 60. */
  maxNewProfiles?: number
  /** pa-users scan cap override (tests). Default 5000. */
  userScanCap?: number
  log?: (event: string, payload?: Record<string, unknown>) => void
}

export type ProvisionAudienceOutcome = {
  scannedUsers: number
  /** Users passing every eligibility gate (provisioned + alreadyProvisioned + cappedOut). */
  eligible: number
  /** Eligible users who already have a pa-job-profiles row (any status) — untouched. */
  alreadyProvisioned: number
  /** New rows actually created this run. */
  provisioned: number
  /** Eligible-but-deferred to a later run by the ramp cap. */
  cappedOut: number
  skippedDoNotContact: number
  skippedOpenPrescreen: number
  errors: number
}

function cleanStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((v): v is string => typeof v === "string" && v.trim().length > 0)
    : []
}

function isEligibleUser(data: Record<string, unknown>, nowMs: number): {
  eligible: boolean
  reason?: "no_target_role" | "no_phone" | "do_not_contact" | "open_prescreen"
} {
  const tags =
    data.tags && typeof data.tags === "object" ? (data.tags as Record<string, unknown>) : null
  const targetRoleFunction = cleanStringArray(tags?.targetRoleFunction)
  if (targetRoleFunction.length === 0) return { eligible: false, reason: "no_target_role" }
  const phone = typeof data.phoneE164 === "string" ? data.phoneE164.trim() : ""
  if (!phone) return { eligible: false, reason: "no_phone" }
  if (data.doNotContact === true) return { eligible: false, reason: "do_not_contact" }
  if (hasOpenPrescreenWorkSession(data, nowMs)) return { eligible: false, reason: "open_prescreen" }
  return { eligible: true }
}

/**
 * Pre-pass: provision minimal active `pa-job-profiles` rows for eligible
 * users missing one. NEVER throws — any error is counted + logged so the
 * batch behind it always runs.
 */
export async function provisionCadenceAudience(
  deps: ProvisionAudienceDeps
): Promise<ProvisionAudienceOutcome> {
  const log = deps.log ?? (() => {})
  const nowIso = deps.nowIso ?? (() => new Date().toISOString())
  const nowMs = deps.nowMs ?? Date.now()
  const cap = deps.maxNewProfiles ?? DEFAULT_PROVISION_CAP_PER_RUN
  const userScanCap = deps.userScanCap ?? DEFAULT_PROVISION_USER_SCAN_CAP

  const outcome: ProvisionAudienceOutcome = {
    scannedUsers: 0,
    eligible: 0,
    alreadyProvisioned: 0,
    provisioned: 0,
    cappedOut: 0,
    skippedDoNotContact: 0,
    skippedOpenPrescreen: 0,
    errors: 0,
  }

  // 1. Existing profile ids (ANY status — paused/onboarding rows must never be
  //    re-created or flipped). select() = id-only projection, cheap.
  const existingIds = new Set<string>()
  try {
    const profSnap = await deps.db
      .collection(JOB_PROFILES_COLLECTION)
      .select()
      .limit(userScanCap)
      .get()
    for (const doc of profSnap.docs) existingIds.add(doc.id)
  } catch (err) {
    // Without the existing-id set we cannot guarantee idempotency cheaply —
    // bail out entirely (the transactional guard would still protect us, but
    // a failed read here usually means Firestore is unhappy; don't pile on).
    outcome.errors += 1
    log("audience_provision.existing_profiles_read_failed", {
      error: err instanceof Error ? err.message : String(err),
    })
    return outcome
  }

  // 2. Scan pa-users + gate eligibility in memory (fleet ~450 docs; one
  //    bounded scan per daily run).
  const candidates: string[] = []
  try {
    const usersSnap = await deps.db.collection("pa-users").limit(userScanCap).get()
    outcome.scannedUsers = usersSnap.size
    for (const doc of usersSnap.docs) {
      const data = (doc.data() ?? {}) as Record<string, unknown>
      const verdict = isEligibleUser(data, nowMs)
      if (!verdict.eligible) {
        if (verdict.reason === "do_not_contact") outcome.skippedDoNotContact += 1
        if (verdict.reason === "open_prescreen") outcome.skippedOpenPrescreen += 1
        continue
      }
      outcome.eligible += 1
      if (existingIds.has(doc.id)) {
        outcome.alreadyProvisioned += 1
        continue
      }
      candidates.push(doc.id)
    }
  } catch (err) {
    outcome.errors += 1
    log("audience_provision.user_scan_failed", {
      error: err instanceof Error ? err.message : String(err),
    })
    return outcome
  }

  // 3. Ramp: deterministic order, cap new rows per run.
  candidates.sort()
  const toProvision = candidates.slice(0, Math.max(0, cap))
  outcome.cappedOut = candidates.length - toProvision.length

  for (const userId of toProvision) {
    try {
      const ref = deps.db.collection(JOB_PROFILES_COLLECTION).doc(userId)
      const ts = nowIso()
      const created = await deps.db.runTransaction(async (tx) => {
        const cur = await tx.get(ref)
        // Race guard — a row that appeared since the pre-filter is NEVER
        // touched (idempotency; operator-paused rows must stay paused).
        if (cur.exists) return false
        const doc: JobProfileDoc & { source: string } = {
          userId,
          // Minimal "no preference" legacy shape — matching reads
          // pa-users.tags (V16 cascade); this row only enrolls the user.
          profile: { industry: "any", sponsorship: "either", location: "", sizePreference: "either" },
          cvParsedAt: ts,
          lastJobBatchSentAt: null,
          status: "active",
          createdAt: ts,
          updatedAt: ts,
          source: AUDIENCE_PROVISION_SOURCE,
        }
        tx.set(ref, doc)
        return true
      })
      if (created) outcome.provisioned += 1
      else outcome.alreadyProvisioned += 1
    } catch (err) {
      outcome.errors += 1
      log("audience_provision.write_failed", {
        userId,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  log("audience_provision.complete", { ...outcome })
  return outcome
}
