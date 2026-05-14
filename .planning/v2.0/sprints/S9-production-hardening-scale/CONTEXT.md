# S9 Context - Production Hardening + Scale

## Current State

- Worktree: `.claude/worktrees/v2-S9-production-hardening-scale`.
- Branch: `codex/v2-S9-production-hardening-scale`.
- Base: `90aaf29 feat(v2): add S8 flywheel HITL eval (#33)`.
- S9 selected as the next roadmap sprint after S8 merged to `main`.
- Worktree is clean at sprint start.

## Product Lock

S9 prepares the candidate-retention marketplace for sustained real use. It does
not change the product model:

- Candidate is the durable asset.
- Job is a demand event.
- Candidate routes stay on `candidate.wekruit.com` / `pa.wekruit.com`.
- Admin routes stay on `wekruit-pa.web.app/admin/**`.
- First interview is never blocked by match score.
- Employer/admin passed-profile visibility remains passed-profile-only.
- Live outbound remains approval-gated.

## Upstream Evidence From S8

S8 shipped and deployed:

- `paAdminFlywheelEvalSnapshot`
- `paCandidateProfileCorrection`
- `paFlywheelCorrectionEvalArtifact`
- `/admin/flywheel-eval`
- `/me/profile` candidate correction panel
- `pa-eval-artifacts` contract and persistence

S8 live no-contact smoke passed:

- candidate job route 200
- candidate profile route 200
- admin flywheel route 200
- admin `/j/:jobId` redirects to candidate domain
- unauth admin callable 403
- unauth candidate correction callable 401
- `pa-outbound` stayed `190 -> 190`

## S9 Roadmap Excerpt

S9 goal: prepare the marketplace for real sustained use.

Required surfaces:

- Candidate stop/delete/export/privacy controls.
- Reliable recommendation and interview flows.
- Admin launch readiness dashboard:
  - queue health
  - Sendblue health
  - account capacity
  - failed parses
  - failed matches
  - failed outbound
  - eval regressions
  - privacy requests

Required backend/data:

- Privacy export/delete.
- Retention policies.
- Cost and rate controls.
- Backups and replay strategy.
- Observability and alerting.
- Sendblue capacity planning.

Required eval/regression:

- Candidate direct job page.
- Bulk-created candidate activation.
- Outbound invite.
- First interview.
- PASS employer-visible.
- NOT_PASS retained.
- Load tests for batch upload and match job -> candidates.

## Working Assumptions

- S9 should prioritize non-destructive readiness first:
  - privacy request intake and admin queue;
  - export preview / delete request workflow;
  - outreach stop switch and dry-run launch checklist;
  - read-only launch readiness dashboard.
- Actual destructive delete/export fulfillment and any live outbound load smoke
  require explicit approval and must be separated from dry-run verification.
- S9 can add production observability callables and dashboard views without
  broadening employer candidate browsing.

## Immediate Risks

- Privacy delete can become destructive quickly; it must start as request and
  preview, not silent deletion.
- Launch readiness can become an Excel-style checklist if not backed by live
  counts and real route/callable smokes.
- Outbound scale work can accidentally send messages; all S9 harnesses must
  default to dry-run and count-only checks.
