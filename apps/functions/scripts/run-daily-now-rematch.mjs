/**
 * Stream H6 D3 — rematch driver. Bypasses runDailyJobRecBatch's per-day
 * idempotency (which already fired at 14:20 PT for Adam) by composing the
 * same pipeline directly with a fresh idempotencyKey suffix
 * `-batch-h6-rematch`. Sends ONE outbound to ONE user, captures
 * BEFORE/AFTER for COMPARE.md.
 *
 * Usage:
 *   node apps/functions/scripts/run-daily-now-rematch.mjs --user=<id>
 *   node apps/functions/scripts/run-daily-now-rematch.mjs --from-allowlist
 *   ... add --dry-run to print without sending.
 */
import admin from "firebase-admin";
import fs from "fs";

const ENV_PATH = "/Users/adam/Desktop/WeKruit/wekruit-pa/.env";
const REMATCH_SUFFIX = "batch-h6-rematch";

function parseArgs(argv) {
  const out = { users: [], fromAllowlist: false, dryRun: false };
  for (const a of argv) {
    if (a === "--from-allowlist") out.fromAllowlist = true;
    else if (a === "--dry-run") out.dryRun = true;
    else if (a.startsWith("--user=")) {
      const v = a.slice("--user=".length).trim();
      if (v) out.users.push(v);
    }
  }
  if (out.users.length === 0 && !out.fromAllowlist) out.fromAllowlist = true;
  return out;
}

const args = parseArgs(process.argv.slice(2));
console.log("[rematch] starting", JSON.stringify(args));

const sa = JSON.parse(
  fs.readFileSync(ENV_PATH, "utf8").split("\n").find(l => l.startsWith("FIREBASE_SERVICE_ACCOUNT_JSON=")).slice("FIREBASE_SERVICE_ACCOUNT_JSON=".length)
);
admin.initializeApp({ credential: admin.credential.cert(sa), projectId: "wekruit-5f89b" });
const db = admin.firestore();

// Resolve user list.
let users = [...args.users];
if (args.fromAllowlist) {
  const flagDoc = await db.collection("pa-feature-flags").doc("paJobRecEnabled").get();
  const allow = (flagDoc.data() ?? {}).allowlist ?? [];
  users = users.concat(allow);
}
users = users.filter((u, i) => users.indexOf(u) === i);
console.log("[rematch] resolved users:", users);

// Pull job-rec deps from the workspace package.
const {
  defaultUserEmbedFetcher,
  rerankByCosine,
  formatBatchMessage,
  normalizeJobProfile,
} = await import("@pa/job-rec");
const { queryMatchingJobs } = await import(
  "@pa/job-rec/tools/query-matching-jobs"
);
const { sendImessage } = await import("@pa/job-rec/tools/send-imessage");

// Local YYYYMMDD helper (matches daily-batch).
function todayYmd() {
  const d = new Date();
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}`;
}

const ymd = todayYmd();
const log = (...a) => console.log("[rematch]", ...a);

// Per-user driver — captures BEFORE (existing pa-outbound today) and AFTER
// (the new rematch send). Returns a structured result for COMPARE.md.
async function rematchOne(userId) {
  // BEFORE: most recent daily-batch outbound for this user, regardless of
  // exact ymd (the rematch script may run after UTC-midnight rollover).
  // We look for any outbound with idempotencyKey matching `<userId>-*-batch`.
  // Cap at 5 to handle multi-day backlog; pick the newest by createdAt.
  const beforeAll = await db
    .collection("pa-outbound")
    .where("userId", "==", userId)
    .where("createdBy", "==", "job-rec@wekruit")
    .get();
  const beforeCandidates = beforeAll.docs
    .map((d) => ({ id: d.id, data: d.data() }))
    .filter((c) => typeof c.data.idempotencyKey === "string" && /-\d{8}-batch$/.test(c.data.idempotencyKey))
    .sort((a, b) => String(b.data.createdAt ?? "").localeCompare(String(a.data.createdAt ?? "")));
  const beforeRow = beforeCandidates.length > 0 ? beforeCandidates[0].data : null;
  const beforeBody = beforeRow?.body ?? null;
  const beforeKey = beforeRow?.idempotencyKey ?? null;
  log("before lookup", { userId, beforeKey, beforeAt: beforeRow?.createdAt });

  // Load profile.
  const profDoc = await db.collection("pa-job-profiles").doc(userId).get();
  if (!profDoc.exists) {
    log("skip — no profile", { userId });
    return { userId, skipped: "no_profile" };
  }
  const profRaw = profDoc.data() ?? {};
  const normalized = normalizeJobProfile(profRaw.profile);
  if (!normalized) {
    log("skip — corrupt profile", { userId });
    return { userId, skipped: "corrupt_profile" };
  }
  log("normalized", {
    userId,
    industry: normalized.industry,
    industryTags: normalized.industryTags,
    location: normalized.location,
    sponsorship: normalized.sponsorship,
  });

  // Query candidate pool with the new industryTags expansion.
  const queryRes = await queryMatchingJobs(
    {
      filters: {
        industry: normalized.industry,
        ...(normalized.industryTags.length > 0
          ? { industryTags: normalized.industryTags }
          : {}),
        location: normalized.location,
        sponsorship: normalized.sponsorship,
        sizePreference: normalized.sizePreference,
        ...(normalized.salaryMin !== undefined ? { salaryMin: normalized.salaryMin } : {}),
      },
      limit: 20,
    },
    { db, log: (...a) => console.log("[query]", ...a), includeEmbedding: true }
  );
  log("pool size", queryRes.jobs.length);

  // Cosine rerank using the same fetcher daily-batch uses.
  const fetched = await defaultUserEmbedFetcher(db, userId);
  let ranked = queryRes.jobs;
  let usedRerank = false;
  let cosineScores = [];
  if (fetched.embedding && fetched.embedding.length > 0) {
    ranked = rerankByCosine(queryRes.jobs, fetched.embedding, 3);
    usedRerank = true;
    // Recompute cosine for reporting.
    const dot = (a, b) => {
      let d = 0, na = 0, nb = 0;
      for (let i = 0; i < a.length; i++) { d += a[i]*b[i]; na += a[i]*a[i]; nb += b[i]*b[i]; }
      return na === 0 || nb === 0 ? 0 : d / (Math.sqrt(na)*Math.sqrt(nb));
    };
    cosineScores = ranked.map(j =>
      Array.isArray(j.embedding) && j.embedding.length === fetched.embedding.length
        ? dot(fetched.embedding, j.embedding)
        : null
    );
  } else {
    ranked = queryRes.jobs.slice(0, 3);
    log("WARNING: no user embedding — fell back to slice(0,3)");
  }

  const body = formatBatchMessage(ranked);
  const idempotencyKey = `${userId}-${ymd}-${REMATCH_SUFFIX}`;

  // AFTER results metadata.
  const after = {
    idempotencyKey,
    poolSize: queryRes.jobs.length,
    usedRerank,
    jobs: ranked.map((j, i) => ({
      id: j.id,
      jobTitle: j.jobTitle,
      companyName: j.companyName,
      locationRaw: j.locationRaw,
      industry: j.industry,
      industryKey: j.industryKey,
      salaryMax: j.salaryMax,
      primaryUrl: j.primaryUrl,
      requiredSkills: j.requiredSkills,
      cosine: cosineScores[i] ?? null,
    })),
    body,
  };

  if (args.dryRun) {
    log("DRY RUN — would send", { userId, idempotencyKey, jobCount: ranked.length });
    return { userId, before: beforeBody, after, sent: false };
  }

  // Hand off structured facts to runtime. Keep the rendered body only for
  // dry-run/operator diff output; runtime must author any candidate copy.
  const { body: _producerBody, bodyBefore: _producerBodyBefore, ...runtimeAfter } = after;
  const sendRes = await sendImessage(
    {
      userId,
      context: {
        source: "manual_rematch_script",
        eventKind: "manual_job_rematch",
        preferredLanguage: "en",
        requestedCount: ranked.length,
        rematch: runtimeAfter,
        instructions: [
          "Write candidate-visible copy in English only.",
          "Use the structured jobs in rematch.jobs.",
          "Include role title, company, URL, and concrete requirements when present.",
          "Reply __NO_SEND__ if this manual rematch should not send now.",
        ],
      },
      idempotencyKey,
    },
    { db, log: (...a) => console.log("[send]", ...a) }
  );
  const runtimeEventId = sendRes.runtimeEventId ?? sendRes.messageHandle;
  if (sendRes.ok && runtimeEventId) {
    await db
      .collection("pa-inbound-events")
      .doc(runtimeEventId)
      .set(
        {
          rawMeta: {
            rematchReason: "stream-h6-quality-fix-2026-05-01",
            // Pin to the actual BEFORE row's idempotencyKey (may be a prior
            // ymd if rematch ran after UTC-midnight rollover).
            rematchedFrom: beforeKey ?? `${userId}-${ymd}-batch`,
          },
        },
        { merge: true }
      );
  }
  log("send result", sendRes);

  return { userId, before: beforeBody, after, sent: sendRes.ok, messageHandle: sendRes.messageHandle };
}

const results = [];
for (const u of users) {
  try {
    const r = await rematchOne(u);
    results.push(r);
  } catch (err) {
    console.error("[rematch] FAIL for", u, err);
    results.push({ userId: u, error: err instanceof Error ? err.message : String(err) });
  }
}

console.log("\n" + "=".repeat(72));
console.log("Stream H6 D3 — rematch summary");
for (const r of results) {
  console.log("---", r.userId, "---");
  if (r.skipped) { console.log("  skipped:", r.skipped); continue; }
  if (r.error) { console.log("  error:", r.error); continue; }
  console.log("  BEFORE outbound body:", r.before ? r.before.slice(0, 400) : "(none today)");
  console.log("  AFTER pool size:", r.after.poolSize, "rerank:", r.after.usedRerank);
  for (const j of r.after.jobs) {
    console.log(
      `  AFTER: [${j.id}] ${j.jobTitle} @ ${j.companyName} (${j.locationRaw}) [industryKey=${j.industryKey}] cosine=${j.cosine !== null ? j.cosine.toFixed(4) : "n/a"}`
    );
  }
  console.log("  SENT:", r.sent, "handle:", r.messageHandle);
}
console.log("=".repeat(72));

// Emit a JSON blob so the caller can pipe to COMPARE.md generator.
console.log("\nRESULTS_JSON=" + JSON.stringify(results));
process.exit(0);
