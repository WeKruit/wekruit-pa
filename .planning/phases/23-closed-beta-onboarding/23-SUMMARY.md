---
phase: 23-closed-beta-onboarding
plan: 23
subsystem: safety-onboarding-dashboard
tags: [beta, onboarding, abuse-events, allowlist, kill-switch, dashboard]
dependency_graph:
  requires: [18-companion-voice-v1, 17-pre-launch-hardening]
  provides: [beta-onboarding-flow, abuse-event-producers, firestore-allowlist, beta-dashboard]
  affects: [pa-orchestrator, pa-safety, dashboard-web, macos-imessage-worker]
tech_stack:
  added:
    - BetaParticipant + OnboardingState types (core-types)
    - pa_beta_participants Firestore collection
    - resolveAllowlist / isAllowlisted / recordAllowlistDeny (pa-orchestrator/allowlist.ts)
    - resolveOnboardingStep / applyOnboardingStep / composeOnboardingInput (pa-orchestrator/onboarding.ts)
    - checkPromptInjectionAndRecord / recordPromptInjection (pa-safety)
    - resolveWorkerAllowlist + recordWorkerAllowlistDeny (macos-imessage-worker/config.ts)
    - Abuse.tsx + Beta.tsx dashboard pages
  patterns:
    - Idempotency key bucketing (60s window for allowlist_deny dedup)
    - Firestore-first with env fallback + 30s in-memory cache (worker allowlist)
    - Onboarding state machine: pure resolver + transactional applyOnboardingStep
key_files:
  created:
    - packages/pa-orchestrator/src/allowlist.ts
    - packages/pa-orchestrator/src/allowlist.test.ts
    - packages/pa-orchestrator/src/onboarding.ts
    - packages/pa-orchestrator/src/onboarding.test.ts
    - apps/dashboard-web/src/pages/Abuse.tsx
    - apps/dashboard-web/src/pages/Beta.tsx
    - .planning/phases/23-closed-beta-onboarding/BETA-RUNBOOK.md
  modified:
    - packages/core-types/src/collections.ts (betaParticipants constant)
    - packages/core-types/src/index.ts (BetaParticipant, OnboardingState types; User.onboardingState)
    - packages/core-types/src/broker.ts (allowlist_deny + prompt_injection AbuseEventKind)
    - packages/pa-safety/src/index.ts (checkPromptInjectionAndRecord, recordPromptInjection)
    - packages/pa-safety/src/index.test.ts (2 new tests)
    - packages/pa-orchestrator/src/index.ts (onboarding wiring + checkPromptInjectionAndRecord)
    - packages/pa-orchestrator/src/index.test.ts (Phase 23 store stubs)
    - packages/pa-orchestrator/package.json (test script updated)
    - apps/macos-imessage-worker/src/config.ts (Firestore allowlist resolver + cache)
    - apps/macos-imessage-worker/src/index.ts (Firestore allowlist wire + abuse recording)
    - apps/dashboard-web/src/App.tsx (/beta + /abuse routes + nav links)
    - config/firebase/firestore.rules (pa_beta_participants rule)
decisions:
  - "D-01: Allowlist source-of-truth migrates env→Firestore (default prod); env=dev mode via PA_ALLOWLIST_SOURCE=env"
  - "D-02: pa_beta_participants is a separate collection from pa_users (orthogonal lifecycle)"
  - "D-03: Onboarding state lives on pa_users.onboardingState (one field, per-user)"
  - "D-04: Onboarding uses Voice v1 prompt unchanged (synthetic system inputs only)"
  - "D-05: Abuse panel read-only with mark_resolved mutation"
  - "D-06: Kill switch = pa_remote_config/platform.outboundPaused"
  - "D-08: invited→active auto-promotion at onboarding complete"
metrics:
  duration: 665s (~11 min)
  completed: 2026-04-28T05:34:37Z
  tasks_completed: 4
  tasks_total: 5
  files_created: 7
  files_modified: 12
  tests_added: 16
  tests_passing: 51
---

# Phase 23 Plan 23: Closed Beta Onboarding + Safety Summary

One-liner: **Firestore-backed allowlist (env fallback), 3-producer abuse event trail (rate-limit + injection + deny), onboarding state machine routing Bible v6.4 first_mes through Voice v1, beta/abuse dashboard with kill switch.**

## What Was Built

### Task 1: Types + Collection + Allowlist Resolver + Firestore Rules

- Added `betaParticipants: "pa_beta_participants"` to `PA_COLLECTIONS`.
- Exported `BetaParticipant`, `BetaParticipantStatus`, `OnboardingState` types from `@pa/core-types`.
- Extended `User` schema with `onboardingState`, `onboardedAt`, `metadata.cohort`.
- Added `allowlist_deny` and `prompt_injection` to `AbuseEventKindSchema`.
- Created `packages/pa-orchestrator/src/allowlist.ts`: `resolveAllowlist`, `isAllowlisted`, `recordAllowlistDeny` with 60s idempotency bucketing.
- Added `pa_beta_participants` Firestore rule (isPaOperator gate).
- 6/6 tests green.

### Task 2: Abuse Producers + Onboarding State Machine

- Added `checkPromptInjectionAndRecord` to `@pa/pa-safety`: writes `pa_abuse_events` with `kind="prompt_injection"` when blocked.
- Replaced sync `checkPromptInjection` call in `checkInboundSafety` with async `checkPromptInjectionAndRecord`.
- Created `packages/pa-orchestrator/src/onboarding.ts`: pure state resolver + idempotent step applicator + synthetic system input composer.
- Wired onboarding into `processInboundEvent`: intercepts before normal LLM dispatch for `invited`/`pending` users; routes through Voice v1 system prompt with synthetic `[onboarding_step: ...]` hint.
- Auto-promotes `pa_beta_participants` status to `active` on `complete` step (D-08).
- 8/8 onboarding tests, 6/6 safety tests, 37/37 existing orchestrator tests — all green.

### Task 3: Dashboard /abuse + /beta Routes

- `Abuse.tsx`: last 50 `pa_abuse_events` ordered newest-first; filter chips for `all / rate_limited / prompt_injection / allowlist_deny`; mark-resolved writes `resolvedAt + resolvedBy + resolutionNote`; resolved rows show strikethrough.
- `Beta.tsx`: Section A = participants CRUD table (add/suspend/reactivate/remove, auto-detect phone vs email); Section B = kill switch button writing `pa_remote_config/platform.outboundPaused` with confirm modal + audit event.
- Kill switch banner at top of `/beta` when paused (shows timestamp + operator).
- Routes `/beta` and `/abuse` registered in `App.tsx` with nav links.
- TypeScript typecheck passes; Vite bundler hit pre-existing `node:crypto/scheduled-jobs` issue (out of scope — pre-dates Phase 23).

### Task 4: Worker Firestore Allowlist + BETA-RUNBOOK.md

- `config.ts` extended: `resolveWorkerAllowlist(db)` queries `pa_beta_participants` (status=active), caches result for 30s, falls back to env on error.
- `recordWorkerAllowlistDeny(db, ...)`: idempotent 60s-keyed abuse row + audit event.
- Worker inbound handler updated to use `resolveWorkerAllowlist` (async, DB-backed when available); both deny paths (empty list + not-in-list) call `recordWorkerAllowlistDeny`.
- `BETA-RUNBOOK.md`: 99 lines, all 8 sections present (Purpose, Onboarding, Daily Checks, Escalation, Kill Switch, Suspend, Remove, Known Limits). Notes Sendblue Free tier 10-contact gate.
- Worker typecheck clean.

### Task 5: E2E Smoke + Voice Approval

**Checkpoint — awaiting Adam verification.**

## Abuse Event Producers (BETA-02 — 3/3 Wired)

| Kind | Producer | Location |
|------|----------|----------|
| `rate_limited` | `enforceRateLimit` | `pa-safety/index.ts` (pre-existing + confirmed) |
| `prompt_injection` | `checkPromptInjectionAndRecord` | `pa-safety/index.ts` (Phase 23 NEW) |
| `allowlist_deny` | `recordWorkerAllowlistDeny` | `macos-imessage-worker/config.ts` (Phase 23 NEW) |

## Test Summary

| Suite | Tests | Pass |
|-------|-------|------|
| pa-safety (total) | 6 | 6 |
| pa-orchestrator/index.test.ts | 37 | 37 |
| pa-orchestrator/allowlist.test.ts | 6 | 6 |
| pa-orchestrator/onboarding.test.ts | 8 | 8 |
| **Total** | **57** | **57** |

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Fake Firestore in onboarding test missing `ref.set` method**
- **Found during:** Task 2 test execution
- **Issue:** `where().limit().get()` docs in fake store returned objects without `ref` property; `applyOnboardingStep complete` test failed with `TypeError: Cannot read properties of undefined (reading 'set')`
- **Fix:** Added `ref: { set() }` to each filtered doc in the test fake firestore
- **Files modified:** `packages/pa-orchestrator/src/onboarding.test.ts`
- **Commit:** `406426a`

**2. [Rule 1 - Bug] Duplicate `Firestore` import in pa-safety/index.ts**
- **Found during:** Task 2 implementation
- **Issue:** Added `import type { Firestore }` when it already existed
- **Fix:** Removed duplicate
- **Files modified:** `packages/pa-safety/src/index.ts`
- **Commit:** `406426a`

### Out-of-Scope Items (Deferred)

- Vite bundler failure on `node:crypto` in `packages/core-types/dist/scheduled-jobs.js` — pre-existing issue (present before Phase 23; unrelated to this phase's changes). Logged in `deferred-items.md` if created.
- Boot-time allowlist log in `index.ts` still uses sync `getPeerAllowlist()` — informational only, not the enforcement path.

## Requirements Satisfied

- BETA-01: First-contact flow — `invited` participant triggers onboarding state machine; Bible v6.4 `first_mes` sent via Voice v1; 1 grounding question; auto-promoted to `active`.
- BETA-02: All 3 abuse producers wired: `rate_limited` (existing), `prompt_injection` (Phase 23), `allowlist_deny` (Phase 23).
- BETA-03: `/abuse` panel renders last 50 events with kind filter + mark-resolved.
- BETA-04: `/beta` CRUD for participants; Firestore is source-of-truth; env still works via `PA_ALLOWLIST_SOURCE=env`.
- BETA-05: `BETA-RUNBOOK.md` at spec path, 99 lines, kill switch documented.

## Known Stubs

None — all wired to Firestore. Dashboard pages connect to live collections.

## Self-Check: PASSED
