# V19 — Full Candidate Journey Live SMS Test Guide

**Author:** Claude (frosty-wozniak-84b965 worktree)
**Date:** 2026-05-12
**Audience:** Adam (the only operator with the test phone + Apple ID)
**Goal:** End-to-end candidate journey on real iMessage, all 5 seeded jobs, single-session test plan with per-job expectation + exact message sequence.

---

## What this guide covers

1. **Pre-flight reset** — wipe Adam's pa-user + browser state so the test starts clean
2. **First-time onboarding via public job page** — upload CV, trigger SMS, prescreen, PII, Level 1, matches
3. **Second-time onboarding** (different jobs) — CV upload skipped, same userId reused
4. **Per-job expectation** — what verdict (PASS / HARD_STOP / FAIL) Adam should see given his actual resume
5. **Post-test verification** — Firestore queries Adam can paste to confirm state
6. **What's NOT in v1.9** — Gmail login, LinkedIn connect (flagged for v2.0)

> **Adam's resume on file** (parsed reference):
> - Name: Adam (Shixiang) Yang
> - Phone: `(424)-320-1960` → normalized E.164 `+14243201960`
> - Email: `adamyang@usc.edu`
> - Location: Los Angeles, CA
> - Education: USC BS CS, May 2025 (new grad), GPA 3.92, Minor Cloud + DevOps
> - Experience: Tesla SWE intern (May 2024–present, React/Node V&C portfolio @ 300 stores), AI Study founder (DKT research + LangChain RAG), OFO Delivery co-founder (iOS app, 10K users, $2K/day, Stripe/OpenAI), Northwestern Mutual intern (.NET/C# actuarial), HireBeat intern (GraphQL/Apollo/AWS)
> - Skill bucket: full-stack SWE, lean backend, junior/new-grad
> - Function vs. designer / marketer / PM: SWE, not those

---

## Changes shipped in this round (must redeploy before test)

| # | Change | File | Why |
|---|---|---|---|
| **A** | cv-ingest writes `pa-users.{uid}.phoneE164` from parsed CV `phone` | `apps/functions/src/cv-ingest/cv-ingest.ts` | Parsed phone was extracted then discarded. Now ATS path (no inbound first) can outbound-text the candidate. |
| **B** | PublicJob page: single global `wkr_uid` localStorage key (not per-job) | `apps/dashboard-web/src/pages/PublicJob.tsx` + `PublicJobCv.tsx` | Returning candidate across multiple job pages was creating a NEW pa-user each time. Now one stable identity per browser. |
| **C** | PublicJob: green "✓ We have your resume on file" badge when `wkr_has_cv` localStorage flag set | `PublicJob.tsx` | Second-job visit no longer prompts for re-upload. |
| **D** | PublicJobCv: stamps `wkr_has_cv = true` after successful upload | `PublicJobCv.tsx` | Powers the above. |
| **E** | `scripts/v19-reset-adam.mjs` — hard reset Adam's user across all v1.9 collections | new file | Required for a clean test. |

Build status (2026-05-12): orchestrator 1479/1479 ✓, functions 1143/1143 ✓, simulator full-flow PASS ✓.

---

## Step 0 — Pre-flight reset (run BEFORE every test cycle)

### 0.1 Server-side reset (delete Adam's pa-user + related state)

```bash
cd /Users/adam/Desktop/WeKruit/wekruit-pa  # or worktree path
node scripts/v19-reset-adam.mjs
```

Expected output:
```
v1.9 reset — target uid=e5d97cd8-1e1d-439d-8672-3008f8aeef2e, phone=+14243201960

[1] pa-users doc (hard delete)
[2] parsedCandidateResumes where userId == uid
  ✓ parsedCandidateResumes: N/N deleted
[3] pa-prescreen-sessions where id contains uid
  ✓ pa-prescreen-sessions: N/N deleted
[4] pa-pii-confirm-state + pa-pii-confirm-meta
[5] pa-prescreen-pending-invites + pa-ats-pending-trigger
[6] pa-prescreen-trigger-idempotency + pa-apply-trigger-idempotency
  ✓ pa-prescreen-trigger-idempotency: N/N deleted
[7] pa-memory-* + pa-conversation-summaries + pa-tag-events (userId-keyed)
  ✓ pa-memory-facts: N/N deleted
  ...
[8] pa-entity-tags subcollection (entity-keyed)

Reset done. Adam's next inbound SMS creates a fresh pa-users doc.
```

### 0.2 Browser-side reset (Safari / Chrome where Adam will open /j/:jobId)

Open DevTools console at any wekruit.com page and run:
```js
localStorage.removeItem('wkr_uid')
localStorage.removeItem('wkr_has_cv')
// also nuke any legacy per-job keys
Object.keys(localStorage).filter(k => k.startsWith('wkr_rid_')).forEach(k => localStorage.removeItem(k))
console.log('cleaned. now:', JSON.stringify(localStorage))
```

### 0.3 Deploy current branch

```bash
cd apps/functions && pnpm run deploy        # cv-ingest phoneE164 fix
cd ../.. && pnpm run deploy:hosting          # PublicJob repeat-user UI
firebase deploy --only firestore:rules --project wekruit-5f89b --non-interactive
```

---

## What's IN v1.9 vs what's NEW v2.0 scope

### IN v1.9 (testable today)
- Public job page `/j/:jobId` (no auth)
- CV upload from local PDF
- Phone + email extracted from CV → pa-users.phoneE164 + tags
- iMessage trigger SMS via Sendblue pool number (hash-by-userId)
- Pre-screen pipeline (KeywordSet Q1-Q2, MUST_HAVE matchThreshold 0.85)
- PASS / FAIL / HARD_STOP / PAUSE terminals
- PII confirm (legalName + email + phone) for ALL terminals except PAUSE
- Level 1 collection (yoe / visa / location / salary / industry / company_size)
- generateJobRecs after PII complete
- Returning user: same browser → same `wkr_uid` → CV upload skipped on 2nd+ job

### NEW for v2.0 (NOT TESTABLE TODAY — flagged for Adam)
- ❌ Login with Gmail at wekruit.com (OAuth) — candidates currently identified by localStorage UUID only
- ❌ "Connect LinkedIn" button (LinkedIn API binding to enrich profile) — schema field exists (`pa-resume-parser.candidateProfile.linkedIn`) but never populated
- ❌ Single email-keyed user lookup across browsers/devices — currently new browser = new wkr_uid = new pa-user even with same email

> If Adam tests on his iPhone Safari and laptop Chrome, they will be 2 different pa-users today. That's a v2.0 fix.

---

## Test 1 — First-time candidate, multi-job journey (single session)

This test exercises the **complete** flow: fresh user uploads CV once, then runs prescreen on 5 jobs back-to-back. The CV upload happens once; the 4 subsequent job page visits show the "we have your resume" badge.

### Setup (one-time, per test cycle)
1. Run Step 0.1, 0.2, 0.3 above
2. Confirm Adam's phone is connected to the test Apple ID
3. Open Firestore console to `pa-users` + `pa-prescreen-sessions` in a tab for live observation

### Job order (do them in this sequence)

| # | jobId | Role | Adam expected verdict | Why |
|---|---|---|---|---|
| **1** | `hs-11005382-invoko-product-designer` | Product Designer | **HARD_STOP** at Q1 | Adam = SWE, no product design portfolio. Q1 asks consumer-facing design work shipped. |
| **2** | `hs-11005377-invoko-ui-ux-designer` | UI/UX Designer | **HARD_STOP** at Q1 | Same — no UI/UX shipped. |
| **3** | `hs-11005308-paradigm-gtm-growth` | GTM & Growth Marketing | **HARD_STOP at Q1**, possible PASS to Q2 | Marginal. If Adam frames OFO Delivery user-acquisition (10K users) as growth: Q1 might pass. Q2 (zero-to-one) he'll pass strongly (founder x2). |
| **4** | `hs-10996795-invoko-product-manager` | Product Manager | **PASS** (most likely) | OFO Delivery = consumer product shipped, 10K users, founder = strong consumer signal. Q2 prioritization — he has founder sprint experience. |
| **5** | `test-swe-screen-001` | Senior Frontend Engineer (test job) | **HARD_STOP at Q2** | Q1 React: PASS (Tesla + OFO React work). Q2 "owned end-to-end with deploy + on-call + observability" → Adam intern role, no on-call. |

### Job 1 — Product Designer (HARD_STOP path, NEW USER, CV upload)

#### Sequence

**Phase A — Public job page**
1. Adam opens `https://wekruit-pa.web.app/j/hs-11005382-invoko-product-designer` in Safari
2. Page loads, no CV badge (fresh user)
3. Page shows: job title "Product Designer", company "invoko.ai", salary range, JD body
4. Adam taps "**upload it here**" link → routes to `/j/hs-11005382-invoko-product-designer/cv`
5. Adam selects `Adam-Yang-Resume.pdf` (194 KB) → taps Upload
6. After ~3-8 sec: green "✓ Got it. Head back to the job page and tap 'Open in iMessage' to start the screen."
7. **localStorage now**: `wkr_uid = <UUID-X>`, `wkr_has_cv = "true"`
8. **Firestore now**:
   - `pa-users/<UUID-X>` exists with `tags.skills = [c++, java, javascript, react, ...]`, `tags.yoeRange = ...`, `phoneE164 = "+14243201960"`, `phoneE164Source = "cv_parsed"`
   - `parsedCandidateResumes/<auto>` exists with `userId = "<UUID-X>"`, `candidateProfile.phone = "(424)-320-1960"`, `candidateProfile.email = "adamyang@usc.edu"`

**Phase B — Trigger SMS**

9. Adam navigates back to `/j/hs-11005382-invoko-product-designer`
10. Now shows: "✓ We have your resume on file — no need to re-upload. Just tap 'Open in iMessage' above to start." (green box)
11. Adam taps "**Open in iMessage →**" → iMessage opens with prefilled message:
    `WeKruit_hs-11005382-invoko-product-designer_<UUID-X>_Job`
    sent to pool number (one of `+13054507716` or `+14243201960`, picked by djb2 hash of UUID-X)
12. Adam taps Send

**Phase C — Pre-screen (HARD_STOP expected)**

13. ~5-15 sec later, iMessage receives from same pool number:
    > Hi — Claire from invoko.ai. Quick screen for Product Designer. Tell me about your product design work — what consumer-facing product have you shipped, and what role did you play?

14. Adam replies honestly:
    > I'm a software engineer, mostly backend. Haven't done product design work directly.

15. ~5-10 sec later, receives:
    > Thanks for the reply. One required area didn't align for this role — let's look at other options.

    (This is the HARD_STOP terminal — score < 0.85 threshold on the `product_design_consumer` keyword.)

**Phase D — PII confirm (fail-source framing) + Level 1**

16. Almost immediately after #15:
    > Before you go — to keep you in the loop for better-aligned roles, what's your legal full name?

17. Adam replies:
    > Adam Yang

18. Receives:
    > What email should the employer use to reach you?

19. Adam replies:
    > adamyang@usc.edu

20. Receives:
    > And the best phone number for next-step coordination?

    *(Note: today PII pipeline asks phone Q even though pa-users.phoneE164 is already set from CV parse. v2.0 should skip-or-confirm. For this test, Adam just retypes.)*

21. Adam replies:
    > +14243201960

22. Receives:
    > Now a few quick fit-questions for future role matches. Years of relevant work experience?

23. Adam replies:
    > 1 year

24. Receives:
    > Work-authorization status? (US citizen, green card, H1B / OPT / CPT, sponsorship needed, other)

25. Adam replies (his real status — likely OPT/F1 → sponsor needed):
    > F1 OPT, will need H1B sponsorship

26. Receives:
    > Preferred work location(s)? (city / region or 'remote' / 'anywhere')

27. Adam:
    > Bay Area, NYC, LA

28. Receives:
    > Minimum total compensation expectation? (e.g. '120k' or '$140-180k' or 'open')

29. Adam:
    > 120k

30. Receives:
    > Industries you're most interested in? (e.g. AI, fintech, healthtech, gaming — or 'open')

31. Adam:
    > AI, fintech

32. Receives:
    > Preferred company stage? (seed / early-startup / scale-up / mid-market / enterprise / open)

33. Adam:
    > seed, early-startup

34. Receives:
    > Thanks — I'll text you when stronger matches come up.

**Phase E — Auto-matching (background)**

35. ~10-30 sec after #34, Adam receives 1-3 SMS like:
    > New match: <Job Title> at <Company>
    > <ATS apply URL>
    > 为啥推: <2-line LLM reason>

    These come from `generateJobRecs` triggered by `onPiiAllCollected` hook.

#### Firestore verification (paste in console at Firebase UI)

After Job 1 finishes, check:
```
pa-users/<UUID-X> →
  phoneE164: "+14243201960"
  phoneE164Source: "cv_parsed"
  contactPII.legalName: "Adam Yang"
  contactPII.email: "adamyang@usc.edu"
  contactPII.phone: "+14243201960"
  contactPII.source: "prescreen_fail_followup"
  contactPII.consentedAt: <ISO>
  tags.yoeRange: { lowYears: 1, highYears: 1 }
  tags.visaStatus: "sponsor_needed"
  tags.targetLocations: ["bay_area", "nyc", "los_angeles"]
  tags.minSalary: 120000
  tags.industrySector: ["artificial_intelligence_and_machine_learning", "financial_technology"]
  tags.companySize: "seed"   or  "early_startup"
  tags.level1CollectedAt: <ISO>
  tags.level1Source: "fail"
  tags.skills: [react, node, javascript, c++, java, python, typescript, ...]   ← from CV

pa-prescreen-sessions/ps_hs-11005382-invoko-product-designer_<UUID-X>_<YYYYMMDD> →
  terminal: "HARD_STOP"
  scores.q_product_design_experience: < 0.85
```

### Job 2 — UI/UX Designer (HARD_STOP, RETURNING USER, no CV upload)

**Difference from Job 1**: localStorage now has `wkr_uid` + `wkr_has_cv`. Same browser → SAME UUID.

1. Adam opens `https://wekruit-pa.web.app/j/hs-11005377-invoko-ui-ux-designer`
2. Page shows green "✓ We have your resume on file — no need to re-upload" box. **DOES NOT** show "upload it here" link.
3. Adam taps "Open in iMessage →" → SMS body: `WeKruit_hs-11005377-invoko-ui-ux-designer_<UUID-X>_Job` (SAME UUID as Job 1)
4. Pool number = same as Job 1 (djb2 hash of UUID is stable)
5. Reply:
   > Hi — Claire from invoko.ai. Quick screen for UI/UX Designer. Describe your UI/UX design work — what interface have you shipped for real users?

6. Adam:
   > Same as before — I'm SWE not UI/UX. No interface design experience.

7. Receives:
   > Thanks for the reply. One required area didn't align for this role — let's look at other options.

8. PII confirm is **SKIPPED** this time. Reason: `pa-users.<UUID-X>.contactPII.consentedAt` was set during Job 1. Adam receives:
   > We already have your contact details on file — the employer will reach out directly.

9. `generateJobRecs` re-fires; Adam may get more match SMS.

#### Verification
```
pa-prescreen-sessions/ps_hs-11005377-...-_<UUID-X>_<DATE> → terminal: "HARD_STOP"
pa-users.<UUID-X>.contactPII → unchanged from Job 1
```

### Job 3 — GTM/Growth (marginal; may HARD_STOP or PASS, depending on Adam's answer)

1. Open `/j/hs-11005308-paradigm-gtm-growth`
2. Same "we have your resume" badge
3. Trigger SMS → Q1: "Tell me about a growth or marketing campaign you owned — what was the channel, the audience, and what numbers did you move?"

**If Adam answers honestly framing his founder work:**
   > At OFO Delivery I drove user acquisition across 2 college campuses, hit 10K users and $2K/day. Channels were campus flyers, Instagram, word-of-mouth. AI Study I got 20+ university English departments to adopt our research tool.

   → likely **score ≥ 0.85 → PASS Q1**, moves to Q2.

**Q2**: "Have you ever built something from scratch with no playbook?"
   → strong for Adam (founder x2). Should PASS.

**If both pass → PASS terminal**, different copy:
   > Great — to share with the employer, can you confirm your legal full name?

(PII pass-source, but legalName already confirmed → skip-all → Adam receives:)
   > We already have your contact details on file — the employer will reach out directly.

Then `generateJobRecs` again.

**If Adam answers more bluntly ("I'm SWE not marketer")** → HARD_STOP same as Job 1/2.

### Job 4 — Product Manager (PASS expected)

1. Open `/j/hs-10996795-invoko-product-manager`
2. Trigger SMS → Q1: "Tell me about consumer product work you've done — PM, design, or eng role on a real user-facing product. What did you ship and what feedback did it drive?"

Adam:
   > I co-founded OFO Delivery, an iOS app for instant campus deliveries. We hit 10K users across 2 schools, $2K/day revenue, 100+ daily orders. I owned eng + product. We iterated based on courier feedback (faster pickup notifications) and rider feedback (Stripe checkout was bouncing on edge cases — fixed).

→ should score ≥ 0.85 on `consumer_product_shipping`. PASS Q1.

3. Q2: "How do you decide what to ship next when you have more ideas than time?"

Adam:
   > Order by impact-to-effort ratio. At OFO we had ~5 ideas/week — I'd pick the one with highest 1-week impact (e.g. fix Stripe bouncing = direct revenue) and defer nice-to-haves (e.g. dark mode). Used a simple value/effort 2x2 plus founder gut.

→ should PASS Q2 (concrete framework + example).

4. Both PASS → **PASS terminal**:
   > Great fit on the must-haves. Here's the next step: <apply URL>. Salary range: <range>. Expected next-step timeline: <eta>.

   (`level1Reveal` from job config — applyUrl + salaryRange + nextStepEta.)

5. Then PII confirm pass-source (or skip if already collected from earlier jobs):
   > We already have your contact details on file — the employer will reach out directly.

6. `generateJobRecs` re-fires.

### Job 5 — Senior Frontend Engineer (test-swe-screen-001) (HARD_STOP at Q2 expected)

1. Open `/j/test-swe-screen-001`
2. Trigger SMS → Q1: "Describe your React production experience — what have you shipped, at what scale, and what was your role?"

Adam (truthful):
   > At Tesla I'm a SWE intern working on a React/Node.js V&C portfolio used by 300+ stores. At OFO Delivery I built the React/Next.js management portal that served 10K users.

→ should PASS Q1 (real React work at scale, even if intern).

3. Q2: "What production systems have you owned end-to-end? (deploy, on-call, observability)"

Adam:
   > As an intern at Tesla I shipped features but didn't carry on-call rotation. At OFO I deployed via Firebase but we didn't have formal on-call or observability.

→ should HARD_STOP (the `production_ownership_e2e` keyword requires real on-call + observability).

4. HARD_STOP terminal → "Thanks for the reply. One required area didn't align for this role — let's look at other options."

5. PII skip (already collected) → "We already have your contact details on file — the employer will reach out directly."

6. `generateJobRecs` re-fires.

---

## Test 2 — Pattern B: ATS-sourced applicant (NOT testable without G3 secret rotation)

> **Gated on Adam-action G3**: `firebase functions:secrets:set ATS_HANDSHAKE_HMAC_SECRET --project wekruit-5f89b` with a real HMAC secret. Without this, `paAtsInboundWebhook` deploy fails or returns 401.

Skipped for this test cycle. Document for v1.9.5 if Adam rotates the secret.

---

## Edge cases to verify

### EC1 — CV phone extracted, no inbound first
- Reset Adam fully (Step 0.1)
- DO NOT trigger any SMS
- Upload his CV at `/j/<any-job>/cv` directly (without first sending iMessage)
- Verify `pa-users.<UUID>.phoneE164 = "+14243201960"` + `phoneE164Source = "cv_parsed"` in Firestore
- This proves Bug A fix works.

### EC2 — Second upload should overwrite phone if user fixed it
- Upload CV → phone set from CV
- Manually edit pa-users doc → set phoneE164 to `+15551234567` (simulating user correction)
- Re-upload SAME CV
- Verify `pa-users.<UUID>.phoneE164` stays `+15551234567` (NOT overwritten, as expected)
- This proves the "only-if-empty" guard works.

### EC3 — Same browser, fresh tab, different job
- After Job 1, close all wekruit-pa tabs
- Open new tab → `/j/hs-11005377-...`
- Verify "we have your resume" badge appears (localStorage persists across tabs)

### EC4 — Different browser (Safari → Chrome) = different user
- Open Job 1 in Safari (do everything)
- Switch to Chrome → open `/j/hs-11005377-...`
- Verify Chrome shows the upload prompt (NOT the badge) → because Chrome has its own localStorage
- This is the v2.0 gap. Document, don't fix today.

---

## Stop-and-report-back checkpoints

If Adam observes any of these, STOP and paste to Claude:

1. **Bug A still alive**: After Step 0 + CV upload, `pa-users.<UUID>.phoneE164` is empty or absent
2. **Bug C UI broken**: Returning user (Job 2+) still sees "upload it here" instead of green badge
3. **Sequence drift**: Q-reply-Q ordering doesn't match the documented sequence
4. **Wrong terminal**: Job 4 (PM) lands HARD_STOP instead of PASS, OR Job 1/2 (designer) lands PASS instead of HARD_STOP
5. **Stuck on Claire fallthrough**: Receive Claire-style commentary after PII completion (the "wait—aretrying to sha" pattern from prior test)
6. **Trigger doesn't fire**: After tapping "Open in iMessage" + Send, no Claire reply within 30 sec

For each: paste the exact iMessage text + screenshot + which step number it deviated at.

---

## Appendix — Reset cheat sheet

| Action | Command |
|---|---|
| Hard-reset Adam server-side | `node scripts/v19-reset-adam.mjs` |
| Browser reset | `localStorage.clear()` in DevTools at wekruit-pa.web.app |
| Re-deploy functions | `cd apps/functions && pnpm run deploy` |
| Re-deploy hosting | `pnpm run deploy:hosting` |
| Re-deploy rules | `firebase deploy --only firestore:rules --project wekruit-5f89b --non-interactive` |
| Re-seed test job | `node scripts/v19-reseed-test-job.mjs` |
| Re-seed 4 handshake jobs | `node scripts/v19-seed-handshake-jobs.mjs` |
| Simulator (no SMS) | `node scripts/v19-simulate-full-flow.mjs` |
| All-job simulator | `node scripts/v19-simulate-all-jobs.mjs` |

---

## Open v2.0 backlog (NOT this cycle)

1. **Gmail login for candidates** — OAuth at /j/:jobId allowing email-keyed identity across browsers/devices.
2. **LinkedIn connect button** — populate `parsedCandidateResumes.candidateProfile.linkedIn` + enrich profile from LinkedIn API.
3. **Skip phone Q in PII when pa-users.phoneE164 already set** — current pipeline still asks even after CV-parse. Should ask "confirm we can text you at +1 424 320 1960?" with yes/no/different.
4. **Bulk resume upload + email-anyone login** — Adam's stated long-term ATS pivot direction.
5. **Cross-job pa-user merge by email** — if 2 separate UUIDs both have contactPII.email = "x@y.com", merge into single user.
