/**
 * v1.7 Phase 70 hotfix — LLM-composed nuanced match reasoning.
 *
 * Replaces V16's template "为啥推: skill X+Y 跟 JD 核心技能对得上" with a
 * personalized 1-sentence reason citing WHICH past experience bridges to
 * THIS job. Pulls work history + projects from parsedCandidateResumes,
 * matched skills from V16 score breakdown, JD body from matching-jobs.
 *
 * Pattern: "你在 [companyA] 用 [skillX] 做 [projectY], 跟这岗位的
 * [JD-requirement] 对得上"
 *
 * NOT: "你的 javascript+python 跟 JD 核心技能对得上" (the v1.6 template).
 *
 * Cost: gpt-5.4-nano ~30 tokens per call × 2 jobs = ~$0.0001 per match
 *       email. Negligible.
 *
 * Latency: ~300-600ms per call. Live path: tolerable since match emails
 * are fire-and-forget. Total path remains <2s for 2-job render.
 *
 * Fail-graceful: any LLM error → fall back to V16 template `j.reason`.
 */

import { logger } from "firebase-functions/v2"
import { callWithFallback } from "@pa/pa-resume-parser"
import type { OpenAIResponsesClient, AnthropicMessagesClient } from "@pa/pa-resume-parser"

export interface CvWorkExperience {
  title?: string | null
  company?: string | null
  bullets?: string[] | null
  description?: string | null
}

export interface CvProject {
  name?: string | null
  description?: string | null
  technologies?: string[] | null
}

export interface NuancedReasonInput {
  /** User's preferred lang — drives prompt style + output language. */
  lang: "zh" | "en"
  /** Top-3 most recent work experiences from parsedCandidateResumes. */
  workHistory: CvWorkExperience[]
  /** Top-2 projects from parsedCandidateResumes (optional, for student / new-grad). */
  projects?: CvProject[]
  /** User's full skill list (for LLM to pick the most-relevant bridge). */
  topSkills: string[]
  /** Job to compose reason for. */
  job: {
    title: string
    company: string | null
    requiredSkills?: string[] | null
    seniorityLevel?: string | null
    jobDescription?: string | null
    /** Company stage / size signal (e.g. "early_startup", "scale_up", "enterprise"). */
    companyStage?: string | null
    /** Industry sector tokens (canonical 42-vocab). */
    industry?: string[] | null
    /** Location (raw or bucketed). */
    location?: string | null
  }
  /** Top-2 matched skills from V16 (sanity check that LLM doesn't hallucinate). */
  matchedSkills: Array<{ name: string; proficiency?: string }>
  /**
   * The candidate's STATED priorities — what they said matters most (comp,
   * equity, growth, mission, WLB, remote…). Sourced from `tags.targetCompanyTags`
   * / main-goal. Drives the "it leans into the X you said matter most" angle that
   * Adam flagged as missing. Optional.
   */
  candidatePriorities?: string[]
  /** Candidate's canonical seniority/careerStage token, for the seniority-fit angle. */
  candidateSeniority?: string | null
}

const SYSTEM_PROMPT_ZH = `你是一个 Career Advisor / 招聘 broker。看候选人的简历经历 + 这个岗位 + 候选人最看重什么, 写一段有说服力、具体的中文推荐理由。

规则:
- 1-2 句话, 共 40-70 字
- 必须引用候选人的具体公司/项目/技能栈 (e.g., "你在 Tesla 做的 V&C 后台 300+ 门店", "你的 React/TS + 后端底子")
- 引用 1-2 个跟岗位需求对得上的具体技能 (从他真用过的技能里选)
- 如果级别对得上 (junior/senior 等)、公司阶段对 (早期/扩张期)、行业对、地点对 — 自然带一句
- 如果给了候选人「最看重的东西」(comp/equity/growth/mission 等), 必须有一句点出这岗位踩中了这些点 (e.g. "而且它正好踩中你最看重的薪资 + 早期股权")
- 中文口语化, 不写"具备""掌握"这种简历腔, 不写"完美契合"这种空话
- 不要前缀"为啥推"或类似 — 只写理由本身
- 只能用给你的真实信息, 不要编造公司细节

格式: 返回 JSON: { "reason": "<理由>" }

例:
- "你在 Tesla 用 Node.js + React 撑过 300+ 门店的 V&C 后台, 这个早期 SF 创业公司的全栈岗规模 + 栈都对得上, 而且它正好踩中你最看重的薪资 + 早期股权。"
- "你 ESL 那个 Dynamic Knowledge Tracing 的 PyTorch 模型, 跟这家做的 LLM 微调方向能直接迁移, 级别也是你现在的 mid 级。"`

const SYSTEM_PROMPT_EN = `You are a recruiter / career broker. Look at the candidate's resume experience + this specific job + what the candidate said matters most, and write a compelling, specific rec reason in English.

Rules:
- 1-2 sentences, ~20-40 words total
- MUST cite the candidate's specific company/project/stack (e.g., "your Tesla V&C backend serving 300+ stores", "your React/TS + backend background")
- Cite 1-2 specific skills that bridge to the JD (only skills they actually used)
- When they line up, naturally weave in: the seniority fit (junior/senior), the company stage (early-stage / fast-scaling), the industry, or the location
- If the candidate's STATED priorities are provided (comp / equity / growth / mission / remote…), you MUST include a clause noting the role leans into them — e.g. "and it leans into the comp + early equity you said matter most"
- Casual, confident, specific — NOT resume-speak ("possess", "demonstrate") and NOT empty hype ("perfect fit", "excellent match")
- No "Why match:" prefix — just the reason
- Use ONLY the real facts given; never invent company claims

Format: Return JSON: { "reason": "<reason>" }

Examples:
- "Full-stack product role at an early-stage SF startup — your React/TS + backend background fits the stack, the junior level lines up, and it leans into the comp + early equity you said matter most."
- "Your ESL Dynamic Knowledge Tracing model in PyTorch transfers cleanly to their LLM fine-tuning work, and the mid-level seniority matches where you are now."`

// 2026-05-07 Bug D true root cause v3 (Adam: "为什么不是同一个 interface")
// — composeNuancedReason was a SDK-level OpenAI island: imported `openai`
// directly, hardcoded model strings, manual fallback chain, manual key
// resolution. CV parse + sponsorship inference + industry-second-pass all
// run through the unified `callWithFallback` 3-tier router from
// `@pa/pa-resume-parser` (gpt-5.4-nano → claude-sonnet-4-6 → gpt-4.1-mini)
// — those paths never 401. This function bypassed the router and got
// orphaned. Refactor: route through `callWithFallback` with a 1-field
// json schema. Auto-inherits 3-tier fallback, retry, key handling, and
// future provider/model rotations.
const NUANCED_REASON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["reason"],
  properties: {
    reason: {
      type: "string",
      description: "1-sentence personalized recommendation reason citing specific work experience or project + bridging skill.",
    },
  },
} as const

export interface ComposeNuancedReasonConfig {
  openaiApiKey: string
  /** Optional Anthropic key — when present, callWithFallback will use Sonnet middle tier. */
  anthropicApiKey?: string
  /** Test seam — passed through to router. */
  clientFactory?: (init: { apiKey: string; baseURL?: string; maxRetries?: number }) => OpenAIResponsesClient | Promise<OpenAIResponsesClient>
  anthropicClientFactory?: (init: { apiKey: string; baseURL?: string; maxRetries?: number }) => AnthropicMessagesClient | Promise<AnthropicMessagesClient>
}

export async function composeNuancedReason(
  input: NuancedReasonInput,
  config: ComposeNuancedReasonConfig
): Promise<string | null> {
  if (!config.openaiApiKey) return null
  // Defense-in-depth: SiliconFlow key (sf-...) accidentally passed via the
  // overloaded `process.env.OPENAI_API_KEY` (apps/functions/src/index.ts
  // :1258 sets it to SILICONFLOW_API_KEY when unset) → OpenAI 401 with
  // empty body. Reject upfront with clear log signal.
  if (!config.openaiApiKey.startsWith("sk-")) {
    logger.warn("pa.match.nuanced_reason_wrong_key_prefix", {
      prefix: config.openaiApiKey.slice(0, 5),
    })
    return null
  }

  // Compose user-text payload — terse, structured.
  const wh = input.workHistory.slice(0, 3).map((e) => {
    const bullets = (e.bullets ?? []).slice(0, 3).join(" / ").slice(0, 350)
    return `${e.title ?? "(role)"} @ ${e.company ?? "(company)"}: ${bullets || (e.description ?? "").slice(0, 200)}`
  }).join("\n")

  const projects = (input.projects ?? []).slice(0, 2).map((p) => {
    const tech = (p.technologies ?? []).join(",").slice(0, 80)
    return `${p.name}: ${(p.description ?? "").slice(0, 200)} [tech: ${tech}]`
  }).join("\n")

  const skills = (input.topSkills ?? []).slice(0, 12).join(", ")
  const matched = (input.matchedSkills ?? []).slice(0, 3).map((s) => s.name).join(", ")
  const reqSkills = (input.job.requiredSkills ?? []).slice(0, 8).join(", ")
  const priorities = (input.candidatePriorities ?? [])
    .filter((p) => typeof p === "string" && p.trim().length > 0)
    .slice(0, 4)
    .map((p) => p.trim())
    .join(", ")
  const jobIndustry = (input.job.industry ?? [])
    .filter((i) => typeof i === "string" && i.trim().length > 0)
    .slice(0, 3)
    .join(", ")

  const userText = `## 候选人最近经历 / Recent Experience
${wh}

${projects ? `## 项目 / Projects\n${projects}\n` : ""}
## 候选人技能 / Skills
${skills}

## V16 已匹配的技能 / V16-Matched Skills
${matched}
${input.candidateSeniority ? `\n## 候选人级别 / Candidate Seniority\n${input.candidateSeniority}\n` : ""}${priorities ? `\n## 候选人最看重 / Candidate Stated Priorities\n${priorities}\n` : ""}
## 这个岗位 / Job
${input.job.title}${input.job.company ? ` @ ${input.job.company}` : ""}
${input.job.seniorityLevel ? `Seniority: ${input.job.seniorityLevel}\n` : ""}${input.job.companyStage ? `Company stage: ${input.job.companyStage}\n` : ""}${jobIndustry ? `Industry: ${jobIndustry}\n` : ""}${input.job.location ? `Location: ${input.job.location}\n` : ""}${reqSkills ? `Required: ${reqSkills}\n` : ""}${input.job.jobDescription ? `JD: ${input.job.jobDescription.slice(0, 600)}` : ""}

返回 JSON: { "reason": "<1-2 句有说服力的推荐理由, 引用具体经历 + 对得上的技能 + 如果有就点出候选人最看重的东西>" }`

  try {
    // 2026-05-07 Bug D root cause v4 — production CF env has
    // `OPENAI_BASE_URL = https://api.siliconflow.cn/v1` (global pollution
    // from index.ts:694, intended for agent-runtime's OpenAI-compatible
    // SiliconFlow client). OpenAI SDK auto-reads this env when baseURL is
    // not explicitly passed, so even with a valid OpenAI key, requests go
    // to SiliconFlow endpoint and 401 because SF doesn't recognize an
    // OpenAI sk-proj key. Force the OpenAI canonical base URL for THIS
    // call (we want real OpenAI, not the aliased SF endpoint).
    const result = await callWithFallback({
      apiKey: config.openaiApiKey,
      baseURL: "https://api.openai.com/v1",
      anthropicApiKey: config.anthropicApiKey,
      systemPrompt: input.lang === "zh" ? SYSTEM_PROMPT_ZH : SYSTEM_PROMPT_EN,
      userText,
      schemaName: "NuancedMatchReason",
      schema: NUANCED_REASON_SCHEMA as unknown as Record<string, unknown>,
      clientFactory: config.clientFactory,
      anthropicClientFactory: config.anthropicClientFactory,
      log: (event, payload) => logger.info(event, payload as Record<string, unknown>),
    })
    let parsed: { reason?: string }
    try {
      parsed = JSON.parse(result.rawJson)
    } catch (e) {
      logger.warn("pa.match.nuanced_reason_parse_failed", {
        rawSample: result.rawJson.slice(0, 200),
        err: e instanceof Error ? e.message.slice(0, 100) : String(e).slice(0, 100),
      })
      return null
    }
    const reason = (parsed.reason ?? "").trim()
    if (!reason || reason.length < 8 || reason.length > 300) {
      logger.warn("pa.match.nuanced_reason_invalid_length", {
        usedTier: result.usedTier,
        usedModel: result.usedModel,
        len: reason.length,
      })
      return null
    }
    const cleaned = reason
      .replace(/^("|")?\s*(为啥推|Why match|Reason)\s*[:：]?\s*/i, "")
      .replace(/^["']|["']$/g, "")
      .trim()
    logger.info("pa.match.nuanced_reason_ok", {
      usedTier: result.usedTier,
      usedModel: result.usedModel,
      tokens: result.usage?.total_tokens,
    })
    return cleaned || null
  } catch (err) {
    logger.warn("pa.match.nuanced_reason_failed", {
      err: err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200),
    })
    return null
  }
}
