# Valet Install + Auto-Apply — Extension Design

**Status:** design only (not implemented). Do not overload prescreen `_Job` / `_Apply` regex triggers.

## Product intents

| Intent | Example user signal | Needs multi-turn? |
|--------|---------------------|-------------------|
| Valet app installed | "I installed Valet" / screenshot of home screen | Maybe (verify link or package id) |
| Auto-apply readiness | "Can you apply for me?" | Yes (consent, URL, confirmation) |
| Apply link check | "Is this apply link still live?" | Often one-shot |

## Pattern recommendation

### Valet install check → **Pattern A (connector)** primary, **Pattern C (trigger)** optional

- **Connector `check-valet-install`** (future): LLM invokes when user claims install; returns `{ installed: boolean, evidence, nextStep }` from deterministic checks (deep link handshake, optional device attestation later).
- **Optional trigger** `WeKruit_Valet_<userId>_Ready` from marketing deep link — starts verification without free-form chat parsing.
- **Do not** route through prescreen `WeKruit_<jobId>_<userId>_Job`.

`toolFamily` audit value: `valet` (reserved in `@pa/pa-connectors` `resolveToolFamily`).

### Auto-apply → **Pattern D (FSM)** + **Pattern B (programmatic)** for side effects

Auto-apply is not a single tool call:

1. **FSM** on `pa-users.autoApplyFlow` — consent → job pick → URL confirm → submit → outcome.
2. **Programmatic** connector or CF only at submit step (e.g. open ATS with stored PII snapshot), never LLM-direct write to employer systems.
3. Reuse **Apply trigger** (`WeKruit_<jobId>_<userId>_Apply`) only for post-PASS PII confirm today; extend with a separate state doc for marketplace auto-apply, not the same regex namespace.

### Link liveness → **Pattern A (connector)** or batch CF

- One-shot `check-apply-url` connector wrapping existing liveness / HEAD-check infra.
- Not prescreen.

## Tracking

- `pa_tool_calls.toolFamily`: `valet` | `match_general` | `match_collab` | `web_search` | `other`
- FSM transitions: `pa_audit_events` or dedicated `pa-users.*Flow` subdoc with `source`, `reviewer` N/A for candidate-driven flows

## Flags (proposed)

| Flag | Purpose |
|------|---------|
| `paValetInstallCheckEnabled` | Gate connector + trigger |
| `paAutoApplyFlowEnabled` | Gate FSM entry |
| `paPostMatchRetentionEnabled` | Shipped sibling — post-rec sentiment FSM |

## Sequencing

1. Ship collab/general match tool allowlist + skill router v2 + `toolFamily` audit (this milestone).
2. Implement `check-valet-install` connector (Pattern A) behind flag.
3. Design auto-apply FSM with legal/consent review before Pattern D code.
