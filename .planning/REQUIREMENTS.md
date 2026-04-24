# Milestone requirements (PA Console + Mac worker)

## P0 — Must have

1. **Worker liveness**  
   - Today the macOS worker is **Node-only** (no HTTP).  
   - Add a **small HTTP health endpoint** on the Mac (e.g. `GET /health`) and optional **nginx** (or Caddy) in front for consistent URL / TLS off (local).  
   - Operator or dashboard can tell **“is the same class of process that runs locally”** = process up + health returns 200.

2. **Dashboard → send test message (E2E)**  
   - From PA Console, trigger a path that results in **outbound iMessage** (or clearly defined `pa_outbound` → worker → sent) and visible **success/failure** in UI or Firestore-backed status.  
   - Close the **POC gap**; document manual steps if automation is partial.

3. **Agent model: registration-only**  
   - **Remove or hide** “Agent Builder” as a product surface.  
   - Keep **agent registration**: select/register agents backed by **OpenAI** (or pre-defined configs) and **invoke** from the pipeline.  
   - **Not** in scope: Mem0/LOM **hosting** as a deliverable; optional spike only.

## P1 — Should have

- **Tests** for non-Mac parts (Firestore writes, client flows); **manual runbook** for full Mac + iMessage.  
- **Self-host Mem0** = future milestone unless explicitly pulled in.

## Out of scope (this milestone)

- Full Agent Builder UX, multi-tenant IAM, HA Mac, production Mem0.
