status: planning

# Phase 14 — PLAN

Six tasks. 14.1–14.5 are harness-side / dashboard. 14.6 is the
deploy-gate task — expected to be a no-op for `onPaInbound` because
all eval logic lives outside the deployed Cloud Function. Confirmed
explicit so P8 doesn't smuggle production code in.

## File-domain isolation map

| Task | Owns (write) | Reads (no write) |
|------|--------------|-------------------|
| 14.1 | `tests/scenarios/runner.mjs`, `tests/scenarios/README.md` (assertion DSL section) | `pa_turns` schema (read-only Firestore queries) |
| 14.2 | `tests/scenarios/judge.mjs` (NEW), `tests/scenarios/README.md` (judge section) | OpenAI client config from packages/agent-runtime (import only) |
| 14.3 | `tests/scenarios/scenarios/persona-drift-zh.yaml` (NEW), `tool-budget-parallel-zh.yaml` (NEW), `hallucination-1900-zh.yaml` (NEW), `tool-choice-cross-lingual-en.yaml` (NEW), `tool-choice-cross-lingual-ja.yaml` (NEW), `reset-then-no-recall-zh.yaml` (NEW), `prompt-injection-in-fact-zh.yaml` (NEW), `tone-judge-zh.yaml` (NEW) | runner.mjs (depends on 14.1 DSL) |
| 14.4 | `package.json` (root, "scripts" key only — `eval` script), `.github/workflows/eval.yml` (NEW), `.gitignore` (add `eval-runs/`) | runner.mjs |
| 14.5 | Operations dashboard files (TBD by P8 discovery — likely `apps/web-ops/...`) | `pa_turns` schema |
| 14.6 | none (verification-only task) | all of above |

**Parallelism**: 14.1 and 14.2 can run in parallel (no file overlap).
14.3 depends on 14.1 (needs new DSL). 14.4 depends on 14.1, 14.2, 14.3.
14.5 is fully independent and can run in parallel with all others.
14.6 runs last.

**Phase 11.3 file-domain check**: 11.3 touches
`packages/memory/`, `packages/orchestrator/`, `packages/agent-runtime/`,
`packages/connectors/` (the `mem0UserId` migration cuts across 4
packages). Phase 14 touches **`tests/scenarios/`**, root
`package.json`, `.github/workflows/`, and `apps/web-ops/`. **Zero
overlap**. Phase 14 can run fully parallel with Phase 11.3.

## Tasks — P8 Task Prompts

---

### 14.1 — Extend runner DSL with structured assertions

**WHY**: Today's runner only does string/regex match on the reply body.
We have rich telemetry in `pa_turns.usage` (10.5) and confirmed
`MemoryFact` rows (11.1) but the harness ignores them, so a scenario
can pass while quietly burning 20k tokens or skipping a required tool
call. Phase 14 closes this by reading the telemetry from the same
Firestore the runner already connects to.

**WHAT**: Extend `applyAssertions` (and add a post-turn telemetry-read
step) in `tests/scenarios/runner.mjs` to support:

- `tool_call_required: string[]` — passes if every named tool appears
  in `pa_turns.usage.hostedToolCalls[*].name` for the turn's event.
- `tool_call_forbidden: string[]` — fails if any named tool appears.
- `usage_max_input_tokens: number`, `usage_max_total_tokens: number` —
  fail if `pa_turns.usage.{inputTokens,totalTokens}` exceeds.
- `persona_facts_present: boolean` — query `pa_users` by participant,
  then `memory_facts` (or wherever 11.1 persists confirmed facts —
  P8 must verify the collection name from `packages/memory/`) for
  `status === "confirmed"`. Pass if presence matches the bool.
  Run BEFORE the turn fires (not after) so it's testing seed state.
- All new keys are optional. Existing scenarios MUST continue to pass
  unmodified.

**WHERE**:
- Edit only: `tests/scenarios/runner.mjs`
- Edit only: `tests/scenarios/README.md` (assertion DSL section,
  add a row per new key)
- Read-only: `pa_turns` Firestore collection schema (consult
  `packages/orchestrator/` types, do NOT modify them)

**HOW MUCH**: ~150 LoC additive in runner.mjs. README ~30 lines added.

**DONE** (verification commands):
- `PA_RUN_SCENARIOS=1 GOOGLE_APPLICATION_CREDENTIALS=... node tests/scenarios/runner.mjs tests/scenarios/scenarios/`
  — all 11 existing scenarios still pass (no behavior change for them)
- Add 2 throwaway test scenarios under `tests/scenarios/scenarios-tmp/`
  exercising each new key (one positive, one negative). Run them and
  confirm correct pass/fail. Delete after.
- Type-check: `npm run -w … check` (whatever the repo uses) clean.

**DON'T**:
- Don't modify any existing scenario YAML.
- Don't introduce a new test framework.
- Don't read or write `onPaInbound` source.
- Don't add `axios`/`got`/new HTTP libs — runner.mjs already has
  `firebase-admin`; use that.

---

### 14.2 — LLM-as-judge harness module

**WHY**: Tone, persona consistency, and "did the agent refuse?" cannot
be expressed as substring matches. We need a judge model. Per CONTEXT
§2 we picked `gpt-5.4-nano` reusing `PA_OPENAI_AGENT_API_KEY`.

**WHAT**: New file `tests/scenarios/judge.mjs` exporting
`runJudge({ criterion, threshold, reply, transcript }) → { verdict,
confidence, rationale }`. Use the OpenAI Responses API with a forced
tool-output schema (verdict enum, confidence number 0-1, rationale
string). Wire it into `runner.mjs` as the `judge` assertion key:

```yaml
assert:
  judge:
    criterion: "reply is concise and friendly"
    threshold: 0.7
```

Threshold compared against `confidence` when `verdict === "pass"`;
`verdict === "fail"` is always a turn failure.

Persist every judge call (input criterion, reply, full response) to
`eval-runs/<runStamp>/judge.jsonl`. The runStamp is generated by the
runner at start of run.

**WHERE**:
- Create: `tests/scenarios/judge.mjs`
- Edit: `tests/scenarios/runner.mjs` (call site only — depends on
  14.1 landing first if both touch runner.mjs simultaneously, so
  serialize 14.2's runner edit AFTER 14.1)
- Edit: `tests/scenarios/README.md` (add Judge section)
- Read-only: `packages/agent-runtime/` for the OpenAI client init
  pattern (DO NOT import production runtime; just match the
  `PA_OPENAI_AGENT_API_KEY` + base URL convention)

**HOW MUCH**: ~120 LoC for `judge.mjs`. ~30 LoC call site in runner.

**DONE**:
- `PA_RUN_EVAL=1 PA_OPENAI_AGENT_API_KEY=... GOOGLE_APPLICATION_CREDENTIALS=...
  node tests/scenarios/runner.mjs tests/scenarios/scenarios/tone-judge-zh.yaml`
  passes (after 14.3 lands the scenario).
- A throwaway negative-criterion scenario (e.g. "reply must be in
  Russian") returns `verdict: "fail"` and turn fails as expected.
- `eval-runs/<stamp>/judge.jsonl` exists and is well-formed JSONL.

**DON'T**:
- Don't call the judge from inside `onPaInbound`. Judge is harness-only.
- Don't use a different model family. Stick with the production key.
- Don't bake the criterion text into runner.mjs — it comes from the
  scenario YAML, per-turn.
- Don't retry judge calls more than once on transient error.

---

### 14.3 — Add 7 new eval-grade scenarios

**WHY**: Rule-based and judge-based axes are useless without scenarios
that exercise them. CONTEXT lists the seven concrete probes.

**WHAT**: Author the 7 YAML files listed in the file-domain map. Each
must:
- Use a fresh reserved `+1999999xxxx` participant.
- Set `suppressOutbound: true` semantics (default in runner — verified
  via `verifySuppressOutbound: true` not being set to false).
- Set realistic `replyTimeoutMs` (live web_search scenarios need ≥120s
  per 10.5's observed turn timing).
- Mix at least one `usage_max_*` cap and one `tool_call_*` assertion
  per scenario where applicable.
- Include a `description` block describing the AXIS being tested
  (mirror the operator caveat style of `tool-budget-stress-zh`).

**WHERE**: `tests/scenarios/scenarios/<file>.yaml` × 7. Strictly new
files. No edits to existing YAMLs.

**HOW MUCH**: ~80 lines per scenario × 7 ≈ ~560 LoC YAML.

**DONE**:
- Each new scenario passes individually against production:
  `PA_RUN_SCENARIOS=1 ... node tests/scenarios/runner.mjs <one yaml>`
- Full directory run still passes 11/11 existing.
- Combined directory run passes 18/18.
- For `tool-budget-parallel-zh`: confirm `pa_turns.usage.hostedToolCalls`
  shows `remember-fact` connector × 2 invocations (or whatever the
  remember-fact telemetry shape is — capture and document in the
  scenario description).

**DON'T**:
- Don't modify existing scenarios' assertions.
- Don't pin participants outside `+1999999xxxx` range.
- Don't omit `__PA_RESET__` as turn 1 for any scenario that asserts on
  fresh state.
- Don't write a scenario whose only assertion is a judge call —
  always include at least one rule-based assertion as a deterministic
  floor.

---

### 14.4 — `npm run eval` script + GitHub Action

**WHY**: We must NOT pollute `npm test` with broker-injection runs
(per existing `PA_RUN_SCENARIOS` gate) AND we want a structured
artifact path. `npm run eval` becomes the single entry point.

**WHAT**:
1. Add to root `package.json` `scripts`:
   ```
   "eval": "PA_RUN_EVAL=1 node tests/scenarios/runner.mjs tests/scenarios/scenarios/"
   ```
   Note: the runner gates judge calls behind `PA_RUN_EVAL=1`. If
   unset, judge assertions are SKIPPED with a warning (so a
   non-eval `PA_RUN_SCENARIOS=1 npm test` doesn't accidentally
   bill OpenAI).
2. Create `.github/workflows/eval.yml`:
   - Triggers: PR `labeled` with `run-eval`, `schedule` cron daily,
     `workflow_dispatch`.
   - Steps: checkout, setup node, restore secrets (FIREBASE_SERVICE_ACCOUNT_JSON,
     PA_OPENAI_AGENT_API_KEY), `npm ci`, `npm run eval`, upload
     `eval-runs/` as artifact.
3. Add `eval-runs/` to `.gitignore`.
4. Implement `PA_EVAL_MAX_RUN_USD` (default 5) cost ceiling in the
   runner's cost ledger; abort + fail loud if exceeded.

**WHERE**:
- Edit: root `package.json` (scripts key ONLY).
- Create: `.github/workflows/eval.yml`.
- Edit: root `.gitignore`.
- Edit: `tests/scenarios/runner.mjs` (cost ceiling — adds maybe 30
  LoC; serialize after 14.1 + 14.2).

**HOW MUCH**: ~70 LoC workflow YAML. ~40 LoC runner edits.

**DONE**:
- `npm run eval` works locally with proper env vars set.
- Workflow YAML lints (`actionlint` if available, otherwise dry-push
  to a throwaway branch and confirm GitHub parses it).
- Setting `PA_EVAL_MAX_RUN_USD=0.001` in a manual run aborts mid-run
  with a clear message.
- PR-label trigger fires on a test PR.

**DON'T**:
- Don't trigger on `pull_request` default events. Label only.
- Don't store secrets in the workflow file itself; use Actions secrets.
- Don't add the workflow to required checks (false positives would
  block merges — see Risks).

---

### 14.5 — Operations dashboard cost panel

**WHY**: Closes carry-over: 10.5 logs `pa_turns.usage` but no panel
visualizes it. Without a panel, regressions land silently.

**WHAT**: Add a "Token Cost" section to the existing Operations
dashboard with:
- Time-series chart of p50/p95/p99 input + total tokens, grouped by
  `pa_turns.usage.model`. Last 24h.
- Bar chart of hosted-tool call counts per name.
- Threshold callout: turns with `hostedToolCalls.length === 0` AND
  `inputTokens > 5000`. (Distinguishes search-amplified from genuine
  prompt bloat.)

**WHERE**: P8 must first **discover** which app owns the Operations
dashboard. Likely candidates: `apps/web-ops/` or `apps/admin-console/`.
P8 confirms by reading the repo's app directory structure, then writes
ONLY to that app's dashboard subtree.

**HOW MUCH**: TBD pending discovery. Estimate ~200 LoC component +
query.

**DONE**:
- Panel renders against staging/prod data.
- p95 threshold callout is visible on a synthetic high-input turn
  (P8 generates one via the harness).
- Code review approves no new external observability vendor pulled in
  (use whatever the existing dashboard already uses — probably
  Recharts or a similar in-repo chart lib).

**DON'T**:
- Don't add a new vendor SDK (Datadog, Grafana Cloud, etc.) — out of
  scope for Phase 14.
- Don't write to Firestore from the dashboard. Read-only.
- Don't touch any other Operations dashboard panel.

---

### 14.6 — Production deploy gate (verification only)

**WHY**: Sanity-check that Phase 14 ships **zero** Cloud-Function
changes. We've designed it that way; this task confirms.

**WHAT**:
- Run `git diff main...HEAD -- apps/onPaInbound packages/orchestrator
  packages/agent-runtime packages/memory packages/connectors`. The
  diff MUST be empty.
- Run the full scenario suite (18 scenarios, includes new ones) against
  current production `onPaInbound`. All pass.
- Confirm `pa_outbound = 0` for harness events across the run.

**WHERE**: read-only verification.

**HOW MUCH**: < 30 minutes.

**DONE**:
- Empty diff against listed paths.
- 18/18 scenario pass.
- Zero `pa_outbound` rows for `harness_*` event ids in the run window.

**DON'T**:
- If diff is non-empty, STOP. Escalate to P9 — Phase 14 boundaries
  were violated. Do not "just deploy it."

---

## Goal-backward verification matrix

| Phase 14 goal | Evidence at end of phase |
|---------------|--------------------------|
| Multi-axis assertion DSL | 14.1 DONE; throwaway scenarios prove each new key |
| LLM-judge integrated, bounded, auditable | 14.2 DONE; `eval-runs/<stamp>/judge.jsonl` exists; cost ceiling fires when set artificially low |
| 7 new eval scenarios | 14.3 DONE; 18/18 directory run |
| `npm run eval` separate from `npm test` | 14.4 DONE; `npm test` does NOT call judge |
| Cost dashboard | 14.5 DONE; panel renders; alert callout visible |
| Zero production-runtime change | 14.6 DONE; empty diff |
| `suppressOutbound` red line preserved | 14.6 DONE; zero pa_outbound for harness events |

## Risk register

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| **Judge-model bias** (gpt-5.4-nano agreeing with itself) | Medium | Medium — false-pass on tone | Use judge ONLY for axes rule-based can't cover; log full rationale; require human review of any judge-driven merge-block; threshold ≥0.7 not 0.5 |
| **Eval cost runaway** (loop, retry storm) | Low | Low — capped at ~$5/run | `PA_EVAL_MAX_RUN_USD` hard ceiling; runner aborts |
| **False positives blocking merges** | Medium | High if eval is required check | Eval is NOT a required PR check; label-triggered only |
| **`pa_turns.usage.hostedToolCalls` doesn't get populated for some tool** (per 10.5 carry-over #3 about deferred audit) | Medium | Medium — `tool_call_required` flakes | Document in 14.1: scenarios using `tool_call_required` MUST verify the tool's telemetry exists in production first; if not, fall back to `usage_max_input_tokens` heuristic (search turns burn 8k+ tokens) |
| **Reserved participant collision** under heavier scenario count | Low | Low | Existing `generateReservedHarnessParticipant` already handles 10000-suffix space; 18 scenarios is well below |
| **Mem0 rate limit on parallel eval scenarios** | Medium | Medium | Existing 429 retry in runner; serialize directory run (already alphabetical) |
| **Dashboard panel breaks existing layout** | Low | Low | Additive panel only; 14.5 reviews CSS/layout |
| **Secrets leak via uploaded `eval-runs/` artifact** | Low | High | judge.jsonl MUST NOT contain `PA_OPENAI_AGENT_API_KEY` or service-account JSON; add a redaction pass before write; review in 14.4 DONE |
| **Hosted web_search billing** silently grows with scenario count | Low | Low | CONTEXT cost section accounts; `searchContextSize` already pinned to "low" |
| **Phase 11.3 lands first and changes `userId` semantics** mid-flight | Low | Medium | 14.1's `persona_facts_present` query keys on `userId` not `mem0UserId`, matching 11.1 lock; safe regardless of 11.3 timing |

## Open questions for P9 review

1. Should LLM-judge also run on the existing 11 scenarios as a
   shadow eval (no merge-block), to baseline the judge's tone
   verdict? Suggest **yes** but mark as 14.7 stretch task.
2. Operations dashboard discovery — is there a known doc P8 should
   start from? If not, 14.5 starts with `find apps -name "*.tsx"
   -path "*ops*"` and reads README files.
3. Cost ceiling default $5 — too high or too low? Eval projection is
   $0.06/run, so $5 is 80x headroom. Suggest leave at $5; tune down
   in Phase 16 once we have run history.
