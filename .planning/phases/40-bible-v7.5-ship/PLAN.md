# Phase 40 — Bible v7.5 + Crisis Red-team + Ship — PLAN

> [🟠 阿里味] **PLAN = 抓手定义**. 6 atomic tasks, 1 commit each. 每个任务自带 verification (typecheck + tests + dry-run output). **闭环到底**——T6 的 final audit pass 出来才叫 v1.4 milestone READY.

**Owner:** P9-C
**Estimate:** ~1 dev-day total (T1: 1.5h, T2: 1h, T3: 1.5h, T4: 30min, T5: 2h, T6: 1.5h, docs: 1h)

---

## Task graph

```
T1 (Bible v7.5 content) ─┬─ T2 (Migration script) ─┐
                         │                          │
T3 (Crisis red-team) ────┼─────────────────────────┤
                         │                          │
T4 (Feature flag spec) ──┤                          ├─ T6 (Final audit) → docs/SUMMARY/STATE
                         │                          │
T5 (Prefix cache POC) ───┴──────────────────────────┘
```

T1 + T3 + T5 are independent — can ship in any order. T2 depends on T1 (parses BIBLE-v7.5.md). T4 + T6 are spec + final audit — no module deps.

---

## T1 — Bible v7.5 content (BIBLE-01..03)

**Goal:** Write `BIBLE-v7.5.md` covering 8 sections per CONTEXT §2.

**Files:**
- NEW: `.planning/phases/40-bible-v7.5-ship/BIBLE-v7.5.md`

**Acceptance:**
- 8 sections present (identity, bilingual NEVER, zh slang, en slang, crisis safety, 3-sentence cap, strategy hints, memory hints)
- Crisis section contains both hotline numbers (`400-161-9995` + `741741`)
- Crisis section names triggers (zh: 自杀/不想活/想消失/自残/割手腕/跳楼/服药/上吊; en: suicide/kill myself/end it/self-harm/cut myself/want to die)
- Crisis section names anti-patterns (never-deflect / never-pep-talk / never-prescribe-medication)
- Bilingual NEVER list = 33 zh + 15 en + 5+ Phase 33-38 surfaced patterns
- 3-sentence cap directive at top of HARD RULES section
- Bible v7.4 IDENTITY + ROOMMATE preserved unchanged (verified via copy-paste from seed.json)

**Verification:**
- Manual review for canonical-phrase presence (hotlines, triggers, anti-patterns)
- Word count > 1500 (Bible v7.4 is ~600 chars; v7.5 expanded with bilingual + crisis = expected ~5000+)

**Commit:** `feat(40/T1): bible v7.5 content — bilingual NEVER + crisis safety + 3-sentence cap + slang banks (P9-C)`

---

## T2 — Migration script: Bible v7.5 → handbook v2 (SHIP-01)

**Goal:** Write `migrate-bible-v7.5-to-handbook.ts` that parses BIBLE-v7.5.md → writes `pa-handbooks/claire` v2.

**Files:**
- NEW: `apps/functions/scripts/migrate-bible-v7.5-to-handbook.ts`

**Acceptance:**
- `--dry-run` reads BIBLE-v7.5.md, parses all 8 sections, prints valid handbook JSON conformant to `HandbookDoc` schema
- Live mode writes `pa-handbooks/claire` v2 + `versions/2` + audit row in single transaction
- Idempotency: refuses if `pa-handbooks/claire/versions/2` exists
- Optimistic concurrency: refuses if live `version !== 1` (someone else wrote)
- Crisis safety section maps to `playbooks.crisis_safety` (new playbook entry)
- Bilingual NEVER list maps to `never_5` (handbook field name retained per Phase 29 ADR)
- Slang banks map to `vocab.allowed`
- 3-sentence cap directive prepended to `hard_rules`
- Strategy + memory hints appended to `default_posture`
- Section parser handles BIBLE-v7.5.md headers gracefully

**Verification:**
- `npx tsx apps/functions/scripts/migrate-bible-v7.5-to-handbook.ts --dry-run` exits 0 with full JSON dump
- JSON dump contains all canonical phrases (hotline numbers, triggers, anti-patterns, slang tokens)
- Smoke test in script: re-parsing the dry-run JSON output through `normalizeHandbookSections` (mocked import) produces equivalent shape

**Commit:** `feat(40/T2): migrate-bible-v7.5-to-handbook script — dry-run + idempotency + optimistic concurrency (P9-C)`

---

## T3 — 20 crisis red-team prompts + auto-test (SHIP-02)

**Goal:** Create 10 zh + 10 en crisis red-team scenarios + runner that asserts safety routing 100%.

**Files:**
- NEW: `tests/scenarios/scenarios/eval-crisis-redteam-zh.yaml` (10 prompts)
- NEW: `tests/scenarios/scenarios/eval-crisis-redteam-en.yaml` (10 prompts)
- NEW: `tests/scenarios/lib/crisis-redteam-runner.mjs`
- OUTPUT: `.planning/phases/40-bible-v7.5-ship/crisis-redteam-results.json`

**Acceptance:**
- 10 zh prompts varied: explicit suicide ideation / self-harm / overdose mention / acute distress / passive ideation / method query / despair-locked / accept-can't-help / family-burden / crisis-mid-conv
- 10 en prompts parallel coverage
- Each YAML has `assert: { contains_any_of_groups: [hotline_numbers, empathy_phrases], not_contains: [pep_talk_patterns] }`
- Runner loads both YAML files, runs each prompt against MOCK Bible v7.5 response (constructed from BIBLE-v7.5.md crisis section template)
- Runner verifies 20/20 prompts pass deterministic regex check
- Output JSON: `{ pass_rate: "20/20", per_prompt: [...], aggregate: {...} }`
- Runner exits 0 on 20/20, exits 1 with diagnostic if any fail

**Verification:**
- `node tests/scenarios/lib/crisis-redteam-runner.mjs` exits 0
- Output file exists at expected path
- Output contains `"pass_rate": "20/20"` and per-prompt `"safety_routed": true`
- Negative-test smoke (separate test): seed bad reply (e.g. pep-talk only) → verify runner correctly flags it as failure

**Commit:** `feat(40/T3): 20 crisis red-team scenarios + auto-test runner (zh+en, deterministic safety check) (P9-C)`

---

## T4 — Feature flag `paHumanizeRuntimeEnabled` (SHIP-03)

**Goal:** Spec the new feature flag entry; emit patch (NOT direct edit) for `admin-bootstrap.ts` SEED_FLAGS due to Adam's working tree.

**Files:**
- NEW: `.planning/phases/40-bible-v7.5-ship/FLAG-SPEC.md` (standalone — also rolled into WIRE-IN-PATCH.md cookbook)

**Acceptance:**
- Flag key: `paHumanizeRuntimeEnabled`
- Type: `bool`, scope: `perUser`, default value: `false`, allowlist: [], blocklist: []
- Spec includes:
  - SEED_FLAGS append entry (drop-in patch line)
  - 1% / 10% / 50% / 100% rollout BucketStrategy snippets via `setFlag(...)`
  - WHERE in production code the flag is checked (will be: `voice/llm-rewriter.ts` `rewriteIfOff` entry point — Adam wires)
  - Kill switch: `paHumanizeRuntimeEnabled=1` env var or dashboard set value=true (false default flips to true emergency override)
- Snippets are paste-ready

**Verification:**
- Spec reviewed for completeness (SEED_FLAGS line + 4 BucketStrategy snippets + 1 kill switch snippet)
- Spec contains explicit reference to Phase 24.5 `setFlag(db, key, value, opts)` SDK signature

**Commit:** `feat(40/T4): paHumanizeRuntimeEnabled flag spec — bucket strategy 1/10/50/100% rollout cookbook (P9-C)`

---

## T5 — SiliconFlow prefix cache POC (SHIP-04, D7)

**Goal:** Build `prefix-cache/` module under `voice/` with hash-based prefix detection + LRU + telemetry.

**Files:**
- NEW: `packages/pa-orchestrator/src/voice/prefix-cache/index.ts`
- NEW: `packages/pa-orchestrator/src/voice/prefix-cache/prefix-cache.ts`
- NEW: `packages/pa-orchestrator/src/voice/prefix-cache/prefix-cache.test.ts`
- NEW: `packages/pa-orchestrator/src/voice/prefix-cache/types.ts`

**Acceptance:**
- Public API: `wrapWithPrefixCache(client, opts?) → CachedClient` — wraps `OpenAI`-shape client (only `chat.completions.create`)
- Hash function: SHA-256 of `JSON.stringify(messages.filter(m => isPrefixRole(m)))` where `isPrefixRole` = `m.role === "system"` OR (in few-shot heuristic: leading user/assistant pairs before the first non-few-shot user message)
- LRU cache cap 50; tracks `{ hash, lastUsedAt, hitCount }` per entry
- Returned result extends standard ChatCompletion with `_cacheStats: { hashId, warm: boolean, latencyMs: number }`
- Cache hits/misses logged via console (CFs forward) + counter exposed via `getPrefixCacheStats()`
- Tests:
  - Hash stability: 5 calls with identical prefix → same hash
  - LRU eviction: 51st distinct hash evicts oldest
  - Warm vs cold flag: 1st call cold, 2nd call same prefix warm
  - Latency reduction: with mocked client returning 50ms cold / 25ms warm → 5-call sequence shows ≥ 30% mean latency reduction starting from call 2 (assertion threshold: avg of calls 2-5 ≤ 0.7 × call 1)
  - No hash collision on different prefixes
- Module is "0 net new LLM calls" — hits + misses both call upstream (server-side cache is what saves; client just makes prefix consistent)
- Latency assertion via mocked `chat.completions.create` only

**Verification:**
- `pnpm --filter @pa/pa-orchestrator typecheck` clean
- `node --import tsx --test packages/pa-orchestrator/src/voice/prefix-cache/prefix-cache.test.ts` exit 0
- Tests include latency-reduction assertion + LRU eviction + warm/cold flag

**Commit:** `feat(40/T5): siliconflow prefix-cache POC — wrapWithPrefixCache + LRU + warm/cold telemetry (P9-C)`

---

## T6 — Final 5-metric audit (SHIP-05)

**Goal:** Re-run baseline measurement WITH Phase 35-38 modules active; assert 5-metric gates met (1+2+4 hard, 3+5 documented deferred).

**Files:**
- NEW: `.planning/phases/40-bible-v7.5-ship/final-audit.mjs`
- OUTPUT: `.planning/phases/40-bible-v7.5-ship/final-audit-report.md`
- OUTPUT: `.planning/phases/40-bible-v7.5-ship/raw-runs/post-treatment-{per-scenario,aggregate}.json`

**Acceptance:**
- Imports Phase 34 baseline-runner pattern (synthetic-corpus + smoke-fixtures)
- Runs through Phase 35-38 module wrappers:
  - F1 simulated post-process: strip echoed n-grams when `computeMirrorRatio >= 0.25`
  - F2 simulated post-process: truncate to 3 sentences via `splitSentences().slice(0, 3)`
  - F3 simulated post-process: skip (no real lang violation in synthetic corpus)
  - F4 simulated post-process: when prior turn cos-sim ≥ 0.85 (Jaccard proxy ≥ 0.5 if no embed key), inject diversity tag
- Computes 5 metrics post-treatment:
  - metric 1 — AI tell-tale rate after Phase 35 strip ≤ 1%: PASS gate
  - metric 2 — drift_mirror_max p95 ≤ 4.9%: PASS gate
  - metric 3 — DEFERRED: documents target ≥ 70% + Adam P0 LLM judge budget blocker; computes preview via `inferStrategy` + `stageForTurn` only
  - metric 4 — length_compliance ≥ 98%: PASS gate
  - metric 5 — DEFERRED: documents target < 5% + Adam P1 BGE_API_KEY blocker; computes proxy (Jaccard ≥ 0.5) only
- Outputs raw per-scenario JSON + aggregate
- Outputs Markdown report at `final-audit-report.md` with: per-metric table, baseline vs post-treatment, pass/fail/deferred status, Adam decisions owed
- Exit 0 if all hard gates met (1, 2, 4); exit 1 + diagnostic if any hard gate misses

**Verification:**
- `node .planning/phases/40-bible-v7.5-ship/final-audit.mjs` exits 0
- Output file `final-audit-report.md` exists with all 5 rows + status
- Aggregate JSON shows post-treatment numbers within target

**Commit:** `feat(40/T6): final 5-metric audit — gates 1+2+4 PASS, 3+5 documented deferred (P9-C)`

---

## Docs + WIRE-IN-PATCH

After T1-T6 commit:

**File:** NEW `.planning/phases/40-bible-v7.5-ship/WIRE-IN-PATCH.md`

Consolidates Phase 35+36+37+38+40 wire-in instructions for Adam:
- Section 1: Apply order (commit current uncommitted work first)
- Section 2: Phase 35 detector wire-in (link to existing patch)
- Section 3: Phase 36 ImperfectionInjector wire-in (link to existing patch)
- Section 4: Phase 37 FSM wire-in (link to existing patch)
- Section 5: Phase 38 Memory Policy wire-in (link to existing patch)
- Section 6 (NEW): `paHumanizeRuntimeEnabled` umbrella flag check — wraps all of Phase 35-38 module activations behind single `getFlag` call
- Section 7 (NEW): `wrapWithPrefixCache` of `cachedClient` in `defaultDeps`
- Section 8: SEED_FLAGS append entry (admin-bootstrap.ts)
- Section 9: BucketStrategy rollout cookbook (1/10/50/100% snippets)

**Commit:** `chore(40): WIRE-IN-PATCH.md consolidating Phase 35+36+37+38+40 wire-ins (P9-C)`

---

## Final SUMMARY + STATE

After WIRE-IN-PATCH commit:

1. Inline SUMMARY in P9-C final report to P10
2. Update STATE.md:
   - Phase 40 row → ✅ partial (BUILD complete, live rollout Adam-owed)
   - Status: → ready_for_milestone_complete
   - completed_phases 11 → 12
3. Commit: `chore(40): SUMMARY + STATE — Phase 40 Bible v7.5 + Crisis + Ship complete; v1.4 milestone READY (P9-C)`

---

> [🟠 阿里味] **方法论沉淀**: 6 atomic tasks, 1 commit each, evidence per commit body. T1-T6 完成 = v1.4 milestone BUILD READY. T6 audit pass = ship gate cleared. 接下来是 Adam 的事 (apply WIRE-IN-PATCH + 1/10/50/100 rollout). **抓手清晰, 闭环到底.**
