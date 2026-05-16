/**
 * v2.1 S5 — TCPA gate orchestrator.
 *
 * Runs the three sub-checks (DNC, quiet hours, consent) in priority order
 * and returns a `GateDecision`. Writes an audit row to
 * `voice-tcpa-checks/{auditId}` for every run regardless of decision —
 * forensic visibility is the whole point of the observed-mode period.
 *
 * Integration point (S3 `handleDialOutbound`):
 *
 *   ```ts
 *   const decision = await runTcpaGate(
 *     { bookingId, paUserId, phoneE164 },
 *     { fs, mode: readGateMode(), now: deps.now },
 *   )
 *   const applied = await applyTcpaGate(decision, bookingRef, { now: deps.now })
 *   if (applied.shouldShortCircuit) {
 *     log("warn", "dialOutbound:tcpa_block", { bookingId, reason: decision.reason })
 *     return {
 *       action: "failed:tcpa_gate",
 *       bookingId,
 *       errorMessage: `tcpa_gate:${decision.reason}`,
 *     }
 *   }
 *   // …continue to sipClient.createSipParticipant
 *   ```
 *
 * Sub-check priority (first-block-wins for `reason`, but all three results
 * are recorded on the audit row):
 *   1. DNC list
 *   2. Quiet hours
 *   3. Consent
 *
 * Lock L4: in `observed` mode the decision is `block_observed` but
 * `applyTcpaGate` will NOT touch the booking row — only logs. In `blocking`
 * mode the decision is `block_enforced` and `applyTcpaGate` flips the
 * booking to `voiceState=failed`.
 */

import type { Firestore } from "firebase-admin/firestore"

import { checkDnc } from "./dncCheck.js"
import { checkQuietHours } from "./quietHours.js"
import { checkConsent } from "./consentCheck.js"
import type {
  BlockReason,
  GateDecision,
  GateMode,
  TcpaAuditRow,
  TcpaGateInput,
} from "./types.js"

export interface RunTcpaGateDeps {
  fs: Firestore
  mode: GateMode
  /** Injected clock for deterministic tests. */
  now?: () => Date
  /** Optional structured log sink. */
  log?: (event: string, payload: Record<string, unknown>) => void
  /**
   * Test seam — override the run-id generator. Production uses
   * `${nowIso}-${random6}` for collision-resistant audit doc ids.
   */
  generateRunId?: () => string
}

function defaultRunId(now: Date): string {
  const iso = now.toISOString()
  const rand = Math.random().toString(36).slice(2, 8)
  return `${iso}-${rand}`
}

/**
 * Run all three sub-checks and produce a `GateDecision`. Always writes an
 * audit row before returning.
 */
export async function runTcpaGate(
  input: TcpaGateInput,
  deps: RunTcpaGateDeps,
): Promise<GateDecision> {
  const nowFn = deps.now ?? (() => new Date())
  const now = nowFn()
  const log = deps.log ?? (() => {})
  const generateRunId = deps.generateRunId ?? (() => defaultRunId(now))

  // Run all three sub-checks. We could short-circuit, but always running
  // all three gives the audit row a complete picture (worth the latency —
  // these are cheap Firestore point reads + an in-process tz lookup).
  const [dnc, consent] = await Promise.all([
    checkDnc(input.phoneE164, { fs: deps.fs }),
    checkConsent(input.paUserId, { fs: deps.fs }),
  ])
  const quietHours = checkQuietHours(input.phoneE164, { now: nowFn })

  // First-block-wins priority: DNC > quiet hours > consent.
  let blockReason: BlockReason | undefined
  if (dnc.blocked) blockReason = dnc.reason
  else if (quietHours.blocked) blockReason = quietHours.reason
  else if (consent.blocked) blockReason = consent.reason

  const details = { dnc, quietHours, consent }

  let decision: GateDecision
  if (!blockReason) {
    decision = {
      decision: "allow",
      mode: deps.mode,
      reason: undefined,
      details,
    }
  } else if (deps.mode === "observed") {
    decision = {
      decision: "block_observed",
      mode: "observed",
      reason: blockReason,
      details,
    }
  } else {
    decision = {
      decision: "block_enforced",
      mode: "blocking",
      reason: blockReason,
      details,
    }
  }

  // Audit write — always, every run, regardless of decision or mode.
  const runId = generateRunId()
  const auditId = `${input.bookingId}_${runId}`
  const auditRow: TcpaAuditRow = {
    bookingId: input.bookingId,
    paUserId: input.paUserId,
    phoneE164: input.phoneE164,
    mode: deps.mode,
    decision: decision.decision,
    reason: blockReason ?? null,
    details,
    checkedAt: now.toISOString(),
    runId,
  }
  try {
    await deps.fs.collection("voice-tcpa-checks").doc(auditId).set(auditRow)
  } catch (err) {
    // Audit-write failure is logged but does NOT mutate the gate decision.
    // We'd rather over-allow with a missing audit row than skip a needed
    // dial because of a Firestore write blip.
    log("voice.tcpa.audit_write_failed", {
      bookingId: input.bookingId,
      auditId,
      error: (err as Error).message ?? String(err),
    })
  }

  log("voice.tcpa.gate_decision", {
    bookingId: input.bookingId,
    paUserId: input.paUserId,
    mode: deps.mode,
    decision: decision.decision,
    reason: blockReason ?? null,
  })

  return decision
}

/* -------------------------------------------------------------------------
 * applyTcpaGate — booking-row side-effect helper.
 * -------------------------------------------------------------------------
 *
 * Pure-ish layer between `runTcpaGate` and S3's `bookingRef.set(...)`. Keeps
 * the gate function single-responsibility (decide + audit) and isolates the
 * booking-state mutation here.
 */

export interface ApplyTcpaGateBookingRef {
  set(
    data: {
      voiceState?: string
      voiceOutcome?: string
      voiceLastError?: string
      voiceEndedAt?: string
    },
    opts?: { merge?: boolean },
  ): Promise<unknown>
}

export interface ApplyTcpaGateDeps {
  /** Injected clock for deterministic tests. */
  now?: () => Date
}

export interface ApplyTcpaGateResult {
  /** Caller (S3 handler) should bail out before SIP dispatch when this is true. */
  shouldShortCircuit: boolean
  /** What the helper wrote to the booking row, if anything. */
  bookingWrite?: {
    voiceState: "failed"
    voiceOutcome: string
    voiceLastError: string
    voiceEndedAt: string
  }
}

/**
 * Translates a `GateDecision` into a booking-row mutation:
 *  - `allow`           → no write, no short-circuit
 *  - `block_observed`  → no write, no short-circuit (caller should still log)
 *  - `block_enforced`  → writes `voiceState=failed` + `voiceOutcome=failed:tcpa_gate:<reason>`,
 *                        returns `shouldShortCircuit=true`
 */
export async function applyTcpaGate(
  decision: GateDecision,
  bookingRef: ApplyTcpaGateBookingRef,
  deps: ApplyTcpaGateDeps = {},
): Promise<ApplyTcpaGateResult> {
  if (decision.decision === "allow" || decision.decision === "block_observed") {
    return { shouldShortCircuit: false }
  }
  // block_enforced
  const now = (deps.now ?? (() => new Date()))()
  const reason = decision.reason
  const bookingWrite = {
    voiceState: "failed" as const,
    voiceOutcome: `failed:tcpa_gate:${reason}`,
    voiceLastError: `tcpa_gate:${reason}`,
    voiceEndedAt: now.toISOString(),
  }
  await bookingRef.set(bookingWrite, { merge: true })
  return { shouldShortCircuit: true, bookingWrite }
}
