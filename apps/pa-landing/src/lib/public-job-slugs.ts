const LEGACY_PUBLIC_JOB_IDS: Record<string, string> = {
  "standout-37429d02-photon-macos-devops": "wekruit-37429d02-photon-macos-devops",
  "standout-973f2953-photon-objective-c-engineer": "wekruit-973f2953-photon-objective-c-engineer",
}

export function canonicalPublicJobId(jobId: string): string {
  return LEGACY_PUBLIC_JOB_IDS[jobId] ?? jobId
}

export function canonicalizePublicJobPath(pathname: string): string {
  const match = pathname.match(/^\/j\/([^/]+)(\/cv)?$/)
  if (!match) return pathname
  const canonicalJobId = canonicalPublicJobId(match[1]!)
  return `/j/${canonicalJobId}${match[2] ?? ""}`
}
