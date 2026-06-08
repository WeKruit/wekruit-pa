import test from "node:test"
import assert from "node:assert/strict"
import {
  resolveRecCadenceDays,
  resolveSendSpreadWindowMinutes,
  resolveJobRecCooldownMs,
  isRecSendDue,
  isWithinRecCooldown,
  planSendSchedule,
  DEFAULT_REC_CADENCE_DAYS,
  DEFAULT_REC_SEND_SPREAD_WINDOW_MINUTES,
  DEFAULT_REC_COOLDOWN_HOURS,
  type SchedulableUser,
} from "../send-cadence.js"

const DAY_MS = 24 * 60 * 60 * 1000
const HOUR_MS = 60 * 60 * 1000

// ---------------------------------------------------------------------------
// (b) config resolvers — defaults + clamps
// ---------------------------------------------------------------------------

test("resolveRecCadenceDays: unset/garbage → default 3", () => {
  assert.equal(resolveRecCadenceDays(undefined), DEFAULT_REC_CADENCE_DAYS)
  assert.equal(resolveRecCadenceDays(null), 3)
  assert.equal(resolveRecCadenceDays("nope"), 3)
  assert.equal(resolveRecCadenceDays(NaN), 3)
})

test("resolveRecCadenceDays: honors a live numeric value", () => {
  assert.equal(resolveRecCadenceDays(7), 7)
  assert.equal(resolveRecCadenceDays("5"), 5)
})

test("resolveRecCadenceDays: clamps to [1, 60]", () => {
  assert.equal(resolveRecCadenceDays(0), 1)
  assert.equal(resolveRecCadenceDays(-4), 1)
  assert.equal(resolveRecCadenceDays(999), 60)
})

test("resolveSendSpreadWindowMinutes: unset/garbage → default 120", () => {
  assert.equal(resolveSendSpreadWindowMinutes(undefined), DEFAULT_REC_SEND_SPREAD_WINDOW_MINUTES)
  assert.equal(resolveSendSpreadWindowMinutes("x"), 120)
})

test("resolveSendSpreadWindowMinutes: honors live value + clamps to [1, 720]", () => {
  assert.equal(resolveSendSpreadWindowMinutes(30), 30)
  assert.equal(resolveSendSpreadWindowMinutes(0), 1)
  assert.equal(resolveSendSpreadWindowMinutes(99999), 720)
})

// ---------------------------------------------------------------------------
// (a) due-gate: >= cadence days → due; < cadence → skip
// ---------------------------------------------------------------------------

test("isRecSendDue: never sent (null/empty) → due", () => {
  const now = Date.parse("2026-06-02T16:00:00.000Z")
  assert.equal(isRecSendDue(null, 3, now), true)
  assert.equal(isRecSendDue(undefined, 3, now), true)
  assert.equal(isRecSendDue("", 3, now), true)
})

test("isRecSendDue: last batch 1 day ago, cadence 3 → NOT due", () => {
  const now = Date.parse("2026-06-02T16:00:00.000Z")
  const oneDayAgo = new Date(now - 1 * DAY_MS).toISOString()
  assert.equal(isRecSendDue(oneDayAgo, 3, now), false)
})

test("isRecSendDue: last batch exactly 3 days ago, cadence 3 → due (>=)", () => {
  const now = Date.parse("2026-06-02T16:00:00.000Z")
  const threeDaysAgo = new Date(now - 3 * DAY_MS).toISOString()
  assert.equal(isRecSendDue(threeDaysAgo, 3, now), true)
})

test("isRecSendDue: last batch 4 days ago, cadence 3 → due", () => {
  const now = Date.parse("2026-06-02T16:00:00.000Z")
  const fourDaysAgo = new Date(now - 4 * DAY_MS).toISOString()
  assert.equal(isRecSendDue(fourDaysAgo, 3, now), true)
})

test("isRecSendDue: unparseable timestamp → fail-open (due)", () => {
  const now = Date.parse("2026-06-02T16:00:00.000Z")
  assert.equal(isRecSendDue("not-a-date", 3, now), true)
})

// ---------------------------------------------------------------------------
// Cross-system rec cooldown — resolver + predicate.
// ---------------------------------------------------------------------------

test("resolveJobRecCooldownMs: unset/garbage → default 22h", () => {
  assert.equal(resolveJobRecCooldownMs(undefined), DEFAULT_REC_COOLDOWN_HOURS * HOUR_MS)
  assert.equal(resolveJobRecCooldownMs(null), 22 * HOUR_MS)
  assert.equal(resolveJobRecCooldownMs(""), 22 * HOUR_MS)
  assert.equal(resolveJobRecCooldownMs("nope"), 22 * HOUR_MS)
})

test("resolveJobRecCooldownMs: honors live numeric hours + clamps to [0, 168]", () => {
  assert.equal(resolveJobRecCooldownMs(12), 12 * HOUR_MS)
  assert.equal(resolveJobRecCooldownMs("6"), 6 * HOUR_MS)
  assert.equal(resolveJobRecCooldownMs(0), 0) // explicit disable
  assert.equal(resolveJobRecCooldownMs(-5), 0)
  assert.equal(resolveJobRecCooldownMs(9999), 168 * HOUR_MS)
})

test("isWithinRecCooldown: rec 2h ago, window 22h → in cooldown (skip)", () => {
  const now = Date.parse("2026-06-02T16:00:00.000Z")
  const twoHoursAgo = new Date(now - 2 * HOUR_MS).toISOString()
  assert.equal(isWithinRecCooldown(twoHoursAgo, 22 * HOUR_MS, now), true)
})

test("isWithinRecCooldown: rec 30h ago, window 22h → past cooldown (send)", () => {
  const now = Date.parse("2026-06-02T16:00:00.000Z")
  const thirtyHoursAgo = new Date(now - 30 * HOUR_MS).toISOString()
  assert.equal(isWithinRecCooldown(thirtyHoursAgo, 22 * HOUR_MS, now), false)
})

test("isWithinRecCooldown: never sent (null/empty/garbage) → fail-open (not in cooldown)", () => {
  const now = Date.parse("2026-06-02T16:00:00.000Z")
  assert.equal(isWithinRecCooldown(null, 22 * HOUR_MS, now), false)
  assert.equal(isWithinRecCooldown(undefined, 22 * HOUR_MS, now), false)
  assert.equal(isWithinRecCooldown("", 22 * HOUR_MS, now), false)
  assert.equal(isWithinRecCooldown("not-a-date", 22 * HOUR_MS, now), false)
})

test("isWithinRecCooldown: window 0 disables the cooldown (always false)", () => {
  const now = Date.parse("2026-06-02T16:00:00.000Z")
  const oneMinAgo = new Date(now - 60_000).toISOString()
  assert.equal(isWithinRecCooldown(oneMinAgo, 0, now), false)
})

test("isWithinRecCooldown: exactly at the window boundary → past cooldown (>=, send)", () => {
  const now = Date.parse("2026-06-02T16:00:00.000Z")
  const exactly22hAgo = new Date(now - 22 * HOUR_MS).toISOString()
  assert.equal(isWithinRecCooldown(exactly22hAgo, 22 * HOUR_MS, now), false)
})

// ---------------------------------------------------------------------------
// (c) N users spread across the window — distinct jittered delays, in-window
// ---------------------------------------------------------------------------

test("planSendSchedule: N users get distinct delays spread across the window", () => {
  const windowMs = 120 * 60_000 // 120 min
  const users: SchedulableUser[] = Array.from({ length: 50 }, (_, i) => ({
    userId: `u${i}`,
  }))
  const { scheduled, cappedOut } = planSendSchedule({ users, windowMs })

  assert.equal(scheduled.length, 50)
  assert.equal(cappedOut.length, 0)

  // All delays inside [0, windowMs)
  for (const s of scheduled) {
    assert.ok(s.delayMs >= 0, `delay >= 0 (${s.delayMs})`)
    assert.ok(s.delayMs < windowMs, `delay < window (${s.delayMs} < ${windowMs})`)
  }

  // Not all the same instant — the whole point of spreading.
  const distinct = new Set(scheduled.map((s) => s.delayMs))
  assert.ok(distinct.size > 1, "delays must not all be equal (spam-burst)")
  // With 50 users in a 2h window, delays should fan out broadly.
  assert.ok(distinct.size >= 40, `expected wide spread, got ${distinct.size} distinct`)

  // The cohort should occupy both early and late thirds of the window.
  const early = scheduled.some((s) => s.delayMs < windowMs / 3)
  const late = scheduled.some((s) => s.delayMs > (2 * windowMs) / 3)
  assert.ok(early && late, "sends should populate early AND late window thirds")
})

test("planSendSchedule: deterministic — same input → same delays (stable per-user phase)", () => {
  const windowMs = 60 * 60_000
  const users: SchedulableUser[] = [{ userId: "alice" }, { userId: "bob" }, { userId: "carol" }]
  const a = planSendSchedule({ users, windowMs })
  const b = planSendSchedule({ users, windowMs })
  assert.deepEqual(
    a.scheduled.map((s) => s.delayMs),
    b.scheduled.map((s) => s.delayMs)
  )
})

// ---------------------------------------------------------------------------
// (d) per-number cap respected — a number at cap gets no more sends this window
// ---------------------------------------------------------------------------

test("planSendSchedule: number at cap → excess users capped out (deferred)", () => {
  const windowMs = 60 * 60_000
  // 5 users all assigned to number A which has only 2 sends left this window.
  const users: SchedulableUser[] = Array.from({ length: 5 }, (_, i) => ({
    userId: `u${i}`,
    fromNumber: "+1A",
  }))
  const { scheduled, cappedOut } = planSendSchedule({
    users,
    windowMs,
    capacityByNumber: { "+1A": { remaining: 2 } },
  })
  assert.equal(scheduled.length, 2, "only 2 fit under the cap")
  assert.equal(cappedOut.length, 3, "remaining 3 deferred to next run")
  // Capped-out users are the LATER ones in input order (FIFO admit).
  assert.deepEqual(
    cappedOut.map((u) => u.userId),
    ["u2", "u3", "u4"]
  )
})

test("planSendSchedule: per-number caps are independent across numbers", () => {
  const windowMs = 60 * 60_000
  const users: SchedulableUser[] = [
    { userId: "a1", fromNumber: "+1A" },
    { userId: "a2", fromNumber: "+1A" },
    { userId: "a3", fromNumber: "+1A" },
    { userId: "b1", fromNumber: "+1B" },
    { userId: "b2", fromNumber: "+1B" },
  ]
  const { scheduled, cappedOut } = planSendSchedule({
    users,
    windowMs,
    capacityByNumber: { "+1A": { remaining: 1 }, "+1B": { remaining: 5 } },
  })
  const scheduledIds = scheduled.map((s) => s.userId).sort()
  // A allows 1 (a1), B allows both (b1, b2).
  assert.deepEqual(scheduledIds, ["a1", "b1", "b2"])
  assert.deepEqual(
    cappedOut.map((u) => u.userId),
    ["a2", "a3"]
  )
})

test("planSendSchedule: number absent from capacity map → unbounded (back-compat)", () => {
  const windowMs = 60 * 60_000
  const users: SchedulableUser[] = Array.from({ length: 8 }, (_, i) => ({
    userId: `u${i}`,
    fromNumber: "+1Z",
  }))
  // No entry for +1Z → no pacing → all scheduled.
  const { scheduled, cappedOut } = planSendSchedule({ users, windowMs, capacityByNumber: {} })
  assert.equal(scheduled.length, 8)
  assert.equal(cappedOut.length, 0)
})

test("planSendSchedule: window of 0 (spread disabled) → all delays 0, still cap-paced", () => {
  const users: SchedulableUser[] = [
    { userId: "u0", fromNumber: "+1A" },
    { userId: "u1", fromNumber: "+1A" },
  ]
  const { scheduled } = planSendSchedule({
    users,
    windowMs: 0,
    capacityByNumber: { "+1A": { remaining: 5 } },
  })
  assert.equal(scheduled.length, 2)
  for (const s of scheduled) assert.equal(s.delayMs, 0)
})
