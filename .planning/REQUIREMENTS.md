# Requirements

This file is append-only across milestones. Active milestone requirements at top; prior milestone requirements archived in `.planning/milestones/v{X}-REQUIREMENTS.md`.

**Last updated:** 2026-05-06 (v1.7 spawned post-v1.6 ship)

---

## v1.7 Active Requirements — Match Quality Depth + Pipeline Reliability Hardening

**Milestone goal:** Close v1.6 gaps surfaced post-ship. Add senior/staff job source. Fill sponsorship data. Harden Serper backfill + macmini reliability. Drop legacy code. Provision secrets + alerts. Build match-debug admin UI. Ramp QA data depth.

**Spawned:** 2026-05-06 by Adam after v1.6 audit (no blockers, but gaps documented)

### Senior Job Source (SENIOR)

- [ ] **SENIOR-01**: Add LinkedIn API / Wellfound / Otta scraper to `wekruit-scraping/src/wekruit_matching/scraper/`. Daily ingestion 100+ senior+staff SWE jobs/day.
- [ ] **SENIOR-02**: New scraper writes to `matching-jobs` with `seniorityLevel: senior|staff|principal|director` per Phase 52 careerStage vocab.
- [ ] **SENIOR-03**: Per-source feature flag in macmini `.env-secrets` (`ENABLE_LINKEDIN_SCRAPE`, `ENABLE_WELLFOUND_SCRAPE`) so individual sources can be toggled without redeploy.
- [ ] **SENIOR-04**: Source-aware deduplication — same job from JobRight + LinkedIn must collapse to one canonical row (by company + title fuzzy + apply URL).
- [ ] **SENIOR-05**: Source attribution on each `matching-jobs` doc: `sources: ['jobright', 'linkedin', 'wellfound']` array. Visible in `/admin/matching-jobs` view.

### Sponsorship Inference (SPONSOR)

- [ ] **SPONSOR-01**: LLM (gpt-5.4-nano OR Qwen-7B) infers `sponsorship: boolean` from JD text when scraper-side raw value is null/missing. Prompt: "Does this JD explicitly state visa sponsorship is offered or required?"
- [ ] **SPONSOR-02**: Inference fail-graceful — undefined → preserve null (don't fabricate); only set when JD has explicit signal.
- [ ] **SPONSOR-03**: Company allowlist `pa-sponsorship-allowlist` Firestore collection — admin-curated list of known-sponsoring companies (Google, Microsoft, Amazon, Meta, etc + 200 startups). Doc shape: `{company: string, sponsorship: boolean, source: 'h1b_data'|'manual', confidence: number}`. Ingestion uses this as fallback when JD-LLM returns null.
- [ ] **SPONSOR-04**: Backfill script `apps/functions/scripts/backfill-sponsorship.mjs` — applies inference to existing 1944 active matching-jobs. DRY-RUN + --apply.
- [ ] **SPONSOR-05**: V16 hard filter respects null vs false correctly: `sponsor_needed × sponsorship === false` drops; `sponsor_needed × sponsorship === null` keeps (graceful — unknown not negative).

### Serper Backfill Hardening (ATSURL)

- [ ] **ATSURL-01**: Parallel batch backfill — currently liveness sweep does inline 33/run. Refactor to dedicated batch CF `paBackfillAtsUrlsBatch` that processes 200/run, scheduled hourly, with 5-concurrent Serper calls.
- [ ] **ATSURL-02**: Retry queue: jobs that fail Serper resolution go to `pa-ats-resolve-priority/{jobId}` with TTL 7d. Next batch tries again with broader query.
- [ ] **ATSURL-03**: Fallback to LinkedIn URL when Serper miss — many jobright postings have a LinkedIn share URL in their `primaryUrl`; extract + verify.
- [ ] **ATSURL-04**: Cost monitoring — log each Serper call to `pa-cost-ledger` with `{api: 'serper', cost_usd: 0.001, jobId, success: bool}`; weekly summary email if >$10/week.

### Macmini Stage 2.5 Permanent Fix (MACMINI)

- [ ] **MACMINI-01**: Diagnose Supabase pooler hang in `wekruit-matching/src/wekruit_matching/pipeline/url_resolver.py`. Either fix the connection-pool config OR migrate the URL-resolution stage to wekruit-pa CF `paBackfillMatchingJobsAtsUrl` (already deployed; wire macmini Stage 4 to call CF instead of running locally).
- [ ] **MACMINI-02**: Remove `SKIP_URL_RESOLUTION=1` hotfix from `/Users/Shared/wekruit/run-pipeline.sh` once permanent fix lands.
- [ ] **MACMINI-03**: Stage 2c LLM enrichment failure ("the connection is lost") root-cause + fix. Currently fails silently per macmini logs.

### Launchd Reliability (LAUNCHD)

- [ ] **LAUNCHD-01**: Load `com.wekruit.daily-update` + `com.wekruit.health-check` plists permanently — both currently `-` PID (not loaded).
- [ ] **LAUNCHD-02**: Health-check script (`/Users/Shared/wekruit/health-check.sh`) verifies last successful daily-update <26h ago, alerts via Mailgun on failure.
- [ ] **LAUNCHD-03**: post-pipeline-webhook PermissionError fix (currently throws at end of run-pipeline.sh; non-fatal but noisy).

### Vocab Hygiene Closure (HYGIENE)

- [ ] **HYGIENE-01**: Delete legacy `apps/job-rec/src/tools/query-matching-jobs.ts` (V16 is sole path post-Phase 60 cutover). Keep tests as smoke for V16 happy path.
- [ ] **HYGIENE-02**: Tighten `seniorityLevel` regex in `apps/functions/scripts/backfill-seniority-level.mjs` — capture `Entry Level`, `New Grad, Entry Level`, `Entry, Mid Level` raw values in matching-jobs that escaped Phase 57 backfill.
- [ ] **HYGIENE-03**: Backfill canonical `industries` field on remaining ~38 parsedCandidateResumes docs (Phase 53/54 only got 6).
- [ ] **HYGIENE-04**: jobType normalization sweep — same as HYGIENE-02 for jobType vocab pollution on matching-jobs corpus.

### Secrets + Alerts (SECRETS)

- [ ] **SECRETS-01**: Provision `ANTHROPIC_API_KEY` Firebase Secret to activate Sonnet-4-6 middle tier in pa-resume-parser + JD-rel weights.
- [ ] **SECRETS-02**: Provision `PA_SLACK_ALERT_WEBHOOK` env to enable Slack alerts on QA evaluator + macmini health-check failures.
- [ ] **SECRETS-03**: LinkedIn API key (`LINKEDIN_ACCESS_TOKEN`) provisioning via macmini `.env-secrets` for SENIOR-01 scraper.

### Match Debug Admin UI (MATCHDEBUG)

- [ ] **MATCHDEBUG-01**: New page `apps/dashboard-web/src/pages/MatchDebug.tsx` — admin enters userId + sees live V16 query result with full ScoreBreakdown per job + drop-counter visualization (which gate dropped how many).
- [ ] **MATCHDEBUG-02**: Side-by-side diff: V16 vs legacy `queryMatchingJobs` for same user (until HYGIENE-01 deletion).
- [ ] **MATCHDEBUG-03**: Score weight tuning sandbox — slider for each weight (`llm_match`, `skill_jaccard`, etc), preview top-5 reranking live, save tuned weights to `pa-match-weight-overrides/{userId}` for testing.
- [ ] **MATCHDEBUG-04**: Per-job inspector: click a result job → see all 7 hard-filter gates' decisions + soft-score breakdown + JD-relative skill weights.

### QA Data Ramp (QADATA)

- [ ] **QADATA-01**: Auto-derive `targetRoleFunction` from CV `industries` + `topSkills` for users who haven't completed onboarding. Heuristic: `tags.skills` overlaps `programming_languages|frameworks_and_libraries` >3 → `software_engineering`.
- [ ] **QADATA-02**: Fill-gaps script: scan all 529 pa-users; for each missing tag axis, compute defaults from CV + chat history. Surface to admin in `/admin/users` for manual override.
- [ ] **QADATA-03**: Phase 61 QA evaluator weekly run — re-trigger after QADATA-01/02 lands; verify sampleSize > 50.
- [ ] **QADATA-04**: Onboarding completion-rate dashboard widget on `/admin/overview` — % users with `targetRoleFunction` set, trended weekly.

### Documentation (DOC-V17)

- [ ] **DOC-V17-01**: `CLAUDE.md` v1.7 design lock subsection.
- [ ] **DOC-V17-02**: `.planning/MILESTONE-v1.7-match-depth.md` with architecture diagram + per-source data flow + sponsorship inference flow + match-debug screenshots.

---

## v1.7 Out of Scope (explicit exclusions)

- Cross-repo Python tag port (deferred v2.0 — separate milestone)
- Multi-resume per user / VALET-style per-job CV variants (v2.0)
- Real-time match notifications (still async daily)
- Recruiter agent overhaul (already shipped v1.5)
- Multi-language CV parse (English-only)

## v1.7 Traceability

| REQ-ID | Phase | Status |
|---|---|---|
| SENIOR-01..05 (5) | Phase 63 | pending |
| SPONSOR-01..05 (5) | Phase 64 | pending |
| ATSURL-01..04 (4) | Phase 65 | pending |
| MACMINI-01..03 (3) | Phase 66 | pending |
| LAUNCHD-01..03 (3) | Phase 67 | pending |
| HYGIENE-01..04 (4) | Phase 68 | pending |
| SECRETS-01..03 (3) | Phase 69 | pending |
| MATCHDEBUG-01..04 (4) | Phase 70 | pending |
| QADATA-01..04 (4) | Phase 71 | pending |
| DOC-V17-01..02 (2) | Phase 72 | pending |

**Total: 37 REQ-IDs across 10 categories. 100% mapped to phases 63-72.**
