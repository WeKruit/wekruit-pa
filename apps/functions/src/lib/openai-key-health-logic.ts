/**
 * OpenAI key-resilience — pure decision logic (deliverable #1 core).
 *
 * Incident: .planning/INCIDENT-2026-06-01-openai-rotation-hardening.md
 *
 * On 2026-06-01 OpenAI auto-revoked the org's shared key and the whole
 * platform 401'd with no early warning. This module is the deterministic,
 * fully-unit-testable brain behind the `paOpenAiKeyHealth` scheduled CF:
 *
 *   - `classifyKeyPing`  — maps an OpenAI HTTP status/body → a health verdict
 *     ("ok" | "revoked" | "quota_exhausted" | "rate_limited" | "unknown").
 *     OpenAI facts (2026): revoked = 401 `invalid_api_key`; quota exhausted =
 *     429 `insufficient_quota`; throttle = 429 `rate_limit_exceeded`. Keys have
 *     NO expiry — they live until revoked.
 *   - `decideBudgetAlert` — given month-to-date spend + a configurable monthly
 *     budget, decides whether to fire the ≥80% pre-quota warning.
 *   - `parseCostsResponse` — sums the OpenAI Costs API
 *     `GET /v1/organization/costs` buckets into a USD total (no key dependency;
 *     pure parse).
 *
 * SECURITY: nothing here ever receives, stores, or emits an API key VALUE. The
 * caller passes only HTTP status + a short response snippet. We redact any
 * `sk-...` lookalike defensively before returning a snippet for logs.
 */

// ---------------------------------------------------------------------------
// Key-ping classifier
// ---------------------------------------------------------------------------

export type KeyHealthVerdict =
  | "ok"
  | "revoked"
  | "quota_exhausted"
  | "rate_limited"
  | "unknown"

export interface KeyPingInput {
  /** HTTP status from the health ping (e.g. GET /v1/models). 0 = network error. */
  status: number
  /** Raw response body (JSON or text). Optional; used to disambiguate 429. */
  body?: string
}

export interface KeyPingResult {
  verdict: KeyHealthVerdict
  /** Stable machine code from OpenAI's error body when we could read it. */
  errorCode?: string
  /** Redacted, length-capped snippet safe for logs (never a key value). */
  snippet?: string
}

/** Defensive redaction — collapse any `sk-...` token to an 8-char prefix + ellipsis. */
export function redactSecrets(text: string): string {
  return text.replace(/sk-[A-Za-z0-9_-]{6,}/g, (m) => `${m.slice(0, 11)}…REDACTED`)
}

/** Pull `error.code` out of an OpenAI JSON error body, tolerant of junk. */
export function extractOpenAiErrorCode(body: string | undefined): string | undefined {
  if (!body) return undefined
  try {
    const parsed = JSON.parse(body) as { error?: { code?: unknown; type?: unknown } }
    const code = parsed?.error?.code
    if (typeof code === "string" && code.length > 0) return code
    const type = parsed?.error?.type
    if (typeof type === "string" && type.length > 0) return type
  } catch {
    // Not JSON — fall through to substring sniffing below.
  }
  return undefined
}

/**
 * Classify the result of a cheap health ping against the live key.
 *
 * - 2xx                                  → ok
 * - 401 (invalid_api_key / any 401)      → revoked   (the 2026-06-01 outage)
 * - 429 + insufficient_quota             → quota_exhausted
 * - 429 + rate_limit_exceeded / other    → rate_limited (key still alive)
 * - everything else (incl. 0/5xx)        → unknown (don't page on a blip)
 */
export function classifyKeyPing(input: KeyPingInput): KeyPingResult {
  const { status } = input
  const body = input.body ?? ""
  const code = extractOpenAiErrorCode(body)
  const snippet = body ? redactSecrets(body).slice(0, 300) : undefined

  if (status >= 200 && status < 300) {
    return { verdict: "ok", snippet }
  }

  if (status === 401) {
    // Any 401 means the key won't authenticate → treat as dead/revoked.
    return { verdict: "revoked", errorCode: code ?? "invalid_api_key", snippet }
  }

  if (status === 429) {
    // Disambiguate quota-exhausted (billing) from throttle (transient).
    const lower = `${code ?? ""} ${body}`.toLowerCase()
    if (lower.includes("insufficient_quota")) {
      return { verdict: "quota_exhausted", errorCode: code ?? "insufficient_quota", snippet }
    }
    return { verdict: "rate_limited", errorCode: code ?? "rate_limit_exceeded", snippet }
  }

  return { verdict: "unknown", errorCode: code, snippet }
}

/** Does a verdict warrant paging an operator? (rate_limited / unknown do not.) */
export function isPageableVerdict(verdict: KeyHealthVerdict): boolean {
  return verdict === "revoked" || verdict === "quota_exhausted"
}

// ---------------------------------------------------------------------------
// Budget / Costs-API logic
// ---------------------------------------------------------------------------

/**
 * Default monthly budget (USD) for the ≥80% pre-quota alert. Overridable via
 * `PA_OPENAI_MONTHLY_BUDGET_USD` env / Firestore knob. This is OUR soft ceiling
 * — in 2026 OpenAI's own per-project "monthly budget" is notification-only, so
 * we model the warning ourselves to catch a runaway before the hard credit cap.
 */
export const DEFAULT_MONTHLY_BUDGET_USD = 2000
/** Fraction of budget at which we fire the warning. */
export const DEFAULT_BUDGET_ALERT_FRACTION = 0.8

export interface BudgetAlertInput {
  /** Month-to-date spend in USD (from the Costs API). */
  monthToDateUsd: number
  /** Configured monthly budget in USD. */
  monthlyBudgetUsd: number
  /** Alert threshold as a fraction of budget (default 0.8 = 80%). */
  alertFraction?: number
}

export interface BudgetAlertResult {
  shouldAlert: boolean
  /** monthToDate / budget, clamped to >= 0. */
  fractionUsed: number
  thresholdUsd: number
  /** "ok" | "warning" (≥ threshold, < 100%) | "over" (≥ 100%). */
  severity: "ok" | "warning" | "over"
}

/**
 * Decide whether month-to-date spend has crossed the pre-quota warning line.
 *
 * Pure + deterministic so it's trivially unit-tested. A non-positive or
 * non-finite budget disables the alert (fail-open: never page on a misconfig).
 */
export function decideBudgetAlert(input: BudgetAlertInput): BudgetAlertResult {
  const fraction =
    typeof input.alertFraction === "number" && input.alertFraction > 0
      ? input.alertFraction
      : DEFAULT_BUDGET_ALERT_FRACTION
  const budget = input.monthlyBudgetUsd
  const mtd = Number.isFinite(input.monthToDateUsd) ? Math.max(0, input.monthToDateUsd) : 0

  if (!Number.isFinite(budget) || budget <= 0) {
    return { shouldAlert: false, fractionUsed: 0, thresholdUsd: 0, severity: "ok" }
  }

  const thresholdUsd = budget * fraction
  const fractionUsed = mtd / budget
  const severity: BudgetAlertResult["severity"] =
    mtd >= budget ? "over" : mtd >= thresholdUsd ? "warning" : "ok"

  return {
    shouldAlert: mtd >= thresholdUsd,
    fractionUsed,
    thresholdUsd,
    severity,
  }
}

/**
 * Sum the OpenAI Costs API response into a USD total.
 *
 * Shape (GET /v1/organization/costs): `{ data: [{ results: [{ amount: {
 * value, currency } }] }] }`. We sum every `amount.value` across all buckets.
 * Tolerant of partial/garbage shapes — returns 0 rather than throwing so the
 * CF stays fail-open.
 */
export function parseCostsResponse(json: unknown): number {
  if (!json || typeof json !== "object") return 0
  const data = (json as { data?: unknown }).data
  if (!Array.isArray(data)) return 0
  let total = 0
  for (const bucket of data) {
    const results = (bucket as { results?: unknown })?.results
    if (!Array.isArray(results)) continue
    for (const r of results) {
      const amount = (r as { amount?: { value?: unknown } })?.amount
      const value = amount?.value
      if (typeof value === "number" && Number.isFinite(value)) {
        total += value
      }
    }
  }
  return total
}

// ---------------------------------------------------------------------------
// Dedupe key (one alert per kind per UTC day)
// ---------------------------------------------------------------------------

/** Build the `pa-alerts/{yyyy-mm-dd-<kind>}` dedupe doc id. */
export function alertDedupeId(kind: string, nowMs: number): string {
  const date = new Date(nowMs).toISOString().slice(0, 10) // YYYY-MM-DD (UTC)
  return `${date}-${kind}`
}

// ---------------------------------------------------------------------------
// Drift-audit hash-compare (deliverable #3 core)
// ---------------------------------------------------------------------------
//
// The 2026-06-01 outage's true cause was a PARTIAL rotation: some surfaces got
// the new key, others kept the dead one. This compares every accessible store's
// key sha256 against the canonical (Firebase PA_OPENAI_AGENT_API_KEY) hash and
// flags any divergence — so a half-finished rotation is caught before it pages.
//
// SECURITY: inputs are sha256 hashes + redacted prefixes ONLY. No key value.

export interface KeyStoreHash {
  /** Human label, e.g. "firebase:OPENAI_API_KEY" or "github:wekruit-pa". */
  store: string
  /** sha256 hex of the key value, or null if the store was unreadable. */
  sha256: string | null
  /** Redacted prefix for the report (e.g. "sk-proj-fFdZ…"), never the value. */
  prefix?: string
  /** True when the store could not be read (access denied / offline). */
  unreadable?: boolean
}

export interface DriftRow {
  store: string
  sha256: string | null
  prefix?: string
  /** "match" | "drift" | "unreadable" relative to canonical. */
  status: "match" | "drift" | "unreadable"
}

export interface DriftReport {
  /** sha256 of the canonical store, or null if canonical itself is unreadable. */
  canonicalSha256: string | null
  canonicalStore: string
  rows: DriftRow[]
  /** Any store whose hash differs from canonical (the partial-rotation signal). */
  driftCount: number
  /** Stores that could not be read (informational; not counted as drift). */
  unreadableCount: number
  /** True when there is drift OR canonical is unreadable → caller exits non-zero. */
  hasDrift: boolean
}

/**
 * Compare a set of store hashes against the canonical store.
 *
 * Rules:
 *   - canonical unreadable                       → hasDrift=true (can't trust audit)
 *   - a store unreadable                         → status "unreadable", NOT drift
 *   - a readable store whose hash != canonical   → status "drift"
 *   - a readable store whose hash == canonical   → status "match"
 *
 * The canonical store itself is excluded from `rows` (it's the reference).
 */
export function computeDrift(
  canonicalStore: string,
  hashes: ReadonlyArray<KeyStoreHash>
): DriftReport {
  const canonical = hashes.find((h) => h.store === canonicalStore)
  const canonicalSha256 = canonical && !canonical.unreadable ? canonical.sha256 : null

  const rows: DriftRow[] = []
  let driftCount = 0
  let unreadableCount = 0

  for (const h of hashes) {
    if (h.store === canonicalStore) continue
    if (h.unreadable || h.sha256 === null) {
      unreadableCount++
      rows.push({ store: h.store, sha256: null, prefix: h.prefix, status: "unreadable" })
      continue
    }
    if (canonicalSha256 !== null && h.sha256 === canonicalSha256) {
      rows.push({ store: h.store, sha256: h.sha256, prefix: h.prefix, status: "match" })
    } else {
      driftCount++
      rows.push({ store: h.store, sha256: h.sha256, prefix: h.prefix, status: "drift" })
    }
  }

  const hasDrift = canonicalSha256 === null || driftCount > 0

  return {
    canonicalSha256,
    canonicalStore,
    rows,
    driftCount,
    unreadableCount,
    hasDrift,
  }
}
