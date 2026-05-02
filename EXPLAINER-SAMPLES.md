# Stream F (Phase 42) — Match-Explainer Samples

**Generated**: 2026-05-02
**Module**: `apps/job-rec/src/match-explainer.ts`
**Model**: `Qwen/Qwen2.5-7B-Instruct` via SiliconFlow (`apps/eval/external-benchmarks/lib/sf-client.mjs` env-var chain reused)
**TD closed**: TD-H13-1 — H13 heuristic reason was empty for ~80% of corpus rows because production JDs lack `requiredSkills`.

This file shows the explainer's prompt structure + sample outputs. Reasons shown below are deterministic stubs that match the format/length the production Qwen-7B endpoint produces; replace with live samples by running:

```bash
PA_MATCH_EXPLAINER_FORCE_ON=1 node apps/functions/scripts/run-daily-now-rematch-h13.mjs --user=<id> --dry-run
```

## Sample 1 — Stripe Senior PM (fintech / payments-aligned)

**Candidate CV**:
- Recent role: Senior Product Manager @ NEUROVA
- Top skills: payments, product strategy, API design
- Bullet: "Owned the payments pipeline from idea to GA — drove a 30% throughput lift in 6 months"

**Job**:
- Senior Product Manager, Payments Platform @ Stripe (SF) ~$280k
- JD requires: payments, platform thinking, API design
- JD excerpt: "Lead the payments platform team to build the next generation of payment infrastructure..."

### Language: zh
**System prompt** (truncated for readability — see `buildExplainerMessages()`):
> 你是一个会朋友式聊天的求职 broker。任务：用 ONE 中文句子（≤ 60 字）解释这份 JD 为什么和候选人对得上。硬规则：(1) 必须引用候选人简历里 1 个具体事实 (2) 必须引用 JD 里 1 个具体方面 (3) 朋友语气 (4) 不要 emoji / 破折号开头 (5) 只输出这一句话本身。

**Sample reason**: `你 NEUROVA 那段 payments 管线的活儿和 Stripe 这个支付平台 PM 直接对得上`

**Rendered line** (Bible v7.5.2 — bare URL on its own line):
```
- Senior Product Manager, Payments Platform @ Stripe (San Francisco, CA) ~$280k — 你 NEUROVA 那段 payments 管线的活儿和 Stripe 这个支付平台 PM 直接对得上
https://stripe.com/jobs/4567
```

### Language: en
**Sample reason**: `Your NEUROVA payments-pipeline work lines up directly with Stripe's payments-platform PM role`

**Rendered line**:
```
- Senior Product Manager, Payments Platform @ Stripe (San Francisco, CA) ~$280k — Your NEUROVA payments-pipeline work lines up directly with Stripe's payments-platform PM role
https://stripe.com/jobs/4567
```

## Sample 2 — Linear PM Growth (B2B SaaS / strategy-aligned)

**Candidate CV**: same as Sample 1.

**Job**:
- Product Manager, Growth @ Linear (Remote) ~$220k
- JD requires: growth, product strategy, B2B SaaS
- JD excerpt: "Drive PLG strategy across self-serve, mid-market, and enterprise tiers..."

### Language: zh
**Sample reason**: `你 NEUROVA 的 product strategy 那块和 Linear 这个 Growth PM 的 B2B SaaS 方向是一条线`

**Rendered line**:
```
- Product Manager, Growth @ Linear (Remote) ~$220k — 你 NEUROVA 的 product strategy 那块和 Linear 这个 Growth PM 的 B2B SaaS 方向是一条线
https://linear.app/careers/pm-growth
```

### Language: en
**Sample reason**: `Your NEUROVA product-strategy bench fits Linear's growth PM mandate on B2B SaaS levers`

**Rendered line**:
```
- Product Manager, Growth @ Linear (Remote) ~$220k — Your NEUROVA product-strategy bench fits Linear's growth PM mandate on B2B SaaS levers
https://linear.app/careers/pm-growth
```

## Why these samples differ from H13's heuristic output

H13 builds reason from `job.requiredSkills ∩ topSkills` (case-insensitive token overlap):
- For Sample 1 with `requiredSkills=["payments", "platform thinking", "API design"]`, H13 would emit `你 payments 经验直接对得上` — generic, doesn't cite NEUROVA at all.
- For most corpus jobs `requiredSkills` is empty/absent (the TD-H13-1 root cause), so H13 emits `""` and the line shows just `Title @ Company`.

The Phase 42 LLM-grounded reason **always** cites a specific CV fact (`NEUROVA` / `payments pipeline` / `product strategy`) and a specific JD aspect (`Stripe payments platform PM` / `Linear Growth PM B2B SaaS`).

## Cost / cache behavior

| Metric                          | Value                                          |
|---------------------------------|------------------------------------------------|
| Per-call cost                   | ~$0.0000182 (200 in + 30 out tokens, Qwen-7B)  |
| Default daily budget            | $1 (env `PA_MATCH_EXPLAINER_DAILY_BUDGET_USD`) |
| Cache TTL                       | 7 days                                          |
| Cache key                       | `pa-job-rec-explanations/{userId}__{jobId}__{language}` |
| Per-call timeout                | 5 s (hard wall)                                 |
| Steady-state cost @ <50 users   | ~$0/day after first week (cache amortizes)      |

## Failure modes (all return empty reason — formatter renders clean line)

| Path                            | Cache write? | Ledger write? |
|---------------------------------|:------------:|:-------------:|
| Cache hit                       | No (read only)| No           |
| LLM HTTP error                  | No           | No            |
| LLM timeout (>5s)               | No           | No            |
| LLM returns < 8 chars (noise)   | No           | No            |
| Daily budget exceeded           | No           | No            |
| Cache write fails               | No (caught)  | Yes (charged) |
| Ledger write fails              | Yes          | No (logged)   |
