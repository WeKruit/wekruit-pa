#!/usr/bin/env node
/**
 * Phase 56 verification — invoke `queryMatchingJobsV16` against a real
 * Firestore user and dump the top-N matched jobs with reasoning.
 *
 * Usage:
 *   node apps/functions/scripts/test-match-v16.mjs --user=<userId> [--limit=5]
 *
 * Default user: e5d97cd8-1e1d-439d-8672-3008f8aeef2e (Adam's CV; see
 * .planning/phases/56-... CONTEXT.md).
 *
 * Output: console-rendered table of top-N jobs with v16 score breakdown,
 * matched skills, and reasoning. Verification target per CLAUDE.md v1.6
 * design lock:
 *   - Top jobs are software_engineering / engineering roleFunction (NOT
 *     BDR / Account Manager / Warehouse).
 *   - No `jobright.ai` URL in `atsApplyUrl`.
 *   - Reasoning surfaces top-2 user skills.
 */
import admin from "firebase-admin";
import fs from "fs";

const ENV_PATH = "/Users/adam/Desktop/WeKruit/wekruit-pa/.env";
const DEFAULT_USER = "e5d97cd8-1e1d-439d-8672-3008f8aeef2e";

function parseArgs(argv) {
  const out = { user: DEFAULT_USER, limit: 5, nowMs: undefined };
  for (const a of argv) {
    if (a.startsWith("--user=")) out.user = a.slice("--user=".length).trim();
    else if (a.startsWith("--limit=")) {
      const n = Number.parseInt(a.slice("--limit=".length), 10);
      if (Number.isFinite(n) && n > 0) out.limit = n;
    } else if (a.startsWith("--pin-now=")) {
      // Pin "now" to a timestamp so the freshness window catches more docs.
      // Useful when the corpus is staler than 20d (Phase 57 inventory pending).
      const v = a.slice("--pin-now=".length);
      const t = Date.parse(v);
      if (Number.isFinite(t)) out.nowMs = t;
    } else if (a === "--bypass-freshness") {
      // Pin "now" 1d after the latest firstSeenAt seen in the corpus so that
      // the 20d window catches everything. Lets the verifier see the rank
      // ordering against real corpus content.
      out.bypassFreshness = true;
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
console.log("[test-match-v16] args:", args);

// Load .env into process.env (for FIREBASE_SERVICE_ACCOUNT_JSON).
if (fs.existsSync(ENV_PATH)) {
  const envFile = fs.readFileSync(ENV_PATH, "utf8");
  for (const line of envFile.split("\n")) {
    const m = line.match(/^([A-Z_][A-Z_0-9]*)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}

const saJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
if (!saJson) {
  console.error("[test-match-v16] FIREBASE_SERVICE_ACCOUNT_JSON missing in env");
  process.exit(1);
}
const sa = JSON.parse(saJson);
admin.initializeApp({ credential: admin.credential.cert(sa), projectId: "wekruit-5f89b" });
const db = admin.firestore();

const { queryMatchingJobsV16 } = await import("@pa/job-rec");

let pinnedNow = args.nowMs;
if (args.bypassFreshness) {
  // Find the latest firstSeenAt in the SWE-filtered slice; pin nowMs to
  // 5 days after it so the 20d window opens up.
  const peek = await db
    .collection("matching-jobs")
    .where("status", "==", "active")
    .orderBy("firstSeenAt", "desc")
    .limit(1)
    .get();
  if (!peek.empty) {
    const ts = peek.docs[0].data().firstSeenAt;
    let ms = 0;
    if (typeof ts === "string") ms = Date.parse(ts);
    else if (ts?.toDate) ms = ts.toDate().getTime();
    else if (ts?._seconds) ms = ts._seconds * 1000;
    if (Number.isFinite(ms) && ms > 0) {
      pinnedNow = ms + 5 * 24 * 3600 * 1000;
      console.log(`[test-match-v16] --bypass-freshness: pinning nowMs to ${new Date(pinnedNow).toISOString()}`);
    }
  }
}

console.log(`[test-match-v16] running for user=${args.user}${pinnedNow ? ` pinnedNow=${new Date(pinnedNow).toISOString()}` : ""}`);
const t0 = Date.now();
const result = await queryMatchingJobsV16(
  { userId: args.user, limit: args.limit, ...(pinnedNow ? { nowMs: pinnedNow } : {}) },
  {
    db,
    log: (event, payload) => console.log(`[v16] ${event}`, payload ?? {}),
  }
);
const elapsed = Date.now() - t0;
console.log(`[test-match-v16] elapsed=${elapsed}ms`);

if (result.noUserTags) {
  console.log("[test-match-v16] no user tags — no jobs returned");
  process.exit(0);
}

console.log(`[test-match-v16] total survivors=${result.total}, dropped=${result.dropped}, llmStale=${result.llmCacheStale ?? false}`);
console.log(`[test-match-v16] hard-filter counters:`, result.hardFilter);

console.log("\n=== TOP", result.jobs.length, "JOBS ===\n");
let leakCount = 0;
for (let i = 0; i < result.jobs.length; i++) {
  const j = result.jobs[i];
  const score = j.v16Score;
  const isJobright = /jobright\.ai/i.test(j.atsApplyUrl ?? "");
  if (isJobright) leakCount++;
  const roleFns = Array.isArray(j.roleFunction) ? j.roleFunction.join(",") : "(none)";
  console.log(
    `#${i + 1}  total=${score.total.toFixed(3)}  ` +
    `[ llm=${score.llmMatch.toFixed(2)} skill=${score.skillJaccard.toFixed(2)} ` +
    `relTags=${score.relevantTags.toFixed(2)} ind=${score.industrySector.toFixed(2)} ` +
    `emb=${score.cvEmbCosine.toFixed(2)} sal=${score.salaryFit.toFixed(2)} ]`
  );
  console.log(`    ${j.jobTitle} @ ${j.companyName}  (${j.locationRaw})`);
  console.log(`    roleFunction: ${roleFns}`);
  console.log(`    atsApplyUrl: ${j.atsApplyUrl ?? "(missing)"}${isJobright ? "  <-- JOBRIGHT LEAK" : ""}`);
  console.log(`    matched skills: ${j.matchedSkills.map((s) => s.name).join(", ") || "(none)"}`);
  console.log(`    reason: ${j.reason}`);
  console.log("");
}

console.log(`\n[test-match-v16] jobright.ai leaks in top-${result.jobs.length}: ${leakCount}`);
console.log("[test-match-v16] done");
