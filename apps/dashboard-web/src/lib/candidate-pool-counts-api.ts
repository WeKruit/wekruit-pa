/**
 * Firebase callable wrapper for `paAdminCandidatePoolCounts`
 * (apps/functions/src/admin-candidate-pool-counts.ts). Returns TRUE aggregate
 * counts over the WHOLE pa-users pool (not the 500-row browse sample the
 * Candidate pool page loads), so the header cards + STATE/SOURCE/IDENTITY
 * breakdowns read the real pool instead of ~10% of it.
 *
 * Wire types mirror the CF result — keep in sync.
 */
import { httpsCallable } from "firebase/functions"
import { functions } from "./firebase.js"

export interface CandidatePoolVariant {
  realRows: number
  byState: Record<string, number>
  bySource: Record<string, number>
  byIdentity: {
    registered: number
    phone_ready: number
    phone_bound: number
    sendblue_eligible: number
  }
}

export interface CandidatePoolCounts {
  totalPaUsers: number
  generatedAt: string
  truncated: { users: boolean; auth: boolean; handles: boolean; sourceLinks: boolean }
  classBreakdown: {
    accountCandidates: number
    externalProspects: number
    legacySmsProfiles: number
    demoPreviewProfiles: number
    syntheticTests: number
    internalProfiles: number
    identityArtifacts: number
  }
  identityCards: {
    registered: number
    phoneReady: number
    phoneBound: number
    sendblueEligible: number
  }
  default: CandidatePoolVariant
  includingHidden: CandidatePoolVariant
}

const CALLABLE = "paAdminCandidatePoolCounts"
const CACHE_KEY = "candidate-pool-counts:v1"
const CLIENT_CACHE_TTL_MS = 5 * 60_000

/** Loads the true pool counts. Client-side sessionStorage cache (5-min TTL) so
 *  re-opening the page is instant; the callable also caches server-side. */
export async function getCandidatePoolCounts(): Promise<CandidatePoolCounts> {
  try {
    const raw = sessionStorage.getItem(CACHE_KEY)
    if (raw) {
      const cached = JSON.parse(raw) as { at?: number; data?: CandidatePoolCounts }
      if (cached.data && typeof cached.at === "number" && Date.now() - cached.at < CLIENT_CACHE_TTL_MS) {
        return cached.data
      }
    }
  } catch {
    /* ignore cache read errors */
  }
  const fn = httpsCallable<Record<string, never>, CandidatePoolCounts>(functions(), CALLABLE)
  const result = await fn({})
  try {
    sessionStorage.setItem(CACHE_KEY, JSON.stringify({ at: Date.now(), data: result.data }))
  } catch {
    /* ignore quota errors */
  }
  return result.data
}
