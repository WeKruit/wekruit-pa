# Canonical Flow Gap-Fix Plan — login→pitch→offer→match→prescreen (dev phone)

Scope: the smallest set of changes to make the canonical loop work end-to-end on the dev
phone (+14243201960 / uid `8fEwIduUrzxZsblHHsNz`). Reuse-not-rebuild. Every fix rides an
existing seam. Canary-gated per invariant #10. Derived from the STEP 2-6 + INVARIANT audits.

All paths relative to `apps/functions/src/claire-agent/` unless absolute.

---

## What already WORKS — DO NOT TOUCH

These were audited as fully wired end-to-end. Re-building them is wasted surface and risks
regressing live behavior. Leave them alone.

- **Step 2 — Post-parse PITCH.** `postParsePitch` → `PITCH_KICKOFF_DIRECTIVE` (prompt.ts:213-370),
  wired through cutover.ts:287-306, mode-selector.ts:424-503, agent.ts:631-663. Delivers a strong
  candidate-facing pitch from the enriched profile.
- **Step 3 — role / jobType / location delta.** `set_matching_preferences` →
  `reduceMatchingPreferences` → `applyPartialUserTags` (matching-tools.ts:855-906). Delta-only,
  no regex, no re-pitch. Triage-routed (prompt.ts:570).
- **Step 3 — post-rec industry/seniority/salary reaction.** `capture_match_feedback` `tagDeltas`
  → `applyPartialUserTags` (matching-tools.ts:1439-1529). Works when reacting to recommended roles.
- **Step 3 — résumé re-drop re-sharpen.** cutover.ts:169-172 `ingestCv` → `resume_parse_completed`
  re-entry → triage confirm pitch. Tags rewritten via parser's `mergeUserTags`.
- **Step 3 — incremental confirm (no whole-pitch re-throw).** Corrections route to triage DEFAULT
  directive, NOT the pitch directive. Full pitch fires only on resume_parse re-entry.
- **Step 5 — OFFER→MATCH handoff.** `find_match` tool wired end-to-end (cutover.ts:207/271,
  matching-tools.ts:909-965). Offer-then-confirm (prompt.ts:558-565), AUTO-MATCH on "yes"/"find me
  a match" (prompt.ts:572-578). Delivers role bubbles + image rec card + collab prescreen offer
  itself. **US-only by default** inside `queryMatchingJobsV16` (query-matching-jobs-v16.ts:1621/1634,
  `userAllowsNonUs` default false). Fail-open (RC2). 160/160 + 18/18 + 5/5 tests pass.
- **Step 5 — image rec card to dev phone.** `REC_CARD_UIDS` includes `8fEwIduUrzxZsblHHsNz`
  (cutover.ts:216). `PA_JOB_REC_CARD_ENABLED=1` shipped in deploy bundle. `.png` contract tested.
- **Step 6 — WeKruit job → prescreen offer → Cal.com.** Collab detection + MANDATORY tool-sent
  prescreen offer after recs (matching-tools.ts:549-845). Both prescreen-start paths
  (verbatim `WeKruit_..._Job` token via router; conversational `begin_collab_prescreen`) reach
  `runPreScreenForUser`. Cal.com `offer_interview_slots`/`book_interview_slot` wired to real client.
  Thin prescreen + scheduling canary-gated by design (`paThinPrescreenEnabled`/`paSchedulingEnabled`
  + dev-uid floor). Non-canary users still get a real legacy prescreen.
- **INVARIANT spine — trailing live-state block + tagging writes.** `buildClaireTurnContext` runs
  unconditionally every turn (agent.ts:653), injected as trailing role:"system" item (agent.ts:673-675),
  carries enrichment status + saved matcher prefs (match input). `applyPartialUserTags` fires on
  relevant turns (process-tools.ts:354, matching-tools.ts:887/1478).

---

## Adam-decision flags (resolve before shipping the gated items)

- **D-A (Step 3 offer wording).** Step-3 multi-bubble static offer reintroduces a résumé-drop offer
  bubble that the current pitch directive's guardrail (prompt.ts:314-318) absolutely bans. Fix 1
  narrows that guardrail. Confirm Adam still wants the optional "you can drop your résumé" bubble
  after the pitch (canonical spec says yes; the guardrail was added to stop the *demanding* framing).
- **D-B (Step 4 salary ask).** Salary is never asked anywhere in the thin flow today (seniority_comp
  slot trimmed). Fix 4 makes the pre-match gate the ONLY place salary is requested. Confirm Adam
  wants Claire to ask "rough target salary" at all — this is a new question in the flow (kept to a
  single combined location+salary message, only-if-both-missing, once-only).
- **D-C (ship gating).** All behavior-changing fixes are canary-gated to the dev uid. Confirm we ramp
  no wider than the dev phone until live-verified (invariant #10).

---

## Ordered fix list (dependency + smallest-first)

### FIX 1 — Step-3 multi-bubble static offer after the pitch  [SMALL, risk low]  ← RECOMMENDED FIRST
- **Gap:** The post-parse pitch turn delivers the pitch (Step 2 ✓) but bubble 2 is either an
  onboarding-question clarifier (the forbidden question wall) or a single find_match offer — NOT the
  Step-3 three-way static offer ("find you a match?" / "improve your info?" / "drop résumé — optional").
  The résumé-offer bubble is additionally impossible because the directive guardrail bans any mention
  of dropping a résumé.
- **Exact change:** In `PITCH_KICKOFF_DIRECTIVE`, replace the "EXACTLY TWO bubbles / messages[1] =
  confirm + clarifiers" contract (prompt.ts:283-287 item 6, prompt.ts:332-336) with: messages[0] =
  pitch; messages[1] = ONE short confirm; then emit the Step-3 static offer as additional bubbles —
  (a) "want me to find you a match?" (b) "or want to improve anything on your info?" (c) "you can
  also drop your résumé if you want — totally optional". Drop the `nextQ` clarifier-question weave in
  the onboarding branch (prompt.ts:447-449) so this turn no longer asks an onboarding question. Apply
  the same offer block to the returning/triage branch (prompt.ts:558-565). Narrow the résumé
  guardrail (prompt.ts:314-318) to block only "I can't see your résumé / you must paste it" framing,
  NOT the optional offer. Same `messages[]` array — different bubble plan, no new machinery.
- **Files:** `prompt.ts`
- **Risk:** low (prompt-only; no tool/state change). Watch: don't let the offer re-fire find_match on
  this turn — it stays an offer until the candidate says yes (Step 5 AUTO-MATCH already handles "yes").
- **Adam decision:** D-A (résumé-offer bubble wording).
- **Live test:** dev phone — finish enrichment (résumé or LinkedIn). Expect: bubble1 = pitch,
  bubble2 = short confirm, then the 3 offer bubbles. No onboarding question. Reply "yes" → find_match
  fires next turn (verifies Fix 1 doesn't break Step 5).

### FIX 2 — Triage profile-sharpen tool route (industry/company/skills delta)  [SMALL, risk low]
- **Gap:** A conversational profile sharpen that is an INDUSTRY / COMPANY / SKILLS delta but NOT a
  role/jobType/location pref and NOT a reaction to just-recommended roles (the canonical "actually I
  work in the Autopilot group" said during Step 3 discuss, before any match) has no tool route.
  `set_matching_preferences` covers only role/jobType/location; `capture_match_feedback` is described
  as a post-find_match reaction so the model won't fire it pre-match; `skills`/`recentRoleTitle` are
  unwritable from any chat tool. The delta is acknowledged in prose but never written → invariant #2
  violated for this case.
- **Exact change:** Broaden the EXISTING `capture_match_feedback` (reuse, no new tool):
  (1) widen description (matching-tools.ts:1442) to "...reaction to recommended jobs OR an unprompted
  profile correction/addition they volunteer in chat"; allow `sentiment='ambiguous'`/
  `reasonCategory='none'` for a pure addition (`jobId` already optional at :1468, `tagDeltas` already
  writes via `applyPartialUserTags` at :1471-1484 — no behavior change).
  (2) add `recentRoleTitle: z.string().nullable()` + `skills: z.array(z.string()).nullable()` to the
  `tagDeltas` object (matching-tools.ts:1453-1465); `validateOnboardingCanonicalTags` already accepts
  the canonical superset.
  (3) add ONE triage directive line near prompt.ts:611: "If the candidate CORRECTS or ADDS a profile
  fact mid-chat (company/group, industry, a skill, seniority) without naming a role preference —
  confirm just that one delta in your voice and call `capture_match_feedback` with the canonical
  `tagDeltas`; do NOT re-pitch."
  Do NOT wire `runConversationTagging` — that is new machinery vs the reuse mandate.
- **Files:** `tools/matching-tools.ts`, `prompt.ts`
- **Risk:** low (additive tool params + one directive line; `applyPartialUserTags` is the existing
  D8 sole writer, no regex). Watch: ensure skills addition merges, not clobbers (the parser already
  guards weak re-parse; this is delta-only via applyPartialUserTags).
- **Live test:** dev phone — after pitch, before matching, say "actually I'm in the Autopilot group,
  more ML infra than web." Expect: short confirm of THAT delta, no re-pitch. Verify `pa-users/8fE…
  .tags` gained the industry/company/skill delta (Firestore).

### FIX 3 — Session trailing block: recent-reply ledger + sentiment signal  [MEDIUM, risk med]
- **Gap:** The trailing live-state block carries enrichment + match-input status (✓) but is MISSING
  two design-mandated signals: (a) recent-reply ledger (`recentReplies[]` — Claire's own last-N
  bubbles for don't-repeat / vary-opener self-check) and (b) sentiment (`lastReaction` /
  `negativeStreak` / pushback / repeatedQuestion). Dislike/pushback is recorded to feedback events
  but never fed into the NEXT turn, so Claire can't react to the candidate disliking/correcting its
  last reply — the "context 一长就不够好" / repeat-advice drift class.
- **Exact change:** Implement SESSION-CONTEXT-DESIGN SLICEs 2-3 on the EXISTING
  `buildClaireTurnContext` seam (no new injection point):
  - SLICE 2 (recentReplies): thread a `kind` through `deliverBubbles`→`sendText`→`enqueueOutbound`;
    stamp `rawMeta.kind` at outbox.ts:500; derive last-N assistant rows in a new `session-context.ts`;
    render a "RECENT (your last replies, newest first): …" line in `buildClaireTurnContext`
    (prompt.ts:697).
  - SLICE 3 (sentiment): derive `lastReaction` from newest `pa-tapback-events` row + a small
    deterministic `negativeStreak`/`pushback`/`repeatedQuestion` reducer at the inbound/cutover seam;
    render a "SENTIMENT: …" line in the trailing block.
  - Thread both through `ModeDecision`→`RunClaireTurnDeps`→`buildClaireTurnContext` exactly like
    `enrichmentInFlight`/`gmailNudge`/`linkedinJustConnected` already travel.
  - SLICE 1 (multi-op `liveOps` map incl. find_match readiness + parse-FAILED surfacing) is OPTIONAL
    for this loop — defer unless a parse failure goes invisible in live testing.
- **Files:** `session-context.ts` (new), `prompt.ts`, `agent.ts`, `mode-selector.ts`,
  `cutover.ts`, `apps/functions/src/sendblue/outbox.ts` (+ `enrichment-inflight.ts` only if SLICE 1)
- **Risk:** med — touches the outbox enqueue path and the byte-stable cache tail; a malformed trailing
  line can bust prompt caching or leak into voice. Keep canary-gated; keep the block empty-when-absent
  (`.filter(Boolean).join`). Largest surface in this plan.
- **Adam decision:** D-C (canary-only).
- **Live test:** dev phone — ≥10-turn runner.mjs scenario. Assert: opener variance (no repeated
  opener), and after a dislike tapback / "no that's wrong" Claire does NOT re-pitch the same thing and
  acknowledges the pushback. Read actual reply text, not just pass status.

### FIX 4 — Step-4 conditional location+salary pre-match gate (only-if-both-missing, once)  [SMALL-MEDIUM, risk low]
- **Gap:** No Step-4 gate. The flow jumps straight to find_match on any "ready" signal (prompt.ts:572).
  No only-if-both-missing reducer exists, and salary is never asked at all (seniority_comp trimmed), so
  the precondition can't be cleared by the candidate volunteering salary.
- **Exact change:** Deterministic, fail-safe, reuse-only:
  (1) new pure reducer `reducers/location-salary-gate.ts` →
  `needsLocationSalaryAsk(user): boolean` — true ONLY IF `!hasLoc && !hasSalary`
  (`tags.targetLocations` non-empty array, `tags.minSalary` positive number) AND once-only stamp
  `user.locationSalaryAskedAt` absent.
  (2) mode-selector.ts TRIAGE section, just before the final `return { mode: "triage" }` (line 587),
  add a canary-gated branch: if `isCanaryUser && !enrichmentInFlight && !cvParsedTrigger &&
  needsLocationSalaryAsk(user)` → stamp `locationSalaryAskedAt` (set merge, fail-open) and return
  `{ mode: "triage", …, locationSalaryAsk: true }`. Add `locationSalaryAsk?: boolean` to `ModeDecision`
  (types.ts).
  (3) prompt.ts TRIAGE branch: when `dec.locationSalaryAsk`, prepend ONE directive: "Before matching,
  ask ONE short message for their US location + rough target salary (you don't have either on file). Do
  NOT call find_match this turn." Answer flows through EXISTING `set_matching_preferences` /
  `record_onboarding_answer` → `applyPartialUserTags`. Once-only stamp + only-if-both-missing reducer
  prevent re-asking; AUTO-MATCH resumes next turn.
- **Files:** `reducers/location-salary-gate.ts` (new), `mode-selector.ts`, `types.ts`, `prompt.ts`
- **Risk:** low (deterministic reducer, fail-open to triage on read error; canary-gated). Depends on
  Fix 1's bubble plan landing first so the offer→gate→match ordering reads cleanly. Order AFTER Fix 1.
- **Adam decision:** D-B (ask salary at all?), D-C (canary-only).
- **Live test:** dev phone — fresh/cold user with NO location and NO salary on file. After the pitch,
  before matching, expect ONE combined location+salary ask, find_match deferred one turn. Answer →
  match runs. Verify it is NOT asked again on a later turn (once-only stamp). Verify a user who already
  has location OR salary is NEVER asked (skip silently).

---

## Recommended FIRST fix

**FIX 1 — Step-3 multi-bubble static offer.** Smallest surface (prompt-only, one file), zero new
machinery, no dependency, and it unblocks the visible candidate-facing seam between pitch and match —
which every downstream fix (2, 4) reads against. It directly closes the most user-visible canonical
gap (the question-wall bubble 2) and is independently shippable/testable on the dev phone in one turn.

## Total estimated surface

**SMALL–MEDIUM overall.** Three of four fixes are SMALL (Fix 1 prompt-only; Fix 2 additive tool
params + one line; Fix 4 one tiny reducer + gated branch). Fix 3 is the only MEDIUM (touches outbox
enqueue + cache tail). Ship order 1 → 2 → (3) → 4; Fix 3 can be deferred without blocking the core
login→pitch→offer→match→prescreen loop — it is the drift-quality hardening, not a loop blocker.
