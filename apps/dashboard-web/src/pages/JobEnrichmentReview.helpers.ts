export type StatusTone = "ok" | "warn" | "info" | "muted"

export function enrichmentStatusTone(status: string | null | undefined): StatusTone {
  const normalized = String(status ?? "").toLowerCase()
  if (normalized === "approved") return "ok"
  if (normalized === "rejected" || normalized === "needs_review") return "warn"
  if (normalized === "draft") return "info"
  return "muted"
}

export function formatPercent(value: unknown): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "-"
  return `${Math.round(value * 100)}%`
}

export function formatScore(value: unknown): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "-"
  return value.toFixed(2)
}

export function formatTime(value: string | null | undefined): string {
  if (!value) return "-"
  return value.slice(0, 19).replace("T", " ")
}

export function timestampToIso(value: unknown): string | null {
  if (!value) return null
  if (typeof value === "string") return value
  if (value instanceof Date) return value.toISOString()
  if (typeof value === "object" && value && "toDate" in value && typeof value.toDate === "function") {
    return value.toDate().toISOString()
  }
  if (typeof value === "object" && value && "seconds" in value && typeof value.seconds === "number") {
    return new Date(value.seconds * 1000).toISOString()
  }
  return null
}

export function compactValue(value: unknown, max = 220): string {
  if (value === undefined || value === null || value === "") return "-"
  const raw = typeof value === "string" ? value : JSON.stringify(value)
  return raw.length > max ? `${raw.slice(0, max)}...` : raw
}

export function listify(value: unknown): string[] {
  if (!value) return []
  if (Array.isArray(value)) return value.map((entry) => compactValue(entry, 120)).filter((entry) => entry !== "-")
  if (typeof value === "object") {
    return Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined && entry !== null && entry !== "")
      .map(([key, entry]) => `${key}: ${compactValue(entry, 120)}`)
  }
  return [compactValue(value, 120)]
}

export function displaySponsorship(value: unknown): { label: string; tone: StatusTone } {
  if (value === true) return { label: "Yes", tone: "ok" }
  if (value === false) return { label: "No", tone: "muted" }
  return { label: "Unknown/Review", tone: "warn" }
}

export function sortByUpdatedAt<T extends { updatedAt?: string | null; createdAt?: string | null }>(
  rows: readonly T[]
): T[] {
  return [...rows].sort((a, b) => rowTime(b) - rowTime(a))
}

function rowTime(row: { updatedAt?: string | null; createdAt?: string | null }): number {
  const updated = row.updatedAt ? Date.parse(row.updatedAt) : 0
  if (Number.isFinite(updated) && updated > 0) return updated
  const created = row.createdAt ? Date.parse(row.createdAt) : 0
  return Number.isFinite(created) ? created : 0
}
