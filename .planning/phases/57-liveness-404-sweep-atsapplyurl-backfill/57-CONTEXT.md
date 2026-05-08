# Phase 57: Liveness/404 sweep + atsApplyUrl backfill + macmini fixups - Context

**Gathered:** 2026-05-06
**Status:** Shipped 2026-05-06 (`57c182b`). Verified: [.planning/v1.6-MILESTONE-AUDIT.md](../../v1.6-MILESTONE-AUDIT.md).
**Mode:** Decisions D9, D10 locked + Adam directive includes macmini fixes

<domain>
## Phase Boundary

Daily Cloud Scheduler CF HEAD-checks `matching-jobs.atsApplyUrl` for active jobs, marks `dead=true` on 404/410/500/timeout. Sweep batch 500/min, concurrent 50, 100ms throttle. 30K active in <60min. Re-checks dead jobs after 7d. Dead jobs older than 30d after marking are hard-deleted. `paBackfillMatchingJobsAtsUrl` (iter34 G.3 commit `a56da02`) wired into daily sweep.

**Plus Phase 56 followups + Adam-directive macmini work:**
- jobType vocab normalization (intern→internship, new_grad→new_graduate)
- seniorityLevel backfill from roleTitle regex
- macmini wekruit-matching pipeline state inspection + Stage 2.5 url_resolution diagnosis
- Trigger fresh jobright pipeline ingestion run (macmini-side) to repopulate corpus with <20d firstSeenAt jobs

**REQ-IDs:** LIVE-01, LIVE-02, LIVE-03, LIVE-04 (4)

**In scope:**
- New CF `paLivenessSweepDaily` — Cloud Scheduler triggered, daily 03:00 UTC
- HEAD check via `fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(5000) })`
- Concurrency via `p-limit` (50) + 100ms throttle between batches
- Dead detection: 4xx/5xx/timeout/network-error → mark `dead: true` + `deadCheckedAt` + `deadReason`
- Re-check dead jobs >7d old (`deadCheckedAt < now - 7d`) — gives sites time to recover
- Hard-delete jobs `dead === true && deadCheckedAt < now - 30d`
- Existing `paBackfillMatchingJobsAtsUrl` wired in: jobs with `dead === true` AND legacy `atsApplyUrl == null` re-resolved via Serper before mark-deleted
- jobType normalize script `apps/functions/scripts/normalize-matching-jobs-vocab.mjs`
- seniorityLevel backfill script `apps/functions/scripts/backfill-seniority-level.mjs`
- macmini wekruit-matching state probe via SSH — document what works, what's broken
- If feasible: trigger fresh ingestion run on macmini (or migrate to wekruit-pa CF if Stage 2.5 still broken)

**Out of scope (deferred to Phase 58+):**
- Nightly LLM rerank batch (Phase 58)
- QA evaluator (Phase 61)

</domain>

<decisions>
## Implementation Decisions

### `paLivenessSweepDaily` CF (LIVE-01, LIVE-02)
- HTTPS Cloud Scheduler trigger at 03:00 UTC daily
- Pseudocode:
  ```ts
  async function livenessSweep() {
    const active = await db.collection('matching-jobs').where('status', '==', 'active').limit(30000).get()
    const limiter = pLimit(50)
    const tasks = active.docs.map(doc => limiter(async () => {
      const job = doc.data() as MatchingJob
      if (!job.atsApplyUrl) return
      const verdict = await headCheck(job.atsApplyUrl, 5000)
      if (verdict.dead) {
        await doc.ref.update({ dead: true, deadCheckedAt: now(), deadReason: verdict.reason })
      } else if (job.dead === true) {
        // Recovered — clear dead flag
        await doc.ref.update({ dead: false, deadCheckedAt: now() })
      }
    }))
    await Promise.allSettled(tasks)
  }
  ```
- Throttle: `pLimit(50)` + `await sleep(100)` between batches of 500
- Timeout per HEAD: 5s
- Memory: 1GB, timeout 540s

### Re-check + GC (LIVE-02, LIVE-03)
- Re-check dead jobs after 7d:
  ```ts
  if (job.dead === true && Date.now() - (job.deadCheckedAt?.toMillis() ?? 0) > 7 * 24 * 3600 * 1000) {
    // Re-HEAD; may be alive again (site recovered)
  }
  ```
- Hard-delete after 30d dead:
  ```ts
  if (job.dead === true && Date.now() - (job.deadCheckedAt?.toMillis() ?? 0) > 30 * 24 * 3600 * 1000) {
    await doc.ref.delete()
  }
  ```

### Wire paBackfillMatchingJobsAtsUrl (LIVE-04)
- Existing CF `paBackfillMatchingJobsAtsUrl` (commit `a56da02`) attempts Serper resolution for missing atsApplyUrl
- New flow: BEFORE marking dead, if `atsApplyUrl == null && primaryUrl` exists, run backfill resolver inline
- New flow: AFTER marking dead via 404, run backfill ONCE more (maybe URL changed) — if resolves to a new URL + alive, update `atsApplyUrl` + clear `dead`
- Limit: 1000 backfill resolutions per sweep run (Serper API cost cap)

### jobType normalize (Phase 56 followup)
- Script `apps/functions/scripts/normalize-matching-jobs-vocab.mjs`
- Mapping:
  - `intern` → `internship`
  - `new_grad` → `new_graduate`
  - `co-op` → `co_op_rotation`
  - `return-to-work` → `return_to_work_program`
- DRY-RUN default, --apply

### seniorityLevel backfill (Phase 56 followup)
- Script `apps/functions/scripts/backfill-seniority-level.mjs`
- For docs with `seniorityLevel == null`, regex over `roleTitle`:
  - `/intern|internship|co-?op/i` → `intern`
  - `/new\s*grad|entry\s*level|junior|early\s*career/i` → `entry_level` or `junior`
  - `/senior|sr\.\s/i` → `senior`
  - `/staff|principal|lead/i` → `staff` or `principal`
  - `/manager|director|head\s*of/i` → `manager` or `director`
  - `/vp|vice\s*president/i` → `vp`
  - `/chief|cto|ceo|cfo|cmo/i` → `c_level`
  - default → `mid_level`
- DRY-RUN, --apply

### macmini probe (Adam directive — solve on the spot)
- SSH to wekruit-mini, inspect:
  - `~/Desktop/WeKruit/wekruit-matching/src/wekruit_matching/pipeline/url_resolver.py` (Stage 2.5)
  - `~/Desktop/WeKruit/wekruit-matching/src/wekruit_matching/pipeline/daily.py` (daily orchestrator)
  - `~/Desktop/WeKruit/wekruit-matching/src/wekruit_matching/scraper/run.py` (jobright scraper)
  - Check last cron run timestamp + log output (likely in `~/Desktop/WeKruit/wekruit-matching/.logs` or `journalctl`-equivalent on macOS)
  - Check Supabase pooler config (the alleged hang point)
- Document state in `~/Desktop/WeKruit/wekruit-pa/.planning/phases/57-.../macmini-state.md`
- IF Stage 2.5 actually hangs: fix or document workaround (wekruit-pa CF backfill is the v1.6 path)
- IF jobright pipeline can run: trigger a fresh ingestion (`python -m wekruit_matching.pipeline.daily` or equivalent) to repopulate matching-jobs with <20d firstSeenAt

### Tests
- Unit tests for `headCheck` (mock fetch)
- Unit tests for liveness sweep (mock Firestore + p-limit deterministic)
- Tests for jobType normalize + seniority backfill mappers
- Integration test (skipped in CI but documented): trigger sweep on small subset

</decisions>

<code_context>
## Existing Code Insights

### Phase 53 + Phase 55 deliverables
- `apps/functions/src/backfill-ats-urls.ts` (commit `a56da02`) — Serper resolver, callable CF
- `apps/functions/src/lib/matching-jobs-mappers.ts` — Phase 55 mappers, reusable

### macmini state references (CLAUDE.md mentions)
- "macmini Stage 2.5 URL Resolution still hangs (Supabase pooler) — wekruit-pa CF backfill paBackfillMatchingJobsAtsUrl deployed as backup"
- macmini path: `~/Desktop/WeKruit/wekruit-matching/src/wekruit_matching/`

### Existing patterns to mirror
- `apps/functions/src/backfill-ats-urls.ts` — batch CF with audit, p-limit, rate throttle
- `apps/functions/scripts/migrate-matching-jobs-schema.mjs` — Phase 55 batch script

</code_context>

<specifics>
## Specific Ideas

- Liveness sweep should emit metrics: `dead_marked`, `dead_recovered`, `hard_deleted`, `head_timeout_count`, `total_active`
- Dashboard /admin/jobs-health surfaces these (Phase 59 will add)
- macmini Stage 2.5 may be already migrated — wekruit-pa CF takes care of new docs ingestion; macmini may just be doing scraper-only
- If Adam wants jobright SCRAPING (not URL resolution) on macmini, that's where REPO_TO_CATEGORY runs — fresh ingestion needed for fresh jobs
- The Phase 56 issue "corpus 28d stale" suggests jobright scraping hasn't run in a while

</specifics>

<deferred>
## Deferred Ideas

- LLM rerank cache populator (Phase 58)
- Dashboard /admin/jobs-health (Phase 59)
- Cross-repo Python port (REQUIREMENTS line 106 — v2.0)

</deferred>
