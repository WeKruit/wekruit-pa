# External Candidate Supply V2 — ACCEPTANCE ledger

> Live evidence ledger. Each row → pass / fail / known_gap with the exact command run + artifact path. Lead updates as waves complete.

| # | Acceptance criterion | Status | Evidence |
|---|---|---|---|
| 1 | 100+ row fixture batch drag-drops, auto-adapter-detected with ≥0.9 confidence on the right adapter. | pending | |
| 2 | Preview pane forecast counters match post-commit reality within ±5%. | pending | |
| 3 | Preview server writes 0 Firestore docs (dry-run hygiene). | pending | |
| 4 | Identity resolution after commit yields counts matching preview's identity-forecast. | pending | |
| 5 | Tag-enrichment forecast matches what `mergeUserTags` + `mergeWeakGlobalTags` actually wrote. | pending | |
| 6 | Adapter registry promotes `juicebox / lessie / coresignal / manual_csv` from switch dispatch; existing V1 tests stay green. | pending | |
| 7 | Detection unit test: each adapter's golden fixture top-scores ≥0.9; an unknown CSV top-scores ≤0.6. | pending | |
| 8 | `paExternalSupplyRunAgentRanking` runs against a real evaluation set in `dryRun: true` mode and returns prompts + estimates with 0 LLM calls + 0 Firestore writes for ranking rows. | pending | |
| 9 | `paExternalSupplyRunAgentRanking` in live mode writes one `pa-agent-ranking-results` row per ranked candidate, with `proposedAgentTier` + `agentRationale` + `agentRisks` + `agentRecommendedAction` + ensembleVotes. | pending | |
| 10 | Per-call cost recorded in `pa-tool-calls` ledger. | pending | |
| 11 | Budget cap: a synthetic 200-row run with default `$10` budget aborts before any LLM call when projected > cap; returns `abortedReason: "budget_exceeded"`. | pending | |
| 12 | Operator override writes a `pa-agent-ranking-results.{ status: "overridden", approvedTier, correctionEventId }` AND a `pa-correction-events` row with `targetType: "agent_ranking_result"`. | pending | |
| 13 | `EvaluationAgentRanking.tsx` dashboard page renders the ranking table + ensemble columns + approve / override controls. | pending | |
| 14 | Audit page trace renders the agent-ranking step alongside the deterministic rubric + agent-research findings. | pending | |
| 15 | v1.9 candidate journey regression: `pnpm --filter pa-orchestrator test` stays at full pass. | pending | |
| 16 | V1 external-supply regression: `pnpm --filter @pa/external-supply test` + `pnpm --filter functions test` (V1 paths) stay green. | pending | |
| 17 | QA evaluator weekly extended sampler computes operator-override rate; weekly run with mock data produces a non-zero `agentTierAcceptanceRate` row in `pa-source-quality-metrics`. | pending | |
| 18 | Dashboard end-to-end click-through (drag-drop → preview → commit → resolve → evaluate → agent-rank → approve → outreach draft → Mailgun dry-run sync → reply event back) walked without terminal commands. | pending | |
| 19 | Live prod e2e via `apps/functions/scripts/external-supply-v2-prod-smoke.ts` captures `agent-rank.json` with per-candidate prompt + response + tier. | pending | |
| 20 | Doc-id audit: every new id is a uuid or sha256 hash; zero raw email/phone/LinkedIn strings appear in `pa-agent-ranking-results` doc ids. | pending | |
| 21 | Candidate-domain isolation: `apps/pa-landing` has zero references to `agent-ranking` / `external-supply` V2 surfaces. | pending | |
| 22 | LinkedIn-automation invariant: no new outbound `linkedin.com` HTTP from V2 code. | pending | |
| 23 | `firebase.json` predeploy gate green for the new callables. | pending | |
| 24 | Final SUMMARY.md lists commands run + pass/fail per row + remaining risks. | pending | |
