import type { Candidate } from "./sourcing-demo-data.js"
import { scoreCandidate } from "./sourcing-demo-score.js"

export type Refinement = {
  companyGroup: "property" | "commercial"
  selectedCompanies: string[]
  industry: "required" | "preferred" | "open"
  minYears: number
}

export function matchingCompanies(candidate: Candidate, selectedCompanies: string[]) {
  return selectedCompanies.filter((name) => candidate.employment.some((role) => role.company.toLowerCase() === name.toLowerCase()))
}

export function refinedCandidates(candidates: Candidate[], refinement: Refinement) {
  // ponytail: Exact employer names and sample industry years drive this demo; a connected search needs sourced aliases and dated employment evidence.
  if (!refinement.selectedCompanies.length) return []
  return candidates.filter((candidate) =>
    matchingCompanies(candidate, refinement.selectedCompanies).length > 0 &&
    (refinement.industry !== "required" || candidate.industryYears >= refinement.minYears),
  ).sort((a, b) =>
    matchingCompanies(b, refinement.selectedCompanies).length - matchingCompanies(a, refinement.selectedCompanies).length ||
    (refinement.industry === "open" ? 0 : b.industryYears - a.industryYears) ||
    scoreCandidate(b) - scoreCandidate(a),
  )
}
