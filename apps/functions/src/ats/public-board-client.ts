/**
 * ats/public-board-client.ts — REAL public ATS job-board read-back.
 *
 * HONEST SCOPE: this is a READ-ONLY public-board fetch. It detects the ATS
 * provider from a pasted board URL (or a bare "provider:org" / org handle),
 * GETs that provider's PUBLIC job-board API (no auth, no OAuth, no API key,
 * no secrets), and normalizes the open reqs into one uniform shape. It
 * persists nothing here, contacts no candidates, and is NOT the managed
 * Kombo/Ashby ATS connect (that's paEmployerConnectRequest). It is the
 * "pull open reqs from your public board URL" affordance.
 *
 * Three PROVEN public endpoints (verified key-less, 2026-06):
 *   - Greenhouse: GET https://boards-api.greenhouse.io/v1/boards/<token>/jobs
 *   - Lever:      GET https://api.lever.co/v0/postings/<org>?mode=json
 *   - Ashby:      GET https://api.ashbyhq.com/posting-api/job-board/<org>
 *
 * Node 24 global fetch (no node-fetch import — mirrors public-cv-ingest.ts).
 */

export type AtsBoardProvider = "greenhouse" | "lever" | "ashby"

/** Uniform normalized open-req row across all three providers. */
export type AtsOpenReq = {
  title: string
  location: string | null
  url: string
  department?: string | null
  team?: string | null
  jobType?: string | null
}

export type PublicBoardResult =
  | {
      ok: true
      provider: AtsBoardProvider
      org: string
      count: number
      reqs: AtsOpenReq[]
    }
  | {
      ok: false
      provider: AtsBoardProvider
      org: string
      error: string
    }

const MAX_REQS = 200
const FETCH_TIMEOUT_MS = 10_000
const USER_AGENT = "WeKruit-PublicBoardReader/1.0 (+https://wekruit.com)"

/** First path segment of a URL path, lowercased + trimmed. */
function firstPathSegment(pathname: string): string {
  return (pathname.split("/").filter(Boolean)[0] ?? "").trim()
}

/** Strip a trailing `.com`-style token to a clean org/token slug. */
function cleanSlug(s: string): string {
  return s.trim().replace(/^@/, "").replace(/\/+$/, "")
}

/**
 * Detect the ATS provider + org/token from a pasted board URL OR a bare
 * "provider:org" / "org" handle. Returns null when nothing recognizable.
 *
 * Supported URL hosts:
 *   - greenhouse: boards.greenhouse.io/<token>, job-boards.greenhouse.io/<token>,
 *                 boards-api.greenhouse.io/v1/boards/<token>/...
 *   - lever:      jobs.lever.co/<org>, api.lever.co/v0/postings/<org>
 *   - ashby:      jobs.ashbyhq.com/<org>, api.ashbyhq.com/posting-api/job-board/<org>
 *
 * Bare forms:
 *   - "greenhouse:acme" / "lever:acme" / "ashby:acme"
 */
export function detectAtsBoard(
  input: string,
): { provider: AtsBoardProvider; org: string } | null {
  const raw = (input ?? "").trim()
  if (!raw) return null

  // Bare "provider:org" form (no URL).
  const bareMatch = /^(greenhouse|lever|ashby)\s*:\s*(.+)$/i.exec(raw)
  if (bareMatch) {
    const provider = bareMatch[1].toLowerCase() as AtsBoardProvider
    const org = cleanSlug(bareMatch[2])
    if (org) return { provider, org }
    return null
  }

  // Try to parse as a URL (tolerate missing scheme).
  let url: URL | null = null
  try {
    url = new URL(raw)
  } catch {
    try {
      url = new URL(`https://${raw}`)
    } catch {
      url = null
    }
  }

  if (url) {
    const host = url.hostname.toLowerCase()
    const segs = url.pathname.split("/").filter(Boolean)

    // Greenhouse
    if (host === "boards.greenhouse.io" || host === "job-boards.greenhouse.io") {
      const token = cleanSlug(firstPathSegment(url.pathname))
      if (token) return { provider: "greenhouse", org: token }
      return null
    }
    if (host === "boards-api.greenhouse.io") {
      // /v1/boards/<token>/jobs
      const i = segs.indexOf("boards")
      const token = i >= 0 ? cleanSlug(segs[i + 1] ?? "") : ""
      if (token) return { provider: "greenhouse", org: token }
      return null
    }

    // Lever
    if (host === "jobs.lever.co") {
      const org = cleanSlug(firstPathSegment(url.pathname))
      if (org) return { provider: "lever", org }
      return null
    }
    if (host === "api.lever.co") {
      // /v0/postings/<org>
      const i = segs.indexOf("postings")
      const org = i >= 0 ? cleanSlug(segs[i + 1] ?? "") : ""
      if (org) return { provider: "lever", org }
      return null
    }

    // Ashby
    if (host === "jobs.ashbyhq.com") {
      const org = cleanSlug(firstPathSegment(url.pathname))
      if (org) return { provider: "ashby", org }
      return null
    }
    if (host === "api.ashbyhq.com") {
      // /posting-api/job-board/<org>
      const i = segs.indexOf("job-board")
      const org = i >= 0 ? cleanSlug(segs[i + 1] ?? "") : ""
      if (org) return { provider: "ashby", org }
      return null
    }

    // Unknown host.
    return null
  }

  return null
}

function endpointFor(provider: AtsBoardProvider, org: string): string {
  switch (provider) {
    case "greenhouse":
      return `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(org)}/jobs`
    case "lever":
      return `https://api.lever.co/v0/postings/${encodeURIComponent(org)}?mode=json`
    case "ashby":
      return `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(org)}`
  }
}

function asString(v: unknown): string | null {
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : null
}

function normalizeGreenhouse(body: unknown): AtsOpenReq[] {
  const jobs = (body as { jobs?: unknown })?.jobs
  if (!Array.isArray(jobs)) return []
  const out: AtsOpenReq[] = []
  for (const j of jobs) {
    if (!j || typeof j !== "object") continue
    const job = j as {
      title?: unknown
      location?: { name?: unknown }
      absolute_url?: unknown
      departments?: Array<{ name?: unknown }>
    }
    const title = asString(job.title)
    const url = asString(job.absolute_url)
    if (!title || !url) continue
    const dept =
      Array.isArray(job.departments) && job.departments.length > 0
        ? asString(job.departments[0]?.name)
        : null
    out.push({
      title,
      location: asString(job.location?.name),
      url,
      department: dept,
      team: dept,
      jobType: null,
    })
  }
  return out
}

function normalizeLever(body: unknown): AtsOpenReq[] {
  if (!Array.isArray(body)) return []
  const out: AtsOpenReq[] = []
  for (const j of body) {
    if (!j || typeof j !== "object") continue
    const job = j as {
      text?: unknown
      hostedUrl?: unknown
      categories?: { location?: unknown; team?: unknown; commitment?: unknown }
    }
    const title = asString(job.text)
    const url = asString(job.hostedUrl)
    if (!title || !url) continue
    const team = asString(job.categories?.team)
    out.push({
      title,
      location: asString(job.categories?.location),
      url,
      department: team,
      team,
      jobType: asString(job.categories?.commitment),
    })
  }
  return out
}

function normalizeAshby(body: unknown): AtsOpenReq[] {
  const jobs = (body as { jobs?: unknown })?.jobs
  if (!Array.isArray(jobs)) return []
  const out: AtsOpenReq[] = []
  for (const j of jobs) {
    if (!j || typeof j !== "object") continue
    const job = j as {
      title?: unknown
      location?: unknown
      jobUrl?: unknown
      department?: unknown
      employmentType?: unknown
    }
    const title = asString(job.title)
    const url = asString(job.jobUrl)
    if (!title || !url) continue
    const dept = asString(job.department)
    out.push({
      title,
      location: asString(job.location),
      url,
      department: dept,
      team: dept,
      jobType: asString(job.employmentType),
    })
  }
  return out
}

/**
 * Do the REAL public-board fetch for a detected { provider, org }. Global
 * fetch with a 10s AbortController timeout + a User-Agent header. Normalizes
 * each provider's shape into the common req shape and caps at 200. On non-200
 * or a network throw, returns { ok:false, error } (never throws).
 */
export async function fetchPublicBoardReqs(input: {
  provider: AtsBoardProvider
  org: string
}): Promise<PublicBoardResult> {
  const { provider, org } = input
  const endpoint = endpointFor(provider, org)

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  let res: Response
  try {
    res = await fetch(endpoint, {
      method: "GET",
      headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
      signal: controller.signal,
    })
  } catch (err) {
    clearTimeout(timer)
    const msg =
      err instanceof Error && err.name === "AbortError"
        ? "board_fetch_timeout"
        : "board_fetch_network_error"
    return { ok: false, provider, org, error: msg }
  }
  clearTimeout(timer)

  if (!res.ok) {
    return {
      ok: false,
      provider,
      org,
      error: res.status === 404 ? "board_not_found" : `board_fetch_http_${res.status}`,
    }
  }

  let body: unknown
  try {
    body = await res.json()
  } catch {
    return { ok: false, provider, org, error: "board_response_not_json" }
  }

  let reqs: AtsOpenReq[]
  if (provider === "greenhouse") reqs = normalizeGreenhouse(body)
  else if (provider === "lever") reqs = normalizeLever(body)
  else reqs = normalizeAshby(body)

  const capped = reqs.slice(0, MAX_REQS)
  return { ok: true, provider, org, count: capped.length, reqs: capped }
}
