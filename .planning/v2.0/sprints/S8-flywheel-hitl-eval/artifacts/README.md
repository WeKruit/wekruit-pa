# S8 Artifacts

Store S8 eval summaries, scenario outputs, generated redacted fixtures,
dashboard smoke evidence, deploy logs, and live no-contact count snapshots here.

## Task E Harness Note

- Command: `pnpm --dir tests/eval/s8-flywheel-hitl-eval test`
- Result: PASS on 2026-05-14. Node test reported 10 pass, 0 fail, 0 skip; static guard reported 18 files scanned.
- Dependency: `materializeEvalArtifactForCorrection`, `buildFlywheelFeedbackEvent`, `runFlywheelMarketplaceSimulation`, and candidate correction artifact materialization are exercised.

## Deploy + Live Smoke Note

- First combined Firebase deploy attempt stopped before upload because
  `build:dashboard:with-injected-env` required production `VITE_FIREBASE_*`
  keys.
- Generated gitignored `apps/dashboard-web/.env.pa-firebase-generated` from
  Firebase web config and reran deploy with `PA_DASHBOARD_VITE_ENV_FILE` plus
  `VITE_CV_INGEST_URL`.
- Final deploy completed for functions, `hosting:pa-dashboard`, and
  `hosting:pa-landing`.
- Live no-contact route/auth/count smoke passed; details are in
  `no-contact-counts.json`.
