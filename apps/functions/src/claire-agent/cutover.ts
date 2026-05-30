/**
 * cutover.ts — the flag-gated seam between the legacy ~12k-LOC path and thin Claire.
 *
 * Both onPaInbound and paMessageCoalescer funnel through
 * `claimAndProcessInboundEvent(db, eventId, ...)`. Each call site is guarded by
 * `maybeRunThinClaire`: if `paThinClaireEnabled` is ON for the event's user, the thin
 * agent handles the turn and we DON'T call the legacy path. Default OFF → returns false
 * for everyone but the 424 canary → legacy path is 100% unchanged.
 *
 * FAIL-SAFE: any miss (no userId/sessionId/text, flag off, read error, or an unexpected
 * throw BEFORE the thin agent sends anything) returns false → the legacy path still runs,
 * so the user always gets a reply. runClaireTurn itself never throws (timeout + fallback).
 */
import type { Firestore } from "firebase-admin/firestore"
import { PA_COLLECTIONS } from "@pa/core-types"
import { isThinClaireEnabled } from "./flags.js"
import { createSendblueTransport } from "./transport.js"
import type { ClaireLang } from "./types.js"
// NOTE: agent.js + tools/matching-tools.js are NOT imported statically — they pull
// the @pa/agent-runtime/zod@4 SDK, which crashes the deployed container at boot.
// They're dynamic-imported below, only after the flag gate passes.

export interface MaybeThinClaireDeps {
  log?: (event: string, payload?: Record<string, unknown>) => void
  /**
   * Test-only: when true, the Sendblue transport RECORDS bubbles instead of sending them, so the
   * full cutover seam (doc parse → flag gate → transport → runClaireTurn → mark completed) can be
   * driven in an integration eval with no real iMessage. Production callers omit it → real send.
   */
  dryRun?: boolean
}

export async function maybeRunThinClaire(
  db: Firestore,
  eventId: string,
  deps: MaybeThinClaireDeps = {},
): Promise<boolean> {
  const log = deps.log ?? (() => {})

  let data: Record<string, unknown>
  try {
    const snap = await db.collection(PA_COLLECTIONS.inboundEvents).doc(eventId).get()
    if (!snap.exists) return false
    data = (snap.data() ?? {}) as Record<string, unknown>
  } catch {
    return false
  }

  const userId = typeof data.userId === "string" ? data.userId : undefined
  const sessionId = typeof data.sessionId === "string" ? data.sessionId : undefined
  const text =
    typeof data.body === "string" ? data.body : typeof data.text === "string" ? data.text : ""
  // Thin Claire needs a durable session + a real message. Otherwise fall through to legacy.
  if (!userId || !sessionId || !text.trim()) return false

  let enabled = false
  try {
    enabled = await isThinClaireEnabled(db, userId)
  } catch {
    return false
  }
  if (!enabled) return false

  const rawMeta = (data.rawMeta ?? {}) as Record<string, unknown>
  const toE164 =
    (typeof data.fromNumber === "string" && data.fromNumber) ||
    (typeof data.externalChatId === "string" && data.externalChatId) ||
    (typeof data.from === "string" && data.from) ||
    ""
  const inboundMessageHandle =
    typeof rawMeta.messageHandle === "string" ? rawMeta.messageHandle : undefined
  const lang: ClaireLang = data.lang === "zh" ? "zh" : "en"

  try {
    // Heavy agent + tools (and their @pa/agent-runtime/zod@4 SDK) load lazily here —
    // only after the flag gate passed — so they stay out of the boot graph. Any
    // load/resolve failure is caught below → falls through to the legacy path.
    const { runClaireTurn } = await import("./agent.js")
    const { makeV16FindMatch } = await import("./tools/matching-tools.js")
    const transport = createSendblueTransport({
      db,
      toE164: String(toE164),
      inboundMessageHandle,
      userId,
      sessionId,
      log,
      ...(deps.dryRun ? { dryRun: true } : {}),
    })
    await runClaireTurn(
      {
        userId,
        sessionId,
        text,
        toE164: toE164 ? String(toE164) : undefined,
        inboundMessageHandle,
        inboundEventId: eventId,
        lang,
      },
      { db, transport, findMatch: makeV16FindMatch(db), log },
    )
    await db
      .collection(PA_COLLECTIONS.inboundEvents)
      .doc(eventId)
      .set({ status: "completed", handledBy: "thin_claire" }, { merge: true })
    log("thin_claire_handled", { eventId, userId })
    return true
  } catch (e) {
    // Unexpected (transport construction etc.) BEFORE any send → safe to fall through to legacy.
    log("thin_claire_failed_fallthrough", {
      eventId,
      userId,
      err: e instanceof Error ? e.message : String(e),
    })
    return false
  }
}
