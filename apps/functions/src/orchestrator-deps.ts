/**
 * iter32 deploy-fix 2026-05-04 — shared Mailgun deps + secret bindings.
 *
 * Lifted out of index.ts so both:
 *   - apps/functions/src/index.ts  (production iMessage onPaInbound path)
 *   - apps/functions/src/admin-bootstrap.ts  (paAdminBootstrap simulator)
 *
 * can import the SAME defineSecret() bindings + the SAME makeOrchestratorDeps()
 * factory and both can list MAILGUN_* in their function `secrets:` array.
 *
 * Previously these lived in index.ts and admin-bootstrap.ts had no way to
 * import them without a circular dep (index.ts re-exports paAdminBootstrap).
 * The result was that the simulator's `defaultOrchestrator` ended up with
 * `store.sendVerificationEmail = undefined` even though Mailgun secrets were
 * set in Secret Manager — the dispatcher then took the
 * "Mailgun unconfigured" graceful fallback and advanced state to `complete`
 * without `contactEmailVerifiedAt`.
 */
import { defineSecret } from "firebase-functions/params"
import { logger } from "firebase-functions/v2"
import { initializeApp, getApps } from "firebase-admin/app"
import { getFirestore } from "firebase-admin/firestore"
import {
  generateVerificationCode,
  sendVerificationEmail as sendVerificationEmailViaMailgun,
} from "./email/mailgun.js"

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

const nowIso = () => new Date().toISOString()

/**
 * Build orchestrator callbacks. Mailgun only gates email verification; it
 * must not disable unrelated runtime capabilities like CV analysis, answer
 * extraction, or explicit job recommendations.
 */
export function makeOrchestratorDeps(): import("@pa/pa-orchestrator").OrchestratorStoreDeps {
  let mailgunApiKey = ""
  let mailgunDomain = ""
  let mailgunFrom = ""
  let mailgunRegion: "us" | "eu" | undefined
  try {
    mailgunApiKey = MAILGUN_API_KEY.value().trim()
    mailgunDomain = MAILGUN_DOMAIN.value().trim()
    mailgunFrom = MAILGUN_FROM.value().trim()
    const region = MAILGUN_REGION.value().trim().toLowerCase()
    mailgunRegion = region === "eu" ? "eu" : "us"
  } catch {
    // Secret not bound to this function (or unset entirely) → return empty
    // deps so the dispatcher takes the graceful fallback path.
  }
  const deps: import("@pa/pa-orchestrator").OrchestratorStoreDeps = {
    generateCvAnalysis: makeGenerateCvAnalysis(),
    generateJobRecs: makeGenerateJobRecs(),
    extractEmailIntent: makeExtractEmailIntent(),
    extractAnswerIntent: makeExtractAnswerIntent(),
  }

  if (mailgunApiKey && mailgunDomain && mailgunFrom) {
    const cfg = {
      apiKey: mailgunApiKey,
      domain: mailgunDomain,
      from: mailgunFrom,
      region: mailgunRegion,
    }
    deps.sendVerificationEmail = async (email: string) => {
      const code = generateVerificationCode()
      const sentAt = nowIso()
      const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString()
      try {
        const result = await sendVerificationEmailViaMailgun(cfg, {
          to: email,
          code,
        })
        if (!result.ok) {
          logger.warn("[mailgun] send failed", {
            email,
            status: result.status,
            response: result.rawResponse?.slice(0, 200),
          })
          return null
        }
        return {
          rawCode: code,
          sentAt,
          expiresAt,
          ...(result.messageId ? { providerMessageId: result.messageId } : {}),
        }
      } catch (err) {
        logger.error("[mailgun] send threw", {
          email,
          err: err instanceof Error ? err.message : String(err),
        })
        return null
      }
    }
  }

  // Note: getUserCvParsed is already implemented in
  // packages/pa-orchestrator/src/index.ts:3777 inside
  // createFirestoreOrchestratorStore — no override needed here.
  return deps
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
  return async (userId: string, lang: "zh" | "en", opts?: { force?: boolean }) => {
    if (!getApps().length) initializeApp()
    const db = getFirestore()

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
      const { queryMatchingJobsV16 } = await import("@pa/job-rec")
      // V16 reads `pa-users/{userId}.tags` directly; no `filters` needed.
      // limit=10 retains the wider window so we can fire-and-forget
      // llmRerank against the top-5 (next-batch cache).
      const out = await queryMatchingJobsV16(
        { userId, limit: 10, lang },
        {
          db,
          log: (event, payload) =>
            logger.info("[job-recs][v16]", { event, ...(payload ?? {}) }),
        }
      )
      if (out.noUserTags) {
        logger.info("[job-recs] no pa-users.tags — fallback", { userId })
        return null
      }
      const jobs = out.jobs ?? []
      if (jobs.length === 0) {
        logger.info("[job-recs] no matches in corpus", {
          userId,
          total: out.total,
          dropped: out.dropped,
          hardFilter: out.hardFilter,
        })
        return null
      }
      const visibleJobs = jobs.slice(0, 2)

      // v1.7 hotfix — LLM-composed nuanced reasoning for top-2.
      // Replaces V16 template "为啥推: skill X+Y 跟 JD 核心技能对得上"
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
          const reasons = await Promise.all(
            visibleJobs.map((j) =>
              composeNuancedReason(
                {
                  lang,
                  workHistory: wh.slice(0, 3),
                  projects: projects.slice(0, 2),
                  topSkills: topSkills.slice(0, 12),
                  job: {
                    title: j.jobTitle,
                    company: j.companyName ?? null,
                    requiredSkills: j.requiredSkills ?? null,
                    seniorityLevel: (j as { seniorityLevel?: string | null }).seniorityLevel ?? null,
                    jobDescription: (j as { jobDescription?: string | null }).jobDescription ?? null,
                  },
                  matchedSkills:
                    (j as { matchedSkills?: Array<{ name: string; proficiency?: string }> }).matchedSkills ?? [],
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

      const lines: string[] = []
      lines.push(lang === "zh" ? "先给你看两个对得上的岗位:" : "two roles that line up for you:")
      for (let i = 0; i < visibleJobs.length; i++) {
        const j = visibleJobs[i]!
        const tag = j.companyName ? ` @ ${j.companyName}` : ""
        // V16 hard-filter already drops jobright.ai URLs + jobs without
        // atsApplyUrl. So `j.atsApplyUrl` is non-empty here. We DROP
        // the legacy primaryUrl fallback (was the jobright leak source).
        const url = j.atsApplyUrl ? `\n${j.atsApplyUrl}` : ""
        // Prefer LLM-composed nuanced reason; fall back to V16 template.
        const nuanced = visibleReasons[i]
        const reason = nuanced && nuanced.length > 0
          ? `${lang === "zh" ? "为啥推" : "why"}: ${nuanced}`
          : j.reason ?? ""
        const reasonLine = reason ? `\n${reason}` : ""
        lines.push(`• ${j.jobTitle}${tag}${url}${reasonLine}`)
      }
      lines.push(
        // iter34 hotfix 2026-05-05 — Adam directive on phrasing.
        lang === "zh"
          ? "先看看, 不准就告诉我我再找; 之后每天会再给你新的"
          : "see if these fit — if not lmk, i'll keep digging; daily fresh batch from here"
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
        visible: visibleJobs.length,
        total: out.total,
        dropped: out.dropped,
        llmCacheStale: out.llmCacheStale ?? false,
      })
      return { message: lines.join("\n"), recCount: visibleJobs.length }
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
  lang: "zh" | "en"
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
  if (lang === "zh") {
    if (skills && trajectory) {
      return `看下来你: ${skills} + ${trajectory} — 推岗位贴这个方向`
    }
    if (skills) return `看下来你 hands-on: ${skills} — 推岗位贴这个方向`
    if (trajectory) return `看下来你最近: ${trajectory} — 推岗位贴这个方向`
    return "先按你 CV 上的方向给你找几个岗位看看"
  }
  if (skills && trajectory) {
    return `from your CV: ${skills} + ${trajectory} — i'll lean recs that way`
  }
  if (skills) return `from your CV: hands-on with ${skills} — i'll lean recs that way`
  if (trajectory) return `from your CV: recent ${trajectory} — i'll lean recs that way`
  return "i'll lean job recs toward what's on your CV"
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
      lang === "zh"
        ? "用中文回，1 句话，朋友语气，不要列表，不要客套，不要重复同一个 token。"
        : "Reply in English, 1 sentence, friend-tone casual, no bullets, no fluff, do NOT repeat the same token."
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
 * iter34 P0 — LLM-fallback email intent extractor.
 *
 * Adam directive 2026-05-05 ("edge case 处理应该是能 involve llm啊 ...
 * 一个认证过程"): when the regex parser fails on q_email, escalate to
 * Qwen-7B for intent extraction. Returns structured {intent, ...} so the
 * deterministic dispatcher can route precisely.
 *
 * Cost: ~$0.0002 per edge call. Latency: <2s p99. Safe to fail (returns
 * null on any error) — caller falls back to deterministic typo map +
 * generic re-ask, so onboarding always advances.
 */
function makeExtractEmailIntent(): NonNullable<
  import("@pa/pa-orchestrator").OrchestratorStoreDeps["extractEmailIntent"]
> {
  return async (reply, lang) => {
    let apiKey = ""
    try {
      apiKey = SILICONFLOW_API_KEY.value().trim()
    } catch {
      // secret not bound — caller falls back
    }
    if (!apiKey) {
      logger.warn("[email-intent] SILICONFLOW_API_KEY unbound")
      return null
    }

    const systemPrompt = `You extract email intent from a user's reply during an onboarding flow.

The user was asked for their email. Their reply might be:
- A clean valid email → output {"intent":"provided", "email":"...", "confidence":0.0-1.0}
- A typo'd or non-existent domain (gmal.com, gmial.com, yangoo.com, etc.) → output {"intent":"typo", "original":"<as typed>", "suggestion":"<corrected>"}
- A decline / skip / "I'd rather not" / "later" → output {"intent":"declined"}
- Ambiguous / unclear / asking back / random unrelated → output {"intent":"unclear", "clarifyingQuestion":"<short ${lang === "zh" ? "Chinese" : "English"} clarifying question, friend tone, no marketing-speak>"}

Rules:
- ALWAYS output valid JSON. NO prose, NO markdown, NO commentary.
- For "provided", confidence 0.0-1.0 reflects how sure you are it's a real address (e.g. "john at gmail dot com" → confidence ~0.85, suggest only if extracted).
- For "typo", original = what user typed, suggestion = canonical (gmail.com / yahoo.com / outlook.com / hotmail.com / icloud.com).
- For "unclear", clarifyingQuestion is friendly, short (1 sentence), in ${lang === "zh" ? "Chinese" : "English"}.
- DO NOT invent emails. If user describes an email without typing one ("send to my work one"), output unclear with clarifying question.`

    const userPrompt = `User reply (after being asked for their email): "${reply}"\n\nOutput JSON:`

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
        logger.warn("[email-intent] siliconflow non-200", { status: res.status })
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
        logger.warn("[email-intent] non-JSON output", { raw: raw.slice(0, 200) })
        return null
      }
      if (typeof parsed !== "object" || parsed === null) return null
      const obj = parsed as Record<string, unknown>
      // Validate shape per intent
      if (obj.intent === "provided" && typeof obj.email === "string") {
        const conf = typeof obj.confidence === "number" ? obj.confidence : 0.5
        // Sanity-check the LLM didn't hallucinate something non-email.
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(obj.email)) return null
        if (conf < 0.6) {
          // Low confidence → don't auto-advance, escalate to clarify
          return {
            intent: "unclear",
            clarifyingQuestion:
              lang === "zh"
                ? `${obj.email} 这个对吗? 不对的话直接发给我`
                : `is ${obj.email} right? send the correct one if not`,
          }
        }
        return { intent: "provided", email: obj.email.toLowerCase(), confidence: conf }
      }
      if (
        obj.intent === "typo" &&
        typeof obj.original === "string" &&
        typeof obj.suggestion === "string"
      ) {
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(obj.suggestion)) return null
        return {
          intent: "typo",
          original: obj.original,
          suggestion: obj.suggestion.toLowerCase(),
        }
      }
      if (obj.intent === "declined") {
        return { intent: "declined" }
      }
      if (obj.intent === "unclear" && typeof obj.clarifyingQuestion === "string") {
        return {
          intent: "unclear",
          clarifyingQuestion: obj.clarifyingQuestion.slice(0, 200),
        }
      }
      logger.warn("[email-intent] unrecognized shape", { obj })
      return null
    } catch (err) {
      logger.error("[email-intent] llm call threw", {
        err: err instanceof Error ? err.message : String(err),
      })
      return null
    }
  }
}

/**
 * iter34 P0.2 — generic LLM intent extractor for the 5 non-email
 * deterministic Q's. Adam directive 2026-05-05: "不只是 email, 包括所有
 * 一开始的 deterministic 的 question 都需要加这个".
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
        '"我做 ml infra 的" → {"intent":"provided","value":"ml","confidence":0.9}',
        '"我什么都行" → {"intent":"unclear","clarifyingQuestion":"那大致偏哪个方向? 工程 / 产品 / 研究 / 设计?"}',
      ],
    },
    ask_q_yoe: {
      label: "years of experience",
      valueSchema:
        '"value":<integer years OR "fresh" for fresh-grad / 0 yrs>',
      examples: [
        '"about 5 years" → {"intent":"provided","value":5,"confidence":0.95}',
        '"两年多" → {"intent":"provided","value":2,"confidence":0.85}',
        '"刚毕业" → {"intent":"provided","value":"fresh","confidence":0.95}',
        '"还没工作过" → {"intent":"provided","value":"fresh","confidence":0.9}',
        '"a while" → {"intent":"unclear","clarifyingQuestion":"a while is like... 2 years? 5? a number is fine"}',
      ],
    },
    ask_q_visa: {
      label: "US work authorization",
      valueSchema:
        '"value":"citizen" | "gc" | "opt" | "cpt" | "h1b" | "tn" | "sponsorship" | "other"',
      examples: [
        '"i\'m a US citizen" → {"intent":"provided","value":"citizen","confidence":0.95}',
        '"绿卡" → {"intent":"provided","value":"gc","confidence":0.95}',
        '"need h1b" → {"intent":"provided","value":"h1b","confidence":0.9}',
        '"opt extension" → {"intent":"provided","value":"opt","confidence":0.9}',
        '"i need sponsorship" → {"intent":"provided","value":"sponsorship","confidence":0.85}',
        '"i\'m on a visa" → {"intent":"unclear","clarifyingQuestion":"哪种签证? 比如 H1B / OPT / 其他?"}',
      ],
    },
    ask_q_startup_pref: {
      label: "startup vs bigtech preference",
      valueSchema:
        '"value":"startup" | "bigtech" | "either"',
      examples: [
        '"想去创业公司" → {"intent":"provided","value":"startup","confidence":0.95}',
        '"big company stable" → {"intent":"provided","value":"bigtech","confidence":0.9}',
        '"都行" → {"intent":"provided","value":"either","confidence":0.9}',
        '"看具体团队" → {"intent":"provided","value":"either","confidence":0.7}',
      ],
    },
    ask_q_location: {
      label: "target work location",
      valueSchema:
        '"value":<location string, e.g. "sf" | "nyc" | "bay area" | "remote" | "boston" | "seattle" | "la" | "china" | "shanghai" | "beijing" | "hangzhou" | <free-form>>',
      examples: [
        '"Bay Area" → {"intent":"provided","value":"sf","confidence":0.9}',
        '"想做远程" → {"intent":"provided","value":"remote","confidence":0.95}',
        '"NYC or remote" → {"intent":"provided","value":"nyc or remote","confidence":0.85}',
        '"上海" → {"intent":"provided","value":"shanghai","confidence":0.95}',
        '"看机会" → {"intent":"unclear","clarifyingQuestion":"大致哪个城市/地区方便? 或者只看远程?"}',
      ],
    },
  } as const

  return async (step, reply, lang) => {
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
      lang === "zh"
        ? "If the question warrants a clarifying question, ask in Chinese."
        : "If the question warrants a clarifying question, ask in English."
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
