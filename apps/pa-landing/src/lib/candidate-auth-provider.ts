import type { User } from "firebase/auth"

export type CandidateAuthProvider = "google" | "linkedin" | "email" | "other"

/** LinkedIn custom-token users use deterministic `li_*` Firebase uids. */
export function isLinkedInFirebaseUid(uid: string): boolean {
  return uid.startsWith("li_")
}

export function detectCandidateAuthProvider(user: User): CandidateAuthProvider {
  const providers = user.providerData.map((p) => p.providerId)
  if (providers.some((id) => id === "google.com")) return "google"
  if (isLinkedInFirebaseUid(user.uid)) return "linkedin"
  if (providers.some((id) => id.includes("linkedin"))) return "linkedin"
  if (providers.some((id) => id === "password" || id === "emailLink")) return "email"
  if (user.email && !providers.length) return "email"
  return "other"
}

export function isLinkedInSignIn(user: User): boolean {
  return detectCandidateAuthProvider(user) === "linkedin"
}
