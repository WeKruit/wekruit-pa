/**
 * Worker config: peer allowlist + channel flags.
 *
 * Phase 23 — D-01: Allowlist source-of-truth migrates env → Firestore (prod).
 *   - PA_ALLOWLIST_SOURCE=firestore (default): reads pa_beta_participants (status=active)
 *   - PA_ALLOWLIST_SOURCE=env: reads IMESSAGE_PEERS / IMESSAGE_PEER (dev mode)
 * Firestore result is cached for 30s to avoid per-message hammering.
 *
 * When allowlist-deny fires and a Firestore handle is available,
 * recordAllowlistDeny writes pa_abuse_events (BETA-02).
 */
import type { Firestore } from "firebase-admin/firestore"
import { PA_COLLECTIONS } from "@pa/core-types"
import { appendAuditEvent } from "@pa/pa-broker"
import { randomUUID } from "node:crypto"

/** Optional allowlist: set IMESSAGE_PEER or IMESSAGE_PEERS to restrict DMs. */
export const DEFAULT_PEER = process.env.IMESSAGE_DEFAULT_PEER || ""

export function normalizePeer(raw: string): string {
  const value = raw.trim()
  if (!value) return ""
  if (value.includes("@")) return value.toLowerCase()
  const digits = value.replace(/\D/g, "")
  if (!digits) return ""
  if (value.startsWith("+")) return `+${digits}`
  if (digits.length === 10) return `+1${digits}`
  return `+${digits}`
}

/** Env-based allowlist (dev mode: PA_ALLOWLIST_SOURCE=env) */
export function getPeerAllowlist(): string[] {
  const raw = [process.env.IMESSAGE_PEERS, process.env.IMESSAGE_PEER, DEFAULT_PEER]
    .filter(Boolean)
    .join(",")
  return raw
    .split(/[\n,;]/g)
    .map(normalizePeer)
    .filter(Boolean)
}

export function getPeerDisplay(): string {
  return getPeerAllowlist().join(", ")
}

function digits(s: string): string {
  return s.replace(/\D/g, "")
}

export function isSamePeer(a: string | null, b: string): boolean {
  if (!a) return false
  const na = normalizePeer(a)
  const nb = normalizePeer(b)
  if (!na || !nb) return false
  if (na === nb) return true
  if (na.includes("@") || nb.includes("@")) return false
  const da = digits(na)
  const db = digits(nb)
  if (da.length >= 10 && db.length >= 10) return da.slice(-10) === db.slice(-10)
  return false
}

/**
 * Phase 21 — channel-cutover flag (D-08).
 */
export function isLegacyChannelEnabled(): boolean {
  return process.env.PA_CHANNEL_LEGACY === "1"
}

/**
 * Fail-closed by default.
 */
export function useDmAllowlist(): boolean {
  return process.env.IMESSAGE_DM_ALLOWLIST !== "0"
}

// ---------------------------------------------------------------------------
// Phase 23 D-01 — Firestore-first allowlist cache
// ---------------------------------------------------------------------------

let _firestoreAllowlistCache: string[] | null = null
let _firestoreAllowlistCachedAt = 0
const FIRESTORE_ALLOWLIST_CACHE_MS = 30_000 // 30s

/**
 * Resolve the worker's effective peer allowlist.
 *
 * - PA_ALLOWLIST_SOURCE=env → env-only path (dev mode)
 * - PA_ALLOWLIST_SOURCE=firestore or unset → Firestore pa_beta_participants
 *   where status="active". Cached for 30s. Falls back to env on error.
 *
 * Callers then use isSamePeer() for comparison (existing worker pattern).
 */
export async function resolveWorkerAllowlist(db: Firestore): Promise<string[]> {
  const source = process.env.PA_ALLOWLIST_SOURCE ?? "firestore"
  if (source === "env") {
    return getPeerAllowlist()
  }
  // Firestore path — check cache
  const now = Date.now()
  if (_firestoreAllowlistCache !== null && now - _firestoreAllowlistCachedAt < FIRESTORE_ALLOWLIST_CACHE_MS) {
    return _firestoreAllowlistCache
  }
  try {
    const snap = await db
      .collection(PA_COLLECTIONS.betaParticipants)
      .where("status", "in", ["active"])
      .limit(500)
      .get()
    const handles = snap.docs
      .map((d) => {
        const data = d.data() as { contactHandle?: string }
        return data.contactHandle ? normalizePeer(data.contactHandle) : ""
      })
      .filter(Boolean)
    _firestoreAllowlistCache = handles
    _firestoreAllowlistCachedAt = now
    return handles
  } catch (e) {
    // Fail-open to env on Firestore error (don't lock out ops during incident)
    console.warn("[allowlist] Firestore fetch failed, falling back to env:", e)
    return getPeerAllowlist()
  }
}

/** Invalidate the Firestore allowlist cache (e.g. after a participant update). */
export function invalidateAllowlistCache(): void {
  _firestoreAllowlistCache = null
  _firestoreAllowlistCachedAt = 0
}

/**
 * Phase 23 BETA-02 — record an allowlist-deny event.
 * Idempotent within 60s window keyed on channel+handle+minute bucket.
 */
export async function recordWorkerAllowlistDeny(
  db: Firestore,
  input: { contactHandle: string; channel?: string }
): Promise<void> {
  const channel = input.channel ?? "imessage"
  const normalizedHandle = normalizePeer(input.contactHandle) || input.contactHandle
  const now = Date.now()
  const idempotencyKey = `allowlist_${channel}_${normalizedHandle}_${Math.floor(now / 60000)}`
  const createdAt = new Date(now).toISOString()
  try {
    await db.collection(PA_COLLECTIONS.abuseEvents).doc(idempotencyKey).set(
      {
        id: idempotencyKey,
        kind: "allowlist_deny",
        createdAt,
        channel,
        contactHandle: normalizedHandle,
        message: `Worker allowlist deny: inbound from ${normalizedHandle} on ${channel}`,
      },
      { merge: false }
    )
    await appendAuditEvent(db, {
      actor: "worker",
      kind: "safety_block",
      message: `Allowlist deny: ${normalizedHandle} on ${channel}`,
      meta: { channel, contactHandle: normalizedHandle, kind: "allowlist_deny" },
    })
  } catch (e) {
    console.warn("[allowlist] recordWorkerAllowlistDeny failed:", e)
  }
}
