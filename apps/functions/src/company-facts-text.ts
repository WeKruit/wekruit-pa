/**
 * company-facts-text.ts — turn the enriched company record into the WORDS someone would ask with,
 * so the semantic stage can actually find them.
 *
 * WHY THIS EXISTS (Adam 2026-07-25: "如果不行那就得弄成一个向量空间"). "YC backed founders" and
 * "startups around series B" both failed on the live pool — measured, "YC backed founders" returned
 * `YC Fellow @ Y Combinator` and a guy at Stealth, while the 16 people whose company is literally
 * `xPay (YC W24)` / `AgentMail (YC S25)` / `Coasty (YC S26)` never surfaced.
 *
 * The reason was not the ranking. Cosine cannot find what is not in the text: nobody's embedded
 * projection contained the phrase "YC-backed" or "Series B", so there was nothing for those queries
 * to bind to. `companyProfile` held the facts (992/992 records) but they lived in fields, and fields
 * are invisible to an embedding. This composes them into prose and the embed script folds it into
 * the descriptor vector.
 *
 * PHRASE IT LIKE THE QUESTION. An embedding matches wording, so a stored "S24" does not answer
 * "who's YC backed" — we write BOTH the batch and the plain phrase. Same for headcount: "1-10" is a
 * token, "small team" is what people say.
 *
 * NEVER GUESS (Adam, standing rule: "这个公司信息不能猜"). Every line below is emitted only from a
 * value we actually hold. This matters more here than anywhere else in the pipeline: a wrong word
 * does not just sit in a field, it enters the vector and starts ATTRACTING the queries it is wrong
 * about. Unknown → the sentence is simply absent. No hedges either — "possibly seed stage" binds
 * exactly as strongly as a fact.
 */

/** The enriched company record, as written by the YC company-enrichment scripts. */
export interface CompanyProfileLike {
  /** Pre-composed "role at company — what the company does" prose, when the enricher built one. */
  matchLine?: string | null
  companyName?: string | null
  /** YC batch code as it appears on the company, e.g. "S24", "W26". */
  ycBatch?: string | null
  isYcBacked?: boolean | null
  /** Canonical stage token, e.g. "pre_seed" | "seed" | "series_a" — only from real evidence. */
  stage?: string | null
  /** Coresignal headcount band, e.g. "1-10", "11-50". */
  sizeRange?: string | null
  employeesCount?: number | null
  industry?: string | null
  investors?: Array<{ name?: string | null } | string> | null
}

/** Canonical stage token → how a person would say it out loud. */
const STAGE_WORDS: Record<string, string> = {
  pre_seed: "pre-seed stage, very early startup",
  seed: "seed stage startup",
  series_a: "Series A company",
  series_b: "Series B company",
  series_c: "Series C company",
  series_d_plus: "late stage company, Series D or later",
  ipo_public: "public company",
}

/**
 * Headcount band → the phrase people actually use for a company that size.
 *
 * Both spellings of every band are listed literally, because Coresignal writes "1-10 employees" on
 * some records and "1-10" on others. NO REGEX (Adam 2026-07-25: "所有的regex，完全不能有") — a
 * closed vendor vocabulary is a lookup, and pattern-stripping a suffix off a known value set is the
 * worst of both worlds: it reads as fuzzy, behaves as exact, and breaks silently the day the vendor
 * writes an en dash. An unlisted spelling falls through to the employee count or to nothing.
 */
const SIZE_WORDS: Record<string, string> = {
  "myself only": "solo founder, one person",
  "1-10": "tiny team, under 10 people",
  "11-50": "small startup, tens of people",
  "51-200": "mid-size company",
  "201-500": "several hundred employees",
  "501-1000": "large company",
  "1001-5000": "large company, thousands of employees",
  "5001-10000": "very large company",
  "10001+": "very large company",
  "myself only employees": "solo founder, one person",
  "1-10 employees": "tiny team, under 10 people",
  "11-50 employees": "small startup, tens of people",
  "51-200 employees": "mid-size company",
  "201-500 employees": "several hundred employees",
  "501-1000 employees": "large company",
  "1001-5000 employees": "large company, thousands of employees",
  "5001-10000 employees": "very large company",
  "10001+ employees": "very large company",
}

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : ""
}

/**
 * Compose the company facts as embeddable prose. Empty string when we know nothing — an empty
 * contribution is correct and leaves the descriptor exactly as it was.
 */
export function companyFactsText(p: CompanyProfileLike | null | undefined): string {
  if (!p || typeof p !== "object") return ""
  const parts: string[] = []

  const line = str(p.matchLine)
  if (line) parts.push(line)

  // YC: write the batch AND the plain phrase. "S24" alone does not answer "who is YC backed".
  const batch = str(p.ycBatch)
  if (batch) parts.push(`Y Combinator ${batch} batch, YC-backed startup, backed by Y Combinator`)
  else if (p.isYcBacked === true) parts.push("YC-backed startup, backed by Y Combinator")

  // Stage ONLY from a canonical token we resolved from real evidence. `unknown` writes nothing.
  const stage = str(p.stage)
  if (stage && stage !== "unknown" && STAGE_WORDS[stage]) parts.push(STAGE_WORDS[stage]!)

  const size = str(p.sizeRange).toLowerCase()
  if (SIZE_WORDS[size]) parts.push(SIZE_WORDS[size]!)
  else if (typeof p.employeesCount === "number" && p.employeesCount > 0) {
    parts.push(`${p.employeesCount} people`)
  }

  const industry = str(p.industry)
  if (industry) parts.push(industry)

  // Investor names are a real ask ("anyone backed by a16z?") and are only ever present when the
  // funding record named them.
  const investors = (p.investors ?? [])
    .map((x) => (typeof x === "string" ? x : str(x?.name)))
    .filter((x) => x.length > 0)
  if (investors.length > 0) parts.push(`investors: ${investors.slice(0, 6).join(", ")}`)

  return parts.join(". ")
}
