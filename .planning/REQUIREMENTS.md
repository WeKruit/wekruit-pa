# Requirements

This file is append-only across milestones. Active milestone requirements at top; prior milestone requirements archived in `.planning/milestones/v{X}-REQUIREMENTS.md`.

**Last updated:** 2026-05-12 (v1.9 spawned post-v1.8 ship)

---

## v1.9 Active Requirements — End-to-End Candidate Journey Closure

**Milestone goal:** Close candidate-side loop from User Flow diagram. PASS/FAIL terminal → next-action automation. Generic ATS inbound adapter (Handshake first). Public candidate-facing job page + CV upload. Sendblue multi-number pool. Reuse all v1.6/v1.7/v1.8 infra — zero rebuild.

**Spawned:** 2026-05-12 by Adam post-v1.8 ship.

### Terminal → Next Action Automation (TERMINAL)

- [ ] **TERMINAL-01**: PASS terminal triggers `generateJobRecs(userId)` automatically inside `PreScreenPipeline.runTurn` terminal handler. Reuse existing CF callable; do not duplicate match cascade.
- [ ] **TERMINAL-02**: FAIL terminal triggers `generateJobRecs(userId)` with "match other jobs?" copy preamble. Reuse same CF.
- [ ] **TERMINAL-03**: HARD_STOP terminal does NOT auto-fire job recs (policy violation / abuse signal — preserve terminal). Override via admin only.
- [ ] **TERMINAL-04**: PAUSE terminal sends "Claire 暂时不确定, 我们晚点继续" + writes `pa-prescreen-sessions.{id}.pausedAt`; no auto-action.
- [ ] **TERMINAL-05**: Terminal-triggered job rec dispatch is async + fail-open — generateJobRecs error does NOT roll back terminal. Audit event `pa-audit-events` for each fire (success or fail).
- [ ] **TERMINAL-06**: Idempotency — same (sessionId, terminal) only fires generateJobRecs once. Stored in `pa-prescreen-sessions.{id}.terminalActionFiredAt`.

### Level 1 Info Reveal (LEVEL1)

- [ ] **LEVEL1-01**: PASS terminal SMS template reveals: company name, full JD URL (`pa-jobs.{jobId}.atsApplyUrl` or hosted job page URL), salary range, next-step CTA ("准备面试 — 我们会让 employer 联系你"). Stored in `packages/pa-orchestrator/src/prescreen/level1-template.ts`.
- [ ] **LEVEL1-02**: Pre-PASS, JD-company-salary fields are NOT revealed in any prescreen message (verified by snapshot test).
- [ ] **LEVEL1-03**: Level 1 reveal SMS sent via `sendImessage` after `generateJobRecs` resolves (sequenced, not parallel — avoid SMS interleave).

### PII Confirm Flow (PIICONFIRM)

- [ ] **PIICONFIRM-01**: New `PiiConfirmPipeline` (separate from `PreScreenPipeline`, same `OnboardingPipeline` base class). Asks 3 Questions: legal name, email, phone. All MUST_HAVE type (weight=1.0).
- [ ] **PIICONFIRM-02**: Reuses `Question<TAnswer>` infrastructure (iter34 P1); zero new state-machine code.
- [ ] **PIICONFIRM-03**: Email validated via existing email regex util; phone validated via libphonenumber-js (already in monorepo).
- [ ] **PIICONFIRM-04**: Answers written to `pa-users.{uid}.contactPII = {legalName, email, phone, consentedAt, source: 'prescreen_pass'}` + audit event.
- [ ] **PIICONFIRM-05**: Triggered AFTER `LEVEL1-03` SMS — sequence: PASS terminal → Level 1 reveal → PII collect (3 Qs) → "已收到, employer 会联系" closing message.
- [ ] **PIICONFIRM-06**: Skip-if-present — if `pa-users.{uid}.contactPII.consentedAt` exists, skip PII collect and go straight to closing message.

### Generic ATS Inbound Adapter (ATSADAPTER)

- [ ] **ATSADAPTER-01**: New CF HTTP endpoint `paAtsInboundWebhook` accepting POST with header `X-Wekruit-Ats-Source: handshake|greenhouse|lever|linkedin`. HMAC-signed per source (secret in Firebase Secrets: `ATS_HANDSHAKE_HMAC_SECRET` etc).
- [ ] **ATSADAPTER-02**: Schema-agnostic core — defines `CanonicalApplicant {applicantId, jobIdExternal, jobIdInternal?, name, email, phone?, resumeUrl?, resumeBase64?, source}`. Per-source adapter in `apps/functions/src/ats-adapters/{handshake,greenhouse,lever,linkedin}.ts` maps raw payload → CanonicalApplicant.
- [ ] **ATSADAPTER-03**: Handshake adapter implemented first. Greenhouse/Lever/LinkedIn adapter stubs return `not_implemented` 501 until later milestones.
- [ ] **ATSADAPTER-04**: `jobIdExternal` → `jobIdInternal` resolved via `pa-jobs-external-mapping/{source}/{externalId}` Firestore doc. Admin-curated.
- [ ] **ATSADAPTER-05**: Find-or-create `pa-users` by email (case-insensitive). New user gets `signupSource: 'ats:handshake'` + `phone` placeholder (filled in PII confirm flow).
- [ ] **ATSADAPTER-06**: Resume binding — if `resumeUrl` present, fetch + invoke `cv-ingest` HTTP endpoint with `{userId, source: 'ats_inbound', resumeBase64}`. Reuse pa-resume-parser v2 chain. Fail-graceful.
- [ ] **ATSADAPTER-07**: Outbound invite SMS via `sendImessage`: "Hi <name>, WeKruit here on behalf of <company> for <jobTitle>. Reply START to begin your 5-min screen." Body composed from `pa-jobs.{jobId}` config.
- [ ] **ATSADAPTER-08**: 7-day idempotency keyed `pa-ats-invite-idempotency/{source}_{externalJobId}_{applicantId}`. Re-firing within 7d → 200 no-op + audit event.
- [ ] **ATSADAPTER-09**: Reply "START" (or any non-trigger message within 24h of invite) seeds the `WeKruit_<jobId>_<userId>_Job` trigger virtually — TriggerRouter handles. If user replies after 24h, prompt re-invite.
- [ ] **ATSADAPTER-10**: Admin dashboard page `/admin/ats-inbound` — list of inbound applicants per source, status (invited / responded / passed / failed), retry button, idempotency override.

### Apply Trigger (APPLY)

- [ ] **APPLY-01**: New trigger pattern `WeKruit_<jobId>_<userId>_Apply` registered in `TriggerRouter`. Regex: `^WeKruit_([A-Za-z0-9_-]+)_([A-Za-z0-9_-]+)_Apply$`.
- [ ] **APPLY-02**: Apply trigger skips prescreen + goes directly to `PiiConfirmPipeline` (for candidates with prior PASS or externally-verified). Verified-PASS check: `pa-prescreen-sessions` exists with `terminal='PASS'` for (jobId, userId) within 30d.
- [ ] **APPLY-03**: If no prior PASS found, Apply trigger fail-safe falls back to standard prescreen `_Job` flow (don't expose Level 1 info to unverified candidate).

### Public Candidate-Facing Job Page (JOBPAGE)

- [ ] **JOBPAGE-01**: Public unauthenticated route `/j/:jobId` on `wekruit-pa.web.app` (existing Vite SPA). Reads `pa-jobs.{jobId}` config; SSR-friendly meta tags for sharing.
- [ ] **JOBPAGE-02**: Firestore rule update — `pa-jobs/{jobId}` allow read if-public-flag (`pa-jobs.{jobId}.publicVisible === true`); write still operator-only. Default `publicVisible: false`.
- [ ] **JOBPAGE-03**: Renders: jobTitle, company, location, salary, JD (markdown from `pa-jobs.{jobId}.descriptionMd`), "Start pre-screen" CTA opening `sms:<sendblueNumber>?body=WeKruit_<jobId>_<requestedUserId>_Job`.
- [ ] **JOBPAGE-04**: "Start pre-screen" CTA generates a temporary `requestedUserId` (UUID v4) when candidate has no prior session. Stored in cookie + `pa-prescreen-pending-invites/{requestedUserId}` Firestore doc with `{jobId, createdAt}`. On first inbound SMS match, `paSendblueWebhook` resolves pending invite + binds `requestedUserId` to actual `pa-users/{uid}`.
- [ ] **JOBPAGE-05**: CV upload flow on job page — `<input type="file">` accepts PDF/DOCX, POSTs to `cv-ingest` HTTP endpoint with `{tempUserId, source: 'public_job_page', jobIdContext}`. Returns parsed preview; candidate confirms → triggers prescreen start.
- [ ] **JOBPAGE-06**: QR code rendered server-side on job page (small SVG, encodes `sms:` URL) for desktop visitors.
- [ ] **JOBPAGE-07**: Dashboard `/admin/job-prescreen` editor adds `Make public` toggle that flips `publicVisible` + shows `/j/<jobId>` preview link.

### Sendblue Multi-Number Pool (SBPOOL)

- [ ] **SBPOOL-01**: Config doc `pa-config/sendblue-pool` with array `numbers: [{number: string, status: 'active'|'paused', capacity: number}]`. Default seeded with current single number.
- [ ] **SBPOOL-02**: `sendImessage` adapter picks number via `hashByUserId(userId) mod activeNumbers.length` — same user always routed to same number for thread continuity.
- [ ] **SBPOOL-03**: Inbound webhook routing — `paSendblueWebhook` accepts inbound from any pool number; user-resolution by phone number unchanged (uses `from` field not destination).
- [ ] **SBPOOL-04**: Per-number daily cost ledger entry in `pa-cost-ledger` (rolled up from individual sends).
- [ ] **SBPOOL-05**: Admin page `/admin/sendblue-pool` — add/remove/pause numbers + show per-number daily volume.
- [ ] **SBPOOL-06**: Single-number backwards-compat: if pool has exactly 1 number, behavior identical to pre-v1.9.

### Feedback Survey (FEEDBACK)

- [ ] **FEEDBACK-01**: Post-`PiiConfirmPipeline` closure, send 1-2 Question feedback survey: "On a scale 1-5, how was Claire's pre-screen?" + optional "What could be better?".
- [ ] **FEEDBACK-02**: Reuses `OnboardingPipeline` base + `Question` class. Default opt-in; reply "skip" exits survey.
- [ ] **FEEDBACK-03**: Answers written to `pa-prescreen-sessions.{sessionId}.feedback = {rating, freeform, completedAt}`.
- [ ] **FEEDBACK-04**: Dashboard `/admin/prescreen-sessions/:sessionId` shows feedback rating + freeform text in new section.
- [ ] **FEEDBACK-05**: Weekly aggregate in `/admin/prescreen-feedback` — average rating, top 10 freeform comments by recency.

### E2E Scenarios + Documentation (E2E + DOC)

- [ ] **E2E-01**: New scenario YAMLs in `tests/scenarios/candidate-journey/`: `pass-to-level1.yaml`, `fail-to-other-jobs.yaml`, `apply-direct.yaml`, `ats-inbound-handshake.yaml`, `pii-skip-when-present.yaml`.
- [ ] **E2E-02**: Existing `tests/scenarios/runner-prescreen.mjs` extended to run new scenarios; exit 0 required.
- [ ] **E2E-03**: Real-LLM smoke test variant `scripts/smoke-candidate-journey-llm.mjs` — runs PASS → Level 1 → PII flow against gpt-5.4-nano live, verifies SMS sequencing.
- [ ] **DOC-V19-01**: `CLAUDE.md` v1.9 design lock subsection.
- [ ] **DOC-V19-02**: `.planning/MILESTONE-v1.9-candidate-journey.md` with architecture diagram (User Flow diagram annotated with phase numbers), per-trigger flow, ATS adapter contract.

---

## v1.9 Out of Scope (explicit exclusions)

- Employer dashboard / passed-candidate inbox (defer v2.0)
- Employer notification webhooks (defer v2.0)
- Interview scheduling (defer v2.0)
- Multi-stage Level 2/3 info reveal (defer v2.0)
- PII vault encryption beyond Firestore at-rest (defer v2.0)
- LinkedIn Recruiter API direct integration (adapter slot stub only)
- Greenhouse/Lever production adapters (stubs only, full impl v2.0)
- Multi-language prescreen (English/Chinese already supported via voice-mode)
- Real-time match notifications (still async daily via generateJobRecs)
- Public job page SEO / SSR optimization (basic meta tags only)

## v1.9 Traceability

| REQ-ID | Phase | Status |
|---|---|---|
| TERMINAL-01..06 (6) | Phase 84 | pending |
| LEVEL1-01..03 (3) | Phase 84 | pending |
| PIICONFIRM-01..06 (6) | Phase 85 | pending |
| APPLY-01..03 (3) | Phase 85 | pending |
| ATSADAPTER-01..10 (10) | Phase 86 | pending |
| JOBPAGE-01..07 (7) | Phase 87 | pending |
| SBPOOL-01..06 (6) | Phase 88 | pending |
| FEEDBACK-01..05 (5) | Phase 89 | pending |
| E2E-01..03 + DOC-V19-01..02 (5) | Phase 90 | pending |

**Total: 51 REQ-IDs across 9 categories. 100% mapped to phases 84-90.**

---

## v1.7 Active Requirements — Match Quality Depth + Pipeline Reliability Hardening

(archived in `.planning/milestones/v1.7-REQUIREMENTS.md` after v1.7 ship — see file for full list)

## v1.8 Active Requirements — Conversational Pre-Screening Platform + Memory Governance

(archived in `.planning/milestones/v1.8-REQUIREMENTS.md` after v1.8 ship — see file for full list)
