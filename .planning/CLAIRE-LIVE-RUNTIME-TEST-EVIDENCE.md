# Claire Live Runtime Test Evidence

This file tracks real runtime evidence for `.planning/CLAIRE-LIVE-RUNTIME-TEST-GOAL.md`.

Completion requires real iMessage conversation evidence, direct Firebase/Firestore verification, fixes where needed, Node 24 deploys, and merge to `main`.

Dashboard, candidate web UI, and admin UI are out of scope for this evidence file. If a state needs verification, read Firebase/Firestore directly.

## Baseline Snapshot

Captured: 2026-05-16T15:30:05.814Z

Runtime:

- Node: `v24.3.0`
- Firebase project: `wekruit-5f89b`
- `pa-users` count: `602`
- Canonical candidate: `pa-users/U7AwKT8nLDRa35DkuBxq`
- Canonical email: `indolencorlol@gmail.com`
- Candidate phone: `+14243201960`
- Active Claire sender: `+13054507715`
- Sendblue pool: only `+13054507715` is active; `+13054507716` is not in the active pool.

Identity checks:

- `emailLower == indolencorlol@gmail.com`: no docs returned.
- `email == indolencorlol@gmail.com`: `U7AwKT8nLDRa35DkuBxq`.
- `phoneE164 == +14243201960`: `U7AwKT8nLDRa35DkuBxq`.
- `layoff_phone_index/p_wrcjs0`: exists and points to `U7AwKT8nLDRa35DkuBxq`.
- No duplicate canonical user found by exact email or phone.

Canonical user state:

- `source`: `WeKruit_Laid_Off`
- `onboardingState`: `q_location_asked`
- `onboardingStatus`: `in_progress`
- `candidateLifecycleState`: `claimed`
- `workSession`: `kind=layoff_onboarding`, `status=active`, `boundary=e2e_resume_after_pending_trigger_fix`
- `pipelineState.currentQId`: `q_location`
- `pipelineState.collected`: role, YoE, visa, startup preference, and country are present.
- `pipelineState.attempts.q_location`: `4`
- `layoffContext`: null
- `tags`: present with resume/chat/matching keys including `skills`, `industryEnum`, `targetCountry`, `targetLocations`, `visaStatus`, `yoeRange`, and `workHistorySummary`.
- `conversationDerivedPreferences.prescreenEvidenceByJob`: present.

Prescreen baseline:

- Active prescreen:
  - `pa-prescreen-sessions/ps_rain-software-engineer-fullstack-8849f6ef_U7AwKT8nLDRa35DkuBxq_20260516T150746279Z`
  - `jobId=rain-software-engineer-fullstack-8849f6ef`
  - `currentQId=role_fit`
  - `terminal=null`
  - `createdAt=updatedAt=2026-05-16T15:07:46.279Z`
- Candidate job state for `U7AwKT8nLDRa35DkuBxq_rain-software-engineer-fullstack-8849f6ef`: missing.
- Recent memory events include prior `PASS`, `HARD_STOP`, and `PAUSE` sessions, but those are not accepted as completion evidence for the new goal unless reverified in the live matrix.
- Current `lastPrescreenMemoryUpdate` is a `HARD_STOP` summary from session `ps_rain-software-engineer-fullstack-8849f6ef_U7AwKT8nLDRa35DkuBxq_20260516T133957146Z`.

Outbound/inbound baseline:

- Recent outbound includes old onboarding re-asks, including `q_location` prompts and older rigid prompts such as `startup / bigtech / either`.
- Recent inbound has several `pending` rows and completed `prescreen` rows.
- `pa-rate-limits` exists with historical sample docs; canonical-user specific rate limit was not yet inspected.

Important baseline finding:

- The canonical user is not in a clean generic-onboarding state. It has an active layoff onboarding `workSession` and an active job prescreen at the same time.
- This is exactly the kind of state-arbitration case the live test goal is meant to verify. Do not mark normal onboarding, layoff onboarding, or prescreen flows complete until this collision is exercised and the resulting transcript plus Firestore state are checked.

## Scenario Evidence Table

| Flow | Status | Live iMessage evidence | Firestore evidence | Notes |
| --- | --- | --- | --- | --- |
| Normal candidate onboarding | NOT_STARTED | Missing | Baseline shows candidate stuck at `q_location` | Need live continuation and direct `pa-users`/session checks. |
| Layoff onboarding | NOT_STARTED | Missing | Baseline shows active layoff workSession but no fresh live run in this goal | Need `WeKruit_LAID_OFF` live run and shared `pa-users` verification. |
| Job prescreen strong candidate | NOT_STARTED | Missing | Active session exists but no fresh strong run in this goal | Need live trigger or continue active session through `PASS`. |
| Job prescreen adjacent/fragmented | LIVE_DONE | Real iMessage rerun reached PASS after adjacent/fragmented answers | Session, turns, memory, candidate-job-state, user workSession, and prior-session supersede verified | Runtime fixes deployed on Node 24; visible salary-copy defect remains in job data/copy. |
| Job prescreen weak candidate | NOT_STARTED | Missing | Prior `HARD_STOP` exists but not accepted as this goal evidence | Need fresh weak run with multiple probes. |
| Pause/restart/supersede | LIVE_PARTIAL | Prior pause/restart live evidence exists | Baseline active session can be used for supersede test | Need active supersede live verification. |
| Privacy/abuse/security | NOT_STARTED | Missing | Missing | Need live canaries. |
| Rate limit/opt-out/suppression/cooldown | NOT_STARTED | Missing | Only historical rate-limit samples inspected | Need safe live canaries and Firestore checks. |
| Job matching conversation | NOT_STARTED | Missing | Missing | Need live ask and matching-state checks. |
| Everyday catchup | NOT_STARTED | Missing | Missing | Need canary with cooldown/session blocking evidence. |
| Automated outbound | NOT_STARTED | Missing | Missing | Need send/do-not-send decisions and reply routing. |
| Firestore runtime observability | NOT_STARTED | Missing | Missing | Need direct reads for every resulting state. |

## Flow 4 Evidence: Adjacent Or Fragmented Fullstack Prescreen

Verified directly in Firestore: 2026-05-16T15:54:04.217Z

Runtime:

- Node: `v24.3.0`
- Candidate: `pa-users/U7AwKT8nLDRa35DkuBxq`
- Job: `rain-software-engineer-fullstack-8849f6ef`
- Session: `pa-prescreen-sessions/ps_rain-software-engineer-fullstack-8849f6ef_U7AwKT8nLDRa35DkuBxq_20260516T150746279Z`
- Candidate job state: `pa-candidate-job-states/U7AwKT8nLDRa35DkuBxq__rain-software-engineer-fullstack-8849f6ef`
- Employer-visible snapshot: `pa-employer-visible-profiles/rain-software-engineer-fullstack-8849f6ef__U7AwKT8nLDRa35DkuBxq`
- Memory event: `pa-prescreen-memory-events/ps_rain-software-engineer-fullstack-8849f6ef_U7AwKT8nLDRa35DkuBxq_20260516T150746279Z`

Conversation shape:

- Candidate started with adjacent/non-exact evidence: had not owned a fullstack product end-to-end; closest work was OFO Delivery merchant/order tooling.
- Candidate then sent fragmented follow-up evidence across multiple messages: JavaScript dashboard screens, SQL failure buckets, scripts joining order events to dispatch status, and ops impact.
- Claire did not immediately reject after the weak first answer; it clarified twice on `role_fit`, then advanced when the fragmented evidence reached the threshold.
- Candidate later gave stronger technical depth: React/TypeScript-style UI, typed issue/order models, API client calls to a Node endpoint, and normalized order failure rows.
- Claire asked and accepted hard-filter answers for location, compensation, and sponsorship.

Turn proof:

- `role_fit` first reply scored `s=0.15`, `c=0.62`, action `clarify`, summary: adjacent merchant/order tooling; no end-to-end fullstack ownership or stack details.
- `role_fit` second reply scored `s=0.62`, `c=0.66`, action `clarify`, summary: JS dashboard + SQL tooling; limited evidence of fullstack React/TS/Next.
- `role_fit` third reply scored `s=0.72`, `c=0.74`, action `advance`, summary: JS dashboard + SQL/event tooling with ops impact; lacks full end-to-end ownership.
- `technical_depth` reply scored `s=0.86`, `c=0.82`, action `advance`, summary: strong React/TypeScript frontend example with typed models and API integration.
- `location_alignment`, `compensation_alignment`, and `sponsorship_status` each scored `s=1`, `c=0.95`.
- Terminal action: `PASS`, reason `ratio=0.916 threshold=0.65`, score `4.58`.

Persisted proof:

- Session has `terminal=PASS`, `currentQId=null`, and `workSession.status=ended`, `workSession.boundary=terminal`.
- Memory event exists with terminal `PASS`, evidence tags `job_prescreen`, `frontend_development`, `data_workflows`, `debugging_workflows`, `operator_tools`.
- `pa-users.lastPrescreenMemoryUpdate` points to this session and contains the same recent replies and scored summaries.
- Candidate-job state is `state=employer_visible`, `reason=passed_snapshot_refreshed`, and points to this session.
- Employer-visible profile exists and points to this session.

Bug found:

- `pa-users/U7AwKT8nLDRa35DkuBxq.workSession` still shows stale `kind=layoff_onboarding`, `status=active`, `boundary=e2e_resume_after_pending_trigger_fix` even though the active job prescreen terminaled with its own ended work session.
- This can incorrectly suppress or route future iMessage conversations because user-level work-session state disagrees with prescreen-session state.

## Flow 4 Rerun Evidence After Runtime Fixes

Verified directly in Firestore: 2026-05-16T16:55:45.198Z

Runtime fixes deployed:

- `apps/functions/src/prescreen-session-start.ts`: job prescreen start now claims `pa-users/{uid}.workSession` with `kind=job_prescreen`, `status=active`, `sessionId`, `jobId`, and `boundary=trigger`.
- `apps/functions/src/prescreen-terminal-action.ts`: terminal actions now end the matching user-level job work session with `boundary=terminal`; superseded sessions end with `boundary=superseded`.
- `apps/functions/src/coalesce/buffer.ts`: active prescreen turns use a prescreen-specific hard cap so narrative answers can span multiple iMessages without the generic chat cap splitting the answer.
- Deployed with Node `v24.3.0` to `functions:pa-orchestrator:onPaInbound`, `functions:pa-orchestrator:paSendblueWebhook`, and `functions:pa-orchestrator:paMessageCoalescer`.

Live iMessage transcript summary:

- Trigger sent to `+13054507715`: `WeKruit_rain-software-engineer-fullstack-8849f6ef_U7AwKT8nLDRa35DkuBxq_Job`.
- New session started: `pa-prescreen-sessions/ps_rain-software-engineer-fullstack-8849f6ef_U7AwKT8nLDRa35DkuBxq_20260516T163931336Z`.
- Previous active session `...20260516T162256723Z` was superseded with `terminal=PAUSE`, `terminalReason=superseded_by_new_prescreen_session:ps_...163931336Z`, and `workSession.boundary=superseded`.
- Candidate started adjacent/weak: no production fullstack product end-to-end; mostly product ops, dashboards, SQL reports, scripts.
- Claire did not hard-stop. It probed for closest project, personal ownership, systems touched, broken edge case, measurable outcome, and then advanced to hard filters.
- Candidate answered across multiple iMessages. The fast two-message ownership/systems answer was merged into one Firestore turn with newline-joined text.
- Random love tapbacks appeared on useful answers, including compensation and intermediate technical answers.
- Claire reached terminal `PASS` and sent contact handoff.

Turn proof:

- `role_fit` had repeated probes before advancing:
  - First weak answer: `s=0.15`, `c=0.7`, action `clarify`.
  - Closest-project answer: `s=0.35`, `c=0.62`, action `clarify`.
  - Two-message UI/SQL/Node answer: `s=0.62`, `c=0.66`, action `clarify`.
  - Outcome answer: `s=0.72`, `c=0.74`, action `advance` to `technical_depth`.
- `technical_depth`:
  - First detailed stale-status answer: `s=0.35`, `c=0.55`, action `clarify`.
  - Explicit React-style UI + Node API + SQL answer: `s=0.72`, `c=0.78`, action `advance` to `location_alignment`.
- `location_alignment`: `s=0.85`, `c=0.78`, action `advance`.
- `compensation_alignment`: `s=1`, `c=0.9`, action `advance`.
- `sponsorship_status`: `s=1`, `c=0.98`, action `terminal`, terminal `PASS`, reason `ratio=0.858 threshold=0.65`.

Persisted proof:

- Session `ps_rain-software-engineer-fullstack-8849f6ef_U7AwKT8nLDRa35DkuBxq_20260516T163931336Z`:
  - `terminal=PASS`
  - `currentQId=null`
  - `score=4.29`
  - `workSession.status=ended`
  - `workSession.boundary=terminal`
  - `workSession.endedAt=2026-05-16T16:54:52.532Z`
- User `pa-users/U7AwKT8nLDRa35DkuBxq.workSession`:
  - `kind=job_prescreen`
  - `sessionId=ps_rain-software-engineer-fullstack-8849f6ef_U7AwKT8nLDRa35DkuBxq_20260516T163931336Z`
  - `status=ended`
  - `boundary=terminal`
  - `terminal=PASS`
  - `endedAt=2026-05-16T16:54:54.745Z`
- User `lastPrescreenMemoryUpdate`:
  - `sessionId=ps_rain-software-engineer-fullstack-8849f6ef_U7AwKT8nLDRa35DkuBxq_20260516T163931336Z`
  - `terminal=PASS`
  - Summary includes owned merchant dashboard/triage workflow, fullstack debugging, remote/NY hybrid, comp alignment, and future H-1B need.
  - Evidence tags: `job_prescreen`, `frontend_development`, `data_workflows`, `debugging_workflows`, `operator_tools`.
- Memory event `pa-prescreen-memory-events/ps_rain-software-engineer-fullstack-8849f6ef_U7AwKT8nLDRa35DkuBxq_20260516T163931336Z` exists with `terminal=PASS` and the same summary.
- Candidate job state `pa-candidate-job-states/U7AwKT8nLDRa35DkuBxq__rain-software-engineer-fullstack-8849f6ef`:
  - `state=employer_visible`
  - `reason=passed_snapshot_refreshed`
  - `prescreenSessionId=ps_rain-software-engineer-fullstack-8849f6ef_U7AwKT8nLDRa35DkuBxq_20260516T163931336Z`.

Residual defects / follow-up:

- Terminal SMS copy displayed salary as `$50000-999000/yr`, which is visibly unpolished and likely comes from job data formatting. This is outside the current runtime-session fix but must be corrected before broad production use.
- Firestore snapshot helper currently shows synthetic/coalescer-created inbound rows with `status=pending` while corresponding original rows are `status=coalesced` and routed to `prescreen`. The runtime processed correctly, but dashboard/observability cleanup should make these synthetic rows less confusing.
