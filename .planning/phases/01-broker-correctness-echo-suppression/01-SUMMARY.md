# Phase 1 Summary: Broker correctness + echo suppression

## Completed

- Added `shouldAppendOutboundTranscript` and tests for broker-managed outbound suppression.
- Prevented `out-imessage-in-*` replies from being appended as operator/user transcript messages.
- Verified fresh local iMessage processing used the OpenAI LLM path after stale runner cleanup.
- Confirmed no duplicate assistant-as-user echo in inspected Firestore message history.

## Verification

- Worker test suite passes.
- Root `npm test` passes.
- Workspace build and typecheck pass.
- Worker health endpoint reports healthy after restart.

## Deferred

- Official target slug is `gpt-5.4-nano`; the earlier failed probe used the wrong `gpt5.4nano` string, so the official slug still needs a runtime probe.
- ATM default profile still returns `Unsupported runtime profile "personal-assistant-default"`.
