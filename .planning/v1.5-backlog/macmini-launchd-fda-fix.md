# Mac mini launchd FDA fix (Adam iter 22, 2026-05-03)

## Problem

`/Users/wekruitclaw1/Library/LaunchAgents/com.wekruit.daily-update.plist` ran
the daily scrape pipeline at 06:00 via `/bin/bash <path>/scripts/daily-update.sh`.
Starting around 2026-04-05, the launchd-launched bash failed every day with:

```
/bin/bash: /Users/wekruitclaw1/Desktop/WeKruit/wekruit-matching/scripts/daily-update.sh: Operation not permitted
```

Result: scrape pipeline silently broken for **28 days**. Postgres on Mac mini
was fresh (manual runs worked), but Firestore `matching-jobs` collection
hadn't been synced since `2026-04-05`. Adam's 09:00 PT push was returning
stale consulting jobs instead of fresh data/AI roles.

## Root cause

macOS Catalina+ enforces **Full Disk Access (FDA)** as a per-app TCC
permission. `~/Desktop/` is FDA-restricted. `/bin/bash` invoked by `launchd`
inherits launchd's TCC profile — which does NOT grant FDA — so any READ of a
file under `~/Desktop/` fails with EPERM.

Manual SSH-launched runs worked because Adam's Terminal.app and the
`sshd-keygen-wrapper` chain DO have FDA. SSH children inherit that.

## Fix shipped

Three components, all in **`/Users/Shared/wekruit/`** (NOT FDA-restricted):

1. **`run-pipeline.sh`** — bash wrapper. Sources `.env-secrets`, cd's into
   the (FDA-restricted) repo, invokes `.venv/bin/python -m
   wekruit_matching.pipeline.daily`, captures stats from log, calls webhook.
   Bash file READ on `/Users/Shared` works. Bash EXECVE of any binary works
   regardless of path (kernel-level access). Python loads `.env` via
   pydantic-settings (Python file IO — separate code path from bash, has
   different TCC semantics; in practice, also works).

2. **`post-pipeline-webhook.sh`** — copy of original webhook script, moved
   here to avoid bash needing to read it from FDA-restricted path.

3. **`.env-secrets`** — mode 600, contains `PA_MATCHING_WEBHOOK_SECRET`. The
   wrapper sources this. Persists across reboots. (`launchctl setenv`
   alternative is volatile.)

**`~/Library/LaunchAgents/com.wekruit.daily-update.plist`** updated:

```xml
<key>ProgramArguments</key>
<array>
    <string>/bin/bash</string>
    <string>/Users/Shared/wekruit/run-pipeline.sh</string>
</array>
```

(Was: `/Users/wekruitclaw1/Desktop/WeKruit/wekruit-matching/scripts/daily-update.sh`.)

## Verification

```bash
# Reload + kickstart
launchctl unload ~/Library/LaunchAgents/com.wekruit.daily-update.plist
launchctl load   ~/Library/LaunchAgents/com.wekruit.daily-update.plist
launchctl kickstart -k gui/501/com.wekruit.daily-update

# Tail log
tail -f /tmp/matching-daily-update.log
```

Result: `INFO | wekruit_matching.scraper.run:scrape_all:42 - Scraping
SimplifyJobs repo: New-Grad-Positions` — pipeline runs end-to-end, no FDA
errors, webhook fires.

## Backup recovery (if launchd ever fails again)

If `/tmp/matching-daily-update.log` shows FDA error or other failure, run
manually from the wekruit-pa machine:

```bash
ssh wekruit-mini 'cd /Users/wekruitclaw1/Desktop/WeKruit/wekruit-matching && \
  nohup .venv/bin/python -c "from wekruit_matching.pipeline.job_sync import \
  sync_jobs_to_firebase; r = sync_jobs_to_firebase(full_sync=True)" \
  > /tmp/wekruit-fullsync-recovery.log 2>&1 &'
```

This pushes ALL Postgres jobs to Firestore in batches (~10 minutes for ~97k
jobs). It bypasses the daily incremental flow and forces a full sync.

## Why not just grant /bin/bash FDA?

That requires: System Settings → Privacy → Full Disk Access → "+" → add
`/bin/bash` (manual GUI click, can't be scripted via SSH without sudo+UI
automation). Even if granted, /bin/bash is a system binary; granting it FDA
is broad. Better to relocate just our scripts to a non-FDA path.

## What's NOT covered

- `daily-backup.plist` (com.wekruit.daily-backup) — UNKNOWN if this hits
  same issue. Runs at 02:00 daily. Verify with: `tail /tmp/wekruit-backup.log`
  after next 02:00. If it fails with FDA, apply same fix pattern.
- `matching-engine.plist` is currently RUNNING (PID 52037) — not affected
  because it's a long-lived daemon launched once via SSH at boot, inheriting
  Terminal's FDA grant.
