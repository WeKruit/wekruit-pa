/**
 * stop-gate.ts — deterministic SMS STOP/START compliance gate (Adam 2026-06-10:
 * "we need to add a 'Stop to stop' for compliance").
 *
 * WHY DETERMINISTIC
 * -----------------
 * Before this gate, opt-out only worked if the LLM volunteered the `privacy` tool
 * (tools/matching-tools.ts), and that tool's runCandidatePrivacyRequest requires a
 * pa-candidate-auth doc — texting-only users don't have one, so a bare "STOP" failed
 * open to "go to the website". Carrier-grade SMS compliance demands a deterministic
 * keyword gate that wins over EVERY other route (agent, onboarding, an ACTIVE
 * prescreen, PII confirm).
 *
 * THE SEAM (documented per the directive)
 * ---------------------------------------
 * Real candidate texts reach the system on exactly TWO turn-driving paths, and BOTH
 * route prescreen/PII/layoff turns BEFORE the thin-Claire cutover (maybeRunThinClaire):
 *
 *   1. Direct broker path — apps/functions/src/index.ts processBrokerImessageEvent:
 *      inbound doc stamped → broker prescreen trigger → runPrescreenTurnIfActive →
 *      layoff → PII confirm → maybeRunThinClaire → legacy orchestrator.
 *   2. Coalesced path — apps/functions/src/coalesce/paMessageCoalescer.ts:
 *      synthetic doc stamped → runPrescreenTurnIfActive → PII confirm →
 *      maybeRunThinClaire → legacy orchestrator.
 *
 * Putting the gate inside cutover.ts would therefore be TOO LATE: a candidate mid-
 * prescreen who texts "STOP" would be consumed by runPrescreenTurnIfActive (whose
 * isUserExitPrescreenReply merely PAUSES the screen — it does not opt out). So the
 * gate is wired at the EARLIEST COMMON SEAM of each path — immediately after the
 * inbound doc is stamped with userId/sessionId/text and BEFORE any prescreen/PII/
 * layoff/agent routing — so STOP wins everywhere, before any LLM call.
 *
 * EXACT-MATCH DISCIPLINE (not classification)
 * -------------------------------------------
 * The keyword test is exact string equality on the WHOLE message (after trim /
 * lowercase / trailing-punctuation strip). "stop sending me internships" is a
 * preference statement and MUST reach the agent (set_matching_preferences), not this
 * gate. This is a structural exact-match set like MEDIA_PLACEHOLDER_BODIES in
 * cutover.ts — NOT text→enum classification, so the no-regex tagging rule is
 * unaffected; deterministic safety keywords are explicitly desired deterministic.
 *
 * BEHAVIOR
 * --------
 *   STOP-class keyword → pa-users.doNotContact=true (+At/+Source), best-effort
 *     stop_outreach privacy request (audit), ONE idempotent confirmation text,
 *     agent does NOT run.
 *   START-class keyword → doNotContact=false (+ResumedAt), ONE confirmation,
 *     agent does NOT run this turn.
 *   While doNotContact===true → every non-START inbound is swallowed silently
 *     (handled, zero sends). Compliance: after STOP, nothing but the START
 *     confirmation may go out.
 *
 * The doNotContact field is already honored by pending-outbound/suppression.ts,
 * outreach/policy.ts, and candidate-lifecycle-trigger.ts (derives opted_out), so
 * this one write suppresses proactive sends fleet-wide.
 */
import type { Firestore } from "firebase-admin/firestore"
import { PA_COLLECTIONS } from "@pa/core-types"
import { createSendblueTransport } from "./transport.js"

/** Carrier-grade opt-out keywords — exact whole-message equality after normalization. */
const STOP_KEYWORDS = new Set([
  "stop",
  "stopall",
  "stop all",
  "unsubscribe",
  "cancel",
  "end",
  "quit",
  "revoke",
  "optout",
  "opt out",
])

/** Opt-back-in keywords — same exact-match discipline. */
const START_KEYWORDS = new Set([
  "start",
  "unstop",
  "optin",
  "opt in",
])

export const STOP_CONFIRMATION_TEXT =
  "You're opted out — Claire won't text you anymore. Reply START anytime if you change your mind."

export const START_CONFIRMATION_TEXT =
  "Welcome back — you'll hear from me again. Want me to pick up where we left off?"

export type OptOutKeywordAction = "opt_out" | "opt_in" | null

/**
 * Classify a whole inbound message as a carrier-grade opt-out / opt-in keyword.
 * Normalization: trim → lowercase → collapse internal whitespace → strip TRAILING
 * punctuation ("Stop." / "STOP!!" qualify). Anything beyond the bare keyword
 * (e.g. "stop sending me internships") returns null — it must reach the agent.
 */
export function classifyOptOutKeyword(text: string): OptOutKeywordAction {
  const normalized = (text || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[\s.!?,;:…。！？]+$/u, "")
  if (!normalized) return null
  if (STOP_KEYWORDS.has(normalized)) return "opt_out"
  if (START_KEYWORDS.has(normalized)) return "opt_in"
  return null
}

export interface StopGateInput {
  eventId: string
  userId: string
  sessionId: string
  toE164: string
  text: string
  inboundMessageHandle?: string
}

export interface StopGateDeps {
  log?: (event: string, payload?: Record<string, unknown>) => void
  now?: () => Date
  /**
   * Test seam — overrides the confirmation sender. Production default builds the
   * SAME Sendblue transport cutover uses (durable pa-outbound row keyed on the
   * inbound eventId + body hash → a webhook retry can never double-send).
   */
  sendConfirmation?: (text: string) => Promise<void>
  /** Test seam — overrides the best-effort stop_outreach privacy-request filing. */
  filePrivacyRequest?: (nowIso: string) => Promise<void>
  /** Forwarded to the default transport (evals must not touch Sendblue). */
  dryRun?: boolean
}

export interface StopGateResult {
  /** True → this turn is fully handled; NO downstream routing (prescreen/PII/agent/legacy) may run. */
  handled: boolean
  action?: "opt_out" | "opt_in" | "suppressed_opted_out"
}

/**
 * Run the deterministic STOP/START gate for one inbound turn. NEVER throws — a
 * keyword turn is always reported handled (even on a partial write failure, the
 * agent must not chat past an opt-out), and the opted-out suppression check fails
 * OPEN on a read error (the rest of the pipeline would fail on the same outage).
 */
export async function runStopGate(
  db: Firestore,
  input: StopGateInput,
  deps: StopGateDeps = {},
): Promise<StopGateResult> {
  const log = deps.log ?? (() => {})
  const action = classifyOptOutKeyword(input.text)
  const nowIso = (deps.now ? deps.now() : new Date()).toISOString()

  const sendConfirmation =
    deps.sendConfirmation ??
    (async (text: string) => {
      const transport = createSendblueTransport({
        db,
        toE164: input.toE164,
        ...(input.inboundMessageHandle ? { inboundMessageHandle: input.inboundMessageHandle } : {}),
        userId: input.userId,
        sessionId: input.sessionId,
        inboundEventId: input.eventId,
        log,
        ...(deps.dryRun ? { dryRun: true } : {}),
      })
      await transport.sendText(text, { seq: 0 })
    })

  if (action === "opt_out") {
    // 1. The compliance-critical write FIRST — suppression.ts / outreach policy /
    //    candidate-lifecycle all key off doNotContact===true. set(merge) not update()
    //    so a thin/provisional profile that races doc creation still records the opt-out.
    let dncWritten = false
    try {
      await db.collection(PA_COLLECTIONS.users).doc(input.userId).set(
        {
          doNotContact: true,
          doNotContactAt: nowIso,
          doNotContactSource: "sms_stop_keyword",
          updatedAt: nowIso,
        },
        { merge: true },
      )
      dncWritten = true
    } catch (err) {
      log("stop_gate.dnc_write_failed", {
        eventId: input.eventId,
        userId: input.userId,
        err: err instanceof Error ? err.message : String(err),
      })
    }

    // 2. Best-effort audit trail — a stop_outreach privacy request (schema permits
    //    sourceSurface "imessage" + requestedBy "candidate"). Schema/index friction
    //    here must NEVER block the doNotContact write above (already committed).
    try {
      const file =
        deps.filePrivacyRequest ??
        (async (createdAt: string) => {
          const [{ writePrivacyRequest }, { PrivacyRequestSchema, createPrivacyRequestId }] =
            await Promise.all([import("@pa/pa-persistence"), import("@pa/core-types")])
          const request = PrivacyRequestSchema.parse({
            requestId: createPrivacyRequestId({
              candidateId: input.userId,
              kind: "stop_outreach",
              createdAt,
            }),
            kind: "stop_outreach",
            candidateId: input.userId,
            sourceSurface: "imessage",
            requestedBy: "candidate",
            detailRedacted: { trigger: "sms_stop_keyword" },
            createdAt,
          })
          await writePrivacyRequest(db, request)
        })
      await file(nowIso)
    } catch (err) {
      log("stop_gate.privacy_request_failed", {
        eventId: input.eventId,
        userId: input.userId,
        err: err instanceof Error ? err.message : String(err),
      })
    }

    // 3. Exactly ONE confirmation (idempotency key = eventId + body hash via the
    //    transport, so a webhook/CF retry of the SAME event dedups). Skipped if the
    //    opt-out write failed — we must not claim an opt-out we didn't record (the
    //    retry will land both).
    if (dncWritten) {
      try {
        await sendConfirmation(STOP_CONFIRMATION_TEXT)
      } catch (err) {
        log("stop_gate.confirmation_failed", {
          eventId: input.eventId,
          err: err instanceof Error ? err.message : String(err),
        })
      }
    }
    log("stop_gate.opted_out", { eventId: input.eventId, userId: input.userId, dncWritten })
    return { handled: true, action: "opt_out" }
  }

  if (action === "opt_in") {
    let resumed = false
    try {
      await db.collection(PA_COLLECTIONS.users).doc(input.userId).set(
        {
          doNotContact: false,
          doNotContactResumedAt: nowIso,
          updatedAt: nowIso,
        },
        { merge: true },
      )
      resumed = true
    } catch (err) {
      log("stop_gate.resume_write_failed", {
        eventId: input.eventId,
        userId: input.userId,
        err: err instanceof Error ? err.message : String(err),
      })
    }
    if (resumed) {
      try {
        await sendConfirmation(START_CONFIRMATION_TEXT)
      } catch (err) {
        log("stop_gate.confirmation_failed", {
          eventId: input.eventId,
          err: err instanceof Error ? err.message : String(err),
        })
      }
    }
    log("stop_gate.opted_in", { eventId: input.eventId, userId: input.userId, resumed })
    return { handled: true, action: "opt_in" }
  }

  // Non-keyword turn: while opted out, swallow EVERYTHING except START (handled, zero
  // sends) — compliance forbids any reply after STOP. Fail-open on a read error.
  try {
    const snap = await db.collection(PA_COLLECTIONS.users).doc(input.userId).get()
    const data = (snap.exists ? snap.data() : undefined) as { doNotContact?: unknown } | undefined
    if (data?.doNotContact === true) {
      log("stop_gate.suppressed_opted_out", { eventId: input.eventId, userId: input.userId })
      return { handled: true, action: "suppressed_opted_out" }
    }
  } catch (err) {
    log("stop_gate.suppression_read_failed", {
      eventId: input.eventId,
      userId: input.userId,
      err: err instanceof Error ? err.message : String(err),
    })
  }
  return { handled: false }
}
