/**
 * Per-number rolling SEND cap — protects each Sendblue line from exceeding its
 * daily message limit (Adam 2026-06-15: "the 800 cap, that's for sending the
 * message ... rolled to the seconds and we need to leave buffer").
 *
 * Distinct from ASSIGNMENT routing (who binds to which number). This governs SEND
 * VOLUME: count messages a number sent in a rolling window (real `sentAt`
 * timestamps — second-precise), and stop at (dailySendCap − buffer) so a burst or
 * in-flight sends never push past the hard carrier limit.
 *
 * Enforced at the single send choke point (outbox.ts), flag-gated + fail-open.
 */
import type { Firestore } from "firebase-admin/firestore"
import type { SendbluePoolNumber } from "./pool.js"

/** Default safety buffer subtracted from the hard cap. */
export const DEFAULT_SEND_CAP_BUFFER = 50
/** Default rolling window for the cap. */
export const DEFAULT_SEND_CAP_WINDOW_HOURS = 24

type SendCapConfig = Pick<
  SendbluePoolNumber,
  "dailySendCap" | "sendCapBuffer" | "sendCapWindowHours"
>

/**
 * The hard per-number daily send cap. Reads ONLY `dailySendCap` (a dedicated,
 * opt-in field) — NOT the `capacity` field, which the S6 send selector / job-rec
 * batch use for a different purpose. null = unconfigured → no enforcement.
 */
export function resolveHardSendCap(n: SendCapConfig): number | null {
  const cap = n.dailySendCap
  return Number.isInteger(cap) && cap !== undefined && cap > 0 ? cap : null
}

/** Effective cap = hard cap − safety buffer. null = unconfigured (do not enforce). */
export function effectiveSendCap(n: SendCapConfig): number | null {
  const hard = resolveHardSendCap(n)
  if (hard === null) return null
  const buffer =
    Number.isInteger(n.sendCapBuffer) && (n.sendCapBuffer ?? -1) >= 0
      ? (n.sendCapBuffer as number)
      : DEFAULT_SEND_CAP_BUFFER
  return Math.max(0, hard - buffer)
}

/** Rolling-window length in ms. */
export function sendCapWindowMs(n: SendCapConfig): number {
  const h =
    Number.isInteger(n.sendCapWindowHours) && (n.sendCapWindowHours ?? 0) > 0
      ? (n.sendCapWindowHours as number)
      : DEFAULT_SEND_CAP_WINDOW_HOURS
  return h * 60 * 60 * 1000
}

/** ISO cutoff for the rolling window, given "now". */
export function sendCapWindowCutoffIso(n: SendCapConfig, nowMs: number): string {
  return new Date(nowMs - sendCapWindowMs(n)).toISOString()
}

/**
 * Count messages SENT from a number within the rolling window. Uses the
 * denormalized `sentFromNumber` + `sentAt` recorded by the outbox at send time
 * (second-precise). Needs the (sentFromNumber, sentAt) composite index.
 */
export async function countRecentSendsForNumber(
  db: Firestore,
  number: string,
  sinceIso: string,
): Promise<number> {
  const snap = await db
    .collection("pa-outbound")
    .where("sentFromNumber", "==", number)
    .where("sentAt", ">=", sinceIso)
    .count()
    .get()
  return snap.data().count
}
