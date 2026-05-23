/**
 * Phase EX1 PR-A — work-entry duration arithmetic.
 *
 * Pulled into its own module so `derive.ts` and `extract.ts` can share
 * the math without circular imports, and so the rules are unit-testable
 * in isolation.
 */

/**
 * Returns whole months between start and end. Null endDate is treated
 * as "current role" and uses `now`. Null startDate yields 0.
 *
 * Defensive: returns 0 (not negative or NaN) when dates parse poorly
 * or end < start. Production data has plenty of "2023" vs "Jan 2023"
 * level inconsistency; we want a stable lower bound rather than an
 * exception.
 */
export function durationMonths(
  startDate: string | null,
  endDate: string | null,
  now: Date = new Date()
): number {
  if (!startDate) return 0
  const start = parseLooseDate(startDate)
  if (!start) return 0
  const end = endDate ? parseLooseDate(endDate) ?? now : now
  if (end < start) return 0
  const years = end.getUTCFullYear() - start.getUTCFullYear()
  const months = end.getUTCMonth() - start.getUTCMonth()
  return Math.max(0, years * 12 + months)
}

/**
 * Parses common resume-date shapes into a Date pinned to day 1 of the
 * month. Returns null on failure.
 *
 * Accepted shapes:
 *   "2024-05-15", "2024-05", "2024", "May 2024", "5/2024"
 */
export function parseLooseDate(raw: string): Date | null {
  const trimmed = raw.trim()
  if (!trimmed) return null

  // ISO yyyy-mm-dd or yyyy-mm
  let m = /^(\d{4})-(\d{1,2})(?:-\d{1,2})?$/.exec(trimmed)
  if (m) {
    const year = Number(m[1])
    const month = Number(m[2]) - 1
    if (Number.isFinite(year) && month >= 0 && month <= 11) {
      return new Date(Date.UTC(year, month, 1))
    }
  }

  // Bare year "2024"
  m = /^(\d{4})$/.exec(trimmed)
  if (m) return new Date(Date.UTC(Number(m[1]), 0, 1))

  // "Mon yyyy" or "Month yyyy"
  m = /^([A-Za-z]+)\s+(\d{4})$/.exec(trimmed)
  if (m) {
    const monthIdx = MONTH_INDEX[m[1]!.toLowerCase().slice(0, 3)]
    if (monthIdx != null) return new Date(Date.UTC(Number(m[2]), monthIdx, 1))
  }

  // "m/yyyy" or "mm/yyyy"
  m = /^(\d{1,2})\/(\d{4})$/.exec(trimmed)
  if (m) {
    const month = Number(m[1]) - 1
    if (month >= 0 && month <= 11) {
      return new Date(Date.UTC(Number(m[2]), month, 1))
    }
  }

  return null
}

const MONTH_INDEX: Record<string, number> = {
  jan: 0,
  feb: 1,
  mar: 2,
  apr: 3,
  may: 4,
  jun: 5,
  jul: 6,
  aug: 7,
  sep: 8,
  oct: 9,
  nov: 10,
  dec: 11,
}
