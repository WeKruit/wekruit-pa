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
// #3 re-enrich hook (Adam 2026-06-05): a résumé PASTED into chat must flow into the SAME
// single enrich path as an attachment (webhook Stream-D) / website upload — re-derive
// role/careerStage/skills via the D8 sole writer — not just return parsed text to the LLM.
import { reEnrichUserTagsFromParsedResume } from "../../cv-ingest/cv-ingest.js"
import { queryMatchingJobsV16, recordRecommendedJobs } from "@pa/job-rec"
import type { FeedbackEvent } from "@pa/core-types"
import type { Firestore } from "firebase-admin/firestore"
// Rec-card image model (flag-gated, fail-open). `resolveRecCardMediaUrl` returns the Sendblue-acceptable
// image url for a job WITHOUT enqueuing (cache-read → shape-guard → liveness → lazy-gen+persist), so the
// image rides INLINE on the role caption bubble (ordered, per-turn). `maybeSendRecCard` is retained for
// back-compat/tests but is no longer used here. `isJobRecCardEnabled` re-gates the resolve (flag off → no
// image). All never throw.
import { resolveRecCardMediaUrl } from "../../job-rec-card/send-rec-card.js"
import { isJobRecCardEnabled } from "../../job-rec-card/job-rec-card.js"
import {
  reduceMatchingPreferences,
  type MatchingTagsSlice,
} from "../reducers/matching-profile-reducer.js"
import type { ClaireToolContext, FindMatchResult } from "../types.js"
import { runCandidatePrivacyRequest } from "../../production-hardening.js"
import { runPreScreenForUser } from "../../prescreen-session-start.js"

const PA_USERS_COLLECTION = "pa-users"
const JOB_PROFILES_COLLECTION = "pa-job-profiles"

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
      negativeJobType: asArr(tags.negativeJobType),
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

/**
 * A candidate's matched/prescreened role, ENRICHED with the job's canonical tags so a fuzzy reference
 * is resolved on canonical signals (roleFunction/industry/company), NOT literal string overlap. The
 * canonical tags come from the job's `matching-jobs` doc (find_match enriches lastCollabRoles; the
 * matcher back-fills any role missing them at resolve time).
 */
export interface CollabRole {
  jobId: string
  company: string
  title: string
  /** Canonical roleFunction tokens (ROLE_FUNCTION_VOCAB) — the primary semantic match axis. */
  roleFunction?: string[]
  /** Canonical industrySector tokens (INDUSTRY_SECTOR_VOCAB). */
  industrySector?: string[]
  /**
   * Where this role is in the candidate's journey. `matched` = recommended, no screen yet.
   * `under_review` = the screen reached a terminal but it's PENDING human (HITL) confirmation — it is
   * NOT a real pass/fail until an operator COMMITS it in the dashboard, so the candidate must never be
   * told they passed while under_review.
   */
  status?: "passed" | "not_passed" | "in_progress" | "matched" | "under_review"
}

/**
 * A CANONICAL query the AGENT composes from the user's free text (Adam 2026-05-31): the agent maps
 * "some product role" → roleFunction:[product_management] / "the design role at the voice company" →
 * roleFunction:[creatives_and_design] + company:"voice…" using the SAME @wekruit/shared-tags vocab the
 * tag extractor uses. The tool then matches the candidate's enriched roles on these signals — no
 * literal token matching, no enum-classification regex.
 */
export interface RoleQuery {
  roleFunction?: string[]
  company?: string | null
  industrySector?: string[]
  /** Raw text — used ONLY as a weak title/company token tiebreak + for logging. Never the primary signal. */
  query?: string | null
}

/** Lower-cased word tokens (len ≥ 2) for the weak title/company tiebreak (NOT enum classification). */
function roleTokens(s: string): string[] {
  return (s ?? "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 2)
}

/** Normalize a company name for matching — drop punctuation + common suffixes/tlds (inc/llc/ai/io…). */
function normCompany(s: string): string {
  return (s ?? "")
    .toLowerCase()
    .replace(/\b(inc|llc|ltd|limited|corp|corporation|co|company|technologies|labs|ai|io|app|com)\b/g, "")
    .replace(/[^a-z0-9]+/g, "")
    .trim()
}

/**
 * Score ONE enriched role against the agent-composed canonical query. Canonical signals dominate;
 * raw-text token overlap is only a weak tiebreak. 0 = no signal (dropped). Pure + unit-testable.
 */
export function scoreRoleAgainstQuery(role: CollabRole, q: RoleQuery): number {
  let score = 0
  // roleFunction intersection — the PRIMARY canonical signal. "product role" → product_management
  // hits BOTH the PM role and a Product Designer whose roleFunction includes product_management.
  if (q.roleFunction?.length && role.roleFunction?.length) {
    const set = new Set(role.roleFunction.map((x) => String(x).toLowerCase()))
    for (const rf of q.roleFunction) if (set.has(String(rf).toLowerCase())) score += 5
  }
  // company — normalized containment in either direction (strong).
  if (q.company && role.company) {
    const a = normCompany(q.company)
    const b = normCompany(role.company)
    if (a && b && (a === b || a.includes(b) || b.includes(a))) score += 6
  }
  // industrySector intersection (medium) — "the fintech one" → financial_technology.
  if (q.industrySector?.length && role.industrySector?.length) {
    const set = new Set(role.industrySector.map((x) => String(x).toLowerCase()))
    for (const s of q.industrySector) if (set.has(String(s).toLowerCase())) score += 2
  }
  // raw-text token overlap vs company+title — WEAK tiebreak only.
  if (q.query) {
    const qt = new Set(roleTokens(q.query))
    for (const t of new Set(roleTokens(`${role.company} ${role.title}`))) if (qt.has(t)) score += 1
  }
  return score
}

/**
 * Rank the candidate's enriched roles against the canonical query.
 *   no roles score > 0      → { kind: "no_match" }
 *   unique top score        → { kind: "one", best, ranked }   (the agent starts / reports it)
 *   ≥2 tie at the top score → { kind: "ambiguous", candidates } (the agent ASKS which — never a silent pick)
 */
export function rankRoles(
  roles: CollabRole[],
  q: RoleQuery,
): { kind: "no_match"; ranked: [] } | { kind: "one"; best: CollabRole; ranked: CollabRole[] } | { kind: "ambiguous"; candidates: CollabRole[]; ranked: CollabRole[] } {
  const valid = (roles ?? []).filter((r) => r && typeof r.jobId === "string" && r.jobId.trim().length > 0)
  const scored = valid.map((role) => ({ role, score: scoreRoleAgainstQuery(role, q) })).filter((x) => x.score > 0)
  if (scored.length === 0) return { kind: "no_match", ranked: [] }
  scored.sort((a, b) => b.score - a.score)
  const ranked = scored.map((x) => x.role)
  const max = scored[0]!.score
  const top = scored.filter((x) => x.score === max).map((x) => x.role)
  if (top.length === 1) return { kind: "one", best: top[0]!, ranked }
  return { kind: "ambiguous", candidates: top, ranked }
}

/** Read the candidate's pushed collab roles from pa-users/{userId}.lastCollabRoles. Fail-soft → []. */
async function readLastCollabRoles(
  db: Firestore,
  userId: string,
  log: ClaireToolContext["log"],
): Promise<CollabRole[]> {
  try {
    const snap = await db.collection(PA_USERS_COLLECTION).doc(userId).get()
    const raw = snap.exists ? (snap.data()?.lastCollabRoles as unknown) : null
    if (!Array.isArray(raw)) return []
    const arr = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [])
    return raw
      .map((r) => {
        const o = (r ?? {}) as Record<string, unknown>
        const role: CollabRole = {
          jobId: typeof o.jobId === "string" ? o.jobId : "",
          company: typeof o.company === "string" ? o.company : "",
          title: typeof o.title === "string" ? o.title : "",
          roleFunction: arr(o.roleFunction),
          industrySector: arr(o.industrySector),
          status: "matched",
        }
        return role
      })
      .filter((r) => r.jobId.trim().length > 0)
  } catch (err) {
    log("pa.claire.read_last_collab_roles_error", {
      userId,
      error: err instanceof Error ? err.message : String(err),
    })
    return []
  }
}

/**
 * Load the candidate's FULL set of matched + prescreened roles, enriched with canonical tags, for
 * find_my_role. Sources, deduped by jobId (a session's status wins over "matched"):
 *   - pa-users.lastCollabRoles  → roles find_match recommended (status "matched", tags from enrichment)
 *   - pa-prescreen-sessions     → roles the candidate STARTED/finished (status from terminal)
 * Any role still missing roleFunction (old lastCollabRoles writes, or a prescreened-only role) is
 * back-filled from its matching-jobs/{jobId} doc (the canonical-tag source). Fail-soft → best effort.
 */
export async function loadCandidateRoles(
  db: Firestore,
  userId: string,
  log: ClaireToolContext["log"],
): Promise<CollabRole[]> {
  const byJob = new Map<string, CollabRole>()
  // 1. matched roles (recommended).
  for (const r of await readLastCollabRoles(db, userId, log)) byJob.set(r.jobId, r)
  // 2. prescreened roles (started/finished) — status overrides "matched".
  try {
    const snap = await db.collection("pa-prescreen-sessions").where("userId", "==", userId).limit(50).get()
    for (const doc of snap.docs) {
      const d = doc.data() as Record<string, unknown>
      const jobId = typeof d.jobId === "string" ? d.jobId : ""
      if (!jobId) continue
      const cfg = (d.cfgSnapshot ?? {}) as Record<string, unknown>
      const existing = byJob.get(jobId)
      byJob.set(jobId, {
        jobId,
        company: existing?.company || (typeof cfg.company === "string" ? cfg.company : ""),
        title: existing?.title || (typeof cfg.jobTitle === "string" ? cfg.jobTitle : ""),
        roleFunction: existing?.roleFunction ?? [],
        industrySector: existing?.industrySector ?? [],
        status: prescreenStatusFromSession(d),
      })
    }
  } catch (err) {
    log("pa.claire.load_candidate_roles.sessions_error", { userId, error: err instanceof Error ? err.message : String(err) })
  }
  // 3. back-fill canonical tags from matching-jobs for any role missing roleFunction.
  const needTags = [...byJob.values()].filter((r) => !r.roleFunction || r.roleFunction.length === 0)
  if (needTags.length > 0) {
    await Promise.all(
      needTags.map(async (r) => {
        try {
          const mj = await db.collection("matching-jobs").doc(r.jobId).get()
          if (!mj.exists) return
          const data = mj.data() as Record<string, unknown>
          const rf = Array.isArray(data.roleFunction) ? data.roleFunction.filter((x): x is string => typeof x === "string") : []
          const ind = Array.isArray(data.industrySector) ? data.industrySector.filter((x): x is string => typeof x === "string") : []
          const cur = byJob.get(r.jobId)
          if (cur) {
            cur.roleFunction = rf
            cur.industrySector = ind
            if (!cur.company && typeof data.companyName === "string") cur.company = data.companyName
            if (!cur.title && typeof data.jobTitle === "string") cur.title = data.jobTitle
          }
        } catch {
          /* best effort */
        }
      }),
    )
  }
  return [...byJob.values()]
}

/** Resolve the candidate's phone (E.164): ctx.toE164 first, else pa-users.phoneE164. "" when unknown. */
async function resolveCandidatePhone(
  db: Firestore,
  userId: string,
  ctxPhone: string | undefined,
  log: ClaireToolContext["log"],
): Promise<string> {
  const fromCtx = (ctxPhone ?? "").trim()
  if (fromCtx) return fromCtx
  try {
    const snap = await db.collection(PA_USERS_COLLECTION).doc(userId).get()
    const phone = snap.exists ? snap.data()?.phoneE164 : null
    return typeof phone === "string" ? phone.trim() : ""
  } catch (err) {
    log("pa.claire.resolve_candidate_phone_error", {
      userId,
      error: err instanceof Error ? err.message : String(err),
    })
    return ""
  }
}

/** The candidate-facing progress status of a prescreen. `under_review` = a terminal verdict that is
 * still pending HITL confirmation (NOT a real pass/fail until an operator commits it). */
export type PrescreenProgressStatus = "passed" | "not_passed" | "in_progress" | "under_review"

/**
 * Map a stored prescreen-session terminal (PASS/FAIL/HARD_STOP/null) to the candidate-facing progress
 * status, taking the HITL REVIEW state into account.
 *
 * A terminal verdict (PASS/FAIL/HARD_STOP) is NOT real until an operator COMMITS it in the dashboard.
 * Until then the session carries `terminalActionPendingReview === true` (and `review.status === "pending"`),
 * and the candidate's status is **"under_review"** — NEVER "passed"/"not_passed". `commitPrescreenOutcome`
 * (apps/functions/src/evaluation-attempts.ts) flips `terminalActionPendingReview → false` and
 * `review.status → "approved"|"overridden"` on commit; only THEN does PASS→passed / FAIL→not_passed.
 *
 * The cheap per-session committed signal (no extra reads) is:
 *   pending  ⇔ pendingReview === true  OR  reviewStatus === "pending"
 *   committed ⇔ NOT pending
 * which is exactly what commit writes back.
 *
 * `review` is optional so a bare-terminal call (legacy/tests) still resolves, but the session-reading
 * call sites MUST pass the review state so a pending PASS reports under_review.
 */
export function prescreenStatusFromTerminal(
  terminal: unknown,
  review?: { pendingReview?: unknown; reviewStatus?: unknown },
): PrescreenProgressStatus {
  const t = typeof terminal === "string" ? terminal.toUpperCase() : ""
  if (t !== "PASS" && t !== "FAIL" && t !== "HARD_STOP") return "in_progress"
  const pending =
    review?.pendingReview === true ||
    (typeof review?.reviewStatus === "string" && review.reviewStatus.toLowerCase() === "pending")
  // A terminal that's awaiting human confirmation is "under review", not a real outcome.
  if (pending) return "under_review"
  if (t === "PASS") return "passed"
  return "not_passed" // FAIL / HARD_STOP committed
}

/**
 * Map a full prescreen-session doc to the candidate-facing progress status. Reads the per-session HITL
 * signals (`terminalActionPendingReview` + `review.status`) so a PASS/FAIL still pending operator commit
 * reports **under_review** (never "passed"). This is the form session-reading call sites should use.
 */
export function prescreenStatusFromSession(session: Record<string, unknown> | undefined | null): PrescreenProgressStatus {
  const d = session ?? {}
  const review = (d.review ?? {}) as Record<string, unknown>
  return prescreenStatusFromTerminal(d.terminal, {
    pendingReview: d.terminalActionPendingReview,
    reviewStatus: review.status,
  })
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
  getPhoneE164: (db: Firestore, userId: string) => Promise<string | null>
  /**
   * Sendblue media-upload creds. NOTE (P0 #4, 2026-06-04): the collab rec-card SEND path is now a PURE
   * CACHE READ — makeV16FindMatch deliberately does NOT thread these into resolveRecCardMediaUrl, so no
   * lazy-gen runs at send time (cards are pre-generated at creation by the enrich pipeline). Retained on
   * the type for back-compat with the caller and the legacy maybeSendRecCard path; unused for collab send.
   */
  sendblueCreds?: { apiKeyId: string; apiSecretKey: string }
  fromNumber?: string
  log?: (event: string, payload?: Record<string, unknown>) => void
}

/**
 * COLLAB FIT GATE (Adam 2026-06-04, P0 #2 — Noah ⟶ MetaVoice ML-research role).
 *
 * COLLAB-ALWAYS-FIRST surfaces a partner role whenever its `roleFunction` shares ONE token with the
 * candidate's `targetRoleFunction`. But a SINGLE stale/extra enum token (e.g. a résumé "Software Engineer"
 * line seeding `data_analysis` for a sales/marketing/PM candidate) re-admits an ENTIRE off-target role
 * family — and nothing downstream checks the role actually FITS. The V16 `COLLAB_PUSH_SCORE_FLOOR` (0.03)
 * is structurally defeated by the `collabBoost` (0.08) it sits downstream of: `0.08 > 0.03`, so the boost
 * ALONE clears the floor and a ZERO-fit collab role can never be dropped by it (proven on the real
 * MetaVoice doc: total=0.105 = collabBoost 0.08 + salaryFit-no-signal-default 0.025, fitSum=0.0000).
 *
 * The fix: gate on the GENUINE-FIT components ONLY — `llmMatch + skillJaccard + relevantTags +
 * industrySector + cvEmbCosine` — EXCLUDING `collabBoost` and the `salaryFit` no-signal mass (both inflate
 * `total` without being real overlap). A collab role must have SOME positive fit signal beyond the single
 * role-family token to surface; a role with `fitSum === 0` (only the role-family token overlaps, 0 skill /
 * industry / embedding / llm) is dropped. Collab-first STILL holds for FITTING collab roles — only the
 * 0-overlap ones are gated.
 *
 * FAIL-OPEN: a job WITHOUT a `v16Score` breakdown (e.g. a fake-catalog eval job, or a legacy projection)
 * is treated as PASS — we never block a collab role just because we couldn't read its score (preserves the
 * RC2 never-blocks-the-turn contract; the eval fakes don't carry v16Score). The gate only DROPS a collab
 * role we can PROVE has zero fit.
 */
const COLLAB_FIT_FLOOR = 0

/** The genuine-fit subtotal of a V16 score breakdown — the match signals only, EXCLUDING collabBoost and
 * the salaryFit no-signal mass. Returns null when no breakdown is present (caller treats null as fail-open
 * pass). */
export function collabFitScore(job: unknown): number | null {
  const b = (job as { v16Score?: Record<string, unknown> } | null | undefined)?.v16Score
  if (!b || typeof b !== "object") return null
  const n = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0)
  return n(b.llmMatch) + n(b.skillJaccard) + n(b.relevantTags) + n(b.industrySector) + n(b.cvEmbCosine)
}

/** True when a collab role clears the fit gate (or has no readable score → fail-open pass). */
export function collabRoleHasFit(job: unknown): boolean {
  const fit = collabFitScore(job)
  if (fit === null) return true // fail-open — no score to judge by (eval fakes / legacy)
  return fit > COLLAB_FIT_FLOOR
}

/**
 * Is this DELIVERED job a WeKruit collab role on its matching-jobs mirror? (P0 #4 — rec-card image.)
 *
 * The rec-card image is a property of the JOB (cached on `matching-jobs/{id}.recCardMediaUrl`), independent
 * of WHICH retrieval pass surfaced it. A collab role whose `pa-jobs` doc lacks `publicVisible:true` + a
 * prescreenConfig (e.g. VoiceCursor) falls OUT of the collab pass and is delivered via the OPEN-MARKET pass
 * — yet its matching-jobs mirror IS collab-tagged AND carries a cached card. So we must resolve images for
 * any delivered row that is collab-on-mirror, not only the collab-pass survivors. The matcher already stamps
 * `matchSourceLabel === "WeKruit collaborated"` for jobs whose `pa-jobs.wekruitCollaborationStatus ===
 * "collaborated"` (resolved once over the survivor set); we also accept the row-level `isWekruitCollab` flag
 * and a `wekruitCollaborationStatus` field carried on the projection. Pure + cheap (no read). Fail-soft.
 */
export function isCollabOnMirror(job: unknown): boolean {
  const j = (job ?? {}) as Record<string, unknown>
  return (
    j.matchSourceLabel === "WeKruit collaborated" ||
    j.isWekruitCollab === true ||
    j.wekruitCollaborationStatus === "collaborated"
  )
}

// DELIVERED-REC COMPOSITION (Adam 2026-06-04 "≤3, don't dump" + 2026-06-06 "what about the normal
// ones?"): cap the delivered set at 3, collab-first, but RESERVE one slot for a normal open-market role
// whenever any exists — so a candidate with ≥3 collab/partner roles still sees a "normal" job instead of
// an all-collab list. When NO open-market row exists, collab keeps the full cap (no empty slots). Pure +
// deterministic so it unit-tests without a DB.
export const REC_DELIVERY_CAP = 3
export const REC_OPEN_MARKET_RESERVE = 1
export function selectDeliveredRecs<T>(collabJobs: readonly T[], openJobs: readonly T[]): T[] {
  const reserve = openJobs.length > 0 ? REC_OPEN_MARKET_RESERVE : 0
  const collabSlots = Math.max(0, REC_DELIVERY_CAP - reserve)
  const collabTake = collabJobs.slice(0, collabSlots)
  const openTake = openJobs.slice(0, REC_DELIVERY_CAP - collabTake.length)
  return [...collabTake, ...openTake]
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
      // COLLAB FIT GATE (P0 #2): drop any collab role with ZERO genuine fit — a role that cleared the
      // collab pass on a single (often stale) role-family enum token but has 0 skill/industry/embedding/llm
      // overlap (exactly Noah ⟶ MetaVoice). collabRoleHasFit reads the per-job v16Score breakdown's
      // fit-only subtotal (excluding the collabBoost + salaryFit no-signal mass that defeat the V16 floor)
      // and is fail-open: a job with no readable score passes (eval fakes / legacy). COLLAB-FIRST is
      // preserved — fitting collab roles still lead; only 0-overlap ones are gated.
      const collabJobsRaw = collabResult?.jobs ?? []
      const collabJobs = collabJobsRaw.filter((j) => collabRoleHasFit(j))
      if (collabJobs.length !== collabJobsRaw.length) {
        log("pa.claire.find_match.collab_fit_gate_dropped", {
          userId,
          dropped: collabJobsRaw.length - collabJobs.length,
          droppedIds: collabJobsRaw.filter((j) => !collabRoleHasFit(j)).map((j) => j.id).slice(0, 10),
        })
      }
      const collabHit = collabJobs.length > 0
      const collabIds = new Set(collabJobs.map((j) => j.id))

      // Pass 2 — open-market fill for the slots collab did not fill. allowBroadFallback: a candidate
      // whose specific city genuinely has 0 fresh roles still gets US matches (location-relax ladder)
      // instead of a dead "no roles" — never a silent dead end. Skip the pass entirely when collab
      // already filled `limit`. The open-market `result` is also the source of the snapshotTags /
      // needsOnboarding / total signals when there are no collab jobs (pure open-market path).
      // RESERVED OPEN-MARKET SLOT (Adam 2026-06-06): size the open-market fetch to fill the slots collab
      // left open PLUS the reserved slot, so collab can't crowd open-market out even when it fills the cap.
      // The final composition is done by selectDeliveredRecs (collab-first, cap, reserve) below.
      const remaining = Math.max(0, limit - collabJobs.length)
      const openWant = Math.max(remaining, REC_OPEN_MARKET_RESERVE)
      let result = collabResult
      let openJobs: typeof collabJobs = []
      // Run the open-market pass whenever we could deliver an open-market row — i.e. collab didn't fill
      // the cap (remaining>0), OR there was no collab at all, OR collab filled the cap but we still want
      // to reserve a normal-role slot (openWant>0). Skipping it only when collab fully owns the set AND
      // no slot is reserved keeps the old cost-saving path.
      if (remaining > 0 || !collabHit || openWant > 0) {
        result = await queryMatchingJobsV16({ userId, limit, allowBroadFallback: true }, { db })
        // Dedup the open-market set against collab ids so a collab role never repeats as open-market,
        // then take enough to fill the open slots + the reserved slot.
        openJobs = (result.jobs ?? []).filter((j) => !collabIds.has(j.id)).slice(0, openWant)
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
      //
      // HARD DELIVERY CAP (Adam 2026-06-04): "limit recommendations to less than 3 — it's dumping too
      // many" (a live test delivered 4+). Cap the DELIVERED set at AT MOST 3 total, here at the single
      // merge point so EVERY downstream consumer (ledger, rec-card, formatted lines, collab prescreen
      // offer) sees the same capped set. COLLAB-FIRST ORDERING IS PRESERVED: the array is collab-then-
      // open and .slice() keeps that order — collab roles take the first slots, open-market fills the
      // rest up to 3. Only the COUNT is capped; the mandatory collab prescreen offer mechanics are
      // untouched (the offer is rebuilt below from the collab roles that survive this cap).
      // Collab-first, capped at 3, with one slot reserved for a normal open-market role (see helper).
      const rawJobs = selectDeliveredRecs(collabJobs, openJobs)
      // The collab roles that actually survived the cap (collab-first, so these are the leading entries
      // of rawJobs that came from the collab pass). The prescreen offer + structured `collab` payload
      // below are built from THIS set, not the full collab pass, so we never name a partner role the
      // candidate was not shown.
      const deliveredCollabJobs = rawJobs.filter((j) => collabIds.has(j.id))

      // PERSIST the pushed collab roles (req #1) — write the collab subset we just surfaced to
      // pa-users/{userId}.lastCollabRoles = [{ jobId, company, title }] so a LATER turn's
      // begin_collab_prescreen can resolve a free-form role name ("the Helium one") back to a real
      // jobId WITHOUT re-running the matcher. Only the collab pass roles (the prescreen-eligible
      // partner inventory) go here — open-market fill is not a start-by-name target. Best-effort,
      // fail-soft: a write failure must NEVER break find_match's never-throws contract (RC2).
      if (collabJobs.length > 0) {
        // Enrich with the job's CANONICAL tags (roleFunction/industrySector) so a later
        // begin_collab_prescreen / find_my_role can resolve a fuzzy reference ("the product role")
        // on canonical signals, not literal title overlap. loadCandidateRoles back-fills from
        // matching-jobs for any role missing these, so this is best-effort.
        const arr = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [])
        const lastCollabRoles = collabJobs.map((j) => {
          const jj = j as unknown as Record<string, unknown>
          return {
            jobId: j.id,
            company: (j.companyName || "").trim(),
            title: (j.jobTitle || j.roleTitle || "").trim(),
            roleFunction: arr(jj.roleFunction),
            industrySector: arr(jj.industrySector),
          }
        })
        await db
          .collection("pa-users")
          .doc(userId)
          .set({ lastCollabRoles, lastCollabRolesAt: nowIso() }, { merge: true })
          .catch((e) => log("pa.claire.find_match.last_collab_roles_write_failed", { err: String(e) }))
      }
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

      // Rec-card IMAGE resolution (flag-gated, fail-open). RESOLVE ONE Sendblue-acceptable image url PER
      // COLLAB/partner role (Adam 2026-06-04: "for each collab role we can share an image, not only the
      // first one") WITHOUT enqueuing — the image is attached INLINE to its role caption bubble by
      // deliverRecBubbles instead of as a separate, decoupled, once/day media row that RACED the recs.
      // This fixes BOTH live bugs: the image now rides WITH its role caption (ordered + per-turn), and the
      // separate "rec-card-<uid>-<jobId>-<ymd>" once/day idempotency cap is gone.
      //
      // IMAGE-ELIGIBLE SET (P0 #4, Adam 2026-06-04): the image is a property of the JOB (cached on
      // matching-jobs/{id}.recCardMediaUrl), NOT of which retrieval pass surfaced it. A collab role whose
      // pa-jobs doc lacks publicVisible+prescreenConfig (e.g. VoiceCursor) falls OUT of the collab pass and
      // is delivered by the OPEN-MARKET pass — yet its matching-jobs mirror IS collab-tagged + carries a
      // cached card. The OLD loop iterated ONLY `deliveredCollabJobs` (collab-pass survivors) → that role's
      // bubble shipped text-only despite a live cached image. So we widen to EVERY delivered row that is
      // collab-on-mirror (collab-pass survivors ∪ open-market-delivered collab-tagged rows). Open-market
      // NON-collab rows stay text-only.
      const imageEligible = rawJobs.filter((j) => collabIds.has(j.id) || isCollabOnMirror(j))
      //
      // SEND DIRECT (Adam 2026-06-04: "should be direct"): for collab roles the card is PRE-GENERATED at
      // creation (agent C), so the happy path is a PURE CACHE READ. We deliberately DO NOT pass
      // sendblueCreds here → resolveRecCardMediaUrl runs cache-read → shape-guard → liveness ONLY and
      // SKIPS lazy-gen entirely (lazy-gen requires creds; absent creds = no render/upload at send time).
      // A cache miss simply omits the image (the role still delivers as text — RC2). This removes the
      // slow, fail-prone, per-send render path Adam flagged; lazy-gen stays available ONLY for the legacy
      // maybeSendRecCard path (which still threads creds when present).
      //
      // resolveRecCardMediaUrl NEVER throws and returns null on any miss. Gated by cardDeps presence (the
      // REC_CARD_UIDS allowlist in cutover.ts) AND the runtime flag, so the image still only goes to the
      // allowlisted dev uid. `imageEligible` elements are the V16 `MatchingJob & { reason, ... }`
      // projection; every field read (incl. `requiredSkills` → the card's SKILLS pills) exists on that
      // shape. CardJobSource fields are all optional, so any null/absent value omits its card section.
      const mediaByJobId = new Map<string, string>()
      if (cardDeps && imageEligible.length > 0 && isJobRecCardEnabled()) {
        for (const cj of imageEligible) {
          try {
            const mediaUrl = await resolveRecCardMediaUrl(db, {
              jobId: cj.id,
              job: {
                companyName: cj.companyName,
                jobTitle: cj.jobTitle,
                roleTitle: cj.roleTitle,
                seniorityLevel: cj.seniorityLevel,
                salaryMin: cj.salaryMin,
                salaryMax: cj.salaryMax,
                locationRaw: cj.locationRaw,
                jobType: cj.jobType,
                atsApplyUrl: cj.atsApplyUrl,
                primaryUrl: cj.primaryUrl,
                requiredSkills: cj.requiredSkills,
                reason: cj.reason,
              },
              // NO sendblueCreds → pure cache read, lazy-gen skipped (send-direct).
              log: cardDeps.log ?? log,
            })
            if (mediaUrl) mediaByJobId.set(cj.id, mediaUrl)
          } catch {
            /* fail-open — the role still delivers as a text bubble */
          }
        }
      }

      // COLLAB MARKER (Adam 2026-05-30): the merged set is now MIXED (collab roles first, then
      // open-market fill), so the marker is per-job — tag ONLY the lines that came from the collab
      // pass (by id) so the agent fires the collab pitch (prescreen now → direct to the hiring
      // manager) on exactly those roles. The prompt keys off this exact "[WeKruit partner role]"
      // marker; open-market lines carry no marker (no fast-track promise). `collabBatch` is now true
      // whenever the collab pass produced surfaced jobs — no longer gated on the first batch.
      const collabBatch = collabHit

      // PRESCREEN COPY-PASTE TRIGGER (Adam 2026-05-30): for collab/partner roles that ACTUALLY have a
      // prescreen config, append the deterministic kickoff string the candidate copies + sends back to
      // START A REAL prescreen session (router PrescreenTrigger → runPreScreenForUser). This is the
      // simple, reliable path — independent of the agentic flow (which can't yet create a real session).
      // It's the SAME `WeKruit_<jobId>_<userId>_Job` token the public job page uses; for collab roles
      // matching-jobs.id == pa-jobs.id (enrich-collab-jobs uses doc.id), so j.id IS the trigger jobId.
      // Only emit for roles WITH a config (≤5 collab ids → one getAll); else the trigger config_missings.
      const prescreenReady = new Set<string>()
      if (collabIds.size > 0) {
        try {
          const snaps = await db.getAll(...[...collabIds].map((id) => db.collection("pa-jobs").doc(id)))
          for (const s of snaps) {
            const data = (s.data() ?? {}) as { prescreenConfig?: { questions?: unknown[] } | null }
            const cfg = data.prescreenConfig ?? null
            if (cfg && Array.isArray(cfg.questions) && cfg.questions.length > 0) prescreenReady.add(s.id)
          }
        } catch (e) {
          log("pa.claire.find_match.prescreen_ready_lookup_failed", { err: String(e) })
        }
      }

      const jobs = rawJobs.map((j) => {
        const title = (j.jobTitle || j.roleTitle || "Role").trim()
        const company = (j.companyName || "Company").trim()
        const isCollab = collabIds.has(j.id)
        // Collab roles ALWAYS link to the WeKruit candidate page — funnel through our own site, never the
        // raw external ATS url (Adam 2026-05-31: Invoko collab role was linking to app.joinhandshake.com).
        //
        // LINK ID FIX (P0 #3, Adam 2026-06-04): the `/j/:id` page resolves by the pa-jobs DOCUMENT id
        // (PublicJob.tsx getDoc(pa-jobs/<id>)), NOT by the `publicId` field. For a collab role
        // matching-jobs.id === pa-jobs.id (enrich-collab-jobs uses doc.id), so `j.id` IS the resolvable
        // candidate-page id. The old `wekruit.com/j/<publicId-UUID>` link 404'd because the page never maps
        // a publicId UUID → doc id (it isn't a doc id). Linking to `j.id` matches the two other builders
        // that already work (outreach/service.ts + partner-users-api.ts both use the pa-jobs doc id).
        const url = isCollab ? `https://wekruit.com/j/${j.id}` : (j.atsApplyUrl ?? "").trim()
        const head = isCollab ? `${title} @ ${company} [WeKruit partner role]` : `${title} @ ${company}`
        const base = url ? `${head}\n${url}` : head
        // The trigger line is RELAYED VERBATIM by the agent (prompt rule) so the candidate can copy it.
        // Human lead-in, and the WeKruit_..._Job token ALONE on its own final line so it copies cleanly
        // (the job-opener regex still extracts it whether they copy the line or the whole block).
        if (isCollab && prescreenReady.has(j.id)) {
          return `${base}\nto start this screen, just reply "${title} @ ${company}" — or copy & send me this line:\nWeKruit_${j.id}_${userId}_Job`
        }
        return base
      })
      // STRUCTURED delivery rows — one per `jobs[]` line, SAME order (jobs maps over rawJobs), each
      // carrying its rec-card image url INLINE when one was resolved above (ANY collab-on-mirror role —
      // collab-pass survivors AND open-market-delivered collab-tagged rows; open-market NON-collab is
      // text-only). deliverRecBubbles iterates THESE so the image rides WITH its caption, in order,
      // per-turn. The mandatory prescreen offer is NOT here — deliverRecBubbles appends it LAST.
      const deliverRows = rawJobs.map((j, i) => {
        const mediaUrl = mediaByJobId.get(j.id)
        return mediaUrl ? { text: jobs[i]!, mediaUrl } : { text: jobs[i]! }
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
      // Structured collab roles for the DETERMINISTIC prescreen offer (the find_match TOOL sends it —
      // the LLM kept dropping it). prescreenReady ⇒ this role's jobs[] line carries a start token.
      // Built from `deliveredCollabJobs` (the collab roles that survived the 3-cap), NOT the full collab
      // pass — so the MANDATORY prescreen offer only names partner roles the candidate was actually
      // shown. The offer mechanics are unchanged; only the candidate count is capped.
      const collab = deliveredCollabJobs.map((j) => ({
        jobId: j.id,
        title: (j.jobTitle || j.roleTitle || "Role").trim(),
        company: (j.companyName || "Company").trim(),
        prescreenReady: prescreenReady.has(j.id),
      }))
      return {
        ok: true,
        recCount: total,
        jobs,
        reason,
        collab,
        deliverRows,
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

/**
 * Build the MANDATORY collab prescreen offer (Adam 2026-06-01: any match with a WeKruit collab role MUST
 * ask the candidate to prescreen it). Names the partner role(s) and the TWO start paths. Deterministic —
 * the LLM kept skipping this, so the find_match tool sends it itself.
 */
export function buildCollabPrescreenOffer(
  collab: Array<{ title: string; company: string }>,
): string {
  if (collab.length === 1) {
    const c = collab[0]!
    return (
      `want to knock out a quick prescreen for the ${c.title} @ ${c.company} role? it pitches you straight ` +
      `to their team. two easy ways: reply "${c.title} @ ${c.company}", or copy & send the start line printed ` +
      `right under it. no stress if you'd rather pass — i'll keep sending more.`
    )
  }
  const names = collab.map((c) => `${c.title} @ ${c.company}`).join(" — or the ")
  const first = collab[0]!
  return (
    `want to run a quick prescreen on one of the partner roles? the ${names}. it pitches you straight to ` +
    `their team. just reply the role + company (like "${first.company}"), or copy & send the start line ` +
    `printed under that role. no stress passing — i'll keep sending more.`
  )
}

/**
 * DETERMINISTIC rec delivery. The LLM repeatedly (3× / Adam 2026-06-01) dropped the collab start tokens,
 * skipped the prescreen offer, and crammed multiple roles into one bubble. So when find_match has roles,
 * the TOOL sends them itself via the transport: a short intro, ONE role per bubble (collab lines already
 * carry their WeKruit_..._Job start token), then — if the batch has any prescreen-ready collab role — the
 * MANDATORY prescreen offer. The agent then stays silent (prompt: delivered:true → empty messages).
 * Fail-soft: a send error degrades to delivered:false so the agent narrates as before (never a dead turn).
 */
export async function deliverRecBubbles(
  ctx: ClaireToolContext,
  res: FindMatchResult,
): Promise<{ delivered: boolean; collabCount: number }> {
  // Prefer the STRUCTURED rows (each carries its inline image url); fall back to the bare `jobs[]` lines
  // (text-only) for older shapes / no-cardDeps. Each row's `text` is one role line.
  const rows: Array<{ text: string; mediaUrl?: string }> =
    Array.isArray(res.deliverRows) && res.deliverRows.length > 0
      ? res.deliverRows
          .filter((r) => r && typeof r.text === "string" && r.text.trim().length > 0)
          .map((r) => (r.mediaUrl ? { text: r.text, mediaUrl: r.mediaUrl } : { text: r.text }))
      : (res.jobs ?? [])
          .filter((s) => typeof s === "string" && s.trim().length > 0)
          .map((text) => ({ text }))
  if (rows.length === 0) return { delivered: false, collabCount: 0 }
  const collab = (res.collab ?? []).filter((c) => c.prescreenReady)
  try {
    // STRICT ORDER + EMIT-PACE (Adam 2026-06-04): intro → each role (in order) → prescreen offer LAST.
    //
    // The reorder bug (job1, job2, OFFER, job3 / image after the offer) was that each `sendText` writes an
    // INDEPENDENT pa-outbound row consumed by a SEPARATE concurrent outbox CF instance. Marking rows
    // `paced:true` makes the outbox SKIP its own length-dwell — but with all rows written back-to-back at
    // the SAME createdAt, the concurrent instances still race on POST order. The proven fix (deliverBubbles
    // in delivery.ts) is to PACE AT THE EMIT SEAM: await a small randomized human delay BEFORE each send so
    // the `createdAt` timestamps stagger (>=900ms apart here — a rec list reads well a touch slower than the
    // 600ms chat beat), giving the outbox an unambiguous arrival order. Combined with `paced:true` (no
    // double-dwell), the monotonic `seq` below IS the delivered order. The image rides its role row's
    // `mediaUrl` so it lands WITH (and in the same order as) its caption — no separate racing media row.
    let seq = 0
    const stagger = async (): Promise<void> => {
      if (seq === 0) return // no delay before the very first bubble
      await ctx.transport.typing().catch(() => {})
      const ms = 900 + Math.floor(Math.random() * 300) // 900–1200ms inter-bubble beat for a rec list
      await new Promise((r) => setTimeout(r, ms))
    }
    const intro =
      collab.length > 0
        ? "found a few that fit right now — including WeKruit partner roles where I pitch you straight to the hiring team 👇"
        : "found a few that fit right now 👇"
    await ctx.transport.sendText(intro, { seq: seq++, paced: true })
    let withImage = 0
    for (const row of rows) {
      await stagger()
      await ctx.transport.sendText(
        row.text,
        row.mediaUrl
          ? { seq: seq++, paced: true, mediaUrl: row.mediaUrl }
          : { seq: seq++, paced: true },
      )
      if (row.mediaUrl) withImage++
    }
    if (collab.length > 0) {
      await stagger()
      await ctx.transport.sendText(buildCollabPrescreenOffer(collab), { seq: seq++, paced: true })
    }
    ctx.log("pa.claire.find_match.delivered", {
      userId: ctx.userId,
      roles: rows.length,
      withImage,
      collab: collab.length,
    })
    return { delivered: true, collabCount: collab.length }
  } catch (e) {
    ctx.log("pa.claire.find_match.deliver_failed", { userId: ctx.userId, err: String(e) })
    return { delivered: false, collabCount: 0 }
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
      "Also pass jobType (full_time/internship/...) and locations when stated. " +
      "If they say they are NOT looking for / done with a JOB TYPE → put it in avoidJobTypes (it is REMOVED from their saved job types) " +
      "(e.g. 'I'm not looking for an internship' → avoidJobTypes:[internship]; 'no more contract gigs, full-time only' → jobType:[full_time] AND avoidJobTypes:[contract]). " +
      "If they say they're open to ANY job type / want the job-type filter gone → clearTargetJobType:true. " +
      "Pass null for anything not stated.",
    parameters: z.object({
      onlyRoleFunctions: z.array(RoleFunctionEnum).nullable(),
      avoidRoleFunctions: z.array(RoleFunctionEnum).nullable(),
      jobType: z.array(JobTypeEnum).nullable(),
      avoidJobTypes: z.array(JobTypeEnum).nullable(),
      clearTargetJobType: z.boolean().nullable(),
      locations: z.array(z.string()).nullable(),
    }),
    async execute({ onlyRoleFunctions, avoidRoleFunctions, jobType, avoidJobTypes, clearTargetJobType, locations }) {
      const current = await readMatchingSlice(ctx.db, ctx.userId, ctx.log)
      const { changed, removedFromPositive } = reduceMatchingPreferences(current, {
        onlyRoleFunctions,
        avoidRoleFunctions,
        jobType,
        avoidJobTypes,
        clearTargetJobType,
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
      "Find ranked job matches AND deliver them. Use when they ask for roles / recommendations / 'what fits " +
      "me', or the moment onboarding completes. Reads their SAVED preferences (call set_matching_preferences " +
      "first if they just stated new ones). CRITICAL: when it returns delivered:true, the role bubbles AND " +
      "the WeKruit collab prescreen offer have ALREADY been sent to the candidate as separate messages — you " +
      "MUST then reply with an EMPTY message list (say nothing more; any text duplicates the recs). Only when " +
      "delivered:false (no match / error) do you speak — warmly and grounded, never an excuse.",
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
        // DETERMINISTIC delivery: when there are roles, the TOOL sends the role bubbles + the mandatory
        // collab prescreen offer (the LLM kept dropping them). On success the agent MUST stay silent —
        // we return delivered:true and jobs:[] so it has nothing to re-list. Only when NOT delivered
        // (no match / error) does the agent narrate (the no-match clarifier).
        const delivery = res.ok ? await deliverRecBubbles(ctx, res) : { delivered: false, collabCount: 0 }
        return {
          ok: res.ok,
          recCount: res.recCount,
          delivered: delivery.delivered,
          collabCount: delivery.collabCount,
          jobs: delivery.delivered ? [] : res.jobs,
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

  // ── 4. (RETIRED) schedule_interview — superseded by the Cal.com scheduling
  // tools (offer_interview_slots + book_interview_slot in scheduling-tools.ts).
  // The legacy stub only wrote a status:"requested" doc and never called
  // Cal.com; it is no longer built or registered. See the registration array
  // below + the SCHEDULING prompt section (TRIAGE now routes scheduling →
  // offer_interview_slots).

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

  // ── 9. find_my_role — CANONICAL resolution of a fuzzy role/company reference ──
  // Adam 2026-05-31: stop literal string matching. YOU (the agent) map the candidate's free text to
  // the SAME canonical @wekruit/shared-tags vocab the tag extractor uses — "some product role" →
  // roleFunction:["product_management"], "the design role at the voice company" →
  // roleFunction:["creatives_and_design"] + company:"voice…", "the fintech one" →
  // industrySector:["financial_technology"] — and pass those signals. The tool matches them against
  // the candidate's matched + prescreened roles (each enriched with the job's canonical roleFunction /
  // industrySector) and returns them RANKED with status. NO literal token matching, NO regex.
  const findMyRole = tool({
    name: "find_my_role",
    description:
      "Resolve which of the candidate's matched / pre-screened WeKruit collab roles they mean when they " +
      "refer to one in plain text ('how'd the product role go?', 'start the design role at the voice " +
      "company', 'did I pass the fintech one?'). Compose a CANONICAL query from their words: roleFunction " +
      "(closed enum), company (free text), industrySector (closed enum) — map their meaning the same way " +
      "you'd tag a preference. Returns matched+prescreened roles RANKED by canonical fit, each with its " +
      "status (passed / not_passed / in_progress / matched / under_review). under_review = the screen is " +
      "submitted but awaiting human confirmation — it is NOT a pass; do NOT say they passed for it. " +
      "kind='one' → the single best is theirs; " +
      "kind='ambiguous' → ASK which of the candidates they mean (never guess); kind='no_match' → they " +
      "haven't been matched to such a role, so guide them to the website to start a new one. Then use " +
      "begin_collab_prescreen with the chosen jobId to START, or just report the status.",
    parameters: z.object({
      roleFunction: z.array(RoleFunctionEnum).nullable(),
      company: z.string().nullable(),
      industrySector: z.array(IndustrySectorEnum).nullable(),
      query: z.string().nullable(),
    }),
    async execute({ roleFunction, company, industrySector, query }) {
      const roles = await loadCandidateRoles(ctx.db, ctx.userId, ctx.log)
      const q: RoleQuery = {
        roleFunction: roleFunction ?? undefined,
        company: company ?? undefined,
        industrySector: industrySector ?? undefined,
        query: query ?? undefined,
      }
      const ranked = rankRoles(roles, q)
      const slim = (r: CollabRole) => ({ jobId: r.jobId, company: r.company, title: r.title, status: r.status ?? "matched" })
      ctx.log("pa.claire.find_my_role", {
        userId: ctx.userId,
        roleFunction: roleFunction ?? null,
        company: company ?? null,
        roleCount: roles.length,
        kind: ranked.kind,
      })
      if (ranked.kind === "no_match") return { ok: true, kind: "no_match", roles: roles.map(slim) }
      if (ranked.kind === "ambiguous") return { ok: true, kind: "ambiguous", candidates: ranked.candidates.map(slim) }
      return { ok: true, kind: "one", best: slim(ranked.best), ranked: ranked.ranked.map(slim) }
    },
  })

  // ── 9b. begin_collab_prescreen — START the screen for a RESOLVED jobId ─────
  // The candidate named a collab role; you resolved it to ONE jobId via find_my_role (or they pasted
  // the trigger). Pass that jobId. SAFETY (Adam: never start the wrong / an unmatched one): the jobId
  // MUST be in the candidate's matched/prescreened set — a foreign jobId returns reason 'not_matched'
  // and starts nothing. Starts via the SAME runPreScreenForUser the copy-paste trigger uses, so the
  // existing thin-prescreen mode-selector + terminal flow are UNCHANGED.
  const beginCollabPrescreen = tool({
    name: "begin_collab_prescreen",
    description:
      "START the pre-screen for a specific WeKruit collab/partner role, identified by its jobId — which " +
      "you get from find_my_role (kind='one' → best.jobId, or the candidate's chosen one after you " +
      "clarified an 'ambiguous' result). NEVER call this with a jobId you guessed, invented, or read off " +
      "a token in your own context — ALWAYS resolve via find_my_role first. reason 'not_matched' means " +
      "the jobId YOU passed isn't in their matched set (you likely guessed) — it does NOT mean the " +
      "candidate is unmatched. NEVER tell them they're 'not matched'; instead read the returned `roles` " +
      "(their REAL matched roles) and ask which one they meant. Only point them to the website if `roles` " +
      "is empty. Use ONLY when they clearly want to begin a role's screen.",
    parameters: z.object({ jobId: z.string() }),
    async execute({ jobId }) {
      const cleanJobId = (jobId ?? "").trim()
      const roles = await loadCandidateRoles(ctx.db, ctx.userId, ctx.log)
      const role = roles.find((r) => r.jobId === cleanJobId)
      if (!role) {
        // Matched-gate (by-name path): only a job in the candidate's matched/prescreened set is startable.
        ctx.log("pa.claire.begin_collab_prescreen.not_matched", { userId: ctx.userId, jobId: cleanJobId, roleCount: roles.length })
        return { ok: false, reason: "not_matched", roles: roles.map((r) => ({ jobId: r.jobId, company: r.company, title: r.title })) }
      }
      const toE164 = await resolveCandidatePhone(ctx.db, ctx.userId, ctx.toE164, ctx.log)
      if (!toE164) {
        ctx.log("pa.claire.begin_collab_prescreen.no_phone", { userId: ctx.userId, jobId: role.jobId })
        return { ok: false, reason: "no_phone", jobId: role.jobId, title: role.title, company: role.company }
      }
      try {
        // SAME session-start the copy-paste trigger runs (PrescreenTrigger → runPreScreenForUser). Do
        // NOT hand-roll a session shape — reuse so the existing mode-selector + terminal flow are unchanged.
        // ctx.beginPrescreen is the eval seam (default = the real legacy handler); prod leaves it undefined.
        const result = ctx.beginPrescreen
          ? await ctx.beginPrescreen({ jobId: role.jobId, userId: ctx.userId, toE164 })
          : await runPreScreenForUser({
              db: ctx.db,
              jobId: role.jobId,
              userId: ctx.userId,
              toE164,
              log: ctx.log,
            })
        if (!result.ok) {
          ctx.log("pa.claire.begin_collab_prescreen.start_failed", {
            userId: ctx.userId,
            jobId: role.jobId,
            reason: result.reason,
          })
          return { ok: false, reason: result.reason ?? "start_failed", jobId: role.jobId, title: role.title, company: role.company }
        }
        ctx.log("pa.claire.begin_collab_prescreen.started", {
          userId: ctx.userId,
          jobId: role.jobId,
          sessionId: result.sessionId,
        })
        return { ok: true, jobId: role.jobId, title: role.title, company: role.company }
      } catch (err) {
        ctx.log("pa.claire.begin_collab_prescreen.error", {
          userId: ctx.userId,
          jobId: role.jobId,
          error: err instanceof Error ? err.message : String(err),
        })
        return { ok: false, reason: "start_error", jobId: role.jobId, title: role.title, company: role.company }
      }
    },
  })

  // ── 10. check_prescreen_progress — READ-ONLY status of the candidate's screens ──
  // Answers "how's my prescreen going / did I pass the Invoko one?". Mirrors prescreen-context.ts:
  // a userId-only query + in-memory filter (index-light, no `!=`/orderBy dependency), optional
  // company/title contains filter. Maps terminal → status. NEVER writes, NEVER throws.
  const checkPrescreenProgress = tool({
    name: "check_prescreen_progress",
    description:
      "Look up the status of the candidate's pre-screens when they ask about their progress " +
      "('how did my screen go?', 'did I pass the Invoko one?', 'what's the status of my interviews?'). " +
      "Optional query = a company/title to filter to (e.g. 'Invoko'); omit to list all their screens. " +
      "Returns each screen's company, title, and status (passed / not_passed / in_progress / under_review). " +
      "under_review = the screen is SUBMITTED and awaiting human confirmation — it is NOT a pass yet; do " +
      "NOT tell the candidate they passed (or offer a confirmed next step) for an under_review screen; only " +
      "a 'passed' status is a real, confirmed pass. READ-ONLY.",
    parameters: z.object({ query: z.string().nullable() }),
    async execute({ query }) {
      try {
        const snap = await ctx.db
          .collection("pa-prescreen-sessions")
          .where("userId", "==", ctx.userId)
          .limit(50)
          .get()
        const q = (query ?? "").trim().toLowerCase()
        const sessions = snap.docs
          .map((doc) => {
            const d = doc.data() as Record<string, unknown>
            const cfg = (d.cfgSnapshot ?? {}) as Record<string, unknown>
            const company = typeof cfg.company === "string" ? cfg.company : ""
            const title = typeof cfg.jobTitle === "string" ? cfg.jobTitle : ""
            const jobId = typeof d.jobId === "string" ? d.jobId : ""
            const createdAt = typeof d.createdAt === "string" ? d.createdAt : ""
            return {
              company,
              title,
              jobId,
              createdAt,
              status: prescreenStatusFromSession(d),
            }
          })
          // optional company/title filter (in-memory contains; NO regex/enum classification).
          .filter((s) => !q || s.company.toLowerCase().includes(q) || s.title.toLowerCase().includes(q))
          // most-recent first when createdAt is present.
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
          .map(({ createdAt: _createdAt, ...rest }) => rest)
        ctx.log("pa.claire.check_prescreen_progress", {
          userId: ctx.userId,
          query: q || null,
          count: sessions.length,
        })
        return { ok: true, sessions }
      } catch (err) {
        ctx.log("pa.claire.check_prescreen_progress_error", {
          userId: ctx.userId,
          error: err instanceof Error ? err.message : String(err),
        })
        return { ok: false, sessions: [], reason: "could not load prescreen status right now" }
      }
    },
  })

  // ── 11. cv_parse — parse pasted resume text via pa-resume-parser v2 ───────
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
        // RE-ENRICH HOOK (Adam #3 2026-06-05): persist the parsed résumé into the SAME
        // canonical enrich path the attachment (webhook Stream-D) + website upload use —
        // re-derives targetRoleFunction (incl. the #2 same-lane override), careerStage,
        // skills, embedding via the D8 sole writer. Fire-and-forget so the agent's
        // confirm/pitch turn (which owns the conversational reply) is never blocked; the
        // helper is fully fail-open. find_match then reads the refreshed tags live.
        void reEnrichUserTagsFromParsedResume({
          db: ctx.db,
          userId: ctx.userId,
          parsedV2: result.parsed,
          nowIso: ctx.nowIso,
          log: ctx.log,
        }).catch((err) =>
          ctx.log("pa.claire.cv_parse.reenrich_failed", {
            userId: ctx.userId,
            error: err instanceof Error ? err.message : String(err),
          }),
        )
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
  // SAME shape as set_matching_preferences (Adam top-level design 2026-05-30): the AGENT
  // maps the candidate's free text to closed-enum sentiment + reasonCategory and
  // canonical pref/tag DELTAS; the tool validates vs shared-tags + writes a
  // structured feedback event (the flywheel) AND any durable tag deltas via the
  // D8 sole writer. NO regex. This is the candidate-SENTIMENT capture the agentic
  // runtime previously lacked (only an automatic job-presented event existed —
  // no "are you happy? why?" signal).
  const captureMatchFeedback = tool({
    name: "capture_match_feedback",
    description:
      "Capture the candidate's reaction to recommended jobs OR an unprompted PROFILE CORRECTION/ADDITION they " +
      "volunteer in chat (e.g. mid-onboarding 'actually I work in the Autopilot group, more ML infra than web' → " +
      "industrySector:[artificial_intelligence_and_machine_learning]). YOU map their reply to: sentiment " +
      "(positive/negative/ambiguous — use 'ambiguous' for a neutral correction), reasonCategory (closed enum for why a " +
      "NEGATIVE batch was off, e.g. wrong_seniority / wrong_industry / salary_too_low; use 'none' for a pure profile " +
      "addition with no complaint), and tagDeltas (canonical preference changes implied — e.g. 'too junior' → " +
      "careerStage:senior; 'all fintech, I want healthcare' → industrySector:[healthcare_and_life_sciences], " +
      "negativeIndustrySector:[financial_technology]). Multi-value = OR. The tool persists a feedback event + any tag " +
      "deltas (via the canonical writer, no regex). Use after find_match when they react to roles, OR mid-chat when " +
      "they correct/add a profile fact — confirm just that one delta in your voice, do NOT re-pitch.",
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
    // NOTE: the legacy `schedule_interview` stub is RETIRED — the Cal.com
    // scheduling tools (offer_interview_slots + book_interview_slot, registered
    // via buildSchedulingTools) supersede it. It only ever wrote a status:
    // "requested" doc and never called Cal.com; keeping it registered created a
    // three-way tool-routing conflict where TRIAGE steered "book me an interview"
    // to the stub, bypassing the entire Cal.com flow. See scheduling-tools.ts.
    privacy,
    saveJobProfile,
    setDailySubscription,
    matchCollab,
    findMyRole,
    beginCollabPrescreen,
    checkPrescreenProgress,
    cvParse,
  ]
}
