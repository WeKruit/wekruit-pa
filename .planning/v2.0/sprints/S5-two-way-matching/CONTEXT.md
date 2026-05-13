# S5 Context - Two-Way Matching

## Base

- Branch: `codex/v2-S5-two-way-matching`.
- Worktree: `.claude/worktrees/v2-S5-two-way-matching`.
- Base commit: `e27edf6 feat(v2): add job enrichment review pipeline`.
- S4 state: merged to `main`, deployed, live-smoked, and PR checks green.

## Goal

Matching supports both directions:

- candidate -> jobs: retained candidate sees recommended and invited jobs.
- job -> candidates: an enriched job can produce a ranked retained-candidate
  list with reasons, risks, missing information, and a recommended action.

S5 is a matching/debug sprint. It must not send live outbound. S6 owns outbound
activation.

## Product Locks

- WeKruit is a C-end candidate retention marketplace, not an employer ATS.
- Candidate profile is the durable supply asset; job is a demand event.
- Candidate-facing surfaces stay on `candidate.wekruit.com` / `pa.wekruit.com`
  through `apps/pa-landing`.
- Admin-only debug/review surfaces stay under `wekruit-pa.web.app/admin/**`.
- Employer surface remains passed-profile-only.
- First interview is never blocked by match score once a candidate enters a job
  flow.
- User tags and job tags share the canonical vocabulary in
  `packages/shared-tags`.
- Preserve v1.6 matching cascade decisions: hard filters stay explainable, soft
  scores stay separate, sponsorship silence remains unknown rather than false.

## Existing Upstream State

- S1 added marketplace profile, candidate-job state, match, outbound invite,
  feedback, correction, and employer-visible profile contracts.
- S2 added identity/claim behavior so candidate handles map to durable profiles.
- S3 added bulk resume intake without outbound side effects.
- S4 added approved job-enrichment drafts and promotion into public-safe
  `pa-jobs/{jobId}` and matching fields on `matching-jobs/{jobId}`.

## S5 Boundary

In scope:

- Contract changes needed for two-way match evidence and recommended action.
- Candidate -> jobs matching debug/eval improvements.
- Job -> candidates retrieval and ranking against retained candidate profiles.
- Admin Match Debug for both directions.
- Candidate `/me/matches` route for recommended/invited jobs and reasons.
- HITL/debug output for borderline, promising-but-missing-info, and suppressed
  mismatches.

Out of scope:

- Creating `pa-outbound` rows or sending Sendblue messages.
- Employer candidate browsing beyond passed-profile-only surfaces.
- Candidate route/domain changes.
- Broad new taxonomy outside `packages/shared-tags`.
- Destructive production backfills.

