/** Optional allowlist: set IMESSAGE_PEER or IMESSAGE_PEERS to restrict DMs. */
export const DEFAULT_PEER = process.env.IMESSAGE_DEFAULT_PEER || ""

function normalizePeer(raw: string): string {
  const value = raw.trim()
  if (!value) return ""
  if (value.includes("@")) return value.toLowerCase()
  const digits = value.replace(/\D/g, "")
  if (!digits) return ""
  if (value.startsWith("+")) return `+${digits}`
  if (digits.length === 10) return `+1${digits}`
  return `+${digits}`
}

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

export function useDmAllowlist(): boolean {
  return process.env.IMESSAGE_DM_ALLOWLIST === "1" && getPeerAllowlist().length > 0
}
