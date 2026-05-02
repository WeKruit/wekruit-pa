# Scrape Pipeline E2E Verification — Health Report

**Date**: 2026-05-02 (Sat ~17:10 CDT)
**Scope**: wekruit-matching pipeline → Postgres → Firestore matching-jobs
**Verdict**: **DEGRADED — Stage-4 Firestore sync silently broken since 2026-04-05.** Underlying scrape/Postgres pipeline is alive but cron has been failing-then-recovering inconsistently for 3+ weeks.

底层逻辑: pipeline runs end in 4 stages; everything passes except the last hop, so cloud consumers (job-rec) read stale corpus. 抓手: pipeline already works manually; gap is in cron reliability + sync visibility. 闭环: fix scheduler, alert on stage-4 failure.

---

## 1. Findings

### 1.1 Mac mini (host: wekruit-mini)
- **Postgres** (AWS-hosted at `ec2-18-214-78-123:5432` — *not* localhost): healthy, reachable via `.venv` from the matching repo.
  - 66,289 active jobs across 4 source repos (jobright-newgrad 38k, Summer2026 988, jobright-intern 1.2k, New-Grad 305).
  - `max(last_seen_at)` = **2026-05-02 22:01 UTC** (fresh, from in-progress run).
- **.venv health**: Python 3.12.13 via uv, imports work.
- **launchd plist** `com.wekruit.daily-update` exists at `~/Library/LaunchAgents/` but is **broken**: `LastExitStatus=32256` (=126 "permission denied"). macOS TCC blocks launchd from executing scripts under `~/Desktop/` without Full Disk Access. `/tmp/matching-daily-update.log` contains 54 consecutive `Operation not permitted` errors from launchd retries — none of these runs ever executed the pipeline.
- **The actual scheduler is `crontab`** (not launchd):
  ```
  0 6 * * * /bin/bash /Users/wekruitclaw1/Desktop/WeKruit/wekruit-matching/scripts/daily-update.sh >> /tmp/matching-daily-update.log 2>&1
  ```
  Crontab runs as user `wekruitclaw1` and was granted Full Disk Access manually. **This is the only working cron.** Both write to the same log, which is why the launchd errors masked any cron-side failures.

### 1.2 Pipeline run history (Postgres `embedded_at` ≈ "did stage 3 finish")
| Date | Jobs embedded |
|---|---|
| 2026-05-02 | (in progress, manual) |
| 2026-04-09 | 500 |
| 2026-04-05 | 1000 |
| 2026-04-04 | 500 |
| 2026-04-03 | 500 |
| 2026-04-02 | 1000 |
| 2026-04-01 | 31000 (full embed run) |

**Pipeline has not completed an end-to-end run since 2026-04-09** — 23 days. Today's run (PID 38431) was started manually at 16:59 CDT and is currently in stage 2 (enrichment, blocked on Postgres I/O — confirmed via `sample`, healthy state).

### 1.3 Firestore (project `wekruit-5f89b`)
- `matching-jobs`: **40,374 docs total** (matches AUDIT.md baseline from a month ago).
- New docs in last 7d: **0**. New in last 24h: **0**.
- Latest `firstSeenAt` value: **2026-04-01T05:04:40Z**.
- Latest `syncedAt` value: **2026-04-05T21:19:18Z**.
- Schema note: `firstSeenAt`/`lastSeenAt`/`syncedAt` stored as **stringValue** (ISO 8601), not `timestampValue`. Any timestamp-typed query returns 0 — index gap. Code that queries by timestamp will silently miss everything.
- `pa-matching-pipeline-runs`: only **2 docs**, both manual smoke tests (`smoke-1777739212`, `smoke-v2-1777758147`). Production cron has never written to this collection.
- `pa-events` for `matching:pipeline:completed`: query requires composite index (`type` + `createdAt`) that is not deployed → **FAILED_PRECONDITION**. Cannot determine whether webhook events have been arriving without creating the index.

### 1.4 Cloud function chain
- `matching-api` (gen2, us-central1): **healthy**. `GET /api/health` → 200 `{"status":"ok"}`. `POST /api/sync/jobs` without API key → 401 (correct). Endpoint accepts the Mac mini's writes when called.
- `paMatchingPipelineComplete`: deployed. Smoke test from Mac mini at 16:42 CDT today returned `{"ok":true,"runId":"smoke-v2-1777758147"}` — the webhook plumbing works.

### 1.5 Why Firestore went stale on April 5
The pipeline runs in 4 stages; only the last writes to Firestore. **It hasn't reached stage 4 since April 9.** Possible causes:
1. Cron job fails partway through (likely — embedded_at gaps are random).
2. Pipeline takes >hours and gets killed by macOS.
3. Stage 2 (Anthropic Haiku enrichment) or stage 3 (OpenAI embed) hits a rate-limit / billing issue and bails before reaching sync.

Email notifications are configured (`PIPELINE_NOTIFY_EMAIL=SET`) — Adam should have been getting failure emails. Either they're going to spam or the failure path doesn't always send the end-of-run email.

---

## 2. Will tomorrow at 6am CDT be clean?

**No, not without intervention.** Cron will fire tomorrow but:
- Pipeline has been silently failing for 23 days. Same failure mode is likely to repeat.
- Even if today's manually-triggered run finishes successfully and pushes 30k+ docs to Firestore, there is no monitoring to catch the next failure.
- The launchd plist is broken AND duplicates the cron. If it ever becomes the active scheduler (e.g. macOS reboot picks it up first), the pipeline runs zero times.

---

## 3. Risks identified
| # | Risk | Severity |
|---|---|---|
| R1 | Stage-4 sync hasn't run for 23 days; Firestore corpus is stale by 30k+ jobs | **P0** |
| R2 | No monitoring on stage-4 success — silent failure | **P0** |
| R3 | Duplicate cron sources (launchd broken + crontab working) — failure mode confusion | P1 |
| R4 | Firestore timestamp fields are strings — any timestamp-typed range query returns 0 | P1 |
| R5 | `pa-matching-pipeline-runs` collection unused — Stream-A2 telemetry not actually wired up | P1 |
| R6 | `pa-events` composite index missing for `type`+`createdAt` | P2 |
| R7 | `/tmp` purge erases per-run pipeline logs — no historical debugging | P2 |
| R8 | Postgres is on AWS EC2 (not Mac mini) — adds another SPOF outside the migration plan | P2 (info) |

---

## 4. Actions I took (read-only audit + safe fixes only)

- **None on Mac mini** — script files are protected by macOS TCC; I cannot fix the launchd plist over SSH without granting `ssh` itself Full Disk Access (refused per safety rules; that's a manual Adam-side fix).
- **No production code changes** in wekruit-matching.
- Cleaned up two helper scripts from `/tmp` on the mini (`pg_check.py`, `pg_history.py`, `sample-pipeline.txt`).

---

## 5. Recommendations (Adam decisions)

1. **Wait for today's manual run to complete (~30-60 min).** Confirm: (a) Postgres `embedded_at` for today populates, (b) Firestore `matching-jobs` count rises above 40,374. That validates the pipeline e2e.
2. **Either fix or remove the launchd plist** (`launchctl unload ~/Library/LaunchAgents/com.wekruit-daily-update.plist`) so only crontab runs at 6am. The duplicate source is masking failure signal.
3. **Wire Phase-47 Option-C migration**: this verification confirms the Mac mini is the SPOF the AUDIT identified. Cloud Run Job + Firestore-only path is justified by the 23-day silent failure. Don't band-aid; ship Phase 48.
4. **Short-term band-aid before Phase 48 lands**: add a Cloud Scheduler health check that queries `matching-jobs` count once a day and alerts if it didn't increase by ≥100 docs. ~30 min of work, would have caught this on April 6.
5. **Build the missing composite index** on `pa-events` (`type` + `createdAt`) so future audits can verify the webhook chain.
6. **Audit the timestamp-vs-string field schema** on `matching-jobs` — pa-side consumers may have silent bugs from the same query mismatch.

---

## 6. Smoke verification commands (for re-run)

```bash
# Postgres freshness:
ssh wekruit-mini 'cd /Users/wekruitclaw1/Desktop/WeKruit/wekruit-matching && \
  .venv/bin/python -c "
import sys; sys.path.insert(0, \"src\")
from wekruit_matching.db.connection import get_pool
with get_pool().connection() as c:
    print(c.execute(\"select max(last_seen_at) from jobs\").fetchone())
"'

# Firestore matching-jobs count:
TOKEN=$(gcloud auth print-access-token)
curl -s -X POST "https://firestore.googleapis.com/v1/projects/wekruit-5f89b/databases/(default)/documents:runAggregationQuery" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"structuredAggregationQuery":{"structuredQuery":{"from":[{"collectionId":"matching-jobs"}]},"aggregations":[{"alias":"total","count":{}}]}}'

# Cloud function health:
curl -s https://us-central1-wekruit-5f89b.cloudfunctions.net/matching-api/api/health
```

---

## 7. Appendix — process state at audit time
- Pipeline PID 38431, started 2026-05-02 16:59 CDT, ~20 CPU sec, blocked on Postgres I/O (psycopg `wait_c → poll`). Healthy.
- FastAPI uvicorn PID 52037, running since Apr 4, 4 workers on 127.0.0.1:8001. Unused by wekruit-pa per AUDIT.md §1.4.
