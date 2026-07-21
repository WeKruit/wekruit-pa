# WeKruit AI Headhunter — Enterprise Onboarding: Feature & UX Plan

_Generated 2026-06-25 via 6-surface design workflow (onboarding wizard · agent-in-Slack · JD calibration · recruiter command center · HITL/trust · pilot dashboard). SOC2/legal excluded by directive — feature & UX only. Companion to HEADHUNTER-ENTERPRISE-ONBOARDING.md._

I'll synthesize the six designs into one cohesive plan.

# WeKruit AI Headhunter — Enterprise Onboarding: Feature & UX Plan

## 0. One-line thesis

WeKruit's enterprise onboarding is a **managed "easy-button"**: a brand-new TA/HR admin goes from first login to a launched pilot req whose **first qualified candidates land in their Slack channel** — without configuring anything. Every consequential decision stays human-in-the-loop, every match and screen-out is explainable, and the whole journey is measured against one number: **time-to-first-qualified-candidate (TTFQ)**.

---

## 1. UX North Star + Design Principles

**North star metric:** **Time-to-first-qualified-candidate (TTFQ)** — made tangible by ending onboarding on a launched pilot req whose first matched/rediscovered candidates appear, with why-matched explanations, in a connected Slack channel. Every surface is graded on whether it shortens TTFQ or proves the value that TTFQ represents.

**Design principles**

1. **Hire, don't configure (managed easy-button).** The honest enterprise steps (Slack, ATS via Kombo, pool import, calibration) exist, but each is presented with a smart default, a skip/do-later, an explicit connect-state, and an instant success state. The human does the *green* steps; WeKruit does the *blue* work (enrichment, matching, calibration, scoring). "Calibrate, don't configure" — the AI drafts, the human signs off.
2. **TTFQ is the only number that matters.** Welcome captures the Stage-0 success criterion as a friendly form; the pilot scoreboard and go/no-go readout grade everything against it. Kills "pilot purgatory" by making the decision mechanical, not political.
3. **Transparency + HITL on every consequential action.** The agent acts autonomously on safe reads, but **always confirms consequential writes** (send / reject / employer-reveal / book / publish-config). Every match and screen-out is reconstructable with evidence; every action leaves an immutable who-saw-what trail; every override becomes flywheel/eval data.
4. **Reuse, not rebuild.** Almost every screen is a thin layer over existing WeKruit infrastructure: the live Slack agent + 14-tool MCP, V16 two-way matching, PreScreenPipeline, `intake_job`/`enrichJobTags`/`deriveJobOpportunityDraft`, the dashboard-web admin shell, recruiter board, `unified-cache`, and the shared UI kit. Net-new is mostly orchestration + a handful of callables.
5. **Meet them where they work (Slack/Teams first).** The conversational agent in-channel is the **primary daily surface** — the place a recruiter/HM/admin runs the whole req→scheduled-interview loop. The web app is the system-of-record/triage/audit cockpit. Teams reaches parity via Adaptive Cards over the same card contracts.

---

## 2. Personas → Surface

| Persona | Primary job | Lives in |
|---|---|---|
| **TA / HR Admin** | Buys it, sets it up, owns policy & autonomy, proves ROI | **Web** — Onboarding Wizard + Setup Checklist Home, HITL/Trust Center (Autonomy, Audit), Pilot & Success Dashboard |
| **Recruiter (daily driver)** | Runs reqs end-to-end, approves & advances | **Slack agent** (primary) + **Web Command Center** (triage/system-of-record) |
| **Hiring Manager (calibrator/approver)** | Answers clarifying Qs, signs off rubric, approves adverse calls | **Slack** lightweight calibrate-and-approve cards + **Web** Calibration Workspace + Approvals |
| **The Agent (Claire)** | Does the work: intake, match, rediscover, prescreen-summarize, draft outreach, schedule | **Slack/Teams in-channel** (Bolt Assistant + Block Kit), over `paHeadhunterMcp` |
| **Candidate** | Gets matched/screened; controls their data & rights | **candidate.wekruit.com** — `/me`, `/me/privacy` Trust & Rights (AI-assist notice, opt-out, appeal, correct-data) |
| **CSM / AE** | Drives onboarding to value, runs QBRs/renewals | **Web** Pilot & Success Dashboard (`/admin/pilots`) |

---

## 3. Information Architecture — one map

### Web admin app (`wekruit-pa.web.app/admin/**`, @wekruit.com SSO)
```
/admin
├─ /setup                         Onboarding Wizard (shell + 7-step VerticalStepper)
│   └─ /setup/home                Setup Checklist Home (persistent, sidebar entry)
├─ /command-center                Reqs Overview (recruiter daily home)
│   └─ /req/:jobId                Per-req pipeline (kanban/funnel) + candidate drawer + pool browse
├─ /jobs/:jobId/calibrate         JD Intake & Rubric Calibration Workspace
├─ /approvals                     Unified Approvals Inbox (outreach + decisions + enrichment)
├─ /decision/:id                  Decision Explainability (why-matched / why-screened)
├─ /audit                         Decision Trail / immutable audit timeline
├─ /autonomy                      Agent Autonomy Control (action × stage matrix)
├─ /pilots                        Pilot & Success Dashboard (index → per-customer workspace)
│   └─ /pilots/:customerId        Onboarding Tracker · Scoreboard · Go/No-Go · QBR · per-req drill
└─ (existing) /match-debug · /candidates · /prescreen-ops · /rejected-candidates · /canonical-tags · /operations
```
Sidebar groups: **Setup** · **Run** (Command Center, Approvals, Pool) · **Trust** (Audit, Autonomy, Explainability) · **Success** (Pilots, Ops).

### Slack / Teams agent surface (over `paHeadhunterMcp`)
```
Assistant pane (DM + per-req channels)
├─ First-Run Guided Flow (threadStarted): Connect ✓ · Drop JD · Get candidates
├─ Result cards: Matched Candidates · Prescreen Verdict · Intake clarifying-Qs
├─ Proactive push cards: New Match · Outreach Approval · Adverse Review · Interview Booked · Daily Digest
├─ Slash commands: /wk match|pool|intake|prescreen|schedule|status|config + "Send to WeKruit" msg action
├─ Per-Channel Config modal (bind reqs, approval policy, autonomy dial, quiet hours)
└─ Transparency: thinking status · tool-trace footer · acts-vs-asks indicator · "Why this?" expander
Teams: Adaptive Card reskin of the same card contracts (single composer, two renderers)
```

### Candidate surface (`candidate.wekruit.com`, public/magic-link)
```
/me                 Home: AI-assist notice, profile completeness, active opportunities
/me/profile         Resume, LinkedIn, PII, Level-1, preferences, memory controls + correct-my-data
/me/matches         Recommended/invited jobs, plain-language "why matched / why not advanced"
/me/privacy         Trust & Rights: opt-out / alternative-process, appeal a decision, export/delete/stop
```

---

## 4. End-to-End Onboarding UX — narrative walk-through

**T-0 · Admin opens the wizard.** A new TA admin signs in (@company SSO) and lands on `/admin/setup`. The **Wizard Shell** shows a 7-milestone `VerticalStepper` and an honest ETA: *"~15 min of your time; ATS + security run in the background."* Every step has a "Why this matters" drawer and a persistent **Skip for now / Save & exit — resume anytime** (Step 0 — *Welcome*).

**Step 0 · The promise + the one number.** A hero card frames *"Your AI recruiter is ready — let's point it at a real role."* A two-column **You vs WeKruit** legend defuses config fear. The **SuccessMetricPicker** captures the Stage-0 written success criterion (default: *time-to-first-interview*) — this seeds the Pilot scoreboard later. (Welcome & Value screen.)

**Step 1 · The 2-minute delight.** *Add to Slack* → OAuth → the **ConnectStateCard** flips to *connected*. A **ChannelPicker** defaults to auto-created `#wekruit-hiring`; the **ApprovalPolicyForm** ships sensible defaults (admin + named approvers can approve sends; recruiters/HMs see consent-redacted PII). **Send test ping** → the agent posts a hello in-channel — instant proof a colleague has arrived. (Connect Slack/Teams.)

**Step 2 · The honest long-pole.** The **Kombo embedded connect** authorizes the ATS in one flow for Greenhouse/Ashby/Lever/etc. Native ATSs connect in minutes; Workday shows the **WorkdayBackgroundBanner**: *"IT will finish this in the background — we'll ping you in Slack."* A **SyncPreview** reads back *"Found 14 open reqs · 3,212 candidates."* No ATS? **Skip → pool-only pilot.** (Connect ATS.)

**Step 3 · Silver medalists become Day-1 assets.** The **FieldMapper** (reused from external-supply BatchNew) maps the four rediscovery-critical fields (status / rejection_reason / last_contact / owner); Kombo's normalized model pre-fills it. **DedupPreview** shows *"X new, Y already in pool, Z need review,"* routing conflicts to the identity-conflict HITL queue. A **silver-medalist callout** counts the >6-month-old rejected candidates now rediscoverable. (Import & Map Pool.)

**Step 4 · Bring the team (optional).** **BulkInviteForm** pastes emails or pulls Slack members; **RolePicker** assigns Admin/Recruiter/HM/HITL-Reviewer with least privilege; invite-via-Slack-DM means no new login to learn. Skippable — *"I'll pilot solo."* (Invite Team.)

**Step 5 · Calibrate, don't configure.** The **ReqPicker** pre-ranks synced reqs by pool overlap (*"we already hold 47 likely matches"*). `intake_job` runs; the HM answers **1–3 clarifying questions** inline; a **must-have vs nice-to-have** chip editor toggles hard-filter vs soft-score; **RubricPreview** shows the generated prescreen config + scoring rubric with HITL-flag chips on low-confidence items. *"Looks right"* is the Stage-5 gate. (Pick & Calibrate Pilot Req — and, for power users, the full **Calibration Workspace** at `/admin/jobs/:jobId/calibrate` with the canonical-tag editor, must-have matrix with live pool-reach deltas, and the **Eval-Fixture Preview** that scores strong/borderline/weak candidates before go-live.)

**Step 6 · "You're live."** One **LaunchButton** — *"Send WeKruit to work on Staff iOS Eng"* — fires the first match + rediscovery. The **LiveResultsFeed** streams the first qualified candidates (title, why-matched, prescreen-willing). Confetti; a deep-link: *"first candidates posted to #wekruit-hiring."* The **PilotScorecard** seeds with the chosen success metric, override-rate, and TTFI counters at 0. (Launch Pilot.)

**T+days · The cockpit takes over.** When the admin closes the tab, the wizard collapses into the **Setup Checklist Home** — completion ring, *"you're live"* badge, **BlockedOnBanner** separating *waiting-on-Workday-IT* from *waiting-on-you-to-invite-team*, and the live pilot scorecard. Recruiters move into the **Command Center** (reqs overview → per-req pipeline → candidate drawer → approvals inbox) and, more often, into **Slack**, where proactive **New Match / Outreach Approval / Adverse Review / Interview Booked** cards arrive with one-click actions. The CSM watches the **Pilot & Success Dashboard**; at the pilot's end the **Go/No-Go Readout** renders the pre-agreed criteria as a live pass/fail verdict, and at renewal the **QBR view** shows ROI vs a human-recruiter cost anchor and the flywheel of HITL corrections improving eval agreement.

---

## 5. Feature Catalog by Module

### Module A — Onboarding Wizard ("Get Live with WeKruit") · Effort **L**
**Screens:** Wizard Shell + Stepper · Step 0 Welcome/Value · Step 1 Connect Slack/Teams · Step 2 Connect ATS (Kombo) · Step 3 Import & Map Pool · Step 4 Invite Team · Step 5 Pick & Calibrate Pilot Req · Step 6 Launch Pilot · **Setup Checklist Home** (persistent).
**Key new components:** `VerticalStepper` (locked/active/in_progress/blocked/skipped/done) · `ConnectStateCard` (shared, Steps 1/2/3) · `SuccessMetricPicker` · `ApprovalPolicyForm` · Kombo embedded-connect wrapper + `SourceAttributionField` + `WorkdayBackgroundBanner` · `DedupPreview` + silver-medalist callout · `BulkInviteForm` + `RolePicker` + `PendingInvitesTable` · `ReqPicker` (pool-overlap pre-ranked) · `LiveResultsFeed` · `ChecklistCard`/`BlockedOnBanner`/`ConnectHealthStrip` · `SkipForNow` / Save-&-exit.
**Agent tools:** Slack agent (connect/test-ping/launch post), `intake_job`, `enrichJobTags`+`deriveJobOpportunityDraft`, `find_candidates_for_job`, `rediscover_for_job`, `summarize_prescreen`, `get_ops_metrics`; **Kombo unified ATS API** (net-new integration the wizard wraps).
**Reuse:** ui.tsx kit; `unified-cache`; external-supply BatchNew/FieldMapper/DedupPreview/IdentityConflicts; AtsInbound status-pill; LaunchReadiness snapshot+polling; JobEnrichmentReview/JobWorkspace; OperationsOverview+recharts; OnboardingQuestions pattern; HITL/confirm-first model; shared-tags vocab; dashboard-web shell+SSO.
**Build-new:** wizard route/shell; **org-scoped wizard-state Firestore doc + reducer + `paOnboardingState` callable** (resumable); `ConnectStateCard`; Kombo wrapper + Workday banner; SuccessMetricPicker + Stage-0 capture; ApprovalPolicyForm; invite components; DedupPreview; ReqPicker; LiveResultsFeed; Checklist Home; Skip/Save-&-exit wiring.

### Module B — Agent-in-Slack/Teams (primary daily surface) · Effort **M**
**Screens:** First-Run Guided Flow · Matched Candidates Result · Prescreen Verdict · Proactive New-Match · Proactive Outreach-Approval (core HITL gate) · Proactive Adverse-Decision Review · Interview-Booked · Slash Commands · Per-Channel Config modal · Transparency/Tool-Trace affordance.
**Key new components:** Block Kit composers (matchedCandidates, prescreenVerdict, outreachApproval, adverseReview, interviewBooked, channelConfig modal, intake clarifying-Q) · first-run 3-step rail state machine · tool-trace/data-scope footer + acts-vs-asks indicator · approval-policy resolver · per-channel config store.
**Agent tools:** `intake_job`, `find_candidates_for_job`/`find_matching_jobs_for_candidate`, `search_candidate_pool`, `rediscover_for_job`, `summarize_prescreen`, `draft_outreach`+`send_candidate_message` (gated), `schedule_interview`+`get_scheduling_status`, advance/reject/request_info/comment + `decide_employer_intro` + `reevaluate_candidate_tier`, `search_external_candidates`, `get_prescreen_ops_snapshot`/`get_ops_metrics`.
**Reuse:** `paHeadhunterSlack` (Bolt Assistant) + `paHeadhunterMcp` (14 tools, live); Bolt `threadStarted`/`setSuggestedPrompts`/`setStatus` (avoids app.message silent-bot bug); `toSlackMrkdwn`; `capForAgent`/MAX_ROWS=25; `redact.ts`; confirm-first write gates + LOCKED outbound safety; V16 why-matched + tiers + PreScreenPipeline verdicts; dashboard deep-links; CorrectionEvent audit.
**Build-new:** **`paHeadhunterInteractions`** (net-new interactivity URL: button_click/view_submission/block_actions → confirm-first writes); **`paHeadhunterProactivePush`** (scheduled CF composing new-match/outreach/adverse/booked cards per channel config + quiet hours); per-channel config store (`pa-headhunter-channels`); slash-command registrations + "Send to WeKruit" action; shared card-contract layer (Slack Block Kit + Teams Adaptive Cards, single composer/two renderers); **Teams parity** (M, fast-follow).

### Module C — JD Intake & Rubric Calibration ("calibrate, don't configure") · Effort **L**
**Screens:** *Slack lightweight* — Intake Trigger/Parse Receipt · Confidence Tag Review · Clarifying-Qs Q&A (re-enrich loop) · Approve-Config Gate. *Web detailed* — Calibration Workspace · Canonical Tag Editor · Must-have vs Nice-to-have Matrix · Prescreen Question & Rubric Editor · Eval-Fixture Preview ("how would they score?") · Approve & Publish Gate.
**Key new components:** Confidence tag-editor chips (confidence bar, evidence popover, canonical-vocab combobox, sandbox propose-new) · two-lane must-have/nice-to-have matrix with weight sliders + **live pool-reach delta** · question↔rubric-dimension side-by-side editor + coverage warnings · Eval-Fixture Preview (strong/borderline/weak + mismatch flags + add-custom-candidate spot-check) · Slack calibration Block Kit cards.
**Agent tools:** `intake_job`, `enrichJobTags`, `deriveJobOpportunityDraft` (single source of hardFilters/softScoringWeights/prescreenConfigDraft/scoringRubric/evalFixtures/coverage/hitlFlags), `find_candidates_for_job` (pool-reach), `summarize_prescreen`+KeywordSetJudge/PreScreenPipeline (fixture scoring).
**Reuse:** the whole calibration UI is a thin editable layer over the JobOpportunityDraft; shared-tags vocab + proposedTags sandbox + canonical-tags promote/reject; CorrectionEvent audit; Bolt patterns + `withProgressHeartbeat`; useCachedResource/drawers/panels; résumé preview; match-debug score rendering.
**Build-new:** **`paAdminCalibrateJobUpdate`** (granular edit → re-derive + CorrectionEvent); **`paAdminPublishJobConfig`** (approve gate flips `prescreenConfigDraft.approved=true`, reversible unpublish); Calibration Workspace route; tag editor; must-have matrix; question+rubric editor; Eval-Fixture Preview; Slack cards; approver/role gating; pool-reach service wrapper.

### Module D — Recruiter Command Center · Effort **L**
**Screens:** Reqs Overview (home) · Per-Req Candidate Pipeline (kanban/funnel) · Candidate Profile Drawer · Pool Browse & Free-Text Search · Approvals Inbox.
**Key new components:** `ReqCard` (funnel mini-bar + freshness chip + attention badge) · per-req kanban joining candidate×job state → SubmissionStage lanes · `CandidateCard` (why-matched top-2 + verdict + tier + SLA flag) · unified Approvals Inbox surface · "Add to req" action (creates approval-gated outreach draft) · cross-req candidate history rollup · attention/SLA scorer · Slack deep-link helper.
**Agent tools:** the full match/pool/rediscover/external/summarize/scheduling/draft/send/advance/reject/decide/reevaluate/intake set + `get_ops_metrics`.
**Reuse:** `SideDrawer` from PrescreenReviewDrawers; CandidateResumePreview; ui.tsx; `unified-cache`; **RecruiterBoardOps** stage vocab (`SubmissionStage`, `statusDisplay`, `STAGE_PRIMARY_ACTION`, `isBulkRejectSelectable`, `buildBoardGroups`, `verdictChip`); recruiter-submission-actions/list APIs; MatchDebug.helpers; prescreen-ops-api + EngagementPanel; PassedCandidates + IntroDecision (redaction); `algolia-search.ts`; candidate-pool-counts/rejected-candidates APIs; shared-tags chip; CorrectionEvent path.
**Build-new:** CommandCenter shell + routes; ReqCard; **`paCommandCenterReqsOverview`** callable (per-req funnel counts + freshness + attention scoring, server-side whole-pool scan); pipeline state-machine adapter; CandidateCard; unified Approvals Inbox + outreach-readiness selector; "Add to req"; cross-req history; attention/SLA scorer.

### Module E — HITL & Trust Center · Effort **L**
**Screens:** Approvals Inbox (`/admin/approvals`) · Decision Explainability (`/admin/decision/:id`) · Decision Trail / Audit (`/admin/audit`) · Agent Autonomy Control (`/admin/autonomy`) · Slack/Teams approval cards · Candidate Trust & Rights (`/me/privacy` + `/me`).
**Key new components:** unified card model + one approve/override API ingesting multiple pending sources · override-with-reason → always-emit CorrectionEvent · Decision Explainability (why-matched V16 + why-screened prescreen, version-pinned, exportable) · read-only audit-query callable + timeline UI · Autonomy action×stage matrix with locked safety rails + per-req scope · candidate AI-assist notice + opt-out/alt-process + appeal/correct-data + status tracker.
**Agent tools:** `send_candidate_message` (gated), `summarize_prescreen`, V16 match tools, `paAdminMatchDebug`, `decide_employer_intro`, advance/reject/request_info/comment, `intake_job` (low-confidence → queue), `reevaluate_candidate_tier`; **net-new `get_autonomy_policy`/`route_for_approval`** the agent consults before acting.
**Reuse:** PendingOutbound queue (generalize → Approvals); CorrectionEvent + flywheel-candidate-correction + writeEvalArtifactForCorrection; prescreen-review-sla (48h breach); MatchDebug/admin-match-debug v16Score+hardFilter; summarize_prescreen + KeywordSetJudge + engagementSignal + school/employer advisories; CandidateResumePreview + EngagementPanel; **Flags.tsx pattern** (type-aware toggles + pa_audit_events drawer + revert) → Autonomy matrix; pa_audit_events/pa-outbound/prescreen events (audit spine); eval-labels dual-pane labeling; `paCandidatePrivacyRequest`+`paCandidateProfileCorrection` + `/me/privacy`.
**Build-new:** unified Approvals shell + one approve/override API; override-with-reason → CorrectionEvent (beyond outbound); Decision Explainability join view; Audit Timeline + read-only audit-query callable (CSV/JSON export); Autonomy matrix + storage + `get_autonomy_policy` callable; Slack approval block-kit + handlers; candidate AI-assist notice + `appeal_decision`/`alt_process` privacy-request kinds + plain-language "why" card; routing layer (auto-act audited vs create approval card).

### Module F — Pilot & Success Dashboard · Effort **L**
**Screens:** Pilots index · Onboarding Tracker · Success Scoreboard · Go/No-Go Readout · QBR view · Per-req drill-down.
**Key new components:** `StageStepper` (8 gated onboarding stages + gate criteria + next-action owner) · 6 baseline-vs-current StatCards + recharts trend lines with baseline ReferenceLine · deterministic Go/No-Go evaluator + verdict banner + export · ROI block (human-recruiter cost anchor) · Flywheel panel (HITL corrections → eval agree-rate) · per-req funnel + override log.
**Agent tools:** `intake_job` (calibration stage signal), V16 match (matched/qualified rate), `summarize_prescreen` (PASS=qualified), `get_prescreen_ops_snapshot`/`get_ops_metrics` (scoreboard backbone), `schedule_interview`/`get_scheduling_status` (interviews booked), `draft_outreach`/`send_candidate_message` + Sendblue events (response-rate lift); FlywheelEval snapshot.
**Reuse:** dashboard-web shell + SSO; OperationsOverview patterns (StatCard, Segmented, RANGE/GRANULARITY, recharts, rollup, truncated-scan banner); LaunchReadinessView status tones; FlywheelEval + flywheel-eval-api; ui.tsx; `unified-cache`; **paAdminOpsMetrics as the scoreboard template**; CorrectionEvent/eval-labels; deep-links into MatchDebug/PrescreenSession/RecruiterSubmissions; recharts already in repo.
**Build-new:** Pilots index + route; per-customer workspace (5 sub-tabs); StageStepper; **`pa-pilots/{customerId}` config doc** (Stage-0 metric, baseline, go/no-go criteria, ROI anchor, pilot reqs, stage statuses); **`paAdminPilotScoreboard`** (baseline-vs-current aggregation, clones paAdminOpsMetrics scan); **`paAdminPilotConfig`** (CRUD); deterministic Go/No-Go evaluator; baseline-capture flow; per-req funnel + override log; ROI block; export readout/QBR deck (anthropic pdf/pptx skills or client print); response-rate-lift metric definition.

---

## 6. The "Wow" Moments (protect these in every cut)

1. **Easy-button first qualified candidate.** Step 6's one button → `LiveResultsFeed` streams real candidates with why-matched into `#wekruit-hiring` within ~2 min. This *is* the product demo; everything before it is in service of it.
2. **The agent as a colleague who asks permission.** Proactive **Outreach Approval** and **Adverse Review** cards in Slack — *agent drafts, never sends* — with one-click Approve/Edit/Override, gate-checklist (✓consent ✓not-suppressed ✓prior-inbound), and a visible acts-vs-asks indicator. Trust you can *see*.
3. **Why-matched / why-screened transparency.** The Decision Explainability view reconstructs any decision: V16 weighted score breakdown + hard-filter ledger on one side, per-question prescreen rubric with evidence quotes on the other — exportable for bias-audit/appeal. Plus the candidate-facing plain-language "why" card.
4. **Silver-medalists as a Day-1 asset.** Step 3's rediscovery callout turns *"3,212 imported candidates"* into *"487 re-screenable silver medalists for your open reqs"* — value before any new sourcing.
5. **The pilot scoreboard that ends pilot purgatory.** Baseline-vs-current against the Stage-0 metric, with a deterministic Go/No-Go verdict the customer pre-agreed to — the decision is mechanical, not political.

---

## 7. Phased Build Roadmap (feature/UX only)

### Phase MVP — "Self-serve to first qualified candidate" · ~**L** (one focused build)
**Ships:** Onboarding Wizard happy-path (Shell+Stepper, Step 0 Welcome/metric, Step 1 Slack connect+test-ping, Step 2 Kombo ATS connect *or* skip-to-pool, Step 3 pool import+dedup+silver-medalist callout, Step 5 single-req calibrate via `intake_job` lightweight, Step 6 Launch → LiveResultsFeed into Slack) + persistent **Setup Checklist Home** + resumable wizard-state doc/callable. Slack **First-Run Guided Flow** + **Matched Candidates** + **intake clarifying-Q** cards. Minimal confirm-first **Outreach Approval** card (reuses existing gates).
**Why:** the smallest path that delivers the north-star moment end-to-end and is demoable to a buyer. Steps 4 (invite) and full web calibration are *skip-friendly*.
**Leans hardest on reuse** — see §8.

### Phase v1 — "Full daily-driver + trust" · ~**L**
**Ships:** **Command Center** (reqs overview → per-req pipeline → candidate drawer → pool browse → approvals inbox). Full **JD Calibration** web Workspace (tag editor, must-have matrix w/ pool-reach deltas, question+rubric editor, Eval-Fixture Preview, Approve&Publish gate) + Slack lightweight calibrate-and-approve. **HITL & Trust Center**: unified Approvals Inbox, Decision Explainability, Decision Trail/Audit, candidate Trust & Rights. Wizard Step 4 (Invite Team + RBAC).
**Why:** turns the demo into a system recruiters live in daily, and lands the enterprise trust proofs (HITL on every adverse call, full audit, candidate rights) that unblock the contract.

### Phase v2 — "Proactive, measured, multi-channel, ATS-deep" · ~**M–L**
**Ships:** **`paHeadhunterProactivePush`** (proactive New-Match/Adverse/Interview-Booked cards + daily digest + quiet hours) + per-channel config + slash commands. **Agent Autonomy Control** matrix + `get_autonomy_policy`/`route_for_approval` routing. **Pilot & Success Dashboard** (tracker, scoreboard, Go/No-Go, QBR, ROI, flywheel). **ATS-deep** (source-attribution write-back, Workday ISU background flow, status sync). **Teams parity** (Adaptive Cards over shared contracts).
**Why:** continuous value without on-demand prompting, the leash dial that scales autonomy safely, the renewal/QBR proof, and channel + ATS breadth for larger accounts.

---

## 8. Reuse Map (specific, per phase)

**MVP builds on:**
- **Slack agent:** `paHeadhunterSlack` (Bolt Assistant) + `paHeadhunterMcp` (14 live tools); `threadStarted`/`setSuggestedPrompts`/`setStatus`; `toSlackMrkdwn`; `capForAgent`/MAX_ROWS=25; confirm-first gates + LOCKED outbound safety.
- **Matching/prescreen:** V16 `find_candidates_for_job`/`rediscover_for_job` (why-matched + tiers); `intake_job`+`enrichJobTags`+`deriveJobOpportunityDraft`; `summarize_prescreen`.
- **Pool import:** external-supply **BatchNew + FieldMapper + DedupPreview + IdentityConflicts**; shared `pa-users` pool.
- **Shell/UX:** dashboard-web admin shell + @wekruit.com SSO; ui.tsx kit; `unified-cache`; **LaunchReadiness** snapshot+polling (import/launch progress); AtsInbound status-pill; OnboardingQuestions pattern.
- **Net-new only:** wizard shell + state doc/callable, ConnectStateCard, SuccessMetricPicker, Kombo wrapper, LiveResultsFeed, Checklist Home.

**v1 builds on:**
- **Recruiter board:** RecruiterBoardOps stage vocab (`SubmissionStage`, `statusDisplay`, `STAGE_PRIMARY_ACTION`, `isBulkRejectSelectable`, `buildBoardGroups`, `verdictChip`) + recruiter-submission-actions/list APIs; `SideDrawer`; CandidateResumePreview; MatchDebug.helpers; prescreen-ops-api + PrescreenSession + EngagementPanel; PassedCandidates redaction; `algolia-search.ts`; candidate-pool-counts/rejected-candidates APIs.
- **Trust:** PendingOutbound queue (→ generalize to Approvals); CorrectionEvent + flywheel-candidate-correction + writeEvalArtifactForCorrection; prescreen-review-sla; admin-match-debug v16Score+hardFilter; `paCandidatePrivacyRequest`+`paCandidateProfileCorrection`+`/me/privacy`; eval-labels dual-pane.
- **Calibration:** shared-tags vocab + proposedTags sandbox + canonical-tags promote/reject; JobOpportunityDraft (confidence/coverage/hitlFlags/evalFixtures); KeywordSetJudge/PreScreenPipeline; `find_candidates_for_job` pool-reach.

**v2 builds on:**
- **Autonomy/audit:** Flags.tsx (type-aware toggles + pa_audit_events drawer + revert) → Autonomy matrix; pa_audit_events/pa-outbound/prescreen events → Audit spine.
- **Pilot dashboard:** OperationsOverview patterns (StatCard, Segmented, RANGE/GRANULARITY, recharts, rollup, truncated-scan banner); **paAdminOpsMetrics** as scoreboard template; LaunchReadinessView tones; FlywheelEval + flywheel-eval-api; recharts (already in repo).
- **Channels/ATS:** shared card-contract layer (Slack Block Kit + Teams Adaptive Cards); Sendblue delivery events (response-rate-lift); Kombo write-back for source-attribution; deep-links into MatchDebug/PrescreenSession/RecruiterSubmissions throughout.

---

**Definition of done for onboarding (north-star check):** a net-new admin, with no training, reaches a launched pilot req whose first qualified candidates appear in Slack with why-matched explanations — and a CSM can show, on the Pilot scoreboard, TTFQ moving against the Stage-0 baseline. Everything in this plan is graded against that sentence.
