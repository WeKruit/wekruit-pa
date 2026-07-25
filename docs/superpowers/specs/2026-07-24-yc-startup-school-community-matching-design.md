# YC Startup School: enrichment and matching design

## Outcome

Turn the YC Startup School 2026 attendee list into a durable WeKruit cohort:

- every supplied LinkedIn profile receives a CoreSignal enrichment attempt;
- verified factual evidence becomes part of the candidate's one global profile;
- an interest form records mutable, self-declared community intent;
- people can be ranked for relevant community introductions; and
- the same person can independently match and be submitted to any number of jobs.

Photon is one current job demand event, not a candidate classification.

## Invariants

1. `pa-users/{candidateId}` remains the only candidate profile. No YC-only
   candidate collection is introduced.
2. CoreSignal writes factual evidence only: identity, experience, education,
   skills, company, location, and derived YoE. Each write retains source,
   evidence, confidence, and extraction version.
3. A failed or ambiguous CoreSignal lookup is a review outcome, never a
   guessed profile merge. "Enrich all" means attempt every eligible row and
   record every result.
4. The YC cohort label is provenance/segment metadata (`yc_startup_school_2026`),
   not a skill or a replacement tag vocabulary.
5. Interest is self-declared and mutable. It is not inferred from CoreSignal.
6. Candidate-to-job state is always keyed by `(candidateId, jobId)` and uses
   the existing `pa-candidate-job-matches` and `pa-candidate-job-states`
   contracts. A Photon submission cannot exclude later matches to other jobs.
7. The existing Terms of Service cover this cohort's permitted data use. Any
   recruiter submission records the applicable Terms provenance rather than
   claiming a recruiter manually collected consent.

## Data model

| Purpose | Canonical storage | Notes |
| --- | --- | --- |
| Person facts | `pa-users` + existing `pa-candidate-source-links` | Existing CoreSignal identity, merge, tag, and experience-mirror pipeline. |
| YC membership | source-link/batch metadata plus a queryable cohort label | Links every candidate back to the supplied sheet row and batch. |
| Community intent | `pa-community-interest-profiles/{candidateId}` | One current, versioned form response: seeking, offering, topics, industries, location, availability, and updated time. |
| Person-to-person recommendation | `pa-community-match-recommendations/{orderedCandidatePair}` | Recomputable score, evidence, explanation, source profile versions, and review/action state. This is a pair relation, not a profile. |
| Person-to-job matching | Existing candidate-job match and state collections | Existing many-to-many model; Photon is queried in the job-to-candidates direction. |
| Employer/recruiter submission | Existing `pa-recruiter-submissions` | A job-specific outcome referencing the global candidate and its evidence. |

## Matching rules

### Community people matching

The primary score is reciprocal intent compatibility: what one person seeks
is offered or relevant to the other. Experience, skills, industry, company,
school/education, and location are supporting evidence and ranking features.
Shared school alone never creates a recommendation.

### Job matching

Use the existing job-to-candidates matcher after profile enrichment. Photon
hard requirements remain hard requirements: relevant stack evidence,
high-concurrency/distributed/messaging ownership, sufficient programming
history, and San Francisco availability. A matching result is not a recruiter
submission; submission is a separate, auditable action for that pair.

## Delivery sequence

1. **Pilot five rows.** Verify the sheet's LinkedIn identity, resolve each to
   a CoreSignal record, collect the raw profile, and publish a per-row quality
   report: identity, email/reachability, experience depth, education, skills,
   YoE, location, and Photon evidence.
2. **Promote the proven path.** Attempt all remaining rows, persist both
   successes and review/no-match outcomes, and attach the YC cohort provenance.
3. **Admin discoverability.** Surface cohort, source status, factual profile
   coverage, and Photon job-to-candidates evidence in the existing Candidates,
   External Supply, and Match Debug pages.
4. **Interest form.** Build the first self-declared intent profile and its
   admin view.
5. **Community recommendations.** Produce explainable people-pair matches,
   then add the operating workflow for review/introduction.
6. **Job workflow.** Run Photon against the enriched cohort and create
   recruiter submissions only for individual candidate-job pairs that meet the
   role's evidence bar.

## Pilot acceptance criteria

For each of the five rows:

- the exact source row and canonical LinkedIn URL are auditable;
- a profile is merged only on high-confidence identity resolution;
- the CoreSignal result is visibly classified as usable, thin, ambiguous, or
  unavailable;
- all derived tags carry source/evidence/confidence;
- the candidate is searchable in admin without creating a second profile; and
- Photon match debug shows evidence or a concrete exclusion reason.

The admin pilot starts at `/admin/external-supply/batches/new-coresignal` once
the numeric CoreSignal IDs are resolved, then uses `/admin/candidates` and
`/admin/match-debug` for inspection. The current sheet supplies LinkedIn URLs,
not the numeric IDs required by the existing batch fetch callable; URL-to-ID
resolution is therefore the first pilot capability to validate.
