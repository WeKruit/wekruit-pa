# S6 Context - Outreach Platform

## Repo State

- Date: 2026-05-13.
- Worktree: `.claude/worktrees/v2-S6-outreach-platform`.
- Branch: `codex/v2-S6-outreach-platform`.
- Base: `16705a5 feat(v2): add S5 two-way matching` from `origin/main`.
- Main worktree is dirty with unrelated local edits, so S6 was created directly
  from `origin/main` to preserve those changes.

## Upstream S5

S5 added two-way matching without outbound side effects:

- `CandidateJobMatch` strict evidence fields and pure `recommendedAction`.
- `writeCandidateJobMatch` materializes latest match and audit evidence without
  writing outbound or invite rows.
- `apps/job-rec/src/two-way-match.ts` ranks job-to-candidate matches.
- `paAdminJobMatchDebug` and candidate `/me/matches` expose read/debug surfaces.

S6 consumes S5 matches where `recommendedAction` is `auto_outbound` or
`hitl_review`. S6 owns the policy step that converts a match into an invite
draft, queue item, or blocked decision.

## Existing Outreach Primitives

- `packages/core-types/src/marketplace.ts`
  - `OutboundInviteSchema` exists but is minimal.
  - `CandidateJobState` includes `outbound_queued` and `outbound_sent`.
  - Reducer allows `candidate_matched -> outbound_queued -> outbound_sent`.
- `packages/pa-broker/src/outbound-queue.ts`
  - `enqueueOutbound` writes idempotent `pa-outbound` rows.
- `packages/pa-persistence/src/outbound-quota.ts`
  - daily count helper for global outbound quota.
- `apps/functions/src/sendblue/outbox.ts`
  - `paSendblueOutbox` sends `pa-outbound` rows and increments daily quota.
  - retry, stale-sending sweep, dead-letter, and allowlist behavior already
    exist.
- `apps/functions/src/sendblue/pool.ts`
  - sticky `hash(userId) mod activeNumbers.length` number selection.
  - `capacity` is currently only a soft field, not enforced in selection.
- `apps/dashboard-web/src/pages/SendbluePool.tsx`
  - admin edits `pa-config/sendblue-pool` numbers/status/capacity.
- `apps/functions/src/paReverseMatch.ts` and
  `apps/dashboard-web/src/pages/MatchCandidates.tsx`
  - legacy operator reverse-match can notify or bulk notify and writes
    `pa-outbound` directly.
  - This is not the S6 product path because it bypasses typed invite policy and
    batch approval state.

## Locked Invariants

- Candidate routes remain on `candidate.wekruit.com` / `pa.wekruit.com`.
- Admin outreach operations remain on `wekruit-pa.web.app/admin/**`.
- First interview is never blocked by match score.
- `auto_outbound` from S5 is only a recommendation until S6 policy writes an
  auditable invite decision.
- No broad employer candidate browsing.
- Stop/decline/opt-out must prevent future outreach until explicit opt-in.
- Sendblue outreach must respect sticky assignment, cooldowns, duplicate
  suppression, and account/group capacity.
- Large or warmup batches require HITL approval; no accidental live bulk sends.

## Initial Product Shape

S6 should not reuse the old `paReverseMatch` notify path as the primary product
path. The shortest correct path is:

1. Read an approved enriched job and retained/profile-ready candidates with S5
   materialized matches.
2. Apply deterministic outreach policy.
3. Write `pa-outbound-invites` decision rows first.
4. Queue selected invites only when policy is `auto_outbound` and dry-run or
   approval gates allow it.
5. Update candidate-job state through `applyCandidateJobEvent`.
6. Expose admin queue/review/capacity state.
7. Let the existing Sendblue outbox own actual provider delivery.

## Open Risks To Resolve In Plan

- Exact capacity unit: per day, active reachable users, or rolling 24h sends.
- Whether `paReverseMatch` should be deprecated, wrapped, or left as legacy
  admin-only while S6 introduces a separate callable.
- Whether S6 should auto-send live in production or default to dry-run plus HITL
  approval. Given locked safety rules, default should be dry-run/approval first.
- Firestore indexes/rules for admin queue reads and candidate-safe reads.
