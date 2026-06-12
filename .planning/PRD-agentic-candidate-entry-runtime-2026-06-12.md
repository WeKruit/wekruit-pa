# PRD: Agentic Candidate Entry, Memory, and Prescreen Runtime

**Status:** Draft for implementation planning  
**Date:** 2026-06-12  
**Owner:** WeKruit candidate runtime  
**Primary goal:** Every candidate-facing message after identity, resume, LinkedIn, recommendation, or prescreen entry is decided by Claire's agent runtime with the candidate's known context loaded. Transactional verification/control messages may stay deterministic; greetings, pitches, prescreen starts, prescreen endings, recommendation narration, and memory-aware follow-ups may not be context-blind sends.

---

## 1. Product Statement

When a candidate enters WeKruit from SMS, website login, Google/Gmail, LinkedIn, resume upload, public job page, external enrichment, or returning conversation, Claire should:

1. Recognize what WeKruit already knows about them.
2. Briefly pitch WeKruit in context.
3. Ask only for missing or fresh information.
4. Start or resume the right tool-backed workflow: profile enrichment, match search, prescreen, preference update, or review status.
5. Persist and reuse memory across later conversations, jobs, numbers, and sessions.

Example behavior:

> "You are signed in and I have your resume on file. I will use it to match you to roles, remember your preferences, and run the first screen for roles you choose. I see you mentioned product work at X before; anything new to add before I start this role's screen?"

Not acceptable:

> Re-ask for sign-in after LinkedIn login.  
> Re-ask for a resume immediately after resume upload.  
> Send a fixed prescreen opener that ignores a completed screen.  
> Write memory but never read it.

---

## 2. Non-Negotiable Design Rules

1. **Runtime owns conversation.** Candidate-facing content goes through the agent runtime except narrow transactional copy: verification code, STOP/START compliance, SMS deep-link control token, and transport errors.
2. **Tools own side effects.** Database reads, database writes, memory read/write, tag update, recommendation lookup, prescreen start, prescreen answer, prescreen terminal action, enrichment handoff, and pitch generation are explicit tools with structured inputs/outputs.
3. **Process integrity stays deterministic.** The LLM chooses and narrates; reducers commit idempotent state transitions.
4. **No blind first-turn.** First greeting/pitch after website sign-in or resume upload is still a runtime turn with context, not static page copy.
5. **Do not re-auth a signed-in candidate.** If Firebase auth, LinkedIn OAuth, Google/Gmail auth, magic link, or resume upload already established identity, Claire must not ask them to sign in again.
6. **Prescreen uses memory.** If prior conversation, tags, resume, LinkedIn enrichment, or prior screen answers already cover the question, Claire references that evidence and asks for additions or confirmation instead of starting from zero.
7. **mem0 must be read or removed.** The product reason for mem0 is durable recall. A write-only memory tool is not a product feature.

---

## 3. Current-State Gap Matrix

| Area | Current state | Gap | Fix size | Priority |
|---|---|---:|---:|---:|
| SMS prescreen/apply trigger evidence | `prescreen`/`apply` control texts are consumed inline by the webhook and historically did not create `pa-inbound-events` evidence. | Outbox RULE-1 can see "no prior inbound" for the exact person who just texted a valid token. | Small | P0 |
| Website first pitch | Candidate verify creates/claims profile and returns portal flags. | No first-class runtime event that says "candidate entered from website with auth/resume/linkedin evidence; pitch and choose next action." | Medium | P0 |
| Google/Gmail login | `/login` signs in via Google or magic link and calls candidate verify. | Verify does not guarantee a Claire runtime pitch; web flow can land in portal/job page without contextual conversation. | Medium | P0 |
| LinkedIn OAuth login | OAuth login exists and candidate verify detects `li_*` / `linkedinSignIn`. | OAuth profile is not enough by itself to guarantee canonical LinkedIn URL enrichment or Claire pitch. | Medium | P0 |
| LinkedIn connect URL flow | `paLinkedinConnectSubmit` links URL, can enrich via Coresignal, and can emit a runtime event for canary. | Behavior is path/canary specific and not unified with first-party website login. | Medium | P1 |
| Resume upload from public job | Inline job page says resume is saved/processing; legacy `/j/:jobId/cv` still says "Resume uploaded. You can close this tab." | Resume upload does not consistently trigger Claire's runtime pitch/start decision. | Medium | P0 |
| Coresignal enrichment | Admin/external-supply adapters, collect client, mirror, tag bridge, and experience merge exist. | First-party self-signup enrichment is not one unified product path tied to Claire's first pitch. | Medium/Large | P1 |
| Prescreen start | Trigger starts deterministic prescreen runtime. | Kickoff does not consistently load global profile/tags/memory/prior answers before asking Q1. | Large | P1 |
| Prescreen answer handling | Reducer commits answers; audit shows off-script text can be consumed as answers. | Need pre-reducer intent tool path: answer vs already-did-this vs question vs pause/exit. | Large | P1 |
| Prescreen ending | Terminal copy and terminal actions are partly deterministic. | Ending narration and per-layer next step should be agent/tool-backed and terminal-cause aware. | Medium | P1 |
| Preferences/tags | Write side exists for some axes. | Runtime context renders only part of saved tags; visa/salary/industry/company size can be missing from prompt context. | Small | P0 |
| Recommendation history | Matcher ledger exists. | Conversation context does not render compact roles-on-file/status/token availability. | Small | P0 |
| Conversation history | Current session transcript is loaded. | Cross-session/cross-number summary is missing for known users. | Medium | P1 |
| mem0 | `remember_fact` writes; audit says no read path. | No top-K memory retrieval in normal runtime, prescreen, or web-origin pitch. | Medium | P0 |
| Identity in-flight state | Candidate handles are read during inbound resolution. | Agent context does not read open verification/connect tokens; pre-bind users can be treated as strangers. | Medium | P1 |

### 3.1 Code-Audit Evidence

Read-only code audit classifies the website-origin surfaces as present but not runtime-complete:

- **Google/Gmail/LinkedIn login is partial.** `apps/pa-landing/src/pages/CandidateLogin.tsx` supports Google, LinkedIn, and email magic-link login. `apps/functions/src/candidate-magic-link-verify.ts` claims/creates the candidate and records LinkedIn OAuth markers, but normal login returns portal state only. It does not emit a Claire runtime pitch/enrichment handoff.
- **Public resume upload is partial.** `apps/functions/src/public-cv-ingest.ts` resolves the signed-in candidate and writes resume/profile state, but website upload uses `followupDeliveryMode: "none"`. `apps/functions/src/cv-ingest/cv-ingest.ts` only emits `resume_parse_completed` when delivery mode is runtime.
- **Phone/SMS connect is partial.** `apps/functions/src/connect-phone/connect-phone-start.ts`, `connect-phone-verify.ts`, and `apps/functions/src/identity/candidate-phone-link.ts` deliver and verify identity codes. They bind identity, but do not themselves create the initial Claire pitch runtime turn.
- **Coresignal/LinkedIn enrichment is partial.** `apps/functions/src/linkedin-connect/linkedin-connect-submit.ts` can enrich through Coresignal, mirror experience, dual-write tags, and emit runtime handoff, but the new enrich+emit path is canary-gated and tied to `/connect-linkedin`, not normal `/login` LinkedIn OAuth.
- **Initial Claire pitch is missing for normal website sign-in and upload.** The runtime handoff mechanism exists in `apps/functions/src/runtime-event-handoff.ts`, and the thin pitch path can fire for `resume_parse_completed`, but normal sign-in and public upload do not currently invoke it.

---

## 4. Required Entry Flows

### 4.1 Direct SMS "hi"

When a candidate texts Claire without a token:

1. Resolve candidate by handle and open verification/connect token state.
2. Load profile, resume, LinkedIn, tags, recommendation history, recent conversation summary, active/past prescreens, and mem0 top-K.
3. If authenticated/profiled, do not ask for login.
4. If not authenticated, Claire may pitch briefly and ask for the least-friction identity/profile action.
5. Response is emitted through runtime `send_message`.

### 4.2 Website Login: Google/Gmail/Magic Link

On successful candidate verify:

1. Emit `candidate_entry_completed` runtime event with:
   - `entrySource: google | email | magic_link`
   - `candidateId`
   - `registrationEntry`
   - `hasResumeOnFile`
   - `hasLinkedIn`
   - `senderNumber`
   - `jobIdContext` when entered from `/j/:jobId` or `/j/:jobId/cv`
2. Runtime loads context and sends first pitch/status.
3. If job context exists and profile is sufficient, runtime calls `start_prescreen`.
4. If profile is missing key info, runtime asks for the smallest missing item.

### 4.3 Website Login: LinkedIn OAuth

On successful LinkedIn login:

1. Candidate verify records LinkedIn OAuth identity on `pa-users`.
2. Runtime event fires immediately: `candidate_entry_completed` with `entrySource: linkedin_oauth`.
3. Coresignal enrichment is started through an enrichment tool/job.
4. First pitch does not wait indefinitely for enrichment. It says what is known now and what Claire is pulling.
5. When enrichment completes, emit `enrichment_completed` runtime event; Claire updates the candidate and asks for additions/corrections.
6. Do not ask the candidate to sign in again.

### 4.4 Website Resume Upload

On successful resume upload:

1. Ingest writes resume artifact and parse status.
2. Emit `resume_uploaded` runtime event with `candidateId`, `resumeArtifactId`, `jobIdContext`, and upload source.
3. Claire's runtime pitch acknowledges the upload and explains the next action.
4. If parse is still running, Claire says it is reading the resume and asks only for missing context that cannot be parsed.
5. Legacy "close this tab" dead-end is removed from the product path.

### 4.5 LinkedIn Connect URL

For SMS-origin one-tap LinkedIn connect:

1. Link canonical LinkedIn handle to the known candidate.
2. Start Coresignal enrichment.
3. Emit runtime event once URL is accepted, even if enrichment is still in progress.
4. Claire pitches from known data and later follows up when enrichment lands.

### 4.6 Prescreen Start

Before the first prescreen question:

1. Runtime calls `read_candidate_context`.
2. Runtime calls `read_prescreen_history(jobId)` and `read_recommendation_history`.
3. Runtime calls `read_memory`.
4. Runtime calls `start_prescreen(jobId, candidateId)` only after checking duplicate/completed/paused state.
5. The first question is adapted:
   - If resume/LinkedIn/tags already answer it, Claire cites the evidence and asks for additions or confirmation.
   - If prior answer exists for same topic, Claire asks "anything new to add?" instead of asking from scratch.
   - If evidence conflicts, Claire asks the candidate to resolve it.

### 4.7 Prescreen Ending Per Layer

Ending is a tool-backed runtime action:

1. Reducer produces terminal state: `PASS | NOT_PASS | HARD_STOP | PAUSE | NEEDS_REVIEW`.
2. Runtime calls `end_prescreen_terminal`.
3. Claire narrates terminal-cause-aware next step:
   - passed profile queued for review / employer-visible snapshot
   - not-pass but retained in global pool
   - pause/resume route
   - needs-review / waiting on WeKruit
4. No one-size "nice work" copy for every terminal cause.

---

## 5. Runtime Tool Contract

### Read tools

| Tool | Purpose |
|---|---|
| `read_candidate_context(candidateId)` | Profile, auth state, handles, resume artifact presence, LinkedIn state, tags, Level 1 fields |
| `read_memory(candidateId, query, limit)` | mem0/Qdrant top-K durable memories with evidence/confidence |
| `read_recent_conversation(candidateId, currentSessionId)` | Current session transcript plus cross-session summary |
| `read_prescreen_history(candidateId, jobId?)` | Active, completed, paused, pending-review screens and answers |
| `read_recommendation_history(candidateId)` | Roles sent, status, token availability, suppressed/rejected roles |
| `read_enrichment_status(candidateId)` | Resume parse, LinkedIn/Coresignal enrichment, conflicts, pending jobs |

### Write/action tools

| Tool | Purpose |
|---|---|
| `send_message(messages[])` | Only path for non-transactional candidate-facing text |
| `start_prescreen(candidateId, jobId, context)` | Idempotent start/resume decision |
| `record_prescreen_answer(sessionId, questionId, answer, evidence)` | Reducer-backed answer commit |
| `classify_prescreen_turn(sessionId, text, context)` | Answer vs question vs already-did-this vs pause/exit |
| `end_prescreen_terminal(sessionId, terminal, cause)` | Terminal commit + downstream side effects |
| `update_tags(candidateId, patch, evidence, confidence)` | Canonical tag update |
| `write_memory(candidateId, memory, evidence, scope)` | Durable memory write |
| `start_enrichment(candidateId, source)` | Resume/LinkedIn/Coresignal enrichment job |
| `create_candidate_entry_event(candidateId, source, context)` | Website-origin runtime entry |

### Tool-loop rule

One candidate turn should normally complete with:

1. Parallel read tools.
2. At most one process action tool.
3. One `send_message` action.

If more work is needed, commit a pending state and resume from a runtime event. Do not spin the agent in repeated wait loops.

---

## 6. Memory and Context Requirements

Claire must remember and reuse:

1. Preferences: role, function, job type, location, salary, visa, industry, company size, avoided roles/job types.
2. Resume facts: companies, titles, tenure, seniority, skills, impact, artifact presence/source.
3. LinkedIn/Coresignal enrichment: canonical LinkedIn URL, experience highlights, current role, conflict state.
4. Conversation facts: corrections, "do not ask again", timing preferences, interests, objections.
5. Prescreen answers: same-job and cross-job answers by topic.
6. Recommendation history: roles sent, status, token availability, ignored/declined roles.
7. Identity state: auth provider, phone binding, email, LinkedIn OAuth, pending verification/connect tokens.

Every runtime turn receives a compact context block. mem0 snippets are supplemental voice/evidence, not the matcher source of truth. Canonical tags remain the matcher input.

---

## 7. Acceptance Criteria

### P0: Stop Blocking Valid Initial Prescreen

- [ ] A valid `WeKruit_<jobId>_<userId>_Job` SMS creates completed inbound evidence before trigger dispatch.
- [ ] Outbox RULE-1 still blocks true no-inbound cold sends.
- [ ] The candidate who sent the token receives the prescreen opener/first question.
- [ ] Duplicate token delivery does not create duplicate normal onboarding turns.

### P0: Website First Pitch

- [ ] New Google login from `/login` receives a Claire runtime pitch and next action, not a sign-in request.
- [ ] New Gmail/magic-link login receives the same runtime pitch.
- [ ] New LinkedIn OAuth login receives a runtime pitch that acknowledges LinkedIn sign-in.
- [ ] Resume upload from `/j/:jobId/cv` and inline `/j/:jobId` emits a runtime event; no "close this tab" dead-end.
- [ ] Returning signed-in candidate sees status/next action, not a full re-introduction.

### P0: Context and Memory

- [ ] `loadGlobalContext` or replacement runtime context renders all saved preference axes.
- [ ] Recommendation history line shows roles on file and token availability.
- [ ] mem0 top-K read is available on normal runtime and prescreen runtime turns.
- [ ] Runtime never claims a resume artifact exists unless an artifact/source exists.

### P1: Prescreen Runtime

- [ ] Prescreen kickoff reads candidate context before Q1.
- [ ] If a prior resume/LinkedIn answer covers a question, Claire asks for additions/confirmation.
- [ ] Off-script text is classified before reducer answer commit.
- [ ] Pause/exit/already-did-this do not become scored answers.
- [ ] Terminal ending copy is terminal-cause aware and committed through `end_prescreen_terminal`.

### P1: LinkedIn/Coresignal

- [ ] LinkedIn OAuth and connect URL paths both bind candidate identity to the same `pa-users/{uid}`.
- [ ] Coresignal enrichment result updates candidate context and triggers Claire follow-up.
- [ ] Identity conflicts route to review and Claire says review is needed; no silent merge.

---

## 8. Implementation Plan

### Phase 0A: Incident Reliability

Ship the completed-inbound-evidence change for prescreen/apply trigger SMS, then repair the live blocked candidate message.

Files:
- `apps/functions/src/sendblue/webhook.ts`
- `apps/functions/src/sendblue/__tests__/webhook.test.ts`

### Phase 0B: Website Entry Runtime Event

Create one runtime event path for successful candidate verify and resume upload:

- `candidate_entry_completed`
- `resume_uploaded`
- `enrichment_completed`

Wire candidate verify, public resume upload, and LinkedIn login to emit the event. The event handler loads context and asks Claire to produce the pitch/next action.

### Phase 0C: Context Completion

Extend runtime context with:

- all tag axes
- resume artifact presence/source
- recommendation history
- Level 1 fields
- mem0 top-K read

### Phase 1A: Prescreen Context Bridge

Move prescreen kickoff and turns onto the same read-context toolset. Add `classify_prescreen_turn` before reducer answer commit.

### Phase 1B: LinkedIn/Coresignal Self-Signup

Unify LinkedIn OAuth, LinkedIn connect URL, and Coresignal enrichment under the same candidate-entry runtime events.

---

## 9. Open Questions

1. Should the first website-origin pitch be delivered by SMS only when a phone binding exists, and by in-app thread otherwise?
2. Should mem0 be enabled for all users immediately once read exists, or behind the same runtime cohort as the agentic entry event?
3. What is the exact employer-visible snapshot boundary after a PASS terminal in the new terminal narration?

These are product routing questions. The technical direction above does not depend on new compatibility paths.
