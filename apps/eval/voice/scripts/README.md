# apps/eval/voice/scripts/

Scripts for populating eval fixtures. Run order:

## 1. Extract real pa_turns (requires Firestore creds)

```bash
export GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account.json
# or: export FIREBASE_SERVICE_ACCOUNT_JSON='<raw json>'

pnpm tsx apps/eval/voice/scripts/extract-pa-turns.ts --limit 200 \
  > apps/eval/voice/fixtures/_extracted-raw.jsonl
```

Output: `_extracted-raw.jsonl` with UNLABELED pairs. Adam picks 50 and labels them
per HITL-LABELING-GUIDE.md.

## 2. Generate synthetic fixtures (requires SiliconFlow key)

```bash
export SILICONFLOW_API_KEY=<key>

pnpm tsx apps/eval/voice/scripts/generate-synthetic.ts --mode vent      > apps/eval/voice/fixtures/synthetic-vent.jsonl
pnpm tsx apps/eval/voice/scripts/generate-synthetic.ts --mode cele      > apps/eval/voice/fixtures/synthetic-cele.jsonl
pnpm tsx apps/eval/voice/scripts/generate-synthetic.ts --mode deflect   > apps/eval/voice/fixtures/synthetic-deflect.jsonl
pnpm tsx apps/eval/voice/scripts/generate-synthetic.ts --mode adversarial > apps/eval/voice/fixtures/adversarial-100.jsonl
```

Model: `Qwen/Qwen3-8B` (SiliconFlow free tier). NOTE: Qwen3.5-4B is NOT yet in SF
catalog (checked 2026-04-27). Swap via `--model` env var once available.

## 3. Label golden-50

See `../HITL-LABELING-GUIDE.md` for full labeling protocol.
