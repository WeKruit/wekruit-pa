# YC Startup School Five-Row POC Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run an auditable five-row CoreSignal enrichment POC from the supplied YC attendee CSV and inspect the resulting global candidates and Photon matches in admin.

**Architecture:** A Node 24 runner parses the CSV and uses the existing CoreSignal LinkedIn URL-to-employee-ID lookup. It invokes the deployed `paCoresignalFetchBatch` callable so the existing batch, identity resolution, tags, and experience-mirror pipeline remains the only candidate writer. The script is dry-run by default and writes no profile directly.

**Tech Stack:** Node 24, Node standard library, Firebase Admin SDK, Firebase callable API, CoreSignal collect v2, Firestore.

---

## File structure

- Create: `apps/functions/scripts/run-yc-startup-school-poc.mjs` — parse CSV, select records, resolve IDs, call the existing batch callable, poll/review results, and write the redacted report.
- Create: `apps/functions/scripts/__tests__/run-yc-startup-school-poc.test.mjs` — pure parser, selection, and request-shape tests.
- Create at execution time: `docs/superpowers/artifacts/yc-startup-school-five-row-poc.json` — redacted POC results and admin links.

### Task 1: Deterministic CSV selection

**Files:**
- Create: `apps/functions/scripts/run-yc-startup-school-poc.mjs`
- Test: `apps/functions/scripts/__tests__/run-yc-startup-school-poc.test.mjs`

- [ ] **Step 1: Write the failing test**

```js
import assert from "node:assert/strict";
import test from "node:test";
import { parseAttendeeCsv, selectPocRows } from "../run-yc-startup-school-poc.mjs";

test("selectPocRows chooses five unique canonical LinkedIn profiles", () => {
  const rows = parseAttendeeCsv("Name,LinkedIn Profile URL\nA,https://www.linkedin.com/in/a/\nDuplicate,https://linkedin.com/in/a\nB,https://www.linkedin.com/in/b/\nC,https://www.linkedin.com/in/c/\nD,https://www.linkedin.com/in/d/\nE,https://www.linkedin.com/in/e/");
  assert.deepEqual(selectPocRows(rows, 5).map((row) => row.linkedinUrl), ["https://www.linkedin.com/in/a/", "https://www.linkedin.com/in/b/", "https://www.linkedin.com/in/c/", "https://www.linkedin.com/in/d/", "https://www.linkedin.com/in/e/"]);
});
```

- [ ] **Step 2: Run the test and observe failure**

Run: `source ~/.zshrc && nvm use 24 && node --test apps/functions/scripts/__tests__/run-yc-startup-school-poc.test.mjs`

Expected: FAIL because the runner exports do not exist.

- [ ] **Step 3: Implement the pure input boundary**

Implement `parseAttendeeCsv(text)` and `selectPocRows(rows, count)`. The parser skips pre-header disclaimer rows, requires `Name` and `LinkedIn Profile URL`, canonicalizes with existing `canonicalizeLinkedInUrl`, preserves the 1-based source row, and returns only `{ name, linkedinUrl, sourceRow }`. Selection returns the first `count` unique URLs.

- [ ] **Step 4: Run the focused test**

Run: `source ~/.zshrc && nvm use 24 && node --test apps/functions/scripts/__tests__/run-yc-startup-school-poc.test.mjs`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/functions/scripts/run-yc-startup-school-poc.mjs apps/functions/scripts/__tests__/run-yc-startup-school-poc.test.mjs
git commit -m "feat: add YC attendee POC input runner"
```

### Task 2: Existing-pipeline invocation

**Files:**
- Modify: `apps/functions/scripts/run-yc-startup-school-poc.mjs`
- Modify: `apps/functions/scripts/__tests__/run-yc-startup-school-poc.test.mjs`

- [ ] **Step 1: Write the failing callable-body test**

```js
test("invokeBatch submits numeric CoreSignal IDs only", async () => {
  const calls = [];
  await invokeBatch([101, 102], async (body) => { calls.push(body); return { batchId: "batch-1" }; });
  assert.deepEqual(calls, [{ candidateIds: [101, 102] }]);
});
```

- [ ] **Step 2: Run the test and observe failure**

Run: `source ~/.zshrc && nvm use 24 && node --test apps/functions/scripts/__tests__/run-yc-startup-school-poc.test.mjs`

Expected: FAIL because `invokeBatch` does not exist.

- [ ] **Step 3: Implement the narrow operational client**

Use the existing `searchEmployeeIdByLinkedinUrl` for every selected URL. Abort a row on no ID, duplicate ID, or mismatched canonical URL after collect. With `--commit`, exchange a Firebase custom token for the existing `admin1@wekruit.com` account and call only the deployed `paCoresignalFetchBatch` endpoint with `{ candidateIds }`. Never print or persist credentials, access tokens, raw CoreSignal responses, or email addresses. Without `--commit`, print the selected rows and resolved IDs only.

- [ ] **Step 4: Run focused tests**

Run: `source ~/.zshrc && nvm use 24 && node --test apps/functions/scripts/__tests__/run-yc-startup-school-poc.test.mjs`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/functions/scripts/run-yc-startup-school-poc.mjs apps/functions/scripts/__tests__/run-yc-startup-school-poc.test.mjs
git commit -m "feat: run CoreSignal attendee POC through batch intake"
```

### Task 3: Authorized five-row run and admin proof

**Files:**
- Modify: `apps/functions/scripts/run-yc-startup-school-poc.mjs`
- Create: `docs/superpowers/artifacts/yc-startup-school-five-row-poc.json`

- [ ] **Step 1: Add the explicit mutating command guard**

The runner accepts `--csv`, `--limit`, and `--commit`. `--limit` defaults to five and rejects any value above five for this POC. `--commit` is required before any callable request.

- [ ] **Step 2: Verify dry-run selection**

Run: `source ~/.zshrc && nvm use 24 && node apps/functions/scripts/run-yc-startup-school-poc.mjs --csv '/Users/adam/Downloads/YC Startup School 2026 - Attendees.csv' --limit 5`

Expected: five unique source rows, canonical LinkedIn URLs, and no remote mutation.

- [ ] **Step 3: Run the POC**

Run: `source ~/.zshrc && nvm use 24 && node apps/functions/scripts/run-yc-startup-school-poc.mjs --csv '/Users/adam/Downloads/YC Startup School 2026 - Attendees.csv' --limit 5 --commit`

Expected: one external-supply batch and either a candidate profile or explicit review outcome for each selected row.

- [ ] **Step 4: Produce the redacted result artifact**

Write the cohort, source rows, canonical URLs, numeric CoreSignal IDs, batch ID, resolution status, candidate IDs when available, and these admin URLs: batch detail, candidate profile, and Photon job-to-candidates match debug. Do not include email, raw CoreSignal data, or credentials.

- [ ] **Step 5: Inspect the records in admin**

Open the resulting batch at `https://wekruit-pa.web.app/admin/external-supply/batches/<batchId>`, each profile at `https://wekruit-pa.web.app/admin/candidates/<candidateId>/profile`, and `https://wekruit-pa.web.app/admin/match-debug` with job `photon-backend-engineer-high-concurrency`. Record either positive match evidence or the exact hard-filter exclusion per candidate.

- [ ] **Step 6: Commit**

```bash
git add apps/functions/scripts/run-yc-startup-school-poc.mjs docs/superpowers/artifacts/yc-startup-school-five-row-poc.json
git commit -m "docs: record YC attendee enrichment POC"
```

