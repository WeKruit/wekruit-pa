#!/usr/bin/env node
/**
 * iter30 WS2 P2 — Seed pa-canonical-tags from existing PA constants.
 *
 * Sources:
 *  1. INDUSTRY_TAGS (10) + INDUSTRY_KEY_MAP (~250 aliases)
 *     → type="industry", canonicalKey = kebab-case of industry tag
 *  2. AI_AGENT_SKILL_WEIGHTS (30 rows)
 *     → type="skill", canonicalKey = skill slug
 *
 * Total: ~280 canonical tag documents.
 *
 * Idempotent: uses Firestore .set({merge: false}) with create-or-skip logic.
 * Re-running the script will update aliases/displayName but never overwrite
 * humanApproved status or confidence.
 *
 * Usage:
 *   node apps/functions/scripts/seed-canonical-tags.mjs [--dry-run]
 *   node apps/functions/scripts/seed-canonical-tags.mjs --project wekruit-5f89b
 *
 * Auth: picks up GOOGLE_APPLICATION_CREDENTIALS from env (set by CLAUDE.md
 * bootstrap) or gcloud ADC.
 */

import { initializeApp, cert, getApps } from "firebase-admin/app"
import { getFirestore, FieldValue } from "firebase-admin/firestore"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { join, dirname } from "node:path"

const __dirname = dirname(fileURLToPath(import.meta.url))

// ─── CLI flags ────────────────────────────────────────────────────────────────

const args = process.argv.slice(2)
const DRY_RUN = args.includes("--dry-run")
const PROJECT = (() => {
  const idx = args.indexOf("--project")
  return idx >= 0 ? args[idx + 1] : "wekruit-5f89b"
})()

// ─── Firebase init ────────────────────────────────────────────────────────────

function initFirebase() {
  if (getApps().length > 0) return
  const credPath = process.env.GOOGLE_APPLICATION_CREDENTIALS
  if (credPath) {
    try {
      const cred = JSON.parse(readFileSync(credPath, "utf8"))
      initializeApp({ credential: cert(cred), projectId: PROJECT })
      return
    } catch {
      // fall through to ADC
    }
  }
  initializeApp({ projectId: PROJECT })
}

// ─── Industry seed data ───────────────────────────────────────────────────────

/**
 * The 10 canonical industry tags (English labels + display names).
 * Mirrored from apps/functions/src/cv-ingest/industry-tags.ts.
 */
const INDUSTRY_TAGS = [
  { key: "tech_software", displayName: "Tech / Software", aliases: ["tech", "software", "internet", "saas", "enterprise_saas", "cloud", "devops", "it", "it_services", "cybersecurity", "security", "technology", "telecom", "telecommunications", "web", "software_development"] },
  { key: "tech_hardware", displayName: "Hardware / Semiconductors", aliases: ["hardware", "semiconductors", "semiconductor", "electronics", "consumer_electronics", "iot", "robotics"] },
  { key: "fintech_finance", displayName: "Fintech / Finance", aliases: ["fintech", "finance", "banking", "accounting_finance", "insurance", "investment", "trading", "hedge_fund", "financial_services", "reinsurance", "insurance_services"] },
  { key: "ai_ml", displayName: "AI / ML", aliases: ["ai", "ai_ml", "ml", "machine_learning", "data_science", "data_analytics", "data", "ai_infrastructure", "artificial intelligence", "machine learning", "data science"] },
  { key: "healthcare_biotech", displayName: "Healthcare / Biotech", aliases: ["healthtech", "healthcare", "biotech", "biotechnology", "pharmaceutical", "pharma", "medical", "medical_devices"] },
  { key: "consumer_retail", displayName: "Consumer / Retail", aliases: ["consumer", "retail", "ecommerce", "e_commerce", "food_beverage", "hospitality", "restaurants", "travel", "real_estate", "apparel", "beauty", "grocery"] },
  { key: "media_entertainment", displayName: "Media / Entertainment", aliases: ["media", "entertainment", "arts_entertainment", "gaming", "games", "social_media", "publishing", "music", "film"] },
  { key: "manufacturing_industrial", displayName: "Manufacturing / Industrial", aliases: ["manufacturing", "industrial", "energy", "oil_gas", "utilities", "construction", "automotive", "aerospace", "aerospace_defense", "defense", "mining", "agriculture", "chemicals", "materials", "logistics", "transportation"] },
  { key: "education", displayName: "Education / EdTech", aliases: ["education", "edtech"] },
  { key: "other", displayName: "Other", aliases: ["other", "unknown"] },
]

// ─── Skill seed data ──────────────────────────────────────────────────────────

/**
 * AI agent skill weights from apps/job-rec/src/match-weights.ts
 * AI_AGENT_SKILL_WEIGHTS (30 rows).
 */
const AI_AGENT_SKILLS = [
  { skill: "rag", displayName: "RAG", aliases: ["rag", "retrieval-augmented generation", "retrieval augmented generation", "rag pipeline"] },
  { skill: "retrieval-augmented", displayName: "Retrieval-Augmented Generation", aliases: ["retrieval-augmented", "retrieval augmented", "rag", "retrieval augmented generation"] },
  { skill: "function-calling", displayName: "Function Calling", aliases: ["function calling", "function-calling", "tool calling", "tool-calling", "tool use", "tool-use"] },
  { skill: "tool-calling", displayName: "Tool Calling", aliases: ["tool calling", "tool-calling", "function calling", "function-calling", "tool use"] },
  { skill: "tool-use", displayName: "Tool Use", aliases: ["tool use", "tool-use", "tool calling", "function calling"] },
  { skill: "workflow-orchestration", displayName: "Workflow Orchestration", aliases: ["workflow orchestration", "workflow-orchestration", "orchestration", "agent orchestration"] },
  { skill: "agentic", displayName: "Agentic AI", aliases: ["agentic", "agentic ai", "ai agent", "agent-based", "autonomous agent"] },
  { skill: "multi-turn-state", displayName: "Multi-Turn State", aliases: ["multi-turn state", "multi-turn-state", "multi turn state", "conversational state", "stateful conversation"] },
  { skill: "multi-turn", displayName: "Multi-Turn", aliases: ["multi-turn", "multi turn", "multi-turn conversation", "multi-turn dialogue"] },
  { skill: "langchain", displayName: "LangChain", aliases: ["langchain", "lang chain", "langchain.js", "langchainjs"] },
  { skill: "llamaindex", displayName: "LlamaIndex", aliases: ["llamaindex", "llama index", "llama-index"] },
  { skill: "vector-database", displayName: "Vector Database", aliases: ["vector database", "vector-database", "vector db", "vector store", "vectorstore", "vector search"] },
  { skill: "embedding", displayName: "Embeddings", aliases: ["embedding", "embeddings", "text embedding", "text embeddings", "vector embedding"] },
  { skill: "prompt-engineering", displayName: "Prompt Engineering", aliases: ["prompt engineering", "prompt-engineering", "prompt design", "prompt crafting"] },
  { skill: "evaluation", displayName: "LLM Evaluation", aliases: ["evaluation", "eval", "llm eval", "model evaluation", "evals"] },
  { skill: "eval-harness", displayName: "Eval Harness", aliases: ["eval harness", "eval-harness", "evaluation harness", "evals framework"] },
  { skill: "fine-tuning", displayName: "Fine-Tuning", aliases: ["fine-tuning", "finetuning", "fine tuning", "model fine-tuning", "lora", "qlora", "instruction tuning"] },
  { skill: "openai", displayName: "OpenAI", aliases: ["openai", "open ai", "gpt", "gpt-4", "chatgpt", "gpt4"] },
  { skill: "anthropic", displayName: "Anthropic / Claude", aliases: ["anthropic", "claude", "claude-3", "claude api"] },
  { skill: "llm", displayName: "LLM", aliases: ["llm", "large language model", "large language models", "foundation model", "language model"] },
  { skill: "python", displayName: "Python", aliases: ["python", "python3", "python 3", "py"] },
  { skill: "sql", displayName: "SQL", aliases: ["sql", "mysql", "postgresql", "postgres", "sqlite", "bigquery sql"] },
  { skill: "javascript", displayName: "JavaScript", aliases: ["javascript", "js", "es6", "ecmascript", "node.js", "nodejs"] },
  { skill: "typescript", displayName: "TypeScript", aliases: ["typescript", "ts", "tsx"] },
  { skill: "git", displayName: "Git", aliases: ["git", "github", "gitlab", "version control"] },
  { skill: "docker", displayName: "Docker", aliases: ["docker", "docker-compose", "dockerfile", "containerization"] },
  { skill: "aws", displayName: "AWS", aliases: ["aws", "amazon web services", "s3", "lambda", "ec2", "sagemaker"] },
  { skill: "gcp", displayName: "GCP", aliases: ["gcp", "google cloud", "google cloud platform", "bigquery", "vertex ai", "cloud run"] },
  { skill: "kubernetes", displayName: "Kubernetes", aliases: ["kubernetes", "k8s", "container orchestration", "helm", "kubectl"] },
]

// ─── Seed logic ───────────────────────────────────────────────────────────────

/**
 * Convert a tag key (snake_case or hyphen) to kebab-case canonicalKey.
 */
function toKebab(key) {
  return key.toLowerCase().replace(/_/g, "-").replace(/\s+/g, "-").replace(/-+/g, "-")
}

async function seedIndustryTags(db) {
  let created = 0
  let skipped = 0
  const now = new Date().toISOString()

  for (const industry of INDUSTRY_TAGS) {
    const canonicalKey = toKebab(industry.key)
    const docRef = db.collection("pa-canonical-tags").doc(canonicalKey)

    if (DRY_RUN) {
      console.log(`[DRY RUN] would seed industry: ${canonicalKey} (${industry.displayName}) — ${industry.aliases.length} aliases`)
      created++
      continue
    }

    const existing = await docRef.get()
    if (existing.exists) {
      const data = existing.data()
      // Only update aliases (append), never downgrade approvalStatus
      const newAliases = [...new Set([...(data.aliases ?? []), ...industry.aliases.map(a => a.toLowerCase().trim())])]
      await docRef.update({ aliases: newAliases, updatedAt: now })
      skipped++
      continue
    }

    await docRef.set({
      canonicalKey,
      type: "industry",
      displayName: industry.displayName,
      aliases: industry.aliases.map(a => a.toLowerCase().trim()),
      confidence: 1.0, // seeded from hand-curated list
      evidence: [],
      approvalStatus: "human-approved",
      mutexGroup: canonicalKey,
      schemaVersion: "v1",
      createdAt: now,
      updatedAt: now,
    })
    created++
  }

  return { created, skipped }
}

async function seedSkillTags(db) {
  let created = 0
  let skipped = 0
  const now = new Date().toISOString()

  for (const skill of AI_AGENT_SKILLS) {
    const canonicalKey = toKebab(skill.skill)
    const docRef = db.collection("pa-canonical-tags").doc(canonicalKey)

    if (DRY_RUN) {
      console.log(`[DRY RUN] would seed skill: ${canonicalKey} (${skill.displayName}) — ${skill.aliases.length} aliases`)
      created++
      continue
    }

    const existing = await docRef.get()
    if (existing.exists) {
      const data = existing.data()
      const newAliases = [...new Set([...(data.aliases ?? []), ...skill.aliases.map(a => a.toLowerCase().trim())])]
      await docRef.update({ aliases: newAliases, updatedAt: now })
      skipped++
      continue
    }

    await docRef.set({
      canonicalKey,
      type: "skill",
      displayName: skill.displayName,
      aliases: skill.aliases.map(a => a.toLowerCase().trim()),
      confidence: 0.9, // seeded from match-weights (AI_AGENT_SKILL_WEIGHTS)
      evidence: [],
      approvalStatus: "human-approved",
      mutexGroup: canonicalKey,
      schemaVersion: "v1",
      createdAt: now,
      updatedAt: now,
    })
    created++
  }

  return { created, skipped }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`Seeding pa-canonical-tags (project=${PROJECT}, dry-run=${DRY_RUN})`)

  initFirebase()
  const db = getFirestore()

  console.log("\n─── Industry tags ────────────────────────────────────────────")
  const industryResult = await seedIndustryTags(db)
  console.log(`Industry: created=${industryResult.created}, updated/skipped=${industryResult.skipped}`)

  console.log("\n─── Skill tags (AI_AGENT_SKILL_WEIGHTS) ─────────────────────")
  const skillResult = await seedSkillTags(db)
  console.log(`Skills:   created=${skillResult.created}, updated/skipped=${skillResult.skipped}`)

  const totalCreated = industryResult.created + skillResult.created
  const totalSkipped = industryResult.skipped + skillResult.skipped
  console.log(`\n✓ Seed complete: ${totalCreated} created, ${totalSkipped} updated/skipped`)
  console.log(`  Total canonical tags seeded: ${INDUSTRY_TAGS.length + AI_AGENT_SKILLS.length}`)

  if (DRY_RUN) {
    console.log("\n(DRY RUN — no Firestore writes performed)")
  }

  process.exit(0)
}

main().catch((err) => {
  console.error("seed-canonical-tags failed:", err)
  process.exit(1)
})
