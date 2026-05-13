# v1.9 — Live SMS test (run on your phone)

**Pre-flight (all green as of 2026-05-13):**
- ✅ 5 public job pages return 200 unauth
- ✅ 4 Handshake jobs PASS prescreen simulator (real gpt-5.4-nano)
- ✅ Full flow simulator (prescreen + PII + Level 1) PASS for all 5 jobs
- ✅ Pool routing: Adam's userId always picks `+14243201960` (sticky verified 100/100)
- ✅ "START" / "hi" / "yes" / "ok" / emoji all trigger ATS virtualize → `_Job`
- ✅ ATS webhook returns 401 to unauth (HMAC working)
- ✅ Pool live: `+13054507716` + `+14243201960` both active

**Adam-action remaining (not test blockers, but blocks Pattern B with real ATS):**
- G3: `firebase functions:secrets:set ATS_HANDSHAKE_HMAC_SECRET --project wekruit-5f89b` (rotate placeholder)
- G6: set `PA_CV_INGEST_URL` env on `paAtsInboundWebhook` if you want resume bind

---

## TEST 1 — Pattern A: Direct user, PASS path

**One-line prompt (sender = your iPhone, must be in pa-users):**
```
WeKruit_test-swe-screen-001_e5d97cd8-1e1d-439d-8672-3008f8aeef2e_Job
```

### Expected sequence (26 messages)

| # | Dir | What you should see |
|---|---|---|
| 1 | ➜ | Send the trigger above |
| 2 | ◄ | "Hi — Claire from WeKruit Test Inc. Quick screen for Senior Frontend Engineer (Test Job). Describe your React production experience — what have you shipped, at what scale, and what was your role?" — **from `+14243201960`** |
| 3 | ➜ | "I shipped 3 React production apps at FAANG over 4 years owned design + deploy + post-launch monitoring" |
| 4 | ◄ | **Verbatim Q2:** "What production systems have you owned end-to-end? (deploy, on-call, observability)" |
| 5 | ➜ | "Yes — owned production deploy pipelines, on-call rotation, blameless post-mortems for our checkout service handling 30k req/min" |
| 6 | ◄ | PASS terminal: "Thanks for your answers! You've passed the initial screen — the employer will follow up within 2-3 business days." |
| 7 | ◄ | Level 1 reveal: "Congrats — you've passed the initial screen for Senior Frontend Engineer (Test Job). Employer: WeKruit Test Inc. Salary range: $140k-$180k. Job details: https://wekruit.com/j/test-swe-screen-001. The employer will follow up within 2-3 business days — please watch for an SMS." |
| 8 | ◄ | PII Q1: "Great — to share with the employer, can you confirm your legal full name?" |
| 9 | ➜ | "Adam Smith" |
| 10 | ◄ | PII Q2: "What email should the employer use to reach you?" |
| 11 | ➜ | "you@example.com" |
| 12 | ◄ | PII Q3: "And the best phone number for next-step coordination?" |
| 13 | ➜ | "+1 415 555 0123" |
| 14 | ◄ | L1 Q1: "Now a few quick fit-questions for future role matches. Years of relevant work experience?" |
| 15 | ➜ | "4 years" |
| 16 | ◄ | L1 Q2: "Work-authorization status? (US citizen, green card, H1B / OPT / CPT, sponsorship needed, other)" |
| 17 | ➜ | "H1B" |
| 18 | ◄ | L1 Q3: "Preferred work location(s)? (city / region or 'remote' / 'anywhere')" |
| 19 | ➜ | "SF, NYC" |
| 20 | ◄ | L1 Q4: "Minimum total compensation expectation? (e.g. '120k' or '$140-180k' or 'open')" |
| 21 | ➜ | "150k" |
| 22 | ◄ | L1 Q5: "Industries you're most interested in? (e.g. AI, fintech, healthtech, gaming — or 'open')" |
| 23 | ➜ | "AI, fintech" |
| 24 | ◄ | L1 Q6: "Preferred company stage? (seed / early-startup / scale-up / mid-market / enterprise / open)" |
| 25 | ➜ | "early-startup" |
| 26 | ◄ | Completion: "got everything I need — running the match now ✓" — then job rec list "Here are roles I think fit better:" + 1-5 roles |

### STOP IF
- ❌ Any inbound from us comes from `+18667700087` or any non-pool number
- ❌ Inbound from us flips between `+14243201960` and `+13054507716` mid-thread
- ❌ Step 4 NOT verbatim Q2 prompt → Claire intercepted, log dump
- ❌ Claire-style commentary appears anywhere (e.g. "That's legit", "not demo-only", "wait—aretrying")
- ❌ Steps 6 and 7 in wrong order
- ❌ Step 26 fires BEFORE step 25 reply
- ❌ Any Q out of order (PII 1-3 must come before L1 1-6)

### Post-test verify (paste this in terminal)
```bash
UID=e5d97cd8-1e1d-439d-8672-3008f8aeef2e
curl -s "https://firestore.googleapis.com/v1/projects/wekruit-5f89b/databases/(default)/documents/pa-users/$UID" \
  | python3 -c "import json,sys; d=json.load(sys.stdin); print('contactPII:', json.dumps(d['fields'].get('contactPII',{}).get('mapValue',{}).get('fields',{}), indent=2)); print('tags keys:', sorted(d['fields'].get('tags',{}).get('mapValue',{}).get('fields',{}).keys()))"
```

Expected output:
```
contactPII: {legalName, email, phone, consentedAt, source, sourceSessionId}
tags keys: [companySize, industrySector, level1CollectedAt, level1Source, minSalary, targetLocations, visaStatus, yoeRange, ...]
```

---

## TEST 2 — Pattern A: HARD_STOP path (weak answer)

**Trigger SMS:**
```
WeKruit_test-swe-screen-001_e5d97cd8-1e1d-439d-8672-3008f8aeef2e_Job
```
(First delete prior session: see footer)

### Diverging from TEST 1 at step 3
| # | Dir | What |
|---|---|---|
| 3 | ➜ | "I don't really know React, mostly Vue" |
| 4 | ◄ | HARD_STOP terminal: "Thanks for the reply. One required area didn't align for this role — let's look at other options." |
| 5 | ◄ | Preamble: "Let me look for better-aligned roles for you — one moment." |
| 6 | ◄ | L1 source=fail Q1: **"Before you go — to keep you in the loop for better-aligned roles, what's your legal full name?"** |
| 7-22 | … | Same Q sequence as TEST 1 steps 9-25 but with fail-source framing on subsequent Qs |
| 23 | ◄ | Completion + job rec list |

### STOP IF
- ❌ Step 6 still says "Great — to share with the employer..." (PASS framing) instead of "Before you go..." (FAIL framing)
- ❌ No preamble at step 5
- ❌ No job recs at step 23

---

## TEST 3 — Pattern A: Real Handshake job

**Trigger:**
```
WeKruit_hs-11005382-invoko-product-designer_e5d97cd8-1e1d-439d-8672-3008f8aeef2e_Job
```

### Expected divergence from TEST 1
- Step 2 inbound: "Hi — Claire from invoko.ai. Quick screen for Product Designer. Tell me about your product design work — what consumer-facing product have you shipped, and what role did you play?"
- Step 4 verbatim Q2: "How do you prototype your ideas? Comfortable with Figma + something like Framer / v0 / Cursor for interactive prototypes?"
- Step 7 Level 1 reveal: "Employer: invoko.ai. Salary range: $80-120K/yr. Job details: https://app.joinhandshake.com/public/jobs/11005382..."
- Rest of sequence identical to TEST 1

### Sample strong answers
- Q1: "Led design at a Series A consumer fintech for 2 years — shipped onboarding redesign that lifted activation 22%"
- Q2: "Fluent in Figma + Framer + v0/Cursor; recently shipped 4 prototypes in a sprint"

### Other 3 jobs to test (same flow, different prompts)

| Job | Trigger | Strong Q1 reply | Strong Q2 reply |
|---|---|---|---|
| **UI/UX Designer @ invoko** | `WeKruit_hs-11005377-invoko-ui-ux-designer_<uid>_Job` | "Shipped onboarding + dashboard for a consumer health app, 50k+ MAU" | "Ship rough Figma within 2 days then weekly user feedback loops" |
| **GTM @ paradigm** | `WeKruit_hs-11005308-paradigm-gtm-growth_<uid>_Job` | "Owned organic TikTok for a learning startup — 0 to 80k followers in 6 months, drove 12k signups" | "Started a podcast from zero as a senior — designed format, scaled to 200 listens/episode" |
| **PM @ invoko** | `WeKruit_hs-10996795-invoko-product-manager_<uid>_Job` | "First PM hire at a consumer travel app — shipped booking flow rewrite, drove 18% conversion lift" | "Prioritize by user-signal × strategic alignment / effort. Cut 2 features to ship a friction-reducer that moved retention 9pts" |

---

## TEST 4 — Pattern B: ATS inbound + virtualized START reply

**Pre-req:** Adam must rotate `ATS_HANDSHAKE_HMAC_SECRET` from placeholder first (G3).

**Steps:**

### 4a. POST simulated Handshake webhook
```bash
SECRET=$(firebase functions:secrets:access ATS_HANDSHAKE_HMAC_SECRET --project wekruit-5f89b)
BODY='{"event":"application.submitted","data":{"applicant_id":"hs_test_'$(date +%s)'","job_id":"hs_ext_11005382","candidate":{"first_name":"Jordan","last_name":"Test","email":"jordan-pattern-b-'$(date +%s)'@example.com","phone":"<YOUR_PHONE_E164>"},"resume_url":"https://handshake.app/r/x.pdf"},"ts":"'$(date -u +%Y-%m-%dT%H:%M:%SZ)'"}'
SIG=$(echo -n "$BODY" | openssl dgst -sha256 -hmac "$SECRET" -hex | awk '{print $2}')

# Seed external→internal mapping (one-time per ATS job_id):
# Manually: pa-jobs-external-mapping/handshake_hs_ext_11005382 → {jobIdInternal:"hs-11005382-invoko-product-designer"}

curl -X POST https://us-central1-wekruit-5f89b.cloudfunctions.net/paAtsInboundWebhook \
  -H "content-type: application/json" \
  -H "X-Wekruit-Ats-Source: handshake" \
  -H "X-Wekruit-Signature: $SIG" \
  -d "$BODY"
```

**Expected response:** `200 {"ok":true,"action":"invited","userId":"<some-uuid>","jobIdInternal":"hs-11005382-invoko-product-designer"}`

### 4b. iMessage arrives on your phone

| # | Content |
|---|---|
| 1 | "Hi Jordan, WeKruit here on behalf of invoko.ai for Product Designer. Reply START to begin your 5-min screen, or send 'stop' to opt out." |

### 4c. Reply with ANYTHING that isn't a literal trigger pattern

Try one of: `START`, `hi`, `ok`, `yes`, `lets go`, 🚀

**Expected:** within ~10sec, Q1 of the Product Designer prescreen arrives. NOT a Claire-style "Hi! How can I help?" — must be the configured Q1 prompt.

### 4d. Continue through prescreen + PII + Level 1 (same sequence as TEST 1)

### STOP IF
- ❌ 4a returns 401 → ATS_HANDSHAKE_HMAC_SECRET still placeholder (G3 unblocked)
- ❌ 4a returns 404 → `pa-jobs-external-mapping/handshake_hs_ext_11005382` not seeded
- ❌ 4b SMS comes from non-pool number
- ❌ 4c response is Claire ("Hi how can I help?") not the prescreen Q1

---

## Reset between tests

Run this to clear all session state for Adam's userId (lets you re-trigger same scenario fresh):
```bash
UID=e5d97cd8-1e1d-439d-8672-3008f8aeef2e
TOKEN=$(node -e 'const fs=require("node:fs"); const c=JSON.parse(fs.readFileSync(process.env.HOME+"/.config/configstore/firebase-tools.json","utf8")); fetch("https://oauth2.googleapis.com/token",{method:"POST",headers:{"content-type":"application/x-www-form-urlencoded"},body:new URLSearchParams({client_id:"563584335869-fgrhgmd47bqnekij5i8b5pr03ho849e6.apps.googleusercontent.com",client_secret:"j9iVZfS8kkCEFUPaAeJV0sAi",refresh_token:c.tokens.refresh_token,grant_type:"refresh_token"})}).then(r=>r.json()).then(t=>console.log(t.access_token))')
for P in \
  pa-prescreen-sessions/ps_test-swe-screen-001_${UID}_$(date +%Y%m%d) \
  pa-prescreen-trigger-idempotency/test-swe-screen-001_${UID} \
  pa-pii-confirm-state/${UID} \
  pa-pii-confirm-meta/${UID} \
; do
  curl -s -X DELETE "https://firestore.googleapis.com/v1/projects/wekruit-5f89b/databases/(default)/documents/$P" -H "authorization: Bearer $TOKEN" -o /dev/null
  echo "deleted $P"
done
```

---

## Report-back form (paste into reply after each test)

```
TEST 1 / 2 / 3 / 4: PASS / FAIL
  Step where it diverged from expected: ___
  Inbound number(s) seen: ___
  Claire-style commentary observed: y/n  text: ___
  Order broken at step: ___
  Post-test contactPII set: y/n
  Post-test tags keys present: ___
```
