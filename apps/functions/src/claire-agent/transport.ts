/**
 * transport.ts — WS-delivery owns this file.
 *
 * Production `ClaireTransport` backed by Sendblue + pa-outbound:
 *   markRead   → sendTypingIndicator (Sendblue has NO read-receipt endpoint;
 *                immediate typing is the read signal — AGENTIC-ARCHITECTURE §7)
 *   typing     → sendTypingIndicator
 *   sendStatus → sendImessage (a quick one-line bubble) OR pa-outbound enqueue
 *   sendText   → pa-outbound enqueue (idempotent approved outbound path)
 *   tapback    → sendReaction(messageHandle)
 *   noReply    → audit only (no outbound)
 *
 * WS-delivery: implement, wrapping apps/functions/src/sendblue/* + the pa-outbound
 * enqueue used by the orchestrator today. Keep every call fail-open (never throw to run()).
 */
import type { Firestore } from "firebase-admin/firestore"
import type { ClaireTransport } from "./types.js"
import { notImplemented } from "./types.js"

export interface SendblueTransportDeps {
  db: Firestore
  toE164: string
  /** Sendblue handle of the inbound message (for tapback). */
  inboundMessageHandle?: string
  userId: string
  sessionId: string
  log?: (event: string, payload?: Record<string, unknown>) => void
}

export function createSendblueTransport(deps: SendblueTransportDeps): ClaireTransport {
  return notImplemented("WS-delivery", "transport.createSendblueTransport")
}
