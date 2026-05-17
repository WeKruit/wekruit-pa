# Claire iMessage Runtime Conversation Test Goal

## Supersedes Older Goal Wording

This file is the current source of truth for the next `/goal` run.

It intentionally supersedes the older broader wording:

```text
Execute .planning/CLAIRE-LIVE-RUNTIME-TEST-GOAL.md using real iMessage/candidate-web conversations only as completion evidence, verifying Firestore + dashboard for every flow, fixing/deploying with Node 24, and merging all fixes to main.
```

That old wording is no longer the active scope because it mixes separate UI/dashboard/candidate-web work back into this runtime conversation goal.

Current scope:

- In scope: Claire iMessage conversation runtime, session lifecycle, routing, persona/probing quality, long/short-term memory, tags, job prescreen, onboarding, layoff onboarding, safety/privacy/abuse, job matching conversation, catchup/outbound behavior, Firestore proof, fixes, Node 24 deploy, merge to `main`.
- Out of scope: dashboard QA, admin UI, candidate web UI, login, resume upload UI, visual design, browser-based flow testing.
- Verification source: real iMessage transcript + direct Firebase/Firestore reads.
- Not accepted as completion evidence: candidate-web screenshots, dashboard screenshots, simulator-only results, unit tests alone, or Firestore stress tests alone.

This goal exists because unit tests, integration tests, and Firestore-only stress runners are not enough.

Completion requires real iMessage conversation testing across Claire's candidate runtime. Test suites are backup evidence only.

Dashboard, candidate web UI, and admin UI are out of scope for this goal. If a state needs verification, read Firebase/Firestore directly.

## Short Goal Prompt

```text
/goal Execute .planning/CLAIRE-LIVE-RUNTIME-TEST-GOAL.md as the current source of truth. This file supersedes older wording that required candidate-web/dashboard verification. Focus only on Claire iMessage conversation runtime: normal onboarding, layoff onboarding, job prescreen, safety/privacy/abuse, job matching conversation, everyday catchup, automated outbound, session lifecycle, memory, tags, and Firestore state. Do not use dashboard/UI/browser checks as completion evidence. Use Node 24, real iMessage, direct Firebase/Firestore verification, deploy fixes, and merge to main.
```

## Current Context For The Next Codex Run

This goal has been narrowed. The next executor must not drift back into dashboard, candidate-web UI, login, resume upload UI, or admin-page QA. Those were separate work. This goal is only about Claire's iMessage conversation runtime and the Firestore state that proves the runtime behaved correctly.

Primary live test thread:

- iMessage conversation with Claire sender number `+13054507715`.
- Do not use `+13054507716`; it is not an active allowed test number.
- Canonical user: `pa-users/U7AwKT8nLDRa35DkuBxq`.
- Canonical email: `indolencorlol@gmail.com`.
- Primary job trigger token: `WeKruit_rain-software-engineer-fullstack-8849f6ef_U7AwKT8nLDRa35DkuBxq_Job`.
- Primary job id: `rain-software-engineer-fullstack-8849f6ef`.
- Node must be `v24.x` for scripts, tests, deploys, and Firebase verification.

Known verified live run:

- Session `pa-prescreen-sessions/ps_rain-software-engineer-fullstack-8849f6ef_U7AwKT8nLDRa35DkuBxq_20260516T150746279Z` is a real iMessage adjacent/fragmented prescreen that reached `PASS`.
- It wrote `pa-prescreen-memory-events/{sessionId}`.
- It wrote `pa-candidate-job-states/U7AwKT8nLDRa35DkuBxq__rain-software-engineer-fullstack-8849f6ef`.
- It wrote `pa-employer-visible-profiles/rain-software-engineer-fullstack-8849f6ef__U7AwKT8nLDRa35DkuBxq`.
- Details are recorded in `.planning/CLAIRE-LIVE-RUNTIME-TEST-EVIDENCE.md`.

Known bug fixed in the latest live run:

- `pa-users/U7AwKT8nLDRa35DkuBxq.workSession` no longer remains stuck on stale layoff onboarding after the Rain fullstack prescreen.
- Latest verified session: `ps_rain-software-engineer-fullstack-8849f6ef_U7AwKT8nLDRa35DkuBxq_20260517T020903710Z`.
- Verified final user work session: `kind=job_prescreen`, `status=ended`, `boundary=terminal`, `terminal=PASS`.
- Treat this as a regression check in future runs, not the first unresolved blocker.

Latest salary-sentinel and URL reveal live proof:

- Latest verified live PASS session: `ps_rain-software-engineer-fullstack-8849f6ef_U7AwKT8nLDRa35DkuBxq_20260517T215442235Z`.
- Visible iMessage PASS reveal rendered the Rain job details URL: `https://www.rain.xyz/careers?ashby_jid=8849f6ef-86e6-464d-9f40-62f8355d40fb#open-roles`.
- Visible iMessage PASS reveal did not include the old open-ended salary sentinel `$50000-999000/yr`, `999000`, or `999k`.
- Firestore verified `terminal=PASS`, user work session ended, memory event exists, candidate job state is `employer_visible`, and employer-visible profile points to this session.

Required execution style:

- Stop at the first customer-visible or Firestore-state divergence, debug root cause, fix, deploy, and rerun that live path.
- Do not tune prompts as a substitute for fixing routing/session/state ownership bugs.
- Do not mark a flow done from unit tests, simulator tests, or Firestore-only stress tests.
- Every completed flow needs a real iMessage transcript review plus exact Firestore doc ids and fields in `.planning/CLAIRE-LIVE-RUNTIME-TEST-EVIDENCE.md`.

Conversation persona requirement:

- Claire should act like a recruiter friend learning the candidate's experience.
- For weak or adjacent answers, Claire must probe for closest relevant projects, ownership, systems touched, tradeoffs, measurable outcome, and constraints before concluding.
- A hard stop is allowed only after repeated attempts make the mismatch clear.
- Each new job prescreen trigger starts an independent work session; old prescreen/onboarding context must not bias the new session.
- At session end, update/archive memory and tags without creating false positive skill tags from negative evidence.

## Captured Next Runtime Architecture Requirement

This is not a request to derail the current iMessage-only execution, but it must be preserved for the next prescreen-runtime phase:

- Prescreen runtime needs its own short-term memory/session context, separate from long-term candidate memory. The runtime should remember the current job/company/culture requirements, current question, recent candidate answers, and probe attempts within one work session.
- The runtime core must be interface-stable: iMessage, future voice, dashboard/operator tools, and any candidate web surface should call the same prescreen session API/state machine instead of forking logic per channel.
- Adding voice should improve the interface without changing core scoring/session/memory behavior. Voice input/output should be an adapter around the same runtime contract, not a second prescreen product.
- Dashboard UI for prescreen should be a later surface over the same runtime state: job context, user profile/evidence, company culture/context, active question, transcript, probe rounds, score reasons, terminal decision, and memory/tag updates.
- Runtime changes must be tested at the core contract level first, then live-tested through iMessage and voice adapters. A UI/dashboard test alone cannot prove runtime correctness.
- Prescreen should include a candidate-question moment near the end, e.g. "Do you have any questions for me about the role, company, process, or what happens next?" Claire should answer from approved job/company context and avoid unsupported claims.

## Hard Acceptance Rule

A flow is not complete unless it has all required evidence:

- Real conversation evidence: real iMessage only, not mocked outbound and not browser/candidate-web chat.
- Firestore evidence: exact docs and fields for session, turns, profile, memory, tags, state, outbound, suppression, or rate-limit records.
- Synthetic canary evidence: rate-limit, abuse, suppression, cooldown, and similar seeded canaries are mechanics proof only unless they are run in a clean candidate thread and read naturally as a real user conversation. If they are run in the canonical candidate thread with artificial setup text, clearly exclude them from transcript-quality pass evidence.
- No dashboard/UI evidence requirement: dashboard, candidate web UI, and admin UI are already considered outside this goal.
- Transcript quality review: Claire must sound like a recruiter friend probing candidate experience, not a rigid form, not an abrupt judge.
- User identity guard: use canonical test identity unless the scenario explicitly tests controlled user creation.
- No accidental user growth: `pa-users` count must not grow unless the scenario explicitly covers approved import/create behavior with cleanup.
- Node 24: all commands, tests, scripts, deploys, and verification must use Node 24.
- Source of truth: deploy fixes and merge to `main` before calling the goal complete.

## Canonical Live Test Identity

- Candidate id: `pa-users/U7AwKT8nLDRa35DkuBxq`
- Candidate email: `indolencorlol@gmail.com`
- Candidate auth/browser profile is not part of this goal.
- Candidate phone on profile: verify directly in Firestore before each live run
- Active Claire sender number: `+13054507715`
- Do not use `+13054507716` unless explicitly testing the wrong-number/disabled-number path.
- Primary live prescreen job token:
  - `WeKruit_rain-software-engineer-fullstack-8849f6ef_U7AwKT8nLDRa35DkuBxq_Job`

## Status Key

- `NOT_STARTED`: no real conversation run.
- `LIVE_PARTIAL`: some real iMessage evidence, but missing terminal, Firestore, memory/tag/state checks, transcript review, or edge cases.
- `LIVE_DONE`: real iMessage conversation, Firestore, memory/tag/state checks, and transcript review complete.
- `BLOCKED`: cannot complete without fixing a bug or missing configuration.

## Flow 1: Normal Candidate Onboarding

Goal: regular candidate entry should create or continue one candidate profile, collect open-ended answers, update reusable profile evidence, and feed matching without job-specific leakage.

Live cases:

1. Returning candidate continues onboarding through iMessage.
2. Candidate answers in multiple short messages.
3. Candidate gives open-ended preference answers, not exact enum values.
4. Candidate edits/corrects a previous answer.
5. Candidate asks what Claire knows about them.
6. Candidate asks to pause onboarding.

Edge cases to verify:

- No duplicate `pa-users` row.
- No rigid enum-only question where open answer should be accepted.
- Country is collected before narrower city/remote preference.
- Resume-derived facts are not overwritten by weak chat facts.
- Tags update only with evidence.
- Work session has clear start/end boundary.
- Normal onboarding does not steal an active job prescreen turn.
- Profile state is readable directly from Firestore.

Required Firestore checks:

- `pa-users/{uid}`
- `pa-users/{uid}.tags`
- `pa-users/{uid}.conversationDerivedPreferences`
- `pa-users/{uid}.workSession`
- `pa_messages` or active conversation/session collection used by the runtime
- outbound rows if Claire sends any message

Current status: `LIVE_DONE`

## Flow 2: Layoff Onboarding

Goal: layoff-specific entry must still use shared `pa-users`, not a parallel candidate product. It should collect layoff context and mark the candidate for layoff-aware matching/outreach.

Live cases:

1. `WeKruit_LAID_OFF` trigger starts layoff onboarding from the allowed sender.
2. Candidate enters layoff context: company, title, location, email, LinkedIn, resume if applicable.
3. Candidate answers with messy/free-form text.
4. Candidate pauses and restarts.
5. Candidate already has a profile and enters layoff flow.
6. Candidate sends a job prescreen trigger while layoff onboarding is active.

Edge cases to verify:

- Uses `pa-users`, not `layoff_candidates`.
- Writes `source: "WeKruit_Laid_Off"` only when appropriate.
- Writes `layoffContext` and `lastLaidOffAt`.
- Writes/updates `layoff_phone_index`.
- Does not create a duplicate candidate for the same canonical identity.
- Active job prescreen has priority over layoff onboarding.
- Layoff onboarding resumes only when no active prescreen owns the turn.
- Layoff candidate state is readable directly from Firestore.

Required Firestore checks:

- `pa-users/{uid}`
- `pa-users/{uid}.source`
- `pa-users/{uid}.layoffContext`
- `pa-users/{uid}.lastLaidOffAt`
- `layoff_phone_index/p_{hash}`
- `pa-outbound`
- `pa-users/{uid}` direct Firestore verification for layoff candidate state

Current status: `LIVE_DONE`

## Flow 3: Job Prescreen - Strong Candidate

Goal: strong candidate should pass after concise but real probing, then write terminal state, memory, candidate-job state, employer-visible profile, tags/evidence, and Firestore-visible reasons.

Live cases:

1. Send real iMessage job trigger.
2. Candidate gives strong role-fit answer.
3. Candidate gives concrete technical depth answer.
4. Candidate answers hard filters: location, compensation, sponsorship.
5. Claire reaches `PASS`.

Edge cases to verify:

- Claire probes enough, but does not over-question when evidence is sufficient.
- Early location/comp/visa answers carry forward and are not re-asked.
- Terminal `PASS` writes candidate-job state.
- Employer-visible profile exists only after pass.
- Profile memory updates without overwriting stronger resume facts.
- Firestore shows pass, transcript turns, evidence, and employer-visible snapshot.

Required Firestore checks:

- `pa-prescreen-sessions/{sessionId}`
- `pa-prescreen-sessions/{sessionId}/turns`
- `pa-prescreen-memory-events/{sessionId}`
- `pa-candidate-job-states/{uid}_{jobId}` or actual keyed doc
- `pa-employer-visible-profiles`
- `pa-users/{uid}.lastPrescreenMemoryUpdate`
- `pa-users/{uid}.tags`

Current status: `LIVE_DONE`

## Flow 4: Job Prescreen - Adjacent Or Fragmented Candidate

Goal: candidate with partial/adjacent evidence should be probed like a friend, allowed to answer in multiple texts, and recover to pass if the details become strong.

Live cases:

1. Candidate initially says they have not owned an exact fullstack system.
2. Candidate gives closest relevant project.
3. Candidate sends multiple messages quickly.
4. Claire coalesces/understands the full answer.
5. Claire probes for ownership, systems touched, failure/tradeoff, and outcome.
6. Candidate eventually provides enough evidence to advance or pass.

Edge cases to verify:

- No repeated identical question.
- No abrupt "not fit" after one weak answer.
- Claire changes probe angle each round.
- Coalescing preserves multi-message context.
- Session current question and clarify rounds update correctly.
- Old unrelated conversation memory does not bias the session.
- Strong later evidence overrides weak initial framing.

Required Firestore checks:

- active session current question
- turns with merged/coalesced replies
- clarify count by question
- scored evidence per question
- terminal state or explicit reason if not terminal yet
- `pa-prescreen-sessions/{sessionId}/turns`

Current status: `LIVE_DONE`

Known live evidence:

- Real iMessage reruns verified routing, repeated non-identical probes, multi-message coalescing, terminal `PASS`, memory/tag writes, candidate-job state, employer-visible snapshot, and transcript quality for the Rain fullstack job.

## Flow 5: Job Prescreen - Weak Or Clearly Unqualified Candidate

Goal: weak candidate should still get multiple chances to explain closest experience before a graceful hard stop. Hard stop should keep candidate in global pool and must not create an employer-visible profile.

Live cases:

1. Candidate gives weak/non-engineering answer.
2. Claire asks for closest project.
3. Candidate gives still-weak support/spreadsheet/ticket-coordination answer.
4. Claire probes a few times for concrete owned systems.
5. Claire reaches graceful `HARD_STOP` only after sufficient attempts.

Edge cases to verify:

- No immediate rejection after one answer.
- Hard stop text is respectful and candidate-retention oriented.
- No false positive skill tags from job id.
- Candidate remains in global pool.
- No employer-visible profile.
- Candidate-job state is not passed.
- Firestore shows not-passed reason and transcript turns.

Required Firestore checks:

- `pa-prescreen-sessions/{sessionId}.terminal = HARD_STOP`
- clarify rounds count
- `pa-prescreen-memory-events/{sessionId}`
- no employer-visible profile for this session
- candidate-job state
- `pa-users.lastPrescreenMemoryUpdate`
- no false positive `software_engineering` / `fullstack_engineering` tags from negative evidence

Current status: `LIVE_DONE`

## Flow 6: Job Prescreen Pause, End, Restart, And Supersede

Goal: every job screen is an independent work session with clear start/end/archive behavior.

Live cases:

1. Candidate sends `PAUSE`.
2. Claire acknowledges pause.
3. Old session ends and archives memory.
4. New trigger after pause starts fresh session.
5. New trigger while an old session is still active supersedes the old session.
6. Reply after terminal session does not fall into stale prescreen.

Edge cases to verify:

- `PAUSE` archives session-specific memory but does not overwrite stronger long-term memory.
- New session does not inherit old current question.
- Old active session ends with `boundary = superseded` when applicable.
- Old paused/terminal session does not catch later normal onboarding replies.
- Firestore shows old and new sessions distinctly.

Required Firestore checks:

- old/new `pa-prescreen-sessions`
- `workSession.status`
- `workSession.boundary`
- `pa-prescreen-memory-events/{sessionId}`
- `pa-users.lastPrescreenMemoryUpdate`
- old/new session transcript turns

Current status: `LIVE_DONE`

Known live evidence:

- `PAUSE` and restart after pause are live-verified.
- Active-session supersede is live-verified through a later real prescreen trigger that superseded the previous active session and wrote `boundary=superseded`.

## Flow 7: Privacy, Abuse, Security, Guardian

Goal: Claire must handle unsafe/off-path conversations safely in real conversation, not just in test suites.

Live cases:

1. Candidate asks what data WeKruit stores.
2. Candidate asks to delete or export data.
3. Candidate sends abusive message.
4. Candidate asks for another candidate's private data.
5. Candidate asks for system prompt/secrets/internal implementation.
6. Candidate asks Claire to bypass employer or safety rules.

Edge cases to verify:

- No unauthorized personal data disclosure.
- No secrets/system prompt disclosure.
- Privacy request writes proper intake/state doc if applicable.
- Abuse does not crash session or create bad tags.
- Guardian/safety response is concise and redirects appropriately.
- Active prescreen state remains coherent after an off-path safety turn.

Required Firestore checks:

- privacy request docs if created
- safety/guardian audit docs if present
- inbound/outbound rows
- active session state before/after
- no unexpected profile tag mutation

Current status: `LIVE_DONE`

## Flow 8: Rate Limit, Opt-Out, Suppression, And Cooldown

Goal: real or production-canary conversation must prove Claire does not spam and respects stop controls.

Live cases:

1. Candidate sends rapid repeated messages.
2. Candidate sends `STOP` or opt-out phrase.
3. Candidate tries to resume after opt-out.
4. Automated outbound attempts while suppression is active.
5. Automated outbound attempts while active prescreen/onboarding is active.

Edge cases to verify:

- Rate-limit doc/state is written.
- Suppression/cooldown blocks sends.
- Active work session blocks unrelated proactive outbound.
- No duplicate outbound rows for the same trigger.
- User-facing response is clear.

Required Firestore checks:

- inbound rate-limit records
- suppression/cooldown docs
- `pa-outbound`
- send/do-not-send reason
- active session state

Current status: `LIVE_DONE`

## Flow 9: Job Matching Conversation

Goal: when candidate asks about jobs, Claire should use profile/matching state, explain safely, and avoid pretending stale or unavailable jobs are live.

Live cases:

1. Candidate asks "what jobs do you have for me?"
2. Candidate asks why a job matches.
3. Candidate rejects a job and gives preference feedback.
4. Candidate asks about a specific job.
5. Candidate asks for jobs while an active prescreen is in progress.

Edge cases to verify:

- Matching uses canonical `pa-users` profile/tags.
- Job recommendations only show public/live eligible jobs.
- Every visible job recommendation must include a candidate-usable URL and a requirements line; callers must use the shared job-recommendation message item interface rather than ad hoc formatting.
- Feedback updates matching preference/evidence.
- Active prescreen blocks or defers unrelated matching conversation appropriately.
- Matching reason/evidence updates in Firestore where applicable.

Required Firestore checks:

- `pa-candidate-job-matches`
- `pa-users.tags`
- preference/evidence fields
- job rec cache or outbound docs
- Firestore-visible match reason/evidence

Current status: `LIVE_DONE`

## Flow 10: Everyday Catchup

Goal: Claire can check in with retained candidates without colliding with active sessions or suppression.

Live cases:

1. Candidate receives or triggers everyday catchup.
2. Candidate replies with new preference or status.
3. Candidate is in active prescreen and catchup should not interrupt.
4. Candidate is suppressed/opted out and catchup should not send.

Edge cases to verify:

- Catchup has candidate value, not generic spam.
- Active work session blocks catchup.
- Cooldown prevents repeated sends.
- Candidate reply updates reusable memory/tags only when evidence supports it.
- Firestore profile fields show updated candidate context.

Required Firestore checks:

- lifecycle trigger decision
- cooldown/suppression state
- outbound row or no-send audit
- profile memory/tag fields

Current status: `LIVE_DONE`

## Flow 11: Automated Outbound

Goal: automated outbound should have explicit send/do-not-send decisions, respect cooldown/suppression, and never bypass active sessions.

Live cases:

1. Candidate is eligible for matched job outbound.
2. Candidate is blocked by active work session.
3. Candidate is blocked by cooldown.
4. Candidate is blocked by suppression/opt-out.
5. Candidate receives outbound and replies.

Edge cases to verify:

- Decision is persisted with reason.
- One outbound per intended trigger.
- Reply routes to correct flow.
- No raw private employer/candidate data leaks.
- Firestore records expose outbound decision.

Required Firestore checks:

- `pa-outbound`
- outbound decision/audit docs
- suppression/cooldown docs
- session routing after reply
- matching state if outbound is job-related

Current status: `LIVE_DONE`

## Flow 12: Firestore Runtime Observability

Goal: every important runtime state created by iMessage conversations must be directly verifiable in Firebase/Firestore.

Live cases:

1. Read candidate profile after normal onboarding.
2. Read layoff candidate state after layoff onboarding.
3. Read active prescreen transcript turns.
4. Read passed prescreen/employer-visible profile.
5. Read hard-stopped/not-passed prescreen.
6. Read paused/restarted prescreen sessions.
7. Read outbound/suppression/cooldown reason.

Edge cases to verify:

- Reads are scoped to the canonical user for user-wise tests.
- State does not rely on hardcoded `WeKruit collaborated` or hardcoded pass state.
- Firestore separates global candidate facts from job-specific evidence.
- Transcript turns and score reasons are stored accurately.

Required Firestore checks:

- `pa-users/{uid}`
- `pa-prescreen-sessions/{sessionId}`
- `pa-prescreen-sessions/{sessionId}/turns`
- `pa-prescreen-memory-events/{sessionId}`
- `pa-candidate-job-states`
- `pa-employer-visible-profiles`
- outbound/suppression/cooldown docs if relevant

Current status: `LIVE_DONE`

## Required Execution Order

1. Snapshot baseline: `pa-users` count, canonical user doc, active sessions, suppression/cooldown state, and active sender-number state.
2. Run normal onboarding live conversation.
3. Run layoff onboarding live conversation.
4. Run job prescreen live matrix: strong, adjacent/fragmented, weak, pause/restart/supersede.
5. Run safety/privacy/abuse/security live canaries.
6. Run job matching conversation live canary.
7. Run everyday catchup and automated outbound canaries.
8. Verify every resulting state directly in Firebase/Firestore.
9. Fix bugs immediately when a live divergence appears.
10. Deploy changed functions/sites with Node 24.
11. Merge to `main`.
12. Write final evidence table with exact doc ids, transcript snippets, Firestore fields, failures, and fixes.

## Final Report Format

The final report must include:

- Scenario name.
- Status: `LIVE_DONE`, `LIVE_PARTIAL`, `BLOCKED`, or `NOT_STARTED`.
- Conversation channel and timestamp.
- Exact candidate id, job id, session id, memory event id, state doc id.
- Firestore proof summary.
- Firebase/Firestore proof summary.
- Transcript quality verdict.
- Bugs found.
- Fix commit/deploy status.
- Remaining risk.
