---
phase: 21-sendblue-channel-migration
plan: 01
type: execute
wave: 1
depends_on: []
files_modified:
  - apps/functions/src/sendblue/types.ts
  - apps/functions/src/sendblue/hmac.ts
  - apps/functions/src/sendblue/allowlist.ts
  - apps/functions/src/sendblue/normalize.ts
  - apps/functions/src/sendblue/webhook.ts
  - apps/functions/src/sendblue/outbox.ts
  - apps/functions/src/sendblue/sendblue-client.ts
  - apps/functions/src/sendblue/typing-indicator.ts
  - apps/functions/src/sendblue/audit.ts
  - apps/functions/src/sendblue/__tests__/hmac.test.ts
  - apps/functions/src/sendblue/__tests__/allowlist.test.ts
  - apps/functions/src/sendblue/__tests__/normalize.test.ts
  - apps/functions/src/sendblue/__tests__/webhook.test.ts
  - apps/functions/src/sendblue/__tests__/outbox.test.ts
  - apps/functions/src/index.ts
  - apps/macos-imessage-worker/src/index.ts
  - apps/macos-imessage-worker/src/outbox.ts
  - apps/macos-imessage-worker/src/config.ts
  - packages/pa-orchestrator/src/chunker.ts
  - .planning/phases/21-sendblue-channel-migration/21-CONTRACT-NOTES.md
  - .planning/phases/21-sendblue-channel-migration/21-RUNBOOK.md
autonomous: false
requirements:
  - CHANNEL-01
  - CHANNEL-02
  - CHANNEL-03
  - CHANNEL-04
  - CHANNEL-05
  - CHANNEL-06
  - CHANNEL-07
  - CHANNEL-08
  - CHANNEL-09
user_setup:
  - service: sendblue
    why: "Hosted iMessage transport — webhook handler + REST send replace macOS worker"
    env_vars:
      - name: SENDBLUE_API_KEY_ID
        source: "Sendblue dashboard → API → Credentials (already saved to apps/functions/.env)"
      - name: SENDBLUE_API_SECRET_KEY
        source: "Sendblue dashboard → API → Credentials (already saved to apps/functions/.env)"
      - name: SENDBLUE_WEBHOOK_SIGNING_SECRET
        source: "Sendblue dashboard → Webhooks → Per-webhook secret (operator must generate)"
    dashboard_config:
      - task: "Inspect Sendblue webhook docs / dashboard to identify exact HMAC header name (e.g. X-Sendblue-Signature)"
        location: "Sendblue Dashboard → Webhooks → Documentation"
      - task: "Configure webhook endpoint URL for paSendblueWebhook (after first deploy)"
        location: "Sendblue Dashboard → Webhooks → Add endpoint"
      - task: "Subscribe to events: receive, outbound, typing_indicator, line_blocked"
        location: "Sendblue Dashboard → Webhooks → Event subscriptions"
      - task: "Answer 4 contract questions before public-launch GO (Apple ID ownership, re-provisioning SLA, outbound rate limit, GDPR/data residency)"
        location: "Sendblue support / sales contact"
must_haves:
  truths:
    - "Inbound iMessage to Sendblue line creates pa_inbound_events keyed by sendblue-${message_handle} within 5s"
    - "Webhook with invalid HMAC returns 401 and creates no inbound event"
    - "Non-allowlisted from_number returns 200 OK silently with pa_audit_events deny record and no inbound event"
    - "Orchestrator turn → pa_outbound → Sendblue REST POST → user iMessage delivery <30s p95 (CHANNEL-09)"
    - "Sendblue retry (same message_handle) produces exactly one pa_inbound_events row"
    - "PA_CHANNEL_LEGACY=1 keeps macOS worker functional (parallel-run safety)"
    - "Phase 15 chunker dormant on Sendblue path; native typing_indicator API used"
    - "Firebase Secret Manager holds SENDBLUE_API_KEY_ID + SENDBLUE_API_SECRET_KEY before prod deploy"
    - "Sandbox round-trip smoke recorded: webhook → orchestrator → REST send → iMessage delivery"
  artifacts:
    - path: "apps/functions/src/sendblue/webhook.ts"
      provides: "paSendblueWebhook handler — HMAC verify, allowlist gate, payload normalize, broker enqueue"
      min_lines: 80
    - path: "apps/functions/src/sendblue/outbox.ts"
      provides: "onDocumentCreated(pa_outbound) → Sendblue REST POST processor"
      min_lines: 80
    - path: "apps/functions/src/sendblue/hmac.ts"
      provides: "verifySendblueSignature(rawBody, header, secret): boolean"
      exports: ["verifySendblueSignature"]
    - path: "apps/functions/src/sendblue/allowlist.ts"
      provides: "Port of useDmAllowlist/getPeerAllowlist/isSamePeer/normalizePeer keyed on from_number"
      exports: ["useDmAllowlist", "getPeerAllowlist", "isSamePeer", "normalizePeer"]
    - path: "apps/functions/src/sendblue/normalize.ts"
      provides: "normalizeSendblueInbound(payload) → { idempotencyKey, fromNumber, toNumber, text, chatId, messageHandle, isGroup }"
      exports: ["normalizeSendblueInbound", "isInboundReceiveEvent"]
    - path: "apps/functions/src/sendblue/sendblue-client.ts"
      provides: "sendImessage({to, body, ...}) → POST api.sendblue.co/api/send-message; sendTypingIndicator(to)"
      exports: ["sendImessage", "sendTypingIndicator"]
    - path: "apps/functions/src/sendblue/types.ts"
      provides: "SendblueInboundPayload, SendblueOutboundPayload, SendblueWebhookEvent type unions"
    - path: "apps/functions/src/index.ts"
      provides: "Export paSendblueWebhook + paSendblueOutbox CF entries"
      contains: "export const paSendblueWebhook"
    - path: ".planning/phases/21-sendblue-channel-migration/21-RUNBOOK.md"
      provides: "Cutover runbook — secret manager, sandbox smoke, drain procedure, rollback"
  key_links:
    - from: "apps/functions/src/sendblue/webhook.ts"
      to: "packages/pa-broker createInboundEvent"
      via: "import + call with idempotencyKey: sendblue-${message_handle}"
      pattern: "createInboundEvent.*sendblue-"
    - from: "apps/functions/src/sendblue/outbox.ts"
      to: "https://api.sendblue.co/api/send-message"
      via: "fetch POST with API key headers"
      pattern: "api\\.sendblue\\.co/api/send-message"
    - from: "apps/functions/src/sendblue/webhook.ts"
      to: "apps/functions/src/sendblue/allowlist.ts isSamePeer"
      via: "from_number gate before broker enqueue"
      pattern: "isSamePeer.*from_number|from_number.*isSamePeer"
    - from: "apps/functions/src/sendblue/webhook.ts"
      to: "apps/functions/src/sendblue/hmac.ts verifySendblueSignature"
      via: "first-line check on raw request body"
      pattern: "verifySendblueSignature"
    - from: "apps/functions/src/index.ts"
      to: "apps/functions/src/sendblue/webhook.ts + outbox.ts"
      via: "import + export paSendblueWebhook, paSendblueOutbox"
      pattern: "paSendblueWebhook|paSendblueOutbox"
---

<objective>
Replace `apps/macos-imessage-worker/` with Sendblue hosted iMessage transport. Add Cloud Functions webhook handler + REST outbox processor; port allowlist to webhook layer; migrate idempotency key from `imessage-in-${rowId}` to `sendblue-${message_handle}`; deprecate Phase 15 chunker via env flip in favor of Sendblue native typing API; migrate API secrets to Firebase Secret Manager; preserve parallel run via `PA_CHANNEL_LEGACY=1` flag for one milestone.

Purpose: Eliminate single-host availability risk + Apple-ID ToS exposure (B1 + B2 in Phase 17 CONTEXT) before public launch. Closed-beta launch can stay on macOS worker IF this phase blocks; public launch is gated on Sendblue (per ROADMAP launch gate).

Output: `paSendblueWebhook` + `paSendblueOutbox` CF endpoints live, real Sendblue sandbox round-trip smoke <30s p95, macOS worker behind `PA_CHANNEL_LEGACY=1`, Phase 15 chunker dormant, secrets in Firebase Secret Manager.
</objective>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
@$HOME/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/PROJECT.md
@.planning/REQUIREMENTS.md
@.planning/ROADMAP.md
@.planning/phases/21-sendblue-channel-migration/21-CONTEXT.md
@.planning/phases/17-pre-launch-hardening/17-CONTEXT.md

# Reference implementations to port
@apps/macos-imessage-worker/src/index.ts
@apps/macos-imessage-worker/src/outbox.ts
@apps/macos-imessage-worker/src/config.ts
@apps/functions/src/index.ts
@packages/pa-broker/src/inbound.ts
@packages/core-types/src/collections.ts

<interfaces>
<!-- Contracts the executor needs. Embedded so no codebase exploration required. -->

From `packages/pa-broker/src/inbound.ts`:
```typescript
export function createInboundEvent(
  db: Firestore,
  input: {
    channel: "imessage" | "sms" | "web"
    idempotencyKey: string  // <- becomes `sendblue-${message_handle}`
    rawPayload: Record<string, unknown>
  }
): Promise<{ id: string; created: boolean }>
// Idempotent: same idempotencyKey returns existing doc (created=false), no overwrite.
```

From `apps/macos-imessage-worker/src/config.ts` (port 1:1 to `apps/functions/src/sendblue/allowlist.ts`):
```typescript
export function useDmAllowlist(): boolean       // env IMESSAGE_DM_ALLOWLIST !== "0", default ON (fail-closed)
export function getPeerAllowlist(): string[]    // env IMESSAGE_PEERS / IMESSAGE_PEER, normalized E.164
export function isSamePeer(a: string | null, b: string): boolean  // E.164 last-10-digit match
export function normalizePeer(raw: string): string                // raw → +1XXXXXXXXXX or email lowercase
```

From `packages/core-types/src/collections.ts`:
```typescript
export const PA_COLLECTIONS = {
  outbound: "pa_outbound",
  inboundEvents: "pa_inbound_events",
  auditEvents: "pa_audit_events",
  // ...
}
```

Sendblue inbound webhook payload shape (from sendblue_assessment.md + Sendblue docs):
```typescript
type SendblueInboundPayload = {
  content: string
  from_number: string          // E.164
  to_number: string            // E.164
  message_handle: string       // stable across Sendblue retries — primary idempotency key source
  date_sent: string            // ISO8601
  status: string
  service: "iMessage" | "SMS"
  participants?: string[]
  group_id?: string
  group_display_name?: string
  media_url?: string
  is_outbound?: boolean        // true for outbound webhook event mirror
}
```

Sendblue REST send (`POST https://api.sendblue.co/api/send-message`):
```typescript
// Headers: sb-api-key-id, sb-api-secret-key, content-type: application/json
// Body:
{
  number: string         // E.164 destination
  content: string        // message body
  status_callback?: string  // optional webhook for delivery status
}
// Response: { message_handle: string, status: "queued" | "sent" | "failed", error?: string }
```

Existing CF entry pattern (`apps/functions/src/index.ts:400`):
```typescript
import { onRequest } from "firebase-functions/v2/https"
import { onDocumentCreated } from "firebase-functions/v2/firestore"
export const memoryAdmin = onRequest({ /* opts */ }, handler)
export const onPaInbound = onDocumentCreated("pa_inbound_events/{id}", handler)
```
</interfaces>
</context>

<tasks>

<task type="auto">
  <name>Task 1: Sendblue contract probe + types + signing-secret resolution (per D-01, D-03, D-05; resolves R-01)</name>
  <files>
    apps/functions/src/sendblue/types.ts,
    .planning/phases/21-sendblue-channel-migration/21-CONTRACT-NOTES.md
  </files>
  <action>
    Resolve unknowns BEFORE writing handler code.

    1. **Probe Sendblue webhook docs** (https://docs.sendblue.com/) and identify:
       - Exact HMAC header name (commonly `X-Sendblue-Signature` or `sb-signature` — confirm)
       - Signing algorithm (HMAC-SHA256 of raw body? hex or base64?)
       - Whether per-webhook secret OR global account secret OR legacy root-level secret applies
       - Exact JSON shape of `receive`, `outbound`, `typing_indicator`, `line_blocked` events
    2. **Write findings** to `.planning/phases/21-sendblue-channel-migration/21-CONTRACT-NOTES.md`. Include verbatim docs links + any sample payloads you can copy. Mark contract Qs 1–4 (Apple ID ownership, re-provisioning SLA, outbound rate limit, GDPR/data residency) as ADAM-PENDING with placeholders.
    3. **Define types** in `apps/functions/src/sendblue/types.ts`:
       - `SendblueInboundPayload`, `SendblueOutboundPayload`, `SendblueTypingIndicatorPayload`, `SendblueLineBlockedPayload`
       - `SendblueWebhookEvent` discriminated union (use `event_type` or shape-based discriminator depending on what docs show)
       - `SendblueSendRequest` + `SendblueSendResponse` for REST client

    DO NOT write the HMAC verifier or webhook handler in this task — types + contract docs only.

    Note: Confirm whether HMAC signature covers raw bytes (typical) or stringified parsed JSON — this affects how the CF reads the body.
  </action>
  <verify>
    <automated>test -f apps/functions/src/sendblue/types.ts &amp;&amp; test -f .planning/phases/21-sendblue-channel-migration/21-CONTRACT-NOTES.md &amp;&amp; npx tsc --noEmit -p apps/functions/tsconfig.json</automated>
  </verify>
  <done>21-CONTRACT-NOTES.md documents HMAC header name + algorithm + raw-vs-parsed body decision; types.ts compiles; contract Qs 1–4 listed as Adam-pending.</done>
</task>

<task type="auto" tdd="true">
  <name>Task 2: HMAC signature verifier (CHANNEL-02, depends on Task 1)</name>
  <files>
    apps/functions/src/sendblue/hmac.ts,
    apps/functions/src/sendblue/__tests__/hmac.test.ts
  </files>
  <behavior>
    - Test 1: valid HMAC of raw-body+secret returns true
    - Test 2: tampered body returns false
    - Test 3: wrong secret returns false
    - Test 4: missing/empty header returns false
    - Test 5: timing-safe comparison (use `crypto.timingSafeEqual`); equal-length but wrong-byte returns false
    - Test 6: hex vs base64 encoding matches what 21-CONTRACT-NOTES.md documented in Task 1
  </behavior>
  <action>
    TDD. Write `apps/functions/src/sendblue/__tests__/hmac.test.ts` first with the 6 cases above (RED). Then implement `verifySendblueSignature(rawBody: Buffer | string, header: string | undefined, secret: string): boolean` in `apps/functions/src/sendblue/hmac.ts` (GREEN).

    Implementation: HMAC-SHA256 over raw body (per Task 1 finding), compare with `crypto.timingSafeEqual`. Treat missing header / wrong length as false. Do NOT throw on bad input — return false.

    Reads `SENDBLUE_WEBHOOK_SIGNING_SECRET` from env. Function takes secret as arg (testable); caller injects from env.
  </action>
  <verify>
    <automated>cd apps/functions &amp;&amp; npm test -- hmac.test</automated>
  </verify>
  <done>All 6 hmac tests pass; verifier rejects bad sigs; uses timingSafeEqual.</done>
</task>

<task type="auto" tdd="true">
  <name>Task 3: Port allowlist + payload normalizer (CHANNEL-04, per D-03, D-04)</name>
  <files>
    apps/functions/src/sendblue/allowlist.ts,
    apps/functions/src/sendblue/normalize.ts,
    apps/functions/src/sendblue/__tests__/allowlist.test.ts,
    apps/functions/src/sendblue/__tests__/normalize.test.ts
  </files>
  <behavior>
    Allowlist (port 1:1 from `apps/macos-imessage-worker/src/config.ts`):
    - Test: `useDmAllowlist()` returns true when env unset (fail-closed default per 17-CONTEXT)
    - Test: `useDmAllowlist()` returns false only when `IMESSAGE_DM_ALLOWLIST=0`
    - Test: `getPeerAllowlist()` parses CSV/semicolon/newline lists, normalizes to E.164
    - Test: `isSamePeer("+15551234567", "5551234567")` returns true (last-10-digit match)
    - Test: `isSamePeer(null, "+1...")` returns false
    - Test: email peers compared case-insensitive

    Normalizer (`normalizeSendblueInbound`):
    - Test: extracts `{ idempotencyKey: "sendblue-${message_handle}", fromNumber, toNumber, text, messageHandle, chatId, isGroup }` from valid `receive` payload
    - Test: returns `null` (caller treats as 200 OK + ignore) for non-`receive` events
    - Test: `isGroup=true` when `group_id` present and non-empty (caller rejects per Q-03 lock)
    - Test: missing `message_handle` throws (cannot enqueue without idempotency key)
    - Test: missing `content` returns null (empty inbound — match macOS worker behavior at index.ts:159)
    - Test: `chatId` is `iMessage;-;${from_number}` for 1:1 (matches macOS worker conventions for transcript continuity)
  </behavior>
  <action>
    TDD. Write tests first.

    `allowlist.ts`: copy `useDmAllowlist`, `getPeerAllowlist`, `getPeerDisplay`, `isSamePeer`, `normalizePeer` verbatim from `apps/macos-imessage-worker/src/config.ts`. Same env var names (`IMESSAGE_DM_ALLOWLIST`, `IMESSAGE_PEERS`, `IMESSAGE_PEER`, `IMESSAGE_DEFAULT_PEER`) so operator config carries over (per D-03).

    `normalize.ts`:
    - `isInboundReceiveEvent(payload): boolean` — checks `is_outbound !== true` and required fields present
    - `normalizeSendblueInbound(payload: SendblueInboundPayload): NormalizedInbound | null`
    - Idempotency key format: `sendblue-${message_handle}` (per D-02)
    - chatId synthesized to match `getImessageSessionExternalId` pattern from existing worker

    DO NOT touch macOS worker config.ts in this task — that's Task 8.
  </action>
  <verify>
    <automated>cd apps/functions &amp;&amp; npm test -- allowlist.test normalize.test</automated>
  </verify>
  <done>All allowlist + normalize tests pass; idempotency key shape matches D-02; allowlist semantics match macOS worker exactly.</done>
</task>

<task type="auto">
  <name>Task 4: Sendblue REST client + typing indicator (CHANNEL-05, CHANNEL-07)</name>
  <files>
    apps/functions/src/sendblue/sendblue-client.ts,
    apps/functions/src/sendblue/typing-indicator.ts
  </files>
  <action>
    `sendblue-client.ts`:
    - `sendImessage({ to, content, statusCallback? }): Promise&lt;SendblueSendResponse&gt;` — POST `https://api.sendblue.co/api/send-message` with `sb-api-key-id` + `sb-api-secret-key` headers (env-injected)
    - Use Node 18+ global `fetch` (CF runtime is Node 22 per Phase 10 success criteria)
    - 30s timeout via `AbortController`
    - On 4xx: throw `SendblueClientError` with status + parsed body (caller maps to `pa_outbound.failed` with reason)
    - On 5xx: throw `SendblueServerError` for retry path (caller updates `pa_outbound.error` and lets next CF invocation retry — see Task 6)
    - On `retry-after` header from 429: surface to caller (R-02 mitigation)

    `typing-indicator.ts`:
    - `sendTypingIndicator({ to }): Promise&lt;void&gt;` — POST `https://api.sendblue.co/api/send-message/typing-indicator` (CHANNEL-07)
    - Best-effort: log + swallow errors (typing UX, never block real send)

    Reads `SENDBLUE_API_KEY_ID` + `SENDBLUE_API_SECRET_KEY` from env (Firebase Secret Manager bound in Task 9). Functions accept creds as args for testability; export a default `getSendblueCreds()` env helper.

    NO test file in this task — covered by integration smoke in Task 11. Unit-testing fetch wrappers has poor ROI.
  </action>
  <verify>
    <automated>cd apps/functions &amp;&amp; npx tsc --noEmit</automated>
  </verify>
  <done>Client compiles; SendblueClientError + SendblueServerError exported; typing helper non-blocking.</done>
</task>

<task type="auto" tdd="true">
  <name>Task 5: paSendblueWebhook handler + audit producer (CHANNEL-01, CHANNEL-02, CHANNEL-03, CHANNEL-04)</name>
  <files>
    apps/functions/src/sendblue/webhook.ts,
    apps/functions/src/sendblue/audit.ts,
    apps/functions/src/sendblue/__tests__/webhook.test.ts
  </files>
  <behavior>
    - Test 1: invalid HMAC → 401 Unauthorized, NO inbound event created, NO audit record
    - Test 2: valid HMAC + non-allowlisted from_number → 200 OK, NO inbound event, ONE pa_audit_events record `{type: "allowlist_deny", channel: "imessage_sendblue", fromNumber}`
    - Test 3: valid HMAC + allowlisted + `receive` event → 200 OK, ONE pa_inbound_events row keyed `sendblue-${message_handle}`
    - Test 4: same `message_handle` posted twice (Sendblue retry) → exactly ONE inbound row (broker idempotency)
    - Test 5: `outbound` event type → 200 OK, NO inbound row (delivery telemetry only — per Q-02 lock, log + ignore)
    - Test 6: `typing_indicator` / `line_blocked` events → 200 OK, NO inbound row, audit log only
    - Test 7: `group_id` present (non-empty) → 200 OK, NO inbound row, audit `{type: "group_chat_rejected"}` (per Q-03 lock)
    - Test 8: empty `content` → 200 OK, NO inbound row (matches macOS worker `[dm] empty; skip`)
    - Test 9: malformed JSON body → 400 Bad Request
  </behavior>
  <action>
    TDD. Write `webhook.test.ts` first with the 9 cases above using firebase-functions-test or supertest harness against the exported handler function (mock Firestore via `getFirestore` injection — match `onPaInbound` test pattern).

    Then implement:

    `audit.ts`:
    - `recordAuditEvent(db, { type, channel, fromNumber?, reason?, payload? })` — writes to `pa_audit_events` collection (exists in `core-types/collections.ts`)

    `webhook.ts`:
    - `handleSendblueWebhook(req, res, deps)` — pure function for testability; deps: `{ db, secrets, now }`
    - Flow:
      1. Read RAW body (Express `req.rawBody` available in Firebase Functions onRequest); parse signature header
      2. `verifySendblueSignature(rawBody, header, secret)` — bad → 401, return
      3. Parse JSON body; bad JSON → 400
      4. Route by event type: `receive` | `outbound` | `typing_indicator` | `line_blocked` | other
         - non-`receive` → audit + 200 OK
      5. `normalizeSendblueInbound(payload)` — null → 200 OK + audit `{type: "inbound_skipped", reason}`
      6. Group chat check (`isGroup=true`) → audit `{type: "group_chat_rejected"}` + 200 OK
      7. Allowlist gate: `useDmAllowlist() &amp;&amp; !peers.some(p =&gt; isSamePeer(fromNumber, p))` → audit `{type: "allowlist_deny"}` + 200 OK
      8. `createInboundEvent(db, { channel: "imessage", idempotencyKey: "sendblue-${message_handle}", rawPayload })` (per D-02)
      9. 200 OK with `{ ok: true, eventId, created }`

    Critical: ALL audit events visible in dashboard abuse panel (BETA-03 dependency); ALL paths return 200 OK except invalid HMAC (401) and malformed body (400) — Sendblue retry policy (3× on 5xx) means anything but 2xx triggers re-delivery.
  </action>
  <verify>
    <automated>cd apps/functions &amp;&amp; npm test -- webhook.test</automated>
  </verify>
  <done>All 9 webhook tests pass; HMAC verified before any side-effect; broker idempotency proven via duplicate-handle test; audit producer wired for allowlist_deny + group_chat_rejected paths.</done>
</task>

<task type="auto" tdd="true">
  <name>Task 6: paSendblueOutbox CF — pa_outbound → Sendblue REST POST (CHANNEL-05, CHANNEL-07)</name>
  <files>
    apps/functions/src/sendblue/outbox.ts,
    apps/functions/src/sendblue/__tests__/outbox.test.ts
  </files>
  <behavior>
    - Test 1: pending pa_outbound row with allowlisted toE164 → fetch called once → row updated to status=sent
    - Test 2: non-allowlisted toE164 → row updated to status=failed with error="blocked by IMESSAGE_DM_ALLOWLIST" (mirror macOS worker outbox.ts:121-137)
    - Test 3: SendblueClientError (4xx) → row failed with parsed Sendblue error
    - Test 4: SendblueServerError (5xx) → row stays pending with error logged + attempt counter incremented (CF re-fires on next pa_outbound mutation OR scheduled reclaim — match `reclaimStuckOutboundJobs`)
    - Test 5: claim transaction prevents double-send (status=pending only)
    - Test 6: when `PA_TYPING_INDICATOR=1`, sendTypingIndicator called BEFORE sendImessage; when 0, skipped (D-06)
    - Test 7: `PA_CHANNEL_LEGACY=1` env present → CF returns early, NO send (D-08 — leaves macOS worker as authority)
    - Test 8: idempotency — same outbound docId triggered twice → only one Sendblue POST
    - Test 9: transcript-append rules from macOS outbox.ts:173 preserved (skip when idempotencyKey starts with "out-imessage-in-" OR "out-sendblue-")
  </behavior>
  <action>
    TDD. Write tests first.

    Implement `apps/functions/src/sendblue/outbox.ts`:
    - Export `paSendblueOutboxHandler(event, deps)` — pure handler taking event + deps `{ db, sendblueClient, now, getEnv }` for tests
    - Trigger: `onDocumentCreated("pa_outbound/{docId}", handler)` AND on update where status transitions to `pending` (handle reclaim case)
    - Port logic from `apps/macos-imessage-worker/src/outbox.ts:99-259` (`processOutboundJob`):
      - Claim via `runTransaction` (status pending → sending)
      - `PA_CHANNEL_LEGACY=1` early-return guard (D-08)
      - Allowlist gate (mirror outbox.ts:121-137, but keyed on `toE164` E.164 directly — no Apple-ID handle parsing)
      - Drop legacy `PA_OUTBOUND_ALLOWLIST_E164` second-layer (already covered by unified allowlist)
      - Transcript append (`appendMessage` with `idempotencyKey: outbox-msg-${docId}`) — match `shouldAppendOutboundTranscript` rule, extended to skip `out-sendblue-` prefix per D-02
      - **REPLACE**: `deliverOutboundBody(sdk, ...)` Photon SDK call → `sendblueClient.sendImessage({ to: toE164, content: body })`
      - On 4xx → status=failed with parsed error
      - On 5xx → status=pending + log + attempt counter (rely on next mutation / `reclaimStuckOutboundJobs`)
      - Status=sent on 2xx; record `messageHandle` from response onto pa_outbound row for delivery audit
    - Optional typing indicator: when `PA_TYPING_INDICATOR=1`, call `sendTypingIndicator` BEFORE `sendImessage` (D-06; CHANNEL-07 — replaces Phase 15 chunked sim)
    - DO NOT call Phase 15 chunker — Sendblue handles message delivery atomically

    Export from `webhook.ts` adjacency: NOT a new file. Outbox is its own module.
  </action>
  <verify>
    <automated>cd apps/functions &amp;&amp; npm test -- outbox.test</automated>
  </verify>
  <done>All 9 outbox tests pass; legacy flag honored; transcript rules preserved; typing-indicator gate respects D-06.</done>
</task>

<task type="auto">
  <name>Task 7: Wire CF entry exports + Phase 15 chunker dormancy (CHANNEL-07, depends on Tasks 5+6)</name>
  <files>
    apps/functions/src/index.ts,
    packages/pa-orchestrator/src/chunker.ts
  </files>
  <action>
    1. **Add CF exports** to `apps/functions/src/index.ts` (mirror existing `memoryAdmin` and `onPaInbound` export style at lines 322 and 400):

       ```typescript
       import { handleSendblueWebhook } from "./sendblue/webhook.js"
       import { paSendblueOutboxHandler } from "./sendblue/outbox.js"
       import { defineSecret } from "firebase-functions/params"

       const sendblueApiKeyId = defineSecret("SENDBLUE_API_KEY_ID")
       const sendblueApiSecretKey = defineSecret("SENDBLUE_API_SECRET_KEY")
       const sendblueWebhookSecret = defineSecret("SENDBLUE_WEBHOOK_SIGNING_SECRET")

       export const paSendblueWebhook = onRequest(
         { secrets: [sendblueWebhookSecret], region: "us-central1", cors: false },
         (req, res) => handleSendblueWebhook(req, res, { /* deps */ })
       )
       export const paSendblueOutbox = onDocumentCreated(
         {
           document: "pa_outbound/{docId}",
           secrets: [sendblueApiKeyId, sendblueApiSecretKey],
           region: "us-central1",
         },
         paSendblueOutboxHandler
       )
       ```

    2. **Phase 15 chunker dormancy** (CHANNEL-07, per D-06):
       - Edit `packages/pa-orchestrator/src/chunker.ts` (or wherever `isTypingIndicatorEnabled()` lives — confirm via grep)
       - Add comment block at top: `// DEPRECATED in Phase 21 — Sendblue native typing_indicator API replaces. Code retained until milestone v1.2 macOS worker deletion. Enable with PA_TYPING_INDICATOR=1 only when PA_CHANNEL_LEGACY=1 (macOS path).`
       - DO NOT delete the chunker code in this phase — D-06 says env-flip cutover, code removal in v1.2

    3. NO changes to orchestrator runtime — the `pa_outbound` write is the integration boundary. Orchestrator stays channel-agnostic per Phase 20 design.
  </action>
  <verify>
    <automated>cd apps/functions &amp;&amp; npm run build &amp;&amp; cd ../.. &amp;&amp; npm run typecheck --workspaces --if-present</automated>
  </verify>
  <done>`apps/functions/lib/index.js` builds cleanly; paSendblueWebhook + paSendblueOutbox exported; chunker carries deprecation banner.</done>
</task>

<task type="auto">
  <name>Task 8: PA_CHANNEL_LEGACY flag in macOS worker (CHANNEL-06, per D-08, D-11)</name>
  <files>
    apps/macos-imessage-worker/src/index.ts,
    apps/macos-imessage-worker/src/outbox.ts,
    apps/macos-imessage-worker/src/config.ts
  </files>
  <action>
    Wire `PA_CHANNEL_LEGACY` flag — controls macOS worker active vs dormant (per D-08 + D-11 rollback plan).

    1. Add to `apps/macos-imessage-worker/src/config.ts`:
       ```typescript
       export function isLegacyChannelEnabled(): boolean {
         return process.env.PA_CHANNEL_LEGACY === "1"
       }
       ```
       Default OFF (post-cutover Sendblue-only state). Operator opts in via `PA_CHANNEL_LEGACY=1`.

    2. In `apps/macos-imessage-worker/src/index.ts`:
       - At top of file (after env load, before SDK init): if `!isLegacyChannelEnabled()`, log `[legacy] PA_CHANNEL_LEGACY!=1 — worker exiting (Sendblue path active)` and `process.exit(0)` cleanly
       - This makes the macOS process a no-op when Sendblue is canonical, so `npm start` in worker dir doesn't compete with CF outbox

    3. In `apps/macos-imessage-worker/src/outbox.ts`:
       - At top of `processOutboundJob` (after claim, before send): if `!isLegacyChannelEnabled()`, release claim back to `pending` and return — lets `paSendblueOutbox` CF take it. Log `[legacy] releasing claim — Sendblue path canonical`.
       - This handles the race where macOS worker is mid-running during cutover

    4. DO NOT delete worker code. Per D-08, worker stays in repo for one milestone for rollback safety.
  </action>
  <verify>
    <automated>cd apps/macos-imessage-worker &amp;&amp; npm test &amp;&amp; npm run build</automated>
  </verify>
  <done>Worker exits cleanly when `PA_CHANNEL_LEGACY` unset; runs full path when `=1`; outbox processor releases claim under non-legacy mode; existing tests pass.</done>
</task>

<task type="auto">
  <name>Task 9: Firebase Secret Manager migration + runbook (per D-07)</name>
  <files>
    .planning/phases/21-sendblue-channel-migration/21-RUNBOOK.md
  </files>
  <action>
    1. Migrate secrets from `apps/functions/.env` plaintext to Firebase Secret Manager:

       ```bash
       cd apps/functions
       # Reads value interactively; do NOT paste in CLI history
       firebase functions:secrets:set SENDBLUE_API_KEY_ID
       firebase functions:secrets:set SENDBLUE_API_SECRET_KEY
       firebase functions:secrets:set SENDBLUE_WEBHOOK_SIGNING_SECRET
       firebase functions:secrets:access SENDBLUE_API_KEY_ID    # verify
       ```

    2. Confirm Task 7 wired `defineSecret(...)` + `secrets: [...]` binding on both CF entries — secrets are NOT visible to functions without explicit binding.

    3. Write `.planning/phases/21-sendblue-channel-migration/21-RUNBOOK.md` with these sections:
       - **Cutover sequence** (D-08 ordering):
         1. Set 3 secrets in Firebase Secret Manager
         2. `cd apps/functions &amp;&amp; npm run build &amp;&amp; firebase deploy --only functions:paSendblueWebhook,functions:paSendblueOutbox`
         3. In Sendblue dashboard: configure webhook URL → `https://us-central1-{project}.cloudfunctions.net/paSendblueWebhook`, subscribe to `receive`, `outbound`, `typing_indicator`, `line_blocked`
         4. Drain check: `firestore where pa_outbound.status=pending` empty AND `pa_inbound_events.status=pending` empty
         5. Run sandbox smoke (Task 11)
         6. Set `PA_CHANNEL_LEGACY=0` on macOS worker host; restart macOS worker → it exits (Task 8)
         7. Verify Adam-only inbound on Sendblue line E2E
       - **Rollback (D-11)**:
         1. Set `PA_CHANNEL_LEGACY=1` on macOS worker host
         2. Restart macOS worker (Photon polls resume; CF outbox releases claims back to pending; macOS worker picks up)
         3. In Sendblue dashboard: pause webhook subscription
         4. CF endpoints stay deployed but idle
       - **Drain procedure** (D-09): Adam keeps macOS worker running until pending outbound queue empty, then flips flag.
       - **Contract Q tracker** (CHANNEL-08): table of 4 Adam-pending questions with status column.

    4. Local dev `.env` keeps plaintext (gitignored) — document in runbook that local dev path uses `.env`, prod uses Secret Manager.
  </action>
  <verify>
    <automated>test -f .planning/phases/21-sendblue-channel-migration/21-RUNBOOK.md &amp;&amp; grep -q "Cutover sequence" .planning/phases/21-sendblue-channel-migration/21-RUNBOOK.md &amp;&amp; grep -q "Rollback" .planning/phases/21-sendblue-channel-migration/21-RUNBOOK.md</automated>
  </verify>
  <done>3 Sendblue secrets in Firebase Secret Manager; runbook documents cutover + rollback + drain + contract-Q tracker.</done>
</task>

<task type="checkpoint:human-action" gate="blocking">
  <name>Task 10: Adam — answer Sendblue contract Qs + provision sandbox (CHANNEL-08)</name>
  <files>.planning/phases/21-sendblue-channel-migration/21-RUNBOOK.md</files>
  <what-built>
    All implementation tasks (1–9) complete; CF deployable; secrets in Secret Manager; macOS worker rollback path armed.
  </what-built>
  <action>
    Adam-required actions before Task 11 smoke can run. Update the Contract-Q tracker in 21-RUNBOOK.md inline.

    1. **Sendblue Free Sandbox provisioned** — sign up if not already; verify Adam's iMessage number as one of the 10 sandbox contacts (Sendblue dashboard → Sandbox → Verified contacts)
    2. **Webhook signing secret generated** — Sendblue dashboard → Webhooks → Add endpoint → copy per-webhook secret → run `firebase functions:secrets:set SENDBLUE_WEBHOOK_SIGNING_SECRET`
    3. **Contract Qs (CHANNEL-08) — record in 21-RUNBOOK.md Contract-Q tracker**:
       - Q1: Apple ID ownership (Sendblue or operator)?
       - Q2: SLA on number re-provisioning if Apple flags line?
       - Q3: Outbound rate limit (only inbound 1000/day documented)?
       - Q4: GDPR / data residency — does Sendblue log/store message content?
    4. **GO / NO-GO call on cutover**:
       - GO → proceed to Task 11 sandbox smoke, then Task 12 production cutover
       - DEFER → land all code behind `PA_CHANNEL_LEGACY=1`, re-evaluate post-closed-beta (per ROADMAP launch gate)

    Note: Contract Qs do NOT block code-landing or sandbox smoke. They block production cutover (`PA_CHANNEL_LEGACY=0`). Adam may choose to ship code + sandbox smoke + keep `PA_CHANNEL_LEGACY=1` for closed beta, defer flip to public-launch cycle.
  </action>
  <how-to-verify>
    Same as &lt;action&gt; — these are Adam-only steps.
  </how-to-verify>
  <verify>Adam types resume signal below.</verify>
  <done>Sendblue sandbox active for Adam's number; SENDBLUE_WEBHOOK_SIGNING_SECRET in Firebase Secret Manager; Contract-Q tracker in runbook updated; resume signal received.</done>
  <resume-signal>Reply "go-sandbox" to proceed to Task 11 sandbox smoke; "go-cutover" to also flip flag in Task 12; "defer" to land code behind legacy flag and stop here.</resume-signal>
</task>

<task type="auto">
  <name>Task 11: Sandbox round-trip smoke (CHANNEL-09 — depends on Task 10 "go-sandbox")</name>
  <files>
    .planning/phases/21-sendblue-channel-migration/21-RUNBOOK.md
  </files>
  <action>
    Execute the smoke test against Sendblue Free Sandbox. Append results to `21-RUNBOOK.md` under "Sandbox smoke results" section.

    **Pre-flight:**
    1. Confirm `firebase functions:secrets:access` returns all 3 Sendblue secrets
    2. Confirm Sendblue webhook endpoint configured to CF URL with subscriptions to 4 events
    3. Confirm Adam's number in `IMESSAGE_PEERS` allowlist for the CF runtime (set via `firebase functions:config:set` or Firestore platform-flags)
    4. Confirm `PA_CHANNEL_LEGACY=0` for the CF (Sendblue active path) — note macOS worker may still be running locally with `=1`; that's intentional parallel-run during smoke

    **Smoke (CHANNEL-09 budget: <30s p95):**
    1. Adam's iMessage → Sendblue sandbox number: `"hello from sendblue smoke 1"`
    2. Watch CF logs (`firebase functions:log --only paSendblueWebhook`):
       - HMAC verified
       - Allowlist passed
       - `pa_inbound_events` row created keyed `sendblue-${message_handle}`
    3. Watch CF logs (`firebase functions:log --only paSendblueOutbox`):
       - `pa_outbound` row picked up
       - Sendblue REST POST 200 OK
       - Status=sent
    4. Adam receives PA reply on iMessage — measure receipt timestamp from inbound to outbound delivery
    5. Repeat 5×; record p50, p95, max latencies

    **Fail-mode probes (must all pass):**
    - Send with bad-signature header (curl manually) → expect 401, no inbound row
    - Send from non-allowlisted number → expect 200 OK, no inbound row, audit_event `allowlist_deny` written
    - Send same `message_handle` twice (curl replay) → expect single `pa_inbound_events` row (broker idempotency)
    - Group-chat payload (synthetic via curl) → expect 200 OK, no inbound row, audit `group_chat_rejected`

    **Success criteria (CHANNEL-09):** p95 latency &lt;30s end-to-end across 5 trials; all 4 fail-mode probes pass.

    **Failure path:** If smoke fails, log root cause in runbook. Do NOT proceed to Task 12. Most likely failure mode: HMAC header name mismatch (re-verify Task 1 finding) OR CF cold start &gt;30s (set `minInstances: 1` per R-05 mitigation).
  </action>
  <verify>
    <automated>grep -q "Sandbox smoke results" .planning/phases/21-sendblue-channel-migration/21-RUNBOOK.md &amp;&amp; grep -q "p95" .planning/phases/21-sendblue-channel-migration/21-RUNBOOK.md</automated>
  </verify>
  <done>5-trial smoke recorded with p95 &lt;30s; 4 fail-mode probes documented as passing; runbook updated.</done>
</task>

<task type="checkpoint:human-verify" gate="blocking">
  <name>Task 12: Production cutover GO/NO-GO + flag flip (CHANNEL-06, depends on Task 11)</name>
  <files>.planning/phases/21-sendblue-channel-migration/21-RUNBOOK.md</files>
  <what-built>
    All code landed; sandbox smoke passed; secrets in Secret Manager; runbook + rollback procedure written.
  </what-built>
  <action>
    Adam decision point — only proceed if Task 10 returned "go-cutover". Append cutover outcome (GO / ROLLBACK / DEFERRED) to 21-RUNBOOK.md.

    1. **Final pre-flight checks:**
       - Sandbox smoke p95 &lt;30s ✅ (Task 11)
       - Contract Qs answered or explicitly deferred ✅ (Task 10)
       - macOS worker shows clean `PA_CHANNEL_LEGACY=1` parallel-run ✅
       - `pa_outbound where status=pending` is empty ✅ (drain per D-09)
       - Rollback plan rehearsed mentally ✅ (D-11)

    2. **Execute cutover** (per runbook Cutover sequence):
       - On macOS worker host: set `PA_CHANNEL_LEGACY=0`, restart worker → expect clean exit (Task 8 behavior)
       - In Sendblue dashboard: switch from sandbox line to paid dedicated line ($100/mo); update webhook URL if changed
       - Verify CF logs show paSendblueWebhook + paSendblueOutbox handling Adam's traffic exclusively for 30 min

    3. **Verify CHANNEL-09 in production:**
       - 5 real-traffic round trips on production line; p95 &lt;30s confirmed
       - No `pa_outbound` rows stuck in `sending` for &gt;5 min
       - Phase 15 chunker confirmed dormant (no chunked-send log lines)

    4. **Confirm or rollback:**
       - GO → mark Phase 21 success criteria 7 satisfied; macOS worker stays in repo behind flag for milestone v1.2 deletion
       - ROLLBACK → execute D-11 rollback (set `PA_CHANNEL_LEGACY=1`, restart worker, pause Sendblue webhook); document failure mode in runbook
  </action>
  <how-to-verify>
    Same as &lt;action&gt; — Adam-only execution steps + production round-trip observation.
  </how-to-verify>
  <verify>Adam types resume signal below; production round-trip latencies appended to 21-RUNBOOK.md.</verify>
  <done>Production cutover outcome (GO/ROLLBACK/DEFERRED) appended to runbook with 5-trial production latency table.</done>
  <resume-signal>Reply "cutover-confirmed" if production round-trip passes; "rolled-back" if rollback executed; "stay-legacy" if Adam defers and keeps closed-beta on macOS worker.</resume-signal>
</task>

</tasks>

<verification>
**Goal-backward truths (all must hold post Task 12 GO):**

1. ✅ Inbound iMessage to Sendblue line creates `pa_inbound_events` keyed `sendblue-${message_handle}` within 5s (Task 11 logs confirm)
2. ✅ Bad HMAC → 401, no inbound (Task 5 test 1, Task 11 fail-mode probe)
3. ✅ Non-allowlisted from_number → 200 OK + audit deny + no inbound (Task 5 test 2, Task 11 probe)
4. ✅ End-to-end &lt;30s p95 (CHANNEL-09 — Task 11 + Task 12)
5. ✅ Sendblue retry produces single inbound row (Task 5 test 4, Task 11 probe)
6. ✅ `PA_CHANNEL_LEGACY=1` keeps macOS worker functional (Task 8 tests)
7. ✅ Phase 15 chunker dormant on Sendblue path (Task 6 test 6, Task 7 deprecation banner, Task 12 verification)
8. ✅ Firebase Secret Manager bound (Task 9, Task 7 `defineSecret`)
9. ✅ Sandbox round-trip smoke logged (Task 11 → runbook)

**Requirement coverage map:**

| REQ-ID | Task |
|---|---|
| CHANNEL-01 (paSendblueWebhook handler) | Task 5, Task 7 |
| CHANNEL-02 (HMAC verify) | Task 1, Task 2, Task 5 |
| CHANNEL-03 (idempotency key migration) | Task 3 (normalize), Task 5 (broker call) |
| CHANNEL-04 (allowlist port to webhook) | Task 3 (port), Task 5 (gate) |
| CHANNEL-05 (outbox REST POST) | Task 4 (client), Task 6 (handler), Task 7 (CF export) |
| CHANNEL-06 (PA_CHANNEL_LEGACY flag) | Task 8, Task 12 |
| CHANNEL-07 (Phase 15 chunker deprecated) | Task 6 (typing API call), Task 7 (banner), Task 12 (verify dormant) |
| CHANNEL-08 (contract Qs) | Task 1 (probe HMAC), Task 9 (runbook tracker), Task 10 (Adam answers) |
| CHANNEL-09 (sandbox smoke <30s) | Task 11 (sandbox), Task 12 (production confirm) |

**Build / typecheck / test gates:**
- `npm run build` (apps/functions) ✅ (Task 7)
- `npm test` (apps/functions/sendblue) ✅ (Tasks 2, 3, 5, 6 — 30+ unit tests across 5 files)
- `npm test` (apps/macos-imessage-worker) ✅ (Task 8 — existing tests pass with new flag)
- `npm run typecheck --workspaces` ✅ (Task 7)
</verification>

<success_criteria>
1. CF endpoints `paSendblueWebhook` + `paSendblueOutbox` deployed; Sendblue webhook configured with HMAC verify (CHANNEL-01, CHANNEL-02).
2. `pa_inbound_events` keyed `sendblue-${message_handle}`; broker idempotency proven (CHANNEL-03).
3. Allowlist enforced in webhook handler against `from_number`; deny path emits `pa_audit_events` (CHANNEL-04).
4. `pa_outbound` flow uses Sendblue REST `POST /api/send-message` (CHANNEL-05); macOS worker behind `PA_CHANNEL_LEGACY=1` (CHANNEL-06).
5. Phase 15 chunker dormant on Sendblue path; Sendblue native typing_indicator API used when `PA_TYPING_INDICATOR=1` (CHANNEL-07).
6. Sendblue contract Qs documented and Adam-decided (CHANNEL-08).
7. Sandbox round-trip smoke <30s p95 (CHANNEL-09).
8. Firebase Secret Manager holds 3 Sendblue secrets; `apps/functions/.env` plaintext deprecated for prod.
9. Runbook documents cutover + rollback + drain + contract-Q tracker.
10. All 30+ unit tests pass; build clean; macOS worker tests still green.
</success_criteria>

<output>
After completion, create `.planning/phases/21-sendblue-channel-migration/21-01-SUMMARY.md` with:
- Decisions executed (D-01 through D-11) — link to code lines
- Sandbox smoke results table (p50/p95/max across 5 trials)
- Production cutover result (GO / ROLLBACK / DEFERRED)
- Contract Qs answered (or marked Adam-pending with target date)
- LOC deltas (CF added, macOS worker untouched but flagged, chunker banner only)
- Runbook link
- Followups for milestone v1.2 (macOS worker code DELETION, Phase 15 chunker DELETION, allowlist promotion to shared package if WhatsApp lands)
</output>
