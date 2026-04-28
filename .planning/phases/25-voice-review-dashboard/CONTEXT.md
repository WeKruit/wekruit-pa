# Phase 25 — Voice Review Dashboard (CONTEXT)

**Owner P9:** P9-Voice (autonomous)
**Depends on:** Phase 24.5 ships (consumes `getFlag('voiceEvalAutoRerun')` toggle)
**Parallel with:** Phase 26 (zero file overlap by design)
**P10 strategy:** `.planning/v1.2-p10-strategic-cut.md`
**ROADMAP entry:** `.planning/ROADMAP.md` lines 385-399

## 底层逻辑 (P10 quote)

> 数据闭环 — 没有人工评分数据, self-evolve 是空中楼阁. Phase 25 是 v1.3 self-evolve 的数据生产者. Phase 27 read-only 消费 `pa_voice_reviews` schema —— 一次定型, 不允许后改.

## Schema (LOCKED — Phase 27 read-only contract; do not alter)

`pa_voice_reviews/{messageId}`:
```
{
  messageId: string,                    // doc id (matches pa_messages doc id)
  rating: 1 | 2 | 3 | 4 | 5,
  tags: ("probe" | "diagnose" | "too_long" | "tone" | "ai_speak" | "ok")[],
  comment: string,                      // free text, optional
  reviewerId: string,                   // dashboard user email
  agentSnapshot: {
    bibleVersion: string,               // e.g. "v7.0"
    modelId: string                     // e.g. "gpt-5.4-nano"
  },
  createdAt: Timestamp
}
```

## Success criteria (P10 locked)

1. New page `apps/dashboard-web/src/pages/Voice.tsx` lists `pa_messages` assistant turns, paginated (50/page), newest first
2. Per-turn UI: 1-5⭐ rating + multi-select chips for tags + comment textarea + Save button
3. `pa_voice_reviews/{messageId}` collection writes follow above schema
4. Keyboard-driven UX (R1 mitigation): `1`-`5` digit keys = rating, `Tab` = focus comment, `Enter` = save+next-turn. Adam target: ≥50 turns reviewed in <30 min single session
5. "Run eval against golden-50" button → triggers `PA_RUN_EVAL=1 deepeval test run` (CF callable OR local script trigger), writes `eval-results/{timestamp}.json`, page renders score + diff vs latest baseline JSON
6. ≥4⭐ turn shown with green badge (fewShot candidate); export tool punted to later phase
7. ≤2⭐ turn tagged for Phase 27 cron — read-only contract, just mark in tag set

## Architectural decisions (P10 locked)

- **No new collections beyond `pa_voice_reviews`**. `pa_messages` already exists.
- **agentSnapshot is denormalized** at write time so Bible-version churn doesn't break historical reviews.
- **Keyboard nav is non-negotiable** — Adam reviewing 50 turns/session by hand is the realistic floor.
- **Eval rerun trigger**: prefer `getFlag('voiceEvalAutoRerun')` to gate auto-rerun on save (default `false`); manual button always works.

## Phase 27 contract surface

Phase 27 cron reads `pa_voice_reviews` where `rating <= 2` from past 24h, clusters by `tags`, generates Bible patch suggestions. Phase 25 must NOT mutate that collection schema after this phase ships. Future fields → additive only (new optional keys), never rename/remove.

## Out-of-scope

- DO NOT build self-evolve cron (Phase 27)
- DO NOT auto-export fewShot YAML (Phase 27 tooling)
- DO NOT change `pa_messages` schema
- DO NOT add new external deps (use existing dashboard react setup)
- DO NOT touch sendblue/voice uncommitted Adam files

## Risks

- R1: Adam evaluation cold-start (50 reviews ≈ 2-3 hr) — mitigated by keyboard UX + persistent draft (review state survives page reload via localStorage)
- R2: golden-50 baseline diff renders bad on big eval JSON — keep diff to top-20 changed turns, full JSON downloadable
