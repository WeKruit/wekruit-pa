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
