# S4 Context - Job Enrichment

## Base

- Branch: `codex/v2-S4-job-enrichment`.
- Worktree: `.claude/worktrees/v2-S4-job-enrichment`.
- Base commit: `8484a36 feat(v2): add bulk resume intake (#26)`.
- S3 state: merged, deployed, and live-smoke verified.

## Goal

Every new job becomes enriched demand before matching:

- canonical job tags from `packages/shared-tags`
- hard constraints
- soft scoring signals
- generated prescreen config draft
- generated scoring rubric
- Claire candidate-facing brief
- generated job-intake eval fixtures
- confidence and HITL review flags

## Product Locks

- WeKruit is a C-end candidate retention marketplace.
- Candidate profile is durable supply; job is a demand event.
- Candidate routes stay on `candidate.wekruit.com` / `pa.wekruit.com`.
- Admin-only job enrichment review stays on `wekruit-pa.web.app/admin/**`.
- Employer surface remains passed-profile-only.
- User tags and job tags share `packages/shared-tags`.
- Never infer `sponsorship=false` from silence.
- Keep `roleFunction` and `industrySector` orthogonal.
- Seniority cannot rely only on title regex.
- Generated prescreen config is a draft unless confidence and coverage are high.
- HITL edits must write correction/flywheel events and become eval fixtures.

## Existing System Facts

- `packages/pa-job-tag-enricher` already extracts canonical role, industry,
  relevant tags, skills, seniority, sponsorship hint, locations, job type, and
  confidence.
- `apps/functions/src/auto-enrich-matching-jobs.ts` enriches `matching-jobs`
  on write and stores v1.9 tag fields plus sponsorship inference.
- `apps/functions/src/enrich-job-tags-http.ts` exposes a server-side API-key
  HTTP wrapper around the tag enricher.
- `apps/dashboard-web/src/pages/JobPrescreen.tsx` edits current job prescreen
  config.
- `packages/core-types/src/marketplace.ts` already contains correction,
  feedback, match, and employer-visible profile primitives from S1.
- `config/firebase/firestore.rules` exposes `pa-jobs` to operators for write
  and public reads only when `publicVisible == true`.

## Lead Decisions

- S4 internal drafts cannot live directly on `pa-jobs/{jobId}` because public
  jobs are readable as whole documents when `publicVisible == true`.
- Durable draft/review state lives under the admin-only subcollection:
  `pa-jobs/{jobId}/enrichment/{draftId}`.
- Generated eval fixtures live under the admin-only subcollection:
  `pa-jobs/{jobId}/enrichment-eval-fixtures/{fixtureId}`.
- Approved public-safe output can be promoted intentionally to selected
  `pa-jobs/{jobId}` fields, but draft HITL notes, internal scores, and raw
  review metadata never go on public-readable job documents.
- Scoring rubric is first-class enrichment metadata next to the draft
  `prescreenConfig`, not buried inside eval fixtures.
- Claire brief remains a separate candidate-facing brief field. It does not
  automatically replace public job page copy in S4.
- `approvalReady` is a machine readiness flag, not admin approval. Admin
  approval requires explicit `approved` status through server code.

## S4 Boundary

In scope:

- Enriched job demand contract.
- Persistence helpers for enrichment draft, review state, and correction events.
- Admin review UI for enrichment output.
- Server callable/API to generate or refresh enrichment drafts.
- Draft prescreen config, rubric, Claire brief, and eval fixture generation.
- Rules/index checks and acceptance/live-smoke ledger.

Out of scope:

- S5 two-way matching implementation.
- S6 outbound activation.
- Employer broad candidate browsing.
- Candidate route/domain changes.
- Destructive backfills without explicit dry-run/apply split.
- Rewriting prescreen runtime beyond consuming a draft config shape.
