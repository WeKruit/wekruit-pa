# Phase 17 — Pre-Launch Hardening (CONTEXT)

**Status**: planning
**Owner**: Adam (decisions) + P9 squads (execution)
**Trigger**: P10 strategic scan (2026-04-27) flagged "No-Go for public launch"
**Goal**: close P0 blockers between current alpha state and launchable closed-beta (≤20 users) → launchable public.

---

## P0 Blockers (must close to launch)

### B1 — iMessage channel risk (CEO-blocked)
- **Root cause**: single Apple ID + single Mac auto-replying to all users violates iCloud AUP §VI.B (commercial bulk messaging). At >50 users Apple silently blocks the ID.
- **Status**: Awaiting CEO decision among three options:
  1. Multi-Apple-ID rotation (gray, cheap, still ToS-violating per ID)
  2. **sendblue.co / loopmessage.com hosted bridge** (recommended, ~$99/mo, production-grade)
  3. Apple Business Chat (fully compliant, multi-week gate-keeping, requires DUNS)
- **Closed-beta carve-out**: ≤20 hand-picked users on single-Apple-ID is acceptable. Public launch is gated on B1.

### B2 — Single-host worker (availability)
- **Root cause**: macOS worker runs on Adam's laptop. Adam offline = product offline.
- **Closed-beta**: defer (acceptable for 20 hand-picked users). Tag in P9-Infra backlog.
- **Public launch**: must move to always-on Mac mini + healthcheck + Firestore liveness lease.

### B3 — Companion voice ("太人机")
- **Root cause**: PA reads as a tool, not a companion. 4-layer diagnosis:
  - L1 model (gpt-5.4-nano is functionally toned by RLHF)
  - L2 persona card is a *user-attribute table*, not PA's *self backstory*
  - L3 eval rubric has no warmth / in-character / over-eager-acknowledge / emoji-appropriateness dimensions
  - L4 no character bible exists
- **Adam's explicit constraint (2026-04-27)**: do NOT escalate to Sonnet. Solve at prompt + persona + eval layers, staying on nano.
- **Pre-req for execution**: Character Bible v1 (one-page; PA's name/backstory/3 verbal tics/reactions). Until this exists, P9-Voice spawning is wasted cycles.

### B4 — Secrets handling (downgraded from P10's P0)
- **Verified**: `.env` never committed to git (`.gitignore` correctly excludes; `git log -S 'BEGIN PRIVATE KEY'` empty).
- **Residual risk**: plaintext on Adam's laptop disk. P1, not P0. Migrate to GCP Secret Manager before public launch.

---

## P0 Companion features for closed-beta

### F1 — Proactive check-in (revived from skipped Phase 12)
- Trigger-based, not cron-based. User opts in via dashboard "Companion Triggers" page.
- Trigger types:
  - Time anchor ("interview Mon, remind me Sunday to prep")
  - Silence anchor ("if you don't hear from me 3 days, ping me")
  - Application follow-up ("3 days since I applied to X — nudge me")
- Plumbing: `pa_scheduled_jobs` (already in `core-types/collections.ts:43`) + Cloud Scheduler sweep + orchestrator → outbox.
- **Combined with dashboard** per Adam's direction: dashboard owns the trigger config UI.

---

## Sendblue channel migration (B1+B2 unifying solution)

**Decision pending**: deep research (2026-04-27, triple-verified) confirms Sendblue is pure transport, not an agent platform. Their "AI Agent" tier is a $100/mo plan NAME, not a hosted runtime.

Verification evidence (three independent sources):

1. **Sendblue API page** (https://www.sendblue.com/api) — describes self as "The API and infrastructure that powers AI-driven messaging at scale" — i.e., infra FOR agents, not an agent. No memory/personalization/persona features mentioned.

2. **Sendblue Quickstart** (https://docs.sendblue.com/getting-started/quickstart/) — provides phone number + API credentials + verification + routing only. Mentions third-party frameworks "OpenClaw" and "TextMe" as integration options — these are NOT Sendblue services.

3. **Sendblue's OWN blog "How to Build an iMessage AI Agent with Claude"** (https://www.sendblue.com/blog/build-imessage-ai-agent-claude-sendblue) — puts the Claude inference call in the DEVELOPER's Express server, verbatim:
   ```js
   app.post('/webhook/receive', async (req, res) => {
     ...
     const response = await anthropic.messages.create({
       model: 'claude-sonnet-4-20250514'
     })
   })
   ```
   Quote: *"Your server sends it to Claude (Anthropic API)"* — inference runs on Anthropic infra. *"Node.js 18+"* + *"Railway, Render, AWS, or any Node.js host"* — developer hosts the orchestration loop. There is no "Sendblue-only" option that avoids running your own backend.

**Conclusion**: Sendblue handles the iMessage transport layer (Apple ID risk, number provisioning, webhook push, REST send, native typing indicator). The agent runtime, memory, persona, and orchestration stay 100% with us. Architecture stays:

```
iMessage → Sendblue webhook push → CF webhook handler (verify HMAC)
       → existing pa_inbound_events broker → existing orchestrator
       → existing outbox → CF posts to Sendblue REST send → iMessage
```

**What's deleted**: `apps/macos-imessage-worker/` entirely (~1000 LOC). Cursor module + catchup logic + chunked typing simulation all become unnecessary (webhook push + native Sendblue typing_indicator API).

**What's kept**: orchestrator, Agents SDK runtime, mem0/qdrant memory, persona system, allowlist (now enforced in CF webhook handler against `from_number`), broker idempotency (key changes from `imessage-in-${rowId}` to Sendblue `message_handle`).

**What's added**: ~150 LOC CF webhook handler. Outbox listener replaced by REST POST in CF.

**Estimated work**: 5-7 dev-days.

**Risks / contract questions** (resolved 2026-04-27):
1. ✅ Apple ID ownership: **Sendblue-owned**, customer not contractually responsible for ToS
2. ✅ SLA on number re-provisioning: **hours**, weekend slower; specific hours number TBD
3. ✅ Outbound rate limits: **new contact 50/day per line, existing user 150/day, typing indicator 15s**. Negotiation room at scale.
4. ✅ GDPR posture: **SOC2 attestation** (audited data handling controls)

For 20-user closed-beta on one $100/mo line: ~3000 outbound/day budget; well within reach.

**Recommendation**: closed-beta path go Sendblue. $100/mo replaces 3+ weeks of single-host worker hardening + Apple-ID risk drama, freeing Adam to focus on brain (voice + product).

---

## Output Normalization (companion-voice supporting layer)

Discovered 2026-04-27: PA outputs include markdown (`**bold**`, `[text](url)`, bullet lists, UTM-tracked URLs) which iMessage renders as literal characters — adds to "robotic" feel.

**Top-down design**: post-LLM normalization at orchestrator exit, BEFORE outbox enqueue. Channel-agnostic (Sendblue, dashboard playground, future web fallback all share).

New module: `packages/pa-orchestrator/src/output-normalizer.ts`.

**Normalization rules**:

```
[1] Strip markdown emphasis: **X** → X, *X* → X, __X__ → X, _X_ → X, `X` → X, ```X``` → X
[2] Strip markdown links: [text](url) → "text url" (or just url if short); strip ?utm_* params
[3] List markers: "- X" → "· X"; "* X" → "· X"; numbered preserved
[4] Whitespace: ≥3 blank lines → 2 blank lines; trim trailing
[5] Length cap: > 600 chars → chunk split (reuse Phase 15 chunker) or truncate
[6] zh-en spacing (optional): "。" before ASCII → "。 "; "..." → "…"
```

**Companion to system prompt**: positive instruction `"You write plain text — like texting a friend. No bold, no bullets, no markdown."` + ALL `mes_example` demos in plain text + post-normalizer as bottom-line guard.

**Eval rubric** gains a 5th axis: `iMessage_render_safe` — auto-fail on regex match `\*\*.+?\*\*` or `\[.+?\]\(.+?\)`.

**Estimated work**: 1 dev-day (normalizer + unit tests). Goes in P9-Voice squad scope.

---

## P1 (post-beta, < 30 days)
- Resume review + application tracking (real WeKruit matching backend)
- Web fallback chat (Firebase Auth + dashboard)
- abuse events producer (rate-limit / injection / allowlist-deny)
- GDPR/CCPA export + delete API (Firestore + mem0 + qdrant cascade)
- Embedding fallback (SiliconFlow → OpenAI text-embed-3 backup)

## P2 (quarter-out)
- WhatsApp / RCS channel
- Voice input (Whisper)
- Resume image OCR
- Mock interview agent

---

## Proactive Check-in (Phase 17 sub-feature, F1)

Trigger-based, not cron. User opts in via dashboard "Companion Triggers" UI. Three trigger types:
- **Time anchor**: "interview Mon, remind me Sunday" → fire at T-24h
- **Silence anchor**: "if I'm quiet 3 days, ping me" → fire when (now - lastUserMsg) > 72h
- **Application follow-up**: "3 days post-apply X, nudge me" → fire at T+72h

Plumbing (much already exists):
- `pa_scheduled_jobs` Firestore collection (already in `core-types/collections.ts:43`)
- New CF `paProactiveSweep` (Cloud Scheduler 1min cron)
- Orchestrator: synthetic "proactive turn" path injecting trigger context into system input
- Outbox + worker outbound listener (existing)
- Idempotency: same trigger × fireWindow doesn't double-send
- "Cancel proactive" via iMessage NLU ("停止提醒" → reverse-update trigger)

**Hard dependency**: P9-Channel cannot spawn before P9-Voice v1 ships. Proactive turn voice has to use the new in-character pattern, not the current robotic one — first ping otherwise feels like a marketing SMS.

Estimated work: 16 dev-days = 2-3 weeks for a P9-Channel squad.

---

## Closed-beta launch criteria (Go gate)

| # | Criterion | Status |
|---|---|---|
| 1 | Allowlist fail-closed (inbound + outbound) | ✅ landed 2026-04-27 |
| 2 | Cursor durable + offline-recovery | ✅ landed 2026-04-27 |
| 3 | Companion voice v1 (4-layer fix, nano-only) | ⏳ blocked on Character Bible |
| 4 | Character Bible v1 | ⏳ Adam owner |
| 5 | Proactive check-in MVP | ⏳ planning |
| 6 | Onboarding flow for 20 users | not started |

## Public launch criteria (Go gate)
1–6 above PLUS B1 (channel decision) + B2 (always-on worker) + B4 (secret manager) + P1 list.
