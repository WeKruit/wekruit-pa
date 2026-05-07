# Layer 3 — Real iMessage checklist (post-deploy)

Run against production Claire after a deploy that touches onboarding/orchestrator.

1. `PA_RESET` → English → reply **engineer** → **5** yoe → **Need sponsorship** → **either** startup → **USA**.
2. **q_location** → **Everywhere is fine** → must accept (no re-ask on “anywhere”).
3. Second location reply → **sfran or nYC works** → extract SF + NYC (or canonical equivalents).
4. PDF upload → ack → CV analysis → job recs mention parsed profile (e.g. companies/projects).
5. CV confirm → **yeah looks right** → state advances; follow-up chat behaves as complete user.

**Pass gate:** 5/5 with no unexpected deterministic re-asks and no duplicate CV wait spam in logs (`pa.onboarding.deterministic.cv_wait` ≤ 1 per attachment).
