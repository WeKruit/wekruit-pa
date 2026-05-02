# Predeploy Contract — `apps/functions`

Stream H9 TD4. This file documents the predeploy chain in `firebase.json` so a
future contributor can understand WHY each step exists. Adding/removing steps
without updating this contract = test gap.

## The chain (in order)

```jsonc
"predeploy": [
  // 1. Force-rebuild pa-orchestrator dist. tsc's incremental cache has been
  //    seen to skip stale outputs after src edits — hard delete forces a
  //    cold rebuild. Without this, P7-E observed deploys shipping yesterday's
  //    bytecode (Stream H4 incident, 2026-04-30).
  "rm -rf \"$RESOURCE_DIR/../../packages/pa-orchestrator/dist\"",

  // 2. Build all workspace deps the bundle inlines. Order matters — deps
  //    must build before pa-orchestrator (which imports them).
  "npm --prefix \"$RESOURCE_DIR/../..\" run build --workspace=@pa/core-types --workspace=@pa/firebase-admin --workspace=@pa/agent-runtime --workspace=@pa/memory --workspace=@pa/agent-registry --workspace=@pa/pa-orchestrator",

  // 3. Smoke test: verify the dist actually reflects current src. Catches
  //    the failure mode where step 2 silently skipped a workspace.
  "node \"$RESOURCE_DIR/../scripts/predeploy-smoke.mjs\"",

  // 4. Bundle apps/functions/src/index.ts → apps/functions/lib/index.js
  //    via esbuild (build.mjs). This is what firebase-tools uploads.
  "npm --prefix \"$RESOURCE_DIR/..\" run build",

  // 5. Typecheck — fails fast on signature drift between workspaces.
  "npm --prefix \"$RESOURCE_DIR/..\" run typecheck",

  // 6. Run unit tests — last line of defense before deploy.
  "npm --prefix \"$RESOURCE_DIR/..\" test"
]
```

## What each variable resolves to

- `$RESOURCE_DIR` is `apps/functions/lib` (firebase deploys from `lib/`).
- `$RESOURCE_DIR/..` is `apps/functions` (where package.json + scripts live).
- `$RESOURCE_DIR/../..` is the repo root (where the npm workspace lives).

## Smoke test expectations

`apps/functions/scripts/predeploy-smoke.mjs` asserts THREE things, in order:

1. `packages/pa-orchestrator/dist/cv-context-injection.js` exists.
2. The dist file's `mtime` is `>= packages/pa-orchestrator/src/cv-context-injection.ts`'s mtime.
3. `import()`-ing the dist file returns a module with
   `appendCvContextToSystemPrompt: function`.

If any check fails, the smoke test exits 1, the predeploy chain aborts, and
firebase tools refuses to deploy. This is the stale-dist regression lock.

## Adding new function-shape sentinel checks

If a new export becomes critical to detect at predeploy time, edit
`predeploy-smoke.mjs` and add a `typeof mod.<name> !== "function"` assertion.
Keep the file under ~50 lines — it's a smoke test, not a test runner.

## When to deploy bypassing predeploy

Never. If the chain is failing, fix the underlying issue. Use
`firebase deploy --only functions --force` ONLY for dashboard pre-deploys
where the chain is irrelevant (and even then, prefer fixing the chain).
