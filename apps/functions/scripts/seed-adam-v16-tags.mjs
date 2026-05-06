#!/usr/bin/env node
/**
 * Phase 56 verifier seed — write a synthetic v1.6 unified tags doc onto Adam's
 * `pa-users/{userId}` so `queryMatchingJobsV16` has something to read against
 * the production `matching-jobs` corpus. Uses the canonical
 * `applyPartialUserTags` writer (USER-TAG-05) with `source: "migration"`.
 *
 * Real Phase 54 migration (USER-TAG-04) seeds tags from existing CV +
 * statedPreferences en-masse — this script is a single-row primer for
 * Phase 56 verify against real `matching-jobs` data.
 *
 * Usage: node apps/functions/scripts/seed-adam-v16-tags.mjs
 */
import admin from "firebase-admin";
import fs from "fs";

const ENV_PATH = "/Users/adam/Desktop/WeKruit/wekruit-pa/.env";
const USER_ID = "e5d97cd8-1e1d-439d-8672-3008f8aeef2e";

if (fs.existsSync(ENV_PATH)) {
  for (const line of fs.readFileSync(ENV_PATH, "utf8").split("\n")) {
    const m = line.match(/^([A-Z_][A-Z_0-9]*)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}
const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
admin.initializeApp({ credential: admin.credential.cert(sa), projectId: "wekruit-5f89b" });
const db = admin.firestore();

// Synthesized tags based on Adam's CV (SWE / ML / fintech background, h1b/sponsor_needed).
const partial = {
  skills: [
    "python",
    "typescript",
    "javascript",
    "node.js",
    "react",
    "next.js",
    "firebase",
    "google_cloud_platform",
    "machine_learning",
    "llm",
    "openai",
    "anthropic",
    "rag",
    "vector_database",
    "sql",
    "postgresql",
    "docker",
    "kubernetes",
    "git",
    "ci_cd",
  ],
  industryEnum: ["tech_software", "ai_ml", "fintech_finance"],
  industrySector: [
    "software_and_saas",
    "artificial_intelligence_and_machine_learning",
    "financial_technology",
  ],
  relevantIndustry: [
    "artificial_intelligence_and_machine_learning",
    "software_and_saas",
    "financial_technology",
  ],
  relevantSpecialization: [
    "machine_learning_engineering",
    "frontend_development",
    "backend_development",
  ],
  proposedTags: ["llm_application", "agent_systems", "prompt_engineering"],
  recentRoleTitle: "Founder / CEO",
  recentCompany: "WeKruit",
  workHistorySummary: "Founder / CEO @ WeKruit; SWE @ Google; SWE @ Quora",
  // chat-derived (these get stamped through Phase 54 partial mappers in real flow)
  targetRoleFunction: ["software_engineering", "engineering_and_development"],
  targetRole: ["swe", "ml_engineer"],
  yoeRange: [5, 10],
  visaStatus: "sponsor_needed",
  prefersStartup: "either",
  targetLocations: ["san_francisco_bay_area", "remote_anywhere"],
  preferredLang: "zh",
  careerStage: "senior",
  // NB: production matching-jobs corpus (post Phase 55 migration) currently
  // carries legacy `jobType` tokens like `intern`/`new_grad`/`full_time` —
  // not yet fully normalized to canonical TAG-05 `internship`/`new_graduate`.
  // Including the legacy tokens here so the Phase 56 verifier exercises the
  // hard-filter chain against real data. Real Phase 54 onboarding mappers
  // should write canonical only; this seed reflects the corpus reality.
  targetJobType: ["full_time", "internship", "new_graduate", "intern", "new_grad"],
  relevantTags: ["llm_application", "agent_systems"],
};

const { applyPartialUserTags } = await import("@pa/pa-orchestrator");

const res = await applyPartialUserTags(db, USER_ID, partial, {
  source: "migration",
  log: (event, payload) => console.log(`[seed] ${event}`, payload ?? {}),
});
console.log("[seed-adam-v16-tags] result:", res);

// Verify
const after = await db.collection("pa-users").doc(USER_ID).get();
const tags = after.data()?.tags ?? {};
console.log("[seed-adam-v16-tags] post-write key count:", Object.keys(tags).length);
console.log("[seed-adam-v16-tags] sample keys:", Object.keys(tags).slice(0, 12));
console.log("[seed-adam-v16-tags] DONE — userId:", USER_ID);
