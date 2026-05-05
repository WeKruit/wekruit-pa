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

// iter33 P3 — SiliconFlow API key (already used by other Qwen-7B paths in
// this repo). Reused here for the CV-analysis brief.
const SILICONFLOW_API_KEY: SecretParamHandle = defineSecret("SILICONFLOW_API_KEY")
export const CV_ANALYSIS_SECRETS: SecretParamHandle[] = [SILICONFLOW_API_KEY]

const nowIso = () => new Date().toISOString()

/**
 * Build a `sendVerificationEmail` callback for the orchestrator store, or
 * return `{}` when secrets are unset (graceful fallback for biz testers
 * before Mailgun is provisioned). Called per-inbound so secret values are
 * read fresh; cheap because defineSecret().value() is cached by Cloud
 * Functions.
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
  if (!mailgunApiKey || !mailgunDomain || !mailgunFrom) {
    return {}
  }
  const cfg = {
    apiKey: mailgunApiKey,
    domain: mailgunDomain,
    from: mailgunFrom,
    region: mailgunRegion,
  }
  return {
    sendVerificationEmail: async (email: string) => {
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
    },
    generateCvAnalysis: makeGenerateCvAnalysis(),
    generateJobRecs: makeGenerateJobRecs(),
    extractEmailIntent: makeExtractEmailIntent(),
    extractAnswerIntent: makeExtractAnswerIntent(),
  }
}

/**
 * iter33 P4 + GAP 1 — produce the 2-job-rec push message before complete.
 *
 * Live inline matching: read user's parsedCandidateResumes (top skills +
 * preferred industry tags), pa-users.statedPreferences (visa, location,
 * startup pref), then call `queryMatchingJobs` with limit=2 to fetch top
 * matches against the active corpus. Formats the result into a single
 * iMessage-shaped reply with title + company + URL per job.
 *
 * Fail-OPEN: any error path (CV not parsed, no matches in corpus, query
 * threw, recent batch already sent) → return null and the deterministic
 * dispatcher emits the deferred-promise fallback ("first batch tomorrow
 * ~9am") so onboarding ALWAYS completes.
 */
function makeGenerateJobRecs(): NonNullable<
  import("@pa/pa-orchestrator").OrchestratorStoreDeps["generateJobRecs"]
> {
  return async (userId: string, lang: "zh" | "en") => {
    if (!getApps().length) initializeApp()
    const db = getFirestore()

    // Skip live match when daily batch already sent recs in the last 24h.
    try {
      const profile = await db.collection("pa-job-profiles").doc(userId).get()
      if (profile.exists) {
        const data = profile.data() as { lastJobBatchSentAt?: string }
        const sentAt = data.lastJobBatchSentAt
        if (sentAt) {
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

    // Read CV for skills + statedPreferences for visa/location/startup.
    // iter34 hotfix 2026-05-05 — Adam LIVE bug "为什么匹配出问题了". RCA:
    // cv-ingest writes `createdAt` (Firestore Timestamp) + `ingestedAt`
    // (ISO), but this orderBy was using non-existent `parsedAt` field.
    // Firestore orderBy EXCLUDES docs missing the field → cvSnap always
    // empty → topSkills/industryTags=[] → return null fallback. Even
    // when Adam had 5 valid CV docs, generateJobRecs saw "no CV signal".
    // Fix: orderBy("createdAt") — the field cv-ingest actually writes.
    let topSkills: string[] = []
    let industryTags: string[] = []
    try {
      const cvSnap = await db
        .collection("parsedCandidateResumes")
        .where("userId", "==", userId)
        .orderBy("createdAt", "desc")
        .limit(1)
        .get()
      if (!cvSnap.empty) {
        const cv = cvSnap.docs[0]!.data() as {
          topSkills?: unknown
          industryTags?: unknown
        }
        if (Array.isArray(cv.topSkills)) {
          topSkills = cv.topSkills.filter(
            (s): s is string => typeof s === "string" && s.length > 0
          )
        }
        if (Array.isArray(cv.industryTags)) {
          industryTags = cv.industryTags.filter(
            (s): s is string => typeof s === "string" && s.length > 0
          )
        }
      }
    } catch (err) {
      logger.warn("[job-recs] CV read failed", {
        userId,
        err: err instanceof Error ? err.message : String(err),
      })
    }

    let visa: string | undefined
    let location: string | undefined
    let prefersStartup: boolean | null | undefined
    try {
      const userDoc = await db.collection("pa-users").doc(userId).get()
      if (userDoc.exists) {
        const u = userDoc.data() as {
          statedPreferences?: {
            visaStatus?: string
            targetLocations?: string[]
            prefersStartup?: boolean | null
          }
        }
        visa = u.statedPreferences?.visaStatus
        location = u.statedPreferences?.targetLocations?.[0]
        prefersStartup = u.statedPreferences?.prefersStartup
      }
    } catch (err) {
      logger.warn("[job-recs] user read failed", {
        userId,
        err: err instanceof Error ? err.message : String(err),
      })
    }

    // Map visa → sponsorship filter (matches QueryMatchingJobs schema).
    let sponsorship: "h1b" | "gc" | "none" | undefined
    if (visa === "h1b" || visa === "opt" || visa === "sponsorship_needed") {
      sponsorship = "h1b"
    } else if (visa === "citizen" || visa === "gc") {
      sponsorship = "none"
    }

    const sizePreference: "startup" | "bigtech" | "either" | undefined =
      prefersStartup === true
        ? "startup"
        : prefersStartup === false
          ? "bigtech"
          : undefined

    const filters = {
      ...(industryTags.length > 0 ? { industryTags } : {}),
      ...(topSkills.length > 0 ? { userSkills: topSkills } : {}),
      ...(sponsorship ? { sponsorship } : {}),
      ...(sizePreference ? { sizePreference } : {}),
      ...(location ? { location } : {}),
    }

    if (!topSkills.length && !industryTags.length) {
      // No CV signal — can't usefully rank. Dispatcher fallback.
      logger.info("[job-recs] no CV signal — fallback", { userId })
      return null
    }

    try {
      const { queryMatchingJobs } = await import("@pa/job-rec")
      const out = await queryMatchingJobs(
        { filters, limit: 2 },
        { db, log: () => {} }
      )
      const jobs = out.jobs ?? []
      if (jobs.length === 0) {
        logger.info("[job-recs] no matches in corpus", { userId, filters })
        return null
      }
      const lines: string[] = []
      lines.push(lang === "zh" ? "先给你看两个对得上的岗位:" : "two roles that line up for you:")
      for (const j of jobs) {
        const tag = j.companyName ? ` @ ${j.companyName}` : ""
        const url = j.primaryUrl ? `\n${j.primaryUrl}` : ""
        lines.push(`• ${j.jobTitle}${tag}${url}`)
      }
      lines.push(
        // iter34 hotfix 2026-05-05 — Adam directive on phrasing.
        lang === "zh"
          ? "先看看, 不准就告诉我我再找; 之后每天会再给你新的"
          : "see if these fit — if not lmk, i'll keep digging; daily fresh batch from here"
      )
      return { message: lines.join("\n"), recCount: jobs.length }
    } catch (err) {
      logger.warn("[job-recs] queryMatchingJobs threw", {
        userId,
        err: err instanceof Error ? err.message : String(err),
      })
      return null
    }
  }
}

/**
 * iter33 P3 — Read parsedCandidateResumes for the user, ask Qwen-7B for
 * a 1-2 sentence summary, return it. Returns null when SILICONFLOW_API_KEY
 * is unbound, the CV row doesn't exist, or the LLM call throws — caller
 * (deterministic dispatcher) falls back to a generic line so onboarding
 * always completes. Cost: ~$0.0002/call (Qwen2.5-7B SiliconFlow).
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
      const parts: string[] = []
      if (cv.recentRoleTitle) parts.push(`recent role: ${cv.recentRoleTitle}`)
      if (cv.recentCompany) parts.push(`@${cv.recentCompany}`)
      if (cv.topSkills?.length) parts.push(`skills: ${cv.topSkills.slice(0, 8).join(", ")}`)
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
        ? "用中文回，1-2 句，朋友语气，不要列表，不要客套。"
        : "Reply in English, 1-2 sentences, friend-tone casual, no bullets, no fluff."
    const systemPrompt = `You are Claire reading a candidate's resume aloud to them. Highlight ONE concrete strength (specific skill or trajectory) you noticed and ONE direction you'll lean job recommendations toward. ${langDirective}`
    const userPrompt = `Resume highlights:\n${cvFields}\n\nGive the candidate your read in 1-2 sentences.`

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
          temperature: 0.6,
          max_tokens: 160,
        }),
        signal: AbortSignal.timeout(8000),
      })
      if (!res.ok) {
        logger.warn("[cv-analysis] siliconflow non-200", {
          userId,
          status: res.status,
        })
        return null
      }
      const data = (await res.json()) as {
        choices?: { message?: { content?: string } }[]
      }
      const summary = data.choices?.[0]?.message?.content?.trim()
      if (!summary) {
        logger.warn("[cv-analysis] empty completion", { userId })
        return null
      }
      logger.info("[cv-analysis] ok", { userId, lang, summaryLen: summary.length })
      return { summary }
    } catch (err) {
      logger.error("[cv-analysis] llm call threw", {
        userId,
        err: err instanceof Error ? err.message : String(err),
      })
      return null
    }
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
