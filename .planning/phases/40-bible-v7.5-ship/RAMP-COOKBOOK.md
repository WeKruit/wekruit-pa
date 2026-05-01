# v1.4 Humanize-Runtime Rollout Cookbook (Adam ramp script)

> **Status 2026-04-30:** All deps shipped + LIVE in Firestore. Ramp = single dashboard / CLI command.
> Pre-flight verified: pa-handbooks/claire@v2 + pa-feature-flags/paHumanizeRuntimeEnabled (perUser, default false) both LIVE.

## What's left for Adam

Item #1 (LLM judge budget) and Item #3 (flag flip) from prior P0 list.

### Item #1 — LLM judge budget approval

**STATUS:** ✅ **DONE 2026-04-30.** OpenAI key in `.env` was used per Adam's signal "用 openai 就行". Cost incurred: $0.0005 (well under $2 ceiling). Result: metric 3 hit rate **83.3%** at strategy_fit ≥ 2 (target 70% PASS). Nothing more required.

### Item #3 — Flag flip 1% → 10% → 50% → 100%

**Adam decision required: WHEN to start the ramp.** Recommended sequence below; each step pauses 24-72h on dashboard 5-metric monitoring.

#### Pre-flight

```bash
# Verify pre-flight state in Firestore
cd /Users/adam/Desktop/WeKruit/wekruit-pa
SA_PATH=/tmp/wekruit-sa.json
awk -F= '/^FIREBASE_SERVICE_ACCOUNT_JSON=/ {sub(/^FIREBASE_SERVICE_ACCOUNT_JSON=/,""); print}' .env > "$SA_PATH" && chmod 600 "$SA_PATH"

GOOGLE_APPLICATION_CREDENTIALS="$SA_PATH" node -e "
const { initializeApp, applicationDefault, getApps } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
if (getApps().length === 0) initializeApp({ credential: applicationDefault() });
(async () => {
  const db = getFirestore();
  const flag = (await db.collection('pa-feature-flags').doc('paHumanizeRuntimeEnabled').get()).data();
  console.log('CURRENT:', JSON.stringify(flag, null, 2));
  process.exit(0);
})();
"
rm "$SA_PATH"
```

Expect: `{value: false, scope: "perUser", type: "bool", bucketStrategy: null, version: 1}`.

#### Step 1 — Phase 1: 1% canary

```bash
GOOGLE_APPLICATION_CREDENTIALS="$SA_PATH" node -e "
const { initializeApp, applicationDefault, getApps } = require('firebase-admin/app');
const { setFlag } = require('./packages/pa-persistence/dist/feature-flags.js');
const { getFirestore } = require('firebase-admin/firestore');
if (getApps().length === 0) initializeApp({ credential: applicationDefault() });
(async () => {
  await setFlag(getFirestore(), 'paHumanizeRuntimeEnabled', {
    value: false, type: 'bool', scope: 'perUser',
    bucketStrategy: {
      method: 'userIdHash',
      variants: [
        { name: 'off', weight: 99, value: false },
        { name: 'on',  weight: 1,  value: true  },
      ],
    },
  }, { actor: 'adam@wekruit.com', reason: 'Phase 40 ramp — 1% canary' });
  console.log('OK — 1% canary live');
  process.exit(0);
})();
"
```

**Watch for 24h before advancing:**
- pa.voice.llm_rewriter.result telemetry → `applied`/`reason` distribution stable
- pa.voice.imperfection_injector.applied count > 0 (verifies arm-router firing)
- 5 metric dashboard: AI tell-tale 0%, drift_p95 ≤ 4.9%, length_compliance ≥ 98%, repeat 0%, strategy_fit ≥ 70%
- Crisis red-team auto-test continues 20/20

**ROLLBACK if any metric regresses:** `PA_HUMANIZE_RUNTIME_DISABLED=true` env on CFs (cold-start), OR re-run setFlag with `bucketStrategy: null` (full off).

#### Step 2 — Phase 2: 10%

```bash
# Same pattern, weights: off=90, on=10
# reason: 'Phase 40 ramp — 10% (1% clean for 24h)'
```

Watch 48h.

#### Step 3 — Phase 3: 50%

```bash
# Same pattern, weights: off=50, on=50
# reason: 'Phase 40 ramp — 50% (10% clean for 48h)'
```

Watch 72h.

#### Step 4 — Phase 4: 100% full

```bash
# value: true, bucketStrategy: null
# reason: 'Phase 40 ramp — 100% (50% clean for 72h)'
```

#### Sub-flag surgical rollback (if one component regresses but not others)

Set on CF env (cold-start required):
- `PA_DETECTORS_ENABLED=false` — disables Phase 35 detector pass
- `PA_FSM_ENABLED=false` — disables Phase 37 FSM directive
- `PA_MEMORY_POLICY_ENABLED=false` — disables Phase 38 trackAdvice
- `PA_IMPERFECTION_INJECTOR_ENABLED=false` — disables Phase 36 ImperfectionInjector

Umbrella stays ON (telemetry preserved); only the specific component is masked.

---

## Reference

- WIRE-IN-PATCH.md (9/9 sections applied autonomously)
- v1.4-MILESTONE-AUDIT.md (5/5 hard gates GREEN deterministic)
- baseline-rev00056.md (full metric numbers)
