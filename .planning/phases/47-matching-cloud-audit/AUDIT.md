# Phase 47 — Matching Engine Cloud Migration AUDIT

**Stream**: D8 (v1.5 friend-companion)
**Date**: 2026-05-02
**Scope**: RESEARCH ONLY — no code changes. Decision document for Phase 48 build.
**Source repo**: github.com/WeKruit/wekruit-matching (cloned at /tmp/wekruit-matching/)
**Current host**: Mac mini at `/Users/wekruitclaw1/Desktop/WeKruit/wekruit-matching` (single-host SPOF).

底层逻辑: pipeline already produces Firestore deltas; Postgres is mostly cache. 抓手: kill the Mac mini SPOF without rewriting 9.5k LoC. 闭环: cloud cron → cloud worker → existing /api/sync/jobs → Firestore.

---

## 1. Current Architecture Inventory

### 1.1 Stack
- Python 3.12, uv-managed venv, ~9.5k LoC across 52 .py files
- Postgres 16 + pgvector 0.4.2 (HNSW, 1536-dim, OpenAI text-embedding-3-small)
- FastAPI + uvicorn (`start-server.sh` → `127.0.0.1:8001`, 4 workers, localhost-only)
- alembic 5 migrations (0001-0005)
- LLMs: anthropic 0.86 (Haiku — classify industry/skills/sponsorship/JD-extract), openai 2.30 (embed only)
- External: Firecrawl (Workday/non-ATS JD), Serper (URL resolve), GitHub PAT (SimplifyJobs raw)

### 1.2 Postgres schema (jobs table — primary)
- Identity: `job_id` (sha256 of company+title+url), `source_repo`, `status`
- Raw: `company_name`, `role_title`, `primary_url`, `ats_apply_url`, `location_raw`, `date_posted_raw`
- Tracking: `first_seen_at`, `last_seen_at`, `enriched_at`, `embedded_at`, `content_hash`, `ats_content_hash`, `data_quality_score`, `jd_fetch_source`, `jd_fetch_attempted_at`
- Enriched (LLM): `job_description`, `core_responsibilities[]`, `salary_range`, `seniority_level`, `benefits[]`, `qualifications[]`, `industry`, `company_size`, `required_skills[]`, `sponsorship`
- Vector: `embedding vector(1536)` + HNSW(`vector_cosine_ops`), `embedding_model`
- Sister tables: `user_profiles` (skills, prefs, affinity_embedding), `feedback` (like/dislike/applied)

### 1.3 Cron / runtime
- launchd → `scripts/daily-update.sh` 6am CDT
- Single entry: `python -m wekruit_matching.pipeline.daily` (fully orchestrated, ~280 LoC)
- Pipeline stages (all wrapped in `try/except`, errors collected for email):
  1. Scrape SimplifyJobs (`scraper.run.scrape_all`)
  2a. JobRight page enrichment (free, 8 workers, batch 50)
  2b. ATS JD enrichment (Greenhouse/Lever/Ashby/Workday/Firecrawl)
  2.5. URL resolution (Simplify → slug registry → Serper, batch 500)
  2c. LLM enrichment (Haiku) for unfilled metadata
  3. Embed (OpenAI text-embedding-3-small)
  4. **Firebase sync** — `pipeline/job_sync.py:sync_jobs_to_firebase(since=run_started_at)` POSTs batches to `FIREBASE_SYNC_URL` (`/api/sync/jobs` on a Firebase function), uses `X-API-Key`, batch 250, with 503/504/timeout split-and-retry
- Email summary on completion (start + end)

### 1.4 FastAPI surface (`api/server.py`)
- `GET /` — health
- `POST /match` (60/min) — UserProfile → ranked matches (calls `matching.matcher.get_matches`)
- `POST /feedback` — record like/dislike/applied
- `POST /api/v1/matching/recommendations` (60/min) — VALET-compatible JobX shape
- `POST /analyze-url` (30/min) — on-demand URL → JD classify → match score (no DB write)
- `GET /jobs/stats` — counts by source_repo × status
- All but `/` require `X-API-Key`. Server is bound to `127.0.0.1` so today it is unreachable from the internet — only the cron-side Firestore push reaches the cloud.

### 1.5 Data flow (current)
```
launchd 6am CDT
   ↓
daily-update.sh → pipeline.daily.run_daily_pipeline()
   ↓
SimplifyJobs raw  → scraper → Postgres jobs (active/inactive)
   ↓
JobRight + ATS + Firecrawl + Serper → JD text + structured fields → Postgres
   ↓
Anthropic Haiku → industry/skills/sponsorship → Postgres
   ↓
OpenAI text-embedding-3-small → vector(1536) → Postgres pgvector
   ↓
sync_jobs_to_firebase(since=runStart) → HTTPS POST batches → wekruit-pa /api/sync/jobs
   ↓
Firestore matching-jobs/{jobId}  (40,374 docs, used by job-rec recruiter agent)
```
**Crucial finding**: the matching API surface (`/match`, etc.) is bound to localhost and *not* called from wekruit-pa today. wekruit-pa reads `matching-jobs` Firestore directly via `apps/job-rec/src/tools/query-matching-jobs.ts` and uses its own cross-encoder rerank. The Mac mini's only critical externally-visible function is the **Firestore sync write**. Everything else is internal to the matching repo.

This drastically narrows the migration.

---

## 2. Three Migration Options

Cost ceiling per Adam: **$50/mo**. Optimization target: ship fastest, lowest risk, single-host SPOF removed.

### Option A — Cloud Run + Cloud SQL (lift-and-shift)

- Cloud Run service, 4 vCPU / 4 GB, scale-to-zero (`--min-instances=0 --max-instances=2`)
- Cloud SQL Postgres 16 with pgvector extension (smallest tier: `db-f1-micro` or `db-g1-small`)
- Cloud Scheduler → HTTPS POST to `/scrape-and-sync` endpoint (Cloud Run authenticates via OIDC)
- Secrets: Secret Manager (ANTHROPIC_API_KEY, OPENAI_API_KEY, GITHUB_TOKEN, FIREBASE_SYNC_*, FIRECRAWL_API_KEY)
- Container: Dockerfile with uv install + entrypoint = uvicorn (FastAPI server) + a `/scrape-and-sync` route that calls `run_daily_pipeline()` synchronously (pipeline currently ~30-60 min — needs Cloud Run **2nd gen** or **Cloud Run Jobs** to exceed 60 min request limit)

**Pros**:
- Minimal code change. Existing 9.5k LoC works as-is.
- Postgres schema preserved; `embedding` HNSW + dedup logic via `content_hash` keep working.
- Can keep `/match` and `/analyze-url` as internal endpoints (not used today, but free option).

**Cons**:
- Cloud SQL is the dominant cost. **db-f1-micro $9-15/mo storage-included only at small data**, db-g1-small ~$25-30/mo, with disk/IO it climbs. Realistic burn $35-55/mo before egress.
- Pipeline duration: needs **Cloud Run Jobs** (not service) for >60 min execution OR refactor pipeline to fit `<60 min` Cloud Run service request OR break into stages on Cloud Tasks. Adds plumbing work.
- pgvector extension on Cloud SQL — supported on Postgres 16, but version pin matters; HNSW available in pgvector ≥0.5.

**Effort**: 2.5-3 dev-days (Dockerfile, Cloud SQL provision + alembic upgrade, Cloud Run Job, Cloud Scheduler, Secret Manager, smoke + cutover).

**Cost estimate**: $35-60/mo (Cloud SQL $25-40 + Cloud Run scale-to-zero ~$2-5 + scheduler + egress + Firecrawl/OpenAI/Anthropic API costs unchanged). **Risk: at ceiling.**

### Option B — Cloud Functions Gen2 + Firestore-only (collapse Postgres, port to TS)

- Rewrite pipeline in TypeScript inside `apps/functions/` — same monorepo as wekruit-pa
- Replace Postgres with Firestore `matching-jobs` (already exists, 40,374 docs) + a new `matching-jobs-pipeline-state/{job_id}` collection for tracking (`content_hash`, `ats_content_hash`, `last_seen_at`, etc.)
- Drop pgvector — replace cosine similarity with the existing **BAAI/bge-reranker-v2-m3 cross-encoder** that wekruit-pa already loads in `apps/job-rec/`. Embeddings live in `pa-job-profiles` already; matching is rerank-driven, not pgvector-driven.
- Cloud Scheduler → Pub/Sub → Cloud Functions Gen2 fan-out
- LLM calls (Anthropic Haiku, OpenAI embed) remain — just from TS instead of Python

**Pros**:
- Monorepo unification — stack matches wekruit-pa (TS, Firestore, CF Gen2). Shared CI, deploy, observability, IAM.
- No Cloud SQL. Cost floor near zero.
- pgvector is *already a non-load-bearing dependency for wekruit-pa* — cosmetically nice to retire.

**Cons**:
- **Full rewrite**: 9.5k LoC of mature pipeline (scraper, JD-fetch, dedup H10/H11/H12, URL resolution, JobRight enricher, slug registry, etc.) → re-implement in TS. Months not days.
- High regression risk: wekruit-pa just landed H8/H10/H11/H12 Stream-H quality wins which depend on the dedup + cross-encoder rerank. Touching the pipeline now risks all of that.
- Loses the FastAPI surface entirely (low cost — wekruit-pa doesn't call it).

**Effort**: 15-25 dev-days. **Wildly out of v1.5 budget.**

**Cost estimate**: $5-15/mo (CF Gen2 invocations + Firestore writes). Lowest of the three — but only matters after the rewrite cost is paid.

### Option C — Cloud Run + Firestore-only (port architecture, keep Python, drop Postgres)

- Cloud Run service or **Cloud Run Job** for pipeline; Python codebase stays intact
- Replace Postgres with Firestore reads/writes inside the pipeline
- `jobs` table → `matching-jobs/{job_id}` (already exists; pipeline writes here today via `sync_jobs_to_firebase`)
- Pipeline-state side tables (`content_hash`, `last_seen_at`, `enriched_at`, `data_quality_score`, `jd_fetch_attempted_at`, etc.) → new `matching-jobs-pipeline/{job_id}` Firestore collection OR a single `_pipeline` subcollection
- Embeddings: skip storage entirely. wekruit-pa already has the cross-encoder + per-job-profile embeddings in `pa-job-profiles` collection. The Python pipeline can produce an embedding once and write it directly into `matching-jobs` doc (it already does — see `_serialize_embedding` in `job_sync.py`).
- Drop `user_profiles` + `feedback` Postgres tables — they back `/match` and `/feedback` which wekruit-pa doesn't call. Document as deprecated; remove after a 2-week soak.

**Pros**:
- No Cloud SQL → no $25-40/mo floor. Inside the $50 ceiling with margin.
- Python codebase preserved; only the **db.connection** + **db.tables** + a few `conn.execute(...)` sites need to swap to Firestore client. Estimated ~25-30 files touched, mostly in `scraper/upsert.py`, `enrichment/run.py`, `embedding/run.py`, `pipeline/job_sync.py`.
- pgvector eliminated as a deploy headache (no extension install needed in container).
- Same Firestore that wekruit-pa already reads — single source of truth.

**Cons**:
- ~3-5 dev-days to refactor Postgres → Firestore (less than B's full rewrite, more than A's lift).
- Firestore aggregate query semantics differ from SQL (no `GROUP BY source_repo, status` — `/jobs/stats` needs to be a derived counter). Acceptable: stats endpoint isn't used by wekruit-pa.
- HNSW vector index gone. **Mitigation**: pipeline does not query vectors today. The vector is computed once and written to Firestore as a serialized list. wekruit-pa's matcher uses cross-encoder rerank, not pgvector cosine. So losing HNSW is a non-event for production.
- Loses `/match` and `/analyze-url` cosine-driven endpoints. Status: confirmed unused by wekruit-pa (job-rec calls Firestore directly + cross-encoder). Document as deprecated.

**Effort**: 4-6 dev-days (Dockerfile, Firestore client port, Cloud Run Job, Cloud Scheduler, Secret Manager, smoke + 7-day soak + cutover).

**Cost estimate**: $5-15/mo (Cloud Run Job ~$2-5 + Firestore writes ~$3-8 + Cloud Scheduler ~$0 + egress). **Well under ceiling.**

---

## 3. Decision — Recommend Option C (Cloud Run + Firestore-only)

**Recommendation: Option C.** Rationale:

1. **底层逻辑**: the matching API surface is unused by wekruit-pa today. The Mac mini's only critical job is to write to Firestore. Removing Postgres aligns the system with what is actually load-bearing.
2. **抓手** = `pipeline/job_sync.py` already converts every job row to a JSON doc that is the canonical Firestore shape. Refactoring upstream to read/write Firestore directly is a *contraction*, not an expansion.
3. **Cost**: A is at-ceiling, C is well under, B is fine on cost but the rewrite cost is prohibitive in v1.5 timeline.
4. **Risk profile**: A introduces Cloud SQL (extra surface to monitor, pgvector-on-Cloud-SQL version compatibility, alembic-in-prod). C drops surface area. B introduces full-rewrite risk on top of the just-shipped Stream-H quality wins.
5. **Reversibility**: C is reversible via a 1-week dual-write window (Mac mini still running, Cloud Run also writing) before decom.

**Decision recommendation**: GO with **Option C** for Phase 48. Hold A as fallback if a Postgres-specific behavior emerges during port (specifically: pgvector queries from any consumer we missed — verify in Phase 48 Step 1).

---

## 4. Phase 48 Task Breakdown (assumes C accepted)

### Step 0 — Pre-flight verification (0.5d)
- [ ] Audit all callers of FastAPI surface — confirm `/match`, `/analyze-url`, `/feedback`, `/jobs/stats` are not called by wekruit-pa. `grep -r 'localhost:8001\|wekruit-matching' wekruit-pa/`. Also check Discord bot, VALET integration if any.
- [ ] Capture a Postgres dump from Mac mini for one-shot snapshot rollback (`pg_dump`).
- [ ] Capture current Firestore `matching-jobs` doc count baseline (40,374 expected per types.ts).

### Step 1 — Containerize pipeline (1d)
- [ ] Add `Dockerfile` to wekruit-matching: python:3.12-slim, uv install, `CMD ["python", "-m", "wekruit_matching.pipeline.daily"]`
- [ ] Add `cloudbuild.yaml` for GCP build trigger on push to main
- [ ] Local smoke test: `docker run --env-file .env wekruit-matching` against existing Mac mini Postgres. Should pass unchanged.

### Step 2 — Firestore-port the data layer (2-3d)
- [ ] New `db/firestore_client.py` — `get_doc(job_id)`, `upsert_doc(job_id, fields)`, `query(filters, limit)`, `delete_doc(job_id)`
- [ ] Refactor `scraper/upsert.py` — replace psycopg `INSERT ... ON CONFLICT` with `firestore_client.upsert_doc`
- [ ] Refactor `enrichment/run.py`, `embedding/run.py`, `pipeline/run_jd_enrichment.py`, `pipeline/run_url_resolution.py` — replace `conn.execute` SELECT/UPDATE patterns with Firestore `where` queries
- [ ] Drop `pipeline/job_sync.py` — pipeline now writes to Firestore directly; the cloud function `/api/sync/jobs` becomes redundant (consider keeping it as a backstop for one release)
- [ ] Drop `db/connection.py`, `db/tables.py`, `alembic/` from runtime path; preserve in repo as `legacy/` reference for 1 release
- [ ] **Disable** `matching/matcher.py` and `feedback/handler.py` paths (return 410 Gone) — confirmed unused
- [ ] Unit tests on Firestore emulator (already used in wekruit-pa CI — `firebase emulators:start`)

### Step 3 — Cloud deployment (1d)
- [ ] Create Cloud Run Job: 4 vCPU / 4 GB / `--task-timeout=3600` (1 hr) / scale-to-zero
- [ ] Wire Secret Manager: ANTHROPIC_API_KEY, OPENAI_API_KEY, GITHUB_TOKEN, FIRECRAWL_API_KEY, GOOGLE_APPLICATION_CREDENTIALS for Firestore (use Workload Identity instead — bind Cloud Run Job SA → Firestore writer role)
- [ ] Cloud Scheduler: 11:00 UTC daily (= 6am CDT) → triggers Cloud Run Job execution via OIDC
- [ ] Email-on-failure: keep existing `notifications/email.py` SMTP path; or swap to Cloud Logging + alert policy. Prefer the latter for production.

### Step 4 — Cutover (1d)
- [ ] **Day 0**: Run Cloud Run Job manually once with `--dry-run` flag (skip Firestore writes, log only). Verify scrape + enrich + embed counts match Mac mini's last successful run.
- [ ] **Day 1**: Run Cloud Run Job for real, IN PARALLEL with Mac mini cron. Both write to Firestore matching-jobs. Idempotent because `job_id` is sha256 + Firestore upsert is set-with-merge. Compare doc deltas.
- [ ] **Day 2-7**: 7-day dual-run soak. Monitor: Firestore write QPS, Cloud Run Job duration, error rate. wekruit-pa daily-batch job-rec output unchanged.
- [ ] **Day 8**: Disable Mac mini launchd entry (`launchctl unload`). Cloud Run Job becomes sole writer.
- [ ] **Day 8-14**: Monitor solo run. Watch for any pipeline regression.

### Step 5 — Mac mini decom (0.5d)
- [ ] **Decom criteria** (ALL must pass): 7 consecutive Cloud Run Job successes + Firestore matching-jobs doc count stable + wekruit-pa daily-batch users get pushes with no quality regression vs. baseline + no error logs in Cloud Logging for 5 consecutive days.
- [ ] Power down Mac mini matching service. Keep machine on standby for 30 days as last-resort rollback.
- [ ] Day +30: re-image Mac mini, archive Postgres dump to GCS, retire.

### Rollback plan
- **Within Day 1-7 dual-run**: re-enable Mac mini cron; disable Cloud Scheduler. Zero data loss because both write same docs.
- **Day 8-14 (Mac mini idle but Postgres intact)**: re-load launchd, Cloud Run Job stays paused. Resume Mac mini writes within 1 hour.
- **Day 15-30 (Mac mini powered down, Postgres dumped)**: restore Postgres dump to Mac mini, re-enable cron, fall back to Option A in parallel as long-term plan.
- **>Day 30**: Mac mini retired. Rollback would require restoring Postgres dump to Cloud SQL (Option A). Estimated 2 dev-days.

### Total Phase 48 effort: 4-6 dev-days (estimate matches MILESTONE-v1.5 entry).

---

## 5. Open Questions for Adam (max 5)

1. **Confirm `/match` + `/analyze-url` + `/feedback` are dead surface**: Are there any external consumers (Discord bot, VALET, anything) calling the Mac mini FastAPI on port 8001? If yes, they break in Option C and we need either Option A or a thin Firestore-backed reimpl of those endpoints.
2. **Cloud project + billing**: Does the cron Cloud Run Job + Scheduler land in the existing **wekruit-pa** GCP project, or a separate `wekruit-matching` project? Same project = simpler Workload Identity to write Firestore; separate = cleaner blast-radius isolation.
3. **Email notifications**: keep SMTP-based `notifications/email.py` (currently sends via Mac mini's local sendmail / Gmail App Password)? Or swap to Cloud Logging + alert policy with PagerDuty/Slack? Latter is more idiomatic in GCP and removes an env-var dependency.
4. **Acceptable pipeline runtime**: current pipeline takes ~30-60 min on Mac mini. Cloud Run Job timeout caps at 24h (since 2024). Confirm we can budget 60-90 min daily window without escalating to a pipeline split.
5. **Mac mini afterlife**: after decom, retire the machine entirely or repurpose for the **iMessage Apple-ID worker** noted in user memory? Keep in mind the iMessage Apple-ID-worker AUP issue — that decision is independent but the hardware is the same.

---

## Appendix A — File-level migration map (Option C)

| File | Current | Phase 48 action |
|---|---|---|
| `db/connection.py` | psycopg pool | Replace with Firestore client wrapper |
| `db/tables.py` | SQLAlchemy schema | Archive to `legacy/`; convert to Pydantic doc schema for Firestore |
| `alembic/` | 5 migrations | Archive to `legacy/`; new collection layout documented in `FIRESTORE_SCHEMA.md` |
| `scraper/upsert.py` | psycopg `INSERT ON CONFLICT` | Firestore `set(merge=True)` |
| `scraper/dedup.py` | content_hash check | Firestore doc `where('content_hash', '==', ...)` |
| `enrichment/run.py` | SELECT unenriched, UPDATE | Firestore `where('enriched_at', '==', null)`, `update()` |
| `embedding/run.py` | SELECT no-embedding, UPDATE | Firestore `where('embedding', '==', null)`, `update()` |
| `pipeline/job_sync.py` | HTTPS POST batches → /api/sync/jobs | DELETE — direct Firestore write replaces it |
| `pipeline/daily.py` | orchestrator | unchanged (calls refactored stages) |
| `pipeline/run_jd_enrichment.py` | psycopg | port to Firestore |
| `pipeline/run_url_resolution.py` | psycopg | port to Firestore |
| `api/server.py` | FastAPI surface | Trim to `/` + `/scrape-and-sync` admin trigger; remove `/match`, `/feedback`, `/analyze-url`, `/jobs/stats` (or stub 410) |
| `matching/matcher.py` | pgvector cosine | DELETE (unused) |
| `feedback/handler.py` | feedback table writes | DELETE (unused) |
| `notifications/email.py` | SMTP | Decision per Q3 |

---

## Appendix B — Cost back-of-envelope (Option C, monthly)

| Line item | Estimate |
|---|---|
| Cloud Run Job (4vCPU/4GB, 60 min/day × 30) | ~$2-5 |
| Cloud Scheduler (1 trigger/day) | <$0.10 |
| Firestore writes (~5k jobs/day × 30 = 150k writes; reads similar order) | $3-8 |
| Secret Manager (5 secrets) | <$0.50 |
| Cloud Logging | $1-2 |
| Egress (Anthropic + OpenAI + Firecrawl outbound, JD fetches) | $1-3 |
| **Subtotal cloud infra** | **$8-19/mo** |
| Anthropic Haiku enrichment (~5k jobs/day × Haiku ~$0.25/1M tok × ~600 tok/job) | $20-25 (unchanged) |
| OpenAI text-embedding-3-small ($0.02/1M × ~150k tok/day) | $0.10 (unchanged) |
| Firecrawl (existing plan, unchanged) | existing |
| **Total monthly burn (cloud-only delta over current Mac mini)** | **$8-19/mo, well under $50** |

LLM costs are unchanged (same calls, just from Cloud Run instead of Mac mini). The migration delta is the cloud infra line only.
