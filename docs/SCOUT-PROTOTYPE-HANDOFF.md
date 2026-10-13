# Scout recruiting prototype — teammate handoff

Updated: 2026-09-29

## Purpose

Scout is a **clickable front-end concept** for a recruiting workflow. A recruiter pastes a job description, answers clarifying questions, reviews ranked candidates, gives client feedback to refine comparable-company and industry filters, opens a detailed person profile, and walks through shortlist, contacts, outreach sequence, inbox, and interview scheduling. The interaction borrows the chat-first entry from Autumn, the search and recruiting workspace from Metix, and the candidate-detail layout from Juicebox. It is a separate `/hire` product surface, not a tab inside the existing admin dashboard.

The live demo is [https://wekruit-pa.web.app/hire](https://wekruit-pa.web.app/hire). It currently requires the dashboard's existing `@wekruit.com` Google sign-in. The existing admin app and candidate-facing sites have separate domains; do not move candidate flows onto the admin host.

## Source of truth and code map

Repository: [WeKruit/wekruit-pa](https://github.com/WeKruit/wekruit-pa), `main`. The prototype code was last changed in commit `c2477d69` before this handoff. Start from current `origin/main`; do not depend on Adam's local worktree path.

| Path | Responsibility |
| --- | --- |
| `apps/dashboard-web/src/App.tsx` | Routes authenticated `/hire/*` to the standalone surface; old `/admin/sourcing-studio-demo` redirects there. |
| `apps/dashboard-web/src/pages/SourcingStudioDemo.tsx` | Page state and all clickable views: job brief, feedback chat, results, person drawer, shortlist, contacts, sequence, inbox, interview, workflow. Uses the already-installed `@chatscope/chat-ui-kit-react` for chat. |
| `apps/dashboard-web/src/pages/sourcing-studio-demo.css` | Visual styling and responsive layout. |
| `apps/dashboard-web/src/pages/sourcing-demo-data.ts` | Five fictional candidate records, one sample job description, and illustrative comparable-company groups. |
| `apps/dashboard-web/src/pages/sourcing-demo-score.ts` | Fixed demo match score and ranking axes. |
| `apps/dashboard-web/src/pages/sourcing-demo-refinement.ts` | Comparable-employer evidence, industry requirement, and reranking logic. |
| `apps/dashboard-web/src/pages/sourcing-demo-score.test.ts`, `sourcing-demo-refinement.test.ts` | Small deterministic checks for ranking and refinement. |

## Run locally

```bash
git clone https://github.com/WeKruit/wekruit-pa.git
cd wekruit-pa
git switch main
git pull --ff-only
source ~/.zshrc && nvm use 24
pnpm install --frozen-lockfile
npm run build --workspace=@pa/core-types
pnpm --filter dashboard-web dev
```

Open Vite's printed localhost URL with `/hire` appended (usually `http://localhost:5173/hire`). Local auth needs `apps/dashboard-web/.env.local` with the dashboard's `VITE_FIREBASE_*` values; obtain that file through the team's approved secret channel. Do not commit it. Node 24 is enforced by the repository.

To check the prototype before changing it:

```bash
source ~/.zshrc && nvm use 24
npx tsx --test apps/dashboard-web/src/pages/sourcing-demo-score.test.ts apps/dashboard-web/src/pages/sourcing-demo-refinement.test.ts
pnpm --filter dashboard-web build
```

## Click-through path

1. `/hire` opens the five-person sample search. **New Role** accepts a pasted job description; **Deep** takes the user through location, compensation, visa, and relevant-company questions. **Fast Search** goes straight to the sample results. Every role currently reuses the same five candidates.
2. On results, choose **Discuss feedback**. State that the client wants similar-company experience; select property-management software or commercial real-estate technology, decide whether industry background is required or preferred, select comparable employers, and choose sector years. Apply to rerank. The property example narrows five profiles to three; the commercial VTS example narrows to two. The result cards show the employer evidence.
3. Open **Morgan Lee**. The drawer has Overview, Experience, Match & company, and Autumn fields tabs, plus Notes and Activity. The LinkedIn URL, career history, current-company context, `value`/`source_id` cells, and `_sources` map are **fictional sample content**. The schema preview is modeled on [Autumn's structured-output guide](https://www.autumn.ai/docs/guides/structured-output); no Autumn API call occurs.
4. Continue through shortlist → contacts → edit sequence → **Simulate send batch** → interested reply → interview slot → **Confirm in demo**. Those actions change React state in the current browser session only. No real email or calendar event is created.

## Boundaries and next implementation work

- This is a UI prototype, not a sourcing integration. Do not treat `example.com` emails, `*-demo` LinkedIn URLs, employment history, company facts, scores, or source IDs as real person data.
- Search refinement is a fixed, staged conversation over illustrative company names. Free text is accepted in the chat, but it is not an LLM interpretation of arbitrary requirements. Ranking uses a deterministic sample weighting. Notes, outreach state, and interview state are in memory and reset on reload.
- For a real Autumn connection, replace the fixture list at the `CANDIDATES` boundary with validated, source-attributed records, then verify each displayed field against its source. Confirm the actual Autumn response contract and permissions before mapping it; the preview JSON is only a target shape.
- Existing WeKruit external candidate supply has a separate canonical `pa-users` and LinkedIn-handle identity model. Read `README.md`, `.planning/INITIATIVE-external-candidate-supply-intake.md`, `AGENTS.md`, and `CLAUDE.md` before connecting this surface to production data or outbound. Never use a raw LinkedIn URL or email as a Firestore document ID. Do not perform credit-consuming Juicebox export, contact reveal, enrichment, shortlist, or sequence actions during reference research.
- The employer surface elsewhere in WeKruit remains passed-profile-only per `AGENTS.md`. Treat `/hire` as Adam-authorized concept work until product scope for a live employer-facing version is explicitly decided.

## Deploy and verification

The current prototype was deployed to Firebase Hosting target `pa-dashboard` at `wekruit-pa.web.app`. The team must have approved production env values and Firebase credentials. `apps/dashboard-web/.env.production.local` and the service-account JSON are local secrets; do not commit or paste them into a handoff. With credentials already configured as `GOOGLE_APPLICATION_CREDENTIALS`:

```bash
source ~/.zshrc && nvm use 24
PA_DASHBOARD_VITE_ENV_FILE=apps/dashboard-web/.env.production.local pnpm run deploy:hosting
```

The hosting command runs its own predeploy build. After deployment, open the live `/hire` URL and click through the feedback filter and person drawer; a successful CLI exit alone is not verification. The last verified deployment showed three property-software matches and Morgan's Autumn fields after clicking through the live page.

## Reference artifacts

- Live demo: [https://wekruit-pa.web.app/hire](https://wekruit-pa.web.app/hire)
- On Adam's Mac only: `/Users/adam/Downloads/WeKruit-Scout-feedback-profile-walkthrough.mp4` (21-second screenshot-based click-path video; not stored in Git)
- Design references: [Autumn](https://platform.autumn.ai/), [Metix](https://www.metix.ai/hire), [Juicebox](https://app.juicebox.ai/)
