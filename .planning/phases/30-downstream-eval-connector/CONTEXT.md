# Phase 30 — Downstream Eval Connector (CONTEXT)

**Owner P9:** P9-Connectors (not spawned yet)
**P10 strategy:** v1.3 expansion (2026-04-28)
**ROADMAP entry:** `.planning/ROADMAP.md` Milestone v1.3 table

## 底层逻辑 (P10 quote)

> 当前 PA agent 单产文本回复, 无下游 hook. Adam 想要: 在每轮对话后, 一个 eval LLM 判某个状态是否发生 (用户提面试焦虑 / 提薪资 / 提被裁员), 命中即触发外部服务 (push mock interview 资源 / push levels.fyi snippet / 通知 HR partner). Connector 化 = 解耦. PA agent 不写业务逻辑, 业务侧也不需要懂 PA 内部. 配置驱动 = 新接入只需写 `pa-eval-triggers/{slug}` doc + 一个 endpoint.

## 顶层设计

```
post-turn hook (orchestrator)
  ↓ user msg + assistant reply
  ↓ load enabled triggers from pa-eval-triggers
  ↓ for each: eval condition (regex | nl_judge)
  ↓ if match + cooldown passed → dispatch HTTP POST (HMAC signed)
  ↓ log fire to pa-eval-fires
```

Eval pipeline 是 fire-and-forget; never throws into the chat path. 失败仅 log + audit event.

## Schema (locked)

`pa-eval-triggers/{slug}`:
```
{
  slug: string,                    // doc id
  name: string,                    // human label
  enabled: boolean,
  condition: {
    kind: "regex" | "nl_judge",
    pattern?: string,              // regex source if kind=regex
    flags?: string,                // regex flags
    judgePrompt?: string,          // for kind=nl_judge: NL question yes/no
    judgeModel?: string            // default "gpt-4.1-nano-2025"
  },
  endpoint: string,                // https://...
  method: "POST",                  // v1: POST only
  payloadTemplate: string,         // Mustache-lite, see Phase 31 renderer
  hmacSecretRef: string,           // Secret Manager key id
  cooldownSec: number,             // per-user × per-trigger
  owner: string,                   // partner / team email
  createdAt: Timestamp,
  updatedAt: Timestamp,
  updatedBy: string
}
```

`pa-eval-fires/{userId}_{slug}_{bucketTs}` (cooldown key + log row):
```
{
  triggerSlug: string,
  userId: string,
  firedAt: Timestamp,
  conversationId: string,
  matchedText: string,             // sanitized snippet for audit
  endpoint: string,
  httpStatus: number | null,
  errorMsg: string | null,
  ttlExpiresAt: Timestamp          // for Firestore TTL policy
}
```

`bucketTs = floor(now / cooldownSec) * cooldownSec` — composite key prevents racey double-fire within cooldown window.

## Eval pipeline (orchestrator integration)

`packages/pa-orchestrator/src/eval-connectors/`:
- `pipeline.ts` — `runPostTurnEvals(turn): Promise<void>`, called after assistant reply persisted, NOT awaited on chat path
- `regex-eval.ts` — synchronous regex match
- `nl-judge.ts` — calls nano with `judgePrompt`, expects yes/no answer (parse first token), 1.5s timeout
- `dispatcher.ts` — HMAC sign + POST + retry (1 retry on 5xx, 30s timeout total)

Cooldown check: `pa-eval-fires/{userId}_{slug}_{bucketTs}` exists → skip.

Master kill switch: feature flag `evalConnectorsEnabled` (Phase 24.5). Default `false` until Adam flips on.

## Cooldown semantics

- Per-trigger × per-user.
- Key: `{userId}_{slug}_{bucketTs}` where `bucketTs = floor(now/cooldownSec)*cooldownSec`.
- Same trigger fires for the same user only once per bucket window.
- Firestore TTL on `ttlExpiresAt` field cleans logs after 30 days.

## Success criteria

1. `pa-eval-triggers/{slug}` + `pa-eval-fires/{id}` collections + schema enforced
2. Dashboard `/admin/triggers` — list/create/edit/disable/delete + recent fires drawer per trigger
3. Runtime eval pipeline: post-turn, fire-and-forget, never throws into chat path
4. Two condition kinds working: `regex` (sync) + `nl_judge` (nano call, 1.5s timeout, parse yes/no)
5. Dispatcher: HMAC-signed payload (header `X-PA-Signature: sha256=<hex>`), 1 retry on 5xx, 30s total timeout
6. Cooldown enforced (per-user × per-trigger × bucket window)
7. Fire log written to `pa-eval-fires` with HTTP status + error
8. Two default triggers seeded (disabled by default, Adam enables manually):
   - `mentioned_layoff` — nl_judge "did the user mention being fired or laid off?" → POST to placeholder endpoint
   - `mentioned_salary_research` — nl_judge "did the user share a specific salary number or ask about pay benchmarks?" → POST to placeholder endpoint
9. Master kill switch: `evalConnectorsEnabled` flag (default `false`); when `false` pipeline exits early

## Architectural decisions (locked)

- **Where to hook**: orchestrator post-turn, AFTER assistant message persisted, BEFORE outbound dispatch. Awaited only with `Promise.race(timeout=2s)` so chat path is never blocked >2s by eval work; remaining trigger work continues in background.
- **Master kill switch**: feature flag (Phase 24.5).
- **Auth to downstream**: HMAC SHA256 over body, secret per-trigger via Secret Manager ref (NOT inline in Firestore).
- **Cooldown**: composite-key Firestore doc with TTL. NOT in-process (multi-CF instance safe).
- **NL judge model**: gpt-4.1-nano-2025 (locked, cheap). NOT eval-specific model.
- **Retry**: 1 retry on 5xx with 1s backoff. NOT exponential (caller is fire-and-forget, drop after 2 attempts).
- **No throw policy**: every call site has try/catch that writes `pa_abuse_events` (`type: "eval_connector_error"`) and returns. Chat path never sees connector errors.

## Out-of-scope (DO NOT do)

- DO NOT support GET/PUT/DELETE methods (POST-only v1)
- DO NOT support webhooks WITH bodies (we send body, not receive — Phase 31 is inbound)
- DO NOT add LangChain/agentic eval (single-pass nano judge only)
- DO NOT block chat path on dispatcher result (fire-and-forget is the design)
- DO NOT auto-enable seeded triggers (Adam flips per partner integration)
- DO NOT support per-trigger model overrides beyond `judgeModel` field (no temperature / max_tokens config)

## Risks

- R1: NL judge false positive fires endpoint → spurious downstream noise. Mitigation: cooldown + Adam review of fire log + ability to disable instantly via dashboard.
- R2: Endpoint hangs → CF timeout pollution. Mitigation: 30s total timeout in dispatcher, fire-and-forget design.
- R3: HMAC secret leak in audit log. Mitigation: dispatcher logs ONLY `X-PA-Signature` header value (the hex, public), NEVER the secret. Secret only resolved at sign-time from Secret Manager.
- R4: Eval cost runaway. Mitigation: Phase 26 cost alerts already monitor nano spend; this phase adds `pa.eval.connector_calls` log-based metric for granular tracking.
