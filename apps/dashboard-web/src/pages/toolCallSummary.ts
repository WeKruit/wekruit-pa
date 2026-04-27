/**
 * Phase 13 — pure helper that decorates `pa_tool_calls.resultSummary`
 * cells for the dashboard's Connectors panel.
 *
 * Lives in its own module (no firebase import) so it can be unit-tested
 * with `node --import tsx` without bootstrapping Vite/Firebase. The
 * Operations + UserDetail pages re-export and consume it for rendering.
 *
 * Contract:
 *   - For `wekruit-matching` rows whose `resultSummary` is valid JSON
 *     produced by Phase 13's connector schema, surface a friendly inline
 *     list of role titles + fitScore (rounded to 2dp).
 *   - For degraded-mode rows (`ok: false`), prefix with the reason tag so
 *     operators can debug without opening the audit row.
 *   - For legacy rows (pre-Phase-13 schema, malformed JSON, non-matching
 *     connector, or missing summary), gracefully pass through the raw
 *     truncated text. No `pa_tool_calls` write shape is mutated by the
 *     dashboard.
 */
export function renderToolCallSummary(row: Record<string, unknown>): string {
  const connectorName = typeof row.connectorName === "string" ? row.connectorName : ""
  const raw = typeof row.resultSummary === "string" ? row.resultSummary : ""
  if (connectorName !== "wekruit-matching" || !raw) return raw
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return raw
  }
  if (!parsed || typeof parsed !== "object") return raw
  const o = parsed as { ok?: unknown; reason?: unknown; summary?: unknown; roles?: unknown }
  if (o.ok === false) {
    const reason = typeof o.reason === "string" ? o.reason : "unknown"
    const summary = typeof o.summary === "string" ? o.summary : ""
    return `(degraded:${reason}) ${summary}`.trim()
  }
  const roles = Array.isArray(o.roles)
    ? (o.roles as unknown[]).filter(
        (r): r is { title?: unknown; fitScore?: unknown } => !!r && typeof r === "object"
      )
    : []
  if (roles.length === 0) {
    return typeof o.summary === "string" ? o.summary : raw
  }
  const lines = roles.map((r, i) => {
    const title = typeof r.title === "string" ? r.title : "(untitled)"
    const score = typeof r.fitScore === "number" ? `(${r.fitScore.toFixed(2)})` : ""
    return `#${i + 1} ${title} ${score}`.trim()
  })
  return lines.join(" | ")
}
