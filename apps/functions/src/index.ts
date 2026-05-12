/**
 * Cloud Functions Gen 2 wrapper for the PA orchestrator.
 *
 * Topology (Sprint-1 prod):
 *   Mac iMessage worker -> Firestore `pa-inbound-events`
 *   onPaInbound (this file) -> processInboundEvent (`@pa/pa-orchestrator`)
 *     -> SiliconFlow LLM + Qdrant via `@pa/memory` mem0 OSS wrapper
 *     -> Firestore `pa-messages` + `pa-outbound`
 *   Mac iMessage worker -> sends from `pa-outbound`
 *
 * The function is idempotent: pa-orchestrator skips events already in a non-
 * `pending` status, and message writes are guarded by `idempotencyKey`.
 */
import { onDocumentCreated } from "firebase-functions/v2/firestore"
import { onRequest } from "firebase-functions/v2/https"
import { onSchedule } from "firebase-functions/v2/scheduler"
import { defineSecret } from "firebase-functions/params"
import { setGlobalOptions, logger } from "firebase-functions/v2"
import { initializeApp, getApps } from "firebase-admin/app"
import { getAuth } from "firebase-admin/auth"
import { getFirestore, FieldValue, type Firestore } from "firebase-admin/firestore"
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
import { sendReaction as defaultSendReaction } from "./sendblue/send-reaction.js"

// iter31 — Mailgun transport for email-verification step in onboarding.
// iter32 deploy-fix 2026-05-04 — MAILGUN_* defineSecret bindings + the
// `makeOrchestratorDeps` factory live in ./orchestrator-deps.js so
// admin-bootstrap.ts can share them. Re-export below for callers that
// still reference them on this module.
import {
  MAILGUN_API_KEY,
  MAILGUN_DOMAIN,
  MAILGUN_FROM,
  MAILGUN_REGION,
  MAILGUN_SECRETS,
  ANTHROPIC_API_KEY,
  PA_SLACK_ALERT_WEBHOOK,
  makeOrchestratorDeps,
} from "./orchestrator-deps.js"
export {
  MAILGUN_API_KEY,
  MAILGUN_DOMAIN,
  MAILGUN_FROM,
  MAILGUN_REGION,
  MAILGUN_SECRETS,
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

// Phase 24.5 — admin bootstrap (seed flags via PA_ADMIN_TOKEN, bypass local gcloud ADC)
export { paAdminBootstrap } from "./admin-bootstrap.js"

// Stream B — Job-rec daily cron (Task B4). Reads pa-job-profiles where status=active,
// queries matching-jobs, formats per Bible v7.5.2, enqueues pa-outbound.
export { paJobRecDaily } from "./job-rec-daily.js"

// Phase 51 (v1.5 / Stream-G.2) — TS-native tag cluster cache rebuild CF.
// Triggered by pa-events doc {eventKind="matching:pipeline:completed"}.
export { paJobRecClusterRebuild } from "./job-rec-cluster-rebuild.js"

// Phase 49 (v1.5 / Stream-H / D9) — operator reverse-match dashboard CF.
// JD + tags + industry → top-K candidates → outbound notify via pa-outbound.
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

// v1.6 Phase 57 (LIVE-01..04) — Daily HEAD-check sweep for matching-jobs.
// Cloud Scheduler 03:00 UTC. Marks dead on 4xx/5xx/timeout, recovers on
// HTTP-200 retry, hard-deletes after 30d dead. Inline-wires the Serper
// resolver from paBackfillMatchingJobsAtsUrl (cap 1000/run).
export { paLivenessSweepDaily } from "./liveness-sweep.js"

// v1.7+ TTL — Weekly hybrid GC for matching-jobs collection. Adam Option D
// (2026-05-08): inactive >90d AND dead >365d are deleted Mon 04:00 UTC.
// Postgres tombstone (P7-K, alembic 0007) preserves dead flag after Firestore
// delete so the scraper does not re-add deleted dead URLs. Pure-deps-injected
// runner with admin-only callable for canary dry-runs.
export {
  paMatchingJobsTtlDeleteWeekly,
  paMatchingJobsTtlDeleteCallable,
} from "./matching-jobs-ttl-delete.js"

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
export { paAdminMatchDebug } from "./admin-match-debug.js"

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

// v1.9 Phase 86 — Generic ATS inbound adapter webhook.
// Handshake fully implemented; GH/Lever/LinkedIn return 501 stubs.
export { paAtsInboundWebhook } from "./ats-inbound-webhook.js"

// Phase 27 T2 — public /health endpoints (one per existing CF). Returns
// {ok, name, version, ts, deps:{firestore, secrets}}. No auth (probes
// must be reachable). All endpoints HTTP 200 always; failure surfaces in body.
import { makeHealthHandler } from "./health.js"

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
  requiredSecrets: ["SILICONFLOW_API_KEY", "QDRANT_URL", "QDRANT_API_KEY"],
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

setGlobalOptions({ region: "us-central1" })

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
    /** Synthetic `[cv-parsed]` worker / E2E — must flow to orchestrator rawMeta. */
    triggerResumeId?: string
    cvParsedTrigger?: boolean
    messageHandle?: string
    source?: string
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

async function createProvisionalUser(db: Firestore, participant: string): Promise<User> {
  const id = randomUUID()
  const n = normalizeImessageParticipant(participant)
  const u: User = {
    id,
    phoneE164: n,
    createdAt: nowIso(),
    onboardingStatus: "provisional" as OnboardingStatus,
    channels: { imessageHandle: n },
  }
  await db.collection(PA_COLLECTIONS.users).doc(id).set(u)
  // iter34 P3 (Adam directive 2026-05-05) — auto-add new user to
  // paOnboardingPipelineEnabled allowlist. "flag必须开, 只要是reset或者新
  // 用户都必须开". Best-effort, swallow + log.
  try {
    const flagRef = db.collection("pa-feature-flags").doc("paOnboardingPipelineEnabled")
    const auditRef = db.collection("pa-audit-events").doc()
    const now = nowIso()
    await db.runTransaction(async (t) => {
      const cur = await t.get(flagRef)
      const action = cur.exists ? "flag.allowlist_add" : "flag.create"
      if (cur.exists) {
        t.update(flagRef, {
          allowlist: FieldValue.arrayUnion(id),
          updatedAt: now,
          updatedBy: "auto-newuser",
          reason: "auto-on-new-user",
          version: ((cur.data() as { version?: number }).version ?? 0) + 1,
        })
      } else {
        t.set(flagRef, {
          key: "paOnboardingPipelineEnabled",
          value: false,
          type: "bool",
          scope: "perUser",
          allowlist: [id],
          blocklist: [],
          bucketStrategy: null,
          updatedAt: now,
          updatedBy: "auto-newuser",
          reason: "auto-on-new-user",
          version: 1,
        })
      }
      t.set(auditRef, {
        actor: "auto-newuser",
        action,
        key: "paOnboardingPipelineEnabled",
        userId: id,
        reason: "auto-on-new-user",
        ts: now,
      })
    })
    logger.info("[provisional-user] paOnboardingPipelineEnabled allowlist += " + id)
  } catch (err) {
    logger.warn("[provisional-user] auto-enable flag FAILED", {
      userId: id,
      error: err instanceof Error ? err.message : String(err),
    })
  }
  return u
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
  const leaseUntil = new Date(now.getTime() + 120_000).toISOString()
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
  if (!payload?.participant || !payload.text || !payload.chatId) {
    // V5 QA Agent-E 2026-05-04: when validation throws, the doc was already
    // claimed (status="running") so it leaks until the 120s lease expires.
    // Finalize the row here so dashboard / downstream observability see it
    // as failed instead of silently stuck.
    const reason = !payload?.participant
      ? "missing_participant"
      : !payload.text
        ? "empty_text"
        : "missing_chatId"
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
  let user = await findUserByParticipant(db, payload.participant)
  if (!user) {
    user = await createProvisionalUser(db, payload.participant)
  }
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
    body: payload.text.trim(),
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
    },
  }
  await db.collection(PA_COLLECTIONS.inboundEvents).doc(claimed.id).set(
    { userId: user.id, sessionId: session.id, externalChatId, from: payload.participant, body: payload.text.trim() },
    { merge: true }
  )

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
      replyText: payload.text.trim(),
      lang: "en",
      log: (event, payload) => logger.info(`[prescreen][onPaInbound] ${event}`, payload ?? {}),
    })
    if (psResult.handled) {
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
  } catch (err) {
    logger.warn("[prescreen][onPaInbound] check FAILED — falling through to Claire", {
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
      // iter31 — Mailgun for email-verification onboarding step. All
      // optional at runtime: if any value is empty, sendVerificationEmail
      // returns null and the orchestrator falls through to complete-without-
      // verification.
      MAILGUN_API_KEY,
      MAILGUN_DOMAIN,
      MAILGUN_FROM,
      MAILGUN_REGION,
      // v1.7 Phase 69 — Anthropic Sonnet powers pa-resume-parser fallback
      // tier + sponsorship-inference + industry-second-pass. All paths
      // already gracefully fall through when ANTHROPIC_API_KEY is empty
      // (gpt-5.4-nano → gpt-4.1-mini → Qwen-7B chain). Listed here so the
      // moment Adam provisions the secret it auto-activates without redeploy
      // beyond the one Phase 69 rollout.
      ANTHROPIC_API_KEY,
    ],
    memory: "1GiB",
    timeoutSeconds: 300,
    concurrency: 1,
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
    if ((data as { coalescing?: boolean }).coalescing === true && (data as { coalesced?: boolean }).coalesced !== true) {
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
      // iter31 — Mailgun transport callback for the email-verification
      // onboarding step. Returns null when secrets are empty, signaling the
      // orchestrator to fall through to complete-without-verification.
      const orchestratorDeps = makeOrchestratorDeps()
      const processed = isBrokerImessageEvent(data)
        ? await processBrokerImessageEvent(db, data, orchestratorDeps)
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
    // Stream D — webhook now also fires-and-forgets sendReaction (needs
    // Sendblue creds) and ingestCv (needs PA_OPENAI_AGENT_API_KEY for the
    // CV LLM extraction). All four are required at request time.
    secrets: [
      SENDBLUE_WEBHOOK_SIGNING_SECRET,
      SENDBLUE_API_KEY_ID,
      SENDBLUE_API_SECRET_KEY,
      SENDBLUE_FROM_NUMBER,
      PA_OPENAI_AGENT_API_KEY,
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
 * Returns deps even when env config is missing — but in that case the
 * tasks-client will throw at first use, and the webhook treats that as a
 * "fall back to legacy direct path" signal (zero-regression contract).
 */
// Exported so the coalescer integration test can assert this factory
// wires `orchestratorDeps.sendVerificationEmail` (iter33 Bug 8 regression
// guard — the bug was that the coalescer path was building this without
// calling makeOrchestratorDeps(), so Mailgun verify was a silent no-op).
export function buildCoalescerDeps(): CoalescerDeps {
  const cfg = resolveTasksConfigFromEnv(process.env)
  return {
    db: getFirestore(),
    tasks: new GoogleCloudTasksClient(cfg),
    sendReaction: defaultSendReaction,
    // iter33 Bug 8 fix 2026-05-05 — pass through Mailgun-wired
    // orchestrator deps so the coalescer's claimAndProcessInboundEvent
    // call uses a store with sendVerificationEmail bound (not undefined).
    // makeOrchestratorDeps reads MAILGUN_* via .value() — the secrets
    // must be bound to whichever fn invokes this builder.
    orchestratorDeps: makeOrchestratorDeps(),
    log: (...args: unknown[]) => logger.info("[coalesce]", ...args),
  }
}

/**
 * Build the deps object passed to handleSendblueWebhook. Wires the
 * coalescer in BUT only if env config is present — otherwise the webhook
 * runs in legacy mode (flag check inside webhook also gates the call,
 * defense in depth).
 */
function buildSendblueWebhookDeps() {
  let coalescerDeps: CoalescerDeps | undefined
  try {
    coalescerDeps = buildCoalescerDeps()
  } catch (err) {
    logger.warn("[coalesce][webhook] coalescer deps not built (env incomplete) — legacy path only", {
      err: err instanceof Error ? err.message : String(err),
    })
  }
  // v1.5 TD-A (2026-05-03): proper-fix fallback for Cloud Tasks enqueue
  // failure. After TD-A the inbound row is stamped `coalescing:true` AT
  // CREATE so onPaInbound's onDocumentCreated trigger skips it. If the
  // subsequent Cloud Tasks enqueue then errors, nothing else will pick the
  // row up — we must drive the legacy orchestrator path right here.
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
  // pa-users.tags + format per CLAUDE.md flow + enqueue pa-outbound. Admin
  // gating happens INSIDE webhook.ts before this is called; we trust the
  // caller. Fail-open: any error logs + returns ok:false rather than crashing.
  const generateJobRecsForUser = async (args: {
    userId: string
    toE164: string
  }): Promise<{ ok: boolean; jobCount: number; reason?: string }> => {
    const db = getFirestore()
    try {
      const { queryMatchingJobsV16 } = await import("@pa/job-rec")
      const { sendImessage } = await import("@pa/job-rec")
      const result = await queryMatchingJobsV16(
        { userId: args.userId, limit: 5 },
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
      // Format per the v1.6 cascade contract — title @ company \n url \n why
      const lines: string[] = []
      lines.push("先给你拉了几个 (admin force):")
      for (const job of result.jobs) {
        const tag = job.companyName ? ` @ ${job.companyName}` : ""
        const url = job.atsApplyUrl ? `\n${job.atsApplyUrl}` : job.primaryUrl ? `\n${job.primaryUrl}` : ""
        const reason = job.reason ? `\n${job.reason}` : ""
        lines.push(`• ${job.jobTitle}${tag}${url}${reason}`)
      }
      const body = lines.join("\n\n")
      const sendRes = await sendImessage(
        {
          userId: args.userId,
          content: body,
          // Idempotency: include hh:mm so the same admin can retrigger within
          // a day but rapid spamming (same minute) dedups. Mirrors the daily
          // batch convention without colliding with it.
          idempotencyKey: `${args.userId}-${new Date().toISOString().slice(0, 16)}-find-match`,
        },
        {
          db,
          log: (...a: unknown[]) => logger.info("[sendblue][webhook][find-match][send]", ...a),
        }
      )
      return {
        ok: sendRes.ok,
        jobCount: result.jobs.length,
        ...(sendRes.ok ? {} : { reason: "send_failed" }),
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
    // iter33 Bug 8 fix 2026-05-05 (Adam reported live: "i dont see verification
    // coming after I gave the email"). Coalescer path runs the orchestrator
    // via claimAndProcessInboundEvent → createFirestoreOrchestratorStore.
    // makeOrchestratorDeps() reads MAILGUN_* via .value() — those calls
    // throw if the secrets aren't bound to THIS function. Without them,
    // sendVerificationEmail = undefined → q_email_asked falls through to
    // "got it — email saved" (no-transport branch) → user skips verify +
    // ToS + role probe entirely. Bind MAILGUN_SECRETS so the coalescer
    // path matches onPaInbound's onboarding behavior.
    secrets: [SENDBLUE_API_KEY_ID, SENDBLUE_API_SECRET_KEY, SENDBLUE_FROM_NUMBER, SILICONFLOW_API_KEY, PA_OPENAI_AGENT_API_KEY, QDRANT_URL, QDRANT_API_KEY, ...MAILGUN_SECRETS],
    memory: "512MiB",
    timeoutSeconds: 120,
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
    // iter33 Bug 8 fix — hydrate MAILGUN_* into env so makeOrchestratorDeps()
    // sees them. Same pattern as SENDBLUE_*. Each .value() throws if the
    // secret isn't bound; we tolerate that for graceful degradation
    // (orchestrator falls back to no-transport with a clear log).
    try { process.env.MAILGUN_API_KEY = MAILGUN_API_KEY.value() } catch {}
    try { process.env.MAILGUN_DOMAIN = MAILGUN_DOMAIN.value() } catch {}
    try { process.env.MAILGUN_FROM = MAILGUN_FROM.value() } catch {}
    try { process.env.MAILGUN_REGION = MAILGUN_REGION.value() } catch {}

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
    // iter33 Bug 8 fix 2026-05-05 — same MAILGUN_SECRETS rationale as
    // paMessageCoalescer. Sweep can fire force-flush of a pending buffer
    // → drives orchestrator → onboarding email-verify path needs Mailgun.
    secrets: [SENDBLUE_API_KEY_ID, SENDBLUE_API_SECRET_KEY, SENDBLUE_FROM_NUMBER, SILICONFLOW_API_KEY, PA_OPENAI_AGENT_API_KEY, QDRANT_URL, QDRANT_API_KEY, ...MAILGUN_SECRETS],
    memory: "256MiB",
    timeoutSeconds: 120,
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
    // iter33 Bug 8 fix — hydrate MAILGUN_* into env (same as coalescer).
    try { process.env.MAILGUN_API_KEY = MAILGUN_API_KEY.value() } catch {}
    try { process.env.MAILGUN_DOMAIN = MAILGUN_DOMAIN.value() } catch {}
    try { process.env.MAILGUN_FROM = MAILGUN_FROM.value() } catch {}
    try { process.env.MAILGUN_REGION = MAILGUN_REGION.value() } catch {}
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
 * Sendblue REST. Honors PA_CHANNEL_LEGACY=1 early-return (D-08) for
 * parallel-run rollback safety.
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
    const { appendMessage, getOrCreateSession, getUser } = await import("@pa/pa-persistence")

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
    const { appendMessage, getOrCreateSession, getUser } = await import("@pa/pa-persistence")
    const { paSendblueOutboxRetrySweepHandler } = await import("./sendblue/outbox-retry-sweep.js")

    try {
      const result = await paSendblueOutboxRetrySweepHandler({
        db: getFirestore(),
        sendblueClient: { sendImessage, sendTypingIndicator },
        log: (...args: unknown[]) => logger.info("[sendblue][retry-sweep]", ...args),
        appendMessage,
        getOrCreateSession,
        getUser,
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
      // a love/question reaction on an `out-cv-overwrite-*` prompt, this
      // promotes the staged CV (replace or supplement) and short-circuits
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
// rate limit, renders the template, and enqueues `pa-outbound`. The
// existing paSendblueOutbox CF then sends the message via Sendblue.

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
    secrets: [PA_OPENAI_AGENT_API_KEY],
    memory: "256MiB",
    timeoutSeconds: 540,
  },
  async () => {
    process.env.PA_OPENAI_AGENT_API_KEY = PA_OPENAI_AGENT_API_KEY.value()
    const { runPrescreenDriftDetector } = await import("./prescreen-drift-detector.js")
    const db = (await import("firebase-admin/firestore")).getFirestore()
    const result = await runPrescreenDriftDetector({ db, log: (e, p) => logger.info(`drift.${e}`, p) })
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

