---
status: human_needed
---

# Phase 1 Verification

## Automated Verification

Passed:

```bash
npm run build
npm run typecheck
npm run test --workspace=@pa/macos-imessage-worker
npm run test --workspace=@pa/memory
npm run test --workspace=@pa/pa-safety
npm test
```

Evidence:
- Worker echo suppression tests: 2 passed.
- Memory tests: 5 passed.
- Safety tests: 3 passed.
- Root `npm test`: 10 tests passed across all current test-enabled workspaces.
- Local worker restarted and `GET http://127.0.0.1:8787/health` returned 200 with `outboundListener: true` and `imessageReady: true`.

## Human Verification

Needs one real inbound iMessage after the restart:

1. Send a fresh iMessage DM to this Mac account.
2. Confirm Firestore shows one inbound `user` transcript row and one assistant transcript row.
3. Confirm there is no second `role=user` row whose body equals the assistant reply.

## Notes

The earlier `gpt5.4nano` probe used the wrong model string and returned:

```text
404 The model `gpt5.4nano` does not exist or you do not have access to it.
```

Official target slug is `gpt-5.4-nano`; probe that exact slug before switching the live default.

Live default model was intentionally not changed.
