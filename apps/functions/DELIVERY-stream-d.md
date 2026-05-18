# v1.5 Stream-D — Message Coalescer DELIVERY

> Status: D1+D2+D3+D5 shipped. D4 (LIVE smoke on Adam canary) tracked as a separate follow-up commit per P10 directive.

## What this delivers

`paMessageCoalescer` — a Cloud Tasks-backed buffer that collapses N quick inbound iMessages from a single user into ONE orchestrator turn:

| Behavior | Before | After (flag=on) |
|---|---|---|
| User sends 3 messages 2s apart | Claire replies 3× | Claire taps back ❤️ on the LAST message + 1 reply that addresses all 3 |
| User sends 1 message | Claire replies immediately | Claire replies ~4s later (single-msg case still pays the coalesce delay) |
| Cloud Tasks fails to enqueue | n/a | Webhook records inbound/audit state; runtime/outbox remains the only user-visible send path |
| Cloud Tasks fires twice | n/a | Second fire is a no-op (markFiredTransaction is atomic) |
| Cloud Tasks task gets stuck | n/a | `paCoalesceBufferSweep` force-fires after 30s |

Behind flag `paMessageCoalesceEnabled` (perUser scope, default off).

## Files added

- `apps/functions/src/coalesce/tasks-client.ts` — Cloud Tasks SDK wrapper, mockable
- `apps/functions/src/coalesce/buffer.ts` — Firestore CRUD with transactions
- `apps/functions/src/coalesce/paMessageCoalescer.ts` — `enqueueOrCoalesce` + `processCoalescedTurn`
- `apps/functions/src/coalesce/buffer-sweep.ts` — R1 sweep (P10 mandate)
- `apps/functions/src/coalesce/__tests__/paMessageCoalescer.test.ts` — 6 cases

## Files modified

- `apps/functions/src/sendblue/webhook.ts` — adds coalesce dispatch in success branch (gated by flag + `mediaUrl===null`)
- `apps/functions/src/index.ts` — registers `paMessageCoalescer` (HTTP) and `paCoalesceBufferSweep` (every 60s); injects coalescer deps into webhook
- `apps/functions/build.mjs` — externalizes `@google-cloud/tasks` (~10MB SDK)
- `apps/functions/package.json` — adds `@google-cloud/tasks` dep

## One-time infra setup (RUN BEFORE FLAG FLIP)

### 1. Create the Cloud Tasks queue

```bash
gcloud tasks queues create pa-message-coalesce \
  --location=us-central1 \
  --max-attempts=3 \
  --max-backoff=30s \
  --min-backoff=5s \
  --max-doublings=2 \
  --max-dispatches-per-second=50 \
  --max-concurrent-dispatches=20 \
  --project=wekruit-5f89b
```

### 2. Grant the runtime SA permission to enqueue

The default Cloud Functions Gen 2 SA is `wekruit-5f89b@appspot.gserviceaccount.com`. It needs:

```bash
# Permission to enqueue tasks
gcloud projects add-iam-policy-binding wekruit-5f89b \
  --member=serviceAccount:wekruit-5f89b@appspot.gserviceaccount.com \
  --role=roles/cloudtasks.enqueuer

# Permission for Cloud Tasks → Cloud Functions invocation (OIDC self-invoke)
gcloud projects add-iam-policy-binding wekruit-5f89b \
  --member=serviceAccount:wekruit-5f89b@appspot.gserviceaccount.com \
  --role=roles/cloudfunctions.invoker

# Permission to mint OIDC tokens for the audience
gcloud projects add-iam-policy-binding wekruit-5f89b \
  --member=serviceAccount:wekruit-5f89b@appspot.gserviceaccount.com \
  --role=roles/iam.serviceAccountTokenCreator
```

### 3. Set runtime env on the deployed CFs

The webhook + coalescer + sweep all read these env vars (resolved at cold start):

```bash
# Edit apps/functions/.env (loaded into the bundle by build.mjs)
PA_COALESCE_PROJECT_ID=wekruit-5f89b
PA_COALESCE_LOCATION=us-central1
PA_COALESCE_QUEUE=pa-message-coalesce
PA_COALESCE_TARGET_URL=https://us-central1-wekruit-5f89b.cloudfunctions.net/paMessageCoalescer
PA_COALESCE_INVOKER_SA=wekruit-5f89b@appspot.gserviceaccount.com
```

Note: `PA_COALESCE_TARGET_URL` only becomes available AFTER the first deploy of `paMessageCoalescer`. Sequence:
1. First `npm run deploy` — creates the function, ignores env (config not read because flag is off)
2. Read the function URL from Cloud Console
3. Update `.env` with the URL, redeploy
4. Flag flip happens AFTER step 3

## Deploy

```bash
cd apps/functions && npm run deploy
# Or selective:
firebase deploy --only \
  functions:paMessageCoalescer,functions:paCoalesceBufferSweep,functions:paSendblueWebhook,functions:onPaInbound \
  --project wekruit-5f89b
```

## Flag flip — Adam canary (perUser allowlist)

Use the existing `paAdminBootstrap` admin endpoint OR direct Firestore write:

```bash
# Replace ${ADAM_USER_ID} with Adam's pa-users docId (typically randomUUID()
# created on first inbound; query: pa-users where phoneE164 == "+15551234567")
ADAM_USER_ID="..."

curl -X POST https://us-central1-wekruit-5f89b.cloudfunctions.net/paAdminBootstrap/setFlag \
  -H "Authorization: Bearer $PA_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{
    \"key\": \"paMessageCoalesceEnabled\",
    \"value\": false,
    \"type\": \"bool\",
    \"scope\": \"perUser\",
    \"allowlist\": [\"$ADAM_USER_ID\"],
    \"reason\": \"v1.5 Stream-D canary — Adam only\"
  }"
```

`scope: "perUser"` + `allowlist: [adamUserId]` means: default value is false (everyone bypassed), allowlist beats default to return true (Adam only). This matches the `feature-flags.ts:resolvePerUser` semantics — `blocklist beats allowlist beats default`.

## Live smoke procedure (Adam canary, D4 follow-up)

1. Send Adam 3 iMessages 2 seconds apart from a different number to Claire (or have Adam do it himself).
2. Wait 5 seconds.
3. Verify in Cloud Logging:
   ```bash
   gcloud logging read 'resource.type=cloud_function AND jsonPayload.severity=INFO AND textPayload=~"pa.coalesce.fired"' \
     --project=wekruit-5f89b --limit=10 --freshness=1h
   ```
   Expected log entry shape:
   ```json
   {
     "userId": "u_adam_...",
     "turnSeq": 1,
     "messageCount": 3,
     "accumulatedBodyLen": 42,
     "elapsedMs": 4012,
     "lastMessageId": "msg-third"
   }
   ```
4. Verify Adam's iMessage shows ❤️ tap-back on his LAST message.
5. Verify Adam received exactly ONE reply from Claire that addresses all three messages.

If the reply is not received within 8s OR more than one reply arrives → ROLLBACK.

## Rollback

```bash
# 1. Flag off (instant — 30s flag cache TTL)
curl -X POST .../paAdminBootstrap/setFlag \
  -d '{"key":"paMessageCoalesceEnabled","value":false,"type":"bool","scope":"perUser","allowlist":[],"reason":"rollback"}'

# 2. Optional emergency override (bypasses Firestore, immediate per-CF):
firebase functions:secrets:set paMessageCoalesceEnabled --data-file=<(echo "0")
# Note: this works for env-override true→true, but env "0" is read as
# falsy by getFlag; the actual rollback path is the flag write above.
# Env override is only a one-way kill (env="1" forces true). Use it ONLY
# if the dashboard/Firestore is offline.

# 3. If buffers are stuck after rollback:
gcloud tasks queues purge pa-message-coalesce --location=us-central1
# Then manually mark stuck buffers as fired in Firestore console:
# pa-message-coalesce-buffer where status="pending" → set status="fired"
```

The R1 sweep (`paCoalesceBufferSweep`) will additionally drain any in-flight buffers within ~60s, so a rollback with users mid-turn is safe — they get a (slightly delayed) reply.

## Verification (run locally before commit)

```bash
cd apps/functions
npm run typecheck                                     # 0 errors
node --import tsx --test src/coalesce/__tests__/*.test.ts   # 6/6 green
npm run test                                          # 336/336 green (no regression)
npm run build                                         # bundle ≤ 16MB
```

## What is intentionally NOT in this commit (D4 follow-up)

- LIVE smoke proof on Adam's phone — needs production deploy + flag flip + manual send
- Cloud Tasks queue creation — runs in production environment by an operator with `roles/cloudtasks.admin`
- IAM bindings — same as above
- The DELIVERY.md command list above is the runbook for D4

## Risk register (for P9/P10 awareness)

| ID | Risk | Mitigation in this commit |
|---|---|---|
| R1 | Cloud Tasks task stuck → user message in limbo | `paCoalesceBufferSweep` force-fires after 30s |
| R2 | Cancel race (cancel after task already firing) | Double guard: Firestore status flip + Cloud Tasks unique name |
| R3 | Concurrent webhooks for same user | Firestore transaction serializes |
| R4 | SA missing perms at deploy time | DELIVERY.md gcloud commands above |
| R5 | sendReaction fails (4xx/breaker) | Fail-open — reply still proceeds |
| R6 | Coalesce env config missing in production | `buildSendblueWebhookDeps` swallows the throw and continues in legacy mode (zero-regression contract) |

## Tech debt logged for follow-up

- (none yet — sweep covers R1 per P10 directive)
- Future: enrich the sweep to also clean up `pa-message-coalesce-buffer` docs whose `status="fired"` and are >7 days old (Firestore TTL field instead?). Not blocking v1.5.
