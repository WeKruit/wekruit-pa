/**
 * progress-heartbeat.ts — ONE proactive "still working on it" bubble for a long async task.
 *
 * Adam 2026-06-06: "if a task is taking more than 30 seconds... issue another side effect word
 * (matching / enriching etc.) saying 'still working on it, give me a bit' so it doesn't seem to get
 * stuck." Plus: "only need to heartbeat once" and — critically — "before sending it we need to make
 * sure we don't send the actual response and THEN this message, we need to ensure the order of
 * sequence."
 *
 * The reactive half of that ask (Claire says "still pulling your info" when the candidate texts
 * DURING enrichment) already exists via the durable enrichmentInFlight marker (enrichment-inflight.ts
 * → mode-selector → prompt). This is the PROACTIVE half: when the candidate is silently waiting and
 * the task overruns 30s, nudge once unprompted.
 *
 * ORDERING GUARANTEE (no "result then heartbeat"):
 *   The timer is CANCELLED (clearTimeout) the instant `work` settles. So:
 *     - work finishes < delayMs  → timer cancelled → NO heartbeat → the real result is the only
 *       message. The heartbeat can never trail the result.
 *     - work still running ≥ delayMs → heartbeat fires once. Because the result is composed/sent only
 *       AFTER work resolves (the cv-parsed re-entry, which fires off ingestCv completion), the
 *       heartbeat is necessarily delivered BEFORE the result.
 *   The `settled` flag is a belt-and-suspenders guard for the micro-race where the timer macrotask is
 *   already queued at the moment work resolves: the finally runs first (sets settled, clears timer),
 *   so the queued callback no-ops.
 *
 * ONCE-ONLY: a single setTimeout, never an interval, never re-armed.
 *
 * FAIL-OPEN: a send error is swallowed (logged) — a missed nudge must never disturb the task or the
 * eventual result.
 *
 * The heartbeat rides the SAME instance that runs the fire-and-forget task; that instance empirically
 * stays alive to the task's completion (the ingest_done log lands minutes later), so the timer fires
 * reliably. `unref()` keeps the timer from being the sole reason an idle instance lingers.
 */

export const PROGRESS_HEARTBEAT_DELAY_MS = 30_000

export interface ProgressHeartbeatOpts {
  /** Transient-bubble sender — wire to transport.sendStatus (immediate sendImessage, no outbox). */
  send: (text: string) => Promise<void>
  /** The single nudge copy, e.g. "still reading through your background — one sec 🙏". */
  message: string
  /** Override the 30s threshold (tests / per-task tuning). */
  delayMs?: number
  /**
   * OPTIONAL extra guard re-checked at fire time (e.g. re-read the enrichmentInFlight marker for a
   * cross-invocation clear). Returning false suppresses the nudge. Omit it: the clearTimeout-on-settle
   * guarantee already covers the same-invocation case, so callers need this only when another path can
   * complete the work out-of-band.
   */
  stillInFlight?: () => boolean | Promise<boolean>
  log?: (event: string, payload?: Record<string, unknown>) => void
}

/**
 * Schedule a single "still working" nudge that fires only if `work` overruns `delayMs`. Returns the
 * work promise (cleanup attached) so the caller's existing `.then/.catch` chain is preserved.
 */
export function withProgressHeartbeat<T>(work: Promise<T>, opts: ProgressHeartbeatOpts): Promise<T> {
  const log = opts.log ?? (() => {})
  const delayMs = opts.delayMs ?? PROGRESS_HEARTBEAT_DELAY_MS
  let settled = false

  const timer = setTimeout(() => {
    if (settled) return
    void (async () => {
      try {
        if (opts.stillInFlight) {
          const live = await opts.stillInFlight()
          if (!live) {
            log("progress_heartbeat.skipped_not_in_flight")
            return
          }
        }
        // Re-check after the (possibly async) stillInFlight resolved — work may have settled meanwhile.
        if (settled) return
        await opts.send(opts.message)
        log("progress_heartbeat.sent", { message: opts.message, delayMs })
      } catch (err) {
        log("progress_heartbeat.error", {
          err: err instanceof Error ? err.message : String(err),
        })
      }
    })()
  }, delayMs)
  // Don't let the nudge timer alone keep an otherwise-idle instance warm.
  if (typeof (timer as { unref?: () => void }).unref === "function") {
    ;(timer as { unref: () => void }).unref()
  }

  return work.finally(() => {
    settled = true
    clearTimeout(timer)
  })
}

/** Default nudge copy by task kind — Claire's casual lowercase voice, one short line. */
export const PROGRESS_HEARTBEAT_COPY: Record<"resume" | "matching" | "linkedin", string> = {
  resume: "still reading through your background — give me a few more secs 🙏",
  matching: "still scanning for the best fits — one sec 🔎",
  linkedin: "still pulling your profile together — almost there 🙏",
}
