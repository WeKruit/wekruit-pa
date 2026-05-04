# iter30 V2 SKILL ACTIVATION MATRIX — QA REPORT

Run timestamp: 2026-05-04T05:42-05:46Z (live deployed orchestrator, 38 broker-shape inbounds).
Test user: `e5d97cd8-1e1d-439d-8672-3008f8aeef2e` / `+14243201960` (testMode=true, admin allowlist).
Driver: `.planning/iter30/qa-reports/qa-v2-skills-matrix.mjs` (per-case onboardingState=complete reset).
Raw JSON: `.planning/iter30/qa-reports/v2-skills-matrix.json`.

## Headline counts (38 cases = 19 skills × {zh, en})

| | count | %  |
|-|-:|-:|
| Regex floor predicted expected key | 29 | 76% |
| Regex floor MISS (regex gap) | 9 | 24% |
| Reply quality tone-MISMATCH (auto-fail patterns) | 1 | 2.6% |
| Inbound errors / orchestrator crash | 0 | 0% |

(Tone heuristic is permissive — it only flags hard auto-fail patterns like ZH `还是?` AB-probe or EN flat-deny / sycophancy. Many cases marked `tone-?` need human or LLM judge eval — out of scope here.)

## P0 bugs (block launch)

### P0-1 — `phrase_repeat_strip` shreds words mid-token (output corruption)

File: `packages/pa-orchestrator/src/voice/phrase-repeat-stripper.ts`

Symptom: live replies contain garbled fragments:
- `"Yeah, I sawr resume"` (was "I saw your resume")
- `"How much dowant Meta in your head"` (was "do you want")
- `"hey—what kind of eare you aiming for on OPT?"` (was "kind of role are")
- `"Ugh, getting rejected bythis morning"` (was "by Meta this")
- `"Was the system you designed in your projects more"` (truncated tail)
- ZH log: `matched_phrase: '。你现在'` then `'是你现在'` later (consecutive turns over-strip)

Root cause: `findLongestRepeatedPhrase` uses `text.slice(i, i+len)` for English with `minPhrase=4`. Tokens like `'hat '`, `'that '`, `' job hunting'`, `'o re'` happen to also be substrings of prior replies. The slice ignores word boundaries and crops mid-word. Cloud Logs `pa.voice.phrase_repeat_strip.applied`:
- `matched_phrase: 'hat '` beforeLen=133 afterLen=129
- `matched_phrase: 'that '`
- `matched_phrase: ' job hunting'`
- `matched_phrase: 'o re'`

Fix sketch: for ASCII matches, snap match offset/end to `\b` word boundaries before stripping. ZH char-window already correct. Also raise EN `minPhrase` to ≥6 chars OR require the match to span ≥2 whole words. Tune `windowChars=30` — opener-only is correct, but the fix must keep the opener intact.

Severity: ships visibly broken English replies on most turns where the prior had any common 4–12 char phrase (very common). Adam will see this in 1st live message.

### P0-2 — `am_i_ai_check` ZH flat-DENY (deceptive answer pattern)

File: deployed `pa-playbooks/am_i_ai_check` (initial run, before per-case reset).

Reply observed (run 1): `"嗯，我是真人朋友。"`

Skill addendum forbids exactly this: `NEVER: flat-deny ("no, I'm a real person") — deceptive`. The LLM did not honor the addendum on ZH.

Note: in run 2 with state-isolation, ZH reply was `"哪里怪？我就是在跟你聊的这个号..."` — neither flat-deny nor flat-confirm, weak deflection but acceptable. So the failure is **inconsistent** — depends on context. Bible v7 / addendum tightening needed; consider adding a regex post-check for `我是真人 / I'm (a )?real (person|human)` and re-roll if hit.

Severity: deceptive output is an Apple-AUP / business-trust risk if it ships.

### P0-3 — `post_offer_decision` ZH `还是 + ?` Phase 18 auto-fail

File: deployed `pa-playbooks/post_offer_decision` (run 1).

Reply (run 1): `"嗯…你是想走更偏 engineering/产品 的路线，还是更偏 finance/ops 那种？"`

Skill addendum: `ZH: NEVER use "还是" before "?" — use "哪个" phrasing.`

The LLM emitted the literal forbidden pattern. The post-gen `stripABProbeFromTail` should have caught it (it does on cold-start onboarding per logs, e.g. `pa.voice.ab_probe_strip.applied { patterns: ['zh_X_还是_Y_question'] }`), but for the main-path skill reply the strip evidently was not applied OR did not match this multi-clause `还是` form.

Run 2 ZH was `"哪个不确定性最让你心里没底?"` (correct phrasing) — again inconsistent.

Fix: ensure `stripABProbeFromTail` runs on main-path skill replies (not just onboarding); broaden regex to catch `想走更偏 X/Y, 还是更偏 A/B 那种？`-style lists.

## P1 bugs (regex floor gaps — LLM intent classifier compensates today, but classifier is flag-gated default OFF)

### P1-1 — `headhunter` regex has ZERO English triggers

File: `packages/agent-registry/src/playbooks.ts:HEADHUNTER_DEFAULT_TRIGGERS` (Firestore mirror).

Deployed regex: `["帮我","想换","在看工作","在面","简历","offer"]`. Pure ZH. Does not match `"looking for a job"`, `"looking to switch"`, `"on the market"`, `"job search"`, etc.

Test cases that whiffed: `headhunter/en` → `predicted=[]`.

Live consequence: when `paSkillRouterV2Enabled=false` (default rollout) the regex floor is the only routing input → headhunter never activates for any English user without LLM intent merge. Today the orchestrator falls back to a length-of-message-and-onboarding-step heuristic which can swing into vent or onboarding mode for innocent EN job-search openers.

Fix: append EN triggers — at minimum `looking for (a |an )?(new )?(job|role|gig|position)`, `on the (job )?market`, `job\s?search`, `looking to switch`, `开始找工作`, `job hunt`.

### P1-2 — `negotiation` regex misses bare "counter" verb / "counter the X offer"

File: same playbooks.ts L739–757.

Deployed has `"counter[\- ]?offer"` and `"counter offer"` — both require "offer" right after. Misses:
- `"拿到 2 个 offer 怎么 counter"` (counter as verb, no following "offer")
- `"how do i counter the Stripe offer with Meta in hand"` (counter NOUN-PHRASE pattern, "Stripe offer" intervenes)

Test cases that whiffed: `negotiation/{zh,en}`. ZH instead matched `headhunter` (bad lift signal); EN matched `headhunter, company_research` (worse — `is\s+([A-Za-z]+)\s+good` from company_research grabs "Stripe").

Fix: add `counter\s+(?:the\s+)?\S+\s+offer`, `counter[\s-]?(?:back|with)`, `怎么\s*counter`, `想\s*counter`, and a multi-offer signal like `(\d+|two|three|多个|两个|两家)\s*(offers?|个\s*offer)`.

### P1-3 — `rejection_processing` regex missing the "got rejected by X" form

File: playbooks.ts iter30 seed.

Deployed `(they|company|recruiter)\s+(rejected|ghosted)\s+me` requires actor-noun before `rejected`. `"got rejected by Meta this morning"` puts the actor AFTER `rejected by` → no match.

Fix: add `got\s+rejected\s+by\b`, `was\s+rejected\b`, `rejection\s+(email|came|came\s+in)`, `email.{0,30}(passed|rejected)`.

### P1-4 — `career_pivot` regex requires "pivot to" / can't see "pivot from"

File: playbooks.ts iter30 seed.

Trigger `pivot(ing)?\s+(careers?|fields?|to)` requires `to`/`careers`/`fields` immediately after `pivoting`. The natural English `"thinking about pivoting from engineering to PM"` (from-then-to) fails. Also the ZH trigger `想转行|转方向|跨界|不想做.{0,5}了` does match `"想从工程转 PM 不想做 backend 了"` partially (`想转` mini), but the deployed regex includes `想转` only as part of `想转行`. Run 2 ZH actually matched `motivation_nudge` (because of `不想做.{0,5}了` overlap with motivation phrase) — wrong skill.

Fix: add `pivot(ing)?\s+from`, `(want|wanting)\s+to\s+pivot`, `想从.{0,10}转.{0,10}到`, `从\s*\w+\s*转\s*\w+`.

### P1-5 — `cv_followup` has empty `regexTriggers` (intentional, but classifier-gated)

File: `packages/agent-registry/src/skills-iter30.ts:CV_FOLLOWUP.regexTriggers = []`.

Design: this skill is supposed to fire via LLM intent classifier when `requiresCtxState.resume_recently_accepted=true`. With the classifier flag default-OFF, cv_followup CANNOT fire anywhere. Test cases `cv_followup/{zh,en}` fell through to `headhunter` (zh) / nothing (en).

Live consequence: a user replying to a CV-acknowledgment Claire just sent gets re-routed into headhunter mode. The "friend who actually read your CV" experience doesn't exist on the regex floor.

Fix options:
- (a) ship the LLM classifier flag ON for launch (paSkillsLlmFallbackEnabled), OR
- (b) add a small ZH+EN regex floor for `(看了|读了|看过).{0,5}(简历|cv|resume)`, `(did|have)\s+you\s+(seen|read|looked\s+at)\s+(my\s+)?(cv|resume)`, `thoughts\s+on\s+my\s+(cv|resume)`.

## P2 (lower priority — observed but acceptable)

- `motivation_nudge/en` "i can't bring myself to start" matched `vent_support` regex (`burned out` not matched but `can't ... start` is in motivation_nudge's regex set — still got vent first). The reply is fine in tone (`"that 'can't start' feeling is so real... what's the exact first click..."`) but the regex priority order should let motivation_nudge win for this kind of phrase. Probably right — vent_support priority=80 > motivation_nudge priority=60 → vent gets ack first, but then LLM stacking should add motivation_nudge nudge. Worth verifying.
- `silence_anchor/en` reply was: `"hey—what kind of eare you aiming for on OPT?"` — silence_anchor addendum says ≤6 words EN, no question, no recap. Reply violates spec (chained role question). Likely the orchestrator stacked silence_anchor + headhunter; given `silence_anchor.composableWith` includes `headhunter`, that's by design, but the resulting reply contradicts silence_anchor's "presence-only ack". Stacker priority is fine; this is an ADDENDUM CONTRADICTION between silence_anchor and headhunter.
- `referral_request/zh` matched `[headhunter, referral_request]`. The headhunter `帮我` regex over-fires: any ZH "帮我..." matches headhunter, even "帮我内推" which is referral. `referral_request` priority (70) > `headhunter` (40) so stacker should resolve correctly. Worth audit — at the regex floor level, headhunter is the most frequent over-match and pollutes telemetry.

## P3 (script/test infra issue — not a product bug)

- The first run (without per-case state reset) drifted: by case 7 the user's `onboardingState` had advanced from `complete` to `q_role_asked` and stayed bouncing between `send_first_mes` ↔ `ask_q_yoe`. Single-trace repro confirmed the orchestrator handles `onboardingState=complete` correctly when the state is preserved. The drift mechanism is unclear (no `applyOnboardingStep` log lines for this user during the run, no `__PA_RESET__`); could be a coalesce / TTL artifact. Per-case reset workaround in `qa-v2-skills-matrix.mjs` resolves it for testing.

## Routing summary per skill (run 2 with state isolation)

```
[OK ] headhunter             zh   regex=[headhunter]
[BUG] headhunter             en   regex=[]                  ← P1-1
[OK ] vent_support           zh   regex=[vent_support]
[OK ] vent_support           en   regex=[vent_support]
[OK ] motivation_nudge       zh   regex=[motivation_nudge]
[OK*] motivation_nudge       en   regex=[vent_support]      ← P2 priority overlap
[OK ] jd_roast               zh   regex=[jd_roast]
[OK ] jd_roast               en   regex=[jd_roast]
[OK ] interview_prep         zh   regex=[interview_prep]
[OK ] interview_prep         en   regex=[interview_prep]
[BUG] negotiation            zh   regex=[headhunter]        ← P1-2
[BUG] negotiation            en   regex=[company_research,headhunter] ← P1-2
[OK ] rejection_processing   zh   regex=[rejection_processing]
[BUG] rejection_processing   en   regex=[]                  ← P1-3
[OK ] post_offer_decision    zh   regex=[post_offer_decision]
[OK ] post_offer_decision    en   regex=[headhunter,post_offer_decision]
[OK ] referral_request       zh   regex=[headhunter,referral_request]
[OK ] referral_request       en   regex=[referral_request]
[OK ] silence_anchor         zh   regex=[silence_anchor]
[OK ] silence_anchor         en   regex=[silence_anchor]    ← addendum violated (P2)
[BUG] cv_followup            zh   regex=[headhunter]        ← P1-5
[BUG] cv_followup            en   regex=[]                  ← P1-5
[OK ] layoff_processing      zh   regex=[layoff_processing]
[OK ] layoff_processing      en   regex=[layoff_processing]
[OK ] company_research       zh   regex=[company_research]
[OK ] company_research       en   regex=[company_research]
[BUG] career_pivot           zh   regex=[motivation_nudge]  ← P1-4
[BUG] career_pivot           en   regex=[]                  ← P1-4
[OK ] return_to_work         zh   regex=[return_to_work]
[OK ] return_to_work         en   regex=[return_to_work]
[OK ] daily_batch_reply      zh   regex=[daily_batch_reply]
[OK ] daily_batch_reply      en   regex=[daily_batch_reply]
[OK ] am_i_ai_check          zh   regex=[am_i_ai_check]     ← addendum violated in run 1 (P0-2)
[OK ] am_i_ai_check          en   regex=[am_i_ai_check]
[OK ] boundary_test          zh   regex=[boundary_test]
[OK ] boundary_test          en   regex=[boundary_test]
[OK ] mom_test               zh   regex=[mom_test]
[OK ] mom_test               en   regex=[mom_test]
```

## Recommendation for tomorrow's launch

Block on:
1. **P0-1** (phrase_repeat_strip) — high-frequency visible corruption. Patch is small (snap to word boundaries on ASCII matches).
2. **P0-2 / P0-3** (am_i_ai_check flat-deny / post_offer_decision 还是+?) — single-shot deceptive / Phase-18-banned outputs. Consider a post-gen regex re-roll guard for these specific patterns.

Ship-with-caveat:
- **P1-1, P1-2, P1-3, P1-4, P1-5** — regex floor gaps. If `paSkillsLlmFallbackEnabled=true` is on at launch, the LLM intent classifier should compensate. Verify the flag is on. If shipping with classifier off, patch the regexes (≤30 lines change).
