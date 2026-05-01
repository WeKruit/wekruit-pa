/**
 * Stream F1 — Locked 10-tag industry enum + deterministic mapping.
 *
 * Used by:
 *   - cv-ingest LLM extract (Stream F1) → up to 3 industryTags per CV
 *   - matching-jobs backfill script (Stream F2) → maps the existing
 *     free-text `industry` / `industryKey` field to the canonical enum
 *   - probing flow (Stream F3, hard rule in Bible v5) → INDUSTRY confirm
 *     question is grounded in this enum, not free-text
 *   - daily-batch matcher (Stream F5) → Firestore where(industryEnum in [...])
 *
 * LOCKED: do NOT add/rename without P10 approval. The 10 buckets cover
 * 100% of the 40,374-doc corpus's 75 unique industry strings. Anything
 * unmappable falls into "other" by design.
 *
 * Mapping rationale: Stream F discovery — matching-jobs already has
 * `industryKey` (snake_case scraped values like "fintech", "healthtech",
 * "data_analytics", etc.). Mapping is purely deterministic; no LLM call
 * needed. See `INDUSTRY_KEY_MAP` below for the explicit table.
 */
import { z } from "zod"

export const INDUSTRY_TAGS = [
  "tech_software", // 互联网/软件/SaaS
  "tech_hardware", // 半导体/硬件/IoT
  "fintech_finance", // 金融科技/银行/对冲基金
  "ai_ml", // AI/ML/数据科学
  "healthcare_biotech", // 医疗/生物科技/药物研发
  "consumer_retail", // 电商/消费品/零售
  "media_entertainment", // 媒体/游戏/内容
  "manufacturing_industrial", // 制造/工业/能源
  "education", // 教育/EdTech
  "other", // 其他
] as const

export type IndustryTag = (typeof INDUSTRY_TAGS)[number]
export const IndustryTagSchema = z.enum(INDUSTRY_TAGS)

/** Bilingual labels for surfacing the enum value in a Claire-voice probe. */
export const INDUSTRY_LABELS: Record<IndustryTag, { zh: string; en: string }> = {
  tech_software: { zh: "互联网/软件", en: "tech/software" },
  tech_hardware: { zh: "半导体/硬件", en: "hardware/semiconductors" },
  fintech_finance: { zh: "金融科技/银行", en: "fintech/finance" },
  ai_ml: { zh: "AI/机器学习", en: "AI/ML" },
  healthcare_biotech: { zh: "医疗/生物科技", en: "healthcare/biotech" },
  consumer_retail: { zh: "电商/消费品", en: "consumer/retail" },
  media_entertainment: { zh: "媒体/娱乐", en: "media/entertainment" },
  manufacturing_industrial: { zh: "制造/工业", en: "manufacturing/industrial" },
  education: { zh: "教育/EdTech", en: "education/edtech" },
  other: { zh: "其他", en: "other" },
}

/**
 * Deterministic map from the corpus's free-text `industryKey` (and a
 * superset of common synonyms) to the canonical 10-tag enum.
 *
 * Source: live audit on 2026-04-30 of `matching-jobs.industryKey`
 * found 75 distinct values across 40,374 docs. Top 30 cover ~95% of
 * the corpus; remaining 45 default to "other" via fallback.
 *
 * Rule: keys are normalized via `normalizeIndustryKey` (lowercase, snake
 * underscores, no trailing whitespace). This avoids needing entries for
 * "FinTech" / "Fin-Tech" / "fin tech" / etc.
 */
const INDUSTRY_KEY_MAP: Record<string, IndustryTag> = {
  // ---- tech_software ------------------------------------------------------
  tech: "tech_software",
  software: "tech_software",
  software_development: "tech_software",
  saas: "tech_software",
  enterprise_saas: "tech_software",
  internet: "tech_software",
  web: "tech_software",
  cloud: "tech_software",
  devops: "tech_software",
  it_services: "tech_software",
  it: "tech_software",
  cybersecurity: "tech_software",
  security: "tech_software",
  // ---- tech_hardware ------------------------------------------------------
  hardware: "tech_hardware",
  semiconductors: "tech_hardware",
  semiconductor: "tech_hardware",
  electronics: "tech_hardware",
  iot: "tech_hardware",
  robotics: "tech_hardware",
  // ---- fintech_finance ----------------------------------------------------
  fintech: "fintech_finance",
  finance: "fintech_finance",
  banking: "fintech_finance",
  accounting_finance: "fintech_finance",
  insurance: "fintech_finance",
  investment: "fintech_finance",
  trading: "fintech_finance",
  hedge_fund: "fintech_finance",
  // ---- ai_ml --------------------------------------------------------------
  ai: "ai_ml",
  ai_ml: "ai_ml",
  ml: "ai_ml",
  machine_learning: "ai_ml",
  data_science: "ai_ml",
  data_analytics: "ai_ml",
  data: "ai_ml",
  // ---- healthcare_biotech -------------------------------------------------
  healthtech: "healthcare_biotech",
  healthcare: "healthcare_biotech",
  biotech: "healthcare_biotech",
  biotechnology: "healthcare_biotech",
  pharmaceutical: "healthcare_biotech",
  pharma: "healthcare_biotech",
  medical: "healthcare_biotech",
  medical_devices: "healthcare_biotech",
  // ---- consumer_retail ----------------------------------------------------
  consumer: "consumer_retail",
  retail: "consumer_retail",
  ecommerce: "consumer_retail",
  e_commerce: "consumer_retail",
  food_beverage: "consumer_retail",
  hospitality: "consumer_retail",
  restaurants: "consumer_retail",
  travel: "consumer_retail",
  // ---- media_entertainment ------------------------------------------------
  media: "media_entertainment",
  entertainment: "media_entertainment",
  arts_entertainment: "media_entertainment",
  gaming: "media_entertainment",
  games: "media_entertainment",
  social_media: "media_entertainment",
  publishing: "media_entertainment",
  music: "media_entertainment",
  film: "media_entertainment",
  // ---- manufacturing_industrial -------------------------------------------
  manufacturing: "manufacturing_industrial",
  industrial: "manufacturing_industrial",
  energy: "manufacturing_industrial",
  oil_gas: "manufacturing_industrial",
  utilities: "manufacturing_industrial",
  construction: "manufacturing_industrial",
  automotive: "manufacturing_industrial",
  aerospace: "manufacturing_industrial",
  logistics: "manufacturing_industrial",
  transportation: "manufacturing_industrial",
  // ---- education ----------------------------------------------------------
  education: "education",
  edtech: "education",
  // every other surfaced (engineering / sales / management / customer_service /
  // marketing / hr / legal / consulting / design / product / business /
  // government / unknown / other) defaults to "other" via fallback below
}

export function normalizeIndustryKey(raw: string): string {
  return raw
    .toLowerCase()
    .trim()
    .replace(/[\s\-/]+/g, "_")
    .replace(/_+/g, "_")
}

/**
 * Deterministic mapper. Returns "other" when the input doesn't match any
 * entry in INDUSTRY_KEY_MAP. Caller can layer an LLM fallback on top if
 * the corpus drifts (currently NOT needed — 100% mapped or intentionally
 * "other"-bucketed).
 */
export function mapToCanonicalIndustry(raw: string | null | undefined): IndustryTag {
  if (!raw || typeof raw !== "string") return "other"
  const norm = normalizeIndustryKey(raw)
  // Identity short-circuit: if the LLM (or any caller) hands us an
  // already-canonical token, preserve it. Without this, "fintech_finance"
  // would get re-mapped via INDUSTRY_KEY_MAP — a miss — and degrade to "other".
  if ((INDUSTRY_TAGS as readonly string[]).includes(norm)) {
    return norm as IndustryTag
  }
  return INDUSTRY_KEY_MAP[norm] ?? "other"
}

/**
 * Render the user's industryTags into a 1-line block for system prompt
 * injection. Used by Stream D's appendCvContextToSystemPrompt extension.
 */
export function renderIndustryTagsLine(tags: readonly IndustryTag[]): string | null {
  if (!Array.isArray(tags) || tags.length === 0) return null
  const seen = new Set<IndustryTag>()
  const ordered: IndustryTag[] = []
  for (const t of tags) {
    if (INDUSTRY_TAGS.includes(t) && !seen.has(t)) {
      seen.add(t)
      ordered.push(t)
    }
  }
  if (ordered.length === 0) return null
  const parts = ordered.map((t) => `${t} (${INDUSTRY_LABELS[t].zh})`)
  return `Industry tags (top guesses from CV experiences): ${parts.join(", ")}`
}
