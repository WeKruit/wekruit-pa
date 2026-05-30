/**
 * tools/matching-tools.ts — WS-tools owns this file.
 *
 * Each tool's `execute` = a deterministic reducer wrapping an EXISTING backend
 * module (no rebuild). Mirrors poc-v1/poc-v3 B tools:
 *   set_matching_preferences → reduceMatchingPreferences (poc-v1, the KEYSTONE
 *                              reducer) + applyPartialUserTags (the sole writer
 *                              to pa-users.tags). RC1 fix.
 *   find_match               → ctx.findMatch (queryMatchingJobsV16); reads
 *                              post-reducer tags; NEVER hangs/throws. RC2 fix.
 *   remember_fact            → mem0Add (@pa/memory), crisis-scrubbed, fail-open
 *   schedule_interview       → pa-interview-bookings dedup store (same store +
 *                              bookingId scheme as SCHEDULE_INTERVIEW_CONNECTOR)
 *   privacy (export/delete/stop) → runCandidatePrivacyRequest (PII-website-lock:
 *                              NO chat tool writes email/phone/legal-name)
 *   save_job_profile / set_daily_subscription / match_collab / cv_parse →
 *                              wrap existing backends (job profile store,
 *                              parseResumeText). See per-tool notes.
 *
 * KEYSTONE (README §10): the LLM only PROPOSES the typed tool args; each
 * `execute` is a deterministic REDUCER that commits state. set_matching_
 * preferences calls `reduceMatchingPreferences` (reducers/matching-profile-
 * reducer.ts) — it does NOT re-derive the only/avoid/replace semantics.
 */
import { tool, z } from "../sdk.js"
import {
  ROLE_FUNCTION_VOCAB,
  JOB_TYPE_VOCAB,
  INDUSTRY_SECTOR_VOCAB,
  CAREER_STAGE_VOCAB,
  COMPANY_SIZE_VOCAB,
  FEEDBACK_SENTIMENT_VOCAB,
  FEEDBACK_REASON_CATEGORY_VOCAB,
} from "@wekruit/shared-tags"

// Rebuild the closed enums on the SDK's zod@4 instance. shared-tags' RoleFunctionSchema /
// JobTypeSchema are built with zod@3 (a different instance) and cannot be mixed into a zod@4
// tool param schema — but the underlying VOCAB arrays are plain strings, instance-agnostic.
const RoleFunctionEnum = z.enum(ROLE_FUNCTION_VOCAB)
const JobTypeEnum = z.enum(JOB_TYPE_VOCAB)
const IndustrySectorEnum = z.enum(INDUSTRY_SECTOR_VOCAB)
const CareerStageEnum = z.enum(CAREER_STAGE_VOCAB)
const CompanySizeEnum = z.enum(COMPANY_SIZE_VOCAB)
const FeedbackSentimentEnum = z.enum(FEEDBACK_SENTIMENT_VOCAB)
const FeedbackReasonCategoryEnum = z.enum(FEEDBACK_REASON_CATEGORY_VOCAB)
import {
  applyPartialUserTags,
  validateOnboardingCanonicalTags,
  type OnboardingCanonicalTagInput,
  type PartialUserTags,
} from "@pa/pa-orchestrator"
import { writeFeedbackEvent } from "@pa/pa-persistence"
import { mem0Add, type Mem0Config } from "@pa/memory"
import { parseResumeText } from "@pa/pa-resume-parser"
import { queryMatchingJobsV16, recordRecommendedJobs } from "@pa/job-rec"
import type { FeedbackEvent } from "@pa/core-types"
import type { Firestore } from "firebase-admin/firestore"
// Rec-card render→host→send side-channel (flag-gated, fail-open). maybeSendRecCard
// internally no-ops when PA_JOB_REC_CARD_ENABLED is off and NEVER throws.
import { maybeSendRecCard } from "../../job-rec-card/send-rec-card.js"
import type { CardStorage } from "../../job-rec-card/upload-card.js"
import {
  reduceMatchingPreferences,
  type MatchingTagsSlice,
} from "../reducers/matching-profile-reducer.js"
import type { ClaireToolContext, FindMatchResult } from "../types.js"
import { runCandidatePrivacyRequest } from "../../production-hardening.js"

const PA_USERS_COLLECTION = "pa-users"
const JOB_PROFILES_COLLECTION = "pa-job-profiles"
const INTERVIEW_BOOKINGS_COLLECTION = "pa-interview-bookings"

/**
 * Read the matching slice of `pa-users/{userId}.tags`. Fail-soft: a missing
 * doc / read error degrades to an empty slice (the reducer treats this as a
 * fresh baseline). This is a READ — the only WRITE path is `applyPartialUserTags`.
 */
async function readMatchingSlice(
  db: Firestore,
  userId: string,
  log: ClaireToolContext["log"],
): Promise<MatchingTagsSlice> {
  try {
    const snap = await db.collection(PA_USERS_COLLECTION).doc(userId).get()
    const tags =
      snap.exists && snap.data()?.tags && typeof snap.data()!.tags === "object"
        ? (snap.data()!.tags as Record<string, unknown>)
        : {}
    const asArr = (v: unknown): string[] | undefined =>
      Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : undefined
    return {
      targetRoleFunction: asArr(tags.targetRoleFunction),
      negativeRoleFunction: asArr(tags.negativeRoleFunction),
      targetJobType: asArr(tags.targetJobType),
      targetLocations: asArr(tags.targetLocations),
    }
  } catch (err) {
    log("pa.claire.read_tags_error", {
      userId,
      error: err instanceof Error ? err.message : String(err),
    })
    return {}
  }
}

/** Read the post-reducer tags snapshot returned alongside find_match. */
async function readSnapshotTags(
  db: Firestore,
  userId: string,
  log: ClaireToolContext["log"],
): Promise<Record<string, unknown>> {
  const slice = await readMatchingSlice(db, userId, log)
  const snap: Record<string, unknown> = {}
  if (slice.targetRoleFunction) snap.targetRoleFunction = slice.targetRoleFunction
  if (slice.negativeRoleFunction) snap.negativeRoleFunction = slice.negativeRoleFunction
  if (slice.targetJobType) snap.targetJobType = slice.targetJobType
  if (slice.targetLocations) snap.targetLocations = slice.targetLocations
  return snap
}

/** Resolve mem0 config from env; null when not configured (tool no-ops fail-open). */
function resolveMem0Config(): Mem0Config | null {
  const apiKey = (process.env.PA_MEM0_API_KEY ?? process.env.MEM0_API_KEY ?? "").trim()
  const qdrantUrl = (process.env.PA_QDRANT_URL ?? process.env.QDRANT_URL ?? "").trim()
  const qdrantApiKey = (process.env.PA_QDRANT_API_KEY ?? process.env.QDRANT_API_KEY ?? "").trim()
  if (!apiKey || !qdrantUrl || !qdrantApiKey) return null
  return {
    apiKey,
    qdrantUrl,
    qdrantApiKey,
    baseUrl: process.env.PA_MEM0_BASE_URL || undefined,
    qdrantCollection: process.env.PA_QDRANT_COLLECTION || undefined,
  }
}

/**
 * Rec tracking (req #4, 2026-05-29) — after the agent's find_match surfaces
 * jobs, persist them to the per-(user,job) ledger AND emit one `job_presented`
 * FeedbackEvent each, so (a) the matcher's `previousRecommendationPenalty`
 * de-prioritises them next time (automatic dedup — no re-offering the same
 * role) and (b) the flywheel learns "a job was offered via the claire_agent".
 *
 * FAIL-OPEN: the find_match TOOL must NEVER throw (RC2). Every flywheel write
 * here is best-effort and swallowed; a Firestore hiccup must not break the
 * candidate's turn. Returns void.
 *
 * Exported for unit test (src/__tests__/claire-find-match-ledger.test.ts):
 * locks "writes ledger + job_presented event, and stays fail-open when the
 * writes throw".
 */
export async function recordAgentPresentation(
  db: Firestore,
  args: {
    userId: string
    jobs: Array<{ id?: unknown }>
    fallbackApplied?: boolean
    log: ClaireToolContext["log"]
    nowIso: string
  },
): Promise<void> {
  const jobIds = [
    ...new Set(
      args.jobs
        .map((j) => (typeof j.id === "string" ? j.id.trim() : ""))
        .filter((id) => id.length > 0),
    ),
  ]
  if (jobIds.length === 0) return
  // req #5 — when V16 relaxed all hard filters to a general scraped-market
  // result, tag the ledger row accordingly; otherwise it's the agent-driven
  // curated/collab+market mix.
  const reason = args.fallbackApplied === true ? "general_market_fallback" : "claire_agent"
  // (1) Ledger — drives `previousRecommendationPenalty` dedup on the next pull.
  try {
    await recordRecommendedJobs(
      db,
      { userId: args.userId, jobs: jobIds.map((id) => ({ id })), source: "claire_agent", reason, nowIso: args.nowIso },
      args.log,
    )
  } catch (err) {
    args.log("pa.claire.find_match_ledger_error", {
      userId: args.userId,
      error: err instanceof Error ? err.message : String(err),
    })
  }
  // (2) Flywheel — one append-only `job_presented` event per offered job. The
  // canonical actor for the Claire agent runtime is `orchestrator` (we do NOT
  // add a parallel `agent` enum member — D8/Rule 8); the surfacing flow lives
  // in `outcome` ("claire_agent"). Deterministic eventId keeps it idempotent.
  await Promise.all(
    jobIds.map(async (jobId) => {
      const event: FeedbackEvent = {
        eventId: `job-presented-${args.userId}-${jobId}-${args.nowIso}`,
        kind: "job_presented",
        actor: "orchestrator",
        candidateId: args.userId,
        jobId,
        outcome: "claire_agent",
        evidence: [{ source: "job_match", summary: `job offered to candidate via claire_agent` }],
        payloadRedacted: { flow: "claire_agent", channel: "imessage" },
        createdAt: args.nowIso,
      }
      try {
        await writeFeedbackEvent(db, event)
      } catch (err) {
        args.log("pa.claire.find_match_feedback_error", {
          userId: args.userId,
          jobId,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }),
  )
}

/**
 * Production wiring for ctx.findMatch — wraps `queryMatchingJobsV16` (@pa/job-rec).
 * Wave B injects this in prod; evals pass a fake catalog instead. Formats each
 * ranked job as "Title @ Company\n<atsApplyUrl>" (the find-match line shape the
 * LLM relays to the user). NEVER throws — returns a grounded ok:false on error.
 */
/**
 * Optional injected deps for the rec-card render→host→send side-channel. Passed
 * by cutover.ts ONLY when PA_JOB_REC_CARD_ENABLED is on and we are NOT in dryRun.
 * Absent → makeV16FindMatch behaves exactly as before (text-only recs).
 */
export type V16FindMatchCardDeps = {
  storage: CardStorage
  getPhoneE164: (db: Firestore, userId: string) => Promise<string | null>
  fromNumber?: string
  log?: (event: string, payload?: Record<string, unknown>) => void
}

export function makeV16FindMatch(
  db: Firestore,
  opts?: { log?: ClaireToolContext["log"]; nowIso?: () => string },
  cardDeps?: V16FindMatchCardDeps,
): ClaireToolContext["findMatch"] {
  const log: ClaireToolContext["log"] = opts?.log ?? (() => {})
  const nowIso = opts?.nowIso ?? (() => new Date().toISOString())
  return async ({
    userId,
    requestedCount,
  }: {
    userId: string
    requestedCount?: number | null
  }): Promise<FindMatchResult> => {
    try {
      const limit =
        typeof requestedCount === "number" && requestedCount > 0
          ? Math.min(5, Math.floor(requestedCount))
          : 3

      // COLLAB-ALWAYS-FIRST (Adam 2026-05-30): WeKruit collab/partner roles are the priority inventory —
      // they must ALWAYS surface first when they match, on EVERY find_match, not just the candidate's
      // first batch. So we ALWAYS run the collab pass (collabPrescreenOnly) up front, regardless of
      // `firstMatchBatchAt`. Whatever collab roles it returns go FIRST, then we FILL the remaining slots
      // up to `limit` with the open-market pass (deduped against the collab ids). If the collab pass
      // returns 0 → pure open-market, exactly as before. `firstMatchBatchAt` survives ONLY as telemetry
      // (set after a delivered batch, for the log) — it no longer gates whether the collab pass runs.
      let firstBatchDone = false
      try {
        firstBatchDone = !!(await db.collection("pa-users").doc(userId).get()).data()?.firstMatchBatchAt
      } catch {
        /* read failure → still run both passes; this flag is telemetry-only now, never a gate */
        firstBatchDone = true
      }

      // Pass 1 — collab roles (curated, actually-matched WeKruit partner inventory). Fail-open: a
      // collab-pass error must never block the open-market fill, so degrade to an empty collab set.
      let collabResult: Awaited<ReturnType<typeof queryMatchingJobsV16>> | undefined
      try {
        collabResult = await queryMatchingJobsV16({ userId, limit, collabPrescreenOnly: true }, { db })
      } catch (e) {
        log("pa.claire.find_match.collab_pass_failed", { userId, err: String(e) })
      }
      const collabJobs = collabResult?.jobs ?? []
      const collabHit = collabJobs.length > 0
      const collabIds = new Set(collabJobs.map((j) => j.id))

      // Pass 2 — open-market fill for the slots collab did not fill. allowBroadFallback: a candidate
      // whose specific city genuinely has 0 fresh roles still gets US matches (location-relax ladder)
      // instead of a dead "no roles" — never a silent dead end. Skip the pass entirely when collab
      // already filled `limit`. The open-market `result` is also the source of the snapshotTags /
      // needsOnboarding / total signals when there are no collab jobs (pure open-market path).
      const remaining = Math.max(0, limit - collabJobs.length)
      let result = collabResult
      let openJobs: typeof collabJobs = []
      if (remaining > 0 || !collabHit) {
        result = await queryMatchingJobsV16({ userId, limit, allowBroadFallback: true }, { db })
        // Dedup the open-market set against collab ids so a collab role never repeats as open-market,
        // then take only enough to fill the remaining slots after collab.
        openJobs = (result.jobs ?? []).filter((j) => !collabIds.has(j.id)).slice(0, remaining)
      }
      // When BOTH passes ran, prefer the open-market `result` for the snapshotTags/needsOnboarding
      // metadata (it reflects the full catalog, not the collab-only funnel); fall back to collab.
      // `result` is guaranteed defined here: with limit>0 either `remaining>0` or `!collabHit` runs the
      // open-market pass, or `collabHit` is true and `result === collabResult` (defined). Assert it so
      // the metadata reads below stay non-optional without re-querying.
      if (!result) result = collabResult
      const meta = result!
      log("pa.claire.find_match.routing", {
        userId,
        firstBatchDone,
        collabHit,
        collabCount: collabJobs.length,
        openCount: openJobs.length,
      })

      // Final merged set: collab roles FIRST, then open-market fill. recordAgentPresentation, the
      // rec-card fire (TOP job → reliably the top collab role when present), and the formatted lines
      // all operate over THIS array, so every downstream consumer sees the same ordered, deduped set.
      const rawJobs = [...collabJobs, ...openJobs]
      // Rec tracking (req #4/#5) — write the ledger + job_presented events for
      // the offered jobs. Fail-open: never breaks the never-throws contract.
      if (rawJobs.length > 0) {
        await recordAgentPresentation(db, {
          userId,
          jobs: rawJobs,
          fallbackApplied: meta.fallbackApplied,
          log,
          nowIso: nowIso(),
        })
        // Mark the first batch delivered so subsequent pulls mix open-market.
        if (!firstBatchDone) {
          await db
            .collection("pa-users")
            .doc(userId)
            .set({ firstMatchBatchAt: nowIso() }, { merge: true })
            .catch((e) => log("pa.claire.find_match.first_batch_mark_failed", { err: String(e) }))
        }
      }

      // Rec-card render→host→send side-channel (flag-gated, fail-open). Sends the
      // TOP ranked job — which, on a first batch, is a curated WeKruit collab role
      // — as a designed iMessage image attachment alongside Claire's text reply.
      // maybeSendRecCard internally no-ops when PA_JOB_REC_CARD_ENABLED is off and
      // NEVER throws — so a render/upload/enqueue hiccup can never break the
      // find_match return contract (RC2): the text rec already covers the user.
      if (cardDeps && rawJobs.length > 0) {
        // `rawJobs` elements are the V16 `MatchingJob & { reason, ... }` projection;
        // every field read below exists on that shape. CardJobSource fields are all
        // optional, so any null/absent value just omits its card section.
        const top = rawJobs[0]!
        try {
          await maybeSendRecCard({
            userId,
            jobId: top.id,
            job: {
              companyName: top.companyName,
              jobTitle: top.jobTitle,
              roleTitle: top.roleTitle,
              seniorityLevel: top.seniorityLevel,
              salaryMin: top.salaryMin,
              salaryMax: top.salaryMax,
              locationRaw: top.locationRaw,
              jobType: top.jobType,
              atsApplyUrl: top.atsApplyUrl,
              primaryUrl: top.primaryUrl,
              reason: top.reason,
            },
            deps: {
              db,
              storage: cardDeps.storage,
              getPhoneE164: cardDeps.getPhoneE164,
              ...(cardDeps.fromNumber ? { fromNumber: cardDeps.fromNumber } : {}),
              log: cardDeps.log ?? log,
            },
          })
        } catch {
          /* fail-open — the text rec already covers the user */
        }
      }

      // COLLAB MARKER (Adam 2026-05-30): the merged set is now MIXED (collab roles first, then
      // open-market fill), so the marker is per-job — tag ONLY the lines that came from the collab
      // pass (by id) so the agent fires the collab pitch (prescreen now → direct to the hiring
      // manager) on exactly those roles. The prompt keys off this exact "[WeKruit partner role]"
      // marker; open-market lines carry no marker (no fast-track promise). `collabBatch` is now true
      // whenever the collab pass produced surfaced jobs — no longer gated on the first batch.
      const collabBatch = collabHit
      const jobs = rawJobs.map((j) => {
        const title = (j.jobTitle || j.roleTitle || "Role").trim()
        const company = (j.companyName || "Company").trim()
        const url = (j.atsApplyUrl ?? "").trim()
        const head = collabIds.has(j.id)
          ? `${title} @ ${company} [WeKruit partner role]`
          : `${title} @ ${company}`
        return url ? `${head}\n${url}` : head
      })
      // `total` reflects the size of the offered set when collab contributed (the collab funnel `total`
      // counts only collab jobs, which would understate a mixed batch); otherwise use the open-market
      // catalog total so a zero-result batch still reports a meaningful count for the clarifier.
      const total = collabBatch
        ? rawJobs.length
        : typeof meta.total === "number"
          ? meta.total
          : jobs.length
      const reason =
        jobs.length === 0
          ? meta.needsOnboarding
            ? "needs onboarding — missing core preferences"
            : meta.noUserTags
              ? "no saved preferences yet"
              : "no fresh roles fit those constraints"
          : null
      return {
        ok: true,
        recCount: total,
        jobs,
        reason,
        snapshotTags: {
          targetRoleFunction: meta.userTags?.targetRoleFunction,
          negativeRoleFunction: meta.userTags?.negativeRoleFunction,
          ...(meta.missingAxes ? { missingAxes: meta.missingAxes } : {}),
        },
      }
    } catch (err) {
      // RC2: find_match must ALWAYS return — degrade, never throw.
      return {
        ok: false,
        recCount: 0,
        jobs: [],
        reason: `matcher error: ${err instanceof Error ? err.message : String(err)}`,
      }
    }
  }
}

export function buildMatchingTools(ctx: ClaireToolContext) {
  // ── 1. set_matching_preferences — THE RC1 FIX ────────────────────────────
  // The LLM PROPOSES typed intent; `reduceMatchingPreferences` (the keystone
  // reducer) DECIDES the resulting canonical slice; `applyPartialUserTags`
  // (sole writer) commits it. The reducer emits the FULL final positive set in
  // `changed.targetRoleFunction`, and the writer SHALLOW-REPLACES per key — so
  // an avoided role (e.g. software_engineering) is GONE after the write, not
  // unioned back in. That is the RC1 bug fix.
  const setMatchingPreferences = tool({
    name: "set_matching_preferences",
    description:
      "Persist the candidate's durable role/job-type/location preferences BEFORE matching. " +
      "Map free text to the closed role vocab: 'PM'/'product strategy'/'product'→product_management, " +
      "'SWE'/'software engineering'/'engineering'→software_engineering. " +
      "If they say they want ONLY / want to SWITCH TO a kind of role → put it in onlyRoleFunctions (a REPLACE of the whole positive set). " +
      "If they say they are DONE WITH / want to AVOID / are NOT INTERESTED IN a kind of role → put that role in avoidRoleFunctions " +
      "(e.g. 'done with software engineering, only product' → onlyRoleFunctions:[product_management] AND avoidRoleFunctions:[software_engineering]). " +
      "Also pass jobType (full_time/internship/...) and locations when stated. Pass null for anything not stated.",
    parameters: z.object({
      onlyRoleFunctions: z.array(RoleFunctionEnum).nullable(),
      avoidRoleFunctions: z.array(RoleFunctionEnum).nullable(),
      jobType: z.array(JobTypeEnum).nullable(),
      locations: z.array(z.string()).nullable(),
    }),
    async execute({ onlyRoleFunctions, avoidRoleFunctions, jobType, locations }) {
      const current = await readMatchingSlice(ctx.db, ctx.userId, ctx.log)
      const { changed, removedFromPositive } = reduceMatchingPreferences(current, {
        onlyRoleFunctions,
        avoidRoleFunctions,
        jobType,
        locations,
      })
      if (Object.keys(changed).length === 0) {
        return { ok: true, changed: {}, summary: "Nothing new to save." }
      }
      // Sole writer. Shallow-replaces each key in `changed`, so the full
      // positive set REPLACES the prior one (SWE removed) — RC1 proof.
      // The reducer widens role/job-type values to `string[]`; the tool's zod
      // enum params guarantee they are canonical, so the cast to the narrowed
      // `PartialUserTags` shape is sound.
      const write = await applyPartialUserTags(ctx.db, ctx.userId, changed as PartialUserTags, {
        source: "chat",
        nowIso: ctx.nowIso(),
        log: ctx.log,
      })
      const positive = changed.targetRoleFunction ?? current.targetRoleFunction ?? []
      const negative = changed.negativeRoleFunction ?? current.negativeRoleFunction ?? []
      const summary =
        `Saved. Now matching ${positive.join(", ") || "—"}` +
        (negative.length ? `, avoiding ${negative.join(", ")}` : "") +
        (removedFromPositive.length ? ` (dropped ${removedFromPositive.join(", ")})` : "")
      ctx.log("pa.claire.set_matching_preferences", {
        userId: ctx.userId,
        changedKeys: Object.keys(changed),
        removedFromPositive,
        writeOk: write.ok,
      })
      return { ok: write.ok, changed, summary }
    },
  })

  // ── 2. find_match — RC2: must ALWAYS return, never hang/throw ─────────────
  const findMatch = tool({
    name: "find_match",
    description:
      "Find ranked job matches for the candidate from the WeKruit catalog. Use when they ask for roles / " +
      "recommendations / 'what fits me'. Reads their SAVED preferences (call set_matching_preferences first " +
      "if they just stated new ones). Returns concrete roles or a grounded reason none fit — never an excuse.",
    parameters: z.object({
      requestedCount: z.number().int().min(1).max(5).nullable(),
    }),
    async execute({ requestedCount }) {
      const snapshotTags = await readSnapshotTags(ctx.db, ctx.userId, ctx.log)
      if (!ctx.findMatch) {
        return {
          ok: false,
          recCount: 0,
          jobs: [] as string[],
          reason: "matcher unavailable",
          snapshotTags,
        }
      }
      try {
        const res = await ctx.findMatch({ userId: ctx.userId, requestedCount })
        ctx.log("pa.claire.find_match", {
          userId: ctx.userId,
          ok: res.ok,
          recCount: res.recCount,
        })
        return {
          ok: res.ok,
          recCount: res.recCount,
          jobs: res.jobs,
          reason: res.reason,
          // prefer the matcher's own snapshot; fall back to the local read.
          snapshotTags: res.snapshotTags ?? snapshotTags,
        }
      } catch (err) {
        // RC2 guard — the find-match TOOL never throws to the agent loop.
        return {
          ok: false,
          recCount: 0,
          jobs: [] as string[],
          reason: `matcher error: ${err instanceof Error ? err.message : String(err)}`,
          snapshotTags,
        }
      }
    },
  })

  // ── 3. remember_fact — mem0 enrich-only; crisis-scrubbed; fail-open ───────
  const rememberFact = tool({
    name: "remember_fact",
    description:
      "Store a durable, non-sensitive fact about the candidate for long-term memory " +
      "(e.g. 'burned out at last job', 'wants to relocate to NYC in 2026'). " +
      "Do NOT use this for email/phone/legal name — those are edited on the website.",
    parameters: z.object({ fact: z.string() }),
    async execute({ fact }) {
      const trimmed = (fact ?? "").trim()
      if (!trimmed) return { ok: true, stored: false, reason: "empty_fact" }
      const config = resolveMem0Config()
      if (!config) {
        // Fail-open: memory is enrich-only and never gates the conversation.
        ctx.log("pa.claire.remember_fact_noop", { userId: ctx.userId, reason: "mem0_not_configured" })
        return { ok: true, stored: false, reason: "memory_not_configured" }
      }
      try {
        // mem0Add scrubs crisis content internally (scrubCrisisFromMessages).
        await mem0Add(config, [{ role: "user", content: trimmed }], ctx.userId, {
          metadata: { source: "claire_chat", sessionId: ctx.sessionId },
        })
        ctx.log("pa.claire.remember_fact", { userId: ctx.userId, stored: true })
        return { ok: true, stored: true }
      } catch (err) {
        ctx.log("pa.claire.remember_fact_error", {
          userId: ctx.userId,
          error: err instanceof Error ? err.message : String(err),
        })
        return { ok: true, stored: false, reason: "memory_write_failed" }
      }
    },
  })

  // ── 4. schedule_interview — dedup REDUCER over pa-interview-bookings ──────
  // Reuses the SAME store + deterministic bookingId scheme as the existing
  // SCHEDULE_INTERVIEW_CONNECTOR (pa-connectors/schedule-connector.ts): one
  // booking per (user × job). Atomic dedup via a Firestore transaction so two
  // concurrent same-turn calls can't double-book.
  const scheduleInterview = tool({
    name: "schedule_interview",
    description:
      "Book the candidate's interview / pre-screen time slot. DEDUP: if they already have a booking " +
      "for this opportunity, do NOT rebook. Use when they want to schedule / book / set up an interview " +
      "or offer their availability (e.g. 'book me in', 'when can I interview?', '帮我约个面试时间').",
    parameters: z.object({ slotIso: z.string() }),
    async execute({ slotIso }) {
      const jobId = (ctx.jobId ?? "").trim() || "unknown_job"
      const bookingId = `booking-${ctx.userId}__${jobId}`
      const ref = ctx.db.collection(INTERVIEW_BOOKINGS_COLLECTION).doc(bookingId)
      try {
        const committed = await ctx.db.runTransaction(async (tx) => {
          const snap = await tx.get(ref)
          if (snap.exists) return false
          tx.set(ref, {
            bookingId,
            userId: ctx.userId,
            jobId,
            slotIso: (slotIso ?? "").trim() || null,
            status: "requested",
            sessionId: ctx.sessionId,
            createdAt: ctx.nowIso(),
          })
          return true
        })
        ctx.log("pa.claire.schedule_interview", {
          userId: ctx.userId,
          jobId,
          action: committed ? "committed" : "deduped",
        })
        return committed
          ? { ok: true, action: "committed", bookingId }
          : { ok: true, action: "deduped", bookingId }
      } catch (err) {
        return {
          ok: false,
          action: "error",
          reason: err instanceof Error ? err.message : String(err),
        }
      }
    },
  })

  // ── 5. privacy — export/delete/stop via runCandidatePrivacyRequest ───────
  // PII-website-lock: there is intentionally NO tool that writes email / phone /
  // legal name from chat. If a candidate wants to change those, the LLM should
  // tell them to edit on the website (a prompt behavior, not a write tool).
  const privacy = tool({
    name: "privacy",
    description:
      "Handle a privacy request the candidate makes in chat: export their data, delete their profile, " +
      "or stop all outreach. Use ONLY for these three intents. " +
      "NOTE: to CHANGE email / phone / legal name, the candidate must edit them on the website — there is no chat tool for that.",
    parameters: z.object({
      kind: z.enum(["export", "delete", "stop"]),
      detailText: z.string().nullable(),
    }),
    async execute({ kind, detailText }) {
      // Map the chat-facing 'stop' to the canonical 'stop_outreach' kind.
      const canonicalKind = kind === "stop" ? "stop_outreach" : kind
      try {
        const result = await runCandidatePrivacyRequest(
          {
            kind: canonicalKind,
            ...(detailText ? { detailText } : {}),
            sourceSurface: "me_profile" as const,
          },
          { uid: ctx.userId },
          { db: ctx.db, now: ctx.nowIso },
        )
        ctx.log("pa.claire.privacy", { userId: ctx.userId, kind: canonicalKind, status: result.status })
        return { ok: true, kind: result.kind, status: result.status, requestId: result.requestId }
      } catch (err) {
        // Fail-open: a privacy request that can't be filed (e.g. no linked
        // profile) must not crash the turn — surface a grounded ok:false so the
        // LLM can direct the candidate to the website /me/privacy surface.
        ctx.log("pa.claire.privacy_error", {
          userId: ctx.userId,
          kind: canonicalKind,
          error: err instanceof Error ? err.message : String(err),
        })
        return {
          ok: false,
          kind: canonicalKind,
          reason: "could not file the request here — direct the candidate to /me/privacy on the website",
        }
      }
    },
  })

  // ── 6. save_job_profile — persist the daily-recommender profile ──────────
  // Wraps the same pa-job-profiles/{userId} store the save-job-profile
  // connector owns (idempotent upsert; preserves operator-paused status).
  const saveJobProfile = tool({
    name: "save_job_profile",
    description:
      "Persist the candidate's job-search profile (industry tags, sponsorship need, location, company size, " +
      "optional salary floor) so the daily job recommender can deliver personalised matches. Use ONLY once they " +
      "have volunteered all four: industryTags, sponsorshipNeeded, locationPreference, sizePreference. Safe to re-call.",
    parameters: z.object({
      industryTags: z
        .array(
          z.enum([
            "tech_software",
            "tech_hardware",
            "fintech_finance",
            "ai_ml",
            "healthcare_biotech",
            "consumer_retail",
            "media_entertainment",
            "manufacturing_industrial",
            "education",
            "other",
          ]),
        )
        .min(1)
        .max(3),
      sponsorshipNeeded: z.enum(["H1B", "GC", "none"]),
      locationPreference: z.string(),
      sizePreference: z.enum(["big", "startup", "mid", "any"]),
      salaryMin: z.number().int().nonnegative().nullable(),
    }),
    async execute(input) {
      try {
        const ts = ctx.nowIso()
        const ref = ctx.db.collection(JOB_PROFILES_COLLECTION).doc(ctx.userId)
        await ctx.db.runTransaction(async (tx) => {
          const cur = await tx.get(ref)
          const profilePayload = {
            industryTags: input.industryTags,
            sponsorshipNeeded: input.sponsorshipNeeded,
            locationPreference: input.locationPreference,
            sizePreference: input.sizePreference,
            salaryMin: input.salaryMin,
          }
          if (cur.exists) {
            const prev = cur.data() as { status?: unknown; createdAt?: unknown } | undefined
            tx.set(
              ref,
              {
                userId: ctx.userId,
                profile: profilePayload,
                status: prev?.status === "paused" ? "paused" : "active",
                createdAt: typeof prev?.createdAt === "string" ? prev.createdAt : ts,
                updatedAt: ts,
              },
              { merge: true },
            )
          } else {
            tx.set(ref, {
              userId: ctx.userId,
              profile: profilePayload,
              status: "active",
              createdAt: ts,
              updatedAt: ts,
              cvParsedAt: ts,
              lastJobBatchSentAt: null,
            })
          }
        })
        ctx.log("pa.claire.save_job_profile", { userId: ctx.userId })
        return { ok: true }
      } catch (err) {
        return { ok: false, reason: err instanceof Error ? err.message.slice(0, 200) : "save_failed" }
      }
    },
  })

  // ── 7. set_daily_subscription — opt in/out of the daily recommender ──────
  // Toggles pa-job-profiles/{userId}.status (active|paused) — the same field
  // the set-daily-job-recommendation-subscription connector controls.
  const setDailySubscription = tool({
    name: "set_daily_subscription",
    description:
      "Opt the candidate IN or OUT of the daily job-recommendation text. Use when they say things like " +
      "'send me daily roles' / 'yes keep them coming' (optedIn=true) or 'stop the daily texts' / 'pause those' (optedIn=false).",
    parameters: z.object({ optedIn: z.boolean() }),
    async execute({ optedIn }) {
      try {
        const ts = ctx.nowIso()
        const ref = ctx.db.collection(JOB_PROFILES_COLLECTION).doc(ctx.userId)
        await ctx.db.runTransaction(async (tx) => {
          const cur = await tx.get(ref)
          const status = optedIn ? "active" : "paused"
          if (cur.exists) {
            tx.set(ref, { status, updatedAt: ts }, { merge: true })
          } else {
            tx.set(ref, {
              userId: ctx.userId,
              status,
              createdAt: ts,
              updatedAt: ts,
              lastJobBatchSentAt: null,
            })
          }
        })
        ctx.log("pa.claire.set_daily_subscription", { userId: ctx.userId, optedIn })
        return { ok: true, optedIn, jobProfileStatus: optedIn ? "active" : "paused" }
      } catch (err) {
        return { ok: false, reason: err instanceof Error ? err.message.slice(0, 200) : "save_failed" }
      }
    },
  })

  // ── 8. match_collab — partner/collab-only ranked matches ─────────────────
  // Wraps queryMatchingJobsV16 with collabPrescreenOnly=true (the same gate the
  // match-against-collab-jobs connector applies). NEVER throws.
  const matchCollab = tool({
    name: "match_collab",
    description:
      "Find ranked matches restricted to WeKruit partner/collaborated roles that have a pre-screen configured. " +
      "Use when the candidate asks specifically about partner roles or WeKruit-collaborated openings.",
    parameters: z.object({
      requestedCount: z.number().int().min(1).max(5).nullable(),
    }),
    async execute({ requestedCount }) {
      try {
        const limit =
          typeof requestedCount === "number" && requestedCount > 0
            ? Math.min(5, Math.floor(requestedCount))
            : 3
        const result = await queryMatchingJobsV16(
          { userId: ctx.userId, limit, collabPrescreenOnly: true },
          { db: ctx.db },
        )
        const jobs = (result.jobs ?? []).map((j) => {
          const title = (j.jobTitle || j.roleTitle || "Role").trim()
          const company = (j.companyName || "Company").trim()
          const url = (j.atsApplyUrl ?? "").trim()
          return url ? `${title} @ ${company}\n${url}` : `${title} @ ${company}`
        })
        const total = typeof result.total === "number" ? result.total : jobs.length
        ctx.log("pa.claire.match_collab", { userId: ctx.userId, recCount: total })
        return {
          ok: true,
          recCount: total,
          jobs,
          reason: jobs.length === 0 ? "no partner roles fit right now" : null,
        }
      } catch (err) {
        return {
          ok: false,
          recCount: 0,
          jobs: [] as string[],
          reason: `matcher error: ${err instanceof Error ? err.message : String(err)}`,
        }
      }
    },
  })

  // ── 9. cv_parse — parse pasted resume text via pa-resume-parser v2 ───────
  // Returns the parsed structured summary to the LLM. Does NOT itself write
  // tags — the conversation-confirm + applyPartialUserTags path (D12) owns
  // persistence; this tool only extracts so Claire can confirm understanding.
  const cvParse = tool({
    name: "cv_parse",
    description:
      "Parse a block of resume / CV text the candidate pasted into the chat. Returns the extracted structured " +
      "profile (skills, roles, companies) so you can confirm what you understood. Use when they paste a resume.",
    parameters: z.object({ resumeText: z.string() }),
    async execute({ resumeText }) {
      const text = (resumeText ?? "").trim()
      if (text.length < 40) {
        return { ok: false, reason: "resume text too short to parse" }
      }
      try {
        const result = await parseResumeText({
          resumeText: text,
          langHint: ctx.lang === "zh" ? "zh" : "en",
        })
        ctx.log("pa.claire.cv_parse", {
          userId: ctx.userId,
          usedTier: result.usedTier,
          usedModel: result.usedModel,
        })
        return { ok: true, parsed: result.parsed, usedModel: result.usedModel }
      } catch (err) {
        return {
          ok: false,
          reason: `could not parse resume: ${err instanceof Error ? err.message : String(err)}`,
        }
      }
    },
  })

  // ── 10. capture_match_feedback — the "are you happy with these? why?" path ─
  // SAME shape as set_matching_preferences (Adam 顶层设计 2026-05-30): the AGENT
  // maps the candidate's free text to closed-enum sentiment + reasonCategory and
  // canonical pref/tag DELTAS; the tool validates vs shared-tags + writes a
  // structured feedback event (the flywheel) AND any durable tag deltas via the
  // D8 sole writer. NO regex. This is the candidate-SENTIMENT capture the agentic
  // runtime previously lacked (only an automatic job-presented event existed —
  // no "are you happy? why?" signal).
  const captureMatchFeedback = tool({
    name: "capture_match_feedback",
    description:
      "Capture the candidate's reaction to the jobs you just recommended (the 'are you happy with these? why or " +
      "why not?' signal). YOU map their reply to: sentiment (positive/negative/ambiguous), reasonCategory (closed " +
      "enum — why a NEGATIVE batch was off, e.g. wrong_seniority / wrong_industry / salary_too_low; use 'none' if no " +
      "reason, 'other' if unclear), and tagDeltas (canonical preference changes the reason implies — e.g. 'too junior' " +
      "→ careerStage:senior; 'all fintech, I want healthcare' → industrySector:[healthcare_and_life_sciences], " +
      "negativeIndustrySector:[financial_technology]). Multi-value = OR. The tool persists a feedback event + any tag " +
      "deltas. Use right after find_match when the candidate reacts to the roles.",
    parameters: z.object({
      sentiment: FeedbackSentimentEnum,
      reasonCategory: FeedbackReasonCategoryEnum,
      reasonText: z.string().nullable(),
      tagDeltas: z
        .object({
          targetRoleFunction: z.array(RoleFunctionEnum).nullable(),
          negativeRoleFunction: z.array(RoleFunctionEnum).nullable(),
          industrySector: z.array(IndustrySectorEnum).nullable(),
          negativeIndustrySector: z.array(IndustrySectorEnum).nullable(),
          companySize: z.array(CompanySizeEnum).nullable(),
          targetJobType: z.array(JobTypeEnum).nullable(),
          targetLocations: z.array(z.string()).nullable(),
          careerStage: CareerStageEnum.nullable(),
          minSalary: z.number().int().nonnegative().nullable(),
        })
        .nullable(),
    }),
    async execute({ sentiment, reasonCategory, reasonText, tagDeltas }) {
      const jobId = (ctx.jobId ?? "").trim() || undefined
      const nowIso = ctx.nowIso()
      // 1) Validate + persist any canonical tag deltas via the D8 sole writer.
      const tags = validateOnboardingCanonicalTags(
        (tagDeltas ?? {}) as OnboardingCanonicalTagInput,
        { source: "conversation" },
      )
      let tagWriteOk = false
      const writtenKeys = Object.keys(tags)
      if (writtenKeys.length > 0) {
        const w = await applyPartialUserTags(ctx.db, ctx.userId, tags as PartialUserTags, {
          source: "chat",
          nowIso,
          log: ctx.log,
        }).catch((err) => ({ ok: false, error: err instanceof Error ? err.message : String(err) }))
        tagWriteOk = w.ok
      }
      // 2) Write a structured feedback event (the flywheel). Best-effort.
      let feedbackWritten = false
      try {
        await writeFeedbackEvent(ctx.db, {
          eventId: `match-feedback-${ctx.userId}-${jobId ?? "batch"}-${nowIso}`,
          kind: sentiment === "negative" ? "candidate_decline" : "candidate_behavior",
          actor: "candidate",
          candidateId: ctx.userId,
          ...(jobId ? { jobId } : {}),
          outcome:
            sentiment === "negative"
              ? "batch_not_relevant"
              : sentiment === "positive"
                ? "batch_relevant"
                : "batch_ambiguous",
          evidence: [
            {
              source: "conversation",
              summary: (reasonText ?? "").slice(0, 240) || `sentiment=${sentiment}`,
              confidence: 0.85,
              meta: { reasonCategory, sentiment },
            },
          ],
          payloadRedacted: { channel: "imessage", flow: "claire_match_feedback", reasonCategory },
          createdAt: nowIso,
        })
        feedbackWritten = true
      } catch (err) {
        ctx.log("pa.claire.capture_match_feedback_event_error", {
          userId: ctx.userId,
          error: err instanceof Error ? err.message : String(err),
        })
      }
      ctx.log("pa.claire.capture_match_feedback", {
        userId: ctx.userId,
        jobId,
        sentiment,
        reasonCategory,
        tagWriteOk,
        writtenKeys,
        feedbackWritten,
      })
      return { ok: true, sentiment, reasonCategory, tagWriteOk, writtenKeys, feedbackWritten }
    },
  })

  return [
    setMatchingPreferences,
    findMatch,
    captureMatchFeedback,
    rememberFact,
    scheduleInterview,
    privacy,
    saveJobProfile,
    setDailySubscription,
    matchCollab,
    cvParse,
  ]
}
