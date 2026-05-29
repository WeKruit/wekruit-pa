export {
  classifyCandidateProfile,
  deriveCandidateSource,
  hasReachableIdentity,
  isDemoPreviewProfile,
  isInternalOperatorProfile,
  isRealCandidateAccount,
  isSyntheticTestProfile,
  type CandidateClass,
  type CandidateListUserDoc,
  type CandidateProfileExternalSource as ExternalSource,
  type SourceKind,
} from "@pa/core-types"

export function isValidE164Phone(value?: string): boolean {
  return typeof value === "string" && /^\+[1-9]\d{7,14}$/.test(value)
}

export function digitsOnly(value?: string): string {
  return (value ?? "").replace(/\D/g, "")
}

export function phoneSearchDigits(value: string): string | null {
  const digits = digitsOnly(value)
  return digits.length >= 3 ? digits : null
}

export function normalizeCandidatePhoneLookup(value: string): string | null {
  const trimmed = value.trim()
  if (!trimmed) return null
  const digits = digitsOnly(trimmed)
  if (digits.length === 10) return `+1${digits}`
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`
  if (trimmed.startsWith("+") && digits.length >= 8) return `+${digits}`
  return null
}

export function matchesPhoneSearch(phoneE164: string | undefined, search: string): boolean {
  const queryDigits = phoneSearchDigits(search)
  if (!queryDigits || !phoneE164) return false
  return digitsOnly(phoneE164).includes(queryDigits)
}

export function previewCandidateDrawerText(value: unknown, max = 400): string | undefined {
  if (value === undefined || value === null || value === "") return undefined
  const raw =
    typeof value === "string"
      ? value
      : (() => {
          try {
            return JSON.stringify(value, null, 2)
          } catch {
            return String(value)
          }
        })()
  if (!raw) return undefined
  return raw.length > max ? `${raw.slice(0, max)}...` : raw
}

export function firstCandidateDrawerText(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value !== "string") continue
    const trimmed = value.trim()
    if (trimmed) return trimmed
  }
  return undefined
}

export function candidateDrawerTimeMs(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value === "string") {
    const parsed = Date.parse(value)
    return Number.isNaN(parsed) ? 0 : parsed
  }
  if (value && typeof value === "object") {
    const record = value as { seconds?: unknown; toMillis?: unknown }
    if (typeof record.toMillis === "function") {
      const millis = record.toMillis()
      return typeof millis === "number" && Number.isFinite(millis) ? millis : 0
    }
    if (typeof record.seconds === "number") return record.seconds * 1000
  }
  return 0
}

export function sortCandidateDrawerRows<T extends Record<string, unknown>>(
  rows: T[],
  timeFields: string[]
): T[] {
  return [...rows].sort((a, b) => {
    const at = firstCandidateDrawerTime(a, timeFields)
    const bt = firstCandidateDrawerTime(b, timeFields)
    return bt - at
  })
}

function firstCandidateDrawerTime(row: Record<string, unknown>, timeFields: string[]): number {
  for (const field of timeFields) {
    const value = candidateDrawerTimeMs(row[field])
    if (value > 0) return value
  }
  return 0
}

export function candidateDrawerVisibleCount(total: number, expanded: boolean, collapsedCount: number): number {
  if (!Number.isFinite(total) || total <= 0) return 0
  if (expanded) return total
  return Math.min(total, collapsedCount)
}

export function candidateDrawerPreviewMax(
  expanded: boolean,
  collapsedMax: number,
  expandedMax: number
): number {
  return expanded ? expandedMax : collapsedMax
}

export function candidateDrawerRegionCount(
  total: number,
  singular: string,
  plural = `${singular}s`
): string {
  const count = Number.isFinite(total) && total > 0 ? Math.trunc(total) : 0
  return `${count} ${count === 1 ? singular : plural}`
}
