/**
 * Matching-rec send cadence + time-spread planner (2026-06-02, Adam).
 *
 * Three independent concerns, all PURE + unit-testable here so the cron
 * (`runDailyJobRecBatch`) stays a thin orchestrator:
 *
 *   1. CADENCE  — send recs every N days (default 3), CONFIGURABLE at runtime
 *      via the `recCadenceDays` feature flag (no deploy to change). The cron
 *      itself still ticks daily (Firebase Scheduler cron is not runtime-
 *      mutable), but each user is DUE-gated: a user only receives recs if
 *      their last batch (`lastJobBatchSentAt`) is >= cadence days old.
 *
 *   2. TIME-SPREAD — instead of an all-at-once synchronous burst (one Sendblue
 *      number fronting hundreds of users → looks like a spam bot + hits caps),
 *      each due user's send is scheduled at a JITTERED future offset spread
 *      uniformly across `sendSpreadWindowMinutes` (default 120). Per-user jitter
 *      is deterministic (hash of userId) so the same user keeps a stable phase
 *      within the window across re-runs.
 *
 *   3. PER-NUMBER PACING — the spread also respects each Sendblue number's
 *      `dailySendCap`: users are bucketed by their assigned from-number and a
 *      number that has no remaining capacity this window gets NO further sends.
 *      We READ pool cap fields; we never mutate the pool.
 *
 * Mirrors the existing `resolveClaireMaxTurns` safe-default + clamp pattern.
 */

// ---------------------------------------------------------------------------
// Config keys (Firestore `pa-feature-flags/{key}`, type=number, scope=global).
// Change live via the feature-flag dashboard / admin writer — no deploy.
// ---------------------------------------------------------------------------

/** Feature-flag key: days between rec batches per user. Default 3. */
export const REC_CADENCE_DAYS_FLAG_KEY = "recCadenceDays"
/** Feature-flag key: minutes over which a batch's sends are spread. Default 120. */
export const REC_SEND_SPREAD_WINDOW_MINUTES_FLAG_KEY = "recSendSpreadWindowMinutes"

export const DEFAULT_REC_CADENCE_DAYS = 3
export const DEFAULT_REC_SEND_SPREAD_WINDOW_MINUTES = 120

/**
 * Resolve `recCadenceDays` from a raw flag value with safe default + clamp.
 * Default 3 days; clamped to [1, 60]. Non-finite / garbage → default.
 */
export function resolveRecCadenceDays(raw: unknown): number {
  if (raw === null || raw === undefined || raw === "") return DEFAULT_REC_CADENCE_DAYS
  const n = Number(raw)
  if (!Number.isFinite(n)) return DEFAULT_REC_CADENCE_DAYS
  return Math.max(1, Math.min(60, Math.trunc(n)))
}

/**
 * Resolve `recSendSpreadWindowMinutes` from a raw flag value with safe default
 * + clamp. Default 120 min (2h); clamped to [1, 720] (1 min .. 12 h). A value
 * of 1 effectively disables spreading (all sends ~immediate) which is the
 * operational escape hatch if the drip ever needs to be turned off live.
 */
export function resolveSendSpreadWindowMinutes(raw: unknown): number {
  if (raw === null || raw === undefined || raw === "") return DEFAULT_REC_SEND_SPREAD_WINDOW_MINUTES
  const n = Number(raw)
  if (!Number.isFinite(n)) return DEFAULT_REC_SEND_SPREAD_WINDOW_MINUTES
  return Math.max(1, Math.min(720, Math.trunc(n)))
}

// ---------------------------------------------------------------------------
// Per-user due-gate.
// ---------------------------------------------------------------------------

/**
 * True when a user is DUE for a rec batch: never sent before
 * (`lastSentIso` null/empty/unparseable) OR last batch was >= cadenceDays ago.
 *
 * Fail-open: an unparseable timestamp is treated as "never sent" → DUE, so a
 * corrupt field never permanently silences a user.
 */
export function isRecSendDue(
  lastSentIso: string | null | undefined,
  cadenceDays: number,
  nowMs: number
): boolean {
  if (!lastSentIso) return true
  const lastMs = Date.parse(lastSentIso)
  if (!Number.isFinite(lastMs)) return true
  const cadenceMs = Math.max(1, cadenceDays) * 24 * 60 * 60 * 1000
  return nowMs - lastMs >= cadenceMs
}

// ---------------------------------------------------------------------------
// Time-spread + per-number pacing planner.
// ---------------------------------------------------------------------------

/** Stable string hash → unsigned 32-bit (djb2). Mirrors pool.ts hashStringToUint. */
export function hashStringToUint(s: string): number {
  let h = 5381
  for (let i = 0; i < s.length; i += 1) {
    h = ((h << 5) + h + s.charCodeAt(i)) >>> 0
  }
  return h >>> 0
}

/** One due user to schedule. */
export type SchedulableUser = {
  userId: string
  /** Assigned Sendblue from-number (sticky hash). Undefined → no pacing bucket. */
  fromNumber?: string
}

/** Per-number remaining capacity for THIS window (dailySendCap - usedToday). */
export type NumberCapacity = {
  /** Remaining sends this number may still accept. Omit/undefined → unbounded. */
  remaining?: number
}

export type PlanSendScheduleInput = {
  /** Due users in deterministic input order (caller sorts; we keep stability). */
  users: SchedulableUser[]
  /** Spread window in ms (resolveSendSpreadWindowMinutes * 60_000). */
  windowMs: number
  /**
   * Per-number remaining capacity for this window, keyed by from-number.
   * A number absent from the map is treated as unbounded (back-compat: pools
   * without a configured dailySendCap don't pace).
   */
  capacityByNumber?: Record<string, NumberCapacity | undefined>
}

export type ScheduledSend = {
  userId: string
  fromNumber?: string
  /** Jittered delay in ms from "now" at which this user's send should fire. */
  delayMs: number
}

export type PlanSendScheduleResult = {
  /** Users that fit within their number's remaining capacity, with a delay. */
  scheduled: ScheduledSend[]
  /** Users dropped this window because their number is at cap. Retried next run. */
  cappedOut: SchedulableUser[]
}

/**
 * Spread due users across the window with deterministic per-user jitter and
 * per-number capacity pacing.
 *
 * Jitter: each user's base slot is `(rank / total) * windowMs` so the cohort
 * drips evenly; a deterministic per-user sub-slot offset (hash-derived,
 * bounded by one slot) de-correlates users that share a rank-neighbourhood so
 * we never fire two sends at the exact same instant. Result delays are in
 * `[0, windowMs)`.
 *
 * Pacing: users are walked in input order; each is charged against its
 * from-number's remaining capacity. Once a number's remaining hits 0 the
 * subsequent users on that number are `cappedOut` (NOT scheduled) — they
 * remain due and will be picked up on the next cron run (no double-send risk
 * because `lastJobBatchSentAt` is only stamped when a send is actually
 * enqueued).
 */
export function planSendSchedule(input: PlanSendScheduleInput): PlanSendScheduleResult {
  const windowMs = Math.max(0, Math.trunc(input.windowMs))
  const capacityByNumber = input.capacityByNumber ?? {}

  // Mutable per-number remaining budget (default unbounded when absent).
  const remaining = new Map<string, number>()
  for (const [num, cap] of Object.entries(capacityByNumber)) {
    if (cap && Number.isFinite(cap.remaining)) {
      remaining.set(num, Math.max(0, Math.trunc(cap.remaining as number)))
    }
  }

  // First pass — apply per-number pacing to decide who is schedulable.
  const admitted: SchedulableUser[] = []
  const cappedOut: SchedulableUser[] = []
  for (const user of input.users) {
    const num = user.fromNumber
    if (num && remaining.has(num)) {
      const left = remaining.get(num) as number
      if (left <= 0) {
        cappedOut.push(user)
        continue
      }
      remaining.set(num, left - 1)
    }
    admitted.push(user)
  }

  // Second pass — assign jittered delays across the window. Even base slots +
  // deterministic per-user sub-slot offset so no two sends collide.
  const total = admitted.length
  const slot = total > 0 ? windowMs / total : 0
  const scheduled: ScheduledSend[] = admitted.map((user, rank) => {
    const base = slot * rank
    // Sub-slot fraction in [0, 1) derived from a stable hash of the userId.
    const frac = (hashStringToUint(user.userId) % 100_000) / 100_000
    const jitter = slot * frac
    let delayMs = Math.floor(base + jitter)
    if (windowMs > 0 && delayMs >= windowMs) delayMs = windowMs - 1
    if (delayMs < 0) delayMs = 0
    return { userId: user.userId, fromNumber: user.fromNumber, delayMs }
  })

  return { scheduled, cappedOut }
}
