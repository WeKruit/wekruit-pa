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
  }
}

/**
 * iter33 P4 — produce the 2-job-rec push message before complete.
 *
 * Current implementation: always returns null → caller emits the
 * deferred-promise fallback ("first batch tomorrow ~9am"). Reason: at
 * onboard time the daily-batch matching pipeline (paJobRecDaily) hasn't
 * run for this user yet, so there are no live matches to surface. The
 * batch runs at 09:00 PT and writes top-K matches via sendImessage
 * directly (no persistent top-N rec list to read inline).
 *
 * Follow-up (iter34): trigger an inline single-user match when the user
 * onboards outside the daily window, so they get matches immediately. For
 * now the deferred-promise sets clear expectations + onboarding always
 * completes.
 */
function makeGenerateJobRecs(): NonNullable<
  import("@pa/pa-orchestrator").OrchestratorStoreDeps["generateJobRecs"]
> {
  return async (userId: string, _lang: "zh" | "en") => {
    if (!getApps().length) initializeApp()
    const db = getFirestore()
    try {
      // Check if user has a recent batch — if so, point them to it.
      const profile = await db.collection("pa-job-profiles").doc(userId).get()
      if (profile.exists) {
        const data = profile.data() as { lastJobBatchSentAt?: string }
        const sentAt = data.lastJobBatchSentAt
        if (sentAt) {
          const ageHours = (Date.now() - Date.parse(sentAt)) / (3600 * 1000)
          if (ageHours < 24) {
            logger.info("[job-recs] recent batch already sent", {
              userId,
              ageHours,
            })
            // Defer to dispatcher's fallback message — no need to repeat
            // recs since user just got them.
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
    // Default: dispatcher fallback (deferred-promise message).
    return null
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
    let cvFields = ""
    try {
      const snap = await db
        .collection("parsedCandidateResumes")
        .where("userId", "==", userId)
        .orderBy("parsedAt", "desc")
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
