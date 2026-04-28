---
phase: 24-voice-quality-baseline
plan: 02
type: execute
wave: 2
depends_on: ["24-01"]
files_modified:
  - apps/eval/voice/fixtures/golden-50.jsonl
  - apps/eval/voice/fixtures/synthetic-vent.jsonl
  - apps/eval/voice/fixtures/synthetic-cele.jsonl
  - apps/eval/voice/fixtures/synthetic-deflect.jsonl
  - apps/eval/voice/fixtures/adversarial-100.jsonl
  - apps/eval/voice/scripts/generate-synthetic.ts
  - apps/eval/voice/scripts/extract-pa-turns.ts
  - apps/eval/voice/HITL-LABELING-GUIDE.md
autonomous: false
requirements:
  - VOICE-07
  - VOICE-08

must_haves:
  truths:
    - "`golden-50.jsonl` contains ≥50 real `pa_turns`-derived cases hand-labeled by Adam (PASS/FAIL + why)."
    - "3 anchor regression cases are present and tagged `regression-anchor`: wekruit投递 / vent / celebrate."
    - "`adversarial-100.jsonl` contains ≥100 LLM-generated coach-trigger queries."
    - "`synthetic-{vent,cele,deflect}.jsonl` contain ≥10 cases each (LLM-gen scenarios)."
    - "`pnpm test:voice:anchors` runs 3 anchor cases against current production target and records baseline score."
  artifacts:
    - path: "apps/eval/voice/fixtures/golden-50.jsonl"
      provides: "Adam-labeled regression net — 50 real cases"
      contains: "regression-anchor"
    - path: "apps/eval/voice/scripts/extract-pa-turns.ts"
      provides: "Firestore export → JSONL converter"
    - path: "apps/eval/voice/scripts/generate-synthetic.ts"
      provides: "LLM-driven synthetic case generator (vent/cele/deflect/adversarial)"
    - path: "apps/eval/voice/HITL-LABELING-GUIDE.md"
      provides: "Adam labeling protocol — bootstrap calibration → full 50"
  key_links:
    - from: "apps/eval/voice/test_voice_baseline.py"
      to: "apps/eval/voice/fixtures/golden-50.jsonl"
      via: "_load() called at module collection time"
      pattern: "fixtures/golden-50\\.jsonl"
    - from: "apps/eval/voice/scripts/extract-pa-turns.ts"
      to: "Firestore pa_turns collection"
      via: "firebase-admin SDK"
      pattern: "PA_COLLECTIONS\\.turns|pa_turns"
---

<objective>
Populate the golden-50 dataset (HITL — Adam owner) and generate synthetic + adversarial fixtures. Wave 0 step 2.

This is the **source of truth** for every voice eval. Without real Adam-labeled data, the judge has nothing to regress against. Bootstrap with a 10-case calibration session before full labeling (per 24-CONTEXT.md Risks → "Adam labels golden-50 inconsistently").

Purpose: VOICE-07 (slang lexicon use ≤1-2 per turn, not stacked) + VOICE-08 (4-axis rubric operational) require labeled data to verify against.
Output: `golden-50.jsonl` with ≥50 cases (3 tagged `regression-anchor`), 3 synthetic JSONL files, 1 adversarial JSONL, HITL labeling guide.

This plan has TWO checkpoints: (a) calibration on 10 cases, (b) approval of full 50 labels.
</objective>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
@$HOME/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/STATE.md
@.planning/MILESTONE-v1.2.md
@.planning/phases/24-voice-quality-baseline/24-CONTEXT.md
@.planning/phases/24-voice-quality-baseline/24-RESEARCH.md
@.planning/phases/24-voice-quality-baseline/24-01-SUMMARY.md
@apps/eval/voice/test_voice_baseline.py
@apps/eval/voice/fixtures/golden-50.template.jsonl
</context>

<interfaces>
Golden case JSONL schema (verified 24-RESEARCH.md Pattern 2):
```json
{
  "id": "golden-001",
  "context": [{"role":"user","content":"..."},{"role":"assistant","content":"..."}],
  "turns": [{"role":"user","content":"..."},{"role":"assistant","content":"..."}],
  "label": "PASS" | "FAIL",
  "why": "explanation for label",
  "tags": ["vent","job-search","zh","regression-anchor"],
  "verified_at": "YYYY-MM-DD"
}
```

3 anchor regression cases (24-RESEARCH.md "Anchor Regression Cases"):
1. wekruit投递: input `我前两天投了一个wekruit岗位的工作，还没回信呢` — expected ≤2 sentences, no `我建议你`
2. vent: input `我焦虑死了` — expected short empathy `来. 喘一下.`-style
3. celebrate: input `我拿到offer了！！！` — expected hype + short, no coach follow-up

Firestore source: `pa_turns` collection (PA_COLLECTIONS.turns). Existing transcript export script may exist — grep `firebase-admin` in repo before writing new extractor.
</interfaces>

<tasks>

<task type="auto">
  <name>Task 1: Build extraction + synthetic-generation scripts + HITL labeling guide</name>
  <read_first>
    - packages/core-types/src/index.ts (for PA_COLLECTIONS.turns / pa_messages constants)
    - .planning/phases/24-voice-quality-baseline/24-RESEARCH.md (Pattern 2 schema, "Anchor Regression Cases" section)
    - .planning/MILESTONE-v1.2.md (verified 网感 corpus, hard-ban list, cringe-warn list)
    - apps/eval/voice/test_voice_baseline.py (consumer schema)
  </read_first>
  <files>
    apps/eval/voice/scripts/extract-pa-turns.ts,
    apps/eval/voice/scripts/generate-synthetic.ts,
    apps/eval/voice/HITL-LABELING-GUIDE.md,
    apps/eval/voice/fixtures/synthetic-vent.jsonl,
    apps/eval/voice/fixtures/synthetic-cele.jsonl,
    apps/eval/voice/fixtures/synthetic-deflect.jsonl,
    apps/eval/voice/fixtures/adversarial-100.jsonl
  </files>
  <action>
    1. `apps/eval/voice/scripts/extract-pa-turns.ts` — Node TS script.
       - Imports: `firebase-admin/firestore`, reads `process.env.PA_FIRESTORE_PROJECT_ID` + `GOOGLE_APPLICATION_CREDENTIALS`
       - Queries `pa_turns` collection (or `pa_messages` if turns are sparse) for last 200 user→assistant turn pairs
       - For each pair, emits one JSONL line matching the golden schema (label="UNLABELED", tags inferred from content via simple heuristics: `zh`/`en` by char ratio, `vent`/`celebrate`/`question` by keyword match like `焦虑/烦/累→vent`, `offer/拿到/恭喜→celebrate`, `?→question`)
       - Output: `apps/eval/voice/fixtures/_extracted-raw.jsonl` (NOT golden-50.jsonl yet — Adam picks 50 from this)
       - Run: `pnpm tsx apps/eval/voice/scripts/extract-pa-turns.ts > apps/eval/voice/fixtures/_extracted-raw.jsonl`
       - Add `--limit N` flag (default 200)

    2. `apps/eval/voice/scripts/generate-synthetic.ts` — Node TS script.
       - Calls SiliconFlow Qwen3-8B (uses `SILICONFLOW_API_KEY`, baseURL `https://api.siliconflow.cn/v1`) — same OpenAI-compat pattern as existing rewriter
       - Three modes: `--mode vent` (10 cases), `--mode cele` (10 cases), `--mode deflect` (10 cases), `--mode adversarial` (100 cases — coach-trigger queries that should still produce non-coach replies)
       - Adversarial prompt template asks Qwen for: "Generate 100 user messages that would tempt an AI assistant to give coach-mode advice (numbered steps, 我建议你, 你应该, 保持积极心态). One per line. Vent/career/job-search themes mixed zh/en."
       - For each generated user message, also generate a candidate Claire reply by calling current production target (gpt-5.4-nano with current Bible), so the JSONL has both turns
       - Output to corresponding JSONL files; each line includes `tags: ["synthetic","<mode>"]` and `label: "UNLABELED"`

    3. `apps/eval/voice/HITL-LABELING-GUIDE.md` — Adam labeling protocol:
       - Step 1: Run `pnpm tsx apps/eval/voice/scripts/extract-pa-turns.ts > fixtures/_extracted-raw.jsonl`
       - Step 2: **Calibration session** — pick 10 cases from `_extracted-raw.jsonl` covering 3 categories (3 vent / 3 question / 4 misc). Adam labels PASS/FAIL + writes `why`. Writes to `fixtures/_calibration-10.jsonl`.
       - Step 3: After calibration checkpoint passes, label 50 total. Use rule: each entry has `label` (PASS/FAIL), `why` (one sentence rationale citing ClaireVoice criteria), `tags` (zh/en/vent/celebrate/question/deflect/regression-anchor as applicable).
       - Step 4: 3 cases MUST be tagged `regression-anchor` — wekruit投递, vent (`我焦虑死了`), celebrate (`我拿到offer了！！！`). Hand-write these 3 (do NOT pull from extracted) so the canonical content matches 24-RESEARCH.md.
       - Step 5: Save final to `fixtures/golden-50.jsonl`.
       - **Labeling rules** (lifted from MILESTONE-v1.2.md):
         - PASS = ≤2 sentences, no `我建议你/你应该/保持积极心态/听起来你`, code-switch matches user, ≤1 verified slang term, emoji rule 💀>😭>🥲 NEVER 😂
         - FAIL = numbered steps, coach-mode probe, 4+ subordinate clauses, pop-therapy (`接住你/硬撑着/hold space`), "听我说谢谢你"/"no cap"/"sus"/"bussin"/"slay"/"bet"/"gyatt" (hard-ban list)
         - Cringe-WARN (mark as PASS with `tags: ["cringe-warn"]`): `哈基米/yyds/city不city/蚌牛`
       - Time budget: ~2 hours one-time (per MILESTONE-v1.2.md "Adam HITL Investment").

    4. Create empty placeholder JSONL files (`synthetic-vent.jsonl`, `synthetic-cele.jsonl`, `synthetic-deflect.jsonl`, `adversarial-100.jsonl`) with header comment lines explaining how to populate via `generate-synthetic.ts`. Do NOT actually invoke Qwen here — that runs in task 2 once scripts are validated.

    Implementation note: prefer `pnpm tsx` for execution (already in repo toolchain). Place a short README inside `apps/eval/voice/scripts/` explaining run order.
  </action>
  <verify>
    <automated>test -f apps/eval/voice/scripts/extract-pa-turns.ts && test -f apps/eval/voice/scripts/generate-synthetic.ts && test -f apps/eval/voice/HITL-LABELING-GUIDE.md && grep -q "regression-anchor" apps/eval/voice/HITL-LABELING-GUIDE.md && grep -q "calibration" apps/eval/voice/HITL-LABELING-GUIDE.md && grep -q "我建议你" apps/eval/voice/HITL-LABELING-GUIDE.md && grep -q "Qwen/Qwen3-8B\|Qwen3-8B" apps/eval/voice/scripts/generate-synthetic.ts && grep -q "siliconflow.cn" apps/eval/voice/scripts/generate-synthetic.ts</automated>
  </verify>
  <acceptance_criteria>
    - `apps/eval/voice/scripts/extract-pa-turns.ts` reads from `pa_turns` Firestore collection (grep: `pa_turns` or `PA_COLLECTIONS.turns`)
    - `apps/eval/voice/scripts/generate-synthetic.ts` calls SiliconFlow with `Qwen/Qwen3-8B` (grep: both `Qwen3-8B` and `siliconflow.cn`)
    - `apps/eval/voice/HITL-LABELING-GUIDE.md` includes: 10-case calibration step, 3 anchor regression cases (wekruit投递, vent, celebrate), hard-ban list, cringe-warn list
    - 4 placeholder JSONL files exist (synthetic-vent, synthetic-cele, synthetic-deflect, adversarial-100)
  </acceptance_criteria>
  <done>Extraction + generation scripts ready. Adam can run them and label.</done>
</task>

<task type="checkpoint:human-action" gate="blocking">
  <name>Task 2: Adam runs extract + labels 10-case calibration set</name>
  <action>
    Adam-driven: this is a true human-action checkpoint requiring Firestore creds + subjective voice judgment. Adam runs the extract script, picks 10 cases covering 3 categories, hand-labels PASS/FAIL + why, saves to fixtures/_calibration-10.jsonl. See <how-to-verify>.
  </action>
  <what-built>
    - Extraction script `extract-pa-turns.ts` ready
    - Labeling guide at `apps/eval/voice/HITL-LABELING-GUIDE.md`
  </what-built>
  <how-to-verify>
    Adam-driven steps (this is a TRUE human-action checkpoint — pulling Firestore creds + applying subjective voice judgment cannot be automated):

    1. Ensure Firebase Admin creds available locally:
       ```bash
       export GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account.json
       export PA_FIRESTORE_PROJECT_ID=wekruit-pa-prod
       ```
    2. Extract:
       ```bash
       pnpm tsx apps/eval/voice/scripts/extract-pa-turns.ts --limit 200 > apps/eval/voice/fixtures/_extracted-raw.jsonl
       ```
    3. Pick 10 cases (3 vent / 3 question / 4 misc) and label PASS/FAIL + why per HITL-LABELING-GUIDE.md. Save as `apps/eval/voice/fixtures/_calibration-10.jsonl`.
    4. Sanity-check: `wc -l apps/eval/voice/fixtures/_calibration-10.jsonl` should be ≥10. Open in editor and confirm each line has `label`, `why`, `tags`.

    If schema is wrong or extraction fails (Firestore creds, query path, etc.) — pause and report. Planner will revise.
  </how-to-verify>
  <resume-signal>
    Type "calibration done" once `_calibration-10.jsonl` exists with 10 labeled cases.
    Or describe issues — e.g.:
    - "Firestore extraction returned 0 rows" → planner adds fallback to `pa_messages` collection
    - "Schema doesn't match `turns` shape DeepEval expects" → planner fixes converter
    - "I want to skip Firestore extract and hand-author 50 fictional cases" → planner regenerates from MILESTONE-v1.2.md anchor cases + Bible v5 examples
  </resume-signal>
</task>

<task type="auto">
  <name>Task 3: Generate synthetic + adversarial fixtures via Qwen3-8B</name>
  <read_first>
    - apps/eval/voice/scripts/generate-synthetic.ts (just built)
    - apps/eval/voice/fixtures/_calibration-10.jsonl (Adam's labels — informs synthetic generation prompt tone)
  </read_first>
  <files>
    apps/eval/voice/fixtures/synthetic-vent.jsonl,
    apps/eval/voice/fixtures/synthetic-cele.jsonl,
    apps/eval/voice/fixtures/synthetic-deflect.jsonl,
    apps/eval/voice/fixtures/adversarial-100.jsonl
  </files>
  <action>
    Run the synthetic generation script in 4 modes. Capture output to JSONL files.

    ```bash
    cd /Users/adam/Desktop/WeKruit/wekruit-pa
    export SILICONFLOW_API_KEY=<from secrets>
    pnpm tsx apps/eval/voice/scripts/generate-synthetic.ts --mode vent      > apps/eval/voice/fixtures/synthetic-vent.jsonl
    pnpm tsx apps/eval/voice/scripts/generate-synthetic.ts --mode cele      > apps/eval/voice/fixtures/synthetic-cele.jsonl
    pnpm tsx apps/eval/voice/scripts/generate-synthetic.ts --mode deflect   > apps/eval/voice/fixtures/synthetic-deflect.jsonl
    pnpm tsx apps/eval/voice/scripts/generate-synthetic.ts --mode adversarial > apps/eval/voice/fixtures/adversarial-100.jsonl
    ```

    Validate each output file is valid JSONL:
    ```bash
    for f in synthetic-vent synthetic-cele synthetic-deflect adversarial-100; do
      python3 -c "import json,sys; [json.loads(l) for l in open('apps/eval/voice/fixtures/${f}.jsonl') if l.strip()]; print('${f} ok')"
    done
    ```

    If `SILICONFLOW_API_KEY` not provisioned locally, this task may need to be deferred — document fallback in summary, label tagged `synthetic` cases as MEDIUM priority (they are NOT in the CI pass-rate gate; only golden-50 is). Anchor regression cases in golden-50 are the gating signal.

    All cases tagged `synthetic` and `<mode>` (no `regression-anchor` — that tag reserved for the 3 hand-authored anchors in plan 02 task 4). Label remains "UNLABELED" — Adam doesn't label synthetic cases manually; they're for adversarial CI runs only.
  </action>
  <verify>
    <automated>test -s apps/eval/voice/fixtures/synthetic-vent.jsonl && test -s apps/eval/voice/fixtures/synthetic-cele.jsonl && test -s apps/eval/voice/fixtures/synthetic-deflect.jsonl && test -s apps/eval/voice/fixtures/adversarial-100.jsonl && [ "$(wc -l < apps/eval/voice/fixtures/adversarial-100.jsonl)" -ge 50 ] && python3 -c "import json; [json.loads(l) for l in open('apps/eval/voice/fixtures/adversarial-100.jsonl') if l.strip()]"</automated>
  </verify>
  <acceptance_criteria>
    - 4 fixture files non-empty (synthetic-vent, synthetic-cele, synthetic-deflect, adversarial-100)
    - `adversarial-100.jsonl` has ≥50 lines (target 100; 50+ is acceptable for closed beta)
    - All JSONL files parse without error
    - Each line has `tags` containing `synthetic` and the mode tag
  </acceptance_criteria>
  <done>Synthetic + adversarial fixtures populated by Qwen3-8B.</done>
</task>

<task type="checkpoint:human-action" gate="blocking">
  <name>Task 4: Adam labels final golden-50 + 3 hand-authored anchor regression cases</name>
  <action>
    Adam-driven: hand-author 3 anchor regression cases (wekruit投递 / vent / celebrate per 24-RESEARCH.md), pull 47 more from _extracted-raw.jsonl, label each with PASS/FAIL + why + tags, save to apps/eval/voice/fixtures/golden-50.jsonl. Time budget ~2 hours one-time. See <how-to-verify>.
  </action>
  <what-built>
    - 10-case calibration done
    - Synthetic + adversarial fixtures generated
    - Labeling guide ready
  </what-built>
  <how-to-verify>
    Adam-driven (~2 hours one-time per MILESTONE-v1.2.md HITL Investment):

    1. **Hand-author 3 anchor cases** (do NOT extract — canonical content per 24-RESEARCH.md):
       - `golden-001`: tags `["regression-anchor","vent","zh","job-search"]` — user `我前两天投了一个wekruit岗位的工作，还没回信呢` → assistant `可能下周回. 也可能默拒. 别先 emo.` → label PASS, why "Short, no coach verbs, no steps, appropriate empathy"
       - `golden-002`: tags `["regression-anchor","vent","zh"]` — user `我焦虑死了` → assistant `来. 喘一下.` → label PASS, why "Sit-with response, no fix attempt, ≤2 sentences"
       - `golden-003`: tags `["regression-anchor","celebrate","zh"]` — user `我拿到offer了！！！` → assistant `卧槽 牛逼 哪家?` → label PASS, why "Hype reaction + short follow-up, no coach probe"

    2. **Pull 47 more cases from `_extracted-raw.jsonl`** — mix of: ~15 vent, ~10 celebrate, ~10 question, ~10 deflect, ~2 misc. For each: PASS/FAIL + one-sentence why + tags.

    3. **Save** `apps/eval/voice/fixtures/golden-50.jsonl` (50+ lines total — 3 anchor + 47 extracted-and-labeled).

    4. **Smoke test**:
       ```bash
       export ANTHROPIC_API_KEY=<your key>
       pnpm test:voice:anchors
       ```
       Expected: 3 anchor cases run against current production target. Some may fail (that's the point — current Bible v5 doesn't pass; Wave 1 plans 03/04/05 will fix). Confirm the score is RECORDED in eval-results/ artifact for baseline comparison.

    5. Commit `golden-50.jsonl` to git (LFS NOT required — file should be < 1MB).

    Time budget: ~2 hours. Use bursts of 30 min × 4.
  </how-to-verify>
  <resume-signal>
    Type "labeled" once `golden-50.jsonl` has ≥50 cases, ≥3 tagged `regression-anchor`, and `pnpm test:voice:anchors` recorded a baseline score.
    Or describe issues — e.g.:
    - "Anchors failing in confusing way" → planner inspects judge output, may adjust criteria
    - "Only have time for 30 cases" → planner accepts but flags as risk for CI gate threshold
    - "Want to use claude-sonnet-4-5 for cheaper bulk labeling sanity-check" → planner adds env override to conftest.py
  </resume-signal>
</task>

</tasks>

<verification>
1. `wc -l apps/eval/voice/fixtures/golden-50.jsonl` ≥ 50
2. `grep -c "regression-anchor" apps/eval/voice/fixtures/golden-50.jsonl` ≥ 3
3. `python3 -c "import json; [json.loads(l) for l in open('apps/eval/voice/fixtures/golden-50.jsonl') if l.strip()]"` exits 0
4. `python3 -c "import json,sys; rows=[json.loads(l) for l in open('apps/eval/voice/fixtures/golden-50.jsonl') if l.strip()]; assert all('label' in r and 'why' in r and 'tags' in r and 'turns' in r for r in rows), 'schema violation'"` exits 0
5. Baseline ClaireVoice pass-rate recorded (in `eval-results/` or summary doc).
</verification>

<success_criteria>
- `golden-50.jsonl` populated with ≥50 Adam-labeled cases
- 3 anchor regression cases hand-authored with canonical content
- Synthetic + adversarial fixtures populated by Qwen3-8B
- Baseline pass-rate recorded for plan 07 comparison
- HITL labeling guide preserved for future re-labeling cycles
</success_criteria>

<output>
Create `.planning/phases/24-voice-quality-baseline/24-02-SUMMARY.md` with:
- Final golden-50 case count + tag distribution (vent/celebrate/question/deflect/misc; zh/en/mixed)
- 3 anchor regression cases verbatim
- **Baseline ClaireVoice pass-rate** (the number to beat in plan 07)
- Synthetic generation cost (token count × Qwen3-8B free-tier rate ≈ $0)
</output>
