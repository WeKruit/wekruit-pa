/**
 * v1.6 Phase 61 — QA evaluator weekly (V1.6 SHIP GATE).
 *
 * Cloud Scheduler `paQaEvaluatorWeekly` runs Mon 09:00 UTC. Samples up to 100
 * user×match pairs (priority queue first, random fill remainder), evaluates
 * each pair via Qwen-7B judge (lib/qa-judge.ts), aggregates pass rates, and
 * alerts via Slack + Mailgun if either threshold is missed.
 *
 * REQ-IDs: QA-01, QA-02, QA-03, QA-04, QA-05
 *
 * Pipeline per run:
 *   1. Load all `pa-users` with `tags.targetRoleFunction.length > 0`.
 *   2. Read `pa-qa-priority-queue` (failure-loop carry-over from prior run).
 *   3. Build sample: priority users first, fill with random shuffle of others
 *      up to SAMPLE_SIZE (100 by default).
 *   4. For each sampled user (concurrency=5, Qwen-7B free-tier limited):
 *      a. Query top-3 active jobs via the Phase 56 V16 minimal path
 *         (Firestore where status=active + array-contains-any roleFunction).
 *      b. For each (user, job) pair, call evaluateQaPair (Qwen-7B JSON-mode).
 *      c. Persist verdict in the run's pairs array.
 *   5. Aggregate hardFilterPassRate + top3AcceptableRate.
 *   6. Identify failing users (any pair failed) → write to priority queue with
 *      8d TTL. Clear expired priority-queue entries.
 *   7. If hardFilter <0.9 OR top3 <0.7: best-effort Slack webhook + Mailgun
 *      email. Both failures non-fatal.
 *   8. Persist `pa-qa-evaluator-runs/{runId}` with full sample + per-pair
 *      verdicts + aggregate rates + alertSent flag.
 *   9. Update `pa-milestones-state/v1.6.qaShipGate` with pass/fail status.
 *
 * Failure semantics (NEVER aborts):
 *   - Per-pair judge failure → recorded with reasoning="judge_error", run continues
 *   - Per-user query failure → logged + skipped, run continues
 *   - Slack webhook missing → log warn, fall through to Mailgun
 *   - Mailgun missing creds → log warn, alertSent=false, run still persists
 *   - Priority-queue cleanup failure → log warn, run still persists
 *
 * Cost budget: 100 pairs × Qwen-7B free tier = $0/run. Mailgun email = ~$0.0008.
 *
 * Architecture: pure logic in `runQaEvaluator` (deps-injected for tests). The
 * `paQaEvaluatorWeekly` onSchedule wrapper at the bottom is a thin shim that
 * wires production deps (Firestore + real evaluator + real Mailgun + fetch).
 */

import { onSchedule } from "firebase-functions/v2/scheduler"
import { defineSecret } from "firebase-functions/params"
import { logger } from "firebase-functions/v2"
import {
  getFirestore,
  type Firestore,
  type DocumentData,
  type QueryDocumentSnapshot,
} from "firebase-admin/firestore"

import { createHash } from "node:crypto"

import {
  evaluateQaPair,
  type QaJudgeInput,
  type QaJudgeOutput,
} from "./lib/qa-judge.js"
import { sendMailgun, type MailgunConfig } from "./email/mailgun.js"
import { makeLimiter } from "./liveness-sweep.js"
import { postSlackAlert } from "./lib/slack-alert.js"
import type { AgentRankingResult } from "@pa/core-types"

// ---------------------------------------------------------------------------
// Secrets
// ---------------------------------------------------------------------------

const SILICONFLOW_API_KEY = defineSecret("SILICONFLOW_API_KEY")
// v1.7 Phase 69 — Mailgun + Slack secrets are declared centrally in
// orchestrator-deps.ts. We import the handles so multiple CFs can share a
// single defineSecret() call per name (Firebase still permits duplicate
// declarations but the central location keeps the Adam-action surface
// auditable in one place).
import {
  MAILGUN_API_KEY,
  MAILGUN_DOMAIN,
  MAILGUN_FROM,
  MAILGUN_REGION,
  PA_SLACK_ALERT_WEBHOOK,
} from "./orchestrator-deps.js"

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Maximum sample size per run. Adam-pinned at 100 (D13). */
export const SAMPLE_SIZE = 100
/** How many top jobs per user we evaluate. Adam-pinned at 3 (top-3 acceptable rate). */
export const TOP_N_PER_USER = 3
/** Threshold for hardFilterPass rate alert. Below this → alert. */
export const HARD_FILTER_PASS_THRESHOLD = 0.9
/** Threshold for top3Acceptable rate alert. Below this → alert. */
export const TOP3_ACCEPTABLE_THRESHOLD = 0.7
/**
 * v1.7 hotfix — minimum sample size below which an alert is suppressed.
 * Insufficient sample is a DATA-THINNESS signal (corpus stale OR no users
 * have populated `tags.targetRoleFunction`), not a quality regression. Alerting
 * on it spams Mailgun + Slack without actionable signal. Run is still persisted
 * to `pa-qa-evaluator-runs` so the audit trail remains complete; ship-gate state
 * also still updates so the milestone can't false-pass on empty data.
 */
export const MIN_SAMPLE_FOR_ALERT = 10
/** Failing users persist in priority queue for this many days. */
export const PRIORITY_QUEUE_TTL_DAYS = 8
/** Concurrency for per-user processing. Bounded by SiliconFlow rate. */
export const USER_CONCURRENCY = 5
/** Firestore array-contains-any cap. Mirrors Phase 56 V16 query. */
export const ROLE_FUNCTION_QUERY_CAP = 10
/** Pool size for top-N query per user (oversample to filter dead jobs). */
export const PER_USER_JOB_POOL = 50
/** v1.7 — freshness window relaxed to 90d. firstSeenAt is INGESTION-DATE
 * (when scraper added doc), NOT JD posted-at. Real corpus has sparse fresh
 * data because macmini scraping is rate-limited; 90d window matches V16
 * adaptive max-relaxation tier so QA samples on what production users
 * actually see. The 20d strict spec lives in V16 reader; QA is downstream
 * eval, not the producer of that filter. */
export const FRESHNESS_WINDOW_MS = 90 * 24 * 3600 * 1000

const PA_USERS_COLLECTION = "pa-users"
const MATCHING_JOBS_COLLECTION = "matching-jobs"
const RUNS_COLLECTION = "pa-qa-evaluator-runs"
const PRIORITY_QUEUE_COLLECTION = "pa-qa-priority-queue"
const MILESTONE_STATE_COLLECTION = "pa-milestones-state"
const MILESTONE_VERSION = "v1.6"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type UserTagsLike = {
  targetRoleFunction?: string[]
  skills?: ReadonlyArray<unknown>
  relevantIndustry?: string[]
  industrySector?: string[]
  careerStage?: string
  visaStatus?: string
  targetLocations?: string[]
  yoeRange?: string
}

export type SampleUserDoc = {
  id: string
  tags: UserTagsLike
}

export type QaJobDoc = {
  id: string
  roleTitle?: string
  jobTitle?: string
  companyName?: string
  company?: string
  companyDisplayName?: string
  industrySector?: string[]
  requiredSkills?: string[]
  seniorityLevel?: string
  sponsorship?: boolean
  locationRaw?: string
  location?: string
  jobDescription?: string
}

export type EvaluatedPair = {
  userId: string
  jobId: string
  hardFilterPass: boolean
  top3Acceptable: boolean
  reasoning: string
  evaluatedAt: string
}

export type RunMetrics = {
  runId: string
  sampleSize: number
  hardFilterPassRate: number
  top3AcceptableRate: number
  failingUserCount: number
  alertSent: boolean
  passes: boolean
  durationMs: number
}

export type AlertPayload = {
  runId: string
  hardFilterPassRate: number
  top3AcceptableRate: number
  failingUserCount: number
  message: string
}

/** Storage seam — production wires Firestore, tests inject fakes. */
export type QaEvaluatorStore = {
  fetchEligibleUsers: () => Promise<SampleUserDoc[]>
  fetchPriorityQueueUserIds: () => Promise<string[]>
  fetchTopJobsForUser: (
    targetRoleFunction: string[],
    topN: number
  ) => Promise<QaJobDoc[]>
  upsertPriorityQueue: (
    userId: string,
    payload: { addedAt: string; ttlExpiresAt: string; lastRunId: string }
  ) => Promise<void>
  clearExpiredPriorityQueue: (nowIso: string) => Promise<number>
  writeRun: (runId: string, doc: Record<string, unknown>) => Promise<void>
  writeMilestoneState: (
    payload: Record<string, unknown>
  ) => Promise<void>
  /**
   * V2 External Supply Wave E (F) additive seam — fetch up to `cap` recent
   * `pa-agent-ranking-results` rows (createdAt >= sinceMs). When this method is
   * not provided, the agent-override sampler step is silently skipped (back-compat
   * with V1 callers / tests). Lead resolution L-F1 / L-F3.
   */
  fetchRecentAgentRankingRows?: (
    sinceMs: number,
    cap: number
  ) => Promise<AgentRankingResult[]>
}

/** External integrations — production wires Mailgun + fetch. */
export type QaEvaluatorIntegrations = {
  evaluatePair: (input: QaJudgeInput) => Promise<QaJudgeOutput>
  sendSlack?: (message: string) => Promise<boolean>
  sendEmail?: (subject: string, body: string) => Promise<boolean>
}

export type QaEvaluatorDeps = {
  store: QaEvaluatorStore
  integrations: QaEvaluatorIntegrations
  /** Inject for test determinism; default Date.now. */
  now?: () => number
  /** Inject for test determinism; default Math.random. */
  random?: () => number
  /** Override for tests. */
  sampleSize?: number
  topNPerUser?: number
  hardFilterPassThreshold?: number
  top3AcceptableThreshold?: number
  priorityQueueTtlDays?: number
  userConcurrency?: number
  /** Min sample below which alerts suppress (data-thinness guard). Default MIN_SAMPLE_FOR_ALERT (10). Tests override to 1 to exercise alert paths. */
  minSampleForAlert?: number
  /** v1.7 — Restrict sample to a specific list of userIds (admin-callable mode).
   *  When set, ignores priority queue + general user list. Used for ad-hoc Adam-only runs. */
  forceUserIds?: string[]
  log?: (msg: string, ctx?: Record<string, unknown>) => void
  errorLog?: (msg: string, ctx?: Record<string, unknown>) => void
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Coerce `tags.skills[]` (string OR `{name}`) → flat string list. */
export function extractSkillNames(skills: ReadonlyArray<unknown> | undefined): string[] {
  if (!Array.isArray(skills)) return []
  const out: string[] = []
  const seen = new Set<string>()
  for (const s of skills) {
    let name: string | undefined
    if (typeof s === "string") name = s.trim()
    else if (s && typeof s === "object" && typeof (s as { name?: unknown }).name === "string") {
      name = (s as { name: string }).name.trim()
    }
    if (!name || name.length === 0) continue
    const key = name.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(name)
  }
  return out
}

/**
 * Fisher-Yates shuffle (in-place on a copy). Deterministic when caller injects
 * a seeded random; default is Math.random.
 */
export function shuffle<T>(arr: ReadonlyArray<T>, random: () => number = Math.random): T[] {
  const a = [...arr]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1))
    ;[a[i], a[j]] = [a[j]!, a[i]!]
  }
  return a
}

/**
 * Build the final sample list: priority users first (capped at sampleSize),
 * then fill remaining slots with shuffled non-priority users.
 */
export function buildSample(
  eligibleUsers: SampleUserDoc[],
  priorityUserIds: ReadonlySet<string>,
  sampleSize: number,
  random: () => number
): SampleUserDoc[] {
  const priorityUsers = eligibleUsers.filter((u) => priorityUserIds.has(u.id))
  const otherUsers = eligibleUsers.filter((u) => !priorityUserIds.has(u.id))
  const priorityHead = priorityUsers.slice(0, sampleSize)
  const remaining = Math.max(0, sampleSize - priorityHead.length)
  const otherTail = shuffle(otherUsers, random).slice(0, remaining)
  return [...priorityHead, ...otherTail].slice(0, sampleSize)
}

/** Project a job doc → QaJudgeInput.job shape, preferring most-specific fields. */
export function projectJobForJudge(job: QaJobDoc): QaJudgeInput["job"] {
  const roleTitle = job.roleTitle ?? job.jobTitle ?? ""
  const companyName = job.companyName ?? job.company ?? job.companyDisplayName ?? ""
  const out: QaJudgeInput["job"] = {
    roleTitle,
    companyName,
  }
  if (Array.isArray(job.industrySector) && job.industrySector.length > 0) {
    out.industrySector = job.industrySector
  }
  if (Array.isArray(job.requiredSkills) && job.requiredSkills.length > 0) {
    out.requiredSkills = job.requiredSkills
  }
  if (typeof job.seniorityLevel === "string" && job.seniorityLevel.length > 0) {
    out.seniorityLevel = job.seniorityLevel
  }
  if (typeof job.sponsorship === "boolean") {
    out.sponsorship = job.sponsorship
  }
  const loc = job.locationRaw ?? job.location
  if (typeof loc === "string" && loc.length > 0) {
    out.locationRaw = loc
  }
  if (typeof job.jobDescription === "string" && job.jobDescription.length > 0) {
    out.jobDescription = job.jobDescription.slice(0, 600)
  }
  return out
}

/** Project user tags → QaJudgeInput.user shape. */
export function projectUserForJudge(tags: UserTagsLike): QaJudgeInput["user"] {
  const skills = extractSkillNames(tags.skills).slice(0, 12)
  const out: QaJudgeInput["user"] = {
    targetRoleFunction: Array.isArray(tags.targetRoleFunction) ? tags.targetRoleFunction : [],
    skills,
  }
  if (Array.isArray(tags.relevantIndustry) && tags.relevantIndustry.length > 0) {
    out.relevantIndustry = tags.relevantIndustry
  }
  if (Array.isArray(tags.industrySector) && tags.industrySector.length > 0) {
    out.industrySector = tags.industrySector
  }
  if (typeof tags.careerStage === "string" && tags.careerStage.length > 0) {
    out.careerStage = tags.careerStage
  }
  if (typeof tags.visaStatus === "string" && tags.visaStatus.length > 0) {
    out.visaStatus = tags.visaStatus
  }
  if (Array.isArray(tags.targetLocations) && tags.targetLocations.length > 0) {
    out.targetLocations = tags.targetLocations
  }
  if (typeof tags.yoeRange === "string" && tags.yoeRange.length > 0) {
    out.yoeRange = tags.yoeRange
  }
  return out
}

// ---------------------------------------------------------------------------
// V2 External Supply Wave E (F) — agent-override sampler helpers
// ---------------------------------------------------------------------------

/**
 * Agent-ranking sampler — pool / pick / threshold per L-F1.
 * 200 rows pulled, 50 sampled deterministically per ISO week.
 */
export const AGENT_RANKING_SAMPLE_POOL = 200
export const AGENT_RANKING_SAMPLE_PICK = 50
/** Strict-greater-than threshold for the operator-override flag. */
export const AGENT_RANKING_OVERRIDE_THRESHOLD = 0.15
/** Lookback window for pulling ranking rows — 7d so a weekly cron sees a full week. */
export const AGENT_RANKING_LOOKBACK_MS = 7 * 24 * 3600 * 1000

/**
 * ISO 8601 week key — e.g. `"2026-W19"`. Pure, timezone-stable (uses UTC).
 *
 * Algorithm: shift the date to the Thursday in the same ISO week, then compute
 * week number from the year's first Thursday. No external deps.
 */
export function isoWeekKey(d: Date): string {
  const ms = d.getTime()
  if (!Number.isFinite(ms)) {
    throw new Error("isoWeekKey: invalid date")
  }
  // Copy as UTC date — strip time-of-day so DST/zone never affects the bucket.
  const utc = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
  // ISO: Mon=1 .. Sun=7. JS UTC: Sun=0 .. Sat=6.
  const dow = utc.getUTCDay() || 7
  // Shift to the Thursday of the current ISO week.
  utc.setUTCDate(utc.getUTCDate() + 4 - dow)
  const isoYear = utc.getUTCFullYear()
  const jan1 = Date.UTC(isoYear, 0, 1)
  const dayOfYear = Math.floor((utc.getTime() - jan1) / (24 * 3600 * 1000)) + 1
  const weekNum = Math.ceil(dayOfYear / 7)
  return `${isoYear}-W${String(weekNum).padStart(2, "0")}`
}

/**
 * Deterministic seeded RNG (mulberry32) over the first 32 bits of sha256(seed).
 * Stable across Node versions (no Math.random dependence).
 */
export function makeSeededRng(seed: string): () => number {
  const hash = createHash("sha256").update(seed).digest()
  // mulberry32 wants a uint32 seed.
  let a =
    ((hash[0]! << 24) | (hash[1]! << 16) | (hash[2]! << 8) | hash[3]!) >>> 0
  return function () {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * Pure sampler — filters to `approved` | `overridden` status, then takes a
 * deterministic shuffled prefix of size `opts.pick` from the first `opts.pool`
 * eligible rows.
 *
 * The seed is `"qa-agent-rank:" + weekKey` so a given ISO week always picks
 * the same sample (reproducible audit, L-F1).
 */
export function sampleAgentRankingRows(
  rows: ReadonlyArray<AgentRankingResult>,
  weekKey: string,
  opts: { pool?: number; pick?: number } = {}
): AgentRankingResult[] {
  const pool = opts.pool ?? AGENT_RANKING_SAMPLE_POOL
  const pick = opts.pick ?? AGENT_RANKING_SAMPLE_PICK
  const eligible = rows.filter(
    (r) => r.status === "approved" || r.status === "overridden"
  )
  const head = eligible.slice(0, pool)
  const rng = makeSeededRng(`qa-agent-rank:${weekKey}`)
  return shuffle(head, rng).slice(0, pick)
}

/**
 * Pure aggregate — operator-override rate over a sample, plus flag.
 *
 * `flag` is **strict** `> 0.15` (L-F1) so the exact-equal-threshold case
 * does not page anyone. Empty samples never flag.
 */
export function computeAgentOverrideMetrics(
  sample: ReadonlyArray<AgentRankingResult>,
  opts: { weekKey: string; threshold?: number }
): {
  sampled: number
  approvals: number
  overrides: number
  operatorOverrideRate: number
  flag: boolean
  weekKey: string
} {
  const threshold = opts.threshold ?? AGENT_RANKING_OVERRIDE_THRESHOLD
  const approvals = sample.filter((r) => r.status === "approved").length
  const overrides = sample.filter((r) => r.status === "overridden").length
  const denom = approvals + overrides
  const operatorOverrideRate = denom > 0 ? overrides / denom : 0
  const flag = denom > 0 && operatorOverrideRate > threshold
  return {
    sampled: sample.length,
    approvals,
    overrides,
    operatorOverrideRate,
    flag,
    weekKey: opts.weekKey,
  }
}

/** Build a fresh runId — millisecond ISO + short random suffix. */
function newRunId(now: number, random: () => number): string {
  const iso = new Date(now).toISOString().replace(/[:.]/g, "-")
  const suffix = Math.floor(random() * 36 ** 6)
    .toString(36)
    .padStart(6, "0")
    .slice(0, 6)
  return `qa-${iso}-${suffix}`
}

// ---------------------------------------------------------------------------
// Main driver
// ---------------------------------------------------------------------------

export async function runQaEvaluator(
  deps: QaEvaluatorDeps
): Promise<RunMetrics> {
  const log = deps.log ?? (() => {})
  const errorLog = deps.errorLog ?? log
  const now = deps.now ?? (() => Date.now())
  const random = deps.random ?? Math.random
  const sampleSize = deps.sampleSize ?? SAMPLE_SIZE
  const topN = deps.topNPerUser ?? TOP_N_PER_USER
  const hfThreshold = deps.hardFilterPassThreshold ?? HARD_FILTER_PASS_THRESHOLD
  const t3Threshold = deps.top3AcceptableThreshold ?? TOP3_ACCEPTABLE_THRESHOLD
  const ttlDays = deps.priorityQueueTtlDays ?? PRIORITY_QUEUE_TTL_DAYS
  const userConcurrency = deps.userConcurrency ?? USER_CONCURRENCY

  const startMs = now()
  const runId = newRunId(startMs, random)

  log("qa_eval.start", { runId })

  // 1. Eligible users.
  let eligibleUsers: SampleUserDoc[]
  try {
    eligibleUsers = await deps.store.fetchEligibleUsers()
  } catch (err) {
    errorLog("qa_eval.fetch_users_failed", {
      runId,
      err: String(err).slice(0, 200),
    })
    throw err
  }

  // 2. Priority queue.
  let priorityUserIds: string[]
  try {
    priorityUserIds = await deps.store.fetchPriorityQueueUserIds()
  } catch (err) {
    errorLog("qa_eval.priority_queue_read_failed", {
      runId,
      err: String(err).slice(0, 200),
    })
    priorityUserIds = []
  }

  // 3. Build sample.
  // v1.7 admin override — when forceUserIds set, scope the sample to ONLY
  // those users (admin-callable ad-hoc runs, e.g. "evaluate Adam's matches now").
  // Bypasses priority-queue + general sampling logic. Tags are loaded directly
  // from the same store path used for eligibleUsers — the user must exist.
  let sample: SampleUserDoc[]
  if (deps.forceUserIds && deps.forceUserIds.length > 0) {
    const forceSet = new Set(deps.forceUserIds)
    sample = eligibleUsers.filter((u) => forceSet.has(u.id))
    log("qa_eval.force_user_mode", {
      runId,
      forceUserIds: deps.forceUserIds,
      matchedCount: sample.length,
    })
  } else {
    const prioritySet = new Set(priorityUserIds)
    sample = buildSample(eligibleUsers, prioritySet, sampleSize, random)
  }

  log("qa_eval.sampling", {
    runId,
    totalEligible: eligibleUsers.length,
    priorityQueue: priorityUserIds.length,
    sampleSize: sample.length,
    forceUserMode: !!deps.forceUserIds?.length,
  })

  // 4. Per-user evaluation.
  const allPairs: EvaluatedPair[] = []
  const limiter = makeLimiter(userConcurrency)

  await Promise.allSettled(
    sample.map((userDoc) =>
      limiter(async () => {
        const userId = userDoc.id
        const tags = userDoc.tags
        const targetRf = (
          Array.isArray(tags.targetRoleFunction) ? tags.targetRoleFunction : []
        ).slice(0, ROLE_FUNCTION_QUERY_CAP)
        if (targetRf.length === 0) {
          log("qa_eval.skip_no_role_function", { runId, userId })
          return
        }

        let jobs: QaJobDoc[]
        try {
          jobs = await deps.store.fetchTopJobsForUser(targetRf, topN)
        } catch (err) {
          errorLog("qa_eval.fetch_jobs_failed", {
            runId,
            userId,
            err: String(err).slice(0, 200),
          })
          return
        }
        if (jobs.length === 0) {
          log("qa_eval.skip_no_jobs", { runId, userId })
          return
        }

        const judgeUser = projectUserForJudge(tags)
        for (const job of jobs.slice(0, topN)) {
          const judgeInput: QaJudgeInput = {
            user: judgeUser,
            job: projectJobForJudge(job),
          }
          let verdict: QaJudgeOutput
          try {
            verdict = await deps.integrations.evaluatePair(judgeInput)
          } catch (err) {
            errorLog("qa_eval.judge_threw", {
              runId,
              userId,
              jobId: job.id,
              err: String(err).slice(0, 200),
            })
            verdict = {
              hardFilterPass: false,
              top3Acceptable: false,
              reasoning: "judge_threw",
            }
          }

          allPairs.push({
            userId,
            jobId: job.id,
            hardFilterPass: verdict.hardFilterPass,
            top3Acceptable: verdict.top3Acceptable,
            reasoning: verdict.reasoning,
            evaluatedAt: new Date(now()).toISOString(),
          })
        }
      })
    )
  )

  // 5. Aggregate.
  const evalSampleSize = allPairs.length
  const hardFilterPasses = allPairs.filter((p) => p.hardFilterPass).length
  const top3Acceptables = allPairs.filter((p) => p.top3Acceptable).length
  const hardFilterPassRate = evalSampleSize > 0 ? hardFilterPasses / evalSampleSize : 0
  const top3AcceptableRate = evalSampleSize > 0 ? top3Acceptables / evalSampleSize : 0

  // 6. Failing users + priority queue.
  const failingUserIds = Array.from(
    new Set(
      allPairs
        .filter((p) => !p.hardFilterPass || !p.top3Acceptable)
        .map((p) => p.userId)
    )
  )

  const ttlExpiresAt = new Date(now() + ttlDays * 24 * 3600 * 1000).toISOString()
  await Promise.allSettled(
    failingUserIds.map((uid) =>
      deps.store
        .upsertPriorityQueue(uid, {
          addedAt: new Date(now()).toISOString(),
          ttlExpiresAt,
          lastRunId: runId,
        })
        .catch((err) => {
          errorLog("qa_eval.priority_queue_write_failed", {
            runId,
            userId: uid,
            err: String(err).slice(0, 200),
          })
        })
    )
  )

  // Clear expired entries (best-effort).
  try {
    const cleared = await deps.store.clearExpiredPriorityQueue(new Date(now()).toISOString())
    log("qa_eval.priority_queue_cleared", { runId, cleared })
  } catch (err) {
    errorLog("qa_eval.priority_queue_clear_failed", {
      runId,
      err: String(err).slice(0, 200),
    })
  }

  // 7. Alerts.
  // v1.7 hotfix — suppress alert when sample is below MIN_SAMPLE_FOR_ALERT.
  // Insufficient sample (sampleSize < 10) is a data-thinness signal, not a
  // quality regression. Run still persists, ship-gate still updates; we only
  // skip the noisy Slack/Mailgun broadcast.
  const passes = hardFilterPassRate >= hfThreshold && top3AcceptableRate >= t3Threshold
  const minSampleForAlert = deps.minSampleForAlert ?? MIN_SAMPLE_FOR_ALERT
  const insufficientSample = evalSampleSize < minSampleForAlert
  let alertSent = false
  if (!passes && !insufficientSample) {
    const message =
      `⚠ QA evaluator FAILED (runId=${runId}): hardFilter=` +
      `${(hardFilterPassRate * 100).toFixed(1)}% (target ≥${(hfThreshold * 100).toFixed(0)}%), ` +
      `top3Acceptable=${(top3AcceptableRate * 100).toFixed(1)}% ` +
      `(target ≥${(t3Threshold * 100).toFixed(0)}%). ` +
      `${failingUserIds.length} failing users in priority queue.`

    if (deps.integrations.sendSlack) {
      try {
        const ok = await deps.integrations.sendSlack(message)
        if (ok) alertSent = true
      } catch (err) {
        errorLog("qa_eval.slack_failed", {
          runId,
          err: String(err).slice(0, 200),
        })
      }
    }

    if (deps.integrations.sendEmail) {
      try {
        const subject =
          `[v1.6 QA] FAILED — hardFilter ` +
          `${(hardFilterPassRate * 100).toFixed(1)}% / top3 ` +
          `${(top3AcceptableRate * 100).toFixed(1)}%`
        const body = `${message}\n\nFull run: ${RUNS_COLLECTION}/${runId}`
        const ok = await deps.integrations.sendEmail(subject, body)
        if (ok) alertSent = true
      } catch (err) {
        errorLog("qa_eval.email_failed", {
          runId,
          err: String(err).slice(0, 200),
        })
      }
    }

    log("qa_eval.threshold_failed", {
      runId,
      hardFilterPassRate,
      top3AcceptableRate,
      alertSent,
    })
  }

  // 7.5 V2 External Supply Wave E (F) — agent-override sampler.
  // Lead resolution L-F1 / L-F3: store the flag on the run doc, NOT on
  // pa-source-quality-metrics (that's the monthly rollup's job). Sampler is
  // a no-op when `store.fetchRecentAgentRankingRows` is absent (back-compat
  // with V1 callers and tests). All failures are non-fatal — the QA run
  // continues even if the sampler throws.
  let agentRankingBlock:
    | {
        weekKey: string
        sampled: number
        approvals: number
        overrides: number
        operatorOverrideRate: number
        flag: boolean
        threshold: number
      }
    | undefined
  if (typeof deps.store.fetchRecentAgentRankingRows === "function") {
    try {
      const startedAt = new Date(startMs)
      const weekKey = isoWeekKey(startedAt)
      const sinceMs = startMs - AGENT_RANKING_LOOKBACK_MS
      const recent = await deps.store.fetchRecentAgentRankingRows(
        sinceMs,
        AGENT_RANKING_SAMPLE_POOL
      )
      const sample = sampleAgentRankingRows(recent, weekKey, {
        pool: AGENT_RANKING_SAMPLE_POOL,
        pick: AGENT_RANKING_SAMPLE_PICK,
      })
      const metrics = computeAgentOverrideMetrics(sample, { weekKey })
      agentRankingBlock = {
        weekKey: metrics.weekKey,
        sampled: metrics.sampled,
        approvals: metrics.approvals,
        overrides: metrics.overrides,
        operatorOverrideRate: metrics.operatorOverrideRate,
        flag: metrics.flag,
        threshold: AGENT_RANKING_OVERRIDE_THRESHOLD,
      }
      log("qa_eval.agent_ranking_sampled", {
        runId,
        weekKey,
        sampled: metrics.sampled,
        operatorOverrideRate: metrics.operatorOverrideRate,
        flag: metrics.flag,
      })
      if (metrics.flag) {
        const flagMessage =
          `⚠ Agent-override rate ${(metrics.operatorOverrideRate * 100).toFixed(1)}% ` +
          `(> ${(AGENT_RANKING_OVERRIDE_THRESHOLD * 100).toFixed(0)}%) over ` +
          `${metrics.sampled} sampled rows in ${weekKey}. ` +
          `Runs at ${RUNS_COLLECTION}/${runId}.`
        if (deps.integrations.sendSlack) {
          try {
            await deps.integrations.sendSlack(flagMessage)
          } catch (err) {
            errorLog("qa_eval.agent_ranking_slack_failed", {
              runId,
              err: String(err).slice(0, 200),
            })
          }
        }
        if (deps.integrations.sendEmail) {
          try {
            await deps.integrations.sendEmail(
              `[external-supply] agent-override flag ${weekKey}`,
              flagMessage
            )
          } catch (err) {
            errorLog("qa_eval.agent_ranking_email_failed", {
              runId,
              err: String(err).slice(0, 200),
            })
          }
        }
      }
    } catch (err) {
      errorLog("qa_eval.agent_ranking_failed", {
        runId,
        err: String(err).slice(0, 200),
      })
    }
  }

  const durationMs = now() - startMs

  // 8. Run audit.
  const runDoc: Record<string, unknown> = {
    runId,
    runAt: new Date(startMs).toISOString(),
    sampleSize: evalSampleSize,
    hardFilterPassRate,
    top3AcceptableRate,
    alertSent,
    pairs: allPairs,
    failingUserIds,
    durationMs,
    passes,
    insufficientSample,
  }
  if (agentRankingBlock) {
    runDoc.agentRanking = agentRankingBlock
  }
  try {
    await deps.store.writeRun(runId, runDoc)
  } catch (err) {
    errorLog("qa_eval.run_write_failed", {
      runId,
      err: String(err).slice(0, 200),
    })
  }

  // 9. Milestone state.
  try {
    await deps.store.writeMilestoneState({
      qaShipGate: {
        status: passes ? "pass" : "fail",
        lastRunId: runId,
        lastRunAt: new Date(now()).toISOString(),
        lastRates: { hardFilterPassRate, top3AcceptableRate },
      },
    })
  } catch (err) {
    errorLog("qa_eval.milestone_state_write_failed", {
      runId,
      err: String(err).slice(0, 200),
    })
  }

  log("qa_eval.complete", {
    runId,
    sampleSize: evalSampleSize,
    hardFilterPassRate,
    top3AcceptableRate,
    failingUserCount: failingUserIds.length,
    alertSent,
    passes,
    durationMs,
  })

  return {
    runId,
    sampleSize: evalSampleSize,
    hardFilterPassRate,
    top3AcceptableRate,
    failingUserCount: failingUserIds.length,
    alertSent,
    passes,
    durationMs,
  }
}

// ---------------------------------------------------------------------------
// Production Firestore-backed store
// ---------------------------------------------------------------------------

/** Coerce a Firestore Timestamp-ish into ms-since-epoch (or 0 on noise). */
function timestampToMsLocal(v: unknown): number {
  if (typeof v === "number" && Number.isFinite(v)) return v
  if (typeof v === "string") {
    const t = Date.parse(v)
    return Number.isFinite(t) ? t : 0
  }
  if (v && typeof v === "object") {
    const obj = v as { toDate?: () => Date; seconds?: number }
    if (typeof obj.toDate === "function") {
      try {
        const d = obj.toDate()
        if (d instanceof Date) return d.getTime()
      } catch {
        return 0
      }
    }
    if (typeof obj.seconds === "number") return obj.seconds * 1000
  }
  return 0
}

function projectJobDoc(id: string, data: DocumentData): QaJobDoc {
  const out: QaJobDoc = { id }
  if (typeof data.roleTitle === "string") out.roleTitle = data.roleTitle
  if (typeof data.jobTitle === "string") out.jobTitle = data.jobTitle
  if (typeof data.companyName === "string") out.companyName = data.companyName
  if (typeof data.company === "string") out.company = data.company
  if (typeof data.companyDisplayName === "string") out.companyDisplayName = data.companyDisplayName
  if (Array.isArray(data.industrySector)) {
    out.industrySector = data.industrySector.filter(
      (s): s is string => typeof s === "string"
    )
  }
  if (Array.isArray(data.requiredSkills)) {
    out.requiredSkills = data.requiredSkills.filter(
      (s): s is string => typeof s === "string"
    )
  }
  if (typeof data.seniorityLevel === "string") out.seniorityLevel = data.seniorityLevel
  if (typeof data.sponsorship === "boolean") out.sponsorship = data.sponsorship
  if (typeof data.locationRaw === "string") out.locationRaw = data.locationRaw
  if (typeof data.location === "string") out.location = data.location
  if (typeof data.jobDescription === "string") out.jobDescription = data.jobDescription
  return out
}

export function makeFirestoreStore(db: Firestore = getFirestore()): QaEvaluatorStore {
  return {
    fetchEligibleUsers: async () => {
      const snap = await db.collection(PA_USERS_COLLECTION).get()
      const out: SampleUserDoc[] = []
      for (const doc of snap.docs as Array<QueryDocumentSnapshot>) {
        const data = doc.data() as DocumentData
        const tags = data.tags
        if (
          tags &&
          typeof tags === "object" &&
          Array.isArray((tags as { targetRoleFunction?: unknown }).targetRoleFunction) &&
          (tags as { targetRoleFunction: unknown[] }).targetRoleFunction.length > 0
        ) {
          out.push({ id: doc.id, tags: tags as UserTagsLike })
        }
      }
      return out
    },

    fetchPriorityQueueUserIds: async () => {
      const snap = await db.collection(PRIORITY_QUEUE_COLLECTION).get()
      return snap.docs.map((d) => d.id)
    },

    fetchTopJobsForUser: async (targetRoleFunction, topN) => {
      const nowMs = Date.now()
      const cutoffMs = nowMs - FRESHNESS_WINDOW_MS
      const roles = targetRoleFunction.slice(0, ROLE_FUNCTION_QUERY_CAP)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let q: any = db
        .collection(MATCHING_JOBS_COLLECTION)
        .where("status", "==", "active")
        .where("roleFunction", "array-contains-any", roles)
        .orderBy("firstSeenAt", "desc")
        .limit(PER_USER_JOB_POOL)
      let snap
      try {
        snap = await q.get()
      } catch {
        // Composite-index miss → fallback to status-only.
        q = db
          .collection(MATCHING_JOBS_COLLECTION)
          .where("status", "==", "active")
          .limit(PER_USER_JOB_POOL)
        snap = await q.get()
      }
      const out: QaJobDoc[] = []
      for (const doc of snap.docs as Array<QueryDocumentSnapshot>) {
        const data = doc.data() as DocumentData
        if (data.dead === true) continue
        const url = typeof data.atsApplyUrl === "string" ? data.atsApplyUrl : ""
        if (!url || /jobright\.ai/i.test(url)) continue
        const fsMs = timestampToMsLocal(data.firstSeenAt)
        if (fsMs > 0 && fsMs < cutoffMs) continue
        out.push(projectJobDoc(doc.id, data))
        if (out.length >= topN) break
      }
      return out
    },

    upsertPriorityQueue: async (userId, payload) => {
      await db
        .collection(PRIORITY_QUEUE_COLLECTION)
        .doc(userId)
        .set(payload, { merge: true })
    },

    clearExpiredPriorityQueue: async (nowIso) => {
      const snap = await db
        .collection(PRIORITY_QUEUE_COLLECTION)
        .where("ttlExpiresAt", "<", nowIso)
        .get()
      let cleared = 0
      await Promise.allSettled(
        snap.docs.map((d) =>
          d.ref.delete().then(
            () => {
              cleared++
            },
            () => {
              /* swallow */
            }
          )
        )
      )
      return cleared
    },

    writeRun: async (runId, doc) => {
      await db.collection(RUNS_COLLECTION).doc(runId).set(doc)
    },

    writeMilestoneState: async (payload) => {
      await db
        .collection(MILESTONE_STATE_COLLECTION)
        .doc(MILESTONE_VERSION)
        .set(payload, { merge: true })
    },

    /**
     * V2 External Supply Wave E (F) — read recent agent-ranking rows for the
     * weekly operator-override sampler. Bounded by `cap` to keep memory + query
     * cost predictable. Falls back to a status-bound query if the composite
     * createdAt index is missing.
     */
    fetchRecentAgentRankingRows: async (sinceMs, cap) => {
      const sinceIso = new Date(sinceMs).toISOString()
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let q: any = db
        .collection("pa-agent-ranking-results")
        .where("createdAt", ">=", sinceIso)
        .orderBy("createdAt", "desc")
        .limit(cap)
      let snap
      try {
        snap = await q.get()
      } catch {
        // Composite-index miss → fall back to in-status filter on the latest cap.
        q = db.collection("pa-agent-ranking-results").limit(cap)
        snap = await q.get()
      }
      const out: AgentRankingResult[] = []
      for (const doc of snap.docs as Array<QueryDocumentSnapshot>) {
        const data = doc.data() as DocumentData
        // We don't re-validate full Zod here (hot read path); we trust the
        // writer (D) to have schema-checked. The sampler only reads `.status`
        // and counts, both string/length-checked downstream.
        out.push(data as unknown as AgentRankingResult)
      }
      return out
    },
  }
}

// ---------------------------------------------------------------------------
// Production integrations
// ---------------------------------------------------------------------------

export function makeProductionIntegrations(opts: {
  siliconflowApiKey: string
  mailgun?: MailgunConfig
  slackWebhookUrl?: string
  to?: string
}): QaEvaluatorIntegrations {
  const integrations: QaEvaluatorIntegrations = {
    evaluatePair: (input) =>
      evaluateQaPair(input, { siliconflowApiKey: opts.siliconflowApiKey }),
  }

  if (opts.slackWebhookUrl && opts.slackWebhookUrl.length > 0) {
    const webhookUrl = opts.slackWebhookUrl
    integrations.sendSlack = async (message) => {
      const res = await postSlackAlert(
        {
          level: "warn",
          title: "QA Evaluator threshold failed",
          message,
        },
        { webhookUrl }
      )
      return res.posted
    }
  }

  if (opts.mailgun && opts.to && opts.to.length > 0) {
    const cfg = opts.mailgun
    const to = opts.to
    integrations.sendEmail = async (subject, body) => {
      try {
        const res = await sendMailgun(cfg, { to, subject, text: body })
        return res.ok
      } catch (err) {
        logger.warn("[qa-evaluator] mailgun_send_failed", {
          err: String(err).slice(0, 200),
        })
        return false
      }
    }
  }

  return integrations
}

// ---------------------------------------------------------------------------
// Cloud Function — Mon 09:00 UTC.
// ---------------------------------------------------------------------------

export const paQaEvaluatorWeekly = onSchedule(
  {
    schedule: "0 9 * * 1",
    timeZone: "UTC",
    memory: "1GiB",
    timeoutSeconds: 540,
    region: "us-central1",
    secrets: [
      SILICONFLOW_API_KEY,
      MAILGUN_API_KEY,
      MAILGUN_DOMAIN,
      MAILGUN_FROM,
      MAILGUN_REGION,
      PA_SLACK_ALERT_WEBHOOK,
    ],
    retryCount: 0,
  },
  async () => {
    const siliconflowKey = (SILICONFLOW_API_KEY.value() ?? "").trim()
    if (!siliconflowKey) {
      logger.warn(
        "[qa-evaluator] SILICONFLOW_API_KEY missing — judge will conservative-fail every pair"
      )
    }

    let mailgun: MailgunConfig | undefined
    try {
      const apiKey = (MAILGUN_API_KEY.value() ?? "").trim()
      const domain = (MAILGUN_DOMAIN.value() ?? "").trim()
      const from = (MAILGUN_FROM.value() ?? "").trim()
      const regionRaw = (MAILGUN_REGION.value() ?? "us").trim()
      const region: "us" | "eu" = regionRaw === "eu" ? "eu" : "us"
      if (apiKey && domain && from) {
        mailgun = { apiKey, domain, from, region }
      }
    } catch (err) {
      logger.warn("[qa-evaluator] mailgun_secret_read_failed", {
        err: String(err).slice(0, 200),
      })
    }

    // v1.7 Phase 69 — read from the defineSecret first (Firebase-managed),
    // fall back to env var for legacy --update-env-vars deploys. Empty
    // string OR `__UNSET__` sentinel = secret not provisioned →
    // postSlackAlert short-circuits and Mailgun alongside picks up the alert.
    const slackWebhookUrl = (() => {
      const isReal = (v: string) => v.length > 0 && v !== "__UNSET__"
      try {
        const secretVal = (PA_SLACK_ALERT_WEBHOOK.value() ?? "").trim()
        if (isReal(secretVal)) return secretVal
      } catch {
        // secret not provisioned yet — fall through
      }
      const env = (process.env.PA_SLACK_ALERT_WEBHOOK ?? "").trim()
      return isReal(env) ? env : ""
    })()

    const db = getFirestore()
    const store = makeFirestoreStore(db)
    const integrations = makeProductionIntegrations({
      siliconflowApiKey: siliconflowKey,
      mailgun,
      slackWebhookUrl: slackWebhookUrl.length > 0 ? slackWebhookUrl : undefined,
      to: "developers@wekruit.com",
    })

    const result = await runQaEvaluator({
      store,
      integrations,
      now: () => Date.now(),
      random: Math.random,
      log: (msg, ctx) => logger.info(`[qa-evaluator] ${msg}`, ctx ?? {}),
      errorLog: (msg, ctx) => logger.error(`[qa-evaluator] ${msg}`, ctx ?? {}),
    })

    logger.info("[qa-evaluator] done", {
      runId: result.runId,
      sampleSize: result.sampleSize,
      hardFilterPassRate: result.hardFilterPassRate,
      top3AcceptableRate: result.top3AcceptableRate,
      failingUserCount: result.failingUserCount,
      alertSent: result.alertSent,
      passes: result.passes,
      durationMs: result.durationMs,
    })
  }
)
