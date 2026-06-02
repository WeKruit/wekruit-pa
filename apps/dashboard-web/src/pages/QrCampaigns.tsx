/**
 * /admin/qr-campaigns — QR campaign manager.
 *
 * Two jobs:
 *  1. Generate a printable QR for `https://wekruit.com/start?c=<code>` (the
 *     iMessage-first onboarding entry). Validate the code client-side against the
 *     same regex the backend (`scan.ts`) enforces, show whether the code would
 *     AUTO-PROVISION (canary) or stay blocked until ramp, and let the operator
 *     download the PNG / copy the link.
 *  2. Read `pa-qr-scan-pending` (most recent ~50) for scan→conversion visibility:
 *     who scanned which campaign, on which Sendblue number, and whether the
 *     inbound claimed the reservation (status pending → claimed) and by which uid.
 *
 * Read-only against Firestore (Cloud Functions own all scan-pending writes). The
 * canary gate constants are MIRRORED from apps/functions/src/qr-onboarding/scan.ts
 * (see QrCampaigns.helpers.ts) — they must stay in sync.
 */
import { useEffect, useMemo, useRef, useState } from "react"
import type { CSSProperties } from "react"
import { QRCodeCanvas } from "qrcode.react"
import { collection, getDocs, limit, orderBy, query } from "firebase/firestore"
import { PA_COLLECTIONS } from "@pa/core-types"
import { AdminUserLink } from "../components/AdminEntityLink.js"
import { Badge, ErrorState, LoadingState, PageHeader, Panel } from "../components/ui.js"
import { db } from "../lib/firebase.js"
import {
  buildStartUrl,
  isValidCampaignCode,
  isCanaryCampaign,
  normalizeCampaignCode,
  shortToken,
  summarizeScans,
  type QrScanRow,
} from "./QrCampaigns.helpers.js"

const SCAN_LIMIT = 50

export function QrCampaigns() {
  const [rawCode, setRawCode] = useState("dev-card")
  const [scans, setScans] = useState<QrScanRow[]>([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [reloadKey, setReloadKey] = useState(0)
  const [campaignFilter, setCampaignFilter] = useState<string>("all")
  const [copied, setCopied] = useState(false)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        setLoading(true)
        setErr(null)
        const snap = await getDocs(
          query(
            collection(db(), PA_COLLECTIONS.qrScanPending),
            orderBy("createdAt", "desc"),
            limit(SCAN_LIMIT),
          ),
        )
        if (cancelled) return
        setScans(
          snap.docs.map((d) => ({ scanToken: d.id, ...(d.data() as Omit<QrScanRow, "scanToken">) })),
        )
      } catch (e) {
        if (!cancelled) setErr(e instanceof Error ? e.message : String(e))
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [reloadKey])

  const normalized = normalizeCampaignCode(rawCode)
  const codeValid = isValidCampaignCode(rawCode)
  const code = normalized ?? ""
  const startUrl = code ? buildStartUrl(code) : ""
  const canary = codeValid && isCanaryCampaign(code)

  const summaries = useMemo(() => summarizeScans(scans), [scans])
  const campaignOptions = useMemo(
    () => Array.from(new Set(scans.map((s) => s.campaign).filter((c): c is string => !!c))).sort(),
    [scans],
  )
  const visibleScans = useMemo(
    () => (campaignFilter === "all" ? scans : scans.filter((s) => s.campaign === campaignFilter)),
    [scans, campaignFilter],
  )

  function downloadPng() {
    const canvas = canvasRef.current
    if (!canvas || !code) return
    const url = canvas.toDataURL("image/png")
    const a = document.createElement("a")
    a.href = url
    a.download = `wekruit-qr-${code}.png`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
  }

  async function copyLink() {
    if (!startUrl) return
    try {
      await navigator.clipboard.writeText(startUrl)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    } catch {
      /* clipboard blocked — operator can still select the visible URL */
    }
  }

  return (
    <div>
      <PageHeader
        eyebrow="Outreach / QR onboarding"
        title="QR campaigns"
        description="Generate a printable QR for the iMessage-first onboarding entry and watch scan→conversion. A scan reserves a Sendblue number; the first inbound claims the reservation (pending → claimed)."
        actions={<button type="button" onClick={() => setReloadKey((k) => k + 1)}>Refresh scans</button>}
      />

      <Panel title="Generate campaign QR" eyebrow="https://wekruit.com/start?c=<code>">
        <div style={{ display: "grid", gap: 16, gridTemplateColumns: "minmax(0, 1fr) auto", alignItems: "start" }}>
          <div style={{ display: "grid", gap: 12, minWidth: 0 }}>
            <label style={labelStyle}>
              Campaign code
              <input
                value={rawCode}
                onChange={(e) => setRawCode(e.target.value)}
                placeholder="dev-card"
                spellCheck={false}
                autoCapitalize="none"
                style={{
                  ...inputStyle,
                  borderColor: rawCode && !codeValid ? "#dc2626" : "#cbd5e1",
                  fontFamily: "monospace",
                }}
              />
            </label>
            {rawCode && !codeValid ? (
              <div style={{ color: "#b91c1c", fontSize: "0.82em" }}>
                Invalid code. Must match <code>{"^[a-z0-9][a-z0-9_-]{0,63}$"}</code> (letters, digits,
                hyphen, underscore; starts alphanumeric).
              </div>
            ) : null}
            {normalized && normalized !== rawCode.trim() ? (
              <div style={{ color: "#92400e", fontSize: "0.82em" }}>
                Normalizes to <code>{normalized}</code> (codes are lowercased).
              </div>
            ) : null}

            <div style={{ display: "grid", gap: 4 }}>
              <span style={{ color: "#64748b", fontSize: "0.82em" }}>Start URL</span>
              <code style={{ overflowWrap: "anywhere", fontSize: "0.85em" }}>
                {startUrl || "— enter a valid code —"}
              </code>
            </div>

            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
              <button type="button" onClick={downloadPng} disabled={!code}>Download PNG</button>
              <button type="button" onClick={() => void copyLink()} disabled={!startUrl}>
                {copied ? "Copied" : "Copy link"}
              </button>
            </div>

            <AutoProvisionIndicator canary={canary} codeValid={codeValid} />
          </div>

          <div
            style={{
              display: "grid",
              placeItems: "center",
              padding: 16,
              border: "1px solid #e2e8f0",
              borderRadius: 8,
              background: "#fff",
              minWidth: 232,
            }}
          >
            {code ? (
              <QRCodeCanvas
                ref={canvasRef}
                value={startUrl}
                size={200}
                level="H"
                marginSize={2}
                title={`WeKruit QR for ${code}`}
              />
            ) : (
              <div style={{ width: 200, height: 200, display: "grid", placeItems: "center", color: "#94a3b8", fontSize: "0.85em", textAlign: "center" }}>
                Enter a valid campaign code to render the QR
              </div>
            )}
          </div>
        </div>
      </Panel>

      <Panel
        title="Campaign summary"
        eyebrow={`${summaries.length} campaign(s) in last ${SCAN_LIMIT} scans`}
      >
        {loading ? <LoadingState label="Loading scans..." /> : null}
        {err ? <ErrorState message={err} /> : null}
        {!loading && !err && summaries.length === 0 ? (
          <p style={{ opacity: 0.7, fontSize: "0.9em" }}>No scan reservations yet.</p>
        ) : null}
        {summaries.length > 0 ? (
          <table style={tableStyle}>
            <thead>
              <tr style={theadRowStyle}>
                <th style={thStyle}>Campaign</th>
                <th style={thStyle}>Auto-provision</th>
                <th style={thNumStyle}>Total</th>
                <th style={thNumStyle}>Pending</th>
                <th style={thNumStyle}>Claimed</th>
                <th style={thNumStyle}>Abandoned</th>
                <th style={thStyle}>Last scan</th>
              </tr>
            </thead>
            <tbody>
              {summaries.map((s) => (
                <tr key={s.campaign} style={tbodyRowStyle}>
                  <td style={tdStyle}><code>{s.campaign}</code></td>
                  <td style={tdStyle}>
                    <Badge tone={s.canary ? "ok" : "muted"}>{s.canary ? "Auto" : "Blocked"}</Badge>
                  </td>
                  <td style={tdNumStyle}>{s.total}</td>
                  <td style={tdNumStyle}>{s.pending}</td>
                  <td style={tdNumStyle}>{s.claimed}</td>
                  <td style={tdNumStyle}>{s.abandoned}</td>
                  <td style={{ ...tdStyle, fontFamily: "monospace", fontSize: "0.8em" }}>
                    {s.lastScanAt ? s.lastScanAt.slice(0, 16) : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
      </Panel>

      <Panel
        title="Recent scans"
        eyebrow={`${visibleScans.length} shown`}
        actions={
          <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: "0.85em" }}>
            Campaign
            <select value={campaignFilter} onChange={(e) => setCampaignFilter(e.target.value)} style={selectStyle}>
              <option value="all">all</option>
              {campaignOptions.map((c) => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
          </label>
        }
      >
        {!loading && !err && visibleScans.length === 0 ? (
          <p style={{ opacity: 0.7, fontSize: "0.9em" }}>No scans for this filter.</p>
        ) : null}
        {visibleScans.length > 0 ? (
          <table style={tableStyle}>
            <thead>
              <tr style={theadRowStyle}>
                <th style={thStyle}>Created</th>
                <th style={thStyle}>Token</th>
                <th style={thStyle}>Campaign</th>
                <th style={thStyle}>Number</th>
                <th style={thStyle}>Status</th>
                <th style={thStyle}>Claimed by</th>
              </tr>
            </thead>
            <tbody>
              {visibleScans.map((scan) => (
                <tr key={scan.scanToken} style={tbodyRowStyle}>
                  <td style={{ ...tdStyle, fontFamily: "monospace", fontSize: "0.8em" }}>
                    {scan.createdAt ? scan.createdAt.slice(0, 16) : "—"}
                  </td>
                  <td style={{ ...tdStyle, fontFamily: "monospace", fontSize: "0.8em" }} title={scan.scanToken}>
                    {shortToken(scan.scanToken)}
                  </td>
                  <td style={tdStyle}><code>{scan.campaign ?? "(none)"}</code></td>
                  <td style={{ ...tdStyle, fontFamily: "monospace", fontSize: "0.8em" }}>{scan.number ?? "—"}</td>
                  <td style={tdStyle}>
                    <Badge tone={scanTone(scan.status)}>{scan.status ?? "pending"}</Badge>
                  </td>
                  <td style={{ ...tdStyle, fontFamily: "monospace", fontSize: "0.75em" }}>
                    {scan.claimedUserId ? (
                      <AdminUserLink userId={scan.claimedUserId}>{scan.claimedUserId.slice(0, 8)}…</AdminUserLink>
                    ) : (
                      "—"
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
      </Panel>
    </div>
  )
}

function AutoProvisionIndicator({ canary, codeValid }: { canary: boolean; codeValid: boolean }) {
  if (!codeValid) {
    return (
      <div style={{ ...calloutStyle, background: "#f8fafc", borderColor: "#e2e8f0", color: "#475569" }}>
        Enter a valid code to see whether it auto-provisions.
      </div>
    )
  }
  if (canary) {
    return (
      <div style={{ ...calloutStyle, background: "#f0fdf4", borderColor: "#bbf7d0", color: "#166534" }}>
        <strong>Auto-provision: ON.</strong> Inbound from this canary code (starts <code>dev-</code> or
        in <code>CANARY_CAMPAIGNS</code>) auto-creates a provisional user and starts onboarding.
      </div>
    )
  }
  return (
    <div
      style={{ ...calloutStyle, background: "#fffbeb", borderColor: "#fde68a", color: "#92400e" }}
      title="Canary gate (scan.ts): only dev- prefix or CANARY_CAMPAIGNS codes auto-provision on inbound. A non-canary code still reserves a number + scan-pending row so the redirect surface is testable, but inbound will NOT auto-create a user until Adam widens CANARY_CAMPAIGNS."
    >
      <strong>Auto-provision: BLOCKED (needs ramp).</strong> The QR works and reserves a number, but
      inbound will not create a user until this code is added to the canary set in{" "}
      <code>scan.ts</code>. Hover for the gate rule.
    </div>
  )
}

function scanTone(status: string | undefined): "ok" | "warn" | "info" | "muted" {
  if (status === "claimed") return "ok"
  if (status === "abandoned") return "muted"
  return "info"
}

const labelStyle: CSSProperties = { display: "grid", gap: 4, fontSize: "0.88em" }
const inputStyle: CSSProperties = {
  width: "100%",
  padding: "0.45rem 0.55rem",
  border: "1px solid #cbd5e1",
  borderRadius: 4,
  fontSize: "0.9em",
  boxSizing: "border-box",
}
const selectStyle: CSSProperties = {
  padding: "0.3rem 0.4rem",
  border: "1px solid #cbd5e1",
  borderRadius: 4,
  fontSize: "0.85em",
}
const calloutStyle: CSSProperties = {
  border: "1px solid",
  borderRadius: 6,
  padding: "0.6rem 0.7rem",
  fontSize: "0.84em",
  lineHeight: 1.4,
}
const tableStyle: CSSProperties = { width: "100%", fontSize: "0.85em", borderCollapse: "collapse" }
const theadRowStyle: CSSProperties = { borderBottom: "1px solid rgba(0,0,0,0.15)" }
const tbodyRowStyle: CSSProperties = { borderBottom: "1px solid rgba(0,0,0,0.05)" }
const thStyle: CSSProperties = { textAlign: "left", padding: "0.35rem" }
const thNumStyle: CSSProperties = { textAlign: "right", padding: "0.35rem" }
const tdStyle: CSSProperties = { padding: "0.35rem" }
const tdNumStyle: CSSProperties = { padding: "0.35rem", textAlign: "right", fontVariantNumeric: "tabular-nums" }
