---
phase: 24-voice-quality-baseline
plan: 01
type: execute
wave: 1
depends_on: []
files_modified:
  - apps/eval/voice/requirements.txt
  - apps/eval/voice/conftest.py
  - apps/eval/voice/judges/claude_judge.py
  - apps/eval/voice/judges/__init__.py
  - apps/eval/voice/rubrics/length-2sent.js
  - apps/eval/voice/rubrics/slang-coverage.js
  - apps/eval/voice/rubrics/_judge.yaml
  - apps/eval/voice/rubrics/claire-voice.yaml
  - apps/eval/voice/test_voice_baseline.py
  - apps/eval/voice/promptfoo/rewriter-ab.yaml
  - apps/eval/voice/fixtures/golden-50.template.jsonl
  - apps/eval/voice/fixtures/adversarial-100.jsonl
  - apps/eval/voice/README.md
  - .github/workflows/voice-eval.yml
  - package.json
autonomous: false
requirements:
  - VOICE-01

must_haves:
  truths:
    - "`pnpm test:voice` runs DeepEval pytest locally with claude-opus-4.5 as judge."
    - "`apps/eval/voice/` workspace exists with 4 reusable layers (dataset × rubric × target × runner)."
    - "promptfoo A/B config compiles against Qwen3-8B + Qwen3.5-4B providers (4B will 404 until SF adds it — expected)."
    - "GitHub Actions `voice-eval.yml` runs on `run-voice-eval` label and blocks PR when ClaireVoice pass-rate < 75%."
    - "claude-opus-4.5 model ID is hardcoded in judge wrapper (no `latest` aliases)."
  artifacts:
    - path: "apps/eval/voice/requirements.txt"
      provides: "deepeval==3.9.8 + anthropic>=0.52 + instructor"
      contains: "deepeval==3.9.8"
    - path: "apps/eval/voice/judges/claude_judge.py"
      provides: "ClaudeOpus45Judge DeepEvalBaseLLM wrapper"
      contains: "claude-opus-4-5"
    - path: "apps/eval/voice/test_voice_baseline.py"
      provides: "ClaireVoice + NoCoachMode ConversationalGEval metrics with parametrized golden cases"
      contains: "ConversationalGEval"
    - path: "apps/eval/voice/rubrics/_judge.yaml"
      provides: "promptfoo judge model lock"
      contains: "claude-opus-4-5"
    - path: ".github/workflows/voice-eval.yml"
      provides: "CI gate workflow"
      contains: "deepeval test run"
  key_links:
    - from: "apps/eval/voice/test_voice_baseline.py"
      to: "apps/eval/voice/judges/claude_judge.py"
      via: "from judges.claude_judge import ClaudeOpus45Judge"
      pattern: "from judges\\.claude_judge import"
    - from: ".github/workflows/voice-eval.yml"
      to: "apps/eval/voice/test_voice_baseline.py"
      via: "deepeval test run command"
      pattern: "deepeval test run apps/eval/voice"
    - from: "package.json (root)"
      to: "apps/eval/voice/test_voice_baseline.py"
      via: "test:voice script"
      pattern: "\"test:voice\""
---

<objective>
Establish the reusable DeepEval foundation (Wave 0 step 1 of 8). Creates the `apps/eval/voice/` workspace with 4-layer architecture (dataset × rubric × target × runner), the claude-opus-4.5 judge wrapper, the ClaireVoice + NoCoachMode metrics, the promptfoo A/B config for rewriter-model comparison, and the GitHub Actions CI gate.

This is the **regression net** that gates every other Wave 1 task. Without it, every voice change is vibes.

Purpose: VOICE-01 requires a reusable, OSS, multi-turn LLM-as-judge eval framework. DeepEval ConversationalGEval is the chosen primitive (verified 2026-04-27 against `deepeval.com/docs`).
Output: Runnable `pnpm test:voice` command + CI workflow + empty golden-50 template ready for the next plan to populate.
</objective>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
@$HOME/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/STATE.md
@.planning/ROADMAP.md
@.planning/REQUIREMENTS.md
@.planning/MILESTONE-v1.2.md
@.planning/phases/24-voice-quality-baseline/24-CONTEXT.md
@.planning/phases/24-voice-quality-baseline/24-RESEARCH.md
@package.json
</context>

<interfaces>
<!-- Critical research findings (NON-NEGOTIABLE) -->

DeepEvalBaseLLM contract (verified deepeval.com/guides/guides-using-custom-llms 2026-04-27):
```python
class DeepEvalBaseLLM:
    def load_model(self) -> Any: ...
    def generate(self, prompt: str, schema: BaseModel) -> BaseModel: ...
    async def a_generate(self, prompt: str, schema: BaseModel) -> BaseModel: ...
    def get_model_name(self) -> str: ...
```

DeepEval ConversationalTestCase + Turn (verified deepeval.com/docs/metrics-conversational-g-eval):
```python
from deepeval.test_case import Turn, ConversationalTestCase
from deepeval.metrics import ConversationalGEval

ConversationalGEval(
    name=str,
    criteria=str,
    threshold=float,  # 0..1, pass-rate gate
    model=DeepEvalBaseLLM,
    async_mode=False,  # CI determinism
    strict_mode=bool,  # binary pass/fail vs continuous score
)
```

promptfoo OpenAI-compatible provider (verified promptfoo.dev/docs/providers/openai 2026-04-27):
```yaml
providers:
  - id: "openai:chat:Qwen/Qwen3-8B"
    config:
      apiBaseUrl: "https://api.siliconflow.cn/v1"
      apiKey: "${SILICONFLOW_API_KEY}"
```

SiliconFlow model availability (verified 2026-04-27):
- ✓ Qwen/Qwen3-8B (free) — DEFAULT for rewriter v2
- ✗ Qwen/Qwen3.5-4B — NOT in SF catalog yet; document as future swap

Judge model: `claude-opus-4-5` (CI gate). Anthropic API key must be provisioned in GitHub Actions secrets.
</interfaces>

<tasks>

<task type="auto">
  <name>Task 1: Scaffold apps/eval/voice/ workspace + Python deps + judge wrapper</name>
  <read_first>
    - apps/functions/package.json (existing workspace pattern reference)
    - .planning/phases/24-voice-quality-baseline/24-RESEARCH.md (Pattern 1 + Pattern 2 verbatim)
    - .planning/phases/24-voice-quality-baseline/24-CONTEXT.md (Wave 0 file list)
    - package.json (root — to add `test:voice` script)
  </read_first>
  <files>
    apps/eval/voice/requirements.txt,
    apps/eval/voice/conftest.py,
    apps/eval/voice/judges/__init__.py,
    apps/eval/voice/judges/claude_judge.py,
    apps/eval/voice/README.md,
    package.json
  </files>
  <action>
    Create the `apps/eval/voice/` Python workspace.

    1. `apps/eval/voice/requirements.txt`:
    ```
    deepeval==3.9.8
    anthropic>=0.52
    instructor>=1.0
    pydantic>=2.0
    python-dotenv>=1.0
    ```

    2. `apps/eval/voice/judges/__init__.py` — empty file (Python package marker).

    3. `apps/eval/voice/judges/claude_judge.py` — ClaudeOpus45Judge class. Implementation EXACTLY per 24-RESEARCH.md Pattern 1, but with these concrete bindings:
       - `self.model_id = "claude-opus-4-5"` (HARDCODED — never use `latest` aliases per Pitfall 3)
       - Constructor reads `ANTHROPIC_API_KEY` via `Anthropic()` default
       - `a_generate` reuses sync path (CI uses `async_mode=False`)
       - Add docstring: "Locked judge for Phase 24 — model ID drift risk per 24-RESEARCH.md Pitfall 3."

    4. `apps/eval/voice/conftest.py`:
       - Load `.env` via `python-dotenv` (best-effort)
       - Module-level singleton `JUDGE = ClaudeOpus45Judge()`
       - pytest fixture `judge()` returning the singleton
       - Guard: if `ANTHROPIC_API_KEY` not set AND `PA_RUN_EVAL=1`, raise `pytest.UsageError`
       - If `PA_RUN_EVAL` not set, skip with reason "Set PA_RUN_EVAL=1 to run voice eval (incurs Claude API cost)"

    5. `apps/eval/voice/README.md` — short doc:
       - "Voice eval foundation for Phase 24 / Milestone v1.2"
       - Local run: `cd apps/eval/voice && pip install -r requirements.txt && PA_RUN_EVAL=1 deepeval test run test_voice_baseline.py -n 4`
       - CI: triggered by `run-voice-eval` PR label
       - Cost guard: 50 cases × claude-opus-4.5 ≈ small but real $$ — NEVER run on every PR. Use the label.

    6. Edit root `package.json` — add to `"scripts"`:
       ```json
       "test:voice": "cd apps/eval/voice && PA_RUN_EVAL=1 deepeval test run test_voice_baseline.py -n 4",
       "test:voice:anchors": "cd apps/eval/voice && PA_RUN_EVAL=1 deepeval test run test_voice_baseline.py -k regression-anchor"
       ```
       Do NOT add `apps/eval/voice` to pnpm workspaces (Pitfall 5 — must NOT auto-run on `npm test`).
  </action>
  <verify>
    <automated>test -f apps/eval/voice/requirements.txt && test -f apps/eval/voice/judges/claude_judge.py && grep -q "claude-opus-4-5" apps/eval/voice/judges/claude_judge.py && grep -q "deepeval==3.9.8" apps/eval/voice/requirements.txt && grep -q '"test:voice"' package.json && grep -q "PA_RUN_EVAL" apps/eval/voice/conftest.py</automated>
  </verify>
  <acceptance_criteria>
    - `apps/eval/voice/requirements.txt` exists and pins `deepeval==3.9.8`, `anthropic>=0.52`, `instructor>=1.0`
    - `apps/eval/voice/judges/claude_judge.py` defines `class ClaudeOpus45Judge(DeepEvalBaseLLM)` with `self.model_id = "claude-opus-4-5"` (verifiable: `grep -c '"claude-opus-4-5"' apps/eval/voice/judges/claude_judge.py` returns ≥1)
    - `apps/eval/voice/conftest.py` guards on `PA_RUN_EVAL=1` (verifiable: `grep -c "PA_RUN_EVAL" apps/eval/voice/conftest.py` returns ≥1)
    - Root `package.json` contains `"test:voice"` script (verifiable: `grep -c "test:voice" package.json` returns ≥2)
    - `apps/eval/voice/` is NOT added to pnpm workspaces (verifiable: `! grep -q "apps/eval/voice" pnpm-workspace.yaml` if file exists)
  </acceptance_criteria>
  <done>Voice eval Python workspace scaffolded with locked judge model and `pnpm test:voice` script wired.</done>
</task>

<task type="auto">
  <name>Task 2: Rubrics + DeepEval test runner + promptfoo A/B config + adversarial fixtures</name>
  <read_first>
    - apps/eval/voice/judges/claude_judge.py (just created — judge import path)
    - .planning/phases/24-voice-quality-baseline/24-RESEARCH.md (Pattern 1 ClaireVoice criteria verbatim, Pattern 2 schema, Pattern 3 promptfoo YAML)
    - .planning/MILESTONE-v1.2.md (web-verified 2025-26 corpus — slang-coverage rubric whitelist)
  </read_first>
  <files>
    apps/eval/voice/rubrics/_judge.yaml,
    apps/eval/voice/rubrics/claire-voice.yaml,
    apps/eval/voice/rubrics/length-2sent.js,
    apps/eval/voice/rubrics/slang-coverage.js,
    apps/eval/voice/test_voice_baseline.py,
    apps/eval/voice/fixtures/golden-50.template.jsonl,
    apps/eval/voice/fixtures/adversarial-100.jsonl,
    apps/eval/voice/promptfoo/rewriter-ab.yaml
  </files>
  <action>
    Create the rubric layer + test runner + dataset templates.

    1. `apps/eval/voice/rubrics/_judge.yaml`:
    ```yaml
    # Judge model lock for Phase 24 / v1.2. Do not change without milestone bump.
    judge:
      provider: anthropic
      model: claude-opus-4-5
      temperature: 0
      verified_at: 2026-04-27
    ```

    2. `apps/eval/voice/rubrics/claire-voice.yaml` — promptfoo `llm-rubric` config with the FULL ClaireVoice criteria string from 24-RESEARCH.md Pattern 1 (the multi-line criteria covering ≤2 sentences, no markdown bullets, no coach-mode verbs, code-switch, emoji hardrule 💀>😭>🥲 NEVER 😂, tone matches scenario). Threshold 0.7. Provider override pointing to `_judge.yaml` (claude-opus-4-5, temp 0).

    3. `apps/eval/voice/rubrics/length-2sent.js` — deterministic JS rubric:
    ```javascript
    // Returns score 1.0 if reply has ≤2 sentences (zh: 。！？  en: . ! ?), else 0.0
    module.exports = ({ output }) => {
      const sentences = (output.match(/[。！？!?\.]+/g) || []).length;
      return sentences <= 2 ? { pass: true, score: 1.0 } : { pass: false, score: 0.0, reason: `Got ${sentences} sentences, expected ≤2` };
    };
    ```

    4. `apps/eval/voice/rubrics/slang-coverage.js` — deterministic JS rubric. Whitelist (verified 2025-26 corpus from MILESTONE-v1.2.md "Web-Verified 网感 Corpus" — Add list):
    ```javascript
    const VERIFIED_2026 = [
      // zh
      "老登","活人感","邪修","主理人","误闯天家","预制","赛博对账","如何呢，又能怎","班味","去班味","拼好","职场申公豹","真没空陪你闹了","发疯工牌","蒜鸟",
      // legacy zh still alive
      "卷","摆烂","躺平","emo","破防","听劝","i人","e人","测评","显眼包","柠檬",
      // en gen-z 2025-26
      "delulu","cooked","mid","brainrot","slop","lock in","yapping","glazing","aura","mother is mothering","demure","ragebait","crash out","NPC","canon event","iykyk",
      // en legacy still alive
      "lowkey","fr","deadass","manifest","next"
    ];
    module.exports = ({ output }) => {
      const lower = output.toLowerCase();
      const hit = VERIFIED_2026.some(s => lower.includes(s.toLowerCase()));
      // Coverage rubric is informational — never blocks. Telemetry only.
      return { pass: true, score: hit ? 1.0 : 0.5, reason: hit ? "verified slang present" : "no verified slang (ok for short replies)" };
    };
    ```

    5. `apps/eval/voice/test_voice_baseline.py` — main pytest entry. Implementation EXACTLY per 24-RESEARCH.md Pattern 1 final code block, with these concrete bindings:
       - Imports: `from judges.claude_judge import ClaudeOpus45Judge`
       - Module-level `JUDGE = ClaudeOpus45Judge()`
       - Module-level `THRESHOLD = float(os.getenv("CLAIRE_VOICE_THRESHOLD", "0.7"))`
       - Two metrics: `CLAIRE_VOICE_METRIC` (full criteria string from Pattern 1) and `NO_COACH_METRIC` (full criteria string from Pattern 1, threshold 0.9, strict_mode=True)
       - `_load(path)` helper to parse JSONL
       - `GOLDENS = _load("fixtures/golden-50.jsonl")` BUT wrap in try/except so file-missing doesn't break collection — fall back to `_load("fixtures/golden-50.template.jsonl")` and log warning
       - `@pytest.mark.parametrize("g", GOLDENS, ids=[g["id"] for g in GOLDENS])`
       - `test_claire_voice(g)` builds `ConversationalTestCase` from `g["turns"]`, calls `assert_test(tc, [CLAIRE_VOICE_METRIC, NO_COACH_METRIC])`
       - Tag `regression-anchor` cases will be filtered via `-k regression-anchor` selector

    6. `apps/eval/voice/fixtures/golden-50.template.jsonl` — 3 placeholder cases (Plan 02 will replace with real Adam-labeled cases). Each is a valid JSONL line matching schema from 24-RESEARCH.md Pattern 2:
    ```json
    {"id":"placeholder-001","turns":[{"role":"user","content":"placeholder"},{"role":"assistant","content":"placeholder"}],"label":"PASS","why":"placeholder — replaced in plan 02","tags":["placeholder"],"verified_at":"2026-04-27"}
    ```
    (3 such lines).

    7. `apps/eval/voice/fixtures/adversarial-100.jsonl` — start empty file with header comment (1 commented-out line `// will be populated by plan 02 LLM-gen step`). Actual generation happens in plan 02.

    8. `apps/eval/voice/promptfoo/rewriter-ab.yaml` — EXACTLY the YAML from 24-RESEARCH.md Pattern 3 (Qwen3-8B + Qwen3.5-4B providers, anthropic claude-opus-4-5 judge, the wekruit投递 test case with 3 asserts: llm-rubric + 2 not-contains for "我建议你" and "首先"). Add header comment: "Qwen3.5-4B will 404 until SiliconFlow adds it (see 24-RESEARCH.md critical finding 1). Default rewriter (plan 04) uses Qwen3-8B."

    Do NOT populate real golden-50 dataset here — that is plan 02 (Adam HITL labeling).
  </action>
  <verify>
    <automated>test -f apps/eval/voice/test_voice_baseline.py && test -f apps/eval/voice/rubrics/claire-voice.yaml && test -f apps/eval/voice/rubrics/length-2sent.js && test -f apps/eval/voice/rubrics/slang-coverage.js && test -f apps/eval/voice/promptfoo/rewriter-ab.yaml && grep -q "ConversationalGEval" apps/eval/voice/test_voice_baseline.py && grep -q "ClaireVoice" apps/eval/voice/test_voice_baseline.py && grep -q "NoCoachMode" apps/eval/voice/test_voice_baseline.py && grep -q "Qwen/Qwen3-8B" apps/eval/voice/promptfoo/rewriter-ab.yaml && grep -q "claude-opus-4-5" apps/eval/voice/rubrics/_judge.yaml && [ "$(wc -l < apps/eval/voice/fixtures/golden-50.template.jsonl)" -ge 3 ]</automated>
  </verify>
  <acceptance_criteria>
    - `apps/eval/voice/test_voice_baseline.py` defines both `CLAIRE_VOICE_METRIC` and `NO_COACH_METRIC` as `ConversationalGEval` instances (grep: "ConversationalGEval" appears ≥2 times)
    - `apps/eval/voice/rubrics/_judge.yaml` pins `model: claude-opus-4-5`
    - `apps/eval/voice/rubrics/length-2sent.js` exports a function returning `{pass, score}` shape
    - `apps/eval/voice/rubrics/slang-coverage.js` includes ≥10 entries from MILESTONE-v1.2.md verified corpus (grep: at least "活人感" AND "delulu" present)
    - `apps/eval/voice/promptfoo/rewriter-ab.yaml` includes BOTH `Qwen/Qwen3-8B` and `Qwen/Qwen3.5-4B` providers with `apiBaseUrl: https://api.siliconflow.cn/v1`
    - `apps/eval/voice/fixtures/golden-50.template.jsonl` has ≥3 valid JSONL lines
    - `apps/eval/voice/test_voice_baseline.py` falls back to template fixture if `golden-50.jsonl` missing (grep: `golden-50.template.jsonl`)
  </acceptance_criteria>
  <done>DeepEval pytest runner + 4 rubrics + promptfoo A/B + fixture templates exist. `pnpm test:voice` would collect tests successfully (will skip without `PA_RUN_EVAL=1` and without real golden-50).</done>
</task>

<task type="auto">
  <name>Task 3: GitHub Actions voice-eval.yml CI gate</name>
  <read_first>
    - .github/workflows/ (existing workflow patterns — find any `.yml` files)
    - .planning/phases/24-voice-quality-baseline/24-RESEARCH.md (Code Examples section — voice-eval.yml template verbatim)
  </read_first>
  <files>.github/workflows/voice-eval.yml</files>
  <action>
    Create `.github/workflows/voice-eval.yml` EXACTLY per 24-RESEARCH.md "Code Examples" section voice-eval.yml block, with these concrete bindings:

    - Trigger: `pull_request: types: [labeled]` AND `schedule: cron: "30 4 * * *"` AND `workflow_dispatch`
    - `if:` condition gates on `github.event.label.name == 'run-voice-eval'` for PR runs (opt-in, never runs on every PR — Pitfall 5)
    - Python 3.11
    - `pip install -r apps/eval/voice/requirements.txt` (NOT inline pip install; use the requirements.txt created in task 1)
    - Env: `ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}`, `SILICONFLOW_API_KEY: ${{ secrets.SILICONFLOW_API_KEY }}`, `CLAIRE_VOICE_THRESHOLD: "0.75"`, `PA_RUN_EVAL: "1"`
    - Run: `cd apps/eval/voice && deepeval test run test_voice_baseline.py -n 4`
    - Upload artifacts: `eval-results/` retention 30 days
    - Timeout: 30 min

    Add a comment block at the top: "Phase 24 — Voice eval CI gate. Apply `run-voice-eval` label to PRs that touch voice code. Daily cron at 04:30 UTC tracks drift. Fails when ClaireVoice pass-rate < 75%."

    NOTE: The workflow will fail fast in initial runs because `ANTHROPIC_API_KEY` may not yet be provisioned in GitHub Actions secrets. That provisioning is a Wave 2 checkpoint (plan 07). For now, the workflow YAML must exist + be valid; first green run waits on secret provisioning.
  </action>
  <verify>
    <automated>test -f .github/workflows/voice-eval.yml && grep -q "run-voice-eval" .github/workflows/voice-eval.yml && grep -q "deepeval test run" .github/workflows/voice-eval.yml && grep -q "CLAIRE_VOICE_THRESHOLD" .github/workflows/voice-eval.yml && grep -q "ANTHROPIC_API_KEY" .github/workflows/voice-eval.yml && grep -q "PA_RUN_EVAL" .github/workflows/voice-eval.yml</automated>
  </verify>
  <acceptance_criteria>
    - `.github/workflows/voice-eval.yml` exists
    - Workflow gates on `run-voice-eval` label for PRs (grep: `run-voice-eval`)
    - Sets `CLAIRE_VOICE_THRESHOLD: "0.75"` env var
    - Sets `PA_RUN_EVAL: "1"` env var (so conftest.py guard passes)
    - Runs `deepeval test run apps/eval/voice/test_voice_baseline.py` (grep: `deepeval test run`)
    - Uploads `eval-results/` artifact
    - YAML is valid (verifiable: `python3 -c "import yaml; yaml.safe_load(open('.github/workflows/voice-eval.yml'))"` exits 0)
  </acceptance_criteria>
  <done>CI workflow exists. PRs with `run-voice-eval` label trigger DeepEval; daily cron tracks drift. Awaits `ANTHROPIC_API_KEY` secret provisioning (plan 07).</done>
</task>

<task type="checkpoint:human-verify" gate="blocking">
  <name>Task 4: Adam confirms eval foundation scaffolding before plan 02 (HITL labeling) starts</name>
  <action>
    Pause for Adam human verification per <how-to-verify>. No autonomous action — Adam inspects scaffolding, decides whether to provision ANTHROPIC_API_KEY now or defer.
  </action>
  <what-built>
    - `apps/eval/voice/` Python workspace with DeepEval + Anthropic + instructor
    - `ClaudeOpus45Judge` wrapper locked to `claude-opus-4-5` model ID
    - `ClaireVoice` + `NoCoachMode` ConversationalGEval metrics
    - 4 rubrics (`_judge.yaml`, `claire-voice.yaml`, `length-2sent.js`, `slang-coverage.js`)
    - promptfoo A/B config for Qwen3-8B vs Qwen3.5-4B (4B will 404 — expected)
    - GitHub Actions `voice-eval.yml` workflow (opt-in via `run-voice-eval` label)
    - Root `package.json` `test:voice` + `test:voice:anchors` scripts
    - 3-row `golden-50.template.jsonl` placeholder (real cases come in plan 02)
  </what-built>
  <how-to-verify>
    1. **Inspect file tree:** `find apps/eval/voice -type f | sort` — should show: requirements.txt, conftest.py, README.md, judges/, rubrics/, fixtures/, promptfoo/, test_voice_baseline.py
    2. **Inspect package.json:** `grep "test:voice" package.json` — should show 2 scripts
    3. **Smoke test (optional, costs Claude $$):** Provision `ANTHROPIC_API_KEY` locally then `cd apps/eval/voice && pip install -r requirements.txt && PA_RUN_EVAL=1 deepeval test run test_voice_baseline.py -k placeholder` — should run 3 placeholder cases against claude-opus-4.5
    4. **Cost gate confirmation:** Confirm comfort with claude-opus-4.5 as the locked judge model. Estimated cost per full 50-case run: small but real. Alternative: claude-sonnet-4-5 for routine local runs (per RESEARCH.md Open Question 3).
    5. **Decide on `ANTHROPIC_API_KEY` provisioning timing:** Now (so plan 02 HITL labels can be sanity-checked against the judge), or defer to plan 07 (verification phase).
  </how-to-verify>
  <resume-signal>
    Type "approved" to proceed with plan 02 (golden-50 + Adam HITL labeling).
    Or describe issues — e.g.:
    - "Use claude-sonnet-4-5 for routine local runs to control cost" → planner adjusts conftest.py to allow override
    - "Provision ANTHROPIC_API_KEY now in GitHub secrets" → checkpoint completes after Adam adds secret
    - "Move workspace to packages/pa-eval/ instead" → planner refactors
  </resume-signal>
</task>

</tasks>

<verification>
1. `find apps/eval/voice -type f | wc -l` ≥ 12 (requirements.txt, conftest.py, README.md, 1 judge file + __init__, 4 rubrics, test_voice_baseline.py, 2 fixtures, promptfoo/rewriter-ab.yaml)
2. `grep -c "claude-opus-4-5" apps/eval/voice/judges/claude_judge.py apps/eval/voice/rubrics/_judge.yaml` ≥ 2
3. `python3 -c "import yaml; yaml.safe_load(open('.github/workflows/voice-eval.yml'))"` exits 0
4. `python3 -c "import json; [json.loads(l) for l in open('apps/eval/voice/fixtures/golden-50.template.jsonl') if l.strip()]"` exits 0
5. `node -e "require('./apps/eval/voice/rubrics/length-2sent.js')({output:'a. b.'})"` exits 0 with `{pass: true, score: 1}`
</verification>

<success_criteria>
- DeepEval workspace exists at `apps/eval/voice/` with Python deps pinned
- Judge wrapper locks `claude-opus-4-5` (no `latest` aliases)
- 4 rubrics ready (`_judge.yaml`, `claire-voice.yaml`, `length-2sent.js`, `slang-coverage.js`)
- promptfoo A/B config covers both Qwen3-8B (working) and Qwen3.5-4B (future)
- GitHub Actions `voice-eval.yml` opt-in via `run-voice-eval` label
- `pnpm test:voice` script in root `package.json`
- `PA_RUN_EVAL=1` guard prevents accidental Claude API spend on `npm test`
- All future Wave 1 plans (03/04/05/06) can run their target evals against this foundation
</success_criteria>

<output>
After completion, create `.planning/phases/24-voice-quality-baseline/24-01-SUMMARY.md` with:
- File tree of `apps/eval/voice/`
- Confirmed model IDs (judge: claude-opus-4-5; rewriter A/B: Qwen3-8B working, Qwen3.5-4B 404 expected)
- Outstanding: `ANTHROPIC_API_KEY` GitHub secret provisioning (deferred to plan 07)
- First baseline score recorded after plan 02 lands real golden-50 (deferred)
</output>
