# v2.2 Hand-off from v2.1 — Voice Prescreen Outbound

**Status:** SKELETON (filled at S7 ship gate).
**Source milestone:** [`MILESTONE-v2.1-voice-prescreen.md`](../MILESTONE-v2.1-voice-prescreen.md).
**Owner of v2.2:** Adam + future P10 lead.

## Intentionally Deferred From v2.1 → v2.2

| Topic | Why deferred | What v2.1 leaves in place |
|---|---|---|
| Inbound call answer (candidate dials in) | v2.1 scope = outbound only; inbound needs separate Twilio inbound trunk + IVR + identity-resolution-by-callerID flow | Outbound caller IDs reserved; no inbound config |
| External candidate launch (consumer numbers) | TCPA production gate not yet hardened with real consent flows | TCPA plumbing complete (S5), `PA_TCPA_GATE_ENFORCED=true` blocking in prod; v2.1 prod sends only to internal numbers |
| Production rollout (full candidate base) | Need ≥8/10 smoke + multi-day soak before scale | S6 internal smoke + S4 telemetry baseline + S5 gate-on dry run |
| Cartesia TTS swap (Aura-2 → Cartesia evaluation) | Out of cycle to keep S2 lean; per-profile flag pattern already in place | TTS plugin abstraction in S2 worker accepts swap; `CARTESIA_API_KEY`/`CARTESIA_CLAIRE_VOICE_ID` env reserved |
| Multi-leg / call transfer | Not needed for prescreen scope | Hangup state machine assumes single leg |
| Voice analytics dashboard for stakeholders | Operator-only metrics in v2.1 | `voice-call-metrics/{callSid}` collection populated; query path documented |
| Retell deprecation | PA profiles always LiveKit per L3 but legacy Retell still wired behind per-profile flag | Flag stays; deprecation scheduled v2.3+ |
| Voice path for non-prescreen flows (e.g. proactive outbound matching) | Only prescreen jobs supported in v2.1 | Worker hard-binds to `outbound-bookings.purpose === "prescreen"` |

## Known v2.1 Sharp Edges to Address

- [ ] Recording retention policy currently defaults to 90d — S5 to refine per TCPA in v2.2.
- [ ] Cost ceiling enforcement ($1/call) — v2.1 hard-stops; v2.2 may want graceful summary instead of hard hangup.
- [ ] Turn telemetry thresholds (<10% false-commit, <5% false-interrupt) calibrated on internal numbers only — recalibrate on real candidate distribution in v2.2.
- [ ] LiveKit Cloud agent concurrency cap — v2.1 = 1 per instance until soak data exists.

## v2.1 Artifacts v2.2 Reads

- `.planning/V21-VOICE-PRESCREEN-GOAL-PROMPT.md`
- `.planning/MILESTONE-v2.1-voice-prescreen.md`
- `.planning/v2.1/sprints/S{0..7}/SUMMARY.md`
- `voice-call-metrics/` Firestore collection (operational data baseline)
- LiveKit Cloud deploy commands captured in S2/S6 SUMMARY

## v2.2 Adam-action Inputs (gather before v2.2 P10 spawn)

- Inbound trunk config + DID number(s)
- Production TCPA consent flow (recording disclosure script + opt-in capture)
- Production rollout cohort definition (how many real candidates, which jobs)
- Cartesia eval decision: ship swap or stay on Aura-2
