/**
 * v1.9 Phase 88 — Sendblue multi-number pool selector.
 *
 * Pool config:
 *   pa-config/sendblue-pool { numbers: [{ number, status, audience, adminOnly, capacity }] }
 *   pa-config/sendblue-pool { groups: [{ groupId, status, audience, adminOnly, dailySendCap, numbers }] }
 *
 * Selector strategy:
 *   - Filter to status === "active"
 *   - User-facing selectors exclude audience=admin/internal or adminOnly=true
 *   - hash(userId) mod activeNumbers.length → same user always routed to
 *     same number (thread continuity)
 *   - Callers decide whether pool empty / unconfigured should block or fall back
 *
 * Single-number pool produces identical behavior to pre-v1.9.
 */

import { FieldValue, type Firestore } from "firebase-admin/firestore"

export type SendbluePoolNumberStatus =
  | "active"
  | "warmup"
  | "paused"
  | "throttled"
  | "degraded"

export type SendbluePoolAudience =
  | "public"
  | "candidate"
  | "candidate_public"
  | "admin"
  | "internal"
  | "developer"

export interface SendbluePoolNumber {
  number: string
  groupId?: string
  status: SendbluePoolNumberStatus
  /** DB-owned routing audience. Candidate surfaces must only use public entries. */
  audience?: SendbluePoolAudience | string
  /** Strong override for admin/developer-only lines. */
  adminOnly?: boolean
  /** Rollout cap for first-touch/new-user entry points. */
  newUserCap?: number
  /** DB-maintained count for first-touch/new-user entry points. */
  assignedNewUsers?: number
  /** S6 hard cap: accepted outbound sends per group per UTC day. */
  capacity?: number
  dailySendCap?: number
  /** Safety buffer subtracted from dailySendCap — outbound stops at (cap − buffer)
   *  so bursts / in-flight sends never push past the hard Sendblue daily limit. */
  sendCapBuffer?: number
  /** Rolling send-cap window in hours (default 24). The cap counts sends in the
   *  trailing window with real timestamps, not a calendar-day reset. */
  sendCapWindowHours?: number
}

export interface SendbluePoolGroup {
  groupId: string
  status: SendbluePoolNumberStatus
  audience?: SendbluePoolAudience | string
  adminOnly?: boolean
  newUserCap?: number
  assignedNewUsers?: number
  capacity?: number
  dailySendCap?: number
  sendCapBuffer?: number
  sendCapWindowHours?: number
  numbers: Array<string | SendbluePoolNumber>
}

export interface SendbluePoolConfig {
  numbers?: SendbluePoolNumber[]
  groups?: SendbluePoolGroup[]
}

export type SendblueGroupUtilization = {
  usedToday: number
  rolling24hUsed?: number
}

export type SendblueCapacitySelectionInput = {
  candidateId: string
  checkedAt: string
  stickyAccountGroupId?: string
  allowWarmup?: boolean
  utilization?: Record<string, SendblueGroupUtilization>
}

export type SendblueCapacityBlockReason =
  | "no_pool"
  | "no_routable_group"
  | "channel_capacity"
  | "sticky_group_capacity"
  | "sticky_group_unavailable"
  | "warmup_requires_hitl"
  | "missing_capacity"

export type SendblueCapacitySnapshot = {
  groupId: string
  fromNumber?: string
  status: SendbluePoolNumberStatus | "missing"
  dailyCap: number
  usedToday: number
  remainingToday: number
  rolling24hUsed?: number
  checkedAt: string
  reason?: string
}

export type SendblueCapacitySelection =
  | {
      ok: true
      groupId: string
      fromNumber: string
      reason: "selected" | "sticky_selected"
      capacitySnapshot: SendblueCapacitySnapshot
    }
  | {
      ok: false
      groupId?: string
      fromNumber?: string
      reason: SendblueCapacityBlockReason
      capacitySnapshot: SendblueCapacitySnapshot
    }

/** Stable string hash → unsigned 32-bit. djb2 variant. */
export function hashStringToUint(s: string): number {
  let h = 5381 >>> 0
  for (let i = 0; i < s.length; i++) {
    h = (Math.imul(h, 33) + s.charCodeAt(i)) >>> 0
  }
  return h
}

export type PickFromNumberOptions = {
  /**
   * Default false. Candidate-facing entry points must not expose admin,
   * internal, or developer lines. Set true only for explicit internal tooling.
   */
  includeInternal?: boolean
  /**
   * Default false. Use true for first-touch/new-user entry points that should
   * respect rollout caps such as "first 200 new users".
   */
  requireNewUserCapacity?: boolean
}

export function isUserAccessibleSendblueNumber(number: SendbluePoolNumber): boolean {
  if (number.adminOnly === true) return false
  const audience = typeof number.audience === "string" ? number.audience.trim().toLowerCase() : ""
  if (audience === "admin" || audience === "internal" || audience === "developer") return false
  return true
}

function hasNewUserCapacity(number: SendbluePoolNumber): boolean {
  const cap = number.newUserCap
  if (!Number.isInteger(cap) || cap === undefined || cap < 0) return true
  const used = Number.isInteger(number.assignedNewUsers) ? Math.max(0, number.assignedNewUsers ?? 0) : 0
  return used < cap
}

function isSelectablePoolNumber(
  number: SendbluePoolNumber,
  options: PickFromNumberOptions = {}
): boolean {
  if (!number.number || number.status !== "active") return false
  if (!options.includeInternal && !isUserAccessibleSendblueNumber(number)) return false
  if (options.requireNewUserCapacity && !hasNewUserCapacity(number)) return false
  return true
}

/**
 * Pure selector — pick a from-number for a given userId from a pool config.
 * Returns null when pool has zero active numbers.
 */
export function pickFromNumber(
  pool: SendbluePoolConfig | null,
  userId: string,
  options: PickFromNumberOptions = {}
): string | null {
  const active = normalizedPoolNumbers(pool).filter((n) => isSelectablePoolNumber(n, options))
  if (active.length === 0) return null
  const idx = hashStringToUint(userId) % active.length
  return active[idx].number
}

// ---- New-user ASSIGNMENT routing (which number a NEW candidate first binds to) ----
// Once assigned, the number is sticky for that candidate's whole thread (callers
// early-return the existing senderNumber). For a NEW candidate, balance by least
// total attached so a number added later drains the historical skew instead of
// being stuck behind a hash split. This is purely WHO-routes-WHERE; daily SEND
// volume limits are a separate concern (selectSendblueCapacityGroup).

/** Active, candidate-facing (public) numbers eligible to receive new assignments. */
export function activeUserAccessibleNumbers(pool: SendbluePoolConfig | null): SendbluePoolNumber[] {
  return normalizedPoolNumbers(pool).filter((n) => isSelectablePoolNumber(n, {}))
}

export type AssignmentNumberStat = {
  number: string
  /** Total candidates currently attached (bound) to this number. */
  totalAttached: number
}

/**
 * Pick the sender number for a NEW candidate: the least-loaded active public number
 * (tiebreak stable by number) so the pool drains toward an even split. Returns null
 * only when there are no candidate-facing numbers.
 */
export function selectLeastLoadedAssignmentNumber(stats: AssignmentNumberStat[]): string | null {
  if (stats.length === 0) return null
  return [...stats].sort(
    (a, b) => a.totalAttached - b.totalAttached || a.number.localeCompare(b.number),
  )[0]!.number
}

function configuredCapacity(number: SendbluePoolNumber): number | undefined {
  return number.dailySendCap ?? number.capacity
}

function normalizedPoolNumbers(pool: SendbluePoolConfig | null): SendbluePoolNumber[] {
  if (!pool) return []
  const grouped = (Array.isArray(pool.groups) ? pool.groups : []).flatMap((group) => {
    const groupId = group.groupId?.trim()
    if (!groupId) return []
    return (Array.isArray(group.numbers) ? group.numbers : [])
      .map((entry): SendbluePoolNumber | null => {
        if (typeof entry === "string") {
          const number = entry.trim()
          if (!number) return null
          return {
            number,
            groupId,
            status: group.status,
            audience: group.audience,
            adminOnly: group.adminOnly,
            newUserCap: group.newUserCap,
            assignedNewUsers: group.assignedNewUsers,
            capacity: group.capacity,
            dailySendCap: group.dailySendCap,
            sendCapBuffer: group.sendCapBuffer,
            sendCapWindowHours: group.sendCapWindowHours,
          }
        }
        const number = entry.number?.trim()
        if (!number) return null
        return {
          ...entry,
          number,
          groupId: entry.groupId?.trim() || groupId,
          status: entry.status ?? group.status,
          audience: entry.audience ?? group.audience,
          adminOnly: entry.adminOnly ?? group.adminOnly,
          newUserCap: entry.newUserCap ?? group.newUserCap,
          assignedNewUsers: entry.assignedNewUsers ?? group.assignedNewUsers,
          capacity: entry.capacity ?? group.capacity,
          dailySendCap: entry.dailySendCap ?? group.dailySendCap,
          sendCapBuffer: entry.sendCapBuffer ?? group.sendCapBuffer,
          sendCapWindowHours: entry.sendCapWindowHours ?? group.sendCapWindowHours,
        }
      })
      .filter((entry): entry is SendbluePoolNumber => entry !== null)
  })
  const legacy = Array.isArray(pool.numbers) ? pool.numbers : []
  return [...grouped, ...legacy]
}

export function findSendbluePoolNumber(
  pool: SendbluePoolConfig | null,
  senderNumber: string
): SendbluePoolNumber | null {
  return normalizedPoolNumbers(pool).find((n) => n.number === senderNumber) ?? null
}

export type NormalizedSendbluePoolGroup = {
  groupId: string
  status: SendbluePoolNumberStatus
  dailySendCap: number | null
  numbers: string[]
}

export function normalizeSendbluePoolGroups(pool: SendbluePoolConfig | null): NormalizedSendbluePoolGroup[] {
  const groups = new Map<string, NormalizedSendbluePoolGroup>()
  for (const number of normalizedPoolNumbers(pool)) {
    const groupId = sendblueGroupId(number)
    const existing = groups.get(groupId)
    const cap = configuredCapacity(number)
    const dailySendCap = Number.isInteger(cap) && cap !== undefined && cap > 0 ? cap : null
    if (existing) {
      existing.numbers.push(number.number)
      if (existing.dailySendCap === null && dailySendCap !== null) existing.dailySendCap = dailySendCap
      continue
    }
    groups.set(groupId, {
      groupId,
      status: number.status,
      dailySendCap,
      numbers: [number.number],
    })
  }
  return [...groups.values()]
}

export function sendblueGroupId(number: SendbluePoolNumber): string {
  return (number.groupId?.trim() || number.number.trim()).replace(/\s+/g, "")
}

function capacitySnapshot(
  number: SendbluePoolNumber | null,
  checkedAt: string,
  utilization: SendblueGroupUtilization | undefined,
  reason?: string
): SendblueCapacitySnapshot {
  const groupId = number ? sendblueGroupId(number) : "unassigned"
  const rawCap = number ? configuredCapacity(number) : undefined
  const dailyCap = Number.isInteger(rawCap) && rawCap !== undefined && rawCap >= 0 ? rawCap : 0
  const usedToday = Math.max(0, Math.trunc(utilization?.usedToday ?? 0))
  return {
    groupId,
    ...(number?.number ? { fromNumber: number.number } : {}),
    status: number?.status ?? "missing",
    dailyCap,
    usedToday,
    remainingToday: Math.max(0, dailyCap - usedToday),
    ...(utilization?.rolling24hUsed !== undefined
      ? { rolling24hUsed: Math.max(0, Math.trunc(utilization.rolling24hUsed)) }
      : {}),
    checkedAt,
    ...(reason ? { reason } : {}),
  }
}

function isCapacityConfigured(number: SendbluePoolNumber): boolean {
  const capacity = configuredCapacity(number)
  return Number.isInteger(capacity) && capacity !== undefined && capacity > 0
}

function isRoutableStatus(number: SendbluePoolNumber, allowWarmup = false): boolean {
  return number.status === "active" || (allowWarmup && number.status === "warmup")
}

function capacityRemaining(
  number: SendbluePoolNumber,
  utilization: Record<string, SendblueGroupUtilization>
): number {
  const groupId = sendblueGroupId(number)
  const usedToday = Math.max(0, Math.trunc(utilization[groupId]?.usedToday ?? 0))
  return Math.max(0, (configuredCapacity(number) ?? 0) - usedToday)
}

export function computeSendblueCapacitySnapshot(input: {
  group: NormalizedSendbluePoolGroup
  usedToday: number
  checkedAt?: Date
  fromNumber?: string
  reason?: string
}): SendblueCapacitySnapshot {
  const dailyCap = input.group.dailySendCap ?? 0
  const usedToday = Math.max(0, Math.trunc(input.usedToday))
  return {
    groupId: input.group.groupId,
    ...(input.fromNumber ? { fromNumber: input.fromNumber } : {}),
    status: input.group.status,
    dailyCap,
    usedToday,
    remainingToday: Math.max(0, dailyCap - usedToday),
    checkedAt: (input.checkedAt ?? new Date()).toISOString(),
    ...(input.reason ? { reason: input.reason } : {}),
  }
}

/**
 * S6 capacity-aware selector. It never falls back to unlimited capacity:
 * missing config, missing cap, full cap, or unavailable sticky groups return a
 * structured block so policy can stop before creating `pa-outbound`.
 */
export function selectSendblueCapacityGroup(
  pool: SendbluePoolConfig | null,
  input: SendblueCapacitySelectionInput
): SendblueCapacitySelection {
  const utilization = input.utilization ?? {}
  const poolNumbers = normalizedPoolNumbers(pool)
  if (poolNumbers.length === 0) {
    return {
      ok: false,
      reason: "no_pool",
      capacitySnapshot: capacitySnapshot(null, input.checkedAt, undefined, "no_pool"),
    }
  }

  const candidateNumbers = poolNumbers.filter(isUserAccessibleSendblueNumber)
  const byGroup = new Map(candidateNumbers.map((number) => [sendblueGroupId(number), number] as const))
  if (input.stickyAccountGroupId) {
    const sticky = byGroup.get(input.stickyAccountGroupId)
    if (!sticky || !isRoutableStatus(sticky, Boolean(input.allowWarmup))) {
      return {
        ok: false,
        groupId: input.stickyAccountGroupId,
        fromNumber: sticky?.number,
        reason: sticky?.status === "warmup" ? "warmup_requires_hitl" : "sticky_group_unavailable",
        capacitySnapshot: capacitySnapshot(
          sticky ?? null,
          input.checkedAt,
          sticky ? utilization[sendblueGroupId(sticky)] : undefined,
          sticky?.status === "warmup" ? "warmup_requires_hitl" : "sticky_group_unavailable"
        ),
      }
    }
    if (!isCapacityConfigured(sticky)) {
      return {
        ok: false,
        groupId: sendblueGroupId(sticky),
        fromNumber: sticky.number,
        reason: "missing_capacity",
        capacitySnapshot: capacitySnapshot(sticky, input.checkedAt, utilization[sendblueGroupId(sticky)], "missing_capacity"),
      }
    }
    if (capacityRemaining(sticky, utilization) <= 0) {
      return {
        ok: false,
        groupId: sendblueGroupId(sticky),
        fromNumber: sticky.number,
        reason: "sticky_group_capacity",
        capacitySnapshot: capacitySnapshot(
          sticky,
          input.checkedAt,
          utilization[sendblueGroupId(sticky)],
          "sticky_group_capacity"
        ),
      }
    }
    return {
      ok: true,
      groupId: sendblueGroupId(sticky),
      fromNumber: sticky.number,
      reason: "sticky_selected",
      capacitySnapshot: capacitySnapshot(sticky, input.checkedAt, utilization[sendblueGroupId(sticky)]),
    }
  }

  const hasWarmupOnly =
    candidateNumbers.some((number) => number.status === "warmup") &&
    !candidateNumbers.some((number) => number.status === "active")
  if (hasWarmupOnly && !input.allowWarmup) {
    const warmup = candidateNumbers.find((number) => number.status === "warmup")!
    return {
      ok: false,
      groupId: sendblueGroupId(warmup),
      fromNumber: warmup.number,
      reason: "warmup_requires_hitl",
      capacitySnapshot: capacitySnapshot(warmup, input.checkedAt, utilization[sendblueGroupId(warmup)], "warmup_requires_hitl"),
    }
  }

  const routable = candidateNumbers.filter((number) => isRoutableStatus(number, Boolean(input.allowWarmup)))
  if (routable.length === 0) {
    return {
      ok: false,
      reason: "no_routable_group",
      capacitySnapshot: capacitySnapshot(null, input.checkedAt, undefined, "no_routable_group"),
    }
  }

  const missingCapacity = routable.find((number) => !isCapacityConfigured(number))
  const eligible = routable.filter(
    (number) => isCapacityConfigured(number) && capacityRemaining(number, utilization) > 0
  )
  if (eligible.length === 0) {
    const full = routable.find((number) => isCapacityConfigured(number)) ?? missingCapacity ?? routable[0]!
    const reason = missingCapacity && !routable.some((number) => isCapacityConfigured(number))
      ? "missing_capacity"
      : "channel_capacity"
    return {
      ok: false,
      groupId: sendblueGroupId(full),
      fromNumber: full.number,
      reason,
      capacitySnapshot: capacitySnapshot(full, input.checkedAt, utilization[sendblueGroupId(full)], reason),
    }
  }

  const idx = hashStringToUint(input.candidateId) % eligible.length
  const selected = eligible[idx]!
  return {
    ok: true,
    groupId: sendblueGroupId(selected),
    fromNumber: selected.number,
    reason: "selected",
    capacitySnapshot: capacitySnapshot(selected, input.checkedAt, utilization[sendblueGroupId(selected)]),
  }
}

export function selectCapacityAwareFromNumber(
  pool: SendbluePoolConfig | null,
  userId: string,
  options: {
    stickyGroupId?: string | null
    usedTodayByGroupId?: Record<string, number> | Map<string, number>
    checkedAt?: Date
  } = {}
): SendblueCapacitySelection {
  const utilization = options.usedTodayByGroupId instanceof Map
    ? Object.fromEntries([...options.usedTodayByGroupId.entries()].map(([k, usedToday]) => [k, { usedToday }]))
    : Object.fromEntries(
        Object.entries(options.usedTodayByGroupId ?? {}).map(([k, usedToday]) => [k, { usedToday }])
      )
  return selectSendblueCapacityGroup(pool, {
    candidateId: userId,
    checkedAt: (options.checkedAt ?? new Date()).toISOString(),
    stickyAccountGroupId: options.stickyGroupId?.trim() || undefined,
    utilization,
  })
}

/**
 * Cached pool fetch from Firestore. 60s TTL keeps the hot path fast while
 * letting admins flip numbers on/off in seconds.
 */
let cached: { config: SendbluePoolConfig | null; expiresAt: number } | null = null
const POOL_TTL_MS = 60 * 1000

export async function loadSendbluePool(db: Firestore): Promise<SendbluePoolConfig | null> {
  const now = Date.now()
  if (cached && cached.expiresAt > now) return cached.config
  try {
    const snap = await db.collection("pa-config").doc("sendblue-pool").get()
    if (!snap.exists) {
      cached = { config: null, expiresAt: now + POOL_TTL_MS }
      return null
    }
    const data = snap.data() as SendbluePoolConfig
    cached = { config: data, expiresAt: now + POOL_TTL_MS }
    return data
  } catch {
    cached = { config: null, expiresAt: now + POOL_TTL_MS }
    return null
  }
}

/** Test seam — clear cache. */
export function _resetPoolCache(): void {
  cached = null
}

// ─── Scan-time new-user counter (the missing load-balance writer) ──────────────
//
// THE GAP (verified, doc §3.2): `hasNewUserCapacity` reads `assignedNewUsers`
// but no code ever incremented it, so `newUserCap` was inert. The QR scan path
// hands out a number BEFORE any candidateId exists, so we increment the per-group
// new-user counter at PICK time (not at inbound) — that defuses the two-scanners-
// race (doc §3.5 Race A): back-to-back scans each see the post-increment count.
//
// B1 (doc §3.4/B1, recommended): counters live in a SIBLING map doc
// `pa-config/sendblue-pool-counters = { <groupId>: <n> }`, NOT inside the
// `groups` ARRAY. Firestore `set(..., {merge:true})` on an array REPLACES the
// whole array (clobbering concurrent writes); a map element-merges cleanly, so
// `FieldValue.increment` per groupId is race-safe. `loadSendbluePoolWithCounters`
// overlays the map onto the static pool's `assignedNewUsers` at read time.

export const SENDBLUE_POOL_COUNTERS_DOC = "sendblue-pool-counters"

/** Counter overlay shape: { [groupId]: assignedNewUsers }. */
export type SendbluePoolCounters = Record<string, number>

let countersCache: { counters: SendbluePoolCounters; expiresAt: number } | null = null

/** Read the per-group new-user counter map (60s TTL — same cadence as the pool). */
export async function loadSendbluePoolCounters(db: Firestore): Promise<SendbluePoolCounters> {
  const now = Date.now()
  if (countersCache && countersCache.expiresAt > now) return countersCache.counters
  try {
    const snap = await db.collection("pa-config").doc(SENDBLUE_POOL_COUNTERS_DOC).get()
    const raw = snap.exists ? (snap.data() as Record<string, unknown>) : {}
    const counters: SendbluePoolCounters = {}
    for (const [groupId, value] of Object.entries(raw ?? {})) {
      const n = typeof value === "number" ? value : Number(value)
      if (Number.isFinite(n)) counters[groupId] = Math.max(0, Math.trunc(n))
    }
    countersCache = { counters, expiresAt: now + POOL_TTL_MS }
    return counters
  } catch {
    countersCache = { counters: {}, expiresAt: now + POOL_TTL_MS }
    return {}
  }
}

/**
 * Overlay the sibling counter map onto a static pool config so `assignedNewUsers`
 * reflects the live count `hasNewUserCapacity` checks. Pure — does not mutate `pool`.
 */
export function overlaySendbluePoolCounters(
  pool: SendbluePoolConfig | null,
  counters: SendbluePoolCounters
): SendbluePoolConfig | null {
  if (!pool) return pool
  if (!counters || Object.keys(counters).length === 0) return pool
  const applyToGroup = <T extends { groupId?: string; assignedNewUsers?: number }>(g: T): T => {
    const groupId = g.groupId?.trim()
    if (!groupId || !(groupId in counters)) return g
    return { ...g, assignedNewUsers: counters[groupId] }
  }
  return {
    ...pool,
    ...(Array.isArray(pool.groups) ? { groups: pool.groups.map(applyToGroup) } : {}),
  }
}

/** Pool config with the live new-user counters overlaid (use for capacity-aware picks). */
export async function loadSendbluePoolWithCounters(db: Firestore): Promise<SendbluePoolConfig | null> {
  const [pool, counters] = await Promise.all([loadSendbluePool(db), loadSendbluePoolCounters(db)])
  return overlaySendbluePoolCounters(pool, counters)
}

/**
 * Atomically bump the new-user counter for `groupId` at scan/pick time.
 * Map-keyed `FieldValue.increment` element-merges (no array clobber, doc §3.4/B1).
 */
export async function incrementAssignedNewUsers(db: Firestore, groupId: string): Promise<void> {
  const key = groupId.trim()
  if (!key) return
  await db
    .collection("pa-config")
    .doc(SENDBLUE_POOL_COUNTERS_DOC)
    .set({ [key]: FieldValue.increment(1) }, { merge: true })
  countersCache = null
}

/**
 * Decrement the new-user counter for `groupId` — used by the abandoned-scan sweep
 * (doc §3.5 Race A) when a `pa-qr-scan-pending` doc TTLs out still `status:'pending'`
 * (a scanner who never sent). Keeps capacity from leaking. Never drives below 0 on
 * read (the overlay clamps), but we still floor the stored value defensively.
 */
export async function decrementAssignedNewUsers(db: Firestore, groupId: string): Promise<void> {
  const key = groupId.trim()
  if (!key) return
  await db.runTransaction(async (t) => {
    const ref = db.collection("pa-config").doc(SENDBLUE_POOL_COUNTERS_DOC)
    const snap = await t.get(ref)
    const cur = snap.exists ? Number((snap.data() as Record<string, unknown>)[key] ?? 0) : 0
    const next = Math.max(0, (Number.isFinite(cur) ? cur : 0) - 1)
    t.set(ref, { [key]: next }, { merge: true })
  })
  countersCache = null
}

export type PickScanNumberResult = { number: string; groupId: string } | null

/**
 * Scan-time number pick. Keyed on the `scanToken` (no candidateId exists yet),
 * capacity-aware (`requireNewUserCapacity`) over the counter-overlaid pool. Returns
 * the picked number AND its groupId so the caller can persist the sticky number and
 * bump that group's counter. Pure selection — caller does the increment + write.
 */
export function pickScanNumber(
  pool: SendbluePoolConfig | null,
  scanToken: string,
  options: PickFromNumberOptions = { requireNewUserCapacity: true }
): PickScanNumberResult {
  const number = pickFromNumber(pool, scanToken, options)
  if (!number) return null
  const found = findSendbluePoolNumber(pool, number)
  const groupId = found ? sendblueGroupId(found) : number
  return { number, groupId }
}

/** Test seam — clear the counter cache. */
export function _resetCountersCache(): void {
  countersCache = null
}
