/**
 * iter34 H.1 — Unified user tag schema + merger.
 *
 * Adam directive (2026-05-05): "聊天有tag，resume有tag，太多地方了" — the
 * candidate signal currently lives in 4+ disjoint places:
 *   1. `pa-users.statedPreferences` (chat-derived: role / yoe / visa / loc)
 *   2. `parsedCandidateResumes.industryTags` (CV-derived industry buckets)
 *   3. `parsedCandidateResumes.topSkills` (CV-derived ranked skills)
 *   4. `parsedCandidateResumes.candidateProfile.skills` + `workHistory[].skills`
 *      (CV-derived raw skill bag + per-job skills)
 *   5. `parsedCandidateResumes.embedding` (CV-derived 1536d vec)
 *
 * This module folds them into ONE canonical projection at
 * `pa-users/{userId}.tags`. Pure function, no Firestore I/O — caller is
 * responsible for reading the inputs + writing the output.
 *
 * Boundary: this module is INPUT-ONLY w.r.t. its parameters. It MUST NOT
 * mutate `cv` or `statedPreferences`. Downstream H.3 will wire cv-ingest
 * to call mergeUserTags + write `pa-users.tags`; H.4 will wire
 * generateJobRecs to read `pa-users.tags` instead of joining the 4 sources
 * inline. This worker (H.1) only defines schema + merger — no call-site
 * wiring.
 *
 * Spec choices (from Adam):
 *   - `skills` is FULL (not truncated). topSkills lives elsewhere for
 *     rendering; tags stores the entire deduplicated lowercased bag from
 *     candidateProfile.skills + workHistory[].skills.
 *   - `industryEnum` priority: cv.industryTags (filtered ≠ "other") →
 *     roleToIndustryBuckets(targetRole) → tech-token sniff on skills →
 *     ["other"].
 *   - `embedding` is pass-through (cost-prohibitive to recompute here).
 *   - chat fields are pass-through from statedPreferences (with the
 *     boolean→enum mapping for prefersStartup + sponsorship_needed→
 *     sponsor_needed token rename).
 */

import { z } from "zod"
import {
  SkillSchema,
  type Skill,
  type SkillBucket,
} from "@wekruit/shared-tags"
import { roleToIndustryBuckets, type IndustryEnumBucket } from "../voice/role-to-industry.js"
import type { CanonicalRole } from "../onboarding.js"
import type { StatedPreferences } from "@pa/core-types"

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

/**
 * Canonical industry enum (mirrors `IndustryEnumBucket` from
 * voice/role-to-industry — kept as a re-export so consumers don't need
 * to import from two places).
 */
export type IndustryTag = IndustryEnumBucket

/**
 * Visa-status token in the unified tag schema. Note this is INTENTIONALLY
 * different from `VisaStatusSchema` in @pa/core-types:
 *   - "sponsorship_needed" (StatedPreferences) → "sponsor_needed" (tags)
 *   - "unknown" (StatedPreferences) → "other" (tags)
 * The rename is so the tag schema reads cleanly without coupling to the
 * onboarding-probe-v2 wire format.
 */
export type TagsVisaStatus =
  | "citizen"
  | "gc"
  | "opt"
  | "h1b"
  | "sponsor_needed"
  | "other"

/**
 * Canonical employer-flavor preference. Boolean prefersStartup (true/false/
 * null) maps to startup/bigtech/either respectively.
 */
export type StartupPreference = "startup" | "bigtech" | "either"

/**
 * Preferred reply language. Mirrors StatedPreferences.preferredLang
 * EXCEPT we drop "mixed" — generators key on this for hard zh/en lock,
 * and "mixed" is actually a runtime adapter signal, not a tag-level
 * preference. Mixed-register users get `undefined` here (caller can fall
 * back to runtime detection).
 */
export type TagsPreferredLang = "zh" | "en"

/**
 * Schema version. Bump on breaking changes (rename / drop fields). Reads
 * default to 1 when the field is absent so legacy `pa-users.tags` rows
 * (if any pre-iter34 lands) don't false-positive as "unparseable".
 */
export const USER_TAGS_SCHEMA_VERSION = 1 as const

export const UserTagsSchema = z.object({
  // ---- CV-derived ------------------------------------------------------
  /**
   * ALL skills from CV — Phase 52 canonical SkillEntry shape (name + bucket
   * + proficiency + evidenceCount + baseWeight). NOT truncated. Adam spec:
   * "skills 全量". topSkills (top-12 ranked) lives separately on
   * parsedCandidateResumes; this is the unranked bag for embedding /
   * cross-rerank consumers.
   *
   * Phase 61 fix: was `z.array(z.string())` — but Phase 56 V16
   * `computeWeightedSkillJaccard` reads `skills[].name` and `skills[].baseWeight`,
   * so `string[]` made baseWeight undefined → score=0 for everyone. The
   * migration script `migrate-skills-to-objects.mjs` upgrades existing
   * pa-users.tags string[] to SkillEntry[] with `baseWeight: 1.0`.
   */
  skills: z.array(SkillSchema),
  /**
   * 1..N canonical industry-bucket tokens. Always non-empty (defaults to
   * ["other"] when no signal). Drives industry filter in job-rec.
   */
  industryEnum: z.array(z.string()),
  /**
   * Phase 53 — Phase 52 canonical industry-sector tokens (42-token vocab,
   * `INDUSTRY_SECTOR_VOCAB`). Distinct from `industryEnum` (legacy 10-tag).
   * Populated parse-time by pa-resume-parser v2 + post-parse Sonnet
   * second-pass when the LLM falls through to ["other"] (D15).
   */
  industrySector: z.array(z.string()).optional(),
  /**
   * Phase 53 — derived industries from work-history (≤6). Same canonical
   * 42-token vocab as `industrySector`. Used by Phase 56 match query as
   * the soft-score axis (alongside `industrySector`).
   */
  relevantIndustry: z.array(z.string()).optional(),
  /**
   * Phase 53 — sub-domain expertise tokens (e.g. `frontend_development`,
   * `mlops`, `infrastructure_security`). Open vocab.
   */
  relevantSpecialization: z.array(z.string()).optional(),
  /**
   * Phase 53 — sandbox open-vocab tags (max 12). Pattern `[a-z][a-z0-9_]{1,79}`.
   * Promoted to canonical via admin dashboard (Phase 59).
   */
  proposedTags: z.array(z.string()).optional(),
  /** Most recent role title (workHistory[0].title or experiences[0].title). */
  recentRoleTitle: z.string().optional(),
  /** Most recent company. */
  recentCompany: z.string().optional(),
  /**
   * 1-line summary of the candidate's last 3 roles. Format:
   * `"${title} @ ${company}; ${title} @ ${company}; ${title} @ ${company}"`.
   * Soft-capped at 200 chars (truncated mid-segment with `…` if longer).
   */
  workHistorySummary: z.string().optional(),
  /** 1536d OpenAI embedding (text-embedding-3-small or compat). */
  embedding: z.array(z.number()).optional(),
  embeddingModel: z.string().optional(),
  embeddingComputedAt: z.string().optional(),

  // ---- chat-derived (statedPreferences echo) --------------------------
  /** Canonical role tokens (closed enum from onboarding canon-role). */
  targetRole: z.array(z.string()).optional(),
  /** [min, max] years-of-experience tuple. */
  yoeRange: z.tuple([z.number(), z.number()]).optional(),
  visaStatus: z
    .enum(["citizen", "gc", "opt", "h1b", "sponsor_needed", "other"])
    .optional(),
  prefersStartup: z.enum(["startup", "bigtech", "either"]).optional(),
  /** Free-text location hints from chat. */
  targetLocations: z.array(z.string()).optional(),
  preferredLang: z.enum(["zh", "en"]).optional(),

  // ---- bookkeeping -----------------------------------------------------
  lastUpdatedFromCv: z.string().optional(),
  lastUpdatedFromChat: z.string().optional(),
  schemaVersion: z.number().int().nonnegative(),
})

/**
 * Canonical user-tags shape. Inferred from `UserTagsSchema` for runtime/
 * compile-time parity. Field-level docs: see schema above.
 */
export type UserTags = z.infer<typeof UserTagsSchema>

// ---------------------------------------------------------------------------
// Input shape
// ---------------------------------------------------------------------------

export interface UserTagsCvInput {
  candidateProfile?: {
    /**
     * Phase 61 — accepts either raw strings (legacy CV / parser v1) or
     * Phase 52 SkillEntry-shaped objects (canonical post-Phase 52). The
     * merger upgrades strings to SkillEntry via `inferSkillBucket` +
     * neutral defaults (`baseWeight: 1.0`). Mixed arrays tolerated.
     */
    skills?: ReadonlyArray<string | { name: string; bucket?: string; proficiency?: string; evidenceCount?: number; baseWeight?: number }>
    name?: string | null
  }
  /**
   * v2 parser shape: { title, company, skills?, ... }. Pre-v2 docs may
   * not populate this (legacy CV with only `experiences[]`); we tolerate
   * both.
   */
  workHistory?: Array<{
    title?: string
    role?: string
    company?: string
    skills?: ReadonlyArray<string | { name: string; bucket?: string; proficiency?: string; evidenceCount?: number; baseWeight?: number }>
    bullets?: string[]
  }>
  /**
   * Legacy v1 shape — { company, title, ... }. When workHistory is
   * empty, we fall back to experiences[0] for recentRoleTitle /
   * recentCompany / workHistorySummary.
   */
  experiences?: Array<{
    title?: string
    company?: string
    description?: string
  }>
  /** Existing CV-derived industry buckets (canonical 10-tag enum). */
  industryTags?: string[]
  /** 1536d embedding pass-through. */
  embedding?: number[]
  embeddingModel?: string
  embeddingComputedAt?: string

  // ---- Phase 53 (PARSE-03..PARSE-05) — canonical Phase 52 vocab ----
  /**
   * Phase 52 canonical 42-token industry sectors. Distinct from
   * `industryTags` (legacy 10-tag bucket). Pass-through from
   * `parsedResumeData.industries` / second-pass override.
   */
  industrySector?: string[]
  /** Pass-through from `parsedResumeData.relevantIndustry`. */
  relevantIndustry?: string[]
  /** Pass-through from `parsedResumeData.relevantSpecialization`. */
  relevantSpecialization?: string[]
  /** Pass-through from `parsedResumeData.proposedTags`. */
  proposedTags?: string[]
}

export interface UserTagsInput {
  cv?: UserTagsCvInput
  statedPreferences?: StatedPreferences
  /**
   * Independent preferred-lang signal — falls back to
   * statedPreferences.preferredLang when absent. Caller may pass this
   * separately when applying mid-conversation lang lock without a full
   * statedPreferences fetch.
   */
  preferredLang?: "zh" | "en" | "mixed"
  /** ISO timestamp; pass-through to lastUpdatedFromCv when cv input present. */
  cvUpdatedAt?: string
  /** ISO timestamp; pass-through to lastUpdatedFromChat when statedPreferences present. */
  chatUpdatedAt?: string
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TECH_SKILL_TOKENS: ReadonlyArray<string> = [
  "python",
  "javascript",
  "typescript",
  "react",
  "node",
  "go ", // trailing space avoids matching "go" inside "logo"
  "golang",
  "rust",
  "c++",
  "java",
  "kotlin",
  "swift",
  "aws",
  "gcp",
  "azure",
  "docker",
  "kubernetes",
  "tensorflow",
  "pytorch",
  "graphql",
]

const KNOWN_INDUSTRY_TOKENS: ReadonlySet<string> = new Set([
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
])

/** Lowercase + collapse whitespace + trim. Returns null when empty. */
function normalizeSkill(raw: unknown): string | null {
  if (typeof raw !== "string") return null
  const norm = raw.toLowerCase().trim().replace(/\s+/g, " ")
  return norm.length > 0 ? norm : null
}

/**
 * Phase 61 — heuristic skill-name → SkillBucket inference. Maps common
 * skill names to one of the 10 Phase 52 SKILL_BUCKET_VOCAB tokens.
 * Returns `domain_specific` when no pattern matches.
 *
 * Used by `migrate-skills-to-objects.mjs` to upgrade legacy pa-users.tags
 * `skills: string[]` → `skills: SkillEntry[]` and by `mergeUserTags` to
 * stamp a sensible bucket on freshly-extracted CV skills.
 *
 * Order matters: more-specific patterns first (prevent "react" matching as
 * a programming-language).
 */
const SKILL_BUCKET_HEURISTICS: ReadonlyArray<[RegExp, SkillBucket]> = [
  // Programming languages — exact-token list. Keep BEFORE frameworks so e.g.
  // "java" doesn't get pulled into a future "javascript" framework regex.
  [
    /^(python|javascript|typescript|java|c\+\+|c#|c|go|golang|rust|ruby|swift|kotlin|scala|php|r|matlab|sql|html|css|bash|shell|perl|elixir|haskell|clojure|julia|dart|lua|objective-c|powershell)$/i,
    "programming_languages",
  ],
  // Frameworks & libraries
  [
    /^(react|reactjs|vue|vuejs|angular|next\.?js|nextjs|nuxt|svelte|django|flask|fastapi|rails|express|spring(\s|_)?boot|laravel|gatsby|remix|node\.?js|nodejs|graphql|redux|jest|mocha|cypress|playwright|tailwind|bootstrap|jquery|three\.?js|d3\.?js|electron|capacitor|expo|react(-|_)?native|flutter|axios|webpack|vite|rollup|babel)$/i,
    "frameworks_and_libraries",
  ],
  // Databases
  [
    /^(postgres(ql)?|mysql|mongodb|mongo|redis|elasticsearch|cassandra|dynamodb|snowflake|bigquery|sqlite|mariadb|oracle(\s|_)?db|sql(\s|_)?server|firebase(\s|_)?firestore|firestore|supabase|cockroachdb|neo4j|opensearch|clickhouse)$/i,
    "databases",
  ],
  // Cloud / infrastructure
  [
    /^(aws|amazon(\s|_)?web(\s|_)?services|gcp|google(\s|_)?cloud(\s|_)?platform|google(\s|_)?cloud|azure|microsoft(\s|_)?azure|kubernetes|docker|terraform|ansible|helm|vault|consul|nginx|apache|cloudflare|heroku|vercel|netlify|firebase|fastly|digitalocean|linode|openshift|ecs|eks|gke|aks|lambda|cloud(\s|_)?run|serverless)$/i,
    "cloud_and_infrastructure",
  ],
  // DevOps / tooling
  [
    /^(git|github|gitlab|bitbucket|jenkins|circle\s?ci|circleci|github\s?actions|gha|gitlab(\s|_)?ci|datadog|grafana|prometheus|sentry|new(\s|_)?relic|splunk|pagerduty|opsgenie|jira|confluence|slack|notion|linear|asana|trello|sonarqube|snyk|dependabot|renovate|pulumi|argo(\s|_)?cd|argocd|spinnaker|tekton|harness|fastlane|cocoapods|npm|yarn|pnpm|pip|cargo|maven|gradle|bazel|nx|lerna)$/i,
    "devops_and_tooling",
  ],
  // Data & ML
  [
    /^(machine(\s|_)?learning|deep(\s|_)?learning|nlp|natural(\s|_)?language(\s|_)?processing|computer(\s|_)?vision|pytorch|tensorflow|scikit(\s|_)?learn|sklearn|pandas|numpy|spark|kafka|airflow|dbt|huggingface|transformers|llm|rag|vector(\s|_)?database|embeddings|fine(\s|_)?tuning|reinforcement(\s|_)?learning|xgboost|lightgbm|keras|jax|mlflow|kubeflow|sagemaker|vertex(\s|_)?ai|databricks|snowpark|tableau|power(\s|_)?bi|looker|mixpanel|amplitude|segment|fivetran|stitch|hadoop|hive|presto|trino|flink|beam|opencv|spacy|nltk|gensim|prophet|statsmodels|matplotlib|seaborn|plotly|jupyter|colab|ray)$/i,
    "data_and_ml",
  ],
  // Design & UX
  [
    /^(figma|sketch|adobe|photoshop|illustrator|indesign|after(\s|_)?effects|premiere(\s|_)?pro|xd|design(\s|_)?systems?|ux|ui|wireframing|prototyping|user(\s|_)?research|usability(\s|_)?testing|interaction(\s|_)?design|visual(\s|_)?design|motion(\s|_)?design|invision|zeplin|framer|principle|webflow|axure|miro|whimsical)$/i,
    "design_and_ux",
  ],
  // Product & business
  [
    /^(product(\s|_)?management|roadmapping|stakeholder(\s|_)?management|okrs?|kpis?|analytics|product(\s|_)?strategy|go(\s|_)?to(\s|_)?market|gtm|product(\s|_)?marketing|growth|a\/b(\s|_)?testing|funnel(\s|_)?analysis|cohort(\s|_)?analysis|customer(\s|_)?research|jobs(\s|_)?to(\s|_)?be(\s|_)?done|jtbd|product(\s|_)?led(\s|_)?growth|plg)$/i,
    "product_and_business",
  ],
  // Soft skills
  [
    /^(communication|leadership|teamwork|presentation|mentorship|negotiation|public(\s|_)?speaking|conflict(\s|_)?resolution|cross(\s|_)?functional(\s|_)?collaboration|stakeholder(\s|_)?management|coaching|feedback|empathy|active(\s|_)?listening|critical(\s|_)?thinking|time(\s|_)?management|prioritization|decision(\s|_)?making|problem(\s|_)?solving)$/i,
    "soft_skills",
  ],
]

export function inferSkillBucket(name: string): SkillBucket {
  const n = (name ?? "").toLowerCase().trim()
  if (!n) return "domain_specific"
  for (const [re, bucket] of SKILL_BUCKET_HEURISTICS) {
    if (re.test(n)) return bucket
  }
  return "domain_specific"
}

/**
 * Phase 61 — common-abbreviation → spelled-out expansions for skill names.
 * The Phase 52 SkillNameSchema rejects `KNOWN_ABBREVIATIONS` (ml, ai, js,
 * ts, k8s, saas, ux, ui, ...) but these are real skills that show up on
 * every CV. Pre-expand common abbreviations to their spelled-out form
 * BEFORE validation so they pass the strict schema.
 */
const SKILL_ABBREV_EXPANSIONS: Record<string, string> = {
  ml: "machine_learning",
  ai: "artificial_intelligence",
  js: "javascript",
  ts: "typescript",
  py: "python",
  k8s: "kubernetes",
  saas: "software_as_a_service",
  ux: "user_experience",
  ui: "user_interface",
  oss: "open_source_software",
  pr: "pull_requests",
  ci: "continuous_integration",
  cd: "continuous_delivery",
  db: "databases",
  vm: "virtual_machines",
  iam: "identity_and_access_management",
  ide: "integrated_development_environment",
  cli: "command_line_interface",
  api: "application_programming_interfaces",
  hr: "human_resources_skill",
  kpi: "key_performance_indicators",
  qa: "quality_assurance",
  sre: "site_reliability_engineering",
  ds: "data_science",
  fe: "frontend_engineering",
  be: "backend_engineering",
  rfp: "request_for_proposal",
}

/**
 * Phase 61 — sanitize a free-form skill name for canonical storage. The
 * Phase 52 `SkillNameSchema` regex requires `^[a-z][a-z0-9_+#.-]{1,63}$`
 * (lowercase + underscore + dot + plus + hyphen) AND rejects entries in
 * KNOWN_ABBREVIATIONS. LLM / CV extraction routinely emits "C++",
 * "Node.js", "Spring Boot", "ML", "AI" — we collapse whitespace to
 * underscore, expand known abbreviations, and ensure first char is a
 * letter.
 *
 * Returns null for inputs that can't be canonicalized.
 */
export function canonicalizeSkillName(raw: string): string | null {
  if (typeof raw !== "string") return null
  let s = raw.toLowerCase().trim()
  if (!s) return null
  // collapse whitespace → underscore
  s = s.replace(/\s+/g, "_")
  // strip disallowed chars (keeps a-z 0-9 _ + # . -)
  s = s.replace(/[^a-z0-9_+#.\-]/g, "")
  if (!s) return null
  // Expand known abbreviations PRE-validation so they pass the schema.
  if (Object.prototype.hasOwnProperty.call(SKILL_ABBREV_EXPANSIONS, s)) {
    s = SKILL_ABBREV_EXPANSIONS[s]!
  }
  // ensure first char is a letter; prefix with `s_` if not
  if (!/^[a-z]/.test(s)) s = `s_${s}`
  // length constraint: min 2, max 64. Truncate when over.
  if (s.length < 2) return null
  if (s.length > 64) s = s.slice(0, 64)
  return s
}

/**
 * Phase 61 — turn a raw input (string OR existing SkillEntry-shaped object)
 * into a canonical Phase 52 `Skill` object. Used by `collectSkills` so the
 * merger output always matches the Phase 52 SkillSchema.
 *
 * Applied defaults when the input is a plain string:
 *   - bucket: `inferSkillBucket(name)` heuristic
 *   - proficiency: "intermediate" (neutral default)
 *   - evidenceCount: 1
 *   - baseWeight: 1.0 (full weight; Phase 56 V16 score =
 *     `baseWeight × jdRelative` — without baseWeight, JD-rel multiplier is
 *     wasted; default 1.0 makes legacy users score immediately).
 *
 * Returns null when the name fails the Phase 52 SKILL_NAME_PATTERN regex.
 */
function toSkillEntry(raw: unknown): Skill | null {
  // Object shape: pick `name` and pass-through `bucket` / `proficiency` /
  // `evidenceCount` / `baseWeight` if present.
  if (raw && typeof raw === "object") {
    const obj = raw as Record<string, unknown>
    const rawName = typeof obj.name === "string" ? obj.name : null
    if (!rawName) return null
    const name = canonicalizeSkillName(rawName)
    if (!name) return null
    const bucket = (typeof obj.bucket === "string" ? obj.bucket : inferSkillBucket(name)) as SkillBucket
    const proficiency = typeof obj.proficiency === "string" ? obj.proficiency : "intermediate"
    const evidenceCount =
      typeof obj.evidenceCount === "number" && Number.isFinite(obj.evidenceCount)
        ? Math.max(0, Math.floor(obj.evidenceCount))
        : 1
    const baseWeight =
      typeof obj.baseWeight === "number" && Number.isFinite(obj.baseWeight)
        ? Math.max(0, Math.min(1, obj.baseWeight))
        : 1.0
    try {
      return SkillSchema.parse({ name, bucket, proficiency, evidenceCount, baseWeight })
    } catch {
      return null
    }
  }
  // String shape: build with defaults.
  if (typeof raw === "string") {
    const norm = canonicalizeSkillName(raw)
    if (!norm) return null
    try {
      return SkillSchema.parse({
        name: norm,
        bucket: inferSkillBucket(norm),
        proficiency: "intermediate",
        evidenceCount: 1,
        baseWeight: 1.0,
      })
    } catch {
      return null
    }
  }
  return null
}

/**
 * Returns the de-duplicated SkillEntry list from the CV. Order is
 * insertion order across:
 *   1. candidateProfile.skills (LLM-extracted; canonical priority)
 *   2. workHistory[].skills (per-job skills; supplemental)
 *
 * Each input string is upgraded to a Phase 52 SkillEntry via
 * `toSkillEntry` (heuristic bucket + neutral defaults). Empty / non-array
 * inputs return [].
 */
function collectSkills(cv: UserTagsCvInput | undefined): Skill[] {
  if (!cv) return []
  const seen = new Set<string>()
  const skills: Skill[] = []
  const ingest = (raw: unknown): void => {
    const entry = toSkillEntry(raw)
    if (!entry) return
    if (seen.has(entry.name)) return
    seen.add(entry.name)
    skills.push(entry)
  }
  if (Array.isArray(cv.candidateProfile?.skills)) {
    for (const s of cv.candidateProfile.skills) ingest(s)
  }
  if (Array.isArray(cv.workHistory)) {
    for (const w of cv.workHistory) {
      if (Array.isArray(w?.skills)) {
        for (const s of w.skills) ingest(s)
      }
    }
  }
  return skills
}

/**
 * Detect industry bucket from skill bag using known tech tokens. Returns
 * `["tech_software"]` when any tech token is present, otherwise [].
 *
 * Phase 61 — accepts SkillEntry[] (matching the Phase 52 canonical schema).
 */
function inferIndustryFromSkills(skills: ReadonlyArray<Skill>): IndustryTag[] {
  for (const s of skills) {
    const name = (s?.name ?? "").toLowerCase()
    for (const tok of TECH_SKILL_TOKENS) {
      if (name === tok.trim()) return ["tech_software"]
      if (name.includes(tok)) return ["tech_software"]
    }
  }
  return []
}

/** Filter raw industryTags array → known tokens; drop "other" when other tags exist. */
function filterIndustryTags(raw: string[] | undefined): IndustryTag[] {
  if (!Array.isArray(raw)) return []
  const filtered = raw.filter(
    (t): t is IndustryTag =>
      typeof t === "string" && KNOWN_INDUSTRY_TOKENS.has(t)
  )
  // If only "other", treat as "no signal" so the priority chain falls
  // through to fallback heuristics.
  if (filtered.length === 0) return []
  if (filtered.every((t) => t === "other")) return []
  // Preserve order, drop "other" when other tags are present.
  return filtered.filter((t) => t !== "other")
}

/**
 * Compose industryEnum following the priority chain:
 *   1. CV.industryTags (filtered ≠ ["other"])
 *   2. roleToIndustryBuckets(statedPreferences.targetRole)
 *   3. tech-token sniff on skills
 *   4. ["other"]
 *
 * Phase 61 — `skills` is now `ReadonlyArray<Skill>` (Phase 52 canonical
 * shape) so the sniff inspects `skill.name` instead of the raw string.
 */
function composeIndustryEnum(
  cv: UserTagsCvInput | undefined,
  statedPreferences: StatedPreferences | undefined,
  skills: ReadonlyArray<Skill>
): IndustryTag[] {
  // 1. CV.industryTags (filtered).
  const fromCv = filterIndustryTags(cv?.industryTags)
  if (fromCv.length > 0) return fromCv

  // 2. Map from targetRole. statedPreferences.targetRole stores
  //    canonicalized tokens (closed enum) — passing through as
  //    CanonicalRole[] is safe at runtime.
  const targetRole = statedPreferences?.targetRole
  if (Array.isArray(targetRole) && targetRole.length > 0) {
    const buckets = roleToIndustryBuckets(targetRole as CanonicalRole[])
    if (Array.isArray(buckets) && buckets.length > 0) return [...buckets]
  }

  // 3. Sniff tech tokens in skill bag.
  const fromSkills = inferIndustryFromSkills(skills)
  if (fromSkills.length > 0) return fromSkills

  // 4. Fallback.
  return ["other"]
}

/**
 * Pick recent role title + company from workHistory[0] (preferred) or
 * experiences[0] (legacy fallback). Trims + drops empty strings.
 */
function pickRecentRole(
  cv: UserTagsCvInput | undefined
): { title?: string; company?: string } {
  if (!cv) return {}
  const wh = Array.isArray(cv.workHistory) ? cv.workHistory[0] : undefined
  if (wh) {
    const title =
      typeof wh.title === "string" && wh.title.trim().length > 0
        ? wh.title.trim()
        : typeof wh.role === "string" && wh.role.trim().length > 0
          ? wh.role.trim()
          : undefined
    const company =
      typeof wh.company === "string" && wh.company.trim().length > 0
        ? wh.company.trim()
        : undefined
    if (title || company) return { title, company }
  }
  const ex = Array.isArray(cv.experiences) ? cv.experiences[0] : undefined
  if (ex) {
    const title =
      typeof ex.title === "string" && ex.title.trim().length > 0
        ? ex.title.trim()
        : undefined
    const company =
      typeof ex.company === "string" && ex.company.trim().length > 0
        ? ex.company.trim()
        : undefined
    if (title || company) return { title, company }
  }
  return {}
}

const WORK_HISTORY_SUMMARY_CAP = 200

/**
 * Build a 1-line summary of the first 3 roles. Format:
 *   "Title @ Company; Title @ Company; Title @ Company"
 *
 * Each segment skipped when both title + company are empty. Whole string
 * soft-capped at 200 chars (suffixed with "…" when truncated).
 */
function buildWorkHistorySummary(cv: UserTagsCvInput | undefined): string | undefined {
  if (!cv) return undefined
  const segments: string[] = []
  const wh = Array.isArray(cv.workHistory) ? cv.workHistory : []
  for (const w of wh.slice(0, 3)) {
    const title =
      typeof w.title === "string" && w.title.trim().length > 0
        ? w.title.trim()
        : typeof w.role === "string" && w.role.trim().length > 0
          ? w.role.trim()
          : ""
    const company =
      typeof w.company === "string" && w.company.trim().length > 0
        ? w.company.trim()
        : ""
    if (!title && !company) continue
    if (title && company) segments.push(`${title} @ ${company}`)
    else if (title) segments.push(title)
    else segments.push(company)
  }
  // Fallback to experiences[] when workHistory empty.
  if (segments.length === 0) {
    const ex = Array.isArray(cv.experiences) ? cv.experiences : []
    for (const e of ex.slice(0, 3)) {
      const title =
        typeof e.title === "string" && e.title.trim().length > 0
          ? e.title.trim()
          : ""
      const company =
        typeof e.company === "string" && e.company.trim().length > 0
          ? e.company.trim()
          : ""
      if (!title && !company) continue
      if (title && company) segments.push(`${title} @ ${company}`)
      else if (title) segments.push(title)
      else segments.push(company)
    }
  }
  if (segments.length === 0) return undefined
  let out = segments.join("; ")
  if (out.length > WORK_HISTORY_SUMMARY_CAP) {
    out = out.slice(0, WORK_HISTORY_SUMMARY_CAP - 1) + "…"
  }
  return out
}

/** Map StatedPreferences.visaStatus → tag-schema visa token. */
function mapVisaStatus(v: StatedPreferences["visaStatus"]): TagsVisaStatus | undefined {
  if (v == null) return undefined
  switch (v) {
    case "citizen":
    case "gc":
    case "opt":
    case "h1b":
      return v
    case "sponsorship_needed":
      return "sponsor_needed"
    case "unknown":
      return "other"
    default:
      return undefined
  }
}

/** Map StatedPreferences.prefersStartup (boolean | null) → tag-schema enum. */
function mapPrefersStartup(
  v: StatedPreferences["prefersStartup"]
): StartupPreference | undefined {
  if (v === true) return "startup"
  if (v === false) return "bigtech"
  if (v === null) return "either"
  return undefined
}

/** Map preferredLang signal — drop "mixed" (caller falls back to runtime detect). */
function mapPreferredLang(
  fromInput: UserTagsInput["preferredLang"],
  fromPrefs: StatedPreferences["preferredLang"]
): TagsPreferredLang | undefined {
  const v = fromInput ?? fromPrefs
  if (v === "zh" || v === "en") return v
  return undefined
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Fold the 4+ disjoint candidate-signal sources (CV doc, statedPreferences,
 * embedding fields, lang lock) into one canonical `UserTags` object that
 * lives at `pa-users/{userId}.tags`.
 *
 * Pure / deterministic. Does NOT mutate input. Does NOT touch Firestore.
 * Caller is responsible for read + write side effects (H.3 worker).
 */
export function mergeUserTags(input: UserTagsInput): UserTags {
  const { cv, statedPreferences, cvUpdatedAt, chatUpdatedAt } = input

  // ---- CV side --------------------------------------------------------
  const skills = collectSkills(cv)
  const industryEnum = composeIndustryEnum(cv, statedPreferences, skills)
  const { title: recentRoleTitle, company: recentCompany } = pickRecentRole(cv)
  const workHistorySummary = buildWorkHistorySummary(cv)

  // ---- embedding pass-through ----------------------------------------
  let embedding: number[] | undefined
  let embeddingModel: string | undefined
  let embeddingComputedAt: string | undefined
  if (cv?.embedding && Array.isArray(cv.embedding) && cv.embedding.length === 1536) {
    embedding = cv.embedding
    if (typeof cv.embeddingModel === "string" && cv.embeddingModel.length > 0) {
      embeddingModel = cv.embeddingModel
    }
    if (typeof cv.embeddingComputedAt === "string" && cv.embeddingComputedAt.length > 0) {
      embeddingComputedAt = cv.embeddingComputedAt
    }
  }

  // ---- chat side ------------------------------------------------------
  const targetRole = Array.isArray(statedPreferences?.targetRole)
    ? [...statedPreferences.targetRole]
    : undefined
  const yoeRange =
    Array.isArray(statedPreferences?.yoeRange) && statedPreferences.yoeRange.length === 2
      ? ([statedPreferences.yoeRange[0], statedPreferences.yoeRange[1]] as [number, number])
      : undefined
  const visaStatus = mapVisaStatus(statedPreferences?.visaStatus)
  const prefersStartup = mapPrefersStartup(statedPreferences?.prefersStartup)
  const targetLocations = Array.isArray(statedPreferences?.targetLocations)
    ? [...statedPreferences.targetLocations]
    : undefined
  const preferredLang = mapPreferredLang(input.preferredLang, statedPreferences?.preferredLang)

  // ---- Phase 53 — canonical Phase 52 fields pass-through --------------
  // Each field defensively normalized: lowercase + trimmed strings, dedupe.
  const dedupedStrings = (
    raw: string[] | undefined,
    cap?: number
  ): string[] | undefined => {
    if (!Array.isArray(raw)) return undefined
    const seen = new Set<string>()
    const out: string[] = []
    for (const v of raw) {
      if (typeof v !== "string") continue
      const norm = v.trim().toLowerCase()
      if (norm.length === 0 || seen.has(norm)) continue
      seen.add(norm)
      out.push(norm)
      if (cap && out.length >= cap) break
    }
    return out.length > 0 ? out : undefined
  }
  const industrySector = dedupedStrings(cv?.industrySector, 6)
  const relevantIndustry = dedupedStrings(cv?.relevantIndustry, 6)
  const relevantSpecialization = dedupedStrings(cv?.relevantSpecialization, 6)
  const proposedTags = dedupedStrings(cv?.proposedTags, 12)

  // ---- assemble + omit-undefined --------------------------------------
  // We deliberately avoid placing `undefined` keys on the output so the
  // shape round-trips through Firestore (Firestore drops `undefined` on
  // write but preserves `null` — exact-match tests are easier without
  // either).
  const out: UserTags = {
    skills,
    industryEnum,
    schemaVersion: USER_TAGS_SCHEMA_VERSION,
  }
  if (recentRoleTitle) out.recentRoleTitle = recentRoleTitle
  if (recentCompany) out.recentCompany = recentCompany
  if (workHistorySummary) out.workHistorySummary = workHistorySummary
  if (embedding) out.embedding = embedding
  if (embeddingModel) out.embeddingModel = embeddingModel
  if (embeddingComputedAt) out.embeddingComputedAt = embeddingComputedAt
  if (targetRole) out.targetRole = targetRole
  if (yoeRange) out.yoeRange = yoeRange
  if (visaStatus) out.visaStatus = visaStatus
  if (prefersStartup) out.prefersStartup = prefersStartup
  if (targetLocations) out.targetLocations = targetLocations
  if (preferredLang) out.preferredLang = preferredLang
  if (industrySector) out.industrySector = industrySector
  if (relevantIndustry) out.relevantIndustry = relevantIndustry
  if (relevantSpecialization) out.relevantSpecialization = relevantSpecialization
  if (proposedTags) out.proposedTags = proposedTags
  if (cv && cvUpdatedAt) out.lastUpdatedFromCv = cvUpdatedAt
  if (statedPreferences && chatUpdatedAt) out.lastUpdatedFromChat = chatUpdatedAt

  return out
}
