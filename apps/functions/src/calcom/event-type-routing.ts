/**
 * event-type-routing.ts — pure Cal.com eventType resolution. No I/O.
 *
 * Resolution order (first match wins):
 *   1. PER-JOB OVERRIDE: pa-jobs/{jobId}.calcomEventTypeId (new optional number;
 *      absent on every existing job → falls through; read defensively by the
 *      caller, no migration).
 *   2. roleFunction MAP: the candidate's matched role's roleFunction[] (from
 *      matching-jobs/{jobId}, falling back to pa-users.tags.targetRoleFunction[])
 *      mapped via ROLE_FUNCTION_EVENT_TYPE. First mapped token wins.
 *   3. DEFAULT_EVENT_TYPE_ID.
 *
 * Live account facts (key cal_live_… owns these — discovered 2026-06-01). The
 * map keys are the CANONICAL jobright `utm_campaign` roleFunction tokens (D1),
 * verified verbatim against `@wekruit/shared-tags`
 * ROLE_FUNCTION_VOCAB:
 *   - software_engineering   → 5847961  "Software Engineer Interview" (15m)
 *   - creatives_and_design   → 5604544  "Designer Interview" (20m)
 *   - sales                  → 5180826  "GTM Interview" (20m)
 * (Agent Dev Interview 5180824 has no clean roleFunction; reserved, not mapped.)
 *
 * NOTE: the brief loosely used "ui_ux"/"design"/"go_to_market" — those are NOT
 * canonical ROLE_FUNCTION_VOCAB tokens; the canonical tokens are
 * `creatives_and_design` and `sales`. The map uses the canonical ones.
 */

export const ROLE_FUNCTION_EVENT_TYPE: Record<string, number> = {
  software_engineering: 5847961, // "Software Engineer Interview" (15m)
  creatives_and_design: 5604544, // "Designer Interview" (20m)
  sales: 5180826, // "GTM Interview" (20m)
}

/**
 * Neutral interview fallback — used when no per-job override AND no mapped
 * roleFunction (e.g. product_management / marketing / data_analysis, or an
 * empty/unknown roleFunction). Reuses 5847961 "Software Engineer Interview"
 * (a real bookable 15-min interview type, verified to return slots) as the
 * generic INTERVIEW default. We intentionally do NOT fall back to the
 * "WeKruit Demo" type (4508818) — booking a candidate INTERVIEW as a "demo" is
 * the wrong product surface. (If a dedicated generic "Interview" type is created
 * later, point this at it.)
 */
export const DEFAULT_EVENT_TYPE_ID = 5847961

export interface ResolveEventTypeArgs {
  jobOverrideEventTypeId?: number | null
  roleFunctions?: string[] | null
}

export interface ResolveEventTypeResult {
  eventTypeId: number
  source: "job_override" | "role_function" | "default"
}

export function resolveEventTypeId(args: ResolveEventTypeArgs): ResolveEventTypeResult {
  const ov = args.jobOverrideEventTypeId
  if (typeof ov === "number" && Number.isInteger(ov) && ov > 0) {
    return { eventTypeId: ov, source: "job_override" }
  }
  for (const rf of args.roleFunctions ?? []) {
    const id = ROLE_FUNCTION_EVENT_TYPE[String(rf).toLowerCase()]
    if (id) return { eventTypeId: id, source: "role_function" }
  }
  return { eventTypeId: DEFAULT_EVENT_TYPE_ID, source: "default" }
}
