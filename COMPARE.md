# Stream H13 — friend-tone CV-aware daily-push opener (BEFORE / AFTER)

**User (real prod data)**: `e5d97cd8-1e1d-439d-8672-3008f8aeef2e` (Adam)
**Resume detected**: `recentCompany=NEUROVAInc`, `recentRoleTitle=Data Analyst Intern`, `topSkills=[SQL, Python, R]`
**Stated preferences**: none yet (D5/D13 onboarding probe v2 not landed)
**Variant routed**: **B (CV-known, prefs-unknown)** — exactly the matrix Adam asked H13 to fix
**Language detected**: `zh` (no `pa-users.preferredLanguage = "en"` flag set)
**Run timestamp**: 2026-05-02 (driver: `apps/functions/scripts/run-daily-now-rematch-h13.mjs --from-allowlist --dry-run`)
**Same ranked-set used for both** (cosine + cross-encoder + dedupe + anti-bias upstream pipeline IDENTICAL — only the formatter changed):

---

## BEFORE (H7/H11 robotic — what Adam saw at 19:21 PT today)

```
今日给你挑了 2 个看上去对路的:

- Consultant, Advisors & Consulting Services, Strategy & Transformation @ mastercard (Chicago, Illinois) ~$139k
https://jobright.ai/jobs/info/69cad8a5e565c26a7004149b?utm_campaign=Consultant&utm_source=1103

- Tax Consultant II, SAP Global Trade Services (GTS) @ deloitte (Richmond, VA) ~$121k
https://jobright.ai/jobs/info/6939e1cbac80bb5492bc5df4?utm_campaign=Consultant&utm_source=1103
```

**Length**: 407 chars
**Adam's reaction (verbatim from brief)**: "现在发送的还是比较人机？我们没有问用户yoe/industry/偏好/等之前推荐应该说 'oh 虽然你没和我说过但我看你简历我觉得你适合..', 或者是'我最近发现这几个开了，你可以投一下，你的xxx 经历相关'之类的！"

---

## AFTER (H13 friend-tone — variant B)

```
嘿，没具体问过你想找啥，看你简历那段 NEUROVAInc 的 SQL 挺硬，今天发现这 2 个对得上：

- Consultant, Advisors & Consulting Services, Strategy & Transformation @ mastercard (Chicago, Illinois) ~$139k
https://jobright.ai/jobs/info/69cad8a5e565c26a7004149b?utm_campaign=Consultant&utm_source=1103

- Tax Consultant II, SAP Global Trade Services (GTS) @ deloitte (Richmond, VA) ~$121k
https://jobright.ai/jobs/info/6939e1cbac80bb5492bc5df4?utm_campaign=Consultant&utm_source=1103
```

**Length**: 442 chars (lead-in: 47 chars — well under the 250-char Bible v7.5 cap)
**Lead-in matches Adam's target almost verbatim**: "oh 虽然你没和我说过但我看你简历我觉得你适合.." → "嘿，没具体问过你想找啥，看你简历那段 NEUROVAInc 的 SQL 挺硬，今天发现这 2 个对得上："

---

## What H13 changed (and what it didn't)

| Layer | BEFORE | AFTER (H13) | Status |
|---|---|---|---|
| Lead-in tone | "今日给你挑了 N 个看上去对路的:" | "嘿，没具体问过你想找啥，看你简历那段 [Company] 的 [Skill] 挺硬，今天发现这 N 个对得上：" | ✅ Replaced |
| CV facts surfaced | none | `recentCompany`, `topSkills[0]` named in lead-in | ✅ Replaced |
| Per-job reason | none | `formatJobLineWithReason` injects "你 [Skill] 经验直接对得上" when `topSkills ∩ requiredSkills` non-empty | ⚠️ Did not fire on Adam's run because mastercard/deloitte JDs have empty `requiredSkills` in our corpus |
| Bible v7.5.2 bare URL on its own line | preserved | preserved | ✅ |
| Bible 3-sentence cap on lead-in | implicit (~14 chars) | hard cap 250 chars (sliced) | ✅ |
| Bilingual zh/en symmetric | zh-only | zh + en variants | ✅ |
| Flag-gated rollout | n/a | `paFriendToneOpenerEnabled` (default **true** — copy fix, not behavior change) | ✅ |
| LLM calls in this path | 0 | **0** (per-job reasons are token-overlap heuristic) | ✅ matches Adam's "ZERO new LLM calls in this path" constraint |

---

## Variant matrix (all three variants exercised by tests)

| Variant | Trigger | Lead-in (zh example) | Lead-in (en example) |
|---|---|---|---|
| **A** CV + stated prefs | `recentCompany && hasUserStatedPreferences` | "今天看到这 3 个跟你之前说想找的支付方向对得上：" | "Spotted 3 that line up with the payments angle you mentioned:" |
| **B** CV only | `recentCompany && !hasUserStatedPreferences` | "嘿，没具体问过你想找啥，看你简历那段 NEUROVA 的 Python 挺硬，今天发现这 3 个对得上：" | "Hey — haven't asked what you're after exactly, but your Python stretch at NEUROVA looked solid; here are 3 that line up:" |
| **C** No CV | `!recentCompany` | "今日给你挑了 3 个看上去对路的（顺便发我看看简历不？我帮你过一遍）：" | "Picked 3 that look on point today. (btw — wanna send me your CV? happy to give it a once-over):" |

---

## Forward-compatibility note (D5/D13 hook)

`loadDailyPushContext` already reads `pa-users/{userId}.statedPreferences.{targetRole, prefersStartup, visaStatus}` and routes to **variant A** when ANY of those are populated. The route is **wired but dormant** — flips on automatically the moment Phase 44 (Onboarding probe v2 / D5+D13) starts writing those fields. No additional H13-side change needed.

## Technical-debt records (handed to P8)

1. **TD-H13-1: per-job concrete reason often empty in production**. Adam's brief asked for "Senior PM Stripe — 你 NEUROVA 支付管线那段直接对得上"-style per-job reasons citing a specific CV fact. H13 ships token-overlap heuristic only (`topSkills ∩ job.requiredSkills`). On the LIVE Adam run, neither mastercard nor deloitte JDs carry `requiredSkills`, so `buildJobReason` returns "" and the lines fall back to plain title-line. **Real fix**: Phase 42 (D2) async match-explainer using Qwen-7B (existing SiliconFlow free tier). H13 leaves the formatter signature ready for a richer reason string; D2 only needs to populate it.

2. **TD-H13-2: Variant A unreachable until D5 lands**. `hasUserStatedPreferences` reads `pa-users.statedPreferences` which is the v1.5 onboarding-probe v2 landing zone (Phase 44, not yet shipped). Until that lands every CV-known user is variant B. Tests cover variant A end-to-end via injected ctx — production routing will start the moment Phase 44 starts writing the field, no H13 redeploy needed.

3. **TD-H13-3: Cross-encoder + dedupe pipeline reads `parsedCandidateResumes` twice per user**. Once inside the cross-encoder block (lines ~828-851 of daily-batch.ts) for query synthesis, once again inside `loadDailyPushContext`. Both are best-effort and small; not worth the refactor risk for H13. Future: lift the resume read to a single per-user-loop variable shared by both consumers.
