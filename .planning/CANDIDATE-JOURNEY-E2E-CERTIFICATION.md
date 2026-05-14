# Candidate Journey E2E Certification

Goal: prove the public candidate journey works from the user's perspective before calling any sprint done.

## Scope

1. Home page at `https://candidate.wekruit.com/` shows the candidate app shell and live job list.
2. Job detail at `https://candidate.wekruit.com/j/<jobId>` uses the same candidate UI system as home.
3. Job detail shows the `WeKruit collaborated` badge for collaborated roles.
4. Signed-out users can read the role but cannot open iMessage.
5. Signed-out users are prompted to sign in from the role page.
6. Google login returns to the exact job detail route and unlocks iMessage.
7. LinkedIn login returns to the exact job detail route and unlocks iMessage.
8. Email magic link returns to the exact job detail route and unlocks iMessage.
9. `Open in iMessage` opens the correct `sms:` URL with job-scoped Claire text.
10. Sending the iMessage creates or attaches the expected pending invite and prescreen session.
11. Candidate profile and matches pages reflect the authenticated candidate state.
12. Firestore/log evidence confirms the same candidate id is used across auth, job, and prescreen.

## Evidence Gate

Do not mark complete from screenshots alone.

Each run must record:

- exact URL tested
- signed-out browser screenshot
- login provider used
- post-login returned URL
- visible post-login UI state
- `sms:` URL payload
- relevant Cloud Functions log lines
- Firestore ids for candidate, pending invite, and prescreen session

Stop at the first customer-visible divergence and fix that before continuing the checklist.

