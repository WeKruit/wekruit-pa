/**
 * suppression.ts — the single authoritative "may we text this candidate?" gate
 * for the recovery campaign (and any other pa-pending-outbound consumer).
 *
 * WHY THIS EXISTS
 * ---------------
 * The recovery campaign re-texts candidates whose inbound message was dropped.
 * It MUST NEVER text someone who opted out. Audit (2026-06-01) found that
 * opt-out capture is weak: there were 0 `candidateLifecycleState == "opted_out"`
 * profiles and 0 captured bare-"STOP" replies, because:
 *
 *   1. The Sendblue webhook (sendblue/webhook.ts) does NOT detect "STOP" /
 *      "unsubscribe" / opt-out replies at all — they flow through as ordinary
 *      inbound text to the orchestrator.
 *   2. The only in-chat opt-out path (orchestrator detectPrivacyIntent →
 *      stop_outreach) requires a narrow phrase ("stop texting" / "stop
 *      outreach" / "pause messages"), NOT a bare "STOP", and when it fires it
 *      only files a `pa-privacy-requests` row with status "submitted" — it does
 *      NOT set any suppression field that the outbound path reads.
 *
 * Because capture is weak, this gate is deliberately BROAD and FAIL-CLOSED:
 * it reads every opt-out signal that exists anywhere in the system, treats a
 * filed-but-unprocessed `stop_outreach`/`delete` privacy request as a hard
 * suppression, and — for the recovery kind — suppresses on ANY read error
 * (we would rather skip a legitimate recovery than text someone who opted out).
 *
 * SIGNALS CHECKED (every authoritative source found in the audit)
 * ---------------------------------------------------------------
 *   - pa-outreach-stop-controls (scope:"global")  → ops kill switch
 *   - pa-users.candidateLifecycleState in {opted_out, deleted}
 *   - pa-users.candidateLifecycle.state (defensive alias) in {opted_out, deleted}
 *   - pa-users.outreach.status in {opted_out, paused}
 *   - pa-users.doNotContact === true
 *   - pa-users.outreachPaused === true
 *   - pa-users.dailyJobRecSubscribe.optedIn === false   (the only signal with live data)
 *   - pa-users.outreach.cooldownUntil in the future / outreach.lastOutboundAt recent
 *     (recent-outbound is NOT suppression by itself for recovery; reported but not blocking)
 *   - pa-privacy-requests rows for this candidate with kind in
 *     {stop_outreach, delete} and status in {submitted, in_review, completed}
 *     → captures the "filed but never applied to pa-users" gap.
 *   - pa-users missing / has no doc → fail-closed for recovery.
 *
 * This module performs READ-ONLY checks. It never sends and never mutates.
 */

import type { Firestore } from "firebase-admin/firestore"
import { PA_COLLECTIONS } from "@pa/core-types"

/** Outbound kinds. `recovery` is the fail-closed, safety-critical kind. */
export type SuppressionKind = "recovery" | string

export interface IsSuppressedOptions {
  /**
   * The outbound kind being gated. `recovery` (default) fails CLOSED: any
   * read error, a missing profile, or an unreachable phone counts as
   * suppressed. Other kinds fail OPEN on transient read errors (they have
   * their own downstream gates).
   */
  kind?: SuppressionKind
  /** Clock override for tests. */
  now?: () => Date
  /**
   * If true, a recent outbound (within the 7-day global cooldown) or a future
   * cooldownUntil is treated as suppression. Recovery campaigns usually WANT to
   * re-reach a dropped inbound regardless of cooldown, so this defaults to
   * false (cooldown is reported in signals but does not block). Set true to
   * make this gate also enforce the outbound cadence cooldown.
   */
  enforceCooldown?: boolean
}

export interface SuppressionResult {
  /** True → DO NOT SEND. */
  suppressed: boolean
  /** Machine reason for the decision (first hard signal, or "clear"). */
  reason: string
  /** Every suppression signal that fired (for audit / dashboards). */
  signals: string[]
  /** True when suppression was decided by failing closed (error / missing). */
  failedClosed: boolean
}

const GLOBAL_OUTBOUND_COOLDOWN_DAYS = 7

/** Privacy-request kinds that mean "stop contacting me" once filed. */
const SUPPRESSING_PRIVACY_KINDS = new Set(["stop_outreach", "delete"])
/**
 * Privacy-request statuses that count. A submitted-but-unprocessed stop request
 * MUST suppress (that is the core gap). `rejected` / `cancelled` do not.
 */
const SUPPRESSING_PRIVACY_STATUSES = new Set(["submitted", "in_review", "completed", "fulfilled"])

function parseMs(value: unknown): number {
  if (typeof value !== "string") return 0
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? ms : 0
}

function isFuture(value: unknown, nowMs: number): boolean {
  const ms = parseMs(value)
  return ms > 0 && ms > nowMs
}

function isWithinDays(value: unknown, nowMs: number, days: number): boolean {
  const ms = parseMs(value)
  if (!ms) return false
  return nowMs >= ms && nowMs - ms < days * 24 * 60 * 60 * 1000
}

/**
 * Decide whether `userId` is suppressed from outbound. Fail-CLOSED for the
 * recovery kind. Pure read; never sends, never mutates.
 */
export async function isSuppressed(
  db: Firestore,
  userId: string,
  options: IsSuppressedOptions = {}
): Promise<SuppressionResult> {
  const kind = options.kind ?? "recovery"
  const failClosed = kind === "recovery"
  const nowMs = (options.now ? options.now() : new Date()).getTime()
  const signals: string[] = []

  if (!userId || typeof userId !== "string") {
    return {
      suppressed: true,
      reason: "missing_user_id",
      signals: ["missing_user_id"],
      failedClosed: true,
    }
  }

  // ---- 1. Global outreach kill switch (pa-outreach-stop-controls) ---------
  try {
    const controlId = "global"
    const snap = await db
      .collection(PA_COLLECTIONS.outreachStopControls)
      .doc(controlId)
      .get()
    if (snap.exists && (snap.data() as { paused?: unknown } | undefined)?.paused === true) {
      signals.push("global_outreach_paused")
      return {
        suppressed: true,
        reason: "global_outreach_paused",
        signals,
        failedClosed: false,
      }
    }
  } catch (err) {
    if (failClosed) {
      return {
        suppressed: true,
        reason: "stop_control_read_failed",
        signals: ["stop_control_read_failed"],
        failedClosed: true,
      }
    }
    // Non-recovery kinds: a transient stop-control read error is not, by
    // itself, fatal — continue and let the per-user checks run.
    signals.push("stop_control_read_failed")
  }

  // ---- 2. Per-user opt-out signals (pa-users) -----------------------------
  let userData: Record<string, unknown> | undefined
  try {
    const snap = await db.collection(PA_COLLECTIONS.users).doc(userId).get()
    if (!snap.exists) {
      // No profile → we cannot prove the candidate did NOT opt out.
      return {
        suppressed: failClosed,
        reason: failClosed ? "user_profile_missing" : "user_profile_missing_allow",
        signals: ["user_profile_missing"],
        failedClosed: failClosed,
      }
    }
    userData = (snap.data() ?? {}) as Record<string, unknown>
  } catch (err) {
    return {
      suppressed: failClosed,
      reason: failClosed ? "user_read_failed" : "user_read_failed_allow",
      signals: ["user_read_failed"],
      failedClosed: failClosed,
    }
  }

  const lifecycleAlias = userData.candidateLifecycle as { state?: unknown } | undefined
  const lifecycleState =
    (typeof userData.candidateLifecycleState === "string"
      ? (userData.candidateLifecycleState as string)
      : undefined) ??
    (typeof lifecycleAlias?.state === "string" ? (lifecycleAlias.state as string) : undefined)

  if (lifecycleState === "opted_out" || lifecycleState === "deleted") {
    signals.push(`lifecycle_${lifecycleState}`)
    return { suppressed: true, reason: `lifecycle_${lifecycleState}`, signals, failedClosed: false }
  }

  const outreach = userData.outreach as
    | { status?: unknown; cooldownUntil?: unknown; lastOutboundAt?: unknown }
    | undefined
  if (outreach?.status === "opted_out" || outreach?.status === "paused") {
    signals.push(`outreach_status_${outreach.status}`)
    return {
      suppressed: true,
      reason: `outreach_status_${outreach.status}`,
      signals,
      failedClosed: false,
    }
  }

  if (userData.doNotContact === true) {
    signals.push("do_not_contact")
    return { suppressed: true, reason: "do_not_contact", signals, failedClosed: false }
  }

  if (userData.outreachPaused === true) {
    signals.push("outreach_paused_flag")
    return { suppressed: true, reason: "outreach_paused_flag", signals, failedClosed: false }
  }

  const dailySub = userData.dailyJobRecSubscribe as { optedIn?: unknown } | undefined
  if (dailySub && dailySub.optedIn === false) {
    signals.push("daily_unsubscribed")
    return { suppressed: true, reason: "daily_unsubscribed", signals, failedClosed: false }
  }

  // ---- 3. Filed-but-unprocessed privacy requests (the core gap) -----------
  // A stop_outreach / delete request that was filed in chat lands in
  // pa-privacy-requests with status "submitted" and is NOT applied to
  // pa-users. Treat it as a hard suppression so the recovery campaign honors
  // it immediately, even before the privacy queue processes it.
  try {
    const prSnap = await db
      .collection(PA_COLLECTIONS.privacyRequests)
      .where("candidateId", "==", userId)
      .limit(50)
      .get()
    for (const doc of prSnap.docs) {
      const data = (doc.data() ?? {}) as { kind?: unknown; status?: unknown }
      const prKind = typeof data.kind === "string" ? data.kind : ""
      const prStatus = typeof data.status === "string" ? data.status : ""
      if (
        SUPPRESSING_PRIVACY_KINDS.has(prKind) &&
        SUPPRESSING_PRIVACY_STATUSES.has(prStatus)
      ) {
        signals.push(`privacy_request_${prKind}`)
        return {
          suppressed: true,
          reason: `privacy_request_${prKind}`,
          signals,
          failedClosed: false,
        }
      }
    }
  } catch (err) {
    if (failClosed) {
      return {
        suppressed: true,
        reason: "privacy_request_read_failed",
        signals: ["privacy_request_read_failed"],
        failedClosed: true,
      }
    }
    signals.push("privacy_request_read_failed")
  }

  // ---- 4. Reachability (recovery requires a phone) ------------------------
  const phone = userData.phoneE164
  if (failClosed && (typeof phone !== "string" || !phone.trim())) {
    signals.push("unreachable_no_phone")
    return { suppressed: true, reason: "unreachable_no_phone", signals, failedClosed: true }
  }

  // ---- 5. Cooldown (reported; only blocks when enforceCooldown=true) ------
  const futureCooldown = isFuture(outreach?.cooldownUntil, nowMs)
  const recentOutbound = isWithinDays(outreach?.lastOutboundAt, nowMs, GLOBAL_OUTBOUND_COOLDOWN_DAYS)
  if (futureCooldown) signals.push("cooldown_until_future")
  if (recentOutbound) signals.push("recent_outbound")
  if (options.enforceCooldown && (futureCooldown || recentOutbound)) {
    return {
      suppressed: true,
      reason: futureCooldown ? "cooldown_until_future" : "recent_outbound",
      signals,
      failedClosed: false,
    }
  }

  return { suppressed: false, reason: "clear", signals, failedClosed: false }
}
