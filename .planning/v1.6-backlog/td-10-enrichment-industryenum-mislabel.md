# v1.6 backlog — H8 enrichment industryEnum mislabel rate (root-cause for TD-#10)

**Surfaced**: 2026-05-02 during TD-#10 Cloud-side fix.
**Owner**: enrichment / Mac mini side (out of Cloud-side scope).
**Severity**: P1 — affects all cluster-OFF users with tech industryTags.

## Evidence

500-doc sample of `matching-jobs.where('industryEnum', 'array-contains-any', ['tech_software','ai_ml','fintech_finance'])` on 2026-05-02:

| `industryKey` bucket | count | tech-OK? |
|---|---:|:---:|
| fintech | 130 | ✓ |
| accounting_finance | 81 | ✓ |
| tech | 72 | ✓ |
| enterprise_saas | 65 | ✓ |
| **sales** | **32** | ✗ MISLABELED |
| ai_ml | 23 | ✓ |
| engineering | 23 | ✓ |
| data_analytics | 15 | ✓ |
| **other** | **14** | ✗ MISLABELED |
| **customer_service** | **14** | ✗ MISLABELED |
| **management** | **8** | ✗ MISLABELED (Groundskeeper, Community Manager, Branch Office Admin) |
| **unknown** | **6** | ✗ MISLABELED |
| **consulting** | **6** | ✗ MISLABELED (Tax Consultant II at Deloitte) |
| **legal** | **2** | ✗ MISLABELED |
| **government** | **2** | ✗ MISLABELED |
| **reinsurance** | **1** | ✗ MISLABELED |
| (other tech buckets) | 6 | ✓ |
| **MISLABELED total** | **85 / 500 = 17.0%** | |

## Specific examples (verified)

| docId (12-char prefix) | jobTitle | industryKey | industryEnum |
|---|---|---|---|
| 00acf47b673f | Groundskeeper - Sabine Street Lofts | management | `["fintech_finance"]` |
| ef5f28ceab72 | Assistant Community Manager - The Bellfort | management | `["fintech_finance"]` |
| a63743b7dcb4 | Marketing Liaison - State Farm Agent Team Member | marketing | `["fintech_finance"]` |
| 26a987d9a1c7 | Tax Consultant II, SAP Global Trade Services | consulting | `["fintech_finance"]` |

The `["fintech_finance"]` tag clearly hallucinated from sleeve associations (State Farm = insurance, Deloitte = finance services, Sabine Street Lofts = property/finance overlap, etc.). The classifier needs:

1. Negative anchors — jobTitle "Groundskeeper / Community Manager / Tax Consultant" should auto-exclude tech_software/ai_ml/fintech_finance.
2. Cross-validation — when `industryKey` is in {management, customer_service, sales, legal, ...}, refuse to assign tech industryEnum unless jobTitle/required_skills explicitly contradicts.
3. Confidence threshold — drop low-confidence classifications instead of forcing one-hot.

## Cloud-side mitigation (already shipped)

`apps/job-rec/src/tools/query-matching-jobs.ts` — `applyEnrichmentNeverList` rejects docs whose `industryKey` ∈ NON_TECH_NEVER_KEYS when user is tech-leaning. Defensive guard, not a fix; logs `[queryMatchingJobs] enrichment_never_list_rejected` for ongoing monitoring.

## Acceptance for v1.6

- Re-run the 500-doc sample query — mislabel rate < 5%.
- Cloud-side never-list logs zero rejections for fresh enrichment over 7 days.
- The 4 specific jobIds above either drop their tech industryEnum tags OR get marked status=rejected.
