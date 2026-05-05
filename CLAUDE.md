# Claude Operating Authority — wekruit-pa

**Adam directive iter23 (2026-05-03):** "你可以 deploy 不要再说让我 deploy 然后自己不做事情了"

## You CAN and MUST deploy

Full deploy authority. **Never tell Adam "deploy this yourself"** — iter19 + iter22 + iter23 failure mode.

### Deploy commands (use directly, no ask)

```bash
# Cloud Functions (orchestrator code path — iMessage live + admin sims)
cd apps/functions && pnpm run deploy
# = firebase deploy --only functions --project wekruit-5f89b

# Hosting (pa-dashboard SPA)
pnpm run deploy:hosting

# Firestore rules / indexes
firebase deploy --only firestore:rules,firestore:indexes --project wekruit-5f89b --non-interactive
```

Auth: `FIREBASE_SERVICE_ACCOUNT_JSON` set in `.env`. Source before run:

```bash
export GOOGLE_APPLICATION_CREDENTIALS=$(mktemp) && \
  grep -E "^FIREBASE_SERVICE_ACCOUNT_JSON=" .env | sed 's/^FIREBASE_SERVICE_ACCOUNT_JSON=//' > "$GOOGLE_APPLICATION_CREDENTIALS"
```

Or pass `--project wekruit-5f89b` + firebase-tools picks creds from `gcloud auth application-default login` if Adam pre-auth'd.

### Predeploy gated — green build = ship

`firebase.json` predeploy runs:
1. Clean orchestrator dist
2. Build dependent workspaces (`@pa/core-types ... @pa/pa-orchestrator`)
3. `apps/functions/scripts/predeploy-smoke.mjs` (smoke checks)
4. `apps/functions` build + typecheck + test

Any step fails → deploy aborts. **Don't `--no-verify`.** Fix cause.

## Verify by doing — no claim "ready post-deploy" without testing

**Adam directive iter23:** "你需要做测试，每个 playbook 测试看看是否真的生效"

Workflow contract for orchestrator-touching change:

1. **Unit tests** — `pnpm --filter pa-orchestrator test` 100% green before commit
2. **Deploy** — run deploy yourself
3. **Live scenario verify** — `node tests/scenarios/runner.mjs <scenario-yaml>` + paste reply text. Scenario "pass" status NOT proof — read actual reply.
4. **Long-context check** — humanization / voice work: run ≥10-turn scenario, check drift (mirror score, repeat-advice, length compliance). Adam iter23: "context 一长就不够好" — test that.

## No delegate back to Adam

Forbidden:
- "Adam needs to deploy" / "pending Adam deploy"
- "you can re-run X yourself"
- "blocked on user"

**Truly** blocked (e.g. requires prod secret only Adam holds, needs physical Mac mini offline) → state **exact unblock** + what pre-staged. Don't bounce default.

## When confirm with Adam

Risky / irreversible / observable per system prompt safety:
- Force-push `main` (avoid; new commits instead)
- Drop Firestore collections / destructive migrations
- Modify prod feature-flag rollout (`paHumanizeRuntimeEnabled`, etc.) — flag flip ramping Adam-gated per V1.5-ROLLOUT.md
- Real iMessage SMS via Sendblue with non-test recipients
- Delete/amend git history Adam pulled

**Routine deploys of orchestrator code NOT in list.** Do them.

## What "done" means

Done = code merged + deployed + scenario-verified + long-context tested. Less = half-done. Adam tells you if half OK; default = full closure.
