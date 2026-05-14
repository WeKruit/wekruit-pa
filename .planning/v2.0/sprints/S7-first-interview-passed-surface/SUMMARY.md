# S7 Summary

**Status:** Landed, deployed, and live-smoked.
**Date:** 2026-05-14.

## Current State

- Branch: `codex/v2-S7-first-interview-passed-surface`.
- Base: initial worktree from `16ab52b feat(v2): add S6 outreach platform
  (#30)`, then rebased over `66917fc feat(v2): external candidate supply
  intake V1 (#29)` before deploy, and prepared for PR over `dcd2ace
  fix(v2): external-supply deploy-unblock + post-ship evidence (#31)`.
- Worktree was created from `origin/main` without touching the dirty root
  checkout.
- Executor `AGENT_PLAN` outputs A-E were integrated before product code edits.
- Core contracts now require prescreen session evidence on first-interview
  events and deterministic employer-visible snapshot ids on PASS.
- PASS terminal action writes one job-scoped employer-visible snapshot and
  advances candidate-job state to `employer_visible`; NOT_PASS and PAUSE do not
  create snapshots.
- Candidate status projection maps `passed` and `employer_visible` to the same
  candidate-facing passed state without exposing employer snapshots.
- `/admin/passed-candidates` reads only `pa-employer-visible-profiles` for the
  requested `jobId`, joins the linked candidate-job state and prescreen
  session, and redacts raw contact/storage values.
- S7 evals, focused/full local checks, Firebase predeploy checks, deploy, and
  live route/auth smokes are green in `ACCEPTANCE.md`.
- Deployment used Node 22 because the global Firebase CLI failed under Node
  25. Targeted S7 functions were deployed to avoid enabling unrelated
  external-supply rollout surface.
- The final PR base includes #31's external-supply optional-secret deploy
  unblock, so S7 does not carry unrelated external-supply code edits. Live
  external-supply outreach remains gated by the existing config path.
- Production no-contact smoke kept `pa-outbound` at `190 -> 190`.

## Next Gate

S7 landed on `main` as
`2c48792 feat(v2): add S7 first-interview passed surface (#32)`. S8 and S9 have
already landed after S7.
