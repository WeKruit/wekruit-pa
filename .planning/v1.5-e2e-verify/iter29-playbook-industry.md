# iter29 — playbook 业界最佳实践 + dashboard UI + LLM-judge benchmark

**Adam directives**: push / commit / deploy / playbook 测试 / benchmark / 业界 playbook 办法 / dashboard

## 1. Push + Deploy 已闭环

- `git push origin main` ✅ 363 commits → wekruit-pa repo
- `firebase deploy --only functions:pa-orchestrator` ✅ iter28 已部署
- Dashboard SPA 代码改了 (apps/dashboard-web/), build install 单独 setup, Adam 触发即可

## 2. Dashboard playbook UI — routingHint 字段加上

`apps/dashboard-web/src/lib/playbooks-api.ts`:
- `Playbook` type 增 `routingHint: "no_chain" | "role_chain" | null`
- `fromSnap` 解析 routingHint
- `SavePlaybookInput` + `savePlaybook` 透传

`apps/dashboard-web/src/pages/Playbooks.tsx`:
- 列表新增 `Routing` 列, 用色块标 (no_chain=黄, role_chain=蓝, none=灰)
- 编辑器加 dropdown:
  - none — no special routing
  - no_chain — 情绪 / 资格 (vent / interview / negotiation / motivation)
  - role_chain — 直接求职 (headhunter / jd_roast)

Adam 现在可在 dashboard 直接改任意 playbook 的 routing 语义, 不用 deploy。

## 3. LLM-as-judge benchmark — 3/3 PASS

`gpt-5.4-nano` judge on 3 critical playbook scenarios post-iter28:

| Playbook | User msg | Reply | Verdict | Confidence | Cost |
|---|---|---|---|---|---|
| vent_support | "今天又被 manager 当众挂了 心慌到现在缓不过来" | "卧…当众被挂真的会吓人，听着挺难受的。😮‍💨" | **pass** | 0.93 | $0.0000518 |
| headhunter | "我想换工作 干两年了实在熬不下去 想看看外面有啥机会" | "好咧，我帮你看看外面适合你能落脚的机会；那你大概想找啥方向的活？比如做产品、做工程、还是做研究" | **pass** | 0.86 | $0.0000638 |
| negotiation | "Stripe just gave me an offer — 230 base + 600k RSUs over 4yr + 30k sign-on. My current TC at Meta is around 280. They want a decision by Friday. How do I counter?" | "ok congrats—how many other offers do you have, and what number do you want to land on (base and/or total comp) so you can anchor the counter?" | **pass** | 0.86 | $0.0000550 |

3 criteria each: friend register / NO AB framework / NO numbered list / appropriate
playbook semantics (vent=ack only, headhunter=role chain, negotiation=stake+leverage
not specific $).

Total cost: $0.000170. Scaling to 100 scenarios: ~$0.005. Trivial.

## 4. 业界 playbook 最佳实践 (调研整理)

### 4a. 模式分类

| 模式 | 代表 | 我们用了吗 | 我们的位置 |
|---|---|---|---|
| **Static prompt template** | Anthropic system prompt, OpenAI persona | ✅ 用 | Bible v7.5 in pa-handbooks |
| **Conditional addendum injection** | LangChain RouterChain, Haystack | ✅ 用 | matchCachedPlaybooks → systemInputs |
| **Trigger-based regex matcher** | n8n/Zapier conditions | ✅ 用 | Firestore regexTriggers + 30s cache |
| **State machine / graph-based** | LangGraph, Microsoft Semantic Kernel | ✅ 部分 | onboarding state machine + ESConv FSM (Phase 35-40) |
| **LLM-classifier router** | Anthropic 'Routing' pattern, AWS Bedrock | ❌ 不用 | regex 够用; LLM router 加成本 |
| **Tool-use selection** | OpenAI function calling, MCP | ✅ 用 | Agents SDK toolPolicy |
| **Self-reflection / critic loop** | DSPy, Reflexion | ❌ 不用 (P10 D1 决定) | 加成本不值 |
| **Vector retrieval routing** | RAG with semantic similarity | ⚠️ 部分 | Mem0 + BGE-M3 for memory recall, 不用 routing |
| **Versioning + audit trail** | LangSmith, Helicone | ✅ 用 | pa-audit-events + version field |
| **A/B test variants** | LaunchDarkly, Statsig | ⚠️ 部分 | feature flags (perUser) 但 playbook variants 还没 |

### 4b. 我们的栈 vs 业界 (比对)

**LangChain RouterChain** — LLM 做 multiclass classification 选 sub-prompt。
- ✅ 比 regex 灵活 (能处理 paraphrase)
- ❌ 每 turn 加 1 LLM call (我们目标 0 net new calls per P10 D1)
- ❌ Latency 增加 ~500ms
- 决定: 不切换. regex + Firestore-editable trigger 颗粒度够.

**LangGraph state machine** — node + conditional edge 显式建模.
- ✅ 我们的 onboarding state machine (q_role_asked → q_yoe_asked → ...) 等价
- ✅ ESConv FSM (5 UX states × 8 strategies) 也对应 Phase 35
- ❌ 引入 LangGraph framework 是 100+ KB 依赖, 没必要

**Anthropic 'Routing' workflow pattern** (anthropic.com/research/building-effective-agents):
- LLM router 看 input → 选下游 prompt → 转交给专 prompt 处理
- 我们用 regex 替代 router (deterministic, 0 cost)
- Trade-off: 在边界 case (paraphrase / 隐含意图) 上 LLM router 更鲁棒
- 解决方法: broaden regex (iter28 我们刚做, 16→40 / 17→37 patterns)
- 真要 LLM router: 我们的 Bible directive 已经在 prompt 里做 routing 了 (强制识别 vent / job_search / etc), 算半个 LLM router

**OpenAI 'Multi-step Function Calling'**:
- 模型自己决定调啥工具 + 啥参数
- 我们的 toolPolicy 用 Agents SDK, 但 onboarding routing 用 regex 不用 tools
- 不冲突: tools 是 capability, playbook 是 prompt-shaping

### 4c. 我们栈最对的 3 个决定

1. **Regex + addendum 而不是 LLM router**: 0 net new calls, dashboard 可编辑, 颗粒度够
2. **Firestore + 30s cache**: 改 regex 不用 deploy, 30s 全机生效
3. **Audit trail + version field**: 每次改有 actor + reason, dashboard 看 audit drawer

### 4d. 业界做法但我们没做的 (iter29+ backlog)

1. **A/B variants 系统化**: 同一 playbookKey 多 variant, 按 user bucket 分流
2. **LLM-classifier router 作 fallback**: 当 regex 都不命中时, 1 cheap call (Qwen-7B) 分类到 6 个 playbook 之一. 成本 ~$0.0001/turn, 兜底 paraphrase
3. **Playbook 自动质量监控**: 每天采样 N turns, 跑 LLM-judge, 识别 regress
4. **Vector embedding-based trigger**: 把 trigger 从 regex 升级到 cosine-sim against playbook description embedding (BGE-M3 已 wired). 比 regex 更鲁棒.

## 5. coalesce / merge / randomize 现状 (复述)

- **coalesce**: iter19 上线. event-driven via Sendblue typing webhook. RAPID_THRESHOLD=5s. 多消息进来 ≤5s 内合并成 1 turn.
- **randomize**: probabilistic-split.ts. mulberry32(turnId). p_one=0.65 default. 长回复 (>100 chars + ≥3 sentences) bumps to p_two=0.5. 实测 200 trials × 长回复 = 97/103 split.
- **merge**: outbound 2 bubbles 用 \n\n 拼接 (normalizeForIMessage), 由 decideReplySplit 决定 1 vs 2 bubble.

## 6. 还需要做 (iter29+)

1. interview_prep playbook reply 太薄 ("嗯 我在") — AB strip 切多了, 加 ≤2 sentences 不切规则
2. "卧" → "卧槽" LLM 仍偶尔出 "卧". slang-injector 加硬规则
3. dashboard SPA 重 build (Adam 启动 install + deploy)
4. job_search / visa_check / resume_parse / preference_update 4 个 onboarding intent 还在 TS regex, 没迁到 Firestore playbook (next 抓手)
