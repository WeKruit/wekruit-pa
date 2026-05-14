/**
 * v2.0 External Supply V2 — Wave D dashboard UX — preview-batch result viewer.
 *
 * Renders the 5 sections from `paExternalSupplyPreviewBatch`:
 *   1. Detection      — top adapter + ranked alternates + confidence pills.
 *   2. Identity       — expected create_new / merge / needs_review / blocked
 *                       row counts.
 *   3. Tag enrichment — per-axis coverage + avg skills/row + missing-role
 *                       count.
 *   4. Tier forecast  — enum-keyed projected counts (only when company+job
 *                       supplied to preview).
 *   5. Warnings       — adapter or preview-level warning strings.
 *
 * All sections render `EmptyState` placeholders when the corresponding
 * forecast key is absent so the operator never sees a blank panel.
 */
import { EmptyState, Panel } from "../ui.js"
import type {
  PreviewBatchResult,
  AdapterDetectionCandidateUI,
} from "../../lib/external-supply-client.js"
import { EvaluationTierBadge } from "./EvaluationTierBadge.js"

const TIER_LABEL_ORDER: Array<keyof NonNullable<PreviewBatchResult["tierForecast"]>> = [
  "tier_1_personal_linkedin_and_email",
  "tier_2_personal_email",
  "tier_3_general_email",
  "retain_only",
  "blocked",
]

export function PreviewPane({ preview }: { preview: PreviewBatchResult }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <Panel
        title="Detection"
        eyebrow={`shape=${preview.detection.shapeHint} · rowCountPreview=${preview.rowCountPreview}`}
      >
        <DetectionList candidates={preview.detection.candidates} />
      </Panel>

      <Panel title="Identity forecast" eyebrow="expected rows per identity-resolution bucket">
        <ForecastGrid
          items={[
            { label: "Create new", value: preview.identityForecast.expectedCreateNew, tone: "good" },
            { label: "Merge existing", value: preview.identityForecast.expectedMergeExisting, tone: "good" },
            { label: "Needs review", value: preview.identityForecast.expectedNeedsReview, tone: "warn" },
            { label: "Blocked", value: preview.identityForecast.expectedBlocked, tone: "bad" },
          ]}
        />
      </Panel>

      <Panel title="Tag-enrichment forecast" eyebrow="canonical-tag axes from this batch">
        {Object.keys(preview.tagEnrichmentForecast.perAxisCoverage).length === 0 ? (
          <EmptyState
            title="No tag coverage"
            body="The preview parser did not surface any canonical-tag axes for this batch sample. Check the adapter override."
          />
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: "0.86em" }}>
            <div>
              <strong>avgSkillsPerRow:</strong> {preview.tagEnrichmentForecast.avgSkillsPerRow.toFixed(2)}
            </div>
            <div>
              <strong>missingRoleFunctionRows:</strong>{" "}
              {preview.tagEnrichmentForecast.missingRoleFunctionRows}
            </div>
            <table style={tagTableStyle}>
              <thead>
                <tr style={{ textAlign: "left", borderBottom: "1px solid #e2e8f0" }}>
                  <th style={thStyle}>Axis</th>
                  <th style={thStyle}>Rows covered</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(preview.tagEnrichmentForecast.perAxisCoverage).map(
                  ([axis, n]) => (
                    <tr key={axis} style={{ borderBottom: "1px solid #f1f5f9" }}>
                      <td style={tdStyle}>{axis}</td>
                      <td style={tdStyle}>{n}</td>
                    </tr>
                  ),
                )}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <Panel
        title="Tier forecast"
        eyebrow={
          preview.tierForecast
            ? "projected per-tier row counts"
            : "company + job required to forecast tiers"
        }
      >
        {preview.tierForecast ? (
          <div style={tierGridStyle}>
            {TIER_LABEL_ORDER.map((tier) => {
              const n = preview.tierForecast?.[tier] ?? 0
              return (
                <div key={tier} style={tierCardStyle}>
                  <div style={{ fontSize: "1.3em", fontWeight: 600 }}>{n}</div>
                  <EvaluationTierBadge tier={tier} />
                </div>
              )
            })}
          </div>
        ) : (
          <EmptyState
            title="No tier forecast"
            body="Pin a company + job above to generate a per-tier breakdown."
          />
        )}
      </Panel>

      <Panel title="Warnings" eyebrow={`${preview.warnings.length} warning(s)`}>
        {preview.warnings.length === 0 ? (
          <EmptyState title="No warnings" body="Adapter detection looks clean for this file." />
        ) : (
          <ul style={{ margin: 0, paddingLeft: 18, fontSize: "0.86em" }}>
            {preview.warnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  )
}

function DetectionList({ candidates }: { candidates: AdapterDetectionCandidateUI[] }) {
  if (candidates.length === 0) {
    return (
      <EmptyState
        title="No adapter detected"
        body="The preview parser couldn't match this file to any adapter signature."
      />
    )
  }
  return (
    <table style={detectionTableStyle}>
      <thead>
        <tr style={{ textAlign: "left", borderBottom: "1px solid #e2e8f0" }}>
          <th style={thStyle}>Adapter</th>
          <th style={thStyle}>Confidence</th>
          <th style={thStyle}>Required</th>
          <th style={thStyle}>Bonus</th>
          <th style={thStyle}>Reasons</th>
        </tr>
      </thead>
      <tbody>
        {candidates.map((c) => (
          <tr key={c.source} style={{ borderBottom: "1px solid #f1f5f9" }}>
            <td style={tdStyle}>
              <strong>{c.source}</strong>
            </td>
            <td style={tdStyle}>
              <span style={confidencePillStyle(c.confidence)}>
                {(c.confidence * 100).toFixed(0)}%
              </span>
            </td>
            <td style={tdStyle}>
              {c.requiredMatched}/{c.requiredCount}
            </td>
            <td style={tdStyle}>{c.bonusMatched}</td>
            <td style={{ ...tdStyle, fontSize: "0.78em", color: "#64748b" }}>
              {c.reasons.length > 0 ? c.reasons.join("; ") : "—"}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function ForecastGrid({
  items,
}: {
  items: Array<{ label: string; value: number; tone: "good" | "warn" | "bad" | "muted" }>
}) {
  return (
    <div style={forecastGridStyle}>
      {items.map((it) => (
        <div key={it.label} style={forecastCardStyle}>
          <div style={{ fontSize: "1.4em", fontWeight: 600 }}>{it.value}</div>
          <span className={`status-badge ${toneClass(it.tone)}`}>{it.label}</span>
        </div>
      ))}
    </div>
  )
}

function toneClass(tone: "good" | "warn" | "bad" | "muted"): string {
  if (tone === "good") return "good"
  if (tone === "bad") return "bad"
  if (tone === "warn") return "warn"
  return "muted"
}

function confidencePillStyle(c: number): React.CSSProperties {
  const pct = Math.max(0, Math.min(1, c))
  const bg = pct > 0.7 ? "#dcfce7" : pct > 0.35 ? "#fef9c3" : "#fee2e2"
  const fg = pct > 0.7 ? "#166534" : pct > 0.35 ? "#854d0e" : "#991b1b"
  return {
    background: bg,
    color: fg,
    padding: "0.15rem 0.5rem",
    borderRadius: 999,
    fontSize: "0.78em",
    fontWeight: 600,
  }
}

const detectionTableStyle: React.CSSProperties = {
  width: "100%",
  fontSize: "0.85em",
  borderCollapse: "collapse",
}
const tagTableStyle: React.CSSProperties = {
  width: "100%",
  fontSize: "0.85em",
  borderCollapse: "collapse",
  marginTop: 6,
}
const thStyle: React.CSSProperties = { padding: "0.4rem 0" }
const tdStyle: React.CSSProperties = { padding: "0.35rem 0" }

const forecastGridStyle: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))",
  gap: 8,
}
const forecastCardStyle: React.CSSProperties = {
  padding: "0.5rem 0.75rem",
  border: "1px solid #e2e8f0",
  borderRadius: 6,
  background: "#fff",
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  gap: 4,
}

const tierGridStyle: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))",
  gap: 8,
}
const tierCardStyle: React.CSSProperties = {
  padding: "0.5rem 0.75rem",
  border: "1px solid #e2e8f0",
  borderRadius: 6,
  background: "#fff",
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  gap: 4,
}
