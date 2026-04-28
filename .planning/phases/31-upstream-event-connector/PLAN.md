# Phase 31 — PLAN (4-task spec)

**Status:** Plan-only. P9 not spawned. Total estimate ~3 dev-day across 1 P8.

T1→T2→T3 serial (each unlocks the next). T4 dashboard can fork parallel after T1.

---

## T1 — Inbound endpoint + HMAC + auth

**WHERE:**
- `apps/functions/src/inbound-events.ts` (new) — `paInboundEvent` HTTPS CF
- `apps/functions/src/sendblue/hmac.ts` — reuse existing helper (Adam has uncommitted edits — DO NOT touch logic, only import)
- `packages/pa-persistence/src/event-partners.ts` (new) — `getPartner(partnerId)`, `listPartners`
- `packages/pa-persistence/src/event-inbound.ts` (new) — `recordInbound(row)`, `countInbound(eventType, userId, sinceMs)`
- Tests for HMAC verify, timestamp window, partner lookup, rate-limit count

**HOW MUCH:** ~1 day.

**DONE:**
- POST + HMAC + 5-min timestamp window verified (replay rejected)
- 401 on bad sig; 403 on event type not in `allowedEventTypes`; 429 on rate-limit hard
- Audit row written on every inbound (success + every error category)
- Unit tests cover: valid signed request → 202; bad sig → 401; stale timestamp → 401; replay → 401; disallowed eventType → 403; unknown partner → 401
- `npm run test --workspace=@pa/functions` 全绿

**DON'T:**
- DON'T touch `sendblue/hmac.ts` logic — only import the existing verifier (Adam has uncommitted work there per `git status`)
- DON'T enqueue outbound yet (T3)
- DON'T render template yet (T2)

Commit msg: `feat(31/T1): paInboundEvent HMAC endpoint + partner auth + audit (P9-Connectors)`

---

## T2 — Template schema + Mustache-lite renderer

**WHERE:**
- `packages/pa-persistence/src/event-templates.ts` (new) — `getTemplate(eventType)`, `listTemplates`, `saveTemplate`
- `packages/pa-orchestrator/src/event-connectors/renderer.ts` (new) — `renderTemplate(tpl, vars): string`
- `packages/pa-orchestrator/src/event-connectors/renderer.test.ts` (new)

**HOW MUCH:** ~0.5 day.

Renderer scope:
- `{{var}}` flat substitution
- `{{nested.key}}` depth ≤2
- `{{#flag}}...{{/flag}}` truthy section
- Missing var → empty string + warn log
- Per-var length cap 256 chars (truncate + log)

**DONE:**
- Unit: 12+ test cases covering normal sub, nested, conditional, missing var, length cap, payload-with-special-chars (no escape needed; we don't render HTML)
- `npm run test --workspace=@pa/pa-orchestrator` 全绿
- Phase 20 normalizer integration test: rendered output → normalizer → expected Claire voice

**DON'T:**
- DON'T support `{{#each}}` loops or `{{>partial}}` partials
- DON'T add HTML escape (output is plaintext SMS/iMessage)
- DON'T allow function/expression evaluation in template

Commit msg: `feat(31/T2): event-templates + Mustache-lite renderer (P9-Connectors)`

---

## T3 — Outbound enqueue + rate-limit + Phase 20 normalize

**WHERE:**
- `apps/functions/src/inbound-events.ts` — extend with full pipeline: lookup partner → verify → rate-limit → lookup template → render → normalize → enqueue
- `packages/pa-orchestrator/src/event-connectors/pipeline.ts` (new) — orchestrates the above (testable)
- Wire to existing `pa-outbound` collection write (mirror shape used by `proactive-sweep.ts`)
- Integration tests

**HOW MUCH:** ~1 day.

**DONE:**
- Soft rate-limit (1/hr default per eventType×userId) returns 202 + `result: "rate_limited_soft"`, NO outbound enqueue
- Hard rate-limit (24/day) returns 429 + `result: "rate_limited_hard"`
- Successful path: writes 1 row to `pa-outbound` with `source: "inbound_event"` + `sourceEventType` + `sourcePartner`
- `paSendblueOutbox` (existing) picks up and sends — no changes needed there
- Integration test: full POST → enqueued row in `pa-outbound` matches expected text
- Phase 20 normalizer applied (verified by injection test: payload var containing "I am an AI" → normalized output strips it)

**DON'T:**
- DON'T modify `paSendblueOutbox` — it already handles outbound send
- DON'T bypass normalizer for any template (no opt-out)
- DON'T await Sendblue send result — fire-and-forget once enqueued

Commit msg: `feat(31/T3): inbound event pipeline + rate-limit + outbound enqueue (P9-Connectors)`

---

## T4 — Dashboard `/admin/events` (partner + template management)

**WHERE:**
- `apps/dashboard-web/src/pages/Events.tsx` (new)
- `apps/dashboard-web/src/lib/events-api.ts` (new — Firestore client wrapper)
- `apps/dashboard-web/src/components/events/PartnerEditor.tsx` (new)
- `apps/dashboard-web/src/components/events/TemplateEditor.tsx` (new)
- `apps/dashboard-web/src/components/events/InboundLogDrawer.tsx` (new)
- `apps/dashboard-web/src/App.tsx` (route + nav link)

**HOW MUCH:** ~0.5 day.

Two tabs:
1. **Partners**: list/create/edit partner — name, allowedEventTypes (chip input), enabled toggle, hmacSecretRef (display ref id only, secret stays in Secret Manager)
2. **Templates**: list/create/edit template — eventType, template (textarea with `{{var}}` highlighting), variableMap docs, rateLimit config, agentSlug, handbookSlug, enabled toggle. "Preview" button renders with sample payload.
3. Recent inbound drawer per template (last 50 from `pa-event-inbound`)

**DONE:**
- `npm run build --workspace=@pa/dashboard-web` 成功
- `npm run typecheck` clean
- Manual smoke (Adam): create partner, create template, push test event via `curl` with HMAC signed body, see audit row in drawer + outbound row
- One seed template `interview_scheduled` added via `apps/functions/scripts/seed-event-templates.ts`, disabled by default

**DON'T:**
- DON'T expose `hmacSecretRef` actual secret (just the ref name)
- DON'T enable seed template by default
- DON'T add HTML preview of template (plain text only — matches actual SMS output)

Commit msg: `feat(31/T4): /admin/events partner+template management + seed (P9-Connectors)`

---

## Sub-task summary

| ID | Title | Dep | Time |
|----|-------|-----|------|
| T1 | Inbound endpoint + HMAC + auth | none | 1d |
| T2 | Template schema + renderer | none | 0.5d |
| T3 | Pipeline + rate-limit + enqueue | T1, T2 | 1d |
| T4 | Dashboard + seed template | T1, T2 | 0.5d |

Total **~3 dev-day**.

## Adam decisions still owed

- [ ] Confirm soft rate-limit default (1/hr) reasonable
- [ ] Confirm hard rate-limit default (24/day) reasonable
- [ ] Confirm seed `interview_scheduled` template wording
- [ ] Confirm partner Secret Manager naming convention (`PA_PARTNER_HMAC_<PARTNERID>`)
- [ ] Confirm Phase 20 normalizer is mandatory on every event template (no opt-out) — yes per current spec
