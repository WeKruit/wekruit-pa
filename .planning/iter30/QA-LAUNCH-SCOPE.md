# iter30 Pre-Launch QA — Continuous 6h Bug-Hunt Scope

**Owner**: Claude P10
**Started**: 2026-05-04 (post `dfc4cad`)
**Mandate (Adam)**: "明天就要 launch, 你需要完整地测出来, 接下来一个任务是把
所有 edge case / pipeline / feature 全部跑通. 包括 onboard 用户, 怎么连接
email 这些全部都要弄出来. 6 小时连续在后台跑, 没做完不能停."

## Verticals (parallelizable agents)

### V1 — Onboarding 6Q chain (Agent-A)
- Fresh user × {zh, en, mixed} × {hello, "我想找工作", silence, vent opener,
  injection-shaped, abuse}
- Each Q step parser correctness (role/yoe/visa/startup/location/resume)
- Mid-probe vent suspension (state stays at q_X)
- ack_q_resume → resumeAccepted gate opens deterministic
- Final state q_resume_asked → complete + statedPreferences populated
- Onboarded user (state=complete) does NOT re-probe
- Edge: user answers role-Q with non-recognizable text (parser miss)
- Edge: user answers in DIFFERENT language than ask
- Edge: user sends multiple short messages back-to-back (coalescer interaction)

### V2 — 19 skills activation matrix (Agent-B)
- Each of 19 skills:
  - Trigger phrases (regex floor) zh + en
  - LLM intent classification accuracy
  - requiresCtxState gating works
  - composableWith / conflictsWith correct (no double-dispatch)
  - Priority ordering produces expected winner
- Skill addendum tone-guard (NEVER PROBE, NEVER COACH-OPENER, etc — Bible v7)
- Ramp scenario: user starts vent → pivots to negotiation → skill changes
- Headhunter + JD roast composability
- Cross-skill regression: vent_support doesn't bleed into onboarding probe

### V3 — CV / resume pipeline (Agent-C)
- Proactive ask_q_resume → user uploads PDF → cv-ingest fires
- 4 limits enforce (gate / quota / size cap / page cap)
- Parser v2 path (paResumeParserV2=true): inferred answers populate
- qaBank → Mem0 (with metadata) → tag-events → entity-tags subcoll
- statedPreferences merge with structured CV fields (totalYearsExperience etc)
- Stream E1 / E2 / E3 all fire
- Multi-resume path: prior + new → enqueueCvOverwritePending → confirm → promote
- Edge: corrupt PDF, encrypted PDF, scanned image-only PDF, very large file
- Edge: user uploads CV WITHOUT being asked (orchestrator opens gate via cv-gate-detector regex helper)

### V4 — Reset + cold-start regressions (Agent-D)
- __PA_RESET__ (and `/pa-reset`, `重置我的记忆`) all 3 patterns
- Reset for: admin-allowlisted / testMode=true user / production user (rejected)
- Verify 13 collections cleared
- Verify user record reset (onboardingState/statedPreferences/resumeAccepted/resumeId)
- Cold-start AFTER reset re-fires 6Q chain
- Repeat 3 times to verify idempotency
- Edge: rapid reset+message-flood

### V5 — Edge cases / safety / abuse (Agent-E)
- Empty body, whitespace-only, single emoji
- Very long body (10k chars) — should hit length cap
- Prompt injection patterns (Bible defense)
- PII in user message (PII scanner guardrail)
- OpenAI moderation (illegal content)
- Crisis-ideation hotline injection
- Mixed-lang reply (zh sentence + en sentence)
- Slang enforcer (banned words like 友好的, 没问题)
- Length cap (3-sentence limit)
- AB-strip (X 还是 Y framework)
- Mirror score (F1)
- Advice repeat (F4)
- Output normalizer (iMessage-safe)

### V6 — Email connection feature (Agent-F)
**Status**: NOT IMPLEMENTED today — confirmed via grep (only contactType
discriminator in user record exists). Adam wants it for launch.
- Design: how does user connect email?
  - Option A: User pastes email address → we send verification email →
    they reply → we OAuth their inbox (heavy, weeks of work)
  - Option B: User pastes email address → we just save it as a
    contactInfo field → email is sent FROM us TO that address (one-way)
  - Option C: Sendblue email channel (if Sendblue supports email transport)
- Recommended for Day-0 launch: Option B (one-way) — store email, allow
  outbound via SendGrid/Postmark, no inbox-read scope
- Implementation:
  - User onboarding: ask_q_email step at end of 6Q (after resume) — OPTIONAL
  - statedPreferences.contactEmail stored
  - SendGrid/Postmark provisioning (HOLD — needs Adam decision)
  - Outbound email helper for proactive (silence-anchor / time-anchor /
    cv-followup) when user not on iMessage
- For TODAY: at minimum ship `ask_q_email` 7th onboarding step + storage,
  defer transport wiring to post-launch hot-fix

### V7 — Job recommendation pipeline (Agent-B-bis)
- daily-batch fires for users with statedPreferences set
- boost-calculator reads pa-match-weight-tables (Firestore)
- match-explainer produces 4-mode (A_core/B_supp/C_gen/D_fallback)
- Bilingual explanation generation
- pa-job-profiles + pa-job-rec-explanations populate
- Edge: user with no resume → fallback path (D)
- Edge: user with multiple resumes → most recent wins

### V8 — Production verify
- After every fix, deploy + curl health
- Run full E2E once per fix-batch (every 30 min)
- Check Cloud Logging for errors
- Verify no regression in 1077 unit tests

## Bug-fix loop protocol

1. Agent finds bug → reports back with: file:line, repro, expected vs actual
2. Claude main thread:
   - Reads report
   - Reproduces (run command, check Firestore)
   - Patches code
   - Runs `npm test` for affected packages
   - Commits + pushes
   - Deploys
   - Notifies agent to re-test
3. If bug found in production-only path: spawn focused agent to write
   regression test BEFORE patching
4. If 2+ agents find SAME bug: dedupe + treat as P0

## Wake-up cadence

- Every 25-30 min: check all running agents, collect reports, fix highest-P bug
- 6h budget: ~12-14 wake cycles
- Loop ends when: Adam says stop, OR all 8 verticals report green, OR critical
  blocker requires Adam decision

## Out of scope (DEFER post-launch)

- Reflexion-lite critic loop
- HDBSCAN canonical discovery (iter31)
- WS6 cutover (delete 350 LOC scattered patches)
- BoostCalculator entity-tags integration
- Scraping repo cross-PR (Python port already shipped, just needs Adam timing)
- Real Turing-test human-rater study

## Done criteria

| Vertical | Green criteria |
|---|---|
| V1 onboarding | 6Q chain runs T0-T6 in zh + en, intent suspension works, ask_q_resume opens gate |
| V2 skills | Each of 19 skills has ≥1 zh + 1 en passing scenario (judge verdict pass) |
| V3 CV | Upload → parse → tag-events fire → entity-tags subcoll populated |
| V4 reset | 13/13 cleared + 6Q re-fires + 3x idempotent |
| V5 edge | All 12 edge case categories don't crash, return safe replies |
| V6 email | ask_q_email step shipped, contactEmail stored, transport DEFER OK |
| V7 job-rec | daily-batch fires for new user, explainer produces explanation |
| V8 prod | Health 200, no errors in 30min Cloud Logging window |

When all green → biz test ready.
