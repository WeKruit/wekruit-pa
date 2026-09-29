export type ScoreAxis = "overall" | "experience" | "skills" | "location" | "compensation"

export type DemoCandidate = {
  id: string
  name: string
  role: string
  company: string
  location: string
  experience: number
  skills: number
  locationFit: number
  compensationFit: number
}

export function scoreCandidate(candidate: DemoCandidate): number {
  // ponytail: fixed demo weights keep ranking explainable; replace with the canonical match service when data is connected.
  return Math.round(
    candidate.experience * 0.45 +
    candidate.skills * 0.3 +
    candidate.locationFit * 0.15 +
    candidate.compensationFit * 0.1,
  )
}

export function rankCandidates<T extends DemoCandidate>(candidates: T[], axis: ScoreAxis): T[] {
  const value = (candidate: T) => {
    if (axis === "overall") return scoreCandidate(candidate)
    if (axis === "location") return candidate.locationFit
    if (axis === "compensation") return candidate.compensationFit
    return candidate[axis]
  }
  return [...candidates].sort((a, b) => value(b) - value(a) || a.name.localeCompare(b.name))
}
