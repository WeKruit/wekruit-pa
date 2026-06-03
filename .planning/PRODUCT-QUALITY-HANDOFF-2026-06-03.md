# Product Quality Handoff - 2026-06-03

## Current state

This handoff captures the product-quality slices shipped during the active goal:

> still the product itself is far more trash than paraform..

The code commits below are already on `origin/main` and deployed to `hosting:pa-landing`. They were pushed directly because the repo operating contract in this session required pushing/deploying candidate SPA code changes after implementation. This PR branch exists as the review and handoff artifact for the next session, without rewriting or reverting `main`.

## Landed commits

- `72331da9` - Route first-time role logins to public interview
- `0d433ecc` - Preserve role signal through login
- `1ae19ec8` - Keep employer packet counts editable-only

Context from the preceding product-quality run:

- `8bec184c` - Hide unresolved open role tab counts
- `53ffd7ef` - Carry durable profile into company screens
- `54ee333b` - Clarify durable profile in role market
- `d1aa2111` - Clarify durable profile on candidate home
- `1cc01c1b` - Keep employer intake navigation employer-scoped

## What changed

### Candidate role login

Problem: a logged-out candidate following a role-specific path could get pushed into generic onboarding/login and lose the role context.

Changes:

- First-time public role logins now route back to the public interview path instead of a generic onboarding loop.
- Market role-signal profile URLs are recognized as durable profile signal paths.
- Logged-out role-signal login now shows role-specific copy, a role-signal preview, and a first-time onboarding link that preserves the encoded original profile signal path.

Live verification:

- URL checked:
  `https://candidate.wekruit.com/me/profile?profileRoleSignalTitle=Backend%20Engineer&profileRoleSignalCompany=Rain&profileRoleSignalFunction=Software%20Engineering&profileRoleSignalLevel=Mid%20Level&profileRoleSignalLocation=New%20York%2C%20NY#profile-corrections`
- Expected and observed:
  - redirected to `/login?next=...profileRoleSignal...#profile-corrections`
  - login showed `ROLE SIGNAL`
  - login showed `Save this role signal.`
  - preview included `Backend Engineer at Rain stays attached...`
  - first-time link pointed to `/onboarding?next=...profileRoleSignal...#profile-corrections`

### Employer role intake

Problem: mobile employer role intake showed `0/8 ready` in the sticky progress dock while the packet preview showed `1/8 complete` before the employer entered anything. The candidate share boundary is a fixed product rule, not an employer-filled packet section.

Changes:

- `candidate_share_boundary` remains rendered in the live packet preview.
- Packet preview count and readiness now count only the seven editable employer packet sections.
- Initial live state now reads:
  - sticky dock: `Role packet 0/8 ready`
  - packet preview: `0/7 complete`

Live verification:

- URL checked:
  `https://candidate.wekruit.com/employer?codexFeedbackLoop=bb2820c5&viewport=mobile&verify=1ae19ec8`
- Expected and observed:
  - preview label: `0 of 7 Claire packet sections complete`
  - visible preview text includes `0/7 complete`
  - no `1/8 complete`
  - candidate share boundary still visible
  - deployed bundle: `/assets/index-s9XiH7bn.js`

## Verification run

Commands run with Node 24:

```bash
source ~/.zshrc && nvm use 24 >/dev/null && npx tsx --test apps/pa-landing/src/pages/CandidateLogin.test.ts apps/pa-landing/src/lib/browser-identity.test.ts
source ~/.zshrc && nvm use 24 >/dev/null && npx tsx --test apps/pa-landing/src/lib/employer-signup-model.test.ts apps/pa-landing/src/pages/EmployerSignup.test.ts
source ~/.zshrc && nvm use 24 >/dev/null && npm run build --workspace apps/pa-landing
source ~/.zshrc && nvm use 24 >/dev/null && npm exec -- firebase deploy --only hosting:pa-landing --project wekruit-5f89b --non-interactive
```

Results:

- Candidate login/browser identity tests: `34/34` passing.
- Employer intake/model tests: `35/35` passing.
- `apps/pa-landing` production build passed.
- Firebase Hosting deploy completed for `hosting:pa-landing`.
- `origin/main` confirmed at `1ae19ec848efe1119cf6ffe1469f1813a5317009`.

Expected warnings:

- npm warns about unknown project config `link-workspace-packages` / `auto-install-peers`.
- Firebase predeploy warns optional `VITE_LINKEDIN_AUTH_START_URL` is not set.
- Vite warns the main chunk is larger than 500 kB.

## Current worktree notes

Tracked files are clean before this handoff file was added.

Existing untracked QA artifacts were intentionally not staged:

- `.playwright-mcp/`
- `company-role-cta-live-c0c13004.png`
- `employer-mobile-current.png`
- `employer-mobile-live-bb2820c5.png`
- `employer-next-gap-snapshot.md`
- `employer-packet-preview-mobile.png`
- `employer-share-boundary-live-94974ecd.png`
- `employers-inbox-mobile-live-bb2820c5.png`
- `local-employers-fit.png`
- `market-next-gap-snapshot.md`
- `market-role-signal-live-8ae1bcae.png`
- `open-claire-first-live-8133e25a.png`

## Suggested next session entry point

Continue from the candidate market and public role path:

1. Inspect `https://candidate.wekruit.com/market?codexFeedbackLoop=next-gap&viewport=mobile`.
2. Pick one live `Talk to Claire` role path and verify the candidate can understand:
   - Claire interviews first;
   - the durable candidate profile supplies constraints and corrections;
   - the employer sees a passed profile only after the role screen and candidate consent.
3. If the path still feels like a job board table with repeated buttons, improve the first candidate action surface. Do not add generic marketing copy or a compatibility workaround.

