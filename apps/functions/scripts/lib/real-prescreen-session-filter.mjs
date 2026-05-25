import {
  classifyCandidateProfile,
  deriveCandidateSource,
} from "@pa/core-types"

export function classifyPrescreenSessionUser({ userId, userDoc, session }) {
  const candidateDoc = buildCandidateClassifierDoc({ userId, userDoc, session })
  const source = deriveCandidateSource(candidateDoc)
  const candidateClass = classifyCandidateProfile(source, candidateDoc)
  return {
    included: candidateClass === "candidate_account",
    reason: candidateClass,
    source,
    candidateDoc,
  }
}

export async function loadUserDocsById(db, userIds) {
  const out = new Map()
  const ids = [...new Set(userIds.filter((id) => typeof id === "string" && id.trim()))]
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50)
    await Promise.all(chunk.map(async (userId) => {
      const snap = await db.collection("pa-users").doc(userId).get()
      out.set(userId, snap.exists ? snap.data() ?? {} : null)
    }))
  }
  return out
}

export function summarizeExcludedPrescreenRows(rows) {
  const byReason = {}
  for (const row of rows) byReason[row.reason] = (byReason[row.reason] ?? 0) + 1
  return byReason
}

function buildCandidateClassifierDoc({ userId, userDoc, session }) {
  const id = cleanString(userId) ?? cleanString(session?.userId) ?? ""
  const doc = userDoc && typeof userDoc === "object" ? userDoc : {}
  return {
    id,
    phoneE164: firstString(
      doc.phoneE164,
      doc.e164,
      doc.identity?.phoneE164,
      doc.identity?.e164,
      doc.contact?.phoneE164,
      doc.contact?.e164,
      session?.e164
    ),
    email: firstString(doc.email, doc.identity?.email, doc.contact?.email),
    linkedinUrl: firstString(
      doc.linkedinUrl,
      doc.linkedInUrl,
      doc.linkedinURL,
      doc.identity?.linkedinUrl,
      doc.contact?.linkedinUrl
    ),
    signupSource: firstString(doc.signupSource),
    source: firstString(doc.source),
    candidateLifecycleState: firstString(doc.candidateLifecycleState),
    onboardingStatus: firstString(doc.onboardingStatus),
    latestResumeArtifactId: firstString(doc.latestResumeArtifactId),
    piiConsentAt: firstString(doc.piiConsentAt),
    mem0UserId: firstString(doc.mem0UserId),
    testMode: doc.testMode === true || session?.testMode === true,
    isDemo: doc.isDemo === true || session?.isDemo === true,
    demoSourcePool: firstString(doc.demoSourcePool, session?.demoSourcePool),
  }
}

function firstString(...values) {
  for (const value of values) {
    const cleaned = cleanString(value)
    if (cleaned) return cleaned
  }
  return undefined
}

function cleanString(value) {
  if (typeof value !== "string") return null
  const trimmed = value.trim()
  return trimmed ? trimmed : null
}
