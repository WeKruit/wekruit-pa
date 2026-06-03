/**
 * CoreSignal cdapi v2 `*_multi_source/collect/{id}` thin client.
 *
 * Mirrors the proven `scripts/coresignal-fetch-employees.mjs` prototype but
 * adds typed schemas + retry semantics suitable for Cloud Functions runtime.
 *
 * Endpoints:
 *  - GET `${baseUrl}/employee_multi_source/collect/{id}` → employee record
 *  - GET `${baseUrl}/company_multi_source/collect/{id}`  → company record
 *
 * Auth: header `apikey: <CORESIGNAL_API_KEY>`.
 *
 * Retry: 429 / 5xx → exponential backoff (1s, 2s, 3s) up to 3 attempts.
 * 4xx (non-429) → throw immediately (likely bad ID or permission).
 *
 * Why thin: keep Cloud Function surface small and test-friendly. Only the
 * fields V2.1 actually consumes are typed; the rest of the payload survives
 * untyped as `Record<string, unknown>` and is preserved in
 * `pa-external-candidate-records.rawPayload` for downstream evolution.
 */

import { z } from "zod"

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export const CORESIGNAL_DEFAULT_BASE_URL = "https://api.coresignal.com/cdapi/v2"

export interface CoresignalCollectClientConfig {
  apiKey: string
  baseUrl?: string
  /**
   * Optional fetch override. Defaults to `globalThis.fetch`. Tests inject a
   * stub here to avoid network access.
   */
  fetchImpl?: typeof fetch
  /** Override per-attempt sleep delay. Tests pass `() => Promise.resolve()` to skip waits. */
  sleepImpl?: (ms: number) => Promise<void>
}

// ---------------------------------------------------------------------------
// Response schemas (lenient — only fields we read downstream are typed)
// ---------------------------------------------------------------------------

const ExperienceEntrySchema = z.object({
  company_name: z.string().nullable().optional(),
  company_id: z.number().nullable().optional(),
  position_title: z.string().nullable().optional(),
  department: z.string().nullable().optional(),
  management_level: z.string().nullable().optional(),
  location: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  date_from: z.string().nullable().optional(),
  date_to: z.string().nullable().optional(),
  duration_months: z.number().nullable().optional(),
  company_industry: z.string().nullable().optional(),
  company_size_range: z.string().nullable().optional(),
  company_website: z.string().nullable().optional(),
  company_linkedin_url: z.string().nullable().optional(),
  company_hq_country: z.string().nullable().optional(),
  company_hq_city: z.string().nullable().optional(),
  // CoreSignal returns 0/1 (number) not true/false (boolean) — accept either.
  active_experience: z.union([z.boolean(), z.number()]).nullable().optional(),
}).passthrough()

const EducationEntrySchema = z.object({
  institution_name: z.string().nullable().optional(),
  degree: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  date_from_year: z.number().nullable().optional(),
  date_to_year: z.number().nullable().optional(),
}).passthrough()

const ProfessionalEmailSchema = z.object({
  professional_email: z.string().nullable().optional(),
  professional_email_status: z.string().nullable().optional(),
  order_of_priority: z.number().nullable().optional(),
}).passthrough()

export const CoresignalEmployeeCollectV2Schema = z.object({
  id: z.number(),
  full_name: z.string().nullable().optional(),
  first_name: z.string().nullable().optional(),
  last_name: z.string().nullable().optional(),
  headline: z.string().nullable().optional(),
  summary: z.string().nullable().optional(),
  linkedin_url: z.string().nullable().optional(),
  github_url: z.string().nullable().optional(),
  location_country: z.string().nullable().optional(),
  location_state: z.string().nullable().optional(),
  location_city: z.string().nullable().optional(),
  location_full: z.string().nullable().optional(),
  primary_professional_email: z.string().nullable().optional(),
  primary_professional_email_status: z.string().nullable().optional(),
  professional_emails_collection: z.array(ProfessionalEmailSchema).nullable().optional(),
  // CoreSignal returns 0/1 (number) not true/false (boolean) — accept either.
  is_working: z.union([z.boolean(), z.number()]).nullable().optional(),
  is_decision_maker: z.union([z.boolean(), z.number()]).nullable().optional(),
  active_experience_company_id: z.number().nullable().optional(),
  active_experience_title: z.string().nullable().optional(),
  active_experience_description: z.string().nullable().optional(),
  active_experience_department: z.string().nullable().optional(),
  active_experience_management_level: z.string().nullable().optional(),
  total_experience_duration_months: z.number().nullable().optional(),
  experience: z.array(ExperienceEntrySchema).nullable().optional(),
  education: z.array(EducationEntrySchema).nullable().optional(),
  inferred_skills: z.array(z.string()).nullable().optional(),
  historical_skills: z.array(z.string()).nullable().optional(),
  connections_count: z.number().nullable().optional(),
  followers_count: z.number().nullable().optional(),
  updated_at: z.string().nullable().optional(),
  profile_score: z.number().nullable().optional(),
}).passthrough()

export type CoresignalEmployeeCollectV2 = z.infer<typeof CoresignalEmployeeCollectV2Schema>

export const CoresignalCompanyCollectV2Schema = z.object({
  id: z.number(),
  company_name: z.string().nullable().optional(),
  company_legal_name: z.string().nullable().optional(),
  website: z.string().nullable().optional(),
  website_domain: z.string().nullable().optional(),
  linkedin_url: z.string().nullable().optional(),
  canonical_linkedin_url: z.string().nullable().optional(),
  industry: z.string().nullable().optional(),
  founded_year: z.string().nullable().optional(),
  size_range: z.string().nullable().optional(),
  employees_count: z.number().nullable().optional(),
  hq_country: z.string().nullable().optional(),
  hq_state: z.string().nullable().optional(),
  hq_city: z.string().nullable().optional(),
  hq_full_address: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  categories_and_keywords: z.array(z.string()).nullable().optional(),
}).passthrough()

export type CoresignalCompanyCollectV2 = z.infer<typeof CoresignalCompanyCollectV2Schema>

// ---------------------------------------------------------------------------
// Error type
// ---------------------------------------------------------------------------

export class CoresignalCollectError extends Error {
  constructor(
    message: string,
    public readonly status: number | null,
    public readonly attempts: number,
    public readonly body?: string,
  ) {
    super(message)
    this.name = "CoresignalCollectError"
  }
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

const RETRY_DELAYS_MS = [1_000, 2_000, 3_000] as const
const MAX_ATTEMPTS = RETRY_DELAYS_MS.length

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function collectRaw(
  endpoint: string,
  id: number,
  config: CoresignalCollectClientConfig,
): Promise<unknown> {
  const baseUrl = config.baseUrl ?? CORESIGNAL_DEFAULT_BASE_URL
  const url = `${baseUrl}/${endpoint}/collect/${id}`
  const fetchImpl = config.fetchImpl ?? fetch
  const sleep = config.sleepImpl ?? defaultSleep

  if (!config.apiKey) {
    throw new CoresignalCollectError("coresignal_api_key_missing", null, 0)
  }

  let lastErr: CoresignalCollectError | null = null
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let res: Response
    try {
      res = await fetchImpl(url, {
        method: "GET",
        headers: {
          "Content-Type": "application/json",
          apikey: config.apiKey,
        },
      })
    } catch (err) {
      lastErr = new CoresignalCollectError(
        `network_error: ${(err as Error).message}`,
        null,
        attempt,
      )
      if (attempt < MAX_ATTEMPTS) {
        await sleep(RETRY_DELAYS_MS[attempt - 1])
        continue
      }
      throw lastErr
    }

    if (res.ok) {
      return await res.json()
    }

    const body = await res.text().catch(() => "")

    // 429 or 5xx → retry
    if (res.status === 429 || res.status >= 500) {
      lastErr = new CoresignalCollectError(
        `transient_${res.status}`,
        res.status,
        attempt,
        body.slice(0, 200),
      )
      if (attempt < MAX_ATTEMPTS) {
        await sleep(RETRY_DELAYS_MS[attempt - 1])
        continue
      }
      throw lastErr
    }

    // Other 4xx → fail fast
    throw new CoresignalCollectError(
      `http_${res.status}`,
      res.status,
      attempt,
      body.slice(0, 200),
    )
  }

  // Should not reach here, but TypeScript needs a terminator
  throw lastErr ?? new CoresignalCollectError("unknown", null, MAX_ATTEMPTS)
}

export async function fetchEmployeeCollect(
  id: number,
  config: CoresignalCollectClientConfig,
): Promise<CoresignalEmployeeCollectV2> {
  const raw = await collectRaw("employee_multi_source", id, config)
  return CoresignalEmployeeCollectV2Schema.parse(raw)
}

// ---------------------------------------------------------------------------
// Search-by-LinkedIn-URL (cdapi v2 ES-DSL filter → numeric employee ids)
//
// The `collect/{id}` endpoint is by NUMERIC id only. The candidate-facing
// LinkedIn one-tap flow only has a raw profile URL, so we need a URL → id hop
// before we can `collect`. This is the EXISTING cdapi v2 ES-DSL search filter
// (`POST employee_multi_source/search/es_dsl`), matched against the LinkedIn
// profile URL field. We keep this in the SAME thin client (no parallel client)
// so retry/auth/baseUrl semantics stay identical.
// ---------------------------------------------------------------------------

/**
 * The CoreSignal field that holds the canonical LinkedIn profile URL. v2
 * employee records expose the professional-network URL under this term.
 */
const LINKEDIN_URL_SEARCH_FIELD = "websites_professional_network"

async function searchRaw(
  endpoint: string,
  query: Record<string, unknown>,
  config: CoresignalCollectClientConfig,
): Promise<unknown> {
  const baseUrl = config.baseUrl ?? CORESIGNAL_DEFAULT_BASE_URL
  const url = `${baseUrl}/${endpoint}/search/es_dsl`
  const fetchImpl = config.fetchImpl ?? fetch
  const sleep = config.sleepImpl ?? defaultSleep

  if (!config.apiKey) {
    throw new CoresignalCollectError("coresignal_api_key_missing", null, 0)
  }

  let lastErr: CoresignalCollectError | null = null
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let res: Response
    try {
      res = await fetchImpl(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          apikey: config.apiKey,
        },
        body: JSON.stringify({ query }),
      })
    } catch (err) {
      lastErr = new CoresignalCollectError(
        `network_error: ${(err as Error).message}`,
        null,
        attempt,
      )
      if (attempt < MAX_ATTEMPTS) {
        await sleep(RETRY_DELAYS_MS[attempt - 1])
        continue
      }
      throw lastErr
    }

    if (res.ok) {
      return await res.json()
    }

    const body = await res.text().catch(() => "")

    if (res.status === 429 || res.status >= 500) {
      lastErr = new CoresignalCollectError(
        `transient_${res.status}`,
        res.status,
        attempt,
        body.slice(0, 200),
      )
      if (attempt < MAX_ATTEMPTS) {
        await sleep(RETRY_DELAYS_MS[attempt - 1])
        continue
      }
      throw lastErr
    }

    throw new CoresignalCollectError(
      `http_${res.status}`,
      res.status,
      attempt,
      body.slice(0, 200),
    )
  }

  throw lastErr ?? new CoresignalCollectError("unknown", null, MAX_ATTEMPTS)
}

/**
 * Resolve a CANONICAL LinkedIn profile URL to the first matching CoreSignal
 * employee id (or `null` when nothing matches). The caller then `collect`s
 * that id to get the full employee record.
 *
 * The ES-DSL response is an array of numeric ids (cdapi v2 search/es_dsl).
 * We defensively also accept `{ data: number[] }` / hit-object shapes.
 */
export async function searchEmployeeIdByLinkedinUrl(
  canonicalLinkedInUrl: string,
  config: CoresignalCollectClientConfig,
): Promise<number | null> {
  const url = canonicalLinkedInUrl.trim()
  if (!url) return null
  const raw = await searchRaw(
    "employee_multi_source",
    { query_string: { query: `${LINKEDIN_URL_SEARCH_FIELD}:"${url}"` } },
    config,
  )
  return firstNumericId(raw)
}

/** Pull the first numeric id out of the lenient ES-DSL response shapes. */
function firstNumericId(raw: unknown): number | null {
  const fromArray = (arr: unknown[]): number | null => {
    for (const item of arr) {
      if (typeof item === "number" && Number.isInteger(item) && item > 0) return item
      if (item && typeof item === "object") {
        const id = (item as { id?: unknown; _id?: unknown }).id ?? (item as { _id?: unknown })._id
        if (typeof id === "number" && Number.isInteger(id) && id > 0) return id
        if (typeof id === "string" && /^\d+$/.test(id)) return Number(id)
      }
    }
    return null
  }
  if (Array.isArray(raw)) return fromArray(raw)
  if (raw && typeof raw === "object") {
    const data = (raw as { data?: unknown }).data
    if (Array.isArray(data)) return fromArray(data)
    const hits = (raw as { hits?: { hits?: unknown } }).hits?.hits
    if (Array.isArray(hits)) return fromArray(hits)
  }
  return null
}

export async function fetchCompanyCollect(
  id: number,
  config: CoresignalCollectClientConfig,
): Promise<CoresignalCompanyCollectV2> {
  const raw = await collectRaw("company_multi_source", id, config)
  return CoresignalCompanyCollectV2Schema.parse(raw)
}
