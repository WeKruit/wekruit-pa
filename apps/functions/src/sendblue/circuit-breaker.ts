/**
 * Phase 40 productionize — Sendblue REST circuit breaker.
 *
 * Mirror of the llm-rewriter Phase 27 T1 in-process breaker. Same thresholds:
 *   - 5 consecutive 5xx/timeouts → OPEN
 *   - OPEN window 60s; calls short-circuit to fail-fast (caller marks the
 *     pa-outbound row failed → `paSendblueOutbox` releases for retry on the
 *     next mutation, which will hit the breaker again until 60s elapses).
 *   - HALF_OPEN: 1 trial after the window. Success → CLOSED. Fail → re-OPEN.
 *
 * Without this, a Sendblue regional outage causes the outbox CF to spam
 * retries for every outbound row (each one paying 10s timeout). With
 * concurrency=1 + Sendblue API down, the outbox queue grows unbounded
 * because each row fails once, gets re-fired, fails again. Breaker turns
 * a 60s outage into 60s of fail-fast instead of N retries × 10s.
 *
 * Scope: in-process only. Each CF instance has its own state. Acceptable
 * because (a) instances die fast on Cloud Run, (b) cross-instance state
 * sharing would need Firestore which adds latency to every Sendblue call.
 */

const FAILURE_THRESHOLD = 5
const OPEN_DURATION_MS = 60_000

type State = {
  consecutiveFailures: number
  openedAt: number | null
}

const states = new Map<string, State>()

function getState(key: string): State {
  let s = states.get(key)
  if (!s) {
    s = { consecutiveFailures: 0, openedAt: null }
    states.set(key, s)
  }
  return s
}

export type SendblueBreakerStateName = "CLOSED" | "OPEN" | "HALF_OPEN"

export function getSendblueBreakerState(
  key = "sendblue",
  now: number = Date.now()
): SendblueBreakerStateName {
  const s = states.get(key)
  if (!s || s.openedAt == null) return "CLOSED"
  if (now - s.openedAt < OPEN_DURATION_MS) return "OPEN"
  return "HALF_OPEN"
}

export function recordSendblueFailure(key = "sendblue", now: number = Date.now()) {
  const s = getState(key)
  s.consecutiveFailures += 1
  if (s.consecutiveFailures >= FAILURE_THRESHOLD && s.openedAt == null) {
    s.openedAt = now
  }
}

export function recordSendblueSuccess(key = "sendblue") {
  const s = getState(key)
  s.consecutiveFailures = 0
  s.openedAt = null
}

/** Test helper. Resets all breaker state. */
export function __resetSendblueBreakerForTests() {
  states.clear()
}

/**
 * Thrown when the breaker is OPEN — caller maps to a SendblueServerError
 * so the outbox releases the doc for retry. The 60s window expires before
 * Sendblue's own retry cadence makes meaningful progress, so this is the
 * right level to short-circuit.
 */
export class SendblueCircuitOpenError extends Error {
  readonly circuitOpen = true
  constructor(public openedAtMs: number, public now: number = Date.now()) {
    super(
      `Sendblue circuit OPEN (opened ${now - openedAtMs}ms ago, ` +
        `${OPEN_DURATION_MS - (now - openedAtMs)}ms until HALF_OPEN)`
    )
    this.name = "SendblueCircuitOpenError"
  }
}
