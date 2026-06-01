/**
 * card-payload.ts — the STRUCTURED contract the rec card consumes, plus a
 * pure builder that maps a matched job (+ optional enrichment + match reasons)
 * into that contract.
 *
 * Adam directive 2026-05-30: deliver job recs as a DESIGNED CARD IMAGE over
 * iMessage (the "standout" reference aesthetic), not plain text.
 *
 * The renderer (render-card.ts) consumes ONLY `RecCardPayload` — it never
 * touches Firestore. This builder is the single place that knows how to map
 * job/company sources into the card shape, so it is unit-testable in isolation
 * and the renderer stays a pure layout function.
 *
 * Graceful omission contract: every optional section (stage / raise / salary /
 * whyFits / whyCompany / backers / team) is dropped from the rendered card
 * when its source is missing — the card never shows an empty heading or a
 * "$undefined" line. Only `company` + `title` are required.
 */

/**
 * The card data contract. Every field is sourced from data we ACTUALLY have
 * (Adam directive 2026-05-30: AUDIT first, design only sections we can fill).
 *
 * Field provenance (see buildRecCardPayload):
 *   company       ← job.companyName                       (REQUIRED)
 *   title         ← job.jobTitle / roleTitle              (REQUIRED)
 *   seniority     ← job.seniorityLevel
 *   salaryMin/Max ← job.salaryMin / salaryMax
 *   location      ← pa-company.hqLocation || job.locationRaw
 *   workMode      ← inferred from job.jobType / locationRaw
 *   industry      ← pa-company.industry
 *   stage         ← pa-company.companyStage                (enum → label)
 *   raiseAmount   ← pa-company.fundingRounds[last].amount  (USD millions)
 *   headcount     ← pa-company.employeeRange               (string range)
 *   logoUrl       ← pa-company.logoUrl                      (Clearbit)
 *   inNetwork     ← pa-company.wekruitCollab
 *   backers       ← pa-company.fundingRounds[*].investors
 *   whyFits       ← match-reason bullets (or reason-string split fallback)
 *   whyCompany    ← match-reason bullets (omitted when none)
 *
 * There is NO team/founders source in pa-companies — the Team section is
 * intentionally absent. Any field with no data is omitted; the card still
 * looks complete from the sections it CAN fill.
 */
export type RecCardPayload = {
  /** REQUIRED. Company display name. */
  company: string
  /** REQUIRED. Job title (big serif headline). */
  title: string
  /** e.g. "Senior" / "Staff". Rendered with the salary/location meta line. */
  seniority?: string
  /** e.g. "Series A" / "Seed" — derived from pa-company.companyStage. Top-right. */
  stage?: string
  /** e.g. "$26M" — from the latest funding round amount. "Series A · $26M". */
  raiseAmount?: string
  /** "N people" pill (top-right) — from pa-company.employeeRange. */
  headcount?: string
  /** Free-form industry label (pa-company.industry), shown under company name. */
  industry?: string
  /** Compensation floor (USD). Rendered as "$200k–400k" with salaryMax. */
  salaryMin?: number
  /** Compensation ceiling (USD). */
  salaryMax?: number
  /** e.g. "San Francisco". */
  location?: string
  /** e.g. "in-office" / "remote" / "hybrid". */
  workMode?: string
  /** WeKruit-collab company → "In Network" badge. */
  inNetwork?: boolean
  /**
   * Company logo image URL (https). Sourced from pa-company.logoUrl, else
   * derived from the company domain via Google favicon. NOT fetched by the
   * renderer (satori never fetches a remote <img>) — the orchestrator
   * pre-fetches it into `logoDataUri` before render.
   */
  logoUrl?: string
  /**
   * Pre-fetched logo as a `data:image/...;base64,...` URI. Set by the
   * orchestrator (job-rec-card.ts) when the remote logo fetch succeeds; the
   * renderer draws an <img> from it. Absent → renderer draws the monogram chip
   * (fail-open). Never a remote URL — satori must not egress at render time.
   */
  logoDataUri?: string
  /** "WHY THIS FITS YOU" bullets (from the match-reason work / reason split). */
  whyFits?: string[]
  /** "WHY <COMPANY>" bullets. Omitted when the reason work produced none. */
  whyCompany?: string[]
  /** Investor names: "Backed by <investors>". */
  backers?: string[]
  /** The apply / job URL (kept for the caption, not rendered on the card). */
  applyUrl?: string
}

/** Loose shape of a matched job row (subset of @pa/job-rec MatchingJob). */
export type CardJobSource = {
  companyName?: string | null
  jobTitle?: string | null
  roleTitle?: string | null
  seniorityLevel?: string | null
  salaryMin?: number | null
  salaryMax?: number | null
  locationRaw?: string | null
  jobType?: string | null
  atsApplyUrl?: string | null
  primaryUrl?: string | null
  /** Single match-reason string — fallback source for whyFits when no bullets. */
  reason?: string | null
}

/** One funding round (mirror of PaCompany.fundingRounds[] — amount in $M). */
export type CardFundingRound = {
  round?: string | null
  /** USD millions. */
  amount?: number | null
  date?: string | null
  investors?: unknown
}

/**
 * Loose mirror of the REAL `pa-companies/{id}` doc (@pa/core-types PaCompany).
 * Every field optional — the builder reads defensively. The field names match
 * the actual enrichment writer (companyStage / employeeRange / fundingRounds /
 * logoUrl / industry / hqLocation / wekruitCollab). There is NO team field.
 */
export type CardCompanySource = {
  /** Phase A2 canonical enum, e.g. "series_a" / "seed" / "ipo_public". */
  companyStage?: string | null
  /** Free-form employee range string, e.g. "501-1000". */
  employeeRange?: string | null
  /** Free-form industry label. */
  industry?: string | null
  /** Logo URL (https). When absent, derived from domain via Google favicon. */
  logoUrl?: string | null
  /** Company domain (e.g. "metavoice.io") — favicon-logo source when logoUrl absent. */
  domain?: string | null
  /** Company website URL (e.g. "https://photon.codes/") — domain fallback source. */
  websiteUrl?: string | null
  hqLocation?: string | null
  /** WeKruit partnership flag → "In Network" badge. */
  wekruitCollab?: boolean | null
  fundingRounds?: CardFundingRound[] | null
}

/**
 * Extract a bare hostname ("metavoice.io") from a company domain, website URL,
 * or domain-shaped company name ("invoko.ai"). Strips scheme / www / path /
 * port. Returns undefined when no plausible domain is present.
 */
export function deriveCompanyDomain(input: {
  domain?: string | null
  websiteUrl?: string | null
  companyName?: string | null
}): string | undefined {
  const candidates = [input.domain, input.websiteUrl, input.companyName]
  for (const raw of candidates) {
    const s = cleanStr(raw)
    if (!s) continue
    let host = s.trim().toLowerCase()
    // Strip scheme.
    host = host.replace(/^[a-z][a-z0-9+.-]*:\/\//, "")
    // Strip path / query / fragment.
    host = host.split(/[/?#]/)[0] ?? ""
    // Strip credentials + port.
    host = host.split("@").pop() ?? host
    host = host.split(":")[0] ?? host
    // Strip leading www.
    host = host.replace(/^www\./, "")
    // Must look like a domain: at least one dot, valid label chars.
    if (/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/.test(host)) {
      return host
    }
  }
  return undefined
}

/**
 * Build the Google favicon logo URL for a domain. 128px PNG, public, no auth.
 * Live-verified 200 image/png (after a 301). Used as the logo source when a
 * company has no explicit logoUrl. Returns undefined for an empty domain.
 */
export function googleFaviconUrl(domain: string | undefined): string | undefined {
  const d = cleanStr(domain)
  if (!d) return undefined
  return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(d)}&sz=128`
}

/** Rich match reasons produced by the sibling reason agent. */
export type CardReasonSource = {
  whyFits?: string[] | null
  whyCompany?: string[] | null
}

function cleanStr(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined
  const t = v.trim()
  return t.length > 0 ? t : undefined
}

function cleanNum(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : undefined
}

function cleanStrList(v: unknown, max: number): string[] | undefined {
  if (!Array.isArray(v)) return undefined
  const out = v
    .map((x) => cleanStr(x))
    .filter((x): x is string => x !== undefined)
    .slice(0, max)
  return out.length > 0 ? out : undefined
}

/**
 * Split a single match-reason sentence into up to 3 short bullets. Used as the
 * whyFits fallback when the reason agent has not produced structured bullets
 * yet (graceful degradation per the Adam brief).
 */
export function splitReasonToBullets(reason: string | undefined, max = 3): string[] | undefined {
  const r = cleanStr(reason)
  if (!r) return undefined
  // Prefer sentence/clause boundaries; collapse whitespace.
  const parts = r
    .split(/(?:[.;\n]|\s—\s|,\s(?=(?:your|matches|offers|same|lines|aligned)))/i)
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
    .slice(0, max)
  return parts.length > 0 ? parts : [r]
}

/**
 * Collapse fundingRounds[] into the latest disclosed raise amount ("$26M") and
 * the de-duplicated investor list. amount is in USD MILLIONS per PaCompany.
 */
function deriveFunding(rounds: CardFundingRound[] | null | undefined): {
  raiseAmount?: string
  backers?: string[]
} {
  if (!Array.isArray(rounds) || rounds.length === 0) return {}
  // Latest by date (fallback: array order). Raise = that round's amount.
  const sorted = [...rounds].sort((a, b) => {
    const da = cleanStr(a.date) ?? ""
    const db = cleanStr(b.date) ?? ""
    return da < db ? 1 : da > db ? -1 : 0
  })
  let raiseAmount: string | undefined
  for (const r of sorted) {
    const m = cleanNum(r.amount)
    if (m) {
      raiseAmount = m >= 1000 ? `$${(m / 1000).toFixed(1).replace(/\.0$/, "")}B` : `$${Math.round(m)}M`
      break
    }
  }
  // Investors across all rounds, de-duped, Title Case, cap 5.
  const seen = new Set<string>()
  const backers: string[] = []
  for (const r of rounds) {
    if (!Array.isArray(r.investors)) continue
    for (const inv of r.investors) {
      const name = cleanStr(inv)
      if (!name) continue
      const display = titleCaseInvestor(name)
      const key = display.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      backers.push(display)
      if (backers.length >= 5) break
    }
    if (backers.length >= 5) break
  }
  return {
    ...(raiseAmount ? { raiseAmount } : {}),
    ...(backers.length > 0 ? { backers } : {}),
  }
}

/** Render an employee range string ("501-1000") into a "N people" headcount label. */
function formatHeadcount(employeeRange: string | null | undefined): string | undefined {
  const r = cleanStr(employeeRange)
  if (!r) return undefined
  return `${r} people`
}

/**
 * Build the card payload from a matched job, optional company enrichment, and
 * optional rich match reasons. Pure / deterministic / no I/O. Returns null
 * only when the job has neither a company nor a title (un-renderable).
 */
export function buildRecCardPayload(input: {
  job: CardJobSource
  company?: CardCompanySource | null
  reasons?: CardReasonSource | null
}): RecCardPayload | null {
  const { job, company, reasons } = input
  const companyName = cleanStr(job.companyName)
  const title = cleanStr(job.jobTitle) ?? cleanStr(job.roleTitle)
  if (!companyName || !title) return null

  const payload: RecCardPayload = { company: companyName, title }

  const seniority = cleanStr(job.seniorityLevel)
  if (seniority) payload.seniority = humanizeToken(seniority)

  const salaryMin = cleanNum(job.salaryMin)
  if (salaryMin) payload.salaryMin = salaryMin
  const salaryMax = cleanNum(job.salaryMax)
  if (salaryMax) payload.salaryMax = salaryMax

  const workMode = inferWorkMode(job.jobType, job.locationRaw)
  if (workMode) payload.workMode = workMode

  const applyUrl = cleanStr(job.atsApplyUrl) ?? cleanStr(job.primaryUrl)
  if (applyUrl) payload.applyUrl = applyUrl

  // ---- Company enrichment (real PaCompany fields; all optional) ----
  // Prefer the company HQ location over the raw job location for the meta line.
  let location = cleanStr(job.locationRaw)
  if (company) {
    const stage = normalizeCompanyStage(company.companyStage)
    if (stage) payload.stage = stage
    const headcount = formatHeadcount(company.employeeRange)
    if (headcount) payload.headcount = headcount
    const industry = cleanStr(company.industry)
    if (industry) payload.industry = humanizeToken(industry)
    // Logo source: explicit https logoUrl wins; else derive a Google favicon URL
    // from the company domain (D5 fix — Clearbit is dead). The renderer never
    // fetches this — the orchestrator pre-fetches it into `logoDataUri`.
    const explicitLogo = cleanStr(company.logoUrl)
    if (explicitLogo && /^https:\/\//.test(explicitLogo)) {
      payload.logoUrl = explicitLogo
    } else {
      const domain = deriveCompanyDomain({
        domain: company.domain,
        websiteUrl: company.websiteUrl,
        companyName: job.companyName,
      })
      const favicon = googleFaviconUrl(domain)
      if (favicon) payload.logoUrl = favicon
    }
    const hq = cleanStr(company.hqLocation)
    if (hq) location = hq
    const { raiseAmount, backers } = deriveFunding(company.fundingRounds)
    if (raiseAmount) payload.raiseAmount = raiseAmount
    if (backers) payload.backers = backers
    if (company.wekruitCollab === true) payload.inNetwork = true
  }
  // No company doc (or company doc had no logo source): still try a favicon from
  // a domain-shaped company name (e.g. "invoko.ai"). Fail-open — the renderer
  // shows a monogram when this stays unset.
  if (!payload.logoUrl) {
    const favicon = googleFaviconUrl(deriveCompanyDomain({ companyName: job.companyName }))
    if (favicon) payload.logoUrl = favicon
  }
  if (location) payload.location = location

  // ---- Match reasons (structured bullets preferred; reason-string fallback) ----
  const whyFits = cleanStrList(reasons?.whyFits, 4) ?? splitReasonToBullets(job.reason ?? undefined)
  if (whyFits) payload.whyFits = whyFits
  const whyCompany = cleanStrList(reasons?.whyCompany, 4)
  if (whyCompany) payload.whyCompany = whyCompany

  return payload
}

/** Render a snake_case / kebab token as Title Case words. */
export function humanizeToken(token: string): string {
  return token
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase())
}

function inferWorkMode(jobType: unknown, location: unknown): string | undefined {
  const jt = typeof jobType === "string" ? jobType.toLowerCase() : ""
  const loc = typeof location === "string" ? location.toLowerCase() : ""
  if (jt.includes("remote") || loc.includes("remote")) return "remote"
  if (jt.includes("hybrid") || loc.includes("hybrid")) return "hybrid"
  if (jt.includes("on-site") || jt.includes("onsite") || jt.includes("in-office") || jt.includes("in office")) {
    return "in-office"
  }
  return undefined
}

/**
 * Map a canonical `companyStage` enum to a display label. Returns undefined for
 * "unknown" / empty so the stage pill is omitted rather than showing "Unknown".
 * Known enums: seed, series_a..series_d_plus, private_mature, ipo_public.
 */
export function normalizeCompanyStage(stage: string | null | undefined): string | undefined {
  const s = cleanStr(stage)
  if (!s) return undefined
  const lower = s.toLowerCase()
  if (lower === "unknown") return undefined
  const map: Record<string, string> = {
    pre_seed: "Pre-Seed",
    seed: "Seed",
    series_a: "Series A",
    series_b: "Series B",
    series_c: "Series C",
    series_d_plus: "Series D+",
    private_mature: "Private",
    ipo_public: "Public",
    public: "Public",
  }
  return map[lower] ?? humanizeToken(s)
}

/** Title-case an investor name, preserving known stylizations (a16z, YC). */
function titleCaseInvestor(name: string): string {
  const special: Record<string, string> = {
    a16z: "a16z",
    yc: "YC",
    "y combinator": "Y Combinator",
    sv: "SV",
  }
  const lower = name.toLowerCase().trim()
  if (special[lower]) return special[lower]!
  return humanizeToken(name)
}

/** Format a salary range as "$200k–400k" (or single bound). Public for tests. */
export function formatSalaryRange(min?: number, max?: number): string | undefined {
  const k = (v: number): string => `$${Math.round(v / 1000)}k`
  if (min && max) return `${k(min)}–${k(max).replace("$", "")}`
  if (max) return `up to ${k(max)}`
  if (min) return `${k(min)}+`
  return undefined
}
