# v1.5 Job-Rec E2E Verification — Adam (UID e5d97cd8…aeef2e)

Run date: 2026-05-02. Source: `apps/functions/scripts/dryrun-adam-e2e.mjs`
(read-only Firestore, no SMS sent).

## Headline

**FAIL on job count.** Final ranked list returns **2 jobs**, target was 5–8.
Friend-tone, match-explainer, and hard-filter mechanics work as designed —
the bottleneck is **dedupe collapsing 10 cosine-survivors into 2 unique
(title, company) pairs**, exposing low corpus diversity for Adam's profile.

## Pipeline trace (Adam, today)

| Stage                         | Count | Notes |
| ----------------------------- | ----- | ----- |
| `queryMatchingJobs` pool      | 20    | Firestore `industryEnum array-contains-any [tech_software, ai_ml, fintech_finance]`. Top 9 are `industryKey=management` noise (Groundskeeper, Branch Office Admin) — they only carry one of the 10-tag `industryEnum` values. |
| `applyHardFiltersWithFallback`| 20→20 | `relaxLevel=none`. Adam's `statedPreferences` is empty AND no resume exp has `endDate=present` → no senior/research/visa/location rule fires. Adam IS finishing M.S. Dec 2025, but `inferCollegeStudent` requires `endDate=="present"`. `parseStartYearMonth("Aug2025")` returns `null` (regex expects `YYYY` or `YYYY-MM`); resume parser writes unseparated `MmmYYYY`. |
| Cosine rerank                 | 20→10 | Top-10 = 6× Mastercard *Strategy & Transformation Consultant* (multi-city duplicates) + 4× Deloitte *Tax Consultant II SAP GTS* (multi-city duplicates), both `industryKey=consulting`. |
| Cross-encoder rerank          | 10→10 | BGE-reranker scores top item at `2.31e-3` — universally low. |
| Startup boost                 | n/a   | `userSignal=0` (neutral, no `prefersStartup` set), 0 explanations. |
| Dedupe (title, company)       | 10→2  | **Collapse: 10 surface as 2 unique roles.** |
| Title anti-bias + slice       | 2→2   | No QA/QC titles to penalise. |
| Match-explainer (top-3)       | 2/2   | Both got Qwen-7B reasons. Cost ≈ $0.000045 total. |
| Friend-tone format            | OK    | Variant **B_cv_only** (recentCompany=NEUROVAInc, no statedPreferences) → `"嘿，没具体问过你想找啥，看你简历那段 NEUROVAInc 的 SQL 挺硬，今天发现这 2 个对得上："` |

## Verdicts

- **Job-count target (5–8)** — **FAIL**. Returned 2.
- **CV grounding** — **PASS as message text, FAIL as ranked relevance**. Adam is a Master's Data Analyst (SQL/Python/R/ML). The 2 returned jobs are *Strategy Consultant* and *Tax Consultant SAP GTS*. The friend-tone opener and explainer text correctly reference NEUROVAInc and SQL, but the underlying jobs aren't data/AI/fintech-tech roles.
- **Friend-tone formatting** — **PASS**. Variant routing correct, bare URL on its own line, 250-char lead-in cap honoured.
- **Match-explainer hit rate (top-3)** — **PASS, 2/2** (only 2 jobs survived; both populated).
- **Hard-filter compliance** — **PASS in code, IRRELEVANT for Adam**. No `senior/staff/principal/lead` titles leaked, no `sponsorship=false` jobs leaked. Hard-filter rules never fired because `statedPreferences` is empty AND date-format mismatch (`Aug2025` vs `YYYY-MM`) defeats the still-in-school inference.

## Root causes

1. **Dedupe collapses cosine winners** because the corpus stores the same JD reposted per metro (Mastercard × 6 cities, Deloitte × 4). The cosine layer can't distinguish them — they tie at `0.4239` / `0.3499`. By the time dedupe runs, the top-10 has only 2 unique roles. A wider cosine pool (e.g. `crossEncoderPoolSize=25` instead of `10`) would let the cross-encoder + dedupe still produce 5+ unique items.
2. **Industry-tag corpus skew.** 6688 jobs in the corpus carry one of Adam's 3 tags via `industryEnum`, but `firstSeenAt desc` ordering surfaces a noisy front of `industryKey=management/consulting/sales` rows. The Jaccard pre-rank inside `queryMatchingJobs` doesn't aggressively de-prioritise them at the 20-cap.
3. **`statedPreferences` empty + CV date-format mismatch** ⇒ hard-filter is a no-op for Adam. Adam IS a college student, but neither rule recognises him because his most recent resume entry has `endDate=Oct2025` (not `"present"`) and the parser writes `Aug2025` which fails `parseStartYearMonth`.

## Recommendations (no code changes shipped this turn — read-only run, scope was verification)

- **Quick win (≤30 LoC)**: bump `crossEncoderPoolSize` default from 10 to 25 in `runDailyJobRecBatch`; dedupe BEFORE cross-encoder so the cross-encoder reranks unique roles only. This alone likely doubles Adam's final count.
- **Medium**: backfill / re-parse Adam's resume with consistent date format (`YYYY-MM`), or relax `parseStartYearMonth` to accept `MmmYYYY`.
- **Strategic**: ship onboarding probe v2 to populate `statedPreferences.yoeRange=[0,1]` for graduating students; that fixes the silent hard-filter bypass for everyone in Adam's cohort.

## Evidence

Final body (Variant B, zh):
```
嘿，没具体问过你想找啥，看你简历那段 NEUROVAInc 的 SQL 挺硬，今天发现这 2 个对得上：

- Consultant, Advisors & Consulting Services, Strategy & Transformation @ mastercard (Chicago, Illinois) ~$139k — NEUROVAInc 的数据分析实习经历和你擅长的 SQL、Python、R 正好契合 Mastercard 对咨询顾问和数据智能方面的要求。
https://jobright.ai/jobs/info/69cad8a5e565c26a7004149b?…

- Tax Consultant II, SAP Global Trade Services (GTS) @ deloitte (Richmond, VA) ~$121k — 你的数据分析实习经历和NEUROVA Inc的工作经历正好匹配Deloitte Tax Consultant II的供应链管理要求…
https://jobright.ai/jobs/info/6939e1cbac80bb5492bc5df4?…
```

Production cron at 2026-05-02T16:00:05Z delivered 1 job (Mastercard Boston) with the same Variant-B opener — consistent with this dry-run.
