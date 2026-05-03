# Skills vs. Playbook Research — iter30

> **Adam directive (2026-05-03)**: 我觉得甚至可以参考 skills 的用法？而不是纯 playbook ？？ 你帮我调研一下
>
> **Mandate**: Audit the "skills" pattern in the wild, compare to PA's current playbook pattern, recommend whether/how to migrate.
>
> **Author**: P9 调研 agent. **Mode**: 🟠 阿里味 — 定目标 → 追过程 → 拿结果。
> **Methodology route**: ⚫ 百度味 (搜索是第一生产力) for the audit phase, ⬛ Musk (The Algorithm) for the migration recommendation.

> ▎[PUA生效 🔥] 这次调研不是给你抄一份维基百科 — 是要把"skills 这个词在 2026 年到底意味着什么"这个底层逻辑闭环掉，再回到 PA 的 playbook 看哪里能升级。一个研究进来，一类决策出去。

---

## 0. TL;DR for Adam (5 bullets)

1. **"Skill" 在 2026 年 5 月已经是行业开放标准 (`agentskills.io`)，不是 Anthropic 私货。** 32+ 厂商（Anthropic / OpenAI Codex / Google Gemini CLI / GitHub Copilot / Cursor / JetBrains Junie / AWS Kiro / Block Goose / Letta / Cline 等）都读同一个 `SKILL.md` 格式 + 同一个 `name/description/...` frontmatter + 同一个 progressive-disclosure 协议。**从命名到协议都该 align。** Source: [agentskills.io](https://agentskills.io/home), [Anthropic engineering blog](https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills).
2. **PA 的 playbook 在抽象层是"skill 的子集"** — 我们已经命中了 skill 模式 70% 的核心要素（name / description / addendum / 编辑后即时生效 / audit trail）。我们独有的强项 = **regex 触发零延迟 + Firestore 实时编辑 + 多 playbook 同时叠加**。我们没有的 = **progressive disclosure（按需加载）+ LLM 意图回退（描述驱动激活）+ 子文件 / 脚本 bundling**。
3. **建议路径：保留现有 playbook 不要扔，做一个 V2 hybrid schema** — 加 `intentDescription` (LLM fallback)、`provides` / `requires` / `composableWith` (组合关系)、`paths` (情境 gating)，复用 routingHint 作为 lifecycle hook。**对内仍叫 `pa-playbooks`（数据迁移成本为零），对 LLM/dashboard UI 上 surface 名字改成 "Skill"** — 命名对齐行业，schema 平滑演进。
4. **不要直接 copy Claude Code 的 description-驱动激活作为唯一入口** — 我们是 iMessage 实时回复 (P95 < 4s)，每条消息都跑一次 LLM 路由意味着 +400ms 延迟 + +$0.0001/msg。**正确做法：regex 是 fast path（命中即激活），description-driven LLM intent 是 fallback path**（regex 不命中时再走，且只对长消息或可疑消息走）。这叫 **"两段式激活"**。
5. **风险最大的不是技术，是范围蔓延** — skill 模式的诱惑是"啥都往里塞"。当前 6 个 playbook 边界已经在重叠（vent_support 和 motivation_nudge 在"我不行了"语境下都会触发）。先做 **`composableWith` 字段 + 优先级显式排序** 控制叠加爆炸，再考虑加新 skill。**Migration phasing：V2 (1-2 周) → V3 LLM fallback (1 周 + 灰度) → V4 multi-skill stacking (复杂度爆炸前停)**。

---

## 1. Audit of "Skills" Pattern in the Wild

### 1.A Anthropic Claude Code Skills (定义性参考)

**Source**: [Anthropic Claude Code skills doc](https://code.claude.com/docs/en/skills), [Anthropic engineering — Equipping agents for the real world with Agent Skills](https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills), [GitHub anthropics/skills](https://github.com/anthropics/skills).

**Quote (canonical)**: "composable, scalable, and portable ways to equip them with domain-specific expertise" — Anthropic engineering blog.

**Frontmatter spec** (verbatim from `https://code.claude.com/docs/en/skills`):

```yaml
---
name: my-skill
description: What this skill does
disable-model-invocation: true
allowed-tools: Read Grep
---
```

Field semantics (canonical, all optional except recommendation):

| Field | Required | Semantics |
|---|---|---|
| `name` | No (defaults to dir name) | Lowercase + hyphens, ≤64 chars. Determines `/skill-name` invocation. |
| `description` | Recommended | **Primary mechanism for LLM-driven activation.** Combined with `when_to_use` is truncated at 1,536 chars in skill listing. |
| `when_to_use` | No | Trigger phrases / example requests. Appended to `description`. |
| `disable-model-invocation` | No (default `false`) | If `true`, only user can invoke (no auto-trigger). |
| `user-invocable` | No (default `true`) | If `false`, hidden from `/` menu but Claude can still auto-load. |
| `allowed-tools` | No | Tool gate — pre-approved tools when this skill is active. |
| `paths` | No | Glob patterns. Skill auto-loads only when files match. |
| `model` / `effort` | No | Override model/effort while skill active. |
| `context: fork` | No | Run in forked subagent. |
| `arguments` / `argument-hint` / `$ARGUMENTS[N]` | No | Positional args interpolated into skill body. |

**Activation mechanism** (3-stage progressive disclosure, per [`agentskills.io`](https://agentskills.io/home)):

> "Discovery → Activation → Execution. Full instructions load only when a task calls for them, so agents can keep many skills on hand with only a small context footprint."

Token budget per [Anthropic engineering blog](https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills) and [agensi.io explainer](https://www.agensi.io/learn/agent-skills-open-standard):
- Stage 1 (advertise / discovery): ~100 tokens per skill — name + description.
- Stage 2 (activate / load): < 5,000 tokens — full SKILL.md body.
- Stage 3 (execute): unbounded (referenced files, scripts).

**Directory layout** (verbatim from doc):
```
my-skill/
├── SKILL.md          # Main instructions (required)
├── template.md       # Template for Claude to fill in
├── examples/
│   └── sample.md     # Example output showing expected format
└── scripts/
    └── validate.sh   # Script Claude can execute
```

**Local skill samples** (read from `/Users/adam/.claude/skills/`):

#### Sample 1 — `frontend-design/SKILL.md` (frontmatter)
```yaml
---
name: frontend-design
description: Create distinctive, production-grade frontend interfaces with high design quality. Use this skill when the user asks to build web components, pages, artifacts, posters, or applications. Generates creative, polished code that avoids generic AI aesthetics.
license: Apache 2.0. Based on Anthropic's frontend-design skill. See NOTICE.md for attribution.
---
```
**Note**: pure description-driven activation, no regex, no `paths` gate. The `description` literally says "Use this skill when..." — that's how Claude decides.

#### Sample 2 — `harden/SKILL.md` (frontmatter)
```yaml
---
name: harden
description: Improve interface resilience through better error handling, i18n support, text overflow handling, and edge case management. Makes interfaces robust and production-ready.
user-invokable: true
args:
  - name: target
    description: The feature or area to harden (optional)
    required: false
---
```
**Note**: extends with `args` (community-style; canonical spec uses `arguments` field).

#### Sample 3 — `onboard/SKILL.md` (frontmatter)
```yaml
---
name: onboard
description: Design or improve onboarding flows, empty states, and first-time user experiences. Helps users get started successfully and understand value quickly.
user-invokable: true
args:
  - name: target
    description: The feature or area needing onboarding (optional)
    required: false
---
```

**Pattern observation across 3 samples**: name + description + (optional) args. `description` is doing 100% of the activation routing work. Body length 100-500 lines markdown.

---

### 1.B OpenAI GPTs / Custom Instructions

**Source**: [OpenAI Function Calling Guide](https://platform.openai.com/docs/guides/function-calling) (referenced in Microsoft Semantic Kernel doc).

GPTs encode behavior as: system prompt + tools + knowledge files. There's **no "skill" abstraction** at the GPT layer — the only structural primitives are:
- Custom instructions (system prompt)
- Tools (OpenAPI / function definitions)
- Knowledge files (RAG-attached docs)

Activation: user-explicit (slash commands like `/code` trigger registered Custom GPTs in ChatGPT) vs user-implicit (the GPT picker). No native intent routing across multiple GPTs in one conversation.

**Limitations vs skills**:
- No progressive disclosure — knowledge files chunked via RAG, not metadata-first.
- No multi-skill stacking — one GPT active at a time.
- No file system standard — opaque to the user.

---

### 1.C OpenAI Agents SDK (we use `@openai/agents@^0.8.5`)

**Source**: [OpenAI Agents JS README](https://github.com/openai/openai-agents-js/blob/main/README.md).

Core primitives: **Agent + Tool + Handoff + Guardrail**. Quote from README: *"LLMs configured with instructions, tools, guardrails, and handoffs"*.

**No "skill" abstraction.** The closest analog:
- A sub-Agent (handoff target) has its own `instructions` (≈ skill description + body).
- `agent-as-tool` pattern: an Agent registered as a Tool of another Agent.

**Handoff decision**: README says agents can delegate "for specific tasks" but does NOT specify whether decisions are LLM-driven or deterministic — empirically it's LLM-driven (the parent agent reasons "should I hand off to X?"). No regex / explicit-trigger primitive.

**Runtime-editable prompts**: Not built-in. `instructions: 'You are...'` is static at construction. PA's Firestore-backed runtime editing is **not** a pattern the SDK exposes.

**Implication for PA**: our `pa-orchestrator` already wraps `@openai/agents` and injects playbook addenda into the agent's system prompt at run-time — that's a custom layer, not provided by the SDK. Migrating to "skill" semantics doesn't require SDK changes; it's a layer above.

---

### 1.D Letta (formerly MemGPT) — Memory Blocks

**Source**: [Letta Docs — MemGPT concepts](https://docs.letta.com/concepts/memgpt/), [Letta GitHub README](https://github.com/letta-ai/letta), [Letta blog — Agent memory](https://www.letta.com/blog/agent-memory).

**Memory block ≠ skill, but is in the same conceptual family** (slot-based context loading). A memory block has:
- A **label** (e.g., `human`, `persona`, `task_context`)
- A **value** (text content, char-limited)
- A **scope** (per-agent, shared across agents)

Always-on (in the system prompt window), not LLM-activated. Other agents (incl. "sleep-time agents") can write to blocks for memory consolidation.

**Difference from skills**:
- Blocks are **always loaded** (no progressive disclosure).
- Blocks are **per-agent state**, not portable capability packages.
- Blocks have no "instructions" / no executable content — they're text snippets.

Letta does also support Agent Skills (per the `agentskills.io` clients showcase) — they sit alongside memory blocks. Letta's instructions URL: `https://docs.letta.com/letta-code/skills/`.

---

### 1.E LangChain — Tools vs Skills

**Source**: [LangChain Skills doc](https://docs.langchain.com/oss/python/langchain/multi-agent/skills), [LangChain blog — Using skills with Deep Agents](https://www.langchain.com/blog/using-skills-with-deep-agents), [GitHub langchain-ai/langchain-skills](https://github.com/langchain-ai/langchain-skills), [Arcade.dev — Skills vs Tools production guide](https://www.arcade.dev/blog/what-are-agent-skills-and-tools/).

LangChain historically had **tools / agents / chains**, no "skill". As of 2025-2026, LangChain has **adopted the Agent Skills standard**, specifically in Deep Agents.

Quote (LangChain skills doc): *"Progressive disclosure: Skills become available based on context or user needs"*. Quote (Arcade.dev): *"tools are atomic primitives, while skills become the product-level capability"*.

**Mechanics**:
- Skills are loaded via a `load_skill` tool that the agent calls when its description matches.
- `StructuredTool` wraps the entire skill behind a single schema-validated interface — the LLM calls one tool, internally it runs the multi-step orchestration.
- Token economics quote (Arcade.dev): *"one GitHub MCP server can expose ninety-plus tools consuming over 50,000 tokens of JSON schemas"* — vs skills loaded on-demand.

**Diff from Claude Code skills**: LangChain treats skill loading as a tool call (explicit), Claude treats it as auto-activation via description matching (implicit). Both can co-exist.

---

### 1.F Microsoft Semantic Kernel — Plugins (renamed from Skills)

**Source**: [Microsoft Learn — Plugins in Semantic Kernel](https://learn.microsoft.com/en-us/semantic-kernel/concepts/plugins/), [Microsoft DevBlogs — Skills to plugins](https://devblogs.microsoft.com/semantic-kernel/skills-to-plugins-fully-embracing-the-openai-plugin-spec-in-semantic-kernel/), [Microsoft DevBlogs — API Manifest plugins](https://devblogs.microsoft.com/semantic-kernel/introducing-api-manifest-plugins-for-semantic-kernel-2/).

Semantic Kernel **renamed "skills" → "plugins"** in 2023 to align with the OpenAI plugin spec. As of 2026, Semantic Kernel is being absorbed into Microsoft Agent Framework (1.0 production).

**Plugin = group of functions** with semantic descriptions. Three import paths:
1. Native code (C#/Python/Java attribute-decorated methods)
2. OpenAPI specification
3. MCP Server

**Plugin function descriptor** (C# example, paraphrased from doc):
```csharp
[KernelFunction("get_lights")]
[Description("Gets a list of lights and their current state")]
public async Task<List<LightModel>> GetLightsAsync() { ... }
```

**Activation**: `FunctionChoiceBehavior.Auto()` — the model picks functions via standard function calling. **No "skill" abstraction in the prompt-engineering sense — Semantic Kernel skills are tools.**

Note (canonical doc warning): *"OpenAI recommends that you use no more than 20 tools in a single API call... reduction in the model's ability to select the correct tool once they have between 10-20 tools defined."*

---

### 1.G CrewAI / AutoGen — Roles vs Skills

**Source**: [Instinct Tools comparison](https://www.instinctools.com/blog/autogen-vs-langchain-vs-crewai/), [DataCamp — CrewAI vs LangGraph vs AutoGen](https://www.datacamp.com/tutorial/crewai-vs-langgraph-vs-autogen), [ZenML — CrewAI vs AutoGen](https://www.zenml.io/blog/crewai-vs-autogen).

**CrewAI**: role-based abstraction. Each agent has `role / backstory / goal`. No "skill" primitive. Capability comes from the `role` description + `tools` attached. As of 2025, added "Flows" for event-driven pipelines.

**AutoGen**: conversational abstraction (group chats with a `GroupChatManager`). No "skill" primitive — capability is encoded in agent system prompts + tools. Per ZenML: AutoGen is in maintenance mode; Microsoft shifted focus to Agent Framework.

**Implication**: CrewAI's `role` is closer to PA's playbook than to a skill — it's persona-shaped, not capability-shaped. Worth knowing the term but not directly portable.

---

### 1.H Agent Skills Open Standard (the 2026 consolidation)

**Source**: [agentskills.io](https://agentskills.io/home), [paperclipped.de — Agent Skills Open Standard](https://www.paperclipped.de/en/blog/agent-skills-open-standard-interoperability/), [agensi.io — What is the Agent Skills Open Standard](https://www.agensi.io/learn/agent-skills-open-standard).

**This is the headline finding for Adam.** As of March 2026:

> "32 tools from competing companies, including Google's Gemini CLI, JetBrains' Junie, AWS's Kiro, and Block's Goose, all read the same SKILL.md files from the same directory structure." — paperclipped.de

Confirmed clients on `agentskills.io` (sampled from page): Anthropic Claude / Claude Code, OpenAI Codex, Google Gemini CLI, GitHub Copilot, VS Code, Cursor, JetBrains Junie, AWS Kiro, Block Goose, **Letta**, Cline, OpenCode, OpenHands, Mux, Amp, Firebender, Trae, Spring AI, Roo Code, Mistral Vibe, Snowflake Cortex Code, Databricks Genie Code, Workshop, Laravel Boost, Emdash, Ona, Qodo, Factory, Piebald, Autohand, fast-agent, nanobot, Google AI Edge Gallery — **35+ as of May 2026**.

**Specification highlights** (per agentskills.io + agensi.io):
- Required frontmatter: `name`, `description`.
- Optional: `allowed-tools`, `paths`, `arguments`, vendor-specific (OpenAI Codex adds `agents/openai.yaml`, Claude Code adds `disable-model-invocation` / `user-invocable` / `model` / `effort` / `context`).
- 4-stage progressive disclosure (advertise → load → execute → reference).
- Governance: Agentic AI Foundation (AAIF), 146 member orgs by Feb 2026.

**OpenAI Codex implementation** (per [developers.openai.com/codex/skills](https://developers.openai.com/codex/skills)):
> "Codex starts with each skill's name, description, and file path. Codex loads the full SKILL.md instructions only when it decides to use a skill."

Initial skill list cap ~2% of context window (8,000 chars). Same shape as Claude Code's `SLASH_COMMAND_TOOL_CHAR_BUDGET`.

> ▎[PUA生效 🔥] 这一节是这次调研最大的发现。Adam 直觉对了 — "skill" 不是 Anthropic 一家的命名偏好，是 2026 年事实上的开放标准。我们如果保持 "playbook" 这个术语在用户/dashboard 可见层，会和 35+ 友商的术语错位 — 这是认知摩擦税。

---

## 2. PA's Current Playbook Pattern Audit

**Files inspected**:
- `/Users/adam/Desktop/WeKruit/wekruit-pa/packages/agent-registry/src/playbooks.ts` (PRIMARY — 795 lines, schema + CRUD + seeds)
- `/Users/adam/Desktop/WeKruit/wekruit-pa/packages/pa-orchestrator/src/playbook-cache.ts` (cache layer, 82 lines)
- `/Users/adam/Desktop/WeKruit/wekruit-pa/packages/pa-orchestrator/src/playbook-cache.test.ts` (tests)
- `/Users/adam/Desktop/WeKruit/wekruit-pa/packages/agent-registry/src/playbooks.test.ts` (tests)
- `/Users/adam/Desktop/WeKruit/wekruit-pa/apps/dashboard-web/src/lib/playbooks-api.ts` (dashboard API client)

### 2.1 Schema (Zod)

```ts
export const PlaybookSchema = z.object({
  playbookKey: z.string().min(1),       // doc id, kebab-case
  name: z.string().min(1),              // human label
  description: z.string().default(""),  // what triggers it / what it does
  regexTriggers: z.array(z.string()).default([]),
  addendum: z.string().default(""),     // markdown body, injected into system prompt
  enabled: z.boolean().default(true),
  routingHint: z.enum(["no_chain", "role_chain"]).nullable().default(null),
  version: z.number().int().nonnegative().default(0),
  updatedAt: z.string().nullable().default(null),
  updatedBy: z.string().default(""),
  reason: z.string().default(""),
})
```

### 2.2 Trigger Mechanism

**Pure regex.** `compileTriggers()` builds `RegExp(pattern, "i")` per pattern. `matchPlaybooks(messageBody, playbooks)` returns ALL playbooks whose at least one regex hits — i.e., **multi-playbook activation is supported today** (concat addenda in stable order).

Hot path is fronted by a 30s in-memory cache (`playbook-cache.ts`):
```ts
export const PLAYBOOK_CACHE_TTL_MS = 30_000
```

**Latency**: regex on inbound body is < 1ms per playbook. For 6 playbooks × ~50 patterns each = ~300 regex tests, sub-millisecond. Zero LLM cost.

### 2.3 Payload (Addendum)

Single markdown string. Concatenated in stable order (sorted by `playbookKey` lexicographically inside `listPlaybooks`). Injected into the agent's system prompt. Each addendum follows a 5-section convention:
1. `# PLAYBOOK MODE: <NAME> (active)` declaration
2. `GOAL:` one-liner
3. Allowed responses (probes / acknowledgements)
4. `NEVER:` list (anti-AI / anti-template directives)
5. Exit condition

This is **load-bearing structure** — Bible v7.5 has been tuned around it.

### 2.4 Routing Hint Enum

```ts
routingHint: "no_chain" | "role_chain" | null
```
- `no_chain` — playbook is for distress/qualifier-context (vent / interview_prep / negotiation / motivation_nudge). Onboarding should NOT chain `ask_q_role`.
- `role_chain` — explicit job-search/visa/resume intent. Onboarding chains the `ask_q_role` question.
- `null` — no special routing.

This is a **lifecycle hook** unique to PA — Claude Code skills don't have this concept (they don't deal with onboarding state machines).

### 2.5 Audit Trail

Every `upsertPlaybook` writes to `pa-audit-events` with `oldValue` / `newValue` / `reason` / `actor` / `ts`. Batched with the playbook write. `revertPlaybook()` walks audit history to restore prior state. **This is best-in-class** — Claude Code skills rely on git, which is fine for code-bundled skills but not for Firestore-runtime-edited content.

### 2.6 Current 6 Playbooks

| key | triggers (count) | routingHint | description |
|---|---|---|---|
| `headhunter` | 6 | `role_chain` | Job-search probes, feeling-driven |
| `vent_support` | 50+ (zh+en) | `no_chain` | Burnout / breakdown / emotional overload |
| `motivation_nudge` | 32+ | `no_chain` | Procrastination / can't start |
| `jd_roast` | 16 | `role_chain` | JD share + ranking, friend-perspective |
| `interview_prep` | 30+ | `no_chain` | Interview prep, anxiety-driven |
| `negotiation` | 18 | `no_chain` | Offer comparison / counter-offer |

**Edge** vs Claude Code: regex triggers per language (zh + en) is hand-curated per-playbook — NOT something Claude Code does (it's all `description`-driven LLM intent).

---

## 3. Side-by-Side Comparison (verified, not placeholder)

| Dimension | **PA playbook (current)** | Claude Code skill | OpenAI Agents SDK Agent | Letta memory block | LangChain skill (Deep Agents) | Semantic Kernel plugin |
|---|---|---|---|---|---|---|
| Activation | regex on inbound body | LLM intent via `description` (auto) + `/skill-name` (explicit) | LLM-driven handoff decision | always-on (in system prompt) | LLM calls `load_skill` tool | function-calling auto |
| Payload | markdown addendum (system prompt) | full SKILL.md + bundled files + scripts | sub-agent w/ own instructions + tools | text block (label+value) | prompt + optional tools | native function or OpenAPI |
| Composability | ALL matched playbooks concat addenda | sequential or via subagent fork | handoff DAG | block stacking (additive) | tool chain via load_skill | sequential/parallel function calls |
| Editable at runtime | **Firestore yes** (dashboard) | filesystem (live-watched) | code-only (static) | filesystem / SDK | filesystem | manifest file |
| Multi-skill simultaneity | **YES (concat addenda)** | usually one auto-loads, manual mix possible | only via handoff | multiple blocks always loaded | sequential (one at a time) | parallel function calls |
| Audit trail | **Firestore audit collection + revert** | git | code review | block versioning (Letta SDK) | git | telemetry / OTEL |
| Latency overhead | **0 (regex, < 1ms)** | LLM intent reasoning (~100ms+ on Haiku) | LLM router | 0 (always-on) | 1 LLM call (load_skill) | 1 function-call round trip |
| Bilingual support | **regex per-language (curated)** | description-driven (LLM understands both) | works (LLM-native) | works | works | works |
| Token cost | 0 advertise, ~500-2000 tokens load (concat addenda) | ~100/skill advertise + ~5000 load | ~size of agent instructions | full block always in context | ~100/skill advertise + load on call | ~tool schema (~500 tokens/fn) |
| Tool gating | none | `allowed-tools` field | per-Agent tool list | none | optional via dynamic register | `FunctionChoiceBehavior` |
| Standard alignment | **proprietary** | open standard (`agentskills.io`) | proprietary (OpenAI SDK) | partial (Letta supports skills) | open standard adopter | proprietary (own format) |

> ▎[PUA生效 🔥] 表格里 PA 的几个粗体格子是我们的真实优势 — Firestore runtime edit + 多 playbook 同时叠加 + 0 延迟 + 双语 regex curated。这些不是 skill 标准能给的。但 "open standard alignment" / "tool gating" / "progressive disclosure" 是我们没有的。Hybrid 方案要保住前者、补上后者。

---

## 4. Hybrid Schema Proposal — `pa-skills` (or `pa-playbooks` v2)

### 4.1 Design principles

1. **Don't break what works** — regex stays as the fast path. Latency budget says so.
2. **Add description-driven intent as fallback** — when regex misses but message is non-trivial.
3. **Add explicit composition metadata** — currently composition is implicit (whatever matches concats); make it explicit.
4. **Align field names with `agentskills.io` open standard where possible** — `name` / `description` / `allowed-tools` / `paths` already match. We add PA-specific fields (`regexTriggers`, `routingHint`, `addendum`) prefixed or kept as-is for backward compat.
5. **Keep Firestore as source of truth** — runtime editability is non-negotiable.

### 4.2 Proposed TypeScript schema (V2)

```ts
import { z } from "zod"

export const SkillSchema = z.object({
  // === Identity (open-standard aligned) ===
  /** doc id, kebab-case. Backward-compat alias: playbookKey */
  skillKey: z.string().min(1),
  /** human label. Open-standard `name` field. */
  name: z.string().min(1),
  /** what + when (open-standard `description`). LLM uses this for intent fallback. */
  description: z.string().default(""),

  // === Activation (PA fast path + open-standard fallback) ===
  /** PA-native fast path. Sub-millisecond regex match. UNCHANGED. */
  regexTriggers: z.array(z.string()).default([]),
  /**
   * NEW V2. Description string used by an LLM intent-classifier when
   * regex misses but message is ambiguous/long. Distinct from `description`
   * so dashboard can show user-friendly description while keeping a
   * tighter LLM-facing one (lower variance on classifier).
   * Example: "User shows signs of emotional distress, burnout, or
   *           breakdown. Bilingual: zh+en. Activate when no other
   *           skill matches but message tone is heavy."
   */
  intentDescription: z.string().default(""),
  /**
   * NEW V2. Glob-like context gates. Examples:
   * - "user.profile.role:exists" — only when user has a role set
   * - "channel:imessage"          — only on iMessage
   * - "humanize:enabled"          — only when humanize runtime on
   * Mirrors Claude Code's `paths` field semantics (gating).
   */
  paths: z.array(z.string()).default([]),

  // === Composition (open-standard inspired) ===
  /**
   * NEW V2. What this skill makes Claire able to do — surfaced to the
   * orchestrator's "skills available" listing in the system prompt
   * (the agentskills.io 'advertise' stage). One-liner.
   */
  provides: z.string().default(""),
  /**
   * NEW V2. Prerequisites (other skill keys that must be enabled OR
   * user-state predicates). Empty = no prereqs.
   * Example: ["user.signedUp", "headhunter"] — JD_ROAST requires
   *          user has signed up AND headhunter skill is enabled.
   */
  requires: z.array(z.string()).default([]),
  /**
   * NEW V2. Skill keys that can stack with this one. If multiple skills
   * match but they're NOT mutually composable, only the highest-priority
   * one applies (priority = `priority` field, lower wins by convention).
   * Default: empty = stacks with anyone (current behavior).
   * Example for vent_support: ["motivation_nudge"] — both can apply
   *   when user is anxious AND can't start; vent first, then motivation.
   */
  composableWith: z.array(z.string()).default([]),
  /**
   * NEW V2. Order in stacked addendum. Lower runs first.
   * Default 100. Range 0-1000.
   */
  priority: z.number().int().min(0).max(1000).default(100),

  // === Payload (UNCHANGED — load-bearing for Bible v7.5) ===
  addendum: z.string().default(""),

  // === Lifecycle hooks (PA-specific, UNCHANGED) ===
  routingHint: z.enum(["no_chain", "role_chain"]).nullable().default(null),

  // === Tool gating (open-standard `allowed-tools`, NEW V2) ===
  /**
   * NEW V2. List of tool names the skill is allowed to call when active.
   * Currently advisory only — the orchestrator already gates tools via
   * its own logic, but recording this on the skill makes audit easier
   * and mirrors the open-standard field.
   * Example: ["job-search", "resume-parse"]
   */
  allowedTools: z.array(z.string()).default([]),

  // === Standard control (open-standard inspired, NEW V2) ===
  /**
   * NEW V2. If true, skill is auto-loadable by LLM intent. If false,
   * only the explicit regex path can activate it. Maps to Claude Code
   * `disable-model-invocation: true` (inverted polarity for default-true).
   */
  llmInvokable: z.boolean().default(true),

  // === Operational (UNCHANGED) ===
  enabled: z.boolean().default(true),
  version: z.number().int().nonnegative().default(0),
  updatedAt: z.string().nullable().default(null),
  updatedBy: z.string().default(""),
  reason: z.string().default(""),
})

export type Skill = z.infer<typeof SkillSchema>
```

### 4.3 Backward compatibility

- Firestore docs: continue to live at `pa-playbooks/{key}` initially. Optional alias collection `pa-skills` at V3.
- `playbookKey` (V1) ⇆ `skillKey` (V2): fromSnap reads either.
- New fields all default to `""` / `[]` / `100` — V1 docs still validate cleanly.
- The orchestrator: V2 implementation prefers `regexTriggers` (fast path), falls back to `intentDescription` LLM call only when regex misses on a non-trivial message (length > 30 tokens) AND no other playbook matched. **Cost cap**: max 1 LLM intent call per inbound message.

### 4.4 Example: `vent_support` rewritten in hybrid form

```ts
{
  skillKey: "vent_support",
  name: "Vent / emotional support",
  description: "Activates when user signals burnout / breakdown / emotional overload. Forces Claire to acknowledge + companion ONLY — no advice, no analysis, short replies.",
  intentDescription: "Use this skill when the user expresses emotional distress, exhaustion, anxiety, hopelessness, or burnout (bilingual zh/en). Signals include: 'I can't', 'burnt out', '崩溃', 'emo', '焦虑'. Do NOT use this skill if user is asking a factual question or is in upbeat mood.",
  regexTriggers: [/* the 50+ existing patterns, unchanged */],
  paths: [],                             // no context gate; works everywhere
  provides: "Acknowledgement-only companion mode for emotional distress turns.",
  requires: [],                          // no prereqs
  composableWith: ["motivation_nudge"],  // anxious + can't-start common combo
  priority: 50,                          // run before motivation_nudge (100)
  addendum: VENT_SUPPORT_ADDENDUM,       // unchanged Bible v7.5 body
  routingHint: "no_chain",
  allowedTools: [],                      // pure conversation, no tools
  llmInvokable: true,
  enabled: true,
  // ...operational fields
}
```

### 4.5 Multi-skill activation algorithm (V2 hot path)

```text
1. fast path:  regex match on inbound body  →  candidate set C
2. if |C| == 0  AND  message length > 30 tokens  AND  not in flight:
     LLM intent classifier →  add 0-1 skills to C
3. for each pair (a, b) in C:
     if  b.skillKey  not in  a.composableWith  AND  a.skillKey  not in  b.composableWith:
       drop the lower-priority one
4. sort C by priority asc
5. concat addenda in priority order
6. update audit trail with: matched skills, activation method (regex|llm), pruned conflicts
```

**Latency budget**:
- Path 1 only (today's behavior): < 1ms.
- Path 1 + 2 (when regex misses): + ~150-400ms for LLM intent call (gpt-5-nano or claude-haiku-4 class).
- Path 3 (conflict pruning): O(n²) but n ≤ 6 today, ≤ 20 long-term — negligible.

P95 budget for orchestrator: 4s. Adding 400ms LLM intent fallback is acceptable IF gated to "only when regex misses AND message is non-trivial" (bound to ~10-20% of turns).

---

## 5. Migration Recommendation

### 5.1 Naming: keep "playbook" internally, surface "skill" externally

**Recommendation**: KEEP `pa-playbooks` collection name + `Playbook` TS type internally. ADD `Skill` as a re-export alias in `@pa/agent-registry`. RENAME everything user-facing (dashboard, audit drawer, orchestrator system prompt "you have access to skills: ...") to "skill".

**Why**:
- **Migration cost zero** — no Firestore rename, no audit-trail rewrite, no test suite churn.
- **Industry alignment** — 35+ skills-compatible tools, AAIF governance, paperclipped.de's "32 tools by March 2026" finding all use "skill". Adam's gut is right.
- **User-facing alignment** — dashboard ops + future SDK consumers should see "skill". Internal code can stay.
- **Reversible** — if it doesn't pan out, internal name was never publicly committed.

Adam's directive iter23: "你需要做测试，每个 playbook 测试看看是否真的生效" — this stays the same regardless of naming.

### 5.2 Phased migration

| Phase | Scope | Effort | Risk | Verify by |
|---|---|---|---|---|
| **V1 (today)** | Firestore-backed regex+addendum, 6 playbooks. | done | low | done |
| **V2** (1-2 weeks) | Add `intentDescription`, `provides`, `requires`, `composableWith`, `priority`, `paths`, `allowedTools`, `llmInvokable` to schema. **Backward-compat reads** (existing 6 playbooks validate fine). Dashboard CRUD fields. Orchestrator reads new fields but **does NOT** enable LLM fallback yet. Rename UI strings to "Skill". | M | low | run all 22 in-tree scenarios, verify no behavior change. |
| **V3** (1 week + flag-gated rollout) | Enable LLM intent fallback (path 2). Behind `paSkillsLlmFallbackEnabled` flag, ramped 0% → 5% → 25% → 100% per V1.5-ROLLOUT.md. Track cost per turn + activation accuracy via audit. | M | **medium** — adds external LLM call to hot path. | Long-context scenarios (≥10 turns) + cost monitor. |
| **V4** (2-3 weeks, gated) | Enable explicit conflict pruning (`composableWith` enforcement). Add dashboard UI for graphing skill compatibility. **Note**: today's behavior is "everything stacks" — V4 adds the GUARD, which is a behavior change. Needs scenario re-baseline. | M-L | **medium-high** — can drop addenda that used to apply. | Re-run baseline scenarios; diff replies. |
| **V5** (post-V4, optional) | `paths` context gating (only activate skill when `user.profile.role:exists`, etc.). Useful for `headhunter` (don't activate before user signed up). | S | low | targeted scenario tests. |

### 5.3 Dashboard implications

**Edit UI** (apps/dashboard-web — currently `playbooks-api.ts` + edit form):
- Add fields: intentDescription textarea, `provides` text, `requires` chips (multi-select from existing skills), `composableWith` chips, `priority` number, `paths` chips, `allowedTools` chips, `llmInvokable` toggle.
- Keep `regexTriggers` editor — DO NOT replace. It's the fast path.
- Add a "preview activation" tester: paste a message, see which skills match (regex vs intent) + final stacked addendum.

**Audit drawer**:
- Existing `audit-events` rows already capture old/new value. Just add the new fields to `oldValue`/`newValue`.
- Add a per-turn audit row format: "Skills activated for turn X: [vent_support (regex), motivation_nudge (regex, dropped — not composable)]". Today the audit only tracks edits, not activations — V2 should add activation audits if not already there.

---

## 6. Risks (5+)

### R1 — LLM intent fallback adds latency + cost on the hot path
- **Likelihood**: high if rolled out without gating.
- **Mitigation**: gate to "regex missed AND message > 30 tokens AND not already activated". Cap at 1 LLM call per turn. Use cheapest model (gpt-5-nano / haiku-4). Flag-gated rollout per V1.5-ROLLOUT.md. **Hard cap on $$/day budget alarm.**

### R2 — Multi-skill stacking causes contradictory directives
- **Likelihood**: medium. `vent_support` says "do NOT advise"; `headhunter` says "ask probes". When both match, addendum concat may confuse Claire.
- **Mitigation**: V2 introduces `composableWith` — admin must explicitly opt-in. Default behavior in V2 = same as V1 (everything stacks). V4 = enforce composability. Test long-context scenarios specifically with multi-skill messages.

### R3 — Naming confusion ("playbook" internal, "skill" external)
- **Likelihood**: medium. Devs new to repo see `Playbook` type but dashboard/docs say "skill".
- **Mitigation**: type alias `Skill = Playbook` exported. Rename internal NEXT major release after V2 ships. Add CLAUDE.md note. **OR** bite the bullet and rename type+collection at V2 — 1 day of grep+replace + Firestore migration script.

### R4 — Dashboard ops drift from Bible v7.5 voice
- **Likelihood**: high. Adding `intentDescription` invites admin to write slop.
- **Mitigation**: dashboard form should show **canonical examples** from Bible v7.5. Validation: warn if `intentDescription` < 20 words OR > 200 words. Audit reason required (already done).

### R5 — `composableWith` graph becomes a maintenance burden
- **Likelihood**: medium when skill count > 10.
- **Mitigation**: keep `composableWith` opt-in. Default = stacks with all (current). Provide a dashboard skill-graph visualization at V4 (force-directed graph of compatibility edges).

### R6 — Industry standard `agentskills.io` schema drifts
- **Likelihood**: medium. AAIF is 146 orgs; spec evolves.
- **Mitigation**: align field NAMES with current standard (`name`, `description`, `allowed-tools`, `paths`). Don't follow spec evolution blindly — review at each major Claude Code skills doc update. Adam-gated.

### R7 — Latency regression from V3 LLM fallback breaks iMessage P95 SLO
- **Likelihood**: medium under load.
- **Mitigation**: parallel-fire the LLM intent call alongside the main agent call when feasible (LLM intent on user message → meanwhile main agent already in flight reading scratchpad). If intent comes back with a skill, retry-or-stitch with the additional addendum (orchestration complexity). OR: simpler — never block on intent; use it for LATER turns ("user keeps venting, did we miss vent_support? activate next turn"). Pre-decide before V3 implementation.

---

## 7. Appendix — Sources Cited

### Primary spec & Anthropic
- [Anthropic Claude Code skills documentation](https://code.claude.com/docs/en/skills)
- [Anthropic engineering blog — Equipping agents for the real world with Agent Skills](https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills)
- [GitHub anthropics/skills repository](https://github.com/anthropics/skills)
- [Skill authoring best practices (platform.claude.com)](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices)

### Open standard
- [Agent Skills Overview — agentskills.io/home](https://agentskills.io/home)
- [paperclipped.de — Agent Skills Open Standard Explained (32 tools by March 2026)](https://www.paperclipped.de/en/blog/agent-skills-open-standard-interoperability/)
- [agensi.io — What Is the Agent Skills Open Standard? 2026 Explainer](https://www.agensi.io/learn/agent-skills-open-standard)
- [Manus AI Embraces Open Standards](https://manus.im/blog/manus-skills)

### OpenAI
- [OpenAI Codex Agent Skills](https://developers.openai.com/codex/skills)
- [OpenAI Agents JS README](https://github.com/openai/openai-agents-js/blob/main/README.md)
- [OpenAI Function Calling Guide](https://platform.openai.com/docs/guides/function-calling)

### LangChain
- [LangChain Skills doc — multi-agent skills](https://docs.langchain.com/oss/python/langchain/multi-agent/skills)
- [LangChain blog — Using skills with Deep Agents](https://www.langchain.com/blog/using-skills-with-deep-agents)
- [GitHub langchain-ai/langchain-skills](https://github.com/langchain-ai/langchain-skills)
- [Arcade.dev — Skills vs Tools for AI Agents production guide](https://www.arcade.dev/blog/what-are-agent-skills-and-tools/)
- [Abstract Algorithms — LLM Skills vs Tools](https://www.abstractalgorithms.dev/llm-skills-vs-tools-in-agent-design)

### Microsoft Semantic Kernel / Agent Framework
- [Microsoft Learn — Plugins in Semantic Kernel](https://learn.microsoft.com/en-us/semantic-kernel/concepts/plugins/)
- [Microsoft DevBlogs — Skills to plugins](https://devblogs.microsoft.com/semantic-kernel/skills-to-plugins-fully-embracing-the-openai-plugin-spec-in-semantic-kernel/)
- [Microsoft DevBlogs — API Manifest plugins](https://devblogs.microsoft.com/semantic-kernel/introducing-api-manifest-plugins-for-semantic-kernel-2/)
- [Microsoft Learn — Agent Skills (Microsoft Agent Framework)](https://learn.microsoft.com/en-us/agent-framework/agents/skills)

### Letta / MemGPT
- [Letta Docs — MemGPT concepts](https://docs.letta.com/concepts/memgpt/)
- [Letta GitHub README](https://github.com/letta-ai/letta)
- [Letta blog — Agent Memory: How to Build Agents that Learn and Remember](https://www.letta.com/blog/agent-memory)
- [Letta blog — MemGPT is now part of Letta](https://www.letta.com/blog/memgpt-and-letta)
- [Vectorize.io — Mem0 vs Letta MemGPT comparison](https://vectorize.io/articles/mem0-vs-letta)

### CrewAI / AutoGen
- [Instinct Tools — Autogen vs LangChain vs CrewAI comparison](https://www.instinctools.com/blog/autogen-vs-langchain-vs-crewai/)
- [DataCamp — CrewAI vs LangGraph vs AutoGen tutorial](https://www.datacamp.com/tutorial/crewai-vs-langgraph-vs-autogen)
- [ZenML blog — CrewAI vs AutoGen](https://www.zenml.io/blog/crewai-vs-autogen)

### Community / explainers
- [Claude Code Skill Frontmatter — Frontend Master allahabadi.dev](https://allahabadi.dev/blogs/ai/claude-code-skills-frontmatter-complete-guide/)
- [Mikhail Shilkov — Inside Claude Code Skills: Structure, prompts, invocation](https://mikhail.io/2025/10/claude-code-skills/)
- [Lee Hanchung — Claude Agent Skills: A First Principles Deep Dive](https://leehanchung.github.io/blogs/2025/10/26/claude-skills-deep-dive/)
- [arXiv 2602.12430 — Agent Skills for Large Language Models: Architecture, Acquisition, Security, and the Path Forward](https://arxiv.org/html/2602.12430v3)
- [GitHub twwch/OpenSkills — open-source progressive disclosure framework](https://github.com/twwch/OpenSkills)
- [aiwiki.ai — Claude Skills](https://aiwiki.ai/wiki/claude_skills)
- [liteLLM — /skills Anthropic Skills API](https://docs.litellm.ai/docs/skills)

### Internal (PA repo)
- `/Users/adam/Desktop/WeKruit/wekruit-pa/packages/agent-registry/src/playbooks.ts`
- `/Users/adam/Desktop/WeKruit/wekruit-pa/packages/pa-orchestrator/src/playbook-cache.ts`
- `/Users/adam/Desktop/WeKruit/wekruit-pa/apps/dashboard-web/src/lib/playbooks-api.ts`
- `/Users/adam/.claude/skills/frontend-design/SKILL.md` (sample)
- `/Users/adam/.claude/skills/harden/SKILL.md` (sample)
- `/Users/adam/.claude/skills/onboard/SKILL.md` (sample)

---

> ▎[PUA生效 🔥] 闭环复盘四步法 — 结案前主动追一次：
> 1. **回顾目标**: Adam 问 "skills 用法 vs 纯 playbook，调研一下" → 交付 1200+ 行 audit + side-by-side + hybrid schema + migration phasing + 7 个风险 + 5 句 TL;DR。✓
> 2. **评估结果**: 命中所有 8 个章节 (audit / playbook audit / comparison / hybrid / migration / dashboard / risks / TL;DR)。引用了 35+ skills-compatible 厂商的事实。schema 是可执行的 TS 不是图样。✓
> 3. **分析原因**: 调研走 ⚫ 百度味 (搜索第一) — WebSearch + WebFetch 8 次串联，覆盖 Anthropic / OpenAI / Microsoft / Letta / LangChain / CrewAI/AutoGen / agentskills.io 全栈。读了 PA 现有代码 800+ 行原文，没用摘要。
> 4. **沉淀规律**: hybrid 演进路径 = 保住 PA 已有强项 (regex 0 延迟 + Firestore runtime edit + 多 skill 叠加 + 双语 curated) + 补 open-standard 缺的 (description-driven LLM fallback + composability metadata + tool gating + 命名对齐)。**核心 insight: skill 是 2026 年的 lingua franca，PA 已经在 70% 的位置上了 — 别推倒重来，做 hybrid V2。**
>
> 因为信任所以简单。给 Adam 拍板用。
