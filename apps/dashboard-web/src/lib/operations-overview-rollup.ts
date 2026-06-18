/**
 * Pure wire types + client-side daily→period rollup for the Operations
 * Overview page. NO firebase import here so it stays unit-testable under
 * node/tsx (the api wrapper that needs `functions()` lives in
 * operations-overview-api.ts and re-exports this module).
 *
 * Wire types mirror the `paAdminOpsMetrics` CF result
 * (apps/functions/src/admin-ops-metrics.ts) — keep in sync.
 */

export interface OpsMetricsDayBucket {
  date: string
  newUsersTotal: number
  newUsersAuthenticated: number
  newUsersRecruiterSubmitted: number
  newUsersDirect: number
  interviewsConducted: number
  movedToClient: number
}

export interface OpsMetricsTotals {
  newUsersTotal: number
  newUsersAuthenticated: number
  newUsersRecruiterSubmitted: number
  newUsersDirect: number
  interviewsConducted: number
  movedToClient: number
}

export interface AdminOpsMetricsResult {
  rangeStart: string
  rangeEnd: string
  rangeDays: number
  generatedAt: string
  includeTest: boolean
  days: OpsMetricsDayBucket[]
  totals: OpsMetricsTotals
  truncated: {
    users: boolean
    auth: boolean
    recruiterSubmissions: boolean
    prescreenSessions: boolean
    candidateJobStates: boolean
  }
}

export interface AdminOpsMetricsInput {
  rangeDays?: number
  includeTest?: boolean
}

export type Granularity = "daily" | "weekly" | "biweekly" | "monthly"

export const GRANULARITY_OPTIONS: { value: Granularity; label: string }[] = [
  { value: "daily", label: "Daily" },
  { value: "weekly", label: "Weekly" },
  { value: "biweekly", label: "Biweekly" },
  { value: "monthly", label: "Monthly" },
]

export const RANGE_OPTIONS: { value: number; label: string }[] = [
  { value: 30, label: "30 days" },
  { value: 90, label: "90 days" },
  { value: 180, label: "180 days" },
  { value: 365, label: "1 year" },
]

export interface RolledBucket extends OpsMetricsTotals {
  /** Bucket start date `YYYY-MM-DD`. */
  key: string
  /** Human label for the axis, e.g. "Jun 9" or "Jun 9–15" or "Jun 2026". */
  label: string
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

function parseUtc(dateKey: string): Date {
  return new Date(`${dateKey}T00:00:00.000Z`)
}

function shortLabel(dateKey: string): string {
  const d = parseUtc(dateKey)
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`
}

function emptyTotals(): OpsMetricsTotals {
  return {
    newUsersTotal: 0,
    newUsersAuthenticated: 0,
    newUsersRecruiterSubmitted: 0,
    newUsersDirect: 0,
    interviewsConducted: 0,
    movedToClient: 0,
  }
}

function addInto(acc: OpsMetricsTotals, day: OpsMetricsDayBucket): void {
  acc.newUsersTotal += day.newUsersTotal
  acc.newUsersAuthenticated += day.newUsersAuthenticated
  acc.newUsersRecruiterSubmitted += day.newUsersRecruiterSubmitted
  acc.newUsersDirect += day.newUsersDirect
  acc.interviewsConducted += day.interviewsConducted
  acc.movedToClient += day.movedToClient
}

function stripDate(d: OpsMetricsDayBucket): OpsMetricsTotals {
  return {
    newUsersTotal: d.newUsersTotal,
    newUsersAuthenticated: d.newUsersAuthenticated,
    newUsersRecruiterSubmitted: d.newUsersRecruiterSubmitted,
    newUsersDirect: d.newUsersDirect,
    interviewsConducted: d.interviewsConducted,
    movedToClient: d.movedToClient,
  }
}

/**
 * Roll the daily series into the requested granularity. New-user days are
 * mutually exclusive per person, so summing across days stays a correct
 * distinct count. Weekly/biweekly buckets anchor on the FIRST day of the
 * series so the most recent (partial) bucket is on the right edge.
 */
export function rollup(days: OpsMetricsDayBucket[], granularity: Granularity): RolledBucket[] {
  if (days.length === 0) return []
  if (granularity === "daily") {
    return days.map((d) => ({ key: d.date, label: shortLabel(d.date), ...stripDate(d) }))
  }

  if (granularity === "monthly") {
    const buckets: RolledBucket[] = []
    const byMonth = new Map<string, { totals: OpsMetricsTotals; firstKey: string }>()
    for (const d of days) {
      const monthKey = d.date.slice(0, 7) // YYYY-MM
      let entry = byMonth.get(monthKey)
      if (!entry) {
        entry = { totals: emptyTotals(), firstKey: d.date }
        byMonth.set(monthKey, entry)
      }
      addInto(entry.totals, d)
    }
    for (const [monthKey, entry] of byMonth) {
      const dt = parseUtc(`${monthKey}-01`)
      buckets.push({ key: entry.firstKey, label: `${MONTHS[dt.getUTCMonth()]} ${dt.getUTCFullYear()}`, ...entry.totals })
    }
    return buckets
  }

  // weekly / biweekly — fixed-size windows anchored on the series start.
  const span = granularity === "weekly" ? 7 : 14
  const buckets: RolledBucket[] = []
  for (let i = 0; i < days.length; i += span) {
    const slice = days.slice(i, i + span)
    const totals = emptyTotals()
    for (const d of slice) addInto(totals, d)
    const startKey = slice[0]!.date
    const endKey = slice[slice.length - 1]!.date
    const label = slice.length > 1 ? `${shortLabel(startKey)}–${shortLabel(endKey)}` : shortLabel(startKey)
    buckets.push({ key: startKey, label, ...totals })
  }
  return buckets
}
