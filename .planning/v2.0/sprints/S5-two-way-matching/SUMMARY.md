# S5 Summary

**Status:** Landed, deployed, and smoke-verified.
**Date:** 2026-05-13.

## Current State

- Branch: `codex/v2-S5-two-way-matching`.
- Base: merged S4 commit `e27edf6 feat(v2): add job enrichment review pipeline`.
- `CandidateJobMatch` now has strict S5 evidence, direction, scoring, lifecycle,
  and version fields in `packages/core-types`.
- `writeCandidateJobMatch` materializes the latest candidate-job edge, writes
  append-only audit evidence, rejects conflicting/stale writes, and does not
  mutate outbound/invite/global candidate docs.
- `apps/job-rec/src/two-way-match.ts` adds pure job-to-candidate scoring/ranking
  using the V16 axis weights, with no Firestore or sender dependency.
- Admin Match Debug now supports both candidate-to-jobs and job-to-candidates
  modes via callables and the existing `/admin/match-debug` route.
- Candidate `/me/matches` is served only from the candidate landing SPA and reads
  public-safe match cards through a callable; raw match evidence and actions stay
  server-side.
- Local verification is green. See `ACCEPTANCE.md` for exact command results.
- Firebase Functions deploy completed; Firebase created `paAdminJobMatchDebug`
  and `paCandidateListMatches` and updated the existing codebase.
- The landing target was redeployed a second time with `VITE_CV_INGEST_URL`
  explicitly set so the existing CV upload path kept its backend URL.
- Live smokes passed: candidate job page `200`, candidate `/me/matches` `200`,
  candidate `/j/:jobId/cv` `200`, stale admin `/j/:jobId` `301` to candidate
  domain, admin `/admin/match-debug` `200`, unauth callable probes blocked, and
  `pa-outbound` stayed at `190`.

## Next Gate

S5 landed on `main` as
`16705a5 feat(v2): add S5 two-way matching`. S6 has already landed after S5.
