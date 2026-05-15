export type CandidateListUserDoc = {
  id: string
  phoneE164?: string
  email?: string
  testMode?: boolean
}

export function isSyntheticTestProfile(doc: CandidateListUserDoc): boolean {
  const id = doc.id.toLowerCase()
  const phone = doc.phoneE164 ?? ""
  const email = doc.email?.toLowerCase() ?? ""
  return doc.testMode === true ||
    id.startsWith("e2e-") ||
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
