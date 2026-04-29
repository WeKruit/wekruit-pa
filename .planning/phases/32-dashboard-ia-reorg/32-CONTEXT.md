# Phase 32 — Dashboard IA Reorg + Stress Harness + Playbooks/Personas CRUD

**Spawned:** 2026-04-28 (post Phase 31 ship + neighbor-agent UX audit + Adam frustration on stress/QA gap)

**Estimate:** 3 dev-days (4 parallel waves)

## Why

Neighbor-agent UX audit revealed:
1. **IA error layer** — runtime/debug pages mixed with operator pages → 工程内部台 instead of 高判断运营台
2. **No QA process** — first 14-page real test from outside this repo
3. **No stress test** — rate-limit unit tests pass (71 green) but never tested under concurrent burst
4. **Internals over evidence** — Flags→History exposes Firestore index URLs; Handbook empty-state names admin scripts

Adam directive (verbatim 2026-04-28): "一次性推完，swarm team来做事情" + "/caveman /gsd:autonomous /loop, 不要找我".

## Goal

Single closed-loop ship that converts the dashboard from engineering console → operator console + closes backend stress-test gap + delivers soul.md-style Playbooks/Personas CRUD for N-round sim.

## Success Criteria

1. **IA reorg** — sidebar reorganized into 5 categories (Monitor / Agent / Eval / Integrations / Platform), Playground deleted, Platform merged into Flags, Operations demoted to drawer
2. **Conversations row** — `Handle / Status / Risk / Last active / Agent / Needs action` columns; `Latest` reduced to 1-line summary; raw errors moved to drawer
3. **UserDetail layout** — `Operator Summary` top card; transcript as chat stream; system events default-hidden; Turns/Outbound/Audit/Memory as nested tabs
4. **Voice page split** — `/eval/voice-review` (rating queue) + `/eval/n-round-sim` (LLM-vs-LLM dedicated)
5. **Flags history** — drawer (not full page); error message is "无法加载历史，缺少审计索引" + admin action button (no raw Firestore URL)
6. **Playbooks CRUD** — `/agent/playbooks` Firestore-backed (`pa-playbooks/{playbookKey}`) with regex trigger + addendum body + audit + revert; orchestrator wires to replace inline `HEADHUNTER_TRIGGER_RE` constant
7. **Personas CRUD** — `/agent/personas` Firestore-backed (`pa-personas/{personaKey}/{soul,style,examples}`) following soul.md three-file structure; `simulateConversation` reads from Firestore instead of inline strings
8. **Artillery stress harness** — 10 concurrent users × 100 turns × 10 minutes against staging Sendblue webhook; reports rate-limit hit %, Firestore tx retry %, P95 latency
9. **paSendblueOutbox** — last deploy 1/10 CF failed; investigated and re-deployed green
10. **Cloud Logging dashboard** — 4-panel JSON config committed (Sendblue quota / rate-limit / abuse / CF error rate)
11. All `pnpm typecheck` + `pnpm test` green
12. Deployed to staging; Adam smoke-tests 1 conversation end-to-end

## Wave Plan

### Wave 1 — IA Reorg (P0, 0.5 day, 1 agent)
- Delete `/playground` route + `apps/dashboard-web/src/pages/Playground.tsx`
- Delete `/platform` route + content merged into Flags page
- Move `/operations` out of sidebar; only reachable from Overview failure-card / UserDetail debug drawer
- Reorganize sidebar into 5 categories with section headers
- Add placeholder routes for `/agent/playbooks` `/agent/personas` `/eval/voice-review` `/eval/n-round-sim` (Wave 2/3 fill)

### Wave 2 — UX P1 Fixes (1 day, 1 agent)
- `Conversations` row redesign
- `UserDetail` `Operator Summary` + chat stream
- `Voice.tsx` split into `VoiceReview.tsx` + `NRoundSim.tsx` pages
- `Flags` history → side drawer + product-grade error message

### Wave 3 — Playbooks + Personas CRUD (1 day, 1 agent)
- `packages/agent-registry/src/playbooks.ts` — schema + CRUD + composeRegexTriggers
- `packages/agent-registry/src/personas.ts` — soul.md three-file schema (SOUL/STYLE/examples)
- `apps/dashboard-web/src/pages/Playbooks.tsx` — Handbook-style editor + audit + revert
- `apps/dashboard-web/src/pages/Personas.tsx` — three-tab editor (soul/style/examples) + same audit pattern
- Orchestrator: replace `HEADHUNTER_TRIGGER_RE` with Firestore-loaded playbooks (cached 30s like flags)
- `simulateConversation`: replace inline persona strings with Firestore lookup
- Seed defaults action: `seedPlaybooks` + `seedPersonas` (headhunter playbook + 3 existing personas)

### Wave 4 — Backend (1 day, 1 agent)
- `apps/stress/` new package — Artillery scenarios:
  - `scenarios/inbound-burst.yml` — 10 users × 100 messages × 10 min
  - `scenarios/upstream-webhook.yml` — HMAC-signed webhook flood
  - `scenarios/downstream-fire.yml` — sustained per-turn webhook fires
- Reports: rate-limit hit %, Firestore tx retry, P50/P95/P99 latency, error rate
- `apps/functions/src/__tests__/sendblue-outbox-repair.md` — investigate paSendblueOutbox last deploy fail (env var? IAM? schema mismatch?), repair, re-deploy
- `config/cloud-logging/dashboard.json` — 4 panel JSON for `gcloud monitoring dashboards create`

## Out of Scope

- Phase 23 Closed-Beta Onboarding flow (separate phase later)
- Self-evolve cron actual enable (gated behind 2-week soak)
- Visual style overhaul (邻组 said: keep current `warm ivory / restrained / trustworthy`)

## Constraints

- **Cannot break existing /voice page UX during Wave 2 split** — soft-redirect old route → new
- **Cannot break running playbook**`HEADHUNTER_TRIGGER_RE` — Firestore replacement must seed `headhunter` playbook on first run (zero-downtime)
- **Cannot pollute prod with stress-test traffic** — Artillery must target staging-only, separate Sendblue test number
- **Cannot break existing rate-limit semantics** — Artillery must verify the 21st-message-blocks behavior still holds under concurrency

## Risks

| Risk | Mitigation |
|---|---|
| Playbooks Firestore lookup adds 30-200ms per turn | 30s in-memory cache like flags |
| Artillery stress test reveals Firestore tx serialization bottleneck | This is the goal — surface bug, file fix in Phase 33 |
| Wave 3 inline-string→Firestore for personas breaks existing N-round sim | Seed defaults idempotent before deploy; e2e test sim before merge |
| Sidebar regroup breaks user muscle memory | Keep all old routes alive (redirect, not 404) for 1 milestone |
