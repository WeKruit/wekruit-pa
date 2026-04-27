# Voice v1 — source of truth (operator edits)

**Status:** Shipped with Phase 18. **Character anchor:** `CHARACTER-BIBLE-v1.md`  
**Research:** `.planning/phases/17-pre-launch-hardening/17-RESEARCH-*.md`

## Block A–C (default agent `systemPrompt`)

See **`18-VOICE-V1-BODY.md`** in this folder — that file is byte-identical to `packages/agent-registry/src/seed.json` → `default.systemPrompt` (version `2`). Edit BODY first, then re-sync seed (or paste JSON-escaped string).

## Block D (post-history reminder)

Canonical string lives in code:

- `packages/pa-orchestrator/src/voice-reminder.ts` → `VOICE_REMINDER_TEXT`

## Rollback

1. `PA_VOICE_V1_DISABLED=true` on orchestrator → legacy one-line system prompt + no reminder.  
2. If production agents in Firestore were published to v2, use dashboard rollback to v1 (Phase 5).
