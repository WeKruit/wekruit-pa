# WS4-A — Skill V2 schema + stacker + 6-skill migration + intent classifier (WS5)

> **Owner**: WS4-A engineer (LLM/prompt + light orchestrator). Pairs with WS4-B (13 new skill bodies) and WS5-impl after this lands.
> **Scope (HARD bounded)**: schema, stacker, migration of EXISTING 6 skills, intent-classifier design, router wiring, tool-gating wire, SDK handoff workaround. **NOT in scope**: 13 new skill addendum bodies, 38 LLM-judge YAMLs.
> **Effort**: ~10 dev-days (target). Two-engineer pair-friendly; runs parallel to WS4-B.
> **Depends on**: WS3 RunContext landed (`run-context.ts`, `loadTurnContext()`), WS6 Output guardrail interface stub.
> **Unblocks**: WS4-B (skill bodies), WS5-impl (router + classifier wiring), WS6 tool-gating enforcement.
>
> Authoritative locks: `discussion.md` lines 1-58 (ADAM DECISIONS 2026-05-03). Plan reference: `PLAN.md` L181-235 (WS4) and L239-275 (WS5). Audit: `PLAN-AUDIT.md` §B (coverage), §C (deps), §G (cross-cutting). SDK gotcha: `packages/agent-runtime/node_modules/@openai/agents-core/dist/run.d.ts:211`.

> [PUA生效 🔥] 这一份不是 schema 复读 — 是把 19-skill 上线前每一处会爆雷的接缝（V1→V2 双写、tool-gating 桥 WS6、handoff guardrail re-entry、Qwen-7B free-tier 限流降级）一次性焊死。下游工程师拉走就能写代码，不用回 P10 追问 day-1 issue。

---

## 0. Required-reads checklist (engineer must read first)

| File | Lines | Why |
|---|---|---|
| `.planning/iter30/PLAN.md` | L181-235, L239-275 | WS4 + WS5 spec; field count is **7+1**, not 5 (audit-corrected) |
| `.planning/iter30/discussion.md` | L1-58 | Adam locks (Qwen-7B free, regex floor only, "playbook"→"skill" external rename) |
| `.planning/iter30/PLAN-AUDIT.md` | §B (L43-85), §C (L88-130), §G (L294-329) | Coverage gaps, dep correction, cross-cutting `allowedTools`/`paths`/`llmInvokable` restoration |
| `.planning/iter30/skills-vs-playbook-research.md` | L364-462 (hybrid Zod), L494-514 (multi-skill algo) | Schema model + activation pseudocode |
| `.planning/iter30/ws-3-6-detail.md` | L85-198 (`ClaireContextSchema`), L900-906 (handoff IG warning) | ctx fields skill activation reads + SDK handoff caveat to design around |
| `packages/agent-registry/src/playbooks.ts` | full (794 lines) | Existing 6-skill source of truth + audit/CRUD/seed pattern |
| `packages/pa-orchestrator/src/playbook-cache.ts` | full (82 lines) | Hot-path cache contract; V2 stacker keeps this shape |
| `packages/pa-orchestrator/src/onboarding-intent.ts` | L1-130 (≈381 total) | Bilingual regex classifier + cost reference (zero-LLM today) |
| `@openai/agents-core/dist/run.d.ts` | L211 | "only the first agent's input guardrails are run" → handoff workaround §8 |

---

## 1. Task breakdown (≤1-day units, ~10 dev-days)

| # | Task | Owner | Effort | Output | Depends on |
|---|---|---|---|---|---|
| T1 | `SkillSchemaV2` Zod + types + dual-read fromSnap | WS4-A | 1.0d | `packages/agent-registry/src/skill-schema.ts` (NEW) | WS3 land |
| T2 | Backward-compat fromSnap unit tests (V1 doc → V2 read with defaults) | WS4-A | 0.5d | `skill-schema.test.ts` | T1 |
| T3 | Migrate 6 existing skills metadata (`headhunter`/`vent_support`/`motivation_nudge`/`jd_roast`/`interview_prep`/`negotiation`) — Zod fixtures with `intentDescription`/`provides[]`/etc | WS4-A | 1.5d | `packages/agent-registry/src/skill-defaults.ts` (NEW) + spec table for WS4-B import | T1 |
| T4 | Firestore migration script (write 8 new fields onto existing 6 docs, idempotent, audit-rowed) | WS4-A | 0.5d | `apps/functions/scripts/migrate-skills-v2.mjs` | T3 |
| T5 | `SkillStacker` core (composability + conflictsWith + ctx-gating) + 80-line pseudocode realised | WS4-A | 1.5d | `packages/pa-orchestrator/src/skill-stacker.ts` (NEW) | T1 + WS3 ctx |
| T6 | `SkillStacker` unit tests (composability, conflict tiebreaker, ctx-gating, addendum order) | WS4-A | 0.5d | `skill-stacker.test.ts` | T5 |
| T7 | `SkillIntentClassifier` design + Qwen-7B production system prompt (≤500 tok) + JSON-mode contract | WS4-A | 1.0d | `packages/pa-orchestrator/src/skill-intent-classifier.ts` (NEW, stub-impl) | T3 |
| T8 | Classifier cache (msg-hash → result, 5-min TTL) + fail-open path | WS4-A | 0.5d | classifier file + test | T7 |
| T9 | `SkillRouter` (regex-floor + LLM-intent merge, 80-line pseudocode realised) | WS4-A | 1.0d | `packages/pa-orchestrator/src/skill-router.ts` (NEW) | T5 + T7 |
| T10 | `allowedTools` wire-in interface for WS6 OutputGuardrail | WS4-A | 0.5d | `packages/pa-orchestrator/src/skill-tool-gate.ts` (NEW, contract-only) | T5 |
| T11 | SDK handoff input-guardrail re-entry assertion (no handoffs in iter30, lint+test gate) | WS4-A | 0.5d | `skill-stacker.test.ts` augment + ESLint rule note | T5 |
| T12 | Re-baseline iter28-29 LLM-judge fixtures (vent / headhunter / negotiation) post-migration | WS4-A | 1.0d | new `tests/scenarios/playbooks-iter30/iter30-rebaseline-*.yaml` | T3 + T5 + T9 |

**Total**: 9.5d engineering + 0.5d schedule slack = **10d**. WS4-B authors 13 skill bodies in parallel against the V2 schema produced in T1; WS5-impl wires the classifier produced in T7 into production behind a flag.

Pair sequencing with WS4-B:
- WS4-A T1+T3 land **day 2** → WS4-B starts authoring 13 skill addenda against frozen schema.
- WS4-A T5+T9 land **day 6-7** → WS4-B can integration-test their skills against the stacker.
- WS4-A T12 day 10 = re-baseline gate; WS4-B's 38 LLM-judge YAMLs use this baseline.

---

## 2. SkillSchemaV2 — full Zod (7+1 fields, all backward-compat)

**File**: `packages/agent-registry/src/skill-schema.ts` (NEW)

```typescript
import { z } from "zod"

/**
 * SkillSchemaV2 — iter30. Backward-compat with PlaybookSchema (V1):
 *   - All new fields default to safe values; existing 6 V1 docs validate without modification.
 *   - V1 readers (legacy code on the cutover boundary) continue to work because no V1 field
 *     has been removed or renamed.
 *   - `playbookKey` is preserved as the doc id; `skillKey` is an alias for forward callers.
 *
 * NEW iter30 fields (7+1) — see PLAN.md L191-198 (audit-corrected count = 7+1):
 *   intentDescription, provides[], requires[], composableWith[], conflictsWith[],
 *   priority, allowedTools[], llmInvokable
 *   PLUS paths[] (schema-only, deferred to iter31 — ships as zod-validated empty array)
 *
 * Renamed-externally: dashboard + LLM-prompt label "Skill"; internal collection name unchanged
 * (`pa-playbooks`) per Adam Q4 lock (skills-vs-playbook-research.md L519-528).
 */

/** External skill type tag — hand-curated to match the 6 + 13 catalog. */
export const SKILL_KEYS = [
  // EXISTING 6 (this WS migrates):
  "headhunter",
  "vent_support",
  "motivation_nudge",
  "jd_roast",
  "interview_prep",
  "negotiation",
  // NEW 13 (WS4-B authors bodies; this WS only validates the literal-union):
  "rejection_processing",
  "post_offer_decision",
  "referral_request",
  "silence_anchor",
  "cv_followup",
  "layoff_processing",
  "company_research",
  "career_pivot",
  "return_to_work",
  "daily_batch_reply",
  "am_i_ai_check",
  "boundary_test",
  "mom_test",
] as const

export type SkillKey = (typeof SKILL_KEYS)[number]
export const SkillKeyEnum = z.enum(SKILL_KEYS)

export const SkillSchemaV2 = z.object({
  // ============ V1 fields — preserved, UNCHANGED semantics ============
  /** Doc id, kebab-case. Same Firestore key as V1. */
  playbookKey: z.string().min(1),

  /** Human label for dashboard + audit. */
  name: z.string().min(1),

  /** Free-text description (dashboard ops, NOT classifier input — see `intentDescription`). */
  description: z.string().default(""),

  /** Regex floor patterns. Stays as fast-path safety net (crisis + AB-NEVER + obvious). */
  regexTriggers: z.array(z.string()).default([]),

  /** Markdown body injected into Claire system prompt when skill is active. */
  addendum: z.string().default(""),

  /** If false, skill never matches. */
  enabled: z.boolean().default(true),

  /** iter27 onboarding routing semantics. */
  routingHint: z.enum(["no_chain", "role_chain"]).nullable().default(null),

  /** Audit fields — written by upsertSkill batch. */
  version: z.number().int().nonnegative().default(0),
  updatedAt: z.string().nullable().default(null),
  updatedBy: z.string().default(""),
  reason: z.string().default(""),

  // ============ V2 fields (7+1) — NEW iter30 ============

  /**
   * 1. **intentDescription** — fed to the LLM intent classifier (Qwen-7B).
   * 1-2 sentences telling the classifier what the skill does + when to activate.
   * Distinct from `description` (dashboard-facing) so we can A/B-tune classifier
   * accuracy independently of human-ops copy. Default empty = fall back to `description`.
   * Example: "Activate when user expresses emotional distress / burnout / breakdown
   *           (bilingual zh/en). Do NOT activate when user is asking a factual question."
   * @range 0-500 chars (validate at write-time; see SkillSchemaV2.refine)
   */
  intentDescription: z.string().max(500).default(""),

  /**
   * 2. **provides** — capability tags this skill exposes when active. Surfaced
   * to other skills' `requires[]` for prerequisite checks. Tag-namespaced:
   *   "stance:companion" | "stance:advisor" | "channel:imessage" | etc.
   * Empty = skill provides nothing for downstream gating.
   * @example ["stance:companion", "tone:vent"]
   */
  provides: z.array(z.string()).default([]),

  /**
   * 3. **requires** — prerequisite tags (other skills' provides[] OR ctx-state predicates).
   * Predicates use `ctx.<field>` dot-path: e.g. "ctx.userProfile.resumeAccepted",
   * "ctx.activeSkills:headhunter".
   * Empty = no prerequisites.
   * @example ["ctx.userProfile.resumeAccepted", "stance:advisor"]
   */
  requires: z.array(z.string()).default([]),

  /**
   * 4. **composableWith** — skill keys that can stack with this one. Empty = stacks with all
   * (V1 backward-compat default). When set, only listed skills may co-activate; non-composable
   * matches are pruned by `conflictsWith` resolution.
   * @example ["motivation_nudge", "interview_prep"]
   */
  composableWith: z.array(SkillKeyEnum).default([]),

  /**
   * 5. **conflictsWith** — skill keys that CANNOT co-activate. Resolution: highest priority
   * wins (lower number = lower priority; see `priority`). Bidirectional — declaring conflict
   * on either side is sufficient.
   * @example ["headhunter"] — vent_support refuses to stack with headhunter probes
   */
  conflictsWith: z.array(SkillKeyEnum).default([]),

  /**
   * 6. **priority** — stacking + conflict tiebreaker. Range 1-100. Higher number = higher
   * priority (= wins conflicts). Default 50.
   * @example crisis=100, vent_support=80, motivation_nudge=60, headhunter=40
   */
  priority: z.number().int().min(1).max(100).default(50),

  /**
   * 7. **allowedTools** — tool names this skill may invoke when active. WS6 OutputGuardrail
   * enforces: any tool call NOT in the union of all active skills' allowedTools[] trips the
   * guardrail. Default empty = no tools (which is correct for iter30: tools wired in WS6).
   * Wire-in interface: see §7.
   * @example ["job_search", "resume_parse"]
   */
  allowedTools: z.array(z.string()).default([]),

  /**
   * 8. **llmInvokable** — if false, skill is regex-only (LLM intent classifier ignores it).
   * Default true. Maps to Claude Code `disable-model-invocation: true` (inverted polarity
   * for default-true). Used to keep `crisis_safety` (a regex-floor-only skill) out of the
   * classifier's choice set even if its intentDescription is set.
   */
  llmInvokable: z.boolean().default(true),

  // ============ DEFERRED to iter31 (schema-only, unwired) ============

  /**
   * paths[] — Claude Code `paths` field analog (context gates: e.g. "channel:imessage",
   * "user.profile.resumeAccepted"). **DEFERRED to iter31** per PLAN.md L198. Ships as
   * Zod-validated empty array; stacker IGNORES this field for iter30. Engineers MUST NOT
   * add gating logic on paths in this WS.
   */
  paths: z.array(z.string()).default([]),
}).refine(
  (s) => s.priority >= 1 && s.priority <= 100,
  { message: "priority must be 1..100" }
)

export type SkillV2 = z.infer<typeof SkillSchemaV2>

/** Forward-compat: callers can use `Skill` interchangeably with `SkillV2`. */
export type Skill = SkillV2

/** Type-alias for V1 reads — points at the same Zod schema; new fields default-fill. */
export const PlaybookSchema = SkillSchemaV2
export type Playbook = SkillV2
```

### 2.1 Backward-compat fromSnap (V1 doc → V2 type)

```typescript
export function fromSnap(id: string, raw: Record<string, unknown>): SkillV2 {
  // V1 docs lack the 8 new fields — Zod defaults handle them.
  // Defensive read: arrays of strings/literal-union may be undefined or
  // contain nulls; we coerce to safe values (drop nulls/non-strings).
  const safe = {
    playbookKey: (raw.playbookKey as string) ?? id,
    name: (raw.name as string) ?? id,
    description: (raw.description as string) ?? "",
    regexTriggers: Array.isArray(raw.regexTriggers)
      ? (raw.regexTriggers as unknown[]).filter((s): s is string => typeof s === "string")
      : [],
    addendum: (raw.addendum as string) ?? "",
    enabled: raw.enabled === undefined ? true : Boolean(raw.enabled),
    routingHint: (raw.routingHint === "no_chain" || raw.routingHint === "role_chain") ? raw.routingHint : null,
    version: typeof raw.version === "number" ? raw.version : 0,
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : null,
    updatedBy: (raw.updatedBy as string) ?? "",
    reason: (raw.reason as string) ?? "",

    // V2 fields — defaults if absent
    intentDescription: (raw.intentDescription as string) ?? "",
    provides: Array.isArray(raw.provides) ? (raw.provides as unknown[]).filter((s): s is string => typeof s === "string") : [],
    requires: Array.isArray(raw.requires) ? (raw.requires as unknown[]).filter((s): s is string => typeof s === "string") : [],
    composableWith: Array.isArray(raw.composableWith) ? (raw.composableWith as unknown[]).filter((s): s is SkillKey => SKILL_KEYS.includes(s as SkillKey)) : [],
    conflictsWith: Array.isArray(raw.conflictsWith) ? (raw.conflictsWith as unknown[]).filter((s): s is SkillKey => SKILL_KEYS.includes(s as SkillKey)) : [],
    priority: typeof raw.priority === "number" && raw.priority >= 1 && raw.priority <= 100 ? raw.priority : 50,
    allowedTools: Array.isArray(raw.allowedTools) ? (raw.allowedTools as unknown[]).filter((s): s is string => typeof s === "string") : [],
    llmInvokable: raw.llmInvokable === undefined ? true : Boolean(raw.llmInvokable),
    paths: Array.isArray(raw.paths) ? (raw.paths as unknown[]).filter((s): s is string => typeof s === "string") : [],
  }
  return SkillSchemaV2.parse(safe)
}
```

**Backward-compat invariant** (test gate T2): every existing V1 Firestore doc (the 6 in production) parses cleanly through `fromSnap()` with no field validation errors. Defaults populate the 8 new fields. Existing readers (e.g. `playbook-cache.ts`) continue working because the V2 type is a superset.

---

## 3. SkillStacker logic (composability + conflictsWith + ctx-gating)

**File**: `packages/pa-orchestrator/src/skill-stacker.ts` (NEW, ~300 lines impl)

### 3.1 Pseudocode (≤80 lines)

```typescript
// SkillStacker.stack(matched, ctx) → StackedResult
//
// Inputs:
//   matched: SkillV2[]  — candidates from regex floor + LLM intent merge
//   ctx:     ClaireContext  — WS3 turn context, used for `requires[]` predicates
//
// Outputs:
//   StackedResult { activeSkills: SkillV2[], addendum: string, allowedTools: string[],
//                   prunedReasons: PruneRecord[] }

function stack(matched: SkillV2[], ctx: ClaireContext): StackedResult {
  const active: SkillV2[] = []
  const pruned: PruneRecord[] = []

  // STEP 1 — ctx-gating: drop skills whose requires[] are unsatisfied.
  // Predicates: "ctx.userProfile.resumeAccepted" → ctx.userProfile.resumeAccepted === true
  //             "stance:companion" → some active skill provides "stance:companion"
  //             "ctx.activeSkills:headhunter" → "headhunter" already in active set
  for (const sk of matched) {
    const unmet = sk.requires.filter((req) => !satisfies(req, ctx, active))
    if (unmet.length > 0) {
      pruned.push({ key: sk.playbookKey, reason: `requires-unmet:${unmet.join(",")}` })
      continue
    }
    active.push(sk)
  }

  // STEP 2 — composability check: if skill A has composableWith=[...] non-empty AND
  // skill B is in active but B.playbookKey not in A.composableWith → conflict.
  // Skill with empty composableWith stacks with all (V1 default).
  for (const a of [...active]) {
    for (const b of active) {
      if (a.playbookKey === b.playbookKey) continue
      const aRestricts = a.composableWith.length > 0
      const bAllowed = a.composableWith.includes(b.playbookKey as SkillKey)
      if (aRestricts && !bAllowed) {
        // Conflict — resolve by priority (higher wins; tiebreak by lex)
        const loser = a.priority < b.priority || (a.priority === b.priority && a.playbookKey > b.playbookKey) ? a : b
        const idx = active.indexOf(loser)
        if (idx >= 0) {
          active.splice(idx, 1)
          pruned.push({ key: loser.playbookKey, reason: `composability-conflict:${a.playbookKey}<>${b.playbookKey}` })
        }
      }
    }
  }

  // STEP 3 — explicit conflictsWith resolution: bidirectional, highest priority wins.
  for (const a of [...active]) {
    for (const b of [...active]) {
      if (a.playbookKey === b.playbookKey) continue
      const conflicts = a.conflictsWith.includes(b.playbookKey as SkillKey)
                     || b.conflictsWith.includes(a.playbookKey as SkillKey)
      if (conflicts) {
        const loser = a.priority < b.priority || (a.priority === b.priority && a.playbookKey > b.playbookKey) ? a : b
        const idx = active.indexOf(loser)
        if (idx >= 0) {
          active.splice(idx, 1)
          pruned.push({ key: loser.playbookKey, reason: `conflictsWith:${a.playbookKey}<>${b.playbookKey}` })
        }
      }
    }
  }

  // STEP 4 — sort by priority desc (highest priority addendum first → strongest directive top-of-prompt).
  active.sort((x, y) => y.priority - x.priority || x.playbookKey.localeCompare(y.playbookKey))

  // STEP 5 — concat addenda + union allowedTools.
  const addendum = active.map((s) => s.addendum).filter((x) => x?.trim()).join("\n\n")
  const allowedTools = Array.from(new Set(active.flatMap((s) => s.allowedTools)))

  return { activeSkills: active, addendum, allowedTools, prunedReasons: pruned }
}
```

### 3.2 ctx-aware activation (`requires[]` predicates)

`satisfies(predicate, ctx, active)` resolves three predicate forms:

| Predicate form | Example | Resolution |
|---|---|---|
| `ctx.<dot.path>` | `ctx.userProfile.resumeAccepted` | dot-walk ctx, `Boolean(value)` |
| `ctx.activeSkills:<key>` | `ctx.activeSkills:headhunter` | check `ctx.activeSkills` array |
| `<tag>` (capability tag) | `stance:companion` | check `active` set's `provides[]` flat-union |

**Audit**: every prune appends to `ctx.guardrailHits[]` with `{ name: "skill-stacker", type: "input", tripped: false, metadata: prunedReasons }` so post-turn audit drawer surfaces "skill X dropped because Y".

### 3.3 Tool-allow union (closes loop with WS6)

`StackedResult.allowedTools` is the **union** of all `active` skills' `allowedTools[]`. WS6 OutputGuardrail (`tool-call-gate.ts`, see §7) reads this union from `ctx.activeSkillsAllowedTools` (mutator-set by stacker) and trips on any tool invocation outside the union.

For iter30 the existing 6 skills all set `allowedTools: []` (no tool calls today) so the gate is enforced as "Claire makes zero tool calls when these 6 skills active" — which is the current production state. Adding tool-bearing skills (post-iter30) requires the skill author to enumerate `allowedTools[]` explicitly. **No silent escalation.**

---

## 4. Migration of existing 6 skills (V1 → V2 metadata)

**Output**: `packages/agent-registry/src/skill-defaults.ts` (NEW) — the 6 metadata blocks below get merged into the existing Firestore docs via the migration script (T4). Addenda + regexTriggers are **UNCHANGED**.

### 4.1 Per-skill metadata table

| Field | `headhunter` | `vent_support` | `motivation_nudge` | `jd_roast` | `interview_prep` | `negotiation` |
|---|---|---|---|---|---|---|
| **intentDescription** | "Activate when user signals job search / role change / 在看工作 / on the market. NOT for emotional distress; route vent_support if signs of burnout." | "Activate when user expresses emotional distress, burnout, breakdown, exhaustion, hopelessness, anxiety (zh+en). Do NOT activate when user is asking a factual question or in upbeat mood." | "Activate when user signals procrastination, can't start, stuck, no motivation. Distinguish from vent: this is about action-paralysis, not emotional overload." | "Activate when user shares a job description / asks for thoughts on a role / 帮我看 this JD / should I apply. Do NOT activate for general career chat." | "Activate when user mentions an upcoming interview, prep, nervousness about a specific round (system design / coding / behavioral)." | "Activate when user is comparing offers, asking how much to ask, counter-offer, 谈薪. Do NOT activate for early-stage role consideration." |
| **provides[]** | `["stance:advisor","tone:friend-roommate","intent:job_search"]` | `["stance:companion","tone:vent","mode:no_advice"]` | `["stance:companion","tone:nudge","mode:smallest_action"]` | `["stance:advisor","tone:friend-roommate","mode:jd_review"]` | `["stance:companion","tone:friend-roommate","mode:interview_prep"]` | `["stance:advisor","tone:friend-roommate","mode:negotiation"]` |
| **requires[]** | `[]` (no prereq for iter30; cv-followup gating is post-iter30) | `[]` | `[]` | `[]` | `[]` | `[]` |
| **composableWith[]** | `["jd_roast","interview_prep","negotiation","cv_followup","referral_request"]` | `["motivation_nudge","silence_anchor","interview_prep"]` | `["vent_support","interview_prep"]` | `["headhunter","negotiation","company_research"]` | `["headhunter","vent_support","motivation_nudge"]` | `["headhunter","jd_roast","post_offer_decision"]` |
| **conflictsWith[]** | `["vent_support"]` (don't push job-search probes when user is venting) | `["headhunter","jd_roast"]` (don't ask role-probes during emotional distress) | `[]` | `["vent_support"]` (don't review JDs when user is breaking down) | `[]` | `["vent_support"]` |
| **priority** (1-100) | 40 | 80 | 60 | 45 | 55 | 50 |
| **allowedTools[]** | `[]` (iter30: tool gating wired in WS6, default empty) | `[]` | `[]` | `[]` | `[]` | `[]` |
| **llmInvokable** | true | true | true | true | true | true |

Priority rationale (brief): vent_support 80 wins all conflicts because emotional distress is a hard veto on advisor stances. headhunter 40 is the lowest of the 6 because it's the most "ambient" mode and yields to anything more specific. motivation_nudge 60 sits between vent (80) and headhunter (40) — it's specific but not crisis. jd_roast / interview_prep / negotiation are stance-aligned with headhunter and stack cleanly when triggered together (composable union). Priorities are *intentionally* sparse in the 1-100 range so WS4-B's 13 new skills can interpolate (e.g. crisis-class new skills slot at 90+, ambient at 30-).

### 4.2 Concrete metadata blocks (TypeScript exports for T3)

```typescript
// packages/agent-registry/src/skill-defaults.ts
import type { SkillKey } from "./skill-schema"

export type SkillMetadataV2 = {
  intentDescription: string
  provides: string[]
  requires: string[]
  composableWith: SkillKey[]
  conflictsWith: SkillKey[]
  priority: number
  allowedTools: string[]
  llmInvokable: boolean
}

export const EXISTING_6_METADATA: Record<SkillKey, SkillMetadataV2 | null> = {
  headhunter: {
    intentDescription: "Activate when user signals job search / role change / 在看工作 / on the market. NOT for emotional distress; route vent_support if signs of burnout.",
    provides: ["stance:advisor", "tone:friend-roommate", "intent:job_search"],
    requires: [],
    composableWith: ["jd_roast", "interview_prep", "negotiation", "cv_followup", "referral_request"],
    conflictsWith: ["vent_support"],
    priority: 40,
    allowedTools: [],
    llmInvokable: true,
  },
  vent_support: {
    intentDescription: "Activate when user expresses emotional distress, burnout, breakdown, exhaustion, hopelessness, anxiety (zh+en). Do NOT activate when user is asking a factual question or in upbeat mood.",
    provides: ["stance:companion", "tone:vent", "mode:no_advice"],
    requires: [],
    composableWith: ["motivation_nudge", "silence_anchor", "interview_prep"],
    conflictsWith: ["headhunter", "jd_roast"],
    priority: 80,
    allowedTools: [],
    llmInvokable: true,
  },
  motivation_nudge: {
    intentDescription: "Activate when user signals procrastination, can't start, stuck, no motivation. Distinguish from vent: this is about action-paralysis, not emotional overload.",
    provides: ["stance:companion", "tone:nudge", "mode:smallest_action"],
    requires: [],
    composableWith: ["vent_support", "interview_prep"],
    conflictsWith: [],
    priority: 60,
    allowedTools: [],
    llmInvokable: true,
  },
  jd_roast: {
    intentDescription: "Activate when user shares a job description / asks for thoughts on a role / 帮我看 this JD / should I apply. Do NOT activate for general career chat.",
    provides: ["stance:advisor", "tone:friend-roommate", "mode:jd_review"],
    requires: [],
    composableWith: ["headhunter", "negotiation", "company_research"],
    conflictsWith: ["vent_support"],
    priority: 45,
    allowedTools: [],
    llmInvokable: true,
  },
  interview_prep: {
    intentDescription: "Activate when user mentions an upcoming interview, prep, nervousness about a specific round (system design / coding / behavioral).",
    provides: ["stance:companion", "tone:friend-roommate", "mode:interview_prep"],
    requires: [],
    composableWith: ["headhunter", "vent_support", "motivation_nudge"],
    conflictsWith: [],
    priority: 55,
    allowedTools: [],
    llmInvokable: true,
  },
  negotiation: {
    intentDescription: "Activate when user is comparing offers, asking how much to ask, counter-offer, 谈薪. Do NOT activate for early-stage role consideration.",
    provides: ["stance:advisor", "tone:friend-roommate", "mode:negotiation"],
    requires: [],
    composableWith: ["headhunter", "jd_roast", "post_offer_decision"],
    conflictsWith: ["vent_support"],
    priority: 50,
    allowedTools: [],
    llmInvokable: true,
  },
  // 13 new skills — null = WS4-B authors metadata + body
  rejection_processing: null, post_offer_decision: null, referral_request: null,
  silence_anchor: null, cv_followup: null, layoff_processing: null,
  company_research: null, career_pivot: null, return_to_work: null,
  daily_batch_reply: null, am_i_ai_check: null, boundary_test: null, mom_test: null,
}
```

### 4.3 Firestore migration script (T4)

**File**: `apps/functions/scripts/migrate-skills-v2.mjs` — idempotent, audit-rowed, dry-run-default.

```javascript
// Usage:
//   node apps/functions/scripts/migrate-skills-v2.mjs --dry-run   # default
//   node apps/functions/scripts/migrate-skills-v2.mjs --apply
//
// Reads each of the 6 existing pa-playbooks docs, merges metadata via upsertPlaybook
// (which writes the audit row in the same batch). Reason field: "iter30 V2 metadata".
//
// Idempotency: re-running with --apply re-writes the same metadata + bumps version.
// To revert: run revertPlaybook(db, key) — existing audit walker handles it.
//
// Dry-run prints diffs to stdout. Apply requires --apply flag explicit.

import { getFirestore } from "firebase-admin/firestore"
import { upsertPlaybook, getPlaybook } from "../../../packages/agent-registry/src/playbooks.js"
import { EXISTING_6_METADATA } from "../../../packages/agent-registry/src/skill-defaults.js"

const APPLY = process.argv.includes("--apply")
const ACTOR = "iter30-skills-v2-migrate@wekruit.com"
const REASON = "iter30 — V2 schema metadata seed (intentDescription, composability, priority, allowedTools, llmInvokable)"

// ... (initFirestore + iterate 6 keys, fetch existing, merge metadata, upsert with reason)
```

**Acceptance**: dry-run prints 6 diffs, each adding 7+1 fields. Apply produces 6 audit rows in `pa-audit-events` with `action: "playbook.update"` + `reason: "iter30 — V2 schema metadata seed ..."`. Revert path uses existing `revertPlaybook` walker.

---

## 5. SkillIntentClassifier (WS5)

**File**: `packages/pa-orchestrator/src/skill-intent-classifier.ts` (NEW)

### 5.1 Production system prompt (≤500 tokens)

```
You are a skill-intent classifier for Claire, a bilingual zh+en companion agent.
Given a user message, return a JSON object listing the top-K=3 skills (by relevance)
the message should activate, with confidence 0.0-1.0 each.

Skills available (19 total):

[EXISTING 6 — populated by intentDescription field]
1. headhunter — Activate when user signals job search / role change / 在看工作 / on the market. NOT for emotional distress; route vent_support if signs of burnout.
2. vent_support — Activate when user expresses emotional distress, burnout, breakdown, exhaustion, hopelessness, anxiety (zh+en). Do NOT activate when user is asking a factual question or in upbeat mood.
3. motivation_nudge — Activate when user signals procrastination, can't start, stuck, no motivation. Distinguish from vent: action-paralysis, not emotional overload.
4. jd_roast — Activate when user shares a job description / asks for thoughts on a role / 帮我看 this JD / should I apply. Do NOT activate for general career chat.
5. interview_prep — Activate when user mentions an upcoming interview, prep, nervousness about a specific round (system design / coding / behavioral).
6. negotiation — Activate when user is comparing offers, asking how much to ask, counter-offer, 谈薪. Do NOT activate for early-stage role consideration.

[NEW 13 — placeholders, WS4-B fills with their authored intentDescription strings]
7-19. <SKILL_KEY> — <intentDescription>  (auto-injected from Firestore at boot)

Rules:
- Return EXACTLY this JSON shape: {"skills":[{"key":"<skillKey>","confidence":0.0-1.0}, ...], "reason":"<≤30 words>"}
- Max 3 skills. Confidence below 0.6 → exclude.
- If message is ambiguous / casual / out-of-scope → return {"skills":[],"reason":"ambiguous"}.
- NEVER invent skill keys. Use only the 19 listed above.
- Bilingual zh+en — respect both. User message language is auto-detected upstream.
- Crisis signals (suicide / self-harm) → DO NOT route here; regex floor handles those upstream.
```

**Token budget**: 19 skills × ~30 tokens each = 570 tokens of skill descriptions + ~120 token rules + user message. Total prompt ≈ 700 tokens. Output ≤ 100 tokens. **Within Qwen-7B 32k context budget by 30×.**

### 5.2 Latency + caching contract

| Aspect | Value | Notes |
|---|---|---|
| Latency budget | ≤500ms p99 | Single Qwen-7B call on SiliconFlow free tier |
| Timeout | 800ms hard | After timeout → fail-open (empty array → regex floor only) |
| Cache | msg-hash → result | sha256 of normalized lower-cased message |
| Cache TTL | 5 min | Trades freshness for ~30% rapid-resend dedupe |
| Fail-open path | empty array | Router falls back to regex-floor matches only |
| Top-K | 3 | Stacker further prunes via composability/conflict |
| Confidence threshold | 0.6 | Below this → skill discarded |
| Cost | ~$0/turn | Free tier; if rate-limited → degrade (see §5.3) |

### 5.3 Free-tier rate-limit handling (Q2 not yet answered — proposed fallback)

**Adam Q2** (PLAN-AUDIT.md §I.2): SiliconFlow free-tier RPM cap is unverified. Proposed degraded-mode path:

```
Order of preference:
  1. Free tier (Qwen2.5-7B-Instruct on SiliconFlow) — primary
  2. On 429/quota-exceeded: emit metric `pa.skill.classifier.rate_limited` + degrade
  3. Degraded mode: return empty array → router falls back to regex floor only.
     Skills still match via regex; classifier becomes no-op until cache TTL elapses.
  4. NEVER auto-failover to paid tier — Adam-locked "free Qwen-7B".
     Paid-tier fallback requires explicit Adam approval + a feature flag flip.
```

**Observability**: classifier emits per-call metric `{ ok, latencyMs, rateLimited, cacheHit, skillsReturned }` to `pa-cost-ledger/skills-classifier/{date}`. Dashboard surfaces a daily 429-rate widget; if 429-rate >5% sustained for 24h, page on-call with "switch to paid tier OR degrade gracefully" runbook.

### 5.4 Module surface (stub-impl in iter30, behind flag)

```typescript
export interface ClassifyInput {
  messageBody: string
  ctx: ClaireContext   // for locale + recentTurns logging only; classifier itself is stateless
}

export interface ClassifyResult {
  skills: { key: SkillKey; confidence: number }[]
  rateLimited: boolean
  cacheHit: boolean
  latencyMs: number
}

export async function classifySkills(input: ClassifyInput, deps?: ClassifyDeps): Promise<ClassifyResult>

// deps default:
//   - llmCall: callQwenSiliconFlow (reuses existing voice/llm-rewriter.ts client config)
//   - cache: in-memory LRU(2000 keys, 5min TTL)
//   - now: Date.now
```

**Flag-gating**: behind `paSkillsLlmFallbackEnabled` (per `ws-3-6-detail.md` L166 — already declared in ClaireContext). Default OFF for iter30 ramp; flip to 1% per Adam directive iter23 (CLAUDE.md L67-69).

---

## 6. SkillRouter logic (regex floor + LLM intent merge)

**File**: `packages/pa-orchestrator/src/skill-router.ts` (NEW)

### 6.1 Pseudocode (≤80 lines)

```typescript
// SkillRouter.route(messageBody, ctx) → RouteResult
//
// Per discussion.md L37-39 (Adam lock):
//   - LLM holistic intent leads
//   - Regex stays as basic floor for crisis + AB-NEVER + obvious patterns
//   - Floor patterns ALWAYS active; LLM intent skills above 0.6 confidence stack
//
// Inputs:
//   messageBody: string  — raw inbound user msg
//   ctx:         ClaireContext  — passed through for stacker
//
// Outputs:
//   RouteResult {
//     activeSkills: SkillV2[],
//     addendum: string,
//     allowedTools: string[],
//     source: { regex: SkillKey[], llm: SkillKey[] },
//     classifierLatencyMs: number,
//     classifierRateLimited: boolean,
//   }

async function route(messageBody: string, ctx: ClaireContext): Promise<RouteResult> {
  const skills = await getCachedSkills(ctx.db)   // 30s cache (existing playbook-cache)

  // STEP 1 — regex floor in parallel with LLM intent. Floor is ALWAYS computed (sub-ms).
  const regexMatched = matchSkillsByRegex(messageBody, skills)   // existing matchPlaybooks

  // STEP 2 — LLM intent (parallel). Flag-gated; fail-open empty array if disabled/rate-limited.
  const llmFlag = ctx.featureFlags.paSkillsLlmFallbackEnabled
  const classifyP = llmFlag
    ? classifySkills({ messageBody, ctx }).catch((e) => ({ skills: [], rateLimited: false, cacheHit: false, latencyMs: 0 }))
    : Promise.resolve({ skills: [], rateLimited: false, cacheHit: false, latencyMs: 0 })

  const llmResult = await classifyP
  const llmMatched = llmResult.skills
    .filter((s) => s.confidence >= 0.6)
    .map((s) => skills.find((sk) => sk.playbookKey === s.key))
    .filter((sk): sk is SkillV2 => !!sk && sk.llmInvokable)   // honor llmInvokable=false

  // STEP 3 — merge: union (regex ALWAYS wins for safety patterns; LLM stacks on top).
  // Crisis-floor patterns are regex-only (their skill metadata can set llmInvokable=false).
  const merged = mergeSkillSets(regexMatched, llmMatched)   // dedupe by playbookKey

  // STEP 4 — hand to stacker for composability + conflictsWith + ctx-gating + priority sort.
  const stacked = SkillStacker.stack(merged, ctx)

  // STEP 5 — record audit + return.
  ctx.guardrailHits.push({
    name: "skill-router",
    type: "input",
    tripped: false,
    metadata: {
      regex: regexMatched.map((s) => s.playbookKey),
      llm: llmMatched.map((s) => s.playbookKey),
      pruned: stacked.prunedReasons,
      classifierLatencyMs: llmResult.latencyMs,
      rateLimited: llmResult.rateLimited,
    },
    latencyMs: llmResult.latencyMs,
  })

  return {
    activeSkills: stacked.activeSkills,
    addendum: stacked.addendum,
    allowedTools: stacked.allowedTools,
    source: { regex: regexMatched.map((s) => s.playbookKey), llm: llmMatched.map((s) => s.playbookKey) },
    classifierLatencyMs: llmResult.latencyMs,
    classifierRateLimited: llmResult.rateLimited,
  }
}
```

### 6.2 Regex-floor scope (Adam-lock: NOT primary routing)

The 6 existing skills' `regexTriggers[]` arrays carry hand-curated bilingual patterns (50+ for `vent_support` alone, see `playbooks.ts:405-461`). For iter30:
- **Keep all existing regex** — they're the safety floor.
- **Crisis triggers** (the only "regex-MUST-fire" patterns) live in the `paCrisisHotlineInjectionEnabled` guardrail (WS6), not in skill regex. Skills with `llmInvokable: false` (none today, but reserved for `crisis_safety` post-iter30) are regex-only.
- **AB-NEVER blocks** are already in WS6 OutputGuardrail (`stripABProbeFromTail`); not skill-regex business.

### 6.3 Cutover with existing playbook-cache.ts

`playbook-cache.ts:60-76` (`matchCachedPlaybooks`) is CURRENT production behavior = regex-only. SkillRouter REPLACES this call site at the orchestrator entry; old function stays exported (deprecated) for any test harness still calling it directly. Cutover diff in `packages/pa-orchestrator/src/index.ts` (estimate ~10 lines):

```typescript
// before:
const { matched, addendum } = await matchCachedPlaybooks(db, body)
// after:
const route = await SkillRouter.route(body, ctx)
const { activeSkills, addendum, allowedTools } = route
ctx.activeSkills = activeSkills.map((s) => s.playbookKey)
ctx.skillAddendum = addendum
ctx.activeSkillsAllowedTools = allowedTools   // NEW field on ClaireContext for §7 tool-gate
```

---

## 7. Tool gating wire to WS6

**File**: `packages/pa-orchestrator/src/skill-tool-gate.ts` (NEW, ~60 lines, contract-only stub for iter30)

### 7.1 Contract

```typescript
/**
 * SkillToolGate — interface contract for WS6 OutputGuardrail enforcement.
 *
 * iter30 deliverable (this WS): export the contract + a no-op default impl.
 *   The 6 existing skills all set allowedTools=[], so the gate is trivially satisfied.
 *   Concrete enforcement wired in WS6 OutputGuardrail; this WS supplies the data.
 *
 * Read-side: WS6 OutputGuardrail reads ctx.activeSkillsAllowedTools (populated by
 *   SkillRouter at turn entry).
 * Write-side: this module exposes ctx mutator + audit helper.
 */

export interface SkillToolGateInput {
  toolName: string                         // proposed tool call
  ctx: ClaireContext
}

export interface SkillToolGateResult {
  allowed: boolean
  reason: string                           // "skill-stack-allows" | "no-active-skill-allows" | "no-skill-allow-for:<tool>"
  activeSkills: SkillKey[]
  allowedToolsUnion: string[]
}

export function checkToolAgainstSkills(input: SkillToolGateInput): SkillToolGateResult {
  const { toolName, ctx } = input
  const union = ctx.activeSkillsAllowedTools ?? []
  const active = (ctx.activeSkills ?? []) as SkillKey[]

  if (active.length === 0) {
    // No skill active = use base agent's tool list (existing behavior).
    return { allowed: true, reason: "no-active-skill", activeSkills: [], allowedToolsUnion: [] }
  }
  if (union.length === 0) {
    // Active skill(s) but none declares tools → all tool calls disallowed (Adam: "no silent escalation").
    return { allowed: false, reason: "no-skill-allow-for:" + toolName, activeSkills: active, allowedToolsUnion: union }
  }
  return {
    allowed: union.includes(toolName),
    reason: union.includes(toolName) ? "skill-stack-allows" : "no-skill-allow-for:" + toolName,
    activeSkills: active,
    allowedToolsUnion: union,
  }
}
```

### 7.2 WS6 wire-in interface

WS6 `OutputGuardrail` (per `ws-3-6-detail.md` §6) calls `checkToolAgainstSkills` BEFORE the SDK's tool-execution loop. Trip:
```
if (!result.allowed) {
  // GuardrailTripwireTriggered with metadata = { toolName, reason, activeSkills, allowedToolsUnion }
}
```

For iter30 the 6 existing skills' `allowedTools=[]` means: **no tool calls allowed when any of the 6 is active**. This is consistent with current production behavior (Claire makes zero tool calls today). Post-iter30 skills that need tools (e.g. `cv_followup` calling resume parser) declare them explicitly in `allowedTools`. WS6 enforces; this WS supplies the data.

### 7.3 ctx field addition

`ClaireContext` (WS3) needs ONE new field added (coordinated with WS3 owner):
```typescript
activeSkillsAllowedTools: z.array(z.string()).default([])
```
WS3 detail-plan currently has `activeSkills` + `skillStackOrder` + `skillAddendum` (`ws-3-6-detail.md` L142-145). This adds the union. Mutation is fire-and-forget by SkillRouter at turn-entry; readonly thereafter.

---

## 8. SDK handoff workaround (`run.d.ts:211`)

**SDK gotcha**: `run.d.ts:211` reads "*Note that only the first agent's input guardrails are run.*" That means if WS4 introduces sub-agent handoffs (Claire hands off to a sub-agent for a specific skill), the sub-agent's input guardrails (crisis detector, PII scanner) **do not re-run**. A crisis input on a sub-agent turn would slip past the safety net.

### 8.1 Does iter30 need handoffs? **No.**

The 19-skill design is **prompt-stacking**, not sub-agent handoffs. SkillStacker concatenates `addendum` strings into the SINGLE Claire agent's system prompt. There is ONE agent, ONE Runner.run call, ONE input-guardrail pass — perfectly compatible with SDK's "first agent only" caveat.

This decision is consistent with:
- skills-vs-playbook-research.md §4.2 (hybrid Zod approach uses addendum concat, not sub-agents)
- ws-3-6-detail.md §6 (guardrails wired on `claireAgent`, single agent definition)
- PLAN.md L211 ("Implement composability stacking (multiple skills concat addendum by priority)") — addendum, not handoff.

### 8.2 If a future iter introduces handoffs (post-iter30)

Document this constraint in `skill-stacker.ts` header + add a runtime assertion test (T11):

```typescript
// skill-stacker.test.ts
test("iter30 invariant: no sub-agent handoff in skill activation", () => {
  // Claire agent definition has handoffs=[] OR every handoff target re-runs IG manually.
  const claireAgent = buildClaireAgent({ /* ... */ })
  assert.deepEqual(claireAgent.handoffs ?? [], [],
    "iter30 forbids sub-agent handoffs. If you add one, also add input-guardrail re-entry per ws-3-6-detail.md R-5.")
})
```

**Future migration path** (if a post-iter30 skill genuinely needs a sub-agent — e.g. `cv_followup` running in a forked context to call the resume parser):
1. Manual IG re-run: wrap the handoff target's first turn in a custom guardrail-rerun closure.
2. OR — preferred — keep the architecture flat. Sub-agent calls become tool calls (`agent-as-tool` pattern, see skills-vs-playbook-research.md §1.C L146-147). Tool calls go through WS6 OutputGuardrail (§7) which IS rewired per turn.

### 8.3 Lint guard (T11)

ESLint custom rule (or grep gate in CI):
```
GREP: "handoffs:\s*\[" in packages/pa-orchestrator/src/index.ts
PASS if the line is empty array OR commented out.
FAIL if non-empty handoffs declared.
```

This lives in the CI pipeline alongside the existing predeploy smoke (`firebase.json:predeploy`) — if someone adds a handoff post-iter30 without addressing IG re-entry, deploy aborts.

---

## 9. Eval baseline preservation

iter28-29 LLM-judge wins are pre-iter30 reference; the V2 schema migration must not regress them. Per PLAN.md L227-231:

| Baseline file | Target | Re-baseline date |
|---|---|---|
| `tests/scenarios/playbooks-iter20/iter28-judge-vent-realistic.yaml` | ≥0.93 | T12 (day 10) |
| `tests/scenarios/playbooks-iter20/iter28-judge-headhunter.yaml` | ≥0.86 | T12 |
| `tests/scenarios/playbooks-iter20/iter28-judge-negotiation.yaml` | ≥0.86 | T12 |
| 30-turn AB-framework drift (locate via `grep "30.turn" tests/`) | 0/30 hits maintained | T12 |

### 9.1 Re-baseline procedure

1. Pre-migration snapshot: run all 4 above against current production state (V1 skills) — record numeric scores in `tests/scenarios/playbooks-iter30/baseline-pre-iter30.json`.
2. After T1-T9 land in dev branch + the migration script applied to a Firestore staging project, re-run the same 4 baselines.
3. Compare: each scenario's score MUST be `≥ pre_iter30_score - 0.02` (allow 2-point variance for LLM-judge stochasticity, but no broad regression).
4. AB-framework drift: 0/30 maintained — any hit fails the gate hard.
5. Output: `tests/scenarios/playbooks-iter30/iter30-rebaseline-report.md` — green/red per scenario + diff explanation if any score moved.

### 9.2 Why this matters

iter28-29 was the first time PA hit ≥0.93 on vent-realistic and 0/30 on AB drift. That came from prompt structure + few-shot tuning + the existing 6 playbooks' addenda. The V2 schema migration is **metadata-only** for the 6 (addenda + regex unchanged), so a regression here would mean the new stacker logic is dropping addenda or reordering them in a way that confuses the model. **Hard gate** — block T12 if any score regresses.

---

## 10. Test plan

### 10.1 Unit tests (T2, T6, T8)

| Test file | Coverage |
|---|---|
| `skill-schema.test.ts` | (a) V1 doc → V2 type via fromSnap (each of 6 existing); (b) all V2 fields default-fill correctly; (c) validation: priority out-of-range rejected; (d) validation: bad SkillKey in composableWith rejected. |
| `skill-stacker.test.ts` | (a) composability: vent + motivation_nudge → both stack (composableWith allows); (b) conflictsWith: vent + headhunter → vent wins (priority 80 > 40); (c) tiebreaker: equal priority → lex sort; (d) ctx-gate: skill with `requires:["ctx.userProfile.resumeAccepted"]` drops when ctx flag false; (e) addendum order: priority desc; (f) allowedTools union deduplicates; (g) audit prune reasons populated. |
| `skill-intent-classifier.test.ts` | (a) cache hit on same-msg-hash; (b) cache miss → llmCall invoked; (c) timeout 800ms → empty array (fail-open); (d) 429 from llmCall → empty + rateLimited=true metric; (e) confidence <0.6 filtered out; (f) result respects llmInvokable=false (excluded from candidates). |

### 10.2 Integration tests

- `skill-router.test.ts` — regex+LLM merge: simulate vent_support regex hit + llm returning headhunter (conflict). Assert: vent wins, headhunter pruned, audit reason populated.
- `skill-router.test.ts` — flag OFF: classifier never called, regex-only behavior matches `matchCachedPlaybooks` exactly (existing playbook-cache tests pass unchanged).
- `migrate-skills-v2.mjs` dry-run + apply + revert round-trip on Firestore emulator.

### 10.3 Eval baseline preservation (§9)

T12 — 4 LLM-judge re-baselines + AB-drift gate.

### 10.4 Live scenario verify (CLAUDE.md mandate)

After deploy:
- 1 zh + 1 en realistic message per existing 6 skills via `node tests/scenarios/runner.mjs <yaml>` — 12 runs.
- Paste reply text in WS4-A close-out report (per CLAUDE.md "verify by doing").
- Long-context check: ≥10-turn scenario invoking ≥2 skills (vent → motivation transition); inspect mirror-score / repeat-advice / length compliance.

**Total test pass criteria for WS4-A**: all unit + integration + 12 live + 4 baselines + 30-turn drift = **0 fail tolerance**. Any fail blocks T12 → blocks WS4-A close → blocks WS4-B integration.

---

## 11. Risks (8+)

### R1 — V1 → V2 dual-write window leaks stale reads
**Likelihood**: medium. **Impact**: high (broken activation for live users during ramp).
**Mitigation**: migration script runs in a single batch per skill (playbook doc + audit row atomic). Cache TTL is 30s, so worst-case stale-read window is ≤30s post-deploy. SkillRouter tolerates V1 docs (defaults populate); no breakage if cache returns mixed V1+V2 mid-migration. Feature-flag gate: `paSkillRouterV2Enabled` (NEW) defaults OFF for staff, flip 1→10→100% per CLAUDE.md L67.

### R2 — Qwen-7B free tier rate-limited at scale
**Likelihood**: HIGH (Adam Q2 unanswered). **Impact**: high — classifier becomes no-op, falls back to regex-only.
**Mitigation**: §5.3 fallback path (degraded mode = empty array → regex floor). Observability metric `pa.skill.classifier.rate_limited`. Page on-call when 24h-rolling 429-rate >5%. Do NOT auto-failover to paid tier (Adam-locked). Pre-deploy spike: **Day-0 verify Qwen-7B free-tier RPM cap by hammering with 100 RPS for 30s** (confirm sustainable rate); document in `.planning/iter30/qwen-rate-limit-test.md`.

### R3 — Composability conflict tiebreaker drops legitimate skill in production
**Likelihood**: medium. **Impact**: medium (user gets wrong stance — e.g. vent wins over interview_prep when user genuinely needs both).
**Mitigation**: priority table (§4.1) is explicit; vent_support 80 vs interview_prep 55 means vent wins on tie. **But** vent + interview_prep is in `composableWith` (both directions) → conflict NOT triggered, both stack. Verified by skill-stacker.test.ts §10.1(a). Long-context test (§10.4) catches edge cases. **Edge**: if WS4-B's 13 new skills introduce priority collisions, T6 unit test catches at land time.

### R4 — Classifier cache poisoning (msg-hash collision)
**Likelihood**: low. **Impact**: low (one user gets wrong skills for 5 min).
**Mitigation**: sha256(`<lower-cased msg>::<userId>`) — userId in hash key prevents cross-user collisions. TTL 5 min hard. Cache invalidate on Firestore skill update (post-deploy hot-swap on intentDescription change).

### R5 — SDK sub-agent handoff added post-iter30 without IG re-entry (§8.2)
**Likelihood**: medium (post-iter30). **Impact**: HIGH (crisis input bypass guardrail).
**Mitigation**: ESLint/grep guard (§8.3) in CI. Module header comment. Test T11 hard-asserts handoffs=[]. Documented in `skill-stacker.ts` header.

### R6 — Cutover diff in `packages/pa-orchestrator/src/index.ts` regresses orchestrator turn flow
**Likelihood**: medium. **Impact**: HIGH (entire claireAgent broken).
**Mitigation**: cutover is a 10-line diff (§6.3). Behind `paSkillRouterV2Enabled` flag; default OFF. Shadow-mode option: run SkillRouter alongside `matchCachedPlaybooks` for 1 week, log differences without applying — diff-zero = safe to flip. Same pattern as WS6 `paGuardrailsShadowMode` (PLAN.md L477).

### R7 — Re-baseline regression on iter28-29 LLM-judge scenarios
**Likelihood**: medium. **Impact**: HIGH (blocks iter30 close).
**Mitigation**: §9 hard gate. Pre + post snapshots; ≥0.93 / ≥0.86 / 0/30 maintained. If regress → bisect to find which commit moved the dial; revert if needed. **Do not relax the threshold to "make it green" — that's iter23 failure mode.**

### R8 — `intentDescription` slop drift on dashboard edits (Adam ops drift risk)
**Likelihood**: high (R4 of skills-vs-playbook-research.md). **Impact**: medium (classifier accuracy degrades).
**Mitigation**: dashboard validation: warn if `intentDescription` <20 words OR >200 words. Audit reason required (existing `upsertPlaybook` already enforces). **Future**: V3 add LLM-judge "is intentDescription canonical?" sanity check on edit (post-iter30).

### R9 — Adding `activeSkillsAllowedTools` to ClaireContext drifts WS3 contract
**Likelihood**: low. **Impact**: low (one new field, default `[]`).
**Mitigation**: coordinate field-add with WS3 owner before T5 (one-line PR to `run-context.ts`). Field is mutator-set, default empty, ignored by all V1 readers. Test mock helper `buildMockCtx` (per ws-3-6-detail.md L734) extends with the new field's default.

### R10 — Migration script applied to wrong Firestore project
**Likelihood**: low. **Impact**: HIGH (production audit trail polluted).
**Mitigation**: script defaults to `--dry-run`, requires explicit `--apply` flag. Reads `FIREBASE_PROJECT_ID` env, refuses to run unless it matches `wekruit-5f89b` OR `WEKRUIT_ALLOW_NON_PROD=1` set. Audit reason field is mandatory (existing `upsertPlaybook` enforces). Revert path via `revertPlaybook` walker.

---

## 12. Open questions

1. **A/B variants in iter30 or iter31?** — PLAN.md L375 mentions A/B variant in dashboard scope but WS4-A schema doesn't include an `arm` / `variant` field. **Recommendation**: defer A/B variant field to iter31; iter30 ships single canonical addendum per skill. Adam to confirm.

2. **LLM intent prompt: include ctx (recent turns, profile) or not?** — Current §5.1 prompt is stateless (just `messageBody`). Including last-3-turns + userProfile.role would improve disambiguation (e.g. user mid-vent followed by "but I should send my resume" — context resolves intent better than message alone). **Trade-off**: +200-500 prompt tokens per call, possibly +50ms latency. **Recommendation**: ship stateless in iter30; add ctx-aware A/B in iter31 once Qwen-7B free-tier baseline is verified. [PUA生效 🔥] Adam to weigh in: voice constraints memory note says context 一长就不够好 — supports stateless first.

3. **Conflict tiebreaker if priority equal?** — Current pseudocode breaks ties by lex order (`a.playbookKey > b.playbookKey ? loser : winner`). This is deterministic but arbitrary. Alternative: declare priority unique (Zod refine: no two skills share priority). **Recommendation**: keep lex tiebreak; document in stacker.ts header. Adam to confirm.

4. **Free-tier rate-limit handling specifics?** — Per §5.3, we propose silent degradation to regex-only on 429. Adam Q2 not yet answered; this is the proposed default. If Adam wants pay-as-you-go fallback ($0.05/M Qwen-7B per discussion.md L207), add a flag-gated paid-tier path (NOT default-on per Adam-lock).

5. **`paSkillRouterV2Enabled` flag — who flips?** — Per CLAUDE.md L67-69, flag flip ramping IS Adam-gated. WS4-A delivers the flag in OFF state; iter30 ramp 1→10→100 is Adam's call.

6. **SkillKey enum vs free-string?** — Schema uses `z.enum(SKILL_KEYS)` for `composableWith[]` / `conflictsWith[]`. This forces every new skill to add a literal-union entry. **Alternative**: `z.string()` (more flexible, less safe). **Recommendation**: keep enum — Adam's iter23 directive "test every playbook for whether it really works" benefits from compile-time enforcement.

---

## 13. Calendar (10 dev-days)

> Pair-friendly. WS4-B starts authoring 13 skill bodies on day 2 against frozen schema (T1).

| Day | WS4-A task(s) | Output | Cross-stream |
|---|---|---|---|
| 1 | Read all required-reads (§0); pin `@openai/agents-core` SDK version; write `skill-schema.ts` + Zod (T1, ½) | Schema scaffolded | — |
| 2 | T1 close + T2 (V1→V2 fromSnap tests) | Schema landed; WS4-B unblocked | WS4-B starts skill body authoring |
| 3 | T3 (6-skill metadata in `skill-defaults.ts`) — write all 6 entries with priority + composability table | Metadata block + table | — |
| 4 | T4 (migration script + dry-run on emulator) + T5 start (SkillStacker core) | `migrate-skills-v2.mjs` runnable | — |
| 5 | T5 close (composability + conflictsWith + ctx-gating) | `skill-stacker.ts` + ≥3 unit cases | Coord with WS3 on `activeSkillsAllowedTools` field |
| 6 | T6 (stacker tests) + T7 start (classifier prompt) | All stacker tests green | WS4-B integration-tests against stacker |
| 7 | T7 close (Qwen-7B prompt + module surface) + T8 (cache + fail-open) | classifier ready, behind flag | — |
| 8 | T9 (SkillRouter merge + cutover diff in `index.ts` shadow-mode) + T10 (tool-gate stub) | Router + tool-gate landed; flag default OFF | WS5-impl wires production behind flag |
| 9 | T11 (handoff lint + assert) + apply migration to staging Firestore + run all unit/integration tests | Migration applied; predeploy smoke green | — |
| 10 | T12 (re-baseline iter28-29 LLM-judge × 4) + 12 live scenario runs + WS4-A close-out report (per CLAUDE.md "verify by doing") | Baselines preserved; close-out report submitted | WS4-A closed; WS4-B + WS5-impl continue |

**Critical-path callouts**:
- Day 2 T1+T2 land — WS4-B unblocked (parallel from day 2).
- Day 5 ctx field add to WS3 — coord required (one-line; low risk).
- Day 10 re-baseline gate — hard block on iter30 close.

---

## 14. Closing — confidence rating

**Overall confidence: HIGH (4/5)**.

Reasons:
- **Schema is concrete + backward-compat verified by design** (§2.1 fromSnap defaults all 8 new fields; existing 6 V1 docs pass through unchanged). Risk is bounded.
- **Stacker pseudocode is realistic** (≤80 lines, 5 explicit steps, tested via 7 unit cases in §10.1). Composability + conflictsWith + ctx-gating semantics match research-doc model (skills-vs-playbook-research.md §4.5) and Adam's lock.
- **Classifier design is feasible** (∼700 token prompt, Qwen-7B 32k context = 30× headroom; cache + fail-open trivial). The Qwen-7B free-tier rate-limit unknown (R2) is the only material risk but it's mitigated by silent degradation to regex floor (no production breakage).
- **SDK handoff workaround is structurally avoided** (§8.1) — iter30 ships flat addendum-stack, no sub-agents, so `run.d.ts:211` is moot. Lint guard (§8.3) prevents silent regression post-iter30.
- **Eval baseline preservation has a hard gate** (§9) — re-baseline pre/post and demand ≥pre - 0.02 / 0/30 maintained. Catches metadata-induced regressions.

Why not 5/5:
- **Adam Q2 (free-tier RPM) and Q4 (skill-rename rollout policy)** unanswered. R2 mitigation reasonable but unverified.
- **WS4-B + WS5-impl wiring** depends on this WS landing cleanly; coordination risk if WS4-A slips beyond day 10.
- **Long-context drift** (Adam iter23 quote: "context 一长就不够好") — the stacker concatenates addenda, which may trigger drift on ≥10-turn sessions. Test §10.4 covers but real-world data only post-deploy.

[PUA生效 🔥] 工程师拉走这份就能动手 — 11 个文件路径 + 7+1 字段 schema + 80 行 stacker + 80 行 router + 6 个 skill 的 priority/composable/conflict 表格 + 10 day 日历 + 10 个 risk 全有 mitigation。下游不必回 P10 追问 day-1 issue。**抓手闭环。**
