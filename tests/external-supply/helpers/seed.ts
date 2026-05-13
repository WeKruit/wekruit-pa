/**
 * v2.0 External Supply V1 — Wave E — fixture loaders + seeded `pa-users`
 * pre-population helpers. Stand-alone from `firestore-fake.ts` so a future
 * Firestore-emulator-backed test can reuse the same seed inputs.
 */
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import path from "node:path"
import { createHash } from "node:crypto"
import {
  PA_COLLECTIONS,
  candidateHandleHashMaterial,
  createCandidateHandleId,
} from "@pa/core-types"
import type { FakeStore } from "./firestore-fake.js"
import { ensureCol } from "./firestore-fake.js"

const HERE = path.dirname(fileURLToPath(import.meta.url))
const FIXTURES_DIR = path.resolve(HERE, "../../fixtures/external-supply")

// ---------------------------------------------------------------------------
// Fixture row shapes (raw JSON deserialized — narrowed at call site).
// ---------------------------------------------------------------------------

export interface BigBatchRow {
  /** Test-only label, e.g. "linkedin_only_1" — never written to Firestore. */
  testCase: string
  /**
   * Adapter shape we expect to drive this row through. Each adapter pulls a
   * different subset of fields.
   */
  adapter: "juicebox" | "lessie" | "coresignal"
  linkedin_url?: string | null
  email_primary?: string | null
  phone?: string | null
  full_name?: string | null
  current_position?: string | null
  current_company_name?: string | null
  location_string?: string | null
  experience_array?: Array<{
    company?: string
    title?: string
    startDate?: string
    endDate?: string
  }>
  education_array?: Array<{
    school?: string
    degree?: string
    field?: string
    endYear?: number
  }>
  skills?: string[]
}

export interface SeedUserRow {
  candidateId: string
  /** Optional pre-existing canonical LinkedIn URL. */
  linkedinUrl?: string
  /** Optional pre-existing email body (NOT a hash) used to seed an
   * `email__<hash>` handle row. When the same email maps to a different
   * candidateId via a SECOND emailHandle entry, this drives the
   * `linkedin_email_candidate_mismatch` test case. */
  email?: string
  /** Optional extra email handle bindings for the mismatch path. */
  extraEmailHandles?: Array<{ email: string; candidateId: string }>
  /** Strong-evidence global tags — used to assert the no-overwrite guarantee. */
  strongGlobalTags?: {
    skills?: Array<{
      name: string
      bucket: string
      proficiency: string
      evidenceCount: number
      baseWeight: number
    }>
    relevantTags?: string[]
  }
  /** Outreach state — drives suppression-gate test cases. */
  outreach?: {
    status?: "allowed" | "cooldown" | "paused" | "opted_out"
    cooldownUntil?: string
    lastOutboundAt?: string
  }
  /** Optional `email_bounced` outreach event to plant in `pa-outreach-events`
   * so the suppression gate sees it. */
  plantBounceEvent?: {
    occurredAt: string
    companyId: string
    jobId: string
    planId: string
  }
}

export interface CompanyJobFixture {
  company: {
    companyId: string
    name: string
    industrySector: string[]
    competitorCompanies: string[]
    size?: string
  }
  job: {
    jobId: string
    title: string
    roleFunction: string[]
    requiredSkills: string[]
    seniorityLevel: string
    locationBuckets: string[]
    sponsorship: boolean | null
    jobType: string
    industrySector: string[]
    firstSeenAt: string
    salaryMin?: number
    salaryMax?: number
  }
}

// ---------------------------------------------------------------------------
// Fixture loaders
// ---------------------------------------------------------------------------

export function loadBigBatchFixture(): BigBatchRow[] {
  const raw = readFileSync(path.join(FIXTURES_DIR, "big-batch.json"), "utf8")
  return JSON.parse(raw) as BigBatchRow[]
}

export function loadSeedUsersFixture(): SeedUserRow[] {
  const raw = readFileSync(path.join(FIXTURES_DIR, "seed-pa-users.json"), "utf8")
  return JSON.parse(raw) as SeedUserRow[]
}

export function loadCompanyJobFixture(): CompanyJobFixture {
  const raw = readFileSync(path.join(FIXTURES_DIR, "company-job.json"), "utf8")
  return JSON.parse(raw) as CompanyJobFixture
}

// ---------------------------------------------------------------------------
// Hash helpers (matches the production hash material exactly)
// ---------------------------------------------------------------------------

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex")
}

/**
 * Canonicalize a raw LinkedIn URL the way the production `canonicalizeLinkedInUrl`
 * does. Mirrors the slug-stripping logic from `packages/external-supply/src/normalize.ts`
 * — keep in sync if that ever changes.
 */
export function canonicalizeLinkedInUrlForSeed(raw: string): string {
  let url = raw.trim()
  if (/^\/\//.test(url)) url = `https:${url}`
  else if (!/^https?:\/\//i.test(url)) url = `https://${url}`
  const parsed = new URL(url)
  let pathPart = parsed.pathname
  const localeMatch = /^\/[a-z]{2,3}\/in\//i.exec(pathPart)
  if (localeMatch) {
    pathPart = pathPart.slice(localeMatch[0].length - "/in/".length)
  }
  const m = /^\/in\/([A-Za-z0-9\-_%]+)\/?$/.exec(pathPart)
  if (!m) throw new Error(`canonicalizeLinkedInUrlForSeed:invalid:${raw}`)
  return `https://linkedin.com/in/${m[1]!.toLowerCase()}`
}

export function linkedinHashForSeed(canonical: string): string {
  return sha256Hex(candidateHandleHashMaterial("linkedin", canonical))
}

export function emailHashForSeed(rawEmail: string): string {
  return sha256Hex(candidateHandleHashMaterial("email", rawEmail.trim().toLowerCase()))
}

// ---------------------------------------------------------------------------
// Seeders
// ---------------------------------------------------------------------------

const NOW = "2026-05-13T12:00:00.000Z"

export function seedUsersFromFixture(store: FakeStore, seeds: SeedUserRow[]): void {
  const users = ensureCol(store, PA_COLLECTIONS.users)
  const handles = ensureCol(store, PA_COLLECTIONS.candidateHandles)
  const events = ensureCol(store, PA_COLLECTIONS.outreachEvents)

  for (const seed of seeds) {
    const profileDoc: Record<string, unknown> = {
      id: seed.candidateId,
      candidateLifecycleState: "profile_ready",
      createdAt: NOW,
      updatedAt: NOW,
      lifecycleUpdatedAt: NOW,
    }
    if (seed.linkedinUrl) {
      profileDoc.linkedinUrl = seed.linkedinUrl
    }
    if (seed.outreach) {
      profileDoc.outreach = {
        status: seed.outreach.status ?? "allowed",
        ...(seed.outreach.cooldownUntil ? { cooldownUntil: seed.outreach.cooldownUntil } : {}),
        ...(seed.outreach.lastOutboundAt ? { lastOutboundAt: seed.outreach.lastOutboundAt } : {}),
      }
    }
    if (seed.strongGlobalTags) {
      // Use canonical vocab tokens so the strict schema accepts them.
      profileDoc.globalTags = {
        roleFunction: ["software_engineering"],
        skills: seed.strongGlobalTags.skills ?? [],
        industrySector: ["artificial_intelligence_and_machine_learning"],
        targetLocations: ["new_york_metro", "remote_united_states"],
        targetJobType: ["full_time"],
        relevantTags: seed.strongGlobalTags.relevantTags ?? [],
        companySizePreference: [],
        careerStage: "senior",
        yoeRange: [6, 8],
        visaStatus: "citizen",
        updatedAt: NOW,
      }
    }
    users.set(seed.candidateId, profileDoc)

    if (seed.linkedinUrl) {
      const canonical = canonicalizeLinkedInUrlForSeed(seed.linkedinUrl)
      const linkedinHash = linkedinHashForSeed(canonical)
      const handleId = createCandidateHandleId("linkedin", linkedinHash)
      handles.set(handleId, {
        handleId,
        candidateId: seed.candidateId,
        kind: "linkedin",
        handleHash: linkedinHash,
        normalizedValue: canonical,
        source: "external_sourcing",
        verifiedAt: null,
        deliverable: false,
        createdAt: NOW,
      })
    }
    if (seed.email) {
      const emailHash = emailHashForSeed(seed.email)
      const handleId = createCandidateHandleId("email", emailHash)
      handles.set(handleId, {
        handleId,
        candidateId: seed.candidateId,
        kind: "email",
        handleHash: emailHash,
        normalizedValue: seed.email.toLowerCase(),
        source: "candidate",
        verifiedAt: null,
        deliverable: true,
        createdAt: NOW,
      })
    }
    for (const extra of seed.extraEmailHandles ?? []) {
      const eh = emailHashForSeed(extra.email)
      const handleId = createCandidateHandleId("email", eh)
      handles.set(handleId, {
        handleId,
        candidateId: extra.candidateId,
        kind: "email",
        handleHash: eh,
        normalizedValue: extra.email.toLowerCase(),
        source: "candidate",
        verifiedAt: null,
        deliverable: true,
        createdAt: NOW,
      })
    }

    if (seed.plantBounceEvent) {
      const evId = `instantly__bounce_${seed.candidateId}`
      events.set(evId, {
        eventId: evId,
        provider: "instantly",
        providerEventId: `bounce_${seed.candidateId}`,
        candidateId: seed.candidateId,
        planId: seed.plantBounceEvent.planId,
        jobId: seed.plantBounceEvent.jobId,
        companyId: seed.plantBounceEvent.companyId,
        kind: "email_bounced",
        payloadRedacted: { reason: "fixture_seeded" },
        occurredAt: seed.plantBounceEvent.occurredAt,
        recordedAt: seed.plantBounceEvent.occurredAt,
      })
    }
  }
}

export function seedCompanyJobFixture(
  store: FakeStore,
  fixture: CompanyJobFixture,
): void {
  ensureCol(store, "pa-companies").set(fixture.company.companyId, {
    ...fixture.company,
  })
  ensureCol(store, "pa-jobs").set(fixture.job.jobId, {
    ...fixture.job,
  })
}

// ---------------------------------------------------------------------------
// Per-adapter pre-serialization
// ---------------------------------------------------------------------------

/**
 * Group big-batch rows by adapter and serialize each group to the on-the-wire
 * format the matching adapter expects. Returns one entry per adapter that
 * actually carries rows so the test can drive `runCreateBatch` 1..3 times.
 */
export function rowsByAdapter(rows: BigBatchRow[]): Array<{
  adapter: "juicebox" | "lessie" | "coresignal"
  /** The rows we kept for this adapter (same shape as inputs). */
  rows: BigBatchRow[]
  /** Already-serialized payload appropriate for that adapter. */
  serialized: string
  /** Hex-sha256 of the serialized payload — sourced into `rawFileRef.sha256`. */
  sha256: string
  /** Best-effort MIME for the rawFileRef. */
  mime: string
}> {
  const groups: Record<"juicebox" | "lessie" | "coresignal", BigBatchRow[]> = {
    juicebox: [],
    lessie: [],
    coresignal: [],
  }
  for (const row of rows) {
    groups[row.adapter].push(row)
  }
  const out: Array<{
    adapter: "juicebox" | "lessie" | "coresignal"
    rows: BigBatchRow[]
    serialized: string
    sha256: string
    mime: string
  }> = []
  for (const adapter of ["juicebox", "lessie", "coresignal"] as const) {
    const groupRows = groups[adapter]
    if (groupRows.length === 0) continue
    const serialized = serializeForAdapter(adapter, groupRows)
    out.push({
      adapter,
      rows: groupRows,
      serialized,
      sha256: sha256Hex(serialized),
      mime: adapter === "lessie" ? "text/csv" : "application/json",
    })
  }
  return out
}

function serializeForAdapter(
  adapter: "juicebox" | "lessie" | "coresignal",
  rows: BigBatchRow[],
): string {
  switch (adapter) {
    case "juicebox":
      return JSON.stringify(
        rows.map((r) => ({
          linkedin_url: r.linkedin_url ?? null,
          email_primary: r.email_primary ?? null,
          phone: r.phone ?? null,
          full_name: r.full_name ?? null,
          current_position: r.current_position ?? null,
          current_company_name: r.current_company_name ?? null,
          location_string: r.location_string ?? null,
          experience_array: r.experience_array ?? [],
          education_array: r.education_array ?? [],
          skills: r.skills ?? [],
        })),
      )
    case "lessie": {
      const header = [
        "LinkedIn URL",
        "Email",
        "Name",
        "Title",
        "Company",
        "Location",
        "Phone",
        "Skills",
      ]
      const lines: string[] = [header.join(",")]
      for (const r of rows) {
        const cells = [
          r.linkedin_url ?? "",
          r.email_primary ?? "",
          r.full_name ?? "",
          r.current_position ?? "",
          r.current_company_name ?? "",
          r.location_string ?? "",
          r.phone ?? "",
          (r.skills ?? []).join("; "),
        ]
        lines.push(cells.map(csvCell).join(","))
      }
      return lines.join("\n")
    }
    case "coresignal":
      return JSON.stringify(
        rows.map((r) => ({
          profile: {
            url: r.linkedin_url ?? null,
            full_name: r.full_name ?? null,
            headline: r.current_position ?? null,
            location: { name: r.location_string ?? null },
          },
          contact: {
            primary_email: r.email_primary ?? null,
            phone: r.phone ?? null,
          },
          experience: (r.experience_array ?? []).map((e) => ({
            company_name: e.company ?? null,
            title: e.title ?? null,
            date_from: e.startDate ?? null,
            date_to: e.endDate ?? null,
          })),
          education: (r.education_array ?? []).map((ed) => ({
            school: ed.school ?? null,
            degree: ed.degree ?? null,
            field_of_study: ed.field ?? null,
            date_to: ed.endYear ? String(ed.endYear) : null,
          })),
          skills: r.skills ?? [],
        })),
      )
  }
}

function csvCell(value: string): string {
  if (/[,"\n\r]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`
  }
  return value
}
