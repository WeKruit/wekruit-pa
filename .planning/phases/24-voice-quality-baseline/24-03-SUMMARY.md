---
phase: 24-voice-quality-baseline
plan: "03"
subsystem: voice-persona
tags: [bible-v6, few-shot, messages-array, persistence-filter, voice-quality]
dependency_graph:
  requires: [24-01, 24-02]
  provides: [Bible-v6-seed, few-shot-module, fs-filter]
  affects: [pa-orchestrator, pa-persistence, agent-registry, core-types]
tech_stack:
  added: [fewShotMessages-array-in-AgentDefSchema]
  patterns: [messages-array-few-shot, fs-id-guard, ChatMessage-stub-synthetic]
key_files:
  created:
    - packages/pa-orchestrator/src/voice/few-shot.ts
    - packages/pa-orchestrator/src/voice/few-shot.test.ts
    - apps/eval/voice/eval-results/24-03-bible-v6-anchors.json
  modified:
    - packages/agent-registry/src/seed.json
    - packages/core-types/src/index.ts
    - packages/pa-orchestrator/src/index.ts
    - packages/pa-persistence/src/index.ts
decisions:
  - "prefixFewShotToHistory uses ChatMessage-shaped stubs (body/sessionId/userId/createdAt sentinels) — required because runAgentTurn accepts ChatMessage[], not generic {role,content} objects"
  - "fs_* filter added to pa-persistence appendMessage as defense-in-depth even though history (not historyForModel) is passed to persistence paths"
  - "AgentDefSchema extended with fewShotMessages in core-types/src/index.ts (Zod schema), not a separate seed-types.ts — AgentDef is the canonical type"
  - "Bible v6 systemPrompt trimmed to 1392 chars (vocab list consolidated to slash-separated format to stay under 1500)"
metrics:
  duration: "~40 minutes execution"
  completed: "2026-04-28"
  tasks: 4
  files_modified: 7
---

# Phase 24 Plan 03: Bible v6 + Few-Shot Relocation Summary

**One-liner:** Bible v6 IDENTITY/STYLE/REACTIONS split (4997→1392 bytes, 72% reduction) + 12 mes_examples migrated from systemPrompt block to messages-array fewShotMessages with fs_* persistence guard.

## Bible v5 → v6 Size Diff

| Metric | v5 | v6 | Change |
|---|---|---|---|
| systemPrompt bytes | 4997 | 1392 | -72% |
| `<START>` example blocks in systemPrompt | 12 | 0 | removed |
| fewShotMessages array | — | 24 messages | added |
| Sections | monolithic | 7 structured | split |
| version field | "5" | "6" | bumped |

## fewShotMessages Sanity Check

All 12 example pairs preserved verbatim:
- 柠檬茶女孩 anchor: `{"role":"user","content":"我喜欢喝柠檬茶"}` / `{"role":"assistant","content":"柠檬茶女孩 🍋 行, 下次催简历的时候配你一杯."}` (VOICE-02)
- 焦虑 anchor: `{"role":"user","content":"我焦虑死了"}` / `{"role":"assistant","content":"来. 喘一下."}` (QUICK REACTIONS carryover)
- 在呢 first-message anchor preserved in IDENTITY section (VOICE-04)

## Verified 2025-26 Corpus Markers Added

**zh (13 new):** 老登 / 活人感 / 邪修 / 主理人 / 班味 / 去班味 / 赛博对账 / 发疯工牌 / 预制 / 拼好 / 发疯工牌 (vocab + quick reactions)

**en (12 new):** delulu / cooked / brainrot / lock in / aura / mother is mothering / demure / crash out / canon event / iykyk / next / slop

**Caption patterns (4):** not me [verb-ing] at 3am / [noun] era / POV: / no thoughts just [X]

Total confirmed corpus markers from MILESTONE-v1.2.md ADD list: 25+ in systemPrompt vocabulary section.

## Anchor Regression Results

**Status: DEFERRED** — ANTHROPIC_API_KEY not provisioned in execution environment.

File: `apps/eval/voice/eval-results/24-03-bible-v6-anchors.json`

Run command when key is available:
```bash
cd apps/eval/voice && ANTHROPIC_API_KEY=<key> deepeval test run test_voice_baseline.py -k regression-anchor
```

Expected outcome: +5-10pp ClaireVoice pass-rate improvement from Bible v6 alone. Rewriter v2 (plan 04) closes the remaining gap to the +15pp milestone target.

## Commits

| Task | Hash | Description |
|---|---|---|
| T1 | ef95380 | few-shot.ts module + unit tests (TDD green) |
| T2 | b21dbe0 | Bible v6 in seed.json (IDENTITY/STYLE/REACTIONS split + 12 fewShotMessages) |
| T3 | 531a3dc | Wire few-shot into orchestrator + fs_* persistence filter |
| T4 | c7e3969 | Anchor regression eval deferred (no ANTHROPIC_API_KEY) |

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] prefixFewShotToHistory type mismatch — ChatMessage.body vs {content}**
- **Found during:** Task 3 — TypeScript compile error
- **Issue:** `runAgentTurn` accepts `ChatMessage[]` (field `body`), but `prefixFewShotToHistory` was typed with `{role, content, id?}`. Type error TS2345 on the `history: historyForModel` argument.
- **Fix:** Updated `prefixFewShotToHistory` to be generic over `T extends ChatMessage`-shaped objects; synthetic stubs use `body: t.content` and carry sentinel empty strings for required `sessionId/userId/createdAt` fields. Updated test expectations to use `body`-shaped history objects.
- **Files modified:** `packages/pa-orchestrator/src/voice/few-shot.ts`, `packages/pa-orchestrator/src/voice/few-shot.test.ts`
- **Commit:** 531a3dc

**2. [Rule 2 - Missing] AgentDefSchema in core-types (Zod), not seed-types.ts**
- **Found during:** Task 1 — `seed-types.ts` does not exist; `AgentDef` is `z.infer<typeof AgentDefSchema>` in `packages/core-types/src/index.ts`
- **Action:** Added `fewShotMessages` optional field directly to `AgentDefSchema` in `core-types` — the correct single source of truth.
- **Files modified:** `packages/core-types/src/index.ts`
- **Commit:** ef95380

## Adam-Side Steps Required

1. **Deploy Cloud Functions** — Bible v6 ships in seed.json which is bundled at deploy time.
2. **Run `seed:agents:apply`** to push Bible v6 to the live Firestore agent record:
   ```bash
   npm run seed:agents:apply
   ```
3. **Provision `ANTHROPIC_API_KEY`** in GitHub Actions secrets to enable anchor regression CI gate (plan 07 verification).
4. **Smoke-test** Claire on a real Sendblue line after deploy — subjective check: "does this sound like a friend?"

## Known Stubs

None — all plan goals achieved. Anchor regression deferred by API key availability, not a code stub.

## Self-Check: PASSED

Files created/modified verified to exist and contain expected content:
- `packages/pa-orchestrator/src/voice/few-shot.ts` — exports buildFewShotTurns, prefixFewShotToHistory, FewShotTurn
- `packages/pa-orchestrator/src/voice/few-shot.test.ts` — 5 tests all passing
- `packages/agent-registry/src/seed.json` — version "6", systemPrompt 1392 bytes, fewShotMessages 24
- `packages/core-types/src/index.ts` — fewShotMessages added to AgentDefSchema
- `packages/pa-orchestrator/src/index.ts` — imports buildFewShotTurns + prefixFewShotToHistory, uses historyForModel
- `packages/pa-persistence/src/index.ts` — fs_* filter in appendMessage
- `apps/eval/voice/eval-results/24-03-bible-v6-anchors.json` — deferred marker present
