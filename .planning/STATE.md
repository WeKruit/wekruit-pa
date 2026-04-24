# Milestone state

- **N+1 (health + UX):** **Done in repo** — worker `GET /health` + CORS; Playground POC steps + optional `VITE_WORKER_HEALTH_URL`; Agents page renamed to **registry**; docs `config/MAC-WORKER.md`, `config/MEM0-SELF-HOST.md`.  
- **Deploy:** run `npm run deploy:hosting` (with `VITE_*` injection) to publish Console; `firebase deploy --only firestore:rules` already separate.  
- **Next (scope: no Mem0):** E2E on a **real Mac** — see `config/E2E-MAC-FIREBASE-DASHBOARD.md` (outbound + optional inbound DMs). Optional ngrok + `VITE_WORKER_HEALTH_URL` for the Playground health badge.
