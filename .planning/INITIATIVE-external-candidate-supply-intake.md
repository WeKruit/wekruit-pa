# Initiative: External Candidate Supply Intake

**Status:** Product/engineering planning lock, 2026-05-13.
**Relationship to v2.0:** Adjacent initiative. It can run in parallel with the
candidate-retention marketplace sprint roadmap, but it must share the same
`pa-users`, tag, matching, outreach, HITL, and eval contracts.
**Goal prompt:** `.planning/V2-EXTERNAL-SUPPLY-GOAL-PROMPT.md`.

## 1. Vision

WeKruit is a multi-company candidate activation network. Internal operators
should be able to serve 100+ companies by combining:

1. existing PA candidates already retained in `pa-users`; and
2. externally sourced candidates from Juicebox, Lessie, and Coresignal.

Each new company/job should activate the existing PA pool first, then expand
supply externally when the pool is thin or when a specific rubric calls for new
profiles. External candidates are not one-off campaign leads. They become
global `pa-users` prospect profiles so future companies/jobs can match them,
outreach them, and learn from their replies and interview outcomes.

The loop:

```text
company/job demand
-> match existing pa-users
-> source missing supply externally
-> normalize LinkedIn-centered records
-> resolve identity
-> create/merge pa-users prospect profiles
-> evaluate against general + company + job rubrics
-> decide tier/channel
-> sync approved email to Instantly
-> create manual LinkedIn outreach tasks
-> candidate reply/interested/decline/bounce/opt-out
-> Claire first interview when interested
-> outcome/correction feeds profile, rubric, source quality, and evals
```

## 2. Non-Negotiable Rules

1. Candidate is the durable global asset. Company/job is demand context.
2. External candidates must share the `pa-users` collection.
3. Excel is an import/export/review surface, never the source of truth.
4. Instantly is email delivery infrastructure, not the candidate database.
5. LinkedIn is manual in V1. Generate personalized messages/tasks only.
6. Email can integrate with Instantly in V1 after operator approval.
7. Every external fact written to a global profile needs source, confidence,
   evidence, and timestamp/version where the current tag model supports it.
8. Company/job fit, tier, risks, explanations, and outreach decision are
   opportunity-specific and must not pollute global `pa-users` facts.
9. Match score and tier decide outreach intensity, not whether Claire can
   interview. Once a candidate enters a job flow, Claire gives the first
   interview.
10. Opt-out, bounce, cooldown, duplicate outreach, and do-not-contact gates run
    before every email sync.
11. This dashboard is internal-only until Adam explicitly expands scope.

## 3. Identity Model

External supply V1 is LinkedIn-centered because Juicebox, Lessie, and Coresignal
inputs are LinkedIn profile URL/content plus enrichment.

### Primary Source Lookup Handle

For external sourced candidates, the primary source identity handle is:

```text
canonicalLinkedInUrl -> linkedinProfileHash -> pa-users uid
```

Rules:

- automatic create/merge first queries by canonical LinkedIn URL hash
- store the normalized LinkedIn URL as a profile handle/source link
- store a hashed LinkedIn index for lookup from external source row to internal
  `pa-users/{uid}`
- do not use raw LinkedIn URL, email, or phone as a Firestore doc id
- email is required for email outreach and can be a strong secondary signal
- email-only rows can be imported, but V1 does not auto-create profiles from
  email-only external sourcing; route them to review
- if LinkedIn resolves to one `pa-users` and email resolves to another, route to
  review
- fuzzy name/current company/school similarity is review-only, never automatic
  merge

### Shared `pa-users`

`pa-users/{uid}` remains the global candidate record. External intake creates or
updates this record only through deterministic identity resolution and audited
profile upsert.

External source links and opportunity evaluations should be separate records:

```text
pa-users/{uid}
pa-candidate-identity-index/{handleHash}
pa-external-sourcing-batches/{batchId}
pa-external-candidate-records/{recordId}
pa-candidate-source-links/{sourceLinkId}
pa-candidate-evaluation-runs/{runId}
pa-candidate-company-job-evaluations/{evaluationId}
pa-outreach-plans/{planId}
pa-outreach-events/{eventId}
```

## 4. Required Domain Objects

### ExternalSourcingBatch

Represents one import from Juicebox, Lessie, Coresignal, or a normalized file.

Fields:

- `id`
- `source`
- `companyId`
- `jobId`
- `importedBy`
- `createdAt`
- `status`
- `rowCount`
- `validLinkedInCount`
- `validEmailCount`
- `duplicateCount`
- `needsReviewCount`
- `readyToProfileCount`
- `rawFileRef`
- `normalizerVersion`

### ExternalCandidateRecord

One normalized source row.

Fields:

- `batchId`
- `source`
- `rawPayload`
- `canonicalLinkedInUrl`
- `linkedinProfileHash`
- `emails[]`
- `name`
- `currentTitle`
- `currentCompany`
- `experience[]`
- `education[]`
- `location`
- `sourceTags[]`
- `enrichment`
- `normalizationStatus`
- `identityResolutionStatus`
- `resolvedUserId`
- `reviewReasons[]`
- `evidence[]`

### CandidateSourceLink

Auditable link between a `pa-users` profile and an external source record.

Fields:

- `userId`
- `source`
- `batchId`
- `recordId`
- `canonicalLinkedInUrl`
- `linkedinProfileHash`
- `emailHashes[]`
- `confidence`
- `evidence`
- `createdAt`
- `createdBy`

### CandidateCompanyJobEvaluation

Opportunity-specific evaluation. This is not global profile truth.

Fields:

- `candidateId`
- `companyId`
- `jobId`
- `evaluationRunId`
- `generalRubricScore`
- `companyRubricScore`
- `jobRubricScore`
- `hardGateResult`
- `softScore`
- `competitorAdjacency`
- `industryAdjacency`
- `missingInfo[]`
- `risks[]`
- `evidence[]`
- `explanation`
- `proposedTier`
- `finalTier`
- `reviewerDecision`
- `reviewedBy`
- `reviewedAt`

### AgentResearchTask / AgentResearchFinding

Used for ChatGPT Agent Mode or other manual research helpers. Findings do not
affect final tier until reviewed.

Fields:

- `taskId`
- `evaluationRunId`
- `candidateIds[]`
- `prompt`
- `expectedJsonSchemaVersion`
- `rawResult`
- `parsedFindings[]`
- `evidenceUrls[]`
- `confidence`
- `reviewStatus`
- `reviewedBy`

### OutreachPlan / OutreachTask

Opportunity-specific outreach plan.

Statuses:

- `tier_1_personal_linkedin_and_email`
- `tier_2_personal_email`
- `tier_3_general_email`
- `retain_only`
- `blocked`

Fields:

- `candidateId`
- `companyId`
- `jobId`
- `evaluationId`
- `tier`
- `channelDecision`
- `personalizedHook`
- `whyThisRole`
- `whyCompany`
- `candidateSpecificSignal`
- `emailSubject`
- `emailBody`
- `linkedinMessage`
- `manualLinkedInTaskStatus`
- `instantlySyncStatus`
- `suppressionGateResult`
- `approvedBy`
- `approvedAt`

## 5. Pipeline

### Step 1: Batch Import

Input:

- Juicebox export
- Lessie export
- Coresignal enrichment
- normalized CSV/XLSX/JSON

Output:

- `ExternalSourcingBatch`
- `ExternalCandidateRecord[]`
- batch quality stats

### Step 2: Normalize

Normalize source-specific field names into one record shape. Preserve raw payload
and source evidence. Canonicalize LinkedIn URLs and normalize emails.

### Step 3: Identity Resolution

Resolution statuses:

- `create_new`
- `merge_existing`
- `needs_review`
- `blocked`

Automatic resolution uses canonical LinkedIn URL first. Email can strengthen
confidence but cannot override a LinkedIn conflict.

### Step 4: Profile Upsert

Create/merge into `pa-users` as `prospect`. Write only stable global facts:

- LinkedIn handle
- email handles
- current title/company
- experience
- education
- location
- canonical tags
- source evidence

Do not overwrite stronger existing facts with weaker external enrichment.

### Step 5: Company/Job Evaluation

Evaluate against:

- global/general rubric
- company rubric
- job rubric

Output:

- hard gate result
- soft score
- competitor/same-industry/adjacent-company signal
- missing info
- risks
- explanation
- proposed tier

### Step 6: Agent Research

Generate structured prompts for ChatGPT Agent Mode when external research is
needed. The prompt must request JSON findings with evidence URLs, confidence,
and uncertainty. Human review is required before findings affect final tier.

### Step 7: Outreach Decision

Final statuses:

- Tier 1: personal LinkedIn task + personal email
- Tier 2: personal email
- Tier 3: general email
- retain-only
- blocked

### Step 8: Delivery And Feedback

- approved email outreach syncs to Instantly
- manual LinkedIn task stays in WeKruit dashboard
- reply/bounce/unsubscribe/interested events sync back to PA
- interested candidate enters Claire job flow
- corrections and outcomes create eval/flywheel data

## 6. Dashboard Operation

Internal dashboard sections:

1. Source Batches
2. Normalize & Merge
3. PA Profile Upsert Results
4. Evaluation Runs
5. Agent Research Workbench
6. Outreach Queue
7. Instantly Sync Status
8. Source Quality / Audit

Operator must be able to:

- import a batch
- inspect invalid/duplicate/review rows
- approve profile create/merge
- run company/job evaluation
- generate/copy Agent research prompt
- import Agent result
- review/edit tier and outreach copy
- approve Instantly sync
- see reply/bounce/opt-out status
- trace why a candidate got a tier/channel decision

## 7. Instantly Contract

WeKruit owns:

- candidate identity
- source evidence
- tags
- scoring
- personalization
- suppression gates
- audit trail

Instantly owns:

- email campaign delivery
- sequence execution
- inbox/reply/bounce/unsubscribe plumbing

Required sync state:

- `instantlyLeadId`
- `campaignId`
- `listId`
- `syncStatus`
- `lastSyncedAt`
- `lastEventAt`
- `error`

Dry-run mode is required. Live sync requires explicit operator approval and
configured campaign/list ids.

## 8. Parallel Execution Plan

This initiative is safe to run in parallel with the v2.0 core roadmap if write
scopes stay disjoint and contracts are locked first.

| Executor | Ownership | Primary write scope |
|---|---|---|
| A. Data Model + Contracts | schemas, enums, collection constants | `packages/core-types`, shared schemas, tests |
| B. Import + Normalization | source adapters, parsing, batch stats | import service/utilities, tests |
| C. Identity + Profile Upsert | LinkedIn/email resolution, `pa-users` writes | identity/profile services, audit tests |
| D. Evaluation + Rubric Engine | general/company/job scoring | evaluation service, rubric tests |
| E. Agent Research | prompt builder, result parser, findings | research task service, parser tests |
| F. Outreach + Instantly | suppression gates, email sync, events | outreach service, Instantly client, tests |
| G. Dashboard | internal operator UI | `apps/dashboard-web` pages/components/lib |
| H. Verification / Eval | fixtures and acceptance evidence | tests, scripts, acceptance docs |

Integration rule: A publishes stable contracts first. B-H can work in parallel
against those contracts. Dashboard may start with fixtures but must converge to
real APIs before acceptance.

## 9. Acceptance

V1 is complete only when:

- a fixture batch of 100+ mixed external candidates imports successfully
- duplicate LinkedIn/email candidates resolve deterministically
- ambiguous identity matches enter review
- new external LinkedIn candidates create `pa-users` prospect profiles
- existing `pa-users` are enriched without overwriting stronger facts
- tags/facts include source/evidence/confidence where supported
- one real company/job evaluation produces Tier 1/2/3/retain-only/blocked
- Agent research prompt can be generated and structured result imported
- Tier 1 rows produce manual LinkedIn task + personal email payload
- Tier 2 rows produce personal email payload
- Tier 3 rows produce general email or retain-only
- approved email rows sync to Instantly in dry-run and live mode behind config
- opt-out/bounce/cooldown/duplicate candidates are blocked from sync
- reply/bounce/unsubscribe events write back to PA outreach events
- dashboard supports the full operator path without terminal-only steps
- final report lists commands run, fixtures used, pass/fail results, remaining
  risks, and any live credentials/config still required
