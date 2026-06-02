/**
 * transport.ts — WS-delivery owns this file.
 *
 * Production `ClaireTransport` backed by Sendblue + pa-outbound:
 *   markRead   → sendTypingIndicator (Sendblue has NO read-receipt endpoint;
 *                immediate typing is the read signal — AGENTIC-ARCHITECTURE §7)
 *   typing     → sendTypingIndicator
 *   sendStatus → sendImessage (a quick one-line bubble, immediate; no durable row)
 *   sendText   → enqueueOutbound → pa-outbound (idempotent, runtime-approved, the
 *                durable approved outbound path the orchestrator uses today; the
 *                paSendblueOutbox CF consumes the row, fires its own typing dwell,
 *                appends transcript, and POSTs Sendblue with retries)
 *   tapback    → sendReaction(messageHandle)  (no-op + log when no handle)
 *   noReply    → audit log only (no outbound)
 *
 * Two send shapes by design:
 *   - sendText is the user-facing REPLY → durable + idempotent + retried via the
 *     pa-outbound outbox. This is the same seam the legacy orchestrator writes to,
 *     so quota, transcript, pool-routing, and dead-lettering are reused for free.
 *   - sendStatus is a transient "one sec" bubble → immediate sendImessage. It is
 *     ephemeral UX; durability/retry would only deliver a stale status late, so we
 *     fire it directly (best-effort) rather than queuing it.
 *
 * Every method is FAIL-OPEN: it swallows its own errors (logs them) and never
 * throws into the agent run loop. A delivery hiccup must not abort the turn.
 *
 * `dryRun`: when true, every method ONLY records intent into `recordedEvents`
 * (no Sendblue, no pa-outbound). Tests/evals read that ledger.
 */
import { createHash } from "node:crypto"
import type { Firestore } from "firebase-admin/firestore"
import type { ClaireReaction, ClaireTransport } from "./types.js"
import { sendImessage as defaultSendImessage } from "../sendblue/sendblue-client.js"
import { sendTypingIndicator as defaultSendTypingIndicator } from "../sendblue/typing-indicator.js"
import { sendReadReceipt as defaultSendReadReceipt } from "../sendblue/read-receipt.js"
import { sendReaction as defaultSendReaction } from "../sendblue/send-reaction.js"
import { enqueueOutbound as defaultEnqueueOutbound } from "@pa/pa-broker"

/** Kinds recorded by the dry-run ledger (mirror the POC fake-channel kinds). */
export type TransportEventKind =
  | "mark_read"
  | "typing"
  | "status"
  | "text"
  | "tapback"
  | "no_reply"

export interface TransportEvent {
  kind: TransportEventKind
  value?: string
}

export interface SendblueTransportDeps {
  db: Firestore
  toE164: string
  /** Sendblue handle of the inbound message (for tapback). */
  inboundMessageHandle?: string
  userId: string
  sessionId: string
  /** inbound event id, for outbound correlation + idempotency dedup. */
  inboundEventId?: string
  log?: (event: string, payload?: Record<string, unknown>) => void
  /**
   * When true, no real Sendblue/pa-outbound calls — every method only records
   * intent into the returned `recordedEvents` array. Used by tests/evals.
   */
  dryRun?: boolean
  /** Test seams (default to the real Sendblue/pa-broker fns in production). */
  sendImessage?: typeof defaultSendImessage
  sendTypingIndicator?: typeof defaultSendTypingIndicator
  sendReadReceipt?: typeof defaultSendReadReceipt
  sendReaction?: typeof defaultSendReaction
  enqueueOutbound?: typeof defaultEnqueueOutbound
}

export interface SendblueTransport extends ClaireTransport {
  /** Intent ledger — populated only in dryRun mode (empty otherwise). */
  readonly recordedEvents: TransportEvent[]
}

const noopLog = (_event: string, _payload?: Record<string, unknown>): void => {}

/**
 * Stable, idempotent outbound key for one Claire text reply on this turn.
 *
 * Key = `<turn-scope>:<body-hash>`. The turn scope is the inbound event id when the cutover
 * supplies it — UNIQUE per inbound, so a webhook RETRY of the SAME event re-keys identically
 * (dedups a true double-send) while a DIFFERENT inbound always re-keys (always sends).
 *
 * The body hash is ALWAYS folded in — even with an event id — so a multi-bubble turn (two
 * sendText calls with different prose) does not self-dedup to a single bubble.
 *
 * The previous key fell back to `sessionId` ALONE when no event id was passed (the prod path —
 * cutover never set inboundEventId). The sessionId is stable per user and the onboarding question
 * bodies are deterministic, so a re-kickoff composed an identical body → identical key →
 * ALREADY_EXISTS against an earlier `sent` row → the reply was silently dropped (the 2026-05-29
 * dev-phone silent-kickoff: reinit cleared pa-messages/pa-sessions but NOT pa-outbound, so the
 * stale sent rows kept blocking every re-send). Keying on the inbound event id kills that.
 */
function textIdempotencyKey(deps: SendblueTransportDeps, body: string): string {
  const scope = deps.inboundEventId?.trim() || deps.sessionId
  const bodyHash = createHash("sha256").update(body, "utf8").digest("hex").slice(0, 16)
  return `claire-reply-${scope}:${bodyHash}`
}

export function createSendblueTransport(
  deps: SendblueTransportDeps,
): SendblueTransport {
  const log = deps.log ?? noopLog
  const recordedEvents: TransportEvent[] = []
  const dryRun = deps.dryRun === true
  const sendImessage = deps.sendImessage ?? defaultSendImessage
  const sendTypingIndicator = deps.sendTypingIndicator ?? defaultSendTypingIndicator
  const sendReadReceipt = deps.sendReadReceipt ?? defaultSendReadReceipt
  const sendReaction = deps.sendReaction ?? defaultSendReaction
  const enqueueOutbound = deps.enqueueOutbound ?? defaultEnqueueOutbound

  const record = (kind: TransportEventKind, value?: string): void => {
    recordedEvents.push(value === undefined ? { kind } : { kind, value })
  }

  // Resolve the conversation's BOUND Sendblue line ONCE per turn (memoized). Both the read
  // receipt AND the typing indicator must come FROM this line or Sendblue can't match the
  // thread → no "Read", no typing bubble. We go through `resolveBoundFromNumber` (the single
  // source of truth) so typing/read-receipt land on the SAME line as the durable reply
  // (outbox.ts also honors the binding) instead of a hash that reshuffles when the pool grows.
  // `undefined` (no pool / resolve error / no eligible line) lets the Sendblue clients fall
  // back to creds.fromNumber — no regression on single-number accounts.
  let fromNumberCache: string | undefined | "unresolved" = "unresolved"
  const resolveFromNumber = async (): Promise<string | undefined> => {
    if (fromNumberCache !== "unresolved") return fromNumberCache
    try {
      const { resolveBoundFromNumber } = await import("../sendblue/resolve-bound-from-number.js")
      const bound = await resolveBoundFromNumber(deps.db, deps.userId)
      fromNumberCache = bound.fromNumber ?? undefined
    } catch {
      fromNumberCache = undefined
    }
    return fromNumberCache
  }

  return {
    recordedEvents,

    // Sendblue DOES support read receipts (POST /api/mark-read). Fire the REAL receipt (blue
    // "Read" label) AND the typing bubble in PARALLEL — both are best-effort UX, and the caller
    // runs this fire-and-forget so it never sits on the reply's critical path.
    async markRead(): Promise<void> {
      record("mark_read")
      if (dryRun) return
      // Read receipt AND typing both come FROM the resolved pool line (see resolveFromNumber).
      const fromNumber = await resolveFromNumber()
      await Promise.allSettled([
        sendReadReceipt({ to: deps.toE164, fromNumber }).catch((err) =>
          log("claire.transport.markRead.error", {
            message: err instanceof Error ? err.message : String(err),
          }),
        ),
        sendTypingIndicator({ to: deps.toE164, fromNumber }).catch(() => {
          /* typing is pure UX; never block on it */
        }),
      ])
    },

    async typing(): Promise<void> {
      record("typing")
      if (dryRun) return
      try {
        // typing reflex (before a slow tool) must also use the thread's pool line.
        await sendTypingIndicator({ to: deps.toE164, fromNumber: await resolveFromNumber() })
      } catch (err) {
        log("claire.transport.typing.error", {
          message: err instanceof Error ? err.message : String(err),
        })
      }
    },

    // Transient "one sec" bubble — immediate, best-effort, no durable row.
    async sendStatus(text: string): Promise<void> {
      record("status", text)
      if (dryRun) return
      try {
        await sendImessage({
          to: deps.toE164,
          content: text,
          userId: deps.userId,
          db: deps.db,
          allowEnvFromNumberFallback: false,
        })
      } catch (err) {
        log("claire.transport.sendStatus.error", {
          message: err instanceof Error ? err.message : String(err),
        })
      }
    },

    // User-facing reply — durable, idempotent, retried via the pa-outbound outbox.
    async sendText(text: string, opts?: { seq?: number; paced?: boolean }): Promise<void> {
      record("text", text)
      if (dryRun) return
      const body = String(text ?? "").trim()
      if (!body) return
      try {
        await enqueueOutbound(deps.db, {
          userId: deps.userId,
          toE164: deps.toE164,
          body,
          idempotencyKey: textIdempotencyKey(deps, body),
          ...(typeof opts?.seq === "number" ? { seq: opts.seq } : {}),
          ...(opts?.paced ? { paced: true } : {}),
          runtimeApproved: true,
          runtimeSource: "pa_orchestrator",
        })
      } catch (err) {
        log("claire.transport.sendText.error", {
          message: err instanceof Error ? err.message : String(err),
        })
      }
    },

    async tapback(reaction: ClaireReaction): Promise<void> {
      record("tapback", reaction)
      if (dryRun) return
      if (!deps.inboundMessageHandle) {
        log("claire.transport.tapback.skip_no_handle", { reaction })
        return
      }
      try {
        await sendReaction({
          to: deps.toE164,
          messageHandle: deps.inboundMessageHandle,
          reaction,
          userId: deps.userId,
          db: deps.db,
          allowEnvFromNumberFallback: false,
        })
      } catch (err) {
        log("claire.transport.tapback.error", {
          message: err instanceof Error ? err.message : String(err),
        })
      }
    },

    async noReply(reason: string): Promise<void> {
      record("no_reply", reason)
      // No outbound by design — audit only.
      log("claire.transport.noReply", { reason })
    },
  }
}
