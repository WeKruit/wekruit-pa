# iter30 WS4-A — LLM-judge baseline preservation plan

**Owner**: WS4-A engineer.
**Status (this branch)**: pre-deploy. Migration script written but not yet applied to production Firestore. Rebaseline tests deferred until production Firestore migration is applied + functions deployed.

## Why this gate exists

iter28-29 was the first time PA hit ≥0.93 on vent-realistic and 0/30 on AB framework drift. That came from:

1. Existing 6 playbooks' addenda (vent / headhunter / motivation / jd_roast / interview / negotiation).
2. Bible v7.6 hard rules.
3. Voice imperfection-injector + LLM rewriter.

iter30 WS4-A migrates the V1 playbook docs to V2 metadata (intentDescription, provides, requires, composableWith, conflictsWith, priority, allowedTools, llmInvokable). The 6 addenda + regexTriggers are **UNCHANGED** by this WS — only metadata is added.

A rebaseline regression here would mean the new SkillStacker logic is dropping addenda or reordering them in a way that confuses the model. **Hard gate** — any regression blocks WS4-A close per ws-4a-detail.md §9.

## Target thresholds (≤0.02 variance tolerance)

| Baseline file | iter28-29 production score | iter30 minimum |
|---|---|---|
| `tests/scenarios/playbooks-iter20/iter28-judge-vent-realistic.yaml` | ≥0.93 (typical 0.95-0.97) | ≥0.93 |
| `tests/scenarios/playbooks-iter20/iter28-judge-headhunter.yaml` | ≥0.86 (typical 0.88-0.92) | ≥0.86 |
| `tests/scenarios/playbooks-iter20/iter28-judge-negotiation.yaml` | ≥0.86 (typical 0.87-0.90) | ≥0.86 |
| 30-turn AB-framework drift | 0/30 hits | 0/30 maintained |

## Rebaseline procedure

### Step 1 — pre-migration snapshot (production)

Run all 4 baselines against current production state (V1 schema + 6 playbooks). This is the reference point. Output recorded into `baseline-pre-iter30.json`:

```bash
GOOGLE_APPLICATION_CREDENTIALS=$SA_PATH \
PA_RUN_EVAL=1 \
PA_OPENAI_AGENT_API_KEY=$OPENAI_KEY \
node tests/scenarios/runner.mjs \
  tests/scenarios/playbooks-iter20/iter28-judge-vent-realistic.yaml \
  tests/scenarios/playbooks-iter20/iter28-judge-headhunter.yaml \
  tests/scenarios/playbooks-iter20/iter28-judge-negotiation.yaml \
  --json > tests/scenarios/playbooks-iter30/baseline-pre-iter30.json
```

### Step 2 — apply migration

```bash
# DRY-RUN (default) — print 6 diffs, no write.
node apps/functions/scripts/migrate-skills-v2.mjs

# APPLY — writes 6 docs + 6 audit rows.
node apps/functions/scripts/migrate-skills-v2.mjs --apply
```

Idempotency guarantee: re-running with `--apply` re-writes the same metadata + bumps version. To revert: invoke `revertPlaybook(db, key)` per skill.

### Step 3 — deploy functions (V2 router enabled OFF)

```bash
cd apps/functions && pnpm run deploy
```

Predeploy gate enforces:
- All workspaces build clean
- pa-orchestrator typecheck + test (476 cases)

### Step 4 — post-migration rebaseline

Same command as Step 1 with output to `baseline-post-iter30.json`. Per-scenario score MUST be `≥ pre_iter30_score - 0.02`. AB-drift: 0/30 maintained — any hit fails the gate hard.

### Step 5 — diff report

`tests/scenarios/playbooks-iter30/iter30-rebaseline-report.md` — green/red per scenario + diff explanation if any score moved.

## Why this WS is **safe by design**

The rebaseline gate is unlikely to fail because:

1. **Addenda + regexTriggers UNCHANGED** by this WS. Migration script only writes the 8 new fields.
2. **SkillRouter feature-flagged OFF** by default (`paSkillsLlmFallbackEnabled` defaults `false`). Existing `matchCachedPlaybooks` path remains active; `SkillStacker` only fires when the flag flips.
3. **Backward-compat invariant unit-tested** — every V1 doc parses through `fromSkillSnap` with all 8 new fields default-filled. Existing readers (`playbook-cache.ts`, `composePlaybooks`) operate on the V1 superset and produce identical output.

Failure modes if rebaseline DOES regress:
- `priority` table puts conflict resolution wrong — bisect to `EXISTING_6_METADATA` and adjust.
- `composableWith` / `conflictsWith` drops a legitimate skill — covered by SkillStacker unit tests for the 6 known pairs.

## Live scenario verify (CLAUDE.md "verify by doing")

After deploy, per CLAUDE.md mandate:

- 1 zh + 1 en realistic message per existing 6 skills via `node tests/scenarios/runner.mjs <yaml>` — 12 runs.
- Long-context check: ≥10-turn scenario invoking ≥2 skills (vent → motivation transition); inspect mirror-score / repeat-advice / length compliance.

Both blocked on production Firestore migration apply + functions deploy. Rebaseline gate enforced by P10 calling agent post-merge.
