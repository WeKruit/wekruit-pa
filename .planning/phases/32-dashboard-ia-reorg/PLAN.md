# Phase 32 — Dashboard IA Reorg + Stress Harness + Playbooks/Personas CRUD — PLAN

**Status:** ✅ COMPLETE 2026-04-29
**Owner:** P9-B (Stream A swarm, 4 parallel waves)
**Spec:** [`32-CONTEXT.md`](./32-CONTEXT.md) — 12 success criteria

> Retro-PLAN: Adam's directive `/loop /gsd:autonomous /caveman 不要找我` collapsed
> the discuss-then-plan-then-execute step into a swarm. P9-B shipped the 8 wave
> commits + 3 deploy-fix commits inline; this PLAN.md is written at closeout to
> satisfy GSD shape-of-record (every phase carries a PLAN.md sibling to its
> CONTEXT.md). Tasks below mirror the actual commit topology, not the discovery
> sequence.

## Tasks

### T1 — Wave 1: IA Reorg (P0)

**Status:** ✅ commit `9031d81 feat(32/W1)`

- Delete `apps/dashboard-web/src/pages/Playground.tsx` + `/playground` route
- Delete standalone `/platform` page; merge content into `/admin/flags`
- Demote `/operations` out of sidebar (still routable from Overview failure
  card + UserDetail debug drawer)
- Reorganize sidebar into 5 categories with `nav-section-label` headers:
  Monitor / Agent / Eval / Integrations / Platform
- Add placeholder routes for `/agent/playbooks`, `/agent/personas`,
  `/eval/voice-review`, `/eval/n-round-sim` (filled by T2c + T3)
- Soft-redirect `/playground` → `/eval/n-round-sim` and `/voice` →
  `/eval/voice-review` (keep muscle memory + bookmarks alive)

### T2 — Wave 2: UX P1 Fixes

**Status:** ✅ 4 sub-commits

- **T2a** `2d37141 feat(32/W2a)` — `Conversations` row redesign
  (`Handle / Status / Risk / Last active / Agent / Needs action` cols;
  `Latest` becomes Handle tooltip; raw errors moved to per-row
  "Review error" link to UserDetail debug drawer)
- **T2b** `f041413 feat(32/W2b)` — `UserDetail` `OperatorSummary` top card
  + chat-stream Turns tab + system events default-hidden + nested
  Turns/Outbound/Connectors/Audit/Memory tabs
- **T2c** `f29a3b6 feat(32/W2c)` — split `/voice` → `/eval/voice-review`
  (rating queue) + `/eval/n-round-sim` (LLM-vs-LLM lab)
- **T2d** `47fa1a0 feat(32/W2d)` — `Flags` history → side drawer +
  product-grade error copy (`无法加载历史，缺少审计索引` + admin button;
  no raw Firestore composite-index URL)

### T3 — Wave 3: Playbooks + Personas CRUD

**Status:** ✅ 2 sub-commits (CRUD pkg + dashboard pages)

- **T3a/b** `7bc163a feat(32/W3a,W3b)` — `packages/agent-registry/src/`
  - `playbooks.ts` — schema + Firestore CRUD + `compileTriggers` +
    `composePlaybooks` + `seedDefaultPlaybooks` (idempotent — seeds
    `headhunter` playbook from `seed.json` `headhunterTriggerRegex`
    on first call, no-ops thereafter)
  - `personas.ts` — soul.md three-file structure (`SOUL` / `STYLE` /
    `examples`) + audit-history sub-collection + `seedDefaultPersonas`
    (3 personas: `anxious_grad`, `formal_em`, `chatty_curious`)
  - 33/33 unit tests pass (`@pa/agent-registry test` clean)
- **T3c** `370415f feat(32/W3c)` — dashboard pages
  - `apps/dashboard-web/src/pages/Playbooks.tsx` — Handbook-style
    editor with regex lint + addendum body + audit timeline + revert
  - `apps/dashboard-web/src/pages/Personas.tsx` — three-tab editor
    (soul / style / examples) + same audit + revert pattern
  - Both pages share Phase 29 Handbook editor visual idiom for
    consistent operator UX
- Orchestrator wiring: `HEADHUNTER_TRIGGER_RE` constant remains as
  zero-downtime fallback; runtime composes playbooks from Firestore
  via 30s in-memory cache (mirrors Phase 24.5 flag-cache pattern)

### T4 — Wave 4: Backend (Stress Harness + Outbox Repair + Logging)

**Status:** ✅ commit `4a92962 feat(32/W4)` + 2 deploy-fix follow-ups
(`cd75b2c` paSendblueOutbox, `a58eafb` dashboard.json gcloud reject,
`20eb5ed` NRoundSim CORS + Sendblue header drift)

- `apps/stress/` new package — Artillery scenarios (staging-only):
  - `scenarios/inbound-burst.yml` — 10 VU × 100 msg × 10 min →
    `paSendblueInbound` (verifies 21st-message-blocks rate-limit
    semantics still hold under concurrent burst)
  - `scenarios/upstream-webhook.yml` — 5 VU × 50 events × 5 min →
    `paUpstreamEventWebhook` (HMAC + dedupe under flood)
  - `scenarios/downstream-fire.yml` — 1 turn/sec × 5 min → admin
    `evalDownstreamTriggers` (post-turn hook stays async)
  - Reports: rate-limit hit %, Firestore tx retry %, P50/P95/P99
    latency, error rate
- `apps/functions/src/__tests__/sendblue-outbox-repair.md` —
  investigation runbook for last `paSendblueOutbox` 1/10 deploy fail.
  Root cause: env/secret overlap on `SENDBLUE_API_KEY` (defined in
  both `runtimeOptions.secrets` and `defineSecret`); fix in `cd75b2c`
  removed dual-bind, redeploy green.
- `config/cloud-logging/dashboard.json` — 4 panels for
  `gcloud monitoring dashboards create`:
  Sendblue daily quota / per-user rate-limit hits / abuse events /
  CF error rate. (`a58eafb` removed gcloud-rejected fields and
  fixed scorecard color thresholds.)

## Dependency / Conflict Notes

- **App.tsx routes:** P9-A's Phase 30 added `/admin/downstream-triggers`;
  P9-B's Wave 1 added 4 placeholder routes. No conflict — different
  prefixes. Both sets coexist in current `App.tsx`.
- **packages/pa-orchestrator/src/index.ts:** P9-A's Phase 30 added
  post-turn eval hook; P9-B's Wave 3 reads playbooks from Firestore
  via cached loader. Adam's uncommitted `index.ts` modifications
  preserved (P9-B did not touch that file).
- **packages/agent-registry/src/seed.json:** P9-A's Phase 29 added
  `handbookSeed`; P9-B's Wave 3 reads `headhunterTriggerRegex` for
  `seedDefaultPlaybooks`. Additive — no key clash.
- **Adam uncommitted (DO NOT TOUCH):**
  `packages/pa-orchestrator/src/voice/llm-rewriter.{ts,test.ts}`,
  `apps/functions/src/admin-bootstrap.ts`,
  `packages/pa-orchestrator/src/{downstream,index}.{ts,test.ts}` —
  P9-B respected boundary, all Wave 3 orchestrator wiring went
  through `agent-registry` cache layer instead of touching
  `pa-orchestrator/src/index.ts`.

## Verification

- `pnpm typecheck` — clean across all 10 workspaces
- `pnpm --filter @pa/agent-registry test` — 33/33 pass
- `pnpm --filter @pa/pa-orchestrator test` — 201/201 pass
- Dashboard `tsc --noEmit` clean (vite bundle not exercised in this
  closeout pass; production deploy uses CI pipeline)
- Manual smoke: each new route resolves; old routes redirect; staging
  Artillery `inbound-burst` ran and surfaced expected 21st-message
  rate-limit at concurrency (Wave 4 acceptance)

## Cross-stream sync

- **S3 (Phase 38 Memory Policy):** `seedDefaultPersonas` writes
  current Bible voice (Claire `default` agent v7.4 from `seed.json`)
  into Firestore `pa-personas/{personaKey}` so Phase 38 can read
  voice from a stable Firestore source instead of inline strings.
