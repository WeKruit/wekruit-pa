# Runbook — Scrape pipeline DEAD

**Triggered by:** Slack alert `🚨 Scrape pipeline DEAD` or `⚠️ Scrape pipeline stale (warn)` from `paScrapeFreshnessMonitorDaily` (12:00 UTC).

**Symptom**

- Newest `matching-jobs.syncedAt` is ≥ 24h (warn) or ≥ 48h (error) old.
- Match quality silently degrades: V16 recency boost no longer fires, active pool ages out (`firstSeenAt > 20d`), pre-screen flow keeps serving the same shrinking set of jobs.
- Audit trail: `matching-jobs-monitor-runs` collection in Firestore.

**First responder loop (5 minutes)**

1. **Reach the macmini**
   ```bash
   ssh -o ConnectTimeout=5 adam@100.83.121.89 'uptime'
   ```
   - **Timeout / "Operation timed out"** → macmini is offline at network or power layer. Adam must physically check the device (power LED, console, Wi-Fi). Tailscale daemon cannot self-restart from a powered-off machine.
   - **`SSH ALIVE`** → macmini is reachable; continue.

2. **Check Tailscale + scrape launchd**
   On macmini (once SSH works):
   ```bash
   tailscale status | head
   launchctl list | grep -iE 'wekruit|scrape|matching|pipeline'
   tail -n 50 /Users/Shared/wekruit/logs/pipeline-latest.log
   ```
   - Tailscale offline → `sudo tailscale up`
   - launchd job not running → `launchctl kickstart -k gui/$(id -u)/<plist label>`
   - Log shows API/quota error → check upstream (jobright, ATS provider).

3. **Force a manual scrape (idempotent)**
   ```bash
   cd /Users/Shared/wekruit && ./run-pipeline.sh
   ```
   Pipeline writes to `matching-jobs` with `syncedAt = serverTimestamp()`. Confirm via:
   ```bash
   node scripts/scrape-health.mjs   # from adam@laptop wekruit-pa repo
   ```

4. **Confirm closure**
   Re-run the monitor CF manually (skip the schedule):
   ```bash
   firebase functions:shell --project wekruit-5f89b
   > paScrapeFreshnessMonitorDaily()
   ```
   New audit doc in `matching-jobs-monitor-runs` should report `severity: "ok"`.

**Common root causes (recorded)**

| Cause | First seen | Detection |
|---|---|---|
| macmini powered off (Mac OS update reboot, surge protector trip) | 2026-05-22 | Tailscale + ICMP both timeout |
| Tailscale daemon crash without supervisor restart | (TBD) | Tailscale offline; SSH via local LAN works |
| launchd job throttled (failed too often) | (TBD) | `launchctl list` shows `LastExitStatus != 0` |
| jobright upstream 429/quota | (TBD) | pipeline log has rate-limit message |
| firebase_sync_batch_size too high | 2026-05-?? | Firestore batch write errors in log |

**Escalation**

- 4h post-alert with no human action: monitor CF will re-fire next 12:00 UTC; consider also paging via PagerDuty (not yet wired).
- 24h DEAD: rebuild active pool from PG full sync (see `.planning/INITIATIVE-scrape-resilience.md` once it exists).

**Related**

- `apps/functions/src/scrape-freshness-monitor.ts` — monitor source + thresholds.
- `apps/functions/src/liveness-sweep.ts` — daily 03:00 UTC liveness HEAD-check (different concern: per-URL aliveness, not pipeline freshness).
- `scripts/scrape-health.mjs` — manual audit script.
