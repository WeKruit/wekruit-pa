/**
 * Seniority RANGE helpers for the /me Match-preferences editor.
 *
 * The "Your seniority" axis is a RANGE: the candidate's stored preference is a
 * `[lo, hi]` pair over the canonical, ORDERED career-stage vocab. The editor
 * expands that pair into every chip between the anchors (so the open band is
 * visible) and, on save, sends the picked set verbatim; the backend collapses it
 * back to `[min, max]` in vocab order (`collapseCareerStageRange`).
 *
 * For that round-trip to be STABLE, the editor's option order MUST equal the
 * canonical `CAREER_STAGE_VOCAB` order used by the backend collapse — otherwise a
 * stored `[intern, junior]` would expand against a different ordering and
 * re-collapse to a different (wrong) range, silently shifting the candidate's
 * seniority floor. We therefore keep the canonical order in ONE place here and
 * both the editor and its tests read it, killing the drift.
 *
 * Mirrors `@wekruit/shared-tags` `CAREER_STAGE_VOCAB` (career-stage.ts). Inlined
 * (not imported from the package) only to avoid a vite build-time dependency on
 * the package's compiled dist — same rationale as the other inlined vocabs in
 * CandidatePortal.tsx. Keep in lock-step with packages/shared-tags.
 */
export const CAREER_STAGE_ORDER: readonly string[] = [
  "student",
  "intern",
  "entry_level",
  "junior",
  "mid_level",
  "senior",
  "staff",
  "principal",
  "manager",
  "director",
  "vp",
  "c_level",
  "founder",
]

/**
 * Expand a stored `[lo, hi]` range (two anchors over an ordered option list)
 * into every option between the anchors inclusive — so the editor shows the full
 * open band, not just the two endpoints. A single value yields just that value.
 * Off-vocab tokens are ignored. `options` MUST be the canonical career-stage
 * order so the expanded set round-trips cleanly through the backend collapse.
 */
export function expandCareerStageRange(raw: string[], options: readonly string[]): string[] {
  const idxs = raw.map((t) => options.indexOf(t)).filter((i) => i >= 0)
  if (idxs.length === 0) return []
  const lo = Math.min(...idxs)
  const hi = Math.max(...idxs)
  return options.slice(lo, hi + 1)
}
