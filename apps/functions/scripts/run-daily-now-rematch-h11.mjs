/**
 * Stream H11 D2 — rematch driver. Forked from H8 (cosine + anti-bias), now
 * adds the BAAI/bge-reranker-v2-m3 cross-encoder pass after cosine.
 *
 * Usage:
 *   node apps/functions/scripts/run-daily-now-rematch-h10.mjs --user=<id>
 *   node apps/functions/scripts/run-daily-now-rematch-h10.mjs --from-allowlist
 */
import admin from "firebase-admin";
import fs from "fs";

const ENV_PATH = "/Users/adam/Desktop/WeKruit/wekruit-pa/.env";
const REMATCH_SUFFIX = "batch-h11-rematch-v2";

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
console.log("[h11-rematch] starting", JSON.stringify(args));

// Load .env so SILICONFLOW_API_KEY is in process.env.
const envFile = fs.readFileSync(ENV_PATH, "utf8");
for (const line of envFile.split("\n")) {
  const m = line.match(/^([A-Z_][A-Z_0-9]*)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}

const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
admin.initializeApp({ credential: admin.credential.cert(sa), projectId: "wekruit-5f89b" });
const db = admin.firestore();

let users = [...args.users];
if (args.fromAllowlist) {
  const flagDoc = await db.collection("pa-feature-flags").doc("paJobRecEnabled").get();
  const allow = (flagDoc.data() ?? {}).allowlist ?? [];
  users = users.concat(allow);
}
users = users.filter((u, i) => users.indexOf(u) === i);
console.log("[h11-rematch] resolved users:", users);

const {
  defaultUserEmbedFetcher,
  rerankByCosine,
  formatBatchMessage,
  normalizeJobProfile,
  rerankWithCrossEncoder,
  buildRerankQuery,
  buildJobCandidateText,
} = await import("@pa/job-rec");
const { queryMatchingJobs, applyTitleAntiBias } = await import("@pa/job-rec/tools/query-matching-jobs");
const { sendImessage } = await import("@pa/job-rec/tools/send-imessage");

function todayYmd() {
  const d = new Date();
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}`;
}

const ymd = todayYmd();
const log = (...a) => console.log("[h11-rematch]", ...a);

async function rematchOne(userId) {
  // BEFORE: most recent rematch outbound (H8) for the user.
  const beforeAll = await db
    .collection("pa-outbound")
    .where("userId", "==", userId)
    .where("createdBy", "==", "job-rec@wekruit")
    .get();
  const beforeCandidates = beforeAll.docs
    .map((d) => ({ id: d.id, data: d.data() }))
    .sort((a, b) => String(b.data.createdAt ?? "").localeCompare(String(a.data.createdAt ?? "")));
  const beforeRow = beforeCandidates[0]?.data ?? null;
  const beforeBody = beforeRow?.body ?? null;
  const beforeKey = beforeRow?.idempotencyKey ?? null;
  log("before lookup", { userId, beforeKey, beforeAt: beforeRow?.createdAt });

  const profDoc = await db.collection("pa-job-profiles").doc(userId).get();
  if (!profDoc.exists) return { userId, skipped: "no_profile" };
  const profRaw = profDoc.data() ?? {};
  const normalized = normalizeJobProfile(profRaw.profile);
  if (!normalized) return { userId, skipped: "corrupt_profile" };
  log("normalized", {
    userId,
    industryTags: normalized.industryTags,
    location: normalized.location,
    sponsorship: normalized.sponsorship,
  });

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
      limit: 20,
    },
    { db, log: (...a) => console.log("[query]", ...a), includeEmbedding: true }
  );
  log("pool size", queryRes.jobs.length);

  // ---- Cosine rerank: keep top 10 ----
  const fetched = await defaultUserEmbedFetcher(db, userId);
  let ranked = queryRes.jobs;
  let cosineScores = [];
  if (fetched.embedding && fetched.embedding.length > 0) {
    ranked = rerankByCosine(queryRes.jobs, fetched.embedding, 10);
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
    log("WARNING: no user embedding — using slice(0,10)");
    ranked = queryRes.jobs.slice(0, 10);
  }
  const cosineTop10 = ranked.map((j, i) => ({ ...j, _cosine: cosineScores[i] ?? null }));
  log("cosine top-10:", cosineTop10.map((j, i) => `${i+1}. [${j.id}] ${j.jobTitle} @ ${j.companyName} cosine=${(j._cosine ?? 0).toFixed(4)}`).join("\n  "));

  // ---- Cross-encoder rerank: 10 → top 3 ----
  // Pull recent role title + skills for query synthesis.
  let recentRoleTitle = null;
  let topSkills = [];
  try {
    const rs = await db.collection("parsedCandidateResumes")
      .where("userId", "==", userId).orderBy("createdAt", "desc").limit(1).get();
    if (!rs.empty) {
      const rd = rs.docs[0].data();
      const exps = Array.isArray(rd.experiences) ? rd.experiences : [];
      if (exps.length > 0 && typeof exps[0].title === "string") recentRoleTitle = exps[0].title;
      const cp = rd.candidateProfile ?? {};
      if (Array.isArray(cp.skills)) topSkills = cp.skills.filter(s => typeof s === "string");
    }
  } catch (e) { log("resume lookup failed", e.message); }

  const query = buildRerankQuery({
    recentRoleTitle,
    topSkills,
    industryTags: normalized.industryTags,
  });
  log("rerank query:", JSON.stringify(query));
  const cands = ranked.map(j => ({
    id: j.id,
    text: buildJobCandidateText({
      jobTitle: j.jobTitle,
      companyName: j.companyName,
      requiredSkills: j.requiredSkills,
      industryKey: j.industryKey,
    }),
  }));
  const reranked = await rerankWithCrossEncoder(query, cands, {
    log: (e, p) => console.log("[xenc]", e, JSON.stringify(p ?? {})),
  });
  log("cross-encoder reranked:", reranked.map((r, i) =>
    `${i+1}. [${r.id}] score=${r.score === null ? "null" : r.score.toExponential(3)}`
  ).join("\n  "));

  // Reorder ranked using rerank order. score=null on every item → keep cosine.
  const haveScores = reranked.some(r => r.score !== null);
  if (haveScores) {
    const byId = new Map(ranked.map(j => [j.id, j]));
    const reordered = [];
    for (const r of reranked) {
      const j = byId.get(r.id);
      if (j) reordered.push(j);
    }
    ranked = reordered;
  } else {
    log("cross-encoder fail-open — preserving cosine order");
  }

  // ---- Dedupe near-identical JDs (same title+company across cities) ----
  // The corpus contains many JDs reposted per metro; cross-encoder can't
  // distinguish them by score so they all rank top — leading to "3x same role
  // in 3 cities" UX. Dedupe by lowercased (title|company), keep first.
  const dedupeKey = (j) => `${(j.jobTitle ?? "").toLowerCase().trim()}|${(j.companyName ?? "").toLowerCase().trim()}`
  const seenKeys = new Set();
  const dedupeOut = [];
  for (const j of ranked) {
    const k = dedupeKey(j);
    if (seenKeys.has(k)) continue;
    seenKeys.add(k);
    dedupeOut.push(j);
  }
  if (dedupeOut.length < ranked.length) {
    log(`dedupe: ${ranked.length} → ${dedupeOut.length} after dropping near-identical JDs`);
  }
  ranked = dedupeOut;

  // ---- Anti-bias + slice top 3 ----
  ranked = applyTitleAntiBias(ranked, normalized.industryTags, 3);

  const body = formatBatchMessage(ranked);
  const idempotencyKey = `${userId}-${ymd}-${REMATCH_SUFFIX}`;

  const after = {
    idempotencyKey,
    poolSize: queryRes.jobs.length,
    cosineTop10: cosineTop10.map(j => ({
      id: j.id, jobTitle: j.jobTitle, companyName: j.companyName,
      industryKey: j.industryKey, locationRaw: j.locationRaw, cosine: j._cosine,
    })),
    crossEncoderRanking: reranked,
    finalTop3: ranked.map((j, i) => {
      const xe = reranked.find(r => r.id === j.id);
      const c = cosineTop10.find(c => c.id === j.id);
      return {
        id: j.id, jobTitle: j.jobTitle, companyName: j.companyName,
        locationRaw: j.locationRaw, industryKey: j.industryKey,
        salaryMax: j.salaryMax, primaryUrl: j.primaryUrl,
        requiredSkills: j.requiredSkills,
        cosine: c?._cosine ?? null,
        crossEncoderScore: xe?.score ?? null,
      };
    }),
    body,
  };

  if (args.dryRun) {
    log("DRY RUN — would send", { userId, idempotencyKey, jobCount: ranked.length });
    return { userId, before: beforeBody, beforeKey, after, sent: false };
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
          "Use the structured jobs in rematch.finalTop3.",
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
    await db.collection("pa-inbound-events").doc(runtimeEventId).set({
      rawMeta: {
        rematchReason: "stream-h11-companyrole-compound-2026-05-01",
        rematchedFrom: beforeKey ?? `${userId}-${ymd}-batch`,
      },
    }, { merge: true });
  }
  log("send result", sendRes);
  return { userId, before: beforeBody, beforeKey, after, sent: sendRes.ok, messageHandle: sendRes.messageHandle };
}

const results = [];
for (const u of users) {
  try { results.push(await rematchOne(u)); }
  catch (err) {
    console.error("[h11-rematch] FAIL for", u, err);
    results.push({ userId: u, error: err instanceof Error ? err.message : String(err) });
  }
}

console.log("\n" + "=".repeat(72));
console.log("Stream H11 D2 — rematch summary");
for (const r of results) {
  console.log("---", r.userId, "---");
  if (r.skipped) { console.log("  skipped:", r.skipped); continue; }
  if (r.error) { console.log("  error:", r.error); continue; }
  console.log("  BEFORE outbound (key):", r.beforeKey);
  console.log("  BEFORE body:", r.before ? r.before.slice(0, 400) : "(none)");
  console.log("  AFTER pool size:", r.after.poolSize);
  console.log("  COSINE TOP 10:");
  for (const j of r.after.cosineTop10) {
    console.log(`    [${j.id}] ${j.jobTitle} @ ${j.companyName} (${j.locationRaw}) [industryKey=${j.industryKey}] cosine=${j.cosine === null ? "n/a" : j.cosine.toFixed(4)}`);
  }
  console.log("  CROSS-ENCODER RANKING:");
  for (const r2 of r.after.crossEncoderRanking) {
    console.log(`    [${r2.id}] score=${r2.score === null ? "null" : r2.score.toExponential(4)}`);
  }
  console.log("  FINAL TOP 3 (post-anti-bias):");
  for (const j of r.after.finalTop3) {
    console.log(`    [${j.id}] ${j.jobTitle} @ ${j.companyName} (${j.locationRaw}) cosine=${j.cosine === null ? "n/a" : j.cosine.toFixed(4)} xenc=${j.crossEncoderScore === null ? "null" : j.crossEncoderScore.toExponential(4)}`);
  }
  console.log("  SENT:", r.sent, "handle:", r.messageHandle);
}
console.log("=".repeat(72));
console.log("\nRESULTS_JSON=" + JSON.stringify(results));
process.exit(0);
