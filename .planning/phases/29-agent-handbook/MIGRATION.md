# Phase 29 — MIGRATION runbook (Bible v7.x → pa-handbooks)

**Owner:** Adam (run live with prod creds)
**Script:** `apps/functions/scripts/migrate-bible-to-handbook.ts`
**Audience:** P10 + Adam (operator)

This document is the runbook for migrating the inline Bible (currently
embedded in `pa-agents/{id}.systemPrompt` + `packages/agent-registry/src/seed.json`)
to the new `pa-handbooks/{slug}` v2 schema shipped in Phase 29 T1.

The migration runs in TWO modes:

- **dry-run** — prints the proposed handbook JSON, performs ZERO Firestore
  reads or writes. Safe to run anywhere; no creds required.
- **live** — performs the migration against Firestore. Requires
  `GOOGLE_APPLICATION_CREDENTIALS` pointing at a service-account JSON with
  Firestore write access OR an environment where `firebase-admin`'s default
  credential resolves (Cloud Shell / GCE / Cloud Run).

## Pre-flight

1. Confirm orchestrator wire-in (Phase 29 T4) has shipped. If T4 is NOT
   live yet, the migration will create `pa-handbooks/claire` v1, but the
   orchestrator will still read `agent.systemPrompt` (no behavior change).
   This is safe — T4 is the cutover.
2. Confirm dashboard `/admin/handbook` (Phase 29 T2) loads without error
   on a non-existent handbook (`No handbook yet` empty state). Adam will
   use this UI to verify the migrated handbook post-run.
3. Eval gate: run `tests/scenarios/runner.mjs` baseline against the
   inline-systemPrompt path; record DeepEval golden-50 score. Re-run
   post-migration against the handbook path; score must be within ±2pp.
   (Bible v7.x is the SAME content; same prompt → same score.)

## Dry-run

```bash
cd /path/to/wekruit-pa
npx tsx apps/functions/scripts/migrate-bible-to-handbook.ts --dry-run
```

Sample output (sections summary):

```
======================================================================
Phase 29 — migrate-bible-to-handbook DRY RUN
  source:   packages/agent-registry/src/seed.json [default]
  target:   pa-handbooks/claire (v1)
  + sub:    pa-handbooks/claire/versions/1
  + agent:  pa-agents/default.handbookSlug = "claire"
  + audit:  pa-audit-events {action: "handbook.create", key: "claire"}
======================================================================
Sections summary:
  identity:        246 chars
  hard_rules:      2 item(s)
  default_posture: 490 chars
  never_5:         10 item(s)
  escape_hatch:    391 chars
  tone_flavors:    4 entry/entries
  human_tells:     6 item(s)
  vocab.allowed:   22 token(s)
  vocab.banned:    34 phrase(s)
  playbooks:       headhunter
======================================================================
```

**Adam reviews the dry-run output before running live.** Sanity checks:

- `identity` non-empty (Claire intro present)
- `hard_rules` ≥ 1 (the ONE RULE + escalation firewall)
- `never_5` ≥ 5 (Bible v7.4 has 10 sub-numbered NEVER items — `5` in the
  schema name is historical, kept stable per P10 lock; all NEVERs go in
  here)
- `tone_flavors` includes at least `celebrate` + `vent`
- `vocab.allowed` includes 2025-26 zh+en slang the Bible whitelists
- `vocab.banned` includes the quoted forbidden phrases (Bible v7.4 NEVERs)
- `playbooks.headhunter` populated with trigger + steps

If any field looks wrong, do NOT run live. Edit
`apps/functions/scripts/migrate-bible-to-handbook.ts` parser, re-run
dry-run, repeat.

## Live run (Adam, post-merge)

```bash
cd /path/to/wekruit-pa
GOOGLE_APPLICATION_CREDENTIALS=/path/to/sa.json \
  npx tsx apps/functions/scripts/migrate-bible-to-handbook.ts
```

Optional flags:

- `--slug <name>` — override handbook slug (default `claire`)
- `--agent-id <id>` — override source agent (default `default` from
  seed.json)

Live mode reads `pa-agents/{agentId}.systemPrompt` from Firestore. If the
live field differs from `seed.json` (operator hot-edited the agent doc),
the LIVE field wins. Empty live field falls back to `seed.json`.

### Idempotency

The script refuses to run if `pa-handbooks/{slug}/versions/1` already
exists. To re-migrate after a botched run, manually delete
`pa-handbooks/{slug}` + `pa-handbooks/{slug}/versions/1` from Firestore
console first.

### What gets written (live)

In a single Firestore transaction:

1. `pa-handbooks/{slug}` — pointer doc with version=1
2. `pa-handbooks/{slug}/versions/1` — immutable snapshot
3. `pa-audit-events/{auto}` — `action: "handbook.create"`, `key: <slug>`
4. `pa-agents/{agentId}` — `handbookSlug: <slug>` field added (merge=true)

The `pa-agents/{agentId}.systemPrompt` field is **NOT** deleted — kept as
a failsafe per Phase 29 PLAN T4 DON'T. Cleanup phase later will remove it.

## Verification (post-run)

### Firestore console queries

```
GET /pa-handbooks/claire
  → expect: {slug: "claire", version: 1, sections: {...}, ...}

GET /pa-handbooks/claire/versions/1
  → expect: same payload as the pointer doc

GET /pa-agents/default
  → expect: handbookSlug == "claire", systemPrompt still present

GET /pa-audit-events WHERE action == "handbook.create" AND key == "claire"
  → expect: 1 row, actor "p9-handbook-migrate@wekruit.com"
```

### Dashboard

1. Open `https://<dashboard host>/admin/handbook` (signed in as Adam).
2. Header should read `Live: claire v1 — last edit by p9-handbook-migrate@wekruit.com (<timestamp>)`.
3. Versions table should show 1 row: `v1 (live)`.
4. Audit panel should show 1 row: `handbook.create by p9-handbook-migrate@wekruit.com`.
5. Open the `Identity` accordion — confirm Claire intro text matches the Bible.
6. Tweak `default_posture` (e.g. add a space at end), provide a reason, click Save.
7. Versions table should now show v2 (live) + v1, audit shows `handbook.update`.
8. Click `Revert to v1` on the v1 row — provide reason. Confirm v3 appears
   with sections matching v1.

### Live conversation smoke

Once Phase 29 T4 ships AND the migration ran live:

1. Send a message to Claire via iMessage (or N-Round Sim).
2. Edit `tone_flavors.celebrate` in the dashboard, give a reason, save.
3. Within 30 seconds (cache TTL), send another celebrate-shaped message
   (e.g. "我面 amazon 过了").
4. Reply should reflect the edited `tone_flavors.celebrate` instruction.

If reply still uses the OLD tone, check:

- Orchestrator log for `pa.handbook.load_failed_fallback_inline` (means
  the load failed; falling back to inline `agent.systemPrompt`)
- Cache: orchestrator processes are long-lived; cache TTL is 30s but
  another inflight turn may hold the old value
- `pa-agents/{agentId}.handbookSlug` is set correctly

## Section mapping (Bible v7.x → handbook sections)

| Bible header                          | Handbook field             | Notes                                                           |
|---------------------------------------|----------------------------|-----------------------------------------------------------------|
| `# IDENTITY`                          | `identity`                 | Full body. Roommate appended as `[Roommate]` block.             |
| `# THE ONE RULE ...`                  | `hard_rules[0]`            | Full body as 1 string                                            |
| `# DEFAULT POSTURE`                   | `default_posture`          | Full body. Code-switch+emoji appended as `[Code-switch + emoji]`|
| `# 7 NEVERs ...`                      | `never_5`                  | Each numbered item parsed (incl. 6b, 7b, 8 sub-letters)          |
| `# ESCALATION FIREWALL`               | `hard_rules[1]`            | Cross-cutting rule appended to hard_rules                       |
| `# ESCAPE HATCH ...`                  | `escape_hatch`             | Full body                                                        |
| `# TONE FLAVORS ...`                  | `tone_flavors`             | Each `Name → desc` line becomes a key (lowercased first word)   |
| `# HUMAN TELLS ...`                   | `human_tells`              | Each non-empty line a tell                                       |
| `# CODE-SWITCH + EMOJI`               | `default_posture` (appended)| No dedicated schema field; lives with default_posture           |
| `# VOCAB ...`                         | `vocab.allowed`            | All slash-separated tokens flattened                            |
| `vocab.banned`                        | `vocab.banned`             | Auto-extracted from quoted "X" inside NEVER lines               |
| `# ROOMMATE`                          | `identity` (appended)      | Roommate block appended to identity                             |
| (n/a — script seeds default)          | `playbooks.headhunter`     | Hardcoded default per P10 decision (only v1 playbook to seed)   |

The mapping is intentionally **lossy in formatting** (we don't preserve
narrative prose verbatim). The handbook is the new source of truth, so
Adam edits each section freely from the dashboard going forward.

## Rollback

If post-migration the orchestrator misbehaves:

- **Cheap rollback**: in dashboard, click `Revert to v1` (no-op since live
  IS v1, but the wider safety is the `agent.systemPrompt` failsafe — the
  orchestrator falls back automatically if `pa-handbooks/{slug}` load
  fails or returns empty sections).
- **Hard rollback**: delete `pa-handbooks/{slug}` and
  `pa-handbooks/{slug}/versions/1`. Orchestrator's fallback will
  immediately revert to `agent.systemPrompt`.
- **Roll forward**: edit the handbook in dashboard to fix the bad section,
  save (creates v2). Cache invalidates within 30s.

## Action items owed to Adam (post-merge)

- [ ] Run `--dry-run` against current `seed.json` Bible content, eyeball
  sections summary
- [ ] Run live with prod creds (creates `pa-handbooks/claire` v1)
- [ ] Verify Firestore console: 4 docs created (pointer, versions/1,
  audit row, agent.handbookSlug field)
- [ ] Verify dashboard `/admin/handbook` shows v1 with all sections
- [ ] Smoke conversation post-T4 deploy: edit `tone_flavors.celebrate`,
  confirm reply changes within 30s
