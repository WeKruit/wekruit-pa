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

The website path must converge with the existing direct-SMS product path:

- direct "hi" / QR / opener text starts the Claire thread
- LinkedIn or resume evidence is pulled in
- Claire briefly pitches the candidate from real evidence
- Claire offers the next action: pull roles, tweak the profile, or run the chosen role screen

The PRD must not introduce a new receipt-like website script such as "you are signed in and I have your resume on file." That phrasing is not the product. The product is Claire sounding like the same recruiter the candidate would meet after texting "hi" and connecting LinkedIn: she recognizes the person, shows the pitch she is using, then asks for the smallest missing/fresh input.

Not acceptable:

> Re-ask for sign-in after LinkedIn login.  
> Re-ask for a resume immediately after resume upload.  
> Send a fixed prescreen opener that ignores a completed screen.  
> Write memory but never read it.

---

## 2. Candidate Experience Contract

### 2.1 Reuse the Existing Pitch Posture

Website-origin entry must reuse the same pitch posture as the direct SMS path, not a separate website-auth receipt.

Existing pitch contract to preserve:

1. **Confirmation bubble.** A short acknowledgement of the source Claire just used:
   - LinkedIn-style: Claire pulled the candidate's experience from LinkedIn.
   - Resume-style: Claire read the resume and added technical detail to the pitch.
2. **Candidate pitch bubble.** A compact evidence-backed pitch, composed from structured profile data. It should show the candidate Claire sees them, not explain WeKruit's internal state. The current `composePitchTurn` shape is the source contract: strongest hiring signal, full-time YoE/seniority, industry/track, and adjacent roles.
3. **Action bubble.** A single clear next move:
   - pull roles that fit now
   - let the candidate tweak/add context
   - if a role context exists, continue into that role's Claire screen

Do not add a new deterministic "I have your resume on file / I will remember preferences" opener. Those ideas are internal capabilities; they should be expressed through the pitch and next action, not as product boilerplate.

### 2.2 Direct SMS UX

When the candidate starts by texting "hi" or an opener token:

1. If they are unknown, Claire briefly explains the value and asks for the least-friction profile input.
2. If they connect LinkedIn, Claire confirms the LinkedIn uptake, pitches them from the data, and offers to pull roles or add context.
3. If they later add a resume, Claire treats it as pitch improvement: acknowledge the resume, sharpen the pitch with concrete technical/detail evidence, then offer the next action.
4. The thread never becomes a form wall. If Claire needs target role or location, she asks one short conversational question.

### 2.3 Website Login + Resume UX

When the candidate signs in through Gmail/Google, LinkedIn, or magic link, then uploads a resume on the website:

1. Website auth establishes identity. Claire must not ask them to sign in again.
2. Resume upload establishes evidence. Claire must not ask them to upload a resume again.
3. The system emits a runtime entry event with enough context to run the same pitch turn used after SMS LinkedIn/resume uptake.
4. If a phone/iMessage thread is already bound and allowed, Claire can send the pitch proactively.
5. If no outbound-capable thread exists yet, the website must preserve a pending Claire continuation. When the candidate clicks "Talk to Claire" and sends the first message, runtime treats that message as a continuation of the signed-in profile/resume state and pitches as known, not as a stranger flow.
6. If resume parsing, LinkedIn import, or Coresignal enrichment is still in progress and the candidate sends "hi" / "what now?" / "Talk to Claire", Claire sends one short progress message instead of pitching from incomplete data: she is still pulling/reading their info, will use it to understand them first, and will continue when it lands.
7. When the enrichment finishes, the completion runtime event resumes the candidate entry flow: pitch/next action for general website entry, or prescreen Q1 for role entry.

The first Claire reply after website-origin signup should therefore feel like:

- "I read/pulled your background."
- "Here is the pitch/profile I would use."
- "Do you want me to pull roles or start this role screen?"
- If data is still loading: "I am still reading/pulling your background, one sec. Let me understand you first, then I will continue."

It should not feel like:

- "Please sign in."
- "Please upload your resume."
- "You are signed in and I have your resume on file."
- "Tell me everything again."

### 2.4 Website "Talk to Claire" Continuation

"Talk to Claire" is not just a link to a generic chat. It carries the candidate entry state:

1. `candidateId`
2. auth provider and identity confidence
3. resume artifact / parse status
4. LinkedIn OAuth/connect state
5. job or role context, if the click came from a job page or market card
6. whether a pitch has already been sent
7. whether Claire is waiting for target role, location, or a role-screen answer

On the first candidate message after this click, runtime must call the entry/pitch tools before normal triage. The response should resume from the website state:

- known + not pitched: run the pitch turn
- known + pitched + no role context: offer roles/tweaks
- known + pitched + role context: connect the pitch to the role and start/resume prescreen
- known + resume parse still pending: acknowledge the pending parse and ask only for missing context that cannot come from the resume
- known + LinkedIn/Coresignal enrichment still pending: acknowledge the in-progress import, avoid re-auth/re-upload asks, and wait for the completion event before pitching or matching from that evidence

### 2.5 Phone Binding and "No Re-Onboarding" UX

Website-origin candidates still need a Claire phone/iMessage thread when they click "Talk to Claire."

1. If the candidate already has a bound phone/Claire thread, open that thread and continue from the known profile.
2. If the candidate is signed in on the website but has no bound phone, "Talk to Claire" must create or route through a phone-binding step. The first Claire thread message must be attributable to the same `pa-users/{uid}`; it must not create a stranger profile.
3. A candidate who onboarded through phone, website login, LinkedIn, or resume upload must never be sent back to the cold onboarding wall after identity is bound.
4. Portal readiness can come from a verified Claire phone thread even without a resume. Resume is evidence, not the gate for "this is a known Claire user."

### 2.6 Role Prescreen UX: Screen First, Onboard After

For a role-specific "Talk to Claire" or prescreen trigger, Claire starts the role screen directly.

1. Do not block the first prescreen on LinkedIn login, resume upload, profile pitch, or broad onboarding.
2. Before Q1, Claire should still load known resume/LinkedIn/conversation evidence and adapt the role probe when evidence already exists.
3. If resume parsing or LinkedIn/Coresignal enrichment is actively in progress before Q1, Claire sends one short status message and defers Q1 until the completion runtime event. This is a prescreen-readiness hold, not onboarding and not a pitch.
4. When the completion event lands, Claire starts Q1 directly from the role screen. She does not send the general candidate pitch before Q1.
5. If prior evidence covers the role probe, Claire asks for additions/corrections/fresher details. If not, Claire asks the role's evidence probe directly.
6. When the prescreen ends, pauses, or the candidate stops, Claire transitions into the candidate-retention flow: "I can keep matching you to better-fit roles if you connect LinkedIn or send a resume."
7. The post-prescreen retention ask is conversational and optional. It is not a login wall before the role screen.

### 2.7 Post-Pitch Matching Subscription UX

After Claire pitches the candidate and the candidate says yes to matching:

1. Activate the job recommendation subscription.
2. Send matched roles on a 2-3 day cadence, not an every-turn spam loop.
3. Every outbound recommendation path must honor STOP / unsubscribe. If the candidate says "stop" or asks to pause job recommendations, pause the subscription and pending sends.
4. The pitch offer should ask one clear thing: whether Claire should pull/send matching roles now. Profile tweaks remain available, but they should not make "yes" ambiguous.

### 2.8 Prescreen Outcome UX

Claire must understand and explain downstream prescreen outcomes, not only the live Q&A screen.

1. **Rejected / not moving forward.**
   - A rejection can be initiated from dashboard review or by timeout.
   - If a WeKruit-team outcome update is still absent after 21 days, WeKruit auto-rejects rather than leaving the candidate in limbo.
   - The outbound rejection must include a comprehensive, personalized, evidence-backed reason.
   - Phrase the rationale as WeKruit team notes prepared to help pitch the hiring manager, not as an internal model score.
   - If the candidate asks later, Claire should consistently explain it as WeKruit team notes for the role.
   - If the candidate has not provided LinkedIn or a resume, Claire must invite them to add one so future collaboration roles can be pitched with profile context instead of making them repeat the whole prescreen from scratch.
   - If the candidate provides LinkedIn after rejection, the same LinkedIn/CoreSignal enrichment path should update the durable profile and future pitch context.
   - Rejection copy must ask whether the candidate wants matching recommendations from WeKruit; it must not silently start proactive matching without opt-in.
2. **Moved to next step.**
   - Claire should tell the candidate they moved forward and route them into interview scheduling.
   - If scheduling is already available for the role, Claire offers slots or schedules through the existing scheduling tools.
   - If a booking exists, Claire can answer interview time/status questions from booking context.
3. **Under review / waiting.**
   - Claire can explain that the first screen is with the WeKruit team, and that WeKruit uses this context to help pitch the hiring manager.
   - Claire should not imply pass/reject before the review state is final.

### 2.9 Context-Aware Status UX

Claire should answer operational questions using stored state before asking new questions:

1. "Did I schedule an interview?" -> read interview bookings and answer with time/status/role.
2. "Where am I with Invoko?" -> read prescreen sessions and candidate job status.
3. "What jobs have you matched me to?" -> read recommendation/match history.
4. "What happened with my previous screen?" -> read prior prescreen terminal/review/outcome state.
5. "Can you keep sending matches?" / "stop sending matches" -> read and update recommendation subscription state.

## 3. Non-Negotiable Design Rules

1. **Runtime owns conversation.** Candidate-facing content goes through the agent runtime except narrow transactional copy: verification code, STOP/START compliance, SMS deep-link control token, and transport errors.
2. **Tools own side effects.** Database reads, database writes, memory read/write, tag update, recommendation lookup, prescreen start, prescreen answer, prescreen terminal action, enrichment handoff, and pitch generation are explicit tools with structured inputs/outputs.
3. **Process integrity stays deterministic.** The LLM chooses and narrates; reducers commit idempotent state transitions.
4. **No blind first-turn.** First greeting/pitch after website sign-in or resume upload is still a runtime turn with context, not static page copy.
5. **Do not re-auth a signed-in candidate.** If Firebase auth, LinkedIn OAuth, Google/Gmail auth, magic link, or resume upload already established identity, Claire must not ask them to sign in again.
6. **Prescreen uses memory.** If prior conversation, tags, resume, LinkedIn enrichment, or prior screen answers already cover the question, Claire references that evidence and asks for additions or confirmation instead of starting from zero.
7. **mem0 must be read or removed.** The product reason for mem0 is durable recall. A write-only memory tool is not a product feature.

---

## 4. Current-State Gap Matrix

| Area | Current state | Gap | Fix size | Priority |
|---|---|---:|---:|---:|
| SMS prescreen/apply trigger evidence | `prescreen`/`apply` control texts are consumed inline by the webhook and historically did not create `pa-inbound-events` evidence. | Outbox RULE-1 can see "no prior inbound" for the exact person who just texted a valid token. | Small | P0 |
| Website first pitch | Candidate verify creates/claims profile and returns portal flags. | No first-class runtime event that says "candidate entered from website with auth/resume/linkedin evidence; pitch and choose next action." | Medium | P0 |
| Website "Talk to Claire" continuation | Site has CTAs and auth/profile state. | First user message after website login/upload is not guaranteed to resume the known candidate state and run the existing pitch turn. | Medium | P0 |
| Talk-to-Claire phone binding | Phone-code linking exists and portal readiness can use verified Claire phone threads. | Website-origin Talk-to-Claire is not specified as a binding path; a web user without a bound phone can still fall into stranger/onboarding behavior. | Medium | P0 |
| Google/Gmail login | `/login` signs in via Google or magic link and calls candidate verify. | Verify does not guarantee a Claire runtime pitch; web flow can land in portal/job page without contextual conversation. | Medium | P0 |
| LinkedIn OAuth login | OAuth login exists and candidate verify detects `li_*` / `linkedinSignIn`. | OAuth profile is not enough by itself to guarantee canonical LinkedIn URL enrichment or Claire pitch. | Medium | P0 |
| LinkedIn connect URL flow | `paLinkedinConnectSubmit` links URL, can enrich via Coresignal, and can emit a runtime event for canary. | Behavior is path/canary specific and not unified with first-party website login. | Medium | P1 |
| Resume upload from public job | Inline job page says resume is saved/processing; legacy `/j/:jobId/cv` still says "Resume uploaded. You can close this tab." | Resume upload does not consistently trigger Claire's runtime pitch/start decision. | Medium | P0 |
| Coresignal enrichment | Admin/external-supply adapters, collect client, mirror, tag bridge, and experience merge exist. | First-party self-signup enrichment is not one unified product path tied to Claire's first pitch. | Medium/Large | P1 |
| In-progress enrichment UX | Async resume/LinkedIn discussion patterns and in-flight markers exist. | Website-origin "hi" / Talk-to-Claire can still look idle, generic, or stranger-like while enrichment is running instead of saying Claire is still reading/pulling the candidate's info. | Small/Medium | P0 |
| Prescreen start | Trigger starts deterministic prescreen runtime. | Kickoff does not consistently load global profile/tags/memory/prior answers before asking Q1. | Large | P1 |
| Prescreen pre-start readiness | Prescreen can start as soon as trigger routing succeeds. | If resume/LinkedIn enrichment is actively running, Claire can ask Q1 too early or pitch too early instead of sending a short readiness hold and starting Q1 when evidence lands. | Medium | P0 |
| Post-prescreen onboarding | Prescreen terminal actions exist and post-match retention exists in places. | Product sequence is unclear: role screen should start first, then Claire should invite LinkedIn/resume/matching after end/stop. | Medium | P0 |
| Prescreen answer handling | Reducer commits answers; audit shows off-script text can be consumed as answers. | Need pre-reducer intent tool path: answer vs already-did-this vs question vs pause/exit. | Large | P1 |
| Prescreen ending | Terminal copy and terminal actions are partly deterministic. | Ending narration and per-layer next step should be agent/tool-backed and terminal-cause aware. | Medium | P1 |
| Prescreen outcome follow-up | Dashboard/admin outcomes and scheduling tools exist. | Candidate UX for rejection, 21-day timeout auto-reject, WeKruit-team-note explanation, moved-forward scheduling, and later status questions is not captured as one flow. | Medium/Large | P0 |
| Matching subscription cadence | Job recommendation subscription and STOP handling exist. | Runtime must verify the post-pitch "yes" path activates a 2-3 day cadence and that STOP/pause suppresses pending proactive sends. | Small/Medium | P0 |
| Context-aware status answers | Tools exist for match status, prescreen progress, and scheduling. | Runtime UX does not explicitly route candidate questions about scheduled interviews, previous screens, or job matches to read tools first. | Medium | P0 |
| Preferences/tags | Write side exists for some axes. | Runtime context renders only part of saved tags; visa/salary/industry/company size can be missing from prompt context. | Small | P0 |
| Recommendation history | Matcher ledger exists. | Conversation context does not render compact roles-on-file/status/token availability. | Small | P0 |
| Conversation history | Current session transcript is loaded. | Cross-session/cross-number summary is missing for known users. | Medium | P1 |
| mem0 | `remember_fact` writes; audit says no read path. | No top-K memory retrieval in normal runtime, prescreen, or web-origin pitch. | Medium | P0 |
| Identity in-flight state | Candidate handles are read during inbound resolution. | Agent context does not read open verification/connect tokens; pre-bind users can be treated as strangers. | Medium | P1 |

### 4.1 Code-Audit Evidence

Read-only code audit classifies the website-origin surfaces as present but not runtime-complete:

- **Google/Gmail/LinkedIn login is partial.** `apps/pa-landing/src/pages/CandidateLogin.tsx` supports Google, LinkedIn, and email magic-link login. `apps/functions/src/candidate-magic-link-verify.ts` claims/creates the candidate and records LinkedIn OAuth markers, but normal login returns portal state only. It does not emit a Claire runtime pitch/enrichment handoff.
- **Public resume upload is partial.** `apps/functions/src/public-cv-ingest.ts` resolves the signed-in candidate and writes resume/profile state, but website upload uses `followupDeliveryMode: "none"`. `apps/functions/src/cv-ingest/cv-ingest.ts` only emits `resume_parse_completed` when delivery mode is runtime.
- **Phone/SMS connect is partial.** `apps/functions/src/connect-phone/connect-phone-start.ts`, `connect-phone-verify.ts`, and `apps/functions/src/identity/candidate-phone-link.ts` deliver and verify identity codes. They bind identity, but do not themselves create the initial Claire pitch runtime turn.
- **Coresignal/LinkedIn enrichment is partial.** `apps/functions/src/linkedin-connect/linkedin-connect-submit.ts` can enrich through Coresignal, mirror experience, dual-write tags, and emit runtime handoff, but the new enrich+emit path is canary-gated and tied to `/connect-linkedin`, not normal `/login` LinkedIn OAuth.
- **In-progress enrichment UX exists but is not unified.** `apps/functions/src/claire-agent/enrichment-inflight.ts`, `apps/functions/src/claire-agent/prompt.ts`, and `packages/pa-orchestrator/src/onboarding/discussion-phase.ts` already model "still reading/pulling your info" while async work runs. The missing product contract is to reuse that state for website-origin entry and prescreen pre-start readiness, not only the current canary/thin or tutorial-style path.
- **Initial Claire pitch is missing for normal website sign-in and upload.** The runtime handoff mechanism exists in `apps/functions/src/runtime-event-handoff.ts`, and the thin pitch path can fire for `resume_parse_completed`, but normal sign-in and public upload do not currently invoke it.

### 4.2 UX Gap Analysis

The candidate-visible gaps are:

1. **Silent loading gap.** A candidate can sign in, upload a resume, connect LinkedIn, then say "hi" while WeKruit is still parsing/importing. Today that can feel like Claire is idle or forgot the action. Required UX: one short progress turn that says Claire is still reading/pulling their info and will continue when it lands.
2. **Premature pitch gap.** If Claire pitches before enrichment lands, the pitch sounds generic and can miss the strongest evidence. Required UX: wait for the completion event before the general pitch when enrichment is actively in progress.
3. **Premature prescreen gap.** If a role screen starts before actively-running resume/LinkedIn evidence lands, Q1 can ask for something the candidate already provided. Required UX: send a readiness hold, then start Q1 directly once the evidence lands.
4. **Wrong sequence gap.** Website role entry must not become pitch -> onboarding -> prescreen. Required UX: role screen first; candidate retention pitch/onboarding after prescreen end, pause, or stop.
5. **Re-ask gap.** In-progress state must never turn into "upload again" or "sign in again." Required UX: Claire acknowledges the action already happened and explains the current processing state.

---

## 5. Required Entry Flows

### 5.1 Direct SMS "hi"

When a candidate texts Claire without a token:

1. Resolve candidate by handle and open verification/connect token state.
2. Load profile, resume, LinkedIn, tags, recommendation history, recent conversation summary, active/past prescreens, and mem0 top-K.
3. If authenticated/profiled, do not ask for login.
4. If not authenticated, Claire may pitch briefly and ask for the least-friction identity/profile action.
5. Response is emitted through runtime `send_message`.

### 5.2 Website Login: Google/Gmail/Magic Link

On successful candidate verify:

1. Emit `candidate_entry_completed` runtime event with:
   - `entrySource: google | email | magic_link`
   - `candidateId`
   - `registrationEntry`
   - `hasResumeOnFile`
   - `hasLinkedIn`
   - `senderNumber`
   - `jobIdContext` when entered from `/j/:jobId` or `/j/:jobId/cv`
2. Runtime loads context and chooses the same pitch path used by direct SMS LinkedIn/resume uptake.
3. If no outbound-capable thread exists, persist `pendingClaireContinuation` so "Talk to Claire" resumes as a known candidate.
4. If the candidate clicks "Talk to Claire" and no phone is bound, start/continue phone binding before treating the iMessage thread as established.
5. If enrichment or resume parsing is actively in progress and the candidate says hi before it finishes, runtime sends a single progress/status turn and waits for the completion event before pitching from that evidence.
6. If job context exists, runtime starts/resumes the role prescreen directly. Do not force profile pitch/onboarding before Q1.
7. If no job context exists and profile evidence is available, runtime uses the existing pitch path and offers matching.
8. If profile is missing key info, runtime asks for the smallest missing item.

### 5.3 Website Login: LinkedIn OAuth

On successful LinkedIn login:

1. Candidate verify records LinkedIn OAuth identity on `pa-users`.
2. Runtime event fires immediately: `candidate_entry_completed` with `entrySource: linkedin_oauth`.
3. Coresignal enrichment is started through an enrichment tool/job.
4. If the candidate sends a message while enrichment is in progress, Claire says she is still pulling their info and will use it to understand them first. She does not pitch, match, or ask them to connect LinkedIn again from incomplete evidence.
5. When enrichment completes, emit `enrichment_completed` runtime event; Claire updates the candidate and asks for additions/corrections.
6. Do not ask the candidate to sign in again.

### 5.4 Website Resume Upload

On successful resume upload:

1. Ingest writes resume artifact and parse status.
2. Emit `resume_uploaded` runtime event with `candidateId`, `resumeArtifactId`, `jobIdContext`, and upload source.
3. Claire's runtime pitch uses the existing resume-style pitch posture: acknowledge the resume, compose/refresh the evidence-backed pitch, then offer the next action.
4. If parse is still running, Claire sends a single progress/status turn that she is reading the resume and will use it to understand the candidate first. She asks only for missing context that cannot be parsed and does not pitch/match blind.
5. Legacy "close this tab" dead-end is removed from the product path.

### 5.5 Website "Talk to Claire" After Login/Upload

When a candidate signs in or uploads a resume on the website and then clicks "Talk to Claire":

1. The click/message carries `candidateId`, `entryEventId`, and optional `jobIdContext`.
2. If no phone/Claire thread is bound, runtime starts or resumes phone binding and links the resulting handle to the same candidate.
3. Runtime reads the pending website-entry state before treating the message as a normal free-form chat.
4. If resume/LinkedIn enrichment is actively in progress, runtime sends the progress/status turn and records the next action to resume after completion.
5. If a role is attached and no enrichment is actively in progress, runtime starts/resumes the prescreen directly and defers onboarding/pitch until after the screen ends or pauses.
6. If no role is attached and the candidate has not received the pitch, runtime sends the existing pitch turn.
7. If the candidate has already received the pitch, runtime references that state and offers the next action.
8. The reply must not ask for login, LinkedIn, or resume when the website already supplied those signals.

### 5.6 LinkedIn Connect URL

For SMS-origin one-tap LinkedIn connect:

1. Link canonical LinkedIn handle to the known candidate.
2. Start Coresignal enrichment.
3. Emit runtime event once URL is accepted, even if enrichment is still in progress.
4. Claire pitches from known data and later follows up when enrichment lands.

### 5.7 Prescreen Start

Before the first prescreen question:

1. Runtime calls `read_candidate_context`.
2. Runtime calls `read_prescreen_history(jobId)` and `read_recommendation_history`.
3. Runtime calls `read_memory`.
4. Runtime calls `read_enrichment_status(candidateId)`.
5. If resume parsing, LinkedIn import, or Coresignal enrichment is actively in progress and expected to affect Q1, runtime sends one short readiness hold and waits for `resume_parse_completed` / `enrichment_completed` before starting Q1. This hold must not contain the general candidate pitch.
6. Runtime calls `start_prescreen(jobId, candidateId)` after checking duplicate/completed/paused state. A missing LinkedIn/resume/profile pitch must not block Q1.
7. The first question is adapted:
   - If resume/LinkedIn/tags already answer it, Claire cites the evidence and asks for additions or confirmation.
   - If prior answer exists for same topic, Claire asks "anything new to add?" instead of asking from scratch.
   - If evidence conflicts, Claire asks the candidate to resolve it.

### 5.8 Prescreen Ending Per Layer

Ending is a tool-backed runtime action:

1. Reducer produces terminal state: `PASS | NOT_PASS | HARD_STOP | PAUSE | NEEDS_REVIEW`.
2. Runtime calls `end_prescreen_terminal`.
3. Claire narrates terminal-cause-aware next step:
   - passed profile queued for review / employer-visible snapshot
   - not-pass but retained in global pool
   - pause/resume route
   - needs-review / waiting on WeKruit
4. No one-size "nice work" copy for every terminal cause.

### 5.9 Post-Prescreen Retention and Matching

After a role screen ends, pauses, or the candidate stops:

1. Claire invites the candidate into the durable matching flow.
2. If LinkedIn/resume is missing, Claire asks for one of them as the fastest way to find better-fit roles and future collaboration roles without repeating a full role screen from zero.
3. If enough profile evidence exists, Claire can pitch and ask whether to send matched roles.
4. If the candidate says yes, activate the job recommendation subscription on a 2-3 day cadence.
5. If the candidate says stop/pause, pause recommendations and pending proactive sends.
6. LinkedIn supplied in this post-prescreen flow enters the CoreSignal enrichment path and updates the same global candidate profile used for future matching and pitches.

### 5.10 Prescreen Outcome and Interview Scheduling

When admin review, WeKruit-team notes, timeout, or scheduler events update the candidate:

1. Rejection/timeout outcome emits a runtime event with the decision source, role context, and evidence-backed reason.
2. If no final decision exists after 21 days, WeKruit auto-rejects with a personalized, role-specific reason rather than leaving the status hanging.
3. Claire phrases rejection reasons as WeKruit team notes for the role and keeps that explanation consistent on follow-up.
4. Moved-forward outcome emits a runtime event that offers interview scheduling.
5. Existing interview bookings are readable by Claire for follow-up status questions.

### 5.11 Context and Status Questions

On any normal conversation turn, before answering status questions, runtime reads the relevant state:

1. interview bookings
2. prescreen sessions and review status
3. candidate job/match status
4. recommendation subscription state
5. recent outbound/inbound thread context

---

## 6. Runtime Tool Contract

### Read tools

| Tool | Purpose |
|---|---|
| `read_candidate_context(candidateId)` | Profile, auth state, handles, resume artifact presence, LinkedIn state, tags, Level 1 fields |
| `read_memory(candidateId, query, limit)` | mem0/Qdrant top-K durable memories with evidence/confidence |
| `read_recent_conversation(candidateId, currentSessionId)` | Current session transcript plus cross-session summary |
| `read_prescreen_history(candidateId, jobId?)` | Active, completed, paused, pending-review screens and answers |
| `read_recommendation_history(candidateId)` | Roles sent, status, token availability, suppressed/rejected roles |
| `read_enrichment_status(candidateId)` | Resume parse, LinkedIn/Coresignal enrichment, conflicts, pending jobs |
| `read_candidate_entry_state(candidateId, entryEventId?)` | Pending website-origin continuation, pitch status, source, and attached job context |
| `read_phone_binding_status(candidateId)` | Bound phone/iMessage thread state and whether Talk-to-Claire can safely open a thread |
| `read_interview_bookings(candidateId, jobId?)` | Scheduled interview times, booking status, role/company, and reschedule/cancel state |
| `read_candidate_job_status(candidateId, jobId?)` | Candidate-visible job status across match, prescreen, review, interview, rejected, and hired states |
| `read_recommendation_subscription(candidateId)` | Active/paused state, cadence, last batch sent, next eligible send |

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
| `mark_pitch_sent(candidateId, source, pitchTurnId)` | Durable pitch state so Talk-to-Claire can continue instead of re-pitching or re-onboarding |
| `start_phone_binding(candidateId, phone?)` | Website-origin Talk-to-Claire binding/code flow |
| `set_recommendation_subscription(candidateId, status, cadence)` | Activate/pause recurring matched-role sends |
| `emit_prescreen_outcome(candidateId, jobId, outcome)` | Candidate-facing rejection/moved-forward/timeout runtime event |
| `schedule_or_offer_interview(candidateId, jobId, constraints?)` | Route moved-forward candidates into interview scheduling |

### Tool-loop rule

One candidate turn should normally complete with:

1. Parallel read tools.
2. At most one process action tool.
3. One `send_message` action.

If more work is needed, commit a pending state and resume from a runtime event. Do not spin the agent in repeated wait loops.

---

## 7. Memory and Context Requirements

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

## 8. Acceptance Criteria

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
- [ ] The pitch turn reuses the existing `composePitchTurn` posture: confirmation, evidence-backed candidate pitch, and single next-action offer.
- [ ] If no outbound-capable thread exists at website entry, "Talk to Claire" resumes the pending known-candidate state and sends the pitch on the first candidate message.
- [ ] Website-origin Claire never asks for login, LinkedIn, or resume when those signals are already present.
- [ ] Returning signed-in candidate sees status/next action, not a full re-introduction.
- [ ] "Talk to Claire" binds or resumes the candidate phone/Claire thread before any generic chat path.
- [ ] A candidate with a verified Claire phone thread or website identity never cold-starts onboarding again.
- [ ] If resume parsing or LinkedIn/Coresignal enrichment is still running and the candidate says hi, Claire sends one progress/status turn and does not pitch or match from incomplete evidence.
- [ ] When the completion runtime event lands, Claire resumes the correct website-entry next action without asking the candidate to upload/sign in again.

### P0: Prescreen-First Flow

- [ ] Role prescreen trigger starts Q1 directly even when LinkedIn/resume/pitch is missing.
- [ ] Missing LinkedIn/resume/profile pitch never blocks the first role screen.
- [ ] If resume/LinkedIn enrichment is actively running before Q1, Claire sends a one-turn readiness hold, then starts Q1 from the completion event.
- [ ] The pre-Q1 readiness hold must not include the general candidate pitch or onboarding ask.
- [ ] After prescreen end, pause, or user stop, Claire invites LinkedIn/resume/profile enrichment for future matching.
- [ ] If the candidate accepts matching after the pitch, job recommendations activate on a 2-3 day cadence.
- [ ] STOP / pause requests pause recommendation subscription and pending sends.

### P0: Outcome and Status UX

- [ ] Dashboard rejection emits a personalized candidate-facing rejection with WeKruit-team-note framing.
- [ ] Rejection copy includes a concrete evidence-backed reason; vague "not a fit" copy is augmented before send.
- [ ] If LinkedIn/resume is missing on rejection, Claire invites the candidate to add one so future collaboration roles can be pitched without repeating the entire prescreen.
- [ ] If LinkedIn is provided after rejection, CoreSignal enrichment updates the durable candidate profile for future matching.
- [ ] Rejection copy asks whether the candidate wants matching recommendations; proactive recommendations start only after opt-in.
- [ ] No-decision timeout after 21 days auto-rejects with a personalized, role-specific reason.
- [ ] Follow-up questions about a rejection explain it consistently as WeKruit team notes for the role.
- [ ] Moved-forward outcome offers interview scheduling through existing scheduling tools.
- [ ] Candidate questions about scheduled interviews, previous prescreens, and job matches read state before answering.
- [ ] Candidate questions about whether Claire will keep sending matches read recommendation subscription state before answering or updating it.

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

## 9. Implementation Plan

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

The event handler must prefer the existing pitch engine/posture over new copy. If an outbound thread is unavailable, it records a pending website-origin continuation consumed by the next "Talk to Claire" message.

### Phase 0C: In-Progress Enrichment UX

Reuse the existing async discussion/in-flight pattern for website and prescreen entry:

- when resume parsing or LinkedIn/Coresignal enrichment is running, render one short progress/status turn
- do not pitch, match, re-auth, or re-upload while evidence is still loading
- on `resume_parse_completed` / `enrichment_completed`, resume the pending next action
- for general website entry, the next action is pitch/offer; for role entry, the next action is prescreen Q1

### Phase 0D: Talk-to-Claire Phone Binding

Make Talk-to-Claire identity-safe:

- detect whether the signed-in candidate already has a bound Claire phone thread
- if not, route through phone binding before opening the Claire thread as an established candidate
- once bound, mark the user as known/portal-ready enough to avoid cold onboarding
- preserve job context across the binding step

### Phase 0E: Prescreen-First Retention Handoff

Correct the role flow:

- start prescreen directly from role trigger / Talk-to-Claire job context
- if enrichment is actively running, wait with a one-turn readiness hold and then start Q1 from the completion event
- after terminal/pause/stop, emit a retention handoff asking for LinkedIn/resume or offering matching
- when the user accepts matching, activate 2-3 day job recommendation cadence with STOP compliance

### Phase 0F: Prescreen Outcome Runtime Events

Unify candidate-facing post-screen outcomes:

- dashboard rejection event
- 21-day no-decision auto-reject event
- moved-forward / schedule-interview event
- context read tools for later status questions
- rejection-message augmentation that guarantees an evidence-backed reason, LinkedIn/resume invite when missing, and matching-recommendation opt-in
- post-rejection LinkedIn/CoreSignal enrichment into the same global candidate profile used by future role pitches

### Phase 0G: Context Completion

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

## 10. Open Questions

1. Should mem0 be enabled for all users immediately once read exists, or behind the same runtime cohort as the agentic entry event?
2. What is the exact employer-visible snapshot boundary after a PASS terminal in the new terminal narration?

These are product routing questions. The technical direction above does not depend on new compatibility paths.
