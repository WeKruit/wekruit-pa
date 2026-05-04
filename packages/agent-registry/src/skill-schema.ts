/**
 * iter30 WS4-A — SkillSchemaV2 (7+1 fields, all backward-compat).
 *
 * Migrates V1 PlaybookSchema → V2 SkillSchema by adding 7+1 NEW fields
 * (intentDescription, provides, requires, composableWith, conflictsWith,
 * priority, allowedTools, llmInvokable) PLUS paths[] (schema-only,
 * deferred to iter31).
 *
 * Backward-compat invariant (test gate):
 *   - Every existing V1 Firestore doc (the 6 in production) parses
 *     cleanly through `fromSkillSnap()` with no field validation errors.
 *   - All new fields default to safe values; existing 6 V1 docs validate
 *     without modification.
 *   - V1 readers (legacy code on the cutover boundary) continue to work
 *     because no V1 field has been removed or renamed.
 *
 * `playbookKey` is preserved as the doc id; `skillKey` is an alias for
 * forward callers. Internal Firestore collection name unchanged
 * (`pa-playbooks`) per Adam Q4 lock.
 *
 * Wire-in:
 *   - SkillStacker (`packages/pa-orchestrator/src/skill-stacker.ts`)
 *   - SkillRouter  (`packages/pa-orchestrator/src/skill-router.ts`)
 *   - SkillIntentClassifier (`packages/pa-orchestrator/src/skill-intent-classifier.ts`)
 *   - SkillToolGate (`packages/pa-orchestrator/src/skill-tool-gate.ts`)
 *
 * SDK handoff caveat (run.d.ts:211): iter30 ships flat addendum-stack;
 * NO sub-agent handoffs. See ws-4a-detail.md §8 for migration path.
 */
import { z } from "zod"

/**
 * External skill type tag — hand-curated to match the 6 + 13 catalog.
 *
 * Existing 6 (this WS migrates): headhunter, vent_support, motivation_nudge,
 *   jd_roast, interview_prep, negotiation
 *
 * New 13 (WS4-B authors bodies; this WS only validates the literal-union):
 *   rejection_processing, post_offer_decision, referral_request,
 *   silence_anchor, cv_followup, layoff_processing, company_research,
 *   career_pivot, return_to_work, daily_batch_reply, am_i_ai_check,
 *   boundary_test, mom_test
 */
export const SKILL_KEYS = [
  // EXISTING 6
  "headhunter",
  "vent_support",
  "motivation_nudge",
  "jd_roast",
  "interview_prep",
  "negotiation",
  // NEW 13 — WS4-B authors bodies; this WS only validates the literal-union
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

/**
 * Ctx-state requires gate — predicates evaluated by SkillStacker against
 * the live ClaireContext at turn entry. WS4-B's silence_anchor /
 * cv_followup need these to gate on conversation history (turn_gap_ge_2h)
 * or onboarding state (resume_recently_accepted).
 *
 * All flags default `false` (= predicate not active) so V1 docs and
 * skills that don't need ctx-gating validate without setting any.
 *
 * NOTE: this is a structured alternative to free-form `requires[]` string
 * predicates ("ctx.userProfile.resumeAccepted"). Both forms supported in
 * iter30 — structured is preferred for new content; free-form is the
 * escape hatch for one-off cases.
 */
export const RequiresCtxStateSchema = z
  .object({
    /** True iff the most recent inbound turn is ≥2h after the prior turn. */
    turn_gap_ge_2h: z.boolean().optional(),
    /** True iff the user has accepted a resume in the last N turns (N=10). */
    resume_recently_accepted: z.boolean().optional(),
    /** True iff conversation has had ≥3 turns. */
    conversation_warmed: z.boolean().optional(),
    /** True iff the user has signalled active job search (via `intent:job_search`). */
    job_search_active: z.boolean().optional(),
    /** True iff onboarding state is "done". */
    onboarding_completed: z.boolean().optional(),
  })
  .strict()

export type RequiresCtxState = z.infer<typeof RequiresCtxStateSchema>

/**
 * SkillSchemaV2 — the full Zod schema.
 *
 * Field count (per PLAN.md L191-198, audit-corrected):
 *   - V1 fields preserved: playbookKey, name, description, regexTriggers,
 *     addendum, enabled, routingHint, version, updatedAt, updatedBy, reason
 *   - NEW V2 (7+1): intentDescription, provides[], requires[],
 *     composableWith[], conflictsWith[], priority, allowedTools[],
 *     llmInvokable
 *   - DEFERRED: paths[] (schema-only, iter31)
 *   - AMENDMENT (WS4-B finding): requiresCtxState (optional structured
 *     ctx-state gate)
 */
export const SkillSchemaV2 = z
  .object({
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
     * 1-2 sentences telling the classifier what the skill does + when to
     * activate. Distinct from `description` (dashboard-facing) so we can
     * A/B-tune classifier accuracy independently of human-ops copy. Default
     * empty = fall back to `description`.
     * @range 0-500 chars
     */
    intentDescription: z.string().max(500).default(""),

    /**
     * 2. **provides** — capability tags this skill exposes when active.
     * Surfaced to other skills' `requires[]` for prerequisite checks.
     * Tag-namespaced: "stance:companion" | "stance:advisor" | etc.
     * Empty = skill provides nothing for downstream gating.
     */
    provides: z.array(z.string()).default([]),

    /**
     * 3. **requires** — prerequisite tags (other skills' provides[] OR
     * ctx-state predicates). Predicates use `ctx.<dot.path>` form:
     *   - "ctx.userProfile.resumeAccepted"
     *   - "ctx.activeSkills:headhunter"
     *   - "stance:advisor" (capability tag)
     * Empty = no prerequisites.
     */
    requires: z.array(z.string()).default([]),

    /**
     * 3.5 **requiresCtxState** — STRUCTURED ctx-state gate (WS4-B amendment).
     *
     * Preferred over free-form `requires[]` for ctx-state predicates because
     * Zod-validated keys catch typos at write-time. Set keys to `true` to
     * require that flag at activation time.
     *
     * Example for silence_anchor: `{ turn_gap_ge_2h: true }`
     * Example for cv_followup:    `{ resume_recently_accepted: true, onboarding_completed: true }`
     */
    requiresCtxState: RequiresCtxStateSchema.optional(),

    /**
     * 4. **composableWith** — skill keys that can stack with this one.
     * Empty = stacks with all (V1 backward-compat default). When set, only
     * listed skills may co-activate; non-composable matches are pruned by
     * `conflictsWith` resolution.
     */
    composableWith: z.array(SkillKeyEnum).default([]),

    /**
     * 5. **conflictsWith** — skill keys that CANNOT co-activate. Resolution:
     * highest priority wins. Bidirectional — declaring conflict on either
     * side is sufficient.
     */
    conflictsWith: z.array(SkillKeyEnum).default([]),

    /**
     * 6. **priority** — stacking + conflict tiebreaker. Range 1-100.
     * Higher number = higher priority (= wins conflicts). Default 50.
     * Examples: crisis=100, vent_support=80, motivation_nudge=60, headhunter=40
     */
    priority: z.number().int().min(1).max(100).default(50),

    /**
     * 7. **allowedTools** — tool names this skill may invoke when active.
     * WS6 OutputGuardrail enforces: any tool call NOT in the union of all
     * active skills' allowedTools[] trips the guardrail. Default empty = no
     * tools (correct for iter30: tools wired in WS6).
     */
    allowedTools: z.array(z.string()).default([]),

    /**
     * 8. **llmInvokable** — if false, skill is regex-only (LLM intent
     * classifier ignores it). Default true. Used to keep `crisis_safety` (a
     * regex-floor-only skill) out of the classifier's choice set.
     */
    llmInvokable: z.boolean().default(true),

    // ============ DEFERRED to iter31 (schema-only, unwired) ============

    /**
     * paths[] — Claude Code `paths` field analog (context gates: e.g.
     * "channel:imessage", "user.profile.resumeAccepted"). DEFERRED to iter31
     * per PLAN.md L198. Ships as Zod-validated empty array; stacker IGNORES
     * this field for iter30. Engineers MUST NOT add gating logic on paths
     * in this WS.
     */
    paths: z.array(z.string()).default([]),
  })
  .refine((s) => s.priority >= 1 && s.priority <= 100, {
    message: "priority must be 1..100",
  })
  // Composability invariant: if regexTriggers is empty AND requires is empty
  // AND requiresCtxState is empty/undefined, skill cannot match anything via
  // regex floor — must rely on LLM intent. PERMITTED — see WS4-B's cv_followup.
  // Validation note: this is intentionally permitted; we do NOT refine to
  // forbid it because cv_followup explicitly relies on requiresCtxState +
  // LLM intent.

export type SkillV2 = z.infer<typeof SkillSchemaV2>

/** Forward-compat: callers can use `Skill` interchangeably with `SkillV2`. */
export type Skill = SkillV2

// ============================================================================
// Backward-compat fromSnap (V1 doc → V2 type)
// ============================================================================

/**
 * Read a Firestore doc raw payload into a SkillV2 instance.
 *
 * Defensive — array fields may be undefined or contain nulls; we coerce to
 * safe values (drop nulls/non-strings). V1 docs lack the 8 new fields; Zod
 * defaults handle them.
 *
 * Test gate: every existing V1 doc parses cleanly with no validation errors.
 * Defaults populate the 8 new fields. Existing readers (e.g.
 * playbook-cache.ts) continue working because the V2 type is a superset.
 */
export function fromSkillSnap(id: string, raw: Record<string, unknown>): SkillV2 {
  const rh = raw.routingHint
  const routingHint: "no_chain" | "role_chain" | null =
    rh === "no_chain" || rh === "role_chain" ? rh : null

  const isString = (s: unknown): s is string => typeof s === "string"
  const isSkillKey = (s: unknown): s is SkillKey =>
    typeof s === "string" && (SKILL_KEYS as readonly string[]).includes(s)

  const updatedAtRaw = raw.updatedAt
  let updatedAt: string | null = null
  if (typeof updatedAtRaw === "string") {
    updatedAt = updatedAtRaw
  } else if (updatedAtRaw && typeof updatedAtRaw === "object") {
    const obj = updatedAtRaw as Record<string, unknown>
    if (typeof obj.toDate === "function") {
      try {
        updatedAt = (obj.toDate as () => Date)().toISOString()
      } catch {
        updatedAt = null
      }
    } else if ("seconds" in obj) {
      const s = Number(obj.seconds)
      if (Number.isFinite(s)) updatedAt = new Date(s * 1000).toISOString()
    }
  }

  const safe: Record<string, unknown> = {
    playbookKey: typeof raw.playbookKey === "string" ? raw.playbookKey : id,
    name: typeof raw.name === "string" ? raw.name : id,
    description: typeof raw.description === "string" ? raw.description : "",
    regexTriggers: Array.isArray(raw.regexTriggers)
      ? (raw.regexTriggers as unknown[]).filter(isString)
      : [],
    addendum: typeof raw.addendum === "string" ? raw.addendum : "",
    enabled: raw.enabled === undefined ? true : Boolean(raw.enabled),
    routingHint,
    version: typeof raw.version === "number" ? raw.version : 0,
    updatedAt,
    updatedBy: typeof raw.updatedBy === "string" ? raw.updatedBy : "",
    reason: typeof raw.reason === "string" ? raw.reason : "",

    // V2 fields — defaults if absent
    intentDescription:
      typeof raw.intentDescription === "string" ? raw.intentDescription : "",
    provides: Array.isArray(raw.provides)
      ? (raw.provides as unknown[]).filter(isString)
      : [],
    requires: Array.isArray(raw.requires)
      ? (raw.requires as unknown[]).filter(isString)
      : [],
    composableWith: Array.isArray(raw.composableWith)
      ? (raw.composableWith as unknown[]).filter(isSkillKey)
      : [],
    conflictsWith: Array.isArray(raw.conflictsWith)
      ? (raw.conflictsWith as unknown[]).filter(isSkillKey)
      : [],
    priority:
      typeof raw.priority === "number" && raw.priority >= 1 && raw.priority <= 100
        ? raw.priority
        : 50,
    allowedTools: Array.isArray(raw.allowedTools)
      ? (raw.allowedTools as unknown[]).filter(isString)
      : [],
    llmInvokable: raw.llmInvokable === undefined ? true : Boolean(raw.llmInvokable),
    paths: Array.isArray(raw.paths)
      ? (raw.paths as unknown[]).filter(isString)
      : [],
  }

  // requiresCtxState — only attach if a valid object present
  if (
    raw.requiresCtxState &&
    typeof raw.requiresCtxState === "object" &&
    !Array.isArray(raw.requiresCtxState)
  ) {
    const ctxParse = RequiresCtxStateSchema.safeParse(raw.requiresCtxState)
    if (ctxParse.success) {
      safe.requiresCtxState = ctxParse.data
    }
  }

  return SkillSchemaV2.parse(safe)
}
