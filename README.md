# wekruit-pa

Personal assistant platform for WeKruit.

## Product Blueprint: Candidate Retention Marketplace

This section is the persistent product memory for WeKruit v2.0+. `CLAUDE.md` and
`AGENTS.md` should reference this blueprint rather than inventing a different
product shape.

Execution roadmap: [.planning/MILESTONE-v2.0-candidate-retention-marketplace.md](.planning/MILESTONE-v2.0-candidate-retention-marketplace.md).
Autonomous sprint harness: [.planning/AUTONOMOUS-SPRINT-HARNESS.md](.planning/AUTONOMOUS-SPRINT-HARNESS.md).
`/goal` prompt: [.planning/V2-GOAL-PROMPT.md](.planning/V2-GOAL-PROMPT.md).
External candidate supply initiative: [.planning/INITIATIVE-external-candidate-supply-intake.md](.planning/INITIATIVE-external-candidate-supply-intake.md).
External supply `/goal` prompt: [.planning/V2-EXTERNAL-SUPPLY-GOAL-PROMPT.md](.planning/V2-EXTERNAL-SUPPLY-GOAL-PROMPT.md).

### North Star

WeKruit is a C-end candidate retention marketplace. It is not just a job page,
pre-screen bot, or employer ATS.

The durable asset is the candidate profile. A job is a demand event. Every
candidate who enters the platform should be retained as global supply, improved
over time through Claire conversations, resumes, memory, tags, preferences, and
outcomes. Every new job should be enriched, matched against the historical
candidate pool, and used to outbound suitable candidates into a first interview.

The long-term loop is:

1. New candidate enters from a job page, employer resume upload, ATS, or direct
   Claire message, or external LinkedIn-based sourcing.
2. Resume, chat, PII, Level 1 info, and behavior enrich a global candidate
   profile.
3. New jobs are ingested, enriched, tagged, and converted into prescreen-ready
   demand.
4. Matching runs both directions: candidate -> jobs and job -> candidates.
5. Outreach uses Sendblue capacity-aware load balancing to invite candidates.
6. Claire gives the first interview once a candidate enters a job flow.
7. Passed profiles become employer-visible.
8. Outcomes, HITL corrections, and candidate behavior feed evals, ranking,
   tagging, and future recommendations.

### Locked Product Rules

1. Candidate is the durable asset. Job is an event.
2. All durable candidate data is global: mem0, tags, PII, Level 1 info, YoE,
   industry preference, salary range, location preference, visa, company size,
   resume, LinkedIn, conversation-derived preferences, and outreach preferences.
3. Job-specific data stays job-specific: match score, outbound invite,
   prescreen session, PASS/NOT_PASS/PAUSE, employer-visible profile snapshot,
   and next-stage status.
4. Match score never blocks the first interview. Once a candidate enters a job
   flow, Claire gives the first interview regardless of initial match quality.
5. NOT_PASS is not an exit. Candidate remains in the global marketplace pool.
6. Employer dashboard only shows passed candidate profiles until Adam explicitly
   expands scope.
7. Candidate flow stays on `candidate.wekruit.com` / `pa.wekruit.com`, never on
   the admin domain.
8. User tags and job tags share one canonical vocabulary.
9. HITL corrections must become flywheel data, not one-off fixes.
10. Sendblue outreach must respect account capacity, cooldowns, opt-out, and
    sticky candidate/account assignment. One account/number group should own
    roughly 300-500 active reachable users before expansion.
11. External sourcing candidates share the same `pa-users` collection. They are
    not separate campaign leads and must not live only in Excel or Instantly.
12. For external Juicebox / Lessie / Coresignal intake, canonical LinkedIn URL
    is the primary source identity lookup handle for automatic create/merge.
    Query a hashed LinkedIn identity index to find an existing internal `uid`;
    do not use raw LinkedIn URL, email, or other PII as a Firestore document id.

### Identity And Global Profile

Candidate identity is email magic-link first. Gmail-only OAuth is not the
north star.

For employer bulk resume upload, PDF-extracted email is the primary identity
signal. Employer-provided email is a validation hint. If they disagree, mark for
review instead of silently creating a second person.

The global profile links handles:

- normalized email / hashed email index
- phone E.164
- Sendblue user / thread identity
- browser `wkr_uid`
- ATS applicant IDs
- canonical LinkedIn URL / hashed LinkedIn index

Do not use raw PII as a public document id. Identity merge must be deterministic
and audited.

For external sourced candidates, LinkedIn URL is the strongest source identity
because Juicebox, Lessie, and Coresignal rows are centered on LinkedIn profile
content and enrichment. Email is still required for outreach and can be a strong
secondary identity signal, but automatic profile create/merge first queries by
canonical LinkedIn URL hash in v1 of the external supply initiative. The index
returns an internal `pa-users/{uid}`; LinkedIn itself is never the user doc id.
If LinkedIn and email resolve to different existing `pa-users`, route to review
rather than silently merging or creating a duplicate.

### Global Candidate State Machine

LLM never directly controls state transitions. LLM may extract intent, judge an
answer, or compose copy. State transitions are deterministic reducers over typed
events, verified facts, confidence, and policy.

| State | Entry Condition | Exit Condition | Controller |
|---|---|---|---|
| `prospect` | Employer bulk upload, ATS applicant, external LinkedIn sourced candidate, anonymous job-page uid, or direct text with no resolved profile | Email, phone, or LinkedIn handle extracted/linked | reducer |
| `profile_created` | `pa-users` global profile exists | At least one reachable handle verified or deliverable | reducer |
| `reachable` | Verified email or deliverable phone exists | Candidate replies, logs in, or opts out | delivery evidence + reducer |
| `claimed` | Email magic-link login succeeds | Core profile reaches ready threshold | reducer |
| `profile_ready` | Resume parsed, core tags present, and at least one reachable handle exists | Candidate becomes active or retained | reducer |
| `active_job_seeker` | Candidate explicitly or behaviorally signals open to opportunities | Stop, inactivity window, cooldown, or opt-out | LLM extracts signal; reducer decides |
| `retained` | Candidate is not actively searching but allows future outreach | Reactivation, new positive signal, or opt-out | reducer |
| `opted_out` | Stop/delete/no-outreach request | Only explicit opt-in can reactivate outreach | reducer, no LLM override |
| `deleted` | Delete request fulfilled | Terminal | reducer |

Allowed LLM output example:

```ts
{
  intent: "open_to_opportunities",
  confidence: 0.91,
  evidence: "I'm actively looking for SWE roles"
}
```

The reducer decides whether that updates `active_job_seeker`.

### Candidate x Job State Machine

This state is per opportunity and must not overwrite the global candidate state.

| State | Entry Condition | Exit Condition | Controller |
|---|---|---|---|
| `candidate_matched` | New job match score crosses retrieval threshold | Outreach approved or blocked | matching service + policy |
| `outbound_queued` | Outreach policy allows or HITL approves | Sendblue accepts send | reducer |
| `outbound_sent` | Sendblue sent/delivered event | Candidate replies, timeout, or decline | delivery event |
| `candidate_interested` | Candidate replies yes/interested/asks relevant details | Prescreen starts | LLM intent extraction + reducer |
| `prescreen_started` | First job interview begins | PASS / NOT_PASS / PAUSE terminal | PreScreenPipeline |
| `passed` | Prescreen PASS | Employer-visible snapshot created | reducer |
| `not_passed` | Prescreen FAIL/HARD_STOP/NOT_PASS | Candidate retained for other jobs | reducer |
| `paused` | Ambiguous, sensitive, or manual-review state | HITL resolves | reducer |
| `employer_visible` | PASS plus required consent/profile snapshot | Employer sees passed profile | reducer |
| `archived` | Job closed, candidate declined, stale invite, or employer no longer hiring | Terminal for this job | reducer |

### Product Surfaces

Candidate surfaces:

- `/` - Claire landing, positioned as an ongoing job-search companion.
- `/j/:jobId` - public job page, inline resume upload, iMessage start.
- `/login` - email magic-link profile claim.
- `/me` - candidate home: profile completeness, resume on file, Claire status,
  active opportunities.
- `/me/profile` - resume, LinkedIn, global PII, Level 1 info, preferences,
  memory controls.
- `/me/matches` - recommended jobs, invited jobs, why matched, interview status.
- `/me/privacy` - export, delete, stop outreach, memory opt-out.

Employer/admin surfaces:

- Jobs: create/import job, job tags, prescreen config, public page preview.
- Bulk Resume Upload: upload emails + PDFs, parse status, extracted email,
  merge/create result, retry/error state.
- External Candidate Supply: import Juicebox / Lessie / Coresignal rows,
  normalize LinkedIn-centered records, resolve identity, create/merge `pa-users`
  prospects, evaluate against company/job rubrics, generate Instantly email
  sync payloads, and create manual LinkedIn outreach tasks.
- Passed Candidates: only passed profiles, filterable by job.
- Candidate Profile: resume summary, tags, Level 1 info, PII consent,
  transcript, pass reason, match reason.
- Match Debug: hard filters, soft score, LLM rerank, evidence, explanation.
- Tagging Admin: canonical vocab, sandbox proposed tags, promote/reject,
  backfill status.
- Sendblue / Outreach Ops: outbound queue, delivery, cooldown, account pool,
  failures, capacity.
- HITL Review Queue: low-confidence job enrichment, candidate matching,
  prescreen ambiguity, employer visibility concerns.
- Eval / Regression: scenario runs, ranking evals, job-intake evals, live-smoke
  artifacts.

### Backend System Boundaries

Long-term backend modules:

1. `candidate-profile-service`
   - identity merge
   - global profile state
   - global PII / tags / Level 1 / resume / memory hooks
   - external LinkedIn identity links and source evidence
   - candidate lifecycle reducer

2. `job-enrichment-service`
   - raw JD ingest
   - canonical job tags
   - hard filters and soft preferences
   - generated prescreen config
   - Claire job brief
   - generated eval fixtures
   - enrichment confidence + HITL review triggers

3. `tagging-service`
   - canonical vocab
   - synonym normalization
   - proposed-tag sandbox
   - admin promote/reject
   - tag confidence, evidence, source attribution
   - versioned backfills and migrations

4. `matching-service` / matching repo
   - candidate -> jobs recommendations
   - job -> candidates activation
   - hard filters
   - soft scoring
   - LLM rerank
   - embedding similarity
   - explanations
   - feedback learning
   - offline eval and debug output

5. `outreach-service`
   - Sendblue account/number pool assignment
   - Instantly email lead sync for approved external candidate outreach
   - manual LinkedIn outreach task generation
   - sticky candidate/account routing
   - account capacity model
   - cooldowns and duplicate suppression
   - delivery health and retries
   - outbound approval policy

6. `conversation-runtime`
   - Claire friend persona
   - job recommendation dialogue
   - pre-screening
   - PII / Level 1 collection
   - long-term retention conversations

7. `quality-control-plane`
   - HITL queues
   - simulation
   - eval
   - regression
   - audit
   - flywheel artifacts from human corrections

### Tagging System Maintenance

Tagging is the central language connecting candidate supply and job demand.

User-side tags include roleFunction, skills, seniority/careerStage, yoe,
industry preference, location preference, salary range, visa/sponsorship,
company size preference, job type, education/major, conversation-derived
preferences, and negative preferences.

Job-side tags include roleFunction, requiredSkills, niceToHaveSkills,
seniorityLevel, industrySector, locationBuckets, salaryRange, sponsorship,
jobType, companySize, must-have constraints, and soft preference signals.

Every meaningful tag should carry value, source, confidence, evidence, version,
and update timestamp:

```ts
{
  value: "software_engineering",
  source: "resume_parse" | "conversation" | "job_enrich" | "admin" | "llm_infer",
  confidence: 0.87,
  evidence: "Tesla SWE intern; React/TypeScript project history",
  version: "tag-vocab-2026-05",
  updatedAt: "..."
}
```

Maintenance obligations:

- keep canonical vocab in `packages/shared-tags`
- keep job and user axes aligned
- log proposed tags before promotion
- require evidence for low-confidence or new tags
- write audit events for promote/reject/edit
- generate backfill tasks when vocab or schema changes
- add eval cases whenever a tag correction is made

### Job Enrichment Pipeline

Each new job must become an enriched demand object before it participates in
matching.

Pipeline:

1. ingest raw JD / employer / source metadata
2. normalize title, employer, location, salary, apply URL
3. extract canonical tags
4. infer hard constraints
5. infer soft preference signals
6. generate prescreen questions
7. generate scoring rubric
8. generate Claire candidate-facing brief
9. generate eval fixtures
10. validate and route low-confidence cases to HITL

Output shape:

```ts
JobOpportunity {
  rawJob
  enrichedJobTags
  hardFilters
  softScoringWeights
  prescreenConfig
  candidateBrief
  evalFixtures
  enrichmentConfidence
  enrichmentVersion
}
```

Guardrails:

- never infer `sponsorship=false` from silence
- keep `roleFunction` and `industrySector` orthogonal
- seniority cannot rely only on title regex
- broken or expired URLs must be swept
- enrichment version changes require backfill planning
- generated prescreen config is draft unless confidence and coverage are high

### User Tagging Pipeline

Candidate information comes from resume, chat, PII/Level1, LinkedIn, historical
behavior, and HITL.

Pipeline:

1. resume parse
2. conversation extraction
3. Level 1 structured answers
4. preference updates
5. behavioral events
6. manual correction
7. periodic re-enrichment

Transcript and mem0 are not enough. Durable facts must be extracted into
structured global profile fields.

Example user message:

> I only want NYC or remote AI infra startups. Below 140k is not worth it. I
> need H1B sponsor.

Structured updates:

- `targetLocations = ["new_york", "remote"]`
- `industrySector = ["artificial_intelligence_and_machine_learning", "cloud_and_infrastructure"]`
- `companySize = ["early_startup", "scale_up"]`
- `minSalaryUsd = 140000`
- `visaStatus = "sponsor_needed"`

LLM extracts; deterministic reducer decides whether and how to write.

### Matching Repo Responsibilities

The matching repo/service must support both directions:

1. Candidate -> jobs: daily recommendations and candidate-requested matching.
2. Job -> candidates: new job activates retained candidate pool and creates
   outbound interview opportunities.

Required output:

```ts
CandidateJobMatch {
  candidateId
  jobId
  hardFilterResult
  softScore
  llmScore
  finalRank
  reasons
  risks
  missingInfo
  recommendedAction: "auto_outbound" | "hitl_review" | "do_not_contact"
}
```

Ranking layers:

1. Deterministic hard gates: role family, work authorization, location,
   seniority, freshness, URL validity.
2. Soft score: skills, industry preference, salary fit, company stage, resume
   embedding, conversation preference.
3. LLM / embedding rerank: nuance after hard filters.
4. Outcome feedback: replies, declines, prescreen outcomes, employer action,
   HITL corrections.

### Outreach And Sendblue Capacity

Outbound is flexible but policy-controlled.

Account/number groups:

- sticky assignment by candidate
- one group owns roughly 300-500 active reachable users
- statuses: `active`, `warmup`, `throttled`, `paused`, `degraded`
- new users assigned by capacity
- old users keep thread continuity

Outreach decision shape:

```ts
OutreachDecision {
  allow: boolean
  mode: "auto" | "hitl_required" | "blocked"
  reason:
    | "high_fit_active_candidate"
    | "cooldown"
    | "low_fit"
    | "channel_capacity"
    | "recent_decline"
    | "opted_out"
    | "duplicate_company_or_role"
}
```

Policy considers candidate state, recent activity, match score, cooldown,
account capacity, delivery health, opt-out status, and duplicate suppression.

### HITL Control Plane

HITL is not a fallback page. It is the control and labeling surface for risky,
low-confidence, or high-value actions.

HITL required or strongly considered for low-confidence JD enrichment, weak
generated questions, conflicting visa/location/salary constraints, borderline
candidate-job ranking, high-value outbound batches, new Sendblue account warmup,
recent candidate decline, ambiguous prescreen answers, compensation/legal/
immigration/safety-sensitive questions, PASS with incomplete PII, and
employer-visible profiles with inconsistent transcript or reason.

Every human edit writes a correction event:

```ts
CorrectionEvent {
  objectType: "job_tag" | "user_tag" | "match_rank" | "question" | "outbound_copy" | "visibility"
  before
  after
  reason
  reviewer
  downstreamEvalCaseCreated: true
}
```

### Data Flywheel

The flywheel:

1. new candidate enters
2. resume + chat enrich global profile
3. candidate receives jobs
4. candidate replies, ignores, declines, or screens
5. interview outcome is recorded
6. employer sees passed profile
7. employer action is recorded
8. scoring/tagging/evals improve
9. future jobs use better profiles and better ranking

Feedback events to persist:

- candidate clicked job
- candidate replied interested
- candidate ignored
- candidate declined
- candidate said recommendation was irrelevant
- candidate completed prescreen
- candidate passed
- employer viewed profile
- employer advanced candidate
- employer rejected candidate
- HITL corrected tag
- HITL changed match reason
- HITL changed generated question
- HITL changed outbound copy

These events feed analytics, eval datasets, scoring calibration, tag confidence,
prompt/rubric improvement, and regression cases.

### Testing And Eval System

Eval must cover marketplace behavior, not only isolated functions.

Layer 1: schema/reducer tests

- tag canonicalization
- identity merge
- candidate state transitions
- candidate-job state transitions
- hard filters
- Sendblue assignment
- cooldown
- idempotency

Layer 2: pipeline simulation

- direct job page new candidate
- employer bulk PDF upload
- old candidate matched to new job
- outbound invite
- interested reply
- prescreen PASS / NOT_PASS / PAUSE
- employer-visible profile creation

Layer 3: ranking eval

- for a job, top candidates are plausible
- for a candidate, top jobs are plausible
- obvious mismatches are suppressed
- plausible but uncertain candidates go to HITL
- score/rank changes create regression fixtures

Layer 4: job intake eval

- generated tags are correct
- generated questions cover true must-haves
- generated rubric catches strong/weak/ambiguous/visa/location/salary cases
- low confidence routes to HITL

Layer 5: safety / privacy eval

- prompt injection
- cross-user leakage
- PII leakage
- employer cannot see non-passed candidates
- delete / opt-out / stop honored

Layer 6: live smoke and channel eval

- Sendblue delivery
- no duplicate outbound
- no skipped first interview
- no admin-domain candidate route
- no PII before consent
- account capacity and cooldown respected

### Single-Point Lead Operating Model

The single-point lead is responsible for preserving one system model across
product, backend, eval, flywheel, and UIUX. The lead should split work into
independently shippable slices, but every slice must strengthen the marketplace
loop.

Lead responsibilities:

- maintain the product invariants above
- define sprint objectives as vertical outcomes, not isolated tickets
- assign executors by disjoint write ownership
- require every new data field to have lifecycle, owner, audit trail, and eval
  story
- ensure every job intake path produces enriched demand
- ensure every candidate intake path improves global supply
- evaluate every matching change in both directions
- convert every HITL correction into flywheel data
- keep all C-end routes on candidate domain
- keep employer views passed-profile-only until Adam expands scope

Sprint slicing principle:

1. Start from one end-to-end marketplace slice.
2. Add backend primitives only when a product path needs them.
3. For every backend primitive, add UI visibility, HITL affordance, and eval.
4. For every UI surface, define the Firestore/API source of truth.
5. For every matching/tagging change, add regression fixtures and match-debug
   evidence.

This repository contains:

- `apps/macos-imessage-worker`: Mac iMessage channel worker
- `apps/dashboard-web`: operator dashboard
- `packages/agent-runtime`: current LLM provider wrapper, target home for turn orchestration
- `packages/pa-orchestrator`: independent broker consumer / turn runtime
- `packages/pa-broker`: Firestore queue, turn, audit, and outbound helpers
- `packages/pa-connectors`: connector registry, schemas, policy-aware router
- `packages/pa-safety`: rate limits, prompt-injection checks, memory filters
- `packages/memory`: Firestore transcript context and optional Mem0
- `packages/core-types`: shared Firestore schemas
- `packages/firebase-admin`: Admin SDK helper
- `packages/agent-registry`: agent seed and lookup
- `config`: runbooks, Firebase rules, deployment docs

Important docs:

- [README.md](README.md) - canonical product blueprint and repository overview
- [.planning/MILESTONE-v2.0-candidate-retention-marketplace.md](.planning/MILESTONE-v2.0-candidate-retention-marketplace.md) - v2.0 sprint roadmap from current baseline to candidate marketplace
- [.planning/INITIATIVE-external-candidate-supply-intake.md](.planning/INITIATIVE-external-candidate-supply-intake.md) - external Juicebox / Lessie / Coresignal candidate supply intake initiative
- [.planning/AUTONOMOUS-SPRINT-HARNESS.md](.planning/AUTONOMOUS-SPRINT-HARNESS.md) - `/goal`-compatible autonomous sprint and executor-plan harness
- [.planning/V2-GOAL-PROMPT.md](.planning/V2-GOAL-PROMPT.md) - overall prompt for autonomous `/goal` execution
- [.planning/V2-EXTERNAL-SUPPLY-GOAL-PROMPT.md](.planning/V2-EXTERNAL-SUPPLY-GOAL-PROMPT.md) - standalone `/goal` prompt for external candidate supply intake
- [CLAUDE.md](CLAUDE.md) - operating authority, deploy rules, design locks
- [AGENTS.md](AGENTS.md) - non-Claude agent TL;DR
- [ARCHITECTURE.md](ARCHITECTURE.md)
- [PLAN.md](PLAN.md)
- [SEQUENCE.md](SEQUENCE.md)
- [CURRENT_VS_TARGET.md](CURRENT_VS_TARGET.md)
- [LEADER_HANDOFF.md](LEADER_HANDOFF.md)
- [SCHEMAS.md](SCHEMAS.md)
- [docs/PA-OPS-RUNBOOK.md](docs/PA-OPS-RUNBOOK.md)
- [config/E2E-MAC-FIREBASE-DASHBOARD.md](config/E2E-MAC-FIREBASE-DASHBOARD.md)
- [config/MEM0-SELF-HOST.md](config/MEM0-SELF-HOST.md)

Current production Firebase project: `wekruit-5f89b`.

Dashboard hosting target: `wekruit-pa`.
