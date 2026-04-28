# Phase 29 — Agent Handbook (CONTEXT)

**Owner P9:** P9-Handbook (not spawned yet)
**P10 strategy:** v1.3 expansion (2026-04-28)
**ROADMAP entry:** `.planning/ROADMAP.md` Milestone v1.3 table

## 底层逻辑 (P10 quote)

> Bible v7.0 现在是隐式的 — 内嵌在 `packages/agent-registry/src/seed.json` + Firestore `pa-agents/{id}.systemPrompt` 字段. 改一句话要 P10 改 seed → reseed → CF 重启 → cache invalidation. 这不是 production-grade. Handbook = 显式 + 结构化 + 版本化 + dashboard 可编辑. 复用 Phase 24.5 audit pattern (`pa_audit_events`).

把 Bible 升级成数据 (data, not code), 让 Adam 可以在 dashboard 不写代码改语气 / 改 hard rule / 加 playbook, 且每次改动可 diff / 可回滚 / 可审计.

## 顶层设计

```
pa-handbooks/{slug}                ← latest pointer (current version)
  ├── slug, version, updatedAt, updatedBy, reason
  └── sections: { identity, hard_rules, default_posture,
                  never_5, escape_hatch, tone_flavors,
                  human_tells, vocab, playbooks }

pa-handbooks/{slug}/versions/{v}   ← immutable history (audit-style)
  └── full snapshot of sections at that version
```

Orchestrator 读 `pa-handbooks/{handbookSlug}` (default `"claire"`), 用固定顺序拼成 system prompt 喂给 nano. Agent doc 不再存 inline `systemPrompt`, 改存 `handbookSlug: "claire"` 引用.

## Schema (locked)

`pa-handbooks/{slug}` (latest pointer):
```
{
  slug: string,                    // doc id, e.g. "claire"
  version: number,                 // monotonic, ++ on each save
  sections: {
    identity: string,              // who Claire is, 1-2 paragraphs
    hard_rules: string[],          // never-violate list
    default_posture: string,       // tone baseline
    never_5: string[],             // 5 forbidden behaviors (Bible §never)
    escape_hatch: string,          // when to bail to human
    tone_flavors: { [name: string]: string },  // moods
    human_tells: string[],         // micro-behaviors that humanize
    vocab: { allowed: string[], banned: string[] },
    playbooks: { [name: string]: PlaybookSpec }
                                   // headhunter, layoff, salary, etc.
  },
  updatedBy: string,               // editor email
  updatedAt: Timestamp,
  reason: string                   // why this change
}
```

`pa-handbooks/{slug}/versions/{v}`: **immutable** full snapshot of the doc above at version `v`. Created on every save. Never mutated.

`PlaybookSpec`:
```
{
  name: string,
  trigger: string,                 // when to enter this playbook
  steps: string[],                 // ordered moves
  exitCondition: string
}
```

Agent doc change: `pa-agents/{id}` drops `systemPrompt: string`, adds `handbookSlug: string` (default `"claire"`).

## Loader (orchestrator)

`packages/pa-orchestrator/src/handbook/loader.ts`:
- `loadHandbook(slug): Promise<Handbook>` — Firestore read, 30s TTL Map cache (mirror Phase 24.5 cache shape)
- `composeSystemPrompt(handbook): string` — fixed-order render (identity → hard_rules → default_posture → never_5 → escape_hatch → vocab → human_tells → tone_flavors → playbooks)
- Replaces all current reads of `agent.systemPrompt`. Agent doc still resolved by id; new step is `handbook = loadHandbook(agent.handbookSlug)`.

Cache invalidation: same pattern as feature flags (30s TTL, not 5min — handbook edits should propagate within reasonable time after dashboard save).

## Migration

One-shot script `apps/functions/scripts/migrate-bible-to-handbook.ts`:
1. Read current `pa-agents/claire.systemPrompt` + `seed.json` Bible v7.0
2. Parse into `sections` (manual mapping table in script comments — Adam reviews diff)
3. Write `pa-handbooks/claire` v1 + `pa-handbooks/claire/versions/1`
4. Write `pa-agents/claire.handbookSlug = "claire"` (does NOT delete `systemPrompt` field — left for fallback during cutover; removed in T4 after orchestrator switch is verified)

Idempotent: re-run skips if version 1 already exists.

## Success criteria (P10 locked)

1. `pa-handbooks/{slug}` collection + `/versions/{v}` sub-collection exist with above schema
2. Dashboard `/admin/handbook` page — section-by-section editor (one accordion per section, JSON-aware for arrays/objects)
3. Save creates new `versions/{v}` doc + `pa_audit_events` row (`action: "handbook.update"`); pointer doc updated atomically
4. Orchestrator reads `pa-handbooks/{slug}` at runtime, 30s TTL cache (≥95% hit rate over 1000 calls in test)
5. Bible v7.0 migrated into `pa-handbooks/claire` v1 (script run by Adam post-merge)
6. Rollback button on dashboard reverts to previous version (reads `versions/{v-1}`, writes back as new version `v+1` with `reason: "revert to vN"`)
7. Editor shows section-level diff vs previous version before save

## Architectural decisions (locked)

- **存哪**: Firestore. Versioned via sub-collection (NOT Firestore document history — too lossy + no query API).
- **缓存**: 30s TTL in-process Map<slug, {handbook, expiresAt}>. Same shape as `getFlag()` cache.
- **Compose order**: fixed in code, NOT configurable. Adam wants reordering = code change (intentional friction).
- **Default slug**: `"claire"`. Agents get `handbookSlug` field; absent → fallback to `"claire"`.
- **Audit**: every save writes `pa_audit_events` row + creates `versions/{v}` doc (both writes, transactional).
- **Field on agent doc**: `handbookSlug` is the new source of truth; `systemPrompt` left in place for one phase as failsafe, removed in a later cleanup phase.

## Out-of-scope (DO NOT do)

- DO NOT support multiple concurrent handbook variants per agent (no A/B yet — Phase 24.5 BucketStrategy doesn't apply here)
- DO NOT auto-generate handbook from voice reviews (that's Phase 27 self-evolve cron territory)
- DO NOT remove `systemPrompt` field from agent doc in this phase (cleanup phase later)
- DO NOT add markdown rendering in editor (raw text + JSON only — keep dashboard simple)
- DO NOT version individual sections separately (whole-doc snapshots only — easier diff + rollback)

## Risks

- R1: Migration mis-parses Bible v7.0 → Claire voice regression. Mitigation: Adam reviews migration diff before script runs live; eval gate (DeepEval golden-50) must pass against migrated handbook.
- R2: Cache staleness during edits → operator confusion. Mitigation: dashboard "force refresh" button bumps `version` no-op to invalidate (mirrors Phase 24.5).
- R3: Section schema drift if new section types are added later. Mitigation: `sections` is flat key-value at top level; loader tolerates unknown keys (logs warning, skips).
