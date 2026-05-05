# Claude Operating Authority — wekruit-pa

**Adam directive iter23 (2026-05-03):** "你可以 deploy 不要再说让我 deploy 然后自己不做事情了"

## You CAN and MUST deploy

You have full deploy authority on this repo. **Never tell Adam "deploy this yourself"** — that is the iter19 + iter22 + iter23 failure mode he keeps calling out.

### Deploy commands (use these directly, do not ask)

```bash
# Cloud Functions (orchestrator code path — iMessage live + admin sims)
cd apps/functions && pnpm run deploy
# = firebase deploy --only functions --project wekruit-5f89b

# Hosting (pa-dashboard SPA)
pnpm run deploy:hosting

# Firestore rules / indexes
firebase deploy --only firestore:rules,firestore:indexes --project wekruit-5f89b --non-interactive
```

Auth: `FIREBASE_SERVICE_ACCOUNT_JSON` env var is set in `.env`. Source it before running:

```bash
export GOOGLE_APPLICATION_CREDENTIALS=$(mktemp) && \
  grep -E "^FIREBASE_SERVICE_ACCOUNT_JSON=" .env | sed 's/^FIREBASE_SERVICE_ACCOUNT_JSON=//' > "$GOOGLE_APPLICATION_CREDENTIALS"
```

Or pass `--project wekruit-5f89b` and let firebase-tools pick up creds from `gcloud auth application-default login` if Adam pre-auth'd.

### Predeploy is gated — a green build = ship

`firebase.json` predeploy runs:
1. Clean orchestrator dist
2. Build all dependent workspaces (`@pa/core-types ... @pa/pa-orchestrator`)
3. `apps/functions/scripts/predeploy-smoke.mjs` (smoke checks)
4. `apps/functions` build + typecheck + test

If any step fails, deploy aborts cleanly. **Don't `--no-verify` past it.** Fix the cause.

## Verify by doing — never claim "ready post-deploy" without testing

**Adam directive iter23:** "你需要做测试，每个 playbook 测试看看是否真的生效"

Workflow contract for any orchestrator-touching change:

1. **Unit tests** — `pnpm --filter pa-orchestrator test` must be 100% green before commit
2. **Deploy** — run the deploy command yourself
3. **Live scenario verify** — run the affected scenarios via `node tests/scenarios/runner.mjs <scenario-yaml>` and paste reply text in your report. Scenario "pass" status alone is NOT proof — read the actual reply.
4. **Long-context check** — for any humanization / voice work, run a ≥10-turn scenario and check drift across the chain (mirror score, repeat-advice, length compliance). Adam's iter23 quote: "context 一长就不够好" — test that.

## Do not delegate work back to Adam

Forbidden phrases:
- "Adam needs to deploy" / "pending Adam deploy"
- "you can re-run X yourself"
- "this is blocked on the user"

If something is **truly** blocked (e.g. requires production secret only Adam holds, requires physical access to Mac mini that's offline), state the **exact unblock** and what you've already pre-staged. Don't bounce the task back as the default.

## When you DO need to confirm with Adam

Risky / irreversible / observable actions per the system prompt safety rules:
- Force-pushing to `main` (avoid; create new commits instead)
- Dropping Firestore collections / running destructive migrations
- Modifying production feature-flag rollout (`paHumanizeRuntimeEnabled`, etc.) — flag flip ramping IS Adam-gated per V1.5-ROLLOUT.md
- Sending real iMessage SMS via Sendblue with non-test recipients
- Deleting or amending git history Adam has pulled

**Routine deploys of orchestrator code are NOT in this list.** Do them.

## What "done" means here

Done = code merged + deployed + scenario-verified + long-context tested. Anything less is half-done. Adam will tell you if half-done is OK; default is full closure.
