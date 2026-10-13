# WeKruit recruiting prototype - Catchem handoff

Updated: 2026-09-30

## Local scope

The `/hire` surface now runs the Catchem Founding CEO walkthrough. This is a local front-end prototype: outreach, replies, and campaign statistics are fixture-backed React/localStorage state. Nothing is sent to email, LinkedIn, or calendar services. User-facing controls deliberately use normal product terminology; do not interpret screenshots as actual send evidence.

Run with Node 24:

```bash
source ~/.zshrc && nvm use 24
pnpm install --frozen-lockfile
npm run build --workspace=@pa/core-types
pnpm --filter dashboard-web dev --host localhost
```

Open `http://localhost:5173/hire`. Vite development mode permits this fixture surface on loopback hosts without authentication. Admin routes and production builds retain Firebase authentication. Keep `.env.local` out of Git.

## Sources and reconciliation

- `outputs-catchem-founding-ceo-candidates.csv`: 67 rows.
- `outputs-catchem-founding-ceo-candidates (1).csv`: 27 rows.
- `catchem_founder_candidates.xlsx`, Candidates sheet: 30 rows.
- Four duplicate identities merged by matching LinkedIn URLs or GitHub profile URLs; shared repository URLs alone never merge co-founders. All 124 original source rows and fields remain attached to 120 imported profiles.
- Ani (Anirudh Manjesh): one additional profile from the user-linked LinkedIn page and user-relayed Claire conversation. Total: 121 profiles.
- Five network contacts: Ani (user-confirmed) plus four synthetic assignments requested by Noah. Lei Liu is explicitly external.
- Ani's signals: card trading and building startups at Afore Capital, attributed to the Claire conversation relayed by Noah. Do not treat school age as a scoring feature.
- Lei's profile is the workbook row for `linkedin.com/in/liu-lei`; his dialogue adapts Noah's supplied conversation into an agent exchange.
- Ani's reply status is supplied by Noah; the wording in the prototype is a fixture, not an actual transcript.

`scripts/demo/import-catchem.py` is not used at runtime; run it with the bundled Python environment (openpyxl). It reads the provided local paths without modifying the inputs. Raw workbook hyperlink error strings are preserved in source records and converted into working links in the normalized view.

## Walkthrough

1. Start with the prefilled prompt on New search, then Find candidates.
2. Review the ranked table. Network badges sit with the names. Open a profile for fit breakdown, evidence, source fields, and verification points.
3. Refine with the agent: “Show my network”, “Prioritize graded cards”, “Prioritize founders”, “Show Lei Liu”, or “Set up a sequence”. This is a deterministic intent mapper, not a live LLM.
4. Sequence defaults to all 121 profiles unless the user explicitly selected a subset. Editable introduction and two follow-ups use first-name and evidence placeholders.
5. All 121 candidates are already contacted on initial load, refresh, or Start over. Lei and Ani replies are preloaded. Saving a sequence preserves contact and reply history.
6. Full-audience metrics: 121 reached, 2 replies, 1 interested, 1 meeting arranged/rescheduled, 128 outbound messages including the conversation exchanges, 119 awaiting replies, 1.7% reply rate.
7. Run next follow-up affects only non-responders. The two respondents remain excluded. Inbox tabs and metric clicks filter the same campaign state.
8. Lei's meeting is conversation-reported and rescheduled to Monday; no exact date or timezone is invented and no real calendar event is created.
9. Start over resets the search and restores the already-contacted baseline (121 contacted, Lei and Ani replied). Data remains local to the browser.

## Code map

- `apps/dashboard-web/src/App.tsx`: selects the Catchem surface; retains the local-only auth wrapper.
- `apps/dashboard-web/src/pages/CatchemDemo.tsx`: search, ranked table, profile drawer, refinement, sequence, inbox, and analytics.
- `apps/dashboard-web/src/pages/catchem-demo.css`: scoped responsive styling.
- `apps/dashboard-web/src/pages/catchem-demo-model.ts`: ranking, refinement, personalization, reply fixtures, campaign metrics.
- `apps/dashboard-web/src/pages/catchem-candidates.ts`: normalized rows, original source records, and import counts.
- `apps/dashboard-web/src/pages/catchem-demo-model.test.ts`: source reconciliation, ranking, reply counts, network semantics, full-audience metrics.
- `apps/dashboard-web/src/lib/local-hire-preview.ts`: loopback `/hire` route guard; App also requires `import.meta.env.DEV`.

## Ranking and boundaries

Default weights: technical work 25, venture/shipped product 30, cards 25, launch/leadership 15, Web3 bonus 5. Alternative ranking modes reweight those same dimensions. Scores are provisional evidence summaries, not probabilities or a hiring decision. Graduation year, school, age, original fit score, network status, and replies do not affect the new score. Unknowns remain verification points. Source claims were not all re-researched.

Do not deploy the imported profiles or private conversation fixtures as part of routine local UI work. Source data, fictional dialogue, and local metrics do not authorize real outreach. Keep existing candidate/admin domains and backend authorization boundaries intact.

## Validation

```bash
source ~/.zshrc && nvm use 24
pnpm --filter dashboard-web exec tsx --test src/pages/catchem-demo-model.test.ts src/lib/local-hire-preview.test.ts
pnpm --filter dashboard-web build
```

Browser checks cover source-to-table loading, five network contacts, Ani's Claire signals, Lei's external status, editable outreach, two inbox replies, matching funnel counts, and the local auth boundary. The Metix macOS-role workspace was reviewed read-only for role navigation, candidate evaluation, outreach timeline, and conditional reply handling.
