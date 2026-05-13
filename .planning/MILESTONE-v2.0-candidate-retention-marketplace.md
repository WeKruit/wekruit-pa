# Milestone v2.0 - Candidate Retention Marketplace Roadmap

**Status:** Planning baseline, 2026-05-13.
**Canonical product memory:** `README.md` -> "Product Blueprint: Candidate Retention Marketplace".
**Operating lock:** This milestone extends v1.9 candidate journey closure into the final C-end candidate retention marketplace. Do not reduce it back to a job page, pre-screen bot, or employer ATS.

## 0. Mission

Build WeKruit into a C-end candidate retention marketplace:

1. Every candidate who enters the system becomes durable global supply.
2. Every job that enters the system becomes enriched demand.
3. Matching runs in both directions: candidate -> jobs and job -> candidates.
4. New jobs can automatically activate historical candidates through Sendblue outbound.
5. Claire gives the first interview once a candidate enters a job flow, regardless of initial match score.
6. Employers only see passed candidate profiles until Adam explicitly expands scope.
7. Every outcome, HITL correction, and behavioral signal improves the tagging, matching, eval, and recommendation flywheel.

## 1. Current Baseline

The active baseline is the v1.9 worktree:

`/Users/adam/Desktop/WeKruit/wekruit-pa/.claude/worktrees/frosty-wozniak-84b965`

Relevant shipped or near-shipped capabilities:

- C-end domain split: `candidate.wekruit.com` and `pa.wekruit.com` serve `apps/pa-landing`; admin remains `wekruit-pa.web.app`.
- Public job page `/j/:jobId` with inline CV upload and iMessage trigger.
- `paPublicCvIngest` HTTP CF for public resume upload.
- `paAtsInboundWebhook` and Handshake adapter path.
- `PreScreenPipeline` for first interview.
- `PiiConfirmPipeline` for PII and Level 1 collection.
- `generateJobRecs` and v1.6 match cascade.
- Sendblue pool routing and sticky user assignment.
- Admin surfaces for job prescreen config, ATS inbound, Sendblue pool, match debug, canonical tags, QA evaluator, prescreen feedback.
- Canonical shared tag system in `packages/shared-tags`.

Known planning constraints:

- v1.9 branch is ahead of `origin/main`; use it as the marketplace planning base until merged.
- Candidate routes must not return to the admin domain.
- v1.6 match/tag decisions are locked and should not be re-litigated.
- User durable facts are global; job outcomes are per-job.

## 2. Product Invariants

These invariants hold across every sprint:

1. Candidate is the durable asset. Job is a demand event.
2. Global candidate data includes mem0, tags, PII, Level 1 info, resume, LinkedIn, YoE, visa, salary range, location preference, industry preference, company size preference, outreach preferences, and conversation-derived preferences.
3. Job-specific data includes match score, invite, prescreen, outcome, employer-visible snapshot, and next-stage status.
4. Match score never blocks the first interview.
5. NOT_PASS does not remove a candidate from the marketplace.
6. Employer view is passed-profile-only.
7. User tags and job tags share the same canonical vocab.
8. LLM extracts, judges, and composes; deterministic reducers own state transitions.
9. HITL edits become auditable correction events and regression/eval artifacts.
10. Sendblue outreach is capacity-aware, cooldown-aware, opt-out-aware, and sticky by candidate.

## 3. Single-Point Lead Operating Model

The lead owns one coherent system model across product, backend, eval, flywheel, and UIUX. Executors can own disjoint write scopes, but the lead owns integration, scope boundaries, and acceptance.

### Lead Artifacts

The lead maintains:

- `README.md` product blueprint
- this v2.0 milestone roadmap
- sprint decision log
- data model map
- state-machine spec
- UI surface map
- eval matrix
- HITL queue spec
- flywheel event catalog
- acceptance ledger

### Sprint Rules

Each sprint must be a vertical marketplace capability, not an isolated frontend/backend/eval ticket. Every sprint must define:

- Product outcome
- Candidate UIUX impact
- Admin/employer UIUX impact
- Backend/data source of truth
- Eval/regression coverage
- HITL path
- Flywheel events produced
- Acceptance criteria

### Integration Gates

No sprint is complete unless:

1. Data ownership and lifecycle are documented.
2. State transitions are deterministic and tested.
3. UI surfaces show enough state for an operator to debug without terminal logs.
4. Eval or simulation covers the main happy path and one failure path.
5. HITL edits, if any, write correction events.
6. Existing v1.9 candidate journey still works.
7. C-end routes remain on candidate domain.

## 4. Executor Topology

The lead should split execution by disjoint ownership:

| Executor | Ownership | Primary write scope |
|---|---|---|
| A. Candidate Profile | identity, `/me`, global profile state | `apps/pa-landing`, `packages/core-types`, profile APIs |
| B. Resume/Bulk Intake | PDF upload, employer bulk upload, parse status | `apps/functions/src/public-cv-ingest.ts`, bulk ingest CFs, dashboard upload page |
| C. Job Enrichment | raw job -> enriched demand, question generation | job enrichment packages/CFs, `pa-jobs`, admin job UI |
| D. Tagging System | canonical vocab, user/job tag maintenance, backfill | `packages/shared-tags`, tag worker, canonical tags dashboard |
| E. Matching Repo | candidate -> jobs and job -> candidates ranking | `apps/job-rec`, matching debug APIs, eval fixtures |
| F. Outreach | Sendblue accounts, cooldowns, outbound policy | `apps/functions/src/sendblue`, outreach service, Sendblue admin UI |
| G. Interview Runtime | first interview, PII/Level1, outcome state | `packages/pa-orchestrator`, prescreen CFs |
| H. Employer Surface | passed profiles only | `apps/dashboard-web`, employer-visible snapshots |
| I. Quality Plane | HITL, eval, regression, simulation, audit | tests, eval apps, QA dashboards, correction events |

## 5. Roadmap At A Glance

| Sprint | Capability | Main outcome |
|---|---|---|
| S0 | Baseline Integration | v1.9 marketplace base is clean, merged or explicitly tracked, and verified. |
| S1 | Marketplace Data Foundation | Global candidate, candidate-job, correction, feedback, and employer-visible profile primitives exist. |
| S2 | Identity + Candidate Claim | Email magic-link claim and handle merge make one global profile per candidate. |
| S3 | Bulk Resume Intake | Employer can upload emails + PDFs; PDFs extract email and create/merge global profiles. |
| S4 | Job Enrichment | New jobs become enriched demand with tags, questions, rubrics, Claire brief, eval fixtures. |
| S5 | Two-Way Matching | Matching supports candidate -> jobs and job -> candidates with debug/eval. |
| S6 | Outreach Platform | Sendblue capacity-aware outbound can activate retained candidates safely. |
| S7 | First Interview + Passed Surface | Activated candidates get first interview; passed profiles become employer-visible. |
| S8 | Flywheel + HITL + Eval | Human corrections and outcomes feed regression, ranking, tags, and QA loops. |
| S9 | Production Hardening + Scale | Privacy, observability, live smoke, account scaling, and launch readiness are complete. |

## 6. Sprint Details

### S0 - Baseline Integration

**Goal:** Establish a clean, trusted v1.9 base for all v2.0 marketplace work.

Product outcome:

- The team agrees that current v1.9 candidate flow is the starting point.
- Candidate domain split, public job page, CV upload, first interview, PII/Level1, and job recommendations are preserved.

Candidate UIUX:

- `/`, `/j/:jobId`, `/legal` remain public on candidate domain.
- Inline CV upload remains on the job page.

Admin UIUX:

- Existing admin pages remain reachable: job prescreen, ATS inbound, Sendblue pool, match debug, canonical tags, QA evaluator.

Backend/data:

- Confirm v1.9 collections and trigger paths.
- Reconcile branch/worktree status into one working base.
- Document dirty files and non-v2.0 unrelated changes.

Eval/regression:

- Run `pnpm --filter pa-orchestrator test`.
- Run `pnpm test` in `apps/functions`.
- Run v1.9 public route curl checks.
- Run at least one simulated full-flow job path.

HITL:

- No new HITL yet; just preserve existing operator pages.

Flywheel:

- Define the initial feedback/correction event catalog for later sprints.

Acceptance:

- v1.9 tests green.
- Candidate public URLs green.
- `paPublicCvIngest` health shape green.
- README/CLAUDE/AGENTS point to the marketplace blueprint and this roadmap.

### S1 - Marketplace Data Foundation

**Goal:** Create the source-of-truth primitives needed by all later marketplace work.

Product outcome:

- The system distinguishes global candidate profile from per-job opportunity state.

Candidate UIUX:

- No large new surface required.
- If simple, add profile-state readout to `/me` placeholder or internal debug page.

Admin UIUX:

- Add or extend a candidate profile inspector showing global fields vs job-specific states.

Backend/data:

- Define schemas/types for:
  - `CandidateProfile`
  - `CandidateHandle`
  - `ResumeArtifact`
  - `CandidateLifecycleState`
  - `CandidateJobState`
  - `CandidateJobMatch`
  - `OutboundInvite`
  - `EmployerVisibleProfile`
  - `FeedbackEvent`
  - `CorrectionEvent`
- Add deterministic reducers for global candidate state and candidate-job state.
- Add audit/event writes for state transitions.
- Add Firestore rules/indexes for new collections.

Eval/regression:

- Unit tests for reducers.
- Schema parse tests.
- Cross-user isolation tests for profile reads.

HITL:

- Define correction event schema even before the UI is complete.

Flywheel:

- Feedback/correction events become append-only first-class records.

Acceptance:

- Reducers cover all states in README blueprint.
- No LLM function writes lifecycle state directly.
- Existing v1.9 flow still works.

### S2 - Identity + Candidate Claim

**Goal:** One real person maps to one global profile across PDF, phone, browser uid, Sendblue, and future ATS.

Product outcome:

- Candidate can claim profile through email magic-link.
- Employer-provided email is a hint; PDF-extracted email is primary.

Candidate UIUX:

- `/login` magic-link request.
- `/me` candidate home with profile summary.
- `/me/profile` for resume, PII, Level 1, preferences, and handles.

Admin UIUX:

- Candidate profile inspector shows linked handles and merge history.
- Conflict queue for email mismatch between uploaded metadata and PDF extraction.

Backend/data:

- Add normalized email / hashed email index.
- Add handle-linking service.
- Add deterministic merge rules.
- Add magic-link auth/session handling for candidate site.
- Add merge audit events.

Eval/regression:

- Identity merge tests:
  - same PDF email + same phone
  - same email across different browser uid
  - employer email differs from PDF email
  - no email in PDF but phone exists
  - duplicate upload idempotency

HITL:

- Email conflict queue.
- Duplicate candidate suspicion queue.

Flywheel:

- Merge correction events become identity regression fixtures.

Acceptance:

- Same extracted email across two PDFs maps to one global profile.
- Candidate can claim the profile and see resume/profile data.
- No raw PII public doc ids.

### S3 - Bulk Resume Intake

**Goal:** Employer/operator can upload many PDFs and create/merge global candidate profiles.

Product outcome:

- Bulk resume upload becomes a candidate supply ingestion path.

Candidate UIUX:

- Claimed candidates see uploaded resume on `/me`.
- If candidate is later outbounded, Claire can reference the resume correctly.

Admin UIUX:

- `/admin/bulk-resumes`:
  - create batch
  - upload PDFs + optional email list
  - per-item status
  - extracted email
  - created/merged profile
  - parse error/retry
  - email mismatch review

Backend/data:

- Add `pa-bulk-upload-batches`.
- Add `pa-bulk-upload-batches/{batchId}/items/{itemId}`.
- Reuse `pa-resume-parser` v2 and `public-cv-ingest` logic.
- Persist `ResumeArtifact`.
- Write user tags through `mergeUserTags`.
- Add idempotency by file hash + extracted email.

Eval/regression:

- Batch parser tests.
- 3-PDF local fixture simulation:
  - clean email
  - missing email
  - conflicting email
- No partial profile write on parse failure.

HITL:

- Missing email review.
- Conflicting email review.
- Low-confidence parse review.

Flywheel:

- Parse corrections create user-tag eval cases.

Acceptance:

- Employer uploads 3 PDFs; system creates or merges 3 profile rows with statuses.
- PDF-extracted email drives identity.
- Existing single public CV upload path remains green.

### S4 - Job Enrichment

**Goal:** Every new job becomes enriched demand before matching.

Product outcome:

- A raw job can become a prescreen-ready job with tags, questions, scoring rubric, Claire brief, and eval fixtures.

Candidate UIUX:

- Job page copy and Claire intro use generated/approved candidate brief.

Admin UIUX:

- Job enrichment review panel:
  - extracted tags
  - hard constraints
  - soft signals
  - generated prescreen questions
  - generated rubric
  - Claire brief
  - confidence and HITL flags

Backend/data:

- Define `JobOpportunity` enrichment output.
- Add enrichment version.
- Add generated `prescreenConfig` draft path.
- Add generated eval fixture store.
- Reuse `packages/shared-tags`.
- Never infer `sponsorship=false` from silence.

Eval/regression:

- Job intake eval for:
  - strong candidate
  - weak candidate
  - ambiguous candidate
  - visa mismatch
  - location mismatch
  - salary mismatch
- Tag extraction regression fixtures.

HITL:

- Low-confidence tags.
- Generated question coverage review.
- Conflicting constraints.

Flywheel:

- Job tag corrections create enrichment eval cases.

Acceptance:

- New raw job produces an enriched job draft.
- Admin can approve or correct it.
- Approved job can be matched and prescreened.

### S5 - Two-Way Matching

**Goal:** Matching supports both candidate -> jobs and job -> candidates.

Product outcome:

- Candidate can receive daily recommendations.
- New job can activate retained candidates.

Candidate UIUX:

- `/me/matches` shows recommended jobs, invited jobs, why matched, and status.

Admin UIUX:

- Match Debug supports:
  - candidate -> jobs
  - job -> candidates
  - hard filter explanation
  - soft score
  - LLM/embedding scores
  - missing info
  - recommended action

Backend/data:

- Add/extend `CandidateJobMatch`.
- Implement job -> candidates retrieval.
- Preserve v1.6 cascade decisions.
- Add final action: `auto_outbound`, `hitl_review`, `do_not_contact`.
- Store match reasons and risks.

Eval/regression:

- Ranking eval:
  - for a job, top candidates plausible
  - for a candidate, top jobs plausible
  - obvious mismatches suppressed
  - plausible uncertain cases go to HITL
- Regression from HITL ranking corrections.

HITL:

- Borderline high-value matches.
- Missing-info but promising candidates.
- Ranking override queue.

Flywheel:

- Candidate reply/ignore/decline and HITL ranking corrections feed scoring calibration.

Acceptance:

- Given one enriched job, system can produce top candidate list with reasons.
- Given one candidate, system can produce top job list with reasons.
- Match debug explains both directions.

### S6 - Outreach Platform

**Goal:** Safely outbound retained candidates into new job opportunities.

Product outcome:

- New job can trigger outbound invites to existing candidates without spam or channel overload.

Candidate UIUX:

- Candidate receives concise Claire outbound:
  - why this job might fit
  - option to do quick interview
  - option to decline/stop

Admin UIUX:

- Outreach Ops:
  - outbound queue
  - delivery state
  - cooldown state
  - Sendblue account/group assignment
  - account capacity
  - failure/retry/dead-letter
  - HITL approval batches

Backend/data:

- Add account/number group capacity model.
- Sticky candidate -> Sendblue group assignment.
- Cooldown and duplicate suppression.
- Outreach policy decision records.
- Outbound idempotency.

Eval/regression:

- Policy tests for:
  - opted out
  - cooldown
  - low match
  - high match
  - recent decline
  - account capacity full
  - duplicate company/role
- Sendblue routing and retry tests.

HITL:

- Batch review before high-value or large outbound.
- Review during new account warmup.

Flywheel:

- Delivery/reply/decline events become outreach quality signals.

Acceptance:

- One enriched job can queue safe outbound to selected candidates.
- No duplicate sends.
- One account group never exceeds configured capacity.
- Candidate can decline or stop.

### S7 - First Interview + Passed Candidate Surface

**Goal:** Outbounded or direct candidates get first interview; only passed candidates become employer-visible.

Product outcome:

- Current-job PASS creates a passed profile for employer review.
- NOT_PASS remains retained and can match other jobs later.

Candidate UIUX:

- Candidate can enter interview from direct job page or outbound invite.
- Claire does not skip first interview because of weak initial match.
- Candidate receives clear next-step status.

Admin/employer UIUX:

- `/admin/passed-candidates`
  - filter by job
  - only passed profiles
  - profile summary
  - PII consent
  - resume summary
  - Level 1
  - transcript
  - pass reason
  - match reason

Backend/data:

- Add `EmployerVisibleProfile` snapshot.
- Link snapshot to `CandidateJobState`.
- Preserve global profile as source but expose only the approved snapshot.
- Ensure PII consent state is respected.

Eval/regression:

- PASS creates visible snapshot.
- NOT_PASS does not create employer-visible snapshot.
- PAUSE does not create snapshot.
- Employer cannot query non-passed candidates.
- First interview is not blocked by match score.

HITL:

- PASS with incomplete PII.
- Transcript/reason mismatch.
- Sensitive or safety concerns before employer visibility.

Flywheel:

- Employer view/advance/reject events feed quality and ranking.

Acceptance:

- Direct candidate and outbound candidate can both complete interview.
- PASS appears in passed candidate dashboard.
- NOT_PASS remains in global pool but invisible to employer.

### S8 - Flywheel + HITL + Eval

**Goal:** Turn corrections, outcomes, and QA into a durable improvement system.

Product outcome:

- The system improves as candidates, jobs, employers, and operators interact with it.

Candidate UIUX:

- Better future recommendations from prior behavior and preferences.
- Candidate can correct profile facts or preferences.

Admin UIUX:

- HITL queues:
  - identity conflicts
  - parse failures
  - job enrichment
  - match ranking
  - outbound approval
  - prescreen ambiguity
  - employer-visible profile review
- Eval dashboard:
  - scenario status
  - ranking eval
  - job intake eval
  - live smoke artifacts
  - regression failures

Backend/data:

- Implement `CorrectionEvent`.
- Implement `FeedbackEvent`.
- Add eval artifact writer.
- Add regression fixture generation hooks.
- Add periodic QA runner for marketplace paths.

Eval/regression:

- Full marketplace sim:
  - bulk upload
  - profile merge
  - job enrichment
  - reverse matching
  - outbound
  - first interview
  - passed profile
  - flywheel event
- Safety eval:
  - prompt injection
  - PII leak
  - cross-user leak
  - opt-out honored
  - employer cannot see non-passed

HITL:

- All manual edits write correction events.
- Correction events can generate eval/regression cases.

Flywheel:

- This sprint makes the flywheel explicit and measurable.

Acceptance:

- At least one human correction creates an eval artifact.
- Marketplace simulation runs end-to-end.
- Eval dashboard shows pass/fail and artifact links.

### S9 - Production Hardening + Scale

**Goal:** Prepare the marketplace for real sustained use.

Product outcome:

- WeKruit can retain candidates, activate them for jobs, and show passed profiles with operational confidence.

Candidate UIUX:

- Clear stop/delete/export/privacy controls.
- Reliable recommendation and interview flows.

Admin UIUX:

- Launch readiness dashboard:
  - queue health
  - Sendblue health
  - account capacity
  - failed parses
  - failed matches
  - failed outbound
  - eval regressions
  - privacy requests

Backend/data:

- Privacy export/delete.
- Retention policies.
- Cost and rate controls.
- Backups and replay strategy.
- Observability and alerting.
- Capacity planning for Sendblue accounts.

Eval/regression:

- Live smoke:
  - candidate direct job page
  - bulk-created candidate activation
  - outbound invite
  - first interview
  - PASS employer-visible
  - NOT_PASS retained
- Load tests for batch upload and match job -> candidates.

HITL:

- Launch approval checklist.
- Manual stop switch for outreach batches.

Flywheel:

- Weekly eval review cadence and correction backlog.

Acceptance:

- Launch checklist green.
- Privacy controls verified.
- Live smoke artifacts recorded.
- No critical eval regressions.

## 7. Cross-Sprint Acceptance Matrix

| Invariant | Covered by |
|---|---|
| Candidate profile is global | S1, S2, S3 |
| Job outcomes are per-job | S1, S7 |
| Match does not block first interview | S7, S8 |
| Employer sees only passed profiles | S7, S8, S9 |
| User and job tags share canonical vocab | S4, S5, S8 |
| New jobs activate old candidates | S5, S6, S7 |
| Sendblue capacity model exists | S6, S9 |
| HITL corrections become flywheel data | S8 |
| Eval covers marketplace paths | S5, S8, S9 |
| C-end stays on candidate domain | S0, S2, S7, S9 |

## 8. What The Lead Should Do First

The next lead should start with S0 and S1, not by writing isolated implementation prompts.

Immediate sequence:

1. Reconfirm v1.9 worktree branch and dirty state.
2. Re-run v1.9 sanity checks.
3. Decide whether to merge/rebase v1.9 into the canonical branch before v2.0 execution.
4. Create a concise data model map for S1.
5. Assign executors by write scope.
6. Build reducer/schema tests before UI work.
7. Only then start implementation slices.

## 9. Open Product Questions To Revisit Later

These are not blockers for S0-S3:

- Whether candidate daily recommendations should be fully automatic or approval-gated at first.
- Whether employer-visible profile needs downloadable PDF export.
- Whether employer can request more information after PASS.
- Whether LinkedIn binding is read-only or deeper integration. Default: read-only enrichment.
- Whether more languages beyond zh/en are needed. Default: zh/en until usage proves otherwise.
- Exact Sendblue account expansion trigger beyond the 300-500 active reachable users guidance.
