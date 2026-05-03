/**
 * v1.5 / Phase 53.5 — Job market knowledge harness prompt.
 *
 * Why this exists (Adam 2026-05-02 spec):
 *   In dry-run testing Adam asked "AI agent 开发, 哪些你觉得我有" and Claire
 *   replied without naming any of the actual hot keywords (RAG, tool calling,
 *   workflow orchestration). Bible v7.5 is voice/style focused; it does NOT
 *   carry domain knowledge of what specific technical keywords are HOT in
 *   the 2026 AI agent market. Claire was happy to confirm vague matches
 *   ("有 Python 是 match") without checking against the harder bar.
 *
 *   This module injects a tight "JOB MARKET CONTEXT (2026)" block into the
 *   system prompt, ONLY when the recent conversation/profile hints at one
 *   of the target roles (AI agent / PM / SWE). The block names the actual
 *   keyword set so when the user asks "what do I have", Claire grounds her
 *   answer in HOT_SKILLS instead of generic praise.
 *
 * Wire-in: same pattern as cv-context-injection.ts — code-level append
 * to the composed handbook system prompt in orchestrator/src/index.ts.
 *
 * SCOPE — Adam constraint "保守, 只列 indisputable hot skills":
 *   - AI agent: 9 keywords (RAG, function/tool calling, workflow orchestration,
 *     multi-turn state, agentic workflows, LangChain/LlamaIndex, vector DBs,
 *     prompt engineering, evaluation harnesses)
 *   - PM: 5 keywords (data-driven, A/B testing, growth metrics, user research, GTM)
 *   - SWE: 6 keywords (system design, distributed systems, observability,
 *     CI/CD, code review, on-call)
 *   - DEFERRED: niche frameworks (AutoGen / CrewAI / Haystack), specific
 *     vector DBs (Pinecone vs Weaviate), DS-specific (causal inference)
 *
 * Failure mode: pure / never throws. Empty/unknown role → returns the input
 * systemPrompt unchanged.
 */

export type JobMarketRole = "ai_agent" | "pm" | "swe"

/** Hot skills for AI agent / LLM application roles in 2026. */
export const AI_AGENT_HOT_SKILLS_2026 = {
  zh: [
    "RAG (检索增强生成)",
    "function calling / tool calling",
    "工作流编排 (workflow orchestration)",
    "多轮对话状态管理 (multi-turn state mgmt)",
    "agentic workflow",
    "LangChain / LlamaIndex",
    "vector database (向量检索)",
    "prompt engineering",
    "evaluation / eval harness",
  ],
  en: [
    "RAG (Retrieval-Augmented Generation)",
    "function/tool calling",
    "workflow orchestration",
    "multi-turn state management",
    "agentic workflows",
    "LangChain / LlamaIndex",
    "vector databases",
    "prompt engineering",
    "evaluation harnesses",
  ],
} as const

/** Hot skills for Product Manager roles in 2026. */
export const PM_HOT_SKILLS_2026 = {
  zh: [
    "数据驱动决策",
    "AB 测试",
    "增长指标 (DAU/MAU/retention)",
    "用户调研 (user research)",
    "GTM (go-to-market)",
  ],
  en: [
    "data-driven decisions",
    "A/B testing",
    "growth metrics (DAU/MAU/retention)",
    "user research",
    "GTM (go-to-market)",
  ],
} as const

/** Hot skills for general SWE roles in 2026. */
export const SWE_HOT_SKILLS_2026 = {
  zh: [
    "系统设计",
    "分布式系统",
    "可观测性 (observability / metrics / tracing)",
    "CI/CD pipelines",
    "code review",
    "on-call / incident response",
  ],
  en: [
    "system design",
    "distributed systems",
    "observability (metrics / tracing)",
    "CI/CD pipelines",
    "code review",
    "on-call / incident response",
  ],
} as const

const ROLE_BANK: Record<
  JobMarketRole,
  { zh: readonly string[]; en: readonly string[]; label: { zh: string; en: string } }
> = {
  ai_agent: {
    zh: AI_AGENT_HOT_SKILLS_2026.zh,
    en: AI_AGENT_HOT_SKILLS_2026.en,
    label: { zh: "AI agent / LLM 应用开发", en: "AI agent / LLM application engineering" },
  },
  pm: {
    zh: PM_HOT_SKILLS_2026.zh,
    en: PM_HOT_SKILLS_2026.en,
    label: { zh: "产品经理 (PM)", en: "Product Manager (PM)" },
  },
  swe: {
    zh: SWE_HOT_SKILLS_2026.zh,
    en: SWE_HOT_SKILLS_2026.en,
    label: { zh: "软件工程师 (SWE)", en: "Software Engineer (SWE)" },
  },
}

/**
 * Lightweight role detection from free text (user message OR CV stated
 * preferences). Returns the role with the strongest signal, or null when
 * no role keyword fires (caller should NOT inject when null — keeps the
 * system prompt clean for casual / off-topic chat).
 *
 * Bias: false-negative friendly. Generic "engineer" alone is NOT enough to
 * fire ai_agent — must include an explicit AI/agent/LLM keyword. We'd
 * rather miss an injection than mis-fire one (which would push AI buzzwords
 * into a non-AI conversation).
 */
export function detectJobMarketRole(text: string | undefined | null): JobMarketRole | null {
  const body = (text ?? "").toLowerCase()
  if (!body || body.length === 0) return null

  // ai_agent — must mention AI/LLM/agent context PLUS an engineering frame.
  // Standalone "AI" is not enough (could be small-talk).
  const aiAgentSignals = [
    /\bai\s*agent\b/,
    /\ba(?:gent|gentic)\s*(?:engineer|开发|工程|workflow|orchestr)/,
    /\bllm\s*(?:engineer|application|app|开发|工程)/,
    /\brag\b/,
    /\blangchain\b/,
    /\bllama\s*index\b/,
    /\btool\s*call(?:ing)?\b/,
    /\bfunction\s*call(?:ing)?\b/,
    /\bagentic\b/,
    /大模型\s*(?:开发|工程|应用|工程师)/,
    /agent\s*开发/,
    /多轮(?:对话|state)/,
  ]
  for (const re of aiAgentSignals) {
    if (re.test(body)) return "ai_agent"
  }

  // pm — explicit product manager / 产品经理 mention. "growth" alone is too generic.
  const pmSignals = [
    /产品经理/,
    /\bproduct\s*manager\b/,
    /\bpm\s*(?:role|岗|工作|岗位|job|position)/,
    /\b(?:做|找|看|当|换)\s*pm\b/,
    /\bgrowth\s*pm\b/,
  ]
  for (const re of pmSignals) {
    if (re.test(body)) return "pm"
  }

  // swe — generic software engineer (only fires when role keyword explicit).
  // Note: "software engineer" alone DOES fire here — it's not as ambiguous
  // as bare "engineer" because it commits to the SWE specialization.
  const sweSignals = [
    /\bsoftware\s*engineer\b/,
    /软件工程师/,
    /\bswe\s*(?:role|岗|工作|岗位|job|position|开发)?/,
    /后端\s*工程师/,
    /前端\s*工程师/,
    /全栈\s*工程师/,
    /\bbackend\s*engineer\b/,
    /\bfrontend\s*engineer\b/,
    /\bfull[- ]?stack\s*engineer\b/,
  ]
  for (const re of sweSignals) {
    if (re.test(body)) return "swe"
  }

  return null
}

/**
 * Build the harness prompt section text for one role. Returns "" for unknown
 * role (defensive — should never happen since the role enum is exhaustive).
 */
export function buildHarnessPrompt(role: JobMarketRole, lang: "zh" | "en"): string {
  const bank = ROLE_BANK[role]
  if (!bank) return ""
  const skills = lang === "zh" ? bank.zh : bank.en
  const label = lang === "zh" ? bank.label.zh : bank.label.en

  const lines: string[] = []
  lines.push("## JOB MARKET CONTEXT (2026)")
  if (lang === "zh") {
    lines.push(
      `用户在聊 ${label} 方向。下面这组关键词是 2026 当前市场上 *硬* 要求的核心技能 — 当用户问 "我哪些 match"、"我够格吗"、"招聘要什么" 类问题时，必须用这组关键词来评估 + 反馈，不要泛泛说 "有 Python 就是 match"。`
    )
    lines.push("")
    lines.push(`${label} 当前市场关键技能 (2026):`)
    for (const s of skills) lines.push(`  - ${s}`)
    lines.push("")
    lines.push("使用规则:")
    lines.push(
      "  - 用户列简历技能时，把上面这组当成 checklist — 直接说 \"你 RAG / tool calling 这块对得上\" 或 \"core 缺 RAG\"。"
    )
    lines.push("  - 单独一个 Python / SQL 这种通用语言不算真 match — 要看上面 core 关键词覆盖度。")
    lines.push("  - 不要把 Python = AI agent。Python 是必要不充分条件。")
  } else {
    lines.push(
      `User is in the ${label} track. The keyword set below is the *hard* requirement on the 2026 market — when the user asks "what do I match", "am I qualified", "what does this role want", evaluate AGAINST this list. Do NOT say "you have Python so you match"; that's the lazy answer.`
    )
    lines.push("")
    lines.push(`${label} hot skills on the 2026 market:`)
    for (const s of skills) lines.push(`  - ${s}`)
    lines.push("")
    lines.push("Usage rules:")
    lines.push(
      "  - When the user lists CV skills, treat the bank above as a checklist — name explicit hits (\"your RAG / tool calling experience lines up\") or explicit gaps (\"core RAG missing\")."
    )
    lines.push("  - A single generic language like Python or SQL is NOT a real match by itself — coverage of the CORE keywords is what counts.")
    lines.push("  - Python alone ≠ AI agent qualification. Python is necessary but not sufficient.")
  }
  return lines.join("\n")
}

/**
 * Main entry — same shape + failure semantics as appendCvContextToSystemPrompt.
 *
 * Looks at:
 *   1. The current user message (highest signal — they may be asking a
 *      role-specific question RIGHT NOW)
 *   2. The most-recent stated preference (statedPreferences.targetRole)
 *
 * Returns systemPrompt UNCHANGED when no role keyword fires. This is the
 * common case (general chat), and we deliberately keep the prompt clean.
 *
 * NEVER throws. NEVER breaks Bible v7.5 NEVER rules — adds an additive
 * section labeled "JOB MARKET CONTEXT" that is informational only.
 */
export function appendJobMarketKnowledgeToSystemPrompt(
  systemPrompt: string,
  signals: {
    userMessage?: string | undefined
    statedTargetRoles?: readonly string[] | undefined
    lang?: "zh" | "en"
  }
): string {
  const lang = signals.lang ?? "zh"
  // Combine signals — userMessage carries the freshest intent; statedTargetRoles
  // provides persistent context (e.g. user said "I'm an AI agent dev" 3 turns ago).
  const combined = [
    signals.userMessage ?? "",
    ...(signals.statedTargetRoles ?? []),
  ]
    .filter((s) => typeof s === "string" && s.length > 0)
    .join(" ")

  const role = detectJobMarketRole(combined)
  if (!role) return systemPrompt
  const block = buildHarnessPrompt(role, lang)
  if (!block) return systemPrompt
  // Trailing-newline-safe append (mirror appendCvContextToSystemPrompt).
  const trimmed = systemPrompt.replace(/\s+$/, "")
  return `${trimmed}\n\n${block}`
}
