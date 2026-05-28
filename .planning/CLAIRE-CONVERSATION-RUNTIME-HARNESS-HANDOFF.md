# Claire Conversation Runtime And Harness Handoff

Date: 2026-05-27

Branch for this handoff: `codex/claire-runtime-harness-handoff`

Base: `origin/main` at `fc26e04fdf6f9c6b0b7bb8bb23c2b10842a109af`

## Purpose

This handoff captures the state after the saved-preference recall work and the follow-up production investigation. It is meant to give the next session enough context to continue with the bigger runtime issue: Claire can sometimes remember and explain preferences, but the full conversation-to-preference-to-matching loop is not unified.

This PR is intentionally a handoff and audit artifact. It does not claim the remaining issues are fixed.

## What Is Already On Main

| Area | Main status | Evidence |
| --- | --- | --- |
| Conversation turn arbiter | Present on `origin/main` | `packages/pa-orchestrator/src/conversation-turn-arbiter.ts` |
| Conversation action arbiter | Present on `origin/main` | `packages/pa-orchestrator/src/conversation-action-arbiter.ts` |
| Arbitration fixture harness | Present on `origin/main` | `tests/scenarios/conversation-arbitration/` |
| Conversation experience scenarios | Present on `origin/main` | `tests/scenarios/conversation-experience/` |
| Live conversation eval harness | Present on `origin/main` | `scripts/eval-conversation-experience.mjs` |
| Turn arbitration audit script | Present on `origin/main` | `scripts/audit-turn-arbitration.mjs` |
| Saved-preference recall trace | Present on `origin/main` | PR #237, merged as `b7b4b1ef` |
| Saved-preference human wording | Present on `origin/main` | PR #238, merged as `dedaae94` |
| Saved-for-matching detection | Present on `origin/main` | PR #239, merged as `fc26e04f` |

## Production Observations From The Live Thread

Test number used: `+1 (717) 491-9939` candidate-facing Claire line.

The visible saved-preference reply is fixed for the tested recall phrasing:

> "What do you have saved for matching right now?"

The resulting production turn had:

| Surface | Observed result |
| --- | --- |
| `pa-messages` inbound | `role="user"` |
| `pa-messages` outbound | `role="assistant"` |
| `pa-outbound` | `runtimeApproved=true`, `status="sent"`, Sendblue delivered |
| `pa-turn-traces` | `status="completed"`, owner `explicit_explanation`, action `answer_then_continue` |
| `outboundSource` | `saved_job_preferences_summary` |
| LLM eval | Passed continuity, context use, human feel, answer-first |

That closes the narrow recall issue. It does not close the full runtime.

## Current Bigger Gaps

| Gap | Symptom | Root cause | Required direction |
| --- | --- | --- | --- |
| Preference memory and matcher input are split | Claire says product/strategy, but matcher uses old SWE/internship tags | Multiple stores exist without one canonical profile contract | Collapse conversation answers, evidence, tags, and matching inputs into one canonical candidate matching profile |
| Conversation-to-preference save is not unified | Some preferences are in `sharedOnboarding.answers`, some in `statedPreferences`, some in `conversationDerivedPreferences`, some in `tags` | Each flow writes its own structure | All user preference changes should emit structured evidence writes with set/append/remove/clarify operations |
| Matcher reads stale tags | Live matcher queried with `targetRoleFunction=["software_engineering"]` and `targetJobType=["internship"]` even after product/strategy preference | `pa-users.tags` is treated as authoritative even when newer conversation evidence exists | Matching must read the canonical profile or run projection before query |
| Tag operations are too weak | "product/strategy only" does not reliably remove software-engineering/internship constraints | Current extraction does not support robust append/update/delete semantics by source and recency | Implement evidence operations and deterministic projection conflict rules |
| Tapback policy is too broad | Substantive questions and job-search requests get heart tapbacks | `paMessageCoalescer` has a random love tapback path outside the semantic delivery action | Move reaction choice under delivery action; cap low-stakes random tapbacks at 30%; suppress substantive turns |
| Read receipt is missing | Claire does not visibly "read" the message before replying | Sendblue `mark-read` is not called | Add Sendblue mark-read API call after inbound coalescing for iMessage/RCS |
| Job-search trace stays incomplete | Live job-search traces were stuck at `owner_arbitrated` after outbound sent | Direct job-search path sends messages but does not finalize the arbiter trace | Complete the trace after status/tool/result reply |
| Matching tool ledger is missing | Matching ran, but `pa-tool-calls` had no row | Matcher is not wrapped as a traced tool call | Record matching as a tool call with input profile, filters, result count, and selected jobs |
| No-match UX is not human enough | Claire says "didn't find much yet" without explaining what happened | No-match reply composer ignores hard-filter counters and previous recommendation history | Explain no-match cause or ask a clarifying question using actual filter output |
| Eval is transcript-heavy | Recall eval passed even while matcher state was stale | Harness grades visible answer but not state projection and matcher input | Eval must assert evidence -> profile -> matcher input -> tool result -> outbound |

## Important Existing Stores

| Store | Current role | Problem |
| --- | --- | --- |
| `sharedOnboarding.answers` | Natural onboarding answers | Useful evidence, not a canonical matching input |
| `statedPreferences` | Normalized preference snapshot | Can diverge from `tags` and conversation-derived state |
| `conversationDerivedPreferences` | Conversation-derived facts and profile updates | Underused by matcher and recall paths |
| `pa-users.tags` | Current V16 matcher input | Too broad and stale; resume-derived tags can override newer conversation preferences |
| `prescreenEvidenceByJob` | Job-specific prescreen evidence | Should not be mixed into global preference unless explicitly projected |
| `pa-conversation-evidence` | Intended evidence ledger | Missing or underused on live paths |
| `pa-job-profiles` | Subscription/status metadata | Not the matching profile |
| Runtime `roleFocus` args | One-off match hints | Not persisted consistently and not enough for durable preferences |

## Target Runtime Contract

The next implementation should make this the single path:

| Step | Required output |
| --- | --- |
| Inbound received | User transcript row, turn id, raw Sendblue message handle |
| Read marker | Best-effort Sendblue mark-read call for iMessage/RCS |
| Intent framed | Owner/action decision with rejected owners/actions |
| Preference extraction | Structured evidence writes before matching |
| Preference projection | One canonical candidate matching profile |
| Delivery decision | `no_response`, `tapback_only`, `micro_ack`, `status_then_async_tool`, `tool_result_reply`, etc. |
| Tool execution | `pa-tool-calls` row for matching and other tools |
| Reply composition | Answer grounded in profile/tool output |
| Trace completion | `pa-turn-traces.status="completed"` with evidence ids, tool ids, outbound ids, and no-match reason |

## Canonical Preference Profile Direction

The core design should be one canonical matching profile, not many competing tag systems.

Suggested shape:

| Field group | Examples | Notes |
| --- | --- | --- |
| Role functions | `product_management`, `business_analyst`, `software_engineering` | Supports add/remove and negative role functions |
| Role focus | product strategy, technical product, product ops, fullstack product engineering | Human-level labels can map to canonical tags |
| Job type | full-time, internship, contract | Newer explicit preference should override stale resume inference |
| Location | SF, remote US, NYC, no relocation outside chosen areas | Include hard/soft strength |
| Industry | AI/devtools/fintech, avoid adtech/crypto | Positive and negative lists |
| Company stage | early startup, scale-up, high ownership, not chaotic | Store as preference evidence, not raw text only |
| Constraints | visa, compensation, start date, work mode | Must be clear hard/soft constraints |
| Evidence metadata | source turn, message id, confidence, timestamp, operation | Needed for replay and conflict resolution |

Do not make matcher read three different preference systems. Either matcher reads the canonical profile directly, or `tags` becomes a derived projection with a single projector that is tested.

## Tapback And Read-Receipt Plan

| Behavior | Current | Required |
| --- | --- | --- |
| Random love tapback | `paMessageCoalescer` has a broad random tapback path | Cap at 30% and restrict to low-stakes eligible turns only |
| Substantive questions | Can still get heart tapbacks | Suppress automatic tapbacks |
| Short ack after status | Action arbiter supports `tapback_only` | Keep, but only when the agent/delivery action selects it |
| Read receipt | Not wired | Add Sendblue mark-read call |

Sendblue read receipt docs:

`POST https://api.sendblue.com/api/mark-read`

Required body:

```json
{
  "number": "+14155551234",
  "from_number": "+19175551234"
}
```

Notes from Sendblue docs:

| Constraint | Meaning |
| --- | --- |
| iMessage/RCS only | Does not apply to SMS |
| Account enablement required | Sendblue engineering must enable read receipts for the account |
| Best effort | No confirmation that recipient device rendered read state |
| Recent messages work best | Should be called quickly after inbound |

Reference: https://docs.sendblue.com/api-v2/read-receipts/

## Job Search Failure From Live Probe

Live request:

> "Can you recommend me some roles?"

Observed:

| Surface | Result |
| --- | --- |
| Claire status bubble | "Checking the latest roles now." |
| Claire result bubble | "hmm didn't find much yet ..." |
| Trace status | `owner_arbitrated`, not `completed` |
| `pa-tool-calls` | Empty |
| Matcher output | 500 jobs loaded, 0 passed hard filters |
| Main stale inputs | `targetRoleFunction=["software_engineering"]`, `targetJobType=["internship"]` |
| Hard-filter drops | location 193, careerStage 162, jobType 145 |

This means the match process did not merely "find no jobs." It searched with stale profile inputs and failed to tell the user why.

## Required No-Match Behavior

When no jobs are found, Claire should respond like a normal recruiter:

| Runtime fact | Reply behavior |
| --- | --- |
| Stale profile suspected | Say which preference needs confirmation before searching again |
| Hard filters zero out corpus | Mention the main blocker in candidate language |
| Previous recommendations exist | Refer to prior batch and ask whether to widen/shift |
| No public links for matches | Explain that there are possible fits but no sendable posting yet |
| Tool error | Say the search did not complete and that Claire will retry, not "no matches" |

Bad:

> "hmm didn't find much yet"

Better:

> "I checked, but your profile is still filtering as SWE internships, which conflicts with the product/strategy direction you just gave me. I should update that first, then search again."

## Harness Requirements

| Harness layer | Required assertion |
| --- | --- |
| Unit | Preference extraction supports set, append, remove, clarify |
| Fixture | "product/strategy only, not SWE" updates profile before matching |
| Scenario | Saved preference recall and role search read the same canonical profile |
| Firestore audit | Evidence write, profile projection, tool call, trace, outbound all link by turn id |
| Live iMessage smoke | Read receipt sent, no inappropriate tapback, status bubble, tool-result bubble |
| LLM judge | Human feel and no-match clarity |
| Deterministic judge | Matcher input cannot contain stale removed role/job-type constraints |

## Concrete Test Cases To Add

| Case | Expected |
| --- | --- |
| "Not software developer roles. Product and strategy only." | Evidence remove `software_engineering`, append product/strategy role functions |
| "Can you recommend me some roles?" after that | Matching input uses product/strategy, not stale SWE/internship |
| "Sure" after status bubble | Tapback only or no-response, trace completed |
| "What do you have saved for matching right now?" | Recall uses canonical profile, not separate onboarding summary |
| No jobs because of filters | Reply explains the blocking filter or asks permission to widen |
| Matching tool throws | Reply says search had a problem, trace records tool error |
| Substantive question | No random heart tapback from coalescer |
| Inbound iMessage | Mark-read API attempted and recorded best-effort result |

## Files Likely To Touch Next

| File | Why |
| --- | --- |
| `packages/pa-orchestrator/src/conversation-action-arbiter.ts` | Delivery action policy and tapback/no-response decisions |
| `apps/functions/src/coalesce/paMessageCoalescer.ts` | Broad random tapback suppression and read receipt timing |
| `apps/functions/src/sendblue/` | Add Sendblue mark-read API wrapper |
| `packages/pa-orchestrator/src/index.ts` | Job-search trace completion and tool-call linkage |
| `apps/functions/src/orchestrator-deps.ts` | Matching tool wrapper and profile input handling |
| `packages/pa-orchestrator/src/conversation-extractor-runtime.ts` | Structured preference extraction path |
| `packages/core-types/src/collections.ts` | Canonical collection/path constants if needed |
| `scripts/eval-conversation-experience.mjs` | State/profile/matcher assertions |
| `tests/scenarios/conversation-arbitration/` | Owner/action/evidence fixtures |
| `tests/scenarios/conversation-experience/` | End-to-end scripted scenarios |

## Suggested Acceptance Gates

Run with Node 24.

```bash
source ~/.zshrc && nvm use 24
node --import tsx --test \
  packages/pa-orchestrator/src/conversation-turn-arbiter.test.ts \
  packages/pa-orchestrator/src/conversation-action-arbiter.test.ts \
  tests/scenarios/conversation-arbitration/arbiter-fixtures.test.ts
```

```bash
source ~/.zshrc && nvm use 24
PA_RUN_EVAL=1 node tests/scenarios/runner-local.mjs tests/scenarios/conversation-experience
```

```bash
source ~/.zshrc && nvm use 24
npm run test --workspace=@pa/pa-orchestrator
npm run test --workspace=@pa/functions
npm run build
```

Production proof after deploy:

| Step | Required proof |
| --- | --- |
| Send "not SWE, product/strategy only" | Evidence write and canonical profile update |
| Send "what did you save?" | Reply matches canonical profile |
| Send "recommend roles" | Matcher input uses canonical profile |
| If no jobs | Reply explains actual blocker and asks a useful next question |
| Firestore | `pa-turn-traces` completed, `pa-tool-calls` present, outbound linked |
| Messages UI | Read marker behavior if enabled, no inappropriate tapback |

## Do Not Treat These As Done

| Item | Reason |
| --- | --- |
| Saved-preference recall | Only proves Claire can answer memory questions |
| Green local unit tests | Do not prove production profile projection or Sendblue behavior |
| `pa-turn-traces.status="owner_arbitrated"` | This is a midpoint, not completion |
| Random tapback pass | Randomness is not a conversational policy |
| No-match response | Must explain real reason or recover, not hide tool/profile bugs |

## Summary For Next Session

The next session should not patch one stale tag. The correct fix is to make conversation-derived preference evidence the input to one canonical matching profile, make matching read that profile, and make the harness fail whenever Claire's spoken memory and the matcher input disagree.

The smallest complete implementation is:

1. Add mark-read and restrict tapbacks.
2. Wrap job matching as a traced tool call.
3. Complete job-search turn traces.
4. Add structured preference operations for add/update/remove.
5. Project those operations into one matching profile before job search.
6. Upgrade no-match copy using actual matcher counters.
7. Add a production-state eval that checks transcript, evidence, profile, tool call, trace, outbound, and visible Messages behavior.
