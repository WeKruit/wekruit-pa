# Job-Rec Runbook (Stream G — production-readiness)

> Audience: P9 / P10 / on-call. Last updated 2026-05-01 after Streams D+E+F+G.
> Stack: Claire (TS/Node/Firebase Cloud Functions Gen2 on `wekruit-5f89b`).

---

## Architecture (full vertical)

```
iPhone/iMessage
   ↓ (PDF + caption text or empty)
Sendblue Mac-mini relay
   ↓ HMAC-signed webhook POST
paSendblueWebhook (us-central1, 512MiB, minInstances=1)
   ├─ HMAC verify (SENDBLUE_WEBHOOK_SIGNING_SECRET)
   ├─ Allowlist check (pa-users.phoneE164)
   ├─ Rate limit (20/min/user via paRateLimitPerUserEnabled)
   ├─ Write pa-sendblue-webhook-raw (audit, 7d TTL)
   ├─ Enqueue pa-inbound-events (rawPayload includes mediaUrl)
   ├─ Side-effect 1 (when media_url present): sendReaction(love) ❤️
   │     │ Stream A circuit-breaker (5 fails → OPEN 60s, isolated key sendblue-reaction)
   │     ↓
   │   Sendblue REST POST /api/send-reaction
   │
   └─ Side-effect 2 (when media_url present): ingestCv() fire-and-forget
         │ Stream D + E pipeline:
         │   1. Download PDF (30s timeout)
         │   2. pdf-parse → text (capped 50 pages / 100KB)
         │   3. OpenAI gpt-5.4-nano structured extract → Zod schema
         │      { candidateProfile, experiences, education, industryTags[] }
         │   4. Write parsedCandidateResumes/{auto-id}
         │   5. Findings followup (Stream E1):
         │        gpt-5.4-nano + Bible v7.5.2 inline rules → 3-sentence reply
         │        → enqueue pa-outbound/out-cvfindings-{resumeId} (idempotent)
         │   6. Mem0 fact write (Stream E2):
         │        buildCvFactBody(zh/en) → mem0Add via @pa/memory
         │        partition key resolveMem0PartitionKey(userId)

onPaInbound (Firestore trigger on pa-inbound-events, 1024MiB, 300s)
   ├─ Phase 26 rate-limit / agent-version flags
   ├─ claimAndProcessInboundEvent → processInboundEvent (@pa/pa-orchestrator)
   │     ├─ load handbook v? from pa-handbooks/claire (30s TTL)
   │     ├─ composeSystemPrompt(handbook) + Stream D5 CV-context-injection
   │     │   (queries parsedCandidateResumes most-recent for userId, prepends
   │     │    "## User CV Profile" block with industryTags[])
   │     ├─ runAgentTurn(@pa/agent-runtime) — OpenAI Agents SDK
   │     │   + tools: web_search, save-job-profile (Stream F4 connector), ...
   │     ├─ rewriteIfOff (Phase 27 LLM rewriter w/ circuit breaker)
   │     ├─ output-normalizer (Bible v7.5.2 — bare URL on own line)
   │     └─ enqueue pa-outbound for assistant reply
   │
paSendblueOutbox (Firestore trigger on pa-outbound, 512MiB, 120s, concurrency=1)
   ├─ Sendblue circuit breaker (Stream A — 5 fails → OPEN 60s)
   └─ POST https://api.sendblue.com/api/send-message → user iPhone

paOnTapbackEvent (Firestore trigger on pa-tapback-events, 256MiB)
   ├─ Stream A4 — query last outbound, extract jobIds via rawMeta or URL
   ├─ Write pa-matching-feedback rows (one per attributed jobId)

paJobRecDaily (Cloud Scheduler, every day 09:00 PT, 512MiB, 540s)
   ├─ Load pa-job-profiles where status=active (cap 100/run)
   ├─ For each user (gated by paJobRecEnabled flag):
   │   ├─ Stream G1 cascade: defaultUserEmbedFetcher → defaultUserEmbedComputer
   │   │   (lazy compute via OpenAI text-embedding-3-small + cache writeback)
   │   ├─ queryMatchingJobs (filter sponsorship + location + status=active)
   │   ├─ rerankByCosine(user_emb × job_emb) → top 5
   │   ├─ formatBatchMessage (Bible v7.5.2 — 1-line lead-in + 2-line per job)
   │   └─ enqueue pa-outbound (idempotent on userId-YYYYMMDD-batch)

External Sendblue (REST + webhooks)
   ├─ Inbound: HMAC-SHA256 signed via SENDBLUE_WEBHOOK_SIGNING_SECRET
   ├─ Outbound auth: sb-api-key-id + sb-api-secret-key
   ├─ media_url: https://storage.googleapis.com/inbound-file-store/* (30d TTL)
   └─ Tapback: /api/send-reaction with reaction ∈ {love, like, dislike, laugh, emphasize, question}
```

---

## Feature Flags (`pa-feature-flags`)

| Key | Scope | Default | Allowlist | Use |
|-----|-------|---------|-----------|-----|
| `paHumanizeRuntimeEnabled` | perUser bool | `false` | 3 admin userIds | Phase 35-40 humanize stack (detectors + tracker + FSM + mem policy) |
| `paJobRecEnabled` | perUser bool | `false` | 3 admin userIds | Stream F4 saveJobProfile connector + paJobRecDaily flow |
| `paRateLimitPerUserEnabled` | global bool | `true` | — | Phase 26 21st-msg-in-rolling-60s 429 |
| `paLlmRewriteDisabled` | env var | unset | — | Kill switch for Phase 21/27 LLM rewriter |
| `paDetectorsEnabled` | env var | unset | — | Phase 35 detector pass |
| `paFsmEnabled` | env var | unset | — | Phase 37 FSM directive |
| `paMemoryPolicyEnabled` | env var | unset | — | Phase 38 advice tracker |
| `paImperfectionInjectorEnabled` | env var | unset | — | Phase 36 ImperfectionInjector |
| `PA_CV_FINDINGS_FOLLOWUP_DISABLED` | env var | unset | — | Stream E1 followup msg kill switch |
| `PA_CV_MEM0_WRITE_DISABLED` | env var | unset | — | Stream E2 mem0 fact kill switch |
| `PA_HUMANIZE_RUNTIME_DISABLED` | env var | unset | — | Phase 40 emergency umbrella off |

### Toggle a flag
```
GOOGLE_APPLICATION_CREDENTIALS=/path/to/sa.json node -e '
const { initializeApp, applicationDefault, getApps } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");
const { setFlag } = require("./packages/pa-persistence/dist/feature-flags.js");
if (getApps().length === 0) initializeApp({ credential: applicationDefault() });
(async () => {
  await setFlag(getFirestore(), "paJobRecEnabled", {
    value: false, type: "bool", scope: "perUser",
    allowlist: ["userId-1","userId-2"],
  }, { actor: "you@wekruit.com", reason: "your reason" });
  process.exit(0);
})();
'
```

---

## Common Operations

### Add a user to allowlist
1. Find their userId via `pa-users.phoneE164 == "+1XXX..."`
2. Append to `paJobRecEnabled.allowlist[]` via setFlag (above)

### Manually trigger paJobRecDaily for one user
1. Set `pa-job-profiles/{userId}.status = "active"` if not already
2. Cloud Scheduler: trigger via gcloud:
   ```
   gcloud scheduler jobs run firebase-schedule-paJobRecDaily-us-central1 --location=us-central1 --project=wekruit-5f89b
   ```
   (Runs the FULL batch — not just one user. To target one user only, modify the batch driver call locally + `gcloud functions deploy` as a one-shot.)

### Inspect a user's data
```
GAC=/path/to/sa.json node -e '
const { initializeApp, applicationDefault, getApps } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");
if (getApps().length === 0) initializeApp({ credential: applicationDefault() });
(async () => {
  const db = getFirestore();
  const userId = "ARGUMENT-USER-ID";
  const profile = await db.collection("pa-job-profiles").doc(userId).get();
  const resumes = await db.collection("parsedCandidateResumes").where("userId","==",userId).orderBy("createdAt","desc").limit(3).get();
  const adviceItems = await db.collection("pa-advice-tracker").doc(userId).collection("items").orderBy("ts","desc").limit(5).get();
  console.log("profile:", profile.data());
  console.log("resumes:", resumes.docs.map(d=>({id:d.id,industryTags:d.data().industryTags,createdAt:d.data().createdAt})));
  console.log("recent advice:", adviceItems.docs.map(d=>({id:d.id,ts:d.data().ts,text:(d.data().text||"").slice(0,60)})));
  process.exit(0);
})();
'
```

### Check tapback feedback for a user
```
SELECT * FROM pa-matching-feedback WHERE userId = '...' ORDER BY createdAt DESC
```
(Adapt as Firestore query — same shape.)

### Pause a user
`db.collection("pa-job-profiles").doc(userId).update({ status: "paused" })`

---

## Troubleshooting

### "User uploaded CV but no followup arrived"
Checklist (in order):
1. `pa-sendblue-webhook-raw` has the row with `media_url` ?
   → If NO: Sendblue webhook didn't fire OR HMAC failed. Check Cloud Logging for `[sendblue][webhook]` entries.
2. `pa-inbound-events/{id}.rawPayload.mediaUrl` is set ?
   → If NO: webhook handler bug; likely empty-content skip without media_url branch (Stream A1 fix).
3. `parsedCandidateResumes` has a doc for userId after webhook receipt ?
   → If NO: cv-ingest pipeline failed. Check `[sendblue][cv-ingest]` logs. Likely culprits: PDF download HTTP fail, pdf-parse threw, OpenAI rate limit. ingestCv NEVER throws — it returns `{ok:false, reason}`. Search log for "cv-ingest done" entries.
4. `pa-outbound/out-cvfindings-{resumeId}` exists ?
   → If NO and parsedCandidateResumes IS present: `runFindingsFollowup` failed. Check `PA_CV_FINDINGS_FOLLOWUP_DISABLED` env. Check OpenAI API key. Check pa-users.phoneE164 lookup.
5. `pa-outbound/out-cvfindings-{resumeId}.status == "sent"` ?
   → If "pending"/"failed": paSendblueOutbox didn't ship it. Check Sendblue circuit breaker state + REST call logs.

### "User getting wrong industry recommendations"
1. Check `parsedCandidateResumes/{id}.industryTags` — wrong LLM extraction?
   → Manual fix: `db.doc.update({industryTags:["correct_tag"]})`
2. Check `pa-job-profiles/{userId}.industryTags` (from probe answers) — user told us wrong?
   → Ask user via iMessage to confirm.
3. The corpus filter is `industryKey ==` (free-text, 30 distinct values: mix of industry + function). Misalignment between user enum and corpus values is a known gap (Stream G2 abort findings) — semantic embedding rerank is the primary signal, structured filter is best-effort.

### "Mem0 facts missing"
1. Check `PA_CV_MEM0_WRITE_DISABLED` env — kill switch on?
2. Check `[memory] mem0 fact recorded` log line for userId
3. Check QDRANT_URL + QDRANT_API_KEY secrets bound to onPaInbound + paSendblueWebhook
4. mem0 collection "pa_memory" present in Qdrant ?

### "Daily batch sent 0 jobs"
1. Cloud Scheduler trigger fired? `gcloud scheduler jobs describe ...`
2. `paJobRecDaily` last execution log → `batch_complete` with `delivered` count
3. `delivered: 0`, `skippedFlag: N` → flag off for all users — check `paJobRecEnabled.allowlist`
4. `delivered: 0`, `skippedNoJobs: N` → query returned no candidates — corpus filter too narrow OR user pref mismatch
5. `delivered: 0`, `errors: N` → check error logs

---

## Cost Monitoring

| Surface | Cost driver | Daily est. |
|---------|------------|------------|
| OpenAI gpt-5.4-nano | cv-ingest extract + cv-findings + LLM rewrite | ~$0.001/CV × N CVs/day + $0.00005/turn × N turns/day |
| OpenAI text-embedding-3-small | user CV embedding (G1 cascade, lazy) | ~$0.00002/user × 100/day = $0.002/day |
| SiliconFlow Qwen-7B | conversation LLM (Phase 21) | ~$0.0002/turn × N turns/day |
| Sendblue messages | outbound iMessage | $0.01/msg × N msgs/day |
| Firestore | reads/writes | typically <$1/day at this scale |
| Cloud Run | function invocations | <$1/day |

Monitor via [Cloud Billing console](https://console.cloud.google.com/billing). LLM-spend telemetry written via `pa.spend.daily` log events.

---

## Disaster Recovery

### Disable the entire job-rec vertical (general Claire chat untouched)
```
# Step 1: kill cv-ingest side effects
gcloud run services update pasendbluewebhook --update-env-vars="PA_CV_FINDINGS_FOLLOWUP_DISABLED=true,PA_CV_MEM0_WRITE_DISABLED=true" --project=wekruit-5f89b --region=us-central1
# Step 2: turn off the flag for all users (clear allowlist)
GAC=... node -e '
  ... setFlag("paJobRecEnabled", { value: false, type: "bool", scope: "perUser", allowlist: [], blocklist: [] })
'
# Step 3: pause Cloud Scheduler
gcloud scheduler jobs pause firebase-schedule-paJobRecDaily-us-central1 --location=us-central1 --project=wekruit-5f89b
```

### Disable Claire entirely (humanize off, vanilla rewriter only)
```
gcloud run services update onpainbound --update-env-vars="PA_HUMANIZE_RUNTIME_DISABLED=true,PA_DETECTORS_ENABLED=false,PA_FSM_ENABLED=false,PA_MEMORY_POLICY_ENABLED=false" --project=wekruit-5f89b --region=us-central1
```

### Rollback handbook v? → v(prev)
```
GAC=... node -e '
  const { revertHandbook } = require("./packages/pa-persistence/dist/handbook.js");
  ... revertHandbook(db, "claire", N-1, { actor: "you@wekruit.com", reason: "rollback" });
'
```

---

## Stream Lineage (commits)

| Stream | Commits | Purpose |
|--------|---------|---------|
| A | `cd54446` `b8332f6` `d7c96c2` `0b298c2` | Sendblue media_url plumb + tapback parser + send-reaction circuit breaker + pa-matching-feedback writer |
| B | `e3e0f79` | apps/job-rec greenfield (RecruiterAgent + 4 tools + paJobRecDaily stub) |
| C | `8ff33a5` | onPaInbound dispatcher (later torn down by D1) |
| D | `29ecb8d` `335de55` `3b84555` `e656a52` | Pivot to Claire-only; cv-ingest pipeline; tapback ❤️ + cv-ingest fire-and-forget on receipt; CV system prompt injection |
| E | `56662ce` | CV findings followup outbound + mem0 fact write |
| F | `7632dfe` `03efcdf` `ed500d7` `4ae0a48` `766e80d` | industryTags enrichment in cv-ingest; matching-jobs backfill script (deferred); Bible v7.6 JOB-PREF PROBE rule; saveJobProfile connector wired into Claire; daily-matcher cosine rerank |
| G | (pending commit) | userEmbedComputer cascade + production wire; F2 backfill abort decision; production audit; this RUNBOOK |

---

## Deferred / Backlog

| Item | Owner | Why deferred |
|------|-------|--------------|
| F2 backfill --live (40k matching-jobs) | P9 | Phase 2a 32%-non-other vs 80% threshold — source `industryKey` field semantically mixes industry + function. Better path: rely on cosine embedding rerank as primary signal. Re-evaluate after observing daily-batch quality metrics. |
| Phase 30 downstream connectors | P9 | HMAC secrets unprovisioned (`PA_TRIGGER_HMAC_LAYOFF/SALARY`); business-side endpoint URLs undefined; out-of-scope for v1 ship |
| ESCO multilingual taxonomy ingest | P10 | 50MB dump + 30min import. Lightweight 10-tag enum sufficient for MVP; revisit when match quality complaints surface |
| RecruiterAgent legacy retirement | P10 | apps/job-rec/src/recruiter-agent.ts + apps/functions/src/job-rec/recruiter-flow.ts marked DEPRECATED; not invoked from prod path. Sweep in single retirement commit after one full week of stable Claire-only operation. |
| Live E2E test suite (Stream G4) | P9 | Spawned as separate focused P7 |

---

## Quick links
- Firebase console: https://console.firebase.google.com/project/wekruit-5f89b/overview
- Cloud Logging (onPaInbound): https://console.cloud.google.com/logs/query;query=resource.labels.service_name%3D%22onpainbound%22?project=wekruit-5f89b
- Sendblue dashboard: https://dashboard.sendblue.com
- Bible (live): pa-handbooks/claire (read via Firestore console — version 5+ as of Stream F3)
