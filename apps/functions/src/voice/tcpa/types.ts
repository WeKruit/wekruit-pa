/**
 * v2.1 S5 — TCPA gate type contracts.
 *
 * Lock L4: TCPA is a **prod** gate. In dev mode (`PA_TCPA_GATE_ENFORCED=false`)
 * blocks become observed-only (logged but allowed). Default for unset env =
 * observed, so dev/staging deploys are safe without setting the flag.
 *
 * Three sub-checks compose the gate:
 *   1. DNC list   (Firestore `voice-dnc/{phoneE164}` document presence)
 *   2. Quiet hours (state-aware, FCC 21:00–08:00 local default)
 *   3. Consent    (`pa-users/{uid}.consent.voiceRecording` boolean + `voiceRecordingConsentAt` timestamp)
 *
 * Sub-check order = priority. First-block-wins; reason of the first blocker
 * is what's returned. All three results are still surfaced on the audit row
 * for forensics.
 */

/**
 * Run mode for the TCPA gate.
 *
 *  - `observed`  — every block is logged but dial is still allowed (dev / staging)
 *  - `blocking`  — blocks are enforced; booking row flips to failed
 */
export type GateMode = "observed" | "blocking"

/**
 * Block reason codes — closed set. Audit consumers MUST switch on these
 * literals, no free-form strings.
 */
export type BlockReason =
  | "dnc_listed"
  | "quiet_hours"
  | "consent_missing"
  | "consent_denied"
  | "user_not_found"
  | "phone_invalid"

/**
 * Top-level gate decision. Three states; the audit row records all three
 * sub-check raw results regardless of decision.
 */
export type GateDecision =
  | { decision: "allow"; mode: GateMode; reason: undefined; details: SubCheckResults }
  | { decision: "block_observed"; mode: "observed"; reason: BlockReason; details: SubCheckResults }
  | { decision: "block_enforced"; mode: "blocking"; reason: BlockReason; details: SubCheckResults }

/**
 * Per-sub-check raw result. All three always populated on the audit row so
 * we never lose the forensic chain even when first-block-wins short-circuits.
 */
export interface SubCheckResults {
  dnc: DncResult
  quietHours: QuietHoursResult
  consent: ConsentResult
}

export interface DncResult {
  blocked: boolean
  /** Closed set: `"dnc_listed"` when blocked, otherwise omitted. */
  reason?: Extract<BlockReason, "dnc_listed">
  /** Echoed normalized phone E.164 for forensics. */
  phoneE164: string
}

export interface QuietHoursResult {
  blocked: boolean
  reason?: Extract<BlockReason, "quiet_hours">
  /** US state inferred from area code, or `"unknown"` / `"non_us"`. */
  state: string
  /** Computed local hour (0-23) at the time of check. -1 if state unknown. */
  localHour: number
  /** Local timezone IANA id used (e.g. `"America/Los_Angeles"`). Empty if non-US/unknown. */
  tz: string
}

export interface ConsentResult {
  blocked: boolean
  reason?: Extract<BlockReason, "consent_missing" | "consent_denied" | "user_not_found">
  /** ISO timestamp from `voiceRecordingConsentAt`, or empty if absent. */
  consentedAt: string
}

/**
 * Input to `runTcpaGate`. Caller (S3 `handleDialOutbound`) supplies what's
 * already validated on the booking row.
 */
export interface TcpaGateInput {
  bookingId: string
  paUserId: string
  phoneE164: string
}

/**
 * Audit row written to `voice-tcpa-checks/{bookingId}_{runId}`. Stable shape
 * so the operator dashboard (v2.2) can render it.
 */
export interface TcpaAuditRow {
  bookingId: string
  paUserId: string
  phoneE164: string
  mode: GateMode
  decision: GateDecision["decision"]
  reason: BlockReason | null
  details: SubCheckResults
  checkedAt: string
  /** Monotonic-ish run id (e.g. ISO timestamp + 6 random chars) for uniqueness. */
  runId: string
}
