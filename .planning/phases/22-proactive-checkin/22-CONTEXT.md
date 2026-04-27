---
phase: 22-proactive-checkin
type: context
captured: 2026-04-27
owner: adam
locked: true
---

# Phase 22 — Proactive Check-in (Context)

Revival of skipped Phase 12. Closed-beta P1 (post-beta unless Adam pulls forward). Hard dependency on Phase 18 (Voice v1) shipping first — proactive turns must use the companion voice, not a robotic utility register.

## Goal

PA reaches out proactively based on **user-defined triggers**. Trigger-based, opt-in, NOT cron-based broadcast. Three trigger types only:

1. **Time anchor** — "interview Monday, remind me Sunday" → fire at T−24h
2. **Silence anchor** — "if I'm quiet 3 days, ping me" → fire when `(now − lastUserMsg) > 72h`
3. **Application follow-up** — "3 days post-apply at company X, nudge me" → fire at T+72h

## Decisions (locked, non-negotiable)

- **D-01:** Triggers are user-owned, defined via dashboard `/triggers` UI page. **Not** operator-driven, **not** cron-broadcast. (Adam direction 2026-04-27.)
- **D-02:** Proactive turn reuses **Phase 18 Voice v1 system prompt**. No separate "proactive utility" prompt. Implementation = synthetic system input ("trigger fired: <context>") routed through the same orchestrator entry as a normal turn.
- **D-03:** Exactly 3 trigger types in v1: `time_anchor`, `silence_anchor`, `application_followup`. No generic cron, no recurring weekly nudges in this phase.
- **D-04:** Storage = existing `pa_scheduled_jobs` collection (already declared in `packages/core-types/src/collections.ts:43`). Schema gets formalized fields in Phase 22 — no new collection.
- **D-05:** Sweep cadence = **1 minute** Cloud Scheduler cron invoking new CF `paProactiveSweep`. Latency budget: trigger fires within ≤60s of `nextFireAt`.
- **D-06:** **Idempotency by `(jobId, fireWindowHash)`** — fireWindowHash is `sha1(jobId + floor(nextFireAt / 60s))`. Same trigger × same fireWindow cannot enqueue twice even on sweep overlap or retry.
- **D-07:** Cancellation = iMessage NLU intent. Orchestrator detects "停止提醒" / "stop reminders" / "取消提醒" / "cancel reminders" on inbound user turn → marks all of user's `status=pending` jobs as `status=cancelled_by_user`. Confirmed back in same turn.
- **D-08:** Outbound channel: enqueue into existing `pa_outbound`. If Phase 21 (Sendblue) has shipped, Phase 21's CF send path picks it up automatically. If Phase 21 deferred, macOS worker outbox handles it. Phase 22 does not branch on channel — it just enqueues.
- **D-09:** Audit: every proactive send writes a `pa_audit_events` row with `kind=proactive_send`, includes `jobId`, `triggerType`, `fireWindowHash`, `outboundId`. Every cancellation writes `kind=proactive_cancel`.
- **D-10:** Rollback: env flag `PA_PROACTIVE_DISABLED=1` short-circuits `paProactiveSweep` (returns immediately, logs skip) and short-circuits orchestrator proactive-turn path. Allows kill-switch without redeploy.
- **D-11:** Output normalization: proactive turn output passes through Phase 20 normalizer like any other turn. No special path.
- **D-12:** Recurrence: `recurrence` field exists in schema but v1 only supports `recurrence: "once"`. Time anchors and application follow-ups are one-shot. Silence anchors recur (re-arm after fire) — implemented as the sweep handler re-computing `nextFireAt = now + windowSec` post-send.
- **D-13:** Goal-backward verification covers PROACTIVE-01 through PROACTIVE-07 — all 7 requirements traceable to a task.

## Deferred Ideas (must NOT appear in plans)

- Recurring weekly/monthly cadences beyond silence-anchor re-arm
- Operator-defined broadcast triggers (announcements to all users)
- Trigger templates / trigger marketplace
- Smart trigger suggestions ("we noticed you applied 5 jobs, want a follow-up trigger?")
- Multi-step trigger flows (if X then Y then Z)
- Snooze / "remind me again in 1h" inline
- Cross-user trigger dependencies
- Push notification fallback if iMessage delivery fails
- A/B testing different proactive opener phrasings
- Trigger analytics dashboard (open rate, response rate)

## Claude's Discretion

- Exact field names within `context: { ... }` per trigger type (must be self-describing)
- Dashboard `/triggers` page visual layout (must match existing PA Console design system — see `apps/dashboard-web/src/styles.css` and `App.tsx` shell)
- Form validation strategy (client-side React Hook Form vs. plain controlled inputs — match existing pages)
- E2E test harness extension shape — must use `pa-orchestrator/src/cli.ts` scenario harness from Phase 14
- NLU pattern detection — regex/keyword vs. cheap LLM classifier (prefer regex for the v1 Chinese + English short-phrase set; cheap and deterministic)

## Hard Dependencies

- **Phase 18 (Voice v1)** — proactive turn voice. Plan must NOT regress Voice v1 system prompt; orchestrator proactive-turn path is a thin wrapper around the existing turn entry, not a parallel prompt.
- **Phase 20 (Output Normalizer)** — proactive output passes through normalizer.
- **`pa_scheduled_jobs` collection** — schema constant exists; concrete field shape formalized this phase.
- **Phase 7 scheduler conventions** — `pa_scheduled_jobs` exists from Phase 7 with `dueAt/status/attempts/maxAttempts/backoff`. Phase 22 layers proactive-specific fields (`triggerType`, `userId`, `nextFireAt`, `recurrence`, `context`) on top — must NOT collide.

## Soft Dependencies

- **Phase 21 (Sendblue)** — if shipped, proactive sends route through Sendblue REST. If not, macOS worker outbox. Phase 22 stays channel-agnostic.

## Codebase Pointers

- `pa_scheduled_jobs` constant: `packages/core-types/src/collections.ts:43`
- Orchestrator entry: `packages/pa-orchestrator/src/index.ts`
- Dashboard shell + routing: `apps/dashboard-web/src/App.tsx`
- Dashboard pages dir: `apps/dashboard-web/src/pages/`
- CF entry: `apps/functions/src/index.ts`
- Scenario harness: `packages/pa-orchestrator/src/cli.ts`
- Voice v1 character bible: `.planning/phases/18-companion-voice-v1/CHARACTER-BIBLE-v1.md`

## Success = closed-beta-grade

User can self-serve a trigger from `/triggers`, walk away, and have PA reach out at the right moment in Voice v1 register. User can shut it off with one Chinese-or-English phrase. Operator sees full audit. Kill switch works.
