# Phase 69: Secrets + Slack alert provisioning - Context

REQ-IDs: SECRETS-01..03 (3)

**Status:** Shipped 2026-05-06 (`d26b3fa`). Verified: [.planning/v1.7-MILESTONE-AUDIT.md](../../v1.7-MILESTONE-AUDIT.md).

**Goal:** Provision ANTHROPIC_API_KEY, PA_SLACK_ALERT_WEBHOOK Firebase Secrets. Wire Slack alerts in QA evaluator + macmini health-check. LinkedIn token (SECRETS-03) is documented as Adam-action since it requires LinkedIn Developer App registration.

**Adam-action items (these need keys Adam holds):**
1. Provide ANTHROPIC_API_KEY → I'll set via `firebase functions:secrets:set`
2. Provide PA_SLACK_ALERT_WEBHOOK URL → set as Firebase Secret + wire Slack-post helper
3. LinkedIn API: register at https://developer.linkedin.com, obtain LINKEDIN_ACCESS_TOKEN, set on macmini .env-secrets

**In scope (without Adam keys):**
- Slack-post helper `apps/functions/src/lib/slack-alert.ts` ready for wire-up
- Refactor QA evaluator + health-check + cost-summary to use unified `slack-alert` helper
- Document Adam-action in commit + STATE.md
- Test slack-alert with mock fetch
