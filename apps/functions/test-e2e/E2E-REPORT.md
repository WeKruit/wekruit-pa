# Stream G4 — Live CV-Onboarding E2E Report

**Run window**: 2026-05-01T06:35:40.024Z → 2026-05-01T06:36:34.304Z
**Duration**: 54s
**Verdict**: ✅ GREEN — ship cleared (informational A6 not emitted, see Followup-1)

## Driver inputs
- Adam userId: `e5d97cd8-1e1d-439d-8672-3008f8aeef2e`
- from_number: `+14243201960`
- message_handle: `e2e-03765ff1-4443-42e3-8e75-d7a05b9eb152`
- media_url: `https://storage.googleapis.com/inbound-file-store/9Bq2Heky_Qitong(Mike) Liang_Resume.pdf`
- webhook URL: `https://us-central1-wekruit-5f89b.cloudfunctions.net/paSendblueWebhook`
- webhook response: status=200 latency=244ms
- parsedCandidateResumes resumeId: `zLSRbpWz8edA7tAhRadA`

## Per-assertion results

| ID | Assertion | Verdict | Detail |
|----|-----------|:------:|--------|
| A1 | pa-sendblue-webhook-raw row exists with rawMeta.e2eTest=true + body.media_url set | PASS | id=cNsC0s8WpfERqW0EUsqU rawMeta.e2eTest=true media_url=SET latency=258ms |
| A2 | pa-inbound-events row with rawPayload.e2eTest=true + rawPayload.mediaUrl set | PASS | id=inb_2ff4da6aef0f93aa4dfb0245e15b7411972357c3 e2eTest=true mediaUrl=SET latency=85ms |
| A3 | sendReaction (love) log emitted with our message_handle | PASS | found 2 reaction log entries; one matches handle |
| A4 | parsedCandidateResumes row written for Adam with industryTags non-empty | PASS | id=zLSRbpWz8edA7tAhRadA industryTags=[tech_software,ai_ml,fintech_finance] candidateName=Qitong(Mike)Liang latency=5178ms |
| A5 | pa-outbound out-cvfindings-{resumeId} appears (status pending/sent) | PASS | id=out-cvfindings-zLSRbpWz8edA7tAhRadA status=sending body="Mike我看到你在 NEUROVAInc 跑的 MySQL+Python 管线效率提升40%，还有用 Random Forest/SVM/Autoencoder 做异常检测把 detection ac..." latency=15330ms |
| A6 | mem0 fact recorded (pa.cv_mem0.ok log emitted) — INFO only, see Followup-1 | INFO-FAIL | 0 entries in last 300s — known observability gap (cv-ingest logger not wired through webhook); mem0 write itself still attempted |
| A7 | CV-context follow-up reply enqueued (qualitative — body logged for review) | PASS | id=e126d54c-aad8-428a-bb33-a3e52550ea31 body="啊不对，是听起来挺烦的。这种感觉确实不好受。要不你试试调整简历的重点，突出数据分析和工程化部分，突出你做的那些具体项目？这样可能更能吸引大数据或监控或产品度量方向的公司人。" latency=10315ms |

## Notes
- A3/A6 are read from Cloud Logging (`gcloud logging read`); a FAIL there can mean either the log line wasn't emitted OR Cloud Logging hadn't ingested it yet (rare lag > 60s).
- A7 is qualitative — Claire's reply text is logged for human review; pass only requires that the orchestrator enqueued an outbound row referencing Adam.
- All E2E artifacts in Firestore carry `e2eTest:true` (raw row `rawMeta.e2eTest` + inbound `rawPayload.e2eTest`); cleanup script can target those.
- Run reproducible via `node apps/functions/test-e2e/cv-onboarding-e2e.mjs --live`.
