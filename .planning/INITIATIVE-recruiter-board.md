# Initiative — WeKruit Recruiter Platform

**Status:** v1 platform execution (updated 2026-05-31)
**Owner:** WeKruit product/engineering
**Companion repo:** [WeKruit/hiring-board](https://github.com/WeKruit/hiring-board) — current static MVP (will be redirected after migration)

## Goal

Give partner recruiters a code-gated workspace for open WeKruit collab jobs, consented candidate submission, status tracking, and recruiter-visible feedback. Firestore is the source of truth; Google Sheet sync remains a secondary review/export path.

> "These data needs to be linked with our pa-jobs (WeKruit collab companies). We give it a place for people to submit qualified candidates as a form so it's easy to attach their name + email. Sync the data to Google Sheet, each tab is a new job. Each column is one checklist item. Track who submitted." — Adam, 2026-05-25

## v1 platform plan — recruiter workspace (2026-05-31)

The flat board is not enough. Recruiters need a small platform loop:

1. **Invite-gated account creation** — WeKruit issues a recruiter code from `/admin/recruiter-submissions`. The recruiter signs up with Firebase Auth email/password plus name + code; the function binds `pa-recruiter-users/{firebaseUid}` to that email. Submissions from the recruiter UI require the current Firebase ID token.
2. **Role marketplace** — `/recruiters` shows open opportunities from `pa-jobs` where `wekruitCollaborationStatus == "collaborated"` and `recruiterBoard.active == true`. No duplicate job store.
3. **Role detail + submission** — `/recruiters/job/:jobId` remains the single role page, but now requires recruiter access before POSTing. Submissions are written with `recruiterId`, score, `status: "submitted"`, and source `hiring-board`.
4. **Recruiter status tracker** — `/recruiters?tab=submissions` lists only that recruiter's submissions through authenticated `paRecruiterSubmissionsList`. It shows role, candidate, checklist score, WeKruit status, and visible feedback.
5. **WeKruit admin feedback loop** — `/admin/recruiter-submissions` can update status and write `recruiterFeedbackNote`; the recruiter sees it on refresh.
6. **New-role notifications** — when a `pa-jobs/{jobId}` doc becomes `wekruitCollaborationStatus="collaborated"` with `recruiterBoard.active=true`, `paRecruiterRoleReleasedNotify` creates idempotent notification docs and emails active recruiters who have new-role email notifications enabled.

Research used for the UX model: Paraform's recruiter onboarding/role approval/submission docs emphasize browsing roles, role-specific approval, candidate consent, a private candidate/submission pipeline, and feedback/status after review. WeKruit should copy the loop, not the whole ATS: code-gated recruiter access, pa-jobs role marketplace, candidate submission, status tracking, and feedback calibration.

Out of scope for this pass: recruiter payments, Chrome extension/LinkedIn CRM, ATS sync, role-slot enforcement, broad candidate CRM, and employer-side candidate browsing.

## Non-goals (v1)

- No public candidate-facing surface (this is recruiter-only — candidates still flow through `candidate.wekruit.com`).
- No payment/payout automation. The $10K+ placement fee is shown as marketing only; payouts are handled offline.
- No scraping / job ingestion changes. Existing `pa-jobs` pipeline untouched.
- No employer-facing dashboard for submissions (admin-only review in `dashboard-web`).

## Product surfaces

| Surface | Owner repo | URL | Purpose |
|---|---|---|---|
| Recruiter workspace | `apps/pa-landing` | `https://candidate.wekruit.com/recruiters` | Invite gate, overview, role marketplace, submissions tracker, feedback, settings |
| Per-role page | `apps/pa-landing` | `https://candidate.wekruit.com/recruiters/job/:jobId` | Single role, deep-linkable submission flow |
| Recruiter APIs | `apps/recruiter-board-fn` | `paRecruiterInviteCodeCreate`, `paRecruiterAccess`, `paRecruiterMe`, `paRecruiterPreferencesUpdate`, `paRecruiterSubmissionsList`, `paRecruiterSubmission`, `paRecruiterRoleReleasedNotify` | Create codes, register/code-gate recruiter, read profile, update notification prefs, list submissions, accept consented candidates, notify on role release |
| Public job list API | `apps/recruiter-board-fn` | `paCollabJobsList` (HTTP CF, GET) | Returns active collab jobs from `pa-jobs` as JSON, cached 60s for anonymous callers |
| Admin review | `apps/dashboard-web` | `https://wekruit-pa.web.app/admin/recruiter-submissions` | All submissions, filter by job/status, drill-down, update recruiter-visible status/feedback |
| Old GH Pages | `WeKruit/hiring-board` | `https://wekruit.github.io/hiring-board/` | 301-equivalent redirect → new URL |

## Data model

### `pa-jobs` collection — extend in place (existing collection)

`pa-jobs` already has `wekruitCollaborationStatus: "collaborated" | "not_collaborated"` (locked v1.6 schema). That's our flag — no new job collection. Collab job docs expose a `recruiterBoard` sub-object holding the recruiter-board payload.

```ts
// Existing pa-jobs fields stay as is:
//   jobId, title, companyId, companyName, location, descriptionMd, atsApplyUrl,
//   publicVisible, wekruitCollaborationStatus, candidatePageStatus, etc.

// Optional sub-object, only present on collab board jobs
type RecruiterBoardPayload = {
  active: boolean;               // toggle visible on board without changing wekruitCollaborationStatus
  sortOrder: number;             // landing page order

  // Anonymized label set surfaced to recruiters
  label: {
    company: string;             // "Co. A · Stealth voice-AI lab"
    companyCode: "A" | "B" | "C" | "D";
    location: string;            // "San Francisco · In-person"
    pills: { text: string; tone?: "warm" | "cool" | "neutral" }[];
  };

  // JD body for the board (richer than descriptionMd)
  comp?: string;
  jdBlocks: Array<{
    heading: string;
    body: string;                // Markdown
    kind?: "list" | "prose";
  }>;
  interviewProcess?: string;

  // Culture card
  culture: {
    bet: string;
    bullets: string[];
  };

  // Checklist drives form + Sheet columns
  checklist: {
    groups: Array<{
      kind: "hard" | "fit" | "bonus" | "anti";
      heading: string;
      items: Array<{
        id: string;              // stable, used as Sheet column key
        text: string;
      }>;
    }>;
  };

  // Bookkeeping
  updatedAt: Timestamp;
  updatedBy: string;             // admin email
};

// On pa-jobs/{jobId}:
//   wekruitCollaborationStatus: "collaborated"
//   recruiterBoard: RecruiterBoardPayload
```

**Query for the board:**
```ts
db.collection("pa-jobs")
  .where("wekruitCollaborationStatus", "==", "collaborated")
  .where("recruiterBoard.active", "==", true)
  .get()
```

Real company names stay only on admin-visible job/company fields. The public CF strips direct company identity and surfaces only `recruiterBoard.label.*`.

### `pa-recruiter-users` Firestore collection (new)

Created only by Cloud Functions after Firebase Auth signup and access-code validation.

```ts
type RecruiterUserDoc = {
  recruiterId: string;           // Firebase Auth uid
  firebaseUid: string;
  name: string;
  email: string;                 // normalized Firebase Auth email
  status: "active" | "disabled";
  inviteCodeId: string;
  notificationPreferences: { newRolesEmail: boolean };
  registeredAt: Timestamp;
  lastSeenAt: Timestamp;
  updatedAt: Timestamp;
};
```

### `pa-recruiter-submissions` Firestore collection (new)

```ts
type RecruiterSubmissionDoc = {
  submissionId: string;
  jobId: string;                 // foreign key → pa-jobs/{jobId}
  inboundJobId: string;          // publicId or doc id received from the recruiter UI
  jobTitleSnapshot: string;      // denormalized for admin list view
  companyLabelSnapshot: string;
  recruiterId: string | null;    // Firebase Auth uid for recruiter submissions
  recruiterEmail: string;

  submitter: {
    name: string;
    email: string;               // lowercased, validated
  };

  candidate: {
    name: string;
    link: string;                // LinkedIn or resume URL (string-validated, not parsed)
    currentRole?: string;
    yoe?: string;
    notes?: string;
  };
  candidateConsent: true;

  checklist: {
    [itemId: string]: boolean;   // keyed by checklist.items[].id
  };

  // Computed at write time, denormalized for Sheet + admin
  score: {
    hardChecked: number;
    hardTotal: number;
    fitChecked: number;
    fitTotal: number;
    bonusChecked: number;
    bonusTotal: number;
    antiChecked: number;         // anti-signals = red flags; lower is better
    antiTotal: number;
  };

  // Provenance
  callerSource: "hiring-board" | "api" | "unknown";
  source: {
    userAgent: string;
    referrer?: string;
    ipHash?: string;
  };

  // Sheet sync
  sheetSyncedAt?: Timestamp;
  sheetRowId?: string;
  sheetSyncError?: string;

  status: "submitted" | "reviewing" | "advanced" | "interviewing" | "hired" | "rejected" | "duplicate";
  recruiterFeedbackNote?: string | null;
  recruiterFeedbackUpdatedAt?: Timestamp;
  statusHistory: Array<{ status: string; by: "recruiter" | "admin"; atIso: string }>;

  createdAt: Timestamp;
  updatedAt: Timestamp;
};
```

### `pa-recruiter-invite-codes` Firestore collection

Invite code docs are created only by `paRecruiterInviteCodeCreate`. The doc id is the SHA-256 hash of the normalized visible code. The visible code is returned once to the admin and is not stored raw. Codes are always single-use: `maxUses` is fixed at `1`, the first successful signup stamps the Firebase uid/email that consumed it, and the default expiry is one year from creation.

```ts
type RecruiterInviteCodeDoc = {
  inviteCodeId: string;
  active: boolean;
  codePreview: string;           // masked, e.g. WK-AB••••9Z
  label?: string | null;
  maxUses: 1;
  usedCount: number;
  lastUsedByUid?: string;
  lastUsedByEmail?: string;
  expiresAt?: string | null;
  createdByEmail: string;
  createdAt: Timestamp;
  updatedAt: Timestamp;
};
```

### `pa-recruiter-notifications` Firestore collection

One doc per `(jobId, recruiterId, notification type)` so role-release emails are idempotent.

```ts
type RecruiterNotificationDoc = {
  notificationId: string;
  type: "new_role";
  status: "queued" | "sent" | "failed";
  recruiterId: string;
  recruiterEmail: string;
  jobId: string;
  publicJobId: string;
  roleTitle: string;
  companyLabel: string;
  location: string;
  roleUrl: string;
  provider?: "mailgun";
  messageId?: string | null;
  lastError?: string;
  sentAt?: Timestamp;
  createdAt: Timestamp;
  updatedAt: Timestamp;
};
```

## API endpoints

### `GET paCollabJobsList`

Public, CORS-enabled, 60s cache.

Returns: `{ ok, jobs, total, nextOffset }` for active `pa-jobs` collab roles, sorted by `recruiterBoard.sortOrder`. Anonymous callers receive public ids and anonymized labels; `@wekruit.com` admin bearer callers receive real doc ids/company labels.

### `POST paRecruiterAccess`

Requires `Authorization: Bearer <Firebase ID token>`. Validates a manually issued invite code from `pa-recruiter-invite-codes`, binds the Firebase uid/email into `pa-recruiter-users/{uid}`, and returns the recruiter profile. Invite-code use is checked and consumed transactionally; disabled recruiter users cannot self-reactivate.

### `GET paRecruiterMe`

Requires `Authorization: Bearer <Firebase ID token>`. Returns the bound `pa-recruiter-users/{uid}` profile for an active recruiter.

### `POST paRecruiterPreferencesUpdate`

Recruiter-authenticated endpoint to toggle `notificationPreferences.newRolesEmail`.

### `GET paRecruiterSubmissionsList`

Requires `Authorization: Bearer <Firebase ID token>`. Returns only submissions whose `recruiterId` equals the caller's Firebase uid, including candidate, role snapshot, score, current status, and recruiter-visible feedback note.

### `POST paRecruiterSubmission`

CORS-enabled. Recruiter UI submissions use source `hiring-board` and require a valid Firebase-bound recruiter account.

Body:
```ts
{
  jobId: string;
  submitter: { name: string; email: string };
  candidate: { name: string; link: string; currentRole?: string; yoe?: string; notes?: string };
  checklist: { [itemId: string]: boolean };
  candidateConsent: true;
  source: "hiring-board";
}
```

Validates recruiter access, candidate consent, job existence, collab status, and active `recruiterBoard`. Writes `pa-recruiter-submissions`, computes `score`, appends initial `statusHistory`, then async-appends to Google Sheet when configured. Sheet failure does not block the response; error is recorded on the doc for retry.

Returns: `{ ok: true, submissionId, score }` or `{ ok: false, reason }`.

## Google Sheets layout

**Master spreadsheet:** "WeKruit Recruiter Submissions" (Adam creates, shares with Firebase service account email — TBD by the functions-explore agent).

**Tab per jobId.** First submission for a job auto-creates the tab via Sheets API with a header row built from the job's checklist.

**Column structure (one tab):**

```
| Submitted at | Submitter name | Submitter email |
| Candidate name | Candidate link | Current role | YOE |
| Hard: <item-1-text> | Hard: <item-2-text> | ... | (one col per hard item)
| Fit: <item-1-text> | ... | (one col per fit item)
| Bonus: <item-1-text> | ... |
| Anti: <item-1-text> | ... |
| Hard score (X/Y) | Fit score | Bonus score | Anti count |
| Notes | Status | Submission ID |
```

Each checklist column holds `TRUE` / `FALSE` (or empty). Each tab is independently shaped by its job's checklist so columns line up cleanly.

## pa-landing route plan

- `/recruiters` — invite gate when unauthenticated; recruiter workspace when authenticated.
- `/recruiters?tab=roles` — role marketplace from `paCollabJobsList`.
- `/recruiters?tab=submissions` — private status tracker from `paRecruiterSubmissionsList`.
- `/recruiters?tab=feedback` — recruiter-visible feedback notes.
- `/recruiters/job/:jobId` — role page with JD, culture, checklist, candidate consent, and authenticated submission.

## Admin dashboard

- `/admin/recruiter-submissions` (auth-gated `@wekruit.com`)
- Sidebar entry under Jobs.
- Top: filter by jobId, status, score, and search submitter/candidate/job.
- Table columns: submitted at, job (label), submitter (name + email), candidate (name + link), hard score, fit score, status
- Row click → detail panel with full checklist breakdown, status select, recruiter-visible feedback note, and status-history append.

## Migration / cutover

1. Build everything below `/recruiters` on `candidate.wekruit.com`.
2. Once deployed + smoke-tested: update `WeKruit/hiring-board/index.html` to a redirect stub (`<meta http-equiv="refresh" content="0;url=https://candidate.wekruit.com/recruiters">` + JS fallback).
3. Push to main. GH Pages serves redirect.
4. Old per-role URLs `wekruit.github.io/hiring-board/#/role-N` map to nothing useful → redirect to `/recruiters` landing (no per-role mapping; recruiters re-pick from the new landing).

## Execution status

Completed in this pass:

1. Firebase Auth email/password recruiter signup + code-gated `pa-recruiter-users/{uid}` binding.
2. Admin invite-code creation in `/admin/recruiter-submissions`.
3. Recruiter workspace shell with overview, roles, submissions, feedback, and settings.
4. Recruiter settings toggle for new-role email notifications.
5. Automatic new-role notification trigger with idempotent docs and Mailgun delivery.
6. Firestore rules for recruiter platform admin visibility and feedback updates.
7. Authenticated role submission with candidate consent.
8. Recruiter-only status list endpoint.
9. Admin submission view feedback/status editor.
10. Planning doc aligned to the actual `recruiterBoard` and `apps/recruiter-board-fn` implementation.

Operational setup before production use:

1. Create the first recruiter invite code from `/admin/recruiter-submissions`.
2. Ensure Mailgun secrets are available to the `recruiter-board` codebase.
3. Deploy Firestore rules, `apps/recruiter-board-fn`, `apps/pa-landing`, and `apps/dashboard-web` from `main`.
4. Run one live smoke with a real invite code: create code → register recruiter → open role → submit consented test candidate → update status in admin → refresh recruiter tracker.
5. Run one role-release smoke: activate a test `recruiterBoard` role → confirm `pa-recruiter-notifications` doc → confirm recruiter email delivery.

## Reference

- WeKruit collab company list (internal, do not surface in code):
  - **Co. A — MetaVoice** (2 roles, already in pa-jobs): `metavoice-research-scientist-post-training`, `metavoice-software-engineer-data-evals`
  - **Co. B — VoiceCursor / Signal Ratio Inc.** (3 roles, need to create): Founding Engineer, Founding PM, Founding Growth
  - **Co. C — Photon** (2 roles, already in pa-jobs): `wekruit-973f2953-photon-objective-c-engineer`, `wekruit-37429d02-photon-macos-devops`
  - **Co. D — Helium** (1 role, need to create): Product Engineer (Full-Stack) — `https://tryhelium.com/`
  - **Co. E — invoko.ai** (3 roles, already in pa-jobs): `hs-10996795-invoko-product-manager`, `hs-11005377-invoko-ui-ux-designer`, `hs-11005382-invoko-product-designer`

Total: 11 roles across 5 companies. 7 pa-jobs already exist + 4 to create.
- Current static MVP: [WeKruit/hiring-board](https://github.com/WeKruit/hiring-board) — commit `bd4e249` is the last anonymized version.
