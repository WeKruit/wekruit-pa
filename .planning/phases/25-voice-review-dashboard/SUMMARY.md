# Phase 25 — Voice Review Dashboard (SUMMARY)

**Status:** Shipped 2026-04-28
**Owner:** P9-Voice (autonomous P8 agent)

## Commits (3)

| Task | Hash | Description |
|---|---|---|
| T1 | `1f6e1d8` | pa_voice_reviews schema + persistence helpers |
| T2 | `859bead` | Voice.tsx review dashboard with keyboard UX (sweep-anomaly: filed under T2 of Phase 26 quota commit; files present in main) |
| T3 | `bb58631` | one-click voice eval rerun + diff vs baseline |

## Verification

- `pnpm --filter @pa/pa-persistence test` → 29 pass / 0 fail (incl. 9 voice-reviews schema tests)
- `pnpm --filter @pa/dashboard-web build` exit 0 (vite 1.04s, 871 KB bundle)
- `pnpm --filter @pa/dashboard-web typecheck` exit 0, no new errors
- 0 net touches to `pa-orchestrator/src/voice/**` (out of scope)

## Files delivered

- `packages/pa-persistence/src/voice-reviews.ts` — schema + 3 helpers (write/list/listForReview)
- `packages/pa-persistence/src/voice-reviews.test.ts` — 9 tests
- `apps/dashboard-web/src/pages/Voice.tsx` — page + EvalPanel (~580 lines)
- `apps/dashboard-web/src/lib/voice-reviews-api.ts` — Firestore client wrapper (~290 lines)
- `apps/dashboard-web/src/lib/voice-eval-api.ts` — eval client + diff renderer
- `apps/dashboard-web/src/App.tsx` — `/voice` route + nav link

## Schema (P27 read-only contract — DO NOT CHANGE without P10 approval)

`pa_voice_reviews/{messageId}`:
```
{
  messageId: string,
  rating: 1 | 2 | 3 | 4 | 5,
  tags: ('probe' | 'diagnose' | 'too_long' | 'tone' | 'ai_speak' | 'ok')[],
  comment: string,
  reviewerId: string,
  agentSnapshot: { bibleVersion: string, modelId: string },
  createdAt: Timestamp
}
```

## Adam owner steps (post-merge)

1. **Deploy dashboard**: `pnpm --filter @pa/dashboard-web build && firebase deploy --only hosting`
2. **Open `/voice`** in dashboard-web after deploy → start labeling assistant turns
3. **Eval rerun**: button gated by `voiceEvalAutoRerun` flag (default off); manual button always live; runs DeepEval golden-50 locally and reads `eval-results/{baseline,latest}.json` static fixtures (CF callable skipped per fallback path)

## Notes

- Keyboard UX: j/k navigate / 1-5 rating / t tag picker / c comment / Enter save+next (R1 mitigation — Adam alone can review 50 turns < 30 min)
- localStorage drafts per messageId (rating/tags/comment persist on reload)
- ≥4⭐ green left border (fewShot candidate) / ≤2⭐ orange left border (Phase 27 self-evolve input)
