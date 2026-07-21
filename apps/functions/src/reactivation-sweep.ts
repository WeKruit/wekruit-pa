/**
 * paReactivationSweepDaily — re-check dormant candidates (Adam 2026-06-23).
 *
 * "for anyone that has more than 20 days not responding to our message.. we can
 * check again if they are still finding jobs, we record the last active."
 *
 * A candidate who went quiet for >20 days (since their LAST INBOUND to us) gets
 * ONE warm "still job-searching?" re-check; if they stay silent we re-ping every
 * ~30 days (Adam: repeat cadence). Accepting it ("yes") flows through the normal
 * thin-Claire path → find_match.
 *
 * SAFETY (LOCKED outbound rules):
 *   - INBOUND-FIRST: only candidates who have EVER sent us inbound (lastInboundAt
 *     present) are eligible — never cold-opens a never-inbound handle.
 *   - doNotContact / opted_out are hard-excluded.
 *   - Flag-gated: `reactivationSweepEnabled` (default OFF) — does nothing until
 *     Adam flips it. Env kill switch `PA_REACTIVATION_SWEEP_DISABLED=1`.
 *   - CANARY-FIRST: only dev phones until `PA_REACTIVATION_RAMP_ALL=1`.
 *
 * lastInboundAt is recorded on every inbound (index.ts processBrokerImessageEvent).
 * For users created before that field existed, we lazily derive it from the most
 * recent role:user pa-messages row (bounded — canary is a tiny set).
 */
import { onSchedule } from "firebase-functions/v2/scheduler"
import { logger } from "firebase-functions/v2"
import { getFirestore, type Firestore } from "firebase-admin/firestore"
import { getFlag } from "@pa/pa-persistence"
import { sendRuntimeApprovedIMessage } from "./runtime-approved-outbox.js"
import { CLAIRE_VOICE_DEV_PHONES } from "./voice/dev-phone-gate.js"

export const REACTIVATION_FLAG_KEY = "reactivationSweepEnabled"
export const REACTIVATION_INACTIVE_DAYS = 20
export const REACTIVATION_REPEAT_DAYS = 30
const DAY_MS = 24 * 60 * 60 * 1000
const SWEEP_USER_CAP = 200

export const REACTIVATION_COPY =
  "hey — it's Claire from WeKruit. it's been a little while! are you still job-searching? reply yes and i'll pull a few fresh matches for you. (reply STOP to opt out anytime.)"

export type ReactivationUser = {
  lastInboundAt?: unknown
  lastReactivationPingAt?: unknown
  lastReactivationPingCount?: unknown
  doNotContact?: unknown
  outreach?: { status?: unknown }
  phoneE164?: unknown
}

/**
 * Pure eligibility check (no IO) — testable. A candidate is eligible when:
 * reachable + opted-in, has previously inbounded (inbound-first), has been quiet
 * for ≥20 days since that last inbound, and hasn't been re-pinged within 30 days.
 */
export function isEligibleForReactivation(
  u: ReactivationUser,
  nowMs: number,
): { eligible: boolean; reason: string } {
  if (u.doNotContact === true) return { eligible: false, reason: "do_not_contact" }
  if (u.outreach && (u.outreach as { status?: unknown }).status === "opted_out") {
    return { eligible: false, reason: "opted_out" }
  }
  const phone = typeof u.phoneE164 === "string" ? u.phoneE164.trim() : ""
  if (!phone) return { eligible: false, reason: "no_phone" }
  const lastIn = typeof u.lastInboundAt === "string" ? Date.parse(u.lastInboundAt) : NaN
  if (!Number.isFinite(lastIn)) return { eligible: false, reason: "never_inbound" }
  if (nowMs - lastIn < REACTIVATION_INACTIVE_DAYS * DAY_MS) {
    return { eligible: false, reason: "recently_active" }
  }
  const lastPing = typeof u.lastReactivationPingAt === "string" ? Date.parse(u.lastReactivationPingAt) : NaN
  if (Number.isFinite(lastPing) && nowMs - lastPing < REACTIVATION_REPEAT_DAYS * DAY_MS) {
    return { eligible: false, reason: "pinged_recently" }
  }
  return { eligible: true, reason: "eligible" }
}

/** Lazy fallback for users created before lastInboundAt existed: latest role:user message. */
async function deriveLastInboundFromMessages(db: Firestore, userId: string): Promise<string | null> {
  try {
    const snap = await db.collection("pa-messages").where("userId", "==", userId).limit(60).get()
    let latest = ""
    for (const d of snap.docs) {
      const x = d.data() as { role?: unknown; createdAt?: unknown }
      if (x.role === "user" && typeof x.createdAt === "string" && x.createdAt > latest) latest = x.createdAt
    }
    return latest || null
  } catch {
    return null
  }
}

/** Core sweep — exported for tests (inject db + now). */
export async function runReactivationSweep(args: {
  db: Firestore
  nowMs: number
  rampAll: boolean
  send?: typeof sendRuntimeApprovedIMessage
  log?: (event: string, payload: Record<string, unknown>) => void
}): Promise<{ scanned: number; sent: number; skipped: number }> {
  const { db, nowMs, rampAll } = args
  const send = args.send ?? sendRuntimeApprovedIMessage
  const log = args.log ?? (() => {})
  const nowIso = new Date(nowMs).toISOString()

  const users: Array<{ id: string; data: ReactivationUser }> = []
  if (!rampAll) {
    // CANARY: only dev phones.
    for (const phone of CLAIRE_VOICE_DEV_PHONES) {
      const q = await db.collection("pa-users").where("phoneE164", "==", phone).limit(1).get()
      q.docs.forEach((d) => users.push({ id: d.id, data: d.data() as ReactivationUser }))
    }
  } else {
    const q = await db.collection("pa-users").where("source", "==", "candidate").limit(SWEEP_USER_CAP).get()
    q.docs.forEach((d) => users.push({ id: d.id, data: d.data() as ReactivationUser }))
  }

  let sent = 0
  let skipped = 0
  for (const u of users) {
    let data = u.data
    if (typeof data.lastInboundAt !== "string") {
      const derived = await deriveLastInboundFromMessages(db, u.id)
      if (derived) data = { ...data, lastInboundAt: derived }
    }
    const { eligible, reason } = isEligibleForReactivation(data, nowMs)
    if (!eligible) {
      skipped++
      log("reactivation.skip", { userId: u.id, reason })
      continue
    }
    try {
      await send({
        db,
        userId: u.id,
        to: String(data.phoneE164),
        content: REACTIVATION_COPY,
        runtimeSource: "pa_orchestrator",
        // one ping per user per day max (idempotent); the 30-day cadence is enforced by eligibility.
        idempotencyKey: `reactivation:${u.id}:${nowIso.slice(0, 10)}`,
      })
      const priorCount = typeof data.lastReactivationPingCount === "number" ? data.lastReactivationPingCount : 0
      await db.collection("pa-users").doc(u.id).set(
        { lastReactivationPingAt: nowIso, lastReactivationPingCount: priorCount + 1, updatedAt: nowIso },
        { merge: true },
      )
      sent++
      log("reactivation.sent", { userId: u.id, pingCount: priorCount + 1 })
    } catch (err) {
      log("reactivation.send_failed", { userId: u.id, error: err instanceof Error ? err.message : String(err) })
    }
  }
  log("reactivation.sweep_complete", { rampAll, scanned: users.length, sent, skipped })
  return { scanned: users.length, sent, skipped }
}

export const paReactivationSweepDaily = onSchedule(
  {
    region: "us-central1",
    schedule: "every day 17:00",
    timeZone: "America/Los_Angeles",
    memory: "512MiB",
    timeoutSeconds: 300,
    retryCount: 0,
  },
  async () => {
    const db = getFirestore()
    if (process.env.PA_REACTIVATION_SWEEP_DISABLED === "1") {
      logger.info("[reactivation] disabled by env kill-switch")
      return
    }
    const enabled = await getFlag(db, REACTIVATION_FLAG_KEY, { env: process.env }, false)
    if (!enabled) {
      logger.info("[reactivation] flag off — no-op (flip reactivationSweepEnabled to enable)")
      return
    }
    const rampAll = process.env.PA_REACTIVATION_RAMP_ALL === "1"
    try {
      const outcome = await runReactivationSweep({
        db,
        nowMs: Date.now(),
        rampAll,
        log: (event, payload) => logger.info(`[reactivation] ${event}`, payload ?? {}),
      })
      logger.info("[reactivation] done", outcome)
    } catch (err) {
      logger.error("[reactivation] sweep_error", { error: err instanceof Error ? err.message : String(err) })
    }
  },
)
