/**
 * Cloud Functions Gen 2 wrapper for the PA orchestrator.
 *
 * Topology (Sprint-1 prod):
 *   Sendblue webhook -> Firestore `pa-inbound-events`
 *   onPaInbound (this file) -> processInboundEvent (`@pa/pa-orchestrator`)
 *     -> SiliconFlow LLM + Qdrant via `@pa/memory` mem0 OSS wrapper
 *     -> Firestore `pa-messages` + runtime-approved `pa-outbound`
 *   Sendblue/iMessage transport sends only runtime-approved `pa-outbound`
 *
 * The function is idempotent: pa-orchestrator skips events already in a non-
 * `pending` status, and message writes are guarded by `idempotencyKey`.
 */
import "./runtime-options.js"
import { onDocumentCreated } from "firebase-functions/v2/firestore"
import { onRequest } from "firebase-functions/v2/https"
import { onSchedule } from "firebase-functions/v2/scheduler"
import { defineSecret } from "firebase-functions/params"
import { logger } from "firebase-functions/v2"
import { initializeApp, getApps } from "firebase-admin/app"
import { getAuth } from "firebase-admin/auth"
import { getFirestore, type Firestore } from "firebase-admin/firestore"
import {
  claimAndProcessInboundEvent,
  createFirestoreOrchestratorStore,
  isInboundLeaseExpired,
  processInboundEvent,
} from "@pa/pa-orchestrator"
import { PA_COLLECTIONS, type Channel, type InboundEvent, type OnboardingStatus, type User } from "@pa/core-types"
import { clearUserMemory, recordDriftIfAny, resolveMem0PartitionKey, summarizeClearResult } from "@pa/memory"
import { createHash, randomUUID } from "node:crypto"

// Phase 21 Sendblue migration
import { handleSendblueWebhook } from "./sendblue/webhook.js"
import { paSendblueOutboxHandler } from "./sendblue/outbox.js"
import { sendTypingIndicator as defaultSendTypingIndicator } from "./sendblue/typing-indicator.js"
import { sendReaction as defaultSendReaction } from "./sendblue/send-reaction.js"
import { decidePreClaireTurnOwner } from "./lib/pre-claire-turn-owner.js"
import { enqueueRuntimeEventHandoff } from "./runtime-event-handoff.js"
import { resolveInboundUserId } from "./candidate-inbound-resolve.js"
import { markClaireConversationStarted } from "./candidate-claire-conversation.js"

// Shared secret bindings + orchestrator callback factory.
import {
  MAILGUN_API_KEY,
  MAILGUN_DOMAIN,
  MAILGUN_FROM,
  MAILGUN_REGION,
  ANTHROPIC_API_KEY,
  PA_SLACK_ALERT_WEBHOOK,
  CALCOM_API_KEY,
  makeOrchestratorDeps,
} from "./orchestrator-deps.js"
import {
  buildJobRecommendationRuntimeContext,
  collectLiveFirestoreJobRecommendationMessageItems,
  compactJobRecContext,
  resolveJobRecVisibleCount,
} from "./job-rec-copy.js"
// Thin Claire cutover — flag-gated (paThinClaireEnabled, default OFF). Returns false for
// everyone but the 424 canary → legacy claimAndProcessInboundEvent path stays unchanged.
// Import the cutover seam DIRECTLY (not the claire-agent barrel) — the barrel
// statically re-exports agent.js + tools, which pulls the @pa/agent-runtime SDK
// into the boot graph and crashed the container at startup. cutover.js loads the
// heavy agent/tools lazily, only behind the flag gate.
import { maybeRunThinClaire } from "./claire-agent/cutover.js"
// Unified ops-alert dispatch (email → admin1@/adam.ylol@/noah.liu@ + Slack).
import { notifyOps } from "./lib/ops-alert.js"
export {
  MAILGUN_API_KEY,
  MAILGUN_DOMAIN,
  MAILGUN_FROM,
  MAILGUN_REGION,
  ANTHROPIC_API_KEY,
  PA_SLACK_ALERT_WEBHOOK,
  makeOrchestratorDeps,
}

// v1.5 Stream-D — message coalescer (paMessageCoalesceEnabled flag-gated)
import {
  GoogleCloudTasksClient,
  resolveTasksConfigFromEnv,
} from "./coalesce/tasks-client.js"
import {
  enqueueOrCoalesce as defaultEnqueueOrCoalesce,
  processCoalescedTurn,
  type CoalescerDeps,
} from "./coalesce/paMessageCoalescer.js"
import { runCoalesceBufferSweep } from "./coalesce/buffer-sweep.js"

// Phase 31 — Upstream Event Connector
import { handleUpstreamEventWebhook } from "./upstream-event-webhook.js"

// v1.5 Stream-A2 / Phase 47.1 — Matching pipeline complete webhook
import {
  handleMatchingPipelineComplete,
  composeFailureAlert,
  type FailureAlertEmailFn,
  type FailureAlertSlackFn,
} from "./matching-pipeline-complete.js"
// P9 directive 2026-05-08 — failure-path alert email reuses the Mailgun
// transport already used by qa-evaluator-weekly + cost-summary-weekly, plus
// the shared Slack alert helper. See task fix/pipeline-failure-alert.
import { sendMailgun, type MailgunConfig } from "./email/mailgun.js"
import { postSlackAlert } from "./lib/slack-alert.js"

// Phase 22 — proactive check-in sweep
export { paProactiveSweep } from "./proactive-sweep.js"
// Prescreen-NURTURE engagement engine — hourly scheduler that creates due
// nurture jobs for paProactiveSweep to dispatch. Flag-gated paPrescreenNurtureEnabled (default OFF).
export { paPrescreenNurtureScheduler } from "./prescreen-nurture-cf.js"
export { paCandidateLifecycleTrigger } from "./candidate-lifecycle-trigger.js"

// Phase 24.5 — admin bootstrap (seed flags via PA_ADMIN_TOKEN, bypass local gcloud ADC)
export { paAdminBootstrap } from "./admin-bootstrap.js"

// Stream B — Job-rec daily cron (Task B4). Reads pa-job-profiles where status=active,
// queries matching-jobs, formats per Bible v7.5.2, then hands the proposed
// candidate message to Claire runtime.
export { paJobRecDaily } from "./job-rec-daily.js"
export { paReactivationSweepDaily } from "./reactivation-sweep.js"

// Phase 51 (v1.5 / Stream-G.2) — TS-native tag cluster cache rebuild CF.
// Triggered by pa-events doc {eventKind="matching:pipeline:completed"}.
export { paJobRecClusterRebuild } from "./job-rec-cluster-rebuild.js"

// Phase 49 (v1.5 / Stream-H / D9) — operator reverse-match dashboard CF.
// JD + tags + industry → top-K candidates → notify via Claire runtime handoff.
export { paReverseMatch } from "./paReverseMatch.js"

// iter30 WS2 P2 — Canonical tag worker (onDocumentCreated pa-tag-events + retry scheduler)
export { paCanonicalTagWorker, paCanonicalTagWorkerRetry } from "./tag-worker/normalize.js"

// iter34 followup G.3 — Admin-callable atsApplyUrl backfill + liveness sweep
// for matching-jobs/{id}. Replaces the never-deployed macmini Stage 2.5
// url_resolver.py with a TS-native cloud-side implementation.
export { paBackfillMatchingJobsAtsUrl } from "./backfill-ats-urls.js"

// v1.7 Phase 65 (ATSURL-01..04) — Hourly Serper backfill batch + retry queue
// + cost ledger. Replaces the inline backfill that was inside the Phase 57
// liveness sweep. 200 jobs/run × 24/day = 4800 capacity. 5-concurrent Serper
// calls. LinkedIn fallback when Serper misses. Cost-ledger row per Serper
// call. Weekly summary CF emails when >$10/wk.
export { paBackfillAtsUrlsBatch, paCostSummaryWeekly } from "./backfill-ats-urls-batch.js"

// 2026-06-02 — OpenAI key early-warning (incident
// .planning/INCIDENT-2026-06-01-openai-rotation-hardening.md). Cloud Scheduler
// every 30 min. Cheap health-ping with the live PA_OPENAI_AGENT_API_KEY: 401
// invalid_api_key → 🚨 "key DEAD/revoked"; 429 insufficient_quota → 🚨 "quota
// exhausted" (Slack + Mailgun). Plus a once-daily Costs-API poll that warns at
// ≥80% of a configurable monthly budget BEFORE the hard credit cap. Deduped via
// pa-alerts/{yyyy-mm-dd-<kind>}. Fail-open (never throws). Costs poll needs the
// optional OPENAI_ADMIN_KEY secret; health-ping works without it.
export { paOpenAiKeyHealth } from "./openai-key-health.js"

// 2026-06-14 — Anthropic key/quota early-warning (mirror of paOpenAiKeyHealth).
// Every 30 min: GET /v1/models health-ping; 401/403 → revoked, 429/billing →
// credit exhausted. Dispatches via notifyOps (email + Slack), deduped per kind/day.
export { paAnthropicKeyHealth } from "./anthropic-key-health.js"

// v1.6 Phase 57 (LIVE-01..04) — Daily HEAD-check sweep for matching-jobs.
// Cloud Scheduler 03:00 UTC. Marks dead on 4xx/5xx/timeout, recovers on
// HTTP-200 retry, hard-deletes after 30d dead. Inline-wires the Serper
// resolver from paBackfillMatchingJobsAtsUrl (cap 1000/run).
export { paLivenessSweepDaily } from "./liveness-sweep.js"

// 2026-06-10 trust audit (fixes 9+10) — daily 09:00 UTC: pendingReview >48h
// SLA alarm (read-only + Slack) AND the canary-gated stalled-screen 24h nudge
// (idempotent per session via `prescreen-nudge-<sessionId>`).
export { paPrescreenReviewSlaDaily } from "./prescreen-review-sla.js"

// Enrich + checklist-evaluate the prescreen candidate (LinkedIn/résumé → Coresignal →
// the SAME hard/fit/anti/bonus + background rubric the recruiter eval uses), per
// (candidate × job), the moment a session enters pending HITL review. Advisory.
export { paPrescreenCandidateEval } from "./prescreen-candidate-eval.js"

// 2026-06-11 incident class — daily 08:00 UTC channel canary: dead
// senderNumber assignments vs the active pa-sendblue-numbers pool (the
// +17174919939 silent-death detector), zero-active-pool CRITICAL, 24h
// outbound failure pressure, and inbound-silence-while-sending CRITICAL.
// READ-ONLY + Slack alerts (fail-soft when PA_SLACK_ALERT_WEBHOOK unset).
export { paChannelHealthDaily } from "./channel-health.js"

// 2026-05-27 — daily watchdog over the macmini → Firestore scrape pipeline.
// Posts a Slack alert when the newest `matching-jobs.syncedAt` is older
// than 24h (warn) or 48h (error). Audit trail in
// `matching-jobs-monitor-runs`. See `scrape-freshness-monitor.ts` for the
// pure orchestrator + co-located unit tests.
export {
  paScrapeFreshnessMonitorDaily,
  // Public HTTP companion — feeds the Claude routine that doesn't have
  // Firestore credentials. Returns latest monitor run + today's pipeline
  // lock state as JSON. 60s CDN cache.
  paScrapeFreshnessStatusPublic,
} from "./scrape-freshness-monitor.js"

// 2026-05-27 — Quality sampling CF. Returns counters per source + ≤20
// random samples (company / role / atsApplyUrl / source) from the
// last 24h of scraped jobs. Feeds a sibling Claude routine that
// HEAD-checks each URL and opens a daily GitHub issue with the
// quality verdict.
export { paScrapeQualitySamplePublic } from "./scrape-quality-sample.js"

// Phase A5 (post-v1.7) — `pa-companies` enrichment cascade (YC → Wikidata →
// Clearbit → LLM). Scheduled Tue 04:00 UTC + admin-only ad-hoc callable.
// Never overwrites docs where `lastReviewedBy != null`.
export {
  paEnrichCompaniesNightly,
  paEnrichCompaniesAdHoc,
} from "./enrich-companies-nightly.js"

// Phase A4.1 — pa-companies job-count sync (admin callable + nightly).
// Surfaces matching-jobs join count on /admin/companies so operators can
// see at a glance whether a directory row has any open roles.
export {
  paCompaniesJobCountSync,
  paCompaniesJobCountNightly,
} from "./sync-companies-jobs-count.js"

// v1.7+ TTL — Weekly hybrid GC for matching-jobs collection. Adam Option D
// (2026-05-08): inactive >90d AND dead >365d are deleted Mon 04:00 UTC.
// Postgres tombstone (P7-K, alembic 0007) preserves dead flag after Firestore
// delete so the scraper does not re-add deleted dead URLs. Pure-deps-injected
// runner with admin-only callable for canary dry-runs.
export {
  paMatchingJobsTtlDeleteWeekly,
  paMatchingJobsTtlDeleteCallable,
} from "./matching-jobs-ttl-delete.js"

// W6 (pre-launch matching hardening, 2026-05-19) — admin-only on-demand
// callable that flips bad-active matching-jobs docs to `status: "inactive"`.
// Predicate (first-match-wins): dead=true / missing jobTitle / firstSeenAt
// past V16's 20-day window / atsApplyUrl missing or jobright.ai placeholder.
// Default dryRun=true for canary safety; explicit `false` to actually flip.
// Safe-because: W1 (core-service upsertJobs status-protection, PR #7) is in
// main, so the next macmini scrape will not resurrect flipped docs.
export { paJobPoolHygiene } from "./job-pool-hygiene.js"

// v1.6 Phase 58 (RERANK-01..04) — Nightly LLM rerank batch + per-skill
// JD-relative weight cache. Cloud Scheduler 04:00 UTC (1h after liveness
// sweep). For each active user: rerank top-50 candidates via Qwen-7B and
// compute per-skill JD-rel weights for top-10 via Sonnet → gpt-5.4-nano →
// Qwen-7B fallback chain. Writes pa-user-rerank-cache/{userId} +
// pa-user-skill-jdrel-cache/{userId}/jobs/{jobId} consumed by Phase 56's
// queryMatchingJobsV16 (already wired with graceful-miss handling).
export { paLlmRerankNightly } from "./nightly-rerank.js"

// v1.6 Phase 59 (DASH-02) — Admin-only callable that promotes/rejects
// sandbox industry-sector tokens. Wired by /admin/canonical-tags page;
// writes pa-canonical-tags overlay doc + audit row. Validates token format
// via @wekruit/shared-tags `validateCanonicalToken` (rejects abbreviations).
export { paPromoteSandboxTag } from "./promote-sandbox-tag.js"
export { paReinitializeCandidate } from "./admin-reinitialize-candidate.js"
// COMPLETE DELETE USER (testing-only, irreversible) — admin-only callable that
// HARD-DELETES the pa-users doc + every per-user / identity-index doc keyed by
// or referencing the uid + the mem0/Qdrant memory partition. Far more thorough
// than COLD reinit (which resets fields). Server-gated on @wekruit.com email.
export { paAdminDeleteUser } from "./admin-delete-user.js"

// v1.6 Phase 61 (QA-01..05) — V1.6 SHIP GATE. Cloud Scheduler 09:00 UTC
// Mondays. Samples 100 user×match pairs (priority queue first), evaluates
// each via Qwen-7B JSON-mode judge, writes pa-qa-evaluator-runs/{runId}
// with full per-pair verdict + aggregate rates. Alerts via Slack +
// Mailgun when hardFilter <90% or top3 <70%. Failure-loop: failing users
// persisted in pa-qa-priority-queue with 8d TTL for next-week re-eval.
// Milestone state pa-milestones-state/v1.6.qaShipGate updated per run.
export { paQaEvaluatorWeekly } from "./qa-evaluator-weekly.js"

// v1.7 Phase 70 (MATCHDEBUG-01..04) — admin-only callable backing the
// /admin/match-debug page. Loads pa-users.tags, runs the V16 cascade with
// optional weight-override sandbox values, and returns full per-job score
// breakdown + counters for the dashboard's live debugger.
export { paAdminJobMatchDebug, paAdminMatchDebug } from "./admin-match-debug.js"
// paAdminIntakeJob — admin-only callable wrapping the SAME runIntakeJob runner
// the Slack-agent intake_job tool uses (enrichJobTags 3-tier router +
// deriveJobOpportunityDraft). Brings Slack-parity JD enrichment (canonical tags,
// hard filters, draft prescreen questions, clarifying questions, confidence) to
// the dashboard create-job / job-edit surface. Advisory + persists nothing.
export { paAdminIntakeJob } from "./admin-intake-job.js"
// paAdminRediscoverForJob — admin-only callable wrapping the SAME
// runRediscoverForJob runner the Slack-agent rediscover_for_job tool uses (V16
// two-way scorer over the global candidate-tier pool). Surfaces silver-medalist
// reactivation in the dashboard. Consent-safe projection (ids/scores/tier only).
export { paAdminRediscoverForJob } from "./admin-rediscover-for-job.js"
// pa-pending-outbound — admin-only callable backing /admin/pending-outbound
// (batch human-approve-then-send queue). list/update/approve/skip are
// functional; `send` is GATED + the live Sendblue dispatch seam is
// intentionally NOT wired (returns blocked) so no message can fire without a
// deliberate, Adam-gated follow-up.
export { paPendingOutboundAdmin } from "./pending-outbound/admin.js"
// Coresignal Agentic Search proxy — admin-only callable forwarding to
// /v2/agentic_search/reasoning. Backs the /admin/coresignal-playground page.
export { paAdminCoresignalAgenticSearch } from "./admin-coresignal-agentic-search.js"
// Chrome recruiter extension callable — LinkedIn-profile source → similar
// candidate profiles via Coresignal agentic search.
export { paExtensionFindSimilarCandidates } from "./extension-similar-candidates.js"
export { paAdminOutreachOpsSnapshot } from "./outreach/admin.js"
export {
  paAdminPassedCandidateIntroDecision,
  paAdminPassedCandidatesSnapshot,
} from "./admin-passed-candidates.js"
// Prescreen Review Queue data truth — server-side global counts, per-job
// rollups, and paginated session pages over pa-prescreen-sessions (the
// client-side limit(75) reads undercounted).
export { paAdminPrescreenOpsSnapshot } from "./admin-prescreen-ops.js"
// AI-headhunter MCP server (Streamable HTTP). Wraps existing admin run* runners
// as MCP tools; admin-claim / PA_ADMIN_TOKEN gated; passed-candidate PII redacted
// server-side for the untrusted LLM client. See headhunter-mcp/.
export { paHeadhunterMcp } from "./headhunter-mcp/http.js"
// AI-headhunter Slack receiver (Bolt + @openai/agents loop; tools = paHeadhunterMcp).
export { paHeadhunterSlack } from "./headhunter-slack/http.js"
export { paAdminPartnerStats, paAdminSetAwaitingHm } from "./admin-partner-stats.js"

// Negative-feedback review dashboard — classify candidate↔Claire conversations
// by sentiment (daily scan + manual re-run) and serve the unhappy ones with a
// transcript preview + "how to improve" note to /admin/conversation-feedback.
export {
  paConversationSentimentScan,
  paConversationSentimentScanRun,
} from "./conversation-sentiment-scan.js"
export { paAdminConversationFeedback } from "./admin-conversation-feedback.js"
// Operations Overview dashboard — daily time-series of new users (by channel),
// interviews conducted, and candidates moved to client. Admin /admin/operations.
export { paAdminOpsMetrics } from "./admin-ops-metrics.js"
// Funnel snapshot — point-in-time group-count over the pa-candidate-job-states
// ladder (candidate_matched → … → employer_visible) + interview sub-track, and
// the "passed but not employer-visible" stuck-PASS leak list. Admin /admin/funnel.
export { paAdminFunnelSnapshot, paAdminPassedNotVisibleList } from "./admin-funnel-snapshot.js"
// Candidate pool TRUE counts (whole pool, not the 500-row browse sample) for
// the /admin/candidates header cards + STATE/SOURCE/IDENTITY breakdowns.
export { paAdminCandidatePoolCounts } from "./admin-candidate-pool-counts.js"
// Trimmed list of EVERY recruiter submission (not just the recent 500) so the
// /admin/recruiter-submissions search + state filter see the whole pool.
export { paAdminRecruiterSubmissionsList } from "./admin-recruiter-submissions-list.js"
// All interview bookings (pa-interview-bookings) for /admin/interviews +
// per-row operator outcome-stamp (completed/no_show/cancelled). The list reuses
// the runSchedulingStatus projection; the outcome action writes the booking
// status AND emits the parallel candidate×job FSM event (fail-open, idempotent).
export { paAdminInterviewBookingsList, paAdminInterviewOutcome } from "./admin-interview-bookings.js"
// Employer-ops admin readers (+ one status action) over three built-but-invisible
// top-level collections: pa-employer-connect-requests (managed-setup demand +
// public-board audit; fulfillment status action), pa-employer-team-invites
// (per-org roster), and pa-headhunter-emails (read-only outbound-email audit log,
// no body PII). Admin /admin/connect-requests + /admin/ops-inbox.
export {
  paAdminConnectRequestsList,
  paAdminConnectRequestSetStatus,
  paAdminTeamInvitesList,
  paAdminHeadhunterEmailsList,
} from "./admin-employer-ops.js"
// Algolia search: real-time sync triggers (submissions + candidates) + a
// one-shot admin backfill. No-op until ALGOLIA_APP_ID + ALGOLIA_ADMIN_KEY are set.
export { paAlgoliaSyncRecruiterSubmission, paAlgoliaSyncCandidate } from "./algolia/algolia-sync.js"
export { paAlgoliaBackfill } from "./algolia/algolia-backfill.js"
// Rejected-candidates-by-tier browse + AI re-evaluate-for-new-roles action.
// Tier is stamped at rejection (prescreen + recruiter) via applyGlobalCandidateTier.
export { paAdminRejectedCandidatesSnapshot } from "./admin-rejected-candidates.js"
export { paAdminReevaluateCandidateTier } from "./admin-candidate-tier-actions.js"
// Per-candidate scheduling ramp — operator enables/disables REAL interview
// scheduling for ONE candidate by mutating ONLY the paSchedulingEnabled flag
// allowlist (never the global value).
export {
  paAdminSetCandidateScheduling,
  paAdminGetCandidateScheduling,
} from "./admin-set-candidate-scheduling.js"
// Identity-conflict resolve/dismiss + true counts — client Firestore writes
// to pa-candidate-identity-conflicts are rules-denied, so the dashboard
// /admin/identity-conflicts page goes through this callable.
export { paAdminIdentityConflictsResolve } from "./admin-identity-conflicts.js"
// AI-first recruiter-submission evaluation — onDocumentCreated trigger over
// pa-recruiter-submissions. Best-effort Coresignal research + ONE strict-JSON
// critical-judge LLM call (callWithFallback 3-tier) → merges `aiEvaluation`
// onto the submission doc. NEVER touches `status` (operator-only transitions).
export { paRecruiterSubmissionEval } from "./recruiter-submission-eval.js"
// Admin one-shot re-eval of existing submissions with the current (résumé-grounded)
// judge — onDocumentCreated never re-fires, so stale verdicts need this backfill.
export { paAdminReevaluateRecruiterSubmissions } from "./admin-reevaluate-submissions.js"
// Admin backlog re-eval of prescreen sessions with the current (transcript-primary,
// wrong-identity-aware) judge — onDocumentWritten never re-fires on evaluated sessions.
export { paAdminReevaluatePrescreens } from "./admin-reevaluate-prescreens.js"
// Operator decision callable for the recruiter-submission review board.
// advance/reject/reviewing/duplicate set status + adminDecision; request_info
// appends requestedInfo[]. The recruiter-board codebase's
// paRecruiterSubmissionFeedbackNotify trigger reacts to the status write and
// owns recruiter emails — this callable never sends mail.
export { paAdminRecruiterSubmissionAction } from "./admin-recruiter-submission-action.js"

// v2.2 W6 — admin-only callable that seeds outbound-bookings/{id} with
// voiceState=dialing to trigger the existing S3 dial gate. Backs the
// /admin/voice-test-dial dashboard form (single-shot smoke dial).
export { paAdminVoiceTestDial } from "./admin-voice-test-dial.js"

// v2.1 S4 — Voice turn telemetry aggregate (admin-gated). Reads the
// voice-call-metrics collection (written by the S4 metricsWriter that
// S2 wires into LiveKit Cloud Agents) and returns the four S6-smoke-gate
// thresholds: false-commit %, false-interrupt %, p50/p95 TTFA, avg
// cost/call. Plus cost-ceiling-hit count (L11).
export { paAdminVoiceTelemetryAggregate } from "./voice/telemetry/aggregateQuery.js"

// v1.8 ENRICHER-04 — `paEnrichJobTags` HTTP CF wraps the unified
// @pa/job-tag-enricher service (mirror of pa-resume-parser, job-side).
// Replaces scattered regex tag-derivation in the macmini matching pipeline
// (the bug: `buildMatchingJobRecord` had ZERO roleFunction/industrySector
// derivation, so non-SimplifyJobs sources got "other" silently → P73 jobs
// surfaced as random sales/SWE soup). Auth via X-API-Key.
export { paEnrichJobTags } from "./enrich-job-tags-http.js"

// v1.8 — Firestore trigger that backfills LLM-canonical tags onto every
// matching-jobs doc. Necessary because core-service `matching-api` sync CF
// (off-monorepo, source only in deployed zip) does not derive these fields.
// Loop-safe via enricherVersion + enricherContentHash idempotency check.
export { paMatchingJobsAutoEnrich } from "./auto-enrich-matching-jobs.js"

// EX1 PR-C — derive yearsPerSkill/skillRecency/titleTrajectory/seniorityCurrent
// per pa-user every time parsedCandidateResumes is written. Fan-out is
// feature-flagged via env `PA_EXPERIENCE_EXTRACTOR_LIVE=true`; until that
// flips on the trigger logs but writes nothing. Fail-open by design.
export { paExperienceExtractorOnParsedResume } from "./experience-extractor-trigger.js"

// v1.9 Phase 86 — Generic ATS inbound adapter webhook.
// Handshake fully implemented; GH/Lever/LinkedIn return 501 stubs.
export { paAtsInboundWebhook } from "./ats-inbound-webhook.js"

// TWO-WAY email — Mailgun inbound route catches candidate REPLIES at
// `reply+<convToken>@<inbound-domain>`; resolves the thread via
// pa-email-threads/{convToken}. By DEFAULT the LLM reply is recorded as a
// DRAFT (pa-inbound-email-drafts, pending_review) — no unsupervised send;
// PA_INBOUND_EMAIL_AUTOSEND=1 opts into legacy auto-send.
export { paInboundEmailWebhook } from "./inbound-email-webhook.js"

// Unified SMS + email comms timeline for one candidate (pa-messages +
// pa-headhunter-emails + pa-email-inbound, keyed by userId/candidateEmail).
// Backs the /admin/users/:id "Communications" panel so operator decisions see
// the FULL conversation, not just SMS. Read-only, admin-gated.
export { paAdminCandidateComms } from "./admin-candidate-comms.js"
// v2026-07-21 — YC Startup School event intake operator queue (list + one-click evening send).
export { paAdminYcIntakeToday, paAdminYcSendMatches } from "./yc-intake-admin.js"

// HITL email-review surfaces: list pending auto-reply DRAFTS, approve+send (or
// edit-then-send) / dismiss a draft, and list the pa-inbound-emails-unmatched
// dead-letter queue (comp/visa/STOP replies that missed the thread token).
// Backs /admin/email-review. All admin-gated.
export {
  paAdminInboundEmailDrafts,
  paAdminSendInboundEmailDraft,
  paAdminInboundUnmatchedList,
} from "./admin-inbound-email-review.js"

// v2.1 S3 — outbound voice prescreen dispatch + status callback reconciliation.
// `paVoiceDialOutbound`: Firestore trigger on `outbound-bookings/{id}` writes;
//   reacts to `→ dialing` and creates a LiveKit Cloud SIP participant routed
//   through the Twilio trunk. Lock L5 short-circuits on missing identity.
// `paVoiceSipWebhook`: HTTP endpoint receiving Twilio status callbacks +
//   LiveKit room webhooks. Idempotent reconciliation against the
//   `outbound-bookings/{id}` state machine (Locks L9 + L10).
export { paVoiceDialOutbound, paVoiceSipWebhook } from "./voice/index.js"
export { paVoicePostCallFollowup } from "./voice/post-call-followup.js"

// v2.2 — Voice-side HTTP callable CFs (shared-brain prescreen).
//   `paVoiceCallContext`   — assembles VoiceCallContext from S1B loaders.
//   `paVoicePrescreenTurn` — runs the channel-agnostic runPrescreenTurn for
//                            one voice turn. Same orchestrator brain as the
//                            SMS handler (prescreen-deps.ts).
// Auth: bearer header `X-Wekruit-Voice-CF-Secret` = PA_VOICE_CF_SECRET.
export {
  paVoiceCallContext,
  paVoiceOnboardingTurn,
  paVoicePrescreenTurn,
} from "./voice/voice-prescreen-callable.js"

// v1.9 hotfix (2026-05-12 live test STOP) — public /j/:jobId CV upload backend.
// Frontend (PublicJobCv.tsx) POSTs base64 to this endpoint. ATS inbound
// webhook (paAtsInboundWebhook) also targets this via PA_CV_INGEST_URL env.
export { paPublicCvIngest } from "./public-cv-ingest.js"
// Public GET "book this time" link from an interview-offer email. Token-gated
// (offerToken) + slot-gated + confirm-on-click → bookInterviewSlotCore.
export { paBookInterviewViaLink } from "./book-interview-via-link.js"
// iMessage-first QR onboarding — public GET /start?c=<campaign> picks a
// capacity-aware Sendblue number, reserves it for a minted scanToken, and 302s
// to sms:<number>?body=Hi, WeKruit, my verification code is <scanToken>. See qr-onboarding/.
export { paQrStartRedirect } from "./qr-onboarding/qr-start-redirect.js"
// Abandoned-scan sweep — decrements the per-group assignedNewUsers counter for
// pa-qr-scan-pending docs that never converted (status stays 'pending' past TTL)
// so the new-user capacity counter doesn't leak.
export { paQrScanAbandonedSweep } from "./qr-onboarding/abandoned-scan-sweep.js"
// LinkedIn one-tap connect — public POST {token, linkedinUrl} from the
// candidate-domain /connect-linkedin page. Resolves token→userId, links the
// LinkedIn handle, enriches by URL via CoreSignal (experienceHighlights + tags),
// emits the resume_parse_completed runtime event (thin pitch), and returns the
// sms: reroute back to the iMessage thread. Canary-gated; degrades gracefully.
export { paLinkedinConnectSubmit } from "./linkedin-connect/linkedin-connect-submit.js"
// WS-3 connect-phone (Adam 2026-06-03): the INVERSE of the QR opener — a candidate who
// registered FIRST via phone (iMessage) and later visits the website binds the two via a
// 6-digit verification code texted to their thread. paCandidateConnectPhoneStart issues +
// texts the code; paCandidateConnectPhoneVerify verifies it + links the web session to the
// existing pa-users/{uid} (deterministic, audited identity merge). Canary-gated; PR-FIRST
// (committed, NOT deployed). No new secret (reuses Sendblue creds + the bound pool line).
export { paCandidateConnectPhoneStart } from "./connect-phone/connect-phone-start.js"
export { paCandidateConnectPhoneVerify } from "./connect-phone/connect-phone-verify.js"
// Recruiter board (candidate.wekruit.com/recruiters): public list + submission.
// Lives in the `recruiter-board` multi-codebase (apps/recruiter-board-fn) as
// of 2026-05-26 to keep the pa-orchestrator bundle small. Endpoints:
// `paCollabJobsList`, `paRecruiterSubmission`, `paCollabJobsListSchema`.
export { paCandidateMagicLinkVerify } from "./candidate-magic-link-verify.js"
// WeKruit Open — public job board at layoff.wekruit.com/open. Reads from
// matching-jobs (scraped/non-collab) with hard filters mirroring v16's
// query (status==active, dead!=true, atsApplyUrl present, firstSeenAt fresh).
export { paPublicOpenJobs } from "./public-open-jobs.js"
// v2.0 Partner API — layoffhedge users export. HTTP callable returning
// sourced candidates (status-filtered, paginated). Auth via X-API-Key.
export { paPartnerUsersApi } from "./partner-users-api.js"
// Adam 2026-05-18: rolling preview on layoff.wekruit.com now reads pa-users
// (mix of demo + real, both filtered by `getHired !== true`) instead of a
// hardcoded JS pool. Public, no-auth GET. See `public-layoff-preview.ts`.
export { paPublicLayoffPreview } from "./public-layoff-preview.js"
// Candidate LinkedIn auth cannot use Firebase generic OIDC because LinkedIn
// rejects token exchange without client_secret. These HTTP functions own the
// OAuth exchange server-side and return a Firebase custom token.
export {
  paCalcomCallback,
  paCandidateConnectorOAuthStart,
  paGithubCallback,
  paLinkedinAuthStart,
  paLinkedinCallback,
} from "./linkedin-auth.js"
export { paSsoLogin, paSsoBootstrap, paSsoLogout } from "./cross-domain-sso.js"
// v2.0 S2 — candidate email-link claim callable. Authenticated candidates
// receive only the redacted candidate self-profile projection.
export { paCandidateClaimProfile } from "./identity/claim-api.js"
export {
  paCandidatePhoneLinkStart,
  paCandidatePhoneLinkVerify,
} from "./identity/candidate-phone-link.js"
// Candidate job start gate. Authenticated candidates must have a parsed and
// labeled resume on the canonical PA profile before iMessage unlocks.
export { paCandidateResumeGateStatus } from "./identity/candidate-resume-gate.js"
// v2.0 S5 — candidate-safe match list projection. Authenticated candidates
// read joined/redacted match cards through a callable, not raw Firestore.
export { paCandidateListMatches } from "./identity/candidate-matches-api.js"
// v2.0 S3 — admin/operator-only bulk resume supply intake. Writes canonical
// pa-users + pa-resume-artifacts through the cv-ingest identity seam.
export {
  paBulkResumeCreateBatch,
  paBulkResumeAddItems,
  paBulkResumeProcessBatch,
  paBulkResumeSubmitRecruiterBatch,
  paBulkResumeRetryItem,
} from "./bulk-resume-intake.js"
// v2.0 S4 — admin/operator-only job enrichment draft review and approval.
export {
  paJobEnrichmentApproveDraft,
  paJobEnrichmentGenerateDraft,
  paJobEnrichmentRefreshDraft,
  paJobEnrichmentRejectDraft,
  paJobEnrichmentSaveCorrections,
} from "./job-enrichment.js"
// v2.0 S8 — backend flywheel/HITL/eval slice. Admin snapshot is read-only;
// candidate correction writes only correction/eval artifacts and never outbound.
export {
  paAdminFlywheelEvalSnapshot,
  paFlywheelCorrectionEvalArtifact,
} from "./flywheel-eval.js"
export {
  paDraftPrescreenReviewMessages,
  paReviewEvaluationAttempt,
} from "./evaluation-attempts.js"
// P4 — AI-vs-human agreement metric + labeled-dataset JSONL export. Admin-only,
// read-only: never mutates the AI verdict, never messages a candidate.
export { paExportEvaluationLabels } from "./export-evaluation-labels.js"
export { paCandidateProfileCorrection } from "./flywheel-candidate-correction.js"
// Flywheel HITL -> regression replay — closes the write-only correction loop:
// reads pa-eval-artifacts and replays each correction through its production
// seam (tag merge / matching / verdict), asserting the corrected expectation
// still holds. Admin callable (on-demand) + weekly scheduled regression.
export {
  paFlywheelRegressionReplay,
  paFlywheelRegressionReplayWeekly,
} from "./flywheel-regression-replay.js"
// v2.0 S9 — production hardening and launch readiness controls.
export {
  paAdminLaunchReadinessSnapshot,
  paAdminOutreachStopControl,
  paCandidatePrivacyRequest,
} from "./production-hardening.js"

// Phase 27 T2 — public /health endpoints (one per existing CF). Returns
// {ok, name, version, ts, deps:{firestore, secrets}}. No auth (probes
// must be reachable). All endpoints HTTP 200 always; failure surfaces in body.
import { makeHealthHandler } from "./health.js"
import { readVersionChannel, setVersionChannel, parseChannel } from "./version-channel.js"

export const paHealthSendblueWebhook = makeHealthHandler({
  name: "paSendblueWebhook",
  requiredSecrets: ["SENDBLUE_WEBHOOK_SIGNING_SECRET"],
})
export const paHealthSendblueOutbox = makeHealthHandler({
  name: "paSendblueOutbox",
  requiredSecrets: ["SENDBLUE_API_KEY_ID", "SENDBLUE_API_SECRET_KEY"],
})
export const paHealthOnPaInbound = makeHealthHandler({
  name: "onPaInbound",
  requiredSecrets: [
    "SILICONFLOW_API_KEY",
    "QDRANT_URL",
    "QDRANT_API_KEY",
    "SENDBLUE_API_KEY_ID",
    "SENDBLUE_API_SECRET_KEY",
  ],
})
export const paHealthProactiveSweep = makeHealthHandler({
  name: "paProactiveSweep",
  requiredSecrets: ["PA_ADMIN_TOKEN"],
})
export const paHealthMemoryAdmin = makeHealthHandler({
  name: "memoryAdmin",
  requiredSecrets: ["QDRANT_URL", "QDRANT_API_KEY"],
})
export const paHealthAdminBootstrap = makeHealthHandler({
  name: "paAdminBootstrap",
  requiredSecrets: ["PA_ADMIN_TOKEN"],
})

if (!getApps().length) initializeApp()

// v1.9 hotfix — KeywordSetJudge / pipeline state can emit optional fields
// as `undefined` (e.g. scored.abortHint). Firestore Admin SDK throws unless
// ignoreUndefinedProperties is enabled. Defensive global setting; we still
// stripUndefined in prescreen-turn-handler for explicitness.
try {
  getFirestore().settings({ ignoreUndefinedProperties: true })
} catch {
  // settings() throws once getFirestore() has been used — safe to ignore
  // if a previous handler already initialized it with default settings.
}

// Phase 21 Sendblue secrets — populated via `firebase functions:secrets:set` (D-07)
const SENDBLUE_API_KEY_ID = defineSecret("SENDBLUE_API_KEY_ID")
const SENDBLUE_API_SECRET_KEY = defineSecret("SENDBLUE_API_SECRET_KEY")
const SENDBLUE_WEBHOOK_SIGNING_SECRET = defineSecret("SENDBLUE_WEBHOOK_SIGNING_SECRET")
const SENDBLUE_FROM_NUMBER = defineSecret("SENDBLUE_FROM_NUMBER")

// iter32 deploy-fix 2026-05-04 — MAILGUN_* defineSecret bindings + factory
// moved to ./orchestrator-deps.ts for sharing with admin-bootstrap.ts.
// (Imports + re-exports above near the top of this file.) Populate via:
//   echo -n "$KEY" | firebase functions:secrets:set MAILGUN_API_KEY --data-file=-
//   echo -n "mg.wekruit.com" | firebase functions:secrets:set MAILGUN_DOMAIN --data-file=-
//   echo -n "Claire <claire@mg.wekruit.com>" | firebase functions:secrets:set MAILGUN_FROM --data-file=-
//   echo -n "us" | firebase functions:secrets:set MAILGUN_REGION --data-file=-   # optional, default us

// Phase 31 — Upstream Event Connector HMAC shared secret. Distinct from
// Sendblue secrets so a compromised upstream partner cannot forge inbound
// Sendblue traffic (and vice versa). Set via:
//   echo "$TOKEN" | firebase functions:secrets:set PA_UPSTREAM_HMAC_SECRET --data-file=-
const PA_UPSTREAM_HMAC_SECRET = defineSecret("PA_UPSTREAM_HMAC_SECRET")

// v1.5 Stream-A2 / Phase 47.1 — Mac mini → cloud webhook for daily-update
// pipeline complete. HMAC shared secret. Set via:
//   echo "$TOKEN" | firebase functions:secrets:set PA_MATCHING_WEBHOOK_SECRET --data-file=-
const PA_MATCHING_WEBHOOK_SECRET = defineSecret("PA_MATCHING_WEBHOOK_SECRET")

const SILICONFLOW_API_KEY = defineSecret("SILICONFLOW_API_KEY")
const PA_OPENAI_AGENT_API_KEY = defineSecret("PA_OPENAI_AGENT_API_KEY")
// Audio intake (2026-06-04) — Deepgram transcribes iMessage voice notes (after an ffmpeg .caf→wav
// transcode). Bound on paSendblueWebhook (where the audio-ingest seam runs). Set via:
//   echo -n "$KEY" | firebase functions:secrets:set DEEPGRAM_API_KEY --data-file=-
const DEEPGRAM_API_KEY = defineSecret("DEEPGRAM_API_KEY")
const QDRANT_URL = defineSecret("QDRANT_URL")
const QDRANT_API_KEY = defineSecret("QDRANT_API_KEY")
// v1.8 Phase 74.5 — feature flag for memory compaction (default off, secret=true to enable).
const MEMORY_COMPACTION_ENABLED = defineSecret("MEMORY_COMPACTION_ENABLED")
// v1.8 Phase 77 — admin allowlist for __PA_COMPACT__ + __PA_FIND_MATCH__ + prescreen-as-admin.
const PA_ADMIN_USER_IDS = defineSecret("PA_ADMIN_USER_IDS")
// mem0/Qdrant convention — snake_case (NOT kebab).
const QDRANT_COLLECTION = "pa_memory"

type BrokerImessageEvent = {
  id: string
  status?: string
  idempotencyKey: string
  createdAt: string
  leaseUntil?: string
  rawPayload?: {
    kind?: string
    participant?: string
    chatId?: string
    messageRowId?: number
    text?: string
    /** Inbound image/attachment URL (iMessage). An image-only message has empty `text` + a
     * `mediaUrl`; it must NOT be rejected as empty_text (live victim: screenshot proof during a
     * prescreen was dropped at the door, never reaching the image-proof guard). */
    mediaUrl?: string
    /** Synthetic `[cv-parsed]` worker / E2E — must flow to orchestrator rawMeta. */
    triggerResumeId?: string
    cvParsedTrigger?: boolean
    messageHandle?: string
    source?: string
    e2eTest?: boolean
    harness?: {
      runner?: string
      suppressOutbound?: boolean
    }
  }
}

type QdrantPoint = {
  id: string | number
  payload?: Record<string, unknown>
  vector?: unknown
}

type QdrantScrollResponse = {
  result?: {
    points?: QdrantPoint[]
    next_page_offset?: string | number | null
  }
}

function setCors(res: { set: (field: string, value: string) => unknown }) {
  res.set("Access-Control-Allow-Origin", "*")
  res.set("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS")
  res.set("Access-Control-Allow-Headers", "Authorization,Content-Type")
  res.set("Access-Control-Max-Age", "3600")
}

function normalizeAdminEmail(email: string | undefined) {
  return email?.trim().toLowerCase() ?? ""
}

function isDashboardAdminEmail(email: string | undefined): boolean {
  const normalized = normalizeAdminEmail(email)
  if (!normalized) return false
  const envAllowlist = (process.env.PA_DASHBOARD_ADMIN_EMAILS ?? "")
    .split(",")
    .map((s) => normalizeAdminEmail(s))
    .filter(Boolean)
  return normalized.endsWith("@wekruit.com") || normalized === "indolencorlol@gmail.com" || envAllowlist.includes(normalized)
}

async function requireDashboardAdmin(req: { header: (name: string) => string | undefined }) {
  const authz = req.header("authorization") ?? req.header("Authorization") ?? ""
  const match = authz.match(/^Bearer\s+(.+)$/i)
  if (!match) throw Object.assign(new Error("Missing bearer token"), { status: 401 })
  const decoded = await getAuth().verifyIdToken(match[1]!)
  if (!isDashboardAdminEmail(decoded.email)) {
    throw Object.assign(new Error("Forbidden"), { status: 403 })
  }
  return decoded
}

function qdrantHeaders() {
  return { "api-key": QDRANT_API_KEY.value(), "content-type": "application/json" }
}

function qdrantBaseUrl() {
  return QDRANT_URL.value().replace(/\/+$/, "")
}

async function qdrantJson(path: string, init: RequestInit) {
  const resp = await fetch(`${qdrantBaseUrl()}${path}`, {
    ...init,
    headers: { ...qdrantHeaders(), ...(init.headers ?? {}) },
  })
  if (!resp.ok) {
    throw new Error(`Qdrant ${path} failed: ${resp.status} ${await resp.text()}`)
  }
  return resp.json() as Promise<unknown>
}

/**
 * Phase 11.3 kill switch — same semantics as stacked.ts. Default OFF
 * (legacy `userId`-keyed Qdrant) so Deploy 1 is a no-op. Set
 * `PA_MEM0_USE_PARTITION_KEY=true` in Deploy 2 to flip dashboard ops
 * onto the resolved partition.
 */
function partitionSwitchEnabled(): boolean {
  const raw = process.env.PA_MEM0_USE_PARTITION_KEY
  if (typeof raw !== "string") return false
  return raw.trim().toLowerCase() === "true"
}

function qdrantUserFilter(userId: string) {
  return { must: [{ key: "user_id", match: { value: userId } }] }
}

function pointMatchesQuery(point: QdrantPoint, q: string) {
  if (!q) return true
  return JSON.stringify(point.payload ?? {}).toLowerCase().includes(q.toLowerCase())
}

async function listQdrantMemories(userId: string, search: string, limit = 100) {
  const body = {
    filter: qdrantUserFilter(userId),
    limit: Math.min(Math.max(limit, 1), 200),
    with_payload: true,
    with_vector: false,
  }
  const json = await qdrantJson(`/collections/${QDRANT_COLLECTION}/points/scroll`, {
    method: "POST",
    body: JSON.stringify(body),
  }) as QdrantScrollResponse
  return (json.result?.points ?? []).filter((p) => pointMatchesQuery(p, search))
}

async function retrieveQdrantPoint(pointId: string) {
  const json = await qdrantJson(`/collections/${QDRANT_COLLECTION}/points`, {
    method: "POST",
    body: JSON.stringify({ ids: [pointId], with_payload: true, with_vector: false }),
  }) as { result?: QdrantPoint[] }
  return json.result?.[0] ?? null
}

async function deleteQdrantPointForUser(userId: string, pointId: string) {
  const point = await retrieveQdrantPoint(pointId)
  if (!point) throw Object.assign(new Error("Memory point not found"), { status: 404 })
  if (point.payload?.user_id !== userId) throw Object.assign(new Error("Memory point does not belong to user"), { status: 403 })
  await qdrantJson(`/collections/${QDRANT_COLLECTION}/points/delete?wait=true`, {
    method: "POST",
    body: JSON.stringify({ points: [point.id] }),
  })
}

function sendJson(res: { status: (code: number) => { json: (body: unknown) => unknown } }, status: number, body: unknown) {
  res.status(status).json(body)
}

function nowIso() {
  return new Date().toISOString()
}

function normalizeE164(phone: string): string {
  const d = phone.replace(/\D/g, "")
  if (phone.trim().startsWith("+")) return `+${d}`
  return d.length === 10 ? `+1${d}` : `+${d}`
}

function normalizeImessageParticipant(participant: string): string {
  const value = participant.trim()
  if (!value) return ""
  if (value.includes("@")) return value.toLowerCase()
  return normalizeE164(value)
}

function sessionDocId(userId: string, channel: Channel, externalChatId: string): string {
  const h = createHash("sha256").update(`${userId}|${channel}|${externalChatId}`).digest("hex")
  return `ses_${h.slice(0, 32)}`
}

async function findUserByParticipant(db: Firestore, participant: string): Promise<User | null> {
  const n = normalizeImessageParticipant(participant)
  if (!n) return null
  const query = n.includes("@")
    ? db.collection(PA_COLLECTIONS.users).where("channels.imessageHandle", "==", n)
    : db.collection(PA_COLLECTIONS.users).where("phoneE164", "==", n)
  const snap = await query.limit(1).get()
  if (snap.empty) return null
  const d = snap.docs[0]!
  return { id: d.id, ...d.data() } as User
}

async function createProvisionalUser(
  db: Firestore,
  participant: string,
  options?: {
    /** Override the canonical source label (QR opener stamps `qr_imessage`). */
    source?: string
    /** First-touch campaign code (per-card attribution, QR path). */
    firstTouchCampaign?: string
    /**
     * Scan-time sticky Sendblue number to persist as the override (doc §3.4). The
     * scan-time pick WINS — we do NOT re-pick — so downstream sticky reads
     * (assignCandidateSenderNumber honors an existing senderNumber) stay consistent.
     */
    senderNumber?: string
    senderGroupId?: string
  }
): Promise<User> {
  const id = randomUUID()
  const n = normalizeImessageParticipant(participant)
  const u: User = {
    id,
    phoneE164: n,
    createdAt: nowIso(),
    onboardingStatus: "provisional" as OnboardingStatus,
    channels: { imessageHandle: n },
  }
  // 2026-05-18 cleanup goal — every pa-users initial create must stamp a
  // canonical source label. Broker / sendblue inbound = real candidate flow.
  // QR opener overrides to `qr_imessage` so the funnel is attributable.
  ;(u as User & { source?: string }).source = options?.source ?? "candidate"
  const extra = u as User & {
    firstTouchCampaign?: string
    senderNumber?: string
    senderGroupId?: string
    senderAssignedAt?: string
    senderAssignedSource?: string
  }
  if (options?.firstTouchCampaign) extra.firstTouchCampaign = options.firstTouchCampaign
  // Override-first sticky: persist the scan-time number so the per-uid pick never
  // clobbers it (assignCandidateSenderNumber no-ops when senderNumber is present).
  if (options?.senderNumber) {
    extra.senderNumber = options.senderNumber
    if (options.senderGroupId) extra.senderGroupId = options.senderGroupId
    extra.senderAssignedAt = nowIso()
    extra.senderAssignedSource = "qr_scan"
  } else {
    // USER↔NUMBER BINDING (2026-06-02) — TEXT-ONLY provisional users (the
    // direct-start path: an unregistered number that texts "hi" with NO QR scan)
    // previously got NO persisted binding, so every later send re-derived the
    // line by hash and reshuffled when the pool grew. Mint a capacity-aware
    // sticky binding HERE at create so the user is bound from their very first
    // outbound (source='inbound_first'). Best-effort: a mint failure leaves
    // senderNumber unset and the send-path reducer lazily mints later — no drop.
    try {
      const {
        loadSendbluePoolWithCounters,
        pickFromNumber,
        findSendbluePoolNumber,
        sendblueGroupId,
        incrementAssignedNewUsers,
      } = await import("./sendblue/pool.js")
      const pool = await loadSendbluePoolWithCounters(db)
      const minted = pickFromNumber(pool, id, { requireNewUserCapacity: true })
      if (minted) {
        const groupId = sendblueGroupId(
          findSendbluePoolNumber(pool, minted) ?? { number: minted, status: "active" }
        )
        extra.senderNumber = minted
        extra.senderGroupId = groupId
        extra.senderAssignedAt = nowIso()
        extra.senderAssignedSource = "inbound_first"
        // Keep new-user capacity accounting correct (mirrors the QR scan-time bump).
        try {
          await incrementAssignedNewUsers(db, groupId)
        } catch {
          /* counter bump is best-effort — overlay clamps on read */
        }
      }
    } catch (err) {
      logger.warn("[createProvisionalUser] text-only sender binding mint failed (non-fatal)", {
        userId: id,
        err: err instanceof Error ? err.message : String(err),
      })
    }
  }
  await db.collection(PA_COLLECTIONS.users).doc(id).set(u)
  return u
}

export function shouldCreateProvisionalUserForBrokerPayload(rawPayload: BrokerImessageEvent["rawPayload"] | undefined): boolean {
  const payload = (rawPayload ?? {}) as BrokerImessageEvent["rawPayload"] & { source?: unknown; text?: unknown }
  if (payload.e2eTest === true) return false
  // Direct-start (Adam 2026-06-02): an unregistered number that sends a REAL text
  // message (a bare "hi" etc.) now creates a provisional user + onboards — no QR
  // scan required. Previously source==='sendblue' was hard-blocked (anti-spam).
  // We still skip non-text events (typing / delivery / line_blocked) so a stray
  // system webhook can never auto-create a profile. The QR opener path still runs
  // FIRST in processBrokerImessageEvent, so scanToken + sticky-number binding is
  // preserved for genuine QR scans (this gate is the fallback for plain text).
  const text = typeof payload.text === "string" ? (payload.text ?? "").trim() : ""
  if (text.length === 0) return false
  return true
}

async function getOrCreateSession(
  db: Firestore,
  userId: string,
  channel: Channel,
  externalChatId: string
): Promise<{ id: string; userId: string; externalChatId: string; channel: Channel }> {
  const id = sessionDocId(userId, channel, externalChatId)
  const ref = db.collection(PA_COLLECTIONS.sessions).doc(id)
  const existing = await ref.get()
  if (existing.exists) {
    const d = existing.data()!
    return { id, userId, externalChatId, channel, ...d } as {
      id: string
      userId: string
      externalChatId: string
      channel: Channel
    }
  }
  await ref.set({ id, userId, channel, externalChatId, createdAt: nowIso(), lastMessageAt: nowIso() })
  return { id, userId, externalChatId, channel }
}

function isBrokerImessageEvent(data: InboundEvent | BrokerImessageEvent): data is BrokerImessageEvent {
  return (data as BrokerImessageEvent).rawPayload?.kind === "imessage"
}

async function claimBrokerEvent(db: Firestore, data: BrokerImessageEvent): Promise<BrokerImessageEvent | null> {
  const ref = db.collection(PA_COLLECTIONS.inboundEvents).doc(data.id)
  const now = new Date()
  const claimedAt = now.toISOString()
  // 180s (raised from 120s, 2026-05-30) so it stays AHEAD of the thin-Claire run ceiling
  // (RUN_TIMEOUT_MS=100s) + per-turn overhead. A cold find_match (V16 ~80s) must finish before
  // the lease expires, or a second worker re-claims the still-running event and double-fires.
  const leaseUntil = new Date(now.getTime() + 180_000).toISOString()
  return db.runTransaction(async (t) => {
    const snap = await t.get(ref)
    if (!snap.exists) return null
    const raw = { id: snap.id, ...snap.data() } as BrokerImessageEvent
    const status = raw.status
    if (
      status &&
      status !== "pending" &&
      status !== "failed" &&
      !(status === "running" && isInboundLeaseExpired(raw.leaseUntil, now)) &&
      !(status === "processing" && isInboundLeaseExpired(raw.leaseUntil, now))
    ) {
      return null
    }
    t.set(ref, { status: "running", claimedAt, leaseUntil, startedAt: claimedAt, updatedAt: claimedAt }, { merge: true })
    return { ...raw, status: "running", claimedAt, leaseUntil }
  })
}

// iter32 deploy-fix 2026-05-04 — `makeOrchestratorDeps` factory moved to
// ./orchestrator-deps.ts. Imported + re-exported above so admin-bootstrap
// can share the identical Mailgun bindings.


async function processBrokerImessageEvent(
  db: Firestore,
  data: BrokerImessageEvent,
  deps: import("@pa/pa-orchestrator").OrchestratorStoreDeps = {}
): Promise<number> {
  const claimed = await claimBrokerEvent(db, data)
  if (!claimed) return 0
  const payload = claimed.rawPayload
  // An image-only iMessage (screenshot proof, photo) arrives with empty `text` + a `mediaUrl`. It is
  // a VALID inbound — dropping it as empty_text strands the candidate (the screenshot never reaches
  // the prescreen image-proof guard / cv-ingest). Accept empty text WHEN media is present.
  const hasInboundMedia = typeof payload?.mediaUrl === "string" && payload.mediaUrl.trim().length > 0
  if (!payload?.participant || (!payload.text && !hasInboundMedia) || !payload.chatId) {
    // V5 QA Agent-E 2026-05-04: when validation throws, the doc was already
    // claimed (status="running") so it leaks until the 120s lease expires.
    // Finalize the row here so dashboard / downstream observability see it
    // as failed instead of silently stuck.
    const reason = !payload?.participant
      ? "missing_participant"
      : !payload.chatId
        ? "missing_chatId"
        : "empty_text"
    try {
      await db.collection(PA_COLLECTIONS.inboundEvents).doc(claimed.id).set(
        {
          status: "failed",
          lastError: `Invalid broker iMessage payload: ${reason}`,
          errorCode: "INVALID_BROKER_PAYLOAD",
          completedAt: nowIso(),
          updatedAt: nowIso(),
        },
        { merge: true }
      )
    } catch {
      /* swallow — finalization is best-effort, the original throw still surfaces */
    }
    throw new Error(`Invalid broker iMessage payload: ${reason}`)
  }
  // Media-only inbound may carry no text — every downstream read uses `(payload.text ?? "")` so a
  // screenshot-only message flows through as an empty-text turn (with mediaUrl) instead of crashing.
  let user: User | null = null
  const phoneE164 = normalizeImessageParticipant(payload.participant)
  // Never-silent-drop (Adam 2026-05-29): the opener-phone-wins + same-phone
  // merge policy means resolveInboundUserId should no longer throw
  // identity_conflict for the texted-from-a-new-number case. But ANY identity
  // resolution error (legacy data, partial merge, schema) must NOT re-throw
  // out of here — that leaves the inbound event stuck `running` until the
  // 120s lease expires and silently never replies (the Yogesh bug). On an
  // identity_conflict we finalize the event terminal (status=failed, observable
  // in the dashboard + re-processable on the next inbound) and fall through to
  // the unbound-user path so the candidate is not silently dropped.
  let resolvedId: string | null = null
  if (phoneE164) {
    try {
      resolvedId = await resolveInboundUserId(db, phoneE164, payload.text)
    } catch (resolveErr) {
      const msg = resolveErr instanceof Error ? resolveErr.message : String(resolveErr)
      if (msg.startsWith("identity_conflict:")) {
        logger.warn("[onPaInbound] identity conflict during resolve — finalizing event terminal (no silent drop)", {
          eventId: claimed.id,
          phoneTail: phoneE164.slice(-4),
          err: msg,
        })
        await db.collection(PA_COLLECTIONS.inboundEvents).doc(claimed.id).set(
          {
            status: "failed",
            lastError: msg,
            errorCode: "IDENTITY_CONFLICT",
            completedAt: nowIso(),
            updatedAt: nowIso(),
            routedTo: "identity_conflict",
          },
          { merge: true },
        )
        return 1
      }
      throw resolveErr
    }
  }
  if (resolvedId) {
    const resolvedSnap = await db.collection(PA_COLLECTIONS.users).doc(resolvedId).get()
    if (resolvedSnap.exists) {
      user = { id: resolvedSnap.id, ...resolvedSnap.data() } as User
    }
  }
  if (!user) {
    user = await findUserByParticipant(db, payload.participant)
  }
  if (!user) {
    // Direct-start (Adam 2026-06-02): an unregistered number that sends a real
    // text now creates a provisional user + onboards (syncGateAllows below).
    // The QR opener check still runs FIRST and UNCONDITIONALLY so a genuine QR
    // scan (`Hi, WeKruit, my verification code is <scanToken>`, or the legacy
    // `Hello, WeKruit! <scanToken>`) keeps its special provisioning —
    // source='qr_imessage' + scanToken claim + sticky-number reconcile — instead
    // of falling through to the generic create. Non-text/system events are still
    // blocked by shouldCreateProvisionalUserForBrokerPayload (empty text → false).
    const syncGateAllows = shouldCreateProvisionalUserForBrokerPayload(payload)
    let qrProvision: import("./qr-onboarding/scan.js").QrOpenerProvisionDecision = {
      shouldProvision: false,
      scan: null,
    }
    {
      try {
        const { resolveQrOpenerProvision } = await import("./qr-onboarding/scan.js")
        qrProvision = await resolveQrOpenerProvision(db, payload.text)
      } catch (err) {
        logger.warn("[onPaInbound] QR opener provision check failed (non-fatal)", {
          eventId: claimed.id,
          err: err instanceof Error ? err.message : String(err),
        })
      }
    }
    if (!syncGateAllows && !qrProvision.shouldProvision) {
      const externalChatId = normalizeImessageParticipant(payload.participant)
      const isE2eUnbound = payload.e2eTest === true
      logger.warn("[onPaInbound] inbound skipped without bound pa-users profile", {
        eventId: claimed.id,
        participant: payload.participant,
        externalChatId,
        source: (payload as Record<string, unknown>).source ?? null,
        e2eTest: isE2eUnbound,
      })
      await db.collection(PA_COLLECTIONS.inboundEvents).doc(claimed.id).set(
        {
          status: "completed",
          completedAt: nowIso(),
          updatedAt: nowIso(),
          routedTo: isE2eUnbound ? "e2e_unbound_user" : "sendblue_unbound_user",
          errorCode: isE2eUnbound ? "E2E_UNBOUND_USER" : "SENDBLUE_UNBOUND_USER",
          externalChatId,
          from: payload.participant,
          body: (payload.text ?? "").trim(),
        },
        { merge: true }
      )
      return 1
    }
    if (qrProvision.shouldProvision && qrProvision.scan) {
      // QR opener — stamp the campaign-mapped source (yc-startup-school event QR
      // → yc_startup_school so Claire's yc event intake fires; default
      // qr_imessage) + the campaign, and reconcile the scan-time sticky number
      // onto the new profile (override-first, doc §3.4).
      const scan = qrProvision.scan
      const { qrCampaignSource } = await import("./qr-onboarding/scan.js")
      user = await createProvisionalUser(db, payload.participant, {
        source: qrCampaignSource(scan.campaign),
        firstTouchCampaign: scan.campaign,
        senderNumber: scan.number,
        senderGroupId: scan.groupId,
      })
      // Mark the reservation claimed (dedupe double-scan / webhook retry,
      // doc §3 Race C/D). Best-effort — never blocks delivery.
      try {
        const { claimQrScanPending } = await import("./qr-onboarding/scan.js")
        await claimQrScanPending(db, scan.scanToken, user.id, nowIso())
      } catch (err) {
        logger.warn("[onPaInbound] QR scan-pending claim failed (non-fatal)", {
          eventId: claimed.id,
          userId: user.id,
          err: err instanceof Error ? err.message : String(err),
        })
      }
    } else {
      user = await createProvisionalUser(db, payload.participant)
    }
  }
  // Dev re-onboard bypass (Adam 2026-06-01): an EXISTING known user whose uid is in
  // QR_REONBOARD_DEV_UIDS, texting a CANARY QR opener, gets NON-DESTRUCTIVELY
  // re-onboarded — we clear ONLY their conversational onboarding/prescreen process
  // state so onboarding self-starts fresh next turn (tags / resume / memory KEPT).
  // A normal known user on a canary QR is NOT re-onboarded (stays in normal flow);
  // a freshly-created provisional uid is never a dev uid so it's naturally excluded.
  try {
    const { resolveQrReonboard } = await import("./qr-onboarding/scan.js")
    const reonboard = await resolveQrReonboard(db, payload.text, user.id)
    if (reonboard.shouldReonboard && reonboard.scan) {
      const { reonboardExistingUserViaQr, claimQrScanPending } = await import("./qr-onboarding/scan.js")
      const reset = await reonboardExistingUserViaQr(db, user.id, reonboard.scan, nowIso())
      await claimQrScanPending(db, reonboard.scan.scanToken, user.id, nowIso())
      logger.info("[onPaInbound] QR dev re-onboard — onboarding state reset (non-destructive)", {
        eventId: claimed.id,
        userId: user.id,
        campaign: reonboard.scan.campaign,
        prescreenSessionsReset: reset.prescreenSessionsReset,
      })
      // Re-read so this turn runs against the cleared state (onboarding cold-start).
      const refreshed = await db.collection(PA_COLLECTIONS.users).doc(user.id).get()
      if (refreshed.exists) user = { id: refreshed.id, ...refreshed.data() } as User
    }
  } catch (err) {
    logger.warn("[onPaInbound] QR dev re-onboard check failed (non-fatal)", {
      eventId: claimed.id,
      userId: user.id,
      err: err instanceof Error ? err.message : String(err),
    })
  }
  void markClaireConversationStarted(db, user.id).catch((err: unknown) => {
    logger.warn("[onPaInbound] claireConversationStarted stamp failed", {
      userId: user.id,
      err: err instanceof Error ? err.message : String(err),
    })
  })
  if (user.onboardingStatus === "provisional") {
    await db.collection(PA_COLLECTIONS.users).doc(user.id).set({ onboardingStatus: "active", updatedAt: nowIso() }, { merge: true })
  }
  const externalChatId = normalizeImessageParticipant(payload.participant)
  const session = await getOrCreateSession(db, user.id, "imessage", externalChatId)
  const p = payload as BrokerImessageEvent["rawPayload"] & Record<string, unknown>
  const event: InboundEvent = {
    id: claimed.id,
    userId: user.id,
    sessionId: session.id,
    channel: "imessage",
    externalChatId,
    from: payload.participant,
    body: (payload.text ?? "").trim(),
    status: "pending",
    createdAt: claimed.createdAt,
    idempotencyKey: claimed.idempotencyKey,
    rawMeta: {
      source: "imessage_broker",
      ...(payload.messageRowId !== undefined ? { messageRowId: payload.messageRowId } : {}),
      ...(payload.chatId !== undefined ? { chatId: payload.chatId } : {}),
      brokerEventId: claimed.id,
      ...(payload.harness ? { harness: payload.harness } : {}),
      ...(typeof p.triggerResumeId === "string" && p.triggerResumeId.trim()
        ? { triggerResumeId: p.triggerResumeId.trim() }
        : {}),
      ...(p.cvParsedTrigger === true ? { cvParsedTrigger: true } : {}),
      ...(typeof p.messageHandle === "string" ? { messageHandle: p.messageHandle } : {}),
      ...(typeof p.source === "string" ? { imessagePayloadSource: p.source } : {}),
      // BUG #6 — carry the inbound attachment URL (résumé PDF) to the thin read path
      // so cutover can run the SAME ingestCv wheel the website uses (covers cold users
      // the webhook Stream-D skips: no userId at webhook time).
      ...(typeof p.mediaUrl === "string" && p.mediaUrl.trim() ? { mediaUrl: p.mediaUrl.trim() } : {}),
    },
  }
  await db.collection(PA_COLLECTIONS.inboundEvents).doc(claimed.id).set(
    {
      userId: user.id,
      sessionId: session.id,
      externalChatId,
      from: payload.participant,
      body: (payload.text ?? "").trim(),
      // Persist rawMeta (incl. messageHandle) so the thin-Claire cutover below can read the
      // iMessage handle for tapbacks. Additive — legacy processInboundEvent uses the in-memory
      // `event` object, not this doc, so this only enriches observability + the thin read path.
      rawMeta: event.rawMeta,
    },
    { merge: true }
  )

  // Record last-inbound timestamp (Adam 2026-06-23) — the dormancy signal the 20-day reactivation
  // sweep keys on. Best-effort; a write failure never blocks the turn. STOP messages also stamp it
  // (harmless — doNotContact hard-excludes them from the sweep).
  void db
    .collection(PA_COLLECTIONS.users)
    .doc(user.id)
    .set({ lastInboundAt: nowIso() }, { merge: true })
    .catch((err: unknown) =>
      logger.warn("[onPaInbound] lastInboundAt stamp failed", {
        userId: user.id,
        err: err instanceof Error ? err.message : String(err),
      }),
    )

  // ── DETERMINISTIC SMS STOP/START GATE (Adam 2026-06-10, compliance) ──────
  // THE SEAM: this is the EARLIEST point on the direct broker path where userId,
  // sessionId, toE164, and the inbound text all exist — BEFORE the prescreen
  // trigger, the active-prescreen turn router (whose isUserExitPrescreenReply
  // merely PAUSES a screen, it does not opt out), layoff/PII routing, thin
  // Claire, and the legacy orchestrator. A "STOP" must win over ALL of those —
  // a candidate mid-prescreen who texts STOP still opts out, before any LLM
  // call. Exact whole-message keyword equality only (stop-gate.ts); anything
  // longer ("stop sending me internships") falls through to the agent.
  // While doNotContact===true, every non-START inbound is swallowed silently.
  try {
    const { runStopGate } = await import("./claire-agent/stop-gate.js")
    const stopGate = await runStopGate(
      db,
      {
        eventId: claimed.id,
        userId: user.id,
        sessionId: session.id,
        toE164: payload.participant,
        text: (payload.text ?? "").trim(),
        ...(typeof p.messageHandle === "string" ? { inboundMessageHandle: p.messageHandle } : {}),
      },
      { log: (e, pl) => logger.info(`[stop-gate][onPaInbound] ${e}`, pl ?? {}) },
    )
    if (stopGate.handled) {
      await db.collection(PA_COLLECTIONS.inboundEvents).doc(claimed.id).set(
        {
          status: "completed",
          completedAt: nowIso(),
          updatedAt: nowIso(),
          routedTo: `stop_gate_${stopGate.action ?? "handled"}`,
        },
        { merge: true }
      )
      return 1
    }
  } catch (err) {
    // runStopGate never throws by design; this guards the dynamic import only.
    logger.warn("[stop-gate][onPaInbound] gate FAILED — falling through", {
      eventId: claimed.id,
      userId: user.id,
      err: err instanceof Error ? err.message : String(err),
    })
  }

  // ── INBOUND TAPBACK NO-OP GATE (live 2026-06-19) ─────────────────────────
  // An iMessage REACTION on one of Claire's own messages arrives as plaintext
  // (`Loved "…"`). Before this gate it was treated as a fresh user turn → Claire
  // re-acked AND re-ran find_match → duplicate batch. A reaction on OUR message
  // is a no-op: nothing sent, no tool call. Same earliest common seam as STOP;
  // mirrored in the coalescer path. Deterministic regex (tapback-parser.ts),
  // verified against Claire's recent assistant messages in pa-messages.
  try {
    const { runTapbackGate } = await import("./claire-agent/tapback-gate.js")
    const tapbackGate = await runTapbackGate(
      db,
      { eventId: claimed.id, userId: user.id, text: (payload.text ?? "").trim() },
      { log: (e, pl) => logger.info(`[tapback-gate][onPaInbound] ${e}`, pl ?? {}) },
    )
    if (tapbackGate.handled) {
      await db.collection(PA_COLLECTIONS.inboundEvents).doc(claimed.id).set(
        {
          status: "completed",
          completedAt: nowIso(),
          updatedAt: nowIso(),
          routedTo: "tapback_reaction_noop",
        },
        { merge: true }
      )
      return 1
    }
  } catch (err) {
    // runTapbackGate never throws by design; this guards the dynamic import only.
    logger.warn("[tapback-gate][onPaInbound] gate FAILED — falling through", {
      eventId: claimed.id,
      userId: user.id,
      err: err instanceof Error ? err.message : String(err),
    })
  }

  // Direct broker path can receive the same candidate trigger token as
  // Sendblue. Treat it as control-plane input here; never let it fall into
  // onboarding, where it would produce the q_lang prompt instead of starting
  // the job prescreen.
  try {
    const { decideBrokerPrescreenTrigger } = await import("./broker-prescreen-trigger.js")
    const triggerDecision = decideBrokerPrescreenTrigger((payload.text ?? "").trim(), user.id)
    if (triggerDecision.kind === "authorized") {
      const { runPreScreenForUser } = await import("./prescreen-session-start.js")
      const result = await runPreScreenForUser({
        db,
        jobId: triggerDecision.jobId,
        userId: triggerDecision.userId,
        toE164: payload.participant,
        // Broker control-plane trigger (decideBrokerPrescreenTrigger already gates on
        // self) — operator-authorized, not the candidate copy-paste threat surface.
        allowMatchedBypass: true,
        log: (event, payload) => logger.info(`[prescreen][onPaInbound][trigger] ${event}`, payload ?? {}),
      })
      await db.collection(PA_COLLECTIONS.inboundEvents).doc(claimed.id).set(
        {
          status: result.ok ? "completed" : "failed",
          completedAt: nowIso(),
          updatedAt: nowIso(),
          routedTo: "prescreen_trigger",
          prescreenSessionId: result.sessionId,
          ...(result.reason ? { prescreenReason: result.reason } : {}),
        },
        { merge: true }
      )
      return 1
    }
    if (triggerDecision.kind === "unauthorized") {
      logger.warn("[prescreen][onPaInbound][trigger] unauthorized", {
        userId: user.id,
        targetUserId: triggerDecision.targetUserId,
        jobId: triggerDecision.jobId,
        reason: triggerDecision.reason,
      })
      await db.collection(PA_COLLECTIONS.inboundEvents).doc(claimed.id).set(
        {
          status: "completed",
          completedAt: nowIso(),
          updatedAt: nowIso(),
          routedTo: "prescreen_trigger_unauthorized",
          errorCode: "PRESCREEN_TRIGGER_UNAUTHORIZED",
        },
        { merge: true }
      )
      return 1
    }
    if (triggerDecision.kind === "garbled_token") {
      // GARBLED START TOKEN (2026-06-16): the inbound looks like a prescreen link
      // structurally, but the bind-code did NOT resolve (corrupted brand + bad/
      // expired/unknown code, or codeless). Ask the candidate about a typo on the
      // SAME notice seam (runtimeSource pa_identity_notice → direct reply into the
      // thread this inbound arrived from) INSTEAD of dropping them into the
      // stranger cold opener — which would mint a duplicate empty account + dead
      // silence (live incident +16263623119). Deterministic copy, no LLM, NO new
      // account. Idempotency keyed on the inbound event id so webhook replays
      // collapse to one notice.
      logger.info("[prescreen][onPaInbound][trigger] garbled_token — typo-ask notice", {
        userId: user.id,
        eventId: claimed.id,
      })
      try {
        const { enqueueOutbound } = await import("@pa/pa-broker")
        const { BROKER_PRESCREEN_GARBLED_TOKEN_NOTICE } = await import("./broker-prescreen-trigger.js")
        await enqueueOutbound(db, {
          userId: user.id,
          toE164: payload.participant,
          body: BROKER_PRESCREEN_GARBLED_TOKEN_NOTICE,
          idempotencyKey: `out-prescreen-garbled-token-${claimed.id}`,
          runtimeApproved: true,
          runtimeSource: "pa_identity_notice",
        })
      } catch (noticeErr) {
        logger.warn("[prescreen][onPaInbound][trigger] garbled_token notice enqueue FAILED", {
          userId: user.id,
          eventId: claimed.id,
          err: noticeErr instanceof Error ? noticeErr.message : String(noticeErr),
        })
      }
      await db.collection(PA_COLLECTIONS.inboundEvents).doc(claimed.id).set(
        {
          status: "completed",
          completedAt: nowIso(),
          updatedAt: nowIso(),
          routedTo: "prescreen_trigger_garbled_token",
        },
        { merge: true }
      )
      return 1
    }
  } catch (err) {
    logger.warn("[prescreen][onPaInbound][trigger] check FAILED — falling through to active-session routing", {
      userId: user.id,
      err: err instanceof Error ? err.message : String(err),
    })
  }

  // v1.9 P85 hotfix — pre-screen routing for non-coalesced path.
  // If user has an active pre-screen session (terminal=null), route this
  // turn through PreScreenPipeline BEFORE Claire orchestrator. Mirrors the
  // check in paMessageCoalescer step 3a so onPaInbound + webhook fallback
  // both honor the prescreen state machine. Fail-open: any error falls
  // through to Claire so users don't get stuck.
  try {
    const { runPrescreenTurnIfActive } = await import("./prescreen-turn-handler.js")
    const psResult = await runPrescreenTurnIfActive({
      db,
      userId: user.id,
      toE164: payload.participant,
      replyText: (payload.text ?? "").trim(),
      // Carry the inbound image attachment so a screenshot-only answer to a
      // scoring question gets an "paste the numbers/link" ask instead of being
      // scored 0 → unfair HARD_STOP (live victim 2026-06-19).
      ...(typeof p.mediaUrl === "string" && p.mediaUrl.trim() ? { mediaUrl: p.mediaUrl.trim() } : {}),
      lang: "en",
      log: (event, payload) => logger.info(`[prescreen][onPaInbound] ${event}`, payload ?? {}),
    })
    const { isLayoffIntakeActiveForUser } = await import("./layoff-sms-start.js")
    const layoffOwnsTurn = psResult.handled ? false : await isLayoffIntakeActiveForUser(db, user.id)
    const turnOwner = decidePreClaireTurnOwner({
      prescreenHandled: psResult.handled,
      layoffOwnsTurn,
    })

    if (turnOwner === "prescreen") {
      logger.info("[prescreen][onPaInbound] handled — short-circuit Claire", {
        userId: user.id,
        sessionId: psResult.sessionId,
        terminal: psResult.terminal,
      })
      // Mark inbound as completed so onPaInbound's status-check is happy.
      await db.collection(PA_COLLECTIONS.inboundEvents).doc(claimed.id).set(
        {
          status: "completed",
          completedAt: nowIso(),
          updatedAt: nowIso(),
          routedTo: "prescreen",
        },
        { merge: true }
      )
      return 1
    }

    if (turnOwner === "layoff_orchestrator") {
      logger.info("[prescreen+pii][onPaInbound] skipped — active layoff intake owns this turn", {
        userId: user.id,
      })
    } else {
      // v1.9 hotfix — PII confirm pipeline check (chained after prescreen
      // terminal). If active PII session, route turn there before Claire.
      const { runPiiConfirmTurnIfActive } = await import("./pii-confirm-start.js")
      const piiResult = await runPiiConfirmTurnIfActive({
        db,
        userId: user.id,
        toE164: payload.participant,
        replyText: (payload.text ?? "").trim(),
        log: (event, payload) => logger.info(`[pii][onPaInbound] ${event}`, payload ?? {}),
      })
      if (piiResult.handled) {
        logger.info("[pii][onPaInbound] handled — short-circuit Claire", {
          userId: user.id,
          completed: piiResult.completed,
        })
        await db.collection(PA_COLLECTIONS.inboundEvents).doc(claimed.id).set(
          {
            status: "completed",
            completedAt: nowIso(),
            updatedAt: nowIso(),
            routedTo: "pii_confirm",
          },
          { merge: true }
        )
        return 1
      }
    }
  } catch (err) {
    logger.warn("[prescreen+pii][onPaInbound] check FAILED — falling through to Claire", {
      userId: user.id,
      err: err instanceof Error ? err.message : String(err),
    })
  }

  // Thin Claire cutover — DIRECT broker path (real iMessage). Flag-gated + fail-safe.
  // Every real Sendblue iMessage is a broker event (rawPayload.kind==='imessage'), so the
  // top-level dispatch (onPaInbound) routes it here; without this block thin Claire would only
  // ever be reachable via the coalescer (onboarding-complete users), and a normal triage text
  // from the canary would silently fall through to legacy = false-green. We call thin ONLY after
  // the prescreen-trigger (above), active-prescreen (runPrescreenTurnIfActive), layoff, and
  // PII-confirm pre-routes have each had their chance to short-circuit — so thin only ever sees a
  // free-conversation (triage) turn, matching its triage-only mode and leaving the reducer-owned
  // FSMs to the legacy path. maybeRunThinClaire re-checks isThinClaireEnabled(userId) itself and
  // returns false on flag-off / any error, so non-canary users hit legacy below, unchanged.
  // NOTE: thin is no longer triage-only — its mode-selector also runs ONBOARDING on the thin agent
  // (reusing the canonical sharedOnboarding state + tag writer). An active prescreen still defers to
  // the legacy runner (mode-selector returns deferToLegacy → maybeRunThinClaire returns false here).
  try {
    const thinHandled = await maybeRunThinClaire(db, claimed.id, {
      log: (e, p) => logger.info(`[thin-claire][onPaInbound] ${e}`, p ?? {}),
    })
    if (thinHandled) return 1
  } catch (err) {
    logger.warn("[thin-claire][onPaInbound] check FAILED — falling through to legacy Claire", {
      userId: user.id,
      err: err instanceof Error ? err.message : String(err),
    })
  }

  await processInboundEvent(event, createFirestoreOrchestratorStore(db, deps))
  return 1
}

export const onPaInbound = onDocumentCreated(
  {
    document: "pa-inbound-events/{eventId}",
    region: "us-central1",
    secrets: [
      SILICONFLOW_API_KEY,
      PA_OPENAI_AGENT_API_KEY,
      QDRANT_URL,
      QDRANT_API_KEY,
      // v1.7 Phase 69 — Anthropic Sonnet powers pa-resume-parser fallback
      // tier + sponsorship-inference + industry-second-pass. All paths
      // already gracefully fall through when ANTHROPIC_API_KEY is empty
      // (gpt-5.4-nano → gpt-4.1-mini → Qwen-7B chain). Listed here so the
      // moment Adam provisions the secret it auto-activates without redeploy
      // beyond the one Phase 69 rollout.
      ANTHROPIC_API_KEY,
      // Prescreen and PII-confirm turns can short-circuit Claire and send
      // directly from onPaInbound, so this function needs the same Sendblue
      // credentials as the webhook/outbox send paths.
      SENDBLUE_API_KEY_ID,
      SENDBLUE_API_SECRET_KEY,
      SENDBLUE_FROM_NUMBER,
      // Cal.com interview-scheduling (thin Claire offer_interview_slots /
      // book_interview_slot) + Mailgun confirmation email. Until Adam provisions
      // CALCOM_API_KEY the scheduling tools fail-open; MAILGUN_* power the
      // confirmation supplement.
      CALCOM_API_KEY,
      MAILGUN_API_KEY,
      MAILGUN_DOMAIN,
      MAILGUN_FROM,
      MAILGUN_REGION,
    ],
    // LATENCY FIX (Adam 2026-06-02): maxInstances:1 + concurrency:1 serialized EVERY inbound
    // globally — one turn at a time, plus a cold-start on the first message after idle (the live
    // "10s to read + 20s to reply"). The thin turn is IO-bound (waiting on the model), so:
    //   - concurrency 1→6: one instance serves 6 concurrent turns in parallel (the big win; base
    //     ~300-400MiB + per-turn working set fits 1GiB; the per-turn max-turns cap (8) bounds cost,
    //     so concurrency cannot re-trigger the 2026-06-01 token runaway).
    //   - minInstances 0→1: keep ONE instance warm → no cold-start on the first message (~$, worth
    //     it for a live product).
    //   - maxInstances 1→3: burst headroom (3 × 1GiB = 3GiB max; within the ~38GiB Adam freed),
    //     still bounded so a deploy can't default to 100+ instances and blow the region quota.
    memory: "1GiB",
    minInstances: 1,
    maxInstances: 3,
    timeoutSeconds: 300,
    concurrency: 6,
  },
  async (event) => {
    const snap = event.data
    if (!snap) {
      logger.warn("onPaInbound fired without snapshot", { eventId: event.params.eventId })
      return
    }
    const data = snap.data() as (InboundEvent | BrokerImessageEvent) | undefined
    if (!data) {
      logger.warn("onPaInbound fired without data", { eventId: event.params.eventId })
      return
    }
    if (data.status && data.status !== "pending") {
      logger.info("onPaInbound skipping non-pending event", {
        eventId: data.id,
        status: data.status,
      })
      return
    }
    // v1.5 Stream-D — when paMessageCoalesceEnabled is on, the webhook stamps
    // `coalescing:true` on the per-message inbound row and enqueues a Cloud
    // Tasks delayed task. The coalescer fires later, synthesizes ONE merged
    // event, and drives the orchestrator from there. Per-message rows must
    // NOT be processed here — that would defeat the entire coalescer.
    if ((data as { coalescing?: boolean }).coalescing === true) {
      logger.info("onPaInbound skipping coalescing inbound (handled by paMessageCoalescer)", {
        eventId: data.id,
        coalesceTurnId: (data as { coalesceTurnId?: string }).coalesceTurnId,
      })
      return
    }

    // Re-export secret values into the env so that `@pa/memory` and
    // `@pa/agent-runtime` (which read process.env) pick them up. Cloud
    // Functions Gen 2 maps secrets into env automatically when listed in
    // `secrets`, but we also expose under MEM0_LLM_API_KEY for the OSS path.
    process.env.SILICONFLOW_API_KEY = SILICONFLOW_API_KEY.value()
    process.env.QDRANT_URL = QDRANT_URL.value()
    process.env.QDRANT_API_KEY = QDRANT_API_KEY.value()
    process.env.SENDBLUE_API_KEY_ID = SENDBLUE_API_KEY_ID.value()
    process.env.SENDBLUE_API_SECRET_KEY = SENDBLUE_API_SECRET_KEY.value()
    // Cal.com + Mailgun — thin Claire scheduling tools read process.env.CALCOM_API_KEY
    // / MAILGUN_* lazily. Re-export defensively; an unset CALCOM_API_KEY just makes
    // the scheduling tools fail-open (a missing key is not an error here).
    try {
      process.env.CALCOM_API_KEY = CALCOM_API_KEY.value()
    } catch {
      /* optional — scheduling tools fail-open without it */
    }
    try {
      process.env.MAILGUN_API_KEY = MAILGUN_API_KEY.value()
    } catch {
      /* optional */
    }
    try {
      process.env.MAILGUN_DOMAIN = MAILGUN_DOMAIN.value()
    } catch {
      /* optional — defaults to wekruit.com */
    }
    try {
      process.env.MAILGUN_FROM = MAILGUN_FROM.value()
    } catch {
      /* optional — defaults to WeKruit <hi@wekruit.com> */
    }
    try {
      process.env.MAILGUN_REGION = MAILGUN_REGION.value()
    } catch {
      /* optional — defaults to us */
    }
    try {
      const fromNumber = SENDBLUE_FROM_NUMBER.value().trim()
      if (fromNumber) {
        process.env.SENDBLUE_FROM_NUMBER = fromNumber
      } else {
        delete process.env.SENDBLUE_FROM_NUMBER
      }
    } catch {
      delete process.env.SENDBLUE_FROM_NUMBER
    }
    try {
      const openAiAgentKey = PA_OPENAI_AGENT_API_KEY.value().trim()
      if (openAiAgentKey) {
        process.env.PA_OPENAI_AGENT_API_KEY = openAiAgentKey
      } else {
        delete process.env.PA_OPENAI_AGENT_API_KEY
      }
    } catch {
      delete process.env.PA_OPENAI_AGENT_API_KEY
    }
    // v1.7 Phase 69 — Re-export ANTHROPIC_API_KEY from the Firebase secret
    // into process.env so packages that read it directly (pa-resume-parser/
    // src/router.ts, cv-ingest/industry-second-pass.ts) pick it up. Until
    // Adam provisions the secret, the placeholder is `__UNSET__` (empty
    // payloads aren't allowed in Secret Manager) — treat that as unset so
    // downstream gracefully falls through to the OpenAI tier.
    try {
      const anthropicKey = ANTHROPIC_API_KEY.value().trim()
      if (anthropicKey && anthropicKey !== "__UNSET__") {
        process.env.ANTHROPIC_API_KEY = anthropicKey
      } else {
        delete process.env.ANTHROPIC_API_KEY
      }
    } catch {
      // secret unbound — leave existing env (may be empty, that's fine)
    }
    // 2026-05-07 Adam directive — STOP poisoning OPENAI_API_KEY and
    // OPENAI_BASE_URL with SiliconFlow values. Real OpenAI callers
    // need real OpenAI endpoint; SiliconFlow callers need SF endpoint.
    // mem0/agent-runtime explicitly points at SF via dedicated MEM0_*
    // env vars — they don't depend on OPENAI_BASE_URL aliasing anymore.
    const siliconflowBase = "https://api.siliconflow.cn/v1"
    const trimOr = (v: string | undefined, fallback: string) => {
      const t = v?.trim()
      return t && t.length > 0 ? t.replace(/\/+$/, "") : fallback
    }
    // mem0 LLM (Qwen-72B) + embedder (BGE-M3) — explicit SF binding.
    process.env.MEM0_LLM_API_KEY = trimOr(process.env.MEM0_LLM_API_KEY, SILICONFLOW_API_KEY.value())
    process.env.MEM0_LLM_BASE_URL = trimOr(process.env.MEM0_LLM_BASE_URL, siliconflowBase)
    process.env.MEM0_LLM_MODEL = trimOr(process.env.MEM0_LLM_MODEL, "Qwen/Qwen2.5-72B-Instruct")
    process.env.MEM0_EMBED_API_KEY = trimOr(process.env.MEM0_EMBED_API_KEY, SILICONFLOW_API_KEY.value())
    process.env.MEM0_EMBED_BASE_URL = trimOr(process.env.MEM0_EMBED_BASE_URL, siliconflowBase)
    process.env.MEM0_EMBED_MODEL = trimOr(process.env.MEM0_EMBED_MODEL, "BAAI/bge-m3")
    process.env.MEM0_EMBED_DIMS = trimOr(process.env.MEM0_EMBED_DIMS, "1024")

    const db = getFirestore()
    // Phase 24.5 — read paRateLimitPerUserEnabled (perUser scope) for the
    // event's user. Reading site only — actual enforcement is Phase 26.
    // Telemetry-friendly: logs the resolved value so the rate-limit
    // policy is observable BEFORE we wire enforcement.
    try {
      const { getFlag } = await import("@pa/pa-persistence")
      const userId = "userId" in data ? (data as { userId?: string }).userId : undefined
      const rateLimitEnabled = await getFlag(
        db,
        "paRateLimitPerUserEnabled",
        { userId, env: process.env },
        true
      )
      logger.debug("onPaInbound rate-limit flag", { userId, rateLimitEnabled })
      // Phase 26 T4 — log resolved agent-registry version per inbound for
      // forensic traceability (which prompt/version handled which turn).
      try {
        const { resolveAgentVersion } = await import("@pa/agent-registry")
        const r = await resolveAgentVersion(db, { getFlag: async (k) => String(await getFlag(db, k, { env: process.env }, "")), env: process.env as Record<string, string | undefined> })
        logger.info("onPaInbound agent-version resolved", { source: r.source, version: r.raw, agentId: r.agent?.id })
      } catch (avErr) { logger.warn("onPaInbound agent-version resolve failed", { err: avErr instanceof Error ? avErr.message : String(avErr) }) }
    } catch (flagErr) {
      // Never let a flag read break the inbound path — Phase 26 will
      // enforce; for now flag failures degrade silently.
      logger.warn("onPaInbound flag read failed", {
        eventId: data.id,
        err: flagErr instanceof Error ? flagErr.message : String(flagErr),
      })
    }
    // Stream D pivot — Claire-only architecture. CV side-effects
    // (tapback + parsedCandidateResumes ingest) fire in the webhook
    // (apps/functions/src/sendblue/webhook.ts); onPaInbound runs the
    // default Claire orchestrator path UNCONDITIONALLY for every event.
    try {
      const orchestratorDeps = makeOrchestratorDeps()
      // Thin Claire (flag-gated): for canary users, handle the turn and skip the legacy path.
      const thinHandled = isBrokerImessageEvent(data)
        ? false
        : await maybeRunThinClaire(db, data.id, {
            log: (e, p) => logger.info(`[thin-claire] ${e}`, p ?? {}),
          })
      const processed = isBrokerImessageEvent(data)
        ? await processBrokerImessageEvent(db, data, orchestratorDeps)
        : thinHandled
          ? "thin_claire"
          : await claimAndProcessInboundEvent(db, data.id, undefined, orchestratorDeps)
      logger.info("onPaInbound processed", { eventId: data.id, userId: "userId" in data ? data.userId : undefined, processed })
    } catch (err) {
      logger.error("onPaInbound failed", {
        eventId: data.id,
        userId: "userId" in data ? data.userId : undefined,
        err: err instanceof Error ? err.message : String(err),
      })
      throw err
    }
  },
)

export const memoryAdmin = onRequest(
  {
    region: "us-central1",
    secrets: [QDRANT_URL, QDRANT_API_KEY],
    memory: "512MiB",
    timeoutSeconds: 120,
    cors: false,
  },
  async (req, res) => {
    setCors(res)
    if (req.method === "OPTIONS") {
      res.status(204).send("")
      return
    }

    try {
      await requireDashboardAdmin(req)
      const userId = String(req.query.userId ?? req.body?.userId ?? "").trim()
      if (!userId) {
        sendJson(res, 400, { error: "userId is required" })
        return
      }

      // Phase 11.3 — resolve the Mem0/Qdrant partition key. Behind the
      // kill switch (default OFF) all paths still scope on `userId` so
      // dashboard behavior is byte-identical to pre-11.3.
      const db = getFirestore()
      let mem0PartitionKey = userId
      if (partitionSwitchEnabled()) {
        const userSnap = await db.collection(PA_COLLECTIONS.users).doc(userId).get()
        if (!userSnap.exists) {
          sendJson(res, 404, { error: "user_not_found", userId })
          return
        }
        const userData = userSnap.data() as Pick<User, "id" | "mem0UserId"> | undefined
        mem0PartitionKey = resolveMem0PartitionKey({
          id: userId,
          mem0UserId: userData?.mem0UserId,
        })
        // Best-effort drift telemetry — never throws.
        if (mem0PartitionKey !== userId) {
          void recordDriftIfAny(
            { userId, mem0UserId: mem0PartitionKey, surface: "memory_admin" },
            { db }
          )
        }
      }

      if (req.method === "GET") {
        const search = String(req.query.q ?? "").trim()
        const limit = Number(req.query.limit ?? "100")
        const points = await listQdrantMemories(mem0PartitionKey, search, Number.isFinite(limit) ? limit : 100)
        sendJson(res, 200, { userId, mem0PartitionKey, collection: QDRANT_COLLECTION, points })
        return
      }

      if (req.method === "DELETE") {
        const pointId = String(req.query.pointId ?? req.body?.pointId ?? "").trim()
        if (!pointId) {
          sendJson(res, 400, { error: "pointId is required" })
          return
        }
        await deleteQdrantPointForUser(mem0PartitionKey, pointId)
        sendJson(res, 200, { userId, mem0PartitionKey, pointId, deleted: true })
        return
      }

      if (req.method === "POST") {
        const action = String(req.body?.action ?? "").trim()
        if (action !== "clear") {
          sendJson(res, 400, { error: "Unsupported action" })
          return
        }
        const result = await clearUserMemory(
          userId,
          {
            db,
            qdrantUrl: QDRANT_URL.value(),
            qdrantApiKey: QDRANT_API_KEY.value(),
            qdrantCollection: QDRANT_COLLECTION,
          },
          {
            keepMessages: req.body?.keepMessages === true,
            dryRun: req.body?.dryRun === true,
            // Only set when the kill switch is on AND the resolved partition
            // diverges from `userId`. When equal, we omit so downstream stays
            // byte-identical to the pre-11.3 path.
            ...(partitionSwitchEnabled() && mem0PartitionKey !== userId
              ? { mem0PartitionKey }
              : {}),
          }
        )
        sendJson(res, 200, { userId, mem0PartitionKey, result, summary: summarizeClearResult(result) })
        return
      }

      sendJson(res, 405, { error: "Method not allowed" })
    } catch (err) {
      const rawStatus = typeof err === "object" && err && "status" in err ? Number((err as { status: unknown }).status) : 500
      const status = Number.isFinite(rawStatus) ? rawStatus : 500
      logger.warn("memoryAdmin failed", { status, error: err instanceof Error ? err.message : String(err) })
      sendJson(res, status, { error: err instanceof Error ? err.message : String(err) })
    }
  }
)

// =============================================================================
// iter31 — Human-in-the-loop runtime-mode admin endpoint.
// Adam directive 2026-05-04 ("human in the loop -> intervene conversation
// (pause & resume)"). Operator flips user.runtimeMode to "paused" or "auto"
// + records audit (runtimeModeAt + runtimeModeSetBy + runtimeModeReason).
//
// On pause: orchestrator skips reply generation but still appends inbound to
// pa-messages so memory + audit are preserved.
// On resume: NO confirmation reply is auto-emitted; the next user inbound
// flows through the normal path.
// =============================================================================
export const paRuntimeMode = onRequest(
  {
    region: "us-central1",
    memory: "256MiB",
    timeoutSeconds: 30,
    maxInstances: 1,
    cors: false,
  },
  async (req, res) => {
    setCors(res)
    if (req.method === "OPTIONS") {
      res.status(204).send("")
      return
    }
    try {
      const decoded = await requireDashboardAdmin(req)
      const userId = String(req.query.userId ?? req.body?.userId ?? "").trim()
      if (!userId) {
        sendJson(res, 400, { error: "userId is required" })
        return
      }
      const db = getFirestore()
      const userRef = db.collection(PA_COLLECTIONS.users).doc(userId)
      if (req.method === "GET") {
        const snap = await userRef.get()
        if (!snap.exists) {
          sendJson(res, 404, { error: "user_not_found", userId })
          return
        }
        const u = snap.data() as {
          runtimeMode?: "auto" | "paused"
          runtimeModeAt?: string
          runtimeModeSetBy?: string
          runtimeModeReason?: string
        }
        sendJson(res, 200, {
          userId,
          runtimeMode: u.runtimeMode ?? "auto",
          runtimeModeAt: u.runtimeModeAt,
          runtimeModeSetBy: u.runtimeModeSetBy,
          runtimeModeReason: u.runtimeModeReason,
        })
        return
      }
      if (req.method === "POST") {
        const mode = String(req.body?.mode ?? "").trim()
        if (mode !== "paused" && mode !== "auto") {
          sendJson(res, 400, { error: "mode must be 'paused' or 'auto'" })
          return
        }
        const reason = String(req.body?.reason ?? "").trim().slice(0, 500)
        const now = nowIso()
        const setBy = decoded.email ?? decoded.uid ?? "operator"
        const patch: Record<string, unknown> = {
          runtimeMode: mode,
          runtimeModeAt: now,
          runtimeModeSetBy: setBy,
          updatedAt: now,
        }
        if (reason) patch.runtimeModeReason = reason
        await userRef.set(patch, { merge: true })
        // Append audit row for forensic traceability.
        try {
          await db.collection(PA_COLLECTIONS.auditEvents).add({
            kind: "hitl_runtime_mode",
            userId,
            actor: setBy,
            createdAt: now,
            message: `Runtime mode set to ${mode}`,
            meta: { mode, reason: reason || null },
          })
        } catch (auditErr) {
          logger.warn("paRuntimeMode audit write failed", {
            userId,
            err: auditErr instanceof Error ? auditErr.message : String(auditErr),
          })
        }
        sendJson(res, 200, { ok: true, userId, mode, runtimeModeAt: now, setBy })
        return
      }
      sendJson(res, 405, { error: "Method not allowed" })
    } catch (err) {
      const rawStatus = typeof err === "object" && err && "status" in err ? Number((err as { status: unknown }).status) : 500
      const status = Number.isFinite(rawStatus) ? rawStatus : 500
      logger.warn("paRuntimeMode failed", { status, error: err instanceof Error ? err.message : String(err) })
      sendJson(res, status, { error: err instanceof Error ? err.message : String(err) })
    }
  }
)
export const paHealthRuntimeMode = makeHealthHandler({
  name: "paRuntimeMode",
  requiredSecrets: [],
})

// =============================================================================
// Per-user version channel (canary / ring) admin endpoint.
// Sibling of paRuntimeMode. Operator flips a single user's versionChannel to
// "latest" (opts into newest conversation behavior under test) or "stable"
// (previous behavior) + records audit (versionChannelAt + versionChannelSetBy
// + versionChannelReason). Internal/test users (PA_INTERNAL_USER_IDS /
// PA_INTERNAL_PHONE_NUMBERS incl. the dev phone) are ALWAYS resolved to
// "latest" by the orchestrator regardless of this field — so we always test
// on internal users before promoting a version to everyone.
//
// GET  ?userId=…           → { userId, versionChannel, effectiveChannel,
//                              internal, versionChannelAt/SetBy/Reason }
// POST { userId, channel, reason? } → sets the field. channel ∈ latest|stable.
//
// Zero-regression: this endpoint only WRITES a field. The field is a strict
// no-op until a behavior is explicitly marked latest-only via
// `isLatestChannel()` in the orchestrator.
// =============================================================================
export const paVersionChannel = onRequest(
  {
    region: "us-central1",
    memory: "256MiB",
    timeoutSeconds: 30,
    maxInstances: 1,
    cors: false,
  },
  async (req, res) => {
    setCors(res)
    if (req.method === "OPTIONS") {
      res.status(204).send("")
      return
    }
    try {
      const decoded = await requireDashboardAdmin(req)
      const userId = String(req.query.userId ?? req.body?.userId ?? "").trim()
      if (!userId) {
        sendJson(res, 400, { error: "userId is required" })
        return
      }
      const db = getFirestore()
      if (req.method === "GET") {
        const read = await readVersionChannel(db, userId, process.env)
        sendJson(res, 200, read)
        return
      }
      if (req.method === "POST") {
        const channel = parseChannel(req.body?.channel)
        if (!channel) {
          sendJson(res, 400, { error: "channel must be 'latest' or 'stable'" })
          return
        }
        const reason = String(req.body?.reason ?? "").trim().slice(0, 500)
        const setBy = decoded.email ?? decoded.uid ?? "operator"
        const result = await setVersionChannel(db, {
          userId,
          channel,
          reason,
          setBy,
          nowIso: nowIso(),
          onAuditError: (auditErr) =>
            logger.warn("paVersionChannel audit write failed", {
              userId,
              err: auditErr instanceof Error ? auditErr.message : String(auditErr),
            }),
        })
        sendJson(res, 200, result)
        return
      }
      sendJson(res, 405, { error: "Method not allowed" })
    } catch (err) {
      const rawStatus = typeof err === "object" && err && "status" in err ? Number((err as { status: unknown }).status) : 500
      const status = Number.isFinite(rawStatus) ? rawStatus : 500
      logger.warn("paVersionChannel failed", { status, error: err instanceof Error ? err.message : String(err) })
      sendJson(res, status, { error: err instanceof Error ? err.message : String(err) })
    }
  }
)
export const paHealthVersionChannel = makeHealthHandler({
  name: "paVersionChannel",
  requiredSecrets: [],
})

// =============================================================================
// Phase 21 — Sendblue channel migration (CHANNEL-01, CHANNEL-05)
// =============================================================================

/**
 * paSendblueWebhook — receives Sendblue inbound webhooks (HMAC-verified).
 * Per 21-CONTRACT-NOTES §2 + §3:
 *   - HMAC-SHA256(rawBody) hex; header Sendblue-Signature (+ aliases)
 *   - Subscribes in dashboard to: receive, outbound, typing_indicator, line_blocked
 *   - Idempotent on `sendblue-${message_handle}` (D-02)
 */
export const paSendblueWebhook = onRequest(
  {
    region: "us-central1",
    // Stream D — webhook fires-and-forgets ingestCv (needs
    // PA_OPENAI_AGENT_API_KEY for the CV LLM extraction). Sendblue creds are
    // still bound because the coalescer/runtime-owned tapback path uses them.
    secrets: [
      SENDBLUE_WEBHOOK_SIGNING_SECRET,
      SENDBLUE_API_KEY_ID,
      SENDBLUE_API_SECRET_KEY,
      SENDBLUE_FROM_NUMBER,
      PA_OPENAI_AGENT_API_KEY,
      // Audio intake (2026-06-04) — voice-note transcription (ffmpeg .caf→wav → Deepgram).
      DEEPGRAM_API_KEY,
      // v1.7 Phase 69 — cv-ingest's industry-second-pass falls through to
      // Anthropic Sonnet when industryTags=["other"]. Until Adam provisions,
      // graceful no-op (industry-second-pass.ts checks for empty key).
      ANTHROPIC_API_KEY,
      // v1.8 Phase 74.5 — compaction enable flag (hydrated into env for
      // CompactTrigger's runCompactionForUser → isMemoryCompactionEnabled).
      // NOTE PA_ADMIN_USER_IDS already injected as plain env var on this
      // function (set via firebase functions:config in an earlier
      // deploy); we do NOT re-declare as secret here to avoid overlap
      // error from Cloud Run.
      MEMORY_COMPACTION_ENABLED,
    ],
    memory: "512MiB",
    timeoutSeconds: 60,
    cors: false,
    // R-05 mitigation: keep at least one warm to stay <30s p95 (CHANNEL-09).
    // Dial up post-cutover if smoke shows cold-start issues.
    minInstances: 1,
  },
  async (req, res) => {
    // Stream D — re-export secrets into env so the side-effect modules
    // (`./sendblue/sendblue-client.js` reads SENDBLUE_API_KEY_ID etc.;
    // `./cv-ingest/cv-ingest.js` reads PA_OPENAI_AGENT_API_KEY) pick them
    // up. These setters are no-ops on warm invocations.
    process.env.SENDBLUE_API_KEY_ID = SENDBLUE_API_KEY_ID.value()
    process.env.SENDBLUE_API_SECRET_KEY = SENDBLUE_API_SECRET_KEY.value()
    try {
      const fromNumber = SENDBLUE_FROM_NUMBER.value().trim()
      if (fromNumber) process.env.SENDBLUE_FROM_NUMBER = fromNumber
    } catch {
      // optional on paid lines
    }
    try {
      const openAiKey = PA_OPENAI_AGENT_API_KEY.value().trim()
      if (openAiKey) process.env.PA_OPENAI_AGENT_API_KEY = openAiKey
      else delete process.env.PA_OPENAI_AGENT_API_KEY
    } catch {
      delete process.env.PA_OPENAI_AGENT_API_KEY
    }
    // v1.7 Phase 69 — re-export ANTHROPIC_API_KEY for cv-ingest's
    // industry-second-pass + pa-resume-parser router fallback tier.
    // `__UNSET__` is the Adam-placeholder version (empty payloads aren't
    // allowed in Secret Manager); treat as unset.
    try {
      const anthropicKey = ANTHROPIC_API_KEY.value().trim()
      if (anthropicKey && anthropicKey !== "__UNSET__") process.env.ANTHROPIC_API_KEY = anthropicKey
      else delete process.env.ANTHROPIC_API_KEY
    } catch {
      // secret not bound — leave env as-is (legacy fallback)
    }
    // v1.8 Phase 74.5 — compaction flag. (PA_ADMIN_USER_IDS already on env.)
    try {
      const compactionFlag = MEMORY_COMPACTION_ENABLED.value().trim()
      if (compactionFlag) process.env.MEMORY_COMPACTION_ENABLED = compactionFlag
    } catch { /* optional */ }
    try {
      await handleSendblueWebhook(
        {
          rawBody: req.rawBody,
          body: req.body,
          headers: req.headers as Record<string, string | string[] | undefined>,
          method: req.method,
          header: (n: string) => req.header(n) ?? undefined,
        },
        {
          status(code: number) {
            res.status(code)
            return this
          },
          json(body: unknown) {
            res.json(body)
            return this
          },
          send(body?: unknown) {
            res.send(body)
            return this
          },
          set(field: string, value: string) {
            return res.set(field, value)
          },
        },
        buildSendblueWebhookDeps()
      )
    } catch (err) {
      logger.error("paSendblueWebhook fatal", { error: err instanceof Error ? err.message : String(err) })
      // Sendblue retry policy will redeliver on 5xx — appropriate for unexpected errors.
      if (!res.headersSent) res.status(500).json({ ok: false, error: "internal" })
    }
  }
)

/**
 * v1.5 Stream-D — coalescer dep builder.
 *
 * Lazy: builds the Cloud Tasks client on first call after env is hydrated.
 * Re-used by `paSendblueWebhook` (enqueue path) AND `paMessageCoalescer`
 * (the Cloud Tasks→CF receiver) AND the buffer sweep.
 *
 * Returns deps even when env config is missing. If Cloud Tasks cannot take
 * ownership, the webhook leaves the event on the normal runtime path.
 */
// Exported so coalescer integration tests can assert the same orchestrator
// deps are used on buffered and direct inbound paths.
export function buildCoalescerDeps(): CoalescerDeps {
  const cfg = resolveTasksConfigFromEnv(process.env)
  return {
    db: getFirestore(),
    tasks: new GoogleCloudTasksClient(cfg),
    sendReaction: defaultSendReaction,
    orchestratorDeps: makeOrchestratorDeps(),
    log: (...args: unknown[]) => logger.info("[coalesce]", ...args),
  }
}

/**
 * Build the deps object passed to handleSendblueWebhook. Wires the
 * coalescer in BUT only if env config is present — otherwise the webhook
 * leaves inbound ownership with the normal runtime path.
 */
function buildSendblueWebhookDeps() {
  let coalescerDeps: CoalescerDeps | undefined
  try {
    coalescerDeps = buildCoalescerDeps()
  } catch (err) {
    logger.warn("[coalesce][webhook] coalescer deps not built (env incomplete) — runtime path only", {
      err: err instanceof Error ? err.message : String(err),
    })
  }
  // v1.5 TD-A (2026-05-03): proper-fix fallback for Cloud Tasks enqueue
  // failure. After TD-A the inbound row is stamped `coalescing:true` AT
  // CREATE so onPaInbound's onDocumentCreated trigger skips it. If the
  // subsequent Cloud Tasks enqueue then errors, nothing else will pick the
  // row up — we must drive the runtime orchestrator path right here.
  // `processBrokerImessageEvent` is the byte-equivalent of what onPaInbound
  // does for non-coalesced rows (claim → user/session resolve → run
  // orchestrator). Re-using it keeps the fallback path symmetric with the
  // happy path.
  const processBrokerImessageFallback = async (eventId: string): Promise<void> => {
    const db = getFirestore()
    const ref = db.collection(PA_COLLECTIONS.inboundEvents).doc(eventId)
    const snap = await ref.get()
    if (!snap.exists) {
      logger.warn("[sendblue][webhook][fallback] inbound row missing", { eventId })
      return
    }
    // Cast widely; isBrokerImessageEvent does the runtime narrowing.
    const data = { id: snap.id, ...snap.data() } as InboundEvent | BrokerImessageEvent
    if (!isBrokerImessageEvent(data)) {
      logger.warn("[sendblue][webhook][fallback] inbound row is not a broker iMessage event", {
        eventId,
        kind: (data as BrokerImessageEvent).rawPayload?.kind,
      })
      return
    }
    await processBrokerImessageEvent(db, data)
  }
  // Phase 60 (DEV-01) — `__PA_FIND_MATCH__` admin trigger handler.
  // Mirrors what runDailyJobRecBatch does for one user: V16 query against
  // pa-users.tags + format per CLAUDE.md flow + runtime handoff. Admin
  // gating happens INSIDE webhook.ts before this is called; we trust the
  // caller. Fail-open: any error logs + returns ok:false rather than crashing.
  const generateJobRecsForUser = async (args: {
    userId: string
    toE164: string
  }): Promise<{ ok: boolean; jobCount: number; reason?: string }> => {
    const db = getFirestore()
    try {
      const { queryMatchingJobsV16, recordRecommendedJobs } = await import("@pa/job-rec")
      const result = await queryMatchingJobsV16(
        { userId: args.userId, limit: 5, lang: "en", allowBroadFallback: true },
        {
          db,
          log: (event, payload) =>
            logger.info(`[sendblue][webhook][find-match] ${event}`, payload ?? {}),
        }
      )
      if (result.noUserTags) {
        return { ok: false, jobCount: 0, reason: "no_user_tags" }
      }
      if (!result.jobs || result.jobs.length === 0) {
        return { ok: false, jobCount: 0, reason: "no_matches" }
      }
      let userTagsForJobRec: unknown
      let introContext: ReturnType<typeof compactJobRecContext> | undefined
      try {
        const userDoc = await db.collection("pa-users").doc(args.userId).get()
        userTagsForJobRec = userDoc.exists ? userDoc.data()?.tags : undefined
        introContext = compactJobRecContext(userTagsForJobRec)
      } catch {
        userTagsForJobRec = undefined
        introContext = undefined
      }
      const visibleCount = resolveJobRecVisibleCount(undefined)
      const items = await collectLiveFirestoreJobRecommendationMessageItems(db, result.jobs, "en", {
        limit: visibleCount,
        candidateTags: userTagsForJobRec,
      })
      if (items.length === 0) {
        return { ok: false, jobCount: 0, reason: "no_linkable_matches" }
      }
      const runtime = await enqueueRuntimeEventHandoff(db, {
        userId: args.userId,
        toE164: args.toE164,
        source: "admin_find_match",
        eventKind: "job_recommendations_requested",
        // Idempotency: include hh:mm so the same admin can retrigger within
        // a day but rapid spamming (same minute) dedups. Mirrors the daily
        // batch convention without colliding with it.
        idempotencyKey: `${args.userId}-${new Date().toISOString().slice(0, 16)}-find-match`,
        requireExistingSession: true,
        context: {
          ...buildJobRecommendationRuntimeContext(items, introContext, {
            requestedCount: visibleCount,
            source: "admin_find_match",
            eventKind: "job_recommendations_requested",
          }),
          jobCount: items.length,
        },
      })
      if (runtime.ok) {
        const { buildRichMatchReason } = await import("@pa/job-rec")
        const candidateTagsForReason =
          userTagsForJobRec && typeof userTagsForJobRec === "object"
            ? (userTagsForJobRec as Record<string, unknown>)
            : undefined
        await recordRecommendedJobs(
          db,
          {
            userId: args.userId,
            // Persist the grounded "why matched" pitch so /me/matches reads the
            // GOOD reason rather than recomputing weak templates.
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
            source: "admin_find_match",
          },
          (event, payload) =>
            logger.info(`[sendblue][webhook][find-match] ${event}`, payload ?? {}),
        )
        const lastJobBatchSentAt = new Date().toISOString()
        await db.collection("pa-job-profiles").doc(args.userId).set(
          {
            lastJobBatchSentAt,
            updatedAt: lastJobBatchSentAt,
          },
          { merge: true },
        )
      }
      return {
        ok: runtime.ok,
        jobCount: items.length,
        ...(runtime.ok ? {} : { reason: runtime.reason }),
      }
    } catch (err) {
      logger.error("[sendblue][webhook][find-match] threw", {
        userId: args.userId,
        error: err instanceof Error ? err.message : String(err),
      })
      return { ok: false, jobCount: 0, reason: "exception" }
    }
  }

  return {
    db: getFirestore(),
    secret: SENDBLUE_WEBHOOK_SIGNING_SECRET.value(),
    log: (...args: unknown[]) => logger.info("[sendblue][webhook]", ...args),
    sendTypingIndicator: defaultSendTypingIndicator,
    enqueueOrCoalesce: coalescerDeps ? defaultEnqueueOrCoalesce : undefined,
    coalescerDeps,
    processBrokerImessageFallback,
    generateJobRecsForUser,
  }
}

/**
 * paMessageCoalescer — Cloud Tasks → CF endpoint (HTTP target).
 *
 * Cloud Tasks POSTs to this URL after the configured delay. Body shape:
 *   { userId: string, turnSeq: number, messageCount?: number }
 *
 * Auth: Cloud Tasks signs requests with an OIDC token (audience = this CF
 * URL, SA = `wekruit-5f89b@appspot.gserviceaccount.com`). Cloud Functions
 * Gen 2 enforces invoker IAM on its own — operator gates this CF with
 * `roles/cloudfunctions.invoker` granted ONLY to that SA, so no extra
 * verification is needed in the handler. (Public access is denied by
 * default for v2 functions unless `--allow-unauthenticated` is set.)
 *
 * Idempotent: `processCoalescedTurn` flips status atomically; duplicate
 * deliveries return early.
 */
export const paMessageCoalescer = onRequest(
  {
    region: "us-central1",
    // CALCOM_API_KEY + MAILGUN_* added (2026-06-01): thin Claire also runs through the
    // coalescer inbound path, so its scheduling tools need process.env.CALCOM_API_KEY /
    // MAILGUN_* populated. A missing CALCOM_API_KEY just makes the tools fail-open.
    secrets: [SENDBLUE_API_KEY_ID, SENDBLUE_API_SECRET_KEY, SENDBLUE_FROM_NUMBER, SILICONFLOW_API_KEY, PA_OPENAI_AGENT_API_KEY, QDRANT_URL, QDRANT_API_KEY, CALCOM_API_KEY, MAILGUN_API_KEY, MAILGUN_DOMAIN, MAILGUN_FROM, MAILGUN_REGION],
    // 512MiB → 1GiB (2026-05-30): this function hosts thin Claire for COALESCED inbounds (onPaInbound
    // skips them), so a `recommend` turn runs find_match HERE. V16 pulls ~67MB of job docs (1536-float
    // embeddings → ~150-300MB parsed) on top of the @openai/agents + mem0 + Sendblue SDK baseline,
    // which OOM-killed the 512MiB instance mid-matcher → function died abruptly, event stuck `pending`,
    // no reply, no graceful fallback (the 2026-05-30 "typing then nothing"). Matches onPaInbound's 1GiB.
    // maxInstances pinned so the bigger allocation can't blow the us-central1 Cloud Run memory quota.
    memory: "1GiB",
    timeoutSeconds: 120,
    maxInstances: 4,
    cors: false,
    invoker: "private",
  },
  async (req, res) => {
    // Hydrate env so the orchestrator chain (LLM + memory) can run.
    process.env.SENDBLUE_API_KEY_ID = SENDBLUE_API_KEY_ID.value()
    process.env.SENDBLUE_API_SECRET_KEY = SENDBLUE_API_SECRET_KEY.value()
    process.env.SILICONFLOW_API_KEY = SILICONFLOW_API_KEY.value()
    process.env.QDRANT_URL = QDRANT_URL.value()
    process.env.QDRANT_API_KEY = QDRANT_API_KEY.value()
    // Cal.com + Mailgun — thin Claire's scheduling tools (this CF hosts thin Claire for
    // coalesced inbounds) read these lazily. A missing CALCOM_API_KEY → tools fail-open.
    try {
      process.env.CALCOM_API_KEY = CALCOM_API_KEY.value()
    } catch {
      /* optional — scheduling tools fail-open without it */
    }
    try {
      process.env.MAILGUN_API_KEY = MAILGUN_API_KEY.value()
    } catch {
      /* optional */
    }
    try {
      process.env.MAILGUN_DOMAIN = MAILGUN_DOMAIN.value()
    } catch {
      /* optional — defaults to wekruit.com */
    }
    try {
      process.env.MAILGUN_FROM = MAILGUN_FROM.value()
    } catch {
      /* optional — defaults to WeKruit <hi@wekruit.com> */
    }
    try {
      process.env.MAILGUN_REGION = MAILGUN_REGION.value()
    } catch {
      /* optional — defaults to us */
    }
    // 2026-05-07 Adam directive — no more OPENAI_API_KEY = SF aliasing.
    try {
      const fromNumber = SENDBLUE_FROM_NUMBER.value().trim()
      if (fromNumber) process.env.SENDBLUE_FROM_NUMBER = fromNumber
    } catch {
      // optional on paid lines
    }
    try {
      const openAiKey = PA_OPENAI_AGENT_API_KEY.value().trim()
      if (openAiKey) process.env.PA_OPENAI_AGENT_API_KEY = openAiKey
      else delete process.env.PA_OPENAI_AGENT_API_KEY
    } catch {
      delete process.env.PA_OPENAI_AGENT_API_KEY
    }
    try {
      const body = (req.body ?? {}) as { userId?: unknown; turnSeq?: unknown; messageCount?: unknown }
      const userId = typeof body.userId === "string" ? body.userId : ""
      const turnSeq = typeof body.turnSeq === "number" ? body.turnSeq : Number(body.turnSeq ?? NaN)
      if (!userId || !Number.isFinite(turnSeq)) {
        logger.warn("paMessageCoalescer bad payload", { body })
        res.status(400).json({ ok: false, error: "bad_payload" })
        return
      }
      const deps = buildCoalescerDeps()
      const result = await processCoalescedTurn(deps, userId, turnSeq)
      logger.info("paMessageCoalescer processed", {
        userId,
        turnSeq,
        status: result.status,
        messageCount: result.buffer?.messageCount,
      })
      res.status(200).json({ ok: true, status: result.status })
    } catch (err) {
      logger.error("paMessageCoalescer fatal", { err: err instanceof Error ? err.message : String(err) })
      // 5xx → Cloud Tasks retries (with its own backoff). Caller should
      // configure max-attempts on the queue to bound replay.
      res.status(500).json({ ok: false, error: "internal" })
    }
  }
)

/**
 * paJobRecSendTask — Cloud Tasks → CF endpoint (HTTP target) for the
 * matching-rec time-spread (2026-06-02). paJobRecDaily schedules ONE delayed
 * task per due user at a jittered offset across the spread window; each task
 * fires here and hands the already-built runtime context to the job-rec
 * `sendImessage` tool, which writes the synthetic pa-inbound-events doc the
 * Claire runtime delivers. This spreads the downstream Sendblue load instead
 * of an all-at-once burst.
 *
 * Internal-only (invoker: private, OIDC-signed by the runtime SA — same trust
 * model as paMessageCoalescer). Body: { userId, context, idempotencyKey,
 * fromNumber? }. The job-rec sendImessage tool dedups on idempotencyKey, and
 * paJobRecDaily already stamped lastJobBatchSentAt at enqueue time, so a Cloud
 * Tasks retry can never double-deliver.
 */
export const paJobRecSendTask = onRequest(
  {
    region: "us-central1",
    memory: "256MiB",
    timeoutSeconds: 60,
    maxInstances: 8,
    cors: false,
    invoker: "private",
  },
  async (req, res) => {
    try {
      const body = (req.body ?? {}) as {
        userId?: unknown
        context?: unknown
        idempotencyKey?: unknown
      }
      const userId = typeof body.userId === "string" ? body.userId : ""
      const context =
        body.context && typeof body.context === "object"
          ? (body.context as Record<string, unknown>)
          : null
      const idempotencyKey =
        typeof body.idempotencyKey === "string" ? body.idempotencyKey : undefined
      if (!userId || !context) {
        logger.warn("paJobRecSendTask bad payload", { hasUser: Boolean(userId), hasCtx: Boolean(context) })
        res.status(400).json({ ok: false, error: "bad_payload" })
        return
      }
      const db = getFirestore()
      const { sendImessage } = await import("@pa/job-rec")
      const result = await sendImessage(
        { userId, context, idempotencyKey },
        { db, log: (...args: unknown[]) => logger.info("[job-rec-send-task]", ...args) }
      )
      logger.info("paJobRecSendTask processed", { userId, ok: result.ok })
      // 2xx even on a soft no-op (e.g. missing session) so Cloud Tasks does NOT
      // retry a non-retryable condition; only true infra errors below 5xx.
      res.status(200).json({ ok: result.ok })
    } catch (err) {
      logger.error("paJobRecSendTask fatal", {
        err: err instanceof Error ? err.message : String(err),
      })
      res.status(500).json({ ok: false, error: "internal" })
    }
  }
)

/**
 * paCoalesceBufferSweep — every 60s scheduled CF (R1 mitigation).
 *
 * Force-fires any pa-message-coalesce-buffer doc whose firstReceivedAt is
 * older than 30s and status="pending". Failures (Cloud Tasks queue paused,
 * IAM regression, etc.) leave buffers stuck — sweep ensures they always
 * drain within ~90s worst case.
 */
export const paCoalesceBufferSweep = onSchedule(
  {
    schedule: "every 1 minutes",
    region: "us-central1",
    secrets: [SENDBLUE_API_KEY_ID, SENDBLUE_API_SECRET_KEY, SENDBLUE_FROM_NUMBER, SILICONFLOW_API_KEY, PA_OPENAI_AGENT_API_KEY, QDRANT_URL, QDRANT_API_KEY],
    memory: "256MiB",
    timeoutSeconds: 120,
    maxInstances: 1,
  },
  async () => {
    process.env.SENDBLUE_API_KEY_ID = SENDBLUE_API_KEY_ID.value()
    process.env.SENDBLUE_API_SECRET_KEY = SENDBLUE_API_SECRET_KEY.value()
    process.env.SILICONFLOW_API_KEY = SILICONFLOW_API_KEY.value()
    process.env.QDRANT_URL = QDRANT_URL.value()
    process.env.QDRANT_API_KEY = QDRANT_API_KEY.value()
    // 2026-05-07 Adam directive — no more OPENAI_API_KEY = SF aliasing.
    try {
      const fromNumber = SENDBLUE_FROM_NUMBER.value().trim()
      if (fromNumber) process.env.SENDBLUE_FROM_NUMBER = fromNumber
    } catch {/* optional */}
    try {
      const openAiKey = PA_OPENAI_AGENT_API_KEY.value().trim()
      if (openAiKey) process.env.PA_OPENAI_AGENT_API_KEY = openAiKey
      else delete process.env.PA_OPENAI_AGENT_API_KEY
    } catch {
      delete process.env.PA_OPENAI_AGENT_API_KEY
    }
    try {
      const deps = buildCoalescerDeps()
      const result = await runCoalesceBufferSweep(deps)
      if (result.scanned > 0 || result.errors > 0) {
        logger.info("paCoalesceBufferSweep tick", result)
      }
    } catch (err) {
      // Never let the sweep tick throw — Cloud Scheduler retries every
      // minute, but we want clean logs not a stack trace.
      logger.error("paCoalesceBufferSweep fatal", {
        err: err instanceof Error ? err.message : String(err),
      })
    }
  }
)

/**
 * paSendblueOutbox — Firestore trigger on pa_outbound writes; POSTs to
 * Sendblue REST. This is the only production iMessage transport sender and
 * it requires runtime-approved pa-outbound input.
 */
export const paSendblueOutbox = onDocumentCreated(
  {
    document: "pa-outbound/{docId}",
    region: "us-central1",
    secrets: [SENDBLUE_API_KEY_ID, SENDBLUE_API_SECRET_KEY, SENDBLUE_FROM_NUMBER],
    // BUG #2 — OOMed at 256Mi when payload contained markdown URLs (Phase 40
    // observed 2026-04-30 on web_search reply). 512Mi keeps a comfortable
    // ceiling for the 14MB bundle + Sendblue REST roundtrip.
    memory: "512MiB",
    timeoutSeconds: 120,
    concurrency: 1,
    // minInstances 0→1 (Adam 2026-07-23, first-touch latency): the inbound chain
    // (paSendblueWebhook + onPaInbound) is already warm, but the SEND path cold-started
    // ~5s on the first reply after idle (measured 2026-07-23: row created 01:39:44 →
    // container ready 01:39:50 → sent 01:39:56). Every reply routes through here, so one
    // warm instance removes the cold start from EVERY first-touch send, not just yc.
    minInstances: 1,
  },
  async (event) => {
    // Bind secrets into env so sendblue-client reads them without prop-drilling.
    process.env.SENDBLUE_API_KEY_ID = SENDBLUE_API_KEY_ID.value()
    process.env.SENDBLUE_API_SECRET_KEY = SENDBLUE_API_SECRET_KEY.value()
    try {
      const fromNumber = SENDBLUE_FROM_NUMBER.value().trim()
      if (fromNumber) process.env.SENDBLUE_FROM_NUMBER = fromNumber
    } catch {
      // SENDBLUE_FROM_NUMBER is optional on paid lines.
    }

    const { sendImessage } = await import("./sendblue/sendblue-client.js")
    const { sendTypingIndicator } = await import("./sendblue/typing-indicator.js")
    const { appendMessage, getOrCreateSession, getUser, readOutreachStopControl } = await import("@pa/pa-persistence")

    const data = event.data?.data() as Record<string, unknown> | undefined
    if (!data) {
      logger.warn("paSendblueOutbox fired without data", { docId: event.params.docId })
      return
    }

    await paSendblueOutboxHandler(
      {
        params: { docId: event.params.docId },
        data: { data: () => data, id: event.params.docId },
      },
      {
        db: getFirestore(),
        sendblueClient: { sendImessage, sendTypingIndicator },
        log: (...args: unknown[]) => logger.info("[sendblue][outbox]", ...args),
        appendMessage,
        getOrCreateSession,
        getUser,
        readOutreachStopControl,
      }
    )
  }
)

// =============================================================================
// Stream H9 TD2 — paSendblueOutboxRetrySweep (5-min scheduled fallback)
// =============================================================================
//
// onDocumentCreated only fires once per row. If that single dispatch fails
// (cold start, OOM, transient infra hiccup), the row sits at status=pending
// indefinitely and the existing top-of-tick `sweepStaleOutbound` only fires
// when SOMETHING ELSE creates a row. This scheduled CF closes the gap by
// scanning every 5 min for orphans (status=pending, age >60s) and re-invoking
// the same `paSendblueOutboxHandler`. Idempotent via the handler's claim
// transaction.

export const paSendblueOutboxRetrySweep = onSchedule(
  {
    schedule: "every 5 minutes",
    region: "us-central1",
    secrets: [SENDBLUE_API_KEY_ID, SENDBLUE_API_SECRET_KEY, SENDBLUE_FROM_NUMBER],
    memory: "512MiB",
    timeoutSeconds: 120,
  },
  async () => {
    process.env.SENDBLUE_API_KEY_ID = SENDBLUE_API_KEY_ID.value()
    process.env.SENDBLUE_API_SECRET_KEY = SENDBLUE_API_SECRET_KEY.value()
    try {
      const fromNumber = SENDBLUE_FROM_NUMBER.value().trim()
      if (fromNumber) process.env.SENDBLUE_FROM_NUMBER = fromNumber
    } catch {
      // optional secret on paid lines
    }

    const { sendImessage } = await import("./sendblue/sendblue-client.js")
    const { sendTypingIndicator } = await import("./sendblue/typing-indicator.js")
    const { appendMessage, getOrCreateSession, getUser, readOutreachStopControl } = await import("@pa/pa-persistence")
    const { paSendblueOutboxRetrySweepHandler } = await import("./sendblue/outbox-retry-sweep.js")

    try {
      const result = await paSendblueOutboxRetrySweepHandler({
        db: getFirestore(),
        sendblueClient: { sendImessage, sendTypingIndicator },
        log: (...args: unknown[]) => logger.info("[sendblue][retry-sweep]", ...args),
        appendMessage,
        getOrCreateSession,
        getUser,
        readOutreachStopControl,
      })
      logger.info("paSendblueOutboxRetrySweep done", result)
    } catch (err) {
      logger.error("paSendblueOutboxRetrySweep fatal", {
        err: err instanceof Error ? err.message : String(err),
      })
    }
  }
)

// =============================================================================
// PA Conversation Recovery Sweep — raw Sendblue → runtime-approved recovery
// =============================================================================
//
// Detects candidate-visible inbound rows that still have no later candidate-
// visible outbound, classifies deterministic recovery classes, and writes
// durable `pa-recovery-cases` rows before taking action. It never direct-sends
// Sendblue; all candidate-visible recovery goes through runtime-approved
// `pa-outbound` or the existing inbound/prescreen runtime.

export const paConversationRecoverySweep = onSchedule(
  {
    schedule: "every 10 minutes",
    region: "us-central1",
    secrets: [
      SILICONFLOW_API_KEY,
      PA_OPENAI_AGENT_API_KEY,
      QDRANT_URL,
      QDRANT_API_KEY,
      ANTHROPIC_API_KEY,
      SENDBLUE_API_KEY_ID,
      SENDBLUE_API_SECRET_KEY,
      SENDBLUE_FROM_NUMBER,
      // Unanswered-inbound alert (Feature 1) dispatches via notifyOps →
      // EMAIL (admin1@/adam.ylol@/noah.liu@) + Slack. Bind both channels'
      // secrets so they're in process.env at runtime. Fail-soft when unset.
      PA_SLACK_ALERT_WEBHOOK,
      MAILGUN_API_KEY,
      MAILGUN_DOMAIN,
      MAILGUN_FROM,
      MAILGUN_REGION,
    ],
    memory: "1GiB",
    maxInstances: 1,
    timeoutSeconds: 300,
    concurrency: 1,
  },
  async () => {
    process.env.SILICONFLOW_API_KEY = SILICONFLOW_API_KEY.value()
    process.env.QDRANT_URL = QDRANT_URL.value()
    process.env.QDRANT_API_KEY = QDRANT_API_KEY.value()
    process.env.SENDBLUE_API_KEY_ID = SENDBLUE_API_KEY_ID.value()
    process.env.SENDBLUE_API_SECRET_KEY = SENDBLUE_API_SECRET_KEY.value()
    // Surface the Slack webhook to the shared alert helper (postSlackAlert reads env).
    try {
      const slackWebhook = PA_SLACK_ALERT_WEBHOOK.value().trim()
      if (slackWebhook && slackWebhook !== "__UNSET__") process.env.PA_SLACK_ALERT_WEBHOOK = slackWebhook
    } catch {
      /* leave unset → alert helper no-ops gracefully */
    }
    // Surface Mailgun so notifyOps can email the unanswered-inbound alert.
    for (const [name, handle] of [
      ["MAILGUN_API_KEY", MAILGUN_API_KEY],
      ["MAILGUN_DOMAIN", MAILGUN_DOMAIN],
      ["MAILGUN_FROM", MAILGUN_FROM],
      ["MAILGUN_REGION", MAILGUN_REGION],
    ] as const) {
      try {
        const v = handle.value().trim()
        if (v && v !== "__UNSET__") process.env[name] = v
      } catch {
        /* secret unprovisioned → notifyOps email path no-ops gracefully */
      }
    }
    try {
      const fromNumber = SENDBLUE_FROM_NUMBER.value().trim()
      if (fromNumber) process.env.SENDBLUE_FROM_NUMBER = fromNumber
      else delete process.env.SENDBLUE_FROM_NUMBER
    } catch {
      delete process.env.SENDBLUE_FROM_NUMBER
    }
    try {
      const openAiAgentKey = PA_OPENAI_AGENT_API_KEY.value().trim()
      if (openAiAgentKey) process.env.PA_OPENAI_AGENT_API_KEY = openAiAgentKey
      else delete process.env.PA_OPENAI_AGENT_API_KEY
    } catch {
      delete process.env.PA_OPENAI_AGENT_API_KEY
    }
    try {
      const anthropicKey = ANTHROPIC_API_KEY.value().trim()
      if (anthropicKey && anthropicKey !== "__UNSET__") process.env.ANTHROPIC_API_KEY = anthropicKey
      else delete process.env.ANTHROPIC_API_KEY
    } catch {
      delete process.env.ANTHROPIC_API_KEY
    }
    const siliconflowBase = "https://api.siliconflow.cn/v1"
    const trimOr = (v: string | undefined, fallback: string) => {
      const t = v?.trim()
      return t && t.length > 0 ? t.replace(/\/+$/, "") : fallback
    }
    process.env.MEM0_LLM_API_KEY = trimOr(process.env.MEM0_LLM_API_KEY, SILICONFLOW_API_KEY.value())
    process.env.MEM0_LLM_BASE_URL = trimOr(process.env.MEM0_LLM_BASE_URL, siliconflowBase)
    process.env.MEM0_LLM_MODEL = trimOr(process.env.MEM0_LLM_MODEL, "Qwen/Qwen2.5-72B-Instruct")
    process.env.MEM0_EMBED_API_KEY = trimOr(process.env.MEM0_EMBED_API_KEY, SILICONFLOW_API_KEY.value())
    process.env.MEM0_EMBED_BASE_URL = trimOr(process.env.MEM0_EMBED_BASE_URL, siliconflowBase)
    process.env.MEM0_EMBED_MODEL = trimOr(process.env.MEM0_EMBED_MODEL, "BAAI/bge-m3")
    process.env.MEM0_EMBED_DIMS = trimOr(process.env.MEM0_EMBED_DIMS, "1024")

    const db = getFirestore()
    const { paConversationRecoverySweepHandler } = await import("./sendblue/recovery-agent.js")
    const { runPreScreenForUser } = await import("./prescreen-session-start.js")

    try {
      // ALERT-ONLY by default (Adam 2026-06-14: "let's not have [active recovery]
      // right now... this is mainly for alert"). Active replay/start/notice
      // actions only run when PA_RECOVERY_ACTIONS_ENABLED is truthy (no redeploy
      // to flip back on). Off → read-only unanswered detection + alert only.
      const recoveryActionsEnabled = (() => {
        const raw = (process.env.PA_RECOVERY_ACTIONS_ENABLED ?? "").trim().toLowerCase()
        return raw === "1" || raw === "true" || raw === "yes" || raw === "on"
      })()
      const result = await paConversationRecoverySweepHandler({
        db,
        recoveryActionsEnabled,
        log: (...args: unknown[]) => logger.info("[sendblue][recovery-agent]", ...args),
        // Unanswered-inbound alert → EMAIL + Slack via notifyOps (Adam 2026-06-14).
        // Keep the postSlackAlert seam name so the deps-injected unit tests are unchanged.
        postSlackAlert: (async (input: Parameters<typeof notifyOps>[0]) => {
          const r = await notifyOps(input)
          return { posted: r.anyDelivered }
        }) as never,
        // Auto-tapback (gated by PA_UNANSWERED_TAPBACK_ENABLED) — acknowledge an
        // unanswered candidate via a reaction on their last inbound, riding their
        // bound Sendblue line. Adam 2026-06-14 approved.
        sendTapback: async ({ to, messageHandle, userId, fromNumber }) => {
          const { sendReaction } = await import("./sendblue/send-reaction.js")
          let resolvedFrom = fromNumber
          if (!resolvedFrom && userId) {
            try {
              const { resolveBoundFromNumber } = await import("./sendblue/resolve-bound-from-number.js")
              const bound = await resolveBoundFromNumber(db, userId, {
                log: (event, payload) => logger.info("[unanswered-tapback]", { event, ...(payload ?? {}) }),
              })
              resolvedFrom = bound.fromNumber
            } catch {
              /* fall through — sendReaction can pool-resolve via userId/db */
            }
          }
          await sendReaction({
            to,
            messageHandle,
            reaction: "like",
            ...(resolvedFrom ? { fromNumber: resolvedFrom } : { userId, db }),
            allowEnvFromNumberFallback: false,
          })
        },
        processInboundEventById: async (eventId) => {
          const snap = await db.collection(PA_COLLECTIONS.inboundEvents).doc(eventId).get()
          if (!snap.exists) {
            logger.warn("[sendblue][recovery-agent] inbound event missing during replay", { eventId })
            return
          }
          const data = { id: snap.id, ...snap.data() } as InboundEvent | BrokerImessageEvent
          const orchestratorDeps = makeOrchestratorDeps()
          if (isBrokerImessageEvent(data)) {
            await processBrokerImessageEvent(db, data, orchestratorDeps)
          } else {
            await claimAndProcessInboundEvent(db, data.id, undefined, orchestratorDeps)
          }
        },
        startPrescreen: async ({ jobId, userId, toE164 }) => runPreScreenForUser({
          db,
          jobId,
          userId,
          toE164,
          // Recovery-agent replays inbound events that were ALREADY authorized when first
          // received — re-gating here would wrongly refuse a legit in-flight start.
          allowMatchedBypass: true,
          log: (event, payload) => logger.info(`[prescreen][recovery-agent] ${event}`, payload ?? {}),
        }),
      })
      logger.info("paConversationRecoverySweep done", result)
    } catch (err) {
      logger.error("paConversationRecoverySweep fatal", {
        err: err instanceof Error ? err.message : String(err),
      })
      throw err
    }
  }
)

// =============================================================================
// Stream A — Tapback → matching-feedback CF (BUG #6 sister-feature)
// =============================================================================
//
// Trigger: onDocumentCreated("pa-tapback-events/{id}"). Reads the tapback
// row, looks up Claire's recent outbound for that user, extracts mentioned
// jobIds, writes one matching-feedback row per jobId. See
// src/job-rec/match-feedback.ts for the matching heuristic.

export const paOnTapbackEvent = onDocumentCreated(
  {
    document: "pa-tapback-events/{id}",
    region: "us-central1",
    memory: "256MiB",
    timeoutSeconds: 60,
    concurrency: 1,
    maxInstances: 1,
  },
  async (event) => {
    const snap = event.data
    if (!snap) {
      logger.warn("paOnTapbackEvent fired without snapshot", { id: event.params.id })
      return
    }
    const data = snap.data() as
      | {
          userId?: string
          fromNumber?: string
          kind?: "love" | "like" | "dislike" | "laugh" | "emphasize" | "question"
          quotedText?: string
        }
      | undefined
    if (!data || !data.userId || !data.kind || !data.quotedText) {
      logger.warn("paOnTapbackEvent skipping malformed row", { id: event.params.id })
      return
    }
    try {
      // Stream H3 — try the cv-overwrite resolver first. If the tapback was
      // a love/question reaction on a runtime-authored CV overwrite prompt,
      // this promotes the staged CV (replace or supplement) and short-circuits
      // the job-rec flow. Otherwise we fall through to the existing
      // match-feedback pipeline.
      const { processCvOverwriteTapback } = await import("./job-rec/cv-overwrite-tapback.js")
      const cvResult = await processCvOverwriteTapback(getFirestore(), {
        userId: data.userId,
        fromNumber: data.fromNumber,
        kind: data.kind,
        quotedText: data.quotedText,
      })
      if (cvResult.handled) {
        logger.info("paOnTapbackEvent cv_overwrite_handled", {
          id: event.params.id,
          kind: data.kind,
          action: cvResult.action,
          newResumeId: cvResult.newResumeId,
          previousResumeId: cvResult.previousResumeId,
        })
        return
      }

      const { processTapbackForFeedback } = await import("./job-rec/match-feedback.js")
      const result = await processTapbackForFeedback(getFirestore(), {
        userId: data.userId,
        fromNumber: data.fromNumber,
        kind: data.kind,
        quotedText: data.quotedText,
      })
      logger.info("paOnTapbackEvent processed", {
        id: event.params.id,
        kind: data.kind,
        written: result.written,
        jobIds: result.jobIds,
      })
    } catch (err) {
      logger.error("paOnTapbackEvent failed", {
        id: event.params.id,
        err: err instanceof Error ? err.message : String(err),
      })
    }
  }
)

// =============================================================================
// Phase 31 — Upstream Event Connector
// =============================================================================
//
// External partners POST signed events to /paUpstreamEventWebhook. The
// handler verifies HMAC, looks up a matching template, gates on the
// `upstreamConnectorEnabled` flag, applies a per-(template,user) hourly
// rate limit, then hands the event/template context to Claire runtime. The
// runtime may no-send or create a runtime-approved transport row.

export const paUpstreamEventWebhook = onRequest(
  {
    region: "us-central1",
    secrets: [PA_UPSTREAM_HMAC_SECRET],
    // Same bundle floor as sendblue webhook — 256Mi too tight under burst.
    memory: "512MiB",
    timeoutSeconds: 60,
    cors: false,
  },
  async (req, res) => {
    try {
      await handleUpstreamEventWebhook(
        {
          rawBody: req.rawBody,
          body: req.body,
          headers: req.headers as Record<string, string | string[] | undefined>,
          method: req.method,
          header: (n: string) => req.header(n) ?? undefined,
        },
        {
          status(code: number) {
            res.status(code)
            return this
          },
          json(body: unknown) {
            res.json(body)
            return this
          },
        },
        {
          db: getFirestore(),
          secret: PA_UPSTREAM_HMAC_SECRET.value(),
          log: (...args: unknown[]) => logger.info("[upstream-webhook]", ...args),
        }
      )
    } catch (err) {
      logger.error("paUpstreamEventWebhook fatal", {
        error: err instanceof Error ? err.message : String(err),
      })
      if (!res.headersSent) res.status(500).json({ ok: false, error: "internal" })
    }
  }
)

export const paHealthUpstreamEventWebhook = makeHealthHandler({
  name: "paUpstreamEventWebhook",
  requiredSecrets: ["PA_UPSTREAM_HMAC_SECRET"],
})

// =============================================================================
// v1.5 Stream-A2 / Phase 47.1 — paMatchingPipelineComplete
// =============================================================================
//
// Mac mini cron (`scripts/daily-update.sh`) POSTs here after each daily
// scrape+enrich+embed+sync run with HMAC-signed body so wekruit-pa can
// surface daily-update health and downstream consumers can react to new
// jobs landing. See apps/functions/src/matching-pipeline-complete.ts and
// .planning/phases/47.1-matching-pipeline-webhook/DELIVERY.md.

export const paMatchingPipelineComplete = onRequest(
  {
    region: "us-central1",
    // P9 directive 2026-05-08 — Mailgun + Slack secrets bound so the
    // failure-path alert can reach Adam when status=failed|partial.
    // Mailgun creds optional at runtime: if any are missing, the alert
    // becomes a Slack-only / log-only path (graceful degradation, same
    // pattern as cost-summary-weekly).
    secrets: [
      PA_MATCHING_WEBHOOK_SECRET,
      MAILGUN_API_KEY,
      MAILGUN_DOMAIN,
      MAILGUN_FROM,
      MAILGUN_REGION,
      PA_SLACK_ALERT_WEBHOOK,
    ],
    memory: "256MiB",
    timeoutSeconds: 30,
    cors: false,
  },
  async (req, res) => {
    try {
      // Build production Mailgun config (optional — empty config disables
      // the email leg, slack continues if its webhook is set).
      const mailgunCfg: MailgunConfig | null = (() => {
        try {
          const apiKey = (MAILGUN_API_KEY.value() ?? "").trim()
          const domain = (MAILGUN_DOMAIN.value() ?? "").trim()
          const from = (MAILGUN_FROM.value() ?? "").trim()
          const regionRaw = (MAILGUN_REGION.value() ?? "us").trim()
          const region: "us" | "eu" = regionRaw === "eu" ? "eu" : "us"
          if (!apiKey || !domain || !from) return null
          return { apiKey, domain, from, region }
        } catch {
          return null
        }
      })()

      const ALERT_RECIPIENT = "developers@wekruit.com"

      const sendFailureAlertEmail: FailureAlertEmailFn | undefined = mailgunCfg
        ? async (input) => {
            const { subject, text, html } = composeFailureAlert(input)
            try {
              const res = await sendMailgun(mailgunCfg, {
                to: ALERT_RECIPIENT,
                subject,
                text,
                html,
              })
              if (!res.ok) {
                return {
                  ok: false,
                  reason: `mailgun_${res.status}`,
                }
              }
              return { ok: true }
            } catch (err) {
              return {
                ok: false,
                reason: err instanceof Error ? err.message : String(err),
              }
            }
          }
        : undefined
      if (!mailgunCfg) {
        logger.warn(
          "[matching-pipeline-complete] mailgun_creds_missing — failure alert email disabled"
        )
      }

      const sendFailureAlertSlack: FailureAlertSlackFn = async (input) => {
        const { subject } = composeFailureAlert(input)
        const fields = [
          { name: "runId", value: input.runId },
          { name: "status", value: input.status },
          {
            name: "started",
            value: String(input.payload.scrapeStartedAt ?? "(missing)"),
          },
          {
            name: "finished",
            value: String(input.payload.scrapeFinishedAt ?? "(missing)"),
          },
          {
            name: "jobsScraped",
            value: String(input.payload.jobsScraped ?? 0),
          },
          {
            name: "jobsErrored",
            value: String(input.payload.jobsErrored ?? 0),
          },
        ]
        const errorPreview =
          typeof input.payload.error === "string" && input.payload.error.length > 0
            ? input.payload.error.slice(0, 400)
            : "(no error field)"
        return await postSlackAlert({
          level: input.status === "failed" ? "error" : "warn",
          title: subject,
          message: errorPreview,
          fields,
        })
      }

      await handleMatchingPipelineComplete(
        {
          rawBody: req.rawBody,
          body: req.body,
          headers: req.headers as Record<string, string | string[] | undefined>,
          method: req.method,
        },
        {
          status(code: number) {
            res.status(code)
            return this
          },
          json(body: unknown) {
            res.json(body)
            return this
          },
        },
        {
          db: getFirestore(),
          secret: PA_MATCHING_WEBHOOK_SECRET.value(),
          log: (...args: unknown[]) =>
            logger.info("[matching-pipeline-complete]", ...args),
          sendFailureAlertEmail,
          sendFailureAlertSlack,
        }
      )
    } catch (err) {
      logger.error("paMatchingPipelineComplete fatal", {
        error: err instanceof Error ? err.message : String(err),
      })
      if (!res.headersSent) res.status(500).json({ ok: false, error: "internal" })
    }
  }
)

export const paHealthMatchingPipelineComplete = makeHealthHandler({
  name: "paMatchingPipelineComplete",
  requiredSecrets: ["PA_MATCHING_WEBHOOK_SECRET"],
})

/**
 * v1.8 Phase 75 — paPrescreenDriftDetector
 *
 * Nightly cron (04:30 UTC). Replays pa-prescreen-fixtures through
 * KeywordSetJudge with current LLM provider chain, compares to stored
 * gold scores. Drift > 5% per-keyword variance → Slack alert + audit row
 * to pa-prescreen-drift-runs.
 */
export const paPrescreenDriftDetector = onSchedule(
  {
    schedule: "30 4 * * *",
    timeZone: "UTC",
    region: "us-central1",
    // + alert channels (Adam 2026-06-14): drift > 5% now EMAILs + Slacks via notifyOps.
    secrets: [
      PA_OPENAI_AGENT_API_KEY,
      PA_SLACK_ALERT_WEBHOOK,
      MAILGUN_API_KEY,
      MAILGUN_DOMAIN,
      MAILGUN_FROM,
      MAILGUN_REGION,
    ],
    memory: "256MiB",
    timeoutSeconds: 540,
  },
  async () => {
    process.env.PA_OPENAI_AGENT_API_KEY = PA_OPENAI_AGENT_API_KEY.value()
    const { runPrescreenDriftDetector } = await import("./prescreen-drift-detector.js")
    const db = (await import("firebase-admin/firestore")).getFirestore()
    const result = await runPrescreenDriftDetector({
      db,
      log: (e, p) => logger.info(`drift.${e}`, p),
      alert: (input) => notifyOps(input),
    })
    logger.info("paPrescreenDriftDetector tick", result)
  }
)

/**
 * v1.8 Phase 81 — paOnboardingShadowDiffSweep
 *
 * Daily 03:00 UTC aggregator. Reads pa-onboarding-shadow-diff written by
 * the coalescer during v2_shadow runs, computes mean jaccard + diff rate
 * + state-disagreement rate. Writes a daily summary doc; gate evaluator
 * flips default v1→v2 when 7 consecutive days pass.
 */
export const paOnboardingShadowDiffSweep = onSchedule(
  {
    schedule: "0 3 * * *",
    timeZone: "UTC",
    region: "us-central1",
    memory: "256MiB",
    timeoutSeconds: 300,
    maxInstances: 1,
  },
  async () => {
    const { runOnboardingShadowDiffSweep } = await import("./onboarding-shadow-diff-sweep.js")
    const db = (await import("firebase-admin/firestore")).getFirestore()
    const result = await runOnboardingShadowDiffSweep({ db, log: (e, p) => logger.info(`shadow.${e}`, p) })
    logger.info("paOnboardingShadowDiffSweep tick", result)
  }
)

/**
 * v1.8 Phase 74.5 — paMemoryCompactionScheduled
 *
 * Daily 05:00 UTC. Per active user, check if pending raw turn count
 * ≥ 20 since last compaction → trigger runCompactionForUser. Cost cap
 * (5/user/day) enforced by runCompactionTurn itself.
 */
export const paMemoryCompactionScheduled = onSchedule(
  {
    schedule: "0 5 * * *",
    timeZone: "UTC",
    region: "us-central1",
    secrets: [PA_OPENAI_AGENT_API_KEY, MEMORY_COMPACTION_ENABLED],
    memory: "256MiB",
    timeoutSeconds: 540,
  },
  async () => {
    process.env.PA_OPENAI_AGENT_API_KEY = PA_OPENAI_AGENT_API_KEY.value()
    try {
      process.env.MEMORY_COMPACTION_ENABLED = MEMORY_COMPACTION_ENABLED.value()
    } catch { /* secret optional */ }
    const { runMemoryCompactionSweep } = await import("./memory-compaction-sweep.js")
    const db = (await import("firebase-admin/firestore")).getFirestore()
    const result = await runMemoryCompactionSweep({ db, log: (e, p) => logger.info(`compact.${e}`, p) })
    logger.info("paMemoryCompactionScheduled tick", result)
  }
)

/**
 * V2 External Candidate Supply Intake — admin callables + Instantly webhook.
 *
 * See .planning/external-supply-v1/PLAN.md for the full V1 spec.
 * Live outreach gated by EXTERNAL_SUPPLY_LIVE_OUTREACH_ENABLED=true +
 * INSTANTLY_API_KEY Firebase Secret; in their absence the sync callable
 * silently downgrades to dry-run.
 */
export {
  paExternalSupplyCreateBatchUploadUrl,
  paExternalSupplyCreateBatch,
} from "./external-supply/import.js"
// V2.1 — CoreSignal cdapi v2 collect batch fetch. Operator pastes candidate ID
// list in dashboard; CF fans out to live API + routes through runCreateBatch.
// See .planning/PRD-CORESIGNAL-INTAKE-OUTBOUND.md §6.
export { paCoresignalFetchBatch } from "./external-supply/coresignal-batch-fetch.js"
// V2.1 P3 — LLM pitch email generator. Compute-only callable; returns draft,
// does not write pa-outreach-plans (P4 wires the approve-and-send flow).
export { paGeneratePitchEmail } from "./external-supply/generate-pitch-email.js"
export { paExternalSupplyResolveBatchIdentity } from "./external-supply/resolve-identity.js"
export { paExternalSupplyRunLinkedInEnrich } from "./external-supply/run-linkedin-enrich.js"
export { paExternalSupplyRunGitHubEnrich } from "./external-supply/run-github-enrich.js"
export { paExternalSupplyPollLinkedInEnrich } from "./external-supply/poll-linkedin-enrich.js"
export { paExternalSupplyRunEvaluation } from "./external-supply/evaluate.js"
export {
  paExternalSupplyGenerateAgentResearchPrompt,
  paExternalSupplyImportAgentResearchResult,
  paExternalSupplyApproveAgentResearchFinding,
} from "./external-supply/agent-task.js"
export {
  paExternalSupplyDraftOutreachPlan,
  paExternalSupplyApproveOutreachPlan,
  paExternalSupplyRejectOutreachPlan,
  paExternalSupplyAssignManualLinkedInTask,
  paExternalSupplyMarkManualLinkedInTaskStatus,
} from "./external-supply/outreach.js"
export { paExternalSupplySyncPlanToInstantly } from "./external-supply/instantly-sync.js"
export { paExternalSupplyInstantlyWebhook } from "./external-supply/instantly-webhook.js"
// v2.0 External Supply V1.1 — Mailgun is the active email-delivery channel
// (Adam directive 2026-05-14). Instantly above stays for an easy switch back.
export { paExternalSupplySyncPlanToMailgun } from "./external-supply/mailgun-sync.js"
export { paExternalSupplyMailgunWebhook } from "./external-supply/mailgun-webhook.js"
export { sendMailgunEmail } from "./send-mailgun-email.js"
export { paExternalSupplyGetConfig } from "./external-supply/config.js"
// V2 — agent-ranking layer (Wave C / Executor D). Three admin-gated callables
// per .planning/external-supply-v2/EXECUTOR-PLANS.md §D.
export {
  paExternalSupplyRunAgentRanking,
  paExternalSupplyApproveAgentTier,
  paExternalSupplyOverrideAgentTier,
} from "./external-supply/agent-rank.js"
// V2 — preview-batch dry-run callable (Wave B / Executor C). Server-side
// read-only forecast that powers the dashboard drag-drop preview pane. Wiring
// deferred from C's commit per L-C7 to avoid parallel-wave conflict; lead
// merge-integration commit lands it.
export { paExternalSupplyPreviewBatch } from "./external-supply/preview-batch.js"
// V2.1 — candidates browser (loose-CSV + Lessie-style list/drawer).
// Pure read-only joins, gated by requireExternalSupplyAdmin. Powers
// /admin/external-supply/batches/:batchId/candidates.
export {
  paExternalSupplyListBatchCandidates,
  paExternalSupplyGetCandidateDetail,
} from "./external-supply/candidates-browser.js"

// ============================================================
// External Supply V2 — Wave E (F) flywheel rollup
// ------------------------------------------------------------
// Fenced into its own export block at the bottom of the file so it stays
// out of Wave D's parallel commit on the V2 callable export block above.
// Lead resolution L-F7. Do not interleave with any other export above.
// ============================================================
export { paExternalSupplyRollupSourceQualityMonthly } from "./external-supply/source-quality.js"

// ============================================================
// WeKruit Open — Layoff product (2026-05-15)
// ------------------------------------------------------------
// Co-deployed with pa-orchestrator. Reuses sendblue/pool.ts + allowlist.ts +
// sendblue-client.ts. Firestore: pa-users (source=WeKruit_Laid_Off tag +
// lastLaidOffAt timestamp + layoffContext sub-object), layoff_phone_index
// (dedup), layoff_employers, layoff_meta. Frontend: https://layoff.wekruit.com
// ============================================================
export {
  openRegisterLayoffCandidate,
  openInitiateSmsPrescreen,
  openSubmitChatTurn,
  openListLayoffCandidates,
  openRegisterEmployer,
} from "./openLayoff.js"
export { paEmployerClaimVerification } from "./identity/employer-claim-verification.js"
export { paEmployerIntakeJob } from "./employer-intake-job.js"
export { paEmployerCreatePilotReq } from "./employer-create-pilot-req.js"
export { paEmployerMatchPilotReq } from "./employer-match-pilot-req.js"
// Employer home (Phase 4) — list the employer's own reqs + server-persist the
// onboarding wizard state, keyed by the (self-asserted) onboarding work email.
export { paEmployerMyReqs, paEmployerOnboardingState } from "./employer-home.js"
// Employer LIVE passed inbox (Phase 4) — consent-gated, PII-redacted, scoped to
// the employer's own reqs; intro decision emits employer_intro_* FSM events.
export {
  paEmployerPassedCandidates,
  paEmployerPassedCandidateIntroDecision,
} from "./employer-passed-candidates.js"
export { paEmployerInviteTeam } from "./employer-invite-team.js"
export { paEmployerConnectRequest } from "./employer-connect-request.js"
export { paEmployerAtsImportReqs } from "./employer-ats-import-reqs.js"

// ============================================================
// Candidate referral program (2026-05-27)
// ------------------------------------------------------------
// Two-tier reward: $50 at interview, $4,000 at placement. Manual payout via
// admin1@wekruit.com / adam.ylol@wekruit.com / noah.liu@wekruit.com email.
// Schema in packages/core-types: pa-referrals + pa-referral-slugs.
// Frontend: /refer (public), /r/:slug (inviter landing), /me/refer (dashboard).
// ============================================================
export {
  paReferEnsureSlug,
  paReferLinkResolve,
  paReferInviteSend,
  paReferDashboardList,
  paReferOnPrescreenWrite,
  paReferOnEmployerVisibleWrite,
} from "./refer-program.js"

// wkjobs CLI acquisition surface — OAuth device flow (`/v1/device/*`) plus
// `/v1/me`, backing the `wkjobs` command-line job search. Strictly additive:
// reads pa-candidate-auth / pa-users, writes only pa-wkjobs-*. See wkjobs/.
export { paWkJobsApi } from "./wkjobs/http.js"
