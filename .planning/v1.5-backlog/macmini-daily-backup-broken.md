# Mac mini daily-backup silent failure — 25+ days (Adam iter 25, 2026-05-03)

## Severity: P1 (silent data-loss for chatwoot)

NOT WeKruit Postgres — this is the SEPARATE chatwoot CRM/inbound data backup.
Job-rec pipeline (matching-jobs Firestore sync) is unaffected; that uses
`com.wekruit.daily-update.plist` fixed in iter22.

## Symptom

`/Users/wekruitclaw1/Library/LaunchAgents/com.wekruit.daily-backup.plist` runs
at 03:00 daily via:

```bash
docker exec chatwoot_postgres pg_dump -U chatwoot chatwoot_production \
  > "$BACKUP_DIR/backup_$TIMESTAMP.sql"
```

Log writes daily "Backup completed: backup_20260503_030003.sql" to
`/tmp/wekruit-backup.log` — looks healthy.

Reality:

```
$ ls -lt /Users/wekruitclaw1/chatwoot-backups/ | head
-rw-r--r-- 1 wekruitclaw1 staff 0 May  3 03:00 backup_20260503_030003.sql
-rw-r--r-- 1 wekruitclaw1 staff 0 May  2 03:00 backup_20260502_030001.sql
-rw-r--r-- 1 wekruitclaw1 staff 0 May  1 03:00 backup_20260501_030003.sql
[... 25+ more 0-byte files ...]
```

**ALL backups are 0 bytes.** No actual data dumped.

## Root cause

```
$ ssh wekruit-mini 'which docker'
zsh:1: command not found: docker
```

Docker is not installed (anymore?) on the Mac mini. The `docker exec` line in
`backup.sh` redirects stderr to `/tmp/wekruit-backup.log` but stdout to the
sql file — so empty stdout becomes a 0-byte sql, then unconditional final
`echo "Backup completed: ..."` masks the failure.

## Cracks in the script

1. No exit-code check after `docker exec`
2. Unconditional success echo at end — looks healthy in logs
3. No size validation of the produced sql (would catch 0-byte case)
4. Old retention cleanup (`tail -n +8 | xargs rm -f`) silently deletes any
   0-byte ones too — so even if docker came back, you'd lose the older real
   backups via the broken-during-failure window

## Out of scope for orchestrator

This is NOT a wekruit-pa orchestrator code path. It's Mac mini admin
infrastructure for the chatwoot CRM (separate service Adam runs). Two
remediation options, both Adam-decision:

**Option A — restore docker + chatwoot stack**
1. Install Docker Desktop on Mac mini
2. `docker compose up -d` from `/Users/wekruitclaw1/clawbot/docker-compose.yml`
3. Verify `chatwoot_postgres` container running
4. Manually trigger backup.sh and confirm sql is non-zero

**Option B — retire chatwoot backup if no longer needed**
1. `launchctl unload ~/Library/LaunchAgents/com.wekruit.daily-backup.plist`
2. `rm ~/Library/LaunchAgents/com.wekruit.daily-backup.plist`
3. `rm -rf /Users/wekruitclaw1/chatwoot-backups/` (all 0-byte files)

## Hardening for future (regardless of A/B)

If chatwoot stays, the script should fail loudly:

```bash
#!/bin/bash
set -euo pipefail
BACKUP_DIR="/Users/wekruitclaw1/chatwoot-backups"
mkdir -p "$BACKUP_DIR"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
SQL_FILE="$BACKUP_DIR/backup_$TIMESTAMP.sql"

if ! docker exec chatwoot_postgres pg_dump -U chatwoot chatwoot_production > "$SQL_FILE"; then
  echo "ERROR: pg_dump failed at $TIMESTAMP" >&2
  rm -f "$SQL_FILE"
  exit 1
fi

SIZE=$(stat -f %z "$SQL_FILE" 2>/dev/null || echo 0)
if [ "$SIZE" -lt 1024 ]; then
  echo "ERROR: backup is suspiciously small ($SIZE bytes) at $TIMESTAMP" >&2
  exit 2
fi

ls -t "$BACKUP_DIR"/backup_*.sql | tail -n +8 | xargs rm -f 2>/dev/null
echo "Backup completed: backup_$TIMESTAMP.sql ($SIZE bytes)"
```

Plus adding StandardErrorPath != StandardOutPath in the plist so stderr is
visible separately from the success echo on stdout.

## Detection

Manual today via `find /Users/wekruitclaw1/chatwoot-backups -name "backup_*.sql"
| xargs ls -la | head`. To prevent recurrence, add to a weekly health check
(could be a separate launchd job, or a heartbeat ping the Cloud Functions
side checks). Out of scope for iter25.
