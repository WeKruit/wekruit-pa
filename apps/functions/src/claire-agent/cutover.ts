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
 *
 * NOTE — SMS STOP/START compliance does NOT live here. Both call paths route prescreen/
 * PII/layoff turns BEFORE this cutover, so a gate here would miss a STOP sent mid-prescreen.
 * The deterministic keyword gate (claire-agent/stop-gate.ts) is wired at the earliest common
 * seam of each path instead: index.ts processBrokerImessageEvent (direct broker) and
 * paMessageCoalescer (coalesced), both immediately after the inbound doc is stamped and
 * before ANY routing — by the time a turn reaches this function it has already passed it.
 */
import type { Firestore } from "firebase-admin/firestore"
import { PA_COLLECTIONS, isYcPeopleUser } from "@pa/core-types"
import { isThinClaireEnabled } from "./flags.js"
import { isCanaryUser, isClaireEntryUxCanary, isPrescreenRetentionHandoffCanary } from "./canary.js"
import { createSendblueTransport } from "./transport.js"
import { selectClaireMode } from "./mode-selector.js"
import { isClaireVoiceDevPhone } from "../voice/dev-phone-gate.js"
import {
  setEnrichmentInFlight,
  clearEnrichmentInFlight,
  claimEnrichmentHoldNotice,
  ENRICHMENT_HOLD_NOTICE_COPY,
} from "./enrichment-inflight.js"
import { withProgressHeartbeat, PROGRESS_HEARTBEAT_COPY } from "./progress-heartbeat.js"
import { getRecentSentMessages } from "./delivery.js"
import {
  buildVoiceCallAckClarifier,
  parseLowInfoCallConfirmation,
  shouldHoldVoiceCallAckFromMatching,
} from "./voice-call-ack-guard.js"
import {
  isExplicitVoicePrescreenRequest,
  resolveVoicePrescreenRole,
  voicePrescreenRoleClarificationText,
} from "./voice-prescreen-request-router.js"
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
import type { ClaireLang, ClaireToolContext } from "./types.js"
import { YC_MATCH_DELIVERY_WHEN } from "@pa/pa-orchestrator"
import {
  resumePendingProfileReadinessPrescreenStart,
  runPreScreenForUser,
  type RunPreScreenResult,
} from "../prescreen-session-start.js"
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

// ── IMAGE-ATTACHMENT DETECTION (BUG A fix, live 2026-06-11 RJcsA285Drcml1kTPZjI) ─────────────────────
// A candidate sent a SCREENSHOT (IMG_7001.PNG) and the résumé-drop path claimed "reading through your
// résumé now 📄", set enrichmentInFlight:true, then ingestCv's parsePdf failed on the PNG bytes →
// `{ok:false, reason:"pdf_parse_failed"}` was only LOGGED → the user got SILENCE forever and the
// in-flight marker stuck true (the resume_parse_completed re-entry — the only CLEAR site — never fires
// on a failed parse). The Sendblue media URL carries the original FILENAME, so the extension is an
// EXISTING structural signal (mime/filename branch, NOT content sniffing / NOT text→enum regex): branch
// BEFORE making any résumé claim. ingestCv has no image/OCR path — parsing an image can never succeed.
const IMAGE_ATTACHMENT_EXTENSIONS = [
  ".png", ".jpg", ".jpeg", ".gif", ".heic", ".heif", ".webp", ".bmp", ".tiff", ".tif",
] as const
export function isImageAttachmentUrl(url: string): boolean {
  const u = (url || "").trim()
  if (!u) return false
  let pathname: string
  try {
    pathname = new URL(u).pathname.toLowerCase()
  } catch {
    return false
  }
  return IMAGE_ATTACHMENT_EXTENSIONS.some((ext) => pathname.endsWith(ext))
}

/** Honest reply for an image-only drop — never pretend to read a résumé out of a screenshot. */
export const IMAGE_ATTACHMENT_REPLY =
  "heads up — that came through as an image, and i can't read those yet 😅 if it's your résumé, send the actual file (PDF) or a link to it. if you're showing me something on your screen, just tell me what it says and i'll help"

/** Real reply when an attempted résumé ingest fails (instead of the old silent log-and-drop). */
export const RESUME_INGEST_FAILURE_REPLY =
  "hmm — that didn't read as a résumé on my side 😅 can you send the file itself (PDF) or a link to it? if you meant to share something else, just tell me what's up"

type RuntimeSmsSender = (args: {
  to: string
  content: string
  userId?: string
  db?: Firestore
  runtimeSource?: string
  idempotencyKey?: string
}) => Promise<unknown>

// ingestCv reasons that ALREADY message the candidate themselves (enqueueLimitRejection's Claire-voice
// rejection iMessage) — sending our fallback on top would double-text. Every OTHER failure reason
// (download_failed / pdf_parse_failed / llm_parse_failed / firestore_write_failed / a throw) was
// previously fully silent and gets the fallback reply.
const SELF_MESSAGING_INGEST_REJECT_REASONS = new Set(["not_invited", "quota_exhausted", "pdf_too_large"])

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
  /**
   * Test seam (website role-context entry): override the prescreen start fired when a
   * resume_parse_completed event carries context.websiteEntry=true + jobIdContext, so tests can
   * assert the §2.6.4 screen-first routing without bootstrapping a real prescreen config.
   * Production omits it → the real runPreScreenForUser (which owns the §2.6.3 readiness hold).
   */
  runPreScreenOverride?: (a: {
    jobId: string
    userId: string
    toE164: string
    allowMatchedBypass: boolean
  }) => Promise<RunPreScreenResult>
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
  // OUTBOUND IDEMPOTENCY SCOPE — silent-drop regression fix (2026-06-07).
  // The resume_parse_completed re-entry eventId is DETERMINISTIC: sha256 over
  // `cv-parsed:<user>:<session>:<résumé-sha>` (cv-ingest.ts) → the SAME résumé in the SAME session
  // re-fires under the SAME eventId on a later day. Runtime event docs are EPHEMERAL (deleted after
  // processing, so they legitimately re-fire), but pa-outbound rows are DURABLE. The pitch turn's
  // confirmation + offer bubbles are TEMPLATED (byte-identical across runs), so their outbound key
  // `claire-reply-<eventId>:<bodyHash>` collided with a PRIOR day's `sent` row → enqueueOutbound saw
  // ALREADY_EXISTS → SILENTLY DROPPED them (only the LLM-composed pitch body, which varies, survived —
  // the live "pitch sent, no closer" bug on +14243201960). Fold the per-PARSE resumeId (fresh per parse
  // — cv-ingest writes a new parsedCandidateResumes doc each run) into the idempotency scope so a
  // genuinely-new pitch turn never collides with a stale ledger row, while a true within-turn retry
  // (same resumeId) still dedups. Empty resumeId → fall back to eventId (no behaviour change).
  const postParseResumeId =
    cvParsedReentry && typeof handoffContext.resumeId === "string"
      ? handoffContext.resumeId.trim()
      : ""
  const pitchTurnScope = postParseResumeId ? `${eventId}:cv:${postParseResumeId}` : eventId
  if (rawMeta.runtimeEvent === true && !cvParsedReentry) {
    log("thin_claire.defer_runtime_event", {
      eventId,
      userId,
      source: typeof rawMeta.runtimeEventSource === "string" ? rawMeta.runtimeEventSource : undefined,
      kind: runtimeEventKind,
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

  if (cvParsedReentry) {
    log("thin_claire.cv_parsed_reentry", { eventId, userId })
    // WS-1(b): the resume_parse_completed event = enrichment FINISHED. Clear before checking pending
    // prescreen starts so the continuation cannot loop back into another readiness hold.
    await clearEnrichmentInFlight(db, userId, new Date().toISOString()).catch(() => {})

    if (isClaireEntryUxCanary(userId)) {
      const dryRunPrescreenSender: RuntimeSmsSender | undefined = deps.dryRun
        ? async ({ to, content }) => {
            const transport = createSendblueTransport({
              db,
              toE164: to,
              inboundMessageHandle,
              userId,
              sessionId,
              inboundEventId: pitchTurnScope,
              log,
              dryRun: true,
            })
            return transport.sendText(content, { seq: 0 })
          }
        : undefined
      const pendingStart = await resumePendingProfileReadinessPrescreenStart({
        db,
        userId,
        occurredAt: new Date().toISOString(),
        ...(dryRunPrescreenSender ? { sendSms: dryRunPrescreenSender } : {}),
        log,
      })
      if (pendingStart.attempted) {
        await db
          .collection(PA_COLLECTIONS.inboundEvents)
          .doc(eventId)
          .set(
            {
              status: "completed",
              handledBy: "thin_claire_pending_prescreen_start",
              pendingPrescreenStart: {
                jobId: pendingStart.jobId ?? null,
                ok: pendingStart.result?.ok ?? null,
                reason: pendingStart.result?.reason ?? null,
                sessionId: pendingStart.result?.sessionId ?? null,
              },
            },
            { merge: true },
          )
          .catch(() => {})
        log("thin_claire.pending_prescreen_start.handled", {
          eventId,
          userId,
          jobId: pendingStart.jobId,
          ok: pendingStart.result?.ok,
          reason: pendingStart.result?.reason,
        })
        return true
      }

      // ── WEBSITE ROLE-CONTEXT ENTRY (ENTRY-UX PRD §2.4 / §2.6.4) ──────────────────────────────────
      // The website producer (website-entry/website-entry-event.ts) emits this SAME
      // resume_parse_completed kind with context.websiteEntry=true — and jobIdContext when the entry
      // came from a job page / market card. A ROLE-context completion starts the SCREEN directly: Q1,
      // never the general pitch first (§2.6.4 "she does not send the general candidate pitch before
      // Q1"). The EXISTING start path owns everything hard: already_completed / start_in_progress
      // dedupe, the §2.6.3 readiness hold, the config-missing notice, supersede. Job-page entry is
      // self-authorizing (the candidate authenticated AS this user on the website and clicked THIS
      // job) → matched-gate bypass, mirroring the WeKruit_<jobId>_<userId>_Job string-token rule.
      // FAIL-OPEN: a start error falls through to the pitch engine below — the candidate still gets
      // the pitch turn rather than silence.
      const websiteEntryJobId =
        handoffContext.websiteEntry === true && typeof handoffContext.jobIdContext === "string"
          ? handoffContext.jobIdContext.trim()
          : ""
      if (websiteEntryJobId && toE164) {
        try {
          // RESUME, DON'T RESTART (ENTRY-UX PRD §2.4 / §2.6.3 safe-fallback) — if a screen for this
          // exact (user, job) is ALREADY ACTIVE (e.g. the candidate used the hold's "just reply and
          // i'll start" safe-fallback continue, or a completion event re-fired), starting again would
          // supersede the live session and send a SECOND Q1. Same query shape as the supersede /
          // matched-gate arms (equality only — no composite-index dependency). Fail-open: a read
          // error falls through to the normal start (already_completed / start-lock still guard).
          let alreadyActiveSessionId: string | null = null
          try {
            const activeSnap = await db
              .collection("pa-prescreen-sessions")
              .where("userId", "==", userId)
              .where("jobId", "==", websiteEntryJobId)
              .where("terminal", "==", null)
              .limit(1)
              .get()
            if (!activeSnap.empty) alreadyActiveSessionId = activeSnap.docs[0]!.id
          } catch {
            /* fail-open — proceed to the normal start path */
          }
          if (alreadyActiveSessionId) {
            await db
              .collection(PA_COLLECTIONS.inboundEvents)
              .doc(eventId)
              .set(
                {
                  status: "completed",
                  handledBy: "thin_claire_website_entry_prescreen",
                  websiteEntryPrescreen: {
                    jobId: websiteEntryJobId,
                    ok: true,
                    reason: "already_active",
                    sessionId: alreadyActiveSessionId,
                  },
                },
                { merge: true },
              )
              .catch(() => {})
            log("thin_claire.website_entry.prescreen_already_active", {
              eventId,
              userId,
              jobId: websiteEntryJobId,
              sessionId: alreadyActiveSessionId,
            })
            return true
          }
          const runStart =
            deps.runPreScreenOverride ??
            ((a: { jobId: string; userId: string; toE164: string; allowMatchedBypass: boolean }) =>
              runPreScreenForUser({
                db,
                ...a,
                ...(dryRunPrescreenSender ? { sendSms: dryRunPrescreenSender } : {}),
                log,
              }))
          const startResult = await runStart({
            jobId: websiteEntryJobId,
            userId,
            toE164: String(toE164),
            allowMatchedBypass: true,
          })
          await db
            .collection(PA_COLLECTIONS.inboundEvents)
            .doc(eventId)
            .set(
              {
                status: "completed",
                handledBy: "thin_claire_website_entry_prescreen",
                websiteEntryPrescreen: {
                  jobId: websiteEntryJobId,
                  ok: startResult.ok,
                  reason: startResult.reason ?? null,
                  sessionId: startResult.sessionId ?? null,
                },
              },
              { merge: true },
            )
            .catch(() => {})
          log("thin_claire.website_entry.prescreen_start", {
            eventId,
            userId,
            jobId: websiteEntryJobId,
            ok: startResult.ok,
            reason: startResult.reason,
          })
          return true
        } catch (err) {
          // Fall through to the pitch engine — never strand the completion event in silence.
          log("thin_claire.website_entry.prescreen_start_error", {
            eventId,
            userId,
            jobId: websiteEntryJobId,
            err: err instanceof Error ? err.message : String(err),
          })
        }
      }
    }
  }

  // ── RÉSUMÉ-INGEST FAILURE HANDLER (BUG A fix, 2026-06-11) ───────────────────────────────────────────
  // Shared by BOTH fire-and-forget ingest sites (merge-accept + immediate-ingest). A failed/empty parse
  // must (1) ALWAYS clear the enrichmentInFlight marker — the resume_parse_completed re-entry (the normal
  // CLEAR site) never fires on failure, so the marker otherwise sticks true and later turns keep saying
  // "still pulling your info, one sec 🔎" — and (2) send the candidate a REAL reply instead of silence
  // (unless ingestCv already messaged them via its own limit-rejection runtime event). try/finally
  // semantics: the marker clear runs FIRST and unconditionally; the reply is best-effort after it.
  const handleResumeIngestFailure = async (reason: string): Promise<void> => {
    await clearEnrichmentInFlight(db, userId, new Date().toISOString()).catch(() => {})
    if (SELF_MESSAGING_INGEST_REJECT_REASONS.has(reason) || !toE164) {
      log("thin_claire.resume_ingest.failure_no_fallback", { eventId, userId, reason })
      return
    }
    try {
      const failTransport = createSendblueTransport({
        db,
        toE164: String(toE164),
        inboundMessageHandle,
        userId,
        sessionId,
        inboundEventId: eventId,
        log,
        ...(deps.dryRun ? { dryRun: true } : {}),
      })
      await failTransport.sendText(RESUME_INGEST_FAILURE_REPLY, { seq: 0 })
      log("thin_claire.resume_ingest.fallback_sent", { eventId, userId, reason })
    } catch (err) {
      log("thin_claire.resume_ingest.fallback_send_failed", {
        eventId,
        userId,
        reason,
        err: err instanceof Error ? err.message : String(err),
      })
    }
  }
  /** Attach the failure handler to an ingest promise: {ok:false} AND throws both route through it. */
  const withIngestFailureHandling = (chain: Promise<unknown>, site: string): Promise<unknown> =>
    chain.then(
      async (r) => {
        log(`thin_claire.${site}.done`, { eventId, userId, result: r })
        const ok = Boolean(r && typeof r === "object" && (r as { ok?: unknown }).ok === true)
        if (!ok) {
          const reason = String(
            (r && typeof r === "object" ? (r as { reason?: unknown }).reason : undefined) ?? "unknown",
          )
          await handleResumeIngestFailure(reason)
        }
        return r
      },
      async (e) => {
        log(`thin_claire.${site}.failed`, {
          eventId,
          userId,
          err: e instanceof Error ? e.message : String(e),
        })
        await handleResumeIngestFailure("ingest_threw")
        return undefined
      },
    )

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
          // BUG A fix (2026-06-11): route the settle through the shared failure handler so a failed
          // merge-ingest clears enrichmentInFlight + replies, instead of the old log-only silence.
          void withProgressHeartbeat(
            withIngestFailureHandling(
              Promise.resolve(
                runIngest(
                  { userId, mediaUrl: pending.mediaUrl, sessionId: pending.sessionId ?? sessionId },
                  { skipLimitEnforcement: true },
                ),
              ),
              "merge_confirm.ingest",
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
  // DEDICATED YC LANE (Adam-LOCKED 2026-07-23): a YC Startup School person is NEVER job-pitched
  // (they may be an investor). This runs through the SAME composePitchTurn path below — that
  // composer self-detects the yc flags (compose-pitch.ts ycPosture) and produces a PEOPLE-framed
  // turn: a "here's what stands out" reaction (Adam 2026-07-23 "where's the short pitch?"), then
  // the pool promise + the NEXT unanswered intake question ("what are you building?" / "who do you
  // want to meet?"), and no attendee list or timing promise.
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
          inboundEventId: pitchTurnScope,
          log,
          ...(deps.dryRun ? { dryRun: true } : {}),
        })
        // ORDER + REASONING BEAT (Adam 2026-06-04): bubbles are [confirmation, pitch, offer] and MUST land
        // in THAT order — the offer comes AFTER the pitch. Do NOT use paced:true: the outbox's
        // length-proportional typing dwell made the SHORT offer overtake the LONG pitch (live "offer before
        // pitch" bug). Instead send each with an explicit typing indicator + sleep between, so createdAt
        // order holds AND the pitch gets a real ~10s "thinking" beat (Adam: "make it at least 10 seconds";
        // 3s felt like no reasoning).
        // YC EVENT FIRST-TOUCH (Adam 2026-07-22 "if this is slow this is really bad"): the
        // LinkedIn-connect pitch is the event user's first real exchange — cut the beats
        // (10s→2.5s, 2.5s→1.2s). Order still holds (beats + per-bubble dwell keep sequence).
        let ycEventFastPitch = false
        try {
          const u = (await db.collection(PA_COLLECTIONS.users).doc(userId).get()).data() ?? {}
          // Shared predicate (was a hand-rolled 2-of-3 copy that omitted `source`) — one
          // definition, so narrowed copies can't get cargo-culted from here.
          ycEventFastPitch = isYcPeopleUser(u)
        } catch { /* fail-open → standard beats */ }
        const pitchBeatMs = ycEventFastPitch ? 2500 : 10000
        const offerBeatMs = ycEventFastPitch ? 1200 : 2500
        await transport.sendText(bubbles[0]!, { seq: 0 }) // confirmation — immediate
        try { await transport.typing() } catch { /* typing is pure UX */ }
        if (!deps.dryRun) await new Promise((r) => setTimeout(r, pitchBeatMs)) // reasoning beat before the pitch
        await transport.sendText(bubbles[1]!, { seq: 1 }) // the PITCH
        if (bubbles[2]) {
          try { await transport.typing() } catch { /* typing is pure UX */ }
          if (!deps.dryRun) await new Promise((r) => setTimeout(r, offerBeatMs)) // short beat, THEN the offer
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
          inboundEventId: pitchTurnScope,
          log,
          ...(deps.dryRun ? { dryRun: true } : {}),
        })
        // YC people-matching users NEVER get "pull roles" (Adam-LOCKED 2026-07-23 — investors
        // sign up too). Read the yc flags (fail-open) and pick people-promise copy instead.
        let ycFallback = false
        try {
          const u = (await db.collection(PA_COLLECTIONS.users).doc(userId).get()).data() ?? {}
          ycFallback = isYcPeopleUser(u)
        } catch { /* fail-open → standard copy */ }
        const fbBody = ycFallback
          ? `got it — you're in the founder-match pool 🤝 your matches (people worth meeting) come on ${YC_MATCH_DELIVERY_WHEN}, and i'll text you right here. anything you want me to know before then?`
          : "got your résumé — your profile's updated 🙌 want me to pull roles that fit now, or tweak/add anything first?"
        await fbTransport
          .sendText(fbBody, { seq: 0 })
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

  // ── IMAGE ATTACHMENT — never enters the résumé pipeline (BUG A fix, 2026-06-11) ────────────────────
  // The filename extension on the Sendblue media URL is an existing structural signal: a .PNG/.JPG/etc
  // can NEVER parse (ingestCv is parsePdf-only), so don't claim "reading your résumé", don't set the
  // in-flight marker, don't fire ingestCv. Image-ONLY drop → deterministic honest reply + stop (mirrors
  // the resume-ack shape). Image WITH a real caption → skip ingest, let the agent answer the text.
  const mediaIsImageAttachment = Boolean(inboundMediaUrl) && isImageAttachmentUrl(inboundMediaUrl)
  if (mediaIsImageAttachment) {
    log("thin_claire.image_attachment.detected", { eventId, userId, mediaUrl: inboundMediaUrl })
  }
  if (mediaIsImageAttachment && !hasRealUserText(text) && toE164 && isCanaryUser(userId)) {
    try {
      const imgTransport = createSendblueTransport({
        db,
        toE164: String(toE164),
        inboundMessageHandle,
        userId,
        sessionId,
        inboundEventId: eventId,
        log,
        ...(deps.dryRun ? { dryRun: true } : {}),
      })
      await imgTransport.sendText(IMAGE_ATTACHMENT_REPLY, { seq: 0 })
      await db
        .collection(PA_COLLECTIONS.inboundEvents)
        .doc(eventId)
        .set({ status: "completed", handledBy: "thin_claire_image_attachment_ack" }, { merge: true })
      log("thin_claire.image_attachment.ack_sent", { eventId, userId })
      return true
    } catch (err) {
      // Fail-open: an ack error falls through to the agent path (still never the résumé pipeline).
      log("thin_claire.image_attachment.ack_error", {
        eventId,
        userId,
        err: err instanceof Error ? err.message : String(err),
      })
    }
  }

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
  if (inboundMediaUrl && !mediaIsImageAttachment && !hasRealUserText(text) && toE164 && isCanaryUser(userId)) {
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

  if (inboundMediaUrl && !mediaIsImageAttachment) {
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
    // BUG A fix (2026-06-11): route the settle through the shared failure handler — a failed/empty
    // parse must clear enrichmentInFlight + send a real reply instead of the old log-only silence
    // (live: a screenshot ingested as a résumé died on parsePdf → silence + a forever-stuck marker).
    const ingestChain = withIngestFailureHandling(
      Promise.resolve(
        runImmediateIngest(
          { userId, mediaUrl: inboundMediaUrl, sessionId },
          { skipLimitEnforcement: true },
        ),
      ),
      "resume_ingest",
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
  // to the deterministic "still pulling" mode-selector ack — the live 2026-06-05 bug). Image attachments
  // never reach here (the image branch above replied honestly instead of claiming a résumé read).
  if (inboundMediaUrl && !mediaIsImageAttachment && !hasRealUserText(text) && toE164 && isCanaryUser(userId)) {
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

  // ── PRESCREEN SAFE-FALLBACK CONTINUE (ENTRY-UX PRD §2.6.3) ─────────────────────────────────────────
  // The readiness hold promises a candidate-visible exit ("if you'd rather not wait, just reply and
  // i'll start the screen right away"). A candidate TEXT arriving while pendingPrescreenStart is still
  // waiting_profile IS that explicit continue — resume the pending start NOW (the resume path sets
  // skipProfileReadinessHold, so Q1 fires on whatever evidence already landed) instead of stranding
  // them until a completion event that may have been lost, or the 3-min TTL + a re-paste. Entry-UX
  // canary only; fail-open — any error falls through to the normal turn (never silence).
  if (
    toE164 &&
    hasRealUserText(text) &&
    !inboundMediaUrl &&
    rawMeta.runtimeEvent !== true &&
    isClaireEntryUxCanary(userId)
  ) {
    try {
      const uSnap = await db.collection(PA_COLLECTIONS.users).doc(userId).get()
      const pendingRaw = (uSnap.data() ?? {}) as Record<string, unknown>
      const pending = pendingRaw.pendingPrescreenStart
      const waitingProfile =
        Boolean(pending) &&
        typeof pending === "object" &&
        !Array.isArray(pending) &&
        (pending as { status?: unknown }).status === "waiting_profile"
      if (waitingProfile) {
        const fallbackDryRunSender: RuntimeSmsSender | undefined = deps.dryRun
          ? async ({ to, content }) => {
              const transport = createSendblueTransport({
                db,
                toE164: to,
                inboundMessageHandle,
                userId,
                sessionId,
                inboundEventId: eventId,
                log,
                dryRun: true,
              })
              return transport.sendText(content, { seq: 0 })
            }
          : undefined
        const resumed = await resumePendingProfileReadinessPrescreenStart({
          db,
          userId,
          occurredAt: new Date().toISOString(),
          ...(fallbackDryRunSender ? { sendSms: fallbackDryRunSender } : {}),
          log,
        })
        if (resumed.attempted) {
          await db
            .collection(PA_COLLECTIONS.inboundEvents)
            .doc(eventId)
            .set(
              {
                status: "completed",
                handledBy: "thin_claire_prescreen_safe_fallback_start",
                pendingPrescreenStart: {
                  jobId: resumed.jobId ?? null,
                  ok: resumed.result?.ok ?? null,
                  reason: resumed.result?.reason ?? null,
                  sessionId: resumed.result?.sessionId ?? null,
                },
              },
              { merge: true },
            )
            .catch(() => {})
          log("thin_claire.prescreen_safe_fallback_start", {
            eventId,
            userId,
            jobId: resumed.jobId,
            ok: resumed.result?.ok,
            reason: resumed.result?.reason,
          })
          return true
        }
      }
    } catch (sfErr) {
      // Fail-open: a safe-fallback read/resume error must never block the turn.
      log("thin_claire.prescreen_safe_fallback_error", {
        eventId,
        userId,
        err: sfErr instanceof Error ? sfErr.message : String(sfErr),
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

  // ── ENRICHMENT HOLD, DETERMINISTIC + ONCE-ONLY (ENTRY-UX PRD §2.3.6) ───────────────────────────────
  // A candidate texting "hi" / "what now?" / their first Talk-to-Claire message while their résumé
  // parse or LinkedIn/Coresignal import is still running gets ONE short deterministic progress line —
  // not an agent turn pitching from incomplete data, and not a fresh hold on every message. Once-only
  // per enrichment window via the claimEnrichmentHoldNotice stamp (the heartbeat once-only convention);
  // a SECOND mid-enrich message falls through to the agent, which still carries the softer
  // enrichmentInFlight directive (existing behavior — nobody is left in silence). The completion event
  // (resume_parse_completed) then resumes: pitch turn for general entry, Q1 for a pending role start.
  // decision.enrichmentInFlight is already entry-UX-canary-gated in mode-selector; the explicit gate
  // here is belt-and-braces so this deterministic send can never ride a wider ramp.
  if (
    decision.enrichmentInFlight === true &&
    // TRIAGE turns only: an ACTIVE-onboarding user mid-enrich keeps the existing agent decision
    // (ack + the pending onboarding question ride together — mode-selector's documented behavior).
    decision.mode === "triage" &&
    toE164 &&
    hasRealUserText(text) &&
    !inboundMediaUrl &&
    rawMeta.runtimeEvent !== true &&
    isClaireEntryUxCanary(userId)
  ) {
    try {
      const claimed = await claimEnrichmentHoldNotice(db, userId, new Date().toISOString())
      if (claimed) {
        const holdTransport = createSendblueTransport({
          db,
          toE164: String(toE164),
          inboundMessageHandle,
          userId,
          sessionId,
          inboundEventId: eventId,
          log,
          ...(deps.dryRun ? { dryRun: true } : {}),
        })
        // Transient "one sec" bubble → sendStatus (same seam as the progress heartbeat).
        await holdTransport.sendStatus(ENRICHMENT_HOLD_NOTICE_COPY)
        await db
          .collection(PA_COLLECTIONS.inboundEvents)
          .doc(eventId)
          .set({ status: "completed", handledBy: "thin_claire_enrichment_hold" }, { merge: true })
          .catch(() => {})
        log("thin_claire.enrichment_hold.sent", { eventId, userId })
        return true
      }
      log("thin_claire.enrichment_hold.already_sent_fallthrough", { eventId, userId })
    } catch (err) {
      // Fail-open: a hold error must never block the turn — the agent path still answers.
      log("thin_claire.enrichment_hold.error", {
        eventId,
        userId,
        err: err instanceof Error ? err.message : String(err),
      })
    }
  }

  // RECOGNIZED-CANDIDATE TEXT PITCH (Adam 2026-06-08): an enriched candidate (résumé-upload / LinkedIn)
  // who TEXTS in for the first time hits mode.recognized_no_onboarding_wall → postParsePitch — but that
  // only reached the chat AGENT, which gave a light "welcome back, want roles?" and went STRAIGHT to recs,
  // never the trust-vehicle PITCH (live: darsh +18573982370, pitchedAt NEVER). The dedicated 3-bubble
  // composePitchTurn engine previously fired ONLY on the cv-parsed re-entry. Fire it here too for a text
  // opener so a recognized-but-never-pitched candidate gets the real pitch BEFORE recs (canonical flow).
  // ONCE-ONLY: gated on !pitchedAt (composePitchTurn stamps pitchedAt + onboarding complete, and the
  // mode-selector recognized path only fires while !onboardingComplete). FAIL-OPEN: a composer miss /
  // error falls through to the agent path below (the existing greeting) — no regression. Canary-gated.
  if (decision.postParsePitch === true && toE164 && isCanaryUser(userId) && !cvParsedReentry) {
    try {
      const uSnap = await db.collection(PA_COLLECTIONS.users).doc(userId).get()
      const alreadyPitched = Boolean((uSnap.data() as { pitchedAt?: unknown } | undefined)?.pitchedAt)
      if (!alreadyPitched) {
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
          await transport.sendText(bubbles[0]!, { seq: 0 }) // confirmation
          try { await transport.typing() } catch { /* typing is pure UX */ }
          if (!deps.dryRun) await new Promise((r) => setTimeout(r, 10000)) // 10s reasoning beat before the pitch
          await transport.sendText(bubbles[1]!, { seq: 1 }) // the PITCH
          if (bubbles[2]) {
            try { await transport.typing() } catch { /* typing is pure UX */ }
            if (!deps.dryRun) await new Promise((r) => setTimeout(r, 2500))
            await transport.sendText(bubbles[2]!, { seq: 2 }) // the OFFER — after the pitch
          }
          await db
            .collection(PA_COLLECTIONS.inboundEvents)
            .doc(eventId)
            .set({ status: "completed", handledBy: "thin_claire_text_pitch" }, { merge: true })
          log("thin_claire.text_pitch.sent", { eventId, userId, bubbles: bubbles.length })
          return true
        }
        log("thin_claire.text_pitch.fallthrough", { eventId, userId })
      }
    } catch (err) {
      log("thin_claire.text_pitch.error", {
        eventId,
        userId,
        err: err instanceof Error ? err.message : String(err),
      })
    }
  }

  // ── EXPLICIT PHONE PRESCREEN REQUEST ─────────────────────────────────────────────────────────────
  // A message like "I want to prescreen Sekai AI Agent Engineer on phone call" is NOT a matching
  // request and must NOT enter begin_collab_prescreen directly. The required call contract is:
  // resolve the exact matched role -> send the "can I call you now?" offer -> wait for a later yes.
  // Handle this before the LLM can send a premature "starting..." status or pass a guessed jobId into
  // the text-prescreen starter. Dev-phone-only while the voice lane is under validation.
  if (
    toE164 &&
    hasRealUserText(text) &&
    !inboundMediaUrl &&
    rawMeta.runtimeEvent !== true &&
    isClaireVoiceDevPhone(String(toE164)) &&
    isExplicitVoicePrescreenRequest(text)
  ) {
    try {
      const { loadCandidateRoles } = await import("./tools/matching-tools.js")
      const { offerVoiceCallNow } = await import("./tools/voice-call-tools.js")
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
      const roles = await loadCandidateRoles(db, userId, log)
      const resolution = resolveVoicePrescreenRole(text, roles)
      if (resolution.kind !== "one") {
        await transport.sendText(voicePrescreenRoleClarificationText(resolution), { seq: 0 })
        await db
          .collection(PA_COLLECTIONS.inboundEvents)
          .doc(eventId)
          .set(
            {
              status: "completed",
              handledBy: "thin_claire_voice_prescreen_role_clarifier",
              voicePrescreenRequest: { resolution: resolution.kind },
            },
            { merge: true },
          )
        log("thin_claire.voice_prescreen.role_clarifier_sent", {
          eventId,
          userId,
          resolution: resolution.kind,
          roleCount: resolution.roles.length,
        })
        return true
      }

      const ctx: ClaireToolContext = {
        db,
        userId,
        sessionId,
        lang,
        transport,
        judgeModel: "gpt-5.4-mini",
        toE164: String(toE164),
        log,
        nowIso: () => new Date().toISOString(),
      }
      const offered = await offerVoiceCallNow(ctx, { purpose: "prescreen", jobId: resolution.role.jobId })
      if (offered.delivered) {
        await db
          .collection(PA_COLLECTIONS.inboundEvents)
          .doc(eventId)
          .set(
            {
              status: "completed",
              handledBy: "thin_claire_voice_prescreen_offer",
              voicePrescreenRequest: {
                resolution: "one",
                jobId: resolution.role.jobId,
                offerOk: offered.ok,
                reason: offered.ok ? null : offered.reason,
              },
            },
            { merge: true },
          )
        log("thin_claire.voice_prescreen.offer_sent", {
          eventId,
          userId,
          jobId: resolution.role.jobId,
          ok: offered.ok,
          reason: offered.ok ? null : offered.reason,
        })
        return true
      }
      log("thin_claire.voice_prescreen.offer_not_delivered", {
        eventId,
        userId,
        jobId: resolution.role.jobId,
        reason: offered.reason,
      })
    } catch (err) {
      log("thin_claire.voice_prescreen.router_error", {
        eventId,
        userId,
        err: err instanceof Error ? err.message : String(err),
      })
    }
  }

  const voiceCallConfirmation = parseLowInfoCallConfirmation(text)
  if (
    toE164 &&
    hasRealUserText(text) &&
    !inboundMediaUrl &&
    rawMeta.runtimeEvent !== true &&
    isClaireVoiceDevPhone(String(toE164)) &&
    voiceCallConfirmation !== null
  ) {
    let attemptedVoiceOfferResolve = false
    let voiceOfferTransport: { sendText: (body: string, opts?: { seq?: number }) => Promise<unknown> } | null = null
    try {
      const {
        hasPendingVoiceCallOffer,
        resolveVoiceCallOfferNow,
      } = await import("./tools/voice-call-tools.js")
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
      voiceOfferTransport = transport
      const ctx: ClaireToolContext = {
        db,
        userId,
        sessionId,
        lang,
        transport,
        judgeModel: "gpt-5.4-mini",
        toE164: String(toE164),
        log,
        nowIso: () => new Date().toISOString(),
      }
      if (await hasPendingVoiceCallOffer(ctx)) {
        attemptedVoiceOfferResolve = true
        const resolved = await resolveVoiceCallOfferNow(ctx, { confirmed: voiceCallConfirmation })
        if (!resolved.delivered) {
          await transport.sendText("I couldn't start that call from this reply. We can keep it over text for now.")
        }
        await db
          .collection(PA_COLLECTIONS.inboundEvents)
          .doc(eventId)
          .set(
            {
              status: "completed",
              handledBy: "thin_claire_voice_call_offer_resolved",
              voiceCallOfferResolution: {
                confirmed: voiceCallConfirmation,
                ok: resolved.ok,
                reason: "reason" in resolved ? resolved.reason : null,
                offerId: "offerId" in resolved ? resolved.offerId : null,
                bookingId: "bookingId" in resolved ? resolved.bookingId : null,
              },
            },
            { merge: true },
          )
        log("thin_claire.voice_call_offer.resolved", {
          eventId,
          userId,
          confirmed: voiceCallConfirmation,
          ok: resolved.ok,
          reason: "reason" in resolved ? resolved.reason : null,
        })
        return true
      }
    } catch (err) {
      log("thin_claire.voice_call_offer.resolve_error", {
        eventId,
        userId,
        err: err instanceof Error ? err.message : String(err),
      })
      if (attemptedVoiceOfferResolve) {
        if (voiceOfferTransport) {
          await voiceOfferTransport.sendText("I couldn't start that call from this reply. We can keep it over text for now.")
        }
        await db
          .collection(PA_COLLECTIONS.inboundEvents)
          .doc(eventId)
          .set(
            {
              status: "completed",
              handledBy: "thin_claire_voice_call_offer_resolve_error",
              voiceCallOfferResolution: {
                confirmed: voiceCallConfirmation,
                ok: false,
                reason: "resolve_error",
              },
            },
            { merge: true },
          )
        return true
      }
    }
  }

  if (toE164 && hasRealUserText(text)) {
    try {
      const recentAssistantMessages = await getRecentSentMessages(
        { db, userId, sessionId },
        3,
      )
      if (shouldHoldVoiceCallAckFromMatching(text, recentAssistantMessages)) {
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
        const reply = buildVoiceCallAckClarifier(recentAssistantMessages)
        await transport.sendText(reply)
        await db
          .collection(PA_COLLECTIONS.inboundEvents)
          .doc(eventId)
          .set({ status: "completed", handledBy: "thin_claire_voice_ack_clarifier" }, { merge: true })
        log("thin_claire.voice_ack_clarifier.sent", { eventId, userId })
        return true
      }
    } catch (err) {
      log("thin_claire.voice_ack_clarifier.error", {
        eventId,
        userId,
        err: err instanceof Error ? err.message : String(err),
      })
    }
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
        // SPEC §6/§7 — cross-session shared-answer write key + provenance jobId + carry-over reference hooks.
        ...(decision.prescreenJobId ? { prescreenJobId: decision.prescreenJobId } : {}),
        ...(decision.prescreenSharedKeys ? { prescreenSharedKeys: decision.prescreenSharedKeys } : {}),
        ...(decision.prescreenCarriedReferences
          ? { prescreenCarriedReferences: decision.prescreenCarriedReferences }
          : {}),
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
        // ENTRY POSTURE (Adam 2026-07-20): entry-page tone overlay (yc_startup_school = founder-scene
        // chat, no pushing, notify-on-match promise). Set by mode-selector from pa-users.source.
        ...(decision.entryPosture ? { entryPosture: decision.entryPosture } : {}),
        // YC EVENT INTAKE (Adam 2026-07-21): event-QR guided mini-intake directive (LinkedIn offer +
        // building/wants-to-meet questions + the no-timing match close). Present until
        // pa-users.ycIntake.completedAt is stamped by record_yc_intake.
        ...(decision.ycEventIntake ? { ycEventIntake: decision.ycEventIntake } : {}),
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

    // ONE-SHOT LINKEDIN NUDGE STAMP — written HERE (after the turn actually delivered),
    // never in selectMode: selection runs more than once per inbound (defer pass + owner
    // pass) and a selection-time stamp let the preview pass consume the one-shot before
    // the reply (live probe 2026-07-22). Fail-open: a stamp miss risks one repeat nudge,
    // never a lost turn.
    if (decision.ycEventIntake?.nudgeLinkedin) {
      try {
        await db
          .collection(PA_COLLECTIONS.users)
          .doc(userId)
          .set({ ycIntake: { linkedinNudgedAt: new Date().toISOString() } }, { merge: true })
        log("thin_claire.yc_linkedin_nudge_stamped", { eventId, userId })
      } catch (err) {
        log("thin_claire.yc_linkedin_nudge_stamp_failed", { eventId, userId, error: String(err) })
      }
    }

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
        servedByModel: trace.servedByModel,
        errorCode: trace.errorCode,
      })
    } catch (traceErr) {
      log("thin_claire.turn_trace_failed", {
        eventId,
        err: traceErr instanceof Error ? traceErr.message : String(traceErr),
      })
    }
    // ── PERSIST USER MESSAGE TO pa-messages (2026-06-18) ────────────────────────────
    // The thin path skips processInboundEvent → user messages never reach pa-messages →
    // the conversation extractor sees assistant-only transcripts → skills/yoeRange/
    // careerStage are never extracted → V16 matching is blind to conversational intent.
    // Write the inbound text as a role:user row so the transcript is complete for the
    // extractor, dashboard, and audit. Idempotent via inbound-event:${eventId} key.
    // Fail-open: a write failure must never block the turn (reply already sent).
    if (hasRealUserText(text)) {
      try {
        const userMsgId = `inbound-event:${eventId}`
        const existing = await db
          .collection(PA_COLLECTIONS.messages)
          .where("idempotencyKey", "==", userMsgId)
          .limit(1)
          .get()
        if (existing.empty) {
          const nowIso = new Date().toISOString()
          await db.collection(PA_COLLECTIONS.messages).doc(eventId).set({
            id: eventId,
            sessionId,
            userId,
            role: "user",
            body: text,
            createdAt: nowIso,
            idempotencyKey: userMsgId,
            rawMeta: { source: "thin_claire_persist", eventId },
          })
          log("thin_claire.user_message_persisted", { eventId, userId })
        }
      } catch (persistErr) {
        log("thin_claire.user_message_persist_failed", {
          eventId,
          err: persistErr instanceof Error ? persistErr.message : String(persistErr),
        })
      }

      // ── RUN CONVERSATION EXTRACTOR (2026-06-18) ──────────────────────────────────
      // Extract skills/yoeRange/careerStage/industrySector from the conversation so
      // V16 matching has structured signals beyond just targetRoleFunction.
      // Fire-and-forget: extractor errors must never block the turn.
      try {
        const { maybeRunExtractor } = await import("@pa/pa-orchestrator")
        const recentSnap = await db
          .collection(PA_COLLECTIONS.messages)
          .where("userId", "==", userId)
          .orderBy("createdAt", "desc")
          .limit(30)
          .get()
        const recentMessages = recentSnap.docs
          .map((d) => {
            const md = d.data() as { role?: string; body?: string; createdAt?: string }
            return {
              role: (md.role === "assistant" ? "assistant" : "user") as "assistant" | "user",
              body: String(md.body ?? ""),
              createdAt: String(md.createdAt ?? ""),
            }
          })
          .filter((m) => m.body.trim().length > 0 && !m.body.startsWith("[system-event:"))
          .reverse()
        if (recentMessages.length > 0) {
          const userSnap = await db.collection(PA_COLLECTIONS.users).doc(userId).get()
          const userData = (userSnap.data() ?? {}) as Record<string, unknown>
          const existingTags = (userData.tags ?? {}) as Record<string, unknown>
          const onboardingState = typeof userData.onboardingState === "string" ? userData.onboardingState : null
          const outcome = await maybeRunExtractor({
            db,
            userId,
            recentMessages,
            existingTags,
            onboardingState,
            userMsgsThisBatch: 1,
            forceTrigger: "intent_signal" as const,
            log: (evt: string, payload?: Record<string, unknown>) => log(`thin_claire.extractor.${evt}`, payload ?? {}),
          })
          log("thin_claire.extractor_result", {
            eventId,
            userId,
            ran: outcome.ran,
            reason: outcome.reason,
            tagFieldsChanged: outcome.tagFieldsChanged,
          })
        }
      } catch (extractErr) {
        log("thin_claire.extractor_failed", {
          eventId,
          userId,
          err: extractErr instanceof Error ? extractErr.message : String(extractErr),
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
