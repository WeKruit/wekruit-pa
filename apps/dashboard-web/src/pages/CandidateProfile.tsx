import { PA_COLLECTIONS } from "@pa/core-types"
import { doc, getDoc } from "firebase/firestore"
import { useEffect, useState } from "react"
import { Link, useParams } from "react-router-dom"
import { EmptyState, ErrorState, LoadingState, PageHeader } from "../components/ui.js"
import { db } from "../lib/firebase.js"
import { CandidateMarketplace } from "./CandidateMarketplace.js"

type CandidateProfileRow = Record<string, unknown> & {
  id: string
  displayName?: string
  phoneE164?: string
}

export function CandidateProfile() {
  const { candidateId } = useParams()
  const [profile, setProfile] = useState<CandidateProfileRow | null>(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    if (!candidateId) return
    let cancelled = false
    setLoading(true)
    setErr(null)
    ;(async () => {
      try {
        const snap = await getDoc(doc(db(), PA_COLLECTIONS.users, candidateId))
        if (cancelled) return
        setProfile(snap.exists() ? ({ id: snap.id, ...snap.data() } as CandidateProfileRow) : null)
      } catch (e: unknown) {
        if (!cancelled) setErr(e instanceof Error ? e.message : String(e))
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [candidateId])

  if (!candidateId) return <ErrorState message="Missing candidate id" />
  if (loading) return <LoadingState label="Loading candidate profile..." />
  if (err) return <ErrorState message={err} />
  if (!profile) {
    return (
      <div className="page-stack">
        <p>
          <Link to="/conversations">Back to conversations</Link>
        </p>
        <EmptyState title="Candidate not found" body="No global candidate profile exists for this id." />
      </div>
    )
  }

  return (
    <div className="page-stack">
      <p>
        <Link to={`/users/${candidateId}`}>Back to conversation detail</Link>
      </p>
      <PageHeader
        eyebrow="Marketplace profile"
        title={profile.displayName || profile.phoneE164 || candidateId}
        description="Global candidate profile and per-job marketplace state."
      />
      <CandidateMarketplace candidateId={candidateId} profile={profile} />
    </div>
  )
}

export default CandidateProfile
