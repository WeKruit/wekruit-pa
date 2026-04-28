---
phase: 22-proactive-checkin
plan: 22
subsystem: proactive-messaging
tags: [firestore, cloud-functions, cloud-scheduler, proactive-triggers, iMessage, voice-v1, idempotency, cancellation-nlu]

requires:
  - phase: 18-companion-voice-v1
    provides: Voice v1 system prompt + runTurn orchestrator entry reused by proactive path
  - phase: 20-output-normalizer
    provides: normalizeForIMessage() called on proactive turn output before enqueue
  - phase: 07-scheduler-platform-runtime
    provides: pa_scheduled_jobs base schema (dueAt/status/attempts/maxAttempts/backoffSec)

provides:
  - ProactiveTriggerType union (time_anchor | silence_anchor | application_followup)
  - ScheduledJob schema with proactive fields coexisting with Phase 7 base (nextFireAt + dueAt dual-write)
  - fireWindowHash(jobId, nextFireAtMs) — sha1 idempotency key for (jobId × fireWindow) dedup
  - runProactiveTurn(userId, job, store) — Voice v1 path via synthetic user-role input
  - detectProactiveCancellation(text) — regex NLU for zh + en stop phrases
  - paProactiveSweep CF — HTTPS-callable, capped at 50 jobs/sweep, claim-then-dispatch
  - /triggers dashboard page — CRUD for all 3 trigger types, filtered to signed-in user
  - PA_PROACTIVE_DISABLED=1 kill switch wired at sweep + turn level
  - 3 E2E YAML scenarios (time_anchor, silence_anchor, application_followup)
  - Scenario runner proactive extensions (proactiveSeed, proactiveSweepHook, proactiveAssertions)

affects: [23-closed-beta-onboarding, phase7-scheduler-callers, pa-orchestrator-inbound-path]

tech-stack:
  added: []
  patterns:
    - "Synthetic user-role input pattern: proactive turn = [system-trigger:type] marker in user role message, reuses Voice v1 prompt unchanged (D-02)"
    - "Claim-then-dispatch mutex: status=running write inside Firestore transaction gates concurrent sweeps"
    - "fireWindowHash = sha1(jobId:floor(nextFireAt/60000)) — 1-min bucket makes double-sweep idempotent"
    - "Dual-write nextFireAt + dueAt for Phase 7 backward compat at job-create time"
    - "Audit event top-level fields: fireWindowHash/jobId/triggerType written directly (not inside meta) to enable Firestore queries"

key-files:
  created:
    - packages/core-types/src/scheduled-jobs.ts
    - packages/pa-orchestrator/src/proactive-turn.ts
    - packages/pa-orchestrator/src/cancellation-nlu.ts
    - packages/pa-orchestrator/src/proactive-turn.test.ts
    - packages/pa-orchestrator/src/cancellation-nlu.test.ts
    - apps/functions/src/proactive-sweep.ts
    - apps/functions/src/proactive-sweep.test.ts
    - apps/functions/src/proactive-turn-store.ts
    - apps/dashboard-web/src/pages/Triggers.tsx
    - apps/dashboard-web/src/lib/triggers-api.ts
    - tests/scenarios/proactive-time-anchor.yaml
    - tests/scenarios/proactive-silence-anchor.yaml
    - tests/scenarios/proactive-application-followup.yaml
  modified:
    - packages/core-types/src/index.ts
    - packages/pa-orchestrator/src/index.ts
    - packages/pa-orchestrator/package.json
    - apps/functions/src/index.ts
    - apps/functions/package.json
    - apps/dashboard-web/src/App.tsx
    - tests/scenarios/runner.mjs

key-decisions:
  - "D-02 enforced: proactive turn calls same orchestrator entry as inbound via synthetic user-role input — no forked system prompt"
  - "D-06 enforced: fireWindowHash written as top-level Firestore field (not inside meta) to support idempotency queries"
  - "D-12: silence_anchor recurs via rearmJob post-fire; time_anchor + application_followup are once-only"
  - "T6 pending Adam: Cloud Scheduler job must be created manually in GCP Console (operator step)"

requirements-completed:
  - PROACTIVE-01
  - PROACTIVE-02
  - PROACTIVE-03
  - PROACTIVE-04
  - PROACTIVE-05
  - PROACTIVE-06
  - PROACTIVE-07

duration: ~90min (T1-T4 first agent; T5 continuation agent)
completed: 2026-04-28
---

# Phase 22: Proactive Check-in Summary

**Trigger-based proactive outreach loop: Voice v1 synthetic-input pattern, fireWindowHash idempotency, cancellation NLU, 3-type dashboard CRUD, paProactiveSweep CF, E2E scenario runner extensions (T6 = Cloud Scheduler creation by Adam)**

## Performance

- **Duration:** ~90 min total (split across two agent executions)
- **Completed:** 2026-04-28
- **Tasks:** 5/6 auto tasks complete + T6 checkpoint (human action required)
- **Files modified:** 18 created, 7 modified

## Accomplishments

- Full proactive outreach loop implemented: user creates trigger at `/triggers`, PA messages at the right moment in Voice v1 register, cancellation via "停止提醒" / "stop reminders"
- Voice v1 non-regression: proactive turn reuses the same orchestrator entry via synthetic user-role input tagged `[system-trigger:type]` — no forked prompt, no utility register
- Idempotency hardened at two layers: claim-mutex in Firestore transaction + fireWindowHash check against pa_audit_events; concurrent sweeps cannot double-fire
- Scenario runner extended with proactiveSeed + proactiveSweepHook + proactiveAssertions DSL; 5 scenarios (3 trigger types + idempotency cross-cut + cancellation cross-cut) wired

## Task Commits

1. **Task 1: pa_scheduled_jobs schema + fireWindowHash** - `354e069` (feat)
2. **Task 2: Orchestrator proactive-turn + cancellation NLU** - `2b8348f` (feat)
3. **Task 3: paProactiveSweep CF + idempotent dispatch** - `1242061` (feat)
4. **Task 4: /triggers dashboard CRUD** - `bfa58e1` (feat)
5. **Task 5: E2E scenarios + runner extensions** - `a7a2569` (feat)
6. **Task 6: Cloud Scheduler human verify** - PENDING (checkpoint:human-verify)

## Files Created/Modified

- `packages/core-types/src/scheduled-jobs.ts` — ProactiveTriggerType, ScheduledJob, fireWindowHash, PROACTIVE_JOB_STATUS
- `packages/pa-orchestrator/src/proactive-turn.ts` — runProactiveTurn: Voice v1 path via synthetic input
- `packages/pa-orchestrator/src/cancellation-nlu.ts` — detectProactiveCancellation: 7 zh+en phrase patterns
- `apps/functions/src/proactive-sweep.ts` — paProactiveSweep CF: SweepStore injectable, cap 50, claim-mutex
- `apps/functions/src/proactive-turn-store.ts` — Firestore adapter for ProactiveTurnStore
- `apps/dashboard-web/src/pages/Triggers.tsx` — /triggers CRUD for 3 trigger types
- `apps/dashboard-web/src/lib/triggers-api.ts` — Firestore SDK wrapper for pa_scheduled_jobs
- `tests/scenarios/runner.mjs` — proactiveSeed/proactiveSweepHook/proactiveAssertions extensions
- `tests/scenarios/proactive-*.yaml` — 3 scenario files (time_anchor, silence_anchor, application_followup)
- `packages/pa-orchestrator/package.json` — added proactive-turn.test.ts + cancellation-nlu.test.ts to test command
- `apps/functions/package.json` — added proactive-sweep.test.ts to test command

## Decisions Made

- Voice v1 re-use: synthetic input carries `[system-trigger:type]` in the content but role stays "user" — this keeps Voice v1 mes_example few-shots anchored (D-02)
- fireWindowHash stored as TOP-LEVEL Firestore field in pa_audit_events (not inside meta) — needed for `where("fireWindowHash", "==", hash)` query in idempotency check; appendAuditEvent doesn't pass through custom fields so we write directly
- silence_rearm post-fire: rearmJob sets nextFireAt = now + windowSec, status back to pending (D-12)
- Cloud Scheduler binding deferred to operator (D-05): CF is deployed + HTTPS-callable; only the cron schedule creation requires prod GCP access

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Fixed fireWindowHash audit field nesting**
- **Found during:** Task 5 (E2E scenario runner implementation)
- **Issue:** `proactive-turn-store.ts` was writing `fireWindowHash` inside `meta: { ... }` via `appendAuditEvent`, but `proactive-sweep.ts` queries `where("fireWindowHash", "==", hash)` at top level. Idempotency check would never find prior audit events.
- **Fix:** Changed `proactive-turn-store.ts` to write the audit event directly with `fireWindowHash` as a top-level field on the Firestore document
- **Files modified:** `apps/functions/src/proactive-turn-store.ts`
- **Committed in:** `a7a2569` (T5 commit)

**2. [Rule 1 - Bug] Fixed proactive-sweep.test.ts TypeScript type error**
- **Found during:** Task 5 (typecheck after adding test to functions package)
- **Issue:** `makeStore()` return object included helper accessors (`getRunTurnCallCount`, etc.) not in `SweepStore` interface — TypeScript error TS2353
- **Fix:** Extracted `TestSweepStore = SweepStore & { helpers... }` type and used it as the `makeStore` return type
- **Files modified:** `apps/functions/src/proactive-sweep.test.ts`
- **Committed in:** `a7a2569` (T5 commit)

---

**Total deviations:** 2 auto-fixed (both Rule 1 bugs)
**Impact on plan:** Both required for correctness. No scope creep.

## Known Stubs

None — proactive turn path wires to real LLM via `runAgentTurn`; pa_outbound enqueued with real body; Triggers page writes to real Firestore pa_scheduled_jobs.

## Issues Encountered

- **Pre-existing sendblue HMAC test failures**: `apps/functions/src/sendblue/__tests__/hmac.test.ts` has 2 failing tests. These exist on main before Phase 22 work and are out of scope for this phase. Deferred to the sendblue channel team.

## User Setup Required

**GCP Cloud Scheduler — must be created manually by Adam**

The CF `paProactiveSweep` is deployed and HTTPS-accessible. Cloud Scheduler must be wired:

```bash
gcloud scheduler jobs create http pa-proactive-sweep \
  --schedule="* * * * *" \
  --uri="https://us-central1-wekruit-5f89b.cloudfunctions.net/paProactiveSweep" \
  --http-method=POST \
  --oidc-service-account-email=<CF service account> \
  --location=us-central1 \
  --project=wekruit-5f89b
```

Exact endpoint URL: verify via `firebase deploy --only functions` output.

## T6 Human Verify — What Adam Must Do

1. Deploy CF: `firebase deploy --only functions --project wekruit-5f89b`
2. Create Cloud Scheduler job (command above)
3. Open `https://wekruit-pa.web.app/triggers`, sign in
4. Create time-anchor trigger with eventAt = NOW + 2 min, leadTimeSec = 60s
5. Wait ~2 min — verify iMessage arrives in Voice v1 register (no markdown, concise)
6. Reply "停止提醒" — verify Voice v1-toned confirmation reply, triggers flip to Cancelled
7. Spot-check pa_audit_events for proactive_send + proactive_cancel rows
8. Set PA_PROACTIVE_DISABLED=1, create fresh trigger, wait — verify no iMessage sent

## Next Phase Readiness

- Phase 23 (Closed Beta Onboarding) — ready to execute; already partially shipped (T1-T4 in bfa58e1 context)
- Phase 22 is functionally complete pending T6 human verify + Cloud Scheduler creation by Adam
- v1.2 Voice Quality Baseline (Phase 24) — executing independently

---
*Phase: 22-proactive-checkin*
*Completed: 2026-04-28 (T6 pending Adam verification)*

---

## Trigger Plan (deferred — 2026-04-28)

Cron Cloud Scheduler intentionally NOT wired. Three trigger paths planned:

1. **Admin** (now): POST `paProactiveSweep` with header `x-admin-token: $PA_ADMIN_TOKEN`. Used for manual sweeps and future dashboard "Run sweep" button.
2. **Event-driven** (next): trigger sweep on Firestore event (e.g. user inactivity threshold crossed) — phase TBD.
3. **Weekly** (later): Cloud Scheduler cron, low-frequency safety net — defer until usage validated.

Dashboard UI to expose trigger 1 lands in a later phase.
