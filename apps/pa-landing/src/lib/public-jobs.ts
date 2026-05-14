import { collection, getDocs, limit, query, where, type DocumentData } from "firebase/firestore"
import { db } from "./firebase.js"

export interface PublicJobOpening {
  id: string
  title: string
  company: string
  location?: string
  salaryRange?: string
  description?: string
  roleFunction: string[]
  industrySector: string[]
  requiredSkills: string[]
  seniorityLevel?: string
  jobType?: string
}

interface RawPublicJob {
  publicVisible?: boolean
  dead?: boolean
  jobTitle?: string
  company?: string
  location?: string
  salaryRange?: string
  descriptionMd?: string
  roleFunction?: unknown
  industrySector?: unknown
  requiredSkills?: unknown
  seniorityLevel?: string
  jobType?: string
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

export function toPublicJobOpening(id: string, data: DocumentData): PublicJobOpening | null {
  const raw = data as RawPublicJob
  if (raw.publicVisible !== true || raw.dead === true) return null
  const title = raw.jobTitle ?? raw.prescreenConfig?.jobTitle ?? "Open role"
  const company = raw.company ?? raw.prescreenConfig?.company ?? "Confidential employer"
  const salaryRange = raw.salaryRange ?? raw.prescreenConfig?.level1Reveal?.salaryRange
  return {
    id,
    title,
    company,
    location: raw.location,
    salaryRange,
    description: summaryLine(raw.descriptionMd, title, company),
    roleFunction: stringArray(raw.roleFunction),
    industrySector: stringArray(raw.industrySector),
    requiredSkills: stringArray(raw.requiredSkills),
    seniorityLevel: raw.seniorityLevel,
    jobType: raw.jobType,
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
