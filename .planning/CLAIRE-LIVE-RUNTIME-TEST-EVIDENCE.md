# Claire Live Runtime Test Evidence

This file tracks real runtime evidence for `.planning/CLAIRE-LIVE-RUNTIME-TEST-GOAL.md`.

Completion requires real iMessage conversation evidence, direct Firebase/Firestore verification, fixes where needed, Node 24 deploys, and merge to `main`.

Dashboard, candidate web UI, and admin UI are out of scope for this evidence file. If a state needs verification, read Firebase/Firestore directly.

Scope update, 2026-05-16: Adam narrowed this run to Claire iMessage conversation runtime only. Dashboard, candidate-web UI, admin UI, login, resume upload UI, and browser-based QA are out of scope. Normal onboarding, layoff onboarding, job prescreen, safety/privacy/abuse, job matching conversation, everyday catchup, automated outbound, session lifecycle, memory, tags, and direct Firestore proof remain in scope for the full runtime goal.

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
| Normal candidate onboarding | LIVE_DONE_FOR_COLLISION_AND_RESUME_COMPLETION | Real iMessage location-answer rerun after prescreen pause advanced to resume ask; real resume-on-file reply completed onboarding | `pa-users.pipelineState.completed=true`, `onboardingStatus=active`, clean ended `workSession` | Found and fixed prescreen recent-terminal guard, existing-resume detection, resume completion language, generic completion noise, and stale workSession merge behavior. |
| Layoff onboarding | NOT_STARTED | Missing | Baseline shows active layoff workSession | Must verify shared `pa-users` state, `layoffContext`, and session boundaries. |
| Job prescreen strong candidate | LIVE_DONE | Real iMessage rerun reached `PASS` after repeated probes | Session, memory, user workSession, candidate-job-state verified | See Flow 4 rerun. |
| Job prescreen adjacent/fragmented | LIVE_DONE | Real iMessage rerun reached PASS after adjacent/fragmented answers | Session, turns, memory, candidate-job-state, user workSession, and prior-session supersede verified | Runtime fixes deployed on Node 24; visible salary-copy defect remains in job data/copy. |
| Job prescreen weak candidate | LIVE_DONE | Real iMessage weak run probed repeatedly before `HARD_STOP` | Session, memory tags, and user/candidate state verified | No false positive skill tags were added. |
| Pause/restart/supersede | LIVE_DONE | Real iMessage restart, opt-out send failure, natural pause, and clean pause rerun verified | User-level `workSession`, session boundary, inbound status, and memory event verified | See Flow 6 and Flow 7. |
| Privacy/abuse/security | NOT_STARTED | Missing | Missing | Must be tested through real iMessage and direct Firestore state. |
| Rate limit/opt-out/suppression/cooldown | PRESCREEN_PARTIAL | `Stop` provider opt-out produced real send failure; `START` restored test line | Send-failed session ended with `boundary=send_failed` | Broad rate-limit/cooldown not tested in this narrowed run. |
| Job matching conversation | NOT_STARTED | Missing | Missing | Must be tested through real iMessage and direct Firestore state. |
| Everyday catchup | NOT_STARTED | Missing | Missing | Must be tested through real iMessage and direct Firestore state. |
| Automated outbound | NOT_STARTED | Missing | Missing | Must be tested through real iMessage and direct Firestore state. |
| Firestore runtime observability | LIVE_DONE_FOR_PRESCREEN | Every live prescreen state was checked via Firestore snapshot | `pa-prescreen-sessions`, `pa-users.workSession`, `pa-inbound-events`, `pa-prescreen-memory-events` | Dashboard not used as evidence. |

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

## Flow 5 Evidence: Weak Candidate Probing Before Hard Stop

Verified directly in Firestore: 2026-05-16T17:42:27.991Z

Runtime:

- Node: `v24.3.0`
- Candidate: `pa-users/U7AwKT8nLDRa35DkuBxq`
- Job: `rain-software-engineer-fullstack-8849f6ef`
- Session: `pa-prescreen-sessions/ps_rain-software-engineer-fullstack-8849f6ef_U7AwKT8nLDRa35DkuBxq_20260516T173357669Z`

Conversation shape:

- Candidate repeatedly stated no production full-stack/API ownership and described support ops, Zendesk exports, Sheets tagging, and manual Slack summaries.
- Claire did not reject after the first weak answer. It asked for the closest project, what the candidate personally owned, the failure mode, validation, and any measurable result.
- After repeated weak/non-software evidence, Claire terminaled with `HARD_STOP`.

Persisted proof:

- Session has `terminal=HARD_STOP`, `terminalReason=MUST_HAVE failed at qId=role_fit s=0.15 c=0.78`, and `currentQId=null`.
- Memory update summary: `Mostly support ops reporting; no production full-stack/API ownership or web stack.`
- Evidence tags were only `job_prescreen`; no false positive `frontend_development`, `data_workflows`, `debugging_workflows`, or `operator_tools` tags were derived from the fullstack job id alone.

Residual defect:

- `pa-candidate-job-states/U7AwKT8nLDRa35DkuBxq__rain-software-engineer-fullstack-8849f6ef` remained `state=employer_visible` from the older PASS session `ps_...163931336Z`. This run did not change the product policy for whether a later hard-stop should override a prior pass snapshot.

## Flow 6 Evidence: Session Start, Supersede, Send Failure, And Natural Pause

Verified directly in Firestore and Messages: 2026-05-16T18:49:11.433Z

Runtime defects found and fixed:

- Fresh prescreen start previously used a merge write for `pa-users/{uid}.workSession`, leaving stale nested `endedAt` / `terminal` fields. Fixed by replacing the whole user-level workSession on start.
- Terminal action previously skipped user-level repair if `pa-users/{uid}.workSession` pointed to a stale ended older session. Fixed so the current terminal repairs stale ended state unless a newer active different prescreen exists.
- Coalescer synthetic inbound rows were left `status=pending`. Fixed so processed synthetic rows are marked `status=completed` with `routedTo=prescreen` or the Claire route.
- If opener send failed with `OPTED_OUT`, a fresh session could remain active. Fixed so send failure marks the session and user workSession as `terminal=PAUSE`, `terminalReason=send_failed: OPTED_OUT`, `workSession.status=ended`, `boundary=send_failed`.

Live evidence:

- Session `ps_rain-software-engineer-fullstack-8849f6ef_U7AwKT8nLDRa35DkuBxq_20260516T180927191Z` was superseded by `ps_...182503261Z` with `boundary=superseded`.
- Session `ps_rain-software-engineer-fullstack-8849f6ef_U7AwKT8nLDRa35DkuBxq_20260516T182503261Z` failed opener send because the test line had been carrier-opted-out by a literal `Stop`.
- Firestore after fix showed that failed-send session ended cleanly: `terminal=PAUSE`, `terminalReason=send_failed: OPTED_OUT`, `currentQId=null`, `workSession.status=ended`, `boundary=send_failed`.
- After `START`, the line accepted new messages. Later prescreen turns routed through the coalescer and synthetic inbound rows showed `status=completed`, while original fragments showed `status=coalesced`.

Natural pause bug found:

- In session `ps_rain-software-engineer-fullstack-8849f6ef_U7AwKT8nLDRa35DkuBxq_20260516T183308045Z`, the candidate sent `Pause this screen for now please.` at 2:38 PM.
- Before the fix, Claire treated it as an off-topic answer and replied: `Quick one--what project are you thinking of when you say "pause"? ...`
- This produced a bad scored turn: `s=0`, `c=0.95`, summary `No relevant skills or examples; reply is a pause request.`

Fix and retest:

- `prescreen-turn-handler.ts` now treats natural imperative pause/stop/end phrases that reference this screen/role/interview/prescreen as user-exit routing, not scoring input.
- At 2:45 PM, the same phrase produced the correct reply: `Got it - I paused this role screen. If you want to continue later, reopen it from the job page; I will keep what you have already shared on your profile.`
- Firestore then showed session `ps_...183308045Z` as `terminal=PAUSE`, `terminalReason=user_exit`, `currentQId=null`, `workSession.status=ended`, `boundary=user_exit`.
- User-level `pa-users/U7AwKT8nLDRa35DkuBxq.workSession` pointed to the same session and also ended with `boundary=user_exit`.

## Flow 7 Evidence: Clean Post-Deploy Pause Archive And Memory Hygiene

Verified directly in Messages and Firestore: 2026-05-16T19:01:29.398Z

Runtime:

- Node: `v24.3.0`
- Deploy target: `onPaInbound`, `paCoalesceBufferSweep`, `paMessageCoalescer`, `paSendblueWebhook`
- Full Firebase predeploy test result: `1713/1713` passing.
- Targeted regression test result before deploy: `90/90` passing.

Live iMessage transcript summary:

- Trigger sent at 2:57 PM: `WeKruit_rain-software-engineer-fullstack-8849f6ef_U7AwKT8nLDRa35DkuBxq_Job`
- Claire opened: `Hi - Claire from Rain. Quick screen for Software Engineer - Fullstack. What recent work best matches this software engineering role?`
- Candidate sent two separate messages:
  - `Closest is not pure production full-stack but I owned OFO Delivery ops tooling JavaScript admin screens SQL reports and small Node scripts for failed orders.`
  - `It touched merchant order dashboards and Slack summaries ops used it twice daily and repeated dispatch escalations dropped about 30%.`
- Coalescer merged those two messages into one prescreen turn.
- Claire advanced to the next question: `Which required skill are you strongest in, and what is a concrete example of using it?`
- Candidate sent `Pause this screen for now please.`
- Claire replied with the correct pause copy. The pause message also received a love tapback, confirming the real tapback path was active in this live run.

Persisted proof:

- Latest session: `pa-prescreen-sessions/ps_rain-software-engineer-fullstack-8849f6ef_U7AwKT8nLDRa35DkuBxq_20260516T185719399Z`
- Session fields:
  - `terminal=PAUSE`
  - `terminalReason=user_exit`
  - `currentQId=null`
  - `score=0.72`
  - `workSession.status=ended`
  - `workSession.boundary=user_exit`
  - `workSession.endedAt=2026-05-16T19:00:32.868Z`
- User-level `pa-users/U7AwKT8nLDRa35DkuBxq.workSession`:
  - `kind=job_prescreen`
  - `sessionId=ps_rain-software-engineer-fullstack-8849f6ef_U7AwKT8nLDRa35DkuBxq_20260516T185719399Z`
  - `status=ended`
  - `boundary=user_exit`
  - `terminal=PAUSE`
  - `endedAt=2026-05-16T19:00:33.038Z`
- Latest prescreen turn:
  - `qId=role_fit`
  - action `advance` from `role_fit` to `technical_depth`
  - score `s=0.72`, `c=0.74`
  - summary `Owned JS/Node ops tooling with SQL reports and dashboards; improved dispatch escalations ~30%.`
- Pause turn:
  - `qId=technical_depth`
  - action `terminal`, `terminal=PAUSE`, `reason=user_exit`
  - `scored=null`
- Latest memory event:
  - `pa-prescreen-memory-events/ps_rain-software-engineer-fullstack-8849f6ef_U7AwKT8nLDRa35DkuBxq_20260516T185719399Z`
  - `terminal=PAUSE`
  - summary `Owned JS/Node ops tooling with SQL reports and dashboards; improved dispatch escalations ~30%.`
  - No pause text and no `No relevant skills...` off-topic summary were archived.
- Inbound events:
  - Two answer fragments: originals `status=coalesced`, synthetic merged row `status=completed`, `routedTo=prescreen`, `coalesceTurnId=U7AwKT8nLDRa35DkuBxq__107`.
  - Pause: original `status=coalesced`, synthetic row `status=completed`, `routedTo=prescreen`, `coalesceTurnId=U7AwKT8nLDRa35DkuBxq__108`.

Code-level memory hygiene fix:

- `prescreen-terminal-action.ts` now filters user-exit-like replies out of memory event `recentReplies`.
- It also excludes scored entries whose abort hint is `off_topic` or `decline` before building PAUSE/PASS/FAIL/HARD_STOP memory summaries.
- Regression test `does not archive user-exit off-topic scoring as profile evidence on PAUSE` covers the exact failure shape found in the 2:38 PM live bug.

Remaining known data artifact:

- The pre-fix PAUSE memory event for session `ps_rain-software-engineer-fullstack-8849f6ef_U7AwKT8nLDRa35DkuBxq_20260516T183308045Z` was created before the memory hygiene patch and may still contain the old off-topic pause summary. The latest post-deploy event is clean, and PAUSE does not overwrite `pa-users.lastPrescreenMemoryUpdate`.

## Flow 1 Evidence: Normal Onboarding After Prescreen Pause

Verified directly in Messages and Firestore: 2026-05-16T19:22:17.112Z

Runtime:

- Node: `v24.3.0`
- Candidate: `pa-users/U7AwKT8nLDRa35DkuBxq`
- Starting state before this test: no active prescreen; latest job prescreen session `ps_rain-software-engineer-fullstack-8849f6ef_U7AwKT8nLDRa35DkuBxq_20260516T185719399Z` had already ended with `terminal=PAUSE`, `terminalReason=user_exit`.
- User onboarding state before this test: `onboardingState=q_location_asked`, `pipelineState.currentQId=q_location`.

Live bug found:

- At 3:13 PM, candidate sent: `For location I am targeting the US mostly New York or remote and I can do SF hybrid for strong startup roles.`
- Claire incorrectly replied: `Got it. This role screen is already paused; I will keep that constraint on your profile and use it for better-matched roles.`
- Firestore showed inbound `inb_d88b4256fe0c190c192931632460cc2c48483ad6` with `routedTo=prescreen`.
- This proved the recent-terminal prescreen guard was stealing a normal onboarding answer after a prescreen pause.

Fix deployed:

- `apps/functions/src/prescreen-turn-handler.ts` now checks the canonical `pa-users/{uid}` state before applying the recent-terminal guard.
- If onboarding is incomplete and the new reply does not look like a continuation of the just-ended role screen, the prescreen guard yields so onboarding can own the turn.
- Regression test added: `yields a recent paused prescreen to an incomplete onboarding location answer`.
- Targeted test result: `91/91` passing.
- Full Firebase predeploy test result: `1713/1713` passing.
- Deployed with Node `v24.3.0` to `onPaInbound`, `paMessageCoalescer`, `paCoalesceBufferSweep`, and `paSendblueWebhook`.

Live rerun proof:

- At 3:22 PM, candidate sent: `Still same profile preference New York remote or SF hybrid for strong startup roles.`
- Claire replied: `btw — can you send me your resume? makes JD review and referrals way more on-point`
- Firestore inbound `inb_58e92ddffa9a544556e61fb0c2d82e1068e5e070`:
  - `status=succeeded`
  - not `routedTo=prescreen`
  - `completedAt=2026-05-16T19:22:17.112Z`
- User state after rerun:
  - `onboardingState=q_resume_asked`
  - `pipelineState.currentQId=q_resume`
  - `pipelineState.collected.q_location=["nyc","remote","sf","hybrid"]`
  - `tags.targetLocations=["new_york_metro","remote_united_states","san_francisco_bay_area"]`
  - `tags.targetCountry=["usa"]`

Remaining normal-onboarding residuals:

- User-level `workSession` still points to the ended job prescreen (`kind=job_prescreen`, `status=ended`, `boundary=user_exit`) instead of an explicit active/ended normal-onboarding session boundary.
- `resumeAccepted` was stamped at `2026-05-16T19:22:16.486Z` with `triggerHash=onboarding_ask_q_resume`, but `pa-resume-artifacts` returned no docs for this user while `parsedCandidateResumes/019MaM207IdXVMKlHuGY` exists. Canonical resume-state detection still needs a separate live fix before Flow 1 can be marked `LIVE_DONE`.

## Flow 1 Rerun Evidence: Existing Resume Completion

Verified directly in Messages and Firestore: 2026-05-16T20:26:40.547Z

Runtime:

- Node: `v24.3.0`
- Candidate: `pa-users/U7AwKT8nLDRa35DkuBxq`
- Test sender: `+13054507715`
- Candidate phone: `+14243201960`
- Deploy target: `onPaInbound`, `paCoalesceBufferSweep`, `paMessageCoalescer`, `paSendblueWebhook`
- Full Firebase predeploy test result: `1713/1713` passing.
- Targeted orchestrator regression test result: `38/38` passing.
- Targeted functions regression test result: `91/91` passing before the completion-status patch; full deploy precheck covered the final bundled code.

Live bugs found before the final fix:

- At 3:36 PM and 3:46 PM, candidate said the resume was already on file (`Adam-Yang-Resume.pdf`), but Claire re-asked for an iMessage attachment. Root cause: `q_resume` did not recognize explicit existing-resume references and only checked one resume artifact collection.
- At 4:01 PM, after the first recovery patch, Claire accepted the existing resume but sent mixed-language and noisy completion copy:
  - `嗯 我读一下, 一两分钟的事`
  - `got everything I need — running the match now ✓`
  - Chinese summary copy.
- Firestore after the 4:01 PM run also preserved stale nested job-prescreen keys in `workSession` because the completion update used `set(..., { merge: true })`.

Runtime fixes deployed:

- `packages/pa-orchestrator/src/onboarding/judges/resume.ts`: detects explicit existing-resume phrases and also checks `parsedCandidateResumes.where("userId","==", uid)`.
- `packages/pa-orchestrator/src/onboarding/runtime-bridge.ts`: resume-accepted copy uses the active turn language first, not stale or missing stored preference.
- `packages/pa-orchestrator/src/onboarding/questions.ts` and `pipeline.ts`: `q_resume` suppresses generic terminal completion copy while still running the resume post-collect flow.
- `packages/pa-orchestrator/src/onboarding.ts`: completed onboarding normalizes `onboardingStatus=active` and replaces the whole `workSession` map so stale prescreen `sessionId`, `jobId`, and `terminal` keys are removed.
- `apps/functions/build.mjs`: Firebase bundle resolves local workspace packages from the current worktree, preventing deploys from accidentally bundling the original repo symlinked package.

Live rerun proof:

- Reset at `2026-05-16T20:25:04.384Z` intentionally put the user back into `onboardingState=q_resume_asked`, `pipelineState.currentQId=q_resume`, `pipelineState.lang=en`, and a stale ended job-prescreen `workSession` with `sessionId=ps_live_reset_stale_work_session`.
- At 4:25 PM, candidate sent: `The resume is already on file please use the parsed Adam-Yang-Resume.pdf and move my profile forward.`
- Claire replied with exactly the resume flow and no generic completion:
  - `ok lemme take a quick look at your resume, brb`
  - `looks like c++ / java / javascript / python / c# + Software Engineer Intern @ Tesla Inc. — pulling matches in that lane`
- No Chinese copy appeared in the live transcript.
- No `got everything I need — running the match now` generic completion appeared in the live transcript.
- No resume re-ask appeared in the live transcript.

Persisted proof:

- Latest inbound event `pa-inbound-events/inb_69ccd5c0c8c03022846e0f22d3647716fef592d1`:
  - `status=succeeded`
  - `fromNumber=+14243201960`
  - `toNumber=+13054507715`
  - `completedAt=2026-05-16T20:25:50.297Z`
- Latest outbounds for that inbound:
  - `outbound-pipeline-inb_69ccd5c0c8c03022846e0f22d3647716fef592d1-q_resume-cv_interim_ack`
  - `outbound-pipeline-inb_69ccd5c0c8c03022846e0f22d3647716fef592d1-q_resume-cv_summary_tag`
  - No `x-completion` outbound was created for the latest inbound.
- User state after rerun:
  - `onboardingState=complete`
  - `onboardingStatus=active`
  - `pipelineState.currentQId=null`
  - `pipelineState.completed=true`
  - `pipelineState.lang=en`
  - `pipelineState.collected.q_resume=[]`
- User-level `workSession` after rerun:
  - `kind=layoff_onboarding`
  - `status=ended`
  - `boundary=complete`
  - `currentState=complete`
  - No stale `sessionId`, `jobId`, or `terminal` keys from the intentionally seeded prescreen state.

Remaining Flow 1 boundary:

- This proves the collision recovery path and resume-on-file completion path for the canonical user. A full fresh-user normal onboarding from empty state is still a separate live scenario if the broader runtime goal is expanded beyond the current narrowed conversation-runtime slice.
