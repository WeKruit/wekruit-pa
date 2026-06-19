// v2.0 marketplace candidate browser.
// Reads pa-users (the global candidate pool) joined to
// pa-candidate-source-links so each row shows where the candidate came from
// (juicebox / lessie / coresignal / manual_csv / imessage / public_job /
// ats / unknown). Renders v2 lifecycle state + global tags + profile
// completeness — replaces the legacy Users.tsx "Conversations" surface as
// the primary candidate management view.
//
// Future management hooks (link-outs already wired):
//  - CandidateProfile detail page (/admin/candidates/:id/profile)
//  - Identity Conflicts queue (/admin/identity-conflicts)
//  - Tag snapshots (/admin/users/:uid/tag-snapshots)
//  - Match debug (/admin/match-debug?candidateId=…)
//  - External-supply audit doc (drawer)
//
// Lifecycle mutations (opt-out / delete) are intentionally deferred until
// the deterministic-reducer CFs land. Per v2 product lock #9 "HITL
// corrections must become flywheel data" — admin UI can't mutate state
// directly without writing audit events server-side.

import { PA_COLLECTIONS } from "@pa/core-types"
import { collection, doc as firestoreDoc, getDoc, getDocs, limit, orderBy, query, where } from "firebase/firestore"
import { useEffect, useMemo, useState } from "react"
import { Link, useNavigate } from "react-router-dom"
import { AdminPrescreenSessionLink } from "../components/AdminEntityLink.js"
import { db } from "../lib/firebase.js"
import { getCandidatePoolCounts, type CandidatePoolCounts } from "../lib/candidate-pool-counts-api.js"
import { Icon } from "../components/console/Icon.js"
import {
  Card,
  DataTable,
  type DataTableSort,
  EmptyState,
  MetricStrip,
  PageHeader,
  PulseDot,
  SectionHead,
  StatusPill,
} from "../components/console/primitives.js"
import {
  classifyCandidateProfile,
  deriveCandidateSource,
  candidateDrawerExternalHref,
  candidateDrawerPreviewMax,
  candidateDrawerRegionCount,
  firstCandidateDrawerText,
  candidateDrawerVisibleCount,
  isValidE164Phone,
  matchesPhoneSearch,
  normalizeCandidatePhoneLookup,
  phoneSearchDigits,
  previewCandidateDrawerText,
  sortCandidateDrawerRows,
  type CandidateClass,
  type ExternalSource,
  type SourceKind,
} from "./Candidates.helpers.js"

type Tone = "live" | "hitl" | "blocked" | "info" | "neutral"

type LifecycleState =
  | "prospect"
  | "profile_created"
  | "reachable"
  | "claimed"
  | "profile_ready"
  | "active_job_seeker"
  | "retained"
  | "opted_out"
  | "deleted"

type IdentityFilter = "registered" | "phone_ready" | "phone_bound" | "sendblue_eligible"

const LIFECYCLE_TONE: Record<LifecycleState, Tone> = {
  prospect: "neutral",
  profile_created: "info",
  reachable: "info",
  claimed: "live",
  profile_ready: "live",
  active_job_seeker: "live",
  retained: "info",
  opted_out: "hitl",
  deleted: "blocked",
}

const LIFECYCLE_LABEL: Record<LifecycleState, string> = {
  prospect: "Prospect",
  profile_created: "Profile created",
  reachable: "Reachable",
  claimed: "Claimed",
  profile_ready: "Profile ready",
  active_job_seeker: "Active",
  retained: "Retained",
  opted_out: "Opted out",
  deleted: "Deleted",
}

// Tooltips explaining the predicate behind each state chip. The "Claimed"
// label is a known misnomer (lastClaimedAt is empty across the corpus —
// see chip-redesign tracking in INITIATIVE-recruiter-board.md follow-ups).
const LIFECYCLE_TOOLTIP: Record<LifecycleState, string> = {
  prospect: "No reachable handle yet (no email + no phone). Identity row only.",
  profile_created: "pa-users doc exists with at least one handle but not Firebase-claimed yet (onboardingStatus = provisional).",
  reachable: "Has email or phone but candidateLifecycleState was never stamped. Heuristic fallback.",
  claimed: "candidateLifecycleState = claimed OR onboardingStatus = active. Note: lastClaimedAt is not currently populated.",
  profile_ready: "Resume parsed, core tags present, reachable handle exists.",
  active_job_seeker: "Explicitly or behaviorally signals open to opportunities.",
  retained: "Not actively searching, allows future outreach.",
  opted_out: "Stop / no-outreach / delete signal received. No outbound allowed.",
  deleted: "Hard-delete requested + fulfilled. Terminal.",
}

const IDENTITY_TOOLTIP: Record<string, string> = {
  registered: "Has a pa-candidate-auth mapping (Firebase Auth account claimed via magic link or OAuth).",
  phone_ready: "Doc has a valid E.164 phone number on the root field (no handle binding required).",
  phone_bound: "Doc has a pa-candidate-handles entry of kind=phone (link confirmed by candidate).",
  sendblue_eligible: "candidate_account class + registered + phone_ready (the three preconditions for Sendblue outbound).",
}

const SOURCE_TOOLTIP: Record<string, string> = {
  imessage: "Inbound from Sendblue / Apple iMessage transport.",
  public_job: "Hit candidate.wekruit.com/j/:jobId (public job page).",
  layoff: "Layoff host (layoff.wekruit.com) WeKruit Open intake.",
  layoffhedge: "LayoffHedge partner referral.",
  ats: "ATS inbound webhook (Handshake / Greenhouse etc).",
  bulk_resume: "Employer bulk resume upload.",
  juicebox: "Juicebox external-supply import.",
  lessie: "Lessie external-supply import.",
  coresignal: "Coresignal LinkedIn-centered external-supply import.",
  manual_csv: "Manual CSV / inspection script.",
  synthetic_test: "Demo / synthetic / internal test profile.",
  unknown: "No pa-candidate-source-links entry resolved — provenance unknown.",
}

const LIFECYCLE_ORDER: LifecycleState[] = [
  "prospect",
  "profile_created",
  "reachable",
  "claimed",
  "profile_ready",
  "active_job_seeker",
  "retained",
  "opted_out",
  "deleted",
]

const SOURCE_LABEL: Record<SourceKind, string> = {
  juicebox: "Juicebox",
  lessie: "Lessie",
  coresignal: "Coresignal",
  manual_csv: "Manual CSV",
  imessage: "iMessage",
  public_job: "Public job page",
  layoffhedge: "LayoffHedge",
  ats: "ATS inbound",
  bulk_resume: "Bulk resume",
  layoff: "WeKruit Open",
  synthetic_test: "Synthetic test",
  unknown: "Unknown",
}

const SOURCE_ORDER: SourceKind[] = [
  "juicebox",
  "lessie",
  "coresignal",
  "manual_csv",
  "imessage",
  "public_job",
  "layoffhedge",
  "ats",
  "bulk_resume",
  "layoff",
  "synthetic_test",
  "unknown",
]

const IDENTITY_FILTERS: { key: IdentityFilter; label: string; tone: Tone }[] = [
  { key: "registered", label: "Registered", tone: "live" },
  { key: "phone_ready", label: "Phone ready", tone: "live" },
  { key: "phone_bound", label: "Phone-bound", tone: "info" },
  { key: "sendblue_eligible", label: "Sendblue eligible", tone: "hitl" },
]

type UserDoc = {
  id: string
  phoneE164?: string
  email?: string
  displayName?: string
  linkedinUrl?: string
  candidateLifecycleState?: LifecycleState
  profileCompleteness?: number
  globalTags?: {
    skills?: { value?: string }[] | string[]
    industryPreference?: string[]
    rolePreference?: string[]
  }
  outreach?: { status?: "allowed" | "cooldown" | "paused" | "opted_out" }
  piiConsentAt?: string
  latestResumeArtifactId?: string
  mem0UserId?: string
  testMode?: boolean
  isDemo?: boolean
  demoSourcePool?: string
  signupSource?: string
  source?: string
  firstSignupEntry?: {
    kind?: string
    path?: string
    jobId?: string
    source?: string
    capturedAt?: string
  }
  createdAt?: string
  updatedAt?: string
  lifecycleUpdatedAt?: string
  onboardingStatus?: string
}

type SourceLink = {
  candidateId?: string
  source?: ExternalSource
}

type IdentityIndex = {
  registeredIds: Set<string>
  phoneBoundIds: Set<string>
}

type Row = {
  id: string
  doc: UserDoc
  handle: string
  handleKind: "name" | "email" | "linkedin" | "phone" | "uid"
  lifecycle: LifecycleState
  source: SourceKind
  candidateClass: CandidateClass
  profilePct: number
  skills: string[]
  lastActiveIso?: string
  emailMasked?: string
  phoneMasked?: string
  linkedinHandle?: string
  registered: boolean
  phoneReady: boolean
  phoneBound: boolean
  sendblueEligible: boolean
}

type DrawerDetailRow = Record<string, unknown> & { id: string }

type CandidateDrawerDetail = {
  resumes: DrawerDetailRow[]
  resumeArtifacts: DrawerDetailRow[]
  prescreens: DrawerDetailRow[]
  messages: DrawerDetailRow[]
  turns: DrawerDetailRow[]
  jobStates: DrawerDetailRow[]
  jobLabels: Record<string, string>
}

type CandidateDrawerSectionId =
  | "identity"
  | "profile"
  | "resume"
  | "experience"
  | "conversation"
  | "prescreens"
  | "management"

const CANDIDATE_DRAWER_SECTION_IDS: CandidateDrawerSectionId[] = [
  "identity",
  "profile",
  "resume",
  "experience",
  "conversation",
  "prescreens",
  "management",
]

function emptyIdentityIndex(): IdentityIndex {
  return { registeredIds: new Set(), phoneBoundIds: new Set() }
}

function maskEmail(email?: string): string | undefined {
  if (!email) return undefined
  const [local, domain] = email.split("@")
  if (!domain) return email
  const head = (local || "").slice(0, 1) || "?"
  return `${head}****@${domain}`
}

function maskPhone(phone?: string): string | undefined {
  if (!phone) return undefined
  if (phone.length < 8) return phone
  return `${phone.slice(0, 4)}…${phone.slice(-4)}`
}

function linkedinHandleFrom(url?: string): string | undefined {
  if (!url) return undefined
  const m = url.match(/linkedin\.com\/(?:in|pub|company)\/([^/?#]+)/i)
  return m ? m[1] : undefined
}

function shortUid(uid: string): string {
  if (uid.length <= 12) return uid
  return `${uid.slice(0, 8)}…${uid.slice(-4)}`
}

function buildHandle(doc: UserDoc): { handle: string; kind: Row["handleKind"] } {
  if (doc.displayName) return { handle: doc.displayName, kind: "name" }
  if (doc.email) return { handle: maskEmail(doc.email) || doc.email, kind: "email" }
  const li = linkedinHandleFrom(doc.linkedinUrl)
  if (li) return { handle: li, kind: "linkedin" }
  if (doc.phoneE164) return { handle: maskPhone(doc.phoneE164) || doc.phoneE164, kind: "phone" }
  return { handle: shortUid(doc.id), kind: "uid" }
}

function skillsFromTags(tags: UserDoc["globalTags"]): string[] {
  const raw = tags?.skills
  if (!raw || !Array.isArray(raw)) return []
  const out: string[] = []
  for (const item of raw) {
    if (typeof item === "string") {
      if (item) out.push(item)
    } else if (item && typeof item === "object" && "value" in item) {
      const v = (item as { value?: string }).value
      if (typeof v === "string" && v) out.push(v)
    }
    if (out.length >= 3) break
  }
  return out
}

function computeProfilePct(doc: UserDoc): number {
  if (typeof doc.profileCompleteness === "number") {
    const v = doc.profileCompleteness
    if (v > 1) return Math.min(100, Math.max(0, Math.round(v)))
    return Math.round(v * 100)
  }
  // Fallback heuristic when profileCompleteness isn't materialized yet.
  let n = 0
  if (doc.displayName) n += 12
  if (doc.email) n += 14
  if (doc.phoneE164) n += 10
  if (doc.linkedinUrl) n += 14
  if (doc.latestResumeArtifactId) n += 18
  if (doc.piiConsentAt) n += 10
  const skillCount = skillsFromTags(doc.globalTags).length
  n += Math.min(15, skillCount * 5)
  if (doc.mem0UserId) n += 7
  return Math.min(100, n)
}

function deriveLifecycle(doc: UserDoc): LifecycleState {
  if (doc.candidateLifecycleState) return doc.candidateLifecycleState
  if (doc.outreach?.status === "opted_out") return "opted_out"
  if (doc.onboardingStatus === "active") return "claimed"
  if (doc.onboardingStatus === "provisional") return "profile_created"
  if (doc.phoneE164 || doc.email) return "reachable"
  return "prospect"
}

function relTime(iso?: string): string {
  if (!iso) return "—"
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return "—"
  const min = Math.max(0, Math.round((Date.now() - t) / 60_000))
  if (min < 1) return "now"
  if (min < 60) return `${min}m`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h`
  const d = Math.floor(hr / 24)
  if (d < 14) return `${d}d`
  return `${Math.floor(d / 7)}w`
}

function signupEntryLabel(entry?: UserDoc["firstSignupEntry"]): string {
  if (!entry?.kind) return "—"
  if (entry.kind === "job_prescreen") {
    return [entry.path, entry.capturedAt ? `first seen ${relTime(entry.capturedAt)}` : ""]
      .filter(Boolean)
      .join(" · ")
  }
  return [entry.kind, entry.path].filter(Boolean).join(" · ")
}

async function loadUserDocs(): Promise<UserDoc[]> {
  const snap = await getDocs(
    query(collection(db(), PA_COLLECTIONS.users), orderBy("createdAt", "desc"), limit(500))
  )
  return snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<UserDoc, "id">) }))
}

async function loadSourceLinks(): Promise<Map<string, ExternalSource>> {
  const out = new Map<string, ExternalSource>()
  try {
    const snap = await getDocs(
      query(collection(db(), PA_COLLECTIONS.candidateSourceLinks), limit(1000))
    )
    for (const d of snap.docs) {
      const data = d.data() as SourceLink
      if (data.candidateId && data.source && !out.has(data.candidateId)) {
        out.set(data.candidateId, data.source)
      }
    }
  } catch {
    // Collection may be empty / rules-denied in some envs — fall through.
  }
  return out
}

function addCandidateId(set: Set<string>, value: unknown) {
  if (typeof value === "string" && value.trim()) set.add(value.trim())
}

async function loadIdentityIndex(): Promise<IdentityIndex> {
  const out = emptyIdentityIndex()
  const authSnap = await getDocs(query(collection(db(), PA_COLLECTIONS.candidateAuth), limit(2000)))
  for (const d of authSnap.docs) {
    const data = d.data() as { candidateId?: unknown; userId?: unknown; uid?: unknown }
    addCandidateId(out.registeredIds, data.candidateId)
    addCandidateId(out.registeredIds, data.userId)
    addCandidateId(out.registeredIds, data.uid)
  }

  const handleSnap = await getDocs(
    query(collection(db(), PA_COLLECTIONS.candidateHandles), where("kind", "==", "phone"), limit(2000))
  )
  for (const d of handleSnap.docs) {
    const data = d.data() as { candidateId?: unknown; userId?: unknown; uid?: unknown }
    addCandidateId(out.phoneBoundIds, data.candidateId)
    addCandidateId(out.phoneBoundIds, data.userId)
    addCandidateId(out.phoneBoundIds, data.uid)
  }
  return out
}

function candidateClassLabel(candidateClass: CandidateClass): string {
  if (candidateClass === "external_supply_prospect") return "External prospect"
  if (candidateClass === "legacy_sms_profile") return "Legacy SMS"
  if (candidateClass === "demo_preview_profile") return "Demo / preview"
  if (candidateClass === "synthetic_test_profile") return "Synthetic test"
  if (candidateClass === "internal_operator_profile") return "Internal"
  if (candidateClass === "incomplete_identity_artifact") return "Incomplete identity"
  return "Candidate account"
}

function identitySummary(row: Row): string {
  const parts: string[] = []
  if (row.registered) parts.push("registered")
  if (row.phoneReady) parts.push("phone ready")
  if (row.phoneBound) parts.push("phone-bound")
  return parts.join(" · ")
}

function isDemoTestOrInternal(candidateClass: CandidateClass): boolean {
  return candidateClass === "demo_preview_profile" ||
    candidateClass === "synthetic_test_profile" ||
    candidateClass === "internal_operator_profile"
}

function matchesIdentityFilter(row: Row, filter: IdentityFilter): boolean {
  if (filter === "registered") return row.registered
  if (filter === "phone_ready") return row.phoneReady
  if (filter === "phone_bound") return row.phoneBound
  return row.sendblueEligible
}

function buildRow(
  doc: UserDoc,
  sourceMap: Map<string, ExternalSource>,
  identityIndex: IdentityIndex
): Row {
  const { handle, kind } = buildHandle(doc)
  const source = deriveCandidateSource(doc, sourceMap.get(doc.id))
  const candidateClass = classifyCandidateProfile(source, doc)
  const phoneReady = isValidE164Phone(doc.phoneE164)
  const registered = identityIndex.registeredIds.has(doc.id)
  const phoneBound = identityIndex.phoneBoundIds.has(doc.id)
  return {
    id: doc.id,
    doc,
    handle,
    handleKind: kind,
    lifecycle: deriveLifecycle(doc),
    source,
    candidateClass,
    profilePct: computeProfilePct(doc),
    skills: skillsFromTags(doc.globalTags),
    lastActiveIso: doc.lifecycleUpdatedAt || doc.updatedAt || doc.createdAt,
    emailMasked: maskEmail(doc.email),
    phoneMasked: maskPhone(doc.phoneE164),
    linkedinHandle: linkedinHandleFrom(doc.linkedinUrl),
    registered,
    phoneReady,
    phoneBound,
    sendblueEligible: candidateClass === "candidate_account" && registered && phoneReady,
  }
}

function handleIcon(kind: Row["handleKind"]): string {
  switch (kind) {
    case "name":
      return "user_check"
    case "email":
      return "mail"
    case "linkedin":
      return "link2"
    case "phone":
      return "phone"
    default:
      return "tag"
  }
}

export function Candidates() {
  const navigate = useNavigate()
  const [rows, setRows] = useState<Row[]>([])
  const [lookupRows, setLookupRows] = useState<Row[]>([])
  const [sourceMap, setSourceMap] = useState<Map<string, ExternalSource>>(new Map())
  const [identityIndex, setIdentityIndex] = useState<IdentityIndex>(emptyIdentityIndex)
  const [loading, setLoading] = useState(true)
  const [lookupLoading, setLookupLoading] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [search, setSearch] = useState("")
  const [sort, setSort] = useState<DataTableSort | null>({ key: "last", dir: "desc" })
  const [stateFilter, setStateFilter] = useState<Set<LifecycleState>>(new Set())
  const [sourceFilter, setSourceFilter] = useState<Set<SourceKind>>(new Set())
  const [identityFilter, setIdentityFilter] = useState<Set<IdentityFilter>>(new Set())
  const [hasReachable, setHasReachable] = useState(false)
  const [accountOnly, setAccountOnly] = useState(true)
  const [includeDemoTestInternal, setIncludeDemoTestInternal] = useState(false)
  const [drawer, setDrawer] = useState<Row | null>(null)
  // TRUE counts over the WHOLE pa-users pool (server-aggregated). The row table
  // below is still the most recent 500 (a browse sample); these counts are not.
  const [poolCounts, setPoolCounts] = useState<CandidatePoolCounts | null>(null)

  async function refresh() {
    setLoading(true)
    setErr(null)
    // Pool counts load in parallel and never block / break the row table — if
    // the callable fails we silently fall back to counts over the loaded rows.
    void getCandidatePoolCounts()
      .then(setPoolCounts)
      .catch(() => undefined)
    try {
      const [docs, nextSourceMap, nextIdentityIndex] = await Promise.all([
        loadUserDocs(),
        loadSourceLinks(),
        loadIdentityIndex(),
      ])
      setSourceMap(nextSourceMap)
      setIdentityIndex(nextIdentityIndex)
      setRows(docs.map((d) => buildRow(d, nextSourceMap, nextIdentityIndex)))
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void refresh()
  }, [])

  useEffect(() => {
    const phone = normalizeCandidatePhoneLookup(search)
    if (!phone) {
      setLookupRows([])
      setLookupLoading(false)
      return
    }
    if (rows.some((r) => r.doc.phoneE164 === phone)) {
      setLookupRows([])
      setLookupLoading(false)
      return
    }

    let cancelled = false
    setLookupLoading(true)
    ;(async () => {
      try {
        const snap = await getDocs(
          query(collection(db(), PA_COLLECTIONS.users), where("phoneE164", "==", phone), limit(10))
        )
        if (cancelled) return
        setLookupRows(
          snap.docs.map((d) =>
            buildRow({ id: d.id, ...(d.data() as Omit<UserDoc, "id">) }, sourceMap, identityIndex)
          )
        )
      } catch (e: unknown) {
        if (!cancelled) setErr(e instanceof Error ? e.message : String(e))
      } finally {
        if (!cancelled) setLookupLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [identityIndex, rows, search, sourceMap])

  const counts = useMemo(() => {
    const byState = new Map<LifecycleState, number>()
    const bySource = new Map<SourceKind, number>()
    const byIdentity = new Map<IdentityFilter, number>()
    let accountCandidates = 0
    let externalProspects = 0
    let legacySmsProfiles = 0
    let demoPreviewProfiles = 0
    let syntheticTests = 0
    let internalProfiles = 0
    let identityArtifacts = 0
    let registered = 0
    let phoneReady = 0
    let phoneBound = 0
    let sendblueEligible = 0

    const countRows = includeDemoTestInternal
      ? rows
      : rows.filter((r) => !isDemoTestOrInternal(r.candidateClass))

    for (const r of countRows) {
      byState.set(r.lifecycle, (byState.get(r.lifecycle) ?? 0) + 1)
      bySource.set(r.source, (bySource.get(r.source) ?? 0) + 1)
      if (r.registered) byIdentity.set("registered", (byIdentity.get("registered") ?? 0) + 1)
      if (r.phoneReady) byIdentity.set("phone_ready", (byIdentity.get("phone_ready") ?? 0) + 1)
      if (r.phoneBound) byIdentity.set("phone_bound", (byIdentity.get("phone_bound") ?? 0) + 1)
      if (r.sendblueEligible) {
        byIdentity.set("sendblue_eligible", (byIdentity.get("sendblue_eligible") ?? 0) + 1)
      }
    }
    for (const r of rows) {
      if (r.candidateClass === "candidate_account") accountCandidates++
      else if (r.candidateClass === "external_supply_prospect") externalProspects++
      else if (r.candidateClass === "legacy_sms_profile") legacySmsProfiles++
      else if (r.candidateClass === "demo_preview_profile") demoPreviewProfiles++
      else if (r.candidateClass === "synthetic_test_profile") syntheticTests++
      else if (r.candidateClass === "internal_operator_profile") internalProfiles++
      else identityArtifacts++
      if (!isDemoTestOrInternal(r.candidateClass)) {
        if (r.registered) registered++
        if (r.phoneReady) phoneReady++
        if (r.phoneBound) phoneBound++
        if (r.sendblueEligible) sendblueEligible++
      }
    }
    return {
      byState,
      bySource,
      byIdentity,
      realRows: countRows.length,
      accountCandidates,
      externalProspects,
      legacySmsProfiles,
      demoPreviewProfiles,
      syntheticTests,
      internalProfiles,
      identityArtifacts,
      registered,
      phoneReady,
      phoneBound,
      sendblueEligible,
    }
  }, [includeDemoTestInternal, rows])

  // Header cards + STATE/SOURCE/IDENTITY chips render the TRUE whole-pool counts
  // (server-aggregated) when available; until they load (or if the callable
  // fails) they fall back to `counts` over the loaded 500 rows. Same shape as
  // `counts`, so downstream render code is unchanged.
  const displayCounts = useMemo(() => {
    if (!poolCounts) return { ...counts, totalPaUsers: rows.length, isTruePool: false }
    const variant = includeDemoTestInternal ? poolCounts.includingHidden : poolCounts.default
    const byState = new Map<LifecycleState, number>(
      Object.entries(variant.byState) as [LifecycleState, number][]
    )
    const bySource = new Map<SourceKind, number>(
      Object.entries(variant.bySource) as [SourceKind, number][]
    )
    const byIdentity = new Map<IdentityFilter, number>([
      ["registered", variant.byIdentity.registered],
      ["phone_ready", variant.byIdentity.phone_ready],
      ["phone_bound", variant.byIdentity.phone_bound],
      ["sendblue_eligible", variant.byIdentity.sendblue_eligible],
    ])
    return {
      byState,
      bySource,
      byIdentity,
      realRows: variant.realRows,
      accountCandidates: poolCounts.classBreakdown.accountCandidates,
      externalProspects: poolCounts.classBreakdown.externalProspects,
      legacySmsProfiles: poolCounts.classBreakdown.legacySmsProfiles,
      demoPreviewProfiles: poolCounts.classBreakdown.demoPreviewProfiles,
      syntheticTests: poolCounts.classBreakdown.syntheticTests,
      internalProfiles: poolCounts.classBreakdown.internalProfiles,
      identityArtifacts: poolCounts.classBreakdown.identityArtifacts,
      registered: poolCounts.identityCards.registered,
      phoneReady: poolCounts.identityCards.phoneReady,
      phoneBound: poolCounts.identityCards.phoneBound,
      sendblueEligible: poolCounts.identityCards.sendblueEligible,
      totalPaUsers: poolCounts.totalPaUsers,
      isTruePool: true,
    }
  }, [counts, includeDemoTestInternal, poolCounts, rows.length])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    const normalizedPhone = normalizeCandidatePhoneLookup(search)
    const phoneDigits = phoneSearchDigits(search)
    const merged = [...lookupRows, ...rows].filter(
      (row, index, all) => all.findIndex((r) => r.id === row.id) === index
    )
    return merged.filter((r) => {
      const phoneMatch =
        (normalizedPhone !== null && r.doc.phoneE164 === normalizedPhone) ||
        (phoneDigits !== null && matchesPhoneSearch(r.doc.phoneE164, search))
      if (phoneMatch) return true
      if (!includeDemoTestInternal && isDemoTestOrInternal(r.candidateClass)) return false
      if (accountOnly && r.candidateClass !== "candidate_account") return false
      if (stateFilter.size > 0 && !stateFilter.has(r.lifecycle)) return false
      if (sourceFilter.size > 0 && !sourceFilter.has(r.source)) return false
      if (
        identityFilter.size > 0 &&
        !Array.from(identityFilter).some((filter) => matchesIdentityFilter(r, filter))
      ) {
        return false
      }
      if (hasReachable && !(r.doc.email || r.doc.phoneE164 || r.doc.linkedinUrl)) return false
      if (!q) return true
      const hay = [
        r.id,
        r.handle,
        r.doc.email,
        r.doc.phoneE164,
        r.doc.linkedinUrl,
        r.doc.displayName,
        ...r.skills,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase()
      return hay.includes(q)
    })
  }, [
    accountOnly,
    hasReachable,
    identityFilter,
    includeDemoTestInternal,
    lookupRows,
    rows,
    search,
    sourceFilter,
    stateFilter,
  ])

  // Ranking. Sortable columns: handle (alpha), lifecycle (pipeline order),
  // profile (completeness %), last (recency). Header click toggles
  // asc → desc → off via DataTable's onSort.
  const sorted = useMemo(() => {
    if (!sort) return filtered
    const dir = sort.dir === "asc" ? 1 : -1
    const val = (r: Row): number | string => {
      switch (sort.key) {
        case "handle": return (r.handle || "").toLowerCase()
        case "lifecycle": return LIFECYCLE_ORDER.indexOf(r.lifecycle)
        case "source": return SOURCE_LABEL[r.source] || ""
        case "profile": return r.profilePct ?? 0
        case "last": return r.lastActiveIso ? Date.parse(r.lastActiveIso) || 0 : 0
        default: return 0
      }
    }
    return [...filtered].sort((a, b) => {
      const av = val(a)
      const bv = val(b)
      if (typeof av === "number" && typeof bv === "number") return (av - bv) * dir
      return String(av).localeCompare(String(bv)) * dir
    })
  }, [filtered, sort])

  const toggleSort = (key: string) => {
    setSort((s) => {
      if (!s || s.key !== key) return { key, dir: "asc" }
      if (s.dir === "asc") return { key, dir: "desc" }
      return null
    })
  }

  const toggleState = (s: LifecycleState) => {
    const next = new Set(stateFilter)
    if (next.has(s)) next.delete(s)
    else next.add(s)
    setStateFilter(next)
  }
  const toggleSource = (s: SourceKind) => {
    const next = new Set(sourceFilter)
    if (next.has(s)) next.delete(s)
    else next.add(s)
    setSourceFilter(next)
  }
  const toggleIdentity = (s: IdentityFilter) => {
    const next = new Set(identityFilter)
    if (next.has(s)) next.delete(s)
    else next.add(s)
    setIdentityFilter(next)
  }
  const clearFilters = () => {
    setStateFilter(new Set())
    setSourceFilter(new Set())
    setIdentityFilter(new Set())
    setHasReachable(false)
    setAccountOnly(true)
    setIncludeDemoTestInternal(false)
    setSearch("")
  }

  const phoneLookupActive = phoneSearchDigits(search) !== null

  return (
    <>
      <PageHeader
        eyebrow="Marketplace pool"
        title="Candidate pool"
        subtitle="pa-users is the shared candidate pool, not just logged-in users. This view defaults to real candidate accounts; external supply prospects stay available by filter."
        actions={
          <>
            <button
              type="button"
              className="btn btn--secondary btn--sm"
              onClick={() => void refresh()}
              disabled={loading}
            >
              <Icon name="refresh" size={12} />
              {loading ? "Loading…" : "Refresh"}
            </button>
            <button
              type="button"
              className="btn btn--primary btn--sm"
              onClick={() => navigate("/admin/external-supply/batches/new")}
            >
              <Icon name="plus" size={12} />
              Import batch
            </button>
          </>
        }
      />

      <MetricStrip
        items={[
          {
            label: "Pool size",
            value: displayCounts.isTruePool ? displayCounts.totalPaUsers : rows.length,
            tone: "info",
            sub: displayCounts.isTruePool
              ? `all pa-users · table shows recent ${rows.length}`
              : "last 500 pa-users by createdAt",
          },
          {
            label: "Real users",
            value: displayCounts.realRows,
            tone: displayCounts.realRows > 0 ? "live" : "neutral",
            sub: includeDemoTestInternal ? "including selected hidden rows" : "default visible pool",
          },
          {
            label: "Candidate accounts",
            value: displayCounts.accountCandidates,
            tone: displayCounts.accountCandidates > 0 ? "live" : "neutral",
            sub: "real candidate users",
          },
          {
            label: "Registered",
            value: displayCounts.registered,
            tone: displayCounts.registered > 0 ? "live" : "neutral",
            sub: "has pa-candidate-auth mapping",
          },
          {
            label: "Phone ready",
            value: displayCounts.phoneReady,
            tone: displayCounts.phoneReady > 0 ? "live" : "neutral",
            sub: "valid pa-users.phoneE164",
          },
          {
            label: "Phone-bound",
            value: displayCounts.phoneBound,
            tone: displayCounts.phoneBound > 0 ? "live" : "neutral",
            sub: "has phone handle index",
          },
          {
            label: "Sendblue eligible",
            value: displayCounts.sendblueEligible,
            tone: displayCounts.sendblueEligible > 0 ? "live" : "neutral",
            sub: "registered + phone ready",
          },
          {
            label: "External prospects",
            value: displayCounts.externalProspects,
            tone: displayCounts.externalProspects > 0 ? "hitl" : "neutral",
            sub: "operator-imported sourcing",
          },
          {
            label: "Legacy SMS",
            value: displayCounts.legacySmsProfiles,
            tone: displayCounts.legacySmsProfiles > 0 ? "neutral" : "neutral",
            sub: "old phone-only rows",
          },
          {
            label: "Demo / preview",
            value: displayCounts.demoPreviewProfiles,
            tone: displayCounts.demoPreviewProfiles > 0 ? "neutral" : "neutral",
            sub: "hidden by default",
          },
          {
            label: "Test / internal",
            value: displayCounts.syntheticTests + displayCounts.internalProfiles,
            tone: displayCounts.syntheticTests + displayCounts.internalProfiles > 0 ? "neutral" : "neutral",
            sub: "hidden unless included",
          },
          {
            label: "Opted out",
            value: displayCounts.byState.get("opted_out") ?? 0,
            tone:
              (displayCounts.byState.get("opted_out") ?? 0) > 0
                ? "hitl"
                : "neutral",
            sub: "do-not-contact pool",
          },
        ]}
      />

      {err && (
        <div
          style={{
            padding: "10px 14px",
            borderRadius: 10,
            background: "var(--blocked-bg)",
            color: "var(--blocked)",
            fontSize: 13,
          }}
        >
          {err}
        </div>
      )}

      {/* Filter chips */}
      <Card padded={false}>
        <div style={{ padding: 14, display: "flex", flexDirection: "column", gap: 10 }}>
          <FilterRow label="State">
            {LIFECYCLE_ORDER.map((s) => {
              const n = displayCounts.byState.get(s) ?? 0
              if (n === 0) return null
              const active = stateFilter.has(s)
              return (
                <Chip
                  key={s}
                  active={active}
                  tone={LIFECYCLE_TONE[s]}
                  onClick={() => toggleState(s)}
                  title={LIFECYCLE_TOOLTIP[s]}
                >
                  {LIFECYCLE_LABEL[s]} <span style={{ opacity: 0.6 }}>· {n}</span>
                </Chip>
              )
            })}
          </FilterRow>
          <FilterRow label="Source">
            {SOURCE_ORDER.map((s) => {
              const n = displayCounts.bySource.get(s) ?? 0
              if (n === 0) return null
              const active = sourceFilter.has(s)
              return (
                <Chip
                  key={s}
                  active={active}
                  tone="info"
                  onClick={() => toggleSource(s)}
                  title={SOURCE_TOOLTIP[s]}
                >
                  {SOURCE_LABEL[s]} <span style={{ opacity: 0.6 }}>· {n}</span>
                </Chip>
              )
            })}
          </FilterRow>
          <FilterRow label="Identity">
            {IDENTITY_FILTERS.map(({ key, label, tone }) => {
              const n = displayCounts.byIdentity.get(key) ?? 0
              if (n === 0) return null
              const active = identityFilter.has(key)
              return (
                <Chip
                  key={key}
                  active={active}
                  tone={tone}
                  onClick={() => toggleIdentity(key)}
                  title={IDENTITY_TOOLTIP[key]}
                >
                  {label} <span style={{ opacity: 0.6 }}>· {n}</span>
                </Chip>
              )
            })}
          </FilterRow>
          <FilterRow label="Modifiers">
            <Chip
              active={accountOnly}
              tone="live"
              onClick={() => setAccountOnly((v) => !v)}
            >
              Candidate accounts only
            </Chip>
            <Chip
              active={hasReachable}
              tone="live"
              onClick={() => setHasReachable((v) => !v)}
            >
              Has reachable handle
            </Chip>
            <Chip
              active={includeDemoTestInternal}
              tone="hitl"
              onClick={() => setIncludeDemoTestInternal((v) => !v)}
            >
              Include demo/test/internal
            </Chip>
            {(stateFilter.size + sourceFilter.size + identityFilter.size > 0 || hasReachable || !accountOnly || includeDemoTestInternal || search) && (
              <button
                type="button"
                className="btn btn--ghost btn--sm"
                onClick={clearFilters}
                style={{ marginLeft: "auto" }}
              >
                <Icon name="x" size={12} />
                Clear filters
              </button>
            )}
          </FilterRow>
          {phoneLookupActive && (
            <div
              style={{
                marginLeft: 78,
                color: "var(--ink-3)",
                fontSize: 12,
                display: "flex",
                alignItems: "center",
                gap: 6,
              }}
            >
              <Icon name="phone" size={12} />
              Phone lookup overrides candidate, source, state, demo/test/internal filters.
            </div>
          )}
        </div>
      </Card>

      <SectionHead
        title="Candidates"
        count={filtered.length}
        actions={
          <span className="caption" style={{ color: "var(--ink-3)" }}>
            {lookupLoading
              ? "looking up phone…"
              : rows.length === filtered.length
              ? `${rows.length} shown`
              : `${filtered.length} of ${rows.length} shown`}
          </span>
        }
      />
      {rows.length === 0 && !loading ? (
        <EmptyState
          icon="users"
          title="No candidates yet"
          body="The pa-users pool is empty — import a batch or wait for iMessage / public-job intake."
        />
      ) : (
        <DataTable
          rows={sorted}
          onRowClick={(r) => setDrawer(r as Row)}
          search={search}
          onSearch={setSearch}
          sort={sort}
          onSort={toggleSort}
          count={sorted.length}
          totalCount={rows.length}
          columns={[
            {
              key: "handle",
              label: "Handle",
              sortable: true,
              render: (r) => (
                <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
                  <Icon name={handleIcon((r as Row).handleKind)} size={13} style={{ color: "var(--ink-3)" }} />
                  <div style={{ minWidth: 0 }}>
                    <div
                      style={{
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                        fontWeight: 500,
                      }}
                      title={(r as Row).id}
                    >
                      {(r as Row).handle}
                    </div>
                    <div
                      style={{
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                        fontFamily: "var(--font-mono)",
                        fontSize: 10,
                        color: "var(--ink-4)",
                        marginTop: 2,
                      }}
                    >
                      {(r as Row).doc.phoneE164 || (r as Row).emailMasked || shortUid((r as Row).id)}
                    </div>
                  </div>
                </div>
              ),
            },
            {
              key: "lifecycle",
              label: "State",
              sortable: true,
              render: (r) => (
                <StatusPill tone={LIFECYCLE_TONE[(r as Row).lifecycle]} dot>
                  {LIFECYCLE_LABEL[(r as Row).lifecycle]}
                </StatusPill>
              ),
            },
            {
              key: "source",
              label: "Source",
              sortable: true,
              render: (r) => {
                const row = r as Row
                const identity = identitySummary(row)
                return (
                  <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                    <span style={{ fontSize: 12, color: "var(--ink-2)" }}>
                      {SOURCE_LABEL[row.source]}
                    </span>
                    <span style={{ fontSize: 10, color: "var(--ink-4)" }}>
                      {candidateClassLabel(row.candidateClass)}
                      {identity ? ` · ${identity}` : ""}
                    </span>
                  </div>
                )
              },
            },
            {
              key: "profile",
              label: "Profile",
              sortable: true,
              render: (r) => <PctBar pct={(r as Row).profilePct} />,
            },
            {
              key: "skills",
              label: "Top tags",
              render: (r) => {
                const skills = (r as Row).skills
                if (skills.length === 0)
                  return <span style={{ color: "var(--ink-4)", fontSize: 12 }}>—</span>
                return (
                  <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                    {skills.map((s, i) => (
                      <span
                        key={i}
                        style={{
                          fontSize: 11,
                          padding: "2px 7px",
                          borderRadius: 4,
                          background: "var(--cream-2)",
                          color: "var(--ink-2)",
                        }}
                      >
                        {s}
                      </span>
                    ))}
                  </div>
                )
              },
            },
            {
              key: "last",
              label: "Last active",
              className: "mono",
              sortable: true,
              render: (r) => relTime((r as Row).lastActiveIso),
            },
            {
              key: "actions",
              label: "",
              render: (r) => (
                <button
                  type="button"
                  className="btn btn--ghost btn--sm"
                  onClick={(e) => {
                    e.stopPropagation()
                    setDrawer(r as Row)
                  }}
                >
                  Manage
                  <Icon name="arrow_right" size={12} />
                </button>
              ),
            },
          ]}
        />
      )}

      {drawer && <CandidateDrawer row={drawer} onClose={() => setDrawer(null)} />}
    </>
  )
}

function Chip({
  active,
  tone,
  onClick,
  children,
  title,
}: {
  active: boolean
  tone: Tone
  onClick: () => void
  children: React.ReactNode
  title?: string
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={`pill pill--${active ? tone : "neutral"}`}
      style={{
        cursor: "pointer",
        border: active ? "1px solid currentColor" : "1px solid transparent",
        opacity: active ? 1 : 0.85,
        padding: "3px 10px",
      }}
    >
      {active && <Icon name="check" size={10} />}
      {children}
    </button>
  )
}

function FilterRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <span
        style={{
          fontSize: 11,
          letterSpacing: "0.1em",
          textTransform: "uppercase",
          fontWeight: 600,
          color: "var(--ink-3)",
          width: 70,
          flexShrink: 0,
        }}
      >
        {label}
      </span>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", flex: 1 }}>{children}</div>
    </div>
  )
}

function PctBar({ pct }: { pct: number }) {
  const tone: Tone = pct >= 70 ? "live" : pct >= 40 ? "hitl" : "blocked"
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 80 }}>
      <div className="score-bar" style={{ flex: 1, maxWidth: 100 }}>
        <div
          className={`score-bar__fill score-bar__fill--${tone}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--ink-2)" }}>
        {pct}%
      </span>
    </div>
  )
}

function CandidateDrawer({ row, onClose }: { row: Row; onClose: () => void }) {
  const doc = row.doc
  const [detail, setDetail] = useState<CandidateDrawerDetail>(() => emptyCandidateDrawerDetail())
  const [detailLoading, setDetailLoading] = useState(true)
  const [detailErr, setDetailErr] = useState<string | null>(null)
  const [expandedSections, setExpandedSections] = useState<Set<CandidateDrawerSectionId>>(
    () => new Set()
  )

  useEffect(() => {
    let cancelled = false
    setDetail(emptyCandidateDrawerDetail())
    setDetailLoading(true)
    setDetailErr(null)
    setExpandedSections(new Set())
    ;(async () => {
      try {
        const loaded = await loadCandidateDrawerDetail(doc.id, doc.latestResumeArtifactId)
        if (cancelled) return
        setDetail(loaded)
      } catch (e: unknown) {
        if (!cancelled) setDetailErr(e instanceof Error ? e.message : String(e))
      } finally {
        if (!cancelled) setDetailLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [doc.id])

  const isExpanded = (sectionId: CandidateDrawerSectionId) => expandedSections.has(sectionId)
  const allExpanded = expandedSections.size === CANDIDATE_DRAWER_SECTION_IDS.length
  const toggleSection = (sectionId: CandidateDrawerSectionId) => {
    setExpandedSections((current) => {
      const next = new Set(current)
      if (next.has(sectionId)) next.delete(sectionId)
      else next.add(sectionId)
      return next
    })
  }
  const setAllExpanded = (expanded: boolean) => {
    setExpandedSections(expanded ? new Set(CANDIDATE_DRAWER_SECTION_IDS) : new Set())
  }
  const detailStatus = detailLoading ? "Loading detail" : "Detail loaded"
  const experienceCount = drawerExperienceRows(detail.resumes[0]).length
  const visibleRegions = [
    row.registered ? "Registered" : "Unregistered",
    row.phoneReady ? "Phone ready" : undefined,
    row.phoneBound ? "Phone-bound" : undefined,
    doc.latestResumeArtifactId ? "Resume on file" : undefined,
    doc.mem0UserId ? "mem0" : undefined,
  ].filter((label): label is string => Boolean(label))

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(45, 26, 10, 0.25)",
        zIndex: 100,
        display: "flex",
        justifyContent: "flex-end",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "min(1180px, calc(100vw - 32px))",
          background: "var(--cream-3)",
          borderLeft: "1px solid var(--border)",
          overflowY: "auto",
          padding: 20,
          display: "flex",
          flexDirection: "column",
          gap: 14,
        }}
      >
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12 }}>
          <div style={{ minWidth: 0 }}>
            <div
              style={{
                fontSize: 11,
                letterSpacing: "0.14em",
                textTransform: "uppercase",
                color: "var(--ink-3)",
                fontWeight: 600,
                marginBottom: 6,
              }}
            >
              {candidateClassLabel(row.candidateClass)} · {SOURCE_LABEL[row.source]}
            </div>
            <div
              style={{
                fontFamily: "var(--font-serif)",
                fontSize: 26,
                lineHeight: 1.1,
                color: "var(--ink)",
                letterSpacing: "-0.02em",
              }}
            >
              {row.handle}
            </div>
            <div
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: 11,
                color: "var(--ink-3)",
                marginTop: 4,
              }}
              title={doc.id}
            >
              {shortUid(doc.id)}
            </div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", justifyContent: "flex-end" }}>
            <DrawerInlineLink to={`/admin/candidates/${doc.id}/profile`}>Open full page</DrawerInlineLink>
            <button
              type="button"
              className="btn btn--secondary btn--sm"
              onClick={() => setAllExpanded(!allExpanded)}
              aria-pressed={allExpanded}
              title={allExpanded ? "Collapse every section" : "Expand every section in this modal"}
            >
              <Icon name={allExpanded ? "chev_d" : "layers"} size={13} />
              {allExpanded ? "Collapse all" : "Expand all"}
            </button>
            <button
              type="button"
              className="btn btn--ghost btn--icon"
              onClick={onClose}
              aria-label="Close"
            >
              <Icon name="x" size={14} />
            </button>
          </div>
        </div>

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "minmax(0, 1fr) minmax(220px, auto)",
            gap: 12,
            padding: 12,
            border: "1px solid var(--border)",
            borderRadius: 8,
            background: "var(--cream)",
          }}
        >
          <div style={{ minWidth: 0 }}>
            <DrawerSectionLabel>Candidate state</DrawerSectionLabel>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              <StatusPill tone={LIFECYCLE_TONE[row.lifecycle]} dot>
                {LIFECYCLE_LABEL[row.lifecycle]}
              </StatusPill>
              {doc.outreach?.status && doc.outreach.status !== "allowed" && (
                <StatusPill tone={doc.outreach.status === "opted_out" ? "blocked" : "hitl"}>
                  outreach: {doc.outreach.status}
                </StatusPill>
              )}
              {doc.piiConsentAt && <StatusPill tone="live">PII consent</StatusPill>}
              {visibleRegions.map((label) => (
                <StatusPill key={label} tone={label === "Registered" || label === "Phone ready" ? "live" : "info"}>
                  {label}
                </StatusPill>
              ))}
              {row.sendblueEligible && <StatusPill tone="hitl">Sendblue eligible</StatusPill>}
            </div>
          </div>
          <div style={{ minWidth: 0 }}>
            <DrawerSectionLabel>{detailStatus}</DrawerSectionLabel>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              <StatusPill tone="neutral">{candidateDrawerRegionCount(detail.resumes.length, "resume")}</StatusPill>
              <StatusPill tone="neutral">{candidateDrawerRegionCount(detail.messages.length, "message")}</StatusPill>
              <StatusPill tone="neutral">{candidateDrawerRegionCount(detail.prescreens.length, "session")}</StatusPill>
              <StatusPill tone="neutral">{candidateDrawerRegionCount(detail.jobStates.length, "job state")}</StatusPill>
            </div>
          </div>
        </div>

        {detailErr && (
          <div
            style={{
              padding: "8px 10px",
              borderRadius: 6,
              background: "var(--blocked-bg)",
              color: "var(--blocked)",
              fontSize: 12,
            }}
          >
            Detail load failed: {detailErr}
          </div>
        )}

        <DrawerSectionLabel>Detail regions</DrawerSectionLabel>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(min(320px, 100%), 1fr))",
            gap: 14,
            alignItems: "start",
            padding: 12,
            border: "1px solid var(--border)",
            borderRadius: 8,
            background: "var(--cream-2)",
          }}
        >
          <DrawerSectionCard
            title="Identity"
            subtitle="Contact, source, lifecycle, and account handles."
            meta={row.registered ? "Registered" : "Identity record"}
            sectionId="identity"
            expanded={isExpanded("identity")}
            onToggle={toggleSection}
          >
            <DrawerKV k="Display name" v={doc.displayName || "—"} />
            <DrawerKV k="Email" v={doc.email || "—"} mono={!!doc.email} />
            <DrawerKV k="Phone" v={doc.phoneE164 || "—"} mono={!!doc.phoneE164} />
            <DrawerKV
              k="LinkedIn"
              v={
                doc.linkedinUrl ? (
                  <a href={doc.linkedinUrl} target="_blank" rel="noreferrer">
                    {row.linkedinHandle || doc.linkedinUrl}
                  </a>
                ) : (
                  "—"
                )
              }
            />
            <DrawerKV k="Created" v={relTime(doc.createdAt)} />
            <DrawerKV k="Updated" v={relTime(doc.updatedAt)} />
            {isExpanded("identity") && (
              <>
                <DrawerKV k="Candidate id" v={doc.id} mono />
                <DrawerKV k="Source" v={SOURCE_LABEL[row.source]} />
                <DrawerKV k="First signup" v={signupEntryLabel(doc.firstSignupEntry)} mono={!!doc.firstSignupEntry?.path} />
                <DrawerKV k="Lifecycle" v={LIFECYCLE_LABEL[row.lifecycle]} />
                <DrawerKV k="mem0 id" v={doc.mem0UserId || "—"} mono={!!doc.mem0UserId} />
                <DrawerKV k="Outreach" v={doc.outreach?.status || "allowed"} />
              </>
            )}
          </DrawerSectionCard>

          <DrawerSectionCard
            title="Profile"
            subtitle="Global tags, durable preferences, and profile completeness."
            meta={candidateDrawerRegionCount(row.skills.length, "tag")}
            sectionId="profile"
            expanded={isExpanded("profile")}
            onToggle={toggleSection}
            openTo={`/admin/candidates/${doc.id}/profile`}
            openLabel="Open profile page"
          >
            <DrawerKV k="Completeness" v={<PctBar pct={row.profilePct} />} />
            <DrawerKV
              k="Top tags"
              v={row.skills.length === 0 ? "—" : <DrawerChipList values={row.skills} />}
            />
            <DrawerProfileDetails doc={doc} compact={!isExpanded("profile")} />
          </DrawerSectionCard>

          <DrawerSectionCard
            title="Resume"
            subtitle="Parsed resume source and extracted resume summary."
            meta={detailLoading ? "Loading" : candidateDrawerRegionCount(detail.resumes.length, "resume")}
            sectionId="resume"
            expanded={isExpanded("resume")}
            onToggle={toggleSection}
            openTo={`/admin/candidates/${doc.id}/profile`}
            openLabel="Open profile page"
          >
            <DrawerResumeSummary
              doc={doc}
              resumes={detail.resumes}
              resumeArtifacts={detail.resumeArtifacts}
              loading={detailLoading}
              expanded={isExpanded("resume")}
            />
          </DrawerSectionCard>

          <DrawerSectionCard
            title="Experience"
            subtitle="Roles from the latest parsed resume."
            meta={detailLoading ? "Loading" : candidateDrawerRegionCount(experienceCount, "role")}
            sectionId="experience"
            expanded={isExpanded("experience")}
            onToggle={toggleSection}
            openTo={`/admin/candidates/${doc.id}/profile`}
            openLabel="Open profile page"
          >
            <DrawerExperienceSummary
              resume={detail.resumes[0]}
              loading={detailLoading}
              expanded={isExpanded("experience")}
            />
          </DrawerSectionCard>

          <DrawerSectionCard
            title="Conversation"
            subtitle="Candidate messages plus stored agent turns."
            meta={detailLoading ? "Loading" : candidateDrawerRegionCount(detail.messages.length, "message")}
            sectionId="conversation"
            expanded={isExpanded("conversation")}
            onToggle={toggleSection}
            openTo={`/users/${doc.id}`}
            openLabel="Open conversation page"
          >
            <DrawerConversationSummary
              messages={detail.messages}
              turns={detail.turns}
              loading={detailLoading}
              expanded={isExpanded("conversation")}
            />
          </DrawerSectionCard>

          <DrawerSectionCard
            title="Prescreened jobs"
            subtitle="Job sessions, outcomes, and candidate job-state rows."
            meta={detailLoading ? "Loading" : candidateDrawerRegionCount(detail.prescreens.length, "session")}
            sectionId="prescreens"
            expanded={isExpanded("prescreens")}
            onToggle={toggleSection}
          >
            <DrawerPrescreenSummary
              prescreens={detail.prescreens}
              jobStates={detail.jobStates}
              jobLabels={detail.jobLabels}
              loading={detailLoading}
              expanded={isExpanded("prescreens")}
            />
          </DrawerSectionCard>

          <DrawerSectionCard
            title="Ops links"
            subtitle="Full profile, conversation, tags, and ops queues."
            meta="6 links"
            sectionId="management"
            expanded={isExpanded("management")}
            onToggle={toggleSection}
          >
            <div style={{ display: "grid", gap: 6, gridTemplateColumns: isExpanded("management") ? "repeat(auto-fit, minmax(220px, 1fr))" : undefined }}>
              <DrawerLink to={`/admin/candidates/${doc.id}/profile`} label="Full profile" icon="user_check" />
              <DrawerLink to={`/users/${doc.id}`} label="Conversation detail" icon="message" />
              <DrawerLink to={`/admin/users/${doc.id}/tag-snapshots`} label="Tag snapshots" icon="tag" />
              <DrawerLink to="/admin/identity-conflicts" label="Identity conflicts queue" icon="user_merge" />
              <DrawerLink to="/admin/match-debug" label="Run in match debug" icon="zap" />
              <DrawerLink to="/admin/outreach-ops" label="Outreach ops" icon="send" />
            </div>
          </DrawerSectionCard>
        </div>
      </div>
    </div>
  )
}

function DrawerSectionCard({
  title,
  subtitle,
  meta,
  sectionId,
  expanded,
  onToggle,
  openTo,
  openLabel = "Open page",
  children,
}: {
  title: string
  subtitle: string
  meta?: string
  sectionId: CandidateDrawerSectionId
  expanded: boolean
  onToggle: (sectionId: CandidateDrawerSectionId) => void
  openTo?: string
  openLabel?: string
  children: React.ReactNode
}) {
  return (
    <div style={{ gridColumn: expanded ? "1 / -1" : undefined, minWidth: 0 }}>
      <Card
        title={<DrawerRegionHeading title={title} subtitle={subtitle} meta={meta} />}
        style={{
          height: "100%",
          borderColor: expanded ? "var(--border-strong)" : undefined,
          boxShadow: expanded ? "var(--shadow-sm)" : undefined,
          background: expanded ? "var(--cream)" : "var(--cream-3)",
          padding: expanded ? 22 : 18,
        }}
        action={
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", justifyContent: "flex-end" }}>
            {openTo && <DrawerInlineLink to={openTo}>{openLabel}</DrawerInlineLink>}
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              onClick={() => onToggle(sectionId)}
              aria-expanded={expanded}
              title={expanded ? `Collapse ${title}` : `Expand ${title} in this modal`}
            >
              <Icon name={expanded ? "chev_d" : "layers"} size={13} />
              {expanded ? "Collapse" : "Expand"}
            </button>
          </div>
        }
      >
        {children}
      </Card>
    </div>
  )
}

function DrawerRegionHeading({
  title,
  subtitle,
  meta,
}: {
  title: string
  subtitle: string
  meta?: string
}) {
  return (
    <div style={{ display: "grid", gap: 5, whiteSpace: "normal", minWidth: 0 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <span style={{ color: "var(--ink)", fontSize: 12, letterSpacing: "0.08em", textTransform: "uppercase" }}>
          {title}
        </span>
        {meta && (
          <span
            style={{
              display: "inline-flex",
              alignItems: "center",
              minHeight: 20,
              padding: "2px 7px",
              borderRadius: 6,
              background: "var(--cream-2)",
              border: "1px solid var(--border)",
              color: "var(--ink-2)",
              fontSize: 11,
              fontWeight: 600,
              letterSpacing: 0,
              textTransform: "none",
            }}
          >
            {meta}
          </span>
        )}
      </div>
      <div
        style={{
          maxWidth: "58ch",
          color: "var(--ink-3)",
          fontSize: 12,
          fontWeight: 500,
          letterSpacing: 0,
          lineHeight: 1.35,
          textTransform: "none",
        }}
      >
        {subtitle}
      </div>
    </div>
  )
}

// Inline expansion shown inside CandidateDrawer — same data the Full Profile
// page surfaces, condensed for drawer width. Keeps the existing DrawerLink to
// the full /admin/candidates/:id/profile route as a "view detached" affordance.
function DrawerProfileDetails({ doc, compact = false }: { doc: UserDoc; compact?: boolean }) {
  const d = doc as Record<string, unknown>
  const tags = (d.tags ?? {}) as {
    topTags?: string[]
    skills?: Array<string | { value: string }>
    targetRoleFunction?: string[]
    industrySector?: string[]
    careerStage?: string
    visaStatus?: string
    targetLocations?: string[]
    minSalary?: number
  }
  const derivedExp = d.derivedExperience as
    | { summary?: string; years?: number; titles?: string[]; companies?: string[] }
    | undefined
  const prefs = d.conversationDerivedPreferences as
    | { summary?: string; updatedAt?: { seconds?: number } | string }
    | undefined
  const expanded = !compact
  const derivedSummary = previewCandidateDrawerText(
    derivedExp?.summary,
    candidateDrawerPreviewMax(expanded, 700, 1800)
  )
  const prefsSummary = previewCandidateDrawerText(
    prefs?.summary,
    candidateDrawerPreviewMax(expanded, 500, 1600)
  )
  const ctx = previewCandidateDrawerText(d.candidateContext, candidateDrawerPreviewMax(expanded, 400, 1800))
  const postMatch = d.postMatchRetention as
    | { state?: string; lastInteractionAt?: { seconds?: number } | string }
    | undefined
  const resumeCount = (d.resumeParseCount ?? 0) as number
  const resumeLast = d.resumeParseLastAt as { seconds?: number } | string | undefined
  const resumeId = d.latestResumeArtifactId as string | undefined
  const layoffCtx = d.layoffContext as Record<string, unknown> | undefined
  const onboardingStatus = d.onboardingStatus as string | undefined
  const claireStarted = d.claireConversationStarted as boolean | undefined

  const skills = Array.isArray(tags.skills)
    ? tags.skills.map((s) => (typeof s === "string" ? s : s?.value)).filter(Boolean).slice(0, 10)
    : []

  const noData = !derivedSummary &&
    !prefsSummary &&
    !ctx &&
    !resumeCount &&
    !tags.topTags?.length &&
    !skills.length &&
    !tags.targetRoleFunction?.length &&
    !tags.industrySector?.length &&
    (compact || (!postMatch?.state && !layoffCtx))

  if (noData) {
    return (
      <div style={{ fontSize: 12.5, color: "var(--ink-3)", padding: "4px 0" }}>
        No derived profile data on this doc yet — resume parse, conversation extraction, and tag enrichment have not run (or returned empty).
      </div>
    )
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10, fontSize: 13 }}>
      {resumeCount > 0 && (
        <div>
          <DrawerSectionLabel>Resume</DrawerSectionLabel>
          <div style={{ color: "var(--ink-2)" }}>
            Parsed {resumeCount}× · last {relTime(toIsoLike(resumeLast))}
            {resumeId && (
              <span style={{ color: "var(--ink-3)", fontFamily: "var(--font-mono)", fontSize: 11, marginLeft: 6 }}>
                · {String(resumeId).slice(0, 12)}…
              </span>
            )}
          </div>
        </div>
      )}

      {derivedSummary && derivedExp && (
        <div>
          <DrawerSectionLabel>Experience summary</DrawerSectionLabel>
          <div style={{ color: "var(--ink-2)", whiteSpace: "pre-wrap" }}>{derivedSummary}</div>
          {(derivedExp.years || derivedExp.titles?.length || derivedExp.companies?.length) && (
            <div style={{ marginTop: 4, color: "var(--ink-3)", fontSize: 12 }}>
              {derivedExp.years ? `${derivedExp.years} yrs · ` : ""}
              {derivedExp.titles?.slice(0, 3).join(", ")}
              {derivedExp.companies?.length ? ` · @ ${derivedExp.companies.slice(0, 3).join(", ")}` : ""}
            </div>
          )}
        </div>
      )}

      {(tags.targetRoleFunction?.length || tags.industrySector?.length || tags.careerStage || tags.visaStatus || tags.targetLocations?.length || tags.minSalary) && (
        <div>
          <DrawerSectionLabel>Canonical tags</DrawerSectionLabel>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
            {tags.targetRoleFunction?.map((r) => <TagChip key={r}>role: {r}</TagChip>)}
            {tags.industrySector?.slice(0, 5).map((i) => <TagChip key={i}>industry: {i}</TagChip>)}
            {tags.careerStage && <TagChip>stage: {tags.careerStage}</TagChip>}
            {tags.visaStatus && <TagChip>visa: {tags.visaStatus}</TagChip>}
            {tags.targetLocations?.slice(0, 3).map((l) => <TagChip key={l}>loc: {l}</TagChip>)}
            {tags.minSalary && <TagChip>min: ${tags.minSalary.toLocaleString()}</TagChip>}
          </div>
        </div>
      )}

      {skills.length > 0 && (
        <div>
          <DrawerSectionLabel>Skills (top {skills.length})</DrawerSectionLabel>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
            {skills.map((s) => <TagChip key={String(s)}>{String(s)}</TagChip>)}
          </div>
        </div>
      )}

      {prefsSummary && (
        <div>
          <DrawerSectionLabel>Conversation preferences</DrawerSectionLabel>
          <div style={{ color: "var(--ink-2)", whiteSpace: "pre-wrap" }}>{prefsSummary}</div>
        </div>
      )}

      {ctx && (
        <div>
          <DrawerSectionLabel>Candidate context</DrawerSectionLabel>
          <div style={{ color: "var(--ink-2)", whiteSpace: "pre-wrap", fontSize: 12 }}>
            {ctx}
          </div>
        </div>
      )}

      {compact ? null : (
        <>
      {postMatch?.state && (
        <div>
          <DrawerSectionLabel>Post-match retention</DrawerSectionLabel>
          <div style={{ color: "var(--ink-2)" }}>
            State: <strong>{postMatch.state}</strong>
            {postMatch.lastInteractionAt && <> · last {relTime(toIsoLike(postMatch.lastInteractionAt))}</>}
          </div>
        </div>
      )}

      {onboardingStatus && (
        <div>
          <DrawerSectionLabel>Onboarding status</DrawerSectionLabel>
          <div style={{ color: "var(--ink-2)" }}>
            {onboardingStatus}
            {claireStarted !== undefined && <> · Claire started: {String(claireStarted)}</>}
          </div>
        </div>
      )}

      {layoffCtx && (
        <div>
          <DrawerSectionLabel>Layoff context</DrawerSectionLabel>
          <pre style={{ margin: 0, fontSize: 11, color: "var(--ink-3)", whiteSpace: "pre-wrap", fontFamily: "var(--font-mono)" }}>
            {JSON.stringify(layoffCtx, null, 2).slice(0, candidateDrawerPreviewMax(expanded, 500, 2200))}
          </pre>
        </div>
      )}
        </>
      )}
    </div>
  )
}

function DrawerResumeSummary({
  doc,
  resumes,
  resumeArtifacts,
  loading,
  expanded,
}: {
  doc: UserDoc
  resumes: DrawerDetailRow[]
  resumeArtifacts: DrawerDetailRow[]
  loading: boolean
  expanded: boolean
}) {
  if (loading) return <DrawerLoadingText />
  const resume = resumes[0]
  const source = drawerResumeOriginalSource(resume, resumeArtifacts, doc.latestResumeArtifactId)
  const resumeId = doc.latestResumeArtifactId ?? firstCandidateDrawerText(resume?.id)
  if (!resume && !resumeId) return <DrawerEmptyText>No resume record loaded.</DrawerEmptyText>
  const fileName = firstCandidateDrawerText(
    resume?.originalFileName,
    resume?.fileName,
    resume?.resumeFileName,
    resume?.sourceFileName,
    doc.latestResumeArtifactId
  )
  const parser = [
    firstCandidateDrawerText(resume?.parserModel, resume?.model),
    firstCandidateDrawerText(resume?.parserVersion, resume?.version),
  ].filter(Boolean).join(" · ")
  const skills = drawerStringList(resume?.topSkills ?? resume?.skills ?? readNested(resume, ["candidateProfile", "skills"])).slice(0, 8)
  const industries = drawerStringList(resume?.industryTags ?? resume?.industries ?? readNested(resume, ["candidateProfile", "industries"])).slice(0, 4)
  const summary = firstCandidateDrawerText(
    resume?.summary,
    resume?.candidateSummary,
    resume?.resumeSummary,
    readNested(resume, ["candidateProfile", "summary"])
  )
  const visibleResumeCount = candidateDrawerVisibleCount(resumes.length, expanded, 1)
  const visibleResumes = resumes.slice(0, visibleResumeCount)
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <DrawerKV k="File" v={fileName || "—"} />
      <DrawerKV
        k="Original file"
        v={
          source.href ? (
            <DrawerExternalFileLink href={source.href} label="Open original file" detail={source.raw} />
          ) : source.raw ? (
            <span style={{ color: "var(--ink-3)" }}>{previewCandidateDrawerText(source.raw, 72)}</span>
          ) : (
            "No source link stored"
          )
        }
      />
      <DrawerKV k="Resume id" v={resumeId ? shortUid(String(resumeId)) : "—"} mono={!!resumeId} />
      <DrawerKV k="Parsed" v={relTime(toIsoLike(resume?.updatedAt) ?? toIsoLike(resume?.createdAt) ?? toIsoLike(resume?.ingestedAt))} />
      {parser && <DrawerKV k="Parser" v={parser} />}
      {skills.length > 0 && <DrawerKV k="Skills" v={<DrawerChipList values={skills} />} />}
      {industries.length > 0 && <DrawerKV k="Industries" v={<DrawerChipList values={industries} />} />}
      {summary && (
        <div style={{ paddingTop: 4 }}>
          <DrawerSectionLabel>Parsed summary</DrawerSectionLabel>
          <div style={{ color: "var(--ink-2)", fontSize: 12.5, lineHeight: 1.5, whiteSpace: "pre-wrap" }}>
            {previewCandidateDrawerText(summary, candidateDrawerPreviewMax(expanded, 420, 1800))}
          </div>
        </div>
      )}
      {expanded && visibleResumes.length > 1 && (
        <div style={{ paddingTop: 4 }}>
          <DrawerSectionLabel>Resume records loaded</DrawerSectionLabel>
          <div style={{ display: "grid", gap: 8 }}>
            {visibleResumes.map((row) => {
              const rowFile = firstCandidateDrawerText(
                row.originalFileName,
                row.fileName,
                row.resumeFileName,
                row.sourceFileName,
                row.id
              )
              const rowSource = drawerResumeOriginalSource(row, resumeArtifacts)
              return (
                <div key={row.id} style={{ border: "1px solid var(--border)", borderRadius: 6, padding: 8 }}>
                  <div style={{ display: "flex", gap: 8, alignItems: "center", justifyContent: "space-between" }}>
                    <div style={{ color: "var(--ink)", fontWeight: 600, fontSize: 12.5 }}>{rowFile || shortUid(row.id)}</div>
                    {rowSource.href && <DrawerExternalFileLink href={rowSource.href} label="Open" compact />}
                  </div>
                  <div style={{ color: "var(--ink-3)", fontSize: 11.5, marginTop: 3 }}>
                    {shortUid(row.id)} · {relTime(toIsoLike(row.updatedAt) ?? toIsoLike(row.createdAt) ?? toIsoLike(row.ingestedAt))}
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}

function DrawerExternalFileLink({
  href,
  label,
  detail,
  compact = false,
}: {
  href: string
  label: string
  detail?: string
  compact?: boolean
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      title={detail}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        width: "fit-content",
        padding: compact ? "4px 7px" : "6px 9px",
        border: "1px solid var(--border-strong)",
        borderRadius: 6,
        background: "var(--cream)",
        color: "var(--ink)",
        fontSize: compact ? 11.5 : 12.5,
        fontWeight: 650,
        textDecoration: "none",
      }}
    >
      <Icon name="download" size={compact ? 11 : 12} style={{ color: "var(--ink-3)" }} />
      {label}
    </a>
  )
}

function drawerResumeOriginalSource(
  resume: DrawerDetailRow | undefined,
  artifacts: DrawerDetailRow[],
  preferredArtifactId?: string
): { raw?: string; href?: string } {
  const artifact = drawerResumeArtifactForResume(resume, artifacts, preferredArtifactId)
  const raw = firstCandidateDrawerText(
    resume?.mediaUrl,
    resume?.resumeUrl,
    resume?.sourceUrl,
    resume?.fileUrl,
    artifact?.storageUri,
    artifact?.mediaUrl,
    artifact?.resumeUrl,
    artifact?.sourceUrl
  )
  return { raw, href: candidateDrawerExternalHref(raw) }
}

function drawerResumeArtifactForResume(
  resume: DrawerDetailRow | undefined,
  artifacts: DrawerDetailRow[],
  preferredArtifactId?: string
): DrawerDetailRow | undefined {
  if (preferredArtifactId) {
    const preferred = artifacts.find((artifact) => artifact.id === preferredArtifactId || artifact.resumeId === preferredArtifactId)
    if (preferred) return preferred
  }
  if (resume?.id) {
    const resumeId = String(resume.id)
    const linked = artifacts.find((artifact) => firstCandidateDrawerText(artifact.parsedCandidateResumeId) === resumeId)
    if (linked) return linked
  }
  return artifacts[0]
}

function DrawerExperienceSummary({
  resume,
  loading,
  expanded,
}: {
  resume?: DrawerDetailRow
  loading: boolean
  expanded: boolean
}) {
  if (loading) return <DrawerLoadingText />
  const allExperiences = drawerExperienceRows(resume)
  const visibleCount = candidateDrawerVisibleCount(allExperiences.length, expanded, 5)
  const experiences = allExperiences.slice(0, visibleCount)
  if (experiences.length === 0) return <DrawerEmptyText>No parsed experience rows loaded.</DrawerEmptyText>
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      {experiences.map((exp, index) => (
        <div
          key={`${exp.title}-${exp.company}-${index}`}
          style={{
            paddingBottom: index === experiences.length - 1 ? 0 : 10,
            borderBottom: index === experiences.length - 1 ? undefined : "1px solid var(--border)",
          }}
        >
          <div style={{ fontWeight: 600, color: "var(--ink)", fontSize: 13 }}>
            {exp.title || "Untitled role"}
          </div>
          <div style={{ color: "var(--ink-3)", fontSize: 12, marginTop: 2 }}>
            {[exp.company, exp.location, [exp.startDate, exp.endDate].filter(Boolean).join(" - ")].filter(Boolean).join(" · ")}
          </div>
          {exp.description && (
            <div style={{ color: "var(--ink-2)", fontSize: 12, marginTop: 5, lineHeight: 1.45 }}>
              {previewCandidateDrawerText(
                exp.description,
                candidateDrawerPreviewMax(expanded, 180, 1200)
              )}
            </div>
          )}
        </div>
      ))}
      {!expanded && allExperiences.length > experiences.length && (
        <DrawerEmptyText>{allExperiences.length - experiences.length} more experience rows available. Expand to show them in this modal.</DrawerEmptyText>
      )}
    </div>
  )
}

function DrawerConversationSummary({
  messages,
  turns,
  loading,
  expanded,
}: {
  messages: DrawerDetailRow[]
  turns: DrawerDetailRow[]
  loading: boolean
  expanded: boolean
}) {
  if (loading) return <DrawerLoadingText />
  const visibleMessageCount = candidateDrawerVisibleCount(messages.length, expanded, 5)
  const visibleTurnCount = candidateDrawerVisibleCount(turns.length, expanded, 0)
  const snippets = messages.slice(0, visibleMessageCount).map((message) => ({
    id: message.id,
    role: firstCandidateDrawerText(message.role, message.direction, message.kind) ?? "message",
    text: firstCandidateDrawerText(message.body, message.message, message.text, message.content) ?? previewCandidateDrawerText(message, 160) ?? "",
    at: toIsoLike(message.createdAt) ?? toIsoLike(message.ts) ?? toIsoLike(message.updatedAt),
  })).filter((snippet) => snippet.text)
  const turnSnippets = turns.slice(0, visibleTurnCount).map((turn) => ({
    id: turn.id,
    role: firstCandidateDrawerText(turn.role, turn.kind, turn.source) ?? "turn",
    text: firstCandidateDrawerText(
      turn.text,
      turn.message,
      turn.content,
      turn.prompt,
      turn.reply,
      turn.assistantMessage,
      turn.userMessage,
      turn.decision,
      turn.reason
    ) ?? previewCandidateDrawerText(turn, 220) ?? "",
    at: toIsoLike(turn.createdAt) ?? toIsoLike(turn.ts) ?? toIsoLike(turn.updatedAt),
  })).filter((snippet) => snippet.text)
  if (snippets.length === 0 && turns.length === 0) return <DrawerEmptyText>No conversation rows loaded.</DrawerEmptyText>
  const previewMax = candidateDrawerPreviewMax(expanded, 220, 1200)
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        <StatusPill tone="neutral">{messages.length} messages loaded</StatusPill>
        <StatusPill tone="neutral">{turns.length} turns loaded</StatusPill>
      </div>
      {snippets.length > 0 ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {snippets.map((snippet) => (
            <div key={snippet.id} style={{ fontSize: 12, color: "var(--ink-2)" }}>
              <span style={{ color: "var(--ink-3)", textTransform: "uppercase", fontSize: 10.5, fontWeight: 600 }}>
                {snippet.role}
              </span>
              <span style={{ color: "var(--ink-4)", marginLeft: 6 }}>{relTime(snippet.at)}</span>
              <div style={{ marginTop: 2, lineHeight: 1.45, whiteSpace: "pre-wrap" }}>{previewCandidateDrawerText(snippet.text, previewMax)}</div>
            </div>
          ))}
        </div>
      ) : (
        <DrawerEmptyText>No message snippets loaded.</DrawerEmptyText>
      )}
      {!expanded && messages.length > snippets.length && (
        <DrawerEmptyText>{messages.length - snippets.length} more messages available. Expand to show them in this modal.</DrawerEmptyText>
      )}
      {expanded && turnSnippets.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8, paddingTop: 4 }}>
          <DrawerSectionLabel>Agent turns</DrawerSectionLabel>
          {turnSnippets.map((snippet) => (
            <div key={snippet.id} style={{ fontSize: 12, color: "var(--ink-2)" }}>
              <span style={{ color: "var(--ink-3)", textTransform: "uppercase", fontSize: 10.5, fontWeight: 600 }}>
                {snippet.role}
              </span>
              <span style={{ color: "var(--ink-4)", marginLeft: 6 }}>{relTime(snippet.at)}</span>
              <div style={{ marginTop: 2, lineHeight: 1.45, whiteSpace: "pre-wrap" }}>{previewCandidateDrawerText(snippet.text, previewMax)}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function DrawerPrescreenSummary({
  prescreens,
  jobStates,
  jobLabels,
  loading,
  expanded,
}: {
  prescreens: DrawerDetailRow[]
  jobStates: DrawerDetailRow[]
  jobLabels: Record<string, string>
  loading: boolean
  expanded: boolean
}) {
  if (loading) return <DrawerLoadingText />
  if (prescreens.length === 0 && jobStates.length === 0) {
    return <DrawerEmptyText>No prescreen or job-state rows loaded.</DrawerEmptyText>
  }
  const visiblePrescreenCount = candidateDrawerVisibleCount(prescreens.length, expanded, 6)
  const showJobStates = expanded || prescreens.length === 0
  const visibleJobStateCount = showJobStates ? candidateDrawerVisibleCount(jobStates.length, expanded, 5) : 0
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      {prescreens.slice(0, visiblePrescreenCount).map((session) => {
        const jobId = firstCandidateDrawerText(session.jobId)
        const terminal = firstCandidateDrawerText(session.terminal, session.review && typeof session.review === "object" ? (session.review as Record<string, unknown>).finalTerminal : undefined)
        const score = drawerScoreLabel(session)
        return (
          <div key={session.id} style={{ borderBottom: "1px solid var(--border)", paddingBottom: 9 }}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "flex-start" }}>
              <AdminPrescreenSessionLink sessionId={session.id} style={{ color: "var(--ink)", fontWeight: 600, fontSize: 13 }}>
                {jobId ? jobLabels[jobId] ?? shortUid(jobId) : shortUid(session.id)}
              </AdminPrescreenSessionLink>
              <StatusPill tone={terminal === "PASS" ? "live" : terminal ? "hitl" : "neutral"}>
                {terminal || "in progress"}
              </StatusPill>
            </div>
            <div style={{ marginTop: 4, color: "var(--ink-3)", fontSize: 12 }}>
              {[score, relTime(toIsoLike(session.updatedAt) ?? toIsoLike(session.createdAt))].filter(Boolean).join(" · ")}
            </div>
            {session.terminalActionPendingReview === true && (
              <div style={{ marginTop: 4 }}>
                <StatusPill tone="hitl">Pending review</StatusPill>
              </div>
            )}
            {expanded && (
              <div style={{ marginTop: 5, color: "var(--ink-3)", fontSize: 11.5, fontFamily: "var(--font-mono)" }}>
                {session.id}
              </div>
            )}
          </div>
        )
      })}
      {!expanded && prescreens.length > visiblePrescreenCount && <DrawerEmptyText>{prescreens.length - visiblePrescreenCount} more prescreen sessions available. Expand to show them in this modal.</DrawerEmptyText>}
      {showJobStates && jobStates.length > 0 && prescreens.length > 0 && <DrawerSectionLabel>Candidate job states</DrawerSectionLabel>}
      {jobStates.slice(0, visibleJobStateCount).map((state) => {
        const jobId = firstCandidateDrawerText(state.jobId)
        return (
          <DrawerKV
            key={state.id}
            k={jobId ? jobLabels[jobId] ?? shortUid(jobId) : shortUid(state.id)}
            v={firstCandidateDrawerText(state.state, state.lifecycleState, state.status) ?? "—"}
          />
        )
      })}
      {!expanded && showJobStates && jobStates.length > visibleJobStateCount && <DrawerEmptyText>{jobStates.length - visibleJobStateCount} more job-state rows available. Expand to show them in this modal.</DrawerEmptyText>}
    </div>
  )
}

function emptyCandidateDrawerDetail(): CandidateDrawerDetail {
  return {
    resumes: [],
    resumeArtifacts: [],
    prescreens: [],
    messages: [],
    turns: [],
    jobStates: [],
    jobLabels: {},
  }
}

async function loadCandidateDrawerDetail(candidateId: string, latestResumeArtifactId?: string): Promise<CandidateDrawerDetail> {
  const [resumeSnap, resumeArtifactSnap, latestResumeArtifactSnap, prescreenSnap, messageSnap, turnSnap, jobStateSnap] = await Promise.all([
    getDocs(query(collection(db(), "parsedCandidateResumes"), where("userId", "==", candidateId))),
    getDocs(query(collection(db(), PA_COLLECTIONS.resumeArtifacts), where("candidateId", "==", candidateId))),
    latestResumeArtifactId
      ? getDoc(firestoreDoc(db(), PA_COLLECTIONS.resumeArtifacts, latestResumeArtifactId))
      : Promise.resolve(null),
    getDocs(query(collection(db(), "pa-prescreen-sessions"), where("userId", "==", candidateId))),
    getDocs(query(collection(db(), PA_COLLECTIONS.messages), where("userId", "==", candidateId))),
    getDocs(query(collection(db(), PA_COLLECTIONS.agentTurns), where("userId", "==", candidateId))),
    getDocs(query(collection(db(), PA_COLLECTIONS.candidateJobStates), where("candidateId", "==", candidateId))),
  ])
  const resumes = sortCandidateDrawerRows(
    resumeSnap.docs.map((snap) => ({ id: snap.id, ...snap.data() }) as DrawerDetailRow),
    ["updatedAt", "createdAt", "ingestedAt", "parsedAt"]
  )
  const resumeArtifactRows = resumeArtifactSnap.docs.map((snap) => ({ id: snap.id, ...snap.data() }) as DrawerDetailRow)
  if (latestResumeArtifactSnap?.exists() && !resumeArtifactRows.some((row) => row.id === latestResumeArtifactSnap.id)) {
    resumeArtifactRows.push({ id: latestResumeArtifactSnap.id, ...latestResumeArtifactSnap.data() } as DrawerDetailRow)
  }
  const resumeArtifacts = sortCandidateDrawerRows(resumeArtifactRows, ["updatedAt", "createdAt"])
  const prescreens = sortCandidateDrawerRows(
    prescreenSnap.docs.map((snap) => ({ id: snap.id, ...snap.data() }) as DrawerDetailRow),
    ["updatedAt", "createdAt", "startedAt"]
  )
  const messages = sortCandidateDrawerRows(
    messageSnap.docs.map((snap) => ({ id: snap.id, ...snap.data() }) as DrawerDetailRow),
    ["createdAt", "ts", "updatedAt"]
  )
  const turns = sortCandidateDrawerRows(
    turnSnap.docs.map((snap) => ({ id: snap.id, ...snap.data() }) as DrawerDetailRow),
    ["createdAt", "updatedAt", "ts"]
  )
  const jobStates = sortCandidateDrawerRows(
    jobStateSnap.docs.map((snap) => ({ id: snap.id, ...snap.data() }) as DrawerDetailRow),
    ["updatedAt", "stateUpdatedAt", "createdAt"]
  )
  const jobIds = uniqueStrings([
    ...prescreens.map((row) => firstCandidateDrawerText(row["jobId"])),
    ...jobStates.map((row) => firstCandidateDrawerText(row["jobId"])),
  ])
  const jobLabels = Object.fromEntries(await Promise.all(jobIds.map(loadJobLabel)))
  return { resumes, resumeArtifacts, prescreens, messages, turns, jobStates, jobLabels }
}

async function loadJobLabel(jobId: string): Promise<[string, string]> {
  try {
    const snap = await getDoc(firestoreDoc(db(), PA_COLLECTIONS.jobs, jobId))
    if (!snap.exists()) return [jobId, shortUid(jobId)]
    const data = snap.data() as Record<string, unknown>
    const company = firstCandidateDrawerText(data.companyName, data.company, data.employerName)
    const title = firstCandidateDrawerText(data.title, data.roleTitle, data.jobTitle, data.name) ?? shortUid(jobId)
    return [jobId, company ? `${title} · ${company}` : title]
  } catch {
    return [jobId, shortUid(jobId)]
  }
}

function uniqueStrings(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))]
}

function readNested(value: unknown, path: string[]): unknown {
  let current = value
  for (const part of path) {
    if (!current || typeof current !== "object") return undefined
    current = (current as Record<string, unknown>)[part]
  }
  return current
}

function drawerStringList(value: unknown): string[] {
  if (typeof value === "string") return value.trim() ? [value.trim()] : []
  if (Array.isArray(value)) {
    return value.flatMap((item) => {
      if (typeof item === "string") return item.trim() ? [item.trim()] : []
      if (!item || typeof item !== "object") return []
      const record = item as Record<string, unknown>
      const label = firstCandidateDrawerText(record.value, record.label, record.name, record.title, record.canonical)
      return label ? [label] : []
    })
  }
  if (value && typeof value === "object") {
    return Object.entries(value as Record<string, unknown>)
      .filter(([, enabled]) => Boolean(enabled))
      .map(([key]) => key)
  }
  return []
}

type DrawerExperienceRow = {
  title?: string
  company?: string
  location?: string
  startDate?: string
  endDate?: string
  description?: string
}

function drawerExperienceRows(resume: DrawerDetailRow | undefined): DrawerExperienceRow[] {
  const source =
    (Array.isArray(resume?.experiences) && resume?.experiences) ||
    (Array.isArray(resume?.workHistory) && resume?.workHistory) ||
    (Array.isArray(readNested(resume, ["candidateProfile", "experiences"])) && readNested(resume, ["candidateProfile", "experiences"])) ||
    (Array.isArray(readNested(resume, ["candidateProfile", "workHistory"])) && readNested(resume, ["candidateProfile", "workHistory"])) ||
    []
  return (source as unknown[]).filter((item) => item && typeof item === "object").map((item) => {
    const record = item as Record<string, unknown>
    return {
      title: firstCandidateDrawerText(record.title, record.role, record.position),
      company: firstCandidateDrawerText(record.company, record.companyName, record.employer),
      location: firstCandidateDrawerText(record.location),
      startDate: firstCandidateDrawerText(record.startDate, record.start, record.from),
      endDate: firstCandidateDrawerText(record.endDate, record.end, record.to) ?? (record.currentRole === true ? "Present" : undefined),
      description: firstCandidateDrawerText(record.description, record.summary) ?? drawerStringList(record.bullets).join(" "),
    }
  })
}

function drawerScoreLabel(session: DrawerDetailRow): string | undefined {
  const score = typeof session.score === "number" ? session.score : undefined
  const scoreMax = typeof session.scoreMax === "number" ? session.scoreMax : undefined
  if (score === undefined || scoreMax === undefined || scoreMax === 0) return undefined
  return `${Math.round((score / scoreMax) * 100)}% score`
}

function DrawerChipList({ values }: { values: string[] }) {
  return (
    <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
      {values.map((value) => <TagChip key={value}>{value}</TagChip>)}
    </div>
  )
}

function DrawerLoadingText() {
  return <div style={{ color: "var(--ink-3)", fontSize: 12.5 }}>Loading...</div>
}

function DrawerEmptyText({ children }: { children: React.ReactNode }) {
  return <div style={{ color: "var(--ink-3)", fontSize: 12.5 }}>{children}</div>
}

function DrawerInlineLink({ to, children }: { to: string; children: React.ReactNode }) {
  return (
    <Link to={to} style={{ color: "var(--ink-2)", fontSize: 12, textDecoration: "none", fontWeight: 600 }}>
      {children}
    </Link>
  )
}

function toIsoLike(v: unknown): string | undefined {
  if (!v) return undefined
  if (typeof v === "string") return v
  if (typeof v === "number" && Number.isFinite(v)) return new Date(v).toISOString()
  if (typeof v === "object") {
    const record = v as { seconds?: unknown; toDate?: unknown; toMillis?: unknown }
    if (typeof record.toDate === "function") {
      const date = record.toDate()
      return date instanceof Date ? date.toISOString() : undefined
    }
    if (typeof record.toMillis === "function") {
      const millis = record.toMillis()
      return typeof millis === "number" ? new Date(millis).toISOString() : undefined
    }
    if (typeof record.seconds === "number") return new Date(record.seconds * 1000).toISOString()
  }
  return undefined
}

function DrawerSectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ fontSize: 10.5, letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--ink-3)", fontWeight: 600, marginBottom: 4 }}>
      {children}
    </div>
  )
}

function TagChip({ children }: { children: React.ReactNode }) {
  return (
    <span style={{ display: "inline-block", padding: "2px 8px", borderRadius: 4, background: "var(--cream)", border: "1px solid var(--border)", fontSize: 11.5, color: "var(--ink-2)" }}>
      {children}
    </span>
  )
}

function DrawerKV({
  k,
  v,
  mono,
}: {
  k: string
  v: React.ReactNode
  mono?: boolean
}) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "120px 1fr",
        gap: 12,
        padding: "6px 0",
        borderBottom: "1px solid var(--border)",
        fontSize: 13,
      }}
    >
      <span style={{ color: "var(--ink-3)" }}>{k}</span>
      <span style={{ color: "var(--ink)", fontFamily: mono ? "var(--font-mono)" : undefined }}>
        {v}
      </span>
    </div>
  )
}

function DrawerLink({
  to,
  label,
  icon,
}: {
  to: string
  label: string
  icon: string
}) {
  return (
    <Link
      to={to}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "8px 10px",
        border: "1px solid var(--border)",
        borderRadius: 6,
        textDecoration: "none",
        color: "var(--ink)",
        fontSize: 13,
        background: "var(--cream-3)",
      }}
    >
      <Icon name={icon} size={13} style={{ color: "var(--ink-3)" }} />
      <span style={{ flex: 1 }}>{label}</span>
      <Icon name="arrow_right" size={12} style={{ color: "var(--ink-3)" }} />
    </Link>
  )
}
