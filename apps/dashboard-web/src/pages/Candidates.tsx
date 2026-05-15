// v2.0 marketplace candidate browser.
// Reads pa-users (the global candidate pool) joined to
// pa-candidate-source-links so each row shows where the candidate came from
// (juicebox / lessie / coresignal / manual_csv / imessage / public_job /
// ats / unknown). Renders v2 lifecycle state + global tags + profile
// completeness — replaces the legacy Users.tsx "Conversations" surface as
// the primary candidate management view.
//
// Future management hooks (link-outs already wired):
//  - CandidateProfile detail page (/admin/candidates/:id/profile)
//  - Identity Conflicts queue (/admin/identity-conflicts)
//  - Tag snapshots (/admin/users/:uid/tag-snapshots)
//  - Match debug (/admin/match-debug?candidateId=…)
//  - External-supply audit doc (drawer)
//
// Lifecycle mutations (opt-out / delete) are intentionally deferred until
// the deterministic-reducer CFs land. Per v2 product lock #9 "HITL
// corrections must become flywheel data" — admin UI can't mutate state
// directly without writing audit events server-side.

import { PA_COLLECTIONS } from "@pa/core-types"
import { collection, getDocs, limit, orderBy, query } from "firebase/firestore"
import { useEffect, useMemo, useState } from "react"
import { Link, useNavigate } from "react-router-dom"
import { db } from "../lib/firebase.js"
import { Icon } from "../components/console/Icon.js"
import {
  Card,
  DataTable,
  EmptyState,
  MetricStrip,
  PageHeader,
  PulseDot,
  SectionHead,
  StatusPill,
} from "../components/console/primitives.js"

type Tone = "live" | "hitl" | "blocked" | "info" | "neutral"

type LifecycleState =
  | "prospect"
  | "profile_created"
  | "reachable"
  | "claimed"
  | "profile_ready"
  | "active_job_seeker"
  | "retained"
  | "opted_out"
  | "deleted"

const LIFECYCLE_TONE: Record<LifecycleState, Tone> = {
  prospect: "neutral",
  profile_created: "info",
  reachable: "info",
  claimed: "live",
  profile_ready: "live",
  active_job_seeker: "live",
  retained: "info",
  opted_out: "hitl",
  deleted: "blocked",
}

const LIFECYCLE_LABEL: Record<LifecycleState, string> = {
  prospect: "Prospect",
  profile_created: "Profile created",
  reachable: "Reachable",
  claimed: "Claimed",
  profile_ready: "Profile ready",
  active_job_seeker: "Active",
  retained: "Retained",
  opted_out: "Opted out",
  deleted: "Deleted",
}

const LIFECYCLE_ORDER: LifecycleState[] = [
  "prospect",
  "profile_created",
  "reachable",
  "claimed",
  "profile_ready",
  "active_job_seeker",
  "retained",
  "opted_out",
  "deleted",
]

type ExternalSource = "juicebox" | "lessie" | "coresignal" | "manual_csv"
type SourceKind = ExternalSource | "imessage" | "public_job" | "ats" | "bulk_resume" | "synthetic_test" | "unknown"
type CandidateClass = "candidate_account" | "external_supply_prospect" | "synthetic_test_profile"

const SOURCE_LABEL: Record<SourceKind, string> = {
  juicebox: "Juicebox",
  lessie: "Lessie",
  coresignal: "Coresignal",
  manual_csv: "Manual CSV",
  imessage: "iMessage",
  public_job: "Public job page",
  ats: "ATS inbound",
  bulk_resume: "Bulk resume",
  synthetic_test: "Synthetic test",
  unknown: "Unknown",
}

const SOURCE_ORDER: SourceKind[] = [
  "juicebox",
  "lessie",
  "coresignal",
  "manual_csv",
  "imessage",
  "public_job",
  "ats",
  "bulk_resume",
  "synthetic_test",
  "unknown",
]

type UserDoc = {
  id: string
  phoneE164?: string
  email?: string
  displayName?: string
  linkedinUrl?: string
  candidateLifecycleState?: LifecycleState
  profileCompleteness?: number
  globalTags?: {
    skills?: { value?: string }[] | string[]
    industryPreference?: string[]
    rolePreference?: string[]
  }
  outreach?: { status?: "allowed" | "cooldown" | "paused" | "opted_out" }
  piiConsentAt?: string
  latestResumeArtifactId?: string
  mem0UserId?: string
  createdAt?: string
  updatedAt?: string
  lifecycleUpdatedAt?: string
  onboardingStatus?: string
}

type SourceLink = {
  candidateId?: string
  source?: ExternalSource
}

type Row = {
  id: string
  doc: UserDoc
  handle: string
  handleKind: "name" | "email" | "linkedin" | "phone" | "uid"
  lifecycle: LifecycleState
  source: SourceKind
  candidateClass: CandidateClass
  profilePct: number
  skills: string[]
  lastActiveIso?: string
  emailMasked?: string
  phoneMasked?: string
  linkedinHandle?: string
}

function maskEmail(email?: string): string | undefined {
  if (!email) return undefined
  const [local, domain] = email.split("@")
  if (!domain) return email
  const head = (local || "").slice(0, 1) || "?"
  return `${head}****@${domain}`
}

function maskPhone(phone?: string): string | undefined {
  if (!phone) return undefined
  if (phone.length < 8) return phone
  return `${phone.slice(0, 4)}…${phone.slice(-4)}`
}

function linkedinHandleFrom(url?: string): string | undefined {
  if (!url) return undefined
  const m = url.match(/linkedin\.com\/(?:in|pub|company)\/([^/?#]+)/i)
  return m ? m[1] : undefined
}

function shortUid(uid: string): string {
  if (uid.length <= 12) return uid
  return `${uid.slice(0, 8)}…${uid.slice(-4)}`
}

function buildHandle(doc: UserDoc): { handle: string; kind: Row["handleKind"] } {
  if (doc.displayName) return { handle: doc.displayName, kind: "name" }
  if (doc.email) return { handle: maskEmail(doc.email) || doc.email, kind: "email" }
  const li = linkedinHandleFrom(doc.linkedinUrl)
  if (li) return { handle: li, kind: "linkedin" }
  if (doc.phoneE164) return { handle: maskPhone(doc.phoneE164) || doc.phoneE164, kind: "phone" }
  return { handle: shortUid(doc.id), kind: "uid" }
}

function skillsFromTags(tags: UserDoc["globalTags"]): string[] {
  const raw = tags?.skills
  if (!raw || !Array.isArray(raw)) return []
  const out: string[] = []
  for (const item of raw) {
    if (typeof item === "string") {
      if (item) out.push(item)
    } else if (item && typeof item === "object" && "value" in item) {
      const v = (item as { value?: string }).value
      if (typeof v === "string" && v) out.push(v)
    }
    if (out.length >= 3) break
  }
  return out
}

function computeProfilePct(doc: UserDoc): number {
  if (typeof doc.profileCompleteness === "number") {
    const v = doc.profileCompleteness
    if (v > 1) return Math.min(100, Math.max(0, Math.round(v)))
    return Math.round(v * 100)
  }
  // Fallback heuristic when profileCompleteness isn't materialized yet.
  let n = 0
  if (doc.displayName) n += 12
  if (doc.email) n += 14
  if (doc.phoneE164) n += 10
  if (doc.linkedinUrl) n += 14
  if (doc.latestResumeArtifactId) n += 18
  if (doc.piiConsentAt) n += 10
  const skillCount = skillsFromTags(doc.globalTags).length
  n += Math.min(15, skillCount * 5)
  if (doc.mem0UserId) n += 7
  return Math.min(100, n)
}

function deriveLifecycle(doc: UserDoc): LifecycleState {
  if (doc.candidateLifecycleState) return doc.candidateLifecycleState
  if (doc.outreach?.status === "opted_out") return "opted_out"
  if (doc.onboardingStatus === "active") return "claimed"
  if (doc.onboardingStatus === "provisional") return "profile_created"
  if (doc.phoneE164 || doc.email) return "reachable"
  return "prospect"
}

function relTime(iso?: string): string {
  if (!iso) return "—"
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return "—"
  const min = Math.max(0, Math.round((Date.now() - t) / 60_000))
  if (min < 1) return "now"
  if (min < 60) return `${min}m`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h`
  const d = Math.floor(hr / 24)
  if (d < 14) return `${d}d`
  return `${Math.floor(d / 7)}w`
}

async function loadUserDocs(): Promise<UserDoc[]> {
  const snap = await getDocs(
    query(collection(db(), PA_COLLECTIONS.users), orderBy("createdAt", "desc"), limit(500))
  )
  return snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<UserDoc, "id">) }))
}

async function loadSourceLinks(): Promise<Map<string, ExternalSource>> {
  const out = new Map<string, ExternalSource>()
  try {
    const snap = await getDocs(
      query(collection(db(), PA_COLLECTIONS.candidateSourceLinks), limit(1000))
    )
    for (const d of snap.docs) {
      const data = d.data() as SourceLink
      if (data.candidateId && data.source && !out.has(data.candidateId)) {
        out.set(data.candidateId, data.source)
      }
    }
  } catch {
    // Collection may be empty / rules-denied in some envs — fall through.
  }
  return out
}

function deriveSource(doc: UserDoc, fromLinks: Map<string, ExternalSource>): SourceKind {
  if (isSyntheticTestProfile(doc)) return "synthetic_test"
  const linked = fromLinks.get(doc.id)
  if (linked) return linked
  if (doc.latestResumeArtifactId && !doc.phoneE164 && !doc.linkedinUrl) return "bulk_resume"
  if (doc.linkedinUrl && !doc.phoneE164) return "ats"
  if (doc.phoneE164) return "imessage"
  if (doc.email) return "public_job"
  return "unknown"
}

function isSyntheticTestProfile(doc: UserDoc): boolean {
  const id = doc.id.toLowerCase()
  const phone = doc.phoneE164 ?? ""
  const email = doc.email?.toLowerCase() ?? ""
  return id.startsWith("e2e-") ||
    id.startsWith("p9-") ||
    id.startsWith("qa") ||
    id.startsWith("recheck-") ||
    id.startsWith("synthetic") ||
    id.includes("reset") ||
    id.includes("smoke") ||
    id.includes("test") ||
    phone.startsWith("+19999") ||
    phone.startsWith("+1888") ||
    phone.includes("@") ||
    email.includes("test") ||
    email.endsWith("@example.com") ||
    email.endsWith("@local")
}

function classifyCandidate(source: SourceKind): CandidateClass {
  if (source === "synthetic_test") return "synthetic_test_profile"
  return source === "juicebox" ||
    source === "lessie" ||
    source === "coresignal" ||
    source === "manual_csv"
    ? "external_supply_prospect"
    : "candidate_account"
}

function candidateClassLabel(candidateClass: CandidateClass): string {
  if (candidateClass === "external_supply_prospect") return "External prospect"
  if (candidateClass === "synthetic_test_profile") return "Synthetic test"
  return "Candidate account"
}

function buildRow(doc: UserDoc, sourceMap: Map<string, ExternalSource>): Row {
  const { handle, kind } = buildHandle(doc)
  const source = deriveSource(doc, sourceMap)
  return {
    id: doc.id,
    doc,
    handle,
    handleKind: kind,
    lifecycle: deriveLifecycle(doc),
    source,
    candidateClass: classifyCandidate(source),
    profilePct: computeProfilePct(doc),
    skills: skillsFromTags(doc.globalTags),
    lastActiveIso: doc.lifecycleUpdatedAt || doc.updatedAt || doc.createdAt,
    emailMasked: maskEmail(doc.email),
    phoneMasked: maskPhone(doc.phoneE164),
    linkedinHandle: linkedinHandleFrom(doc.linkedinUrl),
  }
}

function handleIcon(kind: Row["handleKind"]): string {
  switch (kind) {
    case "name":
      return "user_check"
    case "email":
      return "mail"
    case "linkedin":
      return "link2"
    case "phone":
      return "phone"
    default:
      return "tag"
  }
}

export function Candidates() {
  const navigate = useNavigate()
  const [rows, setRows] = useState<Row[]>([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [search, setSearch] = useState("")
  const [stateFilter, setStateFilter] = useState<Set<LifecycleState>>(new Set())
  const [sourceFilter, setSourceFilter] = useState<Set<SourceKind>>(new Set())
  const [hasReachable, setHasReachable] = useState(false)
  const [accountOnly, setAccountOnly] = useState(true)
  const [drawer, setDrawer] = useState<Row | null>(null)

  async function refresh() {
    setLoading(true)
    setErr(null)
    try {
      const [docs, sourceMap] = await Promise.all([loadUserDocs(), loadSourceLinks()])
      setRows(docs.map((d) => buildRow(d, sourceMap)))
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void refresh()
  }, [])

  const counts = useMemo(() => {
    const byState = new Map<LifecycleState, number>()
    const bySource = new Map<SourceKind, number>()
    let withProfile = 0
    let withReachable = 0
    let accountCandidates = 0
    let externalProspects = 0
    let syntheticTests = 0
    for (const r of rows) {
      byState.set(r.lifecycle, (byState.get(r.lifecycle) ?? 0) + 1)
      bySource.set(r.source, (bySource.get(r.source) ?? 0) + 1)
      if (r.profilePct >= 50) withProfile++
      if (r.doc.email || r.doc.phoneE164 || r.doc.linkedinUrl) withReachable++
      if (r.candidateClass === "candidate_account") accountCandidates++
      else if (r.candidateClass === "external_supply_prospect") externalProspects++
      else syntheticTests++
    }
    return { byState, bySource, withProfile, withReachable, accountCandidates, externalProspects, syntheticTests }
  }, [rows])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return rows.filter((r) => {
      if (accountOnly && r.candidateClass !== "candidate_account") return false
      if (stateFilter.size > 0 && !stateFilter.has(r.lifecycle)) return false
      if (sourceFilter.size > 0 && !sourceFilter.has(r.source)) return false
      if (hasReachable && !(r.doc.email || r.doc.phoneE164 || r.doc.linkedinUrl)) return false
      if (!q) return true
      const hay = [
        r.id,
        r.handle,
        r.doc.email,
        r.doc.phoneE164,
        r.doc.linkedinUrl,
        r.doc.displayName,
        ...r.skills,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase()
      return hay.includes(q)
    })
  }, [rows, search, stateFilter, sourceFilter, hasReachable, accountOnly])

  const toggleState = (s: LifecycleState) => {
    const next = new Set(stateFilter)
    if (next.has(s)) next.delete(s)
    else next.add(s)
    setStateFilter(next)
  }
  const toggleSource = (s: SourceKind) => {
    const next = new Set(sourceFilter)
    if (next.has(s)) next.delete(s)
    else next.add(s)
    setSourceFilter(next)
  }
  const clearFilters = () => {
    setStateFilter(new Set())
    setSourceFilter(new Set())
    setHasReachable(false)
    setAccountOnly(false)
    setSearch("")
  }

  return (
    <>
      <PageHeader
        eyebrow="Marketplace pool"
        title="Candidate pool"
        subtitle="pa-users is the shared candidate pool, not just logged-in users. This view defaults to real candidate accounts; external supply prospects stay available by filter."
        actions={
          <>
            <button
              type="button"
              className="btn btn--secondary btn--sm"
              onClick={() => void refresh()}
              disabled={loading}
            >
              <Icon name="refresh" size={12} />
              {loading ? "Loading…" : "Refresh"}
            </button>
            <button
              type="button"
              className="btn btn--primary btn--sm"
              onClick={() => navigate("/admin/external-supply/batches/new")}
            >
              <Icon name="plus" size={12} />
              Import batch
            </button>
          </>
        }
      />

      <MetricStrip
        items={[
          { label: "Total", value: rows.length, tone: "info", sub: "in last 500 by createdAt" },
          {
            label: "Accounts",
            value: counts.accountCandidates,
            tone: counts.accountCandidates > 0 ? "live" : "neutral",
            sub: "auth / SMS / candidate intake",
          },
          {
            label: "External prospects",
            value: counts.externalProspects,
            tone: counts.externalProspects > 0 ? "hitl" : "neutral",
            sub: "operator-imported sourcing",
          },
          {
            label: "Synthetic tests",
            value: counts.syntheticTests,
            tone: counts.syntheticTests > 0 ? "neutral" : "neutral",
            sub: "excluded from account view",
          },
          {
            label: "Reachable",
            value: counts.withReachable,
            tone: counts.withReachable > 0 ? "live" : "neutral",
            sub: "has email / phone / linkedin",
          },
          {
            label: "Profile ≥ 50%",
            value: counts.withProfile,
            tone: counts.withProfile > 0 ? "live" : "neutral",
            sub: "completeness threshold",
          },
          {
            label: "Opted out",
            value: counts.byState.get("opted_out") ?? 0,
            tone:
              (counts.byState.get("opted_out") ?? 0) > 0
                ? "hitl"
                : "neutral",
            sub: "do-not-contact pool",
          },
        ]}
      />

      {err && (
        <div
          style={{
            padding: "10px 14px",
            borderRadius: 10,
            background: "var(--blocked-bg)",
            color: "var(--blocked)",
            fontSize: 13,
          }}
        >
          {err}
        </div>
      )}

      {/* Filter chips */}
      <Card padded={false}>
        <div style={{ padding: 14, display: "flex", flexDirection: "column", gap: 10 }}>
          <FilterRow label="State">
            {LIFECYCLE_ORDER.map((s) => {
              const n = counts.byState.get(s) ?? 0
              if (n === 0) return null
              const active = stateFilter.has(s)
              return (
                <Chip
                  key={s}
                  active={active}
                  tone={LIFECYCLE_TONE[s]}
                  onClick={() => toggleState(s)}
                >
                  {LIFECYCLE_LABEL[s]} <span style={{ opacity: 0.6 }}>· {n}</span>
                </Chip>
              )
            })}
          </FilterRow>
          <FilterRow label="Source">
            {SOURCE_ORDER.map((s) => {
              const n = counts.bySource.get(s) ?? 0
              if (n === 0) return null
              const active = sourceFilter.has(s)
              return (
                <Chip key={s} active={active} tone="info" onClick={() => toggleSource(s)}>
                  {SOURCE_LABEL[s]} <span style={{ opacity: 0.6 }}>· {n}</span>
                </Chip>
              )
            })}
          </FilterRow>
          <FilterRow label="Modifiers">
            <Chip
              active={accountOnly}
              tone="live"
              onClick={() => setAccountOnly((v) => !v)}
            >
              Candidate accounts only
            </Chip>
            <Chip
              active={hasReachable}
              tone="live"
              onClick={() => setHasReachable((v) => !v)}
            >
              Has reachable handle
            </Chip>
            {(stateFilter.size + sourceFilter.size > 0 || hasReachable || accountOnly || search) && (
              <button
                type="button"
                className="btn btn--ghost btn--sm"
                onClick={clearFilters}
                style={{ marginLeft: "auto" }}
              >
                <Icon name="x" size={12} />
                Clear filters
              </button>
            )}
          </FilterRow>
        </div>
      </Card>

      <SectionHead
        title="Candidates"
        count={filtered.length}
        actions={
          <span className="caption" style={{ color: "var(--ink-3)" }}>
            {rows.length === filtered.length
              ? `${rows.length} shown`
              : `${filtered.length} of ${rows.length} shown`}
          </span>
        }
      />
      {rows.length === 0 && !loading ? (
        <EmptyState
          icon="users"
          title="No candidates yet"
          body="The pa-users pool is empty — import a batch or wait for iMessage / public-job intake."
        />
      ) : (
        <DataTable
          rows={filtered}
          onRowClick={(r) => setDrawer(r as Row)}
          search={search}
          onSearch={setSearch}
          columns={[
            {
              key: "handle",
              label: "Handle",
              render: (r) => (
                <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
                  <Icon name={handleIcon((r as Row).handleKind)} size={13} style={{ color: "var(--ink-3)" }} />
                  <span
                    style={{
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                      fontWeight: 500,
                    }}
                    title={(r as Row).id}
                  >
                    {(r as Row).handle}
                  </span>
                </div>
              ),
            },
            {
              key: "lifecycle",
              label: "State",
              render: (r) => (
                <StatusPill tone={LIFECYCLE_TONE[(r as Row).lifecycle]} dot>
                  {LIFECYCLE_LABEL[(r as Row).lifecycle]}
                </StatusPill>
              ),
            },
            {
              key: "source",
              label: "Source",
              render: (r) => (
                <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                  <span style={{ fontSize: 12, color: "var(--ink-2)" }}>
                    {SOURCE_LABEL[(r as Row).source]}
                  </span>
                  <span style={{ fontSize: 10, color: "var(--ink-4)" }}>
                    {candidateClassLabel((r as Row).candidateClass)}
                  </span>
                </div>
              ),
            },
            {
              key: "profile",
              label: "Profile",
              render: (r) => <PctBar pct={(r as Row).profilePct} />,
            },
            {
              key: "skills",
              label: "Top tags",
              render: (r) => {
                const skills = (r as Row).skills
                if (skills.length === 0)
                  return <span style={{ color: "var(--ink-4)", fontSize: 12 }}>—</span>
                return (
                  <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                    {skills.map((s, i) => (
                      <span
                        key={i}
                        style={{
                          fontSize: 11,
                          padding: "2px 7px",
                          borderRadius: 4,
                          background: "var(--cream-2)",
                          color: "var(--ink-2)",
                        }}
                      >
                        {s}
                      </span>
                    ))}
                  </div>
                )
              },
            },
            {
              key: "last",
              label: "Last active",
              className: "mono",
              render: (r) => relTime((r as Row).lastActiveIso),
            },
            {
              key: "actions",
              label: "",
              render: (r) => (
                <button
                  type="button"
                  className="btn btn--ghost btn--sm"
                  onClick={(e) => {
                    e.stopPropagation()
                    setDrawer(r as Row)
                  }}
                >
                  Manage
                  <Icon name="arrow_right" size={12} />
                </button>
              ),
            },
          ]}
        />
      )}

      {drawer && <CandidateDrawer row={drawer} onClose={() => setDrawer(null)} />}
    </>
  )
}

function Chip({
  active,
  tone,
  onClick,
  children,
}: {
  active: boolean
  tone: Tone
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`pill pill--${active ? tone : "neutral"}`}
      style={{
        cursor: "pointer",
        border: active ? "1px solid currentColor" : "1px solid transparent",
        opacity: active ? 1 : 0.85,
        padding: "3px 10px",
      }}
    >
      {active && <Icon name="check" size={10} />}
      {children}
    </button>
  )
}

function FilterRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <span
        style={{
          fontSize: 11,
          letterSpacing: "0.1em",
          textTransform: "uppercase",
          fontWeight: 600,
          color: "var(--ink-3)",
          width: 70,
          flexShrink: 0,
        }}
      >
        {label}
      </span>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", flex: 1 }}>{children}</div>
    </div>
  )
}

function PctBar({ pct }: { pct: number }) {
  const tone: Tone = pct >= 70 ? "live" : pct >= 40 ? "hitl" : "blocked"
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 80 }}>
      <div className="score-bar" style={{ flex: 1, maxWidth: 100 }}>
        <div
          className={`score-bar__fill score-bar__fill--${tone}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--ink-2)" }}>
        {pct}%
      </span>
    </div>
  )
}

function CandidateDrawer({ row, onClose }: { row: Row; onClose: () => void }) {
  const doc = row.doc
  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(45, 26, 10, 0.25)",
        zIndex: 100,
        display: "flex",
        justifyContent: "flex-end",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "min(520px, 100%)",
          background: "var(--cream-3)",
          borderLeft: "1px solid var(--border)",
          overflowY: "auto",
          padding: 24,
          display: "flex",
          flexDirection: "column",
          gap: 18,
        }}
      >
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12 }}>
          <div style={{ minWidth: 0 }}>
            <div
              style={{
                fontSize: 11,
                letterSpacing: "0.14em",
                textTransform: "uppercase",
                color: "var(--ink-3)",
                fontWeight: 600,
                marginBottom: 6,
              }}
            >
              {candidateClassLabel(row.candidateClass)} · {SOURCE_LABEL[row.source]}
            </div>
            <div
              style={{
                fontFamily: "var(--font-serif)",
                fontSize: 26,
                lineHeight: 1.1,
                color: "var(--ink)",
                letterSpacing: "-0.02em",
              }}
            >
              {row.handle}
            </div>
            <div
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: 11,
                color: "var(--ink-3)",
                marginTop: 4,
              }}
              title={doc.id}
            >
              {shortUid(doc.id)}
            </div>
          </div>
          <button
            type="button"
            className="btn btn--ghost btn--icon"
            onClick={onClose}
            aria-label="Close"
          >
            <Icon name="x" size={14} />
          </button>
        </div>

        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          <StatusPill tone={LIFECYCLE_TONE[row.lifecycle]} dot>
            {LIFECYCLE_LABEL[row.lifecycle]}
          </StatusPill>
          {doc.outreach?.status && doc.outreach.status !== "allowed" && (
            <StatusPill tone={doc.outreach.status === "opted_out" ? "blocked" : "hitl"}>
              outreach: {doc.outreach.status}
            </StatusPill>
          )}
          {doc.piiConsentAt && <StatusPill tone="live">PII consent</StatusPill>}
          {doc.latestResumeArtifactId && <StatusPill tone="info">Resume on file</StatusPill>}
          {doc.mem0UserId && <StatusPill tone="info">mem0</StatusPill>}
        </div>

        <Card title="Reachable handles">
          <DrawerKV k="Display name" v={doc.displayName || "—"} />
          <DrawerKV k="Email" v={row.emailMasked || "—"} mono={!!row.emailMasked} />
          <DrawerKV k="Phone" v={row.phoneMasked || "—"} mono={!!row.phoneMasked} />
          <DrawerKV
            k="LinkedIn"
            v={
              doc.linkedinUrl ? (
                <a href={doc.linkedinUrl} target="_blank" rel="noreferrer">
                  {row.linkedinHandle || doc.linkedinUrl}
                </a>
              ) : (
                "—"
              )
            }
          />
        </Card>

        <Card title="Profile">
          <DrawerKV
            k="Completeness"
            v={<PctBar pct={row.profilePct} />}
          />
          <DrawerKV
            k="Top tags"
            v={
              row.skills.length === 0
                ? "—"
                : (
                  <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                    {row.skills.map((s, i) => (
                      <span
                        key={i}
                        style={{
                          fontSize: 11,
                          padding: "2px 7px",
                          borderRadius: 4,
                          background: "var(--cream-2)",
                          color: "var(--ink-2)",
                        }}
                      >
                        {s}
                      </span>
                    ))}
                  </div>
                )
            }
          />
          <DrawerKV k="Created" v={relTime(doc.createdAt)} />
          <DrawerKV k="Updated" v={relTime(doc.updatedAt)} />
        </Card>

        <Card title="Management actions">
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <DrawerLink to={`/admin/candidates/${doc.id}/profile`} label="Full profile" icon="user_check" />
            <DrawerLink to={`/admin/users/${doc.id}/tag-snapshots`} label="Tag snapshots" icon="tag" />
            <DrawerLink to="/admin/identity-conflicts" label="Identity conflicts queue" icon="user_merge" />
            <DrawerLink to="/admin/match-debug" label="Run in match debug" icon="zap" />
            <DrawerLink to="/admin/outreach-ops" label="Outreach ops" icon="send" />
          </div>
          <div
            style={{
              marginTop: 12,
              padding: "8px 10px",
              borderRadius: 6,
              background: "var(--hitl-bg)",
              color: "var(--hitl)",
              fontSize: 12,
              display: "flex",
              alignItems: "flex-start",
              gap: 6,
            }}
          >
            <Icon name="alert" size={13} />
            <span>
              Lifecycle mutations (opt-out · delete · merge) need server-side
              reducer CFs that don't exist yet. Tracked as a follow-up; the
              v2 product lock requires audit-event writes, so this surface
              stays read-only for now.
            </span>
          </div>
        </Card>
      </div>
    </div>
  )
}

function DrawerKV({
  k,
  v,
  mono,
}: {
  k: string
  v: React.ReactNode
  mono?: boolean
}) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "120px 1fr",
        gap: 12,
        padding: "6px 0",
        borderBottom: "1px solid var(--border)",
        fontSize: 13,
      }}
    >
      <span style={{ color: "var(--ink-3)" }}>{k}</span>
      <span style={{ color: "var(--ink)", fontFamily: mono ? "var(--font-mono)" : undefined }}>
        {v}
      </span>
    </div>
  )
}

function DrawerLink({
  to,
  label,
  icon,
}: {
  to: string
  label: string
  icon: string
}) {
  return (
    <Link
      to={to}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "8px 10px",
        border: "1px solid var(--border)",
        borderRadius: 6,
        textDecoration: "none",
        color: "var(--ink)",
        fontSize: 13,
        background: "var(--cream-3)",
      }}
    >
      <Icon name={icon} size={13} style={{ color: "var(--ink-3)" }} />
      <span style={{ flex: 1 }}>{label}</span>
      <Icon name="arrow_right" size={12} style={{ color: "var(--ink-3)" }} />
    </Link>
  )
}
