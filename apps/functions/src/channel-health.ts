/**
 * channel-health.ts — 2026-06-11 incident class: dead Sendblue sender number.
 *
 * Incident: +17174919939 silently died (zero inbound webhooks) while 473
 * pa-users still carried it as their sticky `senderNumber`, so the public
 * job page's "text this to start your screen" sms: links sent ~2 weeks of
 * prescreen-start strings into a void. Sticky assignment was never
 * revalidated against the live pool.
 *
 * Daily canary `paChannelHealthDaily` (08:00 UTC) — READ-ONLY, four checks:
 *
 *   (1) Active pool — load `pa-sendblue-numbers` docs with status=="active".
 *       ZERO active numbers → CRITICAL alert (every assignment is dead).
 *
 *   (2) Dead sender assignment — ANY pa-users.senderNumber not in the active
 *       set → log `pa.channel.dead_sender_assignment` with
 *       {count, numbers, sampleUserIds (≤10)} as ERROR + Slack alert.
 *       This exact check catches the 2026-06-11 incident class.
 *
 *   (3) Outbound health — pa-outbound rows created in the last 24h:
 *       failures = status in ("failed","dead_letter_rate_limited"),
 *       sends = status in ("sent","delivered"). Alert when
 *       failures > 10% of sends OR failures > 20 absolute.
 *
 *   (4) Inbound liveness — pa-inbound-events created in the last 24h. ZERO
 *       inbound while outbound sends > 0 → CRITICAL "channel may be
 *       inbound-dead" (a totally silent inbound side is the smoking gun).
 *
 * All reads bounded. Time-window reads try `where(createdAt > cutoff)`
 * (single-field auto-index — no new composite indexes); if the query is
 * rejected we fall back to a bounded scan + client-side filter.
 *
 * Pure verdict helpers (`evaluate*`) unit-test without Firestore; the runner
 * takes injectable db / now / log / alert (same seam as prescreen-review-sla).
 */
import { onSchedule } from "firebase-functions/v2/scheduler"
import { logger } from "firebase-functions/v2"
import { getFirestore, type Firestore } from "firebase-admin/firestore"
import { postSlackAlert as defaultPostSlackAlert } from "./lib/slack-alert.js"
import { notifyOps, claimOpsAlertOnce, isoWeekBucket } from "./lib/ops-alert.js"
import { MAILGUN_SECRETS, PA_SLACK_ALERT_WEBHOOK } from "./orchestrator-deps.js"

const POOL = "pa-sendblue-numbers"
const USERS = "pa-users"
const OUTBOUND = "pa-outbound"
const INBOUND_EVENTS = "pa-inbound-events"
/** pa-config doc holding the live Sendblue number pool (capacity caps). */
const POOL_CONFIG_DOC = "pa-config/sendblue-pool"

// ── Phone-number capacity (Adam 2026-06-14): alert as a % of each public
// number's configured `newUserCap` so the alert auto-tracks when the cap moves
// (live cap = 550 on 2026-06-14). Thresholds env-overridable. ───────────────
export const CAPACITY_INFO_PCT = 0.7
export const CAPACITY_WARN_PCT = 0.85
export const CAPACITY_CRITICAL_PCT = 1.0
/** Dead-letter queue depth (24h) over which we alert. */
export const DEAD_LETTER_DEPTH_THRESHOLD = 100
const DEAD_LETTER_STATUSES = ["dead_letter", "dead_letter_rate_limited"] as const

export const WINDOW_MS = 24 * 60 * 60 * 1000
/** failures > 10% of sends → breach. */
export const OUTBOUND_FAILURE_RATE_THRESHOLD = 0.1
/** failures > 20 absolute → breach regardless of rate. */
export const OUTBOUND_FAILURE_ABSOLUTE_THRESHOLD = 20
export const SAMPLE_USER_IDS_MAX = 10

const POOL_SCAN_LIMIT = 200
const USERS_SCAN_LIMIT = 5000
const OUTBOUND_SCAN_LIMIT = 5000
const INBOUND_SCAN_LIMIT = 500

export const OUTBOUND_FAILURE_STATUSES = ["failed", "dead_letter_rate_limited"] as const
export const OUTBOUND_SENT_STATUSES = ["sent", "delivered"] as const

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : ""
}

// ---------------------------------------------------------------------------
// Pure verdict helpers — no Firestore, unit-testable.
// ---------------------------------------------------------------------------

export type DeadSenderVerdict = {
  /** CRITICAL: the active pool is empty — every sticky assignment is dead. */
  zeroActivePool: boolean
  /** Users whose senderNumber is NOT an active pool number. */
  count: number
  /** Distinct dead numbers still assigned. */
  numbers: string[]
  /** ≤ SAMPLE_USER_IDS_MAX affected user ids for triage. */
  sampleUserIds: string[]
}

/**
 * (1)+(2) — ANY user whose senderNumber is not an active pool number is a
 * dead assignment. Users without a senderNumber are unassigned, not dead.
 * Zero active pool numbers is its own CRITICAL verdict (and every assigned
 * user is then a dead assignment by definition).
 */
export function evaluateDeadSenderAssignments(
  activeNumbers: ReadonlyArray<string>,
  users: ReadonlyArray<{ id: string; senderNumber?: unknown }>,
): DeadSenderVerdict {
  const active = new Set(activeNumbers.map((n) => str(n)).filter(Boolean))
  const deadNumbers = new Set<string>()
  const sampleUserIds: string[] = []
  let count = 0
  for (const user of users) {
    const sender = str(user.senderNumber)
    if (!sender) continue // unassigned ≠ dead
    if (active.has(sender)) continue
    count++
    deadNumbers.add(sender)
    if (sampleUserIds.length < SAMPLE_USER_IDS_MAX) sampleUserIds.push(user.id)
  }
  return {
    zeroActivePool: active.size === 0,
    count,
    numbers: [...deadNumbers].sort(),
    sampleUserIds,
  }
}

export type OutboundHealthVerdict = {
  sent: number
  failed: number
  /** failed / sent; null when sent == 0. */
  failureRate: number | null
  breached: boolean
  reason: "failure_rate" | "absolute_failures" | null
}

/**
 * (3) — outbound failure pressure over the last 24h.
 * Breach when failures > 10% of sends OR failures > 20 absolute.
 */
export function evaluateOutboundHealth(
  rows: ReadonlyArray<{ status?: unknown }>,
): OutboundHealthVerdict {
  let sent = 0
  let failed = 0
  for (const row of rows) {
    const status = str(row.status)
    if ((OUTBOUND_SENT_STATUSES as ReadonlyArray<string>).includes(status)) sent++
    else if ((OUTBOUND_FAILURE_STATUSES as ReadonlyArray<string>).includes(status)) failed++
  }
  const failureRate = sent > 0 ? failed / sent : null
  let reason: OutboundHealthVerdict["reason"] = null
  if (failed > OUTBOUND_FAILURE_ABSOLUTE_THRESHOLD) reason = "absolute_failures"
  else if (failureRate !== null && failureRate > OUTBOUND_FAILURE_RATE_THRESHOLD)
    reason = "failure_rate"
  // 0 sends + some failures: rate is undefined, but failures still count
  // toward the absolute threshold (handled above).
  return { sent, failed, failureRate, breached: reason !== null, reason }
}

export type InboundLivenessVerdict = {
  inboundCount: number
  outboundSent: number
  /** CRITICAL: we are sending but hearing NOTHING back — inbound may be dead. */
  inboundDead: boolean
}

/**
 * (4) — zero inbound events in 24h while outbound sends > 0 is the smoking
 * gun of a silently dead inbound webhook (today's incident signature).
 */
export function evaluateInboundLiveness(
  inboundCount: number,
  outboundSent: number,
): InboundLivenessVerdict {
  return {
    inboundCount,
    outboundSent,
    inboundDead: inboundCount === 0 && outboundSent > 0,
  }
}

// ---------------------------------------------------------------------------
// (5) Phone-number capacity — % of each public number's configured newUserCap.
// ---------------------------------------------------------------------------

export type CapacityBand = "ok" | "info" | "warn" | "critical"

export type NumberCapacity = {
  number: string
  /** Active reachable users assigned to this number (phone present, not deleted). */
  reachable: number
  /** Configured `newUserCap` from pa-config/sendblue-pool. */
  cap: number
  /** reachable / cap (0 when cap <= 0). */
  pct: number
  band: CapacityBand
}

export type CapacityThresholds = {
  info: number
  warn: number
  critical: number
}

export function capacityBand(pct: number, t: CapacityThresholds): CapacityBand {
  if (pct >= t.critical) return "critical"
  if (pct >= t.warn) return "warn"
  if (pct >= t.info) return "info"
  return "ok"
}

/**
 * Per-public-number capacity verdict. Admin-only numbers and numbers without a
 * configured `newUserCap` are skipped (no capacity rule to enforce). Sorted by
 * pct desc so the worst offender leads the alert.
 */
export function evaluateCapacity(
  numbers: ReadonlyArray<{ number?: unknown; newUserCap?: unknown; adminOnly?: unknown; status?: unknown }>,
  reachableByNumber: ReadonlyMap<string, number>,
  thresholds: CapacityThresholds = {
    info: CAPACITY_INFO_PCT,
    warn: CAPACITY_WARN_PCT,
    critical: CAPACITY_CRITICAL_PCT,
  },
): NumberCapacity[] {
  const out: NumberCapacity[] = []
  for (const n of numbers) {
    const number = str(n.number)
    if (!number) continue
    if (n.adminOnly === true) continue
    const cap = typeof n.newUserCap === "number" && n.newUserCap > 0 ? n.newUserCap : 0
    if (cap <= 0) continue // no capacity rule configured for this number
    const reachable = reachableByNumber.get(number) ?? 0
    const pct = reachable / cap
    out.push({ number, reachable, cap, pct, band: capacityBand(pct, thresholds) })
  }
  return out.sort((a, b) => b.pct - a.pct)
}

/** Highest band across all numbers (drives the single alert's severity). */
export function worstCapacityBand(caps: ReadonlyArray<NumberCapacity>): CapacityBand {
  let worst: CapacityBand = "ok"
  const rank: Record<CapacityBand, number> = { ok: 0, info: 1, warn: 2, critical: 3 }
  for (const c of caps) if (rank[c.band] > rank[worst]) worst = c.band
  return worst
}

export type DeadLetterVerdict = {
  count: number
  breached: boolean
}

/** (6) Dead-letter queue depth over the window. */
export function evaluateDeadLetterDepth(
  rows: ReadonlyArray<{ status?: unknown }>,
  threshold: number = DEAD_LETTER_DEPTH_THRESHOLD,
): DeadLetterVerdict {
  let count = 0
  for (const row of rows) {
    if ((DEAD_LETTER_STATUSES as ReadonlyArray<string>).includes(str(row.status))) count++
  }
  return { count, breached: count > threshold }
}

/** Map an ops band to a notify level. */
function bandToLevel(band: CapacityBand): "info" | "warn" | "error" {
  if (band === "critical") return "error"
  if (band === "warn") return "warn"
  return "info"
}

/** Read capacity thresholds, allowing env overrides (PA_CAPACITY_*_PCT). */
export function capacityThresholdsFromEnv(env: NodeJS.ProcessEnv = process.env): CapacityThresholds {
  const num = (v: string | undefined, fallback: number) => {
    const n = Number.parseFloat((v ?? "").trim())
    return Number.isFinite(n) && n > 0 && n <= 1 ? n : fallback
  }
  return {
    info: num(env.PA_CAPACITY_INFO_PCT, CAPACITY_INFO_PCT),
    warn: num(env.PA_CAPACITY_WARN_PCT, CAPACITY_WARN_PCT),
    critical: num(env.PA_CAPACITY_CRITICAL_PCT, CAPACITY_CRITICAL_PCT),
  }
}

// ---------------------------------------------------------------------------
// Runner — injectable db / now / log / alert (tests use a fake db).
// ---------------------------------------------------------------------------

export type ChannelHealthDeps = {
  db: Firestore
  now?: () => Date
  log?: (event: string, payload?: Record<string, unknown>) => void
  postSlackAlert?: typeof defaultPostSlackAlert
}

export type ChannelHealthResult = {
  activePoolNumbers: string[]
  deadSender: DeadSenderVerdict
  outbound: OutboundHealthVerdict
  inbound: InboundLivenessVerdict
  capacity: NumberCapacity[]
  deadLetter: DeadLetterVerdict
  alertsSent: number
  errors: number
}

type Row = { id: string; data: Record<string, unknown> }

function toRows(snap: { docs: Array<{ id: string; data: () => unknown }> }): Row[] {
  return snap.docs.map((d) => ({ id: d.id, data: (d.data() ?? {}) as Record<string, unknown> }))
}

/**
 * Bounded recent-rows read: try the single-field range query (createdAt is
 * auto-indexed; NO composite index needed since there's no other clause);
 * if the backend rejects it for any reason, fall back to a bounded scan and
 * filter client-side. Either path never reads more than `limit` rows.
 */
async function queryRecentRows(
  db: Firestore,
  coll: string,
  cutoffIso: string,
  limit: number,
): Promise<Row[]> {
  try {
    const snap = await db.collection(coll).where("createdAt", ">", cutoffIso).limit(limit).get()
    return toRows(snap)
  } catch {
    const snap = await db.collection(coll).limit(limit).get()
    return toRows(snap).filter((row) => str(row.data.createdAt) > cutoffIso)
  }
}

export async function paChannelHealthHandler(deps: ChannelHealthDeps): Promise<ChannelHealthResult> {
  const log = deps.log ?? (() => {})
  const now = deps.now ?? (() => new Date())
  const alert = deps.postSlackAlert ?? defaultPostSlackAlert
  const cutoffIso = new Date(now().getTime() - WINDOW_MS).toISOString()

  const result: ChannelHealthResult = {
    activePoolNumbers: [],
    deadSender: { zeroActivePool: true, count: 0, numbers: [], sampleUserIds: [] },
    outbound: { sent: 0, failed: 0, failureRate: null, breached: false, reason: null },
    inbound: { inboundCount: 0, outboundSent: 0, inboundDead: false },
    capacity: [],
    deadLetter: { count: 0, breached: false },
    alertsSent: 0,
    errors: 0,
  }
  /** Active reachable users per senderNumber — populated by the users scan below. */
  const reachableByNumber = new Map<string, number>()

  const fireAlert = async (input: Parameters<typeof defaultPostSlackAlert>[0]) => {
    try {
      await alert(input)
      result.alertsSent++
    } catch {
      /* Slack is never load-bearing — fail-soft (helper itself doesn't throw,
         but an injected test double might). */
    }
  }

  // ── (1) Active pool ───────────────────────────────────────────────────────
  try {
    const snap = await deps.db
      .collection(POOL)
      .where("status", "==", "active")
      .limit(POOL_SCAN_LIMIT)
      .get()
    // Docs are keyed by number; tolerate an explicit `number` field too.
    result.activePoolNumbers = toRows(snap)
      .map((row) => str(row.data.number) || row.id)
      .filter(Boolean)
  } catch (err) {
    result.errors++
    log("pa.channel.pool_query_failed", {
      error: err instanceof Error ? err.message : String(err),
    })
  }

  // ── (2) Dead sender assignments ───────────────────────────────────────────
  try {
    const usersSnap = await deps.db.collection(USERS).limit(USERS_SCAN_LIMIT).get()
    const users = toRows(usersSnap).map((row) => ({
      id: row.id,
      senderNumber: row.data.senderNumber,
    }))
    result.deadSender = evaluateDeadSenderAssignments(result.activePoolNumbers, users)
    // Reachable-user count per number (for the capacity check): a user counts if
    // it has a senderNumber + a phone + is not deleted.
    for (const row of toRows(usersSnap)) {
      const sender = str(row.data.senderNumber)
      if (!sender) continue
      const phone = str(row.data.phoneE164)
      const lifecycle = str(row.data.candidateLifecycleState)
      if (!phone || lifecycle === "deleted") continue
      reachableByNumber.set(sender, (reachableByNumber.get(sender) ?? 0) + 1)
    }
  } catch (err) {
    result.errors++
    result.deadSender = evaluateDeadSenderAssignments(result.activePoolNumbers, [])
    log("pa.channel.users_query_failed", {
      error: err instanceof Error ? err.message : String(err),
    })
  }

  if (result.deadSender.zeroActivePool) {
    log("pa.channel.zero_active_pool", { severity: "CRITICAL" })
    await fireAlert({
      level: "error",
      title: "CRITICAL: Sendblue pool has ZERO active numbers",
      message:
        "pa-sendblue-numbers has no status==active docs. Every sticky senderNumber assignment " +
        "is dead — all candidate sms: entry points are sending into a void.",
    })
  }

  if (result.deadSender.count > 0) {
    log("pa.channel.dead_sender_assignment", {
      severity: "ERROR",
      count: result.deadSender.count,
      numbers: result.deadSender.numbers,
      sampleUserIds: result.deadSender.sampleUserIds,
    })
    await fireAlert({
      level: "error",
      title: "Dead Sendblue sender-number assignments",
      message:
        `${result.deadSender.count} pa-users have a senderNumber that is NOT an active pool ` +
        `number (${result.deadSender.numbers.join(", ") || "n/a"}). Their inbound "text to start" ` +
        "links are dead — the 2026-06-11 +17174919939 incident class.",
      fields: [
        { name: "dead numbers", value: result.deadSender.numbers.join(", ") || "n/a" },
        { name: "sample users", value: result.deadSender.sampleUserIds.join(", ") || "n/a" },
      ],
    })
  }

  // ── (3) Outbound health (last 24h) ────────────────────────────────────────
  try {
    const rows = await queryRecentRows(deps.db, OUTBOUND, cutoffIso, OUTBOUND_SCAN_LIMIT)
    const statuses = rows.map((row) => ({ status: row.data.status }))
    result.outbound = evaluateOutboundHealth(statuses)
    result.deadLetter = evaluateDeadLetterDepth(statuses)
  } catch (err) {
    result.errors++
    log("pa.channel.outbound_query_failed", {
      error: err instanceof Error ? err.message : String(err),
    })
  }

  if (result.outbound.breached) {
    log("pa.channel.outbound_failure_breach", {
      severity: "ERROR",
      sent: result.outbound.sent,
      failed: result.outbound.failed,
      failureRate: result.outbound.failureRate,
      reason: result.outbound.reason,
    })
    await fireAlert({
      level: "warn",
      title: "Outbound failure pressure (24h)",
      message:
        `${result.outbound.failed} failed/dead-letter outbound vs ${result.outbound.sent} sent ` +
        `in the last 24h (${result.outbound.reason === "absolute_failures" ? ">20 absolute" : ">10% of sends"}).`,
      fields: [
        { name: "sent", value: String(result.outbound.sent) },
        { name: "failed", value: String(result.outbound.failed) },
        {
          name: "failure rate",
          value:
            result.outbound.failureRate === null
              ? "n/a (0 sends)"
              : `${Math.round(result.outbound.failureRate * 1000) / 10}%`,
        },
      ],
    })
  }

  // ── (4) Inbound liveness (last 24h) ───────────────────────────────────────
  try {
    const rows = await queryRecentRows(deps.db, INBOUND_EVENTS, cutoffIso, INBOUND_SCAN_LIMIT)
    result.inbound = evaluateInboundLiveness(rows.length, result.outbound.sent)
  } catch (err) {
    result.errors++
    log("pa.channel.inbound_query_failed", {
      error: err instanceof Error ? err.message : String(err),
    })
  }

  if (result.inbound.inboundDead) {
    log("pa.channel.inbound_dead", {
      severity: "CRITICAL",
      inboundCount: result.inbound.inboundCount,
      outboundSent: result.inbound.outboundSent,
    })
    await fireAlert({
      level: "error",
      title: "CRITICAL: channel may be inbound-dead",
      message:
        `ZERO pa-inbound-events in the last 24h while ${result.inbound.outboundSent} outbound ` +
        "message(s) were sent. A totally silent inbound side is the dead-webhook smoking gun.",
    })
  }

  // ── (5) Phone-number capacity (% of configured newUserCap) ────────────────
  try {
    const poolDoc = await deps.db.doc(POOL_CONFIG_DOC).get()
    const poolData = (poolDoc.data() ?? {}) as { numbers?: unknown }
    const numbers = Array.isArray(poolData.numbers)
      ? (poolData.numbers as Array<Record<string, unknown>>)
      : []
    result.capacity = evaluateCapacity(numbers, reachableByNumber, capacityThresholdsFromEnv())
  } catch (err) {
    result.errors++
    log("pa.channel.capacity_query_failed", {
      error: err instanceof Error ? err.message : String(err),
    })
  }

  const flaggedCapacity = result.capacity.filter((c) => c.band !== "ok")
  if (flaggedCapacity.length > 0) {
    const worst = worstCapacityBand(flaggedCapacity)
    const severity = worst === "critical" ? "CRITICAL" : worst === "warn" ? "ERROR" : "INFO"
    log("pa.channel.capacity_threshold", {
      severity,
      worst,
      flagged: flaggedCapacity.map((c) => ({ number: c.number, reachable: c.reachable, cap: c.cap, pct: c.pct })),
    })
    // THROTTLE (Adam 2026-06-14: don't overload email): the daily run would
    // otherwise email every day while a number sits above threshold. Send at
    // most once per ISO-week per worst-band — escalating to a higher band
    // (info→warn→critical) changes the key, so a worsening situation re-alerts.
    const capKey = `capacity-${worst}-${isoWeekBucket(now().getTime())}`
    if (await claimOpsAlertOnce(deps.db, capKey, now().getTime())) {
      await fireAlert({
        level: bandToLevel(worst),
        title: `Sendblue number capacity ${worst === "critical" ? "AT/OVER cap" : worst === "warn" ? "high" : "rising"}`,
        message:
          `One or more public Sendblue numbers crossed a capacity threshold (active reachable users vs configured newUserCap). ` +
          `Provision/expand the pool before a number fills — Product Rule 10 keeps each group ~300-500 active users.`,
        fields: flaggedCapacity.map((c) => ({
          name: c.number,
          value: `${c.reachable}/${c.cap} (${Math.round(c.pct * 100)}%) — ${c.band}`,
        })),
      })
    } else {
      log("pa.channel.capacity_alert_throttled", { worst, key: capKey })
    }
  }

  // ── (6) Dead-letter queue depth (24h) ─────────────────────────────────────
  if (result.deadLetter.breached) {
    log("pa.channel.dead_letter_depth", {
      severity: "ERROR",
      count: result.deadLetter.count,
      threshold: DEAD_LETTER_DEPTH_THRESHOLD,
    })
    await fireAlert({
      level: "warn",
      title: "Outbound dead-letter queue depth high",
      message:
        `${result.deadLetter.count} outbound message(s) hit dead_letter in the last 24h ` +
        `(> ${DEAD_LETTER_DEPTH_THRESHOLD}). These never delivered — check Sendblue rate-limit / plan status.`,
      fields: [{ name: "dead-letter (24h)", value: String(result.deadLetter.count) }],
    })
  }

  if (
    !result.deadSender.zeroActivePool &&
    result.deadSender.count === 0 &&
    !result.outbound.breached &&
    !result.inbound.inboundDead &&
    flaggedCapacity.length === 0 &&
    !result.deadLetter.breached
  ) {
    log("pa.channel.health_ok", {
      activePoolNumbers: result.activePoolNumbers,
      outboundSent: result.outbound.sent,
      outboundFailed: result.outbound.failed,
      inboundCount: result.inbound.inboundCount,
      capacity: result.capacity.map((c) => ({ number: c.number, pct: Math.round(c.pct * 100) })),
    })
  }

  return result
}

// ---------------------------------------------------------------------------
// Thin CF shim — pure logic above is deps-injected for tests.
// ---------------------------------------------------------------------------
export const paChannelHealthDaily = onSchedule(
  {
    schedule: "0 8 * * *",
    timeZone: "UTC",
    memory: "256MiB",
    timeoutSeconds: 300,
    region: "us-central1",
    // Route alerts to EMAIL (Adam 2026-06-14) + Slack via notifyOps — bind both
    // channels' secrets so they're available in process.env at runtime.
    secrets: [PA_SLACK_ALERT_WEBHOOK, ...MAILGUN_SECRETS],
    retryCount: 0,
  },
  async () => {
    const result = await paChannelHealthHandler({
      db: getFirestore(),
      log: (event, payload) => {
        const severity = payload?.severity
        if (severity === "ERROR" || severity === "CRITICAL") {
          logger.error(`[channel-health] ${event}`, payload ?? {})
        } else {
          logger.info(`[channel-health] ${event}`, payload ?? {})
        }
      },
      // Every channel-health alert now dispatches via notifyOps (email + Slack).
      // We keep the postSlackAlert seam name for the deps-injected unit tests.
      postSlackAlert: (async (input) => {
        const r = await notifyOps(input)
        return { posted: r.anyDelivered }
      }) as typeof defaultPostSlackAlert,
    })
    logger.info("[channel-health] done", result)
  },
)
