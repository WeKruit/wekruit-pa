# Manual Smoke — Dynamic Typing Dwell (Phase 24 T1E)

## What to verify
Sendblue typing indicator dwell scales with reply length. Visible 1-4s "..."
animation before bubble arrives, longer for longer replies.

## Setup
1. Deploy CF: `pnpm -C apps/functions deploy`
2. Confirm `PA_TYPING_INDICATOR=1` in functions env
3. Confirm `PA_TYPING_DWELL_MS` is UNSET (or 0/empty) so dynamic computation kicks in

## Test cases
Send messages from sandbox iMessage line that elicit different reply lengths:

### Case 1: short reaction (≤30 chars expected)
Send: `lol`
Expected reply: short like `干嘛.` or `咋了.`
Expected dwell: ~1s typing animation
PASS criterion: typing visible briefly, bubble arrives < 2s after typing starts

### Case 2: medium reply (31-100 chars expected)
Send: `我又被拒了 emo 中`
Expected reply: anchor case `拒得快说明他们没准备好你. next.` (~21 chars — actually case 1 band)
Expected dwell: ~1s
Alt input for case 2: `你能帮我看下这个 JD 吗 感觉有点 mid 但是 base 还行`
Expected reply: medium ~80 chars
Expected dwell: ~2s

### Case 3: long technical (>200 chars expected)
Send: `详细解释一下 OPT 转 H1B 的时间线`
Expected reply: long technical 200+ chars
Expected dwell: ~4s
PASS criterion: typing animation persists noticeably longer than case 1

### Case 4: env override sanity
Set `PA_TYPING_DWELL_MS=500`, redeploy.
Send any message.
Expected dwell: always 500ms regardless of reply length.
PASS criterion: env override takes precedence over computed value.

## Anti-test (no double-bubble)
During all 3 cases, verify only ONE assistant bubble appears per reply
(no race between typing animation and send producing duplicates).

## Rollback
Set `PA_TYPING_INDICATOR=0` (disables typing entirely).
