/**
 * v1.5 / Phase 53.5 — Job market knowledge harness prompt.
 *
 * Why this exists (Adam 2026-05-02 spec):
 *   In dry-run testing Adam asked "AI agent dev, which of these do you think I have" and Claire
 *   replied without naming any of the actual hot keywords (RAG, tool calling,
 *   workflow orchestration). Bible v7.5 is voice/style focused; it does NOT
 *   carry domain knowledge of what specific technical keywords are HOT in
 *   the 2026 AI agent market. Claire was happy to confirm vague matches
 *   ("you have Python so it is a match") without checking against the harder bar.
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
 * SCOPE — Adam constraint "be conservative, only list indisputable hot skills":
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
  // Legacy `zh` key retained for back-compat; product is English-only, so it
  // mirrors `en`.
  zh: [
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
    "data-driven decisions",
    "A/B testing",
    "growth metrics (DAU/MAU/retention)",
    "user research",
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
    "system design",
    "distributed systems",
    "observability (metrics / tracing)",
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
    label: { zh: "AI agent / LLM application engineering", en: "AI agent / LLM application engineering" },
  },
  pm: {
    zh: PM_HOT_SKILLS_2026.zh,
    en: PM_HOT_SKILLS_2026.en,
    label: { zh: "Product Manager (PM)", en: "Product Manager (PM)" },
  },
  swe: {
    zh: SWE_HOT_SKILLS_2026.zh,
    en: SWE_HOT_SKILLS_2026.en,
    label: { zh: "Software Engineer (SWE)", en: "Software Engineer (SWE)" },
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
    /\ba(?:gent|gentic)\s*(?:engineer|workflow|orchestr)/,
    /\bllm\s*(?:engineer|application|app)/,
    /\brag\b/,
    /\blangchain\b/,
    /\bllama\s*index\b/,
    /\btool\s*call(?:ing)?\b/,
    /\bfunction\s*call(?:ing)?\b/,
    /\bagentic\b/,
    /multi-?turn\s*(?:conversation|state)/,
  ]
  for (const re of aiAgentSignals) {
    if (re.test(body)) return "ai_agent"
  }

  // pm — explicit product manager mention. "growth" alone is too generic.
  const pmSignals = [
    /\bproduct\s*manager\b/,
    /\bpm\s*(?:role|job|position)/,
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
    /\bswe\s*(?:role|job|position)?/,
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
  // Product is English-only — always render the English bank/label.
  void lang
  const skills = bank.en
  const label = bank.label.en

  const lines: string[] = []
  lines.push("## JOB MARKET CONTEXT (2026)")
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
  const lang = signals.lang ?? "en"
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
