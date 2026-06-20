import { collection, getDocs, limit, query, where, type DocumentData } from "firebase/firestore"
import { db } from "./firebase.js"
import { formatPublicJobType } from "./public-job-labels.js"
import { stripJobSourceSection, stripVisaLines } from "./public-job-description.js"

export { stripJobSourceSection, stripVisaLines } from "./public-job-description.js"

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
    jobType?: string
    level1Reveal?: {
      salaryRange?: string
    }
  }
}

/**
 * Shared raw snapshot of publicly visible pa-jobs (one 48-doc Firestore read).
 *
 * Landing's hero carousel and Market's "Direct line" tab issue the exact same
 * `publicVisible == true, limit 48` query but map the docs to different view
 * shapes. Caching the RAW rows under one TanStack Query key lets both surfaces
 * share a single read per 6h window (each applies its own `select`), instead
 * of burning a 48-doc read on every homepage visit plus another on /market.
 */
export interface PublicPaJobsRawRow {
  id: string
  data: DocumentData
}

export const PUBLIC_PA_JOBS_RAW_LIMIT = 48
export const PUBLIC_PA_JOBS_RAW_QUERY_KEY = ["pa-jobs-hero", PUBLIC_PA_JOBS_RAW_LIMIT] as const

export async function fetchPublicPaJobsRaw(
  maxJobs: number = PUBLIC_PA_JOBS_RAW_LIMIT,
): Promise<PublicPaJobsRawRow[]> {
  const snap = await getDocs(
    query(collection(db(), "pa-jobs"), where("publicVisible", "==", true), limit(maxJobs)),
  )
  return snap.docs.map((docSnap) => ({ id: docSnap.id, data: docSnap.data() }))
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

export function toPublicJobOpening(id: string, data: DocumentData): PublicJobOpening | null {
  const raw = data as RawPublicJob
  if (raw.publicVisible !== true || raw.dead === true) return null
  const title = raw.title ?? raw.jobTitle ?? raw.prescreenConfig?.jobTitle ?? "Open role"
  const company = raw.companyName ?? raw.company ?? raw.prescreenConfig?.company ?? "Confidential employer"
  const salaryRange = raw.salaryRange ?? raw.prescreenConfig?.level1Reveal?.salaryRange
  const collaborated = raw.wekruitCollaborationStatus === "collaborated"
  const descriptionMd = stripVisaLines(
    collaborated ? stripJobSourceSection(raw.descriptionMd) : raw.descriptionMd,
  )
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
    jobType: formatPublicJobType(raw.jobType ?? raw.prescreenConfig?.jobType),
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
