export type CandidateProofPromptItem = {
  id: string
  label: "Hard requirement"
  detail: string
  prompt: string
}

export function buildCandidateProofPromptItems(input: {
  missingHard: string[]
  maxItems?: number
}): CandidateProofPromptItem[] {
  const maxItems = input.maxItems ?? 4
  const limit = Number.isFinite(maxItems) ? Math.max(0, Math.floor(maxItems)) : 4
  const seen = new Set<string>()

  return input.missingHard
    .map((item) => item.trim())
    .filter((item) => {
      if (!item) return false
      const key = item.toLowerCase()
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    .slice(0, limit)
    .map((detail, index) => ({
      id: `hard-${index}-${slugify(detail)}`,
      label: "Hard requirement",
      detail,
      prompt: `Proof for "${detail}": `,
    }))
}

function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
  return slug || "proof"
}
