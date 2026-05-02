/**
 * E2E dry-run of v1.5 daily-batch for Adam.
 * - No sendImessage call
 * - All 7 stages logged: query → hard-filter → cosine → cross-encoder → boost → dedupe → anti-bias → match-explainer → friend-tone format
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
const TARGET_JOB_COUNT = 5;

const {
  defaultUserEmbedFetcher,
  rerankByCosine,
  formatBatchMessage,
  formatDailyPushBody,
  loadDailyPushContext,
  normalizeJobProfile,
  rerankWithCrossEncoder,
  buildRerankQuery,
  buildJobCandidateText,
  explainMatch,
} = await import("@pa/job-rec");
const { queryMatchingJobs, applyTitleAntiBias, applyHardFiltersWithFallback } = await import("@pa/job-rec/tools/query-matching-jobs");
const { applyStartupBoost, userPreferStartup } = await import("../../job-rec/dist/cross-encoder-rerank.js");

const log = (...a) => console.log("[dryrun]", ...a);

// 1. Profile
const profDoc = await db.collection("pa-job-profiles").doc(ADAM).get();
const profRaw = profDoc.data() ?? {};
const normalized = normalizeJobProfile(profRaw.profile);
console.log("\n=== STAGE 0: profile normalize ===");
console.log(JSON.stringify(normalized, null, 2));

// 2. queryMatchingJobs (pool=20)
console.log("\n=== STAGE 1: queryMatchingJobs ===");
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
  { db, log: (e,p) => console.log("[query]", e, p ? JSON.stringify(p).slice(0,400) : ""), includeEmbedding: true }
);
console.log(`Pool: ${queryRes.jobs.length} jobs returned from Firestore`);
queryRes.jobs.slice(0,10).forEach((j,i) => console.log(`  ${i+1}. [${j.id}] ${j.jobTitle} @ ${j.companyName} (${j.locationRaw}) industryKey=${j.industryKey}`));

// 3. Hard filters
console.log("\n=== STAGE 2: hard filters ===");
const hfProfile = {};
const userDoc = await db.collection("pa-users").doc(ADAM).get();
if (userDoc.exists) {
  const ud = userDoc.data();
  if (ud.statedPreferences) hfProfile.statedPreferences = ud.statedPreferences;
}
const rs = await db.collection("parsedCandidateResumes").where("userId","==",ADAM).orderBy("createdAt","desc").limit(1).get();
if (!rs.empty) {
  const rd = rs.docs[0].data();
  hfProfile.experiences = (rd.experiences ?? []).map(e => ({startDate:e.startDate, endDate:e.endDate}));
}
console.log("HardFilterProfile:", JSON.stringify(hfProfile, null, 2));

const dry = applyHardFiltersWithFallback(hfProfile, queryRes.jobs, [], 20);
console.log(`Hard-filter result: relaxLevel=${dry.relaxLevel} survivors=${dry.jobs.length}`);
let hardFiltered = dry.jobs;

// v1.5 fix mirror — early dedupe BEFORE cosine, matches the production
// path now in apps/job-rec/src/daily-batch.ts (post-job-rec-E2E agent
// finding: Adam was getting 2 jobs because Mastercard×6 + Deloitte×4
// dominated the pool and only collapsed at end). Pure / deterministic.
console.log("\n=== STAGE 2.5: early dedupe (v1.5 fix) ===");
{
  const seen = new Set();
  const earlyDeduped = [];
  for (const j of hardFiltered) {
    const key = `${(j.jobTitle ?? "").toLowerCase().trim()}|${(j.companyName ?? "").toLowerCase().trim()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    earlyDeduped.push(j);
  }
  console.log(`Early dedupe: ${hardFiltered.length} → ${earlyDeduped.length}`);
  hardFiltered = earlyDeduped;
}

// 4. Cosine rerank
console.log("\n=== STAGE 3: cosine rerank ===");
const fetched = await defaultUserEmbedFetcher(db, ADAM);
console.log(`User embedding: dim=${fetched.embedding?.length ?? 0} resumeId=${fetched.resumeId}`);
let ranked = hardFiltered;
if (fetched.embedding && fetched.embedding.length > 0) {
  // v1.5 fix mirror — pool 10→25 (matches prod default change)
  ranked = rerankByCosine(hardFiltered, fetched.embedding, 25);
  const dot = (a,b) => { let d=0,na=0,nb=0; for(let i=0;i<a.length;i++){d+=a[i]*b[i];na+=a[i]*a[i];nb+=b[i]*b[i];} return na===0||nb===0?0:d/(Math.sqrt(na)*Math.sqrt(nb)); };
  console.log(`Cosine top-${ranked.length}:`);
  ranked.forEach((j,i) => {
    const c = (Array.isArray(j.embedding) && j.embedding.length === fetched.embedding.length) ? dot(fetched.embedding, j.embedding) : 0;
    console.log(`  ${i+1}. [${j.id}] ${j.jobTitle} @ ${j.companyName} cosine=${c.toFixed(4)} requiredSkills=${(j.requiredSkills??[]).slice(0,5).join(",")}`);
  });
}

// 5. Cross-encoder
console.log("\n=== STAGE 4: cross-encoder ===");
let recentRoleTitle = null, topSkills = [];
if (!rs.empty) {
  const rd = rs.docs[0].data();
  const exps = rd.experiences ?? [];
  if (exps.length > 0 && typeof exps[0].title === "string") recentRoleTitle = exps[0].title;
  const cp = rd.candidateProfile ?? {};
  if (Array.isArray(cp.skills)) topSkills = cp.skills.filter(s => typeof s === "string");
}
const query = buildRerankQuery({ recentRoleTitle, topSkills, industryTags: normalized.industryTags });
console.log("rerank query:", JSON.stringify(query));
const cands = ranked.map(j => ({ id: j.id, text: buildJobCandidateText({ jobTitle: j.jobTitle, companyName: j.companyName, requiredSkills: j.requiredSkills, industryKey: j.industryKey }) }));
const reranked = await rerankWithCrossEncoder(query, cands, { log: (e,p) => console.log("[xenc]", e) });
const haveScores = reranked.some(r => r.score !== null);
console.log(`Cross-encoder: haveScores=${haveScores}`);
let crossEncoderScores = null;
if (haveScores) {
  const byId = new Map(ranked.map(j=>[j.id,j]));
  ranked = reranked.map(r => byId.get(r.id)).filter(Boolean);
  crossEncoderScores = new Map(reranked.map(r=>[r.id, r.score]));
  console.log("After cross-encoder reorder:");
  ranked.forEach((j,i) => console.log(`  ${i+1}. [${j.id}] ${j.jobTitle} @ ${j.companyName} xenc=${crossEncoderScores.get(j.id)?.toExponential(4)}`));
}

// 6. Startup boost
console.log("\n=== STAGE 5: startup boost ===");
let prefersStartup = null;
let cvExperiences = [];
if (userDoc.exists) {
  const ud = userDoc.data();
  if (ud.statedPreferences && typeof ud.statedPreferences.prefersStartup === "boolean") prefersStartup = ud.statedPreferences.prefersStartup;
}
if (!rs.empty) {
  const rd = rs.docs[0].data();
  cvExperiences = (rd.experiences ?? []).map(e => ({ company: e.company ?? null, companyEmployeeCount: typeof e.companyEmployeeCount === "number" ? e.companyEmployeeCount : null }));
}
const userSignal = userPreferStartup({ statedPreferences: { prefersStartup }, cvExperiences });
const boosted = applyStartupBoost(ranked, userSignal, crossEncoderScores ?? undefined);
console.log("Startup signal:", JSON.stringify(userSignal));
console.log("Boost explanations:", boosted.explanations.length);
boosted.explanations.forEach(e => console.log(`  - jobId=${e.jobId} mult=${e.boostMult} userSignal=${e.userSignal} jobSignal=${e.jobSignal}`));
if (boosted.explanations.length > 0) ranked = boosted.jobs;

// 7. Dedupe
console.log("\n=== STAGE 6: dedupe ===");
const seen = new Set();
const deduped = [];
for (const j of ranked) {
  const k = `${(j.jobTitle??"").toLowerCase().trim()}|${(j.companyName??"").toLowerCase().trim()}`;
  if (seen.has(k)) continue;
  seen.add(k);
  deduped.push(j);
}
console.log(`Dedupe: ${ranked.length} → ${deduped.length}`);
ranked = deduped;

// 8. Anti-bias + slice
console.log("\n=== STAGE 7: anti-bias + slice ===");
const beforeAB = ranked.length;
ranked = applyTitleAntiBias(ranked, normalized.industryTags, TARGET_JOB_COUNT);
console.log(`Anti-bias: ${beforeAB} → ${ranked.length}`);
ranked.forEach((j,i) => console.log(`  ${i+1}. [${j.id}] ${j.jobTitle} @ ${j.companyName} (${j.locationRaw}) industryKey=${j.industryKey}`));

// 9. push context
console.log("\n=== STAGE 8: push context (H13) ===");
const pushCtx = await loadDailyPushContext(db, ADAM, normalized.industryTags, log);
console.log(JSON.stringify({
  recentCompany: pushCtx.recentCompany,
  recentRoleTitle: pushCtx.recentRoleTitle,
  topSkills: pushCtx.topSkills,
  hasUserStatedPreferences: pushCtx.hasUserStatedPreferences,
  language: pushCtx.language,
  variant: pushCtx.recentCompany
    ? (pushCtx.hasUserStatedPreferences ? "A_cv_and_prefs" : "B_cv_only")
    : "C_no_cv",
}, null, 2));

// 10. Match explainer (top 3) — Stream-F
console.log("\n=== STAGE 9: match explainer (top 3) ===");
const reasonsMap = new Map();
const top3 = ranked.slice(0,3);
for (const job of top3) {
  try {
    const reason = await explainMatch(
      { db, log: (e,p) => console.log("[explainer]", e, p ? JSON.stringify(p).slice(0,200) : "") },
      {
        userId: ADAM,
        userCv: { recentRoleTitle: pushCtx.recentRoleTitle, recentCompany: pushCtx.recentCompany, topSkills: pushCtx.topSkills },
        job,
        language: pushCtx.language,
      }
    );
    if (reason) reasonsMap.set(job.id, reason);
    console.log(`  [${job.id}] ${job.jobTitle}: reason="${reason || "(empty)"}"`);
  } catch (err) {
    console.log(`  [${job.id}] explainer FAILED: ${err.message}`);
  }
}
console.log(`Match-explainer hit rate: ${reasonsMap.size}/${top3.length}`);

if (reasonsMap.size > 0) pushCtx.reasons = reasonsMap;

// 11. Format
console.log("\n=== STAGE 10: friend-tone format ===");
const body = formatDailyPushBody(ranked, pushCtx);
console.log("---BODY START---");
console.log(body);
console.log("---BODY END---");

// VERDICT SUMMARY
console.log("\n\n" + "=".repeat(60));
console.log("VERDICT SUMMARY for Adam");
console.log("=".repeat(60));
console.log(`Final job count: ${ranked.length}`);
console.log(`Target was: ${TARGET_JOB_COUNT}-8`);
console.log(`Pool started at: ${queryRes.jobs.length}`);
console.log(`Hard filter: ${queryRes.jobs.length} → ${hardFiltered.length} (level=${dry.relaxLevel})`);
console.log(`Friend-tone variant: ${pushCtx.recentCompany ? (pushCtx.hasUserStatedPreferences ? "A" : "B") : "C"}`);
console.log(`Match-explainer top-3 hit rate: ${reasonsMap.size}/${Math.min(3,ranked.length)}`);

// Hard filter compliance audit
console.log("\nHard-filter audit (sponsorship + senior leak check):");
for (const j of ranked) {
  const t = (j.jobTitle ?? "").toLowerCase();
  const seniorLeak = /\b(senior|sr\.|staff|principal|lead|director|vp|head)\b/.test(t);
  const sponsorshipReq = j.sponsorshipText ?? j.requiresSponsorship ?? null;
  console.log(`  - ${j.jobTitle}: senior=${seniorLeak} sponsorshipRequired=${j.sponsorshipRequired ?? j.sponsorshipFlag ?? "?"}`);
}

console.log("\n=== INDUSTRY TAGS ALIGNMENT ===");
console.log(`User industryTags: ${JSON.stringify(normalized.industryTags)}`);
const indAligned = ranked.filter(j => {
  const ik = (j.industryKey ?? "").toLowerCase();
  return normalized.industryTags.some(t => t.toLowerCase() === ik);
}).length;
console.log(`Aligned: ${indAligned}/${ranked.length}`);

process.exit(0);
