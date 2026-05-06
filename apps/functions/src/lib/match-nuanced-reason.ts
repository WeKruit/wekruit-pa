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

import OpenAI from "openai"
import { logger } from "firebase-functions/v2"

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
  }
  /** Top-2 matched skills from V16 (sanity check that LLM doesn't hallucinate). */
  matchedSkills: Array<{ name: string; proficiency?: string }>
}

const SYSTEM_PROMPT_ZH = `你是一个 Career Advisor。看候选人的简历经历 + 这个岗位需求, 写一句中文推荐理由。

规则:
- 1 句话, 30-50 字
- 必须引用候选人的具体公司/项目 (e.g., "你在 Tesla 做的 V&C 后台 300+ 门店")
- 引用 1-2 个跟岗位需求对得上的具体技能 (从他真用过的技能里选)
- 中文口语化, 不写"具备""掌握"这种简历腔
- 不要前缀"为啥推"或类似 — 只写理由本身

格式: 直接返回理由 string, 不要 JSON 不要 markdown。

例:
- "你在 Tesla 用 Node.js + React 撑过 300+ 门店的 V&C 后台, 这个 Stripe 全栈岗规模 + 栈都对得上"
- "你 OFO 那个跨平台外卖 app 跟这个岗位的 React Native + Firebase 路径几乎一样"
- "你 ESL 那个 Dynamic Knowledge Tracing 的 PyTorch 模型, 跟这家做的 LLM 微调方向能直接迁移"`

const SYSTEM_PROMPT_EN = `You are a Career Advisor. Look at candidate's resume experience + this job's requirements, write a 1-sentence rec reason in English.

Rules:
- 1 sentence, 15-25 words
- MUST cite candidate's specific company/project (e.g., "your Tesla V&C backend serving 300+ stores")
- Cite 1-2 specific skills that bridge to JD (only from skills they actually used)
- Casual tone, not resume-speak ("possess", "demonstrate")
- No "Why match:" prefix — just the reason

Format: Return the reason as plain string, no JSON, no markdown.

Example:
- "Your Tesla V&C backend with Node.js+React serving 300+ stores maps directly to this Stripe full-stack scale"
- "Your OFO Delivery cross-platform app on RN+Firebase is the same stack this role uses"
- "Your ESL Dynamic Knowledge Tracing model in PyTorch transfers cleanly to their LLM fine-tuning"`

const MAX_TOKENS = 120

export async function composeNuancedReason(
  input: NuancedReasonInput,
  config: { openaiApiKey: string; model?: string; client?: OpenAI; timeoutMs?: number }
): Promise<string | null> {
  if (!config.openaiApiKey) return null
  const model = config.model ?? "gpt-5.4-nano"
  const client = config.client ?? new OpenAI({ apiKey: config.openaiApiKey, timeout: config.timeoutMs ?? 8000 })

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

  const userText = `## 候选人最近经历 / Recent Experience
${wh}

${projects ? `## 项目 / Projects\n${projects}\n` : ""}
## 候选人技能 / Skills
${skills}

## V16 已匹配的技能 / V16-Matched Skills
${matched}

## 这个岗位 / Job
${input.job.title}${input.job.company ? ` @ ${input.job.company}` : ""}
${input.job.seniorityLevel ? `Seniority: ${input.job.seniorityLevel}\n` : ""}${reqSkills ? `Required: ${reqSkills}\n` : ""}${input.job.jobDescription ? `JD: ${input.job.jobDescription.slice(0, 600)}` : ""}

写一句推荐理由, 引用具体经历 + 1-2 个对得上的技能。`

  try {
    // gpt-5.x family rejects `max_tokens`, requires `max_completion_tokens`.
    // Detect model family by prefix to pick correct param.
    const useNewParam = /^gpt-(5|6|7|8|9)/i.test(model)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const requestParams: any = {
      model,
      messages: [
        { role: "system", content: input.lang === "zh" ? SYSTEM_PROMPT_ZH : SYSTEM_PROMPT_EN },
        { role: "user", content: userText },
      ],
    }
    if (useNewParam) {
      requestParams.max_completion_tokens = MAX_TOKENS
    } else {
      requestParams.max_tokens = MAX_TOKENS
      requestParams.temperature = 0.4
    }
    const res = await client.chat.completions.create(requestParams)
    const text = res.choices?.[0]?.message?.content?.trim()
    if (!text || text.length < 8 || text.length > 300) {
      logger.warn("pa.match.nuanced_reason_invalid_length", { len: text?.length ?? 0 })
      return null
    }
    // Strip leading "为啥推:" / "Why match:" if LLM added it (prompt says don't, but defensive)
    const cleaned = text
      .replace(/^("|")?\s*(为啥推|Why match|Reason)\s*[:：]?\s*/i, "")
      .replace(/^["']|["']$/g, "")
      .trim()
    return cleaned || null
  } catch (err) {
    logger.warn("pa.match.nuanced_reason_failed", {
      err: err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200),
    })
    return null
  }
}
