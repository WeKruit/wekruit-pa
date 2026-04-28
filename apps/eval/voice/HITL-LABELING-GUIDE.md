# HITL Labeling Guide — Phase 24 / Plan 02

**Owner:** Adam  
**Time budget:** ~2 hours one-time (4x 30-min bursts)  
**Output:** `apps/eval/voice/fixtures/golden-50.jsonl`

---

## Overview

The golden-50 dataset is the ground-truth regression net for every voice eval.
Without it, the judge has nothing to gate against. This guide walks you through
a 5-step process: extract real turns, do a 10-case calibration, then label 50 total.

---

## Step 1: Extract real pa_turns from Firestore

Requires Firebase Admin credentials for the production project.

```bash
export GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account.json
# OR: export FIREBASE_SERVICE_ACCOUNT_JSON='<raw json string>'

pnpm tsx apps/eval/voice/scripts/extract-pa-turns.ts --limit 200 \
  > apps/eval/voice/fixtures/_extracted-raw.jsonl

wc -l apps/eval/voice/fixtures/_extracted-raw.jsonl  # should be ~200
```

If extraction returns 0 rows, try:
- Check `GOOGLE_APPLICATION_CREDENTIALS` is set and points to a valid file
- Try `--collection pa_turns` flag (falls back automatically, but can force it)
- Check Firestore rules allow service account read on `pa_messages`

---

## Step 2: 10-case calibration session (CHECKPOINT)

Before labeling all 50, do a 10-case calibration to anchor your judgment.

Pick 10 cases from `_extracted-raw.jsonl` covering:
- 3 vent messages (焦虑/累/frustrated)
- 3 question messages (how to / 怎么)
- 4 misc (celebrate / deflect / other)

For each case, fill in `label`, `why`, `tags`, then save as `fixtures/_calibration-10.jsonl`.

```bash
wc -l apps/eval/voice/fixtures/_calibration-10.jsonl  # should be 10
```

**Stop and report the calibration file** so the agent can sanity-check schema + quality
before you commit to all 50.

---

## Step 3: Label the full golden-50

After calibration checkpoint passes, label 50 total.

**JSONL schema** (each line is one JSON object):
```json
{
  "id": "golden-001",
  "context": [],
  "turns": [
    {"role": "user", "content": "..."},
    {"role": "assistant", "content": "..."}
  ],
  "label": "PASS",
  "why": "Short, no coach verbs, appropriate empathy",
  "tags": ["vent", "zh", "regression-anchor"],
  "verified_at": "2026-04-28"
}
```

---

## Step 4: Hand-author 3 anchor regression cases

These 3 cases MUST be typed by hand (do NOT extract from Firestore) so the canonical
content exactly matches the 24-RESEARCH.md spec. They are the minimum CI gate.

```json
{"id":"golden-001","context":[],"turns":[{"role":"user","content":"我前两天投了一个wekruit岗位的工作，还没回信呢"},{"role":"assistant","content":"可能下周回. 也可能默拒. 别先 emo."}],"label":"PASS","why":"Short, no coach verbs, no steps, appropriate low-key empathy for wekruit投递 scenario","tags":["regression-anchor","vent","zh","job-search"],"verified_at":"2026-04-28"}
{"id":"golden-002","context":[],"turns":[{"role":"user","content":"我焦虑死了"},{"role":"assistant","content":"来. 喘一下."}],"label":"PASS","why":"Sit-with response, no fix attempt, ≤2 sentences — canonical vent anchor","tags":["regression-anchor","vent","zh"],"verified_at":"2026-04-28"}
{"id":"golden-003","context":[],"turns":[{"role":"user","content":"我拿到offer了！！！"},{"role":"assistant","content":"卧槽 牛逼 哪家?"}],"label":"PASS","why":"Hype reaction + short curiosity follow-up, no coach probe, no steps — canonical celebrate anchor","tags":["regression-anchor","celebrate","zh"],"verified_at":"2026-04-28"}
```

---

## Labeling Rules

### PASS criteria (all must be true):
- Reply is ≤2 sentences
- No `我建议你` / `你应该` / `保持积极心态` / `你的感受是合理的`
- No numbered steps or markdown bullets
- No pop-therapy phrases: `接住你` / `硬撑着` / `hold space`
- Code-switch matches user (zh reply for zh user, en for en)
- At most 1 emoji — hierarchy: 💀>😭>🥲, **NEVER 😂**
- ≤1 verified slang term (not stacked)
- Tone matches scenario: vent→sit-with, celebrate→hype, question→straight answer

### FAIL criteria (any one triggers FAIL):
- Numbered steps (1. 2. 3.) or markdown bullet list (`-` / `*`)
- Coach-mode verbs: `我建议你` / `你应该` / `我推荐` / `不妨试试` / `总之要相信自己`
- Probe question at end after 3+ sentences ("你觉得呢?", "有没有想过?")
- 4+ subordinate clauses in single reply
- Pop-therapy: `接住你` / `硬撑着` / `hold space` / `听起来你`
- Hard-ban slang (confirmed dead 2026): `"no cap"` / `"sus"` / `"bussin"` / `"slay"` / `"bet"` / `"gyatt"` / `"听我说谢谢你"`

### Cringe-WARN (label PASS but add `"cringe-warn"` tag):
- `哈基米` / `yyds` / `city不city` / `蚌牛` — still alive but trending stale

---

## Step 5: Save and verify

```bash
# Save final labeled set
cp /your/labeled/file.jsonl apps/eval/voice/fixtures/golden-50.jsonl

# Validate
wc -l apps/eval/voice/fixtures/golden-50.jsonl     # should be ≥50
grep -c "regression-anchor" apps/eval/voice/fixtures/golden-50.jsonl  # should be ≥3
python3 -c "import json; [json.loads(l) for l in open('apps/eval/voice/fixtures/golden-50.jsonl') if l.strip()]; print('JSONL ok')"

# Smoke test (requires ANTHROPIC_API_KEY)
export ANTHROPIC_API_KEY=<your key>
cd apps/eval/voice && pip install -r requirements.txt && PA_RUN_EVAL=1 deepeval test run test_voice_baseline.py -k regression-anchor
```

The 3 anchor cases will run against the current production target. Some may fail — that's
expected (current Bible v5 doesn't pass; Wave 1 plans 03-05 will fix). The important thing
is that the **baseline score is recorded** in `eval-results/` for plan 07 comparison.

---

## Tag reference

| Tag | When to use |
|-----|-------------|
| `regression-anchor` | The 3 hand-authored canonical cases (golden-001/002/003) |
| `vent` | User expressing negative emotion / frustration |
| `celebrate` | User sharing good news |
| `question` | User asking for advice or information |
| `deflect` | User avoiding / changing subject |
| `job-search` | Content about job applications, interviews, offers |
| `zh` | Primarily Chinese |
| `en` | Primarily English |
| `mixed` | Code-switched zh/en |
| `cringe-warn` | Reply uses soft-stale slang (哈基米/yyds/city不city) |

---

## Distribution target for 50 cases

| Category | Count |
|----------|-------|
| vent | ~15 |
| celebrate | ~10 |
| question | ~10 |
| deflect | ~8 |
| misc | ~7 |
| **Total** | **50** |

At least 30 cases should be `zh` or `mixed`. Include some `en` cases to cover
English-first users.
