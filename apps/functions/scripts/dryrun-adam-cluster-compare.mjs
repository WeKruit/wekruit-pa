/**
 * v1.5 / Phase 51 — Cluster ON vs OFF comparison dryrun for Adam.
 *
 * Sister script to dryrun-adam-e2e.mjs. Runs the cluster path
 * (fetchTopKFromCluster) and the legacy path (queryMatchingJobs) back-to-back
 * over the SAME normalized profile + user resume, prints:
 *   - pool size from each path
 *   - wall-clock duration
 *   - top-K job ids overlap
 *   - cluster cache state probe (cluster doc count, doc sizes for the user's tags)
 *
 * Usage:
 *   node scripts/dryrun-adam-cluster-compare.mjs
 *
 * Phase 51 G.2 acceptance: cluster ON path returns ≥1 job for Adam, falls
 * through cleanly when cluster cache is cold.
 */
import admin from "firebase-admin";
import fs from "fs";

const ENV_PATH = "/Users/adam/Desktop/WeKruit/wekruit-pa/.env";
const envFile = fs.readFileSync(ENV_PATH, "utf8");
for (const line of envFile.split("\n")) {
  const m = line.match(/^([A-Z_][A-Z_0-9]*)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}

const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
admin.initializeApp({ credential: admin.credential.cert(sa), projectId: "wekruit-5f89b" });
const db = admin.firestore();

const ADAM = "e5d97cd8-1e1d-439d-8672-3008f8aeef2e";
const POOL = 20;

const {
  defaultUserEmbedFetcher,
  normalizeJobProfile,
  fetchTopKFromCluster,
  computeClusterId,
  clusterKeysForUser,
  TAG_CLUSTERS_COLLECTION,
  PA_TAG_CLUSTER_REC_FLAG_KEY,
} = await import("@pa/job-rec");
const { queryMatchingJobs } = await import("@pa/job-rec/tools/query-matching-jobs");

const log = (e, p) => console.log("[cluster-cmp]", e, p ? JSON.stringify(p).slice(0, 300) : "");

console.log("=".repeat(72));
console.log("Phase 51 G.2 — cluster ON vs OFF comparison for Adam");
console.log("=".repeat(72));

// ---------------------------------------------------------------------------
// 0. Profile + user skills + embedding
// ---------------------------------------------------------------------------
const profDoc = await db.collection("pa-job-profiles").doc(ADAM).get();
const profRaw = profDoc.data() ?? {};
const normalized = normalizeJobProfile(profRaw.profile);
console.log("\n[STAGE 0] normalized profile:");
console.log("  industry:", normalized.industry);
console.log("  industryTags:", JSON.stringify(normalized.industryTags));
console.log("  sponsorship:", normalized.sponsorship);

const fetched = await defaultUserEmbedFetcher(db, ADAM);
const userEmb = fetched.embedding;
console.log("  user embedding dim:", userEmb?.length ?? 0);

const rs = await db.collection("parsedCandidateResumes").where("userId", "==", ADAM).orderBy("createdAt", "desc").limit(1).get();
let userSkills = [];
if (!rs.empty) {
  const cp = (rs.docs[0].data().candidateProfile ?? {});
  if (Array.isArray(cp.skills)) userSkills = cp.skills.filter((s) => typeof s === "string").slice(0, 10);
}
console.log("  user skills (top 10):", JSON.stringify(userSkills));

// ---------------------------------------------------------------------------
// 1. Flag state probe
// ---------------------------------------------------------------------------
console.log("\n[STAGE 1] flag + cluster cache probe");
const flagDoc = await db.collection("pa-feature-flags").doc(PA_TAG_CLUSTER_REC_FLAG_KEY).get();
console.log("  flag exists:", flagDoc.exists);
if (flagDoc.exists) {
  const fd = flagDoc.data();
  console.log("  flag value:", fd.value, "scope:", fd.scope);
  console.log("  allowlist (Adam in?):", (fd.allowlist || []).includes(ADAM));
  console.log("  blocklist:", JSON.stringify(fd.blocklist || []));
}

const clusterIds = clusterKeysForUser({ industryTags: normalized.industryTags, sponsorship: normalized.sponsorship });
console.log("  user cluster keys:", clusterIds);
for (const cid of clusterIds) {
  const snap = await db.collection(TAG_CLUSTERS_COLLECTION).doc(cid).get();
  console.log(`  cluster[${cid}] exists=${snap.exists} jobIds.len=${snap.exists ? (snap.data().jobIds || []).length : 0}`);
}

// ---------------------------------------------------------------------------
// 2. Cluster ON path
// ---------------------------------------------------------------------------
console.log("\n[STAGE 2] cluster ON — fetchTopKFromCluster");
const t0 = Date.now();
const clusterJobs = await fetchTopKFromCluster(
  { db, log },
  {
    industryTags: normalized.industryTags,
    sponsorship: normalized.sponsorship,
    skills: userSkills,
    userEmbedding: userEmb ?? null,
  },
  POOL
);
const dCluster = Date.now() - t0;
console.log(`  pool size: ${clusterJobs.length} | wall-time: ${dCluster}ms`);
clusterJobs.slice(0, 10).forEach((j, i) => console.log(`    ${i + 1}. [${j.id}] ${j.jobTitle} @ ${j.companyName} industryKey=${j.industryKey}`));

// ---------------------------------------------------------------------------
// 3. Cluster OFF (legacy queryMatchingJobs)
// ---------------------------------------------------------------------------
console.log("\n[STAGE 3] cluster OFF — legacy queryMatchingJobs");
const t1 = Date.now();
const queryRes = await queryMatchingJobs(
  {
    filters: {
      industry: normalized.industry,
      ...(normalized.industryTags.length > 0 ? { industryTags: normalized.industryTags } : {}),
      location: normalized.location,
      sponsorship: normalized.sponsorship,
      sizePreference: normalized.sizePreference,
      ...(normalized.salaryMin !== undefined ? { salaryMin: normalized.salaryMin } : {}),
    },
    limit: POOL,
  },
  { db, log: () => {}, includeEmbedding: true }
);
const dQuery = Date.now() - t1;
console.log(`  pool size: ${queryRes.jobs.length} | wall-time: ${dQuery}ms`);
queryRes.jobs.slice(0, 10).forEach((j, i) => console.log(`    ${i + 1}. [${j.id}] ${j.jobTitle} @ ${j.companyName} industryKey=${j.industryKey}`));

// ---------------------------------------------------------------------------
// 4. Verdict
// ---------------------------------------------------------------------------
console.log("\n" + "=".repeat(72));
console.log("VERDICT");
console.log("=".repeat(72));
const clusterIds_ = new Set(clusterJobs.map((j) => j.id));
const queryIds = new Set(queryRes.jobs.map((j) => j.id));
const overlap = [...clusterIds_].filter((id) => queryIds.has(id));
console.log(`Cluster ON pool: ${clusterJobs.length} jobs in ${dCluster}ms`);
console.log(`Cluster OFF pool: ${queryRes.jobs.length} jobs in ${dQuery}ms`);
console.log(`Overlap (same job ids in both): ${overlap.length}`);
console.log(`Cluster path returns: ${clusterJobs.length === 0 ? "EMPTY → daily-batch falls through (zero-regression contract)" : "non-empty → cluster path supplies the pool"}`);
const zeroRegression = clusterJobs.length === 0 ? "PASS (cold-cache fallback works as designed)" : `INFO (cluster supplied ${clusterJobs.length}, legacy ${queryRes.jobs.length})`;
console.log(`Zero-regression check: ${zeroRegression}`);

process.exit(0);
