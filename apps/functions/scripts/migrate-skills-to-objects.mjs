#!/usr/bin/env node
/**
 * Phase 61 — Migrate pa-users.tags.skills from string[] (legacy) to
 * Phase 52 SkillEntry[] (canonical with bucket / proficiency / baseWeight).
 *
 * Why: Phase 56 V16 `computeWeightedSkillJaccard` reads `skills[].name`
 * AND `skills[].baseWeight`. With raw strings the multiplier is undefined
 * → score=0 for everyone, even if their skills perfectly match the JD.
 *
 * Default DRY-RUN: writes proposed update + diff to
 * `pa-users-skills-migration-audit/{userId}` for Adam to review.
 * `--apply` writes the upgrade onto pa-users.tags.skills.
 *
 * Idempotent: skips users where `tags.skills[0]` is already an object
 * with `name` + `baseWeight` properties.
 *
 * Usage:
 *   node apps/functions/scripts/migrate-skills-to-objects.mjs                 # dry-run all
 *   node apps/functions/scripts/migrate-skills-to-objects.mjs --user U123     # single user
 *   node apps/functions/scripts/migrate-skills-to-objects.mjs --limit 5       # first 5
 *   node apps/functions/scripts/migrate-skills-to-objects.mjs --apply         # write
 *
 * Auth: GOOGLE_APPLICATION_CREDENTIALS or FIREBASE_SERVICE_ACCOUNT_JSON env.
 */

import { initializeApp, cert, getApps } from "firebase-admin/app"
import { getFirestore } from "firebase-admin/firestore"
import { readFileSync } from "node:fs"

// ─── CLI flags ────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2)
const DRY_RUN = !argv.includes("--apply")
const PROJECT = (() => {
  const idx = argv.indexOf("--project")
  return idx >= 0 ? argv[idx + 1] : "wekruit-5f89b"
})()
const SINGLE_USER = (() => {
  const idx = argv.indexOf("--user")
  return idx >= 0 ? argv[idx + 1] : null
})()
const LIMIT = (() => {
  const idx = argv.indexOf("--limit")
  return idx >= 0 ? parseInt(argv[idx + 1], 10) : 0
})()

// ─── Phase 52 SkillBucket heuristic (mirrors user-tags-merger.ts) ──────────
const SKILL_BUCKET_HEURISTICS = [
  [
    /^(python|javascript|typescript|java|c\+\+|c#|c|go|golang|rust|ruby|swift|kotlin|scala|php|r|matlab|sql|html|css|bash|shell|perl|elixir|haskell|clojure|julia|dart|lua|objective-c|powershell)$/i,
    "programming_languages",
  ],
  [
    /^(react|reactjs|vue|vuejs|angular|next\.?js|nextjs|nuxt|svelte|django|flask|fastapi|rails|express|spring(\s|_)?boot|laravel|gatsby|remix|node\.?js|nodejs|graphql|redux|jest|mocha|cypress|playwright|tailwind|bootstrap|jquery|three\.?js|d3\.?js|electron|capacitor|expo|react(-|_)?native|flutter|axios|webpack|vite|rollup|babel)$/i,
    "frameworks_and_libraries",
  ],
  [
    /^(postgres(ql)?|mysql|mongodb|mongo|redis|elasticsearch|cassandra|dynamodb|snowflake|bigquery|sqlite|mariadb|oracle(\s|_)?db|sql(\s|_)?server|firebase(\s|_)?firestore|firestore|supabase|cockroachdb|neo4j|opensearch|clickhouse)$/i,
    "databases",
  ],
  [
    /^(aws|amazon(\s|_)?web(\s|_)?services|gcp|google(\s|_)?cloud(\s|_)?platform|google(\s|_)?cloud|azure|microsoft(\s|_)?azure|kubernetes|docker|terraform|ansible|helm|vault|consul|nginx|apache|cloudflare|heroku|vercel|netlify|firebase|fastly|digitalocean|linode|openshift|ecs|eks|gke|aks|lambda|cloud(\s|_)?run|serverless)$/i,
    "cloud_and_infrastructure",
  ],
  [
    /^(git|github|gitlab|bitbucket|jenkins|circle\s?ci|circleci|github\s?actions|gha|gitlab(\s|_)?ci|datadog|grafana|prometheus|sentry|new(\s|_)?relic|splunk|pagerduty|opsgenie|jira|confluence|slack|notion|linear|asana|trello|sonarqube|snyk|dependabot|renovate|pulumi|argo(\s|_)?cd|argocd|spinnaker|tekton|harness|fastlane|cocoapods|npm|yarn|pnpm|pip|cargo|maven|gradle|bazel|nx|lerna)$/i,
    "devops_and_tooling",
  ],
  [
    /^(machine(\s|_)?learning|deep(\s|_)?learning|nlp|natural(\s|_)?language(\s|_)?processing|computer(\s|_)?vision|pytorch|tensorflow|scikit(\s|_)?learn|sklearn|pandas|numpy|spark|kafka|airflow|dbt|huggingface|transformers|llm|rag|vector(\s|_)?database|embeddings|fine(\s|_)?tuning|reinforcement(\s|_)?learning|xgboost|lightgbm|keras|jax|mlflow|kubeflow|sagemaker|vertex(\s|_)?ai|databricks|snowpark|tableau|power(\s|_)?bi|looker|mixpanel|amplitude|segment|fivetran|stitch|hadoop|hive|presto|trino|flink|beam|opencv|spacy|nltk|gensim|prophet|statsmodels|matplotlib|seaborn|plotly|jupyter|colab|ray)$/i,
    "data_and_ml",
  ],
  [
    /^(figma|sketch|adobe|photoshop|illustrator|indesign|after(\s|_)?effects|premiere(\s|_)?pro|xd|design(\s|_)?systems?|ux|ui|wireframing|prototyping|user(\s|_)?research|usability(\s|_)?testing|interaction(\s|_)?design|visual(\s|_)?design|motion(\s|_)?design|invision|zeplin|framer|principle|webflow|axure|miro|whimsical)$/i,
    "design_and_ux",
  ],
  [
    /^(product(\s|_)?management|roadmapping|stakeholder(\s|_)?management|okrs?|kpis?|analytics|product(\s|_)?strategy|go(\s|_)?to(\s|_)?market|gtm|product(\s|_)?marketing|growth|a\/b(\s|_)?testing|funnel(\s|_)?analysis|cohort(\s|_)?analysis|customer(\s|_)?research|jobs(\s|_)?to(\s|_)?be(\s|_)?done|jtbd|product(\s|_)?led(\s|_)?growth|plg)$/i,
    "product_and_business",
  ],
  [
    /^(communication|leadership|teamwork|presentation|mentorship|negotiation|public(\s|_)?speaking|conflict(\s|_)?resolution|cross(\s|_)?functional(\s|_)?collaboration|stakeholder(\s|_)?management|coaching|feedback|empathy|active(\s|_)?listening|critical(\s|_)?thinking|time(\s|_)?management|prioritization|decision(\s|_)?making|problem(\s|_)?solving)$/i,
    "soft_skills",
  ],
]

export function inferSkillBucket(name) {
  const n = (name ?? "").toLowerCase().trim()
  if (!n) return "domain_specific"
  for (const [re, bucket] of SKILL_BUCKET_HEURISTICS) {
    if (re.test(n)) return bucket
  }
  return "domain_specific"
}

// Mirror packages/pa-orchestrator/src/tags/user-tags-merger.ts SKILL_ABBREV_EXPANSIONS
const SKILL_ABBREV_EXPANSIONS = {
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
 * Mirror packages/pa-orchestrator/src/tags/user-tags-merger.ts
 * canonicalizeSkillName.
 */
export function canonicalizeSkillName(raw) {
  if (typeof raw !== "string") return null
  let s = raw.toLowerCase().trim()
  if (!s) return null
  s = s.replace(/\s+/g, "_")
  s = s.replace(/[^a-z0-9_+#.\-]/g, "")
  if (!s) return null
  if (Object.prototype.hasOwnProperty.call(SKILL_ABBREV_EXPANSIONS, s)) {
    s = SKILL_ABBREV_EXPANSIONS[s]
  }
  if (!/^[a-z]/.test(s)) s = `s_${s}`
  if (s.length < 2) return null
  if (s.length > 64) s = s.slice(0, 64)
  return s
}

/**
 * Decide what to do with a user's skills field.
 */
export function planUser(tags) {
  if (!tags || typeof tags !== "object") return { mode: "skip-no-tags" }
  const raw = tags.skills
  if (raw === undefined || raw === null) return { mode: "skip-no-skills" }
  if (!Array.isArray(raw)) return { mode: "skip-not-array" }
  if (raw.length === 0) return { mode: "skip-empty" }
  // Already canonical? (first item is object with name+baseWeight)
  const first = raw[0]
  if (
    first &&
    typeof first === "object" &&
    typeof first.name === "string" &&
    typeof first.baseWeight === "number"
  ) {
    return { mode: "skip-already-objects", count: raw.length }
  }
  // Build SkillEntry[] from string[].
  const seen = new Set()
  const upgraded = []
  for (const item of raw) {
    if (typeof item === "string") {
      const name = canonicalizeSkillName(item)
      if (!name || seen.has(name)) continue
      seen.add(name)
      upgraded.push({
        name,
        bucket: inferSkillBucket(name),
        proficiency: "intermediate",
        evidenceCount: 1,
        baseWeight: 1.0,
      })
    } else if (item && typeof item === "object" && typeof item.name === "string") {
      // Partial object — upgrade missing fields.
      const name = canonicalizeSkillName(item.name)
      if (!name || seen.has(name)) continue
      seen.add(name)
      upgraded.push({
        name,
        bucket: typeof item.bucket === "string" ? item.bucket : inferSkillBucket(name),
        proficiency: typeof item.proficiency === "string" ? item.proficiency : "intermediate",
        evidenceCount:
          typeof item.evidenceCount === "number" && Number.isFinite(item.evidenceCount)
            ? Math.max(0, Math.floor(item.evidenceCount))
            : 1,
        baseWeight:
          typeof item.baseWeight === "number" && Number.isFinite(item.baseWeight)
            ? Math.max(0, Math.min(1, item.baseWeight))
            : 1.0,
      })
    }
  }
  if (upgraded.length === 0) {
    return { mode: "skip-empty-after-canonicalize", before: raw.length }
  }
  return { mode: "rewrite", from: raw, to: upgraded }
}

// ─── Firebase init ────────────────────────────────────────────────────────────
function initFirebase() {
  if (getApps().length > 0) return
  const credPath = process.env.GOOGLE_APPLICATION_CREDENTIALS
  if (credPath) {
    try {
      const cred = JSON.parse(readFileSync(credPath, "utf8"))
      initializeApp({ credential: cert(cred), projectId: PROJECT })
      return
    } catch {}
  }
  const inlineJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON
  if (inlineJson) {
    try {
      const cred = JSON.parse(inlineJson)
      initializeApp({ credential: cert(cred), projectId: PROJECT })
      return
    } catch {}
  }
  initializeApp({ projectId: PROJECT })
}

async function migrateUser(db, userId, userData, opts) {
  const tags = userData?.tags ?? null
  const plan = planUser(tags)

  if (plan.mode !== "rewrite") {
    return { ...plan, userId }
  }

  const before = { skills: tags.skills }
  const after = { skills: plan.to }

  if (opts.dryRun) {
    try {
      await db
        .collection("pa-users-skills-migration-audit")
        .doc(userId)
        .set({
          userId,
          timestamp: new Date().toISOString(),
          beforeCount: before.skills.length,
          afterCount: after.skills.length,
          sample: { before: before.skills.slice(0, 5), after: after.skills.slice(0, 5) },
        })
    } catch (err) {
      return { mode: "error", userId, error: err?.message ?? String(err) }
    }
    return { mode: "dry-run-rewrite", userId, beforeCount: before.skills.length, afterCount: after.skills.length }
  }

  try {
    await db
      .collection("pa-users")
      .doc(userId)
      .set({ tags: { skills: plan.to } }, { merge: true })
    return { mode: "applied", userId, beforeCount: before.skills.length, afterCount: after.skills.length }
  } catch (err) {
    return { mode: "error", userId, error: err?.message ?? String(err) }
  }
}

async function main() {
  console.log(
    `Phase 61 skills→SkillEntry migration\n` +
      `  project=${PROJECT}\n` +
      `  mode=${DRY_RUN ? "DRY-RUN" : "APPLY"}\n` +
      `  user=${SINGLE_USER ?? "all"}\n` +
      `  limit=${LIMIT || "none"}`
  )
  initFirebase()
  const db = getFirestore()

  let processed = 0
  let rewritten = 0
  let skipped = 0
  let errored = 0
  const errors = []
  const sample = []

  if (SINGLE_USER) {
    const snap = await db.collection("pa-users").doc(SINGLE_USER).get()
    if (!snap.exists) {
      console.error(`User not found: ${SINGLE_USER}`)
      process.exit(1)
    }
    const res = await migrateUser(db, SINGLE_USER, snap.data(), { dryRun: DRY_RUN })
    console.log(JSON.stringify(res, null, 2))
    return
  }

  let lastDoc = null
  while (true) {
    let q = db.collection("pa-users").orderBy("__name__").limit(100)
    if (lastDoc) q = q.startAfter(lastDoc)
    const snap = await q.get()
    if (snap.empty) break
    lastDoc = snap.docs[snap.docs.length - 1]
    for (const doc of snap.docs) {
      if (LIMIT > 0 && processed >= LIMIT) break
      processed++
      const userId = doc.id
      try {
        const res = await migrateUser(db, userId, doc.data(), { dryRun: DRY_RUN })
        if (res.mode === "applied" || res.mode === "dry-run-rewrite") {
          rewritten++
          if (sample.length < 5) sample.push({ userId, beforeCount: res.beforeCount, afterCount: res.afterCount })
        } else if (res.mode === "error") {
          errored++
          errors.push({ userId, error: res.error })
        } else {
          skipped++
        }
        if (processed % 50 === 0) {
          console.log(`  ${processed} processed (rewritten=${rewritten} skipped=${skipped} errored=${errored})...`)
        }
      } catch (err) {
        errored++
        errors.push({ userId, error: err?.message ?? String(err) })
      }
    }
    if (LIMIT > 0 && processed >= LIMIT) break
    if (snap.docs.length < 100) break
  }

  const summary = {
    project: PROJECT,
    mode: DRY_RUN ? "dry-run" : "apply",
    total: processed,
    rewritten,
    skipped,
    errored,
    errors: errors.slice(0, 20),
    sample,
  }
  console.log("\nSUMMARY:", JSON.stringify(summary, null, 2))
  if (DRY_RUN) {
    console.log(
      "\nDry-run complete. Audit collection: pa-users-skills-migration-audit/{userId}\n" +
        "Adam-action: review audit, then re-run with --apply."
    )
  }
}

const isMain =
  typeof process !== "undefined" &&
  Array.isArray(process.argv) &&
  process.argv[1] &&
  import.meta.url === `file://${process.argv[1]}`
if (isMain) {
  main().catch((err) => {
    console.error("FATAL:", err?.stack ?? err?.message ?? String(err))
    process.exit(1)
  })
}
