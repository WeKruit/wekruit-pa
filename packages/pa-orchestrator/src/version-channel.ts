/**
 * Per-user version channel (canary / ring) — pure resolver.
 *
 * Goal: when we ship new conversation behavior, ONLY internal/test users run
 * the LATEST version while everyone else keeps running the PREVIOUS STABLE
 * version, so we always dogfood internally before promoting to everyone.
 *
 * This module mirrors the shape of the per-user `runtimeMode` HITL pause
 * (packages/core-types `User.runtimeMode`, orchestrator `getRuntimeMode`). It
 * deliberately holds NO Firestore handle — it is a pure function over a small
 * "fact" object so it can be unit-tested in isolation and reused by both the
 * Firestore-backed orchestrator store and the `paVersionChannel` Cloud
 * Function setter.
 *
 * ── Resolution rule (single source of truth) ───────────────────────────────
 *   latest  IF  user is in the internal allowlist
 *               (env PA_INTERNAL_USER_IDS contains the userId, OR the user's
 *                phoneE164 is in PA_INTERNAL_PHONE_NUMBERS — which ALWAYS
 *                includes the dev phone +14243201960)
 *           OR  pa-users/{userId}.versionChannel === "latest"
 *   stable  OTHERWISE (field absent / "stable" / user not found)
 *
 * ── Zero-regression contract ───────────────────────────────────────────────
 * Resolving "latest" does NOTHING on its own. A behavior only diverges once it
 * is explicitly guarded by `isLatestChannel(...)` (or equivalent). Until a
 * behavior is marked latest-only, every user — internal or not — gets the
 * exact same code path as before. This is the same self-gating discipline as
 * `getRuntimeMode`: unimplemented / "auto" / "stable" ⇒ legacy behavior.
 */

export type VersionChannel = "latest" | "stable"

/** Dev phone that always rides the latest channel (per repo dev-phone authz). */
export const DEFAULT_INTERNAL_PHONE = "+14243201960"

/**
 * Inputs the resolver needs. Everything is optional so callers (tests, stores,
 * CFs) can supply only what they have. `env` is injected explicitly rather
 * than read from `process.env` by stealth — same convention as `getFlag`'s
 * `ctx.env`.
 */
export interface VersionChannelFacts {
  /** The resolved internal `pa-users/{uid}` id. */
  userId?: string | null
  /** The user's E.164 phone, if known (e.g. from the pa-users doc). */
  phoneE164?: string | null
  /** The persisted `pa-users.versionChannel` field, if any. */
  storedChannel?: VersionChannel | string | null
  /** Injected env (typically `process.env`). */
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>
}

function splitCsv(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
}

/** Normalize a phone to digits-with-leading-`+` so comparisons are robust. */
function normalizePhone(phone: string | null | undefined): string {
  if (!phone) return ""
  const digits = phone.replace(/\D/g, "")
  if (!digits) return ""
  return `+${digits}`
}

/**
 * The set of internal/test userIds from env `PA_INTERNAL_USER_IDS`
 * (comma-separated). Exported for reuse/inspection by callers + tests.
 */
export function internalUserIds(env: VersionChannelFacts["env"]): Set<string> {
  return new Set(splitCsv(env?.PA_INTERNAL_USER_IDS))
}

/**
 * The set of internal/test phone numbers (normalized E.164). Always includes
 * the dev phone {@link DEFAULT_INTERNAL_PHONE}; env `PA_INTERNAL_PHONE_NUMBERS`
 * (comma-separated) extends it.
 */
export function internalPhoneNumbers(env: VersionChannelFacts["env"]): Set<string> {
  const set = new Set<string>([DEFAULT_INTERNAL_PHONE])
  for (const p of splitCsv(env?.PA_INTERNAL_PHONE_NUMBERS)) {
    const n = normalizePhone(p)
    if (n) set.add(n)
  }
  return set
}

/** True when the userId OR phone is in the internal allowlist. */
export function isInternalUser(facts: VersionChannelFacts): boolean {
  const env = facts.env
  if (facts.userId && internalUserIds(env).has(facts.userId)) return true
  const phone = normalizePhone(facts.phoneE164)
  if (phone && internalPhoneNumbers(env).has(phone)) return true
  return false
}

/**
 * Resolve the effective channel for a user. Internal allowlist wins, then the
 * persisted field, else "stable". Never throws.
 */
export function resolveVersionChannel(facts: VersionChannelFacts): VersionChannel {
  if (isInternalUser(facts)) return "latest"
  if (facts.storedChannel === "latest") return "latest"
  return "stable"
}

/**
 * Integration helper — the seam a behavior consults to know whether to run the
 * NEW (latest-only) path. Returns `true` only when the user resolves to the
 * `latest` channel. When the store does not implement `getVersionChannel`
 * (older / test harnesses), this self-gates to `false` ⇒ stable behavior, so
 * adding the field + resolver is a strict no-op until a store opts in.
 *
 * Usage to mark a behavior "latest-only":
 *
 * ```ts
 * if (await isLatestChannel(store, event.userId)) {
 *   // NEW behavior under test — internal users only
 * } else {
 *   // PREVIOUS stable behavior — everyone else
 * }
 * ```
 */
export async function isLatestChannel(
  store: { getVersionChannel?(userId: string): Promise<VersionChannel> },
  userId: string,
): Promise<boolean> {
  if (!store.getVersionChannel) return false
  try {
    const channel = await store.getVersionChannel(userId)
    return channel === "latest"
  } catch {
    // Fail closed to stable — a resolver error must never flip a normal user
    // onto unproven behavior.
    return false
  }
}
