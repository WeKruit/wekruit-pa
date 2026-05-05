# Macmini Daily Pipeline Stage 2.5 Hang — RCA + Patches

**Date**: 2026-05-05
**Adam directive**: "为什么匹配出问题了他妈的这个才是重点啊?"

## Symptom

Daily pipeline (`com.wekruit.daily-update` launchd job, 6am CDT) last
successful run **2026-05-03 05:04**. Subsequent retries (May 3-5) all
hung in `Stage 2.5: URL Resolution` immediately after the log line:

```
url_resolution: starting SimplifyJobs pass (batch_size=500)
```

`launchctl print` showed `last exit code = (never exited)` — process
just sat there forever. Tested manually from user shell (FDA-aware) —
same hang.

## RCA

`sample` on the stuck Python PID showed:
```
psycopg.wait_c → poll  (in libsystem_kernel.dylib)
```

Process blocked on `poll()` system call waiting for PG socket data.
**Supabase PgBouncer (aws-1-us-east-1.pooler.supabase.com:5432)
silently drops idle connections, but the client-side psycopg
ConnectionPool re-uses them without health-check** → hand out a dead
socket → first query waits for response forever.

Verified by opening a fresh psycopg connection bypassing the pool —
connect 0.4s, query 0.08s. Pool's stale connection was the cause.

Sub-secondary: `com.wekruit.daily-update` cron entry ALSO scheduled
6am running `~/Desktop/.../scripts/daily-update.sh` (FDA-blocked
because launchd-spawned bash can't read `~/Desktop`). Polluted log
with `Operation not permitted` spam. Removed.

## Patches applied (live on macmini, NOT in wekruit-pa git)

### Patch 1 — connection pool health-check + keepalives

File: `~/Desktop/WeKruit/wekruit-matching/src/wekruit_matching/db/connection.py`

```diff
     pool = ConnectionPool(
         conninfo=conninfo,
         min_size=2,
         max_size=20,
         timeout=5.0,
-        max_idle=300.0,
+        # iter34 hotfix 2026-05-05 — Supabase pgBouncer drops idle conns silently.
+        # max_idle=300s let stale conns persist; pipeline hung in poll() forever.
+        # Lower to 60s + check_connection validates with SELECT 1 before hand-out
+        # + tcp keepalives so the client OS detects dead sockets quickly.
+        max_idle=60.0,
         max_lifetime=1800.0,
-        kwargs={"row_factory": dict_row},
+        check=ConnectionPool.check_connection,
+        kwargs={
+            "row_factory": dict_row,
+            "connect_timeout": 10,
+            "keepalives": 1,
+            "keepalives_idle": 30,
+            "keepalives_interval": 10,
+            "keepalives_count": 3,
+            "options": "-c statement_timeout=120000",
+        },
     )
```

Even with this patch the symptom recurred (Supabase pooler may be
dropping mid-request, not just idle). So we add Patch 2.

### Patch 2 — Stage 2.5 thread timeout + skip env

File: `~/Desktop/WeKruit/wekruit-matching/src/wekruit_matching/pipeline/daily.py`

Wraps Stage 2.5 in `threading.Thread(target=...).join(timeout=600)`.
After 10 min, log warning and proceed to Stage 3 (Embed) + Stage 4
(Firestore sync). New env flag `SKIP_URL_RESOLUTION=1` skips the
stage entirely.

### Patch 3 — run-pipeline.sh exports skip env

File: `/Users/Shared/wekruit/run-pipeline.sh`

```diff
+# iter34 hotfix 2026-05-05 — skip Stage 2.5 (Supabase pooler hang on URL resolve)
+export SKIP_URL_RESOLUTION=1
+
 if perl -e "alarm shift; exec { $ARGV[0] } @ARGV" 14400 .venv/bin/python -m wekruit_matching.pipeline.daily 2>&1 | tee "$PIPELINE_LOG"; then
```

Daily launchd run now skips Stage 2.5 → reaches Stage 3 (Embed) +
Stage 4 (Firestore sync) reliably. Daily fresh job batch flows to
`pa-jobs` Firestore so Cloud Function `queryMatchingJobs` has new
data to rerank.

### Patch 4 — Cron dup removed

`crontab -e` removed the duplicate 6am entry that ran the FDA-blocked
`~/Desktop/.../scripts/daily-update.sh`. Only launchd `com.wekruit.daily-update`
runs the pipeline now (via `/Users/Shared/wekruit/run-pipeline.sh`,
FDA-safe).

## Side note: real root cause of "matching broken" was elsewhere

While diagnosing this, found the actual reason Adam saw "tomorrow ~9am"
fallback messages: `apps/functions/src/orchestrator-deps.ts`
`generateJobRecs` queried `parsedCandidateResumes` with
`orderBy("parsedAt", "desc")` but `cv-ingest.ts` writes `createdAt`
(not `parsedAt`). Firestore orderBy excludes docs missing the field
→ cvSnap.empty=true → "No CV signal" fallback even when 5 valid CV
records existed. Fixed in commit `1d7f3b7` of wekruit-pa.

So macmini Stage 2.5 hang was REAL but secondary — even with stale
job data, `pa-jobs` Firestore had 39204 jobs from May 3 unchanged
that should've matched. The orderBy bug stopped Cloud Function from
ever reading Adam's CV.

## Follow-up tasks

1. **Adam: commit Patches 1-3 to wekruit-matching repo** so they
   survive macmini reinstall.
2. **Investigate why Supabase pooler drops connections** — maybe
   pgBouncer max_client_conn limit, or network NAT timeout. May need
   to switch from pooler to direct connection (port 6543 instead of
   5432) for long-running pipelines.
3. **Stage 2.5 URL resolution** can be re-enabled later once pool
   connection robust. For now the matching engine doesn't strictly
   need ats_apply_url resolved — primary_url works as fallback.
