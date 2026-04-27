# Phase 21 — Sendblue Channel Migration (CONTEXT)

**Status:** planning
**Owner:** Adam (contract decisions) + executor (implementation)
**Milestone:** v1.1 Pre-Launch Hardening + Companion Brain
**Created:** 2026-04-27
**Estimated effort:** 5–7 dev-days (largest phase by surface area in v1.1)
**Requirements addressed:** CHANNEL-01 .. CHANNEL-09

---

## 1. Goal

Replace `apps/macos-imessage-worker/` with Sendblue hosted iMessage transport.

Eliminates two Adam-flagged risks in one move:

1. **Single-host availability** — worker runs on Adam's laptop; offline = product offline (B2 in Phase 17 CONTEXT)
2. **Apple-ID ToS exposure** — single Apple ID auto-replying violates iCloud AUP §VI.B at scale (B1 in Phase 17 CONTEXT, also pinned in MEMORY `imessage_apple_id_tos`)

Sendblue is **pure transport** (triple-verified — see `~/.claude/.../sendblue_assessment.md`). LLM, agent runtime, memory, persona, broker, allowlist, audit all stay with us.

## 2. Architecture deltas

**KEEP (unchanged):**
- `packages/pa-orchestrator/*` (orchestrator + Voice v1 + normalizer)
- `packages/pa-broker/*` (inbound idempotency by `idempotencyKey`)
- `packages/agent-runtime/*`, `packages/memory/*`, `packages/agent-registry/*`
- `pa_inbound_events` / `pa_outbound` collection schemas
- Allowlist semantics (`useDmAllowlist()` fail-closed default, `IMESSAGE_DM_ALLOWLIST` env, peer normalization)

**DELETE (after one-milestone parallel run behind `PA_CHANNEL_LEGACY=1`):**
- `apps/macos-imessage-worker/` (~1000 LOC) — Photon SDK polling, cursor recovery, outbox listener
- `packages/pa-orchestrator/src/chunker.ts` chunked typing simulation (Phase 15) — Sendblue native `typing_indicator` API replaces

**ADD:**
- `apps/functions/src/sendblue/` — webhook handler, REST send client, HMAC verify, payload normalize, allowlist port (~150 LOC)
- New CF endpoint: `paSendblueWebhook` (HTTPS, POST)
- New outbox processor: triggered by `pa_outbound` Firestore writes (CF `onDocumentCreated`), POSTs to `https://api.sendblue.co/api/send-message`

**CHANGE:**
- Idempotency key: `imessage-in-${rowId}` → `sendblue-${message_handle}`
- Allowlist key: Apple-ID handle (email/+phone) → Sendblue `from_number` (E.164)
- Outbox transport: Photon `IMessageSDK.send()` → Sendblue REST `POST /api/send-message`
- Typing indicator: chunked simulation → REST `POST /api/send-message/typing-indicator`

## 3. Sendblue contract — known + unknown

**Known (from triple-verified docs):**
- 7 webhook events: `receive`, `outbound`, `typing_indicator`, `call_log`, `line_blocked`, `line_assigned`, `contact_created`
- Inbound payload includes: `content`, `from_number`, `to_number`, `message_handle`, `date_sent`, `status`, `service: "iMessage" | "SMS"`, `participants`, optional `group_id`, `group_display_name`, `media_url`
- Outbound payload similar + `is_outbound: true` + `status`
- HMAC signature verify supported (per-webhook secret OR global secret OR legacy root-level secret)
- Retry policy: 3× on 5xx, 45s timeout — endpoint MUST dedupe on `message_handle`
- REST send: `https://api.sendblue.co/api/send-message`
- Auth: `SENDBLUE_API_KEY_ID` + `SENDBLUE_API_SECRET_KEY` (already saved to `apps/functions/.env`, gitignored)
- Pricing: $100/mo per dedicated line (1000 inbound contacts/day; outbound rate limit unspecified)

**Unknown / Adam-pending (CHANNEL-08 blocker):**
1. Apple ID ownership — Sendblue's name or operator's?
2. SLA on number re-provisioning if Apple flags a line
3. Outbound rate limit (only inbound 1000/day documented)
4. GDPR / data residency — do they log/store message content?
5. Exact HMAC header name (not in our research; needs first-task lookup in Sendblue dashboard / docs)

**Decision dependencies:**
- Tasks 1–10 (implementation) can proceed independently of contract questions 1–4
- Contract Q5 (HMAC header name) blocks Task 3 (HMAC verify) — must be resolved by Sendblue dashboard inspection in Task 1
- Contract Qs 1–4 block Adam's GO decision for cutover (CHANNEL-08) — implementation can land behind `PA_CHANNEL_LEGACY=1` while answers pend

## 4. Locked decisions

- **D-01:** Webhook handler lives in `apps/functions/src/sendblue/` as a new Express-style HTTPS function (`paSendblueWebhook`), exported from `apps/functions/src/index.ts`. Route is `/paSendblueWebhook`. *(rationale: matches existing `memoryAdmin` pattern at functions/src/index.ts:400)*
- **D-02:** Idempotency key format is `sendblue-${message_handle}` (no fallback to rowId — Sendblue handles are stable + Sendblue-side retry uses same handle)
- **D-03:** Allowlist port is to a new shared utility `apps/functions/src/sendblue/allowlist.ts` (NOT shared package — keep blast radius small for v1.1; promote to package post-beta if WhatsApp adapter lands). Port `useDmAllowlist`, `getPeerAllowlist`, `isSamePeer`, `normalizePeer` from `apps/macos-imessage-worker/src/config.ts` 1:1.
- **D-04:** Allowlist input is `from_number` (E.164 already-normalized by Sendblue). No Apple-ID handle parsing needed.
- **D-05:** Outbox processor is a new CF triggered by `onDocumentCreated(pa_outbound)` in `apps/functions/src/sendblue/outbox.ts`. The macOS worker's `startOutboundListener` (in `apps/macos-imessage-worker/src/outbox.ts`) is the reference behavior to port — including transcript-append rules, allowlist gate, and status-state machine (pending → sending → sent | failed).
- **D-06:** Phase 15 chunker is **disabled by env flip** in cutover (set `PA_TYPING_INDICATOR=0` for Sendblue path). Code removal is deferred to milestone v1.2 with the macOS worker deletion. *(rationale: kill switch is safer than mid-milestone code removal)*
- **D-07:** Secrets migrate from `apps/functions/.env` plaintext to **Firebase Secret Manager** via `firebase functions:secrets:set SENDBLUE_API_KEY_ID` and `SENDBLUE_API_SECRET_KEY` BEFORE first prod CF deploy. Local dev keeps `.env` (gitignored).
- **D-08:** Parallel-run flag: `PA_CHANNEL_LEGACY=1` keeps macOS worker active during cutover. Cutover order:
  1. Deploy CF + secrets, dual-run with macOS worker
  2. Adam-only smoke (his number)
  3. Flip Sendblue line live, set `PA_CHANNEL_LEGACY=0`, stop macOS worker
  4. Keep macOS worker code in repo for one milestone, then delete in v1.2
- **D-09:** No backward-compat for in-flight `imessage-in-${rowId}` events at cutover — operator stops macOS worker, drains pending `pa_outbound` (which still uses old keys) via macOS worker, *then* flips `PA_CHANNEL_LEGACY=0`. New events use new keys. Drain window: Adam runs macOS worker until `pa_outbound where status=pending` is empty. *(rationale: queue is short, Adam-only beta, clean cutover beats translation layer)*
- **D-10:** Smoke test for CHANNEL-09 uses Sendblue Free Sandbox (10 verified contacts, shared number). Production launch flips to paid line after Adam GO.
- **D-11:** Rollback plan: `PA_CHANNEL_LEGACY=1` re-enabled + macOS worker restarted = Sendblue ignored, old path active. CF remains deployed (idle without webhook traffic).

## 5. Deferred / out of scope (this phase)

- WhatsApp adapter (P1 / `CHANNEL-WHATSAPP`)
- GCP Secret Manager migration for non-Sendblue secrets (`SECRETS-MIGRATE` separately)
- Apple Business Chat path
- Read-receipts / reactions handling (Sendblue doesn't fire webhooks for these)
- Multi-line support / line-routing logic (single line for closed beta)
- macOS worker code DELETION (deferred to v1.2 — this phase keeps it behind `PA_CHANNEL_LEGACY=1`)

## 6. Goal-backward — observable truths

For "Sendblue migration shipped" to be TRUE:

1. Inbound iMessage to Sendblue line creates `pa_inbound_events` keyed by `sendblue-${message_handle}` within 5s of receipt
2. Webhook with bad HMAC returns 401 and creates NO inbound event
3. Webhook from non-allowlisted `from_number` returns 200 OK silently AND creates a `pa_audit_events` deny record AND creates NO inbound event
4. Orchestrator turn completes → `pa_outbound` row enqueued → CF outbox processor POSTs to Sendblue REST → message delivered to user's iMessage within 30s p95 (CHANNEL-09)
5. Sendblue retries (3× on 5xx) on the same `message_handle` produce exactly one `pa_inbound_events` row (idempotency holds)
6. `PA_CHANNEL_LEGACY=1` ⇒ macOS worker still works end-to-end (parallel-run safety)
7. Phase 15 chunker is dormant under Sendblue path (`PA_TYPING_INDICATOR=0` honored); typing indicator instead fires via Sendblue REST API
8. `firebase functions:secrets:get SENDBLUE_API_KEY_ID` returns the configured value (Secret Manager wired before deploy)
9. CHANNEL-08 contract questions documented as ANSWERED in a follow-up `21-CONTRACT-NOTES.md` (Adam owner) before public launch — implementation is unblocked but business GO requires this

## 7. Relevant prior art

- `apps/macos-imessage-worker/src/index.ts` lines 135–423 — `handleDirectMessage` flow is the reference for orchestrator-touch contract (idempotency check → broker create → orchestrator → outbox)
- `apps/macos-imessage-worker/src/index.ts` lines 143–153 — allowlist gate to port (now keyed by `from_number`)
- `apps/macos-imessage-worker/src/outbox.ts` lines 99–259 — outbox processor (claim → allowlist → send → status update); `startOutboundListener` is the listener to replace
- `apps/macos-imessage-worker/src/config.ts` — `normalizePeer`, `getPeerAllowlist`, `isSamePeer`, `useDmAllowlist` to port to CF utility
- `apps/functions/src/index.ts:400` — `memoryAdmin` (existing `onRequest` HTTPS pattern in this CF entry)
- `apps/functions/src/index.ts:322` — `onPaInbound` (existing `onDocumentCreated` pattern for outbox processor shape)
- `packages/pa-broker/src/inbound.ts:27` — `createInboundEvent` is idempotent by `idempotencyKey` — direct reuse with new key shape
- `packages/core-types/src/collections.ts:13,15` — `pa_outbound`, `pa_inbound_events` collection names

## 8. Risks

- **R-01:** HMAC header name unknown until Sendblue dashboard inspected — Task 1 must resolve, Task 3 blocked otherwise.
- **R-02:** Outbound rate limit unspecified — risk of throttling on bursty proactive nudges (Phase 22). Mitigation: log every Sendblue 4xx/5xx with `retry-after`; surface rate-limit-trips to `pa_audit_events`.
- **R-03:** `message_handle` collision across resends — Sendblue documents stable handle for retries, but cross-conversation collision risk is unverified. Mitigation: use `sendblue-${message_handle}` namespaced (collision survives idempotent create — no overwrite, see broker test at `inbound.test.ts:158`).
- **R-04:** Apple flags Sendblue's line — Sendblue SLA on re-provisioning unknown. Mitigation: keep macOS worker code in repo for one milestone (D-08); rollback via `PA_CHANNEL_LEGACY=1`.
- **R-05:** CF cold-start adds latency to webhook → orchestrator path. Mitigation: target <30s p95 (CHANNEL-09 explicit budget); set CF `minInstances: 1` if needed.
- **R-06:** Drain window at cutover (D-09) requires Adam to verify `pa_outbound where status=pending` is empty before flipping flag. Document in runbook.

## 9. Open questions (non-blocking, Adam-pending)

- **Q-01:** Sendblue webhook URL allowlisting — does Sendblue support source-IP allowlist for webhook origins? If not, HMAC is sole auth boundary.
- **Q-02:** Should we mirror `outbound` Sendblue webhook events into `pa_audit_events` for delivery-confirm telemetry? Adam: defer to post-beta.
- **Q-03:** Group-chat support (`group_id` in payload) — closed beta is 1:1 only; reject non-empty `group_id` in webhook? Locked YES until Adam decides otherwise.
