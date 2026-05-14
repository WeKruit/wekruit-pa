# S8 Context - Flywheel + HITL + Eval

**Date:** 2026-05-14.
**Branch:** `codex/v2-S8-flywheel-hitl-eval`.
**Worktree:** `.claude/worktrees/v2-S8-flywheel-hitl-eval`.
**Base:** `2c48792 feat(v2): add S7 first-interview passed surface (#32)`.

## Product Invariant Advanced

S8 turns HITL corrections, candidate/job/employer outcomes, and QA runs into a
durable improvement loop. It must not create a broad employer ATS, expose
non-passed candidates, bypass candidate-domain locks, or let LLMs own state
transitions.

## Upstream State

- S7 is merged to `main` as `2c48792`.
- S7 deployed and live-smoked first-interview PASS -> employer-visible
  snapshots, `/admin/passed-candidates`, candidate status projection, and
  no-contact production count `190 -> 190`.
- #31 external-supply deploy unblock is already on `main`; S8 should consume it,
  not re-own that surface.
- Current worktree is clean at sprint start.

## Existing Flywheel Primitives

- `packages/core-types/src/marketplace.ts` already defines
  `FeedbackEventSchema` and `CorrectionEventSchema`.
- `packages/pa-persistence/src/marketplace.ts` already exports
  `writeFeedbackEvent` and `writeCorrectionEvent` append-only helpers.
- `PA_COLLECTIONS.feedbackEvents` and `PA_COLLECTIONS.correctionEvents` are
  locked collection names.
- Current emitters exist but are fragmented:
  - job enrichment correction save writes `pa-correction-events`;
  - external-supply outreach edits write `pa-correction-events`;
  - Instantly webhook writes `pa-feedback-events`;
  - prescreen outcome writes candidate-job state but does not yet emit a shared
    feedback event.
- Dashboard already exposes raw marketplace feedback/correction tables inside
  `/admin/marketplace`, and v1.6 QA evaluator has `/admin/qa-evaluator`.

## S8 User-Visible Gap

- Operators cannot see one S8 flywheel dashboard that connects correction
  events, feedback events, eval artifacts, and marketplace scenario status.
- Human corrections do not consistently generate eval/regression artifacts.
- There is no full marketplace simulation covering bulk upload -> profile merge
  -> job enrichment -> reverse matching -> outbound dry-run -> first interview
  -> passed profile -> flywheel event.
- Candidate self-correction is not yet tied into the same correction-event and
  eval-artifact loop.

## Safety Boundaries

- No live outbound without explicit approval.
- Use dry-run harnesses for outbound, batch, live-network, and costed eval work.
- Redact raw contact, resume storage locators, transcript PII, and prompt text
  before writing correction/eval artifacts.
- Admin/employer surface remains passed-profile-only.
- Candidate flow remains on `candidate.wekruit.com` / `pa.wekruit.com`.

