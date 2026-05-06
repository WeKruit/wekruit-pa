/**
 * v1.6 Phase 58 — Nightly LLM rerank batch + per-skill JD-rel weight cache.
 *
 * Cloud Scheduler `paLlmRerankNightly` at 04:00 UTC (1h after Phase 57's
 * `paLivenessSweepDaily` at 03:00 UTC).
 *
 * For each `pa-users/{userId}` whose `tags.targetRoleFunction.length > 0`:
 *   1. Skip if `pa-user-rerank-cache/{userId}.computedAt` < 23h old.
 *   2. Query candidate pool (top 50) via a minimal hard-filtered Firestore
 *      read. We deliberately DON'T call Phase 56's `queryMatchingJobsV16`
 *      end-to-end — that path reads the very `pa-user-rerank-cache` doc we're
 *      about to write, creating a recursion / read-your-own-write pattern.
 *      This batch only needs the candidate pool (LLM does its own ranking).
 *   3. Compose `RerankInput` from `tags` + jobs, call existing `llmRerank()`
 *      (Qwen-7B JSON-mode, iter34 H.2 commit `c187c50`).
 *   4. Write `pa-user-rerank-cache/{userId}` { ranked, computedAt, modelUsed,
 *      candidatePoolSize }.
 *   5. For top-N (10) ranked jobs, compute per-skill JD-rel weights via
 *      `computeJdRelativeWeights` (Sonnet → gpt-5.4-nano → Qwen → fallback).
 *      Write `pa-user-skill-jdrel-cache/{userId}/jobs/{jobId}` { jdRelativeWeights,
 *      computedAt, modelUsed }.
 *   6. Audit row in `pa-rerank-runs/{runId}` with counters.
 *
 * Concurrency:
 *   - 5 users in parallel (Qwen-7B free tier rate limits).
 *   - 3 JD-rel calls per user in parallel (top-10 → ~3 batches/user).
 *
 * Failure semantics:
 *   - Per-skill failure → continue with other skills.
 *   - Per-job JD-rel failure → continue with other jobs in top-10.
 *   - Per-user failure (rerank throws) → counted, log, continue with next user.
 *   - Audit always written (best-effort).
 *
 * Architecture: pure logic in `runNightlyRerank` (deps-injected). The
 * `paLlmRerankNightly` onSchedule wrapper at the bottom is a thin shim that
 * wires production deps (Firestore + real llmRerank + jd-rel chain).
 *
 * REQ-IDs: RERANK-01, RERANK-02, RERANK-03, RERANK-04
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

import { llmRerank, type RerankInput, type RerankOutput } from "./lib/llm-rerank.js"
import {
  computeJdRelativeWeights,
  type JdRelInput,
  type JdRelOutput,
} from "./lib/jd-relative-weights.js"
import { makeLimiter } from "./liveness-sweep.js"

// ---------------------------------------------------------------------------
// Secrets
// ---------------------------------------------------------------------------

// Reuse the same SiliconFlow key already provisioned for the synchronous
// llm-rerank path (iter34 H.2). Phase 58 piggybacks on it for both the rerank
// call AND the Qwen-7B fallback inside computeJdRelativeWeights.
const SILICONFLOW_API_KEY = defineSecret("SILICONFLOW_API_KEY")
// Reuse the existing OpenAI agent key — used as the gpt-5.4-nano fallback
// for JD-rel weight computation when ANTHROPIC_API_KEY isn't provisioned.
const PA_OPENAI_AGENT_API_KEY = defineSecret("PA_OPENAI_AGENT_API_KEY")

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Parallel users processed at any moment. Bounded by Qwen free-tier rate. */
export const USER_CONCURRENCY = 5
/** Parallel JD-rel calls within a single user's top-N. */
export const JDREL_CONCURRENCY = 3
/** How many of the rerank's top-N get JD-rel weights computed. */
export const TOP_N_FOR_JDREL = 10
/** Candidate-pool size we ship to llmRerank. */
export const CANDIDATE_POOL_SIZE = 50
/** Skip user if their rerank cache is fresher than this (idempotent retry). */
export const SKIP_IF_FRESHER_THAN_MS = 23 * 3600 * 1000
/** Phase 56 freshness window — must match V16 reader to avoid reranking jobs
 *  the matcher will never surface. */
export const FRESHNESS_WINDOW_MS = 20 * 24 * 3600 * 1000
/** Firestore array-contains-any cap (matches Phase 56 V16 query). */
export const ROLE_FUNCTION_QUERY_CAP = 10

const PA_USERS_COLLECTION = "pa-users"
const MATCHING_JOBS_COLLECTION = "matching-jobs"
const RERANK_CACHE_COLLECTION = "pa-user-rerank-cache"
const SKILL_JDREL_CACHE_COLLECTION = "pa-user-skill-jdrel-cache"
const AUDIT_COLLECTION = "pa-rerank-runs"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type RerankCounters = {
  totalUsers: number
  processed: number
  skippedFresh: number
  skippedNoCandidates: number
  errored: number
  jdrelComputed: number
  jdrelErrored: number
}

export function emptyCounters(): RerankCounters {
  return {
    totalUsers: 0,
    processed: 0,
    skippedFresh: 0,
    skippedNoCandidates: 0,
    errored: 0,
    jdrelComputed: 0,
    jdrelErrored: 0,
  }
}

/** Minimal job projection consumed by the rerank composer. */
export type RerankJobDoc = {
  id: string
  roleTitle?: string
  companyName?: string
  companyDisplayName?: string
  industrySector?: string[]
  requiredSkills?: string[]
  seniorityLevel?: string
  sponsorship?: boolean
  locationRaw?: string
  salaryRange?: string
  jobDescription?: string
  /** Required for the per-skill JD-rel sub-step. */
  jobTitle?: string
}

/** Minimal user-tags projection used by the batch. */
export type UserTagsLike = {
  targetRoleFunction?: string[]
  skills?: ReadonlyArray<unknown>
  yoeRange?: string | [number, number]
  visaStatus?: string
  cvSummary?: string
  preferredLang?: string
}

/**
 * Storage seam — production wires Firestore, tests inject a fake. Every
 * method is failure-tolerant at the caller level (caller catches throws).
 */
export type RerankStore = {
  /** Iterate over users with non-empty `tags.targetRoleFunction`. */
  fetchActiveUsers: () => Promise<Array<{ id: string; tags: UserTagsLike }>>
  /** Read existing rerank cache (for skip-fresh check). Returns null when missing. */
  getRerankCache: (userId: string) => Promise<{ computedAt: string } | null>
  /** Pull a candidate pool of jobs for one user. */
  fetchCandidateJobs: (
    targetRoleFunction: string[],
    poolSize: number
  ) => Promise<RerankJobDoc[]>
  /** Persist the rerank output. */
  writeRerankCache: (
    userId: string,
    payload: {
      ranked: Array<{ jobId: string; llmScore: number; reasoning: string }>
      computedAt: string
      modelUsed: string
      candidatePoolSize: number
    }
  ) => Promise<void>
  /** Persist one (user, job) JD-rel cache doc. */
  writeJdRelCache: (
    userId: string,
    jobId: string,
    payload: {
      jdRelativeWeights: Record<string, number>
      computedAt: string
      modelUsed: string
    }
  ) => Promise<void>
  /** Best-effort audit write. */
  writeAudit: (counters: RerankCounters, runAt: string, durationMs: number) => Promise<void>
}

export type RerankDeps = {
  store: RerankStore
  /** Inject for tests; production passes the real `llmRerank`. */
  llmRerankImpl: (input: RerankInput) => Promise<RerankOutput>
  /** Inject for tests; production wraps `computeJdRelativeWeights` with secrets. */
  computeJdRelImpl: (skills: ReadonlyArray<string>, job: JdRelInput) => Promise<JdRelOutput>
  /** ms-since-epoch — stubbable for tests. */
  now: () => number
  /** Concurrency knobs (override for tests). */
  userConcurrency?: number
  jdrelConcurrency?: number
  topNForJdrel?: number
  candidatePoolSize?: number
  skipIfFresherThanMs?: number
  log?: (msg: string, ctx?: Record<string, unknown>) => void
  errorLog?: (msg: string, ctx?: Record<string, unknown>) => void
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Coerce `tags.skills[]` (string OR `{name}` shape) to a flat string list. */
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
 * Parse YOE — accepts string (`"3-5"`, `"10+"`) or already-parsed tuple.
 * Returns undefined when shape is unrecognised.
 */
export function parseYoeRange(yoe: UserTagsLike["yoeRange"]): [number, number] | undefined {
  if (Array.isArray(yoe) && yoe.length === 2) {
    const [a, b] = yoe
    if (typeof a === "number" && typeof b === "number" && Number.isFinite(a) && Number.isFinite(b)) {
      return [a, b]
    }
    return undefined
  }
  if (typeof yoe === "string") {
    const m = yoe.match(/^(\d+)-(\d+)$/)
    if (m) {
      const a = parseInt(m[1]!, 10)
      const b = parseInt(m[2]!, 10)
      if (Number.isFinite(a) && Number.isFinite(b)) return [a, b]
    }
    if (yoe === "10+") return [10, 30]
    const single = yoe.match(/^(\d+)\+$/)
    if (single) {
      const a = parseInt(single[1]!, 10)
      if (Number.isFinite(a)) return [a, a + 20]
    }
  }
  return undefined
}

/**
 * Compose the RerankInput packet from tags + projected jobs. Pure,
 * deterministic — testable without any I/O.
 *
 * Truncations match the comments in `RerankInput`:
 *   - cvSummary: 200 chars
 *   - jobDescription: 400 chars
 *   - topSkills: 12 entries
 */
export function composeRerankInput(
  userTags: UserTagsLike,
  jobs: RerankJobDoc[]
): RerankInput {
  const skillNames = extractSkillNames(userTags.skills).slice(0, 12)
  return {
    candidate: {
      targetRole: Array.isArray(userTags.targetRoleFunction) ? userTags.targetRoleFunction : [],
      topSkills: skillNames,
      ...(parseYoeRange(userTags.yoeRange) !== undefined ? { yoeRange: parseYoeRange(userTags.yoeRange)! } : {}),
      ...(typeof userTags.visaStatus === "string" && userTags.visaStatus.length > 0
        ? { visaStatus: userTags.visaStatus }
        : {}),
      ...(typeof userTags.cvSummary === "string" && userTags.cvSummary.length > 0
        ? { cvSummary: userTags.cvSummary.slice(0, 200) }
        : {}),
    },
    jobs: jobs.map((j) => {
      const role = j.roleTitle ?? j.jobTitle ?? ""
      const company = j.companyName ?? j.companyDisplayName ?? ""
      const desc = (j.jobDescription ?? "").slice(0, 400)
      return {
        id: j.id,
        roleTitle: role,
        companyName: company,
        ...(Array.isArray(j.industrySector) && j.industrySector.length > 0
          ? { industryEnum: j.industrySector }
          : {}),
        ...(Array.isArray(j.requiredSkills) && j.requiredSkills.length > 0
          ? { requiredSkills: j.requiredSkills }
          : {}),
        ...(typeof j.seniorityLevel === "string" && j.seniorityLevel.length > 0
          ? { seniorityLevel: j.seniorityLevel }
          : {}),
        ...(typeof j.sponsorship === "boolean" ? { sponsorship: j.sponsorship } : {}),
        ...(typeof j.locationRaw === "string" && j.locationRaw.length > 0
          ? { locationRaw: j.locationRaw }
          : {}),
        ...(typeof j.salaryRange === "string" && j.salaryRange.length > 0
          ? { salaryRange: j.salaryRange }
          : {}),
        ...(desc.length > 0 ? { jobDescription: desc } : {}),
      }
    }),
  }
}

// ---------------------------------------------------------------------------
// Per-user driver
// ---------------------------------------------------------------------------

/**
 * Process one user end-to-end. Pure-ish — mutates counters, calls `deps`
 * for I/O. Never throws — caught failures bump `counters.errored`.
 */
export async function processOneUser(
  userId: string,
  userTags: UserTagsLike,
  counters: RerankCounters,
  deps: RerankDeps
): Promise<void> {
  const log = deps.log ?? (() => {})
  const errorLog = deps.errorLog ?? log
  const skipMs = deps.skipIfFresherThanMs ?? SKIP_IF_FRESHER_THAN_MS
  const poolSize = deps.candidatePoolSize ?? CANDIDATE_POOL_SIZE
  const topN = deps.topNForJdrel ?? TOP_N_FOR_JDREL
  const jdrelLimit = deps.jdrelConcurrency ?? JDREL_CONCURRENCY

  // 1. Skip-fresh: idempotent on retry.
  try {
    const cache = await deps.store.getRerankCache(userId)
    if (cache && typeof cache.computedAt === "string") {
      const t = Date.parse(cache.computedAt)
      if (Number.isFinite(t) && deps.now() - t < skipMs) {
        counters.skippedFresh++
        log("skip_fresh", { userId, ageMs: deps.now() - t })
        return
      }
    }
  } catch (err) {
    errorLog("skip_check_failed", {
      userId,
      error: err instanceof Error ? err.message : String(err),
    })
    // Non-fatal — fall through and try the run anyway.
  }

  // 2. Candidate pool query (minimal — DON'T recurse into V16).
  const targetRoleFunction = Array.isArray(userTags.targetRoleFunction)
    ? userTags.targetRoleFunction.slice(0, ROLE_FUNCTION_QUERY_CAP)
    : []
  if (targetRoleFunction.length === 0) {
    counters.skippedNoCandidates++
    log("skip_no_role_function", { userId })
    return
  }

  let candidates: RerankJobDoc[]
  try {
    candidates = await deps.store.fetchCandidateJobs(targetRoleFunction, poolSize)
  } catch (err) {
    counters.errored++
    errorLog("candidate_fetch_failed", {
      userId,
      error: err instanceof Error ? err.message : String(err),
    })
    return
  }
  if (candidates.length === 0) {
    counters.skippedNoCandidates++
    log("skip_no_candidates", { userId })
    return
  }

  // 3. Run rerank.
  const rerankInput = composeRerankInput(userTags, candidates)
  let rerankOut: RerankOutput
  try {
    rerankOut = await deps.llmRerankImpl(rerankInput)
  } catch (err) {
    counters.errored++
    errorLog("rerank_failed", {
      userId,
      error: err instanceof Error ? err.message : String(err),
    })
    return
  }

  // 4. Write rerank cache (always — even when ranked is empty, so the next
  //    night's skip-fresh check fires correctly).
  const computedAt = new Date(deps.now()).toISOString()
  try {
    await deps.store.writeRerankCache(userId, {
      ranked: rerankOut.ranked.map((r) => ({
        jobId: r.jobId,
        llmScore: r.score,
        reasoning: r.reasoning,
      })),
      computedAt,
      modelUsed: rerankOut.modelUsed,
      candidatePoolSize: rerankInput.jobs.length,
    })
  } catch (err) {
    counters.errored++
    errorLog("rerank_cache_write_failed", {
      userId,
      error: err instanceof Error ? err.message : String(err),
    })
    return
  }

  counters.processed++
  log("user_processed", {
    userId,
    rankedCount: rerankOut.ranked.length,
    poolSize: rerankInput.jobs.length,
    modelUsed: rerankOut.modelUsed,
  })

  // 5. Compute JD-rel weights for the top-N.
  const userSkills = extractSkillNames(userTags.skills)
  if (userSkills.length === 0) return // no skills → no weights to compute

  const top = rerankOut.ranked.slice(0, topN)
  const candidatesById = new Map<string, RerankJobDoc>()
  for (const c of candidates) candidatesById.set(c.id, c)

  const limiter = makeLimiter(jdrelLimit)
  const tasks = top.map((rankedJob) =>
    limiter(async () => {
      const job = candidatesById.get(rankedJob.jobId)
      if (!job) return // hallucinated jobId — sanitize already filtered, defensive
      try {
        const jdInput: JdRelInput = {
          jobTitle: job.roleTitle ?? job.jobTitle ?? "",
          ...(typeof job.jobDescription === "string" ? { jobDescription: job.jobDescription } : {}),
          ...(Array.isArray(job.requiredSkills) ? { requiredSkills: job.requiredSkills } : {}),
        }
        const result = await deps.computeJdRelImpl(userSkills, jdInput)
        await deps.store.writeJdRelCache(userId, rankedJob.jobId, {
          jdRelativeWeights: result.weights,
          computedAt: new Date(deps.now()).toISOString(),
          modelUsed: result.modelUsed,
        })
        counters.jdrelComputed++
      } catch (err) {
        counters.jdrelErrored++
        errorLog("jdrel_failed", {
          userId,
          jobId: rankedJob.jobId,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    })
  )
  await Promise.allSettled(tasks)
}

// ---------------------------------------------------------------------------
// Top-level batch driver
// ---------------------------------------------------------------------------

/**
 * Drive the nightly batch end-to-end. Pure logic; deps wire I/O. Returns
 * the final counters + duration so the wrapper can log a single summary line.
 */
export async function runNightlyRerank(deps: RerankDeps): Promise<{
  counters: RerankCounters
  durationMs: number
}> {
  const log = deps.log ?? (() => {})
  const errorLog = deps.errorLog ?? log

  const startMs = deps.now()
  const counters = emptyCounters()
  const userLimit = deps.userConcurrency ?? USER_CONCURRENCY

  let users: Array<{ id: string; tags: UserTagsLike }>
  try {
    users = await deps.store.fetchActiveUsers()
  } catch (err) {
    errorLog("fetch_users_failed", {
      error: err instanceof Error ? err.message : String(err),
    })
    // Bubble — without users we can't proceed and have nothing to log.
    throw err
  }

  counters.totalUsers = users.length
  log("batch_start", { totalUsers: users.length })

  const limiter = makeLimiter(userLimit)
  const tasks = users.map((u) =>
    limiter(async () => {
      try {
        await processOneUser(u.id, u.tags, counters, deps)
      } catch (err) {
        // processOneUser swallows its own failures; this catch only fires on
        // a programming error. Counter-bump + log so the run never aborts.
        counters.errored++
        errorLog("process_one_user_threw", {
          userId: u.id,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    })
  )
  await Promise.allSettled(tasks)

  const durationMs = deps.now() - startMs

  // Best-effort audit write.
  try {
    await deps.store.writeAudit(counters, new Date(startMs).toISOString(), durationMs)
  } catch (err) {
    errorLog("audit_write_failed", {
      error: err instanceof Error ? err.message : String(err),
    })
  }

  log("batch_complete", { ...counters, durationMs })

  return { counters, durationMs }
}

// ---------------------------------------------------------------------------
// Production Firestore-backed store
// ---------------------------------------------------------------------------

/** Coerce a raw Firestore doc data into a `RerankJobDoc` projection. */
function projectJobDoc(id: string, data: DocumentData): RerankJobDoc {
  const out: RerankJobDoc = { id }
  if (typeof data.roleTitle === "string") out.roleTitle = data.roleTitle
  else if (typeof data.jobTitle === "string") out.jobTitle = data.jobTitle
  if (typeof data.companyName === "string") out.companyName = data.companyName
  else if (typeof data.companyDisplayName === "string")
    out.companyDisplayName = data.companyDisplayName
  if (Array.isArray(data.industrySector)) {
    out.industrySector = data.industrySector.filter((s): s is string => typeof s === "string")
  }
  if (Array.isArray(data.requiredSkills)) {
    out.requiredSkills = data.requiredSkills.filter((s): s is string => typeof s === "string")
  }
  if (typeof data.seniorityLevel === "string") out.seniorityLevel = data.seniorityLevel
  if (typeof data.sponsorship === "boolean") out.sponsorship = data.sponsorship
  if (typeof data.locationRaw === "string") out.locationRaw = data.locationRaw
  if (typeof data.salaryRange === "string") out.salaryRange = data.salaryRange
  if (typeof data.jobDescription === "string") out.jobDescription = data.jobDescription
  return out
}

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

/**
 * Build the production Firestore-backed store. Reads + writes match the
 * Phase 56 V16 reader contract so the rerank cache lands where the matcher
 * expects it.
 */
export function makeFirestoreStore(db: Firestore = getFirestore()): RerankStore {
  return {
    fetchActiveUsers: async () => {
      const snap = await db.collection(PA_USERS_COLLECTION).get()
      const out: Array<{ id: string; tags: UserTagsLike }> = []
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
    getRerankCache: async (userId: string) => {
      try {
        const doc = await db.collection(RERANK_CACHE_COLLECTION).doc(userId).get()
        if (!doc.exists) return null
        const data = doc.data()
        const computedAt = data?.computedAt
        if (typeof computedAt === "string") return { computedAt }
        // Firestore Timestamp shape — convert to ISO for the caller's parse.
        const ms = timestampToMsLocal(computedAt)
        if (ms > 0) return { computedAt: new Date(ms).toISOString() }
        return null
      } catch {
        return null
      }
    },
    fetchCandidateJobs: async (targetRoleFunction: string[], poolSize: number) => {
      const nowMs = Date.now()
      const cutoffMs = nowMs - FRESHNESS_WINDOW_MS
      // Mirror the V16 reader query: status==active, role array-contains-any,
      // ordered by firstSeenAt desc, capped to `poolSize`. We then drop dead
      // rows + missing/jobright atsApplyUrl + freshness violations in-memory.
      const roles = targetRoleFunction.slice(0, ROLE_FUNCTION_QUERY_CAP)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let q: any = db
        .collection(MATCHING_JOBS_COLLECTION)
        .where("status", "==", "active")
        .where("roleFunction", "array-contains-any", roles)
        .orderBy("firstSeenAt", "desc")
        .limit(poolSize)
      let snap
      try {
        snap = await q.get()
      } catch {
        // Composite-index miss → fallback to status-only scan.
        q = db.collection(MATCHING_JOBS_COLLECTION).where("status", "==", "active").limit(poolSize)
        snap = await q.get()
      }
      const out: RerankJobDoc[] = []
      for (const doc of snap.docs as Array<QueryDocumentSnapshot>) {
        const data = doc.data() as DocumentData
        if (data.dead === true) continue
        const url = typeof data.atsApplyUrl === "string" ? data.atsApplyUrl : ""
        if (!url || /jobright\.ai/i.test(url)) continue
        const fsMs = timestampToMsLocal(data.firstSeenAt)
        if (fsMs > 0 && fsMs < cutoffMs) continue
        out.push(projectJobDoc(doc.id, data))
      }
      return out
    },
    writeRerankCache: async (userId, payload) => {
      await db.collection(RERANK_CACHE_COLLECTION).doc(userId).set(payload, { merge: true })
    },
    writeJdRelCache: async (userId, jobId, payload) => {
      await db
        .collection(SKILL_JDREL_CACHE_COLLECTION)
        .doc(userId)
        .collection("jobs")
        .doc(jobId)
        .set(payload, { merge: true })
    },
    writeAudit: async (counters, runAt, durationMs) => {
      await db.collection(AUDIT_COLLECTION).add({
        runAt,
        durationMs,
        counters,
      })
    },
  }
}

// ---------------------------------------------------------------------------
// Cloud Function — daily at 04:00 UTC.
// ---------------------------------------------------------------------------

export const paLlmRerankNightly = onSchedule(
  {
    schedule: "0 4 * * *",
    timeZone: "UTC",
    memory: "1GiB",
    timeoutSeconds: 540,
    region: "us-central1",
    secrets: [SILICONFLOW_API_KEY, PA_OPENAI_AGENT_API_KEY],
    retryCount: 0,
  },
  async () => {
    // Bind SiliconFlow key into both `OPENAI_API_KEY` (for Qwen-7B fallback in
    // computeJdRelativeWeights' OpenAI-tier client when running against
    // SiliconFlow's compatible endpoint) AND `SILICONFLOW_API_KEY` (read by
    // llm-rerank.ts directly via process.env). Mirrors the existing pattern
    // in apps/functions/src/index.ts (lines 607, 1099, 1174).
    const siliconflowKey = (SILICONFLOW_API_KEY.value() ?? "").trim()
    if (!siliconflowKey) {
      logger.warn("[nightly-rerank] SILICONFLOW_API_KEY missing — rerank will no-op")
    } else {
      process.env.SILICONFLOW_API_KEY = siliconflowKey
    }
    const openaiKey = (PA_OPENAI_AGENT_API_KEY.value() ?? "").trim()
    // ANTHROPIC_API_KEY is NOT defined as a Firebase secret in this project
    // (see CLAUDE.md / Phase 58 deploy notes). At runtime it may still be
    // populated via gcloud functions deploy --update-env-vars; we pick it up
    // from process.env if present, otherwise the JD-rel chain falls back to
    // the OpenAI tier (gpt-5.4-nano) and ultimately Qwen-7B.
    const anthropicKey = (process.env.ANTHROPIC_API_KEY ?? "").trim()

    const db = getFirestore()
    const store = makeFirestoreStore(db)

    const result = await runNightlyRerank({
      store,
      llmRerankImpl: (input) =>
        llmRerank(input, {
          costLabels: { caller: "nightly-rerank" },
        }),
      computeJdRelImpl: (skills, job) =>
        computeJdRelativeWeights(skills, job, {
          ...(anthropicKey ? { anthropicApiKey: anthropicKey } : {}),
          ...(openaiKey ? { openaiApiKey: openaiKey } : {}),
          ...(siliconflowKey ? { siliconflowApiKey: siliconflowKey } : {}),
        }),
      now: () => Date.now(),
      log: (msg, ctx) => logger.info(`[nightly-rerank] ${msg}`, ctx ?? {}),
      errorLog: (msg, ctx) => logger.error(`[nightly-rerank] ${msg}`, ctx ?? {}),
    })

    logger.info("[nightly-rerank] done", {
      ...result.counters,
      durationMs: result.durationMs,
    })
  }
)
