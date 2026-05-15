/**
 * v2.1 S5 — Quiet-hours check.
 *
 * FCC Telephone Consumer Protection Act default: no telemarketing calls
 * before 8:00 AM or after 9:00 PM in the called party's **local** time.
 * (47 CFR § 64.1200(c)(1)). State AGs frequently overlay tighter windows;
 * for v2.1 we apply the federal 21:00–08:00 baseline uniformly across the
 * five US states we route to, and surface `state` + `localHour` on the
 * audit row so future state-specific tightening is a table edit, not a
 * code edit.
 *
 * Implementation:
 *  1. Phone → US state via NANPA area code lookup (table below; ≥ 5 states
 *     per S5 charter — CA, NY, TX, IL, FL minimum). Non-NANPA numbers and
 *     unmapped area codes are not blocked (default ALLOW with `state:
 *     "unknown"` or `"non_us"` on the audit row).
 *  2. State → IANA timezone (single-tz states only; multi-tz states like
 *     TN/KY/FL we resolve to the majority-population tz to stay
 *     deterministic without GPS).
 *  3. Compute local hour using `Intl.DateTimeFormat` with the IANA tz so
 *     DST transitions are correct.
 *
 * Limitations (documented for v2.2 follow-up):
 *  - Number-portability ignored — a +1212 phone might physically be in CA.
 *    For v2.1 we accept this drift; carrier-level call-time-zone (CTZ)
 *    lookup is v2.2 work.
 *  - Multi-tz states resolved coarsely.
 */

import type { QuietHoursResult } from "./types.js"

/**
 * NANPA area code → US state code (ISO 3166-2 subset). Only the five states
 * S5 charter requires plus a handful of high-volume neighbors for realistic
 * test coverage. Extending the table is purely additive.
 *
 * Source: NANPA assignments as of 2026-05.
 */
const AREA_CODE_TO_STATE: Record<string, string> = {
  // California (PT)
  "415": "CA", "510": "CA", "650": "CA", "408": "CA", "707": "CA",
  "213": "CA", "310": "CA", "323": "CA", "424": "CA", "562": "CA",
  "619": "CA", "626": "CA", "657": "CA", "661": "CA", "714": "CA",
  "747": "CA", "805": "CA", "818": "CA", "858": "CA", "909": "CA",
  "916": "CA", "925": "CA", "949": "CA",
  // New York (ET)
  "212": "NY", "315": "NY", "332": "NY", "347": "NY", "516": "NY",
  "518": "NY", "585": "NY", "607": "NY", "631": "NY", "646": "NY",
  "680": "NY", "716": "NY", "718": "NY", "838": "NY", "845": "NY",
  "914": "NY", "917": "NY", "929": "NY", "934": "NY",
  // Texas (CT — vast majority; we treat all TX as Central)
  "214": "TX", "254": "TX", "281": "TX", "346": "TX", "409": "TX",
  "430": "TX", "432": "TX", "469": "TX", "512": "TX", "682": "TX",
  "713": "TX", "726": "TX", "737": "TX", "806": "TX", "817": "TX",
  "830": "TX", "832": "TX", "903": "TX", "915": "TX", "936": "TX",
  "940": "TX", "956": "TX", "972": "TX", "979": "TX",
  // Illinois (CT)
  "217": "IL", "224": "IL", "309": "IL", "312": "IL", "331": "IL",
  "618": "IL", "630": "IL", "708": "IL", "773": "IL", "779": "IL",
  "815": "IL", "847": "IL", "872": "IL",
  // Florida (ET — overwhelming majority; FL panhandle CT ignored for v2.1)
  "239": "FL", "305": "FL", "321": "FL", "352": "FL", "386": "FL",
  "407": "FL", "561": "FL", "656": "FL", "689": "FL", "727": "FL",
  "754": "FL", "772": "FL", "786": "FL", "813": "FL", "850": "FL",
  "863": "FL", "904": "FL", "941": "FL", "954": "FL",
}

/** US state → IANA timezone. Single canonical tz per state for v2.1. */
const STATE_TO_TZ: Record<string, string> = {
  CA: "America/Los_Angeles",
  NY: "America/New_York",
  TX: "America/Chicago",
  IL: "America/Chicago",
  FL: "America/New_York",
}

/** Quiet window — block when local hour ∈ [QUIET_START, 23] ∪ [0, QUIET_END). */
const QUIET_START = 21 // 21:00 local
const QUIET_END = 8 // 08:00 local

/**
 * Extracts the 3-digit NPA (area code) from an E.164 US number.
 * Returns empty string if not parseable as a +1NXX...
 */
function extractAreaCode(phoneE164: string): string {
  const trimmed = phoneE164.trim()
  // Expected form: +1NXXNXXXXXX (12 chars). Defensive parse.
  if (!trimmed.startsWith("+1")) return ""
  const digits = trimmed.slice(2).replace(/\D/g, "")
  if (digits.length < 10) return ""
  return digits.slice(0, 3)
}

/**
 * Compute the local hour (0-23) at `nowUtc` in `tz`. Uses Intl so DST is
 * handled correctly across `America/Los_Angeles` etc. Throws on invalid tz
 * (which would be a programming bug — `STATE_TO_TZ` table is closed).
 */
export function localHourIn(nowUtc: Date, tz: string): number {
  const fmt = new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    hour12: false,
    timeZone: tz,
  })
  const parts = fmt.formatToParts(nowUtc)
  const hourPart = parts.find((p) => p.type === "hour")
  if (!hourPart) {
    throw new Error(`localHourIn: failed to extract hour for tz=${tz}`)
  }
  // `hour12: false` with en-US still occasionally renders "24" for midnight;
  // normalize to 0-23.
  const h = parseInt(hourPart.value, 10)
  if (h === 24) return 0
  return h
}

/**
 * Decide whether `localHour` falls in the quiet window. Window wraps midnight:
 * blocked if hour ≥ QUIET_START OR hour < QUIET_END.
 */
function isQuietHour(localHour: number): boolean {
  return localHour >= QUIET_START || localHour < QUIET_END
}

export interface CheckQuietHoursDeps {
  /** Injected clock for deterministic tests. Defaults to `new Date()` if absent. */
  now?: () => Date
}

/**
 * Returns `{ blocked: true, reason: "quiet_hours" }` iff the caller is in a
 * known US state we route to AND the current local hour falls in
 * [QUIET_START, QUIET_END) wrapping midnight. Unknown / non-US numbers
 * default to ALLOW with `state: "unknown" | "non_us"` for audit visibility.
 */
export function checkQuietHours(
  phoneE164: string,
  deps: CheckQuietHoursDeps = {},
): QuietHoursResult {
  const now = (deps.now ?? (() => new Date()))()

  const trimmed = phoneE164.trim()
  if (!trimmed.startsWith("+1")) {
    return { blocked: false, state: "non_us", localHour: -1, tz: "" }
  }

  const npa = extractAreaCode(trimmed)
  const state = AREA_CODE_TO_STATE[npa]
  if (!state) {
    return { blocked: false, state: "unknown", localHour: -1, tz: "" }
  }

  const tz = STATE_TO_TZ[state]
  if (!tz) {
    // Programming error — state mapped but no tz. Fail safe = allow + flag.
    return { blocked: false, state, localHour: -1, tz: "" }
  }

  const localHour = localHourIn(now, tz)
  const blocked = isQuietHour(localHour)
  if (blocked) {
    return { blocked: true, reason: "quiet_hours", state, localHour, tz }
  }
  return { blocked: false, state, localHour, tz }
}
