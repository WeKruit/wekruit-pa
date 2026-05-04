# iter31 deploy handoff — for a Claude Code CLI session with deploy creds

Paste the prompt below into a fresh Claude Code session running on your
**local CLI** (not the web sandbox). That session must have:

- `gcloud` installed + `gcloud auth application-default login` OR
  `FIREBASE_SERVICE_ACCOUNT_JSON` populated in `apps/functions/.env`
- `firebase-tools` installed (`pnpm i -g firebase-tools` or local)
- Push access to `WeKruit/wekruit-pa` (you already have this on your machine)

## ROTATE FIRST

Before pasting anything, **revoke the PAT** that you pasted in the previous
web session at https://github.com/settings/tokens (it's in that transcript
and in this repo's git proxy logs — the prefix was `ghp_bkMc…`). Generate
a fresh one if you need it for future sessions.

## The handoff prompt

```
You are picking up iter31 of wekruit-pa right after the GitHub PR landed
but before live deploy.

## State on origin/claude/wekruit-pa-biz-test-prep-8MICh

- HEAD: 1f55b9d (or later if more commits land)
- 2 commits since main (3c3b4c9):
  - ffb5fde feat(iter31): biz-test prep — HITL pause/resume + ToS gate + email verify
  - 1f55b9d test(iter31): offline simulator for HITL + email-verify branches
- PR: https://github.com/WeKruit/wekruit-pa/pull/1 (draft)

## What landed in iter31

1. **Privacy + Terms acceptance gate** — new OnboardingState `q_tos_asked`
   between first_mes_sent and q_role_asked. Bilingual accept/decline
   regex; decline keeps state at q_tos_asked with respectful ack and
   tosAcceptance.declinedAt audit (downstream memory ingest can opt-out).
   Public /legal page on dashboard hosting outside the auth wall.
   Flag-gated: paOnboardingTosGateEnabled (default OFF).

2. **Email verification (Mailgun + SMS)** — new state `q_email_verifying`
   between q_email_asked and complete. Code never persisted raw — sha256
   hash + 30-min TTL + 5-attempt cap. User replies code over iMessage/SMS;
   orchestrator hashes + compares. Verified → state=complete +
   contactEmailVerifiedAt stamp. 4 new MAILGUN_* secrets required.
   Flag-gated: paOnboardingEmailVerifyEnabled (default OFF).

3. **HITL pause/resume runtime** — User.runtimeMode (auto | paused) +
   audit fields. Orchestrator gate at top of processInboundEvent: paused
   users keep memory ingest, skip safety/onboarding/LLM/outbound. Resume
   produces NO auto-reply (next user inbound flows normally).
   paRuntimeMode admin HTTP endpoint + dashboard ⏸ Pause / ▶ Resume button
   + "HITL paused" badge + ops scripts. Self-gates (no flag).

Bonus folded in:
- T6 tone-lock for ask_q_email — directive requires literal 邮箱/email keyword
- Stale CV archive ops script (`archive-stale-cvs.mjs --keep <docId>`)
- seed-iter31.mjs flips both flags + seeds pa-remote-config/platform.tosVersion

## Pre-deploy verification (already green; re-run if uncertain)

```bash
git checkout claude/wekruit-pa-biz-test-prep-8MICh
git pull origin claude/wekruit-pa-biz-test-prep-8MICh
pnpm install   # or npm install with PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
npm run build --workspace=@pa/core-types --workspace=@pa/firebase-admin --workspace=@pa/agent-runtime --workspace=@pa/memory --workspace=@pa/agent-registry --workspace=@pa/pa-orchestrator
npm test --workspace=@pa/pa-orchestrator    # expect 590/590 green
npm test --workspace=@pa/functions          # expect 437/437 green
node apps/functions/scripts/sim-iter31.mjs  # expect 10/10 green
```

## Deploy steps (in order, do NOT skip)

```bash
# 1. Source Firebase Admin creds
export GOOGLE_APPLICATION_CREDENTIALS=$(mktemp) && \
  grep -E "^FIREBASE_SERVICE_ACCOUNT_JSON=" apps/functions/.env | sed 's/^FIREBASE_SERVICE_ACCOUNT_JSON=//' > "$GOOGLE_APPLICATION_CREDENTIALS"

# 2. Set the four Mailgun secrets (one-time — skip if already set)
echo -n "$MG_API_KEY" | firebase functions:secrets:set MAILGUN_API_KEY --data-file=- --project wekruit-5f89b
echo -n "mg.wekruit.com" | firebase functions:secrets:set MAILGUN_DOMAIN --data-file=- --project wekruit-5f89b
echo -n "Claire <claire@mg.wekruit.com>" | firebase functions:secrets:set MAILGUN_FROM --data-file=- --project wekruit-5f89b
echo -n "us" | firebase functions:secrets:set MAILGUN_REGION --data-file=- --project wekruit-5f89b

# 3. Deploy Cloud Functions (predeploy gate enforces builds + 590+437 tests + smoke)
cd apps/functions && pnpm run deploy && cd ../..

# 4. Deploy hosting (dashboard + /legal page)
pnpm run deploy:hosting

# 5. Seed ToS version + flip iter31 flags ON
node apps/functions/scripts/seed-iter31.mjs

# 6. Verify
node apps/functions/scripts/audit-mvp-state.mjs
curl -I https://wekruit-pa.web.app/legal           # expect 200
curl -s https://us-central1-wekruit-5f89b.cloudfunctions.net/paHealthRuntimeMode # expect 200 ok
```

## Live verification (broker-shape E2E)

After deploy, verify each new flow against a real test user. Use a fresh
phone number scoped to test mode, or reset Adam's test user via
`node apps/functions/scripts/e2e-reset-cold-start.mjs <userId>`.

For each flow, fire a synthetic broker iMessage event into
pa-inbound-events and read the assistant reply from pa-outbound. Pattern
matches `e2e-reset-cold-start.mjs`.

### Flow A: ToS accept path
1. Reset user; flip paOnboardingTosGateEnabled ON
2. Send "hi" → expect reply chain: greeting + ToS line w/ /legal link
3. Send "同意" → expect ask_q_role question; verify
   user.tosAcceptance.version=v1.0
4. Continue 7Q chain; expect onboardingState=complete

### Flow B: ToS decline path
1. Reset user
2. Send "hi" → expect ToS line
3. Send "no" → expect respectful decline ack ("totally ok…");
   user.tosAcceptance.declinedAt set, state STAYS at q_tos_asked
4. Send "同意" → state advances to q_role_asked
5. Send "what" → re-ask branch fires (ask_q_tos_reask directive)

### Flow C: Email verify pass
1. Reset user; advance to q_email_asked; flip paOnboardingEmailVerifyEnabled ON
2. Send "myemail@gmail.com" → Mailgun fires → state=q_email_verifying;
   user.emailVerification.codeHash set
3. Read the code from the actual email Mailgun delivered
4. Send the 6-digit code → state=complete; user.statedPreferences.contactEmailVerifiedAt set
5. Confirm reply contains "✓ verified" or "邮箱验过了"

### Flow D: HITL pause/resume
1. Open dashboard https://wekruit-pa.web.app, navigate to user
2. Click ⏸ Pause agent → confirm "HITL paused" badge appears
3. Send inbound from test user → confirm pa-messages has the inbound row
   but pa-outbound has NO new row, and pa-audit-events has hitl_runtime_mode
4. Click ▶ Resume agent → no auto-reply
5. Send next inbound → expect normal LLM-generated reply
6. Verify Cloud Logging shows pa.hitl.paused.inbound_skip events for the
   paused turns

### Flow E: T6 tone-lock for ask_q_email
1. Reset user, advance to q_resume_asked; user replies "好的"
2. Expect ask_q_email reply MUST contain literal "邮箱" (zh) or "email" (en)
3. Repeat 5 times and confirm 100% inclusion (T6 was drifting at ~80%
   pre-fix per iter30 follow-up notes)

## Cloud Logging telemetry to watch

After deploy, these events should appear in Cloud Logging (search by event
name in the Logs Explorer):

- `pa.hitl.paused.inbound_skip` — HITL pause active
- `pa.onboarding.tos_decision` — every q_tos_asked turn (decision: accept / decline / unclear)
- `pa.onboarding.tos_suspended` — decline / unclear path
- `pa.onboarding.email_verify.sent` — Mailgun fire success
- `pa.onboarding.email_verify.send_error` — Mailgun fire failure
- `pa.onboarding.email_verify.verified` — verification success
- `pa.onboarding.email_verify.miss` — verification miss
- `pa.onboarding.email_verify.bypass` — expired / exhausted bypass

## Rollback

If anything goes sideways:

```bash
# 1. Flip flags OFF (immediate; takes effect in <30s due to playbook cache TTL)
node -e "
const admin = require('firebase-admin');
admin.initializeApp({projectId:'wekruit-5f89b'});
const db = admin.firestore();
(async () => {
  await db.collection('pa-feature-flags').doc('paOnboardingTosGateEnabled').set({defaultValue: false}, {merge: true});
  await db.collection('pa-feature-flags').doc('paOnboardingEmailVerifyEnabled').set({defaultValue: false}, {merge: true});
  console.log('flags off');
})();
"

# 2. Or env-kill (faster, takes effect immediately):
# Add to apps/functions/.env or via firebase functions:config:
#   PA_ONBOARDING_TOS_GATE_DISABLED=true
#   PA_ONBOARDING_EMAIL_VERIFY_DISABLED=true
# Then re-deploy functions.

# 3. HITL is self-gating — set runtimeMode back to "auto" for every paused user.
```

The HITL feature has no kill switch by design — it's operator-controlled
per-user via the dashboard. Worst case set every user.runtimeMode = "auto"
via a one-shot script if it gets stuck on for a wide cohort (unlikely).

## Locked iter30 directives (DO NOT revert)

1. NO regex-primary anywhere; LLM intent classifier + state-machine determinism is primary
2. Skill system in pa-playbooks Firestore is operator-editable
3. parsedCandidateResumes is cross-product; do NOT include in clearUserMemory
4. Sendblue is THE iMessage transport
5. SiliconFlow + Qwen2.5-7B-Instruct = the model
6. Bilingual zh + en + mixed everywhere; Adam-locked tone in onboarding.ts Q_PROMPTS

## What "done" means

Deployed + flag flipped + scenario-verified + at least Flow A + D verified
live with reply text pasted in your final report. Adam directive iter23:
"你需要做测试，每个 playbook 测试看看是否真的生效".

If anything fails the predeploy gate, fix the cause — don't skip with
--no-verify. The gate runs builds + typecheck + 590+437 tests + smoke.

## Pending items NOT in this PR (for future iterations)

- WS6 OUTPUT chain cutover — gate-blocked on 24h shadow parity telemetry; check
  `pa.guardrails.input.shadow.result` events in Cloud Logging for parity with
  the legacy checkInboundSafety; cutover decision is post-launch
- am_i_ai_check 10-turn long-context live verify — needs real LLM access;
  unit tests already cover the deflector (am-i-ai-deflector.test.ts)
- Stale CV archive for e5d97cd8 — script ready, run when convenient:
  `node apps/functions/scripts/archive-stale-cvs.mjs e5d97cd8 --keep zLSRbpWz8edA7tAhRadA --apply`
- Scraping repo @wekruit/shared-tags Python port integration — pending
  Adam's timing decision on cross-repo PR
```
