# S3 — PLAN

1. AGENT_PLAN.md
2. Firestore schema migration script (idempotent) + tests
3. `paVoiceDialOutbound` Firestore trigger CF + LiveKit room create + SIP dispatch
4. Caller-ID rotation logic + test
5. `sipWebhook` HTTP CF for Twilio + LiveKit status callbacks + idempotency
6. State-machine reducer + invalid-transition rejection
7. Dial dry-run against internal dev number (manual, capture in SUMMARY)
8. Regression gate
9. Push, SUMMARY.md, report
