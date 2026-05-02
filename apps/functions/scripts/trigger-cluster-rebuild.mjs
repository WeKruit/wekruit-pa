/**
 * v1.5 / Phase 51 — One-shot cluster rebuild for Adam to pre-fill
 * pa-rec-tag-clusters-v2 after the cluster-key alignment fix.
 *
 * The production trigger (paJobRecClusterRebuild CF) is gated on the
 * paTagClusterRecEnabled flag. This script bypasses that flag and the CF
 * shim entirely, calling rebuildClusters() directly with the admin SDK so
 * Adam can populate the v2 collection without flipping the flag.
 *
 * Usage:
 *   node apps/functions/scripts/trigger-cluster-rebuild.mjs
 *
 * Output: outcome stats { clusters, jobsBucketed, jobsScanned, pagesRead }.
 * Expected: ~25-30 clusters bucketed (10 industries × ≤3 sponsorship buckets,
 * minus empty intersections).
 *
 * Safety: idempotent by runId — re-running with same runId argument skips
 * writes; the script generates a fresh runId per invocation by default.
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

const { rebuildClusters, TAG_CLUSTERS_COLLECTION } = await import("@pa/job-rec");

const runId = process.argv[2] || `manual-${new Date().toISOString().replace(/[:.]/g, "-")}`;
console.log("=".repeat(72));
console.log("Phase 51 alignment-fix — manual cluster rebuild");
console.log("=".repeat(72));
console.log(`Target collection: ${TAG_CLUSTERS_COLLECTION}`);
console.log(`runId: ${runId}`);
console.log();

const t0 = Date.now();
const outcome = await rebuildClusters({
  db,
  runId,
  log: (...args) => console.log("[rebuild]", ...args.map((a) =>
    typeof a === "string" ? a : JSON.stringify(a).slice(0, 300))),
});
const dt = Date.now() - t0;

console.log();
console.log("=".repeat(72));
console.log("OUTCOME");
console.log("=".repeat(72));
console.log(`clusters written:        ${outcome.clusters}`);
console.log(`jobs bucketed (total):   ${outcome.jobsBucketed}`);
console.log(`jobs scanned:            ${outcome.jobsScanned}`);
console.log(`pages read:              ${outcome.pagesRead}`);
console.log(`skipped (idempotency):   ${outcome.skippedDueToIdempotency}`);
console.log(`wall-clock:              ${dt}ms`);

// Probe: list the cluster docs that landed.
console.log();
console.log("CLUSTER DOC INVENTORY (sponsorshipBucket × industryEnum):");
const all = await db.collection(TAG_CLUSTERS_COLLECTION).get();
const byBucket = { sponsor: 0, "no-sponsor": 0, unknown: 0 };
const sample = [];
for (const d of all.docs) {
  const data = d.data();
  byBucket[data.sponsorshipBucket] = (byBucket[data.sponsorshipBucket] ?? 0) + 1;
  sample.push({
    id: d.id,
    industryEnum: data.industryEnum,
    bucket: data.sponsorshipBucket,
    jobCount: data.jobCount,
  });
}
console.log(`  total docs in v2 collection: ${all.size}`);
console.log(`  by bucket: sponsor=${byBucket.sponsor} no-sponsor=${byBucket["no-sponsor"]} unknown=${byBucket.unknown}`);
sample
  .sort((a, b) => b.jobCount - a.jobCount)
  .slice(0, 10)
  .forEach((s) => console.log(`    [${s.id}] ${s.industryEnum} / ${s.bucket} → ${s.jobCount} jobs`));

process.exit(0);
