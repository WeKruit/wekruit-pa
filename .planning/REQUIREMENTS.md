# Milestone v1.1 Requirements — Pre-Launch Hardening + Companion Brain

**Goal:** Closed-beta launchable (≤20 hand-picked users) within 3 weeks. Fix companion voice on gpt-5.4-nano (no Sonnet escalation), migrate iMessage channel to Sendblue, close output normalization + safety gaps, revive proactive check-in.

**Last updated:** 2026-04-27

---

## v1.1 Active Requirements

### VOICE — Companion Voice v1 (static base)

- [ ] **VOICE-01**: System prompt rewritten using Snapchat MyAI skeleton (concise, friend register, no monologue, sparse emoji, never self-identifies as AI).
- [ ] **VOICE-02**: PA persona is encoded as PA self-backstory (not a user-attribute table) per Tendera "facts as voice" pattern; per-user facts stay in mem0 layer, never injected as bullet specs.
- [ ] **VOICE-03**: System prompt ships with 3 in-character `mes_example` few-shot dialogue turns demonstrating implicit ack ("柠檬茶女孩 🍋" pattern) instead of explicit catalog ("好的，我记住了").
- [ ] **VOICE-04**: System prompt includes `first_mes` voice anchor (research-validated highest-ROI lever for small-model voice).
- [ ] **VOICE-05**: Post-history voice reminder (50-100 tokens) injected before user's latest turn so voice constraints survive long context.
- [ ] **VOICE-06**: Character Bible v1 written (Adam owner) — PA name, backstory, 3 verbal tics, reaction templates, signature emoji, code-switch policy, length cap.
- [ ] **VOICE-07**: zh + en slang lexicon curated (≤10 zh + ≤7 en signature terms with usage notes); used at most 1-2 per turn, not stacked.
- [ ] **VOICE-08**: Eval rubric extended with 4 voice axes — `warmth_no_sycophancy`, `in_character_voice`, `no_robot_filler`, `length_appropriateness` — pairwise judge against current-prompt baseline.
- [ ] **VOICE-09**: Eval LLM-judge auto-fail patterns include zh + en filler blacklist (`好的，我记住了 / 收到 / 没问题，我会记得 / "It's important to" / "Remember,"`); blacklist is NOT in system prompt (token activation risk).
- [ ] **VOICE-10**: 5+ companion-voice golden scenarios added to harness as anchor benchmark.

### ADAPT — Adaptive Mirror Layer

- [ ] **ADAPT-01**: Per-turn user-style analyzer extracts register / language ratio / emoji frequency / length from user's last 3-5 turns.
- [ ] **ADAPT-02**: Dynamic mirror snippet (Meta AI WhatsApp pattern: *"match user style; if formal, formal; if slangy, slangy"*) injected post-history per turn.
- [ ] **ADAPT-03**: Long-term style preferences (e.g. "user uses zh-en code-switch", "user emo-coded vocab") accumulated in mem0 and re-injected via persona card extension.
- [ ] **ADAPT-04**: Mirror layer kill switch (`PA_VOICE_MIRROR_DISABLED=true`) for rollback.
- [ ] **ADAPT-05**: Eval scenario for mirror — turn 1 user formal → PA formal; turn 2 user slangy → PA slangy.

### NORM — Output Normalization

- [ ] **NORM-01**: New module `packages/pa-orchestrator/src/output-normalizer.ts` runs at orchestrator exit (channel-agnostic).
- [ ] **NORM-02**: Strips markdown emphasis: `**X** / *X* / __X__ / _X_ / `X` / ```X``` → `X`.
- [ ] **NORM-03**: Converts markdown links `[text](url)` → `text url` (or just `url` if short); strips `?utm_*=...&...` tracking params.
- [ ] **NORM-04**: List markers `- ` and `* ` → `· ` (CJK-friendly bullet); numbered lists preserved.
- [ ] **NORM-05**: Whitespace collapse: ≥3 blank lines → 2; trailing whitespace trimmed.
- [ ] **NORM-06**: Length cap (>600 chars) triggers chunk-split (reuse Phase 15 chunker) or graceful truncate.
- [ ] **NORM-07**: Eval rubric gains 5th axis `iMessage_render_safe` — auto-fail on regex match `\*\*.+?\*\*` or `\[.+?\]\(.+?\)`.
- [ ] **NORM-08**: Unit tests cover 8+ edge cases (mixed markdown, UTM params, empty input, very long input, code blocks, links).

### CHANNEL — Sendblue Channel Migration

- [ ] **CHANNEL-01**: New CF endpoint `paSendblueWebhook` receives Sendblue webhook events (`receive`, `outbound`, `typing_indicator`, `line_blocked`).
- [ ] **CHANNEL-02**: HMAC signature verification on every webhook; rejects on mismatch.
- [ ] **CHANNEL-03**: Webhook handler creates `pa_inbound_events` keyed by Sendblue `message_handle` (replaces `imessage-in-${rowId}`).
- [ ] **CHANNEL-04**: Allowlist gate moves from worker to webhook handler; non-allowlisted `from_number` returns 200 OK silently (no PA reply, audit logged).
- [ ] **CHANNEL-05**: Outbox listener replaced with CF that POSTs to Sendblue REST `api.sendblue.co/api/send-message` instead of Photon SDK.
- [ ] **CHANNEL-06**: `apps/macos-imessage-worker/` deprecated (kept in repo behind `PA_CHANNEL_LEGACY=1` flag for one milestone, then removed).
- [ ] **CHANNEL-07**: Chunked typing simulation (Phase 15) deprecated; use Sendblue native `typing_indicator` API.
- [ ] **CHANNEL-08**: Sendblue contract questions answered before signing (Apple ID ownership, SLA on number re-provisioning, outbound rate limit, GDPR/data residency).
- [ ] **CHANNEL-09**: Smoke test: real Sendblue sandbox → CF webhook → orchestrator → Sendblue REST send → real iMessage delivery; full round-trip <30s p95.

### PROACTIVE — Proactive Check-in (revived from skipped Phase 12)

- [ ] **PROACTIVE-01**: Dashboard `/triggers` page — CRUD for user's proactive triggers (time anchor, silence anchor, application follow-up).
- [ ] **PROACTIVE-02**: `pa_scheduled_jobs` schema fields: `userId`, `triggerType`, `nextFireAt`, `recurrence`, `context`, `status`.
- [ ] **PROACTIVE-03**: New CF `paProactiveSweep` (Cloud Scheduler 1-min cron) — query `status=pending && nextFireAt<=now`, dispatch.
- [ ] **PROACTIVE-04**: Orchestrator gains "proactive turn" path — synthetic system input ("trigger fired: <context>") routes through Voice v1 prompt, NOT a separate utility prompt.
- [ ] **PROACTIVE-05**: Idempotency — same trigger × fireWindow doesn't double-send.
- [ ] **PROACTIVE-06**: User can cancel triggers via iMessage NLU ("停止提醒" / "stop reminders") — orchestrator detects and updates trigger status.
- [ ] **PROACTIVE-07**: E2E scenario test for each trigger type.

### BETA — Closed Beta Onboarding + Safety

- [ ] **BETA-01**: Onboarding flow for first-contact user — PA introduces self in first_mes voice, asks 1-2 grounding questions, sets up mem0 partition.
- [ ] **BETA-02**: `pa_abuse_events` producer wired at 3 points: rate-limit-trip, prompt-injection-detect, allowlist-deny.
- [ ] **BETA-03**: Dashboard abuse panel surfaces last 50 abuse events with filter by type.
- [ ] **BETA-04**: Allowlist UI in dashboard — operator can add/remove beta participants without editing `.env`.
- [ ] **BETA-05**: Beta user runbook (one-page Notion / md doc) — onboarding script, escalation contact, kill switch instructions.

---

## P1 — Should have (post-beta, before public launch)

- VOICE-RFT: collect ≥10k human-validated in-character turns, evaluate fine-tuning ROI
- ADAPT-DRIFT: identity drift telemetry from `pa_audit_events` extended to track voice drift
- CHANNEL-WHATSAPP: WhatsApp Business adapter (Meta Cloud API) for non-iMessage users
- WEB-FALLBACK: Firebase Auth web chat for users without iMessage
- SECRETS-MIGRATE: move `.env` plaintext secrets to GCP Secret Manager
- GDPR-DELETE: user-level export + delete API (Firestore + mem0 + qdrant cascade)

## Out of scope (this milestone)

- Sonnet / Opus model escalation (Adam-locked: stay on nano)
- Fine-tuning / RFT / character LoRA (premature, no anchor data)
- Multi-tenant enterprise IAM
- HA fleet of Mac workers (Sendblue migration replaces single-host concern)
- Voice / image / multimodal input
- Resume audit + application tracking integration (P1, post-beta)
- Mock interview agent
- Apple Business Chat (multi-week gate-keeping; Sendblue covers closed-beta)
- Replacing Mem0/Qdrant
- Negative-instruction blacklists in system prompt (token activation risk on small models)

---

## Traceability

(Filled by roadmap — each REQ-ID maps to exactly one phase.)
