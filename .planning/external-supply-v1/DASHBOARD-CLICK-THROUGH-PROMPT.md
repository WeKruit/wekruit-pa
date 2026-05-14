# Dashboard click-through test prompt — External Supply V1

> Copy-paste this prompt into a Claude Cowork (or any browser-driving
> agent) session that has a logged-in `@wekruit.com` Firebase Auth
> account in the active browser profile. The agent will walk every
> external-supply admin route on the live prod dashboard and report
> back. Closes ACCEPTANCE row 20 (last `known_gap`).

---

## Task for the Cowork agent

You are auditing the live WeKruit admin dashboard at
`https://wekruit-pa.web.app`. Sign in with the `@wekruit.com` Google
account already loaded in the browser if not signed in.

Walk every route under `/admin/external-supply/**` and report what you
see at each step. At each step record: route URL, top-level page header,
key controls visible, whether the route serves loading / empty / error /
populated state, and any console errors in the browser DevTools console
(open DevTools before you start).

There is real test data in prod with the prefix
`prod-smoke-2026-05-14T01-18-26-580Z-*` (created by the Admin-SDK smoke
script). Use it for any "open an existing item" step instead of seeding
new data.

### Sequence

1. **`/admin/external-supply`** (landing).
   Expect: a `Source Batches` table with at least 1 row matching the
   prod-smoke batch id (`prod-smoke-2026-05-14T01-18-26-580Z-batch`).
   Click the batch row to navigate to the detail page.

2. **`/admin/external-supply/batches/:batchId`** (batch detail).
   Expect: stats header showing `rowCount: 4`, `validLinkedInCount: 3`,
   `validEmailCount: 2`, `duplicateCount: 0`. Per-row table with 4 rows.
   Each row shows an `IdentityStatusBadge`: two rows green ("Create new"
   or "Merge"), one amber ("Needs review"), one red ("Blocked").
   The action menu on each row should expose at least "Resolve identity"
   and "View conflict". DO NOT click "Resolve identity" again — the
   batch is already resolved. Note any rows that look orphaned (no
   `resolvedUserId`).

3. **`/admin/external-supply/batches/new`** (new batch upload).
   Expect: file picker, source-adapter dropdown (juicebox / lessie /
   coresignal / manual-csv), optional companyId + jobId text fields,
   plus a `columnMapping` editor that ONLY appears when adapter =
   `manual_csv`. DO NOT submit — just record the form shape.

4. **`/admin/external-supply/review`** (needs-review queue).
   Expect: filter chips for `linkedin_email_candidate_mismatch`,
   `external_fuzzy_match`, `email-only review`. At least 1 row from the
   prod-smoke batch should be visible (the `email-only` candidate +
   possibly the `no-signal` candidate as `external_fuzzy_match` →
   `blocked` fallback). Record which conflict kinds you see.

5. **`/admin/external-supply/evaluations`** (eval runs list).
   Expect: at least 1 evaluation run from the smoke script. Click into
   it.

6. **`/admin/external-supply/evaluations/:runId`** (per-run detail).
   Expect: per-candidate evaluation rows with tier badges, hard-gate
   reason chips, soft-score numeric, missingInfo / risks lists, an
   `explanation` summary, and an "Override tier" action. Click the
   "Override tier" action on one row (do NOT save — just open the
   dialog and verify it shows a dropdown of all 5 tier values and a
   `reason` text input). Close the dialog without saving.

7. **`/admin/external-supply/research`** (Agent research workbench).
   Expect: a list of `AgentResearchTask` rows in their current state
   (`draft_prompt` / `prompt_copied` / `result_imported` /
   `approved` / `rejected`). If at least one task exists, click into it
   and verify the prompt is copy-to-clipboard-able, that there's a
   raw-result textarea, and that per-finding `approve` / `reject`
   buttons appear once a result is imported. DO NOT actually run
   ChatGPT Agent Mode — just verify the UI shape.

8. **`/admin/external-supply/outreach`** (outreach queue).
   Expect: per-plan rows with tier badge + suppression chip
   (`SuppressionGateChip`). Click a plan to open the drawer; verify
   `OutreachCopyEditor` shows fields for `personalizedHook`,
   `whyThisRole`, `whyCompany`, `candidateSpecificSignal`,
   `emailSubject`, `emailBody`, `linkedinMessage`. There should be both
   `Approve`, `Reject`, and `Sync` controls visible.

   **The Mailgun / Instantly sync button (NEW 2026-05-14):** the
   page must call `paExternalSupplyGetConfig`. The returned shape is
   `{ liveOutreachEnabled, instantlyConfigured, mailgunConfigured,
   defaultEmailProvider: "mailgun" }`. The primary sync button must
   default to "Sync via Mailgun (dry-run)". A `Live` toggle / chip
   should be DISABLED unless `liveOutreachEnabled && mailgunConfigured`
   are both true. Verify the button text + disabled state match the
   config callable's response.

9. **`/admin/external-supply/sync`** (sync status).
   Expect: list of `pa-mailgun-sync-records` AND `pa-instantly-sync-records`
   merged in one timeline view. Each row shows provider chip
   (`mailgun` / `instantly`), `syncStatus`, `mode`, and last event
   timestamp. The smoke script wrote one Instantly dry-run; with the
   Mailgun swap the next sync should write to `pa-mailgun-sync-records`
   instead — note whether the dashboard reads from both collections.

10. **`/admin/external-supply/audit`** (audit + source quality).
    Expect: per-source quality cards (Juicebox / Lessie / Coresignal /
    manual_csv) showing `validRate`, `duplicateRate`, `replyRate`,
    `bounceRate`. Plus a "Why this tier?" search input. Enter
    `prospect-cand_id_5a5e23b6` (or any prod-smoke candidate id) +
    `prod-smoke-2026-05-14T01-18-26-580Z-job` and verify the trace
    drawer shows the full ExternalCandidateRecord → resolution →
    evaluation → outreach plan chain.

### Hard-fail observations (report immediately if you see any)

- Any external-supply route renders on `candidate.wekruit.com` or
  `pa.wekruit.com` — should ONLY be on `wekruit-pa.web.app`.
- Any UI text that says "Connect LinkedIn" / "Send LinkedIn DM" / "Auto
  LinkedIn outreach" — V1 must be manual tasks only.
- Console errors mentioning `Permission denied` or `Missing or
  insufficient permissions` — Firestore rules misconfigured.
- A "Live" sync button enabled when `getExternalSupplyConfig` returned
  `liveOutreachEnabled: false` or `mailgunConfigured: false` — that's
  a UI override bug.
- Any displayed full email address or full phone number — should always
  be masked via `RedactedField`.

### What to return

A markdown report with the 10 routes as section headers. Under each:

- **URL** as a code-formatted line
- **Visible header text** (the dashboard's own `PageHeader` content)
- **Key controls present** as a bullet list
- **State at first paint** — `loading` / `empty` / `error` /
  `populated` / `partial`
- **Console errors** (paste verbatim or "(none)")
- **Anything unexpected** — describe in 1-2 sentences

Plus a top-level **`Hard-fail observations`** section with a bullet per
violation you found (or `(none)` if the walk was clean).

Plus a top-level **`Mailgun swap verification`** section that records
whether the primary sync button on `/admin/external-supply/outreach`
references Mailgun (not Instantly) when `defaultEmailProvider:
"mailgun"` is the config response.

Do not click any button that mutates production data. The smoke fixture
is sufficient.
