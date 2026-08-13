/**
 * v1.9 Phase 85 — runPiiConfirmForUser.
 *
 * Bootstrap for the PiiConfirmPipeline (3-Q legal name / email / phone)
 * fired AFTER an Apply trigger resolves to a verified-PASS candidate.
 *
 * Reuses iter34 P1 OnboardingPipeline + PiiConfirmPipeline factory.
 * State lives in `pa-pii-confirm-state/{userId}` (separate from onboarding
 * state) so concurrent onboarding doesn't collide.
 *
 * Skip-if-present: caller (Apply trigger handler) MAY short-circuit before
 * this is called by checking pa-users.{uid}.contactPII.consentedAt. We also
 * check here defensively to avoid duplicate collection.
 */

import type { Firestore } from "firebase-admin/firestore"
import { FieldValue } from "firebase-admin/firestore"
import {
  applyPartialUserTags,
  createPiiConfirmPipeline,
  type PiiConfirmAnswers,
} from "@pa/pa-orchestrator"
import type {
  PartialUserTags,
  PipelineState,
  PipelineStateProvider,
} from "@pa/pa-orchestrator"
import { INDUSTRY_SECTOR_VOCAB, type IndustrySector } from "@wekruit/shared-tags"
import { isYcPeopleUser } from "@pa/core-types"
import { sendRuntimeApprovedIMessage } from "./runtime-approved-outbox.js"
import {
  buildJobRecommendationRuntimeContext,
  collectLiveFirestoreJobRecommendationMessageItems,
  compactJobRecContext,
  resolveJobRecVisibleCount,
} from "./job-rec-copy.js"

/** v1.9 — extended state stash for tracking what source the PII flow is for. */
const PII_META_COLL = "pa-pii-confirm-meta"

const PII_STATE_COLL = "pa-pii-confirm-state"
const BETA_CANDIDATE_VISIBLE_LANG = "en" as const

function betaEnglishPiiState(state: PipelineState): PipelineState {
  return { ...state, lang: BETA_CANDIDATE_VISIBLE_LANG }
}

export function composePiiSkipExistingText(source: "fail"): string {
  return "We already have your contact details on file — I’ll text you when a stronger fit comes through."
}

export function buildLevel1TagPatch(level1: PiiConfirmAnswers["level1"] | undefined): PartialUserTags {
  if (!level1) return {}
  const tagPatch: PartialUserTags = {}
  if (level1.yoeRange) tagPatch.yoeRange = level1.yoeRange
  if (level1.visaStatus) {
    // D4 canonicalization (2026-05-28): keep the canonical `permanent_resident`
    // token. The `pa-users.tags.visaStatus` schema accepts it directly; the
    // legacy `gc` downgrade here was the source of non-canonical visa tags.
    tagPatch.visaStatus = level1.visaStatus
  }
  if (level1.targetLocations) tagPatch.targetLocations = level1.targetLocations
  if (level1.minSalaryUsd !== undefined) tagPatch.minSalary = level1.minSalaryUsd
  if (level1.industrySector) {
    // W3 — UserTagsSchema.industrySector is the canonical 42-token enum.
    // Level1Answers.industrySector is still string[] (caller payload), so
    // filter to canonical here to keep non-vocab Level 1 answers from
    // corrupting the user-tag schema.
    const filtered = level1.industrySector.filter(
      (t): t is IndustrySector =>
        typeof t === "string" && (INDUSTRY_SECTOR_VOCAB as readonly string[]).includes(t),
    )
    if (filtered.length > 0) tagPatch.industrySector = filtered
  }
  if (level1.companySize) tagPatch.companySize = level1.companySize
  return tagPatch
}

class FirestorePiiState implements PipelineStateProvider {
  constructor(private readonly db: Firestore) {}
  async load(userId: string): Promise<PipelineState> {
    const snap = await this.db.collection(PII_STATE_COLL).doc(userId).get()
    if (!snap.exists) {
      return {
        currentQId: null,
        collected: {},
        attempts: {},
        halted: null,
        lang: BETA_CANDIDATE_VISIBLE_LANG,
        completed: false,
      }
    }
    return betaEnglishPiiState(snap.data() as PipelineState)
  }
  async save(userId: string, state: PipelineState): Promise<void> {
    await this.db.collection(PII_STATE_COLL).doc(userId).set(betaEnglishPiiState(state), { merge: false })
  }
}

export interface RunPiiConfirmStartArgs {
  db: Firestore
  userId: string
  toE164: string
  jobId: string
  sourceSessionId: string
  /** Runtime language for any post-PII copy or job recommendations. */
  lang?: "zh" | "en"
  /** Frames PII ask copy: "pass" = employer share, "fail" = future matching. */
  source?: "pass" | "fail"
  /**
   * Optional callback fired AFTER PII is fully collected. Use to chain
   * generateJobRecs / other downstream actions per Adam's spec:
   * FAIL/HARD_STOP path = PII confirm + matching.
   */
  onComplete?: (args: { userId: string; toE164: string; jobId: string }) => Promise<void>
  log?: (event: string, payload: Record<string, unknown>) => void
}

export interface RunPiiConfirmStartResult {
  ok: boolean
  skipped: boolean
  reason?: string
}

/**
 * Entry from Apply trigger. Sends the first Q (legal name). Subsequent
 * replies flow through `runPiiConfirmTurnIfActive` (parallel to prescreen
 * turn handler).
 */
export async function runPiiConfirmForUser(
  args: RunPiiConfirmStartArgs
): Promise<RunPiiConfirmStartResult> {
  const log = args.log ?? (() => undefined)

  // Skip-if-present: PII already consented.
  const userSnap = await args.db.collection("pa-users").doc(args.userId).get()

  // YC PEOPLE LANE (Adam-LOCKED 2026-07-24: "we don't wanna ask anything about the job") — this
  // pipeline runs with includeLevel1:true, which appends SIX job-search questions: years of
  // experience, WORK AUTHORIZATION, target location, SALARY floor, industry and company size.
  // They emit through sendRuntimeApprovedIMessage, so neither the bubble scrub nor the job-rec
  // sendImessage backstop covers them. A YC founder/investor must never be asked any of it.
  if (isYcPeopleUser(userSnap.data() ?? {})) {
    log("pii_confirm.yc_people_no_job_questions", { userId: args.userId })
    return { ok: false, skipped: true, reason: "yc_people_no_job_questions" }
  }

  const existing = userSnap.data()?.contactPII as
    | { consentedAt?: string }
    | undefined
  if (existing?.consentedAt) {
    const source = args.source ?? "pass"
    log("pii_confirm.skip_existing", {
      userId: args.userId,
      consentedAt: existing.consentedAt,
      source,
    })
    if (source === "fail") {
      try {
        await sendRuntimeApprovedIMessage({
          to: args.toE164,
          content: composePiiSkipExistingText("fail"),
          userId: args.userId,
          db: args.db,
          runtimeSource: "pa_pii_runtime",
          idempotencyKey: `pii_skip_existing:${args.userId}:${args.jobId}:${args.sourceSessionId}`,
        })
      } catch (err) {
        log("pii_confirm.skip_send_failed", { error: String(err) })
      }
    }
    return { ok: true, skipped: true, reason: "already_consented" }
  }

  // Stash meta so subsequent turn handler knows source + onComplete deps.
  await args.db.collection(PII_META_COLL).doc(args.userId).set({
    source: args.source ?? "pass",
    jobId: args.jobId,
    sourceSessionId: args.sourceSessionId,
    toE164: args.toE164,
    lang: BETA_CANDIDATE_VISIBLE_LANG,
    startedAt: new Date().toISOString(),
  })

  const pipeline = buildPipeline({
    db: args.db,
    userId: args.userId,
    toE164: args.toE164,
    jobId: args.jobId,
    sourceSessionId: args.sourceSessionId,
    source: args.source ?? "pass",
    onComplete: args.onComplete,
    log,
  })

  // Kick off — pipeline emits Q1 prompt
  const result = await pipeline.startTurn({
    userId: args.userId,
    turnId: `pii_start_${Date.now()}`,
    reply: "",
  })
  log("pii_confirm.started", {
    userId: args.userId,
    currentQId: result.currentQId,
    emitted: result.emitted?.slice(0, 80),
  })
  return { ok: true, skipped: false }
}

/** Build the pipeline with the right hooks for both start + turn handlers. */
function buildPipeline(args: {
  db: Firestore
  userId: string
  toE164: string
  jobId: string
  sourceSessionId: string
  source: "pass" | "fail"
  onComplete?: (args: { userId: string; toE164: string; jobId: string }) => Promise<void>
  log: (event: string, payload: Record<string, unknown>) => void
}) {
  const state = new FirestorePiiState(args.db)
  return createPiiConfirmPipeline({
    state,
    source: args.source,
    // v1.9 Adam directive — always chain Level 1 onboarding Qs after PII.
    // Writes go to pa-users.tags so generateJobRecs matching uses them.
    includeLevel1: true,
    emit: async (text) => {
      try {
        await sendRuntimeApprovedIMessage({
          to: args.toE164,
          content: text,
          userId: args.userId,
          db: args.db,
          runtimeSource: "pa_pii_runtime",
          idempotencyKey: `pii_emit:${args.userId}:${args.sourceSessionId}:${text}`,
        })
      } catch (err) {
        args.log("pii_confirm.emit_failed", { error: String(err) })
      }
    },
    hooks: {
      onAllCollected: async (answers: PiiConfirmAnswers) => {
        const consentedAt = new Date().toISOString()
        const userDoc: Record<string, unknown> = {
          contactPII: {
            legalName: answers.legalName,
            email: answers.email,
            phone: answers.phone,
            consentedAt,
            source: args.source === "fail" ? "prescreen_fail_followup" : "prescreen_pass",
            sourceSessionId: args.sourceSessionId,
          },
          level1CollectedAt: consentedAt,
          level1CompletedAt: consentedAt,
          level1Status: "complete",
          level1Source: args.source ?? "pass",
          updatedAt: FieldValue.serverTimestamp(),
        }
        let tagPatch: PartialUserTags = {}
        // v1.9 — merge Level 1 onboarding answers into pa-users.tags so
        // generateJobRecs picks them up. Each field merged independently
        // through the canonical tag writer.
        if (answers.level1) {
          tagPatch = buildLevel1TagPatch(answers.level1)
        }
        await args.db.collection("pa-users").doc(args.userId).set(userDoc, { merge: true })
        if (Object.keys(tagPatch).length > 0) {
          await applyPartialUserTags(args.db, args.userId, tagPatch, {
            source: "chat",
            nowIso: consentedAt,
            log: (event, payload) => args.log(event, payload ?? {}),
          })
        }
        await args.db.collection("pa-audit-events").add({
          kind: "pii_confirm.collected",
          userId: args.userId,
          jobId: args.jobId,
          sourceSessionId: args.sourceSessionId,
          source: args.source,
          consentedAt,
          ts: consentedAt,
        })
        args.log("pii_confirm.collected", { userId: args.userId, source: args.source })

        // Stamp completion timestamp on the pipeline state doc so the
        // turn handler can swallow duplicate inbound retries for the
        // dedupe window.
        try {
          await args.db
            .collection("pa-pii-confirm-state")
            .doc(args.userId)
            .set({ completedAt: consentedAt }, { merge: true })
        } catch {
          /* swallow — dedupe is best-effort */
        }

        // Chain → generateJobRecs (matching) once PII collected.
        if (args.onComplete) {
          try {
            await args.onComplete({
              userId: args.userId,
              toE164: args.toE164,
              jobId: args.jobId,
            })
          } catch (err) {
            args.log("pii_confirm.onComplete_failed", { error: String(err) })
          }
        }
      },
    },
    log: args.log,
  })
}

/**
 * Handle inbound iMessage when user has active PII confirm pipeline.
 * Mirrors runPrescreenTurnIfActive but for PII state. Returns handled=false
 * when no active session (pipeline not started OR already completed).
 */
export interface RunPiiConfirmTurnArgs {
  db: Firestore
  userId: string
  toE164: string
  replyText: string
  log?: (event: string, payload: Record<string, unknown>) => void
}

export async function runPiiConfirmTurnIfActive(
  args: RunPiiConfirmTurnArgs
): Promise<{ handled: boolean; completed?: boolean }> {
  const log = args.log ?? (() => undefined)
  // Check if user has live PII session: state has currentQId != null AND
  // not yet completed.
  const stateSnap = await args.db
    .collection("pa-pii-confirm-state")
    .doc(args.userId)
    .get()
  if (!stateSnap.exists) return { handled: false }
  const stateData = stateSnap.data() as { currentQId?: string | null; completed?: boolean; completedAt?: string } | undefined
  // v1.9 hotfix — swallow inbound for 5 min after PII completed. Sendblue
  // may resend the same inbound (network retry), and without this we fall
  // through to Claire which produces a stray reply ("wait—aretrying to sha"
  // in the live smoke). Return handled=true (silent) for recent completes.
  const RECENT_COMPLETE_WINDOW_MS = 5 * 60 * 1000
  if (stateData?.completed && stateData?.completedAt) {
    const completedAtMs = Date.parse(stateData.completedAt as string)
    if (Number.isFinite(completedAtMs) && Date.now() - completedAtMs < RECENT_COMPLETE_WINDOW_MS) {
      log("pii_confirm.swallow_recent_complete", { userId: args.userId })
      return { handled: true, completed: true }
    }
  }
  if (!stateData || stateData.completed || !stateData.currentQId) {
    return { handled: false }
  }
  // Read meta to recover source + sourceSessionId + onComplete hook target.
  const metaSnap = await args.db.collection(PII_META_COLL).doc(args.userId).get()
  const meta = metaSnap.data() as
    | { source?: "pass" | "fail"; jobId?: string; sourceSessionId?: string; toE164?: string; lang?: "zh" | "en" }
    | undefined
  if (!meta) return { handled: false }
  const source = meta.source ?? "pass"
  // Default onComplete fires generateJobRecs ("matching" link per Adam).
  const onComplete = async (a: { userId: string; toE164: string; jobId: string }) => {
    try {
      const { getFirestore } = await import("firebase-admin/firestore")
      const { queryMatchingJobsV16, sendImessage: send, recordRecommendedJobs } = await import("@pa/job-rec")
      const db = getFirestore()
      const result = await queryMatchingJobsV16(
        { userId: a.userId, limit: 5, lang: "en", allowBroadFallback: true },
        { db, log: () => undefined }
      )
      if (!result.jobs || result.jobs.length === 0) {
        if (source === "pass") {
          log("pii_confirm.recs_no_matches_suppressed_after_pass", { userId: a.userId })
          return
        }
        await sendRuntimeApprovedIMessage({
          to: a.toE164,
          content:
            "Thanks for the details — I'll text you when a stronger fit comes through.",
          userId: a.userId,
          db,
          runtimeSource: "pa_pii_runtime",
          idempotencyKey: `pii_no_matches:${a.userId}:${meta?.sourceSessionId ?? ""}`,
        })
        return
      }
      const visibleCount = resolveJobRecVisibleCount(undefined)
      const items = await collectLiveFirestoreJobRecommendationMessageItems(db, result.jobs, "en", { limit: visibleCount })
      if (items.length === 0) {
        log("pii_confirm.recs_no_linkable_matches", { userId: a.userId })
        if (source !== "pass") {
          await sendRuntimeApprovedIMessage({
            to: a.toE164,
            content:
              "Thanks for the details — I'll text you when I find roles with a usable job link and clear requirements.",
            userId: a.userId,
            db,
            runtimeSource: "pa_pii_runtime",
            idempotencyKey: `pii_no_linkable_matches:${a.userId}:${meta?.sourceSessionId ?? ""}`,
          })
        }
        return
      }
      let introContext: ReturnType<typeof compactJobRecContext> | undefined
      let candidateTagsForReason: Record<string, unknown> | undefined
      try {
        const userDoc = await db.collection("pa-users").doc(a.userId).get()
        const tags = userDoc.exists ? userDoc.data()?.tags : undefined
        introContext = compactJobRecContext(tags)
        if (tags && typeof tags === "object") candidateTagsForReason = tags as Record<string, unknown>
      } catch {
        introContext = undefined
      }
      const sent = await send(
        {
          userId: a.userId,
          context: buildJobRecommendationRuntimeContext(items, introContext, {
            requestedCount: visibleCount,
            source: "pii_confirm_post_collect",
            eventKind: "pii_post_collect_job_recommendations",
          }),
          idempotencyKey: `${a.userId}-${new Date().toISOString().slice(0, 16)}-pii-postcollect`,
        },
        { db, log: () => undefined }
      )
      if (sent.ok) {
        const { buildRichMatchReason } = await import("@pa/job-rec")
        await recordRecommendedJobs(
          db,
          {
            userId: a.userId,
            // Attach a grounded "why matched" pitch so /me/matches reads the GOOD
            // reason. Rich deterministic (no LLM call); falls back to the V16
            // sourceJob.reason inside recordRecommendedJobs when tags absent.
            jobs: items.map((item) => {
              const sourceJob = item.sourceJob as Record<string, unknown>
              let matchReason: string | undefined
              if (candidateTagsForReason) {
                try {
                  matchReason = buildRichMatchReason({
                    candidate: candidateTagsForReason,
                    job: sourceJob,
                    matchedSkills:
                      (sourceJob.matchedSkills as Array<{ name?: string }> | undefined) ?? [],
                    breakdown: sourceJob.v16Score as Record<string, unknown> | undefined,
                    lang: "en",
                  })
                } catch {
                  matchReason = undefined
                }
              }
              return { ...sourceJob, ...(matchReason ? { matchReason } : {}) }
            }),
            source: "pii_confirm_post_collect",
          },
          () => undefined,
        )
      }
    } catch (err) {
      log("pii_confirm.recs_chain_failed", { error: String(err) })
    }
  }

  const pipeline = buildPipeline({
    db: args.db,
    userId: args.userId,
    toE164: args.toE164,
    jobId: meta.jobId ?? "",
    sourceSessionId: meta.sourceSessionId ?? "",
    source,
    onComplete,
    log,
  })

  const result = await pipeline.startTurn({
    userId: args.userId,
    turnId: `pii_turn_${Date.now()}`,
    reply: args.replyText,
  })
  log("pii_confirm.turn_handled", {
    userId: args.userId,
    completed: result.completed,
    currentQId: result.currentQId,
  })
  return { handled: true, completed: result.completed }
}
