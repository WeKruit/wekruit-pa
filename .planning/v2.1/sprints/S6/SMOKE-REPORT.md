# v2.1 S6 Smoke Report

- **Mode**: mock
- **Run at**: 2026-05-16T06:35:56.294Z
- **Sample size**: 10
- **Pass rate**: 10/10

## Threshold compliance

| Metric | Threshold | Actual | Pass |
|---|---|---|---|
| Pass rate | >= 8/10 | 10/10 | yes |
| PII leaks | == 0 | 0 | yes |
| p50 TTFA | < 1500 ms | 1040 ms | yes |
| Cost / call | < $1.00 | $0.47 | yes |
| False-commit | < 10% | 0.0% | yes |
| False-interrupt | < 5% | 0.0% | yes |

## Recording archive spot-check

- Sampled: 3
- OK: true

## Per-call results

| # | Scenario | Expected | Actual | TTFA ms | Cost $ | Pass |
|---|---|---|---|---|---|---|
| 1 | 01-happy-path-pass | PASS | PASS | 850 | 0.42 | yes |
| 2 | 02-not-pass-low-score | NOT_PASS | NOT_PASS | 920 | 0.48 | yes |
| 3 | 03-hangup-mid-call | HANGUP | HANGUP | 780 | 0.18 | yes |
| 4 | 04-yes-no-en | PASS | PASS | 910 | 0.37 | yes |
| 5 | 05-yes-no-zh | PASS | PASS | 1050 | 0.45 | yes |
| 6 | 06-multilingual-switch | PASS | PASS | 1120 | 0.51 | yes |
| 7 | 07-noisy-background | PASS | PASS | 1280 | 0.62 | yes |
| 8 | 08-fast-talker | PASS | PASS | 1040 | 0.49 | yes |
| 9 | 09-long-pause | PASS | PASS | 1310 | 0.71 | yes |
| 10 | 10-edge-late-consent | PASS | PASS | 990 | 0.44 | yes |

## Ship-readiness

- **Ship gate**: GREEN
