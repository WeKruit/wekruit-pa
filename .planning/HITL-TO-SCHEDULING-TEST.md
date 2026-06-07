# HITL-commit → Scheduling Linkage — Guided Live Test

**Goal:** prove on Adam's real dev phone (+14243201960, uid `8fEwIduUrzxZsblHHsNz`) that
**committing a PASS in the dashboard makes that exact job schedulable in thin Claire** —
the committed job (not the dev-mimic) shows up when Claire offers interview slots, and a
booking lands in Cal.com + `pa-interview-bookings`.

This is the live counterpart to the automated proof. The harness already proved the
software seam end-to-end against real Firestore (see "What the harness proved" below);
this doc covers the human-driven dashboard → phone → Cal.com round trip.

---

## 0. Prerequisites (verify before starting)

- **Thin Claire enabled** for Adam's uid — it is, globally (`paThinClaireEnabled=true`).
- **`CALCOM_API_KEY` Firebase secret is set** on the functions project. Without it the
  scheduling tools fail-OPEN (Claire says "a teammate will lock in a time") and **no real
  slots appear** — the test cannot pass. Verify:
  ```bash
  firebase functions:secrets:access CALCOM_API_KEY --project wekruit-5f89b
  ```
  If unset, set it and redeploy `onPaInbound` before testing.
- **Scheduling is dev-gated** to `SCHEDULING_DEV_UIDS = { 8fEwIduUrzxZsblHHsNz (Adam),
  UKFaKdsMzzfPW2CDl5ve (Noah) }`. Only these uids get real slots. A non-dev uid hits
  `scheduling_not_enabled` and Claire defers to a human — so **this test must run from
  Adam's or Noah's phone**, never a random candidate. (Flagged caveat — see §6.)
- Functions deployed with the current `evaluation-attempts.ts` + `scheduling-tools.ts`.

---

## 1. Stage a PASS pending HITL review

Pick ONE of these.

### Option A — fresh REAL prescreen (most faithful, end-to-end)

1. On Adam's dev phone, start a collab prescreen for a job whose `pa-jobs` doc has a
   live `prescreenConfig`. Either:
   - text the copy-paste trigger `WeKruit_<jobId>_<userId>_Job` to the Sendblue number, or
   - reply "interested" to a collab rec card so Claire offers + begins the screen.
2. Answer the screen well enough to reach a terminal **PASS**. Claire then sends the
   "we're reviewing your screen" pending-ack and the session goes
   `terminalActionPendingReview=true`.
3. This writes:
   - `pa-prescreen-sessions/<sessionId>` with `terminal=PASS`,
     `terminalActionPendingReview=true`, `review.status="pending"`, `evaluationAttemptId`.
   - `pa-evaluation-attempts/<attemptId>` (`source=prescreen`,
     `purpose=employment_prescreen`, `proposedOutcome.kind=pass`).
   - `pa-candidate-job-states/<uid>__<jobId>` at `prescreen_review_pending`.
   - **Note the real `<jobId>`** — that is the job you will expect to become schedulable.

### Option B — synthetic seed via the harness (fast, deterministic)

Stages the exact same shapes for a clearly-marked TEST job
`dev-hitl-sched-test-software_engineering`, **without** sending a real screen SMS:

```bash
source ~/.zshrc && nvm use 24
export GOOGLE_APPLICATION_CREDENTIALS=$(mktemp) && \
  grep -E "^FIREBASE_SERVICE_ACCOUNT_JSON=" .env \
    | sed 's/^FIREBASE_SERVICE_ACCOUNT_JSON=//' > "$GOOGLE_APPLICATION_CREDENTIALS"
cd apps/functions
node --import tsx scripts/hitl-to-scheduling-harness.ts
```

The harness **also commits** the PASS itself (with the SMS stubbed) and asserts the whole
linkage, then leaves the seeded docs in place. So after Option B you can skip §2 and go
straight to §3 (the job is already employer-visible). To test the **dashboard commit**
specifically, run the harness with `--cleanup` first, then re-seed with Option A.

> Staged session id (Option B): `dev-hitl-sched-8fEwIduUrzxZsblHHsNz-dev-hitl-sched-test-software_engineering`
> Staged job id (Option B): `dev-hitl-sched-test-software_engineering`

---

## 2. Commit the PASS in the dashboard (the HITL action)

1. Open the admin dashboard → **`/admin/prescreen-sessions`**
   (https://wekruit-pa.web.app/admin/prescreen-sessions — `@wekruit.com` sign-in).
2. The row for your session shows **status "Pending HITL"** (Claire terminal `PASS`,
   "Committed final" empty). Filter/sort to "Pending HITL" if needed.
3. Click the row to open the **review drawer**.
4. Set the final terminal to **PASS** (it defaults to Claire's proposed terminal).
   Fill the candidate message + decision reason + recommended actions — or click
   **"Draft with LLM"** / **"Use evidence draft"** to populate them.
5. Click **"Approve and queue iMessage"**.
   - This calls the `paReviewEvaluationAttempt` callable with
     `status="approved"`, `finalOutcome.prescreenTerminal="PASS"`, and your message.
   - Server-side `commitPrescreenOutcome` then:
     - flips `pa-prescreen-sessions.<sessionId>.terminalActionPendingReview` → **false**,
       sets `review.status="approved"`,
     - writes **`pa-employer-visible-profiles/<jobId>__<uid>`** (this is the doc that
       makes the job schedulable),
     - transitions `pa-candidate-job-states.<uid>__<jobId>` → **`employer_visible`**,
     - sends the decision SMS to the candidate. **(This is a real Sendblue send to
       Adam's phone — expected.)**
6. Confirm the dashboard row now reads **"Committed PASS"**.

---

## 3. Trigger scheduling from the phone

On Adam's dev phone (+14243201960), text the dev sentinel:

```
__PA_SCHEDULE__
```

(`cutover.ts` rewrites this to "I'd like to schedule the interview now — what times do you
have open?" so Claire calls `offer_interview_slots` on a normal turn.)

**Expected reply:** a short, numbered list of **real Cal.com open times** in Adam's
timezone for the **committed job** — e.g.

```
Here are a few open times:
1) Mon Jun 2, 9:00 AM EDT
2) Tue Jun 3, 1:30 PM EDT
3) Wed Jun 4, 11:00 AM EDT
Which works?
```

**The linkage check:**
- These slots are for the job you committed in §2 — its event-type, routed from that
  job's `roleFunction`.
- It is **NOT** the dev-mimic. The dev-mimic (`Software Engineer @ MetaVoice` /
  `Product Designer @ Helium`) only appears when the candidate has **zero**
  dashboard-committed passes. Once §2 wrote the employer-visible profile, the real
  committed job wins and the mimic is suppressed.
- If you have **more than one** committed pass, Claire asks which role first
  (`needs_job_choice`). Reply with the role name and it re-offers for that job.

> If Claire instead says a teammate will lock in a time, or gives no slots: scheduling
> is gated/unset — re-check `CALCOM_API_KEY` and that you texted from Adam's/Noah's phone
> (§0, §6).

---

## 4. Book a slot

Reply with the slot you want, in your own words, e.g.:

```
the 9am monday one
```

or `1` / `book #2`. If Claire asks for an email, send it once and it re-books.

**Expected reply:** a lock-in confirmation, e.g. "You're locked in for Mon Jun 2,
9:00 AM EDT — I just emailed you the details" plus a Google-Meet/Cal join link if Cal
returned one.

---

## 5. Confirm the booking landed

1. **Firestore** — `pa-interview-bookings/calbk-8fewiduurzxzsblhhsnz__<slugified-jobId>`
   should exist with:
   - `status` = `booked` then `confirmed` (after the WeKruit email sends),
   - `selectedSlotIso` = the chosen slot,
   - `calBookingId` / `calBookingUid` populated (the real Cal.com booking),
   - `candidateEmail`, `meetingUrl` (if Cal returned a join link),
   - `confirmationEmailMessageId` (Mailgun id) once the email sent.

   Quick check:
   ```bash
   source ~/.zshrc && nvm use 24
   export GOOGLE_APPLICATION_CREDENTIALS=$(mktemp) && \
     grep -E "^FIREBASE_SERVICE_ACCOUNT_JSON=" .env \
       | sed 's/^FIREBASE_SERVICE_ACCOUNT_JSON=//' > "$GOOGLE_APPLICATION_CREDENTIALS"
   cd apps/functions
   node --import tsx -e '
     import { initializeApp, applicationDefault, getApps } from "firebase-admin/app"
     import { getFirestore } from "firebase-admin/firestore"
     import { interviewBookingDocId } from "@pa/core-types"
     if(!getApps().length) initializeApp({credential: applicationDefault(), projectId:"wekruit-5f89b"})
     const db=getFirestore()
     const JOB="<jobId>"  // the committed job from step 1
     const id=interviewBookingDocId({userId:"8fEwIduUrzxZsblHHsNz", jobId:JOB})
     const s=await db.collection("pa-interview-bookings").doc(id).get()
     console.log(id, s.exists? s.data() : "MISSING"); process.exit(0)'
   ```
2. **Cal.com** — the interviewer's calendar for that event-type shows the new booking at
   the chosen time.
3. **Email** — the WeKruit confirmation email arrives at the candidate email used.

---

## 6. Caveats / known gates (flag before running)

- **Non-dev candidates hit `scheduling_not_enabled`.** `offer_interview_slots` /
  `book_interview_slot` are gated to `SCHEDULING_DEV_UIDS`. A real (non-Adam/Noah)
  candidate who PASSes will become `employer_visible` and appear in `listSchedulableJobs`,
  but the scheduling **tools** still refuse and Claire defers to a human. So the
  commit→scheduling linkage is dev-only until that gate is widened. **This does not block
  the test** (run from Adam's phone) but it is the gap that stops a general candidate from
  self-scheduling today.
- **`CALCOM_API_KEY` must be set** or there are no real slots (§0).
- **Real SMS:** the §2 "Approve and queue iMessage" step and the §3–4 replies are real
  Sendblue sends to Adam's phone. Expected, but it is a live channel.
- **Cleanup (Option B only):** remove the synthetic seed when done so prod isn't polluted:
  ```bash
  cd apps/functions
  node --import tsx scripts/hitl-to-scheduling-harness.ts --cleanup
  ```
  (Option A used a real session — leave it, or archive via the normal flow.)

---

## What the automated harness already proved (no phone needed)

`apps/functions/scripts/hitl-to-scheduling-harness.ts` drove the **real** production seam
against **real Firestore**, scoped to Adam's uid + `dev-hitl-sched-test-software_engineering`,
SMS stubbed. Result: **ALL GREEN**.

- BEFORE commit: `listSchedulableJobs(Adam)` → `["dev-metavoice-swe","dev-helium-design"]`
  (dev-mimic); test job NOT present.
- Commit via the real `runReviewEvaluationAttempt` (`status="approved"`,
  `finalOutcome.prescreenTerminal="PASS"`): `prescreenOutcomeCommitted=true`,
  `terminalActionPendingReview` → false, `review.status="approved"`,
  `pa-employer-visible-profiles/dev-hitl-sched-test-software_engineering__8fEwIduUrzxZsblHHsNz`
  **exists**, candidate-job state → `employer_visible`.
- AFTER commit: `listSchedulableJobs(Adam)` →
  `[{ jobId:"dev-hitl-sched-test-software_engineering", label:"Software Engineer (HITL harness) @ WeKruit Test" }]`
  — the committed job **is** schedulable, dev-mimic **suppressed**.

Deterministic unit proof (no network):
`apps/functions/scripts/__tests__/hitl-to-scheduling-harness.test.ts` — 3/3 GREEN, same
linkage against an in-memory Firestore.

What the automated harness does NOT cover (this is what §3–5 add): the live `__PA_SCHEDULE__`
turn through the deployed agent, the real Cal.com slot fetch + booking, and the WeKruit
confirmation email — i.e. everything downstream of `listSchedulableJobs` that needs
`CALCOM_API_KEY` + a deployed function + a real phone.
