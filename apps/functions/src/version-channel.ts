/**
 * Per-user version channel (canary / ring) — Cloud Function core logic.
 *
 * Sibling to the `paRuntimeMode` admin endpoint (see apps/functions/src/index.ts
 * `paRuntimeMode`). An operator reads or sets a single user's `versionChannel`
 * ("latest" | "stable") + audit fields. Setting `latest` opts an individual
 * user into the newest conversation behavior under test; internal/test users
 * (env `PA_INTERNAL_USER_IDS` / `PA_INTERNAL_PHONE_NUMBERS`, incl. the dev
 * phone +14243201960) are ALWAYS resolved to `latest` by the orchestrator's
 * `getVersionChannel` regardless of this field.
 *
 * The HTTP wiring (auth, CORS, method routing) lives in `index.ts`; the pure
 * read/write logic lives HERE over a minimal injected Firestore so it can be
 * unit-tested without importing the side-effectful functions entrypoint. Same
 * extract pattern as `admin-match-debug.ts` (`runAdminJobMatchDebug`).
 */
import { PA_COLLECTIONS } from "@pa/core-types"
import {
  resolveVersionChannel,
  isInternalUser,
  type VersionChannel,
} from "@pa/pa-orchestrator"

// ---------------------------------------------------------------------------
// Minimal Firestore surface — just what this module touches. Lets tests inject
// an in-memory fake (mirrors the `apps/functions` unit-test convention).
// ---------------------------------------------------------------------------
export interface VcDocSnap {
  exists: boolean
  data(): Record<string, unknown> | undefined
}
export interface VcDocRef {
  get(): Promise<VcDocSnap>
  set(patch: Record<string, unknown>, opts?: { merge?: boolean }): Promise<unknown>
}
export interface VcCollRef {
  doc(id: string): VcDocRef
  add(row: Record<string, unknown>): Promise<unknown>
}
export interface VcFirestore {
  collection(name: string): VcCollRef
}

export type VersionChannelRead = {
  userId: string
  /** The persisted field exactly as stored ("latest" | "stable" | undefined). */
  versionChannel: VersionChannel
  /**
   * The EFFECTIVE channel after the internal-allowlist override is applied.
   * This is what `getVersionChannel` returns at runtime, so the dashboard can
   * show "stored stable, but effective latest (internal user)".
   */
  effectiveChannel: VersionChannel
  /** Whether this user is forced to latest by the internal allowlist. */
  internal: boolean
  versionChannelAt?: string
  versionChannelSetBy?: string
  versionChannelReason?: string
}

export function parseChannel(raw: unknown): VersionChannel | null {
  const v = String(raw ?? "").trim()
  return v === "latest" || v === "stable" ? v : null
}

/**
 * GET — read the stored + effective channel for a user. Throws a `{status:404}`
 * error when the user doc is absent (mirrors paRuntimeMode GET).
 */
export async function readVersionChannel(
  db: VcFirestore,
  userId: string,
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): Promise<VersionChannelRead> {
  const snap = await db.collection(PA_COLLECTIONS.users).doc(userId).get()
  if (!snap.exists) {
    throw Object.assign(new Error("user_not_found"), { status: 404, userId })
  }
  const u = (snap.data() ?? {}) as {
    versionChannel?: VersionChannel | string
    phoneE164?: string
    versionChannelAt?: string
    versionChannelSetBy?: string
    versionChannelReason?: string
  }
  const stored: VersionChannel = u.versionChannel === "latest" ? "latest" : "stable"
  const effectiveChannel = resolveVersionChannel({
    userId,
    phoneE164: u.phoneE164,
    storedChannel: u.versionChannel,
    env,
  })
  return {
    userId,
    versionChannel: stored,
    effectiveChannel,
    internal: isInternalUser({ userId, phoneE164: u.phoneE164, env }),
    versionChannelAt: u.versionChannelAt,
    versionChannelSetBy: u.versionChannelSetBy,
    versionChannelReason: u.versionChannelReason,
  }
}

/**
 * POST — set a user's `versionChannel` + audit fields, and append a
 * `version_channel` audit row. Returns the write summary. `nowIso` + `setBy`
 * are injected so the CF can supply the operator identity + clock.
 *
 * The audit-row append is best-effort: a failure there is logged via the
 * injected `onAuditError` hook but does NOT fail the call, because the channel
 * field write has already committed (matches paRuntimeMode semantics). The
 * channel write itself is NOT swallowed — if it throws, the caller sees it.
 */
export async function setVersionChannel(
  db: VcFirestore,
  input: {
    userId: string
    channel: VersionChannel
    reason?: string
    setBy: string
    nowIso: string
    onAuditError?: (err: unknown) => void
  },
): Promise<{ ok: true; userId: string; channel: VersionChannel; versionChannelAt: string; setBy: string; auditWritten: boolean }> {
  const reason = (input.reason ?? "").trim().slice(0, 500)
  const patch: Record<string, unknown> = {
    versionChannel: input.channel,
    versionChannelAt: input.nowIso,
    versionChannelSetBy: input.setBy,
    updatedAt: input.nowIso,
  }
  if (reason) patch.versionChannelReason = reason
  await db.collection(PA_COLLECTIONS.users).doc(input.userId).set(patch, { merge: true })
  // Append audit row for forensic traceability (best-effort).
  let auditWritten = true
  try {
    await db.collection(PA_COLLECTIONS.auditEvents).add({
      kind: "version_channel",
      userId: input.userId,
      actor: input.setBy,
      createdAt: input.nowIso,
      message: `Version channel set to ${input.channel}`,
      meta: { channel: input.channel, reason: reason || null },
    })
  } catch (auditErr) {
    auditWritten = false
    input.onAuditError?.(auditErr)
  }
  return {
    ok: true,
    userId: input.userId,
    channel: input.channel,
    versionChannelAt: input.nowIso,
    setBy: input.setBy,
    auditWritten,
  }
}
