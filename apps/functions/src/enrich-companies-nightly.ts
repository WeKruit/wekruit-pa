/**
 * Phase A5 (post-v1.7) — `paEnrichCompaniesNightly` + `paEnrichCompaniesAdHoc`.
 *
 * Centralized `pa-companies/{id}` enrichment cascade. Free-tier-first.
 * Per-company source priority: YC list → Wikidata SPARQL → Clearbit free
 * (quota-tracked) → Anthropic Sonnet with web_search tool (last resort).
 *
 * Schedule: Tue 04:00 UTC weekly. Ad-hoc admin callable mirrors same logic.
 *
 * Never overwrites docs where `lastReviewedBy != null` (Adam manual override).
 *
 * REQ-IDs: GOAL-company-tier-yc-match.md Phase A5
 *
 * Architecture: pure logic in `runEnrichmentBatch` (deps-injected). The
 * onSchedule + onCall wrappers at the bottom are thin shims that wire
 * production deps (Firestore + real fetch).
 */

import { onSchedule } from "firebase-functions/v2/scheduler"
import { onCall, HttpsError } from "firebase-functions/v2/https"
import { defineSecret } from "firebase-functions/params"
import { logger } from "firebase-functions/v2"
import { getFirestore, type Firestore } from "firebase-admin/firestore"

import {
  normalizeCompanyName,
  type PaCompany,
  type CompanyEnrichmentSource,
} from "@pa/core-types"
import {
  COMPANY_STAGE_VOCAB,
  COMPANY_TAG_VOCAB,
  type CompanyStage,
  type CompanyTag,
} from "@wekruit/shared-tags"

import { authorizeAdminCallable } from "./promote-sandbox-tag.js"
import { ANTHROPIC_API_KEY } from "./orchestrator-deps.js"

// ---------------------------------------------------------------------------
// Secrets (Firebase v2 params) — declared once so the wrapper can list them.
// ---------------------------------------------------------------------------

const PA_ADMIN_TOKEN = defineSecret("PA_ADMIN_TOKEN")
const CLEARBIT_KEY = defineSecret("CLEARBIT_KEY")

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

export const DEFAULT_LIMIT = 200
export const STALE_AFTER_MS = 30 * 24 * 3600 * 1000 // 30d
export const CLEARBIT_MONTHLY_CAP = 45 // halt 5 below the 50/mo free tier
export const CLEARBIT_RESET_DAYS = 30
export const YC_CACHE_DOC = "pa-companies-source/yc-cache"
export const CLEARBIT_QUOTA_DOC = "pa-companies-source/clearbit-quota"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type YcCachedCompany = {
  slug?: string
  name: string
  batch?: string | null
  status?: string | null
  industry?: string | null
  hq_country?: string | null
  website?: string | null
  one_liner?: string | null
}

export type YcCache = {
  companies: YcCachedCompany[]
  fetchedAt?: string
}

export type ClearbitQuota = {
  count: number
  windowStartedAt: string // ISO
}

export type EnrichmentResult = {
  stage: CompanyStage
  tags: CompanyTag[]
  source: CompanyEnrichmentSource | "unknown"
  /** Optional partial-field updates harvested as side-effects. */
  patch?: Partial<
    Pick<
      PaCompany,
      | "domain"
      | "logoUrl"
      | "hqLocation"
      | "employeeRange"
      | "industry"
      | "displayName"
      | "fundingRounds"
    >
  >
}

export type EnrichDeps = {
  /** Resolves the YC cache snapshot (already JSON-parsed). */
  loadYcCache: () => Promise<YcCache | null>
  /** Wikidata SPARQL probe. Returns null on miss. */
  probeWikidata: (name: string) => Promise<EnrichmentResult | null>
  /** Clearbit enrichment probe. Returns null on miss / disabled. */
  probeClearbit: (name: string) => Promise<EnrichmentResult | null>
  /** Anthropic LLM (web_search) probe. Returns null on miss / disabled. */
  probeLlm: (name: string) => Promise<EnrichmentResult | null>
  /** Resolve names to enrich. Caller-owned because the staleness query is
   *  Firestore-shaped. */
  resolveCandidateNames: (mode: "explicit" | "all_stale", explicit: string[], limit: number) => Promise<string[]>
  /** Read existing pa-companies doc — used to short-circuit on lastReviewedBy. */
  readExisting: (id: string) => Promise<Partial<PaCompany> | null>
  /** Merge-write pa-companies/{id}. */
  writeCompany: (id: string, data: Partial<PaCompany>) => Promise<void>
  /** Increment the Clearbit monthly counter. Returns the new count. */
  bumpClearbitQuota: () => Promise<number>
  /** Current monthly counter (without incrementing). */
  readClearbitQuota: () => Promise<ClearbitQuota | null>
  now: () => number
  log?: (msg: string, ctx?: Record<string, unknown>) => void
  errorLog?: (msg: string, ctx?: Record<string, unknown>) => void
}

export type EnrichmentCounters = {
  candidates: number
  processed: number
  skipped_reviewed: number
  yc_hits: number
  wikidata_hits: number
  clearbit_hits: number
  llm_hits: number
  unknown: number
  errors: number
  clearbit_quota_blocked: number
}

export function emptyCounters(): EnrichmentCounters {
  return {
    candidates: 0,
    processed: 0,
    skipped_reviewed: 0,
    yc_hits: 0,
    wikidata_hits: 0,
    clearbit_hits: 0,
    llm_hits: 0,
    unknown: 0,
    errors: 0,
    clearbit_quota_blocked: 0,
  }
}

// ---------------------------------------------------------------------------
// YC list lookup
// ---------------------------------------------------------------------------

/** Crude batch-year extractor: "W21" → 2021, "S15" → 2015. */
export function ycBatchYear(batch: string | null | undefined): number | null {
  if (!batch) return null
  const m = /^[WS](\d{2})$/i.exec(batch.trim())
  if (!m) return null
  const yy = parseInt(m[1], 10)
  if (!Number.isFinite(yy)) return null
  return 2000 + yy
}

/**
 * Derive a CompanyStage from YC metadata. Heuristic — Adam can manually
 * override post-hoc via the dashboard (Phase A4).
 */
export function deriveYcStage(co: YcCachedCompany, now: Date): CompanyStage {
  const status = (co.status ?? "").toLowerCase().trim()
  const year = ycBatchYear(co.batch)
  const ageYears = year !== null ? now.getUTCFullYear() - year : null

  if (status === "acquired" || status === "public") {
    if (ageYears !== null && ageYears >= 8) return "private_mature"
    return "series_a"
  }
  if (status === "dead" || status === "inactive") return "unknown"

  if (ageYears === null) return "seed"
  if (ageYears <= 1) return "seed"
  if (ageYears <= 4) return "series_a"
  if (ageYears <= 7) return "series_b"
  return "private_mature"
}

/** Derive companyTags from YC metadata (seed-vocab tokens). */
export function deriveYcTags(co: YcCachedCompany, now: Date): CompanyTag[] {
  const tags: Set<CompanyTag> = new Set()
  const status = (co.status ?? "").toLowerCase().trim()
  const year = ycBatchYear(co.batch)
  if (status === "active") tags.add("yc_active")
  if (status !== "active" || (year !== null && now.getUTCFullYear() - year >= 3)) {
    tags.add("yc_alumni")
  }
  const industry = (co.industry ?? "").toLowerCase()
  if (industry.includes("fintech")) tags.add("fintech_unicorn")
  if (industry.includes("crypto") || industry.includes("web3")) tags.add("crypto_web3")
  if (industry.includes("ai") || industry.includes("ml") || industry.includes("artificial intelligence")) {
    tags.add("ai_native")
  }
  return Array.from(tags)
}

/** Look up a (normalized) company name in the cached YC directory. */
export function lookupYc(cache: YcCache | null, normalized: string): YcCachedCompany | null {
  if (!cache || !Array.isArray(cache.companies)) return null
  for (const co of cache.companies) {
    if (typeof co.name !== "string") continue
    if (normalizeCompanyName(co.name) === normalized) return co
    if (typeof co.slug === "string" && normalizeCompanyName(co.slug) === normalized) return co
  }
  return null
}

export function ycResultFor(co: YcCachedCompany, now: Date): EnrichmentResult {
  const stage = deriveYcStage(co, now)
  const tags = deriveYcTags(co, now)
  const patch: EnrichmentResult["patch"] = {}
  if (typeof co.name === "string" && co.name.trim()) patch.displayName = co.name.trim()
  if (typeof co.website === "string" && co.website.trim()) {
    try {
      const u = new URL(co.website.trim())
      patch.domain = u.hostname.replace(/^www\./, "")
      patch.logoUrl = `https://logo.clearbit.com/${patch.domain}`
    } catch {
      // ignore malformed
    }
  }
  if (typeof co.industry === "string" && co.industry.trim()) patch.industry = co.industry.trim()
  if (typeof co.hq_country === "string" && co.hq_country.trim()) patch.hqLocation = co.hq_country.trim()
  return { stage, tags, source: "yc", patch }
}

// ---------------------------------------------------------------------------
// Wikidata SPARQL probe (production implementation)
// ---------------------------------------------------------------------------

const WIKIDATA_ENDPOINT = "https://query.wikidata.org/sparql"

export function buildWikidataQuery(name: string): string {
  const safe = name.replace(/"/g, '\\"')
  return `
SELECT ?co ?coLabel ?employees ?founded ?listed ?website ?industryLabel WHERE {
  ?co rdfs:label "${safe}"@en .
  ?co wdt:P31/wdt:P279* wd:Q4830453 .
  OPTIONAL { ?co wdt:P1128 ?employees . }
  OPTIONAL { ?co wdt:P571 ?founded . }
  OPTIONAL { ?co wdt:P414 ?listed . }
  OPTIONAL { ?co wdt:P856 ?website . }
  OPTIONAL { ?co wdt:P452 ?industry . }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
} LIMIT 5`
}

export function parseWikidataResponse(
  json: unknown,
  now: Date
): EnrichmentResult | null {
  if (!json || typeof json !== "object") return null
  const results = (json as Record<string, unknown>).results
  if (!results || typeof results !== "object") return null
  const bindings = (results as Record<string, unknown>).bindings
  if (!Array.isArray(bindings) || bindings.length === 0) return null

  const b = bindings[0] as Record<string, { value?: string } | undefined>
  const employeesRaw = b.employees?.value
  const founded = b.founded?.value
  const listed = b.listed?.value
  const website = b.website?.value
  const industry = b.industryLabel?.value

  const employees = employeesRaw ? parseInt(employeesRaw, 10) : null
  let stage: CompanyStage = "unknown"

  if (listed) {
    stage = "ipo_public"
  } else if (employees !== null && Number.isFinite(employees)) {
    if (employees >= 5000) stage = "private_mature"
    else if (employees >= 1000) stage = "series_d_plus"
    else if (employees >= 250) stage = "series_c"
    else if (employees >= 75) stage = "series_b"
    else if (employees >= 25) stage = "series_a"
    else stage = "seed"
  } else if (founded) {
    const year = parseInt(founded.slice(0, 4), 10)
    if (Number.isFinite(year)) {
      const age = now.getUTCFullYear() - year
      if (age >= 20) stage = "private_mature"
      else if (age >= 10) stage = "series_c"
      else if (age >= 5) stage = "series_b"
      else stage = "seed"
    }
  }

  const tags: CompanyTag[] = []
  if (listed) tags.push("big_tech")
  if (typeof industry === "string") {
    const ind = industry.toLowerCase()
    if (ind.includes("fintech") || ind.includes("financial")) tags.push("fintech_unicorn")
    if (ind.includes("crypto") || ind.includes("blockchain")) tags.push("crypto_web3")
    if (ind.includes("artificial intelligence") || ind.includes("machine learning")) {
      tags.push("ai_native")
    }
  }

  const patch: EnrichmentResult["patch"] = {}
  if (website) {
    try {
      const u = new URL(website)
      patch.domain = u.hostname.replace(/^www\./, "")
      patch.logoUrl = `https://logo.clearbit.com/${patch.domain}`
    } catch {
      // ignore
    }
  }
  if (typeof industry === "string") patch.industry = industry
  if (employees !== null && Number.isFinite(employees)) {
    patch.employeeRange = bucketEmployeeCount(employees)
  }

  return { stage, tags, source: "wikidata", patch }
}

function bucketEmployeeCount(n: number): string {
  if (n <= 10) return "1-10"
  if (n <= 50) return "11-50"
  if (n <= 200) return "51-200"
  if (n <= 500) return "201-500"
  if (n <= 1000) return "501-1000"
  if (n <= 5000) return "1001-5000"
  if (n <= 10000) return "5001-10000"
  return "10001+"
}

export async function probeWikidataProd(
  name: string,
  fetchImpl: typeof fetch = globalThis.fetch
): Promise<EnrichmentResult | null> {
  const query = buildWikidataQuery(name)
  const url = `${WIKIDATA_ENDPOINT}?query=${encodeURIComponent(query)}&format=json`
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 8000)
  try {
    const res = await fetchImpl(url, {
      headers: {
        Accept: "application/sparql-results+json",
        "User-Agent": "wekruit-pa-enrich/1.0 (admin1@wekruit.com)",
      },
      signal: ctrl.signal,
    })
    if (!res.ok) return null
    const json = (await res.json()) as unknown
    return parseWikidataResponse(json, new Date())
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

// ---------------------------------------------------------------------------
// Clearbit Enrichment (free 50/mo)
// ---------------------------------------------------------------------------

export function guessDomain(displayName: string): string {
  return `${displayName.toLowerCase().replace(/[^a-z0-9]+/g, "")}.com`
}

export type ClearbitProbeOpts = {
  name: string
  domain?: string
  apiKey: string
  fetchImpl?: typeof fetch
}

export async function probeClearbitProd(
  opts: ClearbitProbeOpts
): Promise<EnrichmentResult | null> {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch
  const domain = opts.domain ?? guessDomain(opts.name)
  const url = `https://company.clearbit.com/v2/companies/find?domain=${encodeURIComponent(domain)}`
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 8000)
  try {
    const res = await fetchImpl(url, {
      headers: {
        Authorization: `Bearer ${opts.apiKey}`,
        Accept: "application/json",
      },
      signal: ctrl.signal,
    })
    if (!res.ok) return null
    const json = (await res.json()) as Record<string, unknown>
    return parseClearbitResponse(json)
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

export function parseClearbitResponse(json: Record<string, unknown>): EnrichmentResult | null {
  if (!json || typeof json !== "object") return null
  const name = typeof json.name === "string" ? json.name : null
  const domain = typeof json.domain === "string" ? json.domain : null
  const metrics = (json.metrics ?? {}) as Record<string, unknown>
  const employees = typeof metrics.employees === "number" ? metrics.employees : null
  const annualRevenue =
    typeof metrics.estimatedAnnualRevenue === "number" ? metrics.estimatedAnnualRevenue : null
  const tagsRaw = Array.isArray(json.tags) ? (json.tags as unknown[]) : []
  const tagsRawStr = tagsRaw.filter((t): t is string => typeof t === "string")

  let stage: CompanyStage = "unknown"
  if (employees !== null) {
    if (employees >= 5000) stage = "private_mature"
    else if (employees >= 1000) stage = "series_d_plus"
    else if (employees >= 250) stage = "series_c"
    else if (employees >= 75) stage = "series_b"
    else if (employees >= 25) stage = "series_a"
    else stage = "seed"
  }
  if (annualRevenue !== null && annualRevenue >= 1_000_000_000) {
    if (stage === "unknown" || stage === "seed") stage = "series_c"
  }

  const tags: CompanyTag[] = []
  const joinedTags = tagsRawStr.map((t) => t.toLowerCase()).join(" ")
  if (joinedTags.includes("artificial intelligence") || joinedTags.includes("machine learning")) {
    tags.push("ai_native")
  }
  if (joinedTags.includes("financial services") || joinedTags.includes("fintech")) {
    tags.push("fintech_unicorn")
  }
  if (joinedTags.includes("crypto") || joinedTags.includes("blockchain")) {
    tags.push("crypto_web3")
  }
  if (joinedTags.includes("retail")) tags.push("retail_ops")

  if (!name && !domain && stage === "unknown" && tags.length === 0) return null

  const patch: EnrichmentResult["patch"] = {}
  if (name) patch.displayName = name
  if (domain) {
    patch.domain = domain
    patch.logoUrl = `https://logo.clearbit.com/${domain}`
  }
  if (employees !== null) patch.employeeRange = bucketEmployeeCount(employees)
  if (typeof json.category === "object" && json.category) {
    const cat = json.category as Record<string, unknown>
    if (typeof cat.industry === "string") patch.industry = cat.industry
  }

  return { stage, tags, source: "clearbit", patch }
}

// ---------------------------------------------------------------------------
// LLM probe (Anthropic Sonnet + web_search)
// ---------------------------------------------------------------------------

const LLM_SYSTEM_PROMPT = `You are a research assistant classifying companies.
You will be given a company name. Search the web and respond with ONLY a JSON object:
{"stage":"<one of: ${COMPANY_STAGE_VOCAB.join("|")}>","tags":["..."]}
The "tags" array MUST be lowercase snake_case tokens, max 5 items, drawn primarily
from this seed vocab: ${COMPANY_TAG_VOCAB.join(", ")}. You MAY add new tokens
following the same format if they describe the company better. If unsure, set
stage="unknown" and tags=[]. Output JSON only, no prose.`

export async function probeLlmProd(
  name: string,
  apiKey: string
): Promise<EnrichmentResult | null> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mod = (await import("@anthropic-ai/sdk")) as any
    const client = new mod.default({ apiKey })
    const res = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 600,
      system: LLM_SYSTEM_PROMPT,
      tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 3 }],
      messages: [{ role: "user", content: `Company: ${name}` }],
    })
    return parseLlmReply(res, name)
  } catch (err) {
    logger.warn("[enrich-companies] llm_failed", {
      name,
      error: err instanceof Error ? err.message : String(err),
    })
    return null
  }
}

export function parseLlmReply(res: unknown, _name: string): EnrichmentResult | null {
  if (!res || typeof res !== "object") return null
  const content = (res as Record<string, unknown>).content
  if (!Array.isArray(content)) return null
  let text = ""
  for (const block of content) {
    if (block && typeof block === "object") {
      const b = block as Record<string, unknown>
      if (b.type === "text" && typeof b.text === "string") text += b.text
    }
  }
  text = text.trim()
  const m = /\{[\s\S]*\}/.exec(text)
  if (!m) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(m[0])
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== "object") return null
  const p = parsed as Record<string, unknown>
  const stageStr = typeof p.stage === "string" ? p.stage : "unknown"
  const stage = (COMPANY_STAGE_VOCAB as readonly string[]).includes(stageStr)
    ? (stageStr as CompanyStage)
    : "unknown"
  const tagsRaw = Array.isArray(p.tags) ? p.tags : []
  const tags: CompanyTag[] = []
  for (const t of tagsRaw) {
    if (typeof t !== "string") continue
    const trimmed = t.trim().toLowerCase()
    if (/^[a-z][a-z0-9_]{1,63}$/.test(trimmed)) tags.push(trimmed)
    if (tags.length >= 5) break
  }
  return { stage, tags, source: "llm" }
}

// ---------------------------------------------------------------------------
// Core cascade
// ---------------------------------------------------------------------------

export async function enrichOneCompany(
  rawName: string,
  deps: EnrichDeps,
  counters: EnrichmentCounters,
  ycCache: YcCache | null
): Promise<EnrichmentResult> {
  const normalized = normalizeCompanyName(rawName)
  const now = new Date(deps.now())

  const ycCo = lookupYc(ycCache, normalized)
  if (ycCo) {
    const r = ycResultFor(ycCo, now)
    if (r.stage !== "unknown" || r.tags.length > 0) {
      counters.yc_hits++
      return r
    }
  }

  try {
    const r = await deps.probeWikidata(rawName)
    if (r && (r.stage !== "unknown" || r.tags.length > 0)) {
      counters.wikidata_hits++
      return r
    }
  } catch (err) {
    counters.errors++
    deps.errorLog?.("wikidata_probe_threw", {
      name: rawName,
      error: err instanceof Error ? err.message : String(err),
    })
  }

  try {
    const r = await deps.probeClearbit(rawName)
    if (r && (r.stage !== "unknown" || r.tags.length > 0)) {
      counters.clearbit_hits++
      return r
    }
  } catch (err) {
    counters.errors++
    deps.errorLog?.("clearbit_probe_threw", {
      name: rawName,
      error: err instanceof Error ? err.message : String(err),
    })
  }

  try {
    const r = await deps.probeLlm(rawName)
    if (r && (r.stage !== "unknown" || r.tags.length > 0)) {
      counters.llm_hits++
      return r
    }
  } catch (err) {
    counters.errors++
    deps.errorLog?.("llm_probe_threw", {
      name: rawName,
      error: err instanceof Error ? err.message : String(err),
    })
  }

  counters.unknown++
  return { stage: "unknown", tags: [], source: "unknown" }
}

export function buildCompanyDoc(
  rawName: string,
  result: EnrichmentResult,
  existing: Partial<PaCompany> | null,
  nowIso: string
): Partial<PaCompany> {
  const normalized = normalizeCompanyName(rawName)
  const doc: Partial<PaCompany> = {
    id: normalized,
    normalizedName: normalized,
    displayName: result.patch?.displayName ?? existing?.displayName ?? rawName.trim(),
    companyStage: result.stage,
    companyTags: result.tags,
    enrichmentSource: result.source === "unknown" ? "llm" : result.source,
    enrichedAt: nowIso,
    updatedAt: nowIso,
  }
  if (result.source === "unknown") {
    doc.enrichmentSource = (existing?.enrichmentSource as CompanyEnrichmentSource | undefined) ?? "manual"
  }

  if (result.patch) {
    if (result.patch.domain) doc.domain = result.patch.domain
    if (result.patch.logoUrl) doc.logoUrl = result.patch.logoUrl
    if (result.patch.hqLocation) doc.hqLocation = result.patch.hqLocation
    if (result.patch.employeeRange) doc.employeeRange = result.patch.employeeRange
    if (result.patch.industry) doc.industry = result.patch.industry
    if (result.patch.fundingRounds) doc.fundingRounds = result.patch.fundingRounds
  }

  if (!existing?.createdAt) doc.createdAt = nowIso

  if (existing?.lastReviewedBy !== undefined) doc.lastReviewedBy = existing.lastReviewedBy ?? null
  else doc.lastReviewedBy = null

  if (doc.domain === undefined && existing?.domain === undefined) doc.domain = null
  if (doc.logoUrl === undefined && existing?.logoUrl === undefined) doc.logoUrl = null
  if (doc.hqLocation === undefined && existing?.hqLocation === undefined) doc.hqLocation = null
  if (doc.employeeRange === undefined && existing?.employeeRange === undefined) doc.employeeRange = null
  if (doc.industry === undefined && existing?.industry === undefined) doc.industry = null

  return doc
}

export async function runEnrichmentBatch(
  mode: "explicit" | "all_stale",
  explicitNames: string[],
  limit: number,
  deps: EnrichDeps
): Promise<EnrichmentCounters> {
  const counters = emptyCounters()
  const log = deps.log ?? (() => {})

  const candidates = await deps.resolveCandidateNames(mode, explicitNames, limit)
  counters.candidates = candidates.length
  log("enrich_batch_start", { mode, candidates: candidates.length, limit })

  const ycCache = await deps.loadYcCache().catch((err) => {
    deps.errorLog?.("yc_cache_load_failed", {
      error: err instanceof Error ? err.message : String(err),
    })
    return null
  })

  for (const rawName of candidates) {
    const trimmed = rawName.trim()
    if (!trimmed) continue
    const normalized = normalizeCompanyName(trimmed)
    if (!normalized) continue

    try {
      const existing = await deps.readExisting(normalized)
      if (existing?.lastReviewedBy) {
        counters.skipped_reviewed++
        continue
      }

      const result = await enrichOneCompany(trimmed, deps, counters, ycCache)
      counters.processed++

      const nowIso = new Date(deps.now()).toISOString()
      const docPayload = buildCompanyDoc(trimmed, result, existing, nowIso)
      await deps.writeCompany(normalized, docPayload)
    } catch (err) {
      counters.errors++
      deps.errorLog?.("enrich_one_failed", {
        name: trimmed,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  log("enrich_batch_done", { ...counters })
  return counters
}

// ---------------------------------------------------------------------------
// Production Firestore-backed deps
// ---------------------------------------------------------------------------

async function resolveStaleNamesProd(
  db: Firestore,
  limit: number,
  nowMs: number
): Promise<string[]> {
  const cutoffIso = new Date(nowMs - STALE_AFTER_MS).toISOString()
  const seenNormalized = new Set<string>()
  const out: string[] = []

  let lastId: string | null = null
  const PAGE = 1000
  const HARD_CAP_PAGES = 20
  for (let i = 0; i < HARD_CAP_PAGES; i++) {
    if (out.length >= limit) break
    let q = db.collection("matching-jobs").orderBy("__name__").limit(PAGE)
    if (lastId) q = q.startAfter(lastId)
    const snap = await q.get()
    if (snap.empty) break

    for (const d of snap.docs) {
      const raw = d.data() as Record<string, unknown>
      const cn = typeof raw.companyName === "string" ? raw.companyName.trim() : ""
      if (!cn) continue
      const norm = normalizeCompanyName(cn)
      if (!norm || seenNormalized.has(norm)) continue
      seenNormalized.add(norm)

      const existing = await db.collection("pa-companies").doc(norm).get()
      if (!existing.exists) {
        out.push(cn)
      } else {
        const data = existing.data() as Partial<PaCompany> | undefined
        const enrichedAt = typeof data?.enrichedAt === "string" ? data.enrichedAt : null
        if (!enrichedAt || enrichedAt < cutoffIso) {
          out.push(cn)
        }
      }
      if (out.length >= limit) break
    }
    lastId = snap.docs[snap.docs.length - 1].id
    if (snap.docs.length < PAGE) break
  }

  return out
}

function makeFirestoreDeps(opts: {
  db: Firestore
  fetchImpl: typeof fetch
  clearbitKey: string | null
  anthropicKey: string | null
}): EnrichDeps {
  const { db, fetchImpl, clearbitKey, anthropicKey } = opts

  return {
    now: () => Date.now(),
    log: (msg, ctx) => logger.info(`[enrich-companies] ${msg}`, ctx ?? {}),
    errorLog: (msg, ctx) => logger.error(`[enrich-companies] ${msg}`, ctx ?? {}),

    loadYcCache: async () => {
      const snap = await db.doc(YC_CACHE_DOC).get()
      if (!snap.exists) return null
      return snap.data() as YcCache
    },

    readClearbitQuota: async () => {
      const snap = await db.doc(CLEARBIT_QUOTA_DOC).get()
      if (!snap.exists) return null
      const data = snap.data() as Partial<ClearbitQuota> | undefined
      if (!data || typeof data.count !== "number") return null
      return {
        count: data.count,
        windowStartedAt: typeof data.windowStartedAt === "string" ? data.windowStartedAt : new Date().toISOString(),
      }
    },

    bumpClearbitQuota: async () => {
      const ref = db.doc(CLEARBIT_QUOTA_DOC)
      const result = await db.runTransaction(async (tx) => {
        const snap = await tx.get(ref)
        const now = new Date()
        const nowIso = now.toISOString()
        const prev = snap.exists ? (snap.data() as Partial<ClearbitQuota> | undefined) : undefined
        let count = typeof prev?.count === "number" ? prev.count : 0
        let windowStartedAt =
          typeof prev?.windowStartedAt === "string" ? prev.windowStartedAt : nowIso
        const windowMs = Date.parse(windowStartedAt)
        if (!Number.isFinite(windowMs) || now.getTime() - windowMs > CLEARBIT_RESET_DAYS * 86_400_000) {
          count = 0
          windowStartedAt = nowIso
        }
        count++
        tx.set(ref, { count, windowStartedAt }, { merge: true })
        return count
      })
      return result
    },

    readExisting: async (id) => {
      const snap = await db.collection("pa-companies").doc(id).get()
      if (!snap.exists) return null
      return snap.data() as Partial<PaCompany>
    },

    writeCompany: async (id, data) => {
      await db.collection("pa-companies").doc(id).set(data, { merge: true })
    },

    resolveCandidateNames: async (mode, explicit, limit) => {
      if (mode === "explicit") {
        return explicit.slice(0, limit)
      }
      return resolveStaleNamesProd(db, limit, Date.now())
    },

    probeWikidata: async (name) => probeWikidataProd(name, fetchImpl),

    probeClearbit: async (name) => {
      if (!clearbitKey) return null
      const ref = db.doc(CLEARBIT_QUOTA_DOC)
      const snap = await ref.get()
      const data = snap.exists ? (snap.data() as Partial<ClearbitQuota>) : null
      const count = typeof data?.count === "number" ? data.count : 0
      if (count >= CLEARBIT_MONTHLY_CAP) return null
      await db.runTransaction(async (tx) => {
        const s = await tx.get(ref)
        const now = new Date()
        const prev = s.exists ? (s.data() as Partial<ClearbitQuota> | undefined) : undefined
        let c = typeof prev?.count === "number" ? prev.count : 0
        let w = typeof prev?.windowStartedAt === "string" ? prev.windowStartedAt : now.toISOString()
        const wms = Date.parse(w)
        if (!Number.isFinite(wms) || now.getTime() - wms > CLEARBIT_RESET_DAYS * 86_400_000) {
          c = 0
          w = now.toISOString()
        }
        c++
        tx.set(ref, { count: c, windowStartedAt: w }, { merge: true })
      })
      return probeClearbitProd({ name, apiKey: clearbitKey, fetchImpl })
    },

    probeLlm: async (name) => {
      if (!anthropicKey) return null
      return probeLlmProd(name, anthropicKey)
    },
  }
}

// ---------------------------------------------------------------------------
// Cloud Functions
// ---------------------------------------------------------------------------

export const paEnrichCompaniesNightly = onSchedule(
  {
    schedule: "0 4 * * 2",
    timeZone: "UTC",
    region: "us-central1",
    memory: "512MiB",
    timeoutSeconds: 540,
    secrets: [CLEARBIT_KEY, ANTHROPIC_API_KEY],
    retryCount: 0,
  },
  async () => {
    const clearbitKey = readSecret(CLEARBIT_KEY) ?? (process.env.CLEARBIT_KEY?.trim() || null)
    const anthropicKey = readSecret(ANTHROPIC_API_KEY) ?? (process.env.ANTHROPIC_API_KEY?.trim() || null)
    const deps = makeFirestoreDeps({
      db: getFirestore(),
      fetchImpl: globalThis.fetch,
      clearbitKey,
      anthropicKey,
    })
    const counters = await runEnrichmentBatch("all_stale", [], DEFAULT_LIMIT, deps)
    logger.info("[enrich-companies] nightly done", counters)
  }
)

export const paEnrichCompaniesAdHoc = onCall(
  {
    region: "us-central1",
    memory: "512MiB",
    timeoutSeconds: 540,
    secrets: [PA_ADMIN_TOKEN, CLEARBIT_KEY, ANTHROPIC_API_KEY],
  },
  async (req): Promise<{ ok: true; counters: EnrichmentCounters }> => {
    authorizeAdminCallable(
      req as { auth?: { token?: { admin?: unknown } }; data?: unknown }
    )

    const data = (req.data ?? {}) as Record<string, unknown>
    const rawNames = data.companyNames
    const limit = typeof data.limit === "number" && Number.isFinite(data.limit)
      ? Math.max(1, Math.min(500, Math.floor(data.limit)))
      : DEFAULT_LIMIT

    let mode: "explicit" | "all_stale" = "all_stale"
    let explicit: string[] = []
    if (Array.isArray(rawNames)) {
      mode = "explicit"
      explicit = rawNames.filter((n): n is string => typeof n === "string" && n.trim().length > 0)
    } else if (rawNames === "all_stale" || rawNames === undefined) {
      mode = "all_stale"
    } else {
      throw new HttpsError("invalid-argument", "companyNames must be string[] | 'all_stale' | undefined")
    }

    const clearbitKey = readSecret(CLEARBIT_KEY) ?? (process.env.CLEARBIT_KEY?.trim() || null)
    const anthropicKey = readSecret(ANTHROPIC_API_KEY) ?? (process.env.ANTHROPIC_API_KEY?.trim() || null)
    const deps = makeFirestoreDeps({
      db: getFirestore(),
      fetchImpl: globalThis.fetch,
      clearbitKey,
      anthropicKey,
    })
    const counters = await runEnrichmentBatch(mode, explicit, limit, deps)
    return { ok: true, counters }
  }
)

function readSecret(s: { value: () => string }): string | null {
  try {
    const v = (s.value() ?? "").trim()
    return v.length > 0 ? v : null
  } catch {
    return null
  }
}
