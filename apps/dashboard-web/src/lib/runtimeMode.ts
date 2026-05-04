/**
 * iter31 — Human-in-the-loop runtime-mode admin client.
 *
 * Wraps the `paRuntimeMode` Cloud Function (apps/functions/src/index.ts).
 * Operator pauses/resumes an agent for a single user; on pause the
 * orchestrator skips reply generation but still appends inbound to
 * pa-messages so memory + audit are preserved. Resume produces no
 * confirmation reply — the next user inbound flows through the normal path.
 */
import { auth } from "./firebase.js"

export type RuntimeMode = "auto" | "paused"

export type RuntimeModeRead = {
  userId: string
  runtimeMode: RuntimeMode
  runtimeModeAt?: string
  runtimeModeSetBy?: string
  runtimeModeReason?: string
}

function endpointBaseUrl() {
  const configured = import.meta.env.VITE_RUNTIME_MODE_URL
  if (configured) return String(configured).replace(/\/+$/, "")
  const projectId = import.meta.env.VITE_FIREBASE_PROJECT_ID
  if (!projectId) throw new Error("VITE_FIREBASE_PROJECT_ID is required")
  return `https://us-central1-${projectId}.cloudfunctions.net/paRuntimeMode`
}

async function adminFetch(path: string, init: RequestInit = {}) {
  const token = await auth().currentUser?.getIdToken()
  if (!token) throw new Error("Sign in before using Runtime Mode admin")
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
    throw new Error(text || `RuntimeMode request failed: ${resp.status}`)
  }
  return resp.json() as Promise<unknown>
}

export async function getRuntimeMode(userId: string): Promise<RuntimeModeRead> {
  const params = new URLSearchParams({ userId })
  return adminFetch(`?${params.toString()}`, { method: "GET" }) as Promise<RuntimeModeRead>
}

export async function setRuntimeMode(
  userId: string,
  mode: RuntimeMode,
  reason?: string
): Promise<{ ok: boolean; userId: string; mode: RuntimeMode; runtimeModeAt: string; setBy: string }> {
  return adminFetch("", {
    method: "POST",
    body: JSON.stringify({ userId, mode, reason: reason ?? "" }),
  }) as Promise<{ ok: boolean; userId: string; mode: RuntimeMode; runtimeModeAt: string; setBy: string }>
}
