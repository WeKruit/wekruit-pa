# Dashboard click-through test prompt — External Supply V2

> Copy-paste this prompt into a Claude Cowork (or any browser-driving
> agent) session that has a logged-in `@wekruit.com` Firebase Auth
> account in the active browser profile. The agent will walk every
> external-supply V2 admin route on the live prod dashboard and report
> back. Closes V2 ACCEPTANCE row 21 (V2-only `known_gap`).

---

## Task for the Cowork agent

You are auditing the live WeKruit admin dashboard at
`https://wekruit-pa.web.app`. Sign in with the `@wekruit.com` Google
account already loaded in the browser if not signed in.

Walk every section below in order and report what you see at each step.
At each step record: route URL, top-level page header, key controls
visible, whether the route serves loading / empty / error / populated
state, and any console errors in the browser DevTools console (open
DevTools before you start).

There is real test data in prod from the V2 prod-smoke script with the
prefix `prod-smoke-v2-2026-05-13T*-*` (created by the Admin-SDK V2 smoke
script). Use it for any "open an existing item" step instead of seeding
new data.

### Sequence

1. **Prerequisites.**
   - You are signed in with a `@wekruit.com` Google account at
     `https://wekruit-pa.web.app`.
   - DevTools is open with the Console + Network tabs visible.
   - You have the V2 prod-smoke batch id handy
     (`prod-smoke-v2-<iso>-batch`) and the V2 fixture file paths
     (`tests/fixtures/external-supply-v2/big-batch-v2.json`,
     `unknown-shape.csv`).
   - You have NOT pre-seeded any new batch — the prod-smoke fixtures
     are the read-only source of truth.

2. **Drag-drop upload (`/admin/external-supply/batches/new`).**
   Drag `tests/fixtures/external-supply-v2/big-batch-v2.json` into
   the drop zone. Expect: the adapter-detect call to identify the file
   as **Juicebox** (confidence ≥ 0.9, based on `linkedin_url` +
   `email_primary` + `current_position` keys). DO NOT submit — record
   the detected adapter, the confidence number, the row-count estimate
   (35 juicebox rows in the multi-source bundle should be the first
   tab), and any column-mapping hints surfaced in the right panel.

3. **Adapter override.**
   Drag `tests/fixtures/external-supply-v2/unknown-shape.csv` into the
   same drop zone. Expect: adapter-detect returns confidence
   below 0.5 (because the row keys `first_name,last_name,company,
   department` do not match any known adapter signature). The UI
   should surface a **"Pick adapter manually"** dropdown with all four
   options (`juicebox`, `lessie`, `coresignal`, `manual_csv`). DO NOT
   submit — pick `manual_csv` and verify the `columnMapping` editor
   appears with one row per CSV column.

4. **Preview pane.**
   For the Juicebox upload from step 2, click **Preview** (do not
   commit). Expect a preview pane showing the first 10 rows alongside
   resolved identity outcomes:
   - `create_new` count
   - `merge_existing` count (LinkedIn-hash hits on `seed_u015..u019`
     from the V2 seed file)
   - `needs_review` count
   - `blocked` count
   - any within-batch duplicate warning chips
   Verify the counts roughly match the fixture's documented
   distribution (35 juicebox = 20/5/5/5 create_new/merge/review/blocked).
   Note any drift.

5. **Commit.**
   DO NOT commit. The prod-smoke batch already covers the commit path.
   Record what the **Commit** button looks like when enabled (label,
   colour, any confirmation modal it triggers on hover) and close the
   drawer.

6. **Resolve identity (`/admin/external-supply/batches/:batchId`).**
   Navigate to the prod-smoke V2 batch detail page. Expect: stats
   header showing `rowCount: 6`, `validLinkedInCount: 4`,
   `validEmailCount: 4`, `duplicateCount: 0`. Per-row table with 6
   rows. Each row shows an `IdentityStatusBadge`: 2 green ("Create
   new" / "Merge"), 2 amber ("Needs review" — `email-only`
   + `linkedin_email_candidate_mismatch`), 1 red ("Blocked" —
   `no-signal` / `fuzzy-blocked`), 1 amber ("Needs review" —
   `fuzzy-blocked`). DO NOT click "Resolve identity" again — the batch
   is already resolved.

7. **Evaluate (`/admin/external-supply/evaluations/:runId`).**
   From the batch detail page, click into the evaluation run produced
   by the prod-smoke script. Expect per-candidate evaluation rows with
   tier badges (`must_outreach` / `outreach_after_research` /
   `retain_for_future` / `do_not_contact` / `blocked`), hard-gate
   reason chips, soft-score numeric, missingInfo / risks lists, and an
   `explanation` summary. The deterministic rubric tier should be set
   for all 6 rows.

8. **Agent rank (dry-run).**
   Click the **"Run agent ranking (dry-run)"** button at the top of the
   evaluation run page. Expect a confirmation modal that:
   - Lists the rows that would be sent to the agent (default = top-K
     by deterministic soft-score; expected K ≤ 10 for the V2 smoke).
   - Shows the model name (`gpt-4o-mini` / `claude-haiku-4` / etc per
     Wave D's chain).
   - Has an "ensemble size" dropdown (1 / 3 / 5).
   - Has a checkbox for **"Use cached results if available"**.
   DO NOT confirm. Close the modal.

9. **Agent rank (live).**
   ONLY proceed if the deploy gate `OPENAI_API_KEY` is set and
   `liveAgentRankEnabled === true` in the config callable. Otherwise
   record the disabled-button reason and skip this step. If enabled,
   click the **"Run agent ranking (live)"** button on a SINGLE row
   (do not run a batch) and wait for the result. Expect:
   - `proposedAgentTier` populated.
   - `agentRationale` populated (4_000-char limit).
   - `agentRisks[]` populated.
   - `agentRecommendedAction` set to one of
     `outreach_now | outreach_after_research | retain_warm | do_not_contact`.
   - `ensembleVotes[]` populated with `modelUsed` + cost telemetry.

10. **Approve / override.**
    On the same row from step 8 or step 9, click the **"Override
    tier"** action. Expect a dropdown of all 5 tier values and a
    required `reason` text input. Pick `retain_for_future` + reason
    `"V2 click-through verification"` and click **Save**. Expect:
    - A correction event written to `pa-correction-events` with
      `targetType: "agent_ranking_result"`.
    - The row's tier badge updates inline.
    - An undo affordance ("revert to agent tier") is visible for at
      least the next 60 seconds.

11. **Outreach draft (`/admin/external-supply/outreach`).**
    Navigate to the outreach queue. Expect per-plan rows with tier
    badge + suppression chip (`SuppressionGateChip`). Click a plan to
    open the drawer; verify `OutreachCopyEditor` shows fields for
    `personalizedHook`, `whyThisRole`, `whyCompany`,
    `candidateSpecificSignal`, `emailSubject`, `emailBody`,
    `linkedinMessage`. There should be **Approve**, **Reject**, and
    **Sync** controls visible.

12. **Mailgun dry-run sync.**
    On the same plan drawer from step 11, expect the sync button to
    default to **"Sync via Mailgun (dry-run)"**. The page must call
    `paExternalSupplyGetConfig` whose returned shape is
    `{ liveOutreachEnabled, instantlyConfigured, mailgunConfigured,
    defaultEmailProvider: "mailgun" }`. Verify:
    - The primary button text references **Mailgun**, not Instantly.
    - A `Live` toggle / chip is DISABLED unless
      `liveOutreachEnabled && mailgunConfigured` are both true.
    - Clicking the dry-run button surfaces a confirmation modal but
      does NOT call the Mailgun live API. DO NOT actually confirm.

13. **Reply event back.**
    From `/admin/external-supply/sync`, locate the V2 prod-smoke
    Mailgun dry-run record. Expect: row shows provider chip
    `mailgun`, `syncStatus`, `mode: dry_run`, and last event
    timestamp. If the V2 prod-smoke script replayed a synthetic
    reply event, verify a `pa-outreach-events` row with
    `event: "reply"` is visible and the candidate appears in any
    "Replied to outreach" filter on `/admin/external-supply/review`.

14. **Audit trace (`/admin/external-supply/audit`).**
    Expect: per-source quality cards (Juicebox / Lessie / Coresignal /
    manual_csv) showing `validRate`, `duplicateRate`, `replyRate`,
    `bounceRate`. Plus a **"Why this tier?"** search input. Enter
    the prod-smoke V2 record id `prod-smoke-v2-<iso>-rec-li-and-email`
    plus job id `prod-smoke-v2-<iso>-job` and verify the trace
    drawer shows the full chain:
    `ExternalCandidateRecord → resolution → deterministic evaluation
    → agent ranking → outreach plan → sync record`.

15. **Hard-fail observations** (report immediately if you see any).
    - Any external-supply route renders on `candidate.wekruit.com` or
      `pa.wekruit.com` — should ONLY be on `wekruit-pa.web.app`.
    - Any UI text that says "Connect LinkedIn" / "Send LinkedIn DM" /
      "Auto LinkedIn outreach" — V2 must still be manual tasks only.
    - Console errors mentioning `Permission denied` or `Missing or
      insufficient permissions` — Firestore rules misconfigured.
    - A `Live` sync button enabled when `getExternalSupplyConfig`
      returned `liveOutreachEnabled: false` or `mailgunConfigured:
      false` — that's a UI override bug.
    - Any displayed full email address or full phone number — should
      always be masked via `RedactedField`.
    - Any **agent ranking** call that runs live without the
      `liveAgentRankEnabled` gate AND without an explicit user
      confirmation modal — that's a kill-switch bypass.
    - Any **override** that does NOT write a corresponding row to
      `pa-correction-events` with `targetType: "agent_ranking_result"`
      — that's a flywheel-data leak.

16. **What to return.**
    A markdown report with sections 2–14 as section headers. Under
    each:
    - **URL** as a code-formatted line.
    - **Visible header text** (the dashboard's own `PageHeader`
      content).
    - **Key controls present** as a bullet list.
    - **State at first paint** — `loading` / `empty` / `error` /
      `populated` / `partial`.
    - **Console errors** (paste verbatim or `(none)`).
    - **Anything unexpected** — describe in 1-2 sentences.

    Plus a top-level **`Hard-fail observations`** section with a
    bullet per violation you found (or `(none)` if the walk was clean).

    Plus a top-level **`V2-specific verification`** section that
    records:
    - Whether the primary sync button on
      `/admin/external-supply/outreach` references Mailgun (not
      Instantly) when `defaultEmailProvider: "mailgun"` is the config
      response.
    - Whether the agent-ranking dry-run + live + override flows all
      work end-to-end without hard-fail observations.
    - Whether the audit-trace drawer surfaces the FULL chain
      (record → resolution → eval → agent → outreach → sync) for
      `prod-smoke-v2-<iso>-rec-li-and-email`.

Do not click any button that mutates production data beyond the
override step (10). The prod-smoke fixture is sufficient for all other
verification.
