import { collection, getDocs, limit, query, where, type DocumentData } from "firebase/firestore"
import { db } from "./firebase.js"

export interface PublicCompanyProfile {
  tagline?: string
  about?: string
  websiteUrl?: string
  hqLocation?: string
  teamSize?: string
  foundedYear?: string
  industryLabels?: string[]
  funding?: {
    totalRaised?: string
    stage?: string
  }
  founders?: Array<{
    name: string
    title?: string
    linkedinUrl?: string
  }>
}

export interface PublicJobOpening {
  id: string
  title: string
  company: string
  companyId?: string
  location?: string
  salaryRange?: string
  description?: string
  descriptionMd?: string
  roleFunction: string[]
  industrySector: string[]
  requiredSkills: string[]
  seniorityLevel?: string
  jobType?: string
  collaborated: boolean
  companyProfile?: PublicCompanyProfile
}

interface RawPublicJob {
  publicVisible?: boolean
  dead?: boolean
  title?: string
  jobTitle?: string
  company?: string
  companyId?: string
  companyName?: string
  location?: string
  salaryRange?: string
  descriptionMd?: string
  roleFunction?: unknown
  industrySector?: unknown
  requiredSkills?: unknown
  seniorityLevel?: string
  jobType?: string
  wekruitCollaborationStatus?: "collaborated" | "not_collaborated"
  companyProfile?: PublicCompanyProfile
  prescreenConfig?: {
    jobTitle?: string
    company?: string
    level1Reveal?: {
      salaryRange?: string
    }
  }
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
}

function cleanMarkdownLine(value: string): string {
  return value
    .replace(/^#+\s*/, "")
    .replace(/\*\*/g, "")
    .replace(/[_`]/g, "")
    .trim()
}

function summaryLine(value: string | undefined, title: string, company: string): string | undefined {
  const titleLower = title.toLowerCase()
  const companyLower = company.toLowerCase()
  return value
    ?.split("\n")
    .map((line) => cleanMarkdownLine(line))
    .find((line) => {
      if (!line) return false
      const lower = line.toLowerCase()
      return !(lower.includes(titleLower) && lower.includes(companyLower))
    })
}

function isSourceHeading(value: string): boolean {
  const normalized = value
    .replace(/^#{1,6}\s+/, "")
    .replace(/^\*\*/, "")
    .replace(/\*\*$/, "")
    .trim()
    .toLowerCase()
  return normalized === "source" || normalized === "job source" || normalized === "original source"
}

function isHeading(value: string): boolean {
  return /^#{1,6}\s+\S/.test(value) || /^\*\*[^*]+\*\*$/.test(value)
}

function isStandaloneSourceUrl(value: string): boolean {
  const trimmed = value.trim()
  if (/^https?:\/\/\S+$/i.test(trimmed)) return true
  if (/^\[[^\]]+\]\(https?:\/\/[^)]+\)$/i.test(trimmed)) return true
  return false
}

export function stripJobSourceSection(markdown?: string): string | undefined {
  const raw = markdown?.trim()
  if (!raw) return raw
  const lines = raw.split(/\r?\n/)
  const kept: string[] = []
  let skippingSource = false

  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed && isSourceHeading(trimmed)) {
      skippingSource = true
      continue
    }
    if (skippingSource) {
      if (trimmed && isHeading(trimmed)) {
        skippingSource = false
      } else {
        continue
      }
    }
    if (isStandaloneSourceUrl(trimmed)) continue
    kept.push(line)
  }

  return kept.join("\n").trim()
}

export function toPublicJobOpening(id: string, data: DocumentData): PublicJobOpening | null {
  const raw = data as RawPublicJob
  if (raw.publicVisible !== true || raw.dead === true) return null
  const title = raw.title ?? raw.jobTitle ?? raw.prescreenConfig?.jobTitle ?? "Open role"
  const company = raw.companyName ?? raw.company ?? raw.prescreenConfig?.company ?? "Confidential employer"
  const salaryRange = raw.salaryRange ?? raw.prescreenConfig?.level1Reveal?.salaryRange
  const collaborated = raw.wekruitCollaborationStatus === "collaborated"
  const descriptionMd = collaborated ? stripJobSourceSection(raw.descriptionMd) : raw.descriptionMd
  return {
    id,
    title,
    company,
    companyId: raw.companyId,
    location: raw.location,
    salaryRange,
    description: summaryLine(descriptionMd, title, company),
    descriptionMd,
    roleFunction: stringArray(raw.roleFunction),
    industrySector: stringArray(raw.industrySector),
    requiredSkills: stringArray(raw.requiredSkills),
    seniorityLevel: raw.seniorityLevel,
    jobType: raw.jobType,
    collaborated,
    companyProfile: raw.companyProfile,
  }
}

export async function listPublicJobOpenings(maxJobs = 24): Promise<PublicJobOpening[]> {
  const publicJobsQuery = query(
    collection(db(), "pa-jobs"),
    where("publicVisible", "==", true),
    limit(maxJobs)
  )
  const snap = await getDocs(publicJobsQuery)
  return snap.docs
    .map((docSnap) => toPublicJobOpening(docSnap.id, docSnap.data()))
    .filter((job): job is PublicJobOpening => job !== null)
    .sort((a, b) => a.company.localeCompare(b.company) || a.title.localeCompare(b.title))
}

export async function listPublicJobOpeningsByCompany(
  companyId: string,
  maxJobs = 24,
): Promise<PublicJobOpening[]> {
  const trimmedCompanyId = companyId.trim()
  if (!trimmedCompanyId) return []
  const companyJobsQuery = query(
    collection(db(), "pa-jobs"),
    where("publicVisible", "==", true),
    where("companyId", "==", trimmedCompanyId),
    limit(maxJobs),
  )
  const snap = await getDocs(companyJobsQuery)
  return snap.docs
    .map((docSnap) => toPublicJobOpening(docSnap.id, docSnap.data()))
    .filter((job): job is PublicJobOpening => job !== null)
    .sort((a, b) => a.title.localeCompare(b.title))
}
