# Phase 31 — Upstream Event Connector (CONTEXT)

**Owner P9:** P9-Connectors (not spawned yet — likely shares P9 with Phase 30)
**P10 strategy:** v1.3 expansion (2026-04-28)
**ROADMAP entry:** `.planning/ROADMAP.md` Milestone v1.3 table

## 底层逻辑 (P10 quote)

> 反方向 connector — 外部系统 push 事件 (interview scheduled / job match found / salary research complete / offer letter received) → PA 主动用 Claire voice 给用户发消息. 不是 system notification, 是 in-character proactive message via templated copy. Phase 22 proactive-checkin 已建好 outbound 通道 (`pa-outbound`), 这里只是新加 inbound endpoint + template lookup + enqueue.

业务侧痛点: 通知用户 "面试已安排" 不应该是冷冰冰系统消息, 应该是 Claire 用她的语气讲: "嘿, 周三下午两点的面试安排好了, 要我帮你过一下要点吗?"

## 顶层设计

```
external partner system
  ↓ POST /paInboundEvent  (HMAC signed, partner secret)
  ↓ verify HMAC, parse {eventType, userId, payload}
  ↓ rate-limit check (per eventType × per user)
  ↓ lookup pa-event-templates/{eventType}
  ↓ render Mustache-lite (template + payload vars)
  ↓ enqueue to pa-outbound (existing CF picks up)
  ↓ audit row to pa-event-inbound
```

## Schema (locked)

`pa-event-templates/{eventType}`:
```
{
  eventType: string,               // doc id, e.g. "interview_scheduled"
  template: string,                // Mustache-lite "Hey, your interview at {{company}} on {{when}} is locked in. Want me to prep you?"
  variableMap: { [key: string]: string },
                                   // documents expected payload keys + descriptions
  agentSlug: string,               // which agent voice to send as (default "claire")
  handbookSlug: string,            // for downstream voice rendering (default "claire")
  enabled: boolean,
  rateLimit: {
    perUserSoftPerHour: number,    // default 1
    perUserHardPerDay: number      // default 24
  },
  partnerOwner: string,            // partner team email
  createdAt, updatedAt, updatedBy
}
```

`pa-event-partners/{partnerId}`:
```
{
  partnerId: string,               // doc id
  name: string,
  hmacSecretRef: string,           // Secret Manager key id
  allowedEventTypes: string[],     // partner can only push these
  enabled: boolean,
  createdAt, updatedAt
}
```

`pa-event-inbound/{id}` (audit + rate-limit log):
```
{
  partnerId: string,
  eventType: string,
  userId: string,
  receivedAt: Timestamp,
  payload: object,                 // sanitized
  result: "enqueued" | "rate_limited_soft" | "rate_limited_hard"
        | "template_missing" | "user_unknown" | "auth_failed",
  outboundId: string | null,       // if enqueued
  ttlExpiresAt: Timestamp          // 30-day TTL
}
```

## Endpoint

`apps/functions/src/inbound-events.ts` exposes `paInboundEvent` HTTPS CF:
- Method: `POST` only
- Headers: `X-PA-Partner: <partnerId>`, `X-PA-Signature: sha256=<hex>`
- Body: `{ eventType, userId, payload }`
- Auth: HMAC verify with partner's `hmacSecretRef` (resolved from Secret Manager)
- Errors:
  - 401 auth failed (HMAC mismatch / missing partner)
  - 403 event type not in `allowedEventTypes`
  - 404 user / template not found
  - 429 rate-limited
  - 202 accepted + enqueued (no body, async outbound)

## Auth (HMAC)

- Secret per partner (NOT per event type — rotation friendly).
- HMAC sha256 over raw body bytes.
- 5-minute timestamp window via `X-PA-Timestamp` header to prevent replay.
- Reuse `apps/functions/src/sendblue/hmac.ts` shared verifier (already in repo, already signed by Adam in `git status`).

## Backpressure (rate-limit)

Per (eventType × userId):
- **Soft**: 1 per hour (configurable per template). Excess returns 202 with `result: "rate_limited_soft"` written to audit but no outbound enqueue.
- **Hard**: 24 per day. Excess returns 429.

Implementation: count `pa-event-inbound` docs for `(eventType, userId)` within window. Firestore composite index needed (documented in INDEX.md).

## Mustache-lite renderer

Single helper `renderTemplate(template: string, vars: object): string`:
- Supports `{{var}}` and `{{nested.key}}` (depth ≤2)
- Supports `{{#var}}...{{/var}}` boolean conditional sections
- NO loops, NO partials, NO functions
- Missing var → empty string + warn log (NOT throw — partner data quality varies)
- Output passes through Phase 20 normalizer before enqueue (so Claire voice rules apply)

## Outbound enqueue

Renders template → writes to `pa-outbound` collection with:
```
{
  agentSlug: <template.agentSlug>,
  userId,
  text: <rendered>,
  source: "inbound_event",
  sourceEventType: eventType,
  sourcePartner: partnerId,
  createdAt, status: "queued"
}
```

Existing `paSendblueOutbox` CF (in `apps/functions/src/sendblue/outbox.ts`) picks up + sends. NO new sender code.

## Success criteria

1. `paInboundEvent` HTTPS CF deployed with HMAC verify + 5-min timestamp window
2. `pa-event-templates/{eventType}` + `pa-event-partners/{partnerId}` + `pa-event-inbound/{id}` collections + schema
3. Mustache-lite renderer with `{{var}}` + `{{nested.key}}` + `{{#var}}...{{/var}}` (no loops/partials)
4. Variable substitution happens BEFORE enqueue; rendered text passes Phase 20 normalizer
5. Per-(eventType × userId) rate-limit (soft 1/hr, hard 24/day) enforced via `pa-event-inbound` count
6. Successful render → row in `pa-outbound`, `paSendblueOutbox` picks it up unchanged
7. Audit row written for every inbound (success + rate-limit + auth fail)
8. Dashboard `/admin/events` page: partner CRUD + template CRUD + recent inbound audit drawer
9. One default template seeded (disabled): `interview_scheduled` → "Hey {{firstName}}, your {{company}} interview on {{when}} is locked in. Want a quick prep pass?"

## Architectural decisions (locked)

- **Per-partner HMAC secret**: rotation-friendly. Reuse Sendblue HMAC helper.
- **Rate-limit storage**: Firestore count query on `pa-event-inbound`. NOT in-memory (multi-instance safe).
- **Renderer scope**: Mustache-lite, NOT full Mustache or Handlebars (security + simplicity).
- **Outbound channel**: existing `pa-outbound` collection. ZERO new sender code.
- **Template field on doc**: stored as raw string (not parsed AST) — re-parsed on each render. Cheap; allows live edit.
- **Voice rendering**: rendered output passes through Phase 20 normalizer so Claire voice rules apply (e.g. no AI-self-mention).
- **Event-type → template lookup**: 1:1. Multiple templates per event-type would need versioning + A/B; out of scope for v1.

## Out-of-scope (DO NOT do)

- DO NOT support GraphQL / batch event payloads (single event per POST)
- DO NOT support nested loops / Handlebars helpers
- DO NOT add per-event A/B template variants (single template per event-type v1)
- DO NOT auto-create unknown event types (must exist in `pa-event-templates` first)
- DO NOT bypass Phase 20 normalizer (rendered text MUST pass it before enqueue)
- DO NOT enable seeded `interview_scheduled` template by default

## Risks

- R1: Partner pushes high-volume noise → user spam. Mitigation: per-user soft+hard rate-limit, kill switch via partner `enabled: false`.
- R2: Template variable injection via partner payload → prompt injection in Claire output. Mitigation: Phase 20 normalizer + payload value length cap (256 chars per var) + Hermes-style scanner from Phase 27 if/when live.
- R3: HMAC replay attack. Mitigation: 5-min timestamp window + reject duplicate `X-PA-Timestamp` within window (in-process LRU 1k entries).
- R4: User unknown (partner sent stale userId). Mitigation: 404 + audit row + alert (`pa.events.user_unknown` log metric).
- R5: Outbound queue backup. Mitigation: existing `paSendblueOutbox` already has Phase 26 rate-limit + cost alert; this phase adds `pa.events.enqueued` log metric.
