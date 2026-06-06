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
import { isCanaryUser, isPrescreenRetentionHandoffCanary } from "./canary.js"
import { createSendblueTransport } from "./transport.js"
import { selectClaireMode } from "./mode-selector.js"
import { setEnrichmentInFlight, clearEnrichmentInFlight } from "./enrichment-inflight.js"
import { withProgressHeartbeat, PROGRESS_HEARTBEAT_COPY } from "./progress-heartbeat.js"
import {
  hasPriorParsedResume,
  readOpenMergePending,
  stageMergePending,
  setMergePendingStatus,
  defaultMergeConfirmClassifier,
  MERGE_CONFIRM_BUBBLE,
  MERGE_ACCEPT_ACK,
  MERGE_DECLINE_REPLY,
  MERGE_ACCEPT_CONFIDENCE,
  type MergeConfirmClassifier,
} from "./merge-resume-confirm.js"
import { buildDecisionTrace } from "./decision-trace.js"
import type { ClaireLang } from "./types.js"
// NOTE: agent.js + tools/matching-tools.js are NOT imported statically — they pull
// the @pa/agent-runtime/zod@4 SDK, which crashes the deployed container at boot.
// They're dynamic-imported below, only after the flag gate passes.

// Sendblue writes a PLACEHOLDER body ("[attachment]") for a bare media drop with no caption — it is
// NOT real user text. The résumé-drop gates below trigger on "no real text"; using text.trim() treated
// "[attachment]" as a real message, so a file drop SKIPPED the reading-ack + merge-confirm path and fell
// through to the deterministic "still pulling your info" ack (live 8fEw 2026-06-05). hasRealUserText()
// treats media placeholders / empty / whitespace as no-text → a file drop hits the merge-confirm flow.
// Structural exact-match set (NOT semantic classification → the no-regex tagging rule is unaffected).
const MEDIA_PLACEHOLDER_BODIES = new Set([
  "[attachment]", "[image]", "[media]", "[photo]", "[video]", "[file]",
  "[document]", "[pdf]", "[gif]", "[sticker]", "[contact]", "[location]",
])
function hasRealUserText(t: string): boolean {
  const s = (t || "").trim()
  if (!s) return false
  return !MEDIA_PLACEHOLDER_BODIES.has(s.toLowerCase())
}

export interface MaybeThinClaireDeps {
  log?: (event: string, payload?: Record<string, unknown>) => void
  /**
   * Test-only: when true, the Sendblue transport RECORDS bubbles instead of sending them, so the
   * full cutover seam (doc parse → flag gate → transport → runClaireTurn → mark completed) can be
   * driven in an integration eval with no real iMessage. Production callers omit it → real send.
   */
  dryRun?: boolean
  /**
   * Test seam (merge-confirm): the LLM accept/decline/unclear classifier for an open merge-pending.
   * Production omits it → the real gpt-5.4-mini json_schema-STRICT classifier. Stubbed in tests so the
   * accept/decline/unclear reducer routing is driven without a model call.
   */
  mergeConfirmClassifier?: MergeConfirmClassifier
  /**
   * Test seam (merge-confirm): override the ingestCv invoked on ACCEPT, so a test can assert it fired
   * exactly once with the staged mediaUrl + live sessionId + skipLimitEnforcement, without parsing a PDF.
   * Production omits it → the real dynamic-imported ingestCv.
   */
  ingestCvOverride?: (
    input: { userId: string; mediaUrl: string; sessionId?: string },
    opts: { skipLimitEnforcement: boolean },
  ) => Promise<unknown>
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
  // RÉSUMÉ DROP STAYS ON THIN (Adam 2026-06-04): a text-LESS résumé attachment is a real turn — it must
  // NOT fall through to legacy, whose cv-followup tells an already-connected candidate "you weren't
  // invited into this workflow, upload again / connect LinkedIn" (live bug). Read the media marker here
  // so the guard admits a media-only inbound. Thin still needs a durable session + EITHER text or a
  // résumé; otherwise defer to legacy.
  const earlyMediaUrl =
    typeof (data.rawMeta as Record<string, unknown> | undefined)?.mediaUrl === "string"
      ? ((data.rawMeta as Record<string, unknown>).mediaUrl as string).trim()
      : ""
  if (!userId || !sessionId || (!text.trim() && !earlyMediaUrl)) return false

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
  const runtimeEventKind =
    typeof rawMeta.runtimeEventKind === "string" ? rawMeta.runtimeEventKind : undefined
  // CV-PARSED RE-ENTRY (Adam 2026-06-02): the cv-ingest post-parse completion event is ALSO a
  // runtimeEvent (enqueueRuntimeEventHandoff eventKind="resume_parse_completed"), so the blanket guard
  // below was deferring the THIN proactive pitch to legacy too — which is why the pitch read surface
  // even after PART 1 shipped. Let THIS one kind fall through to thin so Claire composes the enriched
  // pitch from the freshly-parsed profile — but ONLY for canary users (invariant 3: non-canary keep the
  // legacy cv-followup until ramp). The producer contract is unchanged; legacy still consumes the same
  // event for everyone else. The onboarding-kickoff / nurture / cv-reject runtime events carry a
  // DIFFERENT runtimeEventKind, so they still defer → the onboarding dup-send fix stays intact.
  const cvParsedReentry =
    runtimeEventKind === "resume_parse_completed" && isCanaryUser(userId)
  // BLOCKER 2 (Adam 2026-06-03): the resume_parse_completed handoff carries the parsed-profile summary
  // (buildCvFactBody) on rawMeta.context.candidateProfileSummary. Read it here and thread it into the
  // turn so the pitch turn ALWAYS has the profile in context — even if loadGlobalContext's read of the
  // freshly-written parsedCandidateResumes row lagged the parse. The model then pitches FROM this and
  // never mistakes the "[resume just finished parsing]" marker for an empty résumé.
  const handoffContext = (rawMeta.context ?? {}) as Record<string, unknown>
  const postParsePitchSummary =
    cvParsedReentry && typeof handoffContext.candidateProfileSummary === "string"
      ? handoffContext.candidateProfileSummary.trim()
      : ""
  if (rawMeta.runtimeEvent === true && !cvParsedReentry) {
    log("thin_claire.defer_runtime_event", {
      eventId,
      userId,
      source: typeof rawMeta.runtimeEventSource === "string" ? rawMeta.runtimeEventSource : undefined,
      kind: runtimeEventKind,
    })
    return false
  }
  if (cvParsedReentry) {
    log("thin_claire.cv_parsed_reentry", { eventId, userId })
    // WS-1(b): the resume_parse_completed event = enrichment FINISHED. CLEAR the in-flight marker
    // (best-effort, never blocks) so the NEXT turn after the pitch doesn't keep saying "one sec".
    // This is the pitch turn (postParsePitch), so the directive is never active here regardless.
    void clearEnrichmentInFlight(db, userId, new Date().toISOString()).catch(() => {})
  }

  const toE164 =
    (typeof data.fromNumber === "string" && data.fromNumber) ||
    (typeof data.externalChatId === "string" && data.externalChatId) ||
    (typeof data.from === "string" && data.from) ||
    ""
  const inboundMessageHandle =
    typeof rawMeta.messageHandle === "string" ? rawMeta.messageHandle : undefined

  // ── MERGE-CONFIRM ACCEPT/DECLINE (Adam-LOCKED 2026-06-05) ──────────────────────────────────────────
  // A NEW/additional résumé on an EXISTING profile is a MERGE, not an overwrite — and Adam wants us to
  // ASK first. When a prior résumé drop staged `pa-cv-merge-pending/{userId}=awaiting_confirm` and sent
  // the MERGE-framed confirm bubble, THIS turn may be the candidate's reply ("yes go for it" / "no"). If
  // a merge-pending is OPEN and this is a TEXT reply (not the résumé media itself, not the parse re-entry),
  // classify the intent with ONE json_schema-STRICT LLM call (no-regex: LLM picks the enum) and let the
  // REDUCER act: accept → fire the EXISTING ingestCv (→ runUserTagsMerge MERGE → resume_parse_completed →
  // composePitchTurn, all reused, never a replace); decline → keep current profile; unclear → fall
  // through to normal triage (pending stays open until TTL). Canary-only (isCanaryUser). Fail-open: any
  // error here never blocks the turn (it just falls through to the agent).
  if (
    isCanaryUser(userId) &&
    toE164 &&
    hasRealUserText(text) &&
    !earlyMediaUrl &&
    rawMeta.runtimeEvent !== true
  ) {
    try {
      const pending = await readOpenMergePending(db, userId)
      if (pending) {
        const classify: MergeConfirmClassifier =
          deps.mergeConfirmClassifier ?? defaultMergeConfirmClassifier
        const { intent, confidence } = await classify(text)
        log("thin_claire.merge_confirm.classified", { eventId, userId, intent, confidence })
        const nowIso = new Date().toISOString()
        if (intent === "accept_merge" && confidence >= MERGE_ACCEPT_CONFIDENCE) {
          // ACCEPT → MERGE via the EXISTING engine. Mark in-flight + fire ingestCv with the staged
          // mediaUrl + the LIVE session (skipLimitEnforcement, exactly like the résumé-drop path). With
          // the cv-ingest:2397 canary guard OFF, ingestCv takes the normal write path → runUserTagsMerge
          // MERGES (LinkedIn experiences + existing tags + new résumé), keeping the skills-regression
          // guard. It then emits resume_parse_completed → the cv-parsed re-entry repitches MERGED. NEVER
          // a replace, NO tombstone, NO promotePendingCv.
          void setEnrichmentInFlight(db, userId, "resume", nowIso).catch(() => {})
          const runIngest =
            deps.ingestCvOverride ??
            (async (input, opts) => {
              const { ingestCv } = await import("../cv-ingest/cv-ingest.js")
              return ingestCv(input, opts)
            })
          // PROGRESS HEARTBEAT (Adam 2026-06-06): the merge runs fire-and-forget; if it overruns 30s
          // nudge the candidate ONCE ("still reading…") so the wait never feels stuck. clearTimeout on
          // settle keeps it strictly before the pitch (the cv-parsed re-entry). Canary-only, fail-open.
          const hbTransport = createSendblueTransport({
            db,
            toE164: String(toE164),
            inboundMessageHandle,
            userId,
            sessionId,
            inboundEventId: eventId,
            log,
            ...(deps.dryRun ? { dryRun: true } : {}),
          })
          void withProgressHeartbeat(
            Promise.resolve(
              runIngest(
                { userId, mediaUrl: pending.mediaUrl, sessionId: pending.sessionId ?? sessionId },
                { skipLimitEnforcement: true },
              ),
            )
              .then((r) =>
                log("thin_claire.merge_confirm.ingest_done", { eventId, userId, result: r }),
              )
              .catch((e) =>
                log("thin_claire.merge_confirm.ingest_failed", {
                  eventId,
                  userId,
                  err: e instanceof Error ? e.message : String(e),
                }),
              ),
            {
              send: (t) => hbTransport.sendStatus(t),
              message: PROGRESS_HEARTBEAT_COPY.resume,
              log: (event, payload) => log(`thin_claire.merge_confirm.${event}`, payload),
            },
          )
          await setMergePendingStatus(db, userId, "accepted", nowIso)
          const ackTransport = createSendblueTransport({
            db,
            toE164: String(toE164),
            inboundMessageHandle,
            userId,
            sessionId,
            inboundEventId: eventId,
            log,
            ...(deps.dryRun ? { dryRun: true } : {}),
          })
          await ackTransport.sendText(MERGE_ACCEPT_ACK, { seq: 0 })
          await db
            .collection(PA_COLLECTIONS.inboundEvents)
            .doc(eventId)
            .set({ status: "completed", handledBy: "thin_claire_merge_accept" }, { merge: true })
          log("thin_claire.merge_confirm.accepted", { eventId, userId })
          return true
        }
        if (intent === "decline_merge") {
          await setMergePendingStatus(db, userId, "declined", nowIso)
          const declineTransport = createSendblueTransport({
            db,
            toE164: String(toE164),
            inboundMessageHandle,
            userId,
            sessionId,
            inboundEventId: eventId,
            log,
            ...(deps.dryRun ? { dryRun: true } : {}),
          })
          await declineTransport.sendText(MERGE_DECLINE_REPLY, { seq: 0 })
          await db
            .collection(PA_COLLECTIONS.inboundEvents)
            .doc(eventId)
            .set({ status: "completed", handledBy: "thin_claire_merge_decline" }, { merge: true })
          log("thin_claire.merge_confirm.declined", { eventId, userId })
          return true
        }
        // unclear (or low-confidence accept) → fall through to normal triage; pending stays open (TTL).
        log("thin_claire.merge_confirm.unclear_fallthrough", { eventId, userId })
      }
    } catch (mcErr) {
      // Fail-open: never block the turn on a merge-confirm read/classify error — fall through to the agent.
      log("thin_claire.merge_confirm.error", {
        eventId,
        userId,
        err: mcErr instanceof Error ? mcErr.message : String(mcErr),
      })
    }
  }

  // PITCH ENGINE (Adam 2026-06-04): the cv-parsed re-entry IS the pitch turn. Compose the pitch with a
  // DEDICATED gpt-5.4-mini call (.planning/PITCH-GUIDE.md) instead of the chat agent — which produced a
  // shallow ONE-signal pitch ("you leveled up to senior backend") and duplicated bubbles. Send a
  // DETERMINISTIC 3-bubble turn: confirmation → composed pitch → offer (fixed order, no dup, no agent
  // paraphrase). FAIL-OPEN: composePitchTurn returns null on any miss (no key / no signal / empty
  // completion) → fall through to the legacy agent pitch path below. Canary-only (the cv-parsed pitch
  // cohort). The composer also stamps onboarding complete so the NEXT turn is normal triage, not a re-pitch.
  if (cvParsedReentry && toE164 && isCanaryUser(userId)) {
    try {
      const { composePitchTurn } = await import("./compose-pitch.js")
      const bubbles = await composePitchTurn(db, userId)
      if (bubbles && bubbles.length > 0) {
        const transport = createSendblueTransport({
          db,
          toE164: String(toE164),
          inboundMessageHandle,
          userId,
          sessionId,
          inboundEventId: eventId,
          log,
          ...(deps.dryRun ? { dryRun: true } : {}),
        })
        // ORDER + REASONING BEAT (Adam 2026-06-04): bubbles are [confirmation, pitch, offer] and MUST land
        // in THAT order — the offer comes AFTER the pitch. Do NOT use paced:true: the outbox's
        // length-proportional typing dwell made the SHORT offer overtake the LONG pitch (live "offer before
        // pitch" bug). Instead send each with an explicit typing indicator + sleep between, so createdAt
        // order holds AND the pitch gets a real ~10s "thinking" beat (Adam: "make it at least 10 seconds";
        // 3s felt like no reasoning).
        await transport.sendText(bubbles[0]!, { seq: 0 }) // confirmation — immediate
        try { await transport.typing() } catch { /* typing is pure UX */ }
        if (!deps.dryRun) await new Promise((r) => setTimeout(r, 10000)) // 10s reasoning beat before the pitch
        await transport.sendText(bubbles[1]!, { seq: 1 }) // the PITCH
        if (bubbles[2]) {
          try { await transport.typing() } catch { /* typing is pure UX */ }
          if (!deps.dryRun) await new Promise((r) => setTimeout(r, 2500)) // short beat, THEN the offer
          await transport.sendText(bubbles[2]!, { seq: 2 }) // the OFFER — always after the pitch
        }
        await db
          .collection(PA_COLLECTIONS.inboundEvents)
          .doc(eventId)
          .set({ status: "completed", handledBy: "thin_claire_pitch_engine" }, { merge: true })
        log("thin_claire.pitch_engine.sent", { eventId, userId, bubbles: bubbles.length })
        return true
      }
      log("thin_claire.pitch_engine.fallthrough", { eventId, userId })
      // composePitchTurn returned null (composer miss). Do NOT fall through to the agent path on a
      // cv-parsed re-entry: the agent has MATCHED here (the live "I pulled 3 fresh matches" instead of a
      // sharpened pitch — Adam 2026-06-04, "we give a match before we get back from resume improvement").
      // Send a deterministic, honest acknowledgment that OFFERS the next step (never auto-matches) and
      // STOP. The résumé is parsed + the profile updated regardless; the user explicitly drives matching.
      if (toE164) {
        const fbTransport = createSendblueTransport({
          db,
          toE164: String(toE164),
          inboundMessageHandle,
          userId,
          sessionId,
          inboundEventId: eventId,
          log,
          ...(deps.dryRun ? { dryRun: true } : {}),
        })
        await fbTransport
          .sendText(
            "got your résumé — your profile's updated 🙌 want me to pull roles that fit now, or tweak/add anything first?",
            { seq: 0 },
          )
          .catch((e) => log("thin_claire.pitch_engine.fallback_send_failed", { eventId, err: String(e) }))
        await db
          .collection(PA_COLLECTIONS.inboundEvents)
          .doc(eventId)
          .set({ status: "completed", handledBy: "thin_claire_pitch_engine_fallback" }, { merge: true })
          .catch(() => {})
        log("thin_claire.pitch_engine.fallback_sent", { eventId, userId })
        return true
      }
    } catch (err) {
      log("thin_claire.pitch_engine.error", {
        eventId,
        userId,
        err: err instanceof Error ? err.message : String(err),
      })
    }
  }

  // Inbound résumé (Adam 2026-06-02): a candidate — especially a brand-new cold sender
  // who never onboarded via QR — can drop a résumé PDF inline. Run the SAME enrichment
  // wheel the website uses: a direct `ingestCv` call (exactly like public-cv-ingest.ts),
  // now that the user is resolved/provisioned (cold users were skipped by the webhook
  // Stream-D ingest, which had no userId at webhook time). ingestCv is sha256-idempotent
  // + fail-open, so a known user already ingested at webhook time is a cheap no-op.
  // Fire-and-forget — a parse failure must never block the conversational turn.
  const inboundMediaUrl = typeof rawMeta.mediaUrl === "string" ? rawMeta.mediaUrl.trim() : ""

  // ── ADDITIONAL-RÉSUMÉ MERGE CONFIRM GATE (Adam-LOCKED 2026-06-05) ──────────────────────────────────
  // A NEW/additional résumé on an EXISTING profile must MERGE, not overwrite — and we ASK first. If the
  // candidate ALREADY has a prior (non-archived) parsed résumé (e.g. a Coresignal/LinkedIn mirror row),
  // this résumé-only drop is an ADDITIONAL one: do NOT parse-and-ingest yet. STAGE the mediaUrl in
  // `pa-cv-merge-pending/{userId}` and send a MERGE-framed confirm bubble ("fold it into your profile and
  // re-pitch you?"). The merge + repitch fire only on ACCEPT (the accept block above on the NEXT turn,
  // which fires ingestCv → runUserTagsMerge MERGE → resume_parse_completed → composePitchTurn). This is
  // canary-only and résumé-ONLY (a résumé WITH a real caption takes the immediate-ingest path — M11). The
  // FIRST résumé (no prior row) keeps the zero-friction immediate-ingest + reading-ack (M8) — confirm is
  // ONLY for the additional case. Trigger on MEDIA presence + no REAL text (so a "[attachment]" placeholder
  // body still fires it — the live 2026-06-05 bug was `!text.trim()` treating "[attachment]" as text).
  // Fail-open: a read error degrades to the immediate-ingest path.
  if (inboundMediaUrl && !hasRealUserText(text) && toE164 && isCanaryUser(userId)) {
    try {
      if (await hasPriorParsedResume(db, userId)) {
        const nowIso = new Date().toISOString()
        await stageMergePending(db, { userId, mediaUrl: inboundMediaUrl, sessionId: sessionId ?? null, nowIso })
        const confirmTransport = createSendblueTransport({
          db,
          toE164: String(toE164),
          inboundMessageHandle,
          userId,
          sessionId,
          inboundEventId: eventId,
          log,
          ...(deps.dryRun ? { dryRun: true } : {}),
        })
        await confirmTransport.sendText(MERGE_CONFIRM_BUBBLE, { seq: 0 })
        await db
          .collection(PA_COLLECTIONS.inboundEvents)
          .doc(eventId)
          .set({ status: "completed", handledBy: "thin_claire_merge_confirm" }, { merge: true })
        log("thin_claire.merge_confirm.staged", { eventId, userId })
        return true
      }
    } catch (gateErr) {
      // Fail-open: an additional-résumé detection error must NEVER block the turn — fall through to the
      // immediate-ingest path below (first-résumé behavior), so the résumé is still parsed.
      log("thin_claire.merge_confirm.gate_error", {
        eventId,
        userId,
        err: gateErr instanceof Error ? gateErr.message : String(gateErr),
      })
    }
  }

  if (inboundMediaUrl) {
    // WS-1(b) ENRICHMENT-AWARENESS (Adam 2026-06-03): the résumé parse runs async (the
    // fire-and-forget ingestCv below) and only completes on the resume_parse_completed re-entry.
    // SET the durable in-flight marker NOW (best-effort, never blocks) so a SECOND inbound that
    // arrives mid-parse routes through the "still pulling your info, one sec" directive instead of
    // pitching on empty data. Cleared on the cv-parsed re-entry (below). Canary-only — the
    // directive only fires for canary users (mode-selector gates the read), and the LinkedIn path
    // sets its own marker server-side in linkedin-connect-submit. Marker self-heals via TTL.
    if (isCanaryUser(userId)) {
      void setEnrichmentInFlight(db, userId, "resume", new Date().toISOString()).catch(() => {})
    }
    // skipLimitEnforcement: a candidate who TEXTS US their résumé during onboarding is exactly the
    // resume-first flow (resume → pitch → find_match). The cv-ingest invite-gate (checkGate →
    // "not_invited") is for unsolicited uploads from non-invited users; it must NOT reject an
    // onboarding/conversation upload — that produced the live "they didn't move forward / resume
    // was shared" rejection (2026-06-02, +18147696202). Bypass the gate; ingestCv stays idempotent.
    // BUG 1 FIX (Adam 2026-06-02): pass the LIVE conversation sessionId (read off the inbound doc at
    // line 52, back-filled by processBrokerImessageEvent at index.ts:1054) into ingestCv. The
    // resume_parse_completed handoff (cv-ingest.ts) threads THIS session, so the handoff's
    // requireExistingSession gate sees a session that already exists (created at index.ts:1020 before
    // this turn ran) instead of re-deriving one from the phone — which (a) could fail `no_existing_session`
    // and silently drop the thin re-entry → NO pitch, and (b) diverged for email-Apple-ID senders.
    // Without this, the cv-parsed completion never reached thin and LEGACY composed the post-parse turn
    // ("scratch that, they weren't invited") through the imperfection injector.
    const runImmediateIngest =
      deps.ingestCvOverride ??
      (async (input, opts) => {
        const { ingestCv } = await import("../cv-ingest/cv-ingest.js")
        return ingestCv(input, opts)
      })
    const ingestChain = Promise.resolve(
      runImmediateIngest(
        { userId, mediaUrl: inboundMediaUrl, sessionId },
        { skipLimitEnforcement: true },
      ),
    )
      .then((r) => log("thin_claire.resume_ingest.done", { eventId, userId, result: r }))
      .catch((e) =>
        log("thin_claire.resume_ingest.failed", {
          eventId,
          userId,
          err: e instanceof Error ? e.message : String(e),
        })
      )
    // PROGRESS HEARTBEAT (Adam 2026-06-06): same once-only nudge as the merge path. The résumé parse
    // is the proven-slow stage; if it overruns 30s send ONE "still reading…" before the pitch re-entry.
    // clearTimeout-on-settle keeps it strictly ahead of the result. Canary-only + needs a thread to reply to.
    if (isCanaryUser(userId) && toE164) {
      const hbTransport = createSendblueTransport({
        db,
        toE164: String(toE164),
        inboundMessageHandle,
        userId,
        sessionId,
        inboundEventId: eventId,
        log,
        ...(deps.dryRun ? { dryRun: true } : {}),
      })
      void withProgressHeartbeat(ingestChain, {
        send: (t) => hbTransport.sendStatus(t),
        message: PROGRESS_HEARTBEAT_COPY.resume,
        log: (event, payload) => log(`thin_claire.resume_ingest.${event}`, payload),
      })
    } else {
      void ingestChain
    }
  }

  // RÉSUMÉ-ONLY drop (no accompanying text): ACK deterministically on THIN and STOP — do NOT run the
  // chat agent (it has no message to answer and hallucinated "you weren't invited, upload again /
  // connect LinkedIn" from the mid-parse empty context — live 2026-06-04). The refined pitch fires on
  // the resume_parse_completed re-entry (composePitchTurn). Canary-only. The ingestCv above already ran.
  // Trigger on MEDIA + no-real-text (a "[attachment]" placeholder body must still ack, not fall through
  // to the deterministic "still pulling" mode-selector ack — the live 2026-06-05 bug).
  if (inboundMediaUrl && !hasRealUserText(text) && toE164 && isCanaryUser(userId)) {
    try {
      const ackTransport = createSendblueTransport({
        db,
        toE164: String(toE164),
        inboundMessageHandle,
        userId,
        sessionId,
        inboundEventId: eventId,
        log,
        ...(deps.dryRun ? { dryRun: true } : {}),
      })
      await ackTransport.sendText(MERGE_ACCEPT_ACK, { seq: 0 })
      await db
        .collection(PA_COLLECTIONS.inboundEvents)
        .doc(eventId)
        .set({ status: "completed", handledBy: "thin_claire_resume_ack" }, { merge: true })
      log("thin_claire.resume_ack.sent", { eventId, userId })
      return true
    } catch (err) {
      log("thin_claire.resume_ack.error", {
        eventId,
        userId,
        err: err instanceof Error ? err.message : String(err),
      })
    }
  }

  const lang: ClaireLang = data.lang === "zh" ? "zh" : "en"

  // Deterministic mode pick from durable state (onboarding/prescreen/triage). An active
  // prescreen DEFERS this turn to the proven legacy runner (return false → legacy handles it).
  // Fail-safe: selectClaireMode never throws — any read error degrades to triage.
  const decision = await selectClaireMode({ db, userId, inboundText: text, log, cvParsedTrigger: cvParsedReentry, hasInboundMedia: Boolean(inboundMediaUrl) })
  if (decision.deferToLegacy) {
    log("thin_claire_defer_legacy", { eventId, userId, mode: decision.mode, jobId: decision.jobId })
    return false
  }
  // SUPPRESS (Adam 2026-06-03): a vestigial system echo with nothing to say — e.g. the
  // "I've done LinkedIn submission <token>" reroute that arrives AFTER the callback already
  // enriched + server-pushed the pitch. Mark the inbound handled (thin owns it) and send NOTHING,
  // so the candidate doesn't get a duplicate "drop your résumé/URL" re-ask.
  if (decision.suppressReply) {
    log("thin_claire_suppress_reply", { eventId, userId, reason: decision.suppressReason })
    return true
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
    const REC_CARD_UIDS = new Set<string>(["8fEwIduUrzxZsblHHsNz", "UKFaKdsMzzfPW2CDl5ve"]) // +14243201960 (Adam), +12154034668 (Noah) — dev image testers
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
    // PRESCREEN-SEAM RETENTION HANDOFF (Adam 2026-06-05): when the prescreen handler DEFERRED a
    // post-terminal / retention turn to thin (canary only — isPrescreenRetentionHandoffCanary), assemble
    // the CONTEXT-COMPLETE candidate context (global profile ∪ ALL prescreen terminals/reasons/scores/
    // borderline signals ∪ retention stage) and thread its rendered block onto the agent so it answers
    // "why paused / why didn't I pass" HONESTLY, captures a target-role answer via the no-regex tools, and
    // offers OTHER matching roles — instead of the legacy canned "You're welcome — screen closed" (the Sai
    // bug). Read-only + fail-soft (buildCandidateContext never throws). Dev-cohort only; everyone else
    // never reaches here (the legacy handler answered them byte-for-byte). The reducer (terminal/retain/
    // match) is untouched — this only changes WHO answers + WITH WHAT CONTEXT.
    let candidateContext: string | undefined
    if (isPrescreenRetentionHandoffCanary(userId)) {
      try {
        const { buildCandidateContext } = await import("./candidate-context.js")
        const cc = await buildCandidateContext(db, userId, {
          ...(toE164 ? { toE164: String(toE164) } : {}),
          ...(decision.jobId ? { jobId: decision.jobId } : {}),
        })
        if (cc.prescreenContextText) candidateContext = cc.prescreenContextText
      } catch (ccErr) {
        // Fail-open: a context-assembler error must NEVER block the turn — the agent still runs on the
        // global context (loadGlobalContext) it loads internally; it just lacks the prior-screen block.
        log("thin_claire.candidate_context_failed", {
          eventId,
          userId,
          err: ccErr instanceof Error ? ccErr.message : String(ccErr),
        })
      }
    }

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
        // cv-parsed re-entry: this turn is the post-parse PITCH turn (mode-selector set postParsePitch).
        // Threaded so prompt.ts swaps the generic kickoff for the PART-2 pitch. Canary-only by construction
        // (cvParsedReentry requires isCanaryUser); default off for everyone else.
        ...(decision.postParsePitch ? { postParsePitch: true } : {}),
        // WS-1(b): enrichment (résumé parse / LinkedIn import) is STILL running from an earlier turn →
        // the turn-context directive tells Claire to hold ("still pulling your info, one sec") instead of
        // pitching on empty data. Canary-only by construction (mode-selector gates the marker read).
        ...(decision.enrichmentInFlight ? { enrichmentInFlight: true } : {}),
        // WS-3(b): this turn MAY carry the occasional "connect Gmail on wekruit.com" nudge (deterministic
        // cooldown reducer passed; stamp already written). Canary-only by construction.
        ...(decision.gmailNudge ? { gmailNudge: true } : {}),
        // CANONICAL STEP 4: the one conditional pre-match ask (location+salary, only-if-both-missing).
        ...(decision.locationSalaryAsk ? { locationSalaryAsk: true } : {}),
        // WARM RETURNING GREETING (Adam 2026-06-05): a KNOWN/returning candidate sent a cold greeting →
        // greet back + offer matches, NEVER the offer kickoff NOR the legacy target_role question.
        // Canary-only by construction (mode-selector gates it behind isCanaryUser).
        ...(decision.warmReturningGreeting ? { warmReturningGreeting: true } : {}),
        // COLD OFFER-FIRST (Adam 2026-06-03): brand-new candidate → deterministic LinkedIn-recommended /
        // résumé offer + NO onboarding question (pitch fires after they connect/drop). Canary by construction.
        ...(decision.offerFirstKickoff ? { offerFirstKickoff: true } : {}),
        // LINKEDIN-DONE re-entry (Adam 2026-06-03): they tapped "log in with LinkedIn" + came back, but
        // OAuth can't enrich (OIDC has no profile URL) → ack by name + ask for résumé/URL, never re-offer.
        ...(decision.linkedinJustConnected ? { linkedinJustConnected: true } : {}),
        // BLOCKER 2: thread the parsed-profile summary from the handoff context onto the pitch turn so
        // the model has the profile THIS turn (defends against a loadGlobalContext read racing the write).
        ...(decision.postParsePitch && postParsePitchSummary ? { postParsePitchSummary } : {}),
        // résumé-DROP turn: an inline résumé media is present + this is NOT the parse re-entry → ACK + HOLD
        // (no pitch, no find_match this turn; the cutover:114 fire-and-forget runs the parse async, and the
        // pitch fires on the resume_parse_completed re-entry). Canary-gated to match the pitch behavior.
        ...(inboundMediaUrl && !cvParsedReentry && isCanaryUser(userId) ? { resumeJustDropped: true } : {}),
        // PRESCREEN-SEAM RETENTION HANDOFF (Adam 2026-06-05): the post-prescreen-terminal / retention block
        // (buildCandidateContext, above). Only set on a deferred post-terminal turn for the dev cohort.
        ...(candidateContext ? { candidateContext } : {}),
      },
    )
    await db
      .collection(PA_COLLECTIONS.inboundEvents)
      .doc(eventId)
      .set({ status: "completed", handledBy: "thin_claire" }, { merge: true })

    // PER-TURN DECISION TRACE keyed on the inbound event: ONE read of pa-turns/{eventId} answers
    // "why did Claire do X this turn" — the user message in, the deterministic mode/pattern that won,
    // the ordered tool calls (name → arguments → output, now de-blackboxed by the observability work),
    // the reply text out, and whether it was tool-delivered / dedup-suppressed. This SUPERSEDES the
    // prior usage-only doc (usage rides along in the same doc when it surfaced). buildDecisionTrace is
    // pure + total (never throws); the .set() is wrapped fail-open so a trace-write error can NEVER
    // fail the turn — the reply already went out. We ALWAYS write (even on no-usage / suppressed turns)
    // so every thin turn leaves an auditable trace, not just the ones that reported token usage.
    try {
      const trace = buildDecisionTrace({
        eventId,
        userId,
        sessionId,
        inboundText: text,
        mode: decision.mode,
        decisionFlags: {
          mode: decision.mode,
          ...(decision.postParsePitch ? { postParsePitch: true } : {}),
          ...(decision.offerFirstKickoff ? { offerFirstKickoff: true } : {}),
          ...(decision.linkedinJustConnected ? { linkedinJustConnected: true } : {}),
          ...(decision.locationSalaryAsk ? { locationSalaryAsk: true } : {}),
          ...(decision.warmReturningGreeting ? { warmReturningGreeting: true } : {}),
          ...(decision.gmailNudge ? { gmailNudge: true } : {}),
          ...(decision.enrichmentInFlight ? { enrichmentInFlight: true } : {}),
          ...(decision.prescreenSessionId ? { prescreenSessionId: decision.prescreenSessionId } : {}),
        },
        turnResult,
        nowIso: new Date().toISOString(),
      })
      await db.collection(PA_COLLECTIONS.turns).doc(eventId).set(trace, { merge: true })
      log("thin_claire.turn_trace", {
        eventId,
        userId,
        mode: trace.mode,
        pattern: trace.pattern,
        toolCalls: trace.toolCalls.map((c) => c.name),
        deliveredViaTool: trace.deliveredViaTool,
        suppressed: trace.suppressed,
        inputTokens: trace.usage?.inputTokens,
        cachedInputTokens: trace.usage?.cachedInputTokens,
        turnsUsed: trace.usage?.turnsUsed,
      })
    } catch (traceErr) {
      log("thin_claire.turn_trace_failed", {
        eventId,
        err: traceErr instanceof Error ? traceErr.message : String(traceErr),
      })
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
