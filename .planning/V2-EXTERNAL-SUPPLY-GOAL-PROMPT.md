# WeKruit External Candidate Supply Intake `/goal` Prompt

Use this prompt for a standalone `/goal` run dedicated to external candidate
supply intake. This initiative can run in parallel with the core v2.0 roadmap,
but it must share the same `pa-users`, tag, matching, outreach, HITL, and eval
contracts.

```text
You are the single-point lead agent for WeKruit External Candidate Supply
Intake V1.

Goal:
Build the internal production V1 for external candidate supply intake. This is
not a demo, not an Excel-only tool, and not a separate lead database. It must be
usable by WeKruit recruiting ops to import candidates from Juicebox / Lessie /
Coresignal, normalize them, resolve identity, create/merge them into the shared
pa-users candidate pool, evaluate them against company/job rubrics, generate
tiered outreach, sync approved email leads to Instantly, create manual LinkedIn
outreach tasks, and feed replies/outcomes back into the PA flywheel.

Operating sources of truth:
- README.md
- CLAUDE.md
- AGENTS.md
- .planning/INITIATIVE-external-candidate-supply-intake.md
- .planning/MILESTONE-v2.0-candidate-retention-marketplace.md
- .planning/AUTONOMOUS-SPRINT-HARNESS.md

Product vision:
WeKruit is a multi-company candidate activation network. Existing PA users and
externally sourced candidates must live in the same durable candidate pool.
When WeKruit adds a new company/job, the system should:
1. match existing pa-users to the job and outbound suitable candidates into
   Claire first interview;
2. source new external candidates from Juicebox / Lessie / Coresignal;
3. normalize and merge/create them into pa-users as global prospect profiles;
4. evaluate them against general + company + job rubrics;
5. generate tiered outreach decisions;
6. sync approved email outreach to Instantly;
7. create manual LinkedIn tasks with personalized messages;
8. write replies/bounces/opt-outs/interested outcomes back into PA so the data
   flywheel improves future matching.

Non-negotiable product locks:
- Candidate is the durable global asset. Company/job is demand context.
- External candidates share the same pa-users collection.
- External candidates are not isolated campaign leads, Instantly-only leads, or
  Excel-only rows.
- External supply V1 is LinkedIn-centered. Canonical LinkedIn URL is the
  primary source identity lookup handle for automatic create/merge.
- Store normalized LinkedIn URLs plus hashed identity indexes/source links. Do
  not use raw LinkedIn URLs, emails, or phones as Firestore document ids.
- Automatic resolution queries the LinkedIn hash index to find the internal
  `pa-users/{uid}`. The LinkedIn URL itself is never the user doc id.
- Email is for reachability/outreach and is a secondary identity signal. It
  cannot override a LinkedIn conflict.
- Email-only external rows may be imported for review, but V1 must not
  automatically create pa-users profiles from email-only external sourcing rows.
- If LinkedIn resolves to one pa-user and email resolves to another, route to
  review.
- Fuzzy name/company/school matches are review-only, never automatic merge.
- Company/job fit, tier, risks, explanations, and outreach decision are
  opportunity-specific and must not pollute global pa-users facts.
- Every tag/fact written to pa-users must carry source, confidence, evidence,
  version/timestamp where existing tag model supports it.
- Match score/tier decides outreach intensity, not whether Claire can interview.
  If a candidate enters a job flow, Claire gives the first interview.
- Opt-out, bounce, cooldown, duplicate suppression, and do-not-contact must gate
  every email sync.
- Instantly is delivery infrastructure. WeKruit owns identity, tags, scoring,
  personalization, suppression gates, and audit.
- LinkedIn is manual in V1. Generate personalized LinkedIn message/tasks only;
  do not automate LinkedIn sending.
- Dashboard is internal-only.

Branch and worktree rules:
1. Start from updated main.
2. Use a dedicated branch named codex/v2-external-supply-intake.
3. Use a dedicated worktree at .claude/worktrees/v2-external-supply-intake.
4. Do not start from an old sprint branch.
5. Before starting:
   - git fetch origin
   - git checkout main
   - git pull --ff-only origin main
   - git worktree add .claude/worktrees/v2-external-supply-intake -b codex/v2-external-supply-intake main
   - cd .claude/worktrees/v2-external-supply-intake

Required lead process:
1. Read the operating sources of truth.
2. Create .planning/external-supply-v1/ with:
   - CONTEXT.md
   - PLAN.md
   - EXECUTOR-PLANS.md
   - ACCEPTANCE.md
   - SUMMARY.md
3. Before implementation, ask each executor for AGENT_PLAN only. Do not allow
   code changes until the lead integrates executor plans.
4. Lock Data Model + Contracts first. Other executors can then run in parallel
   against those contracts.
5. Assign executors by disjoint write scope. If two executors need the same
   file, pick one owner and sequence the other behind the owner's interface.
6. Execute in waves:
   - Wave A: schemas, enums, collection constants, fixtures, failing tests
   - Wave B: import, normalization, identity/profile services
   - Wave C: evaluation, agent research, outreach, Instantly services
   - Wave D: dashboard operator surfaces
   - Wave E: eval, acceptance fixture, docs, final report

Required data model:
- ExternalSourcingBatch
- ExternalCandidateRecord
- CandidateSourceLink
- CandidateIdentityResolution
- CandidateProfileUpsertResult
- CandidateEvaluationRun
- CandidateCompanyJobEvaluation
- AgentResearchTask
- AgentResearchFinding
- OutreachDecision
- OutreachPlan / OutreachTask
- InstantlySyncRecord
- OutreachEvent
- SourceQualityMetric / CorrectionEvent if needed

Required pipeline:
1. Batch import
   - Accept CSV/XLSX/JSON-style external candidate rows from Juicebox, Lessie,
     and Coresignal.
   - Normalize source-specific fields into ExternalCandidateRecord.
   - Preserve raw payload and source metadata.
   - Compute stats: rows, valid LinkedIn, valid email, duplicates, needs review,
     ready to profile.

2. Identity resolution
   - Canonicalize LinkedIn URLs.
   - Normalize emails.
   - Match existing pa-users by LinkedIn hash index and email hash index.
   - Automatic create/merge queries by canonical LinkedIn URL hash and requires
     a canonical LinkedIn URL.
   - Fuzzy matches must go to review.
   - Produce deterministic statuses: create_new, merge_existing, needs_review,
     blocked.

3. PA profile creation
   - Create/merge pa-users prospect profiles.
   - Write stable global facts only: LinkedIn, email handles, current title,
     current company, experience, education, location, skills/tags, source
     evidence.
   - Do not overwrite stronger existing facts with weaker external enrichment.
   - Write audit events for every create/merge/tag update.

4. Company/job evaluation
   - Evaluate candidate records or pa-users against global/general rubric,
     company rubric, and job rubric.
   - Output hard gates, soft score, missing info, risks, evidence, explanation,
     and proposed tier.
   - Support competitor/same-industry/adjacent-company research as a structured
     finding.

5. Agent research prompt generation
   - Generate ChatGPT Agent prompts for rows needing external research.
   - Prompt must ask for structured JSON findings with evidence URLs,
     confidence, and uncertainty.
   - Import/paste Agent result back into dashboard and attach to evaluation.
   - Human approval is required before agent findings affect final tier.

6. Outreach decisioning
   - Produce final statuses:
     - Tier 1: personal LinkedIn task + personal email
     - Tier 2: personal email
     - Tier 3: general email or retain-only
     - Blocked: opt-out, bounced, invalid email, cooldown, duplicate outreach,
       low confidence
   - Generate:
     - email subject/body variables
     - personalizedHook
     - whyThisRole
     - whyCompany
     - candidateSpecificSignal
     - manual LinkedIn message
   - Require human approval before email sync.

7. Instantly integration
   - Add approved email leads to the configured Instantly campaign/list.
   - Store instantlyLeadId, campaignId, listId, syncStatus, lastSyncedAt, error.
   - Support dry-run mode.
   - Pull or receive reply/bounce/unsubscribe status where feasible.
   - Write outreach events back into PA.
   - Do not make Instantly the source of truth.

8. Dashboard
   Build internal dashboard pages or one cohesive section for:
   - Source Batches
   - Normalize & Merge
   - PA Profile Upsert Results
   - Evaluation Runs
   - Agent Research Workbench
   - Outreach Queue
   - Instantly Sync Status
   - Source Quality / Audit

Dashboard must let an operator:
- import a batch
- inspect invalid/duplicate/review rows
- approve profile creation/merge
- run company/job evaluation
- generate/copy Agent research prompt
- import Agent research result
- review/edit tier and outreach copy
- approve Instantly sync
- see reply/bounce/opt-out status
- trace why a candidate got a tier/channel decision

Parallel executor split:
A. Data Model + Contracts
Write scopes: packages/core-types, shared schemas, Firestore collection
constants, tests.
Own all new type contracts and status enums. No UI.

B. Import + Normalization
Write scopes: functions/import service, parsing utilities, source adapters,
tests.
Own Juicebox/Lessie/Coresignal row normalization and batch stats.

C. Identity + pa-users Upsert
Write scopes: identity resolution service, profile upsert service, audit writes,
tests.
Own LinkedIn/email matching, create/merge/review logic, tag/evidence writes.

D. Evaluation + Rubric Engine
Write scopes: evaluation service, rubric types, scoring helpers, tests.
Own general/company/job rubric evaluation and tier proposal.

E. Agent Research + Prompt Contract
Write scopes: prompt builder, result parser/validator, research finding storage,
tests.
Own structured prompt and import flow. Do not browse automatically unless
explicitly configured.

F. Outreach + Instantly
Write scopes: outreach decision service, Instantly API client, dry-run/live
sync, event sync tests.
Own email sync, suppression gates, sync status, reply/bounce/unsubscribe
mapping.

G. Dashboard
Write scopes: apps/dashboard-web new pages/components/lib clients.
Own internal operator UI and navigation. Must use existing dashboard
style/patterns.

H. Verification / Eval
Write scopes: tests, fixtures, scripts, planning acceptance docs.
Own end-to-end dry-run fixture and acceptance evidence.

Integration constraints:
- Lead must merge A's contracts or publish a stable interface doc before B-H
  finalize.
- B/C/D/E/F can run in parallel after contracts are available.
- Dashboard can start with mocked/static contracts but must converge to real
  APIs before acceptance.
- No executor may change candidate public routes or admin/candidate domain
  split.
- No executor may build employer-visible sourcing pages.
- No executor may automate LinkedIn sending.

Acceptance:
- A fixture batch of 100+ mixed external candidates imports successfully.
- Duplicate LinkedIn/email candidates resolve deterministically.
- Ambiguous identity matches enter review.
- New external candidates with canonical LinkedIn URLs create pa-users prospect
  profiles.
- Email-only external rows do not auto-create pa-users profiles in V1.
- Existing pa-users are enriched without overwriting stronger existing facts.
- Tags/facts include source/evidence/confidence where supported.
- A real company/job evaluation produces Tier 1/2/3/retain-only/blocked
  outputs.
- Agent research prompt can be generated and structured result can be imported.
- Tier 1 rows produce manual LinkedIn task + personal email payload.
- Tier 2 rows produce personal email payload.
- Tier 3 rows produce general email or retain-only.
- Approved email rows sync to Instantly in dry-run and live mode behind
  explicit config.
- Opt-out/bounce/cooldown/duplicate candidates are blocked from sync.
- Reply/bounce/unsubscribe events write back to PA outreach events.
- Dashboard supports the full operator path without terminal-only steps.
- Tests cover schema, normalization, identity resolution, profile upsert,
  evaluation, outreach gating, and Instantly dry-run.
- Produce a final acceptance report listing commands run, fixtures used, passed
  checks, remaining risks, and any live credentials/config still required.

Ask Adam only for:
- unsettled product behavior not answered by this prompt or the initiative doc
- destructive migration or data deletion
- live outreach to non-test recipients
- paid API budget or third-party account configuration
- any change that would make external candidates separate from pa-users

Do not ask Adam for:
- implementation details that follow existing repo patterns
- whether to use LinkedIn URL as the external source identity; this is locked
- whether to keep LinkedIn sending manual; this is locked for V1
- whether to run required acceptance checks

Start by creating .planning/external-supply-v1/CONTEXT.md and PLAN.md, then ask
executors for AGENT_PLAN outputs.
```
