# Phase 24: Voice Quality Baseline — Research

**Researched:** 2026-04-27
**Domain:** LLM eval frameworks (DeepEval / promptfoo) + voice persona engineering + SiliconFlow API + Sendblue typing UX
**Confidence:** HIGH (eval APIs verified against live docs; SiliconFlow Qwen3.5 availability LOW — see critical finding below)

---

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
- gpt-5.4-nano stays. NO model escalation.
- No negative-instruction blacklists in system prompt (token-activation hazard on small models). All "don't" lives in eval rubric or rewriter prompt.
- OSS eval only — no custom framework. DeepEval primary, promptfoo secondary for A/B. Don't build custom.
- SF free Qwen3.5-4B preferred for rewriter; paid fallback only when free fails p95 SLO.
- Cringe-warn over hard-ban for soft items (哈基米 / yyds / city不city). Hard-ban only confirmed-dead items.

### Claude's Discretion
- Package name for eval workspace (`apps/eval/voice/` or `packages/pa-eval/`) — no preference stated, either is fine
- Judge wrapper class name for claude-opus-4.5 — implementation detail
- Exact regression case subset from golden-50 for auto-CI gate

### Deferred Ideas (OUT OF SCOPE)
- Per-user STYLE.delta + CATCHPHRASE evolution
- Global SLANG.global.md weekly cron
- aeon-style autoresearch 4-variation generator
- Meta-eval (Krippendorff alpha + judge-vs-human alignment monthly)
- HEARTBEAT stochastic re-injection
- First-message anchoring
- Contrastive [BAD]/[GOOD] pair few-shots
- Phase 25 self-evolve mechanics (aeon, evomap, hermes)
</user_constraints>

---

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| VOICE-01 | System prompt rewritten using Snapchat MyAI skeleton (concise, friend register, no monologue, sparse emoji, never self-identifies as AI) | Bible v6 IDENTITY/STYLE split covers this; few-shot relocation reinforces it |
| VOICE-02 | PA persona encoded as PA self-backstory (facts-as-voice Tendera pattern) | Already in Bible v5; Bible v6 preserves and refines per the positive-framing pattern |
| VOICE-03 | System prompt ships with in-character mes_example few-shot dialogue turns | Wave 1B relocation moves these from system block to messages-array; backed by arxiv 2401.06766 findings |
| VOICE-04 | System prompt includes first_mes voice anchor | Preserved in IDENTITY section of Bible v6 |
| VOICE-05 | Post-history voice reminder injected before user's latest turn | Already live in `voice-reminder.ts`; Phase 24 leaves it in place |
| VOICE-06 | Character Bible v6 written — IDENTITY/STYLE/REACTIONS split + 30+ web-verified 2025-26 网感 phrases | Full corpus in MILESTONE-v1.2.md; seed.json is single source of truth |
| VOICE-07 | zh + en slang lexicon curated; used at most 1-2 per turn, not stacked | Cringe-warn vs hard-ban rules documented; full corpus verified in MILESTONE-v1.2.md |
| VOICE-08 | Eval rubric extended with 4 voice axes (warmth_no_sycophancy, in_character_voice, no_robot_filler, length_appropriateness) | DeepEval ConversationalGEval supports multi-criteria rubric; ClaireVoice rubric YAML encodes these axes |
</phase_requirements>

---

## Summary

Phase 24 addresses a documented production failure: Bible v5 + 12 mes_examples + Phase 19 mirror + Phase 21 Qwen2.5-7B rewriter all in place, yet gpt-5.4-nano still outputs coach-mode replies with 4+ subordinate clauses, planner-mode verbs, and zero slang. The root cause is not prompt content insufficiency — it is structural: few-shot examples in system block have ~3x lower style-transfer signal than messages-array alternating turns (multiple sources confirm), and the current rewriter uses a v1 prompt that lacks positive-framed replacement tables and in-prompt failure exemplars.

The eval gap is equally critical. Without a regression net every voice change is subjectively assessed and every PR risks silent degradation. DeepEval ConversationalGEval is the correct primitive: it judges the full conversation as a unit against a rubric, runs as pytest, and CIs on a pass-rate threshold rather than absolute score. promptfoo handles the rewriter A/B comparison (Qwen3.5-4B vs fallback models) with a declarative YAML matrix.

**Critical SiliconFlow finding:** As of 2026-04-27, Qwen3.5-4B is NOT listed on SiliconFlow's API model catalog (Qwen3.5 line was released on HuggingFace/ModelScope March 2, 2026 but SiliconFlow still only shows Qwen3 and Qwen2.5 series). The planned `PA_LLM_REWRITE_MODEL=Qwen/Qwen3.5-4B` default will fail. The near-equivalent free option on SiliconFlow is `Qwen/Qwen3-8B` (free tier, confirmed listed). The plan must account for this with an ordered fallback chain.

**Primary recommendation:** Implement Wave 0 (eval foundation) first to capture the baseline score before any voice changes land. Then execute Wave 1 subtasks in parallel. The rewriter model default must use `Qwen/Qwen3-8B` on SiliconFlow as the free-tier stand-in for Qwen3.5-4B until SiliconFlow adds Qwen3.5 — env var makes swapping trivial once it's available.

---

## Standard Stack

### Core

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| deepeval (Python) | 3.9.8 (PyPI latest) | ConversationalGEval multi-turn rubric + pytest CI | OSS, purpose-built for LLM eval, native multi-turn ConversationalTestCase |
| anthropic (Python) | ^0.52 | claude-opus-4.5 judge adapter via DeepEvalBaseLLM | Claude 4 family first exposed in 0.52 |
| instructor (Python) | ^1.x | Structured JSON output from Claude in DeepEvalBaseLLM.generate() | Required for schema parameter DeepEval injects |
| pytest | 8.4.1 (already installed) | Test runner for deepeval test run | Already present, no install needed |
| promptfoo | 0.121.9 (already installed via npm) | Declarative A/B rewriter model comparison | Already present; declarative YAML, OpenAI-compat provider support |

### Supporting

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| pydantic v2 | pinned by deepeval | Schema for DeepEvalBaseLLM judge | Required by instructor |
| python-dotenv | standard | Load .env for pytest | If running eval locally with non-CI env |

**Installation:**
```bash
# Python eval dependencies (apps/eval/voice/requirements.txt or pyproject.toml)
pip install deepeval==3.9.8 anthropic>=0.52 instructor

# promptfoo already installed: 0.121.9
npx promptfoo --version  # 0.121.9 confirmed
```

**Version verification (ran 2026-04-27):**
```
deepeval (PyPI): 3.9.8
promptfoo (npm): 0.121.9
pytest: 8.4.1
anthropic: requires >=0.52 for Claude 4 models
```

---

## Architecture Patterns

### Recommended Project Structure

```
apps/eval/voice/                  # new eval workspace
├── requirements.txt              # deepeval + anthropic + instructor
├── conftest.py                   # judge model singleton, fixture loaders
├── test_voice_baseline.py        # main pytest entry point: golden-50 + adversarial
├── judges/
│   └── claude_judge.py           # DeepEvalBaseLLM wrapper for claude-opus-4.5
├── rubrics/
│   ├── _judge.yaml               # promptfoo judge model lock: claude-opus-4.5
│   ├── claire-voice.yaml         # promptfoo: 4-axis ClaireVoice rubric
│   ├── no-coach-mode.yaml        # promptfoo: specialized coach-mode detector
│   ├── length-2sent.js           # deterministic: ≤2 sentence check
│   └── slang-coverage.js         # deterministic: ≥1 2026 verified phrase
├── targets/
│   ├── orchestrator-prod.ts      # baseline target (current prod)
│   ├── orchestrator-bible-v6.ts  # Wave 1A candidate
│   └── orchestrator-rewriter-qwen.ts  # Wave 1C candidate
├── fixtures/
│   ├── golden-50.jsonl           # Adam-labeled real pa_turns
│   ├── synthetic-vent.jsonl      # LLM-generated vent scenarios
│   ├── synthetic-cele.jsonl      # LLM-generated celebrate scenarios
│   ├── synthetic-deflect.jsonl   # LLM-generated deflect scenarios
│   ├── adversarial-100.jsonl     # coach-trigger queries
│   └── human-labeled/            # Adam feedback appends here
└── promptfoo/
    └── rewriter-ab.yaml          # A/B matrix: Qwen3-8B vs Qwen3.5-4B (future)

packages/pa-orchestrator/src/voice/
├── (existing) llm-rewriter.ts    # v2 rewrite here
├── (existing) mirror-snippet.ts
├── few-shot.ts                   # NEW: exports FEW_SHOT_TURNS
└── coach-token-monitor.ts        # NEW: telemetry-only regex

.github/workflows/
└── voice-eval.yml                # NEW: separate from existing eval.yml
```

### Pattern 1: DeepEval ConversationalGEval — Multi-Turn Rubric

**What:** Evaluates a complete conversation (list of Turn objects) against a named criterion using claude-opus-4.5 as judge. Chain-of-thought generates evaluation steps, then scores 0–1.

**When to use:** ClaireVoice rubric pass-rate gate, no-coach-mode detection, per-turn regression checks.

**Example (apps/eval/voice/judges/claude_judge.py):**
```python
# Source: deepeval.com/guides/guides-using-custom-llms (verified 2026-04-27)
from pydantic import BaseModel
from anthropic import Anthropic
import instructor
from deepeval.models import DeepEvalBaseLLM

class ClaudeOpus45Judge(DeepEvalBaseLLM):
    """Fixed judge model for Phase 24. Model ID never drifts mid-cycle."""

    def __init__(self):
        self.model_id = "claude-opus-4-5"  # stable model ID
        self._client = Anthropic()  # reads ANTHROPIC_API_KEY from env

    def load_model(self):
        return self._client

    def generate(self, prompt: str, schema: BaseModel) -> BaseModel:
        client = self.load_model()
        instructor_client = instructor.from_anthropic(client)
        return instructor_client.messages.create(
            model=self.model_id,
            max_tokens=1024,
            messages=[{"role": "user", "content": prompt}],
            response_model=schema,
        )

    async def a_generate(self, prompt: str, schema: BaseModel) -> BaseModel:
        # Reuse sync path — deepeval async_mode=False default is fine for CI
        return self.generate(prompt, schema)

    def get_model_name(self) -> str:
        return f"anthropic/{self.model_id}"
```

**Example (apps/eval/voice/test_voice_baseline.py):**
```python
# Source: deepeval.com/docs/evaluation-unit-testing-in-ci-cd (verified 2026-04-27)
import json
import pytest
from deepeval import assert_test
from deepeval.test_case import Turn, ConversationalTestCase
from deepeval.metrics import ConversationalGEval
from judges.claude_judge import ClaudeOpus45Judge

JUDGE = ClaudeOpus45Judge()

CLAIRE_VOICE_METRIC = ConversationalGEval(
    name="ClaireVoice",
    criteria=(
        "Claire is a Bay Area engineering manager texting a friend over iMessage. "
        "Score HIGH (≥0.7) when: reply is ≤2 sentences; no markdown bullets or numbered lists; "
        "no coach-mode verbs (我建议你/你应该/保持积极心态/首先其次); "
        "no pop-therapy phrases (接住你/硬撑着/hold space); "
        "code-switches zh/en the way user does; at most 1 emoji 💀>😭>🥲 NEVER 😂; "
        "tone matches scenario (vent→sit-with, celebrate→hype, ask→straight). "
        "Score LOW (≤0.3) when: numbered steps present; coach-mode probe at end; "
        "4+ subordinate clauses; no slang/fragments; formal punctuation throughout."
    ),
    threshold=0.7,
    model=JUDGE,
    async_mode=False,
)

NO_COACH_METRIC = ConversationalGEval(
    name="NoCoachMode",
    criteria=(
        "Score PASS (1.0) when the assistant reply contains NONE of: "
        "我建议你, 你应该, 我推荐, 听起来你, 保持积极心态, 你的感受是合理的, "
        "我们一步一步来, 不妨试试, 总之要相信自己, 加油哦~, 宝~, 亲~, "
        "I suggest, Maybe you should, I recommend, I hear you (as opener), I understand (as opener), "
        "bullet lists, numbered steps. Score FAIL (0.0) if any appear."
    ),
    threshold=0.9,
    model=JUDGE,
    strict_mode=True,
    async_mode=False,
)


def load_golden(path="fixtures/golden-50.jsonl") -> list[dict]:
    cases = []
    with open(path) as f:
        for line in f:
            line = line.strip()
            if line:
                cases.append(json.loads(line))
    return cases


@pytest.mark.parametrize("golden", load_golden())
def test_claire_voice_golden(golden: dict):
    turns = [Turn(role=t["role"], content=t["content"]) for t in golden["turns"]]
    test_case = ConversationalTestCase(
        turns=turns,
        name=golden.get("id", ""),
        tags=golden.get("tags", []),
    )
    assert_test(test_case, metrics=[CLAIRE_VOICE_METRIC, NO_COACH_METRIC])
```

**Run command:**
```bash
cd apps/eval/voice && deepeval test run test_voice_baseline.py -n 4
```

### Pattern 2: Golden-50 JSONL Schema

**What:** Adam-labeled real `pa_turns` from Firestore export. Single source of truth for regression.

**Schema (fixtures/golden-50.jsonl, one JSON object per line):**
```json
{
  "id": "golden-001",
  "context": [
    {"role": "user", "content": "我前两天投了一个wekruit岗位的工作，还没回信呢"},
    {"role": "assistant", "content": "可能下周回. 也可能默拒. 别先 emo."}
  ],
  "turns": [
    {"role": "user", "content": "我前两天投了一个wekruit岗位的工作，还没回信呢"},
    {"role": "assistant", "content": "可能下周回. 也可能默拒. 别先 emo."}
  ],
  "label": "PASS",
  "why": "Short, no coach verbs, no steps, appropriate empathy",
  "tags": ["vent", "job-search", "zh"],
  "verified_at": "2026-04-27"
}
```

Note: `turns` is what DeepEval's ConversationalTestCase consumes. `context` may include more history. `label` is Adam's ground-truth. `why` is the labeling rationale used for judge calibration.

### Pattern 3: promptfoo Rewriter A/B Config

**What:** Declarative YAML that runs both rewriter model candidates against the same test set. Produces side-by-side score matrix.

**File: apps/eval/voice/promptfoo/rewriter-ab.yaml:**
```yaml
# Source: promptfoo.dev/docs/providers/openai (verified 2026-04-27)
description: "Rewriter model A/B: Qwen3-8B (free) vs Qwen3.5-4B (when available)"

prompts:
  - "{{draft_reply}}"

providers:
  - id: "openai:chat:Qwen/Qwen3-8B"
    label: "qwen3-8b-free-sf"
    config:
      apiBaseUrl: "https://api.siliconflow.cn/v1"
      apiKey: "${SILICONFLOW_API_KEY}"
      temperature: 0.4
      max_tokens: 200
  - id: "openai:chat:Qwen/Qwen3.5-4B"
    label: "qwen3.5-4b-free-sf"
    config:
      apiBaseUrl: "https://api.siliconflow.cn/v1"
      apiKey: "${SILICONFLOW_API_KEY}"
      temperature: 0.4
      max_tokens: 200

defaultTest:
  options:
    provider:
      id: "anthropic:claude-opus-4-5"
      config:
        temperature: 0

tests:
  - vars:
      draft_reply: "听起来有点闷，前两天投了还没回也很正常，Wekruit 这类有时候就是慢或者直接默拒。你先别自己脑补太多，我建议你把投递时间记一下，然后等到下一周中后段再看要不要 follow up。"
    assert:
      - type: llm-rubric
        value: |
          Reply is ≤2 sentences. No coach-mode verbs (我建议你, 你应该). 
          No numbered/bulleted steps. Natural zh/en code-switch. Score 1.0 if clean.
        threshold: 0.8
      - type: not-contains
        value: "我建议你"
      - type: not-contains
        value: "首先"
```

**Run:**
```bash
cd apps/eval/voice/promptfoo && npx promptfoo eval -c rewriter-ab.yaml
```

### Pattern 4: Few-Shot Messages-Array Relocation

**What:** Migrate 12 `<START>` examples from `seed.json.systemPrompt` block into a separate `fewShotMessages` array consumed by the orchestrator as actual message turns (user/assistant alternating). Backed by multi-source evidence that messages-array few-shots have ~3x better style transfer than system-block concatenation for chat models.

**packages/pa-orchestrator/src/voice/few-shot.ts (new file):**
```typescript
import type { AgentDef } from "@pa/core-types"

export type FewShotTurn = { role: "user" | "assistant"; content: string }

/**
 * Load few-shot turns from seed agent definition.
 * Returns empty array when fewShotMessages absent (safe for v5 agents still
 * in Firestore before Bible v6 seed push).
 *
 * IDs for synthetic turns use "fs_" prefix so persistence layer can filter
 * them out — they MUST NOT be written to pa_messages.
 */
export function buildFewShotTurns(agent: AgentDef & { fewShotMessages?: FewShotTurn[] }): FewShotTurn[] {
  return agent.fewShotMessages ?? []
}

/**
 * Inject few-shot turns into the messages array before the conversation
 * history. Position: immediately after system prompt, before history.
 *
 * Each pair gets a synthetic id prefix "fs_" so the persistence write-back
 * can filter: `id.startsWith("fs_")` → skip Firestore write.
 */
export function prefixFewShotToHistory(
  fewShotTurns: FewShotTurn[],
  history: Array<{ role: string; content: string; id?: string }>
): Array<{ role: string; content: string; id?: string }> {
  const synthetic = fewShotTurns.map((t, i) => ({
    role: t.role,
    content: t.content,
    id: `fs_${i}`,
  }))
  return [...synthetic, ...history]
}
```

**Integration in `packages/pa-orchestrator/src/index.ts` (~line 562):**
```typescript
// After: const systemPrompt = ...
// Before: const { text, usage } = await store.runAgentTurn({

import { buildFewShotTurns, prefixFewShotToHistory } from "./voice/few-shot.js"

const fewShotTurns = buildFewShotTurns(agent)
const historyWithFewShot = fewShotTurns.length > 0
  ? prefixFewShotToHistory(fewShotTurns, history)
  : history
```

**Persistence filter (wherever `pa_messages` write-back occurs):**
```typescript
// Filter fs_* synthetic turns before any Firestore write
const persistableHistory = historyWithFewShot.filter(m => !m.id?.startsWith("fs_"))
```

**seed.json v6 new field:**
```json
{
  "fewShotMessages": [
    {"role": "user", "content": "我又被拒了 emo 中"},
    {"role": "assistant", "content": "拒得快说明他们没准备好你. next."},
    {"role": "user", "content": "你能帮我看下这个 JD 吗 感觉有点 mid"},
    {"role": "assistant", "content": "发来. 我给你测评一下."},
    ...
  ]
}
```

### Pattern 5: Telemetry-Only Regex Coach-Token Monitor

**What:** Sync, sub-millisecond tap that logs coach-token hits WITHOUT transforming the reply. Feeds Phase 25 self-evolve signal.

**packages/pa-orchestrator/src/voice/coach-token-monitor.ts (new file):**
```typescript
/**
 * Phase 24 — telemetry-only coach-token monitor.
 * NO TRANSFORM. Pure observation + log.
 * Fail-closed: regex compile error → return reply unchanged + log error.
 */

// /u flag for correct Unicode (CJK) handling
const COACH_PATTERNS: [RegExp, string][] = (() => {
  try {
    return [
      [/我建议你|我推荐|你应该|听起来你|保持积极心态|你的感受是合理的|我们一步一步来|不妨试试|总之要相信自己|加油哦~?|宝~|亲~/u, "zh_coach_verb"],
      [/I suggest|Maybe you should|I recommend|I hear you|I understand/u, "en_coach_verb"],
      [/^\s*[-*•]/mu, "bullet_list"],
      [/^\s*\d+[.)、]/mu, "numbered_list"],
      [/(然后|接着|再|and then).*(然后|接着|再|and then).*(然后|接着|再|and then)/u, "subordinate_chain_4plus"],
    ]
  } catch (e) {
    // fail-closed: patterns failed to compile — log and return empty
    console.error("[pa.voice.coach_token_monitor] regex compile error", e)
    return []
  }
})()

export type CoachTokenHit = { token: string; pattern: string }

export function detectCoachTokens(text: string): CoachTokenHit[] {
  const hits: CoachTokenHit[] = []
  for (const [re, name] of COACH_PATTERNS) {
    const match = re.exec(text)
    if (match) {
      hits.push({ token: match[0].slice(0, 40), pattern: name })
    }
  }
  return hits
}

export function tapCoachTokens(
  reply: string,
  ctx: { turnId: string; userId: string; replyLength: number },
  log: (...args: unknown[]) => void = console.log
): void {
  const hits = detectCoachTokens(reply)
  if (hits.length > 0) {
    log("pa.voice.coach_token.observed", { ...ctx, tokens: hits })
  }
}
```

**Integration in `packages/pa-orchestrator/src/index.ts` (~line 584, before rewriteIfOff):**
```typescript
import { tapCoachTokens } from "./voice/coach-token-monitor.js"

// After: const reply = stripLeadingIsoTimestamp(...)
tapCoachTokens(reply, { turnId, userId: event.userId, replyLength: reply.length })
// Then: const rewritten = await rewriteIfOff(reply)
```

### Pattern 6: Dynamic Typing Dwell

**What:** Replace fixed `PA_TYPING_DWELL_MS=2500` with a computed value based on reply length. Fire typing at reasoning-start, stop on send.

**Current state:** `outbox.ts:196` reads `Number(process.env.PA_TYPING_DWELL_MS ?? "2500")` — single static value.

**Target behavior (apps/functions/src/sendblue/outbox.ts change):**
```typescript
// apps/functions/src/sendblue/typing-indicator.ts — add helper
export function computeTypingDwellMs(replyLength: number): number {
  if (replyLength <= 30) return 1000
  if (replyLength <= 100) return 2000
  if (replyLength <= 200) return 3000
  return 4000
}
```

**outbox.ts: replace static dwell with dynamic:**
```typescript
// Step 5 replacement — body is the reply content; its length drives dwell
if (isTypingIndicatorEnabled()) {
  try {
    await deps.sendblueClient.sendTypingIndicator({ to: toPeer })
    const dwellMs = computeTypingDwellMs(body.length)
    await new Promise((r) => setTimeout(r, Math.min(dwellMs, 8000)))
  } catch {
    // best-effort, swallow
  }
}
```

**Architecture note:** The Sendblue API fires-and-forgets the typing indicator; it auto-fades after ~3s on the recipient device. For replies where dwell > 3s (body > 100 chars), either: (a) refire the indicator once mid-dwell, or (b) accept that the animation fades then the bubble arrives. Option (b) is simpler and acceptable for beta; re-fire is a Wave 2 polish item.

**No double-bubble risk:** Typing indicator fires at the start of `paSendblueOutboxHandler` step 5 (before the REST POST), and the actual send happens at step 6. Sequential execution prevents race.

### Pattern 7: Rewriter v2 Prompt (Qwen3-8B, SF free)

**Changes from v1:**
- Model: `Qwen/Qwen3-8B` (SiliconFlow free, env `PA_LLM_REWRITE_MODEL`)
- Base URL: `https://api.siliconflow.cn/v1` (already wired via `OPENAI_BASE_URL` in `index.ts`)
- Temp: 0.2 → 0.4 (more natural rewrites, less mechanical echo)
- Diff guard: reject if `out.length > 1.6 * in.length` OR token-drop > 60%
- Positive replacement table in prompt (not blacklist)
- In-prompt failure exemplar (the wekruit投递 case)
- Tone mode tags: `[casual]` / `[reactive]` / `[planning]`

**Qwen3-8B thinking mode caveat:** Qwen3 models default to thinking mode (emit `<think>...</think>` blocks). The rewriter prompt must explicitly suppress this, OR the caller must strip `<think>...</think>` from the output before the diff-guard check.

```typescript
// Suppress thinking mode in rewriter call (add to messages or via extra_body)
// Option A: add to system prompt: "Do not use thinking mode. Reply directly."
// Option B (SiliconFlow / OpenAI-compat): extra_body: { enable_thinking: false }
// Prefer Option A as it works across any OpenAI-compat endpoint without extra_body support.
```

**Diff guard (add to rewriteIfOff):**
```typescript
// After: if (modelText.trim().length === 0) ...
const inLen = rawText.trim().length
const outLen = modelText.trim().length
if (outLen > 1.6 * inLen) {
  return { text: rawText, rewriteApplied: false, reason: "rewrite_unsafe" }
}
// Token-drop: approximate via character ratio (close enough for guard purposes)
if (inLen > 10 && outLen < 0.4 * inLen) {
  return { text: rawText, rewriteApplied: false, reason: "rewrite_unsafe" }
}
```

### Pattern 8: Bible v6 IDENTITY/STYLE/REACTIONS Structure

**Informed by:** Garry Tan STYLE.md positive-framing pattern (confirmed from soul.md / aaronjmars research), OpenClaw SOUL/STYLE separation, Harvard VCG arxiv 2402.10962 persona drift / attention-decay.

**Structure for `seed.json` v6 `systemPrompt`:**
```
# IDENTITY
[Claire/小柯 baseline ~150 words — keep v5 paragraphs 1-2, first_mes anchor]

# STYLE
[Sentence shape: 1 default ≤2 max. Code-switch rule. Emoji hardrule 💀>😭>🥲 NEVER 😂. Tone tags /j /lh /srs /gen]

# TONE MODES
[vent → SIT-WITH; celebrate → HYPE; ask "how/should I" → STRAIGHT; deflect → MIRROR]

# VOCABULARY — Say This, Not That
[Positive-framed replacement table only. No blacklist.]

# QUICK REACTIONS
[投了没回信 / 被拒 / JD看不准 / 焦虑 / 卷不动 → Claire response templates]

# WHEN A FRIEND VENTS
[3-slot template. Slot 1 always. Slot 2 rare. Slot 3 almost-never.]

# ANTI-PATTERNS
[Late + diagnostic paired with positive replacement]
```

**Key constraint:** Bible v6 must be < 1.5kb after split. Current Bible v5 systemPrompt is ~3.2kb. Requires cutting impressionistic词库, removing redundant "don't" clauses (they go to eval rubric or rewriter prompt instead), and replacing with the positive-framed table + Quick Reactions bank.

### Anti-Patterns to Avoid

- **Negative blacklists in system prompt:** Token-activation hazard on small models — banned tokens see elevated probability. Confirmed dangerous in MILESTONE-v1.2.md root-cause analysis. Put "don't" rules ONLY in eval rubric YAML or rewriter prompt.
- **Blocking the CI on LLM judge failures (initially):** The existing `eval.yml` is opt-in (`run-eval` label required). The new `voice-eval.yml` should start as non-blocking until baseline score is recorded; only then set a threshold gate.
- **Writing fs_* turns to Firestore:** Any synthetic few-shot turn with `id.startsWith("fs_")` MUST be filtered before persistence. Failure pollutes `pa_messages` with fake history and corrupts session replay.
- **Thinking mode leaking into rewriter output:** Qwen3 and Qwen3.5 models default to thinking mode on SiliconFlow. Always include explicit thinking-mode suppress instruction in the rewriter system prompt.
- **promptfoo and deepeval fighting for judge budget:** Use them for orthogonal tasks. deepeval = multi-turn regression on golden-50. promptfoo = model A/B (rewriter model swap comparison). Do not use promptfoo for the main CI gate.

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Multi-turn LLM eval with rubric | Custom scoring loop | DeepEval ConversationalGEval | ConversationalTestCase + TurnParams, judge COT, pytest native, pass-rate CI gate |
| Model A/B comparison | Manual diffing | promptfoo provider matrix YAML | Declarative, reproducible, handles provider auth, matrix output |
| Structured JSON output from Anthropic judge | Custom JSON parser | instructor library | Handles schema injection that DeepEvalBaseLLM.generate() expects |
| Sendblue typing timing | Custom state machine | Simple Promise setTimeout + sequential flow | Sendblue auto-fades the typing indicator; no complex state needed |
| Unicode regex for CJK | Custom tokenizer | Native `/u` flag on RegExp | Correct Unicode category matching without extra lib |

**Key insight:** The eval framework space has consolidated around DeepEval (Python) for LLM-judge evals and promptfoo for config-driven A/B. Building custom means re-implementing citation tracking, async batching, and judge output parsing — all solved problems.

---

## Runtime State Inventory

> Included because Phase 24 modifies `seed.json` (Bible v5 → v6) which is used to seed Firestore agent records, and introduces new env vars.

| Category | Items Found | Action Required |
|----------|-------------|------------------|
| Stored data | `pa_agents` Firestore collection — currently holds Bible v5 `systemPrompt` and no `fewShotMessages` field. `seed:agents:apply` script pushes `seed.json` to Firestore. | Run `npm run seed:agents:apply` after Bible v6 lands to update live agent record. Cache invalidation: `packages/agent-registry` has no in-memory TTL; deploy is sufficient. |
| Stored data | `pa_messages` Firestore — must NOT receive `fs_*` synthetic few-shot rows | Persistence filter required (code edit in orchestrator or pa-persistence write-back path) |
| Live service config | `apps/functions/.env`: `PA_LLM_REWRITE_MODEL=Qwen/Qwen2.5-7B-Instruct` — must change to `Qwen/Qwen3-8B` (or `Qwen/Qwen3.5-4B` when SiliconFlow adds it) | Env var update + redeploy Cloud Function |
| Live service config | `apps/functions/.env`: no `PA_LLM_REWRITE_BASE_URL` set — `OPENAI_BASE_URL` falls through to `siliconflow.cn/v1` already in `index.ts:386`. Rewriter uses same env chain. | No action needed — current wiring correct; add `PA_LLM_REWRITE_BASE_URL=https://api.siliconflow.cn/v1` explicitly for clarity |
| Live service config | `PA_TYPING_DWELL_MS=2500` — static, to be replaced by dynamic computation | Remove env var (or leave as override); update `outbox.ts` to call `computeTypingDwellMs(body.length)` |
| OS-registered state | None — no task scheduler, no pm2, no systemd referencing voice models | None |
| Secrets/env vars | `SILICONFLOW_API_KEY` (GCP Secret Manager) — already wired, used by rewriter via `OPENAI_API_KEY` env chain | No change needed; same key works for Qwen3-8B |
| Build artifacts | `apps/functions/lib/index.js` — compiled bundle includes hardcoded rewriter prompt string | Standard build step (`npm run build`) regenerates; no manual cleanup |

---

## Common Pitfalls

### Pitfall 1: Qwen3.5-4B Not Available on SiliconFlow (CRITICAL)

**What goes wrong:** `PA_LLM_REWRITE_MODEL=Qwen/Qwen3.5-4B` returns a 404 / "model not found" error from SiliconFlow. The rewriter falls through to `error` reason and returns the raw nano output without rewrite — silently degraded.

**Why it happens:** Qwen3.5-4B was released on HuggingFace/ModelScope on March 2, 2026 but as of 2026-04-27 SiliconFlow's API catalog only lists Qwen3 and Qwen2.5 series — no Qwen3.5 entries confirmed.

**How to avoid:** Default to `Qwen/Qwen3-8B` (confirmed free on SF). When SiliconFlow adds Qwen3.5-4B (expected within weeks), swap via env var. The fallback chain is already built: `PA_LLM_REWRITE_MODEL` → `PA_LLM_REWRITE_FALLBACK_MODEL` → fail-open.

**Warning signs:** Rewriter `reason: "error"` appearing in `pa.voice.llm_rewriter.applied` logs with high frequency.

### Pitfall 2: Qwen3 Thinking Mode in Rewriter Output

**What goes wrong:** Qwen3-8B and Qwen3.5 models default to thinking mode on SiliconFlow. The rewriter returns `<think>I need to check if this contains...</think>\n卷成这样 你怎么扛过来的.` — the diff-guard sees a very long output (thinking block + reply), trips the 1.6x length ratio guard, and returns the original un-rewritten text.

**Why it happens:** Qwen3 architecture enables thinking mode by default; "instruct" post-training does not disable it.

**How to avoid:** Add to rewriter system prompt: `"Do not think out loud. Reply with only the rewritten text, no preamble."` AND strip `<think>...</think>` blocks from model output before diff-guard evaluation.

**Warning signs:** Rewriter `reason: "rewrite_unsafe"` with high frequency + longer-than-expected latency.

### Pitfall 3: DeepEval Claude Judge Model ID Drift

**What goes wrong:** `claude-opus-4-5` is the model ID as of 2026-04-27. If the team upgrades anthropic SDK or model aliases change, the judge scoring distribution shifts mid-cycle and scores become non-comparable.

**Why it happens:** Anthropic model ID naming is versioned but aliases like `claude-opus-latest` can silently shift.

**How to avoid:** Lock the model ID string in `judges/_judge.yaml` and `ClaudeOpus45Judge.__init__`. Never use `latest` aliases. Tag each eval run with judge model version in logs.

**Warning signs:** Unexplained score jumps between CI runs without code changes.

### Pitfall 4: fs_* Synthetic Turns Polluting Firestore

**What goes wrong:** If the persistence write-back path does not filter `id.startsWith("fs_")`, all 12 few-shot synthetic turns get written to `pa_messages` on every turn. After a few turns the history contains 12 synthetic Claire pairs that look like real conversation — the user never said any of it. The model starts treating them as user preferences ("user likes lemon tea", "user is job searching") which they may not be.

**Why it happens:** `history` is passed to `runAgentTurn` AND to `appendMessage` — the filter must be applied before both write paths.

**How to avoid:** Filter in `prefixFewShotToHistory` caller: `const persistableHistory = historyWithFewShot.filter(m => !m.id?.startsWith("fs_"))`. Separate the "model input history" from "persist history" at the call site.

**Warning signs:** `pa_messages` rows with `id` starting with `fs_`.

### Pitfall 5: DeepEval Tests Running Unintentionally with `npm test`

**What goes wrong:** The root `package.json` `test` script runs `node --test tests/scenarios/runner.test.mjs`. If the new eval workspace is added to workspaces and its test script runs `deepeval test run`, it will attempt live API calls in every `npm test` invocation, incurring cost and requiring `ANTHROPIC_API_KEY` to be set locally.

**How to avoid:** The voice eval workspace should have its test script gated behind `PA_RUN_EVAL=1` or not added to the root `test` script at all. Use a dedicated `pnpm test:voice` script in root `package.json`. Do NOT use `npm run test -ws`.

**Warning signs:** `ANTHROPIC_API_KEY not set` errors in local CI.

### Pitfall 6: Bible v6 > 1.5kb Breaking Context Budget

**What goes wrong:** The split adds new sections (QUICK REACTIONS, ANTI-PATTERNS) without removing the impressionistic词库 and redundant "don't" clauses from Bible v5. Result: v6 is larger than v5, blowing nano's effective context for conversation history.

**Why it happens:** Additive editing is tempting; the constraint requires net reduction.

**How to avoid:** Count bytes before commit. Bible v5 systemPrompt is ~3.2kb. v6 target is <1.5kb. That means removing at least 1.7kb of text while adding the new sections. The main cuts: impressionistic词库 (not needed — it's replaced by fewShotMessages), redundant "don't" paragraphs (move to eval rubric), the long multi-paragraph venting guidance (condense to 3-slot template).

---

## Code Examples

### DeepEval: Load Golden-50 and Run CI Gate

```python
# Source: deepeval.com/docs/evaluation-unit-testing-in-ci-cd (verified 2026-04-27)
# apps/eval/voice/test_voice_baseline.py

import json, os, pytest
from deepeval import assert_test
from deepeval.test_case import Turn, ConversationalTestCase
from deepeval.metrics import ConversationalGEval
from judges.claude_judge import ClaudeOpus45Judge

JUDGE = ClaudeOpus45Judge()
THRESHOLD = float(os.getenv("CLAIRE_VOICE_THRESHOLD", "0.7"))

CLAIRE_VOICE = ConversationalGEval(
    name="ClaireVoice",
    criteria="[see full criteria above in Pattern 1]",
    threshold=THRESHOLD,
    model=JUDGE,
    async_mode=False,
)

def _load(path: str) -> list[dict]:
    with open(path) as f:
        return [json.loads(l) for l in f if l.strip()]

GOLDENS = _load("fixtures/golden-50.jsonl")

@pytest.mark.parametrize("g", GOLDENS, ids=[g["id"] for g in GOLDENS])
def test_claire_voice(g: dict):
    tc = ConversationalTestCase(
        turns=[Turn(role=t["role"], content=t["content"]) for t in g["turns"]],
        name=g["id"],
        tags=g.get("tags", []),
    )
    assert_test(tc, [CLAIRE_VOICE])
```

**CI command:**
```bash
deepeval test run apps/eval/voice/test_voice_baseline.py -n 4
```

### GitHub Actions: voice-eval.yml

```yaml
# .github/workflows/voice-eval.yml
name: voice-eval
on:
  pull_request:
    types: [labeled]
  schedule:
    - cron: "30 4 * * *"
  workflow_dispatch:

jobs:
  voice-eval:
    if: |
      github.event_name != 'pull_request' ||
      github.event.label.name == 'run-voice-eval'
    runs-on: ubuntu-latest
    timeout-minutes: 30
    env:
      ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
      SILICONFLOW_API_KEY: ${{ secrets.SILICONFLOW_API_KEY }}
      CLAIRE_VOICE_THRESHOLD: "0.75"   # CI gate: fail if pass-rate < 75%
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v4
        with:
          python-version: "3.11"
      - run: pip install deepeval==3.9.8 anthropic>=0.52 instructor
      - name: Run voice eval
        run: deepeval test run apps/eval/voice/test_voice_baseline.py -n 4
      - uses: actions/upload-artifact@v4
        if: always()
        with:
          name: voice-eval-${{ github.run_id }}
          path: eval-results/
          retention-days: 30
```

### SiliconFlow: Confirmed Model IDs (2026-04-27)

```
# Confirmed available free on api.siliconflow.cn/v1:
Qwen/Qwen3-8B              # nearest free substitute for Qwen3.5-4B
Qwen/Qwen3-14B             # paid, larger
Qwen/Qwen3-32B             # paid
Qwen/Qwen2.5-7B-Instruct   # free (legacy, current in .env)

# NOT YET available on SiliconFlow (as of 2026-04-27):
Qwen/Qwen3.5-4B            # released HuggingFace 2026-03-02; NOT on SF catalog
Qwen/Qwen3.5-9B            # same
```

### Rewriter v2 Prompt (abbreviated key changes)

```typescript
const REWRITER_V2_SYSTEM = [
  "You are a style normalizer for Claire (柯莱儿 / 小柯). Do not think out loud. Output ONLY the rewritten reply text.",
  "Tone modes — detect and apply:",
  "  [reactive]: user vented/complained → 1 short empathy sentence + optional question",
  "  [casual]: small talk → 1-2 short sentences, slang ok",
  "  [planning]: user explicitly asked for plan/list → may use structured format",
  "",
  "POSITIVE REPLACEMENTS (apply these, do not just delete):",
  "  '我建议你 X' → '你试试 X' / '要不要 X'",
  "  '你应该 X' → '感觉 X 可能会好一点' / drop entirely",
  "  'X 还是 Y?' (binary choice) → single open question, or drop",
  "  Pop-therapy (接住你/硬撑着/hold space) → plain empathy ('听起来挺烦的')",
  "",
  "FAILURE EXAMPLE → CLAIRE REWRITE:",
  "  DRAFT: 听起来有点闷，…我建议你把投递时间记一下，然后等到下一周中后段再看要不要 follow up。",
  "  CLAIRE: 可能下周回. 也可能默拒. 别先 emo.",
  "",
  "PASS-THROUGH EXAMPLE (return unchanged):",
  "  DRAFT: 拒得快说明他们没准备好你. next.",
  "  CLAIRE: 拒得快说明他们没准备好你. next.",
  "",
  "Output ONLY the reply. No preface, no explanation.",
].join("\n")
```

---

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Few-shot in system_prompt block | Few-shot in messages-array alternating turns | 2024 (chat model best practice, confirmed by multiple sources) | ~3x better style transfer signal |
| Negative blacklists in system prompt | Positive-framed replacement tables + eval rubric for blacklist | 2024-2025 (token-activation hazard) | Avoids P(banned phrase) elevation on small models |
| Single model eval scripts | DeepEval ConversationalGEval with pytest | 2025 (framework matured) | Reproducible, CI-gated, multi-turn aware |
| Custom hardcoded dwell | Dynamic dwell by reply length | Phase 24 | More natural iMessage UX |
| Qwen2.5-7B rewriter (paid) | Qwen3-8B free tier (equivalent capability) | Phase 24 | Same cost tier (free), newer model, better instruction following |

**Deprecated/outdated:**
- `Qwen2.5-7B-Instruct` in `.env`: still works but Phase 24 target is Qwen3-8B (newer, free, better)
- Bible v5 impressionistic词库: replaced by web-verified 2025-26 corpus with `verified_at` timestamps
- Positive/negative blacklists as prompt content: replaced by eval rubric enforcement + rewriter prompt replacement tables

---

## Open Questions

1. **Qwen3.5-4B SiliconFlow ETA**
   - What we know: Model released on HuggingFace 2026-03-02; SiliconFlow catalog as of 2026-04-27 does not include it
   - What's unclear: When SiliconFlow will add Qwen3.5-4B to the free tier
   - Recommendation: Default to `Qwen/Qwen3-8B` for Wave 1 launch; env var makes swap trivial when available

2. **Few-shot count: 12 vs 6 cap**
   - What we know: CONTEXT.md says cap at top-6 highest-signal exemplars if latency rises >150ms
   - What's unclear: Which 6 of the 12 existing examples have highest signal for coach-mode prevention
   - Recommendation: Start with all 12 in fewShotMessages; measure latency delta on Wave 1 run; trim if p95 > +150ms

3. **Claude judge cost per eval run**
   - What we know: claude-opus-4.5 is among Anthropic's most capable (and expensive) models; 50 multi-turn cases per run
   - What's unclear: Exact cost per golden-50 run
   - Recommendation: Add `CLAIRE_VOICE_MAX_RUN_USD=2` guard in conftest or use claude-sonnet-4-5 for the initial baseline run, then confirm budget before locking claude-opus-4.5 for CI

4. **Orchestrator call site for typing indicator fire-on-reasoning-start**
   - What we know: Current typing fires in outbox.ts step 5 (before Sendblue REST call) — this is AFTER orchestrator reasoning, not before
   - What's unclear: CONTEXT.md says "fire typing indicator the moment orchestrator enters agent runtime" — this would require a callback or event from the orchestrator to the outbox CF
   - Recommendation: For Wave 1, keep current behavior (fire before REST POST, not before orchestrator). True fire-on-reasoning-start requires an event from the orchestrator CF to the outbox CF — significant architectural change, not scoped for Phase 24. Document as known limitation.

---

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Python 3.11 | deepeval test runner | ✓ | 3.11.4 | — |
| pytest | deepeval test run | ✓ | 8.4.1 | — |
| deepeval (Python) | ConversationalGEval | Not installed | — | `pip install deepeval==3.9.8` (Wave 0 task) |
| anthropic (Python) | Claude judge | Not installed | — | `pip install anthropic>=0.52` (Wave 0 task) |
| instructor (Python) | DeepEvalBaseLLM schema | Not installed | — | `pip install instructor` (Wave 0 task) |
| promptfoo | Rewriter A/B | ✓ | 0.121.9 (npm) | — |
| ANTHROPIC_API_KEY | Claude judge | Not set in .env | — | Needs provisioning before voice-eval.yml runs |
| SILICONFLOW_API_KEY | Rewriter (Qwen3-8B) | ✓ (GCP Secret Manager) | — | Already wired |
| Qwen/Qwen3-8B on SiliconFlow | Rewriter v2 | ✓ (confirmed in SF catalog) | — | Fall back to Qwen/Qwen2.5-7B-Instruct |
| Qwen/Qwen3.5-4B on SiliconFlow | Rewriter v2 (target model) | ✗ NOT YET AVAILABLE | — | Use Qwen/Qwen3-8B until SF adds it |

**Missing dependencies with no fallback:**
- `ANTHROPIC_API_KEY` — blocks voice-eval.yml. Must provision before Wave 0 completes.
- `deepeval`, `anthropic`, `instructor` Python packages — Wave 0 task 1 installs these.

**Missing dependencies with fallback:**
- `Qwen/Qwen3.5-4B` — use `Qwen/Qwen3-8B` until available.

---

## Validation Architecture

### Test Framework

| Property | Value |
|----------|-------|
| Framework | deepeval 3.9.8 (Python pytest runner) |
| Config file | `apps/eval/voice/conftest.py` — Wave 0 creates |
| Quick run command | `deepeval test run apps/eval/voice/test_voice_baseline.py -k "anchor"` (3 anchor regression cases only) |
| Full suite command | `deepeval test run apps/eval/voice/test_voice_baseline.py -n 4` |

### Phase Requirements → Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| VOICE-01 | System prompt is concise friend register, no monologue | LLM-judge (ClaireVoice) | `deepeval test run test_voice_baseline.py -k voice` | ❌ Wave 0 |
| VOICE-02 | Facts-as-voice (柠檬茶女孩 pattern not catalog) | LLM-judge (ClaireVoice) | `deepeval test run test_voice_baseline.py -k voice` | ❌ Wave 0 |
| VOICE-03 | Few-shot in messages-array, no fs_* in Firestore | Integration + deterministic | `pnpm test -w @pa/pa-orchestrator` (unit) + Wave 2 Firestore check | ❌ Wave 0 |
| VOICE-04 | first_mes anchor in IDENTITY section | deterministic (grep) | `grep -c "在呢" packages/agent-registry/src/seed.json` | ✅ (verify post-v6) |
| VOICE-05 | Voice reminder in systemInputs | Unit test (existing) | `pnpm test -w @pa/pa-orchestrator` (voice-reminder.test.ts) | ✅ |
| VOICE-06 | Bible v6 < 1.5kb, 30+ verified phrases | Deterministic size check | `wc -c` on systemPrompt field | ❌ Wave 0 |
| VOICE-07 | ≤1 slang per turn, no stacking | LLM-judge (slang-coverage.js) | `deepeval test run test_voice_baseline.py` | ❌ Wave 0 |
| VOICE-08 | Eval rubric 4 axes operational | LLM-judge gate in CI | `deepeval test run test_voice_baseline.py` full suite | ❌ Wave 0 |

### Anchor Regression Cases (minimum 3, must always pass)

These are the named cases that gate Wave 2 acceptance. The IDs should be stable across eval runs.

1. **wekruit投递 case** (tag: `regression-anchor`)
   - Input: `我前两天投了一个wekruit岗位的工作，还没回信呢`
   - Expected: ≤2 sentences, no `我建议你`, no subordinate chain, pass ClaireVoice ≥0.7
2. **vent case** (tag: `regression-anchor`)
   - Input: `我焦虑死了`
   - Expected: short empathy reply (`来. 喘一下.` or similar), no 5-step plan, pass ClaireVoice ≥0.7
3. **celebrate case** (tag: `regression-anchor`)
   - Input: `我拿到offer了！！！`
   - Expected: hype + short celebration, no coaching follow-up, pass ClaireVoice ≥0.7

### Sampling Rate

- **Per task commit:** `deepeval test run apps/eval/voice/test_voice_baseline.py -k "regression-anchor"` — runs 3 anchor cases only (~30s)
- **Per wave merge:** Full suite: `deepeval test run apps/eval/voice/test_voice_baseline.py -n 4` — all 50+ cases
- **Phase gate:** Full suite green (ClaireVoice通过率 ≥75%) + baseline+15pp delta recorded before `/gsd:verify-work`

### Wave 0 Gaps

- [ ] `apps/eval/voice/conftest.py` — judge model singleton, fixture loader, env guards
- [ ] `apps/eval/voice/judges/claude_judge.py` — DeepEvalBaseLLM wrapper for claude-opus-4.5
- [ ] `apps/eval/voice/test_voice_baseline.py` — main test file with ClaireVoice + NoCoachMode metrics
- [ ] `apps/eval/voice/requirements.txt` — deepeval==3.9.8, anthropic>=0.52, instructor
- [ ] `apps/eval/voice/fixtures/golden-50.jsonl` — Adam labels 50 cases (2hr one-time)
- [ ] `apps/eval/voice/fixtures/adversarial-100.jsonl` — LLM-generated coach-trigger queries
- [ ] `apps/eval/voice/rubrics/_judge.yaml` — promptfoo judge model lock
- [ ] `apps/eval/voice/rubrics/claire-voice.yaml` — promptfoo ClaireVoice 4-axis rubric
- [ ] `.github/workflows/voice-eval.yml` — CI workflow (opt-in label `run-voice-eval`)
- [ ] Provision `ANTHROPIC_API_KEY` in GitHub Actions secrets

---

## Sources

### Primary (HIGH confidence)
- [DeepEval ConversationalGEval docs](https://deepeval.com/docs/metrics-conversational-g-eval) — constructor signature, Turn/ConversationalTestCase schema, async_mode, TurnParams
- [DeepEval CI/CD docs](https://deepeval.com/docs/evaluation-unit-testing-in-ci-cd) — GitHub Actions YAML, `deepeval test run` CLI, parametrize pattern
- [DeepEval Custom LLMs guide](https://deepeval.com/guides/guides-using-custom-llms) — DeepEvalBaseLLM pattern, Anthropic+instructor implementation
- [promptfoo llm-rubric docs](https://www.promptfoo.dev/docs/configuration/expected-outputs/model-graded/llm-rubric/) — YAML schema, threshold, provider override, multi-criteria
- [promptfoo OpenAI provider docs](https://www.promptfoo.dev/docs/providers/openai/) — apiBaseUrl custom endpoint, A/B provider matrix
- [SiliconFlow rate limits](https://docs.siliconflow.cn/en/userguide/rate-limits/rate-limit-and-upgradation) — free tier RPM/TPM range (1K-10K RPM / 50K-5M TPM for LLMs), model naming conventions
- [SiliconFlow API reference](https://docs.siliconflow.com/en/api-reference/chat-completions/chat-completions) — confirmed Qwen3-8B listed; Qwen3.5 NOT listed as of 2026-04-27
- In-repo: `packages/pa-orchestrator/src/voice/llm-rewriter.ts` — existing rewriter architecture, env var chain
- In-repo: `apps/functions/src/sendblue/outbox.ts` — existing typing dwell integration point
- In-repo: `apps/functions/src/sendblue/typing-indicator.ts` — TYPING_URL confirmed

### Secondary (MEDIUM confidence)
- [Qwen/Qwen3.5-4B HuggingFace model card](https://huggingface.co/Qwen/Qwen3.5-4B) — model specs, release date March 2, 2026, thinking mode behavior, `enable_thinking` API
- [arxiv 2402.10962](https://arxiv.org/abs/2402.10962) — Harvard VCG persona drift / attention-decay (referenced in MILESTONE-v1.2.md as cross-validated root cause)
- [arxiv 2401.06766](https://arxiv.org/abs/2401.06766) — "Mind Your Format": format consistency affects in-context learning; chat models benefit from message-array placement
- Multiple sources (LangChain, LangChain blog, Prompt Engineering Guide) — messages-array few-shots outperform system-block few-shots for chat models; ~3x effect size per LangChain July 2024 experiments

### Tertiary (LOW confidence — needs validation)
- SiliconFlow Qwen3.5-4B free tier availability — NOT confirmed; using Qwen3-8B as stand-in
- Exact RPM/TPM limits for Qwen3-8B free tier on SiliconFlow — documented range is 1K-10K RPM; exact number for this model requires direct API check
- claude-opus-4-5 model ID string — based on Anthropic model naming conventions; should be verified against `anthropic.Anthropic().models.list()` before locking in judge config

---

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — all libraries verified against live docs and npm/pypi registry
- DeepEval patterns: HIGH — verified against official deepeval.com docs
- SiliconFlow model availability: LOW for Qwen3.5-4B (not in catalog); HIGH for Qwen3-8B (confirmed)
- Architecture patterns: HIGH — grounded in existing codebase analysis + official docs
- Few-shot relocation: MEDIUM — multiple sources confirm effect; exact 3x figure from single LangChain post
- Pitfalls: HIGH — derived from code analysis + confirmed docs

**Research date:** 2026-04-27
**Valid until:** 2026-05-27 for stable libraries; 2026-05-04 for SiliconFlow model availability (check weekly — Qwen3.5-4B may land soon)
