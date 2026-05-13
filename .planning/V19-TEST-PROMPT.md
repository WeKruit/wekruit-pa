# v1.9 — Test Prompts, Sample Content, Requirements & Expectations

**Last updated:** 2026-05-13
**Ship state:** Pre-screen 4-gate state machine + PII confirm + Level 1 onboarding chain (6 Qs) + matching, all deployed to wekruit-5f89b.

---

## What was added this round

**Level 1 onboarding chain** (per Adam directive: "我们在结束要问一些level1 info … 用我们的同一系统tag"):

After PII (legalName / email / phone) the same pipeline now asks 6 more Qs in this order, BEFORE firing job recs:

| # | Q | Tag field written | Accepted format examples |
|---|---|---|---|
| 4 | YOE | `pa-users.tags.yoeRange = {lowYears, highYears}` | `3`, `3-5`, `5 years`, `10+`, `<1`, `five` |
| 5 | Visa | `pa-users.tags.visaStatus` (citizen / permanent_resident / sponsor_needed / other) | `US citizen`, `green card`, `H1B`, `OPT`, `STEM OPT`, `need sponsorship` |
| 6 | Location | `pa-users.tags.targetLocations[]` | `SF, NYC`, `remote`, `anywhere`, `Seattle or Boston` |
| 7 | Salary | `pa-users.tags.minSalaryUsd` (number) | `120k`, `$140-180k`, `open`, `negotiable` |
| 8 | Industry | `pa-users.tags.industrySector[]` | `AI, fintech`, `gaming`, `open` |
| 9 | Company size | `pa-users.tags.companySize` (seed / early_startup / scale_up / mid_market / enterprise / open) | `seed`, `Series A`, `scale-up`, `FAANG`, `Fortune 500`, `30 people`, `open` |

All 6 write to `pa-users.{uid}.tags.*` — same source of truth `generateJobRecs` reads. Stricter match on future SMS.

**Completion text after all 9 collected:**
- PASS source: `"got everything I need — running the match now ✓"` (chained then sends job rec list)
- FAIL source: same chain, different framing on Q1 ("Before you go — to keep you in the loop...")

---

## 4 production jobs seeded (Handshake content)

| Job ID | Title | Company | Pay | Public URL |
|---|---|---|---|---|
| `hs-11005382-invoko-product-designer` | Product Designer | invoko.ai | $80-120K | https://wekruit-pa.web.app/j/hs-11005382-invoko-product-designer |
| `hs-11005377-invoko-ui-ux-designer` | UI/UX Designer | invoko.ai | $80-120K | https://wekruit-pa.web.app/j/hs-11005377-invoko-ui-ux-designer |
| `hs-11005308-paradigm-gtm-growth` | GTM & Growth Marketing Manager | paradigm.study | $90-130K | https://wekruit-pa.web.app/j/hs-11005308-paradigm-gtm-growth |
| `hs-10996795-invoko-product-manager` | Product Manager | invoko.ai | $90-140K | https://wekruit-pa.web.app/j/hs-10996795-invoko-product-manager |

All publicly visible (publicVisible=true). All single-keyword MUST_HAVE with matchThreshold=0.85. Threshold T=0.65 to PASS.

---

## Sample candidate replies per job — strong (PASS), marginal, weak (HARD_STOP)

### Job 1 — invoko.ai Product Designer
**Q1 prompt:** Tell me about your product design work — what consumer-facing product have you shipped, and what role did you play?
**Q2 prompt:** How do you prototype your ideas? Comfortable with Figma + something like Framer / v0 / Cursor for interactive prototypes?

| Profile | Q1 reply | Q2 reply | Expected |
|---|---|---|---|
| **Strong** | "Led design at Series A consumer fintech, 2 years — shipped onboarding redesign that lifted activation 22%" | "Figma daily + Framer for marketing flows + v0/Cursor for fast prototypes. Recently shipped 4 prototypes in 5 days" | **PASS** |
| Marginal | "Designed a few interfaces for college projects, shipped one to my campus app store" | "Comfortable in Figma; haven't used Framer or v0 much" | HARD_STOP (consumer experience too thin) |
| Weak | "I do graphic design and branding for local restaurants" | "Mostly Photoshop and Illustrator" | HARD_STOP (not product design) |

### Job 2 — invoko.ai UI/UX Designer
**Q1:** Describe your UI/UX design work — what interface have you shipped for real users?
**Q2:** What's your iteration cadence — comfortable shipping rough prototypes fast and refining vs. waiting for the perfect final design?

| Profile | Q1 reply | Q2 reply | Expected |
|---|---|---|---|
| **Strong** | "Shipped onboarding + dashboard for a consumer health app at 50k+ MAU" | "Ship rough Figma within 2 days, weekly user feedback loops. Threw away 3 weeks of work after a usability test and rebuilt" | **PASS** |
| Marginal | "Did UI for an internal admin tool at my last job" | "I like to plan thoroughly before designing" | HARD_STOP (not consumer + slow iteration) |
| Weak | "I'm more of a print designer, but I've used Figma" | "I prefer perfection over speed" | HARD_STOP |

### Job 3 — paradigm.study GTM & Growth Marketing Manager
**Q1:** Tell me about a growth or marketing campaign you owned — channel, audience, numbers
**Q2:** Have you ever built something from scratch with no playbook?

| Profile | Q1 reply | Q2 reply | Expected |
|---|---|---|---|
| **Strong** | "Owned organic TikTok for a learning startup — 0 to 80k followers in 6 months, drove 12k signups" | "Started a podcast from zero as a senior. Designed the format, booked guests, scaled to 200 listens/episode" | **PASS** |
| Marginal | "I ran some Google Ads for my last team — boss set the budget and copy" | "I followed playbooks the marketing lead made" | HARD_STOP (no real ownership) |
| Weak | "I'm strong in PR and event marketing" | "I work best with established processes" | HARD_STOP |

### Job 4 — invoko.ai Product Manager
**Q1:** Tell me about consumer product work — PM, design, or eng role on a real user-facing product
**Q2:** How do you decide what to ship next when you have more ideas than time?

| Profile | Q1 reply | Q2 reply | Expected |
|---|---|---|---|
| **Strong** | "First PM hire at a consumer travel app — shipped booking flow rewrite, drove 18% conversion lift" | "Prioritize by user-signal × strategic alignment / effort. Cut 2 features last quarter to ship a friction-reducer that moved retention 9pts" | **PASS** |
| Marginal | "PM on internal HR tooling at a midsize company" | "I follow whatever the executive sponsor wants" | HARD_STOP (B2B not consumer) |
| Weak | "I'm starting my first PM role next month" | "I'll figure it out when I get there" | HARD_STOP |

---

## End-to-end expected message sequence (Pattern A or B)

After candidate's trigger SMS is sent, this is the **complete** sequence the tester should see (PASS path on test job):

| # | Direction | Content (paraphrase) |
|---|---|---|
| 1 | inbound | `Hi — Claire from <Company>. Quick screen for <Job Title>. <Q1 prompt verbatim>` |
| 2 | candidate reply | strong answer to Q1 |
| 3 | inbound | `<Q2 prompt verbatim>` |
| 4 | candidate reply | strong answer to Q2 |
| 5 | inbound | PASS terminal: `Thanks for your answers! You've passed the initial screen — the employer will follow up within 2-3 business days.` |
| 6 | inbound | Level 1 reveal: `Congrats — you've passed... Employer: <Company>. Salary range: <range>. Job details: <URL>. The employer will follow up within ... business days...` |
| 7 | inbound | PII Q1: `Great — to share with the employer, can you confirm your legal full name?` |
| 8 | reply | `Adam Smith` |
| 9 | inbound | PII Q2: `What email should the employer use to reach you?` |
| 10 | reply | `you@example.com` |
| 11 | inbound | PII Q3: `And the best phone number for next-step coordination?` |
| 12 | reply | `+1 415 555 0123` |
| 13 | inbound | **NEW** Level 1 Q1: `Now a few quick fit-questions for future role matches. Years of relevant work experience?` |
| 14 | reply | `4 years` |
| 15 | inbound | **NEW** Level 1 Q2: `Work-authorization status? (US citizen, green card, H1B / OPT / CPT, sponsorship needed, other)` |
| 16 | reply | `H1B` |
| 17 | inbound | **NEW** Level 1 Q3: `Preferred work location(s)? (city / region or 'remote' / 'anywhere')` |
| 18 | reply | `SF, NYC` |
| 19 | inbound | **NEW** Level 1 Q4: `Minimum total compensation expectation? (e.g. '120k' or '$140-180k' or 'open')` |
| 20 | reply | `150k` |
| 21 | inbound | **NEW** Level 1 Q5: `Industries you're most interested in? (e.g. AI, fintech, healthtech, gaming — or 'open')` |
| 22 | reply | `AI, fintech` |
| 23 | inbound | **NEW** Level 1 Q6: `Preferred company stage? (seed / early-startup / scale-up / mid-market / enterprise / open)` |
| 24 | reply | `early-startup` |
| 25 | inbound | Completion: `got everything I need — running the match now ✓` |
| 26 | inbound | Job rec list: `Here are roles I think fit better:` + 1-5 matching role lines |

---

## STOP IF (when to halt + report)

- ❌ Step 1 missing — webhook didn't fire
- ❌ Step 3 NOT verbatim Q2 prompt → Claire intercepted; check logs for "[prescreen][onPaInbound] check FAILED"
- ❌ Claire-style commentary anywhere (`That's legit`, `not demo-only`, `wait—aretrying to sha`)
- ❌ Steps 5/6 out of order
- ❌ Steps 13-24 missing or out of order
- ❌ Step 26 fires BEFORE step 25
- ❌ Step 25 says "Thanks — you're all set" (means Level 1 chain not running)

---

## Pattern A — Direct new user (no prior ATS data)

**Test requirements:**
1. Fresh `pa-users` row (or pre-seeded but no `contactPII`, no `tags`)
2. Phone number registered as `pa-users` (Adam's iPhone qualifies)
3. Job marked `publicVisible: true`

**Test script:** `node scripts/v19-test-pattern-direct-user.mjs [jobId]`

**Live test sequence:**
1. Open `/j/<jobId>` in fresh private browser
2. Click "Open in iMessage →" → check that `To:` is one of pool numbers (`+13054507716` or `+14243201960`)
3. Send the pre-filled trigger
4. Follow expected sequence 1-26 above
5. After step 24, verify Firestore:
   - `pa-users/<uid>.contactPII` has legalName/email/phone/consentedAt
   - `pa-users/<uid>.tags` has yoeRange/visaStatus/targetLocations/minSalaryUsd/industrySector/companySize/level1CollectedAt
6. Step 26 job recs should reflect Level 1 preferences (different from baseline)

**Verification queries (after test):**
```bash
node -e 'fetch(`https://firestore.googleapis.com/v1/projects/wekruit-5f89b/databases/(default)/documents/pa-users/<UID>`)
  .then(r=>r.json()).then(d=>{
    console.log("contactPII:", JSON.stringify(d.fields.contactPII?.mapValue?.fields))
    console.log("tags:", JSON.stringify(d.fields.tags?.mapValue?.fields))
  })'
```

---

## Pattern B — ATS-sourced user (resume + email already known)

**Test requirements:**
1. `pa-jobs-external-mapping/{source}_{externalJobId}` row exists pointing to internal jobId
2. ATS adapter receives webhook → finds/creates `pa-users` by email
3. Resume bound via `cv-ingest` HTTP endpoint
4. Outbound invite SMS sent

**Test script:** `node scripts/v19-test-pattern-ats-user.mjs [jobId]`

**Simulated payload (what Handshake POSTs to `paAtsInboundWebhook`):**
```json
{
  "event": "application.submitted",
  "data": {
    "applicant_id": "hs_app_<timestamp>",
    "job_id": "hs_ext_11005382",
    "candidate": {
      "first_name": "Jordan",
      "last_name": "Test-Applicant",
      "email": "jordan-test@example.com",
      "phone": "+14155557777"
    },
    "resume_url": "https://handshake.app/r/<id>.pdf"
  },
  "ts": "2026-05-13T..."
}
```

**Pre-seeded user tags (mock what cv-ingest would write from resume parse):**
```json
{
  "yoeRange": { "lowYears": 2, "highYears": 4 },
  "careerStage": "junior_to_mid",
  "visaStatus": "sponsor_needed",
  "targetLocations": ["san_francisco_bay_area"],
  "targetRoleFunction": ["product_design"],
  "skills": ["figma", "user_research", "prototyping", "design_systems"]
}
```

**Live test sequence:**
1. POST the JSON above to `https://us-central1-wekruit-5f89b.cloudfunctions.net/paAtsInboundWebhook` with header `X-Wekruit-Ats-Source: handshake` + `X-Wekruit-Signature: <hmac-sha256(body, ATS_HANDSHAKE_HMAC_SECRET) in hex>`
2. Verify dashboard `/admin/ats-inbound` shows new row, `sendOk: true`
3. Outbound invite SMS arrives on candidate's phone: "Hi <name>, WeKruit here on behalf of <Company> for <Job Title>. Reply START to begin your 5-min screen..."
4. Candidate replies → goes through prescreen pipeline (same as Pattern A from step 1 onwards, but skip-if-present should trigger on PII Q1 if contactPII already set)
5. Verify final `pa-users/<uid>.tags` merges Level 1 answers with prior resume tags (e.g. yoeRange might overwrite if differing)

**HMAC test curl (paste candidate email/phone):**
```bash
BODY='{"event":"application.submitted","data":{"applicant_id":"hs_app_test1","job_id":"hs_ext_11005382","candidate":{"first_name":"Jordan","last_name":"Test","email":"jordan@example.com","phone":"+14155557777"},"resume_url":"https://handshake.app/r/x.pdf"},"ts":"2026-05-13T01:00:00Z"}'
SECRET=$(firebase functions:secrets:access ATS_HANDSHAKE_HMAC_SECRET --project wekruit-5f89b)
SIG=$(echo -n "$BODY" | openssl dgst -sha256 -hmac "$SECRET" -hex | awk '{print $2}')
curl -X POST https://us-central1-wekruit-5f89b.cloudfunctions.net/paAtsInboundWebhook \
  -H "content-type: application/json" \
  -H "X-Wekruit-Ats-Source: handshake" \
  -H "X-Wekruit-Signature: $SIG" \
  -d "$BODY"
```

---

## Test exit criteria — milestone audit

For v1.9 candidate-journey to be GA-ready:

- [ ] All 4 jobs PASS simulator (`node scripts/v19-simulate-all-jobs.mjs` exits 0)
- [ ] Adam runs at least 1 live PASS path → reaches step 26 (job recs)
- [ ] Adam runs at least 1 live HARD_STOP path → still gets Level 1 collection + recs
- [ ] Pattern A live test complete with `pa-users.tags` populated
- [ ] Pattern B live test complete via curl + outbound invite SMS arrives
- [ ] No Claire-style commentary leak in any test
- [ ] `/admin/ats-inbound` shows the Pattern B row
- [ ] `/admin/prescreen-sessions` shows all sessions with correct terminal + score
- [ ] `pa-users.{uid}.tags.level1CollectedAt` stamped on all completed PII chains
