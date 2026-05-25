# Initiative — WeKruit Recruiter Job Board (v0)

**Status:** scoping → execution (started 2026-05-25)
**Owner:** Claude (with Adam in the loop)
**Companion repo:** [WeKruit/hiring-board](https://github.com/WeKruit/hiring-board) — current static MVP (will be redirected after migration)

## Goal

Give the recruiters we partner with a single source of truth for our open collab jobs, plus a friction-free way to submit candidates. Submissions land in a Google Sheet (one tab per job, one column per checklist item) that the WeKruit team reviews in one place.

> "These data needs to be linked with our pa-jobs (WeKruit collab companies). We give it a place for people to submit qualified candidates as a form so it's easy to attach their name + email. Sync the data to Google Sheet, each tab is a new job. Each column is one checklist item. Track who submitted." — Adam, 2026-05-25

## Non-goals (v0)

- No public candidate-facing surface (this is recruiter-only — candidates still flow through `candidate.wekruit.com`).
- No payment/payout automation. The $10K+ placement fee is shown as marketing only; payouts are handled offline.
- No scraping / job ingestion changes. Existing `pa-jobs` pipeline untouched.
- No employer-facing dashboard for submissions (admin-only review in `dashboard-web`).

## Product surfaces

| Surface | Owner repo | URL | Purpose |
|---|---|---|---|
| Recruiter board | `apps/pa-landing` | `https://candidate.wekruit.com/recruiters` | List of 8 collab roles + JD + checklist + submission form |
| Per-role page | `apps/pa-landing` | `https://candidate.wekruit.com/recruiters/job/:jobId` | Single role, deep-linkable |
| Submission API | `apps/functions` | `paRecruiterSubmission` (HTTP CF) | Accepts form POST, writes to Firestore + Sheet |
| Public job list API | `apps/functions` | `paCollabJobsList` (HTTP CF, GET) | Returns 8 collab jobs as JSON, cached 60s |
| Admin review | `apps/dashboard-web` | `https://wekruit-pa.web.app/admin/recruiter-submissions` | All submissions, filter by job, drill-down |
| Old GH Pages | `WeKruit/hiring-board` | `https://wekruit.github.io/hiring-board/` | 301-equivalent redirect → new URL |

## Data model

### `pa-jobs` collection — extend in place (existing collection)

`pa-jobs` already has `wekruitCollaborationStatus: "collaborated" | "not_collaborated"` (locked v1.6 schema). That's our flag — no new collection. We extend the 8 collab job docs with a `collabBoard` sub-object holding the rich recruiter-board payload.

```ts
// Existing pa-jobs fields stay as is:
//   jobId, title, companyId, companyName, location, descriptionMd, atsApplyUrl,
//   publicVisible, wekruitCollaborationStatus, candidatePageStatus, etc.

// NEW: optional sub-object, only present on collab board jobs
type CollabBoardPayload = {
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
//   collabBoard: CollabBoardPayload
```

**Query for the board:**
```ts
db.collection("pa-jobs")
  .where("wekruitCollaborationStatus", "==", "collaborated")
  .where("collabBoard.active", "==", true)
  .get()
```

Real company names (`MetaVoice`, `VoiceCursor`, `Photon`, `Helium`) stay only on `companyName` / `companyId` — the public CF strips both and surfaces only `collabBoard.label.*`.

### `pa-recruiter-submissions` Firestore collection (new)

```ts
type RecruiterSubmissionDoc = {
  submissionId: string;
  jobId: string;                 // foreign key → pa-collab-jobs.jobId
  jobTitleSnapshot: string;      // denormalized for admin list view
  companyLabelSnapshot: string;

  submitter: {
    name: string;
    email: string;               // lowercased, validated
    company?: string;            // optional, "Acme Recruiting" etc.
  };

  candidate: {
    name: string;
    link: string;                // LinkedIn or resume URL (string-validated, not parsed)
    currentRole?: string;
    yoe?: string;
    notes?: string;
  };

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
  source: {
    userAgent: string;
    referrer?: string;
    ip?: string;                 // hashed
  };

  // Sheet sync
  sheetSyncedAt?: Timestamp;
  sheetRowId?: string;
  sheetSyncError?: string;

  status: "new" | "reviewing" | "advanced" | "rejected" | "duplicate";
  reviewerNotes?: string;        // internal

  createdAt: Timestamp;
  updatedAt: Timestamp;
};
```

## API endpoints

### `GET paCollabJobsList`

Public, CORS-enabled, 60s cache.

Returns: `{ jobs: CollabJobDoc[] }` filtered to `status=active`, sorted by `sortOrder`. **Strips** `company.realName` before sending.

### `POST paRecruiterSubmission`

Public, CORS-enabled, rate-limited by submitter email (max 30/hour).

Body:
```ts
{
  jobId: string;
  submitter: { name: string; email: string; company?: string };
  candidate: { name: string; link: string; currentRole?: string; yoe?: string; notes?: string };
  checklist: { [itemId: string]: boolean };
  hcaptchaToken?: string;        // optional spam gate
}
```

Validates jobId exists + checklist itemIds match the job's checklist. Writes `pa-recruiter-submissions` doc, computes `score`, then async-appends to Google Sheet (failure does not block the response — error is recorded on the doc for retry).

Returns: `{ ok: true, submissionId }` or `{ ok: false, error }`.

## Google Sheets layout

**Master spreadsheet:** "WeKruit Recruiter Submissions" (Adam creates, shares with Firebase service account email — TBD by the functions-explore agent).

**Tab per jobId.** First submission for a job auto-creates the tab via Sheets API with a header row built from the job's checklist.

**Column structure (one tab):**

```
| Submitted at | Submitter name | Submitter email | Submitter company |
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

- `/recruiters` — landing: payout strip, instructions, role grid (fetches `paCollabJobsList`)
- `/recruiters/job/:jobId` — role page: JD + culture + submission form + checklist
- `/recruiters/submitted` — thank-you confirmation page (with submission id + next steps)

## Admin dashboard

- `/admin/recruiter-submissions` (auth-gated `@wekruit.com`)
- Top: filter by jobId, by submitter, by date range, by status
- Table columns: submitted at, job (label), submitter (name + email), candidate (name + link), hard score, fit score, status
- Row click → drawer with full checklist breakdown + status change buttons + reviewer notes

## Migration / cutover

1. Build everything below `/recruiters` on `candidate.wekruit.com`.
2. Once deployed + smoke-tested: update `WeKruit/hiring-board/index.html` to a redirect stub (`<meta http-equiv="refresh" content="0;url=https://candidate.wekruit.com/recruiters">` + JS fallback).
3. Push to main. GH Pages serves redirect.
4. Old per-role URLs `wekruit.github.io/hiring-board/#/role-N` map to nothing useful → redirect to `/recruiters` landing (no per-role mapping; recruiters re-pick from the new landing).

## Phasing

1. **A — Codebase mapping (in flight)** — 4 parallel Explore agents.
2. **B — Architecture doc (this doc)** — review + sign-off.
3. **C — pa-jobs collabBoard payload + seed 8 jobs** — TS types in `packages/core-types`, seed script `apps/functions/scripts/seed-collab-board.mjs` that sets `wekruitCollaborationStatus=collaborated` + `collabBoard` on the 8 jobs (creates if missing, merges if exists). Run against prod Firestore.
4. **D — `paCollabJobsList` CF** — implement, test, deploy.
5. **E — `/recruiters` pa-landing route** — React port, fetches CF, renders board.
6. **F — Submission form + `paRecruiterSubmission` CF (Firestore only first)** — form UX, validation, write to Firestore. No Sheets yet.
7. **G — Google Sheets sync** — add Sheets API integration. Adam shares SA on the master Sheet.
8. **H — Admin dashboard `/admin/recruiter-submissions`** — review surface.
9. **I — Redirect old GH Pages** — flip the URL.
10. **J — Deploy + E2E smoke** — submit a real test candidate, walk it through all surfaces.

## Open questions for Adam

1. **Which of the 8 jobs already exist in `pa-jobs`?** Paste the existing jobIds so I can set `linkedPaJobId` on the seed.
2. **Service account for Sheets API** — should I create a dedicated SA (`pa-recruiter-sheets@<project>.iam.gserviceaccount.com`), or reuse the existing functions runtime SA? (Will know after the functions-explore agent reports.)
3. **Sheet name** — "WeKruit Recruiter Submissions" OK? Or something else?
4. **Rate limiting** — 30 submissions/hour per submitter email reasonable? Or stricter?
5. **Submission confirmation** — email the submitter a copy? (Adds complexity; can defer.)
6. **hCaptcha / spam gate** — needed v0 or defer? (Public form is spam-attractive.)

## Reference

- WeKruit collab company list (internal, do not surface in code):
  - **Co. A — MetaVoice** (2 roles, already in pa-jobs): `metavoice-research-scientist-post-training`, `metavoice-software-engineer-data-evals`
  - **Co. B — VoiceCursor / Signal Ratio Inc.** (3 roles, need to create): Founding Engineer, Founding PM, Founding Growth
  - **Co. C — Photon** (2 roles, already in pa-jobs): `wekruit-973f2953-photon-objective-c-engineer`, `wekruit-37429d02-photon-macos-devops`
  - **Co. D — Helium** (1 role, need to create): Product Engineer (Full-Stack) — `https://tryhelium.com/`
  - **Co. E — invoko.ai** (3 roles, already in pa-jobs): `hs-10996795-invoko-product-manager`, `hs-11005377-invoko-ui-ux-designer`, `hs-11005382-invoko-product-designer`

Total: 11 roles across 5 companies. 7 pa-jobs already exist + 4 to create.
- Current static MVP: [WeKruit/hiring-board](https://github.com/WeKruit/hiring-board) — commit `bd4e249` is the last anonymized version.
