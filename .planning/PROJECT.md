# Jobless / PA Platform

Monorepo: Mac **Photon iMessage worker** + Firestore **`pa_*`** + **PA Console** (Vite, `wekruit-pa.web.app`). Auth: Google; Firestore rules: `@wekruit.com` + allowlisted Gmail (see `config/firebase/firestore.rules`).

## Current milestone (brownfield)

**Goal:** Finish a **demoable E2E**: operator sees **worker liveness** (local reverse proxy + health), sends a **test message from the dashboard** through the **real pipeline**, and uses **agent registration only** (no Agent Builder product). Mem0 / heavy memory is **out of scope** until core path is green.

See `REQUIREMENTS.md`, `ROADMAP.md`, `STATE.md`.
