# Conversation Experience Scenarios

Runtime-focused scripted scenarios for Claire's conversation action layer.

Run:

```bash
source ~/.zshrc && nvm use 24
node tests/scenarios/runner-local.mjs tests/scenarios/conversation-experience --dry-run
PA_RUN_EVAL=1 node tests/scenarios/runner-local.mjs tests/scenarios/conversation-experience
```

These scenarios reuse `runner-local.mjs` and assert action-trace behavior such as
tapback-only, answer-first, micro-ack, and async-tool status planning. Deep
Firestore mutation assertions live in `tests/scenarios/conversation-arbitration`.
