/**
 * Phase 23 — Firestore-first allowlist resolver with env fallback.
 *
 * Source of truth: PA_ALLOWLIST_SOURCE env var
 *   - "firestore" (default in prod): reads pa_beta_participants where status in ["active"]
 *   - "env": reads IMESSAGE_PEERS / IMESSAGE_PEER env vars (dev mode)
 *
 * Idempotency for allowlist_deny abuse rows: keyed on
 *   allowlist_{channel}_{normalizedHandle}_{Math.floor(now/60000)}
 * which collapses multiple deny writes from the same handle+channel within
 * any 60-second bucket.
 */
import type { Firestore } from "firebase-admin/firestore"
import { PA_COLLECTIONS } from "@pa/core-types"
import { appendAuditEvent } from "@pa/pa-broker"

export type AllowlistEntry = {
  contactHandle: string
  contactType: "phone" | "email"
}

/** Normalize a raw contact handle to a canonical form for comparison. */
function normalizeHandle(raw: string): string {
  const value = raw.trim()
  if (!value) return ""
  if (value.includes("@")) return value.toLowerCase().trim()
  const digits = value.replace(/\D/g, "")
  if (!digits) return ""
  if (value.startsWith("+")) return `+${digits}`
  if (digits.length === 10) return `+1${digits}`
  return `+${digits}`
}

/**
 * Parse the env-based allowlist (IMESSAGE_PEERS / IMESSAGE_PEER) into
 * AllowlistEntry objects for runtime-owned inbound/outbound processing.
 */
function parseEnvAllowlist(): AllowlistEntry[] {
  const raw = [process.env.IMESSAGE_PEERS, process.env.IMESSAGE_PEER]
    .filter(Boolean)
    .join(",")
  if (!raw) return []
  return raw
    .split(/[\n,;]/g)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((handle) => {
      const normalized = normalizeHandle(handle)
      if (!normalized) return null
      const contactType: "phone" | "email" = normalized.includes("@") ? "email" : "phone"
      return { contactHandle: normalized, contactType }
    })
    .filter((e): e is AllowlistEntry => e !== null)
}

/**
 * Resolve the current allowlist. Returns an array of AllowlistEntry objects.
 *
 * By default (prod) reads from Firestore pa_beta_participants where
 * status = "active". Falls back to env when PA_ALLOWLIST_SOURCE=env.
 */
export async function resolveAllowlist(db: Firestore): Promise<AllowlistEntry[]> {
  const source = process.env.PA_ALLOWLIST_SOURCE ?? "firestore"
  if (source === "env") {
    return parseEnvAllowlist()
  }
  // Firestore path (default)
  const snap = await db
    .collection(PA_COLLECTIONS.betaParticipants)
    .where("status", "in", ["active"])
    .limit(500)
    .get()
  return snap.docs.map((d) => {
    const data = d.data() as { contactHandle: string; contactType: "phone" | "email" }
    return {
      contactHandle: data.contactHandle,
      contactType: data.contactType,
    }
  })
}

/**
 * Test whether a given inbound contact handle appears in the allowlist.
 * Phones are matched by last-10-digit suffix to handle carrier-prefix variations.
 * Emails are compared lowercase.
 */
export function isAllowlisted(handle: string, list: AllowlistEntry[]): boolean {
  const normalized = normalizeHandle(handle)
  if (!normalized) return false
  const isEmail = normalized.includes("@")
  for (const entry of list) {
    if (isEmail) {
      if (entry.contactType === "email" && entry.contactHandle === normalized) return true
    } else {
      if (entry.contactType === "phone") {
        const entryDigits = entry.contactHandle.replace(/\D/g, "")
        const handleDigits = normalized.replace(/\D/g, "")
        if (
          entryDigits.length >= 10 &&
          handleDigits.length >= 10 &&
          entryDigits.slice(-10) === handleDigits.slice(-10)
        ) {
          return true
        }
      }
    }
  }
  return false
}

/**
 * Record an allowlist-deny event in pa_abuse_events and pa_audit_events.
 *
 * Idempotent within a 60-second window: the idempotency key encodes the
 * 60s bucket so rapid retries from the same handle+channel are collapsed
 * to a single row (prevent log spam from a determined non-allowlisted sender).
 */
export async function recordAllowlistDeny(
  db: Firestore,
  input: {
    channel: string
    contactHandle: string
    userId?: string
  }
): Promise<void> {
  const now = Date.now()
  const normalizedHandle = normalizeHandle(input.contactHandle) || input.contactHandle
  const idempotencyKey = `allowlist_${input.channel}_${normalizedHandle}_${Math.floor(now / 60000)}`
  const createdAt = new Date(now).toISOString()

  // Use idempotency key as doc id — same key = same doc = idempotent SET
  const abuseRef = db.collection(PA_COLLECTIONS.abuseEvents).doc(idempotencyKey)
  await abuseRef.set(
    {
      id: idempotencyKey,
      kind: "allowlist_deny",
      createdAt,
      channel: input.channel,
      contactHandle: normalizedHandle,
      ...(input.userId ? { userId: input.userId } : {}),
      message: `Allowlist deny: inbound from non-allowlisted handle ${normalizedHandle} on channel ${input.channel}`,
    },
    { merge: false }
  )

  // Audit event — always append (defense-in-depth; this matches Phase 17 behavior)
  await appendAuditEvent(db, {
    actor: "worker",
    kind: "safety_block",
    message: `Allowlist deny: ${normalizedHandle} on ${input.channel}`,
    ...(input.userId ? { userId: input.userId } : {}),
    meta: { channel: input.channel, contactHandle: normalizedHandle, kind: "allowlist_deny" },
  })
}
