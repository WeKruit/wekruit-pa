# Note — ATS user-creation pivot + email login + LinkedIn binding

**Captured:** 2026-05-12
**Source:** Adam (post-v1.9 ship)
**Affects:** Phase 86 (ATS inbound adapter) — REQ-IDs ATSADAPTER-05, ATSADAPTER-06, signup auth flow.

## Requirement update

Shift ATS user creation from per-applicant webhook → dashboard bulk-upload flow.

### New flow

1. **Dashboard bulk-upload page** — operator uploads N resumes at once.
2. **Per-resume pipeline:** parse + enrichment (reuse `pa-resume-parser` v2).
3. **Extract email from resume body** — that becomes the canonical user identity.
4. **Auto-create `pa-users`** keyed by extracted email.
5. **Candidate login flow:** user signs in via their resume email (any provider — Gmail / Outlook / Yahoo / iCloud / corporate, etc.) → sees their own pre-uploaded resume.

### LinkedIn change

- **Cancel LinkedIn registration** (no LinkedIn-as-signup-provider).
- **Allow LinkedIn binding post-email-signup** — user signs in with email first, then optionally connects LinkedIn to enrich profile data.

## Implications for v2.0 backlog

- Drop ATS-webhook-as-user-creation path (Phase 86 ATSADAPTER-05 partially obsoleted).
- Add: `/admin/bulk-resume-upload` dashboard page.
- Add: candidate-side login UI (any-provider email auth via Firebase Auth email-link / OAuth).
- Add: per-user "Connect LinkedIn" CTA post-signup.
- Resume binding becomes synchronous (operator-driven bulk) instead of async (webhook-driven).
- Email match strategy: case-insensitive, multi-resume-per-email (rebind latest).

## Open questions for next milestone planning

- Should the bulk upload accept ZIP / folder of PDFs, or one-by-one?
- What's the "claim my resume" gate — passwordless email link? Magic SMS?
- Where does LinkedIn binding fit on the candidate journey (post-prescreen? always available?)
