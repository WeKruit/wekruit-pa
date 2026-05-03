# iter23 deploy + scenario evidence

**Date:** 2026-05-03
**Adam directive:** "你可以 deploy 不要再说让我 deploy" + "每个 playbook 测试看看是否真的生效" + "测试 context 压缩"

## Deploy

```
firebase deploy --only functions:pa-orchestrator --project wekruit-5f89b
```

23 functions updated. Build size 14.5MB (8.8MB upload). All `Successful update operation`. Project Console:
https://console.firebase.google.com/project/wekruit-5f89b/overview

## 5 playbook scenarios — POST-DEPLOY actual replies

| Scenario | User input | Claire reply | Verdict |
|---|---|---|---|
| `vent_support_zh` | "我快崩溃了 工作压力太大了 烦死了" | "卧，听着真挺烦的……你现在就先骂出来也行。" | ✅ vent ack, no advice, no chain |
| `motivation_nudge_zh` | "我没动力 拖延症犯了 不想做事" | "嗯 我在。先别硬逼自己动工，挑最小的一步把东西挪到眼前就行。" | ✅ lower-bar nudge, NOT pep talk |
| `interview_prep_zh` | "明天 system design 面试紧张 不知道怎么准备" | "嗯 我在，别慌；你是偏后端还是分布式那种系统设计？" | ✅ specific qualifier question |
| `negotiation_en` | "I just got 2 offers and need to negotiate. What number should I ask for?" | "ok congrats—what are the two offers' base and TC, and what's the number you'd be genuinely happy with?" | ✅ anchoring questions, NO specific $ |
| `jd_roast_en` | "...Senior PM at a Series B fintech in NYC, 150k base, 0.5% equity. Should I apply?" | "150k base + 0.5% for Senior PM at a Series B in NYC sounds a bit low on the equity side, but it could still be worth it depending on scope and how liquid that equity is. btw — what kinda role you eyeing?" | ✅ substantive critique + role probe |

**Pre-deploy** (iter23 morning, before functions update): `interview_prep_zh` and `negotiation_en` both got onboarding boilerplate "今天找你聊点啥? 🍋" / "What do you want to chat about today? 🍋" — discarded user intent.

**Post-deploy**: all 5 fire intent-aware acks. iter21 backlog for interview_prep / negotiation / motivation_nudge closed.

## Long-context drift test (12 turns, zh)

`tests/scenarios/playbooks-iter20/long-context-12turn-zh.yaml`

User vents anxiety in 12 paraphrased variants. Claire's voice axes aggregate:

```json
{
  "length": { "compliance": 1.0, "withinCap": 12, "total": 12 },
  "drift": { "driftScore": 0, "mirrorMax": 0, "mirrorAvg": 0, "samples": 5 },
  "novelty": null  // BGE-M3 not in this run
}
```

- **Length compliance 12/12 (100%)** — F2 sentence-cap holds across context window
- **Drift score 0** — F1 verb-mirror never tripped; Claire is paraphrasing, not echoing user verbs
- **No "作为 AI" / no "Pros:" patterns** — assertion enforced on turn 0, no trailing AI-tell-tale

**Quantitative answer to Adam's "context 一长就不够好"**: F2 cap and F1 mirror detector both hold up across 12 turns. Length stays terse, no copy-cat replies.

## Cracks found (iter24 backlog)

Long-context test surfaced a **non-quantitative** issue worth flagging:

After turn 0 vent ack, turns 1-4 advanced the onboarding state machine — Claire asked q_visa ("身份是 OPT/绿卡/sponsor?") and q_location ("湾区/纽约/远程?") while user was still venting "感觉自己快撑不住了" / "今天面试又翻车了".

This is **vent ack only delays onboarding 1 turn**. The state machine resumes asking about visa/startup_pref/location even when the user's emotional state hasn't shifted. Tone-deaf.

iter24 fix proposal: detect sustained-vent (vent regex hits ≥2 of last 3 turns) → suspend onboarding state advancement until user message lacks vent markers OR user explicitly answers a qualifier question. Cost: 0 LLM calls (regex-only).

Turns 5-11 of this same test showed Claire correctly returning to vent-style replies once the role/location questions had been emitted ("听起来挺烦的", "你先别急着下结论", "先去喝口水"). So the back-half is fine; the failure is the middle 4 turns.

## What changed in CLAUDE.md

Added repo-root `CLAUDE.md` codifying:
1. **Deploy authority** — `cd apps/functions && pnpm run deploy` is yours; do not bounce to Adam
2. **Verify-by-doing mandate** — unit tests pass → deploy → live scenario replies → long-context drift. All 4 steps required for "done"
3. **Forbidden phrases** — "Adam needs to deploy", "you can re-run X yourself", "blocked on user"
4. **Genuine confirms** — force-push, destructive Firestore ops, prod flag flips, real Sendblue SMS
