/**
 * v1.9 Phase 88 — Sendblue multi-number pool selector.
 *
 * Pool config:
 *   pa-config/sendblue-pool { numbers: [{ number, status, capacity }] }
 *   pa-config/sendblue-pool { groups: [{ groupId, status, dailySendCap, numbers }] }
 *
 * Selector strategy:
 *   - Filter to status === "active"
 *   - hash(userId) mod activeNumbers.length → same user always routed to
 *     same number (thread continuity)
 *   - Fall back to env SENDBLUE_FROM_NUMBER when pool empty / unconfigured
 *
 * Single-number pool produces identical behavior to pre-v1.9.
 */

import type { Firestore } from "firebase-admin/firestore"

export type SendbluePoolNumberStatus =
  | "active"
  | "warmup"
  | "paused"
  | "throttled"
  | "degraded"

export interface SendbluePoolNumber {
  number: string
  groupId?: string
  status: SendbluePoolNumberStatus
  /** S6 hard cap: accepted outbound sends per group per UTC day. */
  capacity?: number
  dailySendCap?: number
}

export interface SendbluePoolGroup {
  groupId: string
  status: SendbluePoolNumberStatus
  capacity?: number
  dailySendCap?: number
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

/**
 * Pure selector — pick a from-number for a given userId from a pool config.
 * Returns null when pool has zero active numbers.
 */
export function pickFromNumber(
  pool: SendbluePoolConfig | null,
  userId: string
): string | null {
  if (!pool || !Array.isArray(pool.numbers)) return null
  const active = pool.numbers.filter((n) => n.status === "active" && n.number)
  if (active.length === 0) return null
  const idx = hashStringToUint(userId) % active.length
  return active[idx].number
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
            capacity: group.capacity,
            dailySendCap: group.dailySendCap,
          }
        }
        const number = entry.number?.trim()
        if (!number) return null
        return {
          ...entry,
          number,
          groupId: entry.groupId?.trim() || groupId,
          status: entry.status ?? group.status,
          capacity: entry.capacity ?? group.capacity,
          dailySendCap: entry.dailySendCap ?? group.dailySendCap,
        }
      })
      .filter((entry): entry is SendbluePoolNumber => entry !== null)
  })
  const legacy = Array.isArray(pool.numbers) ? pool.numbers : []
  return [...grouped, ...legacy]
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

  const byGroup = new Map(poolNumbers.map((number) => [sendblueGroupId(number), number] as const))
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
    poolNumbers.some((number) => number.status === "warmup") &&
    !poolNumbers.some((number) => number.status === "active")
  if (hasWarmupOnly && !input.allowWarmup) {
    const warmup = poolNumbers.find((number) => number.status === "warmup")!
    return {
      ok: false,
      groupId: sendblueGroupId(warmup),
      fromNumber: warmup.number,
      reason: "warmup_requires_hitl",
      capacitySnapshot: capacitySnapshot(warmup, input.checkedAt, utilization[sendblueGroupId(warmup)], "warmup_requires_hitl"),
    }
  }

  const routable = poolNumbers.filter((number) => isRoutableStatus(number, Boolean(input.allowWarmup)))
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
