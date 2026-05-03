# iter30 — Master Plan (post-Adam-decisions 2026-05-03)

**P10 architect**: Claude
**Reviewed by**: Adam (2026-05-03 round)
**Driver decisions**: see [discussion.md](./discussion.md) top section "ADAM DECISIONS 2026-05-03"

---

## North Star (业务驱动)

1. **Closed-beta launch readiness**: Claire bilingual companion + matching + 19 playbooks/skills passing LLM-judge.
2. **Business-team demo readiness**: dashboard showing playbook ops + match-weight ops + match-explainer in production data — Adam will demo SOON.
3. **Cost discipline**: stay on gpt-5.4-nano + free Qwen-7B for everything cheap. Async via Batch API.

---

## 8 workstreams

Each workstream = 1 engineer agent. Engineers run in parallel where the dependency graph allows.

### Dependency graph

```
WS3 (RunContext) ──┬──→ WS4 (Skill V2 + 19 playbook)
                   │       ↓
                   │   WS5 (LLM intent + composability)
                   │
WS3 → WS6 (Guardrails)
                   ↓
WS1 (parseResume v2) — independent, can start day 1
WS2 (Tag pipeline + cross-repo) — depends on shared lib design
WS7 (Unified profile) — depends on WS2 schema landing
WS8 (Boost calc + Dashboard + Explainer) — depends on tag schema (WS2 P1)
```

**Parallelizable from day 1**: WS1, WS2, WS3, WS6
**Wave 2** (after WS3 + WS2 P1 land): WS4, WS5, WS7, WS8

---

## WS1 — parseResume v2 (port VALET, structured-output)

**Engineer**: 1 (Backend, owns CV ingest + Mem0 boundary)
**Effort**: 8-11 dev-days
**Depends on**: nothing (start day 1)

### Goals
- Port VALET parseResume into PA package `packages/pa-resume-parser`
- 4 limits: gate, quota=2, size 5MB, retry chain
- Structured output via OpenAI Responses API JSON schema (gpt-5.4-nano primary; gpt-4.1-mini → gpt-4.1-nano fallback)
- qaBank → Mem0 (extend `mem0Add` signature to accept metadata)

### Hard constraints (Adam-locked)
- **NO Sonnet 4.5** in retry chain — nano + mini + nano-fallback only
- **Structured output mandatory** (JSON schema enforced, not free-text parse)
- **Use OpenAI Batch API** for cv-ingest path (async, 50% cheaper)
- **mem0Add signature fix** is a blocker — must land before qaBank→Mem0

### Deliverables
1. `packages/pa-resume-parser/` package with:
   - `parser.ts` (LLMRouter port, 3-tier fallback)
   - `schema.ts` (Zod schema, ported from VALET, snake→camelCase, with `inferredAnswers[]` for qaBank)
   - `gate.ts` (resumeAccepted check + reject text bilingual)
   - `quota.ts` (FieldValue.increment + 3rd-attempt reject)
   - `size-cap.ts` (HEAD-then-bounded-GET)
   - `qabank-to-mem0.ts` (intentTag mapping + dedupe)
2. `packages/memory/src/mem0.ts` — extend `mem0Add(userId, content, metadata?)` signature
3. `apps/functions/src/cv-ingest/cv-ingest.ts` — replace single-shot nano call with parser package
4. `apps/functions/src/sendblue/webhook.ts` — gate + quota check before fire ingestCv
5. **Tag-event coupling (P3 task, after WS2 P1 lands)**: every qaBank entry produced during cv-ingest also calls `recordTagEvent({userId, rawTag, source: "pa-cv-ingest", evidence: questionText})`. CV is a canonical signal source — must flow into tag pipeline. Detail-plan to spec the rawTag extraction from question-pattern intentTag.
6. Tests:
   - Unit: each gate/quota/size/retry path
   - Integration: full PDF → parsed schema → Mem0 entries (use real PDF fixture)
   - Eval: 10 PDF fixture set, structured-output schema validation pass rate ≥ 95%
   - Cross-coupling: cv-ingest fires → tag-events appear (after WS2 P1)

### Acceptance gates
- [ ] All 4 limits enforced + tested
- [ ] mem0Add metadata round-trips to Qdrant (verify via direct read)
- [ ] qaBank entries searchable in Mem0 with correct intentTag
- [ ] cv-ingest swap deploys without regression on existing flows
- [ ] Sonnet 4.5 NOT in fallback chain

### Reference
[valet-integration.md](./valet-integration.md) (713 lines)

---

## WS2 — Tag ontology + cross-repo unify (shared lib + async pipeline)

**Engineer**: 1 (Backend / data engineer, owns shared schema + worker)
**Effort**: **4 weeks** (P4 HDBSCAN discovery + operator UI deferred to iter31). Original research-doc estimate was 6-7 weeks; iter30 scope is P1+P2+P3 only.
**Depends on**: nothing for P1 schema; P2 worker depends on `@wekruit/shared-tags` package land

### Goals
- 3 Firestore collections (`pa-canonical-tags`, `pa-tag-events`, `pa-entity-tags`)
- New shared package `@wekruit/shared-tags` consumed by both PA + scraping repo
- `recordTagEvent()` write contract with sha256 idempotency
- Async worker: Firestore onWrite trigger normalizes via Qwen-7B (free) + BGE-M3 cosine
- HDBSCAN discovery for new canonical tags
- **Tags English-only, mutually exclusive** (Adam-locked)

### Hard constraints (Adam-locked)
- **English-only canonical** (single `displayName`, no zh/en split)
- **Mutual exclusion**: a user has ONE canonical preference per concept ("prefer ML" → canonical `preference::machine-learning`, no duplicates)
- **Free Qwen-7B for normalize** (NOT DeepSeek-V4-Flash)
- **Cross-repo sharing mandatory** — both PA + scraping write to same `pa-tag-events`
- Don't import ESCO / Lightcast / LinkedIn

### Deliverables
1. New shared package `@wekruit/shared-tags`:
   - `schema.ts` (Zod for all 3 collections)
   - `record-tag-event.ts` (idempotent write, sha256 key)
   - `types.ts` (TagType enum, CanonicalTag, EntityTag interfaces)
   - npm-publishable (or workspace package if monorepo'd)
2. PA changes:
   - `packages/pa-orchestrator/src/voice/realtime-tagger.ts` — rewrite to call `recordTagEvent()`
   - `apps/functions/src/cv-ingest/industry-tags.ts` — alias seed migrate to canonical store
   - Read consumers (`apps/job-rec/src/tag-cluster-rec.ts`, etc.) — switch to `pa-entity-tags`
3. Scraping repo changes (issue PR there):
   - Replace 3 hand-rolled taxonomies with `@wekruit/shared-tags.recordTagEvent()`
4. Worker `apps/functions/src/tag-worker/normalize.ts`:
   - onWrite `pa-tag-events/{eventId}` trigger
   - Hot alias hit → write `pa-entity-tags`
   - Miss → Qwen-7B normalize call → write canonical + entity
5. Worker `apps/functions/src/tag-worker/discovery.ts`:
   - Daily scheduled HDBSCAN over recent events with low confidence
   - Promote new canonical tags
6. Tests:
   - Idempotency: same event sha256 → no duplicate write
   - Mutual exclusion: writing "prefer machine learning" then "prefer ML" → single entity-tag, count++
   - Cross-repo: scraping calls recordTagEvent → PA reads entity-tag

### Acceptance gates
- [ ] PA + scraping both write via shared lib
- [ ] 12k events/day worker stable (load test): p99 ≤ 5s, error rate ≤ 0.1%
- [ ] **Cost ceiling: ≤ $3.00/mo at 12k events/day.** WS2+7 detail-plan recomputed end-to-end with Adam-locked free Qwen-7B = **$2.69/mo** (research-doc $0.87 was 3.1× under). Mostly Firestore reads/writes + Cloud Functions invocations + BGE-M3 embedding (free tier).
- [ ] Mutual exclusion enforced (no "prefer ML" + "prefer machine learning" both in entity-tags)
- [ ] All 3 scraping taxonomies retired

### Reference
[tag-ontology-research.md](./tag-ontology-research.md) (769 lines)

### Sub-phases (engineer plans 3 phases over 4 weeks for iter30)
- **P1 (1w)**: schema + shared lib + PA realtime-tagger rewrite
- **P2 (1.5w)**: worker (normalize via free Qwen-7B + write canonical/entity) + alias-table seed
- **P3 (1.5w)**: backfill existing data + scraping repo PR
- **P4 (deferred to iter31)**: HDBSCAN discovery + operator UI for canonical promotion. iter30 ships with manually seeded canonical dictionary; HDBSCAN discovery becomes iter31 first phase.

---

## WS3 — RunContext<ClaireContext> + turn-state collapse

**Engineer**: 1 (orchestrator owner — small but unblocking workstream)
**Effort**: 3-5 dev-days
**Depends on**: nothing
**Unblocks**: WS4, WS5, WS6, WS7

### Goals
- Define `ClaireContext` type (see [discussion.md §8.4](./discussion.md))
- Wrap `Runner.run(claireAgent, [...], { context: ctx })` with single turn-load
- Migrate Firestore reads to turn-entry, expose via ctx for guardrails/tools/handoffs

### Hard constraints (Adam-locked)
- ALL turn-scoped Firestore reads collapse into single ctx-load at turn entry
- ctx must be readable by guardrails, tools, sub-agent handoffs

### Deliverables
1. `packages/pa-orchestrator/src/run-context.ts` — `ClaireContext` type + factory
2. `packages/pa-orchestrator/src/turn-loader.ts` — single Firestore batch read at turn entry
3. Refactor: every existing per-turn Firestore read → ctx accessor
4. Tests: ctx field freshness, mock-ctx test ergonomics

### Acceptance gates
- [ ] Single Firestore round-trip per turn (audit via Cloud Functions trace)
- [ ] Per-turn latency improved by ≥ 200ms (was N reads, now 1 batch)
- [ ] Guardrails + tools all read ctx, not Firestore directly

---

## WS4 — Skill V2 schema + 19 playbooks (+ skill renaming externally)

**Engineer**: 1 (LLM/prompt engineer, owns playbook system)
**Effort**: 3-4 weeks
**Depends on**: WS3 (RunContext) — playbooks need ctx-aware activation

### Goals
- Migrate 6 existing + 13 new playbooks (= 19 total) to V2 Zod schema
- Add **7 new fields** (corrected from audit-flagged 5):
  - `intentDescription` (LLM intent classifier input)
  - `provides[]` (capability tags)
  - `requires[]` (prerequisite tags / state)
  - `composableWith[]`
  - `conflictsWith[]`
  - `priority` (1-100)
  - `allowedTools[]` (**tool gating** — closes loop with WS6 guardrails)
  - `llmInvokable` (boolean, allow LLM intent fallback to select)
  - `paths[]` (sub-file progressive disclosure) — **DEFERRED TO iter31** (engineer can add field-defs to schema but leaves unused)
- Externally rename "playbook" → "skill" in dashboard + LLM-facing prompts (internal Firestore collection name `pa-playbooks` unchanged)
- Implement composability stacking (multiple skills concat addendum by priority)
- Implement conflictsWith resolution (highest priority wins on conflict)
- **Skill activation reads ctx**: `ctx.userProfile` + `ctx.activePlaybooks` gate activation (e.g. cv_followup only fires if `ctx.resumeAccepted` true within last 24h)

### Hard constraints (Adam-locked)
- **Skill approach is primary** — LLM intent → skill selection → compose
- **Basic regex stays as floor** (crisis triggers, AB-NEVER blocks) but NOT primary routing
- 19 skills total (= 6 existing renamed + 13 new from §12)

### Deliverables
1. `packages/agent-registry/src/skill-schema.ts` — V2 Zod with 5 new fields, backward-compat
2. `packages/agent-registry/src/skills.ts` — replace `playbooks.ts`, export 19 skills
3. `packages/pa-orchestrator/src/skill-stacker.ts` — composability + conflictsWith resolution
4. 13 new skill files (or 13 entries in skills.ts):
   - Tier 1 (5): rejection_processing, post_offer_decision, referral_request, silence_anchor, cv_followup
   - Tier 2 (5): layoff_processing, company_research, career_pivot, return_to_work, daily_batch_reply
   - Tier 3 (3): am_i_ai_check, boundary_test, mom_test
5. Test scenarios per skill (in `tests/scenarios/playbooks-iter30/`):
   - 1 zh + 1 en realistic user message per skill
   - LLM-judge criterion per skill
6. Migration: 6 existing → V2 (add metadata fields)

### Acceptance gates
- [ ] 19 skills loaded in Firestore + dashboard
- [ ] Each skill has zh + en LLM-judge scenario passing ≥ 80% threshold
- [ ] Composability tested: vent + jd_roast simultaneous, addendum concat correct
- [ ] Conflicts tested: vent + motivation_nudge → only highest priority wins
- [ ] **No regression on iter28-29 baselines.** Re-baseline reference scenarios (must score ≥ pre-iter30 on each):
  - `tests/scenarios/playbooks-iter20/iter28-judge-vent-realistic.yaml` (target ≥ 0.93)
  - `tests/scenarios/playbooks-iter20/iter28-judge-headhunter.yaml` (target ≥ 0.86)
  - `tests/scenarios/playbooks-iter20/iter28-judge-negotiation.yaml` (target ≥ 0.86)
  - 30-turn AB-framework drift: 0/30 hits maintained (current state post iter27-28)

### Reference
- [skills-vs-playbook-research.md](./skills-vs-playbook-research.md) (655 lines)
- [discussion.md §12](./discussion.md) (13 new skills detail)

---

## WS5 — LLM intent fallback (skill router using free Qwen-7B)

**Engineer**: 1 (LLM/prompt — can be same as WS4 or paired)
**Effort**: 1-2 weeks
**Depends on**: WS4 (skill registry must be V2 with intentDescription)

### Goals
- Replace primary regex routing with LLM intent classifier
- Use FREE Qwen-7B on SiliconFlow (Adam: it's free)
- Regex remains as basic floor for crisis + AB-NEVER + obvious patterns
- Output: `{ skills: SkillKey[], confidences: number[] }`
- Multi-skill output (LLM can return up to 3 skills for composition)

### Hard constraints (Adam-locked)
- Use **free Qwen2.5-7B-Instruct on SiliconFlow** — primary intent classifier
- LLM holistic judgment leads, regex is safety net
- Latency budget: classifier ≤ 500ms p99 (single short prompt to free Qwen-7B)
- Fail-open: classifier timeout → fall back to regex floor

### Deliverables
1. `packages/pa-orchestrator/src/skill-intent-classifier.ts`:
   - System prompt: lists 19 skill descriptions, asks for top-K skills + confidence
   - Single Qwen-7B call (free), JSON-mode output
   - Cache by msg hash (5-min TTL) to dedupe rapid same-msg
2. `packages/pa-orchestrator/src/skill-router.ts`:
   - Run regex floor (cheap, deterministic safety net) + LLM intent in parallel
   - LLM intent priority on conflict, regex floor unioned for safety patterns (crisis)
3. Tests:
   - 50 realistic msg fixture, LLM-judge correctness ≥ 85%
   - Latency p99 ≤ 500ms
   - Crisis msg always tripped (regex floor wins)

### Acceptance gates
- [ ] Intent classifier produces multi-skill output for composable scenarios
- [ ] No regression on the 6 LLM-judge baselines (vent / headhunter / negotiation / motivation / jd_roast / interview_prep)
- [ ] Cost ≈ $0/turn (free Qwen-7B)

---

## WS6 — Input/Output Guardrails (SDK wrap)

**Engineer**: 1 (orchestrator engineer, can pair with WS3)
**Effort**: 3-5 dev-days
**Depends on**: WS3 (RunContext)

### Goals
- Wrap existing `output-normalizer.ts` AB-strip + slang-injector + length-cap as `OutputGuardrail[]`
- Wrap crisis detection + PII scan + length check as `InputGuardrail[]`
- Hook into `@openai/agents` Runner with `inputGuardrails: [...]` + `outputGuardrails: [...]`

### Hard constraints (Adam-locked)
- "Critical" workstream — Adam: "对的这个很关键，你需要想清楚这里怎么做"
- Single source of truth for each transform (no parallel logic in tool calls)

### Deliverables
1. `packages/pa-orchestrator/src/guardrails/input/`:
   - `crisis-detector.ts`
   - `pii-scanner.ts` (SSN / 银行卡 / passport)
   - `length-input.ts`
2. `packages/pa-orchestrator/src/guardrails/output/`:
   - `ab-strip.ts` (port `stripABProbeFromTail`)
   - `slang-enforcer.ts` (卧 → 卧槽)
   - `length-cap.ts`
   - `crisis-trailer.ts`
3. Wire into `claireAgent` definition
4. Tests: each guardrail unit + integration (guardrail chain order matters)

### Acceptance gates
- [ ] Existing iter25-29 normalizer tests still pass
- [ ] No more monkey-patch logic outside guardrail/ folder
- [ ] PII scanner blocks 100% of fixture (SSN samples)

---

## WS7 — Unified profile maintenance (`pa-entity-tags` consumption)

**Engineer**: 1 (backend, can be same as WS2 since it's the consumer)
**Effort**: 1-2 weeks
**Depends on**: WS2 P2 (entity-tags collection populated)

### Goals
- Single source of truth `pa-entity-tags/{userId}/items/{tagKey}` for all preferences/skills/traits
- Migrate readers (`pa-job-profiles`, `pa-users`, scattered fields) to read from entity-tags
- Mem0 stays as fine-grained dialog facts; entity-tags as aggregated profile
- RunContext.userProfile loads entity-tags batch at turn entry (via WS3)

### Hard constraints (Adam-locked)
- Realtime tag write fire-and-forget (no turn block)
- Batch reinforcement via WS2 worker
- Decay support (180-day half-life optional per tag)

### Deliverables
1. `packages/pa-orchestrator/src/profile-loader.ts`:
   - `loadUserProfile(userId): Promise<UserProfile>` — single batch read of entity-tags
2. RunContext (WS3) integration: ctx.userProfile populated at turn entry
3. Reader migration: 5+ existing call sites switch from `pa-users.preferences` → entity-tags
4. Tests: source-merge correctness (same fact from PA + scraping → reinforced count)

### Acceptance gates
- [ ] All current preference/skill reads go through entity-tags (grep gate: zero `pa-users.preferences` reads in `apps/job-rec` + `packages/pa-orchestrator`)
- [ ] Source attribution audit: any tag → which sources contributed (assert `sources[]` populated for ≥ 95% of entity-tags)
- [ ] RunContext.userProfile populated from entity-tags batch read at turn entry (WS3 integration)
- [ ] **DEFERRED to iter31**: BoostCalculator integration with entity-tags (WS8 reads `cvSkills: string[]` directly in iter30; entity-tags read added in iter31 once weight FK migration completes)

---

## WS8 — Boost calculator + dashboard + match-explainer with weights (BIZ-LAUNCH CRITICAL)

**Engineer**: 1 (full-stack — owns Firestore migration + React dashboard + explainer prompt)
**Effort**: 2-3 weeks
**Depends on**: **WS2 P1 only** (canonical-tags schema for `skillCanonical` FK, forward-compat). WS7 dependency removed — BoostCalculator reads `cvSkills: string[]` directly in iter30. WS7 entity-tags integration deferred to iter31.
**Priority**: **HIGHEST URGENCY** — Adam will demo SOON

### Goals
- Migrate `match-weights.ts` AI_AGENT_SKILL_WEIGHTS → Firestore (`pa-match-weights/*`)
- BoostCalculator class with cached Firestore loader (30s TTL like playbooks)
- Dashboard `/match-weights` page: list + edit + dry-run + audit
- Match-explainer takes `BoostExplainerInput` (core/supporting/generic hits + coreMissing)
- Match-explainer dashboard view: operator can spot-check daily-batch outputs

### Hard constraints (Adam-locked)
- **Do it all at once** — no phased toggle
- **Industry research mandatory** for explainer pattern (LinkedIn / Indeed / Hired / Vettery)
- Dashboard polished — biz-team-demo-ready
- Combined with playbook ops dashboard (same admin shell)

### Deliverables
1. Firestore migration:
   - `pa-match-weight-tables/{tableKey}` (table metadata)
   - `pa-match-weight-tables/{tableKey}/items/{skillKey}` (rows)
   - One-shot seed script from current `match-weights.ts` const
2. `apps/job-rec/src/boost-calculator.ts`:
   - Class with cached loader
   - `applyWeightedMatchBoost` rewritten to use BoostCalculator
   - Forward-compat with `pa-canonical-tags` FK
3. Dashboard pages:
   - `/match-weights` — table list, row editor, slider/dropdown, reason text, audit drawer
   - `/match-weights/test` — input CV skill list, see boost result diff
   - `/playbooks` (existing) — extend with WS4/5 fields (intentDescription, composability, A/B variant)
   - `/match-explainer-history` — paginate recent daily-batch jobs with explainer output
4. Match-explainer changes:
   - `apps/job-rec/src/match-explainer.ts` — accept `BoostExplainerInput`
   - New prompt directive: prioritize core hits, downplay generic-only, surface coreMissing
   - Cache invalidation on weight table change
5. Industry research deliverable (sub-output): `.planning/iter30/explainer-industry-research.md` covering LinkedIn / Indeed / Hired / Vettery / etc patterns
6. Tests:
   - Boost calculator parity test: Firestore read ≡ TS const result for all 30 rows
   - Dashboard E2E: edit row → re-run boost → reorder verified
   - Explainer LLM-judge: ≥ 80% pass on 20-fixture set (core hits properly highlighted)

### Acceptance gates
- [ ] Boost calculator reads Firestore, TS const deleted
- [ ] Dashboard edit → live within 30s without deploy
- [ ] Explainer prompt mentions core hits when present, never says "Python match" alone
- [ ] Industry research doc published (`.planning/iter30/explainer-industry-research.md`)
- [ ] **Biz-team demo-ready checklist** (engineer-testable):
  - [ ] `/match-weights` page: table list, row editor (slider+dropdown+reason), audit drawer all functional, no console errors
  - [ ] `/match-weights/test` page: input CV skill list → boost result diff visible, no console errors
  - [ ] `/playbooks` (extended): 19 skills displayed with composability metadata, no console errors
  - [ ] `/match-explainer-history` page: paginate ≥ 50 daily-batch records with explainer output, no console errors
  - [ ] All copy text in zh+en where applicable, no `TODO` / `Lorem ipsum` / placeholder strings
  - [ ] Demo flow runnable end-to-end ≤ 5 min without engineer assistance

---

## Engineer agent assignments

| WS | Engineer agent role | Spawned via |
|---|---|---|
| WS1 | Backend (CV ingest + Mem0 boundary) | `general-purpose` engineer subagent |
| WS2 | Backend / data engineer (shared lib + worker) | `general-purpose` engineer subagent |
| WS3 | Orchestrator engineer | `general-purpose` engineer subagent |
| WS4 | LLM/prompt engineer | `general-purpose` engineer subagent |
| WS5 | LLM/prompt engineer (paired with WS4) | `general-purpose` engineer subagent |
| WS6 | Orchestrator engineer (paired with WS3) | `general-purpose` engineer subagent |
| WS7 | Backend (paired with WS2) | `general-purpose` engineer subagent |
| WS8 | Full-stack (frontend-heavy) | `general-purpose` engineer subagent |

**Total bodies**: 4-5 engineers (with pairing). Sequencing parallel-where-possible.

---

## Sequencing — 6-week timeline (reconciled with WS2 4w scope)

```
Week 0: Day-0 unblocks closed (Adam answers Q1-6 above) + external dep validation spike
        - Verify Qwen-7B free tier rate limit
        - Verify Responses API JSON-schema mode handles 14-field schema
        - cost-logger.ts price table extended

Week 1: WS1 P1 (gate+quota+size), WS2 P1 (schema+shared lib), WS3 (RunContext), WS6 (guardrails) parallel start
Week 2: WS1 P2 (parser port+retry), WS2 P2 (worker), WS4 starts (after WS3 lands), WS6 close
Week 3: WS1 P3 (qaBank→Mem0 + tag-events), WS2 P3 (backfill+scraping PR), WS5 (intent classifier), WS8 P1 (BoostCalculator+dashboard skeleton)
Week 4: WS4 close (19 skills LLM-judge), WS7 (profile-loader+RunContext integration), WS8 P2 (industry research+explainer prompt+/match-explainer-history page) ⇒ **BIZ DEMO READY end of W4**
Week 5: integration + iter28-29 LLM-judge re-baseline + biz demo dry-run + flag-gated rollout 1% → 10%
Week 6: buffer + closed-beta ramp 10% → 100% + iter31 cost optimization scoping
```

**Critical path**: WS3 (W1) → WS4 (W2-4) → WS8 P2 (W4 close) — biz demo gate is end-of-W4.

---

## Review & gate checklist

### Plan-quality review (before engineers spawn)
Spawned via `gsd-plan-checker` style subagent. Checks:
- [ ] Each WS has clear deliverables, gates, file paths
- [ ] Dependencies are accurate (no engineer blocked unexpectedly)
- [ ] Adam decisions reflected (no V4-Pro, no Sonnet 4.5 in parser, free Qwen-7B for normalize+intent, structured output for parse)
- [ ] Hard constraints surface in each engineer's prompt
- [ ] Effort estimates reasonable

### Per-WS execution review (after each engineer agent completes detail-plan)
Each engineer agent produces `.planning/iter30/ws-N-detail.md` with:
- Sub-task breakdown (≤ 1-day units)
- File-level diffs preview
- Test plan
- Risks specific to their WS
- Open questions back to me / Adam

These get reviewed before any code is written.

### Per-WS code review (during execution)
Spawned via `code-reviewer` style subagent at each major commit.

---

## Out of scope for iter30

- **1000-user public-launch cost optimization** (defer to iter31). ⚠️ **NOT a free deferral**: gpt-5.4-nano main-turn at 1000 users projects ~$765/mo (3000 input tokens × 30 turns/day × 1000 users at $0.20/M input + 200 output tokens at $1.25/M output). This is essentially the same cost ceiling V4-Pro post-promo would have hit ($780/mo). **iter31 cost optimization is MANDATORY before public launch, not optional.** Plan now: fallback Qwen-7B for vent/casual turns, V4-Pro/Claude for hard intent turns, Batch API for daily-batch.
- LLM-judge automated regression in CI (iter31)
- Multi-language playbook expansion beyond zh+en (iter32+)
- VALET deeper integration (Hatchet workflow → PA migration) — only port parser, not platform
- pa-canonical-tags imports from ESCO/LinkedIn (deferred unless 4-week metric pass forces)
- WS2 P4: HDBSCAN canonical discovery + operator review UI (moved to iter31 first phase)
- skill V2 `paths[]` progressive disclosure feature (schema field exists in iter30 but unused; full feature in iter31)
- WS8 BoostCalculator entity-tags integration (iter30 reads `cvSkills: string[]` directly; entity-tags read in iter31)

---

## Risks not in scope (per audit §F)

These are NOT separate workstreams but cross-cutting risks each engineer must address in detail-plan + execution:

### F1. Migration strategy for live users during ramp
- 19 skills loaded into `pa-playbooks` Firestore — schema bump is backward-compat risk. **Mitigation**: dual-write window (V1 + V2 schema both written, readers tolerant), then cutover.
- WS2 `realtime-tagger.ts` rewrite affects every live user message. **Mitigation**: feature flag `paTagEventsEnabled`, ramp 1% → 10% → 100% per CLAUDE.md iter23 directive (Adam-gated).
- WS6 guardrails wrap existing normalizer logic. **Mitigation**: shadow-mode flag `paGuardrailsShadowMode` runs guardrails in parallel without applying suggested output for 1 week before cutover.
- Each engineer must declare which feature flag(s) gate their WS rollout in detail-plan §"Migration & rollout".

### F2. Rollback plan per WS
- WS1: cv-ingest swap is deploy-time replacement. **Mitigation**: `paResumeParserV2` flag default OFF for first deploy, flip per-user via `paFeatureFlags`.
- WS4 V2 schema: if breaks existing 6 playbooks at deploy, **revert path**: Firestore docs are versioned via `audit drawer`, "revert" button restores prior version.
- WS8 TS const → Firestore: do NOT delete TS const until all 30 weight rows verified parity in Firestore for 1 full daily-batch run.

### F3. Cost monitoring per WS
- `apps/functions/src/instrumentation/cost-logger.ts:73` price table missing entries — add: gpt-5.4-nano structured-output rate, OpenAI Batch API discount, Qwen-7B (free → $0/M but log token volume).
- Per-WS daily cost budget logged to Firestore `pa-cost-ledger/{ws}/{date}`. Alert threshold: 2× projected.

### F4. Eval-baseline preservation across migrations
- iter28-29 LLM-judge wins (vent 0.93, headhunter 0.86, negotiation 0.86, 0/30 AB drift) are pre-iter30 reference.
- WS3/4/5/6 each must run iter28 LLM-judge baseline pre-merge, score must NOT regress.
- Baseline files: `tests/scenarios/playbooks-iter20/iter28-judge-*.yaml` + 30-turn drift fixture (locate via grep).

### F5. Test data / fixtures (authoring effort budgeted)
- WS1: 10-PDF fixture set authoring (~1d)
- WS4: 19 skills × (zh + en) = 38 LLM-judge scenarios (~1.5w in WS4 calendar — already absorbed)
- WS2: 12k events/day load test harness (~1d)
- WS6: PII fixture set (SSN/passport samples) (~0.5d)

### F6. iMessage live channel testing during 19-skill rollout
- CLAUDE.md mandates live scenario verify. 19 skills × scenarios = 38+ live runs minimum.
- **Apple AID at scale concern** (per memory): each engineer uses Adam's test phone numbers `+19999992891-2895` per existing scenario YAMLs. Stage rollout = 1 skill per day ramp on iMessage to avoid AID rate spike.
- Live verify gate per skill: 1 zh + 1 en real iMessage turn with screenshot of reply.

---

## Day-0 ANSWERS from Adam (2026-05-03 round)

| Q | Answer | Impact |
|---|---|---|
| Q1 `@wekruit/shared-tags` publish | **(b) GitHub Packages org auth** | WS2 P1 day-1 unblock. Engineer adds GH Packages auth to PA + scraping CI. |
| Q2 Qwen-7B free tier rate-limit fallback | **Use free Qwen-7B first; build alerts on rate-limit chokepoints; global poison-pill protection** | WS2 + WS5 must instrument: monitor 429s, cost-logger ledger, fallback path on 429 (queue + retry, not pay-as-you-go). New ⚠ alert: `paQwen7BRateLimit429` Firestore doc → ops dashboard. |
| Q3 gpt-5.4-nano price confirm | **YES** ($0.20 in / $0.025 cached / $1.25 out per M) | WS1 day-1 wires into `cost-logger.ts:73`. |
| Q4 skill rename rollout | **Skills approach** (flag-gated `paSkillNamingV2`, default OFF, ramp staff → 100%) | WS4 day-1: feature flag added. |
| Q5 dashboard polish target | **沿用 `ui.tsx` 弄干净点 + 找开源别造轮子.** Decision: **adopt shadcn/ui** (Radix primitives, copy-paste components, no dependency lock-in, React 19 + Vite compatible). Tables + dialogs + dropdowns + sliders all from shadcn. Existing `ui.tsx` retained for app-shell layout. Tailwind required as shadcn dep — adds to dashboard pkg. | WS8 day-1: install shadcn CLI, add Tailwind, port existing ui.tsx primitives to use shadcn. |
| Q6 iMessage testing channel | **NO test phone numbers (no `+19999992891-2895`). ONLY Sendblue dialog channel. Old direct iMessage SDK retired.** | 🚨 **MAJOR**: every test scenario currently using `participant: "+19999992891"` etc. must migrate to Sendblue test channel. WS4-B 26 LLM-judge YAML scenarios (in flight) will need participant rewrite. Old SDK code paths in PA can be deleted (cleanup task added to iter30). |
| Q7 deprovision DEEPSEEK_API_KEY | **YES** | Adam unblocks now. |
| Q8 engineer agent model | **Opus** | All future detail-plan + execution agents on Opus (was Sonnet default). |
| Q9/Q10 biz demo + closed beta date | **NOW (ASAP, not specific date)** | Sequence priority: WS8 biz-demo path first (D1-D10 critical), then closed-beta ramp. Compress 6-week timeline to ~4 weeks if possible by parallelizing wave-2 starts. |

---

## Day-0 unblocks Adam must answer (BLOCKING engineer spawn)

These are not nice-to-haves. Engineers will hit these on day 1; answering now saves a round-trip per WS.

### Q1. `@wekruit/shared-tags` publish strategy (BLOCKS WS2 day 1)
PA + scraping repo are separate git repos. Options:
- (a) **npm public**: simplest, but tag schemas are internal IP — leak risk?
- (b) **GitHub Packages with org auth**: requires CI auth setup in scraping repo
- (c) **Workspace-only with git submodule**: no publish, but scraping repo must add PA as submodule
- (d) **Schema-only repo**: shared `@wekruit/shared-schemas` (just types), each repo implements client

**Recommendation**: (b) GitHub Packages. Adam, confirm or pick.

### Q2. Qwen-7B free tier rate limits (BLOCKS WS2 + WS5)
12k events/day = ~8 RPS sustained. 1% intent-fallback × 1000 user × 30 turn/day = 300 calls/day = trivial.

SiliconFlow free tier published RPM cap (per docs)? Adam, please confirm:
- Free tier RPM/RPD cap?
- Fallback if rate-limited: queue + retry, OR pay-as-you-go ($0.05/$0.05 per M)?

### Q3. gpt-5.4-nano price into cost-logger.ts (BLOCKS WS1)
Confirmed from screenshot: $0.20/M input, $0.025/M cached input, $1.25/M output. **Engineer wires these into `cost-logger.ts:73` as P1 task.** Confirm Adam.

### Q4. Skill-rename rollout policy (BLOCKS WS4)
"playbook" → "skill" external rename. LLM-prompt change = behavior change in production.
- (a) **Sudden cutover**: rename in same deploy as V2 schema land
- (b) **Flag-gated**: `paSkillNamingV2` controls dashboard + LLM-prompt label
- Recommendation: (b) — flag-gated, default ON for staff, ramp to 100% after 1-week monitoring

### Q5. WS8 dashboard polish target (BLOCKS WS8)
"Biz-team demo-ready" — design reference?
- (a) Figma reference link
- (b) Existing internal dashboard screenshot (Adam's Playbooks.tsx is the bar?)
- (c) "Use Tailwind, ship clean tables, no fancy charts"
Engineer needs ONE answer to avoid 3-5d UI critique loop.

### Q6. iMessage live testing channel (BLOCKS WS4 verification)
19 skills × scenarios verified on iMessage requires test phone numbers. Reuse existing `+19999992891-2895`? OR provision new test AIDs per CLAUDE.md ToS concerns?

### Existing PLAN open questions (still relevant)
- Q7. DEEPSEEK_API_KEY — V4-Pro dropped, can deprovision (low priority)
- Q8. Engineer agent model preference: Sonnet (fast) default, Opus for plan-check, OK?
- Q9. **Biz demo target date** — "SOON" → date? (BLOCKS WS8 backplan)
- Q10. **Closed-beta launch target date** — date? (BLOCKS scope decisions)

---

## Open questions for Adam

1. **gpt-5.4-nano price into cost-logger.ts** — pasted screenshot, I'll wire it
2. **DEEPSEEK_API_KEY** — no longer needed (V4-Pro dropped); can deprovision
3. **Sub-agent engineer model preference**: Opus (deep) vs Sonnet (fast)? Default Sonnet for engineers, Opus for plan-check. OK?
4. **Biz demo target date** — "SOON" — give me a date so WS8 can backplan
5. **Closed-beta launch target date** — same
