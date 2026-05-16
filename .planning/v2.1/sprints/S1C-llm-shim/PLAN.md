# S1C — PLAN

1. AGENT_PLAN.md → package path, framework choice, port default
2. Server bootstrap commit
3. `POST /v1/chat/completions` handler + SSE encoder
4. Non-stream 400 path
5. Tests: SSE format, openai SDK roundtrip, finish_reason populate
6. Regression gate
7. Push, SUMMARY.md, report
