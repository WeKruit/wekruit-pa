/**
 * QrCampaigns.helpers — pure logic for the /admin/qr-campaigns operator surface.
 *
 * IMPORTANT — keep in sync with the backend source of truth:
 *   apps/functions/src/qr-onboarding/scan.ts
 * These constants/regex are mirrored client-side ONLY so the operator can preview
 * "would this campaign auto-provision?" before printing a card. The backend gate
 * is authoritative; this is a read-only preview. If `CANARY_CAMPAIGNS` or the
 * `dev-` prefix rule changes there, change it here too.
 */

/** Mirror of scan.ts CAMPAIGN_RE — one a-z0-9 start char + up to 63 [a-z0-9_-]. */
export const CAMPAIGN_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i

/** Mirror of scan.ts CANARY_CAMPAIGNS. Widen in BOTH places to ramp. */
export const CANARY_CAMPAIGNS: ReadonlySet<string> = new Set<string>(["dev-card"])

/** Base of the QR start URL the printed card encodes. */
export const QR_START_BASE = "https://wekruit.com/start"

/** Mirror of scan.ts normalizeCampaignCode — trimmed lowercase or null. */
export function normalizeCampaignCode(raw: unknown): string | null {
  if (typeof raw !== "string") return null
  const trimmed = raw.trim().toLowerCase()
  if (!trimmed || !CAMPAIGN_RE.test(trimmed)) return null
  return trimmed
}

/** True when the raw input is a syntactically valid campaign code. */
export function isValidCampaignCode(raw: string): boolean {
  return normalizeCampaignCode(raw) !== null
}

/**
 * Mirror of scan.ts isCanaryCampaign — `dev-` prefix OR explicit allowlist.
 * A canary campaign's inbound auto-provisions a provisional user; a non-canary
 * code only reserves a number + scan-pending row (blocked until Adam ramps).
 */
export function isCanaryCampaign(campaign: string | null | undefined): boolean {
  if (typeof campaign !== "string") return false
  const code = campaign.trim().toLowerCase()
  if (!code) return false
  if (code.startsWith("dev-")) return true
  return CANARY_CAMPAIGNS.has(code)
}

/** Build the exact `?c=<code>` start URL the QR encodes. */
export function buildStartUrl(code: string): string {
  return `${QR_START_BASE}?c=${encodeURIComponent(code)}`
}

export type QrScanStatus = "pending" | "claimed" | "abandoned"

export interface QrScanRow {
  scanToken: string
  number?: string
  groupId?: string
  campaign?: string
  status?: QrScanStatus | string
  createdAt?: string
  claimedAt?: string
  claimedUserId?: string
  abandonedAt?: string
}

export interface QrCampaignSummary {
  campaign: string
  total: number
  pending: number
  claimed: number
  abandoned: number
  canary: boolean
  lastScanAt?: string
}

/**
 * Roll the most-recent scan rows up into per-campaign counters. Ordering of the
 * returned summary is by most-recent scan first; counters are stable regardless
 * of row order.
 */
export function summarizeScans(rows: QrScanRow[]): QrCampaignSummary[] {
  const byCampaign = new Map<string, QrCampaignSummary>()
  for (const row of rows) {
    const campaign = typeof row.campaign === "string" && row.campaign.trim() ? row.campaign.trim() : "(none)"
    let summary = byCampaign.get(campaign)
    if (!summary) {
      summary = {
        campaign,
        total: 0,
        pending: 0,
        claimed: 0,
        abandoned: 0,
        canary: isCanaryCampaign(campaign),
        lastScanAt: undefined,
      }
      byCampaign.set(campaign, summary)
    }
    summary.total += 1
    if (row.status === "claimed") summary.claimed += 1
    else if (row.status === "abandoned") summary.abandoned += 1
    else summary.pending += 1
    if (row.createdAt && (!summary.lastScanAt || row.createdAt > summary.lastScanAt)) {
      summary.lastScanAt = row.createdAt
    }
  }
  return Array.from(byCampaign.values()).sort((a, b) =>
    (b.lastScanAt ?? "").localeCompare(a.lastScanAt ?? ""),
  )
}

/** Short, copyable form of an opaque scan token for table display. */
export function shortToken(token: string): string {
  if (token.length <= 12) return token
  return `${token.slice(0, 8)}…${token.slice(-4)}`
}
