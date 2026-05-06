# Macmini launchd snapshot — Phase 67 (2026-05-06)

Forensics snapshot of the wekruit-mini Macmini launchd configuration after Phase 67 reliability + health-check fixes (LAUNCHD-01..03).

## Services

```
launchctl list | grep wekruit
-       0       com.wekruit.daily-update      # calendar 06:00 CDT (StartCalendarInterval)
1648    0       com.cloudflare.wekruit-tunnel # cloudflare zero-trust tunnel
52037   0       com.wekruit.matching-engine   # FastAPI uvicorn (KeepAlive)
-       0       com.wekruit.health-check      # calendar 09:00 CDT (StartCalendarInterval)
```

`-` PID = idle (calendar-scheduled service waiting for next fire). Not a fault.

## com.wekruit.daily-update

- Plist: `~/Library/LaunchAgents/com.wekruit.daily-update.plist`
- Calendar: 06:00 daily (CDT, system tz)
- Program: `/bin/bash /Users/Shared/wekruit/run-pipeline.sh`
- stdout/stderr → `/tmp/matching-daily-update.log` (single file, append-overwrite each run)
- runs=0, last exit=(never since last bootstrap) at snapshot time

run-pipeline.sh wraps `wekruit_matching.pipeline.daily` python module with a 4-hour `perl alarm`, then calls post-pipeline-webhook.sh with stats parsed from log via `grep -oE`.

## com.wekruit.health-check

- Plist: `~/Library/LaunchAgents/com.wekruit.health-check.plist`
- Calendar: 09:00 daily (CDT)
- Program: `/bin/bash /Users/Shared/wekruit/health-check.sh`
- stdout/stderr → `/tmp/health-check.log`
- Logic (post-Phase-67): scan latest `/tmp/wekruit-matching-daily-*.log` for completion marker (case-insensitive `grep -i`), fall back to `/tmp/matching-daily-update.log` (launchd stdout). Healthy if marker found AND log mtime < 26h.
- Auto-heal (UNHEALTHY branch): touch lockfile (2h re-fire suppression), POST alert to `paUpstreamEventWebhook`, `pkill` stale pipeline procs, `launchctl bootout/bootstrap` daily-update, `nohup` manual run.

## Phase 67 fixes applied

1. **health-check.sh case-insensitive grep** — old pattern `Pipeline complete` (uppercase P) failed to match log line `Daily pipeline complete` (lowercase p), causing daily false-UNHEALTHY at 09:00 and unnecessary auto-heal kicks.
2. **health-check.sh fallback to launchd stdout log** — if pipeline-day log lacks marker (truncation, mid-run state), check `/tmp/matching-daily-update.log` next.
3. **health-check.sh idempotency lock** — `/tmp/wekruit-health-check.lock` (2h window) prevents double auto-heal if cron fires multiple times during a long pipeline.
4. **health-check.sh alert POST to paUpstreamEventWebhook** — observable from PA orchestrator side.
5. **post-pipeline-webhook.sh — replaced `python3 -c` with `jq`** — `/usr/bin/python3` import resolution scanned `/Users/wekruitclaw1/Library/Python/3.9/lib/python/site-packages` which is FDA-restricted under launchd-spawned bash. `jq` (system `/usr/bin/jq`) is FDA-safe, no user-home lookups. Fixes the daily PermissionError trace at end of pipeline log.

## Backups (on macmini)

- `/Users/Shared/wekruit/health-check.sh.p67bak` — pre-fix script
- `/Users/Shared/wekruit/post-pipeline-webhook.sh.p67bak` — pre-fix script
- `/Users/Shared/wekruit/run-pipeline.sh.p66bak` — pre-Phase-66 script (existing)

## Verification (2026-05-06)

```
$ ssh wekruit-mini 'bash /Users/Shared/wekruit/health-check.sh'
[Wed May  6 14:00:04 CDT 2026] log /tmp/wekruit-matching-daily-20260506-185242.log exists but no completion marker found
[Wed May  6 14:00:04 CDT 2026] healthy via /tmp/matching-daily-update.log (age=10204s)
[Wed May  6 14:00:04 CDT 2026] healthy — pipeline ran successfully within 26h
```

Stale-state simulation (manually backdated logs to 2026-04-01) correctly produced `UNHEALTHY` branch.

post-pipeline-webhook.sh test with empty secret: graceful skip (`PA_MATCHING_WEBHOOK_SECRET unset — skipping`). With fake secret: `jq` body composition succeeds, no PermissionError.

## Files in this directory

- `com.wekruit.daily-update.plist` — verbatim copy of launchd plist
- `com.wekruit.health-check.plist` — verbatim copy of launchd plist
- `health-check.sh` — verbatim copy of FDA-safe script
- `post-pipeline-webhook.sh` — verbatim copy of FDA-safe webhook script
- `run-pipeline.sh` — verbatim copy of pipeline wrapper
