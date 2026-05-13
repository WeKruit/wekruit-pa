import { collection, getDocs, limit, orderBy, query } from "firebase/firestore"
import { useEffect, useMemo, useState } from "react"
import { Link } from "react-router-dom"
import {
  DataTable,
  EmptyState,
  ErrorState,
  LoadingState,
  PageHeader,
  Panel,
  StatusBadge,
  type DataTableColumn,
} from "../components/ui.js"
import { db } from "../lib/firebase.js"
import {
  S2_IDENTITY_COLLECTIONS,
  compactValue,
  isResolvedIdentityConflict,
  sortRowsByTime,
  type MarketplaceRow,
} from "./CandidateMarketplace.helpers.js"

type IdentityConflictRow = MarketplaceRow & {
  candidateId?: string
  primaryCandidateId?: string
  competingCandidateId?: string
  kind?: string
  status?: string
  state?: string
  type?: string
  createdAt?: string
  updatedAt?: string
  resolvedAt?: string
}

export function IdentityConflicts() {
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [rows, setRows] = useState<IdentityConflictRow[]>([])

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        setLoading(true)
        setErr(null)
        const snap = await getDocs(
          query(collection(db(), S2_IDENTITY_COLLECTIONS.identityConflicts), orderBy("createdAt", "desc"), limit(100))
        )
        if (cancelled) return
        setRows(
          sortRowsByTime(
            snap.docs.map((docSnap) => ({ id: docSnap.id, ...docSnap.data() }) as IdentityConflictRow),
            ["updatedAt", "createdAt"]
          )
        )
      } catch (e: unknown) {
        if (!cancelled) setErr(e instanceof Error ? e.message : String(e))
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const openCount = useMemo(() => rows.filter((row) => !isResolvedIdentityConflict(row)).length, [rows])

  if (loading) return <LoadingState label="Loading identity conflicts..." />
  if (err) return <ErrorState message={err} />

  return (
    <div>
      <PageHeader
        eyebrow="S2 identity"
        title="Identity Conflicts"
        description="Operator queue for deterministic identity review items. This is not an employer candidate browser."
      />
      <Panel title={`${openCount} open / ${rows.length} total`} eyebrow="pa-candidate-identity-conflicts">
        <DataTable<IdentityConflictRow>
          rows={rows}
          empty={
            <EmptyState
              title="No identity conflicts"
              body="No PDF/email mismatch or duplicate-candidate suspicion records are queued."
            />
          }
          columns={columns}
        />
      </Panel>
    </div>
  )
}

const columns: DataTableColumn<IdentityConflictRow>[] = [
  { key: "createdAt", header: "Created", render: (row) => compactValue(row.createdAt) },
  { key: "kind", header: "Kind", render: (row) => <StatusBadge value={row.kind ?? row.type} /> },
  { key: "status", header: "Status", render: (row) => <StatusBadge value={row.status ?? row.state} /> },
  {
    key: "primaryCandidateId",
    header: "Primary",
    render: (row) =>
      row.primaryCandidateId ?? row.candidateId ? (
        <Link to={`/admin/candidates/${encodeURIComponent(row.primaryCandidateId ?? row.candidateId ?? "")}/profile`}>
          {row.primaryCandidateId ?? row.candidateId}
        </Link>
      ) : (
        "-"
      ),
  },
  {
    key: "competingCandidateId",
    header: "Competing",
    render: (row) =>
      row.competingCandidateId ? (
        <Link to={`/admin/candidates/${encodeURIComponent(row.competingCandidateId)}/profile`}>{row.competingCandidateId}</Link>
      ) : (
        "-"
      ),
  },
  { key: "summary", header: "Summary", render: (row) => compactValue(row.evidence ?? row.reason ?? row.payloadRedacted, 360) },
  { key: "resolvedAt", header: "Resolved", render: (row) => compactValue(row.resolvedAt) },
]
