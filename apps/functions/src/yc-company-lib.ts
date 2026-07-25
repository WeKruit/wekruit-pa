/**
 * Company-signal extraction for the YC attendee cohort. Free, deterministic.
 *
 * LIVES IN src/, NOT scripts/ (Adam 2026-07-25): a scanner is now enriched and pooled INSIDE a live
 * turn (`yc-pool-sync.ts`), so the batch script and the runtime path must share ONE trust gate. A
 * forked copy is how the guards below silently stop applying to the newer caller.
 *
 * The load-bearing piece is `trustedCompanyEntry` — the guard deciding which
 * company we may attribute to a founder. Attaching the WRONG company to a real
 * person at a live event is the one failure we cannot take back, so this errs
 * toward returning nothing. Two live failures it exists to stop (each asserted
 * by name in __tests__/yc-company-guards.test.ts):
 *
 *   1. BlueAlpha — the founder's only founder-titled row was a 2020-2022 role at
 *      Machinaa Technology. `collect` returned Machinaa in full confident detail.
 *   2. "Stealth" — 13 founders list it. LinkedIn's placeholder company page maps
 *      to company_id 83805468, which collects as TimelyAI, Phoenix, 3954 employees.
 */
import { roundTypeToStage } from "./yc-people-match.js"

type Rec = Record<string, any>

export const FOUNDER_RE = /\b(founder|co[-\s]?founder|cofounder|ceo|chief executive)\b/i
/** LinkedIn placeholder "companies" — a company_id here points at some unrelated real firm. */
export const PLACEHOLDER_COMPANY_RE =
  /^\s*(stealth|confidential|self[-\s]?employed|freelance|independent|unemployed|n\/?a|none|tbd)\b/i
/** A school is not the founder's company — it's where they study. */
export const SCHOOL_RE = /\b(university|universities|college|school of|institute of technology|polytechnic)\b/i
// Leading non-letter requirement keeps "NYC W2" out.
const YC_BATCH_RE = /(?:^|[^A-Za-z])YC\s*([WSFX])\s?(\d{2})(?![0-9])/i

export function parseYcBatch(text: string | null | undefined): string | null {
  if (!text) return null
  const m = YC_BATCH_RE.exec(text)
  return m ? `${m[1].toUpperCase()}${m[2]}` : null
}

/**
 * Coarse stage implied by batch age. Deliberately vague: measured against real
 * collect payloads, W24 companies still show "Pre Seed Round" as their last
 * round, so batch age does NOT pin the round. It reliably says "YC-backed and
 * this old" — the actual round type comes from a company collect.
 * ponytail: 3 buckets, no round-letter guessing.
 */
export function ycBatchStage(batch: string): "yc_current" | "yc_early" | "yc_maturing" {
  const age = 26 - Number(batch.slice(1)) // 2026
  if (age <= 0) return "yc_current"
  if (age <= 3) return "yc_early"
  return "yc_maturing"
}

/**
 * Comparable company name: drops the YC suffix, legal/filler suffixes, punctuation.
 * Stripping the fillers here is what lets `namesAgree` demand strict EQUALITY —
 * "Clad Labs (YC F25)" and "Clad" both reduce to "clad".
 */
export function normCompanyName(s: string | null | undefined): string {
  return String(s ?? "")
    .toLowerCase()
    .replace(/\(?\s*yc\s*[wsfx]\s?\d{2}\s*\)?/g, "")
    .replace(/\b(inc|llc|ltd|corp|corporation|gmbh|limited|technologies|technology|labs|lab|ai|hq|io)\b/g, "")
    .replace(/[^a-z0-9]/g, "")
}

/**
 * Do two company names refer to the same company? Strict equality after
 * normalization — NO substring containment. Containment is how "Axiom" silently
 * becomes "Axiom Space"; the fillers that legitimately differ are already
 * stripped by normCompanyName.
 */
export function namesAgree(a: string | null | undefined, b: string | null | undefined): boolean {
  const x = normCompanyName(a), y = normCompanyName(b)
  return Boolean(x) && x === y
}

/** Bare registrable domain from a URL, for `website_domain` search. */
export function domainOf(url: string | null | undefined): string | null {
  if (!url) return null
  const m = /^(?:https?:\/\/)?(?:www\.)?([^/?#\s]+)/i.exec(String(url).trim())
  return m?.[1]?.toLowerCase() ?? null
}

/**
 * The ONLY company entry we may attribute to a founder as "current".
 * Requires an ACTIVE experience row whose name agrees with the company the record
 * says they're at. No active row, or a disagreement → trust nothing.
 */
export function trustedCompanyEntry(
  emp: Rec | undefined,
  statedCompany: string | null,
): { entry: Rec | null; reason: "active_name_agrees" | "active_no_stated_name" | "no_active_experience" | "active_name_disagrees" } {
  const exp: Rec[] = Array.isArray(emp?.experience) ? emp!.experience : []
  const active = exp.filter((e) => e.active_experience === 1 || e.active_experience === true)
  if (!active.length) return { entry: null, reason: "no_active_experience" }
  const founderRows = active.filter((e) => FOUNDER_RE.test(String(e.position_title ?? "")))
  const pool = founderRows.length ? founderRows : active
  if (!statedCompany) return { entry: pool[0] ?? null, reason: "active_no_stated_name" }
  const hit = pool.find((e) => namesAgree(e.company_name, statedCompany))
  return hit ? { entry: hit, reason: "active_name_agrees" } : { entry: null, reason: "active_name_disagrees" }
}

/**
 * Everything decided about a person's employer BEFORE any lookup: which experience row we may
 * trust, whether it is worth resolving at all, and the YC batch tag.
 *
 * Shared by the batch resolver and the live scanner path so the two cannot disagree about whose
 * company this is. The CALLER owns the lookup ladder after this (the batch has search rungs the
 * runtime deliberately does not get); this function owns the judgement.
 */
export function trustedCompanyContext(
  emp: Rec | undefined,
  statedCompany: string | null,
  title: string,
): {
  entry: Rec | null
  trustReason: string
  /** Non-null = do not look anything up; there is no company here to resolve. */
  resolveNote: string | null
  isFounder: boolean
  ycBatch: string | null
} {
  const { entry, reason: trustReason } = trustedCompanyEntry(emp, statedCompany)
  const placeholder = statedCompany ? PLACEHOLDER_COMPANY_RE.test(statedCompany) : false
  const school = statedCompany ? SCHOOL_RE.test(statedCompany) : false
  const e = placeholder || school ? null : entry
  const resolveNote = placeholder
    ? "placeholder_company"
    : school
      ? "stated_company_is_school"
      : !statedCompany && !entry
        ? "no_company_stated"
        : null
  return {
    entry: e,
    trustReason,
    resolveNote,
    isFounder: FOUNDER_RE.test(title),
    ycBatch: parseYcBatch(
      [title, statedCompany, emp?.headline, emp?.summary, e?.company_name, e?.position_title, e?.description]
        .filter(Boolean)
        .join(" | "),
    ),
  }
}

/**
 * THE `companyProfile` RECORD — one implementation, used by `scripts/yc-company-resolve.ts` for the
 * 992 imported rows and by `yc-pool-sync.ts` for everyone who walks up and scans.
 *
 * Merge rule: the resolved company record wins where present, the founder's own cached experience
 * row fills the gaps, and nothing is ever invented. `companyFactsText` puts these values INTO the
 * embedding, so a wrong "Series B" starts attracting the queries it is wrong about — unknown must
 * leave the clause absent rather than hedge.
 */
export function composeCompanyProfile(args: {
  /** Cached Coresignal EMPLOYEE payload. */
  emp: Rec | undefined
  ctx: ReturnType<typeof trustedCompanyContext>
  statedCompany: string | null
  title: string
  /** Company record the caller resolved (cache, collect, or search), or null. */
  company: Rec | null
  resolvedVia: string | null
  /** Extra `resolveNote` from the caller's own ladder, when it tried and failed. */
  resolveNote?: string | null
  libStage?: string | null
  libTags?: unknown
  nowIso: string
}): Rec {
  const { emp, ctx, statedCompany, title, nowIso } = args
  const e = ctx.entry
  const paid = args.company ? companyFacts(args.company) : null
  const resolveNote = ctx.resolveNote ?? args.resolveNote ?? null

  const merged: Rec = {
    companyName: paid?.companyName ?? e?.company_name ?? (ctx.resolveNote ? null : statedCompany),
    companyId: paid?.companyId ?? e?.company_id ?? null,
    website: paid?.website ?? e?.company_website ?? null,
    linkedin: paid?.linkedin ?? e?.company_linkedin_url ?? null,
    industry: paid?.industry ?? e?.company_industry ?? null,
    sizeRange: paid?.sizeRange ?? e?.company_size_range ?? null,
    employeesCount: paid?.employeesCount ?? e?.company_employees_count ?? null,
    foundedYear: paid?.foundedYear ?? e?.company_founded_year ?? null,
    hq: paid?.hq ?? null,
    whatTheyDo: paid?.description ?? (e?.description ? String(e.description).slice(0, 600) : null),
    categories: paid?.categories ?? [],
    activeJobPostings: paid?.activeJobPostings ?? null,
    stage: paid?.funding?.latestRoundType ?? null,
    lastFundingDate: paid?.funding?.latestRoundDate ?? e?.company_last_funding_round_date ?? null,
    lastFundingAmountUsd:
      paid?.funding?.latestRoundAmountUsd ?? e?.company_last_funding_round_amount_raised ?? null,
    totalRaisedUsd: paid?.funding?.totalRaisedUsd ?? null,
    investors: paid?.funding?.investors ?? [],
    fundingRoundCount: paid?.funding?.roundCount ?? null,
    ycBatch: ctx.ycBatch,
    ycStage: ctx.ycBatch ? ycBatchStage(ctx.ycBatch) : null,
    /**
     * Being YC-backed is a FACT, not a direction in embedding space — "YC backed founders" ranks
     * "YC Fellow @ Y Combinator" first because that is the most YC-sounding string in the pool.
     * So it is a filterable boolean, derived ONLY from evidence about the COMPANY: an explicit
     * batch tag, or Y Combinator in the investor list. WORKING at Y Combinator is NOT being
     * YC-backed, so the employer name is never evidence.
     */
    isYcBacked:
      Boolean(ctx.ycBatch) ||
      ((paid?.funding?.investors ?? []) as string[]).some((i) => /^y[\s-]?combinator$/i.test(String(i).trim())),
    internalLibStage: args.libStage ?? null,
    internalLibTags: args.libTags ?? null,
    statedCompany,
    trustReason: ctx.trustReason,
    resolvedVia: args.resolvedVia ?? (e ? "cached_employee_payload" : null),
    resolveNote,
    resolvedAt: nowIso,
  }
  // "Unknown" means we cannot NAME their company at all. A company we can name but could not
  // enrich is NOT unknown — it keeps its name and the founder's own prose.
  merged.unknownReason = merged.companyName ? null : (resolveNote ?? "no_company_identified")
  // A founder/CEO describing their role IS describing the company. An employee describing theirs is
  // not — so only a founder's own words may stand in for the company's business.
  merged.companyBusiness =
    paid?.description ?? (ctx.isFounder ? (e?.description ?? emp?.active_experience_description ?? null) : null)
  const currentLine = merged.companyName
    ? personExperienceLine(e?.position_title ?? title, merged.companyName, merged)
    : ""
  const lines = experienceLines(currentLine, emp, e)
  merged.matchLine = lines.length ? lines.join(". ") : null
  // undefined is not a Firestore value.
  return JSON.parse(JSON.stringify(merged, (_k, v) => (v === undefined ? null : v))) as Rec
}

// ---------------------------------------------------------------------------
// A Coresignal company record, flattened to the fields we store. Lifted out of
// scripts/yc-company-resolve.ts so the runtime path reads a company collect the
// SAME way the batch did — a second copy would put a different `stage` on the
// live arrivals than the 992 rows they are ranked against.
// ---------------------------------------------------------------------------

/** Funding as a flat, matcher-readable shape. The round TYPE is the paid-only prize. */
export function fundingOf(c: Rec) {
  const rounds: Rec[] = Array.isArray(c.funding_rounds) ? c.funding_rounds : []
  if (!rounds.length) {
    return { latestRoundType: null, latestRoundDate: null, latestRoundAmountUsd: null, totalRaisedUsd: null, investors: [] as string[], roundCount: 0 }
  }
  const dated = rounds.filter((r) => r.announced_date).sort((a, b) => String(b.announced_date).localeCompare(String(a.announced_date)))
  const latest = dated[0] ?? rounds[0]
  const total = rounds.reduce((s, r) => s + (typeof r.amount_raised === "number" ? r.amount_raised : 0), 0)
  return {
    latestRoundType: latest.type ?? null,
    latestRoundDate: latest.announced_date ?? null,
    latestRoundAmountUsd: typeof latest.amount_raised === "number" ? latest.amount_raised : null,
    totalRaisedUsd: total || null,
    investors: [...new Set(rounds.flatMap((r) => (Array.isArray(r.investors) ? r.investors : []).map((i: Rec) => i?.name).filter(Boolean)))].slice(0, 12) as string[],
    roundCount: rounds.length,
  }
}

/** The company record flattened to the fields we store. Shared by the cache and API paths. */
export function companyFacts(c: Rec): Rec {
  return {
    companyId: c.id ?? null,
    companyName: c.company_name ?? null,
    website: c.website ?? null,
    linkedin: c.canonical_linkedin_url ?? c.linkedin_url ?? null,
    industry: c.industry ?? null,
    sizeRange: c.size_range ?? null,
    employeesCount: c.employees_count ?? null,
    foundedYear: c.founded_year ?? null,
    hq: [c.hq_city, c.hq_country].filter(Boolean).join(", ") || null,
    description: typeof c.description === "string" ? c.description.slice(0, 800) : null,
    categories: Array.isArray(c.categories_and_keywords) ? c.categories_and_keywords.slice(0, 12) : [],
    activeJobPostings: c.active_job_postings_count ?? null,
    funding: fundingOf(c),
  }
}

// ---------------------------------------------------------------------------
// The embedded surface: THIS PERSON's experience with the company filled in.
// Lifted verbatim out of scripts/yc-company-resolve.ts so the runtime path
// (yc-pool-sync.ts) composes the SAME matchLine the cohort's 992 rows carry —
// a scanner whose line is worded differently ranks differently for no reason.
// ---------------------------------------------------------------------------

/**
 * First sentence only — a whole About-page paragraph drowns the person's own prose.
 * Requires the break to be followed by a capital AND to leave something substantial,
 * so "Part of Prof. Smith's lab" doesn't truncate to "Part of Prof.".
 */
export const firstCompanySentence = (s: unknown, cap = 220): string => {
  const t = typeof s === "string" ? s.replace(/\s+/g, " ").trim() : ""
  if (!t) return ""
  for (const m of t.matchAll(/(?<=[.!?])\s+(?=[A-Z])/g)) {
    if (m.index !== undefined && m.index >= 40) return t.slice(0, m.index).trim()
  }
  return t.length <= cap ? t : `${t.slice(0, cap).replace(/\s\S*$/, "")}…`
}

/** Funding stage in the words an ask uses. Only ever reached from a REAL funding round. */
const STAGE_WORDS: Record<string, string> = {
  pre_seed: "pre-seed stage startup, very early stage",
  seed: "seed stage startup, early stage",
  series_a: "Series A company",
  series_b: "Series B company",
  series_c: "Series C company",
  series_d_plus: "Series D or later, late stage company",
  ipo_public: "public company",
  private_mature: "established private company",
}

/** Headcount as a phrase, not a range token. A restatement of the number — never a stage claim. */
function headcountWords(n: number): string {
  if (n <= 10) return `small team of ${n} people`
  if (n <= 50) return `${n} people, small company`
  if (n <= 200) return `${n} employees, mid-sized company`
  if (n <= 1000) return `${n} employees, large company`
  return `${n} employees, very large company`
}

/**
 * ONE LINE OF THIS PERSON'S EXPERIENCE, with the company filled in.
 *
 * Adam 2026-07-25: "公司的enrich只是部分内容。。他只是添加了个人用户经历的内容" — the company
 * record is NOT the deliverable, it is extra detail on the person's own history. So the unit is
 * "<role> at <company> — <what that company does>, <stage>", never a detached company blurb:
 * the pool is ranked by embedding, and "anyone who's worked on payments infra" has to bind to a
 * sentence about THIS PERSON. A standalone company profile competes with their prose instead of
 * enriching it.
 *
 * Every clause is measured. Nothing here is inferred — no round from a YC batch year, no
 * business description we did not read off the company record. Unknown company → the line is
 * just "<role> at <company>", exactly what we had before.
 */
export function personExperienceLine(role: unknown, company: unknown, facts: Rec): string {
  const r = typeof role === "string" ? role.trim() : ""
  const c = typeof company === "string" ? company.trim() : ""
  if (!c && !r) return ""
  let line = r && c ? `${r} at ${c}` : r || c
  // ONLY company-sourced text may sit after the em-dash — it reads as "what this company does".
  // The person's own bio must never land here: a Google intern's summary ("Software Engineer |
  // USC Esport Mid Laner") rendered as "at Google — Software Engineer | USC Esport Mid Laner"
  // states something false about Google. Their prose is already in the profile text separately.
  const what = firstCompanySentence(facts.companyBusiness) || (facts.industry ? String(facts.industry) : "")
  if (what) line += ` — ${what}`
  // Trailing qualifiers, most query-relevant first. Comma-joined so they read as part of the
  // same clause about the person, not as a separate record.
  // Spell the facts out in the words a person would ASK with. Cosine matches phrasing, so
  // "W24" alone never binds to "YC backed" — both forms get written. Only ever off a real
  // value; a wrong word here goes straight into the vector and starts attracting queries, so
  // unknown simply omits the clause.
  const tail: string[] = []
  if (facts.ycBatch) tail.push(`Y Combinator ${facts.ycBatch} batch, YC-backed startup`)
  const stageWords = STAGE_WORDS[roundTypeToStage(facts.stage) ?? ""]
  if (stageWords) tail.push(stageWords)
  if (typeof facts.employeesCount === "number") tail.push(headcountWords(facts.employeesCount))
  else if (facts.sizeRange) tail.push(String(facts.sizeRange))
  if (facts.investors?.length) tail.push(`backed by ${facts.investors.slice(0, 3).join(", ")}`)
  return tail.length ? `${line}, ${tail.join(", ")}` : line
}

/**
 * The person's experience as enriched lines, current role first — their own order, not ours.
 * Prior roles carry only what the cached payload already holds for that employer (industry /
 * size); we never fetched their past companies, so we never claim more than that.
 */
export function experienceLines(current: string, emp: Rec | undefined, activeEntry: Rec | null): string[] {
  const out = current ? [current] : []
  const rows: Rec[] = Array.isArray(emp?.experience) ? emp!.experience : []
  for (const e of rows) {
    if (out.length >= 3) break
    if (e === activeEntry) continue
    if (e.active_experience === 1 || e.active_experience === true) continue
    if (!e.company_industry && !e.company_size_range) continue // nothing to add beyond the raw row
    const line = personExperienceLine(e.position_title, e.company_name, {
      whatTheyDo: null,
      industry: e.company_industry,
      sizeRange: e.company_size_range,
      employeesCount: e.company_employees_count,
    })
    if (line) out.push(`previously ${line}`)
  }
  return out
}
