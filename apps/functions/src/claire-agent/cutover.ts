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
import { selectClaireMode } from "./mode-selector.js"
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
  let text =
    typeof data.body === "string" ? data.body : typeof data.text === "string" ? data.text : ""
  // Thin Claire needs a durable session + a real message. Otherwise fall through to legacy.
  if (!userId || !sessionId || !text.trim()) return false

  // DEV TRIGGER — `__PA_SCHEDULE__` deterministically exercises the thin scheduling
  // flow (mirrors `__PA_FIND_MATCH__`). We rewrite the sentinel into a natural
  // scheduling ask so the agent calls offer_interview_slots through its normal turn.
  // The scheduling tools self-gate to SCHEDULING_DEV_UIDS, so a non-dev sender just
  // hears "a teammate will lock in a time" — safe to leave the sentinel ungated here.
  if (text.trim() === "__PA_SCHEDULE__") {
    text = "I'd like to schedule the interview now — what times do you have open?"
    log("thin_claire.dev_trigger.schedule", { eventId, userId })
  }

  let enabled = false
  try {
    enabled = await isThinClaireEnabled(db, userId)
  } catch {
    return false
  }
  if (!enabled) return false

  const rawMeta = (data.rawMeta ?? {}) as Record<string, unknown>

  // DUP-SEND GUARD (Adam 2026-06-02): runtime-event handoffs (onboarding kickoff, nurture,
  // reverse-match, cv-reject, etc.) are SYNTHETIC inbound docs enqueued by
  // enqueueRuntimeEventHandoff — their body is a "[system-event:…]" directive and
  // rawMeta.runtimeEvent === true. Thin Claire has NO runtime-event semantics (no system
  // role, no __NO_SEND__ token, no trusted-runtime-body composer); only the LEGACY path
  // (handleSharedOnboardingRuntimeEvent / index.ts runtimeEvent branch) knows how to treat
  // them. With thin ON for everyone, the un-guarded seam made thin answer the synthetic
  // kickoff directive AS IF it were a candidate message → a SECOND onboarding opener (the
  // real broker "Hello, WeKruit!" handshake produced the first). Defer ALL runtime events
  // to legacy so exactly one path composes one opener. The candidate's real handshake flows
  // via the broker path (no runtimeEvent marker) and is unaffected by this guard.
  if (rawMeta.runtimeEvent === true) {
    log("thin_claire.defer_runtime_event", {
      eventId,
      userId,
      source: typeof rawMeta.runtimeEventSource === "string" ? rawMeta.runtimeEventSource : undefined,
      kind: typeof rawMeta.runtimeEventKind === "string" ? rawMeta.runtimeEventKind : undefined,
    })
    return false
  }

  const toE164 =
    (typeof data.fromNumber === "string" && data.fromNumber) ||
    (typeof data.externalChatId === "string" && data.externalChatId) ||
    (typeof data.from === "string" && data.from) ||
    ""
  const inboundMessageHandle =
    typeof rawMeta.messageHandle === "string" ? rawMeta.messageHandle : undefined

  // Inbound résumé (Adam 2026-06-02): a candidate — especially a brand-new cold sender
  // who never onboarded via QR — can drop a résumé PDF inline. Run the SAME enrichment
  // wheel the website uses: a direct `ingestCv` call (exactly like public-cv-ingest.ts),
  // now that the user is resolved/provisioned (cold users were skipped by the webhook
  // Stream-D ingest, which had no userId at webhook time). ingestCv is sha256-idempotent
  // + fail-open, so a known user already ingested at webhook time is a cheap no-op.
  // Fire-and-forget — a parse failure must never block the conversational turn.
  const inboundMediaUrl = typeof rawMeta.mediaUrl === "string" ? rawMeta.mediaUrl.trim() : ""
  if (inboundMediaUrl) {
    void import("../cv-ingest/cv-ingest.js")
      .then(({ ingestCv }) => ingestCv({ userId, mediaUrl: inboundMediaUrl, sessionId: undefined }))
      .then((r) => log("thin_claire.resume_ingest.done", { eventId, userId, result: r }))
      .catch((e) =>
        log("thin_claire.resume_ingest.failed", {
          eventId,
          userId,
          err: e instanceof Error ? e.message : String(e),
        })
      )
  }

  const lang: ClaireLang = data.lang === "zh" ? "zh" : "en"

  // Deterministic mode pick from durable state (onboarding/prescreen/triage). An active
  // prescreen DEFERS this turn to the proven legacy runner (return false → legacy handles it).
  // Fail-safe: selectClaireMode never throws — any read error degrades to triage.
  const decision = await selectClaireMode({ db, userId, inboundText: text, log })
  if (decision.deferToLegacy) {
    log("thin_claire_defer_legacy", { eventId, userId, mode: decision.mode, jobId: decision.jobId })
    return false
  }

  try {
    // Heavy agent + tools (and their @pa/agent-runtime/zod@4 SDK) load lazily here —
    // only after the flag gate passed — so they stay out of the boot graph. Any
    // load/resolve failure is caught below → falls through to the legacy path.
    const { runClaireTurn } = await import("./agent.js")
    const { makeV16FindMatch } = await import("./tools/matching-tools.js")
    // Rec-card render→host→send side-channel deps (flag-gated, fail-open).
    // Built ONLY when PA_JOB_REC_CARD_ENABLED is on AND we are NOT in dryRun
    // (evals must not touch real Storage). makeV16FindMatch no-ops without these
    // deps, and maybeSendRecCard re-checks the flag internally — so on any
    // init failure we fall through to text-only recs, never blocking delivery.
    // REC-CARD IMAGE ALLOWLIST (Adam 2026-06-01: "for image let's only send to 4243201960"): even though
    // thin Claire is on for all users, the card IMAGE only sends to this dev-phone uid for now — everyone
    // else gets text-only recs. Widen this set to ramp the image. (The text rec + offer are unaffected.)
    const REC_CARD_UIDS = new Set<string>(["8fEwIduUrzxZsblHHsNz"]) // +14243201960
    let cardDeps: import("./tools/matching-tools.js").V16FindMatchCardDeps | undefined
    if (!deps.dryRun && toE164 && REC_CARD_UIDS.has(userId)) {
      try {
        const { isJobRecCardEnabled } = await import("../job-rec-card/job-rec-card.js")
        if (isJobRecCardEnabled()) {
          const resolvedPhone = String(toE164)
          // CACHED-IMAGE model: the runtime reads matching-jobs.recCardMediaUrl
          // (no render/upload). Sendblue media creds are passed ONLY for the
          // lazy-gen fallback (a job with no cached card yet); absent → cache-read
          // only, fail-open to text. Creds are in process.env during onPaInbound.
          const apiKeyId = process.env.SENDBLUE_API_KEY_ID?.trim()
          const apiSecretKey = process.env.SENDBLUE_API_SECRET_KEY?.trim()
          cardDeps = {
            getPhoneE164: async () => resolvedPhone,
            ...(apiKeyId && apiSecretKey ? { sendblueCreds: { apiKeyId, apiSecretKey } } : {}),
            log,
          }
        }
      } catch (cardErr) {
        // Non-fatal — fall through to text-only recs.
        log("rec_card.deps_init_failed", {
          error: cardErr instanceof Error ? cardErr.message : String(cardErr),
        })
      }
    }

    const transport = createSendblueTransport({
      db,
      toE164: String(toE164),
      inboundMessageHandle,
      userId,
      sessionId,
      // UNIQUE per inbound → outbound idempotency keys on the event, not just sessionId+body.
      // Without this the kickoff/onboarding question (deterministic body + stable sessionId)
      // re-keys identically across turns and ALREADY_EXISTS against an earlier `sent` row →
      // the reply is silently dropped (2026-05-29 dev-phone silent-kickoff).
      inboundEventId: eventId,
      log,
      ...(deps.dryRun ? { dryRun: true } : {}),
    })
    const turnResult = await runClaireTurn(
      {
        userId,
        sessionId,
        text,
        toE164: toE164 ? String(toE164) : undefined,
        inboundMessageHandle,
        inboundEventId: eventId,
        lang,
      },
      {
        db,
        transport,
        // 3rd arg = rec-card deps (undefined unless the flag is on + not dryRun).
        findMatch: makeV16FindMatch(db, undefined, cardDeps),
        log,
        mode: decision.mode,
        ...(decision.pendingStep ? { pendingStep: decision.pendingStep } : {}),
        ...(decision.currentStep ? { currentStep: decision.currentStep } : {}),
        ...(decision.processStore ? { processStore: decision.processStore } : {}),
        ...(decision.onboardingSlot ? { onboardingSlot: decision.onboardingSlot } : {}),
        ...(decision.awaitingAnswer !== undefined ? { awaitingAnswer: decision.awaitingAnswer } : {}),
        // prescreen-on-thin: DIRECTION prompts + judge rubric + résumé/prior-session context + the
        // REAL prescreen sessionId (score write-back + terminal fire) + jobId (ctx.jobId for the turn).
        ...(decision.jobId ? { jobId: decision.jobId } : {}),
        ...(decision.prescreenPrompts ? { prescreenPrompts: decision.prescreenPrompts } : {}),
        ...(decision.judgeContext ? { judgeContext: decision.judgeContext } : {}),
        ...(decision.prescreenContext ? { prescreenContext: decision.prescreenContext } : {}),
        ...(decision.prescreenResumeSnippet ? { prescreenResumeSnippet: decision.prescreenResumeSnippet } : {}),
        ...(decision.prescreenSessionId ? { prescreenSessionId: decision.prescreenSessionId } : {}),
      },
    )
    await db
      .collection(PA_COLLECTIONS.inboundEvents)
      .doc(eventId)
      .set({ status: "completed", handledBy: "thin_claire" }, { merge: true })

    // 2A — per-turn token usage telemetry (incl cached-prefix tokens) keyed on the inbound event,
    // tagged by MODE so prompt-cache hit-rate is visible per mode. Fail-open: a write error here
    // must NEVER fail the turn (the reply already went out). Skipped when no usage surfaced.
    if (turnResult?.usage) {
      try {
        await db
          .collection(PA_COLLECTIONS.turns)
          .doc(eventId)
          .set(
            {
              userId,
              sessionId,
              mode: decision.mode,
              handledBy: "thin_claire",
              usage: turnResult.usage,
              createdAt: new Date().toISOString(),
            },
            { merge: true },
          )
        log("thin_claire.turn_usage", {
          eventId,
          userId,
          mode: decision.mode,
          inputTokens: turnResult.usage.inputTokens,
          cachedInputTokens: turnResult.usage.cachedInputTokens,
          turnsUsed: turnResult.usage.turnsUsed,
        })
      } catch (usageErr) {
        log("thin_claire.turn_usage_failed", {
          eventId,
          err: usageErr instanceof Error ? usageErr.message : String(usageErr),
        })
      }
    }
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
