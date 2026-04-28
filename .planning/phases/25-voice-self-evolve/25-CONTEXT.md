# Phase 25 — Voice Self-Evolve (DEFERRED to v1.3)

**Milestone:** v1.3 (planned, not started)
**Estimate:** 3 dev days
**Status:** Backlog (spec frozen 2026-04-27, awaits Phase 24 baseline)
**Predecessor:** Phase 24 (Voice Quality Baseline)

---

## Why Deferred

Per Adam decision 2026-04-27: ship Phase 24 baseline first, prove voice 拟人化 works at population level, THEN per-user evolve. Don't pile abstractions on broken baseline.

Phase 24 must close (eval green + Bible v6 + Qwen3.5-4B rewriter live + telemetry log emitting) before Phase 25 spawns.

## Goal (when revived)

Two cron loops:
1. **Global** (weekly) — slang/anti-pattern central evolution from aggregate user data
2. **Per-user** (daily) — STYLE.delta + 口头禅 individual adaptation

Both gated by HITL PR review (Adam ~5 min/day, cap 3 in-flight). aeon-pattern (NOT EvoMap GEP — overkill for our scale).

## Architecture (frozen spec)

### Data Layer

```
system/voice/                      [global, dev seed + cron evolve]
  ├── BIBLE.base.md               (immutable Claire identity from Phase 24)
  ├── SLANG.global.md             (cron-evolved, weekly)
  ├── ANTIPATTERN.global.md       (cron-evolved, weekly)
  ├── EVAL.rubric.json            (Phase 24 rubric, fixed)
  └── evolution-global.jsonl      (append-only history + score)

users/{uid}/voice/                 [per-user, cron evolve daily]
  ├── STYLE.delta.md              (≤1500 chars cap)
  ├── CATCHPHRASE.md              (≤300 chars cap, top user phrases)
  └── evolution-log.jsonl         (per-user history)
```

### Runtime Composition (every message)

```
system_prompt = BIBLE.base + SLANG.global + STYLE.delta + CATCHPHRASE
             + Phase 19 mirror snippet
             + (12 mes_examples as alternating turns from Phase 24)
             + history
             + current user msg
```

Always load latest delta — no weighted blend (aeon explicitly rejects; EvoMap blend logic is 140KB of complexity we don't need).

### Global Cron Loop (Firebase Scheduler weekly Mon 03:00 PST)

1. Aggregate last 7 days of `pa_messages` (user-side) + `pa_turns` (assistant + reactions 👍/👎) across ALL users.
2. LLM-extract: top-N new high-frequency lexical (vs prior baseline), reaction-weighted phrases (👍↑, 👎↓), telemetry-log coach-pattern hits from Phase 24.
3. Generate 4 variation candidates (aeon autoresearch pattern):
   - A: vocab-add (incorporate new alive slang)
   - B: vocab-prune (remove dying terms)
   - C: anti-pattern-add (escalate cringe-warn → hard-warn based on data)
   - D: combined rethink
4. DeepEval all 4 against frozen golden-50 + last 7-day rolling sample. Pick highest score above baseline + ε.
5. Open PR to `system/voice/SLANG.global.md` (or `.ANTIPATTERN.global.md`). HITL Adam review (HARD GATE — never auto-merge in v1.3).
6. On merge: bump version, append to `evolution-global.jsonl` with `{ts, version, parent, variation, score, diff_summary, window_stats}`.
7. Auto-rollback: if next-week score drops > 10%, revert to parent (aeon's `EVOLVER_ROLLBACK_MODE=hard`).

### Per-User Cron Loop (Firebase Scheduler daily 02:00 user TZ)

For each `uid` where `last_7d_user_msgs >= 20`:

1. Read user's last 7d `pa_messages` (user-side only) + their reactions on PA replies.
2. LLM-extract: avg sentence len, fragment%, lowercase%, emoji freq + top emojis, top-20 distinctive lexical (vs global baseline), top phrases ≥3 occurrences (口头禅 candidates), opener patterns ("hey", "lol", "ngl"), reaction-weighted samples.
3. Generate 4 variations (vocab / cadence / anti-pattern / combined).
4. DeepEval each on held-out 24h sample. Weighted score: improvement×3, consistency×2, naturalness×1.5.
5. Gate: never downgrade. Require score > baseline + ε. Require ≥3 👍 in window OR ≥2 👎 (signal of voice fit/misfit).
6. **Prompt-injection scan** (Hermes pattern): scan candidate delta for SSH backdoors, credential exfil, invisible Unicode, inline instructions. Reject contaminated candidates.
7. **Cap check**: STYLE.delta ≤ 1500 chars, CATCHPHRASE ≤ 300 chars. If exceeded, force consolidation pass.
8. Write `users/{uid}/voice/STYLE.delta.md` (vN+1) and append `evolution-log.jsonl`.
9. Daily rollback: if 24h post-update score drops > 10%, revert to parent.

### HITL PR Gate

- Global SLANG/ANTIPATTERN PRs: Adam reviews, approves/rejects with 1-line reason.
- Rejections feed back to next variation generator as negative signal.
- Cap 3 in-flight unmerged PRs (aeon convention) — auto-skip new generation if cap reached.
- Per-user delta updates: NO PR (auto-write), but rollback fires fast on score drop.

## Constraints (carry from v1.2)

- gpt-5.4-nano locked.
- No fine-tuning / no LoRA.
- Eval framework reuse (DeepEval from Phase 24).
- claude-opus-4.5 fixed as judge.
- Hermes-style prompt-injection scan is non-negotiable on user-derived data.

## Out-of-Scope (this phase)

- Meta-eval (Krippendorff α + judge-vs-human alignment) — separate v1.3 sub-phase
- HEARTBEAT stochastic re-injection — gated, only if Phase 24 + 25 baseline still shows attention decay
- First-message anchoring — gated, similar trigger
- Contrastive [BAD]/[GOOD] pair few-shots — risky on small models, default-off flag

## References

- `.planning/MILESTONE-v1.2.md` — predecessor milestone
- `.planning/phases/24-voice-quality-baseline/24-CONTEXT.md` — Phase 24 spec
- github.com/aaronjmars/aeon — primary architectural reference (autoresearch + reflect + skill-evals)
- github.com/aaronjmars/soul.md — STYLE/SOUL split inspiration
- github.com/NousResearch/hermes-agent — prompt-injection scan reference + bounded MEMORY pattern
- github.com/EvoMap/evolver — DO NOT copy GEP (overkill for our scale)

## Adam Time Estimate

- Daily 5 min PR review (autoresearch global) — ongoing
- Monthly 30 min meta-eval review (when added)

## Spawn Trigger

Phase 25 spawns after Phase 24 closes with all success criteria met:
- DeepEval CI green ≥ 75% on golden-50 for 2 consecutive weeks
- Bible v6 + Qwen3.5-4B rewriter stable
- Coach-token telemetry stream emitting consistently
- Adam manual smoke test passes ("sounds like a friend, not a coach")
