import { PA_COLLECTIONS, normalizeCompanyName } from "@pa/core-types"
import { doc, getDoc, increment, setDoc } from "firebase/firestore"

import { db } from "./firebase.js"
import { suggestCompanyId, suggestJobId } from "./job-admin-ids.js"

function cleanOptional(value: string | null | undefined): string | undefined {
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  return trimmed ? trimmed : undefined
}

export interface CreateCompanyInput {
  companyId?: string
  displayName: string
  domain?: string
  websiteUrl?: string
  careersUrl?: string
  description?: string
  operatorEmail?: string
}

export interface CreateJobInput {
  jobId?: string
  companyId: string
  companyName?: string
  title: string
  department?: string
  rawLocation?: string
  atsApplyUrl?: string
  descriptionMd?: string
}

export async function createCompany(input: CreateCompanyInput): Promise<{ companyId: string }> {
  const displayName = cleanOptional(input.displayName)
  if (!displayName) throw new Error("displayName is required")

  const companyId = normalizeCompanyName(cleanOptional(input.companyId) ?? suggestCompanyId(displayName))
  if (!companyId) throw new Error("companyId is required")

  const companyRef = doc(db(), PA_COLLECTIONS.companies, companyId)
  const existing = await getDoc(companyRef)
  if (existing.exists()) {
    throw new Error(`Company "${companyId}" already exists.`)
  }

  const now = new Date().toISOString()
  const websiteUrl = cleanOptional(input.websiteUrl)
  const careersUrl = cleanOptional(input.careersUrl)
  const description = cleanOptional(input.description)
  await setDoc(companyRef, {
    id: companyId,
    name: displayName,
    displayName,
    normalizedName: companyId,
    domain: cleanOptional(input.domain) ?? null,
    ...(websiteUrl ? { websiteUrl } : {}),
    ...(careersUrl ? { careersUrl } : {}),
    ...(description ? { description } : {}),
    companyStage: "unknown",
    companyTags: [],
    enrichmentSource: "manual",
    enrichedAt: now,
    lastReviewedBy: cleanOptional(input.operatorEmail) ?? null,
    wekruitCollab: false,
    jobsCount: 0,
    jobsCountUpdatedAt: now,
    createdAt: now,
    updatedAt: now,
  })

  return { companyId }
}

export async function createJob(input: CreateJobInput): Promise<{ companyId: string; jobId: string }> {
  const companyId = normalizeCompanyName(input.companyId)
  if (!companyId) throw new Error("companyId is required")

  const title = cleanOptional(input.title)
  if (!title) throw new Error("title is required")

  const companyRef = doc(db(), PA_COLLECTIONS.companies, companyId)
  const companySnap = await getDoc(companyRef)
  if (!companySnap.exists()) {
    throw new Error(`Company "${companyId}" not found. Create the company first.`)
  }

  const companyData = companySnap.data() as { displayName?: string; name?: string }
  const companyName =
    cleanOptional(input.companyName) ??
    cleanOptional(companyData.displayName) ??
    cleanOptional(companyData.name) ??
    companyId

  const requestedJobId = cleanOptional(input.jobId) ?? suggestJobId(companyId, title)
  const jobId = normalizeCompanyName(requestedJobId)
  if (!jobId) throw new Error("jobId is required")

  const jobRef = doc(db(), PA_COLLECTIONS.jobs, jobId)
  const existing = await getDoc(jobRef)
  if (existing.exists()) {
    throw new Error(`Job "${jobId}" already exists.`)
  }

  const now = new Date().toISOString()
  const department = cleanOptional(input.department)
  const rawLocation = cleanOptional(input.rawLocation)
  const atsApplyUrl = cleanOptional(input.atsApplyUrl)
  const descriptionMd = cleanOptional(input.descriptionMd)
  await setDoc(jobRef, {
    jobId,
    companyId,
    company: companyName,
    title,
    ...(department ? { department } : {}),
    ...(rawLocation ? { rawLocation } : {}),
    ...(atsApplyUrl ? { atsApplyUrl } : {}),
    ...(descriptionMd ? { descriptionMd } : {}),
    status: "open",
    source: "manual_dashboard",
    firstSeenAt: now,
    updatedAt: now,
    publicVisible: false,
    wekruitCollaborationStatus: "not_collaborated",
    candidatePageStatus: "draft",
    dead: false,
  })

  await setDoc(
    companyRef,
    {
      jobsCount: increment(1),
      jobsCountUpdatedAt: now,
      updatedAt: now,
    },
    { merge: true },
  )

  return { companyId, jobId }
}
