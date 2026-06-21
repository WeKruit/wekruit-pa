/**
 * prescreen-staleness.ts — ONE pure predicate for "this prescreen session closed by STALENESS,
 * not by a real outcome" (Adam 2026-06-12, Invoko PM live failure +12026571666 /
 * wQfGZlttRQltMPv4NU6e: a boundary=timeout PAUSE was narrated as "under review" and triggered a
 * matching offer + generic recs in the same turn).
 *
 * Deliberately a tiny standalone module: it is imported by BOTH the prescreen runtime
 * (prescreen-terminal-action.ts / prescreen-turn-handler.ts — coalescer boot graph, must stay light)
 * and the thin-agent layer (matching-tools.ts / candidate-context.ts — agents-SDK graph). A shared
 * leaf avoids pulling either graph into the other (functions_undeployable_sdk_agent_runtime lesson).
 *
 * Truth table — a session is STALE-CLOSED when any of:
 *   - terminalReason === "expired_inactive_prescreen_session"  (the 21d expiry sweep)
 *   - workSession.boundary === "timeout"                       (same expiry, boundary form)
 *   - workSession.boundary === "manual_review_required"        (parked for manual triage)
 *
 * Downstream contract (Adam priorities 2+4):
 *   - candidate copy NEVER calls a stale-closed screen "under review" / "submitted"
 *   - the post-terminal auto-matching flow (recs, "want me to pull roles?") MUST NOT fire off it
 *   - the candidate is offered "reply 'restart screen'" instead.
 */
export function isStaleClosedPrescreenSession(
  session: Record<string, unknown> | undefined | null,
): boolean {
  const d = session ?? {}
  if (d.terminalReason === "expired_inactive_prescreen_session") return true
  const workSession =
    d.workSession && typeof d.workSession === "object" ? (d.workSession as Record<string, unknown>) : null
  return workSession?.boundary === "timeout" || workSession?.boundary === "manual_review_required"
}

/**
 * Canonical reason for the "stale / zombie" sweep terminal. Single source of truth so the
 * three detectors (findActiveSession, hasActivePrescreen, session-finder) + isStaleClosedPrescreenSession
 * all agree.
 */
export const STALE_PRESCREEN_TERMINAL_REASON = "expired_inactive_prescreen_session"

/**
 * The merge-patch that turns a stale non-terminal session into a CLEANLY-CANCELLED, stale-closed
 * terminal that NONE of the three active-prescreen detectors will re-pick:
 *   - terminal "PAUSE" (terminal != null → findActiveSession / hasActivePrescreen skip it)
 *   - terminalReason expired_inactive_prescreen_session → isStaleClosedPrescreenSession === true
 *   - currentQId null → the FSM has no active question to resume against
 *   - workSession.boundary "timeout" → recent-terminal guards + stale-closed copy agree it timed out
 *   - expiredAt stamp → auditable expiry instant (distinct from updatedAt, which the zombie self-bumped)
 *
 * `expiryNoticeSentAt` is written SEPARATELY by the caller that actually sends the candidate notice
 * (the one-time idempotency gate) — it is NOT folded in here, so a detector that only cancels (no send)
 * does not falsely claim the candidate was told.
 */
export function buildStalePrescreenSweepPatch(nowIso: string): Record<string, unknown> {
  return {
    terminal: "PAUSE",
    terminalReason: STALE_PRESCREEN_TERMINAL_REASON,
    currentQId: null,
    expiredAt: nowIso,
    updatedAt: nowIso,
    workSession: { kind: "job_prescreen", status: "ended", endedAt: nowIso, boundary: "timeout" },
  }
}

/**
 * The auditable `turns` subcollection record for a staleness sweep. One row per sweep, so the
 * session history shows WHY the screen closed (age in ms + createdAt vs sweep time) for HITL / eval.
 */
export function buildStalePrescreenSweepTurn(args: {
  createdAtIso: string | null
  nowIso: string
  ageMs: number | null
  detector: "find_active_session" | "mode_selector" | "session_finder"
}): Record<string, unknown> {
  return {
    qId: "terminal",
    action: {
      kind: "session_expired_swept",
      reason: STALE_PRESCREEN_TERMINAL_REASON,
      detector: args.detector,
      createdAt: args.createdAtIso,
      expiredAt: args.nowIso,
      ageMs: args.ageMs,
    },
    ts: args.nowIso,
  }
}
