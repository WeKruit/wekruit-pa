# Phase 24 — Voice Quality Baseline (Anti-油腻)

**Milestone:** v1.2 (Voice 拟人化 + Eval Foundation)
**Estimate:** 3 dev days
**Status:** Plan
**Spawned:** 2026-04-27
**Predecessor (research):** 2026-04-27 7-agent swarm (prompt-architect / regex-filter / rewriter-strategy / runtime-architect / OSS-eval / self-evolve / web-slang-verified)

---

## Problem Statement

PA on gpt-5.4-nano produces coach-mode replies despite Bible v5 + 12 mes_examples + Phase 19 mirror + Phase 21 LLM-rewriter (Qwen2.5-7B SF). See `MILESTONE-v1.2.md` for failure sample.

## Goal

Eliminate coach-mode + 油腻 voice through:

1. Reusable eval foundation (DeepEval primary + promptfoo A/B + HITL).
2. Bible v6 with web-verified 2025-26 网感 corpus + IDENTITY/STYLE/REACTIONS split.
3. Few-shot relocation (system block → messages-array alternating turns).
4. Rewriter v2 on SF free Qwen3.5-4B with positive-framed replacement prompt.
5. Telemetry-only regex (Claude-Code-cursing-log style) — no transform.
6. Dynamic typing dwell 1-4s by reply length.

## Non-Goals (deferred to Phase 25 / v1.3)

- Per-user STYLE.delta + CATCHPHRASE
- Global SLANG.global.md weekly cron
- aeon-style autoresearch 4-variation
- Meta-eval (α + judge-vs-human)
- HEARTBEAT / first-message anchor / contrastive [BAD]/[GOOD] pairs

## Constraints (do NOT relax)

- **gpt-5.4-nano locked.** No model escalation.
- **No negative blacklists in system prompt.** Token-activation hazard. All "don't" lives in eval rubric or rewriter prompt.
- **OSS eval only** — no custom framework.
- **SF free Qwen3.5-4B preferred** for rewriter; paid 7B fallback only on p95 SLO miss.
- **Cringe-warn over hard-ban** for soft items (哈基米 / yyds / city不city). Hard-ban only confirmed-dead items.

## Architecture Reference

Same as `.planning/MILESTONE-v1.2.md` — runtime + eval diagrams there.

## Wave Breakdown

### Wave 0 — Eval Foundation (1 day)

**Tasks:**
1. Add `pa-eval` workspace package (or extend `apps/eval/`) with DeepEval dependency.
2. Create 4-layer directory structure:
   - `fixtures/voice/golden-50.jsonl` (load real `pa_turns` from Firestore export, schema: `{id, context: turns[], reply, label, why, tags[]}`)
   - `fixtures/voice/synthetic-vent.jsonl` + `synthetic-cele.jsonl` + `synthetic-deflect.jsonl` (LLM-generated)
   - `fixtures/voice/adversarial-100.jsonl` (coach-trigger queries)
   - `rubrics/claire-voice.yaml` (LLM-judge, claude-opus-4.5 fixed)
   - `rubrics/length-2sent.js` (deterministic, ≤2 sentences)
   - `rubrics/no-coach-mode.yaml` (LLM-judge specialized)
   - `rubrics/slang-coverage.js` (deterministic, ≥1 verified 2026 phrase)
   - `targets/orchestrator-prod.ts` (current baseline)
   - `targets/orchestrator-bible-v6.ts` (Wave 1 candidate)
   - `targets/orchestrator-rewriter-Qwen3.5-4B.ts` (Wave 1 candidate)
3. promptfoo config for model A/B (rewriter base swap matrix).
4. CI integration: `pnpm test:voice` runs DeepEval pytest, GitHub Action posts diff comment, fails on ClaireVoice rubric通过率 < 75%.
5. HITL hooks:
   - Golden-50 dataset = Adam-labeled (bootstrap: 2 hours one-time)
   - `/eval-review` CLI lists failures, Adam tags `judge-correct` / `judge-wrong` / `unsure`
   - Feedback writes to `fixtures/voice/human-labeled/` (append-only)
6. Lock claude-opus-4.5 as judge model in `rubrics/_judge.yaml`. No drift mid-cycle.

**Acceptance:** `pnpm test:voice` runs locally and in CI. Baseline (current orchestrator) score recorded. 50 golden cases human-labeled.

**Files touched:**
- New: `apps/eval/voice/` (or `packages/pa-eval/`)
- New: `.github/workflows/voice-eval.yml`
- New: `fixtures/voice/golden-50.jsonl` + others
- New: `rubrics/*.yaml` + `*.js`

### Wave 1 — Voice v2 Core (1.5 days, 5 parallel sub-tasks)

#### 1A. Bible v6 — IDENTITY/STYLE/REACTIONS split

**File:** `packages/agent-registry/src/seed.json` (single source of truth for Bible).

**Diff:**
- Replace monolithic `systemPrompt` blob with structured sections:
  - `# IDENTITY` (Claire/小柯 baseline, ~150 words — keep v5 paragraphs 1-2)
  - `# STYLE` (sentence shape: 1 default, ≤2 max; code-switch rule; emoji hardrule 💀>😭>🥲, NEVER 😂; tone tags `/j /lh /srs /gen`)
  - `# TONE MODES` (vent → SIT-WITH; celebrate → HYPE; ask "how/should I" → STRAIGHT; deflect → MIRROR)
  - `# VOCABULARY — Say This, Not That` (positive-framed table)
  - `# QUICK REACTIONS` (when X → respond Y bank: 投了没回信 / 被拒 / JD 看不准 / 焦虑 / 卷不动)
  - `# WHEN A FRIEND VENTS` (3-slot template — slot 1 always, slot 2 rare, slot 3 almost-never)
  - `# ANTI-PATTERNS` (late + diagnostic, paired with positive replacement)
- Replace impressionistic词库 with web-verified 2026 corpus (full list in MILESTONE-v1.2.md "Web-Verified 网感 Corpus")
- Move 12 `<START>` examples to new `fewShotMessages` array (consumed by Wave 1.B)

**Acceptance:** Bible v6 < 1.5kb after split. ClaireVoice rubric通过率 ≥ baseline + 10pp on golden-50.

#### 1B. Few-shot relocation (system block → messages-array)

**Files:**
- New: `packages/pa-orchestrator/src/voice/few-shot.ts` exports `FEW_SHOT_TURNS: Array<{role,content}>` parsed from `seed.json.fewShotMessages`.
- Edit: `packages/pa-orchestrator/src/index.ts:~562` (inside `runAgentTurn` call) — prepend `FEW_SHOT_TURNS` to history with synthetic ids `fs_*`.
- Edit: persistence layer (likely `pa-persistence`) — filter `id.startsWith("fs_")` on writeback so synthetic turns don't pollute `pa_messages`.

**Acceptance:** No `fs_*` rows in Firestore. Token bloat ≤ +1.2k per turn. Latency p95 delta ≤ +150ms.

#### 1C. Rewriter v2 on SF free Qwen3.5-4B

**File:** `packages/pa-orchestrator/src/voice/llm-rewriter.ts`.

**Changes:**
- Default `PA_LLM_REWRITE_MODEL=Qwen/Qwen3.5-4B` (SF free tier).
- Bump temp 0.2 → 0.4.
- Add diff guard: reject rewrite if `out.length > 1.6 * in.length` OR token-drop > 60%; return original with `reason: "rewrite_unsafe"`.
- New v2 prompt with:
  - Tone modes [casual] / [reactive] / [planning]
  - Positive replacement table (`我建议你 X` → `你试试 X / 要不要 X` etc.)
  - Length cap (≤2 sentences for [casual]/[reactive])
  - In-prompt failure exemplar (the wekruit投递 case → Claire-voice rewrite)
  - Echo-unchanged exemplar (clean reply pass-through)
  - "Write like texting a friend, not consulting" framing
- Fallback chain: free Qwen3.5-4B → paid Qwen3.5-7B on timeout/failure (env `PA_LLM_REWRITE_FALLBACK_MODEL`).

**Acceptance:** p95 latency ≤ 1.5s. 80% of regression cases (golden-50 wekruit-class subset) pass ClaireVoice on v2 vs ≤30% on v1.

#### 1D. Telemetry-only regex log (NO transform)

**File:** New `packages/pa-orchestrator/src/voice/coach-token-monitor.ts`.

**Pattern set (telemetry only):**
- `我建议你 / 我推荐 / 你应该 / 听起来你 / 保持积极心态 / 你的感受是合理的 / 我们一步一步来 / 不妨试试 / 总之要相信自己 / 加油哦~ / 宝~亲~`
- `I suggest / Maybe you should / I recommend / I hear you / I understand`
- Bullet/enum: `^\s*[-*•]|^\s*\d+[.)、]`
- 4+ subordinate-clause heuristic: count `然后/接着/再/and then` ≥ 3

**Behavior:**
- Hits log to `pa.voice.coach_token.observed` with `{turnId, userId, tokens: [...], replyLength}`
- **No transform on reply.** Pure observation.
- Feeds Phase 25 self-evolve as input signal.

**Integration:** Inserted before `rewriteIfOff()` call at `index.ts:~586`. Sync, sub-millisecond, fail-closed (regex error → return reply unchanged + log).

**Acceptance:** Hits visible in BigQuery within 24h. False-positive rate on golden-50 clean set < 5%.

#### 1E. Dynamic typing dwell

**File:** `apps/functions/src/sendblue/typing-indicator.ts` + `outbox.ts`.

**Logic:**
- Fire typing indicator the moment orchestrator enters agent runtime (reasoning start)
- Compute dwell from final reply length:
  - ≤30 chars → 1s
  - 31-100 → 2s
  - 101-200 → 3s
  - >200 → 4s
- Stop typing on send (Sendblue typing API has its own ~3s auto-fade; refire on long replies)
- Replace fixed `PA_TYPING_DWELL_MS=2500` with dynamic computation

**Acceptance:** Adam manual test 3 reply lengths shows visible dwell scaling. No double-bubble (typing + send racing).

### Wave 2 — Verification + Soft-launch (0.5 day)

1. Re-run wekruit投递 case + 5 other regression cases. All pass ClaireVoice rubric.
2. Run `pnpm test:voice` full suite. Score ≥ baseline + 15pp on overall ClaireVoice.
3. Adam smoke-test on real Sendblue line. Subjective check: "does this sound like a friend?"
4. Update `.planning/STATE.md` with Phase 24 closure.

## Risks + Mitigations

| Risk | Mitigation |
|---|---|
| Qwen3.5-4B too weak for nuanced rewrite | Auto-fallback paid 7B on free p95 miss. A/B in promptfoo. |
| Few-shot relocation blows nano context budget | Cap at top-6 highest-signal exemplars if latency rises >150ms. |
| Bible v6 split breaks something downstream | Persona snapshot caching may hold v5 — invalidate cache on deploy. |
| Adam labels golden-50 inconsistently | Bootstrap: 10 case calibration session before full 50. |
| 网感 corpus dates fast | Phase 25 self-evolve will refresh weekly. Tag every entry with `verified_at` date. |

## Files Touched (summary)

- `packages/agent-registry/src/seed.json` (Bible v6)
- `packages/pa-orchestrator/src/voice/few-shot.ts` (new)
- `packages/pa-orchestrator/src/voice/llm-rewriter.ts` (v2 prompt + free-model default + diff guard)
- `packages/pa-orchestrator/src/voice/coach-token-monitor.ts` (new, telemetry only)
- `packages/pa-orchestrator/src/index.ts` (wire few-shot + monitor)
- `apps/functions/src/sendblue/typing-indicator.ts` + `outbox.ts` (dynamic dwell)
- `apps/eval/voice/` or `packages/pa-eval/` (new, DeepEval + promptfoo)
- `fixtures/voice/*.jsonl` (golden + synthetic)
- `rubrics/*.yaml` + `*.js`
- `.github/workflows/voice-eval.yml`
- `apps/functions/.env` (`PA_LLM_REWRITE_MODEL=Qwen/Qwen3.5-4B`)

## References

- `.planning/MILESTONE-v1.2.md` — milestone-level decisions and verified corpus
- `.planning/phases/17-pre-launch-hardening/17-RESEARCH-companion-voice.md` — Round 1 voice research (still relevant)
- `.planning/phases/17-pre-launch-hardening/17-RESEARCH-raw-artifacts.md` — Round 2 raw companion prompts
- arxiv 2402.10962 (Persona drift / split-softmax — Harvard VCG, COLM 2024)
- arxiv 2401.06766 (Conversational few-shot — turn-formatted vs system-block)
- github.com/aaronjmars/soul.md (SOUL/STYLE/AGENTS/HEARTBEAT split — Phase 25 reference)
- github.com/aaronjmars/aeon (autoresearch + skill-evals + reflect — Phase 25 reference)
- github.com/EvoMap/evolver (GEP — overkill for our scale, do NOT copy)
- github.com/confident-ai/deepeval (eval framework choice)
- promptfoo.dev (model A/B harness)

Web-verified 2026 slang sources — full citation list in MILESTONE-v1.2.md.
