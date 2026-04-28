---
phase: 24-voice-quality-baseline
plan: 07
type: execute
wave: 4
depends_on: ["24-03", "24-04", "24-05", "24-06"]
files_modified:
  - apps/eval/voice/eval-results/24-07-final.json
  - .planning/STATE.md
  - .planning/RETROSPECTIVE.md
autonomous: false
requirements:
  - VOICE-07
  - VOICE-08

must_haves:
  truths:
    - "Full DeepEval suite green: ClaireVoice pass-rate ≥ baseline + 15pp."
    - "3 anchor regression cases (wekruit投递 + vent + celebrate) PASS the ClaireVoice rubric."
    - "Adam smoke test on real Sendblue line confirms voice subjectively reads as friend, not assistant."
    - "promptfoo A/B between Qwen3-8B (default) and Qwen3.5-4B (404 expected) recorded — Qwen3.5-4B status confirms still 404."
    - "Coach-token telemetry hits visible in BigQuery `pa.voice.coach_token.observed` within 24h of deploy."
    - "Cringe-warn (soft items 哈基米/yyds/city不city) flagged but NOT hard-banned (per VOICE-08 carryover from CONTEXT)."
    - "STATE.md updated to reflect Phase 24 closure."
    - "RETROSPECTIVE.md updated with v1.2 milestone learnings."
  artifacts:
    - path: "apps/eval/voice/eval-results/24-07-final.json"
      provides: "Final pass-rate snapshot vs baseline"
    - path: ".planning/phases/24-voice-quality-baseline/24-07-SUMMARY.md"
      provides: "Phase 24 closure summary"
  key_links:
    - from: ".planning/STATE.md"
      to: "Phase 24 closure status"
      via: "Status: Complete update"
      pattern: "Phase 24"
---

<objective>
Wave 2 (0.5 day per 24-CONTEXT.md): Verification + Adam smoke test + STATE/RETROSPECTIVE updates.

This is the gate plan that closes Phase 24. Aggregates all Wave 1 work (Bible v6 + few-shot + rewriter v2 + telemetry + dynamic typing) and validates against the regression net from Wave 0.

Pre-conditions (must be done before plan 07 starts):
- Plans 03/04/05/06 merged
- ANTHROPIC_API_KEY provisioned (deferred from plan 01 task 4)
- Cloud Functions redeployed with Bible v6 + Qwen3-8B rewriter + dynamic typing dwell
- `seed:agents:apply` run to push Bible v6 to Firestore agent record

Purpose: VOICE-07 (slang ≤1-2 per turn validated) + VOICE-08 (4-axis rubric operational with full pass-rate gate).
Output: Final eval result + Adam smoke pass + STATE/RETROSPECTIVE updates.
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
@.planning/phases/24-voice-quality-baseline/24-02-SUMMARY.md
@.planning/phases/24-voice-quality-baseline/24-03-SUMMARY.md
@.planning/phases/24-voice-quality-baseline/24-04-SUMMARY.md
@.planning/phases/24-voice-quality-baseline/24-05-SUMMARY.md
@.planning/phases/24-voice-quality-baseline/24-06-SUMMARY.md
@apps/eval/voice/MANUAL-SMOKE-TYPING.md
@apps/eval/voice/HITL-LABELING-GUIDE.md
</context>

<interfaces>
Phase 24 success criteria (MILESTONE-v1.2.md "Success Criteria"):
1. DeepEval `pnpm test:voice` runs locally + CI; PR blocks when ClaireVoice pass-rate < 75%.
2. Bible v6 shipped (DONE in plan 03).
3. 12 mes_examples relocated (DONE in plan 03).
4. Rewriter v2 default = Qwen3-8B (substituting Qwen3.5-4B per 24-RESEARCH.md finding 1) with diff guard, p95 ≤ 1.5s, fail-open (DONE in plan 04).
5. Telemetry-only regex log emitting (DONE in plan 05).
6. Dynamic typing dwell 1-4s (DONE in plan 06).
7. **3 anchor regression cases PASS on baseline rerun** ← THIS PLAN VALIDATES.
8. Cringe-warn over hard-ban (validated by absence of cringe items in Bible v6 hard-ban list).

Anchor cases (from `apps/eval/voice/fixtures/golden-50.jsonl` tagged `regression-anchor`):
1. wekruit投递: `我前两天投了一个wekruit岗位的工作，还没回信呢` → expected ≤2 sentences, no `我建议你`
2. vent: `我焦虑死了` → expected short empathy ≤2 sentences
3. celebrate: `我拿到offer了！！！` → expected hype + short, no coach probe

Pass-rate target: baseline + 15pp on overall ClaireVoice (CONTEXT.md Wave 2.2).
</interfaces>

<tasks>

<task type="checkpoint:human-action" gate="blocking">
  <name>Task 1: Adam provisions ANTHROPIC_API_KEY in GitHub Actions secrets + deploys CF with Bible v6 + Qwen3-8B</name>
  <action>
    Adam-driven infrastructure provisioning: set ANTHROPIC_API_KEY in GitHub Actions secrets, verify SILICONFLOW_API_KEY in GCP Secret Manager, deploy CF with Phase 24 env vars (PA_LLM_REWRITE_MODEL=Qwen/Qwen3-8B etc.), run seed:agents:apply to push Bible v6 to Firestore. Sandbox ping confirms CF alive. See <how-to-verify> for exact commands.
  </action>
  <what-built>
    Plans 03/04/05/06 implementations are committed. To run the full eval gate, infrastructure must be ready.
  </what-built>
  <how-to-verify>
    Adam-driven (truly cannot be automated — secret provisioning + production deploy):

    1. **Provision ANTHROPIC_API_KEY in GitHub Actions:**
       ```
       gh secret set ANTHROPIC_API_KEY -b "<key>"  # or via GitHub UI Settings → Secrets
       ```
       Verify: `gh secret list | grep ANTHROPIC`

    2. **Confirm SILICONFLOW_API_KEY in GCP Secret Manager:**
       (Already wired per Phase 21. Sanity check.)
       ```
       firebase functions:secrets:access SILICONFLOW_API_KEY
       ```

    3. **Deploy Cloud Functions with new env:**
       ```
       cd apps/functions
       # Set Phase 24 env vars
       firebase functions:config:set pa.llm_rewrite_model="Qwen/Qwen3-8B" \
                                     pa.llm_rewrite_fallback_model="Qwen/Qwen2.5-7B-Instruct" \
                                     pa.llm_rewrite_base_url="https://api.siliconflow.cn/v1"
       # Or set in .env file per repo convention; verify with apps/functions/.env.example
       pnpm deploy
       ```

    4. **Push Bible v6 to Firestore agent record:**
       ```
       npm run seed:agents:apply
       # Or pnpm tsx packages/agent-registry/src/seed-apply.ts
       ```
       Verify: open Firebase console → pa_agents collection → check default agent's systemPrompt contains `# IDENTITY` and fewShotMessages array length 24.

    5. **Smoke ping** Sendblue sandbox line to confirm CF is alive after deploy:
       Send `ping`. Should get a Claire reply (not 5xx, not silence).
  </how-to-verify>
  <resume-signal>
    Type "infra ready" once: ANTHROPIC_API_KEY in GH secrets, SILICONFLOW_API_KEY confirmed, CF deployed with Phase 24 env, Firestore agent has Bible v6 + fewShotMessages, sandbox ping works.
    Or describe issues — e.g.:
    - "Bible v6 push failed — Firestore validation error" → planner inspects seed-types.ts
    - "Qwen3-8B 404 from CF" → planner adds connectivity test before continuing
    - "Don't have ANTHROPIC_API_KEY budget approval yet" → planner offers fallback to claude-sonnet-4-5 judge for this run only
  </resume-signal>
</task>

<task type="auto">
  <name>Task 2: Run full DeepEval suite + record final pass-rate</name>
  <read_first>
    - apps/eval/voice/test_voice_baseline.py
    - apps/eval/voice/fixtures/golden-50.jsonl
    - .planning/phases/24-voice-quality-baseline/24-02-SUMMARY.md (baseline pass-rate to compare)
  </read_first>
  <files>
    apps/eval/voice/eval-results/24-07-final.json
  </files>
  <action>
    Step 1: Run anchor subset first (cheap, fast feedback):
    ```bash
    pnpm test:voice:anchors
    ```
    Expected: 3 anchor cases PASS the ClaireVoice rubric (≥0.7 each).
    If FAIL: stop. Inspect output. Likely root cause = Bible v6 not pushed to Firestore (re-run seed:apply), or rewriter v2 not deployed (re-deploy CF), or judge model API error (check ANTHROPIC_API_KEY).

    Step 2: Run full suite:
    ```bash
    pnpm test:voice
    ```
    Capture stdout to a log file. Extract:
    - Total cases run
    - ClaireVoice pass count + pass-rate
    - NoCoachMode pass count + pass-rate
    - Per-tag breakdown (vent / celebrate / question / deflect / regression-anchor)

    Step 3: Run promptfoo A/B (informational only — Qwen3.5-4B will 404):
    ```bash
    cd apps/eval/voice/promptfoo
    npx promptfoo eval -c rewriter-ab.yaml
    ```
    Expected: Qwen3-8B passes, Qwen3.5-4B 404s with model-not-found. Confirms 24-RESEARCH.md critical finding 1 still holds.

    Step 4: Write `apps/eval/voice/eval-results/24-07-final.json`:
    ```json
    {
      "phase": "24-voice-quality-baseline",
      "plan": "24-07",
      "run_at": "<ISO timestamp>",
      "judge_model": "claude-opus-4-5",
      "rewriter_model_default": "Qwen/Qwen3-8B",
      "rewriter_model_fallback": "Qwen/Qwen2.5-7B-Instruct",
      "qwen_3_5_4b_status": "404 (not in SF catalog as of run date)",
      "claire_voice_pass_rate": 0.X,
      "no_coach_mode_pass_rate": 0.Y,
      "baseline_pass_rate": <from plan 02 summary>,
      "delta_pp": <X - baseline>,
      "target_delta_pp": 15,
      "gate_passed": (delta >= 15 && claire_voice_pass_rate >= 0.75),
      "anchor_results": {
        "wekruit投递": "PASS" | "FAIL",
        "vent": "PASS" | "FAIL",
        "celebrate": "PASS" | "FAIL"
      },
      "all_three_anchors_pass": true | false,
      "tags_breakdown": {...}
    }
    ```

    Step 5: If `gate_passed=false`:
    - Capture verbatim failing-case output from stdout
    - Append to summary as "Gaps to address — defer to plan 08 (gap closure)" or escalate to Adam
    - Do NOT close phase. Open `/gsd:plan-phase 24 --gaps` cycle.

    If `gate_passed=true`:
    - Continue to task 3 (Adam smoke).
  </action>
  <verify>
    <automated>test -f apps/eval/voice/eval-results/24-07-final.json && python3 -c "import json; r=json.load(open('apps/eval/voice/eval-results/24-07-final.json')); assert 'claire_voice_pass_rate' in r; assert 'all_three_anchors_pass' in r; print('gate=', r.get('gate_passed'), 'anchors=', r.get('all_three_anchors_pass'))"</automated>
  </verify>
  <acceptance_criteria>
    - eval-results/24-07-final.json exists with all required fields (phase, plan, judge_model, rewriter_model_default, claire_voice_pass_rate, baseline_pass_rate, delta_pp, gate_passed, anchor_results, all_three_anchors_pass)
    - all_three_anchors_pass = true (else this plan does NOT close — file gap)
    - claire_voice_pass_rate >= 0.75 (CI gate threshold)
    - delta_pp >= 15 (Wave 2 acceptance per CONTEXT.md)
    - promptfoo A/B run executed and Qwen3.5-4B 404 confirmed (or its absence noted)
  </acceptance_criteria>
  <done>Eval gate green. 3 anchor cases PASS. Pass-rate ≥ baseline + 15pp.</done>
</task>

<task type="checkpoint:human-verify" gate="blocking">
  <name>Task 3: Adam smoke test on real Sendblue line — subjective "does this sound like a friend?"</name>
  <action>
    Adam-driven subjective verification: send 5 turns from real iMessage to Sendblue sandbox covering wekruit投递/vent/celebrate/deflect/long-technical scenarios. Rate each 1-5 on 'sounds like a friend'. Verify BigQuery telemetry alive 24h post-deploy. See <how-to-verify> for exact prompts and pass criteria.
  </action>
  <what-built>
    - All Wave 1 implementations live in production CF
    - Eval gate passed (task 2)
    - Manual smoke guides ready: HITL-LABELING-GUIDE.md and MANUAL-SMOKE-TYPING.md
  </what-built>
  <how-to-verify>
    Adam-driven subjective verification (cannot be automated — voice quality requires human judgment):

    Run 5 turns from real iMessage to Sendblue sandbox line covering the key failure modes from MILESTONE-v1.2.md:

    **Turn 1 (the original failure case):**
    Send: `我前两天投了一个wekruit岗位的工作，还没回信呢`
    Expected: ≤2 sentences, no `我建议你`, no numbered steps, no 4+ subordinate clauses. Should resemble `可能下周回. 也可能默拒. 别先 emo.`
    PASS criterion: voice reads as friend, not coach.

    **Turn 2 (vent):**
    Send: `我焦虑死了`
    Expected: short empathy like `来. 喘一下.` or `卷成这样 你怎么扛过来的.`
    PASS criterion: sit-with response, no fix attempt, no 5-step plan.

    **Turn 3 (celebrate):**
    Send: `我拿到offer了！！！`
    Expected: hype reaction + optional short follow-up.
    PASS criterion: no `保持积极心态`, no coach probe, genuine excitement.

    **Turn 4 (deflect):**
    Send: `你觉得我喜欢干嘛`
    Expected: deflect-mirror like `我又不是你妈. 你说你喜欢喝咖啡那就喜欢喝咖啡.`
    PASS criterion: appropriate sass, no over-interpretation.

    **Turn 5 (long technical):**
    Send: `详细解释一下 OPT 转 H1B 的时间线`
    Expected: longer (200+ chars), can use structured format only because user explicitly asked.
    PASS criterion: dwell ≈4s typing animation observed; reply not over-formatted.

    **Subjective gate:**
    For each turn, rate 1-5 on "does this sound like a friend?". Need ≥4 average and zero turn rated 1-2.

    **Telemetry verification (24h after smoke test):**
    Query BigQuery for `pa.voice.coach_token.observed` log events in last 24h:
    ```sql
    SELECT timestamp, JSON_VALUE(jsonPayload, '$.tokens') as tokens
    FROM `<project>.<dataset>.cloud_functions_logs`
    WHERE jsonPayload.event = 'pa.voice.coach_token.observed'
    AND timestamp > TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 24 HOUR)
    LIMIT 50
    ```
    PASS criterion: at least 1 hit visible (proves telemetry pipeline alive). Hits should be infrequent (low rate = rewriter v2 working).
  </how-to-verify>
  <resume-signal>
    Type "voice approved" once 5 turns subjectively pass (≥4/5 avg) AND BigQuery telemetry confirmed alive.
    Or describe issues — e.g.:
    - "Turn 1 still says `我建议你`" → planner opens `/gsd:plan-phase 24 --gaps` for rewriter v2 prompt revision
    - "Coach telemetry has 0 hits — pipeline broken" → planner inspects store.log wiring in plan 05
    - "Typing dwell feels off — 4s feels too long" → planner adjusts thresholds in plan 06 (gap fix)
  </resume-signal>
</task>

<task type="auto">
  <name>Task 4: Update STATE.md + RETROSPECTIVE.md for Phase 24 closure</name>
  <read_first>
    - .planning/STATE.md (current Phase 24 status: "Spec locked, PLAN.md not yet generated")
    - .planning/RETROSPECTIVE.md (if exists; create if not)
    - .planning/MILESTONE-v1.2.md (success criteria + closure language)
    - apps/eval/voice/eval-results/24-07-final.json (numerical results to cite)
    - All 24-XX-SUMMARY.md files in phase dir
  </read_first>
  <files>
    .planning/STATE.md,
    .planning/RETROSPECTIVE.md
  </files>
  <action>
    Edit 1: `.planning/STATE.md`

    Find the line `## Active milestone: v1.2 — Voice 拟人化 + Eval Foundation (spawned 2026-04-27)`. Update the Status block:

    ```markdown
    ## Active milestone: v1.2 — Voice 拟人化 + Eval Foundation (spawned 2026-04-27)

    See [`MILESTONE-v1.2.md`](./MILESTONE-v1.2.md).

    **Status:** Phase 24 (Voice Quality Baseline) **CLOSED** YYYY-MM-DD.
    - DeepEval foundation live (`apps/eval/voice/`, claude-opus-4-5 judge locked)
    - Bible v6 shipped (1.5kb structured split, 24 fewShotMessages)
    - Rewriter v2 on Qwen/Qwen3-8B (Qwen3.5-4B deferred — not in SF catalog)
    - Coach-token telemetry observation-only stream live
    - Dynamic typing dwell 1-4s by reply length
    - 3 anchor regression cases PASS (wekruit投递 / vent / celebrate)
    - Final pass-rate: <X>% (baseline +<Y>pp)
    - Adam smoke test: PASS

    **Phase 25 (Voice Self-Evolve)** stays in v1.3 backlog per MILESTONE-v1.2.md plan.
    ```

    Edit 2: `.planning/RETROSPECTIVE.md`

    If file does not exist, create it with header:
    ```markdown
    # Retrospectives

    Cross-milestone learnings — read by future planners (history-digest selection signal).
    ```

    Append a new section for v1.2:
    ```markdown
    ---

    ## Milestone v1.2 — Voice 拟人化 + Eval Foundation (closed YYYY-MM-DD)

    **Phases:** 24 (Voice Quality Baseline)
    **Estimate vs actual:** Planned 3 dev days + 3hr Adam HITL. Actual: <to fill>.

    ### What Worked
    - **Eval foundation FIRST** (Wave 0 sequenced before all voice changes) — caught regressions early. Without baseline pass-rate from plan 02, plans 03/04/05/06 would have shipped on vibes.
    - **Bible v6 IDENTITY/STYLE/REACTIONS split** — 50% size reduction (3.2kb → 1.5kb) freed nano context budget. Persona drift from attention-decay (arxiv 2402.10962) materially improved.
    - **Few-shot relocation to messages-array** — single highest-leverage change per arxiv 2401.06766. Style transfer ~3x stronger.
    - **Cringe-warn over hard-ban** — kept soft items (哈基米/yyds) in vocabulary; rubric flags but doesn't fail. Avoided over-correction.

    ### What Was Inefficient
    - **Qwen3.5-4B target turned out to be 404 on SiliconFlow** — caught at research time (24-RESEARCH.md critical finding 1), but Wave 1 still had to default to Qwen3-8B and document the swap. Lesson: validate model availability against live API catalog BEFORE locking in CONTEXT.md target.
    - **<think>...</think> stripping** — not anticipated in original CONTEXT.md; surfaced in research as Pitfall 2. Plan 04 had to add helper. Lesson: every Qwen3-family model has thinking-mode default; budget the strip helper.

    ### Patterns Established
    - 4-layer eval architecture (dataset × rubric × target × runner) → reusable for v1.3 self-evolve.
    - Telemetry-only regex tap pattern (Claude-Code-cursing-log style) → applicable to other observation streams.
    - Dynamic UX timing scaled by reply length → applicable to delivery feel beyond typing.
    - claude-opus-4-5 hardcoded as judge model (no `latest` aliases) → score-comparability across runs.

    ### Key Lessons
    - **Locking judge model is non-negotiable.** Every comparable run must use the same model ID.
    - **HITL bootstrap (10-case calibration before full 50)** caught labeling drift before it polluted the dataset. Worth the 30 min.
    - **Rewriter prompt failure exemplar (the wekruit投递 case in-prompt)** — small models learn from concrete bad/good pair faster than from abstract rules.
    - **Architectural changes (typing fire-on-reasoning-start) deferred is fine** — Phase 24 shipped without them. Document the limitation, move on.

    ### Cost Patterns
    - Claude opus-4-5 judge: ~$X per golden-50 run (record actual).
    - Qwen3-8B rewriter: free (SF tier). Per-turn cost ≈ $0.
    - Total v1.2 Claude API spend: ~$X (CI runs + Adam labeling sanity-checks).
    ```

    Replace `YYYY-MM-DD` with actual date and `<X>` placeholders with values from `eval-results/24-07-final.json`.
  </action>
  <verify>
    <automated>grep -q "Phase 24" .planning/STATE.md && grep -q "CLOSED" .planning/STATE.md && grep -q "Milestone v1.2" .planning/RETROSPECTIVE.md && grep -q "Bible v6" .planning/RETROSPECTIVE.md</automated>
  </verify>
  <acceptance_criteria>
    - STATE.md Phase 24 status updated to CLOSED with dated closure note (grep "Phase 24" + "CLOSED")
    - STATE.md cites final pass-rate + baseline delta + anchor results
    - RETROSPECTIVE.md has v1.2 section with What Worked / What Was Inefficient / Patterns Established / Key Lessons / Cost Patterns
    - Both files committed to git
  </acceptance_criteria>
  <done>STATE.md + RETROSPECTIVE.md updated. Phase 24 closed. v1.2 milestone state aligned for v1.3 spawn.</done>
</task>

</tasks>

<verification>
1. `cat apps/eval/voice/eval-results/24-07-final.json | python3 -c "import json,sys; r=json.load(sys.stdin); assert r['gate_passed'] is True and r['all_three_anchors_pass'] is True"` exits 0
2. `grep -q "Phase 24.*CLOSED\\|Phase 24.*Complete" .planning/STATE.md` exits 0
3. `grep -q "Milestone v1.2" .planning/RETROSPECTIVE.md` exits 0
4. Adam smoke test approval recorded in summary (subjective signal, but documented)
5. BigQuery telemetry hits visible (or telemetry validation gap noted in summary)
</verification>

<success_criteria>
- Full DeepEval pass-rate ≥ baseline + 15pp
- 3 anchor regression cases PASS
- Adam smoke test on Sendblue line PASS (≥4/5 average across 5 turns)
- Coach-token telemetry visible in BigQuery
- promptfoo A/B record (Qwen3-8B working, Qwen3.5-4B 404 — confirmed status)
- STATE.md + RETROSPECTIVE.md updated
- Phase 24 closed; v1.2 milestone gate satisfied
</success_criteria>

<output>
Create `.planning/phases/24-voice-quality-baseline/24-07-SUMMARY.md` with:
- Final pass-rate vs baseline (numerical)
- Anchor case results table (3 rows: wekruit / vent / celebrate)
- Adam smoke test record (5 turns + ratings)
- Coach-token telemetry sample hits (last 24h)
- promptfoo A/B record
- Open follow-ups for v1.3 (e.g. Qwen3.5-4B swap once SF adds it; per-user STYLE.delta from Phase 25 spec)
- Phase 24 close-out commit reference
</output>
