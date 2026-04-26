import { auth } from "./firebase.js"

export type MemoryPoint = {
  id: string | number
  payload?: Record<string, unknown>
}

export type MemoryListResponse = {
  userId: string
  collection: string
  points: MemoryPoint[]
}

export type MemoryClearResponse = {
  summary: string
  result: {
    userId: string
    dryRun: boolean
    qdrant: { collection: string; matched: number; deleted: boolean }
    firestore: Record<string, number>
  }
}

function memoryAdminBaseUrl() {
  const configured = import.meta.env.VITE_MEMORY_ADMIN_URL
  if (configured) return String(configured).replace(/\/+$/, "")
  const projectId = import.meta.env.VITE_FIREBASE_PROJECT_ID
  if (!projectId) throw new Error("VITE_FIREBASE_PROJECT_ID is required")
  return `https://us-central1-${projectId}.cloudfunctions.net/memoryAdmin`
}

async function adminFetch(path: string, init: RequestInit = {}) {
  const token = await auth().currentUser?.getIdToken()
  if (!token) throw new Error("Sign in before using Memory Admin")
  const resp = await fetch(`${memoryAdminBaseUrl()}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  })
  if (!resp.ok) {
    const text = await resp.text()
    throw new Error(text || `Memory Admin request failed: ${resp.status}`)
  }
  return resp.json() as Promise<unknown>
}

export async function listMemoryPoints(userId: string, q: string): Promise<MemoryListResponse> {
  const params = new URLSearchParams({ userId })
  if (q.trim()) params.set("q", q.trim())
  return adminFetch(`?${params.toString()}`) as Promise<MemoryListResponse>
}

export async function deleteMemoryPoint(userId: string, pointId: string | number): Promise<void> {
  const params = new URLSearchParams({ userId, pointId: String(pointId) })
  await adminFetch(`?${params.toString()}`, { method: "DELETE" })
}

export async function clearUserMemory(userId: string): Promise<MemoryClearResponse> {
  return adminFetch("", {
    method: "POST",
    body: JSON.stringify({ action: "clear", userId }),
  }) as Promise<MemoryClearResponse>
}
