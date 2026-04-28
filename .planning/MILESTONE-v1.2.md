# Milestone v1.2 — Voice 拟人化 (Anti-油腻) + Eval Foundation

**Status:** Plan
**Spawned:** 2026-04-27
**Predecessor:** v1.1 (Pre-Launch Hardening + Companion Brain — Phases 18, 20, 21 shipped; 19, 22, 23 carried forward)
**Successor (planned):** v1.3 (Voice Self-Evolve)

---

## Why This Milestone

Phase 21 Sendblue cutover unblocked the channel. Voice quality is now the only blocker to opening closed beta beyond 2 internal testers.

Real failure observed 2026-04-27 sandbox:

> **USER:** 我前两天投了一个wekruit岗位的工作，还没回信呢
> **PA:** 听起来有点闷，前两天投了还没回也很正常，Wekruit 这类有时候就是慢或者直接默拒。你先别自己脑补太多，**我建议你把投递时间记一下**，然后**等到下一周中后段**再看要不要 follow up。

Symptoms: coach-probe verbs ("我建议你"), 4+ subordinate clauses, planner-mode time refs, no slang/emoji/fragments. Bible v5 + 12 mes_examples + Phase 19 mirror + Phase 21 LLM-rewriter (Qwen2.5-7B SF) all in place; output still robotic.

Root-cause hypothesis (cross-validated by 4 swarm agents + Harvard VCG arxiv 2402.10962 + OpenClaw / aeon / hermes / soul.md research):

1. **Persona drift = attention-decay**, not prompt-content insufficiency. Adding more Bible text can't fix it.
2. **Negative-instruction overload** in Bible v5 raises P(banned phrase) on small models (token-activation hazard).
3. **Few-shot examples buried in system block** — chat models pick up style ~3× harder from messages-array alternating turns vs system text (arxiv 2401.06766).
4. **Bible v5 lexicon is impressionistic, not 网感** — written from intuition, not 2025-26 verified slang.
5. **Eval is missing.** No regression net = every voice change is vibes.

---

## Goal

Eliminate coach-mode / 油腻 voice. Establish reusable eval foundation. Ship day-1 internet 网感 corpus. Defer per-user self-evolution to v1.3.

## Success Criteria

1. **Eval foundation live** — DeepEval `pnpm test:voice` runs in CI; PR blocks when ClaireVoice rubric通过率 drops below 75%.
2. **Bible v6 shipped** — IDENTITY/STYLE/REACTIONS split + Quick Reactions bank + positive-framed replacement table + 30+ web-verified 2025-26 网感 phrases (老登 / 活人感 / 邪修 / 主理人 / 误闯天家 / 预制 XX / 赛博对账 / etc.).
3. **Few-shot relocation** — 12 mes_examples migrated from system_prompt block to messages-array alternating user/assistant turns; persistence layer ignores `fs_*` synthetic ids.
4. **Rewriter v2 on SF free Qwen3.5-4B** — fail-open ≤1.5s p95, diff guard (>1.6× len OR >60% drop → reject), v2 prompt with positive replacement table + in-prompt failure exemplar.
5. **Telemetry-only regex log** — hits on `我建议你 / 你应该 / 听起来你 / 保持积极心态 / AI slop / etc.` log to `pa.voice.coach_token.observed` (no transform); feeds v1.3 self-evolve.
6. **Dynamic typing dwell** — Sendblue typing fires at agent reasoning start, dwell length scales 1-4s with reply length, stops on send.
7. **3 anchor regression cases pass** — wekruit投递 case + vent case + celebrate case — all rated PASS by ClaireVoice rubric on baseline rerun.
8. **Cringe-warning over hard-ban** — soft items (哈基米 / yyds / city不city) not banlisted, only flagged in rubric for cringe scoring; hard ban only on dead/cringe items confirmed by web verify (听我说谢谢你 / no cap / sus / sheesh / bussin / slay / bet / gyatt).

## Constraints (Adam-locked, do NOT relax)

- **No model escalation.** Agent stays gpt-5.4-nano via Responses API.
- **No negative-instruction blacklists in system prompt** — token-activation hazard on small models. All "don't" rules go in eval LLM-judge or rewriter prompt only.
- **No fine-tuning** — no anchor data yet.
- **Eval framework must be OSS** — DeepEval primary, promptfoo secondary for A/B. Don't build custom.
- **Rewriter prefers SF free tier** (Qwen3.5-4B). Paid fallback only when free fails p95 SLO.
- **Self-evolve deferred** — Phase 25 spec written, not executed this cycle.
- **HITL is non-optional** — Adam reviews autoresearch PRs (cap 3 in-flight); human-labeled golden-50 dataset is source of truth.

## Phases

| # | Phase | Goal | Estimate | Status |
|---|-------|------|---|---|
| 24 | Voice Quality Baseline | Eval framework + Bible v6 + few-shot relocation + Qwen3.5-4B rewriter + telemetry-only regex + dynamic typing dwell | 3 dev days | Plan |
| 25 | Voice Self-Evolve (deferred to v1.3) | Global slang central evolution (weekly cron) + per-user STYLE.delta + 口头禅 (daily cron) + aeon-style autoresearch + HITL PR gate + Hermes-style injection scan | 3 dev days | Backlog |

## Architecture (Phase 24)

```
┌─ DATA ──────────────────────────────────────────────────────┐
│ system/voice/          [global, dev-edited]                │
│   ├── BIBLE.base.md         Claire 人格 (immutable Bible v6)│
│   └── EVAL.rubric.json      ClaireVoice + length + slang    │
│                                                             │
│ fixtures/voice/        [eval dataset, git LFS]              │
│   ├── golden-50.jsonl       human-labeled real pa_turns    │
│   ├── synthetic-vent.jsonl  LLM-gen scenarios              │
│   └── adversarial-100.jsonl coach-trigger queries          │
└─────────────────────────────────────────────────────────────┘

┌─ RUNTIME ──────────────────────────────────────────────────┐
│ user msg → BIBLE.base + few-shot turns + history           │
│         → gpt-5.4-nano (Responses API)                      │
│         → telemetry tap (regex log only, NO transform)      │
│         → Qwen3.5-4B rewriter v2 (SF free, 1.5s, fail-open)│
│         → output-normalizer (existing Phase 20)             │
│         → dynamic typing dwell (1-4s by reply length)       │
│         → Sendblue REST                                     │
└─────────────────────────────────────────────────────────────┘

┌─ EVAL ─────────────────────────────────────────────────────┐
│ DeepEval (multi-turn ConversationalGEval) — primary        │
│ promptfoo (model A/B side-by-side) — secondary             │
│ 4 reusable layers: dataset × rubric × target × runner      │
│ HITL: golden-50 truth + judge calibration + auto-PR review │
│ pytest CI gate, claude-opus-4.5 fixed as judge model       │
└─────────────────────────────────────────────────────────────┘
```

## Web-Verified 网感 Corpus (Phase 24 Bible v6 input)

Source: web research 2026-04-27 (微博 / 小红书 / 1point3acres / Reddit / TikTok / Smithsonian / EMU thesis on tone tags). Full citations in `.planning/phases/24-voice-quality-baseline/24-CONTEXT.md`.

**Add (verified 2025-26 alive):**
- Chinese: `老登` / `活人感` / `邪修` / `主理人` / `误闯天家` / `预制 XX` / `赛博对账` / `如何呢, 又能怎` / `班味` / `去班味` / `拼好 X` / `从从容容游刃有余 / 匆匆忙忙连滚带爬` / `职场申公豹` / `真没空陪你闹了` / `发疯工牌` / `蒜鸟蒜鸟`
- English (Gen Z 2025-26): `delulu` / `cooked` / `mid` / `brainrot` / `slop` / `lock in` / `yapping` / `glazing` / `aura` / `it's giving X` / `mother is mothering` / `demure` / `ragebait` / `crash out` / `NPC behavior` / `canon event` / `iykyk`
- Caption patterns: `not me [verb-ing] [thing] at 3am` / `the way [observation]` / `[noun] era` / `main character energy` / `POV: [you-are-X]` / `no thoughts just [X]`
- Emoji hardrule: 💀 > 😭 > 🥲. NEVER 😂 sincere (Gen Z 2026 老人标志, ladbible 2025-12).
- Tone tags: `/j` / `/lh` / `/srs` / `/gen`

**Cringe-warn (not hard-ban — soft items):**
- 哈基米 / yyds / city 不 city / 蚌牛 / 含金量还在上升

**Hard-ban (web-verified dead):**
- 听我说谢谢你 / no cap / sus / sheesh / bussin / slay (overplayed) / bet / on god / gyatt
- "听起来你..." / "我建议..." / "保持积极心态" / "你的感受是合理的" / "我们一步一步来" / "首先/其次/最后" / "宝~亲~" / "加油哦~" / "作为 AI"

## Out-of-Scope (this cycle)

Deferred to v1.3 / Phase 25:
- Per-user STYLE.delta + CATCHPHRASE evolution
- Global SLANG.global.md weekly cron
- aeon-style autoresearch 4-variation generator
- Hermes-style prompt-injection scan on user-derived deltas
- Meta-eval (Krippendorff α + judge-vs-human alignment monthly)
- HEARTBEAT stochastic re-injection
- First-message anchoring
- Contrastive [BAD]/[GOOD] pair few-shots

## Adam HITL Investment

- 50 golden-set hand labels (one-time, ~2 hours)
- Daily 5 min PR review (autoresearch — only after Phase 25 ships)
- Monthly 30 min meta-eval review (after v1.3)

Phase 24 only: ~3 hours total Adam time across the whole cycle.
