const PUBLIC_JOB_TYPE_LABELS: Record<string, string> = {
  full_time: "Full-time",
  part_time: "Part-time",
  contract: "Contract",
  temporary: "Temporary",
  internship: "Internship",
  freelance: "Freelance",
}

export function formatPublicJobType(value?: string): string | undefined {
  const normalized = value?.trim().toLowerCase()
  if (!normalized) return undefined
  const key = normalized.replace(/[\s-]+/g, "_").replace(/_+/g, "_")
  const known = PUBLIC_JOB_TYPE_LABELS[key]
  if (known) return known

  const parts = key.split("_").filter(Boolean)
  if (!parts.length) return undefined
  return parts
    .map((part, idx) => (idx === 0 ? `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}` : part))
    .join(" ")
}
