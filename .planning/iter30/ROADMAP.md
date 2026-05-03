# iter30 ROADMAP — execution synthesis

**Status (2026-05-03)**: 6 detail-plans landed, Adam day-0 answered. **Ready for execution.**

---

## Inputs

| Doc | Lines | Status |
|---|---|---|
| [PLAN.md](./PLAN.md) | 600+ | v2 (post-audit) |
| [PLAN-AUDIT.md](./PLAN-AUDIT.md) | 453 | BLOCK→PASS after edits |
| [discussion.md](./discussion.md) | 740+ | Adam decisions locked top |
| [ws-1-detail.md](./ws-1-detail.md) | 1280 | parseResume v2 |
| [ws-2-7-detail.md](./ws-2-7-detail.md) | 1158 | tag pipeline + profile |
| [ws-3-6-detail.md](./ws-3-6-detail.md) | 1057 | RunContext + guardrails |
| [ws-4a-detail.md](./ws-4a-detail.md) | 980 | skill schema + stacker + intent |
| [ws-4b-detail.md](./ws-4b-detail.md) | 1589 | 13 new skills + 26 YAML |
| [ws-8-detail.md](./ws-8-detail.md) | 1503 | dashboard + boost + explainer |

---

## Cross-WS reconciliation (synthesis fixes)

These overlaps/conflicts must be resolved BEFORE code lands:

| # | Issue | Fix | Owner |
|---|---|---|---|
| 1 | WS2+7 detail still has 4-phase scope (P4 HDBSCAN) | Defer P4 to iter31, WS2 = 4w P1+P2+P3 | WS2+7 eng |
| 2 | WS4-B 26 YAML use phones `+19999992896-921` | Rewrite to Sendblue conversation-form (Adam Q6 lock) | WS4-B exec |
| 3 | WS4-A schema lacks ctx-state field | Add `requiresCtxState: { turn_gap_ge_2h?, resume_recently_accepted?, ... }` to V2 schema, enforced by SkillStacker | WS4-A exec |
| 4 | WS4-B `cv_followup` empty regex | Schema permit `regexTriggers=[] && requires.length>0` combo | WS4-A exec |
| 5 | WS8 stack: Tailwind+shadcn vs current ui.tsx | Adopt shadcn/ui (MIT, Radix), add Tailwind, retain ui.tsx for app shell | WS8 exec |
| 6 | WS2 cost: $0.87 (research) vs $2.69 (detail) | Cost gate raised to ≤$3/mo (already in PLAN) | locked |
| 7 | Old iMessage SDK retire | Cleanup task added: delete Apple-AID direct paths | new task |
| 8 | DEEPSEEK_API_KEY deprovision | Adam handles, code path already nano-only | Adam |

---

## 3-wave 4-week execution

### Wave 1 (W1, day 1-7) — backbone, parallel start

**4 engineer agents, all on Opus** (Adam Q8):

| Engineer | WS | Day-1 atomic task |
|---|---|---|
| Eng-A | WS3 RunContext | Define `ClaireContext` Zod + `turnLoader.ts` 4-tier batch read |
| Eng-A | WS6 Guardrails | (after Eng-A finishes WS3 day 4) port AB-strip + crisis-trailer + slang to OutputGuardrail[] |
| Eng-B | WS1 parseResume | Day-1 = MS5.1 mem0Add metadata signature fix + verify Qdrant round-trip |
| Eng-C | WS2 tag pipeline | Day-1 = `@wekruit/shared-tags` GH Packages skeleton + Zod for 3 collections |
| Eng-D | WS8 dashboard | Day-1 = `pnpm add shadcn-ui`, Tailwind config, port Playbooks.tsx primitives |

**Wave 1 acceptance** (end of W1):
- ✅ ClaireContext + turnLoader + 28 reads collapsed to 1 batch (latency -200ms)
- ✅ mem0Add metadata round-trips (BLOCKER GO/NO-GO)
- ✅ shared-tags published to GH Packages
- ✅ Match-weights table seeded in Firestore (parity with TS const)

### Wave 2 (W2, day 8-14) — content + integration

| Engineer | WS | Day-8 task |
|---|---|---|
| Eng-A | WS6 close | Wire 5 InputGuardrails + 7 OutputGuardrails into Runner |
| Eng-B | WS1 close | Parser port + 3-tier retry + qaBank→Mem0 + tag-event coupling |
| Eng-C | WS2 P2 | Worker (free Qwen-7B normalize + alias-table seed + Firestore writes) |
| Eng-D | WS8 P2 | BoostCalculator + dashboard pages live + match-explainer w/ weights |
| Eng-E | WS4-A | SkillSchemaV2 + SkillStacker + 6 existing migrate + LLM intent classifier |
| Eng-F | WS4-B | 13 new skills upload + 26 YAML scenarios (Sendblue-form) |

**Wave 2 acceptance** (end of W2):
- ✅ All guardrails wired, iter25-29 normalizer tests still green
- ✅ parseResume v2 deploy with `paResumeParserV2=true` for staff
- ✅ 19 skills loaded, regex+LLM intent router shipping behind `paSkillRouterV2Enabled`
- ✅ **BIZ DEMO READY**: WS8 dashboard polished, 6-bullet checklist green

### Wave 3 (W3-W4, day 15-28) — eval + ramp + closed-beta

| Engineer | Task |
|---|---|
| Eng-A | Eval baseline preservation (iter28-29 LLM-judge re-run, ≤0.02 variance) |
| Eng-B | Tag-event coupling end-to-end test (cv-ingest fires → entity-tags appears) |
| Eng-C | WS2 P3 backfill + scraping repo PR |
| Eng-D | Match-explainer history page + biz-demo dry-run |
| Eng-E | LLM-judge 38-scenario gate (19 skills × zh/en, ≥80% pass) |
| Eng-F | Old iMessage SDK retire cleanup |

**Wave 3 acceptance** (end of W4):
- ✅ Closed-beta ramp 1% → 10% → 100% via flags
- ✅ All baselines preserved
- ✅ 1000-user cost projection logged + iter31 cost-opt scoped

---

## Day-1 (now) atomic tasks (4 engineers can spawn in parallel)

**Eng-A (WS3 RunContext)**:
1. Create `packages/pa-orchestrator/src/run-context.ts` with full Zod from ws-3-6-detail.md §3
2. Create `packages/pa-orchestrator/src/turn-loader.ts` with 4-tier batch read
3. Add unit test: ctx round-trip from mock Firestore

**Eng-B (WS1 mem0Add fix — BLOCKER)**:
1. Read `packages/memory/src/mem0.ts:304`
2. Extend signature `mem0Add(userId, content, options?: { metadata?, agentId? })`
3. Verify round-trip via Qdrant direct read script
4. **GO/NO-GO: must complete day-1**

**Eng-C (WS2 shared lib)**:
1. Create `packages/shared-tags/` (or new repo `wekruit-shared-tags` published to GH Packages)
2. Zod for `pa-canonical-tags`, `pa-tag-events`, `pa-entity-tags`
3. `recordTagEvent()` TS impl + Python port stub

**Eng-D (WS8 stack setup)**:
1. `pnpm add tailwindcss postcss autoprefixer` to `apps/dashboard-web`
2. `pnpm dlx shadcn@latest init`
3. Add 1 sample shadcn Table to verify integration
4. Seed `pa-match-weight-tables/ai-agent-2026` from `match-weights.ts:49-220` (script `apps/functions/scripts/seed-match-weights.mjs`)

---

## Critical-path gates

| Gate | Day | Block on fail |
|---|---|---|
| **mem0Add round-trip** | D1-D2 | WS1 entire blocked |
| **Qwen-7B free-tier sustains 8 RPS** | D3-D4 | WS2 + WS5 fall back to paid (escalate) |
| **shadcn render parity with ui.tsx** | D2 | WS8 stack pivot |
| **iter28 LLM-judge baselines preserved** | D14 | WS4 V2 cutover blocked |
| **Biz-demo 6-bullet checklist** | D14 | WS8 ramp blocked |

---

## Risks (cross-cutting)

1. Free Qwen-7B rate limit at 12k events/day load test — alert configured per Adam Q2
2. shadcn/Tailwind add to existing dashboard repo may collide with ui.tsx CSS — D1 verify
3. Sendblue test channel cost during 38-scenario eval (~$0.50/run × 38 × 5 iter = ~$95)
4. ClaireContext backward-compat: existing turn handlers must tolerate ctx undefined during ramp
5. Iter30 4w timeline assumes zero engineer churn; buffer is W4 only

---

## What NOT to do during execution

1. NO new V4-Pro adoption (locked dropped)
2. NO Apple-AID direct iMessage testing (locked Sendblue-only)
3. NO Sonnet 4.5 in parser fallback (locked nano + 4.1-mini + 4.1-nano)
4. NO regex-primary skill routing (locked LLM-intent-primary, regex floor only)
5. NO WS2 P4 HDBSCAN this iter (locked iter31)
6. NO BoostCalculator entity-tags read this iter (locked iter31)
7. NO bilingual tag display (locked English-only canonical)
8. NO tag duplication (locked mutex enforcement)

---

## Adam green-light decision points

Before spawning Wave 1 (4 engineers parallel), Adam confirm:

1. **Spawn now?** OR review ROADMAP first?
2. **All 4 engineers Opus?** Cost ~10-20× Sonnet. Confirm.
3. **WS1 mem0Add fix Day-1 GO/NO-GO** — if fails, parseResume v2 entire blocked. Acceptable risk?
4. **shadcn/Tailwind add** to dashboard-web — confirm or "use ui.tsx only".
