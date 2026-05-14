# `pa-agent-ranking-results` Firestore rules note

V2 external-supply Wave A added the `pa-agent-ranking-results` Firestore
collection (see `packages/core-types/src/collections.ts` →
`PA_COLLECTIONS.agentRankingResults` + the bare `PA_AGENT_RANKING_RESULTS`
const).

## Required rule

When the agent-ranking writer lands (Wave C / Executor D), append the
following block to `config/firebase/firestore.rules` inside the same
"v2.0 external-supply — operator-only intake/eval/outreach" section
that already gates `pa-external-sourcing-batches`,
`pa-external-candidate-records`, `pa-candidate-source-links`,
`pa-candidate-evaluation-runs`, `pa-candidate-company-job-evaluations`,
`pa-agent-research-tasks`, `pa-outreach-plans`, etc.:

```
// V2 — operator-only read on per-candidate agent ranking row.
// Mutations only via Admin SDK / callable (paExternalSupplyRunAgentRanking,
// paExternalSupplyApproveAgentTier, paExternalSupplyOverrideAgentTier).
match /pa-agent-ranking-results/{resultId} {
  allow read: if isPaOperator();
  allow write: if false;
}
```

## Cross-reference

The pattern mirrors the V1 `pa-external-sourcing-batches` block in
`config/firebase/firestore.rules` lines 405-408 (and siblings 409-440).

- Public / candidate clients must never see agent-ranking rows.
- All mutations are admin-gated callables that use the Admin SDK and
  therefore bypass these rules.

## Why Wave A does not deploy the rule

Lead resolution **L-A3** (see
`.planning/external-supply-v2/EXECUTOR-PLANS.md` §A): Wave A only locks the
collection name and contracts. Deploying the rule before the collection has
any docs is wasted churn. Executor D adds the actual `firestore.rules` block
in the same commit that lands the agent-ranking writer, so the rule and the
first writes ship together.

When D lands the writer:

1. Append the rule block above to `config/firebase/firestore.rules`.
2. Run `firebase deploy --only firestore:rules --project wekruit-5f89b`
   (or let the agent-rank callable deploy pull it in via the existing
   `firebase.json` rules entry).
3. Delete this note (or replace it with a one-line "rule lives in
   `config/firebase/firestore.rules`" pointer if it stays useful for
   future readers).
