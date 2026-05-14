# Goal Prompt: Candidate Journey E2E Certification

Use this prompt for the next `/goal`:

```md
Goal: fully certify the public candidate journey E2E.

Repo: /Users/adam/Desktop/WeKruit/wekruit-pa
Primary spec: .planning/CANDIDATE-JOURNEY-E2E-CERTIFICATION.md

Do not treat CI, screenshots, or page rendering as completion. The acceptance boundary is the real user journey on https://candidate.wekruit.com with browser evidence, auth return evidence, iMessage evidence, logs, and Firestore ids.

Rules:
- Candidate routes only: candidate.wekruit.com / pa.wekruit.com / wekruit-pa-landing.web.app.
- Admin routes only: wekruit-pa.web.app /admin.
- Use main as source of truth. If code changes are needed, commit, push to main, and deploy directly.
- Stop at the first customer-visible divergence, fix root cause, redeploy, then rerun the failed flow.
- Do not mark done unless every core flow in the spec passes with evidence.

Core flows to certify:
1. Home page job list.
2. Signed-out job detail gate for both Invoko jobs.
3. LinkedIn login return to exact job URL and iMessage unlock.
4. Google login return to exact job URL and iMessage unlock.
5. Email magic-link return and iMessage unlock.
6. iMessage handoff with correct sms: URL and job-scoped body.
7. Sent message attaches to correct candidate, pending invite, job, and prescreen session.
8. Resume upload attaches correctly.
9. /profile and /matches work for the authenticated candidate.
10. Desktop and mobile UI have no overlap, inconsistent styling, or blocked buttons.

Final output must be a PASS / FAIL / BLOCKED table with exact evidence paths, URLs, logs, and Firestore ids. No “should work.”
```

