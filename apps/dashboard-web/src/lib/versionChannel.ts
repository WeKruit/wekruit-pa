/**
 * Per-user version channel (canary / ring) admin client.
 *
 * Wraps the `paVersionChannel` Cloud Function (apps/functions/src/index.ts).
 * Operator opts a single user into "latest" (newest conversation behavior
 * under test) or "stable" (previous behavior). Internal/test users
 * (PA_INTERNAL_USER_IDS / PA_INTERNAL_PHONE_NUMBERS incl. the dev phone) are
 * ALWAYS resolved to "latest" server-side regardless of the stored field, so
 * we always test on internal users before promoting a version to everyone.
 *
 * Sibling of `runtimeMode.ts`. A full dashboard UI page is a follow-up (this
 * lib is the seam an admin page or a quick console call uses).
 */
import { auth } from "./firebase.js"

export type VersionChannel = "latest" | "stable"

export type VersionChannelRead = {
  userId: string
  /** The persisted field. */
  versionChannel: VersionChannel
  /** Effective channel after the internal-allowlist override (what runtime uses). */
  effectiveChannel: VersionChannel
  /** True when the user is forced to latest by the internal allowlist. */
  internal: boolean
  versionChannelAt?: string
  versionChannelSetBy?: string
  versionChannelReason?: string
}

function endpointBaseUrl() {
  const configured = import.meta.env.VITE_VERSION_CHANNEL_URL
  if (configured) return String(configured).replace(/\/+$/, "")
  const projectId = import.meta.env.VITE_FIREBASE_PROJECT_ID
  if (!projectId) throw new Error("VITE_FIREBASE_PROJECT_ID is required")
  return `https://us-central1-${projectId}.cloudfunctions.net/paVersionChannel`
}

async function adminFetch(path: string, init: RequestInit = {}) {
  const token = await auth().currentUser?.getIdToken()
  if (!token) throw new Error("Sign in before using Version Channel admin")
  const resp = await fetch(`${endpointBaseUrl()}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  })
  if (!resp.ok) {
    const text = await resp.text()
    throw new Error(text || `VersionChannel request failed: ${resp.status}`)
  }
  return resp.json() as Promise<unknown>
}

export async function getVersionChannel(userId: string): Promise<VersionChannelRead> {
  const params = new URLSearchParams({ userId })
  return adminFetch(`?${params.toString()}`, { method: "GET" }) as Promise<VersionChannelRead>
}

export async function setVersionChannel(
  userId: string,
  channel: VersionChannel,
  reason?: string,
): Promise<{
  ok: boolean
  userId: string
  channel: VersionChannel
  versionChannelAt: string
  setBy: string
  auditWritten: boolean
}> {
  return adminFetch("", {
    method: "POST",
    body: JSON.stringify({ userId, channel, reason: reason ?? "" }),
  }) as Promise<{
    ok: boolean
    userId: string
    channel: VersionChannel
    versionChannelAt: string
    setBy: string
    auditWritten: boolean
  }>
}
