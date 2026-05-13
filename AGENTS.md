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

See `CLAUDE.md` for the full v1.6 design lock, deploy authority, milestone state, and roadmap.
