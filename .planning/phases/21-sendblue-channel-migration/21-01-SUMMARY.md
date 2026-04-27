---
phase: 21-sendblue-channel-migration
plan: 01
subsystem: channel-transport
tags: [sendblue, imessage, channel, webhook, firestore, cf-gen2, hmac]
status: paused-at-deploy-checkpoint
requires:
  - "@pa/pa-broker createInboundEvent (idempotent on idempotencyKey)"
  - "@pa/pa-persistence appendMessage / getOrCreateSession / getUser"
  - "@pa/core-types PA_COLLECTIONS (pa_outbound, pa_inbound_events, pa_audit_events)"
  - "Firebase Functions Gen 2 onRequest + onDocumentCreated + defineSecret"
provides:
  - "paSendblueWebhook CF endpoint (HMAC-verified inbound)"
  - "paSendblueOutbox CF processor (REST POST → Sendblue api/send-message)"
  - "PA_CHANNEL_LEGACY=1 rollback path on macOS worker"
affects:
  - "apps/macos-imessage-worker (now dormant by default; legacy flag opt-in)"
  - "packages/pa-orchestrator/src/chunker.ts (deprecation banner; v1.2 removal)"
  - "Idempotency key namespace: legacy imessage-in-${rowId} → sendblue-${message_handle}"
tech-stack:
  added:
    - "tsx as devDep in apps/functions (test runner: node --import tsx --test)"
    - "@pa/pa-broker + @pa/pa-persistence as deps in apps/functions"
  patterns:
    - "Pure-function handlers + injected deps (testable without firebase-functions-test)"
    - "Shape-based event discrimination (no single event_type field on Sendblue payloads)"
    - "Lazy-import expensive modules inside CF handler to scope cold-start cost"
key-files:
  created:
    - "apps/functions/src/sendblue/types.ts"
    - "apps/functions/src/sendblue/hmac.ts"
    - "apps/functions/src/sendblue/allowlist.ts"
    - "apps/functions/src/sendblue/normalize.ts"
    - "apps/functions/src/sendblue/sendblue-client.ts"
    - "apps/functions/src/sendblue/typing-indicator.ts"
    - "apps/functions/src/sendblue/audit.ts"
    - "apps/functions/src/sendblue/webhook.ts"
    - "apps/functions/src/sendblue/outbox.ts"
    - "apps/functions/src/sendblue/__tests__/hmac.test.ts (8 cases)"
    - "apps/functions/src/sendblue/__tests__/allowlist.test.ts (16 cases)"
    - "apps/functions/src/sendblue/__tests__/normalize.test.ts (15 cases)"
    - "apps/functions/src/sendblue/__tests__/webhook.test.ts (10 cases)"
    - "apps/functions/src/sendblue/__tests__/outbox.test.ts (9 cases)"
    - ".planning/phases/21-sendblue-channel-migration/21-CONTRACT-NOTES.md"
    - ".planning/phases/21-sendblue-channel-migration/21-RUNBOOK.md"
  modified:
    - "apps/functions/src/index.ts (CF exports)"
    - "apps/functions/package.json (test runner + deps)"
    - "apps/macos-imessage-worker/src/index.ts (legacy guard)"
    - "apps/macos-imessage-worker/src/outbox.ts (legacy guard)"
    - "apps/macos-imessage-worker/src/config.ts (isLegacyChannelEnabled)"
    - "apps/macos-imessage-worker/src/outbox.test.ts (PA_CHANNEL_LEGACY=1 prelude)"
    - "packages/pa-orchestrator/src/chunker.ts (deprecation banner)"
decisions:
  - "D-01..D-09 + D-11 executed (see Decisions Made section)"
  - "Sendblue uses uuid as message identifier on REST responses; message_handle on webhook payloads — record both"
  - "minInstances:1 set on paSendblueWebhook to mitigate R-05 cold-start"
  - "Test framework: node --test + tsx (matches @pa/pa-broker convention)"
  - "Adam-confirmed contract: 50/day new + 150/day existing outbound; SOC2; Sendblue owns Apple ID"
metrics:
  tasks-complete: "9 of 12 (T10, T11, T12 require Adam-side execution)"
  tests-added: 58
  tests-passing-functions: 58
  tests-passing-macos-worker: 27
  unit-test-total: 85
  duration: "~75 min single-agent execution"
  completed-date: "2026-04-27"
---

# Phase 21 Plan 01: Sendblue Channel Migration Summary

Replaced macOS iMessage worker with Sendblue hosted transport at the
implementation level: 9 of 12 tasks (T1–T9) shipped behind `PA_CHANNEL_LEGACY=1`
guard. Deploy + dashboard config + sandbox round-trip + production cutover
(T10–T12) remain pending Adam-side execution per plan checkpoints.

## What Was Built

### Cloud Functions surface (`apps/functions/src/sendblue/`)

- **`paSendblueWebhook`** (HTTPS, `minInstances:1`): HMAC-verified Sendblue webhook receiver.
  Routes by event shape — outbound mirror logged & ignored; typing/line events audit-only;
  group_id non-empty rejected (Q-03 lock); allowlist gate fail-closed; inbound `receive`
  enqueued via `@pa/pa-broker` keyed `sendblue-${message_handle}` (D-02).
  All paths return 2xx except 401 (bad sig) + 400 (malformed body) — Sendblue retries on 5xx.
- **`paSendblueOutbox`** (Firestore trigger on `pa_outbound`): claims pending row
  transactionally → allowlist gate → optional typing indicator (PA_TYPING_INDICATOR=1) →
  POST `https://api.sendblue.co/api/send-message`. 4xx → status=failed; 5xx → status=pending
  with attemptCount bump (CF re-fires).

### Auxiliary modules

- `hmac.ts` — `verifySendblueSignature(rawBody, header, secret)`: HMAC-SHA256 hex,
  `crypto.timingSafeEqual`, never throws on malformed input
- `allowlist.ts` — 1:1 port from `apps/macos-imessage-worker/src/config.ts`; same env
  vars (D-03)
- `normalize.ts` — shape-based `isInboundReceiveEvent` + `normalizeSendblueInbound`
- `sendblue-client.ts` — `sendImessage` with `SendblueClientError` (4xx)
  vs `SendblueServerError` (5xx); 30s AbortController timeout; 429 retry-after surfaced
- `typing-indicator.ts` — best-effort `sendTypingIndicator` (5s timeout, swallows errors)
- `audit.ts` — `recordAuditEvent` → `pa_audit_events`

### macOS worker hardening (D-08, D-11)

- `isLegacyChannelEnabled()` flag (default OFF, opt-in via `PA_CHANNEL_LEGACY=1`)
- Worker exits cleanly when not legacy → no competition with CF outbox
- Outbox processor releases claim back to pending under non-legacy → CF takes over

### Phase 15 chunker (D-06)

- Deprecation banner in `packages/pa-orchestrator/src/chunker.ts`
- Code retained for output-normalizer + macOS rollback path; v1.2 removal target

## Decisions Made

| ID  | Decision                                                        | Implementation                                                                |
| --- | --------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| D-01 | Webhook lives at `apps/functions/src/sendblue/webhook.ts`       | `handleSendblueWebhook` pure handler + `paSendblueWebhook` CF wrapper          |
| D-02 | Idempotency: `sendblue-${message_handle}`                       | `normalize.ts` line 67                                                         |
| D-03 | Allowlist port to CF utility (not shared package, blast radius) | `allowlist.ts` 1:1 from worker `config.ts`; same env vars                      |
| D-04 | Allowlist key on `from_number` (E.164)                          | `webhook.ts` lines 184-198                                                     |
| D-05 | Outbox is `onDocumentCreated(pa_outbound)`                      | `apps/functions/src/index.ts` paSendblueOutbox export                          |
| D-06 | Phase 15 chunker disabled by env flip                           | `chunker.ts` deprecation banner; outbox uses native typing API when flag=1     |
| D-07 | Secrets to Firebase Secret Manager                              | 4 `defineSecret` bindings in `index.ts`; runbook documents `firebase functions:secrets:set` flow |
| D-08 | `PA_CHANNEL_LEGACY=1` parallel-run                              | macOS `index.ts` exit-guard + `outbox.ts` claim-release                       |
| D-09 | No backward-compat for in-flight legacy events at cutover       | Runbook drain procedure (Step 4)                                              |
| D-11 | Rollback via `PA_CHANNEL_LEGACY=1` re-enable                    | Runbook Rollback section                                                       |

## Test Results

```
apps/functions:           58 tests pass (8 hmac + 16 allowlist + 15 normalize + 10 webhook + 9 outbox)
apps/macos-imessage-worker: 27 tests pass (existing suite, prepended PA_CHANNEL_LEGACY=1)
typecheck (all workspaces): clean
apps/functions npm run build: clean
```

## Live API probes (T1)

- `POST https://api.sendblue.co/api/send-message` with empty body → 400, auth verified
- Send-message error envelope captured; confirmed `uuid` (REST) vs `message_handle` (webhook) duality
- Free_api / sandbox plan requires `from_number` in body — surfaced as `SENDBLUE_FROM_NUMBER` env

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Added test framework to apps/functions**

- **Found during:** Task 2 (HMAC TDD)
- **Issue:** apps/functions had no test runner; the plan demanded TDD with `npm test`
- **Fix:** Added `tsx@^4` as devDep + `npm test` script using `node --import tsx --test`
  (matches `@pa/pa-broker` convention)
- **Files modified:** `apps/functions/package.json`
- **Commit:** 92a5027

**2. [Rule 3 - Blocking] Added `@pa/pa-broker` + `@pa/pa-persistence` to apps/functions deps**

- **Found during:** Task 7 (CF wiring)
- **Issue:** Outbox handler needed `appendMessage`, `getOrCreateSession`, `getUser`
  from `@pa/pa-persistence`; webhook needed `createInboundEvent` from `@pa/pa-broker`,
  but neither was in `apps/functions/package.json`
- **Fix:** Added workspace links; ran `npm install` to wire
- **Files modified:** `apps/functions/package.json`, `package-lock.json`
- **Commit:** 4841247

**3. [Rule 3 - Blocking] Type-loosened OutboxDeps for production injection**

- **Found during:** Task 7 typecheck
- **Issue:** `appendMessage` from `@pa/pa-persistence` has a strict `Omit<ChatMessage, "id">`
  signature that conflicted with the test-friendly `Record<string, unknown>` injection
- **Fix:** Loosened `OutboxDeps` to `(db: Firestore, input: never) => Promise<unknown>` so
  production casts at use site
- **Commit:** 4841247

**4. [Rule 1 - Bug] Fixed test for `isSamePeer("12345","12345")`**

- **Found during:** Task 3 RED → GREEN
- **Issue:** Wrote test asserting `false` for short-digit equal inputs, but worker
  semantics return `true` (na===nb shortcut)
- **Fix:** Updated test to match worker truth-table (different short strings → false;
  identical short strings → true)
- **Commit:** c7f5612

### Plan-explicit work NOT auto-extended

None. T10/T11/T12 are explicit Adam-side checkpoints in the plan.

## Authentication Gates

**T7 → T9 — webhook signing secret provisioning (`SENDBLUE_WEBHOOK_SIGNING_SECRET`)**

- Plan says: "Pause and ask Adam to set webhook secret if not yet set."
- Status: **Code wired with `defineSecret(...)` binding; Adam must execute
  `firebase functions:secrets:set SENDBLUE_WEBHOOK_SIGNING_SECRET` before deploy**
- Documented in 21-RUNBOOK.md Step 1

## What's NOT Done (Adam-side)

- **T10 (`checkpoint:human-action`)** — Sendblue dashboard webhook endpoint config
  + signing-secret provisioning. Contract Qs Q1–Q4 already answered; tracker updated.
- **T11** — Sandbox round-trip smoke (5 trials + 4 fail-mode probes) — requires CF
  deploy first, then Adam sends real iMessages from his phone.
- **T12 (`checkpoint:human-verify`)** — Production cutover GO/NO-GO + flag flip
  on macOS worker host. Depends on T11 passing.

These are sequenced post-deploy. Code is ready.

## Followups

- Live HMAC header confirmation on first webhook delivery (Q5 in CONTRACT-NOTES; verify alias coverage)
- v1.2: DELETE `apps/macos-imessage-worker/`, `chunker.ts` (per D-08 + D-06 removal targets)
- Promote `apps/functions/src/sendblue/allowlist.ts` to shared package if WhatsApp adapter lands
- Mirror `outbound` Sendblue webhook events into `pa_audit_events` for delivery telemetry (Q-02 deferred)

## Self-Check: PASSED

- 9 source files exist under `apps/functions/src/sendblue/`
- 5 test files exist under `apps/functions/src/sendblue/__tests__/`
- `21-CONTRACT-NOTES.md` + `21-RUNBOOK.md` exist under phase dir
- 9 commits exist on `main` (8483b73 92a5027 c7f5612 4a6bcbf 8531ce1 fcad570 4841247 b189f5b 9aaa58b)
- `apps/functions && npm run build` succeeds (verified)
- `apps/functions && npm test` reports 58 pass / 0 fail (verified)
- `apps/macos-imessage-worker && npm test` reports 27 pass / 0 fail (verified)
