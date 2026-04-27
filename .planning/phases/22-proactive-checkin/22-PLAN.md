---
phase: 22-proactive-checkin
plan: 22
type: execute
wave: 1
depends_on: [18-companion-voice-v1, 20-output-normalizer]
files_modified:
  - packages/core-types/src/scheduled-jobs.ts
  - packages/core-types/src/index.ts
  - apps/functions/src/proactive-sweep.ts
  - apps/functions/src/index.ts
  - packages/pa-orchestrator/src/proactive-turn.ts
  - packages/pa-orchestrator/src/index.ts
  - packages/pa-orchestrator/src/cancellation-nlu.ts
  - apps/dashboard-web/src/pages/Triggers.tsx
  - apps/dashboard-web/src/App.tsx
  - apps/dashboard-web/src/lib/triggers-api.ts
  - packages/pa-orchestrator/src/proactive-turn.test.ts
  - packages/pa-orchestrator/src/cancellation-nlu.test.ts
  - apps/functions/src/proactive-sweep.test.ts
  - tests/scenarios/proactive-time-anchor.yaml
  - tests/scenarios/proactive-silence-anchor.yaml
  - tests/scenarios/proactive-application-followup.yaml
autonomous: false
requirements:
  - PROACTIVE-01
  - PROACTIVE-02
  - PROACTIVE-03
  - PROACTIVE-04
  - PROACTIVE-05
  - PROACTIVE-06
  - PROACTIVE-07
user_setup:
  - service: gcp-cloud-scheduler
    why: "1-minute cron invokes paProactiveSweep CF"
    dashboard_config:
      - task: "Create Cloud Scheduler job 'pa-proactive-sweep' with schedule '* * * * *' targeting paProactiveSweep HTTPS endpoint with OIDC auth"
        location: "GCP Console → Cloud Scheduler (project wekruit-5f89b)"
must_haves:
  truths:
    - "User can create a time-anchor trigger via /triggers and PA messages them at T-24h in Voice v1 register"
    - "User can create a silence-anchor trigger and PA messages them after configured silence window with no other inbound activity"
    - "User can create an application-followup trigger and PA messages them at T+72h post-apply"
    - "User can cancel all pending triggers by sending '停止提醒' or 'stop reminders' on iMessage"
    - "Same trigger × fireWindow cannot fire twice (idempotent)"
    - "Setting PA_PROACTIVE_DISABLED=1 stops all proactive sends without redeploy"
    - "Every proactive send and every cancellation is in pa_audit_events with jobId + triggerType + fireWindowHash"
  artifacts:
    - path: "packages/core-types/src/scheduled-jobs.ts"
      provides: "ProactiveTriggerType union, ScheduledJob type with proactive fields, fireWindowHash() helper"
      exports: ["ProactiveTriggerType", "ScheduledJob", "ProactiveJobContext", "fireWindowHash"]
    - path: "apps/functions/src/proactive-sweep.ts"
      provides: "paProactiveSweep CF — query pending due jobs, dispatch through orchestrator, idempotent enqueue"
      exports: ["paProactiveSweep"]
    - path: "packages/pa-orchestrator/src/proactive-turn.ts"
      provides: "runProactiveTurn(userId, job) — synthesizes system input, reuses Voice v1 turn entry, normalizes output, enqueues to pa_outbound"
      exports: ["runProactiveTurn"]
    - path: "packages/pa-orchestrator/src/cancellation-nlu.ts"
      provides: "detectProactiveCancellation(text): boolean — regex over zh + en short-phrase set"
      exports: ["detectProactiveCancellation", "CANCELLATION_PATTERNS"]
    - path: "apps/dashboard-web/src/pages/Triggers.tsx"
      provides: "/triggers route — CRUD for user's pa_scheduled_jobs (3 trigger types), list with status badges"
      exports: ["Triggers"]
    - path: "tests/scenarios/proactive-time-anchor.yaml"
      provides: "E2E scenario for time-anchor trigger fire path"
    - path: "tests/scenarios/proactive-silence-anchor.yaml"
      provides: "E2E scenario for silence-anchor trigger fire path"
    - path: "tests/scenarios/proactive-application-followup.yaml"
      provides: "E2E scenario for application-followup trigger fire path"
  key_links:
    - from: "apps/functions/src/proactive-sweep.ts"
      to: "packages/pa-orchestrator/src/proactive-turn.ts"
      via: "import { runProactiveTurn }"
      pattern: "runProactiveTurn\\("
    - from: "packages/pa-orchestrator/src/proactive-turn.ts"
      to: "Voice v1 system prompt (Phase 18)"
      via: "reuses default orchestrator turn entry — does NOT define its own system prompt"
      pattern: "runTurn|orchestrate"
    - from: "packages/pa-orchestrator/src/index.ts"
      to: "packages/pa-orchestrator/src/cancellation-nlu.ts"
      via: "inbound-turn pre-LLM hook calls detectProactiveCancellation"
      pattern: "detectProactiveCancellation\\("
    - from: "apps/dashboard-web/src/pages/Triggers.tsx"
      to: "pa_scheduled_jobs collection"
      via: "Firestore SDK reads/writes filtered by userId"
      pattern: "pa_scheduled_jobs|scheduledJobs"
    - from: "apps/functions/src/proactive-sweep.ts"
      to: "pa_audit_events"
      via: "writes kind=proactive_send on every enqueue"
      pattern: "kind.*proactive_send"
---

<objective>
Phase 22 — Proactive Check-in (revived from skipped Phase 12).

Build the trigger-based proactive outreach loop:
1. Dashboard `/triggers` page so users self-serve their own time / silence / application-followup triggers (per D-01).
2. `pa_scheduled_jobs` formalized schema with proactive-specific fields (per D-04, PROACTIVE-02).
3. CF `paProactiveSweep` on 1-min Cloud Scheduler cron (per D-05, PROACTIVE-03).
4. Orchestrator proactive-turn path that reuses Phase 18 Voice v1 prompt — synthetic system input only, NO separate utility prompt (per D-02, PROACTIVE-04).
5. Cancellation flow via iMessage NLU "停止提醒" / "stop reminders" (per D-07, PROACTIVE-06).
6. Idempotency by `(jobId, fireWindowHash)` (per D-06, PROACTIVE-05).
7. Audit logging in `pa_audit_events` for every proactive send + cancellation (per D-09).
8. Rollback via `PA_PROACTIVE_DISABLED=1` env flag (per D-10).
9. E2E scenarios for all 3 trigger types (per PROACTIVE-07).

Purpose: Make PA feel alive without sliding into spam. User-controlled, voice-consistent, kill-switchable.
Output: 1 new collection schema module, 1 new CF, 1 new dashboard route, 1 new orchestrator path, 3 E2E scenarios, audit + rollback wiring.
</objective>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
@$HOME/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/PROJECT.md
@.planning/REQUIREMENTS.md
@.planning/ROADMAP.md
@.planning/STATE.md
@.planning/phases/22-proactive-checkin/22-CONTEXT.md
@.planning/phases/18-companion-voice-v1/CHARACTER-BIBLE-v1.md
@packages/core-types/src/collections.ts
@packages/pa-orchestrator/src/index.ts
@apps/functions/src/index.ts
@apps/dashboard-web/src/App.tsx

<interfaces>
<!-- Existing contracts the executor will consume. Do not re-explore. -->

From packages/core-types/src/collections.ts:
```ts
export const PA_COLLECTIONS = {
  scheduledJobs: "pa_scheduled_jobs",
  outbound: "pa_outbound",
  auditEvents: "pa_audit_events",
  inboundEvents: "pa_inbound_events",
  // ... see file for full set
} as const
```

From Phase 7 (already-shipped scheduler convention — pa_scheduled_jobs base shape):
```ts
// Existing fields on pa_scheduled_jobs (do not break)
{
  id: string                    // doc id
  dueAt: Timestamp              // existing — proactive-fields ALIAS this as nextFireAt
  status: "pending" | "running" | "done" | "failed" | "dead_letter"
  attempts: number
  maxAttempts: number
  backoffSec: number
}
```

From Phase 18 (Voice v1 — must reuse, do NOT duplicate prompt):
```
Orchestrator default turn entry already loads Voice v1 system prompt.
Proactive turn = call same entry with synthetic user-role input "[system-trigger] <context>".
DO NOT write a parallel proactive-only system prompt.
```

From apps/dashboard-web/src/App.tsx (routing pattern to extend):
```tsx
<NavLink to="/operations">Operations</NavLink>
<Route path="/operations" element={<Operations />} />
// Add:
<NavLink to="/triggers">Triggers</NavLink>
<Route path="/triggers" element={<Triggers />} />
```

From PA_COLLECTIONS.outbound (existing enqueue contract):
```ts
// pa_outbound row shape used by both macOS worker (current) and Sendblue CF (Phase 21)
{
  userId: string
  toNumber: string
  body: string
  status: "queued" | "sent" | "failed"
  enqueuedAt: Timestamp
  // proactive-specific:
  source?: "user_turn" | "proactive"
  proactiveJobId?: string
}
```
</interfaces>
</context>

<tasks>

<task type="auto" tdd="true">
  <name>Task 1: Formalize pa_scheduled_jobs proactive schema + idempotency helper</name>
  <files>
    packages/core-types/src/scheduled-jobs.ts,
    packages/core-types/src/index.ts,
    packages/core-types/src/scheduled-jobs.test.ts
  </files>
  <behavior>
    - Test 1: ProactiveTriggerType union accepts exactly "time_anchor" | "silence_anchor" | "application_followup" (per D-03).
    - Test 2: ProactiveJobContext is discriminated on triggerType — time_anchor requires { eventLabel, eventAt, leadTimeSec }; silence_anchor requires { windowSec, lastUserMsgAt }; application_followup requires { companyName, jobTitle, appliedAt, followupAfterSec }.
    - Test 3: fireWindowHash(jobId, nextFireAtMs) returns deterministic sha1 of `${jobId}:${Math.floor(nextFireAtMs/60000)}` — same inputs same output, different bucket different output (per D-06).
    - Test 4: ScheduledJob type extends existing Phase 7 base (status / attempts / maxAttempts / backoffSec) without removing any field.
    - Test 5: Recurrence union "once" | "silence_rearm" only — no generic cron strings in v1 (per D-12).
  </behavior>
  <action>
    Create new module `packages/core-types/src/scheduled-jobs.ts` exporting:

    - `ProactiveTriggerType = "time_anchor" | "silence_anchor" | "application_followup"` (per D-03, PROACTIVE-02).
    - `ProactiveRecurrence = "once" | "silence_rearm"` (per D-12).
    - `ProactiveJobContext` discriminated union by `triggerType` with the field shapes above. Each variant self-describing — operator inspecting Firestore can read meaning without code.
    - `ScheduledJob` interface with: `jobId: string`, `userId: string`, `triggerType: ProactiveTriggerType`, `nextFireAt: Timestamp` (alias / coexist with existing `dueAt` from Phase 7 — write both or use a getter; do NOT remove `dueAt`), `recurrence: ProactiveRecurrence`, `context: ProactiveJobContext`, `status: "pending" | "running" | "fired" | "cancelled_by_user" | "failed" | "dead_letter"`, `createdAt: Timestamp`, `lastFiredAt?: Timestamp`, plus the existing Phase 7 base fields (`attempts`, `maxAttempts`, `backoffSec`).
    - `fireWindowHash(jobId: string, nextFireAtMs: number): string` — sha1 hex of `${jobId}:${Math.floor(nextFireAtMs/60000)}` (per D-06, PROACTIVE-05).
    - `PROACTIVE_JOB_STATUS` const-as-frozen-object for runtime checks.

    Re-export from `packages/core-types/src/index.ts`. Confirm coexistence with existing `dueAt` semantics from Phase 7 — DO NOT silently rename or break Phase 7 callers; treat `nextFireAt` as the proactive-domain alias and write both at job-create time inside the dashboard CRUD layer (Task 4).

    Do NOT re-export anything that would shadow existing PA_COLLECTIONS or break tree-shaking.
  </action>
  <verify>
    <automated>cd /Users/adam/Desktop/WeKruit/wekruit-pa && npm run -w @wekruit/core-types test -- scheduled-jobs && npm run -w @wekruit/core-types build</automated>
  </verify>
  <done>
    Schema + idempotency helper exported and unit-tested. Phase 7 callers still compile (dueAt preserved). PROACTIVE-02 satisfied.
  </done>
</task>

<task type="auto" tdd="true">
  <name>Task 2: Orchestrator proactive-turn path + cancellation NLU detector</name>
  <files>
    packages/pa-orchestrator/src/proactive-turn.ts,
    packages/pa-orchestrator/src/cancellation-nlu.ts,
    packages/pa-orchestrator/src/proactive-turn.test.ts,
    packages/pa-orchestrator/src/cancellation-nlu.test.ts,
    packages/pa-orchestrator/src/index.ts
  </files>
  <behavior>
    proactive-turn.ts:
    - Test 1: runProactiveTurn(userId, job) calls the SAME orchestrator turn entry the inbound path uses (i.e. reuses Voice v1 prompt). Test asserts the system prompt resolver is invoked with the same persona key as a regular turn — NOT a "proactive-utility" key (per D-02).
    - Test 2: synthetic input shape is `{ role: "user", content: "[system-trigger:<triggerType>] <human-readable context line>", meta: { source: "proactive", jobId, triggerType } }` — preserves Voice v1 register since downstream prompt sees a user-role utterance with system-trigger marker.
    - Test 3: output passes through Phase 20 normalizer (mock asserts normalizer is called) before enqueue (per D-11).
    - Test 4: enqueues into pa_outbound with `source: "proactive"`, `proactiveJobId: job.jobId`.
    - Test 5: writes pa_audit_events row `{ kind: "proactive_send", userId, jobId, triggerType, fireWindowHash, outboundId }` (per D-09).
    - Test 6: when `PA_PROACTIVE_DISABLED=1` env set, runProactiveTurn returns `{ skipped: true, reason: "disabled" }` without enqueueing or auditing (per D-10).

    cancellation-nlu.ts:
    - Test 7: detectProactiveCancellation matches "停止提醒", "取消提醒", "别提醒了", "stop reminders", "stop the reminders", "cancel reminders", "cancel my reminders" (case-insensitive, trim-tolerant) (per D-07, PROACTIVE-06).
    - Test 8: does NOT match unrelated text ("提醒我明天", "remind me tomorrow", "I'll stop later").
    - Test 9: orchestrator inbound pre-LLM hook (in index.ts) calls detector first; on hit, marks all user's pending pa_scheduled_jobs as `status=cancelled_by_user`, writes audit `kind=proactive_cancel`, and short-circuits to a Voice-v1-toned confirmation reply — does NOT proceed to the LLM tool-loop.
  </behavior>
  <action>
    Create `proactive-turn.ts`:
    - Import existing turn-runner from `./index.ts` (or wherever `runTurn` lives — DO NOT duplicate it).
    - Build synthetic input per Test 2 shape. The system-trigger marker keeps the model aware this is a proactive nudge while the role stays "user" so the Voice v1 mes_example few-shots still anchor (per D-02; Phase 18 Character Bible voice).
    - Wrap the existing turn entry. After the turn produces text, run it through the Phase 20 normalizer (`packages/pa-orchestrator/src/output-normalizer.ts` — exists post-Phase-20).
    - Enqueue to `pa_outbound` with `source: "proactive"` and `proactiveJobId`.
    - Write `pa_audit_events` row with `kind: "proactive_send"`, including `fireWindowHash` from `@wekruit/core-types`.
    - Honor `PA_PROACTIVE_DISABLED` env (per D-10).
    - Update `pa_scheduled_jobs.{jobId}` to `status: "fired"`, `lastFiredAt: now`. If `recurrence === "silence_rearm"`, also re-arm: `nextFireAt = now + context.windowSec*1000`, `status: "pending"` (per D-12).

    Create `cancellation-nlu.ts`:
    - `CANCELLATION_PATTERNS` const = readonly array of regex (per D-07 phrase set; investigator should anchor or use word boundaries to avoid the negative cases in Test 8).
    - `detectProactiveCancellation(text: string): boolean` runs all patterns over normalized (trimmed, lowercased for en — leave zh untouched) text.

    Wire `index.ts` (orchestrator entry):
    - At the top of inbound-turn handling, before the normal LLM tool loop, call `detectProactiveCancellation(userText)`.
    - On hit: query `pa_scheduled_jobs where userId == X and status == "pending"` → batch update to `cancelled_by_user`. Write `pa_audit_events` row `kind: "proactive_cancel"` with the count. Return a short Voice-v1-toned confirmation reply (e.g. "好的，全停了 ✋" — Adam can tune via Character Bible). Skip LLM call.

    DO NOT define a "proactive system prompt." DO NOT branch the turn entry by source. The whole point of D-02 is that proactive ≡ regular turn + synthetic input.
  </action>
  <verify>
    <automated>cd /Users/adam/Desktop/WeKruit/wekruit-pa && npm run -w @wekruit/pa-orchestrator test -- proactive-turn cancellation-nlu</automated>
  </verify>
  <done>
    runProactiveTurn reuses Voice v1 path, normalizes output, enqueues + audits, honors kill switch. Cancellation NLU catches the 7 phrase variants and short-circuits. PROACTIVE-04 + PROACTIVE-06 satisfied.
  </done>
</task>

<task type="auto" tdd="true">
  <name>Task 3: paProactiveSweep CF + Cloud Scheduler binding + idempotent dispatch</name>
  <files>
    apps/functions/src/proactive-sweep.ts,
    apps/functions/src/proactive-sweep.test.ts,
    apps/functions/src/index.ts
  </files>
  <behavior>
    - Test 1: Sweep queries `pa_scheduled_jobs where status == "pending" and nextFireAt <= Timestamp.now()` and dispatches each to runProactiveTurn (per PROACTIVE-03).
    - Test 2: Idempotency — sweep computes `fireWindowHash(jobId, nextFireAtMs)`. Before dispatch, sweep does a transactional check that no `pa_audit_events` row with this `fireWindowHash` exists. If one exists, skip + log idempotent_skip (per D-06, PROACTIVE-05).
    - Test 3: Concurrent sweep simulated — two sweep instances called back-to-back on same job → exactly one runProactiveTurn invocation. Use Firestore transaction or `claim` write of `status: running` with optimistic lock as the gate.
    - Test 4: When `PA_PROACTIVE_DISABLED=1` env set, sweep returns `{ skipped: true, reason: "disabled" }` immediately, no Firestore reads (per D-10).
    - Test 5: Dispatch failure (runProactiveTurn throws) → job moves to `status: failed`, `attempts++`. After `attempts >= maxAttempts` (default 3), `status: dead_letter`. Reuses Phase 7 backoff convention.
    - Test 6: Sweep handler is bounded — caps at 50 jobs per invocation to avoid CF timeout. Remainder picked up next minute.
  </behavior>
  <action>
    Create `apps/functions/src/proactive-sweep.ts`:
    - Export `paProactiveSweep` as Firebase Functions v2 HTTPS-callable (or onSchedule if v2 scheduler is in use elsewhere; prefer HTTPS + Cloud Scheduler OIDC for explicit user_setup parity).
    - Honor `PA_PROACTIVE_DISABLED` env first (per D-10) — early return with audit log.
    - Query: `firestore().collection(PA_COLLECTIONS.scheduledJobs).where('status','==','pending').where('nextFireAt','<=',Timestamp.now()).limit(50).get()` (per Test 6).
    - For each job, run a transaction:
      1. Re-read job inside txn.
      2. Compute `fireWindowHash(jobId, nextFireAt.toMillis())`.
      3. Check `pa_audit_events where fireWindowHash == X and kind == "proactive_send"` exists → if yes, skip (idempotent).
      4. Else, set `status: "running"` and exit txn.
    - Outside txn, call `runProactiveTurn(userId, job)` (Task 2). On success, runProactiveTurn handles status flip + audit. On error, increment `attempts`; if `attempts >= maxAttempts`, set `status: dead_letter`, else set `status: pending` with `nextFireAt = now + backoffSec*1000`.
    - Export from `apps/functions/src/index.ts` so Cloud Functions deploy picks it up.

    Cloud Scheduler binding documented in `user_setup` frontmatter (operator creates the cron in GCP Console — Claude cannot create the schedule for the prod project without prod creds). The CF code is deployable autonomously; only the cron wiring is human (per D-05).
  </action>
  <verify>
    <automated>cd /Users/adam/Desktop/WeKruit/wekruit-pa && npm run -w functions test -- proactive-sweep && npm run -w functions build</automated>
  </verify>
  <done>
    paProactiveSweep deployable; idempotent under concurrent invocation; rolls back via env flag; respects Phase 7 retry/dead-letter conventions. PROACTIVE-03 + PROACTIVE-05 satisfied.
  </done>
</task>

<task type="auto" tdd="true">
  <name>Task 4: Dashboard /triggers page — CRUD UI for user-owned triggers</name>
  <files>
    apps/dashboard-web/src/pages/Triggers.tsx,
    apps/dashboard-web/src/lib/triggers-api.ts,
    apps/dashboard-web/src/App.tsx
  </files>
  <behavior>
    - Test 1 (component test): Triggers page renders 3-tab or 3-section trigger creator (time / silence / application) with type-specific form fields matching ProactiveJobContext from Task 1.
    - Test 2: Submitting a time-anchor form writes a pa_scheduled_jobs doc with triggerType=time_anchor, computes nextFireAt = eventAt - leadTimeSec, recurrence=once, status=pending, both `nextFireAt` AND legacy `dueAt` set to same value (Phase 7 compat per Task 1).
    - Test 3: Submitting silence-anchor → recurrence=silence_rearm, nextFireAt = lastUserMsgAt + windowSec.
    - Test 4: Submitting application-followup → recurrence=once, nextFireAt = appliedAt + followupAfterSec.
    - Test 5: List view shows user's triggers with status badge ("Pending", "Fired", "Cancelled", "Failed") matching existing PA Console badge style; sorted by nextFireAt asc.
    - Test 6: Cancel button on a row sets status=cancelled_by_user and writes pa_audit_events kind=proactive_cancel (per D-09).
    - Test 7: Page is filtered to `where userId == currentSignedInUid` — operator does NOT see other users' triggers (per D-01: user-owned, not operator-driven).
  </behavior>
  <action>
    Create `apps/dashboard-web/src/lib/triggers-api.ts`:
    - Thin wrapper over Firestore SDK using existing `lib/firebase.js` pattern. Functions: `listUserTriggers(uid)`, `createTrigger(uid, input)`, `cancelTrigger(uid, jobId)`. Each writes/reads `PA_COLLECTIONS.scheduledJobs` (import from `@wekruit/core-types`).
    - Compute nextFireAt + dueAt deterministically per trigger type per Tests 2-4. `createTrigger` generates `jobId` (uuid v4), sets `createdAt`, `attempts=0`, `maxAttempts=3`, `backoffSec=60`.

    Create `apps/dashboard-web/src/pages/Triggers.tsx`:
    - Use existing PA Console design tokens / panel styles (see Operations.tsx, Users.tsx for shape — match panel layout, status badges, empty/error/loading states from Phase 3 design system).
    - 3 form sections OR 3 tabs (Claude's discretion — match Operations.tsx tab pattern if present).
    - Time-anchor form: eventLabel (text), eventAt (datetime-local), leadTimeSec dropdown (24h / 12h / 1h presets).
    - Silence-anchor form: windowSec dropdown (24h / 48h / 72h / 7d).
    - Application-followup form: companyName, jobTitle, appliedAt (datetime-local), followupAfterSec dropdown (24h / 72h / 7d).
    - List below forms: user's triggers with status badge, nextFireAt humanized, Cancel button per row (only for status=pending).
    - Empty state: "No triggers yet. Create one above to have PA reach out."

    Wire route in `apps/dashboard-web/src/App.tsx`:
    - Import `Triggers` page.
    - Add `<NavLink to="/triggers">Triggers</NavLink>` after Operations.
    - Add `<Route path="/triggers" element={<Triggers />} />` in the auth'd Routes block.

    Per D-01, this is **user-self-serve**, not operator-only. Page filters by signed-in uid.

    PROACTIVE-01 = page exists with CRUD for all 3 trigger types.
  </action>
  <verify>
    <automated>cd /Users/adam/Desktop/WeKruit/wekruit-pa && npm run -w @wekruit/dashboard-web test -- Triggers triggers-api && npm run -w @wekruit/dashboard-web build</automated>
  </verify>
  <done>
    /triggers route renders, can CRUD triggers for the signed-in user, persists to pa_scheduled_jobs in the shape Task 1 + Task 3 expect. PROACTIVE-01 satisfied.
  </done>
</task>

<task type="auto" tdd="true">
  <name>Task 5: E2E scenarios — one per trigger type</name>
  <files>
    tests/scenarios/proactive-time-anchor.yaml,
    tests/scenarios/proactive-silence-anchor.yaml,
    tests/scenarios/proactive-application-followup.yaml
  </files>
  <behavior>
    Each YAML scenario uses the existing harness (packages/pa-orchestrator/src/cli.ts) with broker injection + suppressOutbound (Phase 9 convention).

    Scenario 1 (time anchor):
    - Seed: pa_scheduled_jobs row, triggerType=time_anchor, nextFireAt=now-1s, context={ eventLabel: "面试 Acme", eventAt: now+24h, leadTimeSec: 86400 }.
    - Invoke paProactiveSweep handler in test harness.
    - Assert: pa_outbound row created with source=proactive, body passes Voice v1 + iMessage_render_safe rubric (no markdown, ≤600 chars), pa_audit_events kind=proactive_send written with fireWindowHash, job status flipped to fired.

    Scenario 2 (silence anchor):
    - Seed: silence_rearm trigger with windowSec=259200 (3d), lastUserMsgAt=now-260000s. nextFireAt computed accordingly.
    - Invoke sweep.
    - Assert: outbound enqueued, status fired, then re-armed → status pending again with nextFireAt=now+259200s.

    Scenario 3 (application followup):
    - Seed: application_followup trigger with companyName="Globex", jobTitle="SWE", appliedAt=now-260000s, followupAfterSec=259200.
    - Invoke sweep.
    - Assert: outbound enqueued, body references the company/role contextually (LLM-grade — soft assert via in_character_voice rubric ≥2/3, not literal substring), job status fired (not re-armed since recurrence=once).

    Scenario 4 (idempotency cross-cut, ride along scenario 1):
    - Invoke sweep twice on Scenario 1 seed → exactly 1 pa_outbound row, exactly 1 pa_audit_events kind=proactive_send.

    Scenario 5 (cancellation cross-cut):
    - Inject inbound user turn "停止提醒" → all user's pending jobs flip to cancelled_by_user, audit kind=proactive_cancel written, confirmation reply enqueued in Voice v1.
  </behavior>
  <action>
    Create three YAML files matching existing scenario format (look at `tests/scenarios/` for prior shape — Phase 14 added scenarios; mirror their structure).

    Each YAML must:
    - Set `suppressOutbound: false` for these specific scenarios (we want to verify outbound enqueue happens; assertions read `pa_outbound` directly rather than send real iMessage — broker remains injected).
    - Seed `pa_scheduled_jobs` rows directly via the harness `firestoreSeed` block.
    - Invoke `paProactiveSweep` via a harness hook (add hook in `packages/pa-orchestrator/src/cli.ts` if missing — small addition, call the CF handler in-process).
    - Assert against `pa_outbound`, `pa_audit_events`, and the job doc post-state.
    - For Scenario 3 voice quality, attach the existing 4-axis rubric from Phase 18 + the iMessage_render_safe axis from Phase 20.

    Idempotency (Scenario 4) and cancellation (Scenario 5) can ride along Scenario 1's seed file or be separate files — Claude's discretion. Prefer separate files for readability.

    PROACTIVE-07 = E2E for each of 3 trigger types. Scenarios 4 + 5 are bonus coverage that hardens PROACTIVE-05 + PROACTIVE-06.
  </action>
  <verify>
    <automated>cd /Users/adam/Desktop/WeKruit/wekruit-pa && npm run -w @wekruit/pa-orchestrator scenario -- tests/scenarios/proactive-time-anchor.yaml tests/scenarios/proactive-silence-anchor.yaml tests/scenarios/proactive-application-followup.yaml</automated>
  </verify>
  <done>
    All 3 trigger-type E2E scenarios pass with no real outbound, no markdown leakage, audit + idempotency + cancellation verified end-to-end. PROACTIVE-07 satisfied.
  </done>
</task>

<task type="checkpoint:human-verify" gate="blocking">
  <name>Task 6: Human verify — /triggers UX, real-time fire, cancellation phrase, kill switch</name>
  <what-built>
    Dashboard /triggers page (Task 4), paProactiveSweep CF (Task 3), orchestrator proactive turn (Task 2), 3 E2E scenarios (Task 5). Cloud Scheduler cron is the only piece Claude cannot wire end-to-end (operator must create the GCP Cloud Scheduler job per user_setup).
  </what-built>
  <how-to-verify>
    Pre-req: Operator has created the Cloud Scheduler job per user_setup frontmatter (`pa-proactive-sweep`, `* * * * *`, OIDC → paProactiveSweep).

    1. Open `https://wekruit-pa.web.app/triggers` (or local dev mirror). Sign in as a beta-allowlisted account whose iMessage number is also allowlisted. Confirm the route renders, looks consistent with rest of PA Console (matches Operations panel style), and shows empty state.

    2. Create a **time-anchor trigger** with eventLabel "Test event", eventAt = NOW + 2 minutes, leadTimeSec = 60s (so `nextFireAt ≈ NOW + 1 min`). Confirm it appears in list with status "Pending" and humanized nextFireAt.

    3. Wait up to 2 minutes. Confirm an iMessage arrives on the test phone in **Voice v1 register** (concise, no markdown asterisks, no robotic "好的，我记住了" filler — sounds like a friend nudging you). Confirm the trigger row in `/triggers` flips to "Fired".

    4. Reply "停止提醒" on iMessage. Confirm:
       a. PA replies with a short Voice-v1-toned confirmation (e.g. "好的，全停了 ✋") within ~5s.
       b. Any other pending triggers in `/triggers` flip to "Cancelled".
       c. Firestore `pa_audit_events` shows a `kind=proactive_cancel` row.

    5. Set `PA_PROACTIVE_DISABLED=1` in functions env (or use Firebase Remote Config equivalent). Create a fresh time-anchor trigger with eventAt = NOW + 90s. Wait 2 min. Confirm: iMessage does NOT arrive, trigger stays "Pending", Cloud Functions logs show `proactive_sweep skipped reason=disabled`.

    6. Spot-check `pa_audit_events` Firestore browser: every send has `jobId`, `triggerType`, `fireWindowHash`, `outboundId`. Every cancel has the count.

    7. Spot-check the silence-anchor + application-followup forms in `/triggers` — at minimum, validate they accept input and write expected schema. Full fire timing for those is exercised by Task 5 scenarios; only time-anchor needs the real iMessage round-trip in this checkpoint.
  </how-to-verify>
  <resume-signal>Type "approved" or describe issues (per-step: e.g. "step 3 failed: PA used markdown asterisks").</resume-signal>
</task>

</tasks>

<verification>
**Goal-backward truth check (must all pass):**

| Truth | Verified by |
|---|---|
| Time-anchor trigger fires at T-leadTime in Voice v1 | Task 5 Scenario 1 + Task 6 step 2-3 |
| Silence-anchor fires after silence window, re-arms | Task 5 Scenario 2 |
| Application-followup fires at T+followup | Task 5 Scenario 3 |
| Cancellation phrase shuts off all pending | Task 5 Scenario 5 + Task 6 step 4 |
| Idempotency — same trigger × fireWindow once | Task 3 Test 2/3 + Task 5 Scenario 4 |
| PA_PROACTIVE_DISABLED=1 kill switch | Task 2 Test 6 + Task 3 Test 4 + Task 6 step 5 |
| Audit logging on every send + cancel | Task 2 Test 5 + cancellation in Task 2 Test 9 + Task 6 step 6 |

**Requirement coverage:**
- PROACTIVE-01 → Task 4
- PROACTIVE-02 → Task 1
- PROACTIVE-03 → Task 3
- PROACTIVE-04 → Task 2 (proactive-turn reuses Voice v1)
- PROACTIVE-05 → Task 1 (fireWindowHash) + Task 3 (txn idempotent dispatch)
- PROACTIVE-06 → Task 2 (cancellation NLU)
- PROACTIVE-07 → Task 5 (3 E2E scenarios)

**Voice v1 non-regression:** Task 2 design (synthetic user-role input + reuse default turn entry) is the explicit lever here. Phase 18 prompt is not duplicated, not branched.

**Phase 7 non-regression:** Task 1 keeps `dueAt` field. Task 3 sweep uses Phase 7 retry/dead-letter conventions.
</verification>

<success_criteria>
1. All 5 auto tasks pass `npm test` + `npm run build` for their respective packages.
2. Task 5 E2E scenarios all green with `pa_outbound` enqueued correctly, no markdown leakage, idempotent under double-sweep, cancellation flips status.
3. Task 6 human verify approves the real iMessage round-trip + Voice v1 register + kill switch.
4. Every PROACTIVE-0N requirement has a green check in the verification matrix.
5. `pa_audit_events` shows `proactive_send` and `proactive_cancel` rows from the verify run; dashboard `/triggers` correctly filters to signed-in user.
6. Setting `PA_PROACTIVE_DISABLED=1` halts all proactive activity within 60s without redeploy.
</success_criteria>

<output>
After completion, create `.planning/phases/22-proactive-checkin/22-SUMMARY.md` summarizing:
- Schema decisions (which fields are coexisting with Phase 7 dueAt, which are net-new)
- Voice v1 reuse approach (synthetic-input pattern) and any tuning needed to confirmation reply
- Cancellation NLU phrase set + any phrases that fired false positives during Task 6
- Cloud Scheduler binding outcome (operator step done?)
- Real iMessage round-trip latency observed (sweep cadence + delivery)
- Whether silence_rearm recurrence behaved correctly under live conditions
- Phase 21 channel: did proactive sends ride macOS worker outbox or Sendblue REST? (Whichever shipped at exec time.)
- Open follow-ups for Phase 23 (closed beta) — e.g. should onboarding suggest a default trigger?
</output>
