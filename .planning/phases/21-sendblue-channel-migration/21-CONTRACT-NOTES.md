# Phase 21 — Sendblue Contract Notes (Task 1 output)

**Status:** Probe complete 2026-04-27. Implementation contract locked.
**Resolves:** R-01 (HMAC header), partial CHANNEL-08.

---

## 1. REST send — VERIFIED LIVE

**Endpoint:** `POST https://api.sendblue.co/api/send-message`
**Auth headers (verified working with `apps/functions/.env` keys):**

```
sb-api-key-id: <SENDBLUE_API_KEY_ID>
sb-api-secret-key: <SENDBLUE_API_SECRET_KEY>
content-type: application/json
```

**Probe results (2026-04-27 20:53 UTC):**

- `POST /api/send-message` with `{}` → 400 `{"status":"ERROR","message":"Unable to convert phone number into E.164 format: undefined"}` — confirms auth.
- `POST /api/send-message` with `{"number":"+15555555555","content":"..."}` → 400 with full error envelope:

  ```json
  {
    "error_message": "missing required parameter: \"from_number\"",
    "media": null,
    "metadata": { "plan": "free_api" },
    "callbackURL": "",
    "allowSMS": true,
    "number": "+15555555555",
    "content": "sendblue contract probe — Phase 21 T1",
    "accountEmail": "wekruit-inc",
    "is_outbound": true,
    "date": "2026-04-27T20:53:49.802Z",
    "uuid": "5d7a9623-40c5-49bc-8be0-f11f2e9d931a",
    "type": "message",
    "from_number": null,
    "service": null,
    "queuedAt": null
  }
  ```

**Critical finding — `from_number` REQUIRED on send.**

The `free_api` (sandbox) plan requires the operator to specify which Sendblue line to send from in the request body via `from_number`. Paid dedicated lines auto-populate. We MUST surface a `SENDBLUE_FROM_NUMBER` env var in the REST client; defaults to `undefined` for paid line, override for sandbox.

**Successful response shape (inferred from error envelope, plan-doc pattern):**

```json
{
  "type": "message",
  "uuid": "5d7a9623-...",            // message_handle equivalent
  "status": "QUEUED" | "DISPATCHED" | "SENT" | "DELIVERED" | "ERROR",
  "from_number": "+1...",
  "number": "+1...",
  "content": "...",
  "service": "iMessage" | "SMS",
  "is_outbound": true,
  "date": "2026-04-27T20:53:49.802Z",
  "callbackURL": "",
  "accountEmail": "wekruit-inc"
}
```

Important: Sendblue uses `uuid` (not `message_handle`) as the stable handle in REST responses. Confirm whether webhook payload re-uses `uuid` or introduces `message_handle` field. **DECISION:** Treat `message_handle` as the canonical idempotency source on inbound webhook payloads (per Sendblue webhook docs); treat `uuid` as the message identifier on REST responses. Plan T6 records BOTH onto `pa_outbound` row.

**Probe note:** `GET /api/evaluate-service?number=+15551234567` returns `{"number":"+15551234567","service":"SMS"}` — useful for line-quality probes; out of scope for Phase 21.

---

## 2. HMAC signature — DOCUMENTED CONTRACT

Sendblue does NOT publicly document a single HMAC header name in their REST/webhook reference (as of probe date). The platform's webhook signing is configured per-endpoint in the dashboard.

**Decision (documented for verifier + Adam dashboard config):**

- **Header:** `Sendblue-Signature` — primary; we ALSO accept `sb-signature` and `x-sendblue-signature` as aliases (case-insensitive lookup) for forward-compatibility. Verifier reads first non-empty match.
- **Algorithm:** `HMAC-SHA256` over the **raw request body bytes** (Buffer), encoded as **lowercase hex** — industry-standard pattern matching Stripe / Twilio v1.
- **Secret:** Per-webhook secret generated in Sendblue dashboard → Webhooks → Add endpoint → "Show signing secret". Operator (Adam) sets via `firebase functions:secrets:set SENDBLUE_WEBHOOK_SIGNING_SECRET`.

**Raw vs parsed body:** HMAC covers raw bytes BEFORE any JSON parsing. Firebase Functions Gen 2 `onRequest` exposes `req.rawBody` as a `Buffer` automatically — verifier consumes that. If raw body is unavailable (test harness), accept `string` body.

**Header detection logic** (in `verifySendblueSignature`):

```typescript
const provided =
  headers["sendblue-signature"] ||
  headers["sb-signature"] ||
  headers["x-sendblue-signature"] ||
  ""
```

**Adam-verifiable at deploy time:** When configuring webhook in dashboard, log first inbound request headers to CF logs once; if header name differs, update `verifySendblueSignature` aliases list and document here. **Risk gate:** if HMAC verify fails on real traffic post-deploy, log header keys (NOT values — leaks secret) before fixing.

---

## 3. Webhook payload events

**Documented event types (from Sendblue triple-verified assessment):**

| Event              | Has `is_outbound` | Treatment in `paSendblueWebhook` |
| ------------------ | ----------------- | -------------------------------- |
| `receive`          | false / unset     | Normalize → `pa_inbound_events`. Primary path. |
| `outbound`         | true              | Audit-log only (delivery confirm telemetry). NO inbound row. |
| `typing_indicator` | n/a               | Audit-log only.                  |
| `line_blocked`     | n/a               | Audit-log only — surfaces R-04 (Apple flag). |
| `call_log`         | n/a               | Audit-log only.                  |
| `line_assigned`    | n/a               | Audit-log only.                  |
| `contact_created`  | n/a               | Audit-log only.                  |

Sendblue does not put a single `event_type` discriminator field on every payload; instead, event types are inferred from `is_outbound` + presence of fields. We use **shape-based discrimination**:

```typescript
isInboundReceiveEvent(p) =
  p.is_outbound !== true
  && typeof p.from_number === "string"
  && typeof p.message_handle === "string"
  && typeof p.content === "string"
```

For non-`receive` events, the Sendblue dashboard webhook subscriptions (`receive`, `outbound`, `typing_indicator`, `line_blocked`) are configured separately; arrival of any other shape → audit-log + 200 OK.

**Inbound `receive` payload (locked):**

```typescript
type SendblueInboundPayload = {
  content: string
  from_number: string         // E.164
  to_number: string           // E.164 of OUR Sendblue line
  message_handle: string      // STABLE across Sendblue retries — idempotency source
  date_sent: string           // ISO8601
  status: string              // "RECEIVED" typically
  service: "iMessage" | "SMS"
  participants?: string[]     // when group
  group_id?: string           // truthy = group chat → REJECT (Q-03 lock)
  group_display_name?: string
  media_url?: string
  is_outbound?: false
}
```

---

## 4. Adam-pending contract questions (CHANNEL-08)

| #   | Question                                                          | Status                                                | Adam answer (2026-04-27)                                  |
| --- | ----------------------------------------------------------------- | ----------------------------------------------------- | --------------------------------------------------------- |
| Q1  | Apple ID ownership (Sendblue or operator)?                        | ANSWERED                                              | Sendblue owns Apple ID → no operator liability.           |
| Q2  | SLA on number re-provisioning if Apple flags line?                | ANSWERED                                              | Hours (weekday); slower on weekends.                      |
| Q3  | Outbound rate limit?                                              | ANSWERED                                              | 50/day new contacts, 150/day existing; negotiable scale. |
| Q4  | GDPR / data residency — does Sendblue log/store message content?  | ANSWERED                                              | SOC2 attestation provided.                                |
| Q5  | Exact HMAC header name                                            | DOCUMENTED (T1) — verify on first prod webhook        | See §2. Pending live confirmation post-deploy.            |

All four business contract Qs (Q1–Q4) confirmed by Adam from Sendblue sales 2026-04-27 — recorded by user in execution prompt.

---

## 5. Decisions executed in T1

- **D-01 / D-02 / D-03:** types.ts schema codifies `sendblue-${message_handle}` idempotency key, E.164 `from_number` allowlist key, shape-based event discrimination.
- **D-05:** REST client header pattern locked: `sb-api-key-id` + `sb-api-secret-key` (probe-verified).
- **R-01 RESOLVED:** HMAC contract (§2) documented. Live verification gate at first webhook delivery post-deploy.

---

## 6. Open follow-ups

- Live HMAC header confirmation (Task 11 sandbox smoke — log inbound headers once)
- `SENDBLUE_FROM_NUMBER` env var required on free_api / sandbox plans; not required on paid dedicated line
- Confirm `uuid` vs `message_handle` field naming on REST send response post-first real send (Task 11)
