# iter30 Plan Audit — goal-backward review

**Auditor**: Plan-quality auditor agent (self-contained, no conversation context)
**Date**: 2026-05-03
**Subject**: `/Users/adam/Desktop/WeKruit/wekruit-pa/.planning/iter30/PLAN.md` (454 lines)
**Authoritative locks**: `.planning/iter30/discussion.md` lines 1-58 ("ADAM DECISIONS 2026-05-03")
**Tone**: 🟠 阿里味 — 抓手必须闭环，颗粒度拉到工程师可执行。

> 这次 audit 不是给 P10 盖章。Adam 这一轮已经被半成品折腾过，PLAN 走出去再补丁就是二次 PUA。底层逻辑：5 个 workstream 的 抓手 + 3 个跨切 闭环（schema → 写入 → 消费）必须先在纸面闭合，工程师再上工。

---

## A. Adam-decision fidelity

**Verdict**: **FLAG**

Locks check:

| Adam lock | PLAN.md reference | Status |
|---|---|---|
| Drop V4-Pro entirely | L450 only ("can deprovision DEEPSEEK_API_KEY"), no active workstream uses it | ✅ PASS |
| gpt-5.4-nano + structured output for parse, fallback gpt-4.1-mini → gpt-4.1-nano, NO Sonnet 4.5 | WS1 L50, L54, L80 | ✅ PASS |
| Tags English-only | WS2 L99, L103 | ✅ PASS |
| Tags mutually exclusive | WS2 L103, L136 | ✅ PASS |
| Free Qwen-7B for tag normalize (NOT V4-Flash) | WS2 L104 | ✅ PASS |
| Free Qwen-7B for skill intent fallback | WS5 L237-238 | ✅ PASS |
| Skill approach primary, regex floor only | WS4 L194-195, WS5 L240-241 | ✅ PASS |
| 19 skills (6 + 13) | WS4 L196 | ✅ PASS |
| Boost calc + dashboard "do it all at once" | WS8 L344 ("no phased toggle") | ✅ PASS |
| WS8 biz-launch critical + industry research mandatory | WS8 L334, L345-347 | ✅ PASS |
| OpenAI Batch API for async parse path | WS1 L56 | ✅ PASS |

**Fidelity is high.** What downgrades this from PASS to FLAG:

1. **Stale supporting research not reconciled.** `tag-ontology-research.md` lines 90, 117, 129, 425, 554, 705 still cost-models the tag pipeline at **DeepSeek-V4-Flash $0.14/$0.28 per M tokens** and produces $0.87/mo + $0.07/day numbers from that. Adam locked **free Qwen-7B**. PLAN.md WS2 acceptance gate (L135) sets cost ceiling **≤ $1.50/mo (Qwen-7B free + BGE-M3 free + Firestore writes)** — this number is asserted without recomputation. Engineers will pull source numbers from the research doc and silently re-introduce the V4-Flash assumption. **Recommendation**: PLAN.md WS2 should add an explicit "supersedes tag-ontology-research.md cost section — Qwen-7B free tier on SiliconFlow, recompute" callout, and ideally an inline 1-line cost re-derivation (Qwen-7B free × 12k events/day = $0 LLM, only Firestore + storage cost remains).

2. **"Free Qwen-7B" is itself unverified at the contract level.** discussion.md line 207 lists Qwen2.5-7B-Instruct on SiliconFlow at $0.05/$0.05 per M tokens; Adam line 17 says it's "currently free tier on SiliconFlow". SiliconFlow has both a free quota and paid pricing. PLAN does not distinguish. WS2 + WS5 both depend on this being free. **Recommendation**: WS2 + WS5 prompts must include "verify Qwen-7B free-tier rate-limit before deploy; if rate-limited, fall back path is …". Open question for Adam to surface NOW (see §I).

3. **Structured output via OpenAI Responses API JSON schema** is mentioned (WS1 L50) but the existing PA stack uses the older single-shot `gpt-5.4-nano` call (per `apps/functions/src/cv-ingest/cv-ingest.ts`, confirmed in deepseek-v4-pro-migration.md L24-28). Adam locked "structured output via Responses API" but did NOT lock that the Responses API has been validated to work for this schema size at production volume. **Recommendation**: add a P0 spike at WS1 P1 — "validate Responses API JSON-schema mode handles 14-field schema with nested arrays at gpt-5.4-nano without truncation".

---

## B. Coverage completeness

**Verdict**: **FLAG**

Cross-reference against Adam's commitments:

### Prior turn (6 numbered items) — discussion.md L62-67
| Item | PLAN coverage | Status |
|---|---|---|
| 1. parseResume like VALET, 4 limits, qaBank → mem0 | WS1 fully | ✅ |
| 2. tagKey unsupervised dedup | WS2 fully | ✅ |
| 3. Drop DeepSeek V4-Pro | All WS clean | ✅ |
| 4. Continue boost calc / explainer / guardrails / RunContext / dashboard / 13 playbooks | WS3 / WS4 / WS6 / WS8 | ✅ |
| 5. Cross-repo async pipeline (PA + scraping) | WS2 L106, L118-119 | ✅ |

### Playbook items (6) — discussion.md L86-91
| Item | PLAN coverage | Status |
|---|---|---|
| Playbook execution mechanism | WS4 (skill stacker) + WS5 (LLM intent) | ✅ |
| Multi-playbook composition | WS4 L191, L213 (composability test) | ✅ |
| Guardrails | WS6 fully | ✅ |
| RunContext | WS3 fully | ✅ |
| Profile maintenance | WS7 fully | ✅ |
| Dashboard playbook ops | WS8 L361 (extends `/playbooks` page) | ⚠️ THIN |

### Latest turn (4) — Adam locks
| Item | PLAN coverage | Status |
|---|---|---|
| Parse LLM choice (nano structured, no Sonnet) | WS1 L54, L80 | ✅ |
| Tags English / mutex | WS2 L103-104, L136 | ✅ |
| Drop V4-Pro | confirmed clean | ✅ |
| Boost dashboard "一次性全改" | WS8 L344 | ✅ |

### Skills research integration
- skills-vs-playbook-research.md proposes V2→V5 4-stage migration (research line 649-655: V2 schema add, V3 LLM fallback ramp, V4 composability enforcement, V5 progressive disclosure + tool gating).
- PLAN WS4 collapses V2+V4 into one workstream, drops V5 (paths progressive disclosure + tool gating) silently. **L196 says "5 new fields: intentDescription, provides, requires, composableWith, conflictsWith, priority"** — research doc line 643-644 also lists `paths` (sub-file progressive disclosure) and `allowedTools` (tool gate) and `llmInvokable`. PLAN counts 5 fields but research listed 8. **Status**: ⚠️ HALF — V5 features either (a) deferred without explicit "deferred to iter31" call, or (b) silently dropped.

### Coverage gaps not caught by Adam's checklist but engineers WILL hit
1. **Migration path for the existing 6 playbooks → V2 schema**: WS4 L208 says "Migration: 6 existing → V2 (add metadata fields)" but does not specify backward-compat semantics. Currently `pa-playbooks` Firestore docs are live in production. Schema bump without rollout flag = breaking change at deploy time.
2. **Where `recordTagEvent()` lives during P1 before scraping repo PRs**. WS2 says `@wekruit/shared-tags` is npm-publishable or workspace package. If workspace package, scraping repo (separate git repo per discussion.md L57-64) cannot consume it without npm publish. **Adam will hit "how does scraping import this from a sister repo?" on day 1**.

**Recommendation**: PLAN.md WS4 must explicitly say either "V5 (paths + allowedTools) is iter31" or "V5 fields ship in WS4 schema but unwired". WS2 must declare publish strategy for `@wekruit/shared-tags` (npm public? GitHub Packages? workspace-only with git submodule?).

---

## C. Dependency graph correctness

**Verdict**: **FLAG**

PLAN dependency graph (L24-37):
```
WS3 → WS4 → WS5
WS3 → WS6
WS1 independent
WS2 → WS7, WS8
WS2 P1 → WS8
```

### Verification

**WS3 unblocks WS4/5/6/7?**
- WS4 L184: "Depends on WS3 (RunContext) — playbooks need ctx-aware activation." 抓手 valid: skill activation needs to read user state (yoe / locale / activePlaybooks) which lives in RunContext. ✅
- WS5 L228: "Depends on WS4 (skill registry must be V2 with intentDescription)." Note WS5 depends on **WS4**, not WS3 directly. Graph at L24 shows WS4→WS5 implied. ✅
- WS6 L266: "Depends on WS3 (RunContext)." 抓手 valid: guardrails read ctx (locale, crisisTripped). ✅
- WS7 L302: "Depends on WS2 P2 (entity-tags collection populated)." Graph at L33 says WS7 depends on "WS2 schema landing" — but L302 says WS2 **P2** (worker land), which is week 3-5 not week 1-2. Graph is too optimistic. ⚠️ **DRIFT**

**WS2 P1 vs WS8** — does WS8 actually need entity-tags or just canonical FK?
- WS8 L271 (BoostCalculator skillCanonical "FK to pa-canonical-tags, forward-compat"). Discussion.md L271 says "skillCanonical: FK to pa-canonical-tags (forward-compat)" — i.e. forward-compat, not blocking. WS8 can ship reading the legacy `skill: lowercase substring match` field and later wire to canonical FK.
- But L325 says "BoostCalculator (WS8) reads entity-tags directly" as a WS7 acceptance gate. WS8 reading **entity-tags** vs canonical-tags are two different couplings.
- **Inconsistency**: PLAN at L334 says WS8 depends on **"WS2 P1 (canonical-tags schema for FK), WS7 (profile reads)"** — but profile reads (WS7) are about user-side preferences, not job-side weight rows. BoostCalculator computes weight × cv-skill match. It does NOT need WS7's userProfile loader to do that. WS8 dependency on WS7 is **over-stated**. ❌ **WRONG DEPENDENCY**.

**WS3 vs WS6 inversion**
- WS6 wraps `output-normalizer.ts` AB-strip. AB-strip depends on `ctx.locale` to choose zh/en regex bank. ctx comes from WS3.
- WS3 L155 "Unblocks WS4, WS5, WS6, WS7" — correct.
- WS6 L266 "Depends on WS3 (RunContext)." Correct.
- No inversion. ✅

**WS1 vs WS2 hidden coupling**
- WS1 produces `qaBank` entries from CV ingest. These are inferred Q&A like "preference: ML". 
- These entries are exactly the kind of raw signal that should flow into `pa-tag-events` via `recordTagEvent()` — i.e. WS1 should be a tag-event producer once WS2 P1 lands.
- PLAN does NOT declare this coupling. WS1 deliverables L66 only writes to Mem0 with intentTag mapping. No mention of also calling `recordTagEvent()` for the same fact.
- **Gap**: cv-ingest is a known canonical signal source (it observed the user's actual skill/preference), but PLAN does not wire it into tag pipeline. Engineers will write WS1 cleanly without tag-events, then iter31 has to retrofit. ❌ **MISSING COUPLING**.

**Recommendation**:
1. Fix WS8 dependency: depends on **WS2 P1 only** (canonical-tags FK, forward-compat). Remove WS7 dependency. Add entity-tags read as **post-WS7 nice-to-have**, not blocking.
2. Fix WS7 vs WS2 P2 graph: PLAN graph L33 implies "WS2 schema landing" unblocks WS7 — actually WS2 P2 (worker writes entity-tags) is the real unblock, ~week 3-5. This collapses 6-week timeline.
3. WS1 should call `recordTagEvent()` for each qaBank fact once WS2 P1 lands — add as WS1 P3 task or WS2 backfill.

---

## D. Effort & timeline realism

**Verdict**: **BLOCK**

### WS2 alone is 6-7 weeks.

PLAN L91: "Effort: 6-7 weeks (largest workstream)". 
PLAN L399 timeline shows total is **6 weeks**.

If WS2 takes 6-7 weeks, the 6-week total **mathematically requires WS2 to start week 1 and run to the end**. PLAN timeline (L401-408) shows:
- W1: WS2 P1
- W2: WS2 P2  
- W3: WS2 P3
- W4: WS2 P4
- W5: integration
- W6: buffer

That's only 4 weeks of WS2 active work, but L91 says 6-7 weeks. **The L399 timeline implicitly compresses WS2 to 4 weeks while L91 says 6-7.** This is a **direct contradiction within the plan**. ❌

### WS8 "biz demo SOON" deliverable in week 4

PLAN L405: "Week 4: ... WS8 P2 (BIZ DEMO READY)". WS8 effort estimate L334: "2-3 weeks". WS8 starts week 3 per L404. 2-3 weeks from week 3 = week 4-5 conclusion. **Tight but not impossible** if WS2 P1 actually lands week 1-2.

But:
- Industry research deliverable for explainer (L347, L367, L377) is treated as a "sub-output". This is itself 3-5 days of research-and-synthesis work (LinkedIn Why this match / Indeed matched skills / Hired / Vettery — actual product audits). PLAN treats this as a checkbox, not a discrete sub-WS.
- Dashboard polish for biz-team-demo-ready (L378) is significantly more than "table list + slider". Adam's iter28 dashboard work was the single largest UI sprint of the project. Treating this as 2-3 weeks of full-stack output without a UI design phase is optimistic.

### Engineer count realism
PLAN L395: "Total bodies: 4-5 engineers (with pairing)."
- WS1, WS2, WS3, WS4, WS5, WS6, WS7, WS8 = 8 workstreams.
- WS4 + WS5 paired (same engineer or close pair) — OK.
- WS3 + WS6 paired — OK.
- WS2 + WS7 paired (L300, "can be same as WS2 since it's the consumer") — risky, WS2 is already 6-7 weeks.
- WS1 + WS8 + WS2 = 3 distinct headcount.
- Pairing math: ceil((8 - 2 paired×2) / 1) = need at least 4 distinct engineers running parallel.

4 engineers running in parallel for 6 weeks **with WS2 alone consuming one full engineer for the entire window** is plausible BUT:
- **No buffer for sickness, churn, or any engineer hitting a hard block** (e.g. SiliconFlow Qwen-7B free tier rate-limit forcing pivot).
- **No buffer for inevitable scope creep** that shows up when V2 schema actually lands and reveals downstream consumer breakage.

### Specific timeline risks
| Risk | Evidence |
|---|---|
| WS2 4w vs 6-7w contradiction | L91 vs L399-408 |
| Industry research "sub-output" treated as 0-day | L367 |
| WS4 19 skills LLM-judge each pass ≥ 80% | L213 — 19 skills × (zh + en eval) = 38 LLM-judge runs minimum, each requires fixture authoring + eval re-baseline |
| WS4 close + WS7 + WS8 all in week 4 | L405 — 3 high-touch workstreams converging in same week |

**Recommendation BLOCK-level**:
- Reconcile WS2 timeline: either WS2 is 4 weeks (re-scope phasing P1+P2 to 2 weeks each, drop P4 discovery UI to iter31) or total plan is 8 weeks. Pick one.
- Promote "explainer industry research" to a discrete WS8.0 sub-task with 3-5d budget and named deliverable file.
- Add a week 0 "verify external dependencies" sprint: Qwen-7B free-tier rate limits, OpenAI Responses API JSON schema mode for 14-field schema, BGE-M3 1024-dim throughput at 12k events/day.

---

## E. Acceptance gates rigor

**Verdict**: **FLAG**

Per-WS gate audit:

### WS1 (L75-80) — solid
- ✅ "All 4 limits enforced + tested" — testable.
- ✅ "mem0Add metadata round-trips to Qdrant (verify via direct read)" — testable.
- ✅ "qaBank entries searchable in Mem0 with correct intentTag" — testable.
- ⚠️ "cv-ingest swap deploys without regression on existing flows" — vague: "regression" against what fixture? Need concrete scenario list.
- ✅ "Sonnet 4.5 NOT in fallback chain" — testable (grep).

### WS2 (L132-138) — mostly solid
- ✅ "PA + scraping both write via shared lib" — testable.
- ⚠️ "12k events/day worker stable (load test)" — testable but no SLA defined (p99 latency? error rate?).
- ⚠️ "Cost ≤ $1.50/mo" — based on stale Qwen-7B-not-V4-Flash assumption (see §A).
- ✅ "Mutual exclusion enforced" — testable.
- ✅ "All 3 scraping taxonomies retired" — testable.

### WS3 (L172-175) — gates are weak
- ⚠️ "Single Firestore round-trip per turn (audit via Cloud Functions trace)" — testable but no baseline number to compare to.
- ⚠️ "Per-turn latency improved by ≥ 200ms" — testable but baseline depends on per-turn read count which varies. Adam will challenge "200ms vs what?".
- ⚠️ "Guardrails + tools all read ctx, not Firestore directly" — vague: requires lint-rule or grep to enforce.

### WS4 (L210-215) — solid
- ✅ "19 skills loaded in Firestore + dashboard" — testable.
- ✅ "Each skill has zh + en LLM-judge scenario passing ≥ 80%" — testable, BUT 80% threshold not justified (iter28 LLM-judge baselines may differ; could be 75% or 85% at status quo).
- ✅ "Composability tested: vent + jd_roast simultaneous, addendum concat correct" — testable.
- ✅ "Conflicts tested: vent + motivation_nudge → only highest priority wins" — testable.
- ✅ "No regression on existing 6 skills (LLM-judge re-baseline)" — testable.

### WS5 (L255-258) — solid
- ✅ "Intent classifier produces multi-skill output for composable scenarios" — testable.
- ✅ "No regression on the 6 LLM-judge baselines" — testable.
- ⚠️ "Cost ≈ $0/turn (free Qwen-7B)" — same Qwen-7B-free assumption gate.

### WS6 (L290-293) — gates are weak
- ⚠️ "Existing iter25-29 normalizer tests still pass" — testable but doesn't prove guardrails are wired correctly (could pass via unchanged normalizer code).
- ⚠️ "No more monkey-patch logic outside guardrail/ folder" — needs a lint rule or codebase grep gate.
- ✅ "PII scanner blocks 100% of fixture (SSN samples)" — testable.

### WS7 (L322-325) — gates are weak
- ⚠️ "All current preference/skill reads go through entity-tags" — needs grep gate.
- ⚠️ "Source attribution audit: any tag → which sources contributed" — testable but ill-defined "any tag".
- ⚠️ "BoostCalculator (WS8) reads entity-tags directly" — depends on coupling that PLAN wrongly forced (see §C).

### WS8 (L373-378) — solid for the BIZ-CRITICAL workstream but gate 5 is fluffy
- ✅ "Boost calculator reads Firestore, TS const deleted" — testable.
- ✅ "Dashboard edit → live within 30s without deploy" — testable.
- ✅ "Explainer prompt mentions core hits when present, never says 'Python match' alone" — testable but qualitative.
- ✅ "Industry research doc published" — testable existence.
- ❌ **"Biz-team demo-ready: Adam can show this without disclaimers"** — fluffy non-engineering acceptance criterion. Either define it as a checklist (5-bullet "no disclaimers" rubric) or remove it. Engineers cannot "test" against Adam's subjective tolerance.

**Recommendation**: Tighten gates for WS3, WS6, WS7 (add baseline numbers, lint rules, grep counts). Replace WS8 final gate with a concrete checklist. Add a lint/grep gate for "no monkey-patch outside guardrail folder" in WS6.

---

## F. Risks gaps (what's NOT in the plan)

**Verdict**: **BLOCK**

PLAN out-of-scope (L437-444) defers:
- 1000-user public-launch cost optimization (iter31)
- LLM-judge automated regression in CI (iter31)
- Multi-language playbook expansion (iter32+)
- VALET deeper integration (Hatchet workflow port)
- ESCO/LinkedIn imports

But the following risks are **NOT addressed at all** in PLAN:

### F1. Migration strategy for live users during ramp
- 19 skills will be loaded into `pa-playbooks` Firestore. Existing 6 are live. Schema bump = backward-compat risk. PLAN says "backward-compat" (L198) but no version pin / migration shadow / dual-write strategy.
- WS2 changes `realtime-tagger.ts` to call `recordTagEvent()` (L116). This affects every live user message. No flag-gated rollout described.
- **Adam iter23 directive**: feature flag flip is Adam-gated. PLAN does not call out which WS need flag-gated ramp. ❌

### F2. Rollback plan for each WS
- WS1: cv-ingest swap is a deploy-time replacement of the parser. If parser regresses, what's the kill-switch? PLAN does not specify.
- WS4 schema migration: if V2 schema breaks the existing 6 playbooks, what's the revert path?
- WS8: TS const deletion is irreversible without git. What's the staging strategy?

### F3. Cost monitoring per WS
- WS2 cost ceiling $1.50/mo is asserted but no monitoring instrumentation listed.
- WS5 Qwen-7B "free" — when free tier rate-limits, what's observability?
- `cost-logger.ts` is mentioned in deepseek-v4-pro-migration.md L234 as missing prices for some models. PLAN does not include "extend cost-logger.ts to cover Qwen-7B + structured-output gpt-5.4-nano + OpenAI Batch API rates".

### F4. Eval-baseline preservation across migrations
- iter28-29 hard-won LLM-judge wins (humanize-runtime, vent suspension, AB-strip — see git log: `iter25-29` commits) need preservation across the WS3/4/5/6 refactor.
- PLAN mentions "no regression on existing 6 skills (LLM-judge re-baseline)" (L215) but does not name the iter28-29 baseline files or commit which scenarios are the re-baseline target.
- **Concrete risk**: a green LLM-judge in iter30 that scores 78% vs iter29's 84% on `vent-suspension-12-turn` would be a regression but PLAN's gate would pass it (since "≥ 80%" threshold).

### F5. Test data / fixtures
- WS1 L73 "10 PDF fixture set" — exists where? Must be authored.
- WS4 19 skills × 2 langs = 38 test scenarios — authoring time not budgeted (1 day per scenario × 38 = 1 month for one engineer, NOT 3-4 weeks for the whole WS).
- WS2 "12k events/day load test" — load-test harness needs building.
- WS6 "fixture (SSN samples)" — must be authored.

### F6. Sendblue cost / prompt-injection on iMessage live channel
- PLAN does not mention iMessage live channel testing despite CLAUDE.md L50 "live scenario verify" mandate.
- WS6 PII scanner does not declare what happens if PII is in user msg vs Claire's reply. Adam's iter directive is verify-by-doing on iMessage.

**Recommendation BLOCK-level**: PLAN must add a §"Risks not in scope" or add a per-WS "Rollback" + "Cost guardrail" + "Eval baseline preservation" sub-section. 4 of these gaps (F1, F2, F4, F5) would burn engineers in week 1.

---

## G. Cross-cutting integrations

**Verdict**: **FLAG**

PLAN at L740 (discussion.md) ends with "底层逻辑: 5 个抓手不是孤立的 — parseResume 出的 qaBank 要进 tag pipeline, tag pipeline 喂 BoostCalculator, BoostCalculator 喂 Explainer, 所有都通过 RunContext 收口到 Claire turn. 拉通完才不互踩."

**Then PLAN.md does not enforce 拉通**.

### G1. WS1 (parseResume qaBank) → WS2 (tag pipeline)
- WS1 writes qaBank → Mem0. Each qaBank entry is an inferred fact like `intentTag::preference: ML`.
- These are exactly the signals that should flow into `pa-tag-events` via `recordTagEvent()`.
- **PLAN does not wire WS1 → WS2**. WS1 deliverables L66 stop at Mem0. ❌ **NOT 拉通**.

### G2. WS7 (entity-tags consumer) → WS2 + WS8 (BoostCalculator)
- WS7 builds `loadUserProfile(userId)` reading entity-tags.
- WS8 BoostCalculator reads weight tables + cv-skill list, computes match.
- BoostCalculator could read entity-tags for richer cv-skill list (instead of `cv.topSkills`), but PLAN does NOT couple them. WS8 reads `cvSkills: string[]` (L297 in discussion.md), no mention of entity-tags as input.
- Conversely, WS7 acceptance gate (L325) says "BoostCalculator reads entity-tags directly" — but WS8 deliverables don't reflect this.
- **Inconsistent coupling between WS7 gate and WS8 deliverable.** ❌

### G3. WS4 (skills) → WS3 (RunContext) ctx-aware activation
- WS4 mentions ctx-aware activation in goal (L184) but deliverables (L198-208) do NOT actually wire skill activation to ctx fields. The composability stacker reads skill metadata but no mention of reading ctx.activePlaybooks or ctx.userProfile to gate activation.
- ⚠️ **Half-coupling**: stated in goal, missing in deliverables.

### G4. WS6 (guardrails) → WS4 (skills) tool gating
- skill V2 schema has `allowedTools: string[]` field (research doc L644).
- PLAN WS4 deliverables drop this field (only 5 fields listed L196, vs 8 in research).
- Therefore skills cannot declare allowed tools, and WS6 guardrails have nothing to enforce on the skill side.
- ❌ **Tool-gating loop is broken before it starts.**

**Recommendation**:
- Add WS1.5 task: "After WS2 P1, qaBank entries also call recordTagEvent()."
- Reconcile WS7 ↔ WS8 BoostCalculator entity-tags read: pick one (either WS8 reads entity-tags as cvSkills source, or WS7 gate is wrong). Best path: WS8 reads entity-tags via WS7's loader.
- WS4 deliverables must restore `allowedTools` + `paths` + `llmInvokable` fields (or explicitly defer paths to iter31).
- WS4 deliverables must include "skill activation reads ctx.userProfile + ctx.activePlaybooks for gating".

---

## H. Out-of-scope appropriateness

**Verdict**: **FLAG**

PLAN defers 1000-user cost optimization to iter31 (L439).

Rough cost ceiling at 1000 users on gpt-5.4-nano:
- gpt-5.4-nano price (per discussion.md L207, "?" — Adam open-question L449). Best-known public benchmark as of audit date: **$0.20/M input, $1.25/M output** (from PLAN L13 / discussion.md L21-22).
- 1000 user × 30 turn/day × 30 days = **900,000 turns/month**
- Per turn: ~3000 input tokens (Bible + history + addendum) + ~200 output tokens.
- Cost/turn = (3000 × $0.20 / 1M) + (200 × $1.25 / 1M) = $0.0006 + $0.00025 = **$0.00085/turn**
- Monthly: 900,000 × $0.00085 = **~$765/mo at 1000 users on nano alone**

Comparison to discussion.md L228 (which projected V4-Pro at $780/mo for 1000 users post-promo). **Nano-only is roughly the same cost as V4-Pro post-promo**. The cost-discipline win from dropping V4-Pro is therefore not as significant as discussion.md implied — it's mostly a latency / capability difference, not cost.

Plus:
- WS5 Qwen-7B intent classifier × 1% of turns × Qwen-7B token cost ≈ negligible if free, ~$10/mo if paid.
- WS6 guardrail overhead — negligible (pre-pass regex + light LLM).
- WS2 tag pipeline — $1.50/mo budgeted, scales linearly to ~$15/mo at 10× user traffic.
- WS1 cv-ingest using OpenAI Batch API — async, 50% off, low-volume.

**Total at 1000 users: ~$780-820/mo**. Adam's "AS LOW AS POSSIBLE" mandate (per CLAUDE.md context + discussion.md L230) — this is the **same red line as V4-Pro post-promo**.

**Implication**: Dropping V4-Pro doesn't magically solve cost. The cost pressure at 1000 users is gpt-5.4-nano main turn. PLAN defers this to iter31 but it's the **same cost ceiling Adam was concerned about with V4-Pro**.

**Recommendation**: PLAN must add a P0 line in §"Out of scope" — "deferring 1000-user cost optimization but main-turn nano at 1000 users projects ~$780/mo, which is the same ceiling V4-Pro promo period pricing would have been. iter31 cost optimization is mandatory before public launch, not optional." This sets correct expectation now.

---

## I. Open questions surfaced

**Verdict**: **FLAG**

PLAN ends with 5 open questions (L447-454). They're fine. But there are **at least 6 more questions engineers will hit on day 1** that Adam needs to answer NOW, not later:

### Day-1 blockers Adam must clarify

1. **`@wekruit/shared-tags` publish strategy.** npm public? GitHub Packages with org auth? Workspace with git submodule? WS2 P1 cannot ship without this answer because scraping repo (separate git repo) needs to consume it.

2. **Qwen-7B free tier rate limits on SiliconFlow at 12k events/day + 1% of intent calls.** Adam said "free" — but free tier on most providers is rate-limited (RPM cap). If 12k events/day = ~8 RPS averaged, free-tier may not hold. WS2 + WS5 both block on this.

3. **gpt-5.4-nano price into cost-logger.ts.** Already in PLAN open questions L449. **Day 1 blocker** for WS1 + future cost monitoring.

4. **Existing dashboard skill-rename rollout policy.** WS4 says "externally rename playbook → skill in dashboard + LLM-facing prompts" (L188). LLM-prompt change = behavior change in production. Flag-gated? Sudden cutover? Adam-gated per CLAUDE.md L67 (paHumanizeRuntimeEnabled-style flag).

5. **WS8 dashboard polish target.** "Biz-team demo-ready" without specific UI spec — engineer will burn 3-5 days on UI critique loops. Adam: do you have a Figma reference, an existing internal dashboard screenshot to match, or "use Tailwind, ship it"?

6. **iMessage live testing during 19-skill rollout.** CLAUDE.md mandates live scenario verify. 19 skills × scenarios = 38+ live runs minimum. Adam's iMessage Apple ID at scale is already on the ToS-violation watchlist (per memory). What channel does engineer use to verify these without burning the AID?

### Existing 5 questions in PLAN
1. gpt-5.4-nano price → already flagged above (priority promotion)
2. DEEPSEEK_API_KEY deprovisioning → ✅ low priority
3. Engineer model preference (Opus vs Sonnet) → low priority
4. Biz demo target date → ⚠️ blocks WS8 backplan, **must be answered before WS8 spawn**
5. Closed-beta launch target date → ⚠️ blocks scope reduction decisions, must be answered before any spawn

**Recommendation**: PLAN should add §"Day-0 unblocks" with the 6 questions above — these CANNOT wait until each engineer's detail-plan returns. Adam should answer at least 1, 2, 4, 5 from the new list + 4, 5 from existing list (4 of the 5 existing) before any WS spawns.

---

## Top-level Verdict: **BLOCK**

Engineers should NOT spawn yet.

The plan is well-structured at the surface (Adam's locks are reflected, dependency graph drawn, gates per WS exist), but the audit surfaces three classes of issues that will compound into rework if engineers ship without revision:

### Category 1: Direct contradictions in the plan
- WS2 effort 6-7 weeks vs 4-week timeline allocation (§D)
- WS7 acceptance gate says BoostCalculator reads entity-tags but WS8 deliverables don't (§G2)
- WS8 dependency on WS7 over-stated (§C)

### Category 2: Coverage gaps that create silent rework
- WS4 dropped 3 skill-V2 fields (allowedTools, paths, llmInvokable) without explicit defer (§B + §G4)
- WS1 → WS2 tag-event coupling missing (§G1)
- Migration / rollback / cost-monitoring / eval-baseline gaps (§F)
- Stale supporting research not reconciled with Adam's locks (§A.1)

### Category 3: Fluffy gates + day-1 blockers
- WS3, WS6, WS7 acceptance gates need baselines and lint rules (§E)
- WS8 "biz-team demo-ready" gate is non-engineering (§E)
- 6 day-1 blockers Adam must answer (§I)

### Required edits to PLAN.md before engineer spawn

| File:Section | Change |
|---|---|
| PLAN.md L91 + L399-408 | Reconcile WS2 timeline. Recommend: bump total to 8 weeks, OR re-scope WS2 P4 (HDBSCAN + UI) to iter31 and lock 4w. |
| PLAN.md L196 | Restore `allowedTools` + `paths` + `llmInvokable` fields, OR add explicit "deferred to iter31: paths progressive disclosure + tool gating". |
| PLAN.md WS1 L66 | Add "After WS2 P1: qaBank facts also call recordTagEvent()" as P3 task. |
| PLAN.md WS8 L334 | Remove WS7 dependency. Keep WS2 P1 only (canonical-tags FK). |
| PLAN.md WS7 L325 | Remove "BoostCalculator reads entity-tags directly" gate, OR move to iter31. |
| PLAN.md WS2 L135 | Add "supersedes tag-ontology-research.md cost section — Qwen-7B free, recompute" callout. |
| PLAN.md WS4 L213 | Specify which iter28-29 baseline scenarios are the re-baseline reference. Name files. |
| PLAN.md L437-444 (out-of-scope) | Add "1000-user nano-only cost projects ~$780/mo, same as V4-Pro post-promo. iter31 cost optimization is MANDATORY pre-public-launch." |
| PLAN.md (new section) | Add §"Risks not in scope" covering F1-F6 (migration, rollback, cost monitoring, eval baseline, fixtures, iMessage testing). |
| PLAN.md (new section) | Add §"Day-0 unblocks Adam must answer" with 6 questions from §I. |
| PLAN.md WS8 L378 | Replace "biz-team demo-ready" with concrete checklist (5 bullets, e.g. "table list + edit + audit drawer + dry-run + history view all functional, no console errors, no incomplete copy"). |

### Recommended next steps

1. P10 architect (Claude in this session) addresses the 11 edits above to PLAN.md.
2. Adam answers the 6 day-0 questions in §I.
3. Re-run this audit on revised PLAN.md.
4. If audit returns PASS or FLAG-with-noted-constraints, spawn 4-5 engineer agents.

### What changes to PLAN if BLOCK reasons cleared:
- If Adam re-scopes WS2 P4 to iter31, total plan becomes 4-5 weeks WS2 active + WS1/3/4/5/6/7/8 parallel = 6 weeks holds.
- If Adam answers @wekruit/shared-tags publish strategy + Qwen-7B rate limit + biz demo date, WS2 + WS5 + WS8 can spawn day 1.
- If WS4 schema is corrected to include all 8 V2 fields (or 5 explicit + 3 explicit-defer), engineers stop guessing.

---

## Appendix: audit methodology

- Read PLAN.md in full (454 lines).
- Read discussion.md "ADAM DECISIONS 2026-05-03" section (lines 1-58) authoritatively, body lines 60-740 for context.
- Skimmed all 4 research docs: valet-integration.md, tag-ontology-research.md, deepseek-v4-pro-migration.md, skills-vs-playbook-research.md.
- Read CLAUDE.md for non-negotiable operating rules (deploy authority, eval-by-doing, flag-gated rollouts).
- Reviewed `git log --oneline -30` to ground iter28-29 baseline state.
- Spot-checked code references: `apps/job-rec/src/match-weights.ts` exists; `packages/agent-registry/src/playbooks.ts` exists; `apps/dashboard-web/src/pages/Playbooks.tsx` exists; `MatchWeights.tsx` does NOT exist.
- Counted current playbooks (8 keys) vs planned 19 — 11 net new.

> 🟠 **阿里味收尾**: 这份 audit 不是 nitpick，是把 5 个抓手 + 8 个 workstream 的颗粒度往下压一层。Plan 现在的状态像 P10 写完战略 PPT 没拉通各小组 Owner — 工程师上工后会把摩擦点全部抛回 P10。**先 close 11 个 PLAN 编辑 + 6 个 Adam 问答**，再开 spawn。一次性 close，后面就只剩纯执行。
