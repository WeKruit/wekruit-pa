# Intent-routing scenario stubs

Created 2026-05-02 by P7 intent-routing audit. These scenarios are **fixtures**
for the gap-4 sim-matrix agent. They are NOT meant to pass green out of the
box — they assert the routing path expected by `.planning/v1.5-playbook/INTENT-PLAYBOOK.md`.

Coverage:
- 4 ZH + 4 EN scenarios
- One per major routing surface: prompt-injection / memory-command /
  proactive-cancel / onboarding-probe-q-role / job-search-headhunter /
  rate-limit-1m / casual-chat-fallthrough / crisis-ideation (gap §3.1)

Usage:
  GOOGLE_APPLICATION_CREDENTIALS=... \
  node tests/scenarios/runner.mjs tests/scenarios/intent-routing/

Each scenario uses a unique participant phone (`+19999991xxx`) so it does not
collide with the existing `tests/scenarios/scenarios/` corpus.
