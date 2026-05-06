/**
 * v1.6 Phase 59 — `/admin/canonical-tags` page. [DASH-01, DASH-02]
 *
 * Three sections:
 *   1. Axis tabs (9): roleFunction, industrySector, major, visa, jobType,
 *      careerStage, location, relevantTags, skillBucket. Each tab shows the
 *      compile-time canonical vocab list (from `@wekruit/shared-tags`).
 *   2. Sandbox tokens (industrySector only) — pending `proposedTags` from
 *      `pa-canonical-tags` overlay collection where status = "sandbox".
 *      Each row has `Promote` + `Reject` buttons calling `paPromoteSandboxTag`.
 *   3. Audit log (industrySector only) — last 50 events from
 *      `pa-canonical-tags-audit`, sorted by timestamp desc.
 *
 * Adam-locked decisions (CLAUDE.md v1.6 design lock):
 *  - D2: industrySector add-able by admin via dashboard sandbox→promote
 *  - D5: vocab uses spelled-out tokens, no abbreviations
 *  - D16: industry vocab is admin add-able via Firestore overlay
 *
 * Auth: page is reachable only behind the dashboard's existing sign-in wall
 * (mirrors `/admin/flags`, `/match/weights` — same convention). The CF
 * itself enforces admin-only via `auth.token.admin === true` claim.
 */
import { useEffect, useState } from "react"
import {
  collection,
  getDocs,
  limit as fsLimit,
  orderBy,
  query,
  where,
} from "firebase/firestore"
import { httpsCallable } from "firebase/functions"
// `@wekruit/shared-tags/canonical` sub-path skips the Node-only sha256
// helpers in the main barrel — Vite cannot bundle `node:crypto`.
import {
  ROLE_FUNCTION_VOCAB,
  INDUSTRY_SECTOR_VOCAB,
  MAJOR_VOCAB,
  VISA_VOCAB,
  JOB_TYPE_VOCAB,
  CAREER_STAGE_VOCAB,
  LOCATION_VOCAB,
  SKILL_BUCKET_VOCAB,
} from "@wekruit/shared-tags/canonical"

import {
  EmptyState,
  ErrorState,
  LoadingState,
  PageHeader,
  Panel,
} from "../components/ui.js"
import { db, functions } from "../lib/firebase.js"

// ---------------------------------------------------------------------------
// Vocab catalogue
// ---------------------------------------------------------------------------

type Axis =
  | "roleFunction"
  | "industrySector"
  | "major"
  | "visa"
  | "jobType"
  | "careerStage"
  | "location"
  | "relevantTags"
  | "skillBucket"

interface AxisInfo {
  key: Axis
  values: readonly string[]
  /** Hard filter vs soft score badge. */
  matchSemantics: "hard_filter" | "soft_score"
  /** Open-vocab pattern axis (no closed list). */
  isOpenVocab: boolean
  /** D16 — runtime add-able via overlay. */
  supportsOverlay: boolean
}

const AXES: AxisInfo[] = [
  {
    key: "roleFunction",
    values: ROLE_FUNCTION_VOCAB,
    matchSemantics: "hard_filter",
    isOpenVocab: false,
    supportsOverlay: false,
  },
  {
    key: "industrySector",
    values: INDUSTRY_SECTOR_VOCAB,
    matchSemantics: "soft_score",
    isOpenVocab: false,
    supportsOverlay: true,
  },
  {
    key: "major",
    values: MAJOR_VOCAB,
    matchSemantics: "soft_score",
    isOpenVocab: false,
    supportsOverlay: false,
  },
  {
    key: "visa",
    values: VISA_VOCAB,
    matchSemantics: "hard_filter",
    isOpenVocab: false,
    supportsOverlay: false,
  },
  {
    key: "jobType",
    values: JOB_TYPE_VOCAB,
    matchSemantics: "hard_filter",
    isOpenVocab: false,
    supportsOverlay: false,
  },
  {
    key: "careerStage",
    values: CAREER_STAGE_VOCAB,
    matchSemantics: "hard_filter",
    isOpenVocab: false,
    supportsOverlay: false,
  },
  {
    key: "location",
    values: LOCATION_VOCAB,
    matchSemantics: "hard_filter",
    isOpenVocab: false,
    supportsOverlay: false,
  },
  {
    key: "relevantTags",
    values: [], // open vocab
    matchSemantics: "soft_score",
    isOpenVocab: true,
    supportsOverlay: false,
  },
  {
    key: "skillBucket",
    values: SKILL_BUCKET_VOCAB,
    matchSemantics: "soft_score",
    isOpenVocab: false,
    supportsOverlay: false,
  },
]

// ---------------------------------------------------------------------------
// Firestore types
// ---------------------------------------------------------------------------

const OVERLAY_COLLECTION = "pa-canonical-tags"
const AUDIT_COLLECTION = "pa-canonical-tags-audit"

interface SandboxToken {
  token: string
  status: string
  proposedBy?: string
  proposedAt?: string
  count?: number
  evidence?: { rawText: string; source: string; sourceDocId: string }[]
}

interface AuditRow {
  eventType: "promote" | "reject" | string
  vocab: string
  token: string
  actorUid?: string
  timestamp?: string
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export function CanonicalTags() {
  const [activeAxis, setActiveAxis] = useState<Axis>("roleFunction")
  const [sandboxTokens, setSandboxTokens] = useState<SandboxToken[] | null>(null)
  const [sandboxErr, setSandboxErr] = useState<string | null>(null)
  const [auditLog, setAuditLog] = useState<AuditRow[] | null>(null)
  const [auditErr, setAuditErr] = useState<string | null>(null)
  const [refreshKey, setRefreshKey] = useState(0)
  const [busyToken, setBusyToken] = useState<string | null>(null)
  const [actionErr, setActionErr] = useState<string | null>(null)

  const activeInfo = AXES.find((a) => a.key === activeAxis)!

  // Load sandbox tokens + audit log when industrySector tab active.
  useEffect(() => {
    if (activeAxis !== "industrySector") return
    let cancelled = false
    setSandboxTokens(null)
    setSandboxErr(null)
    setAuditLog(null)
    setAuditErr(null)

    const sandboxQ = query(
      collection(db(), OVERLAY_COLLECTION),
      where("vocab", "==", "industry-sector"),
      where("status", "==", "sandbox"),
    )
    getDocs(sandboxQ)
      .then((snap) => {
        if (cancelled) return
        const rows = snap.docs.map((d) => d.data() as SandboxToken)
        // Sort by count desc (most-evidence first)
        rows.sort((a, b) => (b.count ?? 0) - (a.count ?? 0))
        setSandboxTokens(rows)
      })
      .catch((e) => {
        if (!cancelled) setSandboxErr(e instanceof Error ? e.message : String(e))
      })

    const auditQ = query(
      collection(db(), AUDIT_COLLECTION),
      orderBy("timestamp", "desc"),
      fsLimit(50),
    )
    getDocs(auditQ)
      .then((snap) => {
        if (cancelled) return
        setAuditLog(snap.docs.map((d) => d.data() as AuditRow))
      })
      .catch((e) => {
        if (!cancelled) setAuditErr(e instanceof Error ? e.message : String(e))
      })

    return () => {
      cancelled = true
    }
  }, [activeAxis, refreshKey])

  async function callPromoteOrReject(token: string, action: "promote" | "reject") {
    setBusyToken(token)
    setActionErr(null)
    try {
      const fn = httpsCallable<
        { vocab: string; token: string; action: string },
        { ok: boolean; token: string; status: string }
      >(functions(), "paPromoteSandboxTag")
      await fn({ vocab: "industry-sector", token, action })
      // Drop the row optimistically; refresh audit log.
      setSandboxTokens((prev) => (prev ? prev.filter((t) => t.token !== token) : prev))
      setRefreshKey((n) => n + 1)
    } catch (e) {
      setActionErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusyToken(null)
    }
  }

  return (
    <div className="page-stack">
      <PageHeader
        eyebrow="v1.6 Phase 59 / Admin"
        title="Canonical Tags"
        description="Compile-time vocabs from @wekruit/shared-tags + Firestore overlay (D16). industrySector is admin add-able via the sandbox→promote flow below."
        actions={
          <button type="button" onClick={() => setRefreshKey((n) => n + 1)}>
            Refresh
          </button>
        }
      />

      {/* Axis tabs */}
      <Panel title="Axes" eyebrow={`${AXES.length} canonical axes`}>
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: 6,
            marginBottom: 6,
          }}
        >
          {AXES.map((a) => (
            <button
              key={a.key}
              type="button"
              onClick={() => setActiveAxis(a.key)}
              style={{
                padding: "0.5rem 0.85rem",
                border:
                  a.key === activeAxis
                    ? "2px solid #1a73e8"
                    : "1px solid #e2e8f0",
                background: a.key === activeAxis ? "#eff6ff" : "#ffffff",
                cursor: "pointer",
                borderRadius: 6,
                fontWeight: a.key === activeAxis ? 600 : 400,
                fontSize: "0.9em",
              }}
            >
              {a.key} ({a.isOpenVocab ? "open" : a.values.length})
            </button>
          ))}
        </div>
      </Panel>

      {/* Vocab list */}
      <Panel
        title={`Vocab: ${activeInfo.key}`}
        eyebrow={
          activeInfo.isOpenVocab
            ? "open-vocab axis (parse-time extracted)"
            : `${activeInfo.matchSemantics === "hard_filter" ? "Hard filter" : "Soft score"}${
                activeInfo.supportsOverlay ? " · admin add-able (D16)" : ""
              }`
        }
      >
        {activeInfo.isOpenVocab ? (
          <p style={{ color: "#64748b", margin: 0 }}>
            <code>relevantTags</code> is an open-vocab axis (parse-time extracted in
            pa-resume-parser v2, max 12 per profile, lowercase + underscore pattern). No fixed enum.
          </p>
        ) : (
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))",
              gap: 6,
            }}
          >
            {activeInfo.values.map((v) => (
              <div
                key={v}
                style={{
                  fontFamily: "monospace",
                  fontSize: "0.82em",
                  background: "#f8fafc",
                  padding: "4px 8px",
                  borderRadius: 4,
                  border: "1px solid #e2e8f0",
                }}
              >
                {v}
              </div>
            ))}
          </div>
        )}
      </Panel>

      {/* Sandbox section (industrySector only) */}
      {activeAxis === "industrySector" && (
        <>
          <Panel
            title="Sandbox tokens"
            eyebrow="pa-canonical-tags · status=sandbox · D16 promote→canonical"
          >
            {actionErr ? <ErrorState message={actionErr} /> : null}
            {sandboxErr ? (
              <ErrorState message={sandboxErr} />
            ) : sandboxTokens === null ? (
              <LoadingState label="Loading sandbox tokens…" />
            ) : sandboxTokens.length === 0 ? (
              <EmptyState
                title="No pending sandbox tokens"
                body="When pa-resume-parser v2 emits an industry token outside the canonical 42 enum, it lands here as 'sandbox' for review."
              />
            ) : (
              <table style={{ width: "100%", fontSize: "0.85em" }}>
                <thead>
                  <tr style={{ textAlign: "left", borderBottom: "1px solid #e2e8f0" }}>
                    <th style={{ padding: "0.5rem 0" }}>Token</th>
                    <th style={{ padding: "0.5rem 0" }}>Evidence count</th>
                    <th style={{ padding: "0.5rem 0" }}>Proposed by</th>
                    <th style={{ padding: "0.5rem 0" }}>Proposed at</th>
                    <th style={{ padding: "0.5rem 0" }}>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {sandboxTokens.map((t) => (
                    <tr key={t.token} style={{ borderBottom: "1px solid #f1f5f9" }}>
                      <td style={{ padding: "0.4rem 0", fontFamily: "monospace" }}>{t.token}</td>
                      <td style={{ padding: "0.4rem 0" }}>{t.count ?? 0}</td>
                      <td style={{ padding: "0.4rem 0", fontSize: "0.85em" }}>
                        {t.proposedBy?.slice(0, 12) ?? "(unknown)"}
                      </td>
                      <td style={{ padding: "0.4rem 0", fontSize: "0.85em" }}>
                        {t.proposedAt ? t.proposedAt.slice(0, 19).replace("T", " ") : "—"}
                      </td>
                      <td style={{ padding: "0.4rem 0" }}>
                        <button
                          type="button"
                          disabled={busyToken === t.token}
                          onClick={() => void callPromoteOrReject(t.token, "promote")}
                          style={{
                            background: "#16a34a",
                            color: "white",
                            border: "none",
                            padding: "4px 10px",
                            marginRight: 8,
                            cursor: "pointer",
                            borderRadius: 4,
                          }}
                        >
                          {busyToken === t.token ? "…" : "Promote"}
                        </button>
                        <button
                          type="button"
                          disabled={busyToken === t.token}
                          onClick={() => void callPromoteOrReject(t.token, "reject")}
                          style={{
                            background: "#dc2626",
                            color: "white",
                            border: "none",
                            padding: "4px 10px",
                            cursor: "pointer",
                            borderRadius: 4,
                          }}
                        >
                          Reject
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Panel>

          <Panel
            title="Audit log"
            eyebrow="pa-canonical-tags-audit · last 50"
          >
            {auditErr ? (
              <ErrorState message={auditErr} />
            ) : auditLog === null ? (
              <LoadingState label="Loading audit log…" />
            ) : auditLog.length === 0 ? (
              <EmptyState
                title="No audit events"
                body="No promote / reject events recorded yet."
              />
            ) : (
              <table style={{ width: "100%", fontSize: "0.85em" }}>
                <thead>
                  <tr style={{ textAlign: "left", borderBottom: "1px solid #e2e8f0" }}>
                    <th style={{ padding: "0.5rem 0" }}>Time</th>
                    <th style={{ padding: "0.5rem 0" }}>Event</th>
                    <th style={{ padding: "0.5rem 0" }}>Token</th>
                    <th style={{ padding: "0.5rem 0" }}>Actor</th>
                  </tr>
                </thead>
                <tbody>
                  {auditLog.map((a, i) => (
                    <tr key={i} style={{ borderBottom: "1px solid #f1f5f9" }}>
                      <td style={{ padding: "0.4rem 0", fontSize: "0.85em" }}>
                        {a.timestamp ? a.timestamp.slice(0, 19).replace("T", " ") : "—"}
                      </td>
                      <td style={{ padding: "0.4rem 0" }}>
                        <span
                          className={`status-badge ${
                            a.eventType === "promote" ? "good" : "bad"
                          }`}
                        >
                          {a.eventType}
                        </span>
                      </td>
                      <td
                        style={{
                          padding: "0.4rem 0",
                          fontFamily: "monospace",
                          fontSize: "0.85em",
                        }}
                      >
                        {a.token}
                      </td>
                      <td style={{ padding: "0.4rem 0", fontSize: "0.8em", color: "#64748b" }}>
                        {a.actorUid?.slice(0, 12) ?? "(unknown)"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Panel>
        </>
      )}
    </div>
  )
}
