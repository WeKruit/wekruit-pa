export type WorkerHealth = { mem0ApiKeyPresent?: boolean; service?: string }

export function getWorkerHealthBaseUrl(): string | undefined {
  return import.meta.env.VITE_WORKER_HEALTH_URL?.trim()
}

/** GET {base}/health — used for Mem0 key presence on the Mac worker. */
export async function fetchWorkerHealth(): Promise<{
  health: WorkerHealth | null
  err: string | null
}> {
  const raw = getWorkerHealthBaseUrl()
  if (!raw) return { health: null, err: null }
  try {
    const u = raw.replace(/\/$/, "")
    const r = await fetch(`${u}/health`, { method: "GET" })
    const j = (await r.json()) as WorkerHealth
    return { health: j, err: r.ok ? null : `HTTP ${r.status}` }
  } catch (e: unknown) {
    return { health: null, err: e instanceof Error ? e.message : String(e) }
  }
}
