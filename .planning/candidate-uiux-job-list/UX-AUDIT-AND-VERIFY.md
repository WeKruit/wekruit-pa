# Candidate UIUX Job List Audit + Verification

Date: 2026-05-14
Branch: `codex/candidate-uiux-job-list`

## User Path

`candidate.wekruit.com/` -> public job list -> `/j/:jobId` -> resume upload -> Open in iMessage -> `/me/matches` or `/me`.

## Repo Audit

- Candidate domain is `apps/pa-landing`; routes are `/`, `/legal`, `/login`, `/me`, `/me/matches`, `/me/profile`, `/j/:jobId`, `/j/:jobId/cv`.
- Existing `/` was a black iMessage-only CTA and did not expose job openings.
- Existing `/j/:jobId` read `pa-jobs/{jobId}` and gated on `publicVisible === true`, but used a separate visual style.
- Public job source is `pa-jobs` with Firestore public read rule `resource.data.publicVisible == true`.
- Admin job editor already owns `publicVisible`; candidate work must not move `/j/:jobId` back to the admin domain.

## Implementation

- Added `apps/pa-landing/src/lib/public-jobs.ts`.
  - Queries `pa-jobs` with `where("publicVisible", "==", true)`.
  - Filters closed jobs with `dead === true`.
  - Uses existing public-safe job fields and `prescreenConfig` fallback fields.
- Rebuilt `apps/pa-landing/src/pages/Landing.tsx`.
  - Home now shows a public jobs grid.
  - Job cards link directly to `/j/:jobId`.
  - Primary action is the job list, not direct SMS.
- Updated `apps/pa-landing/src/pages/PublicJob.tsx`.
  - Uses the same candidate shell and Jobs / Matches / Profile navigation as home/profile/matches.
  - Keeps `publicVisible` gate, Sendblue pool selection, global browser UID, inline resume upload, QR, and Open in iMessage.
  - Renders JD markdown into headings, bullets, and paragraphs instead of exposing raw `**markdown**`.
- Updated shared candidate shell navigation in `CandidateLogin.tsx`.
- Updated landing theme color in `index.html`.

## Local Verification

Commands:

- `pnpm install --frozen-lockfile`
- `pnpm --filter @pa/landing typecheck`
- `pnpm --filter @pa/landing build`
- `git diff --check`

Result:

- Typecheck passed.
- Production build passed.
- Diff whitespace check passed.
- Build warning remains the existing Vite large chunk warning only.

Browser verification:

- Local URL: `http://127.0.0.1:5177/`
- Desktop `1365x900`: home loaded 5 public jobs; first card linked to `/j/hs-11005382-invoko-product-designer`.
- Desktop click: Product Designer card navigated to `/j/hs-11005382-invoko-product-designer`.
- Job detail showed Product Designer, company/location/salary, rendered role details, Open in iMessage, QR, resume upload, terms.
- Mobile `390x844`: home and job detail rendered without overlapping text or broken navigation.
- Console: `0` errors, `0` warnings.

Computer Use verification:

- Chrome app-state opened `http://127.0.0.1:5177/`.
- App-state exposed 5 public job links.
- Clicked Product Designer job link.
- App-state confirmed URL `127.0.0.1:5177/j/hs-11005382-invoko-product-designer` and visible job detail with rendered headings/bullets, Open in iMessage, QR, and resume upload.
- Existing production Chrome tab still showed old raw markdown UI before deploy; this is the pending deployment verification target.

Passive no-outbound check:

- Current `pa-outbound` count after local passive browsing: `190`.
- No SMS link was clicked during local verification.

Artifacts:

- `artifacts/local-home-desktop.png`
- `artifacts/local-job-desktop.png`
- `artifacts/local-home-mobile.png`
- `artifacts/local-job-mobile.png`
- `artifacts/local-browser-console.log`

## Production Verification

PR:

- PR `#41` merged into `main` at `32ffc5426e015f6509790bdb791486a8f39aa704`.
- Required checks passed: CodeQL, Analyze actions, Analyze javascript-typescript, Analyze python, typecheck + unit tests, v1.5 QA team.

Deploy:

- Deployed `hosting:pa-landing` to Firebase project `wekruit-5f89b`.
- First deploy surfaced a real stale-dist issue: live home still showed the old SMS-only landing.
- Rebuilt `@pa/landing` in the updated main worktree and redeployed `hosting:pa-landing`.

Live browser verification:

- `https://candidate.wekruit.com/?t=20260514-uiux2` showed the new candidate marketplace home and 5 public job cards.
- Clicking Product Designer navigated to `https://candidate.wekruit.com/j/hs-11005382-invoko-product-designer`.
- Live job detail showed the unified nav, Product Designer title, company/location/salary, rendered role details, Open in iMessage, QR, resume upload, and terms.
- Mobile live home and job detail rendered at `390x844` without broken navigation or text overlap.
- Live browser console: `0` errors, `0` warnings.
- Admin stale route check: `https://wekruit-pa.web.app/j/hs-11005382-invoko-product-designer` returns `301` to `https://candidate.wekruit.com/j/hs-11005382-invoko-product-designer`.
- Passive outbound check: `pa-outbound` count stayed `190` before deploy and after live browsing.

Live artifacts:

- `artifacts/live-home-desktop.png`
- `artifacts/live-job-desktop.png`
- `artifacts/live-home-mobile.png`
- `artifacts/live-job-mobile.png`
