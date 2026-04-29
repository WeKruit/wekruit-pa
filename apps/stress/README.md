# `@pa/stress` — Artillery stress harness

Concurrency / latency stress harness for the staging pa-* Cloud Functions.
Phase 32 Wave 4 deliverable.

## Constraints

- **STAGING ONLY.** Every scenario reads its target URL from an env var
  whose name is prefixed `STAGING_`. There is no prod target hard-coded.
  Do not point this at prod even for "a quick check" — it will burn the
  Sendblue Free tier daily quota and trip live rate-limit alarms.
- **Allowlisted test number only.** Provision a dedicated Sendblue line
  for `STAGING_TEST_PHONE_NUMBER`. Do not use a teammate's phone.

## Install

```bash
cd apps/stress
pnpm install
```

If running from repo root: `pnpm --filter @pa/stress install` (npm workspaces
also work — `npm install -w @pa/stress`).

## Scenarios

| Scenario                | Load                       | Targets                                | Goal                                                    |
| ----------------------- | -------------------------- | -------------------------------------- | ------------------------------------------------------- |
| `inbound-burst.yml`     | 10 VU x 100 msg x 10 min   | `paSendblueInbound`                    | Rate-limit + Firestore tx serialization under burst     |
| `upstream-webhook.yml`  | 5 VU x 50 events x 5 min   | `paUpstreamEventWebhook` (P9-Connectors) | HMAC verify + dedupe + non-blocking enqueue            |
| `downstream-fire.yml`   | 1 turn/sec for 5 min       | admin `evalDownstreamTriggers`         | Confirm post-turn hook stays async (no orch coupling)   |

## Run

```bash
# Inbound burst (the headline scenario)
pnpm test:inbound

# Upstream webhook flood
pnpm test:upstream

# Downstream-fire (per-turn webhook, sustained)
pnpm test:downstream

# Generate HTML report from a saved JSON output
pnpm report -- --output report.html artillery-output.json
```

## Env vars (see `.env.example`)

| Var                                | Purpose                                                |
| ---------------------------------- | ------------------------------------------------------ |
| `STAGING_SENDBLUE_WEBHOOK_URL`     | inbound CF URL                                         |
| `STAGING_SENDBLUE_HMAC_SECRET`     | mirrors `SENDBLUE_API_SECRET_KEY` on staging           |
| `STAGING_UPSTREAM_WEBHOOK_URL`     | pa-upstream CF URL                                     |
| `STAGING_UPSTREAM_HMAC_SECRET`     | shared secret for `X-Wekruit-Signature`                |
| `STAGING_DOWNSTREAM_TRIGGER_URL`   | admin endpoint that fires `evalDownstreamTriggers`     |
| `STAGING_TEST_PHONE_NUMBER`        | E.164, allowlisted dedicated test line                 |
| `ADMIN_TOKEN`                      | bearer for admin endpoints — rotate after each run     |

## Expected baseline (after Phase 32 ship)

```
inbound-burst:
  http.response_time.p50  < 400ms
  http.response_time.p95  < 1200ms
  http.response_time.p99  < 3000ms
  status_2xx              ~ 800/1000
  status_429              ~ 200/1000  (expected — 21st msg/min/user blocked)
  status_5xx              < 1%

upstream-webhook:
  http.response_time.p95  < 800ms
  status_2xx              == 250/250

downstream-fire:
  http.response_time.p95  < 800ms  (if higher → orchestrator coupling bug)
```

## Interpreting results

- **High 429 share on inbound-burst is expected** — the harness intentionally
  exceeds the 20-msg/min/user limit. The diagnostic is *whether* the limit
  triggers cleanly (no bleed-through, no 5xx, no Firestore tx timeouts).
- **Any 5xx is a bug.** Capture the request id from the Artillery output
  and pull the matching CF log via `firebase functions:log`.
- **p95 above the threshold** is the most useful signal: it surfaces
  Firestore tx serialization or downstream coupling without the noise of
  the long tail.

## Layout

```
apps/stress/
  package.json
  README.md
  .env.example
  scenarios/
    inbound-burst.yml
    upstream-webhook.yml
    downstream-fire.yml
    lib/
      hmac.js        # shared HMAC-SHA256 signers (Sendblue + Upstream)
```

## Workspace registration

`apps/stress` is covered by the existing `apps/*` workspace glob in the
root `package.json` (npm workspaces). If `pnpm-workspace.yaml` is added
later, ensure `apps/*` glob remains.

## Safety checklist before each run

1. Target env vars all start with `STAGING_`.
2. `STAGING_TEST_PHONE_NUMBER` is the dedicated test line, not a real user.
3. Sendblue daily quota on staging has headroom (`sendblueDailyQuota` flag).
4. You have ack from Adam if the run will exceed 1000 messages — that is
   half the daily Free-tier quota.
