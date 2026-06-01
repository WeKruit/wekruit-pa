import { defineSecret } from "firebase-functions/params"
import { logger } from "firebase-functions/v2"
import { initializeApp, getApps } from "firebase-admin/app"
import { getFirestore } from "firebase-admin/firestore"
import {
  collectLiveFirestoreJobRecommendationMessageItems,
  composeJobRecommendationMessage,
  compactJobRecContext,
  hasConcreteJobRequirements,
  resolveJobRecVisibleCount,
  type JobRecIntroContext,
} from "./job-rec-copy.js"

export {
  cleanJobRecUrl,
  collectJobRecommendationMessageItems,
  collectLiveFirestoreJobRecommendationMessageItems,
  composeJobRecommendationMessage,
  compactJobRecContext,
  formatJobRecIntro,
  formatJobRequirementsLine,
  hasConcreteJobRequirements,
  resolveJobRecVisibleCount,
  toJobRecommendationMessageItem,
} from "./job-rec-copy.js"

type SecretParamHandle = ReturnType<typeof defineSecret>

export const MAILGUN_API_KEY: SecretParamHandle = defineSecret("MAILGUN_API_KEY")
export const MAILGUN_DOMAIN: SecretParamHandle = defineSecret("MAILGUN_DOMAIN")
export const MAILGUN_FROM: SecretParamHandle = defineSecret("MAILGUN_FROM")
export const MAILGUN_REGION: SecretParamHandle = defineSecret("MAILGUN_REGION")

/** All four Mailgun secrets — pass to a function's `secrets:` array. */
export const MAILGUN_SECRETS: SecretParamHandle[] = [
  MAILGUN_API_KEY,
  MAILGUN_DOMAIN,
  MAILGUN_FROM,
  MAILGUN_REGION,
]

// v1.7 Phase 69 — Adam-action keys. Adam holds these and provisions them via
// `firebase functions:secrets:set <NAME> --project wekruit-5f89b --data-file=-`
// (see ops/secrets/SECRETS-PROVISIONING.md). Until provisioned:
//   - ANTHROPIC_API_KEY absent → pa-resume-parser router skips Anthropic
//     fallback tier; JD-rel weights helper skips Anthropic; sponsorship-inference
//     skips Anthropic — all already coded with fall-through.
//   - PA_SLACK_ALERT_WEBHOOK absent → postSlackAlert returns
//     { posted:false, reason:"...not set" }; defense-in-depth Mailgun path still
//     fires.
// Declared once here so multiple CFs can list them without `defineSecret` being
// called repeatedly across the bundle.
export const ANTHROPIC_API_KEY: SecretParamHandle = defineSecret("ANTHROPIC_API_KEY")
export const PA_SLACK_ALERT_WEBHOOK: SecretParamHandle = defineSecret("PA_SLACK_ALERT_WEBHOOK")

// iter33 P3 — SiliconFlow API key (already used by other Qwen-7B paths in
// this repo). Reused here for the CV-analysis brief.
const SILICONFLOW_API_KEY: SecretParamHandle = defineSecret("SILICONFLOW_API_KEY")
export const CV_ANALYSIS_SECRETS: SecretParamHandle[] = [SILICONFLOW_API_KEY]

/**
 * Build orchestrator callbacks. SMS onboarding does not ask for email or
 * run email verification; Mailgun is only exported here for unrelated
 * alert/admin surfaces that still need the secret handles.
 */
export function makeOrchestratorDeps(): import("@pa/pa-orchestrator").OrchestratorStoreDeps {
  const deps: import("@pa/pa-orchestrator").OrchestratorStoreDeps = {
    generateCvAnalysis: makeGenerateCvAnalysis(),
    generateJobRecs: makeGenerateJobRecs(),
    extractAnswerIntent: makeExtractAnswerIntent(),
    classifyFeedback: makeClassifyFeedback(),
    startPrescreenForJob: async ({ userId, jobId, toE164 }) => {
      if (!getApps().length) initializeApp()
      const db = getFirestore()
      const { runPreScreenForUser } = await import("./prescreen-session-start.js")
      const result = await runPreScreenForUser({
        db,
        userId,
        jobId,
        toE164,
        // Orchestrator-chosen jobId (the agentic collab-prescreen hook resolves the
        // role from what Claire presented) — not candidate-supplied free text, so the
        // matched-gate does not apply here.
        allowMatchedBypass: true,
        log: (event, payload) => logger.info("[collab-prescreen]", { event, ...(payload ?? {}) }),
      })
      return {
        ok: result.ok,
        reason: result.reason,
      }
    },
    sendReaction: async ({ to, messageHandle, reaction, userId }) => {
      if (!getApps().length) initializeApp()
      const db = getFirestore()
      let fromNumber: string | undefined
      if (userId) {
        try {
          const userSnap = await db.collection("pa-users").doc(userId).get()
          const senderNumber = userSnap.data()?.senderNumber
          fromNumber = typeof senderNumber === "string" && senderNumber.trim()
            ? senderNumber.trim()
            : undefined
        } catch {
          fromNumber = undefined
        }
      }
      const { sendReaction } = await import("./sendblue/send-reaction.js")
      await sendReaction({
        to,
        messageHandle,
        reaction,
        ...(userId ? { userId, db } : {}),
        ...(fromNumber ? { fromNumber } : {}),
        allowEnvFromNumberFallback: false,
      })
    },
  }

  // Note: getUserCvParsed is already implemented in
  // packages/pa-orchestrator/src/index.ts:3777 inside
  // createFirestoreOrchestratorStore — no override needed here.
  return deps
}

function normalizeRuntimeRoleFocus(values: unknown): string[] {
  if (!Array.isArray(values)) return []
  const out: string[] = []
  const add = (value: string) => {
    if (!out.includes(value)) out.push(value)
  }
  for (const raw of values) {
    if (typeof raw !== "string") continue
    const value = raw.trim().toLowerCase()
    if (value === "frontend" || value === "front-end" || value === "front end") add("frontend")
    if (value === "fullstack" || value === "full-stack" || value === "full stack") add("fullstack")
    if (value === "backend" || value === "back-end" || value === "back end") add("backend")
  }
  return out
}

export function resolveRuntimeJobRecRoleFocus(explicitFocus: unknown, userTags: unknown): string[] {
  const explicit = normalizeRuntimeRoleFocus(explicitFocus)
  if (explicit.length > 0) return explicit
  if (!userTags || typeof userTags !== "object") return []
  const targetRoleFunction = (userTags as { targetRoleFunction?: unknown }).targetRoleFunction
  if (Array.isArray(targetRoleFunction)) {
    return targetRoleFunction.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
  }
  return normalizeRuntimeRoleFocus((userTags as { targetRole?: unknown }).targetRole)
}

/**
 * Rec tracking (req #4, 2026-05-29) — pick the attribution `reason` label for a
 * `recordRecommendedJobs` ledger row from the V16 matcher result + the call
 * intent. Single source of truth so the orchestrator-deps path and the
 * claire_agent tool path tag the same canonical vocabulary:
 *
 *   - `collab_prescreen`        — collab/partner-only request (opts.collabPrescreenOnly).
 *   - `general_market_fallback` — V16 relaxed all hard filters and surfaced
 *     general scraped-market jobs (out.fallbackApplied) so Claire is never
 *     dead-silent (req #5).
 *   - `runtime_job_search_reply`— the default curated/collab+market mix.
 *
 * Pure + exported for unit test (orchestrator-deps.test.ts): the un-DI'd
 * `makeGenerateJobRecs` reads Firestore directly, so we lock the reason-
 * selection contract here rather than driving the whole closure.
 */
export function resolveRecommendationReason(args: {
  collabPrescreenOnly?: boolean
  fallbackApplied?: boolean
}): "collab_prescreen" | "general_market_fallback" | "runtime_job_search_reply" {
  if (args.collabPrescreenOnly === true) return "collab_prescreen"
  if (args.fallbackApplied === true) return "general_market_fallback"
  return "runtime_job_search_reply"
}

/**
 * Phase 61 hotfix — V16 cutover. Replaces the legacy `queryMatchingJobs`
 * call (which read fragmented sources: parsedCandidateResumes.topSkills +
 * pa-users.statedPreferences) with `queryMatchingJobsV16` (single-source
 * read of `pa-users/{userId}.tags`).
 *
 * V16 already includes:
 *   - Hard filter chain: visa / location / careerStage / jobType /
 *     freshness / atsApplyUrl (drops jobright.ai) / dead
 *   - Soft scoring: weighted Jaccard skill + relevant tags + industry
 *     sector + cv-emb cosine + salary fit + LLM rerank (Phase 58 cache)
 *   - Pre-composed `reason` per job (top-2 weighted matched skills)
 *
 * Fail-OPEN: any error path (no user tags, no matches, query threw,
 * recent batch already sent) → return null and the deterministic
 * dispatcher emits the deferred-promise fallback ("first batch tomorrow
 * ~9am") so onboarding ALWAYS completes.
 */
function makeGenerateJobRecs(): NonNullable<
  import("@pa/pa-orchestrator").OrchestratorStoreDeps["generateJobRecs"]
> {
  return async (
    userId: string,
    lang: "zh" | "en",
    opts?: {
      force?: boolean
      requestedCount?: number
      roleFocus?: string[]
      collabPrescreenOnly?: boolean
      excludeInternships?: boolean
      allowBroadFallback?: boolean
    },
  ) => {
    if (!getApps().length) initializeApp()
    const db = getFirestore()
    const outputLang: "en" = "en"
    void lang
    let userTagsForJobRec: unknown
    let introContext: JobRecIntroContext | undefined

    // Skip live match when daily batch already sent recs in the last 24h.
    try {
      const profile = await db.collection("pa-job-profiles").doc(userId).get()
      if (profile.exists) {
        const data = profile.data() as { lastJobBatchSentAt?: string }
        const sentAt = data.lastJobBatchSentAt
        if (sentAt && opts?.force !== true) {
          const ageHours = (Date.now() - Date.parse(sentAt)) / (3600 * 1000)
          if (ageHours < 24) {
            logger.info("[job-recs] recent batch already sent — defer", {
              userId,
              ageHours,
            })
            return null
          }
        }
      }
    } catch (err) {
      logger.warn("[job-recs] profile read failed", {
        userId,
        err: err instanceof Error ? err.message : String(err),
      })
    }

    try {
      const userDoc = await db.collection("pa-users").doc(userId).get()
      userTagsForJobRec = userDoc.exists ? userDoc.data()?.tags : undefined
      introContext = compactJobRecContext(userTagsForJobRec)
    } catch (err) {
      logger.warn("[job-recs] user context read failed", {
        userId,
        err: err instanceof Error ? err.message : String(err),
      })
    }

    const roleFocus = resolveRuntimeJobRecRoleFocus(opts?.roleFocus, userTagsForJobRec)

    try {
      const { queryMatchingJobsV16, recordRecommendedJobs } = await import("@pa/job-rec")
      // V16 reads `pa-users/{userId}.tags` directly; no `filters` needed.
      // limit=10 retains the wider window so we can fire-and-forget
      // llmRerank against the top-5 (next-batch cache).
      const out = await queryMatchingJobsV16(
        {
          userId,
          limit: opts?.collabPrescreenOnly ? 5 : roleFocus.length ? 20 : 10,
          lang: outputLang,
          allowBroadFallback: opts?.allowBroadFallback !== false,
          ...(opts?.collabPrescreenOnly ? { collabPrescreenOnly: true } : {}),
          ...(roleFocus.length ? { presentationRoleFocus: roleFocus } : {}),
          ...(opts?.excludeInternships ? { excludeInternships: true } : {}),
        },
        {
          db,
          log: (event, payload) =>
            logger.info("[job-recs][v16]", { event, ...(payload ?? {}) }),
        }
      )
      // 2026-05-27 — V16 counter pass-through. Adam's live test caught the
      // matcher returning 0 jobs (hard-filter wipeout) and the legacy
      // generic "I did not find a strong fresh match yet" copy. The
      // orchestrator's `composeNoMatchReply` needs the real V16 counters
      // (total / dropped / hardFilter / needsOnboarding / missingAxes) to
      // narrate the actual cause. We surface them on every return path —
      // including the previously `null`-returning 0-match branches — so
      // the caller can always produce a grounded reply.
      const counters: {
        noUserTags?: boolean
        needsOnboarding?: boolean
        missingAxes?: readonly string[]
        total?: number
        dropped?: number
        hardFilter?: Readonly<Record<string, number>>
        collabPrescreenOnly?: boolean
      } = {
        ...(out.noUserTags ? { noUserTags: true } : {}),
        ...(out.needsOnboarding ? { needsOnboarding: true } : {}),
        ...(out.missingAxes ? { missingAxes: out.missingAxes } : {}),
        ...(typeof out.total === "number" ? { total: out.total } : {}),
        ...(typeof out.dropped === "number" ? { dropped: out.dropped } : {}),
        ...(out.hardFilter ? { hardFilter: out.hardFilter as Record<string, number> } : {}),
        ...(opts?.collabPrescreenOnly ? { collabPrescreenOnly: true } : {}),
      }
      if (out.noUserTags) {
        logger.info("[job-recs] no pa-users.tags — fallback", { userId })
        return { message: "", recCount: 0, v16Counters: counters }
      }
      if (
        opts?.allowBroadFallback === false &&
        out.needsOnboarding === true &&
        out.missingAxes?.includes("targetRoleFunction")
      ) {
        logger.info("[job-recs] target role missing — skip broad candidate-visible recs", {
          userId,
          missingAxes: out.missingAxes,
        })
        return { message: "", recCount: 0, v16Counters: counters }
      }
      const jobs = out.jobs ?? []
      if (jobs.length === 0) {
        logger.info("[job-recs] no matches in corpus", {
          userId,
          total: out.total,
          dropped: out.dropped,
          hardFilter: out.hardFilter,
          collabPrescreenOnly: opts?.collabPrescreenOnly ?? false,
        })
        return { message: "", recCount: 0, v16Counters: counters }
      }
      if (opts?.collabPrescreenOnly === true) {
        const top = jobs[0]!
        const score =
          typeof top.v16Score === "object" && top.v16Score && "total" in top.v16Score
            ? Number((top.v16Score as { total?: number }).total ?? 0)
            : 0
        return {
          message: `${top.jobTitle ?? "Role"} @ ${top.companyName ?? "Company"}\n${top.reason ?? ""}`.trim(),
          recCount: 1,
          topJob: {
            jobId: top.id,
            title: String(top.jobTitle ?? "Role"),
            company: String(top.companyName ?? "Company"),
            score,
          },
          v16Counters: counters,
        }
      }
      const visibleCount = resolveJobRecVisibleCount(opts?.requestedCount)
      const visibleItems = await collectLiveFirestoreJobRecommendationMessageItems(db, jobs, outputLang, {
        limit: visibleCount,
        candidateTags: userTagsForJobRec,
        maxCandidates: Math.min(jobs.length, Math.max(10, visibleCount * 5)),
        log: (event, payload) => logger.warn(`[job-recs] ${event}`, payload ?? {}),
      })
      if (visibleItems.length === 0) {
        logger.warn("[job-recs] no matches with public job links", {
          userId,
          total: out.total,
          dropped: out.dropped,
        })
        return { message: "", recCount: 0, v16Counters: counters }
      }

      // v1.7 hotfix — LLM-composed nuanced reasoning for top-2.
      // Replaces the generic V16 skill-overlap template
      // with reason citing specific work-history bridge.
      // Pulls user's parsedCandidateResumes for work-history + projects.
      // Fail-graceful: if LLM errors, falls back to V16 template `j.reason`.
      const visibleReasons: (string | null)[] = []
      try {
        const cvSnap = await db
          .collection("parsedCandidateResumes")
          .where("userId", "==", userId)
          .orderBy("createdAt", "desc")
          .limit(1)
          .get()
        const cvData = cvSnap.docs[0]?.data() as
          | {
              workHistory?: Array<{ title?: string; company?: string; bullets?: string[]; description?: string }>
              experiences?: Array<{ title?: string; company?: string; bullets?: string[]; description?: string }>
              projects?: Array<{ name?: string; description?: string; technologies?: string[] }>
              topSkills?: string[]
              candidateProfile?: { skills?: string[] }
            }
          | undefined
        if (cvData) {
          const { composeNuancedReason } = await import("./lib/match-nuanced-reason.js")
          const wh = cvData.workHistory ?? cvData.experiences ?? []
          const projects = cvData.projects ?? []
          const topSkills = cvData.topSkills ?? cvData.candidateProfile?.skills ?? []
          // 2026-05-07 Bug D true root cause — `process.env.OPENAI_API_KEY` is
          // OVERLOADED in production (apps/functions/src/index.ts line 1258
          // sets it to `SILICONFLOW_API_KEY.value()` when unset). Falling
          // through to it = passing a SiliconFlow key to OpenAI client →
          // OpenAI returns "401 status code (no body)". Persistent, not
          // transient. Use ONLY PA_OPENAI_AGENT_API_KEY here, with empty-
          // string detection so we don't pass an empty Authorization header.
          const rawKey = (process.env.PA_OPENAI_AGENT_API_KEY ?? "").trim()
          const openaiKey = rawKey.startsWith("sk-") ? rawKey : ""
          // 2026-05-07 diagnostic — Bug D 401 STILL firing post first fix.
          // Log the actual key shape (length + prefix + suffix) the CF sees
          // at call time so we can compare with secret-manager value. We
          // already verified the secret-manager value works for openai
          // gpt-5.4-nano via direct burst test, so divergence here = CF
          // process.env mutation between secret bind + this call site.
          logger.info("pa.match.nuanced_reason_key_diag", {
            userId,
            len: rawKey.length,
            prefix: rawKey.slice(0, 8),
            suffix: rawKey.slice(-5),
            paEnvType: typeof process.env.PA_OPENAI_AGENT_API_KEY,
            openaiEnvType: typeof process.env.OPENAI_API_KEY,
            openaiEnvPrefix: (process.env.OPENAI_API_KEY ?? "").slice(0, 8),
          })
          if (!openaiKey) {
            logger.warn("[job-recs] nuanced reason skipped: PA_OPENAI_AGENT_API_KEY missing or non-OpenAI", {
              userId,
              hasRawKey: rawKey.length > 0,
              keyPrefix: rawKey.slice(0, 5),
            })
          }
          // Stated-priority + seniority signals from the candidate's tags so the
          // nuanced reason can land the "leans into the comp + equity you said
          // matter most" angle Adam flagged as missing (2026-05-30).
          const tagsForReason =
            userTagsForJobRec && typeof userTagsForJobRec === "object"
              ? (userTagsForJobRec as Record<string, unknown>)
              : undefined
          const candidatePriorities = Array.isArray(tagsForReason?.targetCompanyTags)
            ? (tagsForReason!.targetCompanyTags as unknown[]).filter(
                (t): t is string => typeof t === "string" && t.trim().length > 0,
              )
            : []
          const candidateSeniority =
            typeof tagsForReason?.careerStage === "string" ? tagsForReason!.careerStage : null
          const reasons = await Promise.all(
            visibleItems.map((item) =>
              composeNuancedReason(
                {
                  lang: outputLang,
                  workHistory: wh.slice(0, 3),
                  projects: projects.slice(0, 2),
                  topSkills: topSkills.slice(0, 12),
                  job: {
                    title: typeof item.sourceJob.jobTitle === "string" ? item.sourceJob.jobTitle : item.title,
                    company: typeof item.sourceJob.companyName === "string" ? item.sourceJob.companyName : null,
                    requiredSkills: Array.isArray(item.sourceJob.requiredSkills)
                      ? item.sourceJob.requiredSkills
                      : null,
                    seniorityLevel: (item.sourceJob as { seniorityLevel?: string | null }).seniorityLevel ?? null,
                    jobDescription: (item.sourceJob as { jobDescription?: string | null }).jobDescription ?? null,
                    companyStage:
                      (item.sourceJob as { companySize?: string | null; companyStage?: string | null }).companyStage ??
                      (item.sourceJob as { companySize?: string | null }).companySize ??
                      null,
                    industry: Array.isArray((item.sourceJob as { industrySector?: string[] }).industrySector)
                      ? (item.sourceJob as { industrySector?: string[] }).industrySector!
                      : Array.isArray((item.sourceJob as { industryEnum?: string[] }).industryEnum)
                        ? (item.sourceJob as { industryEnum?: string[] }).industryEnum!
                        : null,
                    location:
                      (item.sourceJob as { locationRaw?: string | null; location?: string | null }).locationRaw ??
                      (item.sourceJob as { location?: string | null }).location ??
                      null,
                  },
                  matchedSkills:
                    (item.sourceJob as { matchedSkills?: Array<{ name: string; proficiency?: string }> }).matchedSkills ?? [],
                  candidatePriorities,
                  candidateSeniority,
                },
                {
                  openaiApiKey: openaiKey,
                  // 2026-05-07 — Forward Anthropic key so callWithFallback's
                  // middle tier (claude-sonnet-4-6) activates if primary 401s.
                  // When unset, router falls through tier-2 → tier-3 (gpt-4.1-mini).
                  anthropicApiKey: process.env.ANTHROPIC_API_KEY?.trim() || undefined,
                }
              )
            )
          )
          for (const r of reasons) visibleReasons.push(r)
        }
      } catch (err) {
        logger.warn("[job-recs] nuanced reason build failed", {
          userId,
          err: err instanceof Error ? err.message : String(err),
        })
      }

      const messageItems = visibleItems.map((item, i) => {
        const nuanced = visibleReasons[i]
        const reason = nuanced && nuanced.length > 0
          ? `why: ${nuanced}`
          : item.reason
        return { ...item, ...(reason ? { reason } : {}) }
      })
      const message = composeJobRecommendationMessage(
        messageItems,
        outputLang,
        introContext,
        {
          // iter34 hotfix 2026-05-05 — Adam directive on phrasing.
          footer: "see if these fit — if not lmk, i'll keep digging; daily fresh batch from here",
        },
      )

      // Phase 61 — fire-and-forget llmRerank for the NEXT request, refreshing
      // the Phase 58 nightly cache pre-emptively so the v16 llmMatch component
      // is non-zero on the next pull. We pull the user's tags (already loaded
      // by V16 internally; we re-read a thin slice for the rerank input) and
      // pass top-5 jobs to the rerank.
      try {
        const top5 = jobs.slice(0, 5)
        if (top5.length > 0) {
          // Read a thin slice of pa-users.tags for the rerank candidate signal.
          // We don't need the full V16 input — just role + top-skills + visa.
          const userDoc = await db.collection("pa-users").doc(userId).get()
          const userTags =
            userDoc.exists
              ? (userDoc.data()?.tags as
                  | {
                      targetRoleFunction?: string[]
                      targetRole?: string[]
                      skills?: Array<{ name: string } | string>
                      visaStatus?: string
                    }
                  | undefined)
              : undefined
          const topSkillsForRerank: string[] = []
          if (Array.isArray(userTags?.skills)) {
            for (const s of userTags!.skills.slice(0, 8)) {
              if (typeof s === "string") topSkillsForRerank.push(s)
              else if (s && typeof s === "object" && typeof s.name === "string")
                topSkillsForRerank.push(s.name)
            }
          }
          fireAndForgetLlmRerank({
            db,
            userId,
            top5: top5.map((j) => ({
              id: j.id,
              jobTitle: j.jobTitle,
              companyName: j.companyName,
              ...(j.industryEnum ? { industryEnum: j.industryEnum } : {}),
              ...(j.requiredSkills ? { requiredSkills: j.requiredSkills } : {}),
              ...(j.sponsorship !== undefined ? { sponsorship: j.sponsorship } : {}),
              ...(j.locationRaw ? { locationRaw: j.locationRaw } : {}),
              ...(j.salaryMin !== undefined ? { salaryMin: j.salaryMin } : {}),
              ...(j.salaryMax !== undefined ? { salaryMax: j.salaryMax } : {}),
            })),
            candidate: {
              targetRole: userTags?.targetRoleFunction ?? userTags?.targetRole,
              topSkills: topSkillsForRerank,
              visaStatus: userTags?.visaStatus,
            },
          })
        }
      } catch (err) {
        // Defensive — fireAndForgetLlmRerank is sync (returns void) so this
        // shouldn't throw, but we belt-and-suspenders the live path.
        logger.warn("[job-recs] fireAndForgetLlmRerank threw at sync setup", {
          userId,
          err: err instanceof Error ? err.message : String(err),
        })
      }

      logger.info("[job-recs] v16_ok", {
        userId,
        visible: messageItems.length,
        total: out.total,
        dropped: out.dropped,
        llmCacheStale: out.llmCacheStale ?? false,
        fallbackApplied: out.fallbackApplied ?? false,
        relaxedHardFilters: out.relaxedHardFilters ?? [],
      })
      // Rec tracking (req #4/#5) — distinguish WHY the batch was surfaced so the
      // flywheel can tell a curated/collab mix apart from a general-market
      // fallback. `source` stays the coarse scalar; `reason` is the precise
      // ledger label resolved from the matcher result + intent.
      const recommendationReason = resolveRecommendationReason({
        collabPrescreenOnly: opts?.collabPrescreenOnly,
        fallbackApplied: out.fallbackApplied,
      })
      if (out.fallbackApplied === true) {
        // req #5 — Claire fell back to general scraped-market jobs (no curated/
        // collab match). Surface it so the never-dead-silence path is auditable.
        logger.info("pa.match.general_market_fallback_activated", {
          userId,
          visible: messageItems.length,
          total: out.total,
          relaxedHardFilters: out.relaxedHardFilters ?? [],
        })
      }
      await recordRecommendedJobs(
        db,
        {
          userId,
          // Persist the grounded "why matched" pitch alongside each rec so the
          // /me/matches API reads the GOOD reason rather than recomputing weak
          // templates. messageItems[i].reason is the LLM nuanced reason
          // ("why: …") or the V16 fallback; recordRecommendedJobs strips the
          // "why:" prefix + length-caps. (The per-job `matchReason` field is
          // distinct from the args-level `reason` ledger label below.)
          jobs: messageItems.map((item) => ({
            ...item.sourceJob,
            ...(item.reason ? { matchReason: item.reason } : {}),
          })),
          source: "runtime_job_search_reply",
          reason: recommendationReason,
        },
          (event, payload) => logger.info("[job-recs]", { event, ...(payload ?? {}) }),
      )
      const lastJobBatchSentAt = new Date().toISOString()
      await db.collection("pa-job-profiles").doc(userId).set(
        {
          lastJobBatchSentAt,
          updatedAt: lastJobBatchSentAt,
        },
        { merge: true },
      )
      return { message, recCount: messageItems.length, v16Counters: counters }
    } catch (err) {
      logger.warn("[job-recs] queryMatchingJobsV16 threw", {
        userId,
        err: err instanceof Error ? err.message : String(err),
      })
      return null
    }
  }
}

// ---------------------------------------------------------------------------
// iter34 H.2 / CR4 — fire-and-forget llmRerank pre-compute.
//
// Wraps llmRerank() in a void-returning helper that:
//   1. Imports llmRerank lazily (avoid pulling OpenAI SDK into the live path
//      when the call is skipped).
//   2. Calls llmRerank with top-5 candidate jobs + minimal candidate signal.
//   3. On success writes pa-user-rerank-cache/{userId} with the ranked list.
//   4. On any failure (LLM error, Firestore write error) logs + swallows.
//
// Caller MUST NOT await — this runs after the live response has been queued
// for the user. Latency-sensitive: reranking takes 1-3s for N=5; cache write
// is small (~5 KB).
//
// Exported for unit testing (orchestrator-deps.test.ts mocks llmRerank +
// asserts cache write semantics).
// ---------------------------------------------------------------------------

export interface FireAndForgetLlmRerankInput {
  db: import("firebase-admin/firestore").Firestore
  userId: string
  top5: Array<{
    id: string
    jobTitle: string
    companyName: string
    industryEnum?: string[]
    requiredSkills?: string[]
    sponsorship?: boolean | null
    locationRaw?: string
    salaryMin?: number | null
    salaryMax?: number | null
  }>
  candidate: {
    targetRole?: string[]
    topSkills?: string[]
    visaStatus?: string
    cvSummary?: string
  }
  /** Inject for unit tests; default lazy-loads ./lib/llm-rerank. */
  llmRerankImpl?: (
    input: import("./lib/llm-rerank.js").RerankInput
  ) => Promise<import("./lib/llm-rerank.js").RerankOutput>
  /** Inject for unit tests; default uses Date.now(). */
  now?: () => Date
}

export function fireAndForgetLlmRerank(input: FireAndForgetLlmRerankInput): void {
  const promise = (async () => {
    let llmRerank: FireAndForgetLlmRerankInput["llmRerankImpl"]
    if (input.llmRerankImpl) {
      llmRerank = input.llmRerankImpl
    } else {
      const mod = await import("./lib/llm-rerank.js")
      llmRerank = mod.llmRerank
    }
    const rerankInput: import("./lib/llm-rerank.js").RerankInput = {
      candidate: {
        targetRole: input.candidate.targetRole,
        topSkills: input.candidate.topSkills,
        visaStatus: input.candidate.visaStatus,
        cvSummary: input.candidate.cvSummary,
      },
      jobs: input.top5.map((j) => ({
        id: j.id,
        roleTitle: j.jobTitle,
        companyName: j.companyName,
        industryEnum: j.industryEnum,
        requiredSkills: j.requiredSkills,
        sponsorship: j.sponsorship === true ? true : false,
        locationRaw: j.locationRaw,
        salaryRange:
          typeof j.salaryMin === "number" && typeof j.salaryMax === "number"
            ? `${j.salaryMin}-${j.salaryMax}`
            : undefined,
      })),
    }
    const result = await llmRerank!(rerankInput)
    if (!result.ranked || result.ranked.length === 0) {
      logger.info("[job-recs] llmRerank empty — skipping cache write", {
        userId: input.userId,
        latencyMs: result.latencyMs,
      })
      return
    }
    const computedAt = (input.now ?? (() => new Date()))().toISOString()
    await input.db
      .collection("pa-user-rerank-cache")
      .doc(input.userId)
      .set({
        userId: input.userId,
        ranked: result.ranked,
        computedAt,
        modelUsed: result.modelUsed,
        latencyMs: result.latencyMs,
      })
    logger.info("[job-recs] llmRerank cache written", {
      userId: input.userId,
      ranked: result.ranked.length,
      latencyMs: result.latencyMs,
    })
  })()
  // Swallow rejections so the live path can't be poisoned by an unhandled
  // promise rejection from the lazy-import or LLM call.
  promise.catch((err) => {
    logger.warn("[job-recs] fireAndForgetLlmRerank failed", {
      userId: input.userId,
      err: err instanceof Error ? err.message : String(err),
    })
  })
}

/**
 * iter34 H.2 / CR1 — fetch wrapper plus degenerate-output guard for CV
 * analysis (and any future Qwen-7B Chat-Completion path that wants to opt-in
 * to the same hardening). Exported for unit tests so we can mock the LLM
 * response and lock in the fallback contract without a live SiliconFlow call.
 *
 * Adam G5-sim 2026-05-05 saw Qwen2.5-7B-Instruct emit "Docker, Docker, Docker..."
 * x60 on Adam's real CV (12 distinct skills) — a cyclical-attention
 * pathology where the model latches onto a single token. Frequency / presence
 * penalties + an explicit prompt rule + a runtime degeneracy guard together
 * make this near-impossible to ship to a candidate.
 */
const SILICONFLOW_CHAT_URL = "https://api.siliconflow.cn/v1/chat/completions"
const CV_ANALYSIS_MIN_LEN = 12 // below this we never trust LLM output (e.g. ".")
const CV_ANALYSIS_MAX_LEN = 220 // hard truncate for "1 sentence" cap (Adam directive)
const CV_ANALYSIS_DEGEN_REPEAT_THRESHOLD = 10

/**
 * Detect token-level cyclical degeneration (e.g. "Docker, Docker, Docker..." x60).
 *
 * Strategy:
 *   - Lowercase + split on non-word boundaries.
 *   - Count occurrences of every token of length >= 2 (skips ", " noise tokens).
 *   - Trip if ANY single non-stopword token appears >= threshold times.
 *
 * Pure / deterministic. Exported for unit tests.
 */
export function isDegenerateLLMOutput(
  text: string,
  threshold: number = CV_ANALYSIS_DEGEN_REPEAT_THRESHOLD
): boolean {
  if (typeof text !== "string" || text.length === 0) return false
  const tokens = text.toLowerCase().match(/[a-z0-9_+\-#./]{2,}/g) ?? []
  if (tokens.length < threshold) return false
  const counts = new Map<string, number>()
  for (const t of tokens) {
    counts.set(t, (counts.get(t) ?? 0) + 1)
  }
  for (const [, n] of counts) {
    if (n >= threshold) return true
  }
  return false
}

/**
 * Build a deterministic fallback summary line from CV fields when the LLM
 * either fails, returns degenerate output, or returns nothing usable. Pure /
 * deterministic. Exported for unit tests.
 */
export function buildCvAnalysisFallback(
  fields: {
    topSkills?: string[]
    recentRoleTitle?: string
    recentCompany?: string
  },
  _lang: "zh" | "en"
): string {
  const skillsArr = (fields.topSkills ?? [])
    .filter((s): s is string => typeof s === "string" && s.length > 0)
    .slice(0, 5)
  const skills = skillsArr.length > 0 ? skillsArr.join(", ") : ""
  const role = (fields.recentRoleTitle ?? "").trim()
  const company = (fields.recentCompany ?? "").trim()
  const trajectory = role
    ? company
      ? `${role}@${company}`
      : role
    : company
      ? company
      : ""
  if (skills && trajectory) {
    return `From your CV, I see ${skills} + ${trajectory}; I’ll use that as profile evidence.`
  }
  if (skills) return `From your CV, I see hands-on work with ${skills}; I’ll use that as profile evidence.`
  if (trajectory) return `From your CV, I see recent ${trajectory}; I’ll use that as profile evidence.`
  return "I’ll use what I can read from your CV as profile evidence."
}

/** Truncate a summary to MAX_LEN chars on a word boundary, never mid-word. */
function clampCvSummary(text: string): string {
  if (text.length <= CV_ANALYSIS_MAX_LEN) return text
  const slice = text.slice(0, CV_ANALYSIS_MAX_LEN)
  const lastSpace = slice.lastIndexOf(" ")
  return (lastSpace > 40 ? slice.slice(0, lastSpace) : slice).trimEnd()
}

/**
 * iter33 P3 + iter34 H.2/CR1 — Read parsedCandidateResumes for the user, ask
 * Qwen-7B for a 1-2 sentence summary, return it. Returns null when
 * SILICONFLOW_API_KEY is unbound or the CV row doesn't exist (caller / dispatcher
 * falls back to a generic line). On LLM-side problems (non-200, empty completion,
 * degenerate "Docker x60" output) we return a deterministic per-CV fallback
 * line instead so the candidate never sees raw model garbage.
 *
 * Cost: ~$0.0002/call (Qwen2.5-7B SiliconFlow).
 *
 * iter34 H.2 hardening (Adam G5-sim verifying):
 *   - frequency_penalty + presence_penalty against cyclical-attention bug.
 *   - prompt requires >=3 distinct skills covering language + framework/cloud
 *     + tool/infra so the brief reflects the candidate's actual breadth.
 *   - max_tokens lowered to ~120 (1 sentence target).
 *   - response post-checked with isDegenerateLLMOutput; on trip, swap to the
 *     deterministic CV-fields fallback (still returns successfully, never
 *     leaks to the user).
 *   - output truncated to <=220 chars on a word boundary.
 */
function makeGenerateCvAnalysis(): NonNullable<
  import("@pa/pa-orchestrator").OrchestratorStoreDeps["generateCvAnalysis"]
> {
  return async (userId: string, lang: "zh" | "en") => {
    let apiKey = ""
    try {
      apiKey = SILICONFLOW_API_KEY.value().trim()
    } catch {
      // secret not bound — caller falls back
    }
    if (!apiKey) {
      logger.warn("[cv-analysis] SILICONFLOW_API_KEY unbound", { userId })
      return null
    }

    if (!getApps().length) initializeApp()
    const db = getFirestore()

    // Read the most recent parsedCandidateResumes row.
    // iter34 hotfix 2026-05-05 — same fix as generateJobRecs above:
    // cv-ingest writes createdAt (not parsedAt). orderBy was excluding
    // every CV record because parsedAt field doesn't exist.
    let cvFields = ""
    let cvForFallback: {
      topSkills?: string[]
      recentRoleTitle?: string
      recentCompany?: string
    } = {}
    try {
      const snap = await db
        .collection("parsedCandidateResumes")
        .where("userId", "==", userId)
        .orderBy("createdAt", "desc")
        .limit(1)
        .get()
      if (snap.empty) {
        logger.warn("[cv-analysis] no parsedCandidateResumes row", { userId })
        return null
      }
      const cv = snap.docs[0]!.data() as {
        recentRoleTitle?: string
        recentCompany?: string
        topSkills?: string[]
        recentBullet?: string
        resumeText?: string
      }
      cvForFallback = {
        topSkills: Array.isArray(cv.topSkills) ? cv.topSkills : undefined,
        recentRoleTitle: cv.recentRoleTitle,
        recentCompany: cv.recentCompany,
      }
      const parts: string[] = []
      if (cv.recentRoleTitle) parts.push(`recent role: ${cv.recentRoleTitle}`)
      if (cv.recentCompany) parts.push(`@${cv.recentCompany}`)
      if (cv.topSkills?.length) parts.push(`skills: ${cv.topSkills.slice(0, 12).join(", ")}`)
      if (cv.recentBullet) parts.push(`recent: ${cv.recentBullet.slice(0, 200)}`)
      cvFields = parts.join("\n")
      if (!cvFields) {
        // fall back to a small slice of resumeText if no structured fields
        cvFields = (cv.resumeText ?? "").slice(0, 600)
      }
      if (!cvFields) {
        logger.warn("[cv-analysis] CV row had no parseable fields", { userId })
        return null
      }
    } catch (err) {
      logger.error("[cv-analysis] firestore read threw", {
        userId,
        err: err instanceof Error ? err.message : String(err),
      })
      return null
    }

    const langDirective =
      "Reply in English, 1 sentence, friend-tone casual, no bullets, no fluff, do NOT repeat the same token."
    // iter34 H.2 / CR1 — diversity rule. Adam G5 sim showed Qwen-7B picking
    // Azure + Docker only out of 12 distinct CV skills then degenerating into
    // "Docker, Docker, Docker..." x60. Force at least 3 distinct skills
    // covering language + framework/cloud + tool/infra so the brief reflects
    // the candidate's actual breadth.
    const systemPrompt = `You are Claire reading a candidate's resume aloud to them. In ONE concise sentence, name 3+ DISTINCT skills you saw on the CV — covering at least 1 programming language + 1 framework or cloud + 1 tool or infra — and ONE direction you'll lean job recommendations toward. Never repeat the same word more than twice. ${langDirective}`
    const userPrompt = `Resume highlights:\n${cvFields}\n\nGive the candidate your read in 1 sentence (<=180 chars).`

    let summary: string | undefined
    try {
      const res = await fetch(SILICONFLOW_CHAT_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "Qwen/Qwen2.5-7B-Instruct",
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt },
          ],
          // iter34 H.2 / CR1 — penalties block "Docker x60" cyclical attention.
          // SiliconFlow accepts both penalties on Qwen2.5-7B; if the field is
          // unsupported by a future model the call still succeeds (server
          // ignores unknown fields).
          temperature: 0.6,
          frequency_penalty: 0.3,
          presence_penalty: 0.3,
          max_tokens: 120,
          // Stop on common degenerate continuations. Experimental — if the
          // server rejects this field we'll see a 400 and fall through to the
          // deterministic fallback.
          stop: ["[STOP]", "\n\n", "..."],
        }),
        signal: AbortSignal.timeout(8000),
      })
      if (!res.ok) {
        logger.warn("[cv-analysis] siliconflow non-200", {
          userId,
          status: res.status,
        })
      } else {
        const data = (await res.json()) as {
          choices?: { message?: { content?: string } }[]
        }
        summary = data.choices?.[0]?.message?.content?.trim()
      }
    } catch (err) {
      logger.error("[cv-analysis] llm call threw", {
        userId,
        err: err instanceof Error ? err.message : String(err),
      })
    }

    // Validate the LLM output — empty / too short / degenerate → fallback.
    if (!summary || summary.length < CV_ANALYSIS_MIN_LEN) {
      logger.warn("[cv-analysis] empty_or_short_completion_using_fallback", {
        userId,
        len: summary?.length ?? 0,
      })
      return { summary: buildCvAnalysisFallback(cvForFallback, lang) }
    }
    if (isDegenerateLLMOutput(summary)) {
      logger.warn("[cv-analysis] degenerate_output_using_fallback", {
        userId,
        // log a short preview so we can see what tripped the guard.
        preview: summary.slice(0, 80),
        len: summary.length,
      })
      return { summary: buildCvAnalysisFallback(cvForFallback, lang) }
    }
    const clamped = clampCvSummary(summary)
    logger.info("[cv-analysis] ok", { userId, lang, summaryLen: clamped.length })
    return { summary: clamped }
  }
}

/**
 * iter34 P0.2 — generic LLM intent extractor for the 5 non-email
 * deterministic Q's. Adam directive 2026-05-05: not just email — every
 * deterministic question at the start needs this intent extractor.
 *
 * Per-step prompts live inline so each Q has its own canonical value
 * space + clarifying-question style. Returns null on any error so the
 * dispatcher falls back to deterministic re-ask cleanly.
 */
function makeExtractAnswerIntent(): NonNullable<
  import("@pa/pa-orchestrator").OrchestratorStoreDeps["extractAnswerIntent"]
> {
  const stepDefs = {
    ask_q_role: {
      label: "target job role",
      valueSchema:
        '"value":<role token, e.g. "swe" | "pm" | "research" | "design" | "data" | "ops" | "marketing" | "ml" | "founder" | <free-form lowercase phrase>>',
      examples: [
        '"engineer at a startup" → {"intent":"provided","value":"swe","confidence":0.85}',
        '"PM for fintech" → {"intent":"provided","value":"pm","confidence":0.9}',
        '"i do ml infra" → {"intent":"provided","value":"ml","confidence":0.9}',
        '"anything works for me" → {"intent":"unclear","clarifyingQuestion":"roughly which direction? engineering / product / research / design?"}',
      ],
    },
    ask_q_yoe: {
      label: "years of experience",
      valueSchema:
        '"value":<integer years OR "fresh" for fresh-grad / 0 yrs>',
      examples: [
        '"about 5 years" → {"intent":"provided","value":5,"confidence":0.95}',
        '"a little over two years" → {"intent":"provided","value":2,"confidence":0.85}',
        '"just graduated" → {"intent":"provided","value":"fresh","confidence":0.95}',
        '"haven\'t worked yet" → {"intent":"provided","value":"fresh","confidence":0.9}',
        '"a while" → {"intent":"unclear","clarifyingQuestion":"a while is like... 2 years? 5? a number is fine"}',
      ],
    },
    ask_q_visa: {
      label: "US work authorization",
      valueSchema:
        '"value":"citizen" | "gc" | "opt" | "cpt" | "h1b" | "tn" | "sponsorship" | "other"',
      examples: [
        '"i\'m a US citizen" → {"intent":"provided","value":"citizen","confidence":0.95}',
        '"green card" → {"intent":"provided","value":"gc","confidence":0.95}',
        '"need h1b" → {"intent":"provided","value":"h1b","confidence":0.9}',
        '"opt extension" → {"intent":"provided","value":"opt","confidence":0.9}',
        '"i need sponsorship" → {"intent":"provided","value":"sponsorship","confidence":0.85}',
        '"i\'m on a visa" → {"intent":"unclear","clarifyingQuestion":"which visa? e.g. H1B / OPT / other?"}',
      ],
    },
    ask_q_startup_pref: {
      label: "startup vs bigtech preference",
      valueSchema:
        '"value":"startup" | "bigtech" | "either"',
      examples: [
        '"i want to join a startup" → {"intent":"provided","value":"startup","confidence":0.95}',
        '"big company stable" → {"intent":"provided","value":"bigtech","confidence":0.9}',
        '"either is fine" → {"intent":"provided","value":"either","confidence":0.9}',
        '"depends on the team" → {"intent":"provided","value":"either","confidence":0.7}',
      ],
    },
    ask_q_location: {
      label: "target work location",
      valueSchema:
        '"value":<location string, e.g. "sf" | "nyc" | "bay area" | "remote" | "boston" | "seattle" | "la" | "austin" | "chicago" | <free-form>>',
      examples: [
        '"Bay Area" → {"intent":"provided","value":"sf","confidence":0.9}',
        '"i want remote" → {"intent":"provided","value":"remote","confidence":0.95}',
        '"NYC or remote" → {"intent":"provided","value":"nyc or remote","confidence":0.85}',
        '"Seattle" → {"intent":"provided","value":"seattle","confidence":0.95}',
        '"open to opportunities" → {"intent":"unclear","clarifyingQuestion":"roughly which US city/area works? or remote only?"}',
      ],
    },
  } as const

  return async (step, reply, _lang) => {
    let apiKey = ""
    try {
      apiKey = SILICONFLOW_API_KEY.value().trim()
    } catch {
      // not bound — null fallback
    }
    if (!apiKey) {
      logger.warn("[answer-intent] SILICONFLOW_API_KEY unbound", { step })
      return null
    }
    const def = stepDefs[step]
    if (!def) return null
    const langDirective =
      "If the question warrants a clarifying question, ask in English."
    const systemPrompt = `You extract structured intent from a user's reply during onboarding.

Question topic: ${def.label}.

Output JSON ONLY (no prose, no markdown). Two possible intents:
  • {"intent":"provided", ${def.valueSchema}, "confidence":0.0-1.0}
  • {"intent":"unclear", "clarifyingQuestion":"<friendly short follow-up>"}

Rules:
- Confidence reflects how sure you are. Below 0.6 → "unclear" with clarifying question.
- Clarifying question must be SHORT (≤1 sentence), friend-tone, no marketing-speak.
- ${langDirective}
- DO NOT invent specifics the user didn't say.

Examples:
${def.examples.map((e) => `  ${e}`).join("\n")}`

    const userPrompt = `User reply: "${reply}"\n\nOutput JSON:`

    try {
      const res = await fetch("https://api.siliconflow.cn/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "Qwen/Qwen2.5-7B-Instruct",
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt },
          ],
          temperature: 0.1,
          max_tokens: 200,
          response_format: { type: "json_object" },
        }),
        signal: AbortSignal.timeout(6000),
      })
      if (!res.ok) {
        logger.warn("[answer-intent] siliconflow non-200", { step, status: res.status })
        return null
      }
      const data = (await res.json()) as {
        choices?: { message?: { content?: string } }[]
      }
      const raw = data.choices?.[0]?.message?.content?.trim() ?? ""
      let parsed: unknown
      try {
        parsed = JSON.parse(raw)
      } catch {
        logger.warn("[answer-intent] non-JSON output", { step, raw: raw.slice(0, 200) })
        return null
      }
      if (typeof parsed !== "object" || parsed === null) return null
      const obj = parsed as Record<string, unknown>
      if (
        obj.intent === "provided" &&
        (typeof obj.value === "string" || typeof obj.value === "number")
      ) {
        const conf = typeof obj.confidence === "number" ? obj.confidence : 0.5
        return {
          intent: "provided",
          value: obj.value,
          confidence: conf,
        }
      }
      if (obj.intent === "unclear" && typeof obj.clarifyingQuestion === "string") {
        return {
          intent: "unclear",
          clarifyingQuestion: obj.clarifyingQuestion.slice(0, 200),
        }
      }
      logger.warn("[answer-intent] unrecognized shape", { step, obj })
      return null
    } catch (err) {
      logger.error("[answer-intent] llm call threw", {
        step,
        err: err instanceof Error ? err.message : String(err),
      })
      return null
    }
  }
}

/**
 * No-regex (2026-05-30) — LLM match-FEEDBACK classifier for the post-match
 * retention FSM. Returns the parsed JSON (the orchestrator's
 * `validateFeedbackResult` validates it against the shared-tags closed enums).
 * THROWS on any provider/parse failure so the FSM fails OPEN to `ambiguous`
 * (re-asks) instead of regex-classifying the reply.
 */
function makeClassifyFeedback(): NonNullable<
  import("@pa/pa-orchestrator").OrchestratorStoreDeps["classifyFeedback"]
> {
  return async ({ prompt }) => {
    let apiKey = ""
    try {
      apiKey = SILICONFLOW_API_KEY.value().trim()
    } catch {
      // not bound
    }
    if (!apiKey) throw new Error("siliconflow_unbound")
    const res = await fetch("https://api.siliconflow.cn/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "Qwen/Qwen2.5-7B-Instruct",
        messages: [
          {
            role: "system",
            content:
              "You classify match-feedback replies into structured JSON. Output JSON only — no prose.",
          },
          { role: "user", content: prompt },
        ],
        temperature: 0,
        max_tokens: 300,
        response_format: { type: "json_object" },
      }),
      signal: AbortSignal.timeout(6000),
    })
    if (!res.ok) throw new Error(`siliconflow non-200 status=${res.status}`)
    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] }
    const raw = data.choices?.[0]?.message?.content?.trim() ?? "{}"
    return { json: JSON.parse(raw) }
  }
}
