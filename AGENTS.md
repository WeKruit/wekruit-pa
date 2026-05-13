# AGENTS.md

Operating contract for non-Claude coding agents (Codex, Cursor, Aider, Continue, GPT-4-based agents). `CLAUDE.md` is the canonical source. Codex + Cursor that support the `@filename` import directive should follow the import. Other agents: read both files; rules in `CLAUDE.md` apply.

@CLAUDE.md

---

## Critical TL;DR (do not violate)

1. **Deploy directly when code changes** — do not tell Adam to deploy himself. Auth via `FIREBASE_SERVICE_ACCOUNT_JSON` in `.env`. See `CLAUDE.md` § "You CAN and MUST deploy".
2. **Domain split is locked** (2026-05-13):
   - **C-end (candidates)** = `candidate.wekruit.com` + `pa.wekruit.com` + `wekruit-pa-landing.web.app`. Served by `apps/pa-landing` Vite SPA. Routes: `/`, `/legal`, `/j/:jobId`, `/j/:jobId/cv`.
   - **Admin only** = `wekruit-pa.web.app`. Served by `apps/dashboard-web`. Routes: `/admin/**`. Requires `@wekruit.com` Google sign-in.
   - **Never** put candidate routes on the admin site, or create a new Firebase Hosting site for candidate work. `wekruit-candidate` site was created + deleted 2026-05-13 — it is gone.
3. **Verify before claiming done** — run scenario tests + read actual replies. Adam directive: "你需要做测试，每个 playbook 测试看看是否真的生效".
4. **Test guide source of truth** — `.planning/V19-FULL-FLOW-TEST.md`. Always use `https://candidate.wekruit.com/j/<jobId>` URLs; never `wekruit-pa.web.app/j/...` (which only 301s now).
5. **v2.0 product direction is locked** — WeKruit is a C-end candidate retention marketplace, not just a job page, pre-screen bot, or employer ATS. Candidate profile is the durable asset; job is a demand event. New jobs must activate retained candidates through matching + outbound + first interview.
6. **Global candidate profile** — mem0, tags, PII, Level 1 info, YoE, industry, salary range, location preference, visa, company size, resume, LinkedIn, and conversation-derived preferences are global per candidate. Job-specific data is only match/outbound/prescreen/outcome/employer-visible snapshot.
7. **First interview is never blocked by match score** — once a candidate enters a job flow, Claire gives the first interview. NOT_PASS keeps the candidate in the global pool.
8. **Employer surface is passed-profile-only** until Adam explicitly expands scope. Do not build broad employer candidate browsing, scheduling, notes, or message-on-behalf-of.
9. **Tagging + matching + eval flywheel are part of the product** — user tags and job tags share the canonical vocab in `packages/shared-tags`; job enrichment, user tagging, matching repo changes, HITL corrections, simulation, QA, and regression must be designed together.

See `README.md` for the canonical **Product Blueprint: Candidate Retention Marketplace**. See `.planning/MILESTONE-v2.0-candidate-retention-marketplace.md` for the sprint roadmap. See `.planning/AUTONOMOUS-SPRINT-HARNESS.md` before running `/goal` or autonomous executor teams. See `.planning/V2-GOAL-PROMPT.md` for the overall `/goal` prompt. See `CLAUDE.md` for the full v1.6 design lock, deploy authority, milestone state, roadmap, and matching v2.0 product lock.
