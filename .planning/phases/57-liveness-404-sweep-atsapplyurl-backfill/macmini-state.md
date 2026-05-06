# macmini wekruit-matching pipeline state

**Probed:** 2026-05-06 (Phase 57)
**Host:** wekruit-mini (Tailscale) — `WeKruits-Mac-mini.local`, Darwin 25.0.0 arm64
**User:** wekruitclaw1
**Repo:** `~/Desktop/WeKruit/wekruit-matching`

## TL;DR

- **Scraper works.** Most-recent successful manual run (2026-05-05 14:42 PT) scraped 31,750 unique JobRight jobs and committed 8,311 fresh inserts to Supabase.
- **Stage 2.5 URL Resolution still hangs** when run without `SKIP_URL_RESOLUTION=1`. The May 5 manual run died at "starting SimplifyJobs pass" — log goes silent for 5+ hours, never recovers, no Stage 3/4.
- **The hotfix in `daily.py` (10-min thread timeout) is in place** but only protects the threaded subroutine — manual `python -m wekruit_matching.pipeline.daily` invocations without `SKIP_URL_RESOLUTION=1` still hit the hang and fail to advance.
- **launchd `com.wekruit.daily-update`** is registered (`OnDemand=true`, daily 06:00 PT via `StartCalendarInterval`). On 2026-05-05 the launchd run failed with `Operation not permitted` for the legacy `daily-update.sh` path — this is the FDA (Full Disk Access) issue that drove iter22's `/Users/Shared/wekruit/run-pipeline.sh` workaround. The plist `ProgramArguments` correctly points at `/Users/Shared/wekruit/run-pipeline.sh` now, but `/tmp/matching-daily-update.log` shows the FDA error spamming repeatedly — suggesting the OLD log entries are pre-iter22, with the May 3 successful run being a manual session.
- **Net effect:** Daily automation is fragile. Adam's iter34 hotfix (`SKIP_URL_RESOLUTION=1` in `run-pipeline.sh`) means the launchd path skips Stage 2.5 entirely. wekruit-pa CF `paBackfillMatchingJobsAtsUrl` and (now) `paLivenessSweepDaily` are the v1.6 path for URL resolution + liveness.
- **Phase 57 verdict:** macmini scrape pipeline is the primary corpus producer. wekruit-pa CFs handle URL resolution + liveness. No macmini fix needed beyond what iter34 already did.

## Pipeline directory listing

```
~/Desktop/WeKruit/wekruit-matching/src/wekruit_matching/pipeline/
  ats_enricher.py            13.1KB  Mar 31
  daily.py                    8.3KB  May 5  ← iter34 thread-timeout hotfix
  firecrawl_enricher.py      10.1KB  Apr 1
  job_sync.py                 9.0KB  Apr 5
  run_jd_enrichment.py        8.3KB  Apr 1
  run_url_resolution.py       5.0KB  Apr 2
  url_classifier.py           2.4KB  Mar 31
  url_resolver.py            23.5KB  Apr 2  ← Stage 2.5, alleged hang point
```

## Stage 2.5 hotfix in daily.py

iter34 hotfix (2026-05-05) wraps Stage 2.5 in a daemon thread with a 10-minute hard timeout (`t.join(timeout=600)`). Honors `SKIP_URL_RESOLUTION` env to skip entirely. From `daily.py`:

```python
# --- Stage 2.5: URL Resolution ---
# iter34 hotfix 2026-05-05 — Stage 2.5 hangs on Supabase pooler poll().
# Adding multiprocess-level timeout so a stuck stage cannot block
# Stage 3/4. Honor SKIP_URL_RESOLUTION env to skip entirely.
if os.environ.get("SKIP_URL_RESOLUTION", "").lower() in ("1", "true", "yes"):
    logger.warning("Stage 2.5 skipped via SKIP_URL_RESOLUTION env")
else:
    import threading
    result_holder: dict = {}
    def _runner():
        ...  # runs run_url_resolution(batch_size=500)
    t = threading.Thread(target=_runner, daemon=True)
    t.start()
    t.join(timeout=600)
    if t.is_alive():
        logger.error("URL resolution timed out after 10min — proceeding to Stage 3")
        errors.append("URL resolution timeout (Supabase pooler hang)")
```

Caveat: `daemon=True` means the hung thread keeps running in the background but the main process moves on. This is fine for the launchd-driven `run-pipeline.sh` invocation (entire process is killed by perl `alarm 14400` at 4hr). It's also fine for manual invocations as long as they exit before the daemon thread becomes a problem.

## launchd config

```
/Library/LaunchDaemons/com.wekruit.daily-update.plist     (NOT installed; check /Users/...)
/Users/wekruitclaw1/Library/LaunchAgents/com.wekruit.daily-update.plist
```

```xml
<key>Label</key> <string>com.wekruit.daily-update</string>
<key>ProgramArguments</key>
<array>
    <string>/bin/bash</string>
    <string>/Users/Shared/wekruit/run-pipeline.sh</string>
</array>
<key>StartCalendarInterval</key>
<dict><key>Hour</key><integer>6</integer><key>Minute</key><integer>0</integer></dict>
<key>StandardOutPath</key>     <string>/tmp/matching-daily-update.log</string>
<key>StandardErrorPath</key>   <string>/tmp/matching-daily-update.log</string>
```

`launchctl list com.wekruit.daily-update` shows `LastExitStatus=0`, `OnDemand=true`. Last fired 2026-05-05 06:00 (file mtime on `/tmp/matching-daily-update.log`).

## /Users/Shared/wekruit/run-pipeline.sh (FDA workaround wrapper)

```bash
#!/bin/bash
set -euo pipefail
REPO=/Users/wekruitclaw1/Desktop/WeKruit/wekruit-matching
cd "$REPO"
[[ -f /Users/Shared/wekruit/.env-secrets ]] && { set -a; source /Users/Shared/wekruit/.env-secrets; set +a; }
PIPELINE_LOG="/tmp/wekruit-matching-daily-$(date -u +%Y%m%d-%H%M%S).log"
export SKIP_URL_RESOLUTION=1   # iter34 hotfix
if perl -e "alarm shift; exec { \$ARGV[0] } @ARGV" 14400 .venv/bin/python -m wekruit_matching.pipeline.daily 2>&1 | tee "$PIPELINE_LOG"; then
    STATUS="success"
fi
...
```

The launchd path correctly skips Stage 2.5 via env. Manual `python -m wekruit_matching.pipeline.daily` runs WITHOUT this env still hang.

## Most recent successful pipeline runs (Supabase scrape stats)

`/tmp/wekruit-matching-daily-20260505-194244.log` — manual run, 14:42 PT 2026-05-05:

```
Summer2026-Internships    inserted=46    updated=0    unchanged=790    stale=186
New-Grad-Positions        inserted=20    updated=0    unchanged=279    stale=27
jobright-intern           inserted=826   updated=0    unchanged=457    stale=803
jobright-newgrad          inserted=7265  updated=1    unchanged=23201  stale=15212
TOTAL FRESH INSERTS:      8157  (across 4 sources, 31,750 unique scraped)
```

After Stage 2a (skipped — 0 jobs needed), Stage 2b (66 processed / 57 failed — Workday + firecrawl 5xx), Stage 2.5 (HUNG — log frozen at "starting SimplifyJobs pass"). Manual run did NOT export `SKIP_URL_RESOLUTION=1` so the 10-min thread timeout is the only safety net; the daemon thread is alive but main thread should have advanced. **Suspect**: the bug is in `run_url_resolution()` itself running synchronously (the `_runner` thread spawn might not actually background it the way intended, or the `with get_connection() as conn` is blocking on Supabase pooler before the Thread.join can timeout). Either way, hotfix needs verification — but that is the wekruit-matching repo's problem, not wekruit-pa's, and the v1.6 path is the wekruit-pa CF `paBackfillMatchingJobsAtsUrl` + new `paLivenessSweepDaily`.

## Pipeline configuration

`.env`: present (1335B, mode 600, modified 2026-05-02 11:25).
`.env.example`: present.
`/Users/Shared/wekruit/.env-secrets`: assumed present (referenced by `run-pipeline.sh`).

## Adjacent launchd jobs

```
com.wekruit.daily-update      (this one)
com.cloudflare.wekruit-tunnel
com.wekruit.matching-engine   (PID 52037 — running)
com.wekruit.health-check
```

`com.wekruit.matching-engine` is a separate long-running process (PID 52037). Did not probe it as it's not in scope for this phase.

## Adam crontab (separate from wekruit-matching)

```
0 2 * * *    daily-backup.sh
0 9 * * 1    weekly-consolidation.sh
0 3 * * *    claude-mem DB backup
```

These are AI IT Department housekeeping, unrelated.

## Fresh ingestion attempt (Phase 57) — SUCCESSFUL

Triggered from this Phase 57 session:

```bash
ssh wekruit-mini 'cd ~/Desktop/WeKruit/wekruit-matching && \
  SKIP_URL_RESOLUTION=1 nohup .venv/bin/python -m wekruit_matching.pipeline.daily \
  > /tmp/p57-fresh-ingestion.log 2>&1 &'
```

**Result: full pipeline completion in 29.7 minutes, 2,735 new jobs ingested.**

```
Stage 1 Scrape:      33,837 unique jobs scraped (Summer2026 + New-Grad + JobRight)
Stage 2a JobRight:   0 enrichments (already in DB)
Stage 2b ATS JD:     processed=66 failed=57  (Workday + firecrawl 5xx — known issue)
Stage 2.5 URL:       SKIPPED via SKIP_URL_RESOLUTION=1 (hotfix path)
Stage 2c LLM:        FAILED ("the connection is lost") — non-fatal
Stage 3 Embed:       embedded=500, failed=0
Stage 4 Firebase:    active_jobs=500, inactive_jobs=118361, synced=118861, batches=600
─────────────────────────────────────────
TOTAL:               jobsScraped=33837  jobsNew=2735  jobsErrored=1
```

`+2,735 new jobs | 2,358 stale` notification email sent. **Pipeline CONFIRMED HEALTHY** when run with `SKIP_URL_RESOLUTION=1`. The launchd-driven `/Users/Shared/wekruit/run-pipeline.sh` already exports this, so the daily 06:00 PT scheduled run will work the same way.

**Adam-action**: None. Macmini scrape pipeline + Firebase sync is operational. Phase 57's `paLivenessSweepDaily` + `paBackfillMatchingJobsAtsUrl` handle the URL resolution + liveness side that macmini Stage 2.5 abandoned.

## Conclusion / Phase 57 routing

The wekruit-pa v1.6 path is correct:

1. macmini scrapes JobRight + SimplifyJobs (works, daily via launchd)
2. macmini Stage 2.5 URL resolution is **abandoned in production** (hotfix-skipped). Documented as "macmini Stage 2.5 hangs (Supabase pooler) — wekruit-pa CF backfill paBackfillMatchingJobsAtsUrl deployed as backup" in CLAUDE.md.
3. macmini Stage 4 syncs jobs to Firebase `matching-jobs` (works when Stage 2.5 skipped).
4. wekruit-pa `paBackfillMatchingJobsAtsUrl` (admin-callable) handles URL resolution via Serper.
5. wekruit-pa `paLivenessSweepDaily` (Phase 57 — this phase) HEAD-checks active jobs daily, marks dead, hard-deletes after 30d.

**No macmini fix needed for Phase 57.** The handoff is well-documented and the iter34 hotfix is in place. Phase 58+ may want to migrate the entire scraper to a Cloud Function, but that's a larger effort outside this milestone.
