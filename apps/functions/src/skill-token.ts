/**
 * skill-token.ts — canonical form for a single skill token, shared by the cohort normalizer
 * (scripts/normalize-yc-skills.ts) and the matcher's facet stage (yc-people-match.ts).
 *
 * WHY IT LIVES IN src/: stored skills are canonicalized with abbreviations EXPANDED
 * (`ml` → `machine learning`), so a raw "ML" typed by the model would no longer substring-hit
 * anything. Query and storage MUST use the same function or the facet silently returns nobody.
 * The script cannot own it — `apps/functions/tsconfig.json` has rootDir `src/`, so `src/` may not
 * import from `scripts/`.
 */
import { canonicalizeSkillName, inferSkillBucket } from "@pa/pa-orchestrator"

const TECH_EXTRA = new Set([
  "artificial_intelligence",
  "software_engineering",
  "computer_science",
  "web_development",
  "app_development",
  "mobile_development",
  "full_stack_development",
  "frontend_development",
  "backend_development",
  "distributed_systems",
  "cybersecurity",
  "robotics",
  "computer_vision",
  "large_language_models",
  "generative_artificial_intelligence",
  "blockchain",
  "cryptography",
  "quantitative_finance",
  "bioinformatics",
  "biotechnology",
  "hardware_engineering",
  "electrical_engineering",
  "mechanical_engineering",
  "systems_programming",
  "embedded_systems",
  "data_engineering",
  "data_science",
  "prompt_engineering",
  "neural_networks",
  "reinforcement_learning",
  "natural_language_processing",
])

const SIGNAL_BUCKETS = new Set([
  "programming_languages",
  "frameworks_and_libraries",
  "databases",
  "cloud_and_infrastructure",
  "devops_and_tooling",
  "data_and_ml",
  "design_and_ux",
])

const ROLE_NOUNS = new Set([
  "engineer", "developer", "analyst", "manager", "director", "assistant", "consultant", "intern",
  "tutor", "teacher", "professor", "instructor", "ambassador", "founder", "cofounder", "co-founder",
  "officer", "specialist", "associate", "scientist", "president", "chief", "lead", "head",
  "researcher", "coordinator", "administrator", "representative", "advisor", "recruiter", "student",
  "volunteer", "partner", "member", "staff", "worker", "trainee", "fellow", "apprentice",
])

const DENY = new Set([
  // stopwords / fragments Coresignal emits as "skills"
  "across", "per", "get", "set", "see", "well", "reach", "access", "core", "track", "stack", "raw",
  "gap", "natural", "smart", "incoming", "various", "using", "ases", "led", "leading", "guiding",
  "conducting", "overseeing", "managing", "designing", "analyzing", "collaborating", "optimizing",
  "organizing", "founding", "serving", "assist", "closing", "coordinating", "leveraging",
  "utilizing", "ensuring", "providing", "supporting", "creating", "building", "working", "helping",
  // generic business/process nouns
  "support", "models", "technology", "process", "processes", "service", "services", "teams", "team",
  "events", "education", "board", "organization", "production", "feedback", "ideas", "discovery",
  "delivery", "execution", "engagement", "promotion", "portfolio", "equity", "safety", "policy",
  "corporate", "reports", "structures", "interface", "framework", "operations", "strategy",
  "innovation", "creativity", "impact", "launch", "scale", "revenue", "funding", "growth",
  "management", "development", "planning", "coordination", "documentation", "onboarding",
  "efficiency", "evaluation", "benchmarking", "tracking", "engineering", "research", "data",
  "analysis", "design", "programming", "coding", "code", "testing", "training", "teaching",
  "mentoring", "mentorship", "coaching", "tutoring", "writing", "media", "integration",
  "implementation", "maintenance", "networking", "computing", "hardware", "software", "server",
  "networks", "database", "databases", "pipelines", "pipeline", "infrastructure", "architecture",
  "deployment", "monitoring", "workflow", "workflows", "detection", "classification", "modeling",
  "optimization", "simulation", "visualization", "analytics", "statistics", "mathematics", "math",
  "physics", "english", "science", "technical", "quantitative", "administration", "compliance",
  "logistics", "outreach", "workshops", "presentations", "hosting", "customization", "acquisition",
  "partnerships", "fundraising", "startup", "startups", "entrepreneurship", "business", "finance",
  "sales", "marketing", "consulting", "advisory", "recruiting", "hiring", "budgeting", "trading",
  "investment", "clinical", "healthcare", "electronics", "electrical", "datasets", "graph",
  "structures", "algorithms", "automation", "security", "reliability", "performance", "quality",
  "productivity", "sustainability", "operations_management", "real-time", "end-to-end",
  "cross-functional", "professional", "corporate_communications",
  // soft skills — true of everyone at a startup event
  "leadership", "communication", "communications", "collaboration", "teamwork", "public_speaking",
  "problem_solving", "critical_thinking", "time_management", "decision_making", "creativity",
  "adaptability", "organization_skills", "interpersonal_skills", "presentation",
  // "<x> skills" buckets Coresignal loves
  "technical_skills", "analytical_skills", "research_skills", "laboratory_skills",
  "secretarial_skills", "soft_skills", "office_software", "microsoft_office", "microsoft",
  "computer_skills", "communication_skills", "leadership_skills", "organizational_skills",
  // single-word residue found by ranking surviving single-word tokens by cohort frequency
  // (the dry run prints this list, so it stays auditable rather than guessed)
  "ran", "case", "progress", "views", "basic", "grade", "pages", "fast", "produce", "post", "start",
  "aims", "turn", "step", "steps", "clean", "join", "fair", "air", "scratch", "rapid", "publish",
  "translate", "inspire", "premier", "camp", "san", "collection", "report", "structure", "records",
  "history", "selection", "boost", "display", "demonstration", "talks", "idea", "asset", "flow",
  "massive", "box", "wave", "stars", "dec", "yield", "tolerance", "commercial", "standards",
  "precision", "stakeholders", "leads", "liaison", "facilitator", "editor", "artist", "scout",
  "trainer", "investor", "investors", "designer", "ceo", "cto", "coo", "cfo", "sde", "dev",
  // known Coresignal taxonomy junk
  "large-scale_scrum", "gnu_make", "systems_management", "platform_management", "material_management",
  "unified_communications", "store_operations", "catalog_management", "pipeline_management",
])

const KEEP_SHORT = new Set([
  "go", "c++", "c#", "sql", "aws", "git", "css", "php", "ios", "rag", "seo", "etl", "crm", "cad",
  "3d", "cnn", "rnn", "gpt", "vue", "jax", "gpu", "sdk", "sap", "erp", "iot", "vpn", "ros",
])

function isTechnical(canon: string): boolean {
  return TECH_EXTRA.has(canon) || SIGNAL_BUCKETS.has(inferSkillBucket(canon))
}

const ALIASES: Record<string, string> = {
  aiml: "machine_learning",
  ai_ml: "machine_learning",
  // `rl` and a bare stored `reinforcement` both canonicalized to nothing, so the skills facet
  // returned ZERO people for "rl" and only 46 of 56 for "reinforcement learning" (measured on the
  // 988-person cohort, 2026-07-25). An alias is the right home for this: the ambiguity ("RL" can
  // mean real life) is resolved by the agent ASKING before it matches, not by the token table
  // refusing to resolve.
  rl: "reinforcement_learning",
  reinforcement: "reinforcement_learning",
  llm: "large_language_models",
  llms: "large_language_models",
  large_language_model: "large_language_models",
  generative_ai: "generative_artificial_intelligence",
  cascading_style_sheets: "css",
  "react.js": "react",
  reactjs: "react",
  "node.js": "nodejs",
  "next.js": "nextjs",
  "vue.js": "vue",
  golang: "go",
  postgres: "postgresql",
  sklearn: "scikit_learn",
  "scikit-learn": "scikit_learn",
  full_stack: "full_stack_development",
  fullstack_development: "full_stack_development",
  front_end_development: "frontend_development",
  back_end_development: "backend_development",
  deep_learning_dl: "deep_learning",
  computer_vision_cv: "computer_vision",
  artificial_intelligence_ai: "artificial_intelligence",
  natural_language_processing_nlp: "natural_language_processing",
}

export function normalizeSkillToken(raw: string): string | null {
  if (typeof raw !== "string") return null
  // "python (programming language)" / "artificial intelligence (ai)" → keep the outer text; the
  // parenthetical is always either the abbreviation or the disambiguator, never new signal.
  let s = raw.toLowerCase().replace(/\([^)]*\)/g, " ").replace(/[/,]/g, " ").trim()
  if (!s) return null
  let canon = canonicalizeSkillName(s)
  if (!canon) return null
  canon = canon.replace(/^s_/, "").replace(/-/g, "_").replace(/_+/g, "_").replace(/^_|_$/g, "")
  if (ALIASES[canon]) canon = ALIASES[canon]!
  if (!canon) return null

  const bare = canon.replace(/_/g, "")
  if (bare.length < 4 && !KEEP_SHORT.has(canon)) return null
  if (DENY.has(canon)) return null
  const words = canon.split("_")
  if (ROLE_NOUNS.has(words[words.length - 1]!)) return null
  // bare past-tense verbs ("led", "integrated") that no vocabulary recognizes
  if (words.length === 1 && /(ed|ing)$/.test(canon) && !isTechnical(canon) && !DENY.has(canon)) {
    if (!/(engineering|marketing|consulting|banking|forecasting|accounting)$/.test(canon)) return null
  }
  // 4+ word phrases are always scraped sentence fragments, never skills
  if (words.length > 3) return null
  return canon
}

const display = (canon: string) => canon.replace(/_/g, " ")

/** Deterministic skill extraction from free text — used for records Coresignal left empty. */
