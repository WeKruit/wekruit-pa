# WeKruit — Full Product Handoff Brief

**For:** Incoming lead-agent session (will direct a team of executor agents to build the final WeKruit product).
**From:** Claude (frosty-wozniak-84b965 worktree), 2026-05-13.
**Goal:** Single self-contained brief that captures product north star, current shipped state, architecture, UIUX state, data model, open gaps, and the v2.0 wishlist Adam has surfaced. The lead reads ONLY this doc + replies; no other context required.

---

## 0. TL;DR (read first)

- **Product:** WeKruit is an AI job-search companion ("Claire") that runs over iMessage/SMS. Candidates text Claire, she pre-screens, matches them to jobs, and hands them off to employers. Employer-side dashboard is OUT OF SCOPE (deferred v2.0).
- **Current state:** v1.9 (End-to-End Candidate Journey Closure) code-complete + deployed, but **live SMS test BLOCKED at upload step until 2026-05-13 hotfixes landed**. Domain split now locked: `candidate.wekruit.com` for C-end, `wekruit-pa.web.app` for admin.
- **Tech stack:** TypeScript monorepo (pnpm). Firebase: Hosting (3 sites) + Firestore (`pa-*` collections) + Cloud Functions Gen 2 + Mailgun + Sendblue (iMessage transport). LLM chain: gpt-5.4-nano primary, claude-sonnet-4-6 fallback, gpt-4.1-mini final. Embedding: text-embedding-3-small 1536d. Async LLM rerank: Qwen-7B JSON-mode via SiliconFlow.
- **Tests:** orchestrator 1479/1479 green, functions 1143/1143 green, simulator full-flow PASS, 6 prescreen scenarios green.
- **Live ship gate:** `ATS_HANDSHAKE_HMAC_SECRET` Firebase Secret + Cloudflare DNS already wired (`candidate` CNAME → `wekruit-pa-landing.web.app`).
- **The 5 hotfix commits today (2026-05-13)** are the real handoff state — see §9.

---

## 1. Product North Star

> "Skip the apply-and-pray. Claire finds matches, drafts intros, surfaces referrals — over iMessage. Like texting a friend who knows the market."

**Two user-entry routes** (from Adam's hand-drawn user-flow diagram):

**A. Direct route** — candidate visits `candidate.wekruit.com/j/<jobId>` from a referral / share, optionally uploads CV, then sends a trigger SMS to start a 5-minute pre-screen with Claire.

**B. Async ATS route** — an Applicant Tracking System (Handshake first, Greenhouse/Lever/LinkedIn deferred) POSTs an applicant payload to `paAtsInboundWebhook`. WeKruit finds-or-creates a `pa-user`, parses the resume from the ATS-provided URL, and sends an outbound iMessage invite. Candidate replies → pre-screen kicks off virtually.

Both routes converge on the same pre-screen + match + outcome pipeline.

**The 5-section flow** (from Adam's diagram):

| # | Section | What happens | Owning component |
|---|---|---|---|
| 1 | **User Entry** | Direct: visit job page, send SMS. ATS: webhook → invite SMS. | `apps/pa-landing/src/pages/PublicJob.tsx`, `paAtsInboundWebhook` CF |
| 2 | **CV / Profile Setup** | CV upload (PDF/DOCX), parse via pa-resume-parser v2, write to `parsedCandidateResumes` + `pa-users.tags`. Optional, single-time. | `paPublicCvIngest` CF + `apps/functions/src/cv-ingest/cv-ingest.ts` |
| 3 | **Shared Routing & Match Pipeline** | Sendblue inbound webhook routes by phone → orchestrator processes inbound event → triggers PreScreenPipeline. Pool-routed outbound (hash-by-userId for thread continuity). | `paSendblueWebhook` CF + `apps/functions/src/sendblue/pool.ts` |
| 4 | **Interview Flow** | 4-gate state machine: Confidence → Type → Viability → Final. KeywordSet judges with per-Q `matchThreshold` (default 0.85). Terminal PASS / FAIL / HARD_STOP / PAUSE. | `packages/pa-orchestrator/src/prescreen/PreScreenPipeline.ts` |
| 5 | **Outcome / Next Actions** | PASS → Level 1 info reveal + auto generateJobRecs + PII confirm + "explore more?" question. FAIL → "match other jobs?" + PII collect + generateJobRecs. HARD_STOP → Exit. PAUSE → write `pausedAt` stamp. | `apps/functions/src/prescreen-terminal-action.ts` + `pii-confirm-start.ts` |

---

## 2. Architecture Overview

### Repo layout

```
wekruit-pa/                                    (this monorepo)
├── apps/
│   ├── pa-landing/         (Vite SPA, C-end — candidate.wekruit.com)
│   │   └── src/pages/
│   │       ├── Landing.tsx          (/ — Claire CTA black gradient)
│   │       ├── Legal.tsx            (/legal — privacy + terms)
│   │       ├── PublicJob.tsx        (/j/:jobId — inline CV upload + SMS trigger)
│   │       └── PublicJobCv.tsx      (/j/:jobId/cv — legacy upload, backwards compat)
│   ├── dashboard-web/      (Vite SPA, ADMIN — wekruit-pa.web.app)
│   │   └── src/pages/
│   │       ├── /admin/match-debug         (live UI to inspect match cascade)
│   │       ├── /admin/canonical-tags      (industrySector sandbox→promote)
│   │       ├── /admin/qa-evaluator        (weekly evaluator output)
│   │       ├── /admin/onboarding-questions(question registry)
│   │       ├── /admin/job-prescreen       (pa-jobs config editor)
│   │       ├── /admin/ats-inbound         (applicant list per ATS source)
│   │       ├── /admin/sendblue-pool       (multi-number pool admin)
│   │       └── /admin/prescreen-feedback  (weekly aggregate of survey replies)
│   ├── functions/          (Firebase Cloud Functions Gen 2)
│   │   └── src/
│   │       ├── index.ts                   (re-exports all CFs)
│   │       ├── sendblue/                  (iMessage transport adapter + pool router)
│   │       ├── cv-ingest/                 (resume parse pipeline)
│   │       ├── ats-adapters/              (handshake.ts impl + 3 stubs)
│   │       ├── ats-inbound-webhook.ts     (paAtsInboundWebhook CF)
│   │       ├── ats-inbound-handler.ts     (CanonicalApplicant → invite SMS)
│   │       ├── public-cv-ingest.ts        (paPublicCvIngest CF — public-page upload)
│   │       ├── prescreen-session-start.ts (runPreScreenForUser handler)
│   │       ├── prescreen-turn-handler.ts  (per-turn dispatch)
│   │       ├── prescreen-terminal-action.ts (PASS/FAIL/HARD_STOP wiring)
│   │       └── pii-confirm-start.ts       (PII + Level 1 pipeline kickoff)
│   ├── eval/               (eval harnesses for voice / match / drift)
│   ├── job-rec/            (legacy job-rec utilities)
│   └── stress/             (load test scripts)
├── packages/
│   ├── pa-orchestrator/    (main brain — agent runtime, pipelines, voice)
│   │   └── src/
│   │       ├── onboarding/                (Question<T> + OnboardingPipeline base)
│   │       ├── prescreen/
│   │       │   ├── PreScreenPipeline.ts   (4-gate state machine)
│   │       │   ├── pii-confirm.ts         (PII + Level 1 pipeline)
│   │       │   ├── config.ts              (PrescreenConfigSchema)
│   │       │   ├── level1-template.ts     (PASS reveal copy)
│   │       │   └── judges/                (KeywordSet, regex, etc)
│   │       ├── matching/                  (generateJobRecs, queryMatchingJobs)
│   │       └── voice/                     (humanize-runtime, mirror-style)
│   ├── pa-resume-parser/   (LLM chain CV→StructuredCv schema)
│   ├── shared-tags/        (canonical vocab: roleFunction, industrySector, etc)
│   ├── memory/             (Mem0 client + clearUserMemory + compaction)
│   ├── core-types/         (shared TypeScript types)
│   ├── agent-runtime/      (OpenAI Agents SDK wrapper)
│   ├── agent-registry/     (versioned agent prompt configs)
│   └── firebase-admin/     (shared Admin SDK helpers)
├── config/firebase/
│   ├── firestore.rules     (security rules — operator-only with carve-outs)
│   └── firestore.indexes.json
├── scripts/                (deploy + seed + test helpers)
│   ├── v19-reset-adam.mjs                 (hard-reset test user)
│   ├── v19-seed-handshake-jobs.mjs        (4 Handshake jobs seed)
│   ├── v19-simulate-full-flow.mjs         (in-memory pipeline simulator)
│   ├── inject-pa-landing-vite-env.mjs     (env injector for C-end build)
│   └── inject-pa-dashboard-vite-env.mjs   (env injector for admin build)
└── .planning/              (specs, milestones, audits — this brief lives here)
```

### LLM stack

| Tier | Provider | Model | Use |
|---|---|---|---|
| Primary | OpenAI | `gpt-5.4-nano` | CV parse main, prescreen judging, Claire voice |
| Fallback | Anthropic | `claude-sonnet-4-6` | 5xx/timeout retry, "industryTags=other" second pass |
| Final | OpenAI | `gpt-4.1-mini` | Last-chance fallback |
| Async rerank | SiliconFlow | `Qwen/Qwen2.5-7B-Instruct` JSON-mode | Nightly batch JD-CV match score |
| Embedding | OpenAI | `text-embedding-3-small` (1536d) | Sync at cv-ingest, used in `scoreJob` |

**Budget:** < 12s p99 per match request (sync). < 24h for nightly LLM rerank batch. Zero net new LLM calls in production voice path.

### Domain & hosting (LOCKED 2026-05-13)

| Domain | Site | App | Auth |
|---|---|---|---|
| `candidate.wekruit.com` | `wekruit-pa-landing` | `apps/pa-landing` | None (public) |
| `pa.wekruit.com` | `wekruit-pa-landing` | same | None |
| `wekruit-pa-landing.web.app` | `wekruit-pa-landing` | same | None |
| `wekruit-pa.web.app` | `wekruit-pa` | `apps/dashboard-web` | Google sign-in, `@wekruit.com` |

**Cloudflare DNS:** `candidate` + `pa` CNAMEs both point at `wekruit-pa-landing.web.app` (DNS-only proxy mode).
**Admin → candidate 301:** `wekruit-pa.web.app/j/:rest*` → `https://candidate.wekruit.com/j/:rest*`.

**Cloud Functions:** all at `https://us-central1-wekruit-5f89b.cloudfunctions.net/<funcName>`.

---

## 3. Data Model (Firestore — collections prefixed `pa-*`)

### Core entities

| Collection | Doc shape | Owner |
|---|---|---|
| `pa-users/{uid}` | `{phoneE164, phoneE164Source, contactPII: {legalName, email, phone, consentedAt, source}, tags: {roleFunction[], industrySector[], skills[], yoeRange, visaStatus, targetLocations[], minSalary, companySize, level1CollectedAt, level1Source}, onboardingState, resumeAccepted, resumeId, resetEpoch, ...}` | Server-only writes (Admin SDK from CFs) |
| `pa-jobs/{jobId}` | `{publicVisible, jobTitle, company, location, salaryRange, descriptionMd, atsApplyUrl, prescreenConfig: {questions[], threshold, confidenceThreshold, maxClarifyRounds}, level1Reveal: {applyUrl, salaryRange, nextStepEta}, roleFunction[], industrySector[], requiredSkills[], seniorityLevel, sponsorship, jobType, firstSeenAt, dead}` | Operator-write, public-read when `publicVisible=true` |
| `parsedCandidateResumes/{auto-id}` | `{userId, candidateProfile: {name, email, phone, linkedIn, location, skills}, experiences, education, industryTags, sha256, createdAt}` | Server-only |

### Pre-screen state

| Collection | Purpose |
|---|---|
| `pa-prescreen-sessions/{sessionId}` | Per-(jobId, userId, date) session. Holds `state`, `cfgSnapshot`, `terminal`, `terminalActionFiredAt`, `feedback` |
| `pa-prescreen-sessions/{sid}/turns/{turnId}` | Per-turn evaluation explanation |
| `pa-pii-confirm-state/{userId}` | PII pipeline state machine |
| `pa-pii-confirm-meta/{userId}` | source + jobId + onComplete deps for resume |
| `pa-prescreen-trigger-idempotency/{pairKey}` | 60-min idempotency stamp |
| `pa-apply-trigger-idempotency/{pairKey}` | Apply trigger stamps |
| `pa-prescreen-pending-invites/{requestedUserId}` | Public-page UUID → jobId bind |
| `pa-ats-pending-trigger/{phoneE164}` | 24h ATS-trigger virtualize window |

### Transport / event log

| Collection | Purpose |
|---|---|
| `pa-inbound-events/{id}` | Sendblue inbound payload archive |
| `pa-outbound/{id}` | Outgoing SMS queue + audit |
| `pa-messages/{id}` | Transcript |
| `pa-turns/{id}`, `pa-agent-turns/{id}` | Orchestrator turn audit |
| `pa-audit-events/{id}` | Generic audit |
| `pa-tool-calls/{id}` | Agent tool invocation audit |

### Memory subsystem

`pa-memory-{facts,actions,events,profiles,evolution-events}` — Mem0/Qdrant-backed semantic memory + Firestore mirror.

### Config + flags

- `pa-feature-flags/{flag}`
- `pa-remote-config/{key}`
- `pa-config/sendblue-pool` (multi-number pool — public-read for client-side hashing)
- `pa-config/{other}` (operator-only)

### Tagging (v1.6 unified)

- `pa-canonical-tags/{vocab}/{token}` — runtime-add-able vocab overlay
- `pa-tag-events/{eventId}` — write-ahead log
- `pa-entity-tags/{entityId}/items/{tagKey}` — entity↔tag join
- `pa-match-weight-tables/{tableKey}/items/{skillKey}` — JD-relative weight

### ATS / external

- `pa-jobs-external-mapping/{source}_{externalId}` → `jobIdInternal`
- `pa-ats-invite-idempotency/{source}_{externalJobId}_{applicantId}` — 7-day dedupe

---

## 4. The Three Pipelines (zero-rebuild reuse mandate)

All three derive from `OnboardingPipeline` base + `Question<TAnswer>` abstraction (iter34 P1).

### 4a. PreScreenPipeline (v1.8 P76)

```
START
  ↓
Confidence Gate     — KeywordSetJudge scores each MUST_HAVE Q.
                      If s_i < matchThreshold (default 0.85) → HARD_STOP.
                      Per-Q `matchThreshold` overrides default for multi-keyword Qs.
  ↓
Type Gate           — Aggregates MUST_HAVE pass/fail.
                      If any MUST_HAVE not passed → HARD_STOP.
  ↓
Viability Gate      — Aggregates GOOD_TO_HAVE soft scores.
                      Compares against `pa-jobs.prescreenConfig.threshold`.
  ↓
Final Gate          — Returns PASS / FAIL / HARD_STOP / PAUSE.
```

**Terminals:**
- **PASS** → `runPrescreenTerminalAction()` fires Level 1 reveal SMS → starts PiiConfirmPipeline (pass-source copy) → on completion fires `generateJobRecs(userId)`.
- **FAIL** → "Match other jobs?" preamble → starts PiiConfirmPipeline (fail-source copy) → on completion fires `generateJobRecs(userId)`.
- **HARD_STOP** → "Thanks for the reply. One required area didn't align — let's look at other options." → SAME PII + matches chain as FAIL (per Adam 2026-05-12 directive: "no dead-ends").
- **PAUSE** → "Claire 暂时不确定" SMS + write `pausedAt`. No PII collected.

### 4b. PiiConfirmPipeline (v1.9 P85)

Extends `OnboardingPipeline` with `source: "pass" | "fail"` (different copy) and `includeLevel1: true` (chains 6 more Qs after PII).

**3 PII Questions:** legal name, email, phone (validators in `packages/pa-orchestrator/src/prescreen/pii-confirm.ts`).

**6 Level 1 Questions (Adam directive 2026-05-12):** yoeRange, visaStatus, targetLocations[], minSalaryUsd, industrySector[], companySize.

**Writes to `pa-users.{uid}.tags` via `mergeUserTags` AND `pa-users.{uid}.contactPII`. Skip-if-present:** if `contactPII.consentedAt` exists, swallow + send "we already have your details" closing message.

### 4c. FeedbackSurveyPipeline (v1.9 P89)

2-Question post-PASS opt-in survey: 1-5 rating + freeform. Writes to `pa-prescreen-sessions.{sid}.feedback`. Skip phrase: "skip".

---

## 5. Trigger Taxonomy

| Trigger | Pattern | Handler | Outcome |
|---|---|---|---|
| `_Job` | `WeKruit_<jobId>_<userId>_Job` | `PrescreenTrigger` (v1.8 P77) | Bootstrap prescreen session |
| `_Apply` | `WeKruit_<jobId>_<userId>_Apply` | `ApplyTrigger` (P85) | Skip prescreen → direct PII (if prior PASS exists) or fall back to prescreen |
| `__PA_RESET__` | literal (or `重置我的记忆`) | memory/admin reset | Hard-delete user + memory |
| `__PA_COMPACT__` | literal | `CompactTrigger` (v1.8 P74.5) | Memory compaction admin |
| `__PA_FIND_MATCH__` | literal | dev trigger | Force `generateJobRecs` |
| ATS invite virtual | first non-trigger reply within 24h | `pa-ats-pending-trigger` consume-once | Webhook synthesizes `WeKruit_..._Job` |

---

## 6. The 5 Currently-Seeded Jobs (test fixtures)

Adam's resume is on file (USC BS CS new grad, +14243201960, `adamyang@usc.edu`, SWE intern at Tesla + 2 founder gigs). Expected outcomes for each seeded job:

| jobId | Role | Company | Threshold | Adam expected | Why |
|---|---|---|---|---|---|
| `hs-11005382-invoko-product-designer` | Product Designer | invoko.ai | 0.85 | **HARD_STOP** Q1 | SWE ≠ designer, no portfolio |
| `hs-11005377-invoko-ui-ux-designer` | UI/UX Designer | invoko.ai | 0.85 | **HARD_STOP** Q1 | No UI/UX shipped |
| `hs-11005308-paradigm-gtm-growth` | GTM & Growth Marketing | paradigm.study | 0.85 | **HARD_STOP** Q1 or marginal PASS | OFO Delivery user-acq could pass if framed |
| `hs-10996795-invoko-product-manager` | Product Manager | invoko.ai | 0.85 | **PASS** | OFO Delivery consumer product strong |
| `test-swe-screen-001` | Senior Frontend Engineer (test) | (test) | varies | **HARD_STOP** Q2 | No on-call/observability |

Test URLs:
- `https://candidate.wekruit.com/j/hs-11005382-invoko-product-designer`
- (etc. for each jobId)

---

## 7. UIUX State (what users actually see)

### 7a. Landing (`candidate.wekruit.com/`)

Single dark-gradient page (iter33 design Adam approved):
- Badge: "Beta · iMessage only"
- H1: "Text **Claire**. Land your next job." (gradient accent on "Claire")
- Body: "Skip the apply-and-pray..."
- Primary CTA: large white pill button "Text Claire on iMessage" → `sms:+13054507715&body=hi`
- Below CTA: "or text +1 (305) 450-7715" (dashed underline link)
- Footer: "Built by WeKruit · Privacy & Terms"
- Fade-in animation, light/dark prefers-color-scheme support
- SessionStorage analytics breadcrumb (ts, referrer, utm src, UA)

### 7b. Public Job Page (`candidate.wekruit.com/j/:jobId`)

Cream-colored single-page card UI:
- Job title (h1)
- Company · Location subtitle
- Salary range (green bold)
- JD body (`descriptionMd` from `pa-jobs.{jobId}.prescreenConfig.descriptionMd`)
- **"Start the 5-minute screen" card** with:
  - Primary CTA: green pill "Open in iMessage →" → opens iMessage with body `WeKruit_<jobId>_<wkr_uid>_Job` to the pool number picked by djb2-hash-of-userId
  - QR code (desktop visitors)
- **Inline CV upload section** (single-page UX, no navigation):
  - Choose file (PDF/DOCX, ≤5MB)
  - Upload button (green pill)
  - During upload: "Parsing resume… / Reading your CV — takes 10-30 seconds"
  - After success: replaces with green badge "✓ We have your resume on file — tap 'Open in iMessage' above to start"
- Footer: "By starting, you agree to our privacy & terms. WeKruit will text you from +13054507716" (or whichever pool number you got)

**Identity:** `localStorage.wkr_uid` (single UUID per browser, NOT per-job). `localStorage.wkr_has_cv` stamped after upload. Legacy `wkr_rid_${jobId}` keys migrated on first read.

### 7c. Legal (`candidate.wekruit.com/legal`)

7-section privacy + terms page (light/dark mode). Content covers: What this is / what we store / what we don't store / who can see your data / your choices (decline memory / stop / delete) / email verification / beta caveats. Source: existing iter33 content preserved verbatim.

### 7d. Pre-screen iMessage flow (the conversation)

After candidate sends `WeKruit_<jobId>_<userId>_Job`:

1. Claire intros: "Hi — Claire from <Company>. Quick screen for <JobTitle>. <Q1 prompt>"
2. Candidate replies
3. Claire either clarifies (up to `maxClarifyRounds`) or advances to Q2
4. After all Qs: terminal SMS
   - **PASS:** Level 1 reveal — "Great fit on the must-haves. Here's the next step: <applyUrl>. Salary range: <range>. Expected next-step: <eta>."
   - **HARD_STOP/FAIL:** "Thanks for the reply. One required area didn't align for this role — let's look at other options."
5. PII confirm (pass-source or fail-source copy):
   - "Great — to share with the employer, can you confirm your legal full name?" (PASS)
   - "Before you go — to keep you in the loop for better-aligned roles, what's your legal full name?" (FAIL)
6. "What email should the employer use to reach you?"
7. "And the best phone number for next-step coordination?"
8. Level 1 (6 questions): YoE → Visa → Location → Salary → Industry → Company stage
9. Completion: "Thanks — you're all set. The employer will follow up directly." (PASS) / "Thanks — I'll text you when stronger matches come up." (FAIL)
10. ~10-30 sec later: 1-3 SMS like "New match: <Job Title> at <Company> / <applyUrl> / 为啥推: <2-line LLM reason>"
11. (PASS only, after generateJobRecs) 2-Q feedback survey: "1-5 rating?" → "What could be better? (or reply 'skip')"

### 7e. Admin Console (`wekruit-pa.web.app/admin/*`)

Operator-only (`@wekruit.com` Google sign-in):
- `/admin/match-debug` — live UI to inspect match cascade per user (queryMatchingJobs scores, LLM reasoning)
- `/admin/canonical-tags` — industrySector vocab editor (sandbox proposed → admin promote)
- `/admin/qa-evaluator` — weekly auto-eval output (100 user×match samples)
- `/admin/onboarding-questions` — Q-as-class registry + verify config
- `/admin/job-prescreen` — pa-jobs config editor + `publicVisible` toggle + `/j/<jobId>` preview link
- `/admin/ats-inbound` — applicant list per ATS source, status, retry, override
- `/admin/sendblue-pool` — multi-number pool admin (add/pause + per-number daily volume)
- `/admin/prescreen-feedback` — weekly aggregate of survey ratings + freeform comments

---

## 8. Bugs / Open Gaps Captured Today (2026-05-13)

| # | Severity | Issue | Status |
|---|---|---|---|
| 1 | BLOCKER | CV upload returned "CV ingest endpoint not configured" — backend CF `paPublicCvIngest` had never been built (Phase 87 shipped frontend only) | **FIXED** commit `30f278f`: built CF + wired secrets + VITE_CV_INGEST_URL env injector |
| 2 | UX | Upload page (`/j/:jobId/cv`) separated from job page (`/j/:jobId`) — Adam: "这些应该都在一个地方来回" | **FIXED** commit `4033ca9`: inline single-page UX in PublicJob.tsx |
| 3 | UX-ARCH | Candidate flow was hosted on admin domain (`wekruit-pa.web.app`) instead of customer-side site | **FIXED** commit `8ad0375` + `a95ecc8`: moved to `apps/pa-landing` Vite SPA, deployed to `wekruit-pa-landing` site = `candidate.wekruit.com` |
| 4 | BUG | Adam's CV phone was parsed but never written to `pa-users.phoneE164` — ATS path broken (no outbound to never-inbound-first users) | **FIXED** commit `b0cd046`: cv-ingest writes phoneE164 (NANP-aware) |
| 5 | UX | First-time user uploads CV; second-time visiting different job re-prompted to upload | **FIXED** commit `b0cd046`: single global `wkr_uid` localStorage + `wkr_has_cv` flag → green badge on return |
| 6 | DOC | Test guide had wrong URLs (admin domain) | **FIXED** commit `a95ecc8`: all docs use `candidate.wekruit.com` now |

**Still open (Adam-actions only):**
- **G3** — set `ATS_HANDSHAKE_HMAC_SECRET` via `firebase functions:secrets:set ATS_HANDSHAKE_HMAC_SECRET --project wekruit-5f89b` (gates Pattern B ATS testing)
- **DNS verify** — Cloudflare CNAME `candidate.wekruit.com` is set (DNS-only proxy). Firebase Hosting "Add custom domain" handshake may need a one-click in Firebase Console if SSL doesn't auto-provision

---

## 9. The 5 Hotfix Commits This Session (in order)

| Commit | Subject | What |
|---|---|---|
| `b0cd046` | v1.9 hotfix — full candidate journey: phoneE164 from CV + repeat-user CV skip + reset script + per-job test guide | Bug A (cv-ingest phoneE164 write) + Bug B (global wkr_uid) + reset script + V19-FULL-FLOW-TEST.md |
| `30f278f` | v1.9 hotfix — paPublicCvIngest HTTP CF (live test STOP fix) | New CF backend that was missing all along; ATS webhook default URL set |
| `4033ca9` | v1.9 hotfix — single-page candidate UX | InlineCvSection + InlineCvUpload merged into PublicJob.tsx |
| `8ad0375` | v1.9 hotfix — candidate flow LIVES on pa-landing | Converted pa-landing from static-only to Vite SPA; deleted mistaken `wekruit-candidate` site + `apps/candidate-web` |
| `a95ecc8` | docs — domain split lock + canonical URLs across CLAUDE.md / AGENTS.md / V19 test guides | Domain layout codified in 3 docs; all stale URLs swept |

**All on branch:** `claude/frosty-wozniak-84b965` (worktree). Branch is 67 commits ahead of `origin/main` — needs eventual merge.

---

## 10. What's IN v1.9 (testable today)

- Public candidate page `/j/:jobId` (no auth)
- CV upload from local PDF (inline, single-page)
- Phone + email extracted from CV → `pa-users.phoneE164` + tags
- iMessage trigger SMS via Sendblue pool number (hash-by-userId for thread continuity, distributed across new users)
- Pre-screen pipeline (KeywordSet Q1-Q2, MUST_HAVE matchThreshold 0.85 default with per-Q override)
- PASS / FAIL / HARD_STOP / PAUSE terminals
- PII confirm (legalName + email + phone) for ALL terminals except PAUSE
- Level 1 collection (yoe / visa / location / salary / industry / company_size)
- generateJobRecs after PII complete
- Returning user: same browser → same `wkr_uid` → CV upload skipped on 2nd+ job
- 2-Q feedback survey post-PASS
- ATS adapter for Handshake (Greenhouse/Lever/LinkedIn stubs return 501)

## 11. What's OUT of v1.9 (v2.0+ wishlist, surfaced by Adam this session)

### High-priority v2.0 (Adam-stated)

1. **Bulk-resume-upload dashboard for employers** — they upload N resumes, system parses each, creates email-keyed `pa-users`. Candidates log in via email (any provider) → see their pre-uploaded resume → confirm.
2. **LinkedIn binding AFTER email signup** (NOT as signup method). Schema field `parsedCandidateResumes.candidateProfile.linkedIn` exists but is never populated.
3. **Cross-browser / cross-device user merge by email** — currently new browser = new `wkr_uid` = new `pa-user` even with same email.
4. **Gmail login for candidates** at `candidate.wekruit.com` — OAuth allowing email-keyed identity across devices.
5. **Skip phone Q in PII when `pa-users.phoneE164` already set** — current pipeline still asks even after CV parse extracted it. Should ask "Confirm we can text you at +1 (424) 320-1960?" with yes/no/different.
6. **Employer dashboard** — passed-candidate inbox, manual review, schedule interview.
7. **libphonenumber-js integration** — international phone formatting (currently regex digits-only).
8. **Greenhouse / Lever production adapters** (slots stub 501 today).
9. **Multi-stage Level 2/3 info reveal** — gradual disclosure.
10. **PII vault encryption** beyond Firestore at-rest.
11. **Real-time match notifications** (still async daily via generateJobRecs).
12. **Public job page SEO / SSR** optimization.
13. **Per-job phone-number rotation across same-user repeat visits** — current sticky behavior intentional but Adam may want option to vary.

### Reuse-mandate constraint (carry forward to v2.0)

The lead MUST enforce: every new piece extends existing infra — Question/Pipeline, KeywordSetJudge, pa-resume-parser v2, mergeUserTags, generateJobRecs, TriggerRouter, sendImessage, pa-jobs config, PreScreenPipeline. Don't rebuild what exists.

---

## 12. v1.6 Design Lock (matching cascade — never re-litigate)

The match flow has **16 locked decisions** that the lead must honor. From CLAUDE.md:

- D1: `roleFunction` = jobright 17 enum verbatim, closed, multi-pick
- D2: `industrySector` = 42 enum, add-able by admin via dashboard sandbox→promote
- D3: `major` = soft score (NOT hard filter)
- D4: `visa` = exactly 4 enum (`citizen` / `permanent_resident` / `sponsor_needed` / `other`)
- D5: **NO abbreviations** in any closed vocab (LLM confusion risk)
- D6: `relevantTags` / `proposedTags` parse-time extract in pa-resume-parser schema
- D7: per-skill `baseWeight` × JD-relative weight (Qwen-7B nightly batch)
- D8: single user tag source: `pa-users/{uid}.tags`
- D9: match cascade: hard filter → skill+relevant+industry score → JD-CV LLM rerank async → emb cosine fallback
- D10: freshness window `firstSeenAt < 20d` (abandon `lastSeenAt`)
- D11: `cv-ingest` wires `pa-resume-parser` v2 (NOT inline single-shot)
- D12: post-parse Claire dialogue confirms understanding
- D13: QA evaluator runs weekly auto-eval
- D14: `__PA_FIND_MATCH__` iMessage trigger forces generateJobRecs
- D15: **reduce regex, prefer LLM judgment** for ambiguous classification
- D16: industry vocab add-able by admin (sandbox proposed → promote)

**Two orthogonal axes** (critical past mistake):
- `roleFunction` (axis 1, hard filter): WHAT you do
- `industrySector` (axis 2, soft score): WHAT KIND of company

A SWE at Stripe = `roleFunction='software_engineering'` AND `industrySector='financial_technology'`. Independent.

---

## 13. Operating Rules for the Lead Agent

### Adam's directives (cited verbatim)

- iter23: "你可以 deploy 不要再说让我 deploy 然后自己不做事情了" — **Deploy directly. Never tell Adam to deploy.**
- iter23: "你需要做测试，每个 playbook 测试看看是否真的生效" — **Verify by doing. Run scenarios. Read actual replies.**
- 2026-05-12: "你自己没有simulate过对话就返回吗？" — **Simulator-first development. Never push without verifying.**
- 2026-05-12: "when not pass, the response right????" — **FAIL/HARD_STOP MUST also collect PII + match other jobs. No dead-ends.**
- 2026-05-13: "这个功能点不是admin是customer side" — **Domain split is locked. Never put candidate routes on admin site.**
- 2026-05-13: "这些应该都在一个地方来回" — **Single-page UX, not back-and-forth.**

### Deploy commands (memorize)

```bash
# 1. Functions
cd apps/functions && pnpm run deploy
# Auth: FIREBASE_SERVICE_ACCOUNT_JSON in .env, sourced into GOOGLE_APPLICATION_CREDENTIALS

# 2. C-end SPA (candidate.wekruit.com)
firebase deploy --only hosting:pa-landing --project wekruit-5f89b --non-interactive

# 3. Admin SPA (wekruit-pa.web.app)
PA_DASHBOARD_VITE_ENV_FILE=apps/dashboard-web/.env.production.local \
  firebase deploy --only hosting:pa-dashboard --project wekruit-5f89b --non-interactive

# 4. Firestore rules / indexes
firebase deploy --only firestore:rules,firestore:indexes --project wekruit-5f89b --non-interactive
```

### Test commands

```bash
# Unit tests
pnpm --filter pa-orchestrator test       # 1479/1479
cd apps/functions && pnpm test           # 1143/1143

# In-memory simulator (no SMS sent)
node scripts/v19-simulate-full-flow.mjs
node scripts/v19-simulate-all-jobs.mjs

# Reset Adam's user for clean live test
node scripts/v19-reset-adam.mjs

# Real SMS test guide: .planning/V19-FULL-FLOW-TEST.md (LIVE) + V19-LIVE-TEST.md
```

### Pre-flight verify before any live SMS test (6 curl checks)

See `.planning/V19-FULL-FLOW-TEST.md` Step 0.4 — runs cv-ingest CF OPTIONS / empty body / non-PDF / candidate site / bundle URL embed / admin 301 redirect. **All 6 currently green.**

### Required reading (canonical docs)

- `CLAUDE.md` — operating contract + domain layout + v1.6 design lock + ship state
- `AGENTS.md` — same for non-Claude agents (mirror)
- `.planning/PROJECT.md` — milestone history + product context
- `.planning/REQUIREMENTS.md` — v1.9 51 REQ-IDs + traceability
- `.planning/ROADMAP.md` — phase plan (long)
- `.planning/MILESTONE-v1.9-candidate-journey.md` — architecture + reuse inventory
- `.planning/V19-FULL-FLOW-TEST.md` — 5-job live test plan with per-job expectation

---

## 14. Questions the Lead Should Decide / Confirm with Adam

(These are open product decisions the lead should drive resolution on before kicking off v2.0 work.)

1. **Email-keyed identity** — is the v2.0 north star "Gmail OAuth on candidate.wekruit.com" or "email + magic-link from any provider"? Current `pa-users` doc ID is a UUID (Sendblue userId or `wkr_uid` from public page). Cross-device merge by email is the explicit gap.
2. **Bulk resume upload** — does the employer paste a list of emails + drop N PDFs into a dashboard, or do they CSV-import from their ATS? Workflow shape affects whether we build a new admin page vs. just extend `paAtsInboundWebhook`.
3. **LinkedIn binding scope** — read-only profile enrichment, or read+write (post on behalf of)? Read-only is much smaller.
4. **Employer dashboard scope** — passed-candidate inbox is the MVP. Anything else (interview scheduling, candidate notes, message-on-behalf-of) v2.0 or v3.0?
5. **Per-job vs. cross-job PII** — currently `contactPII.consentedAt` is global per user. Should candidates be able to give different emails per employer? Default answer: no, keep global.
6. **HARD_STOP vs. FAIL framing** — both currently fall through to PII + matches. Is this Adam's permanent stance? Current copy says "Thanks for the reply. One required area didn't align." Same for both. Lead should confirm.
7. **Multi-language** — currently zh/en bilingual in Claire voice. Are we adding more? Spanish was floated for v2.0 but not committed.
8. **Sendblue pool growth strategy** — currently 2 numbers in pool (`+13054507716` + `+14243201960`). When do we scale? Trigger: 100 daily users? 10 daily users?

---

## 15. Final Sanity Checks (lead can paste before starting)

```bash
# 1. Build green
pnpm --filter pa-orchestrator test                    # expect 1479/1479
cd apps/functions && pnpm test                         # expect 1143/1143

# 2. Live infrastructure green
curl -sI https://candidate.wekruit.com/                 # expect 200
curl -sI https://candidate.wekruit.com/j/hs-11005382-invoko-product-designer  # expect 200
curl -sI https://wekruit-pa.web.app/j/hs-11005382-invoko-product-designer | grep -i location
# expect: location: https://candidate.wekruit.com/j/hs-11005382-invoko-product-designer

# 3. CF green
curl -s -X POST https://us-central1-wekruit-5f89b.cloudfunctions.net/paPublicCvIngest \
  -H "content-type: application/json" -d '{}'
# expect: {"ok":false,"reason":"missing_userId_or_tempUserId"}

# 4. Branch state
git status                                              # expect: branch ahead of main, clean working tree
git log --oneline -10                                   # expect: top 5 commits = b0cd046, 30f278f, 4033ca9, 8ad0375, a95ecc8
```

---

**Handoff complete.** Lead can now read this doc top-to-bottom and have full context. Adam is available for v2.0 product decision questions in §14. Live SMS test on the test phone is the next blocking step — run `node scripts/v19-reset-adam.mjs`, then `https://candidate.wekruit.com/j/hs-11005382-invoko-product-designer` per `V19-FULL-FLOW-TEST.md` Test 1.
