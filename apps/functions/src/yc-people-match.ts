/**
 * yc-people-match.ts — people↔people matching for an event cohort (Adam 2026-07-25).
 *
 * WHY THIS EXISTS: Claire promises every YC Startup School scanner she'll match them with "the
 * right Startup School people", but nothing produced that match. The two answers she collects
 * (`ycIntake.building` / `wantsToMeet`) were stored and never consumed by any matcher, and every
 * matcher in the repo is job-centric.
 *
 * SHAPE: modelled on `apps/job-rec/src/reverse-match.ts`, which is already person-pool cosine
 * matching (embed a query → load a pool → cosine → rerank → topK). We reuse its *components* rather
 * than wrapping `runReverseMatch` itself, because that driver internally calls
 * `synthesizeJobFromJd` → `applyHardFilters` (visa / location / seniority / yoe). Those are job
 * semantics and would silently drop attendees — an investor "needing sponsorship" is meaningless.
 *
 * NOT PURE SEMANTIC. Cosine answers "who is like me / building something similar", but the asks
 * people actually make are mixed:
 *     "people doing fintech"        → facet   (industrySector)
 *     "who else does ML"            → facet   (skills)
 *     "anyone from my school"       → RELATIONAL exact match against the ASKER's own schools
 *     "who's built something like mine" → semantic
 * So: structured facets narrow the pool, semantics rank inside it.
 *
 * ONE-DIRECTIONAL by design. The cohort never told us who *they* want to meet and never opted in,
 * so only the scanner receives recommendations; nobody in the pool is contacted.
 */
import type { Firestore } from "firebase-admin/firestore"
// Query-side parity with the stored, canonicalized skill form (see passesFacets).
import { normalizeSkillToken } from "./skill-token.js"
import {
  canonicalEntityToken,
  canonicalEntityTokens,
  tokensIntersect,
  type EntityKind,
} from "./entity-token.js"
import { YC_ENTITY_OVERLAY } from "./yc-entity-overlay.generated.js"

export const YC_COHORT_2026 = "yc_startup_school_2026"

/** A person in the matchable pool, flattened from an external-candidate record. */
export interface PeoplePoolMember {
  recordId: string
  name: string | null
  linkedinUrl: string | null
  currentTitle: string | null
  currentCompany: string | null
  location: string | null
  schools: string[]
  majors: string[]
  companies: string[]
  skills: string[]
  /** Text used for the semantic stage. */
  matchText: string
  /** Index-time "what their company actually builds" — the honest why-line when no facet is set. */
  whatTheyBuild: string | null
  embedding?: number[] | null
  /**
   * Second vector: the `businessDescriptor` ALONE (see `descriptorText`). Optional — ~10 of 992
   * records have no descriptor, and those still rank on `embedding` alone.
   */
  descriptorEmbedding?: number[] | null
  /** How many DISTINCT users have already been shown this person (see `EXPOSURE_FIELD`). */
  exposureCount: number
  /** `PERSON_TYPE_VOCAB` — what KIND of person, index-time. Empty when undescribed. */
  personType: string[]
  /** `COMPANY_STAGE_VOCAB` value for their current company, or "unknown". See `inferCompanyStage`. */
  companyStage: string
  /** Where `companyStage` came from — "company_size" means we guessed it from headcount. */
  companyStageSource: CompanyStageSource
  /** "Likely Match" | "First Result" | "Needs Review" | … — the sheet's own confidence. */
  matchStatus: string | null
}

/** Facets the agent may set. Every one is optional; set ones are AND-ed. */
export interface YcPeopleMatchFilters {
  /** Free-text semantic steer. Falls back to the asker's own intake answers. */
  query?: string
  skills?: string[]
  industrySector?: string[]
  roleFunction?: string[]
  companies?: string[]
  schools?: string[]
  major?: string[]
  location?: string[]
  /**
   * `PERSON_TYPE_VOCAB` — "investors", "founders", "operators", "students". OR-ed within the facet.
   * A facet, not a semantic hint, because a title is a job and not a kind of person.
   */
  personType?: string[]
  /**
   * `COMPANY_STAGE_VOCAB` — "startup series B 左右的". OR-ed within the facet, matched EXACTLY
   * against `inferCompanyStage`, so an ask nobody satisfies returns ~nothing and trips the relax
   * path rather than manufacturing confident-looking wrong people.
   */
  fundingStage?: string[]
  /** Relational — resolved from the ASKER's own profile, never guessed by the model. */
  sameSchool?: boolean
  sameCompany?: boolean
  sameMajor?: boolean
}

export interface YcPeopleMatchResult {
  recordId: string
  name: string | null
  linkedinUrl: string | null
  title: string | null
  company: string | null
  location: string | null
  score: number
  /** Human-readable "why" naming WHICH signal matched. */
  reason: string
  /**
   * What they actually build — the index-time `businessDescriptor.whatTheyBuild`, first sentence.
   * SEPARATE from `reason` on purpose: a facet ask makes `reason` the facet ("also went to
   * Berkeley"), which says nothing about the person. Adam 2026-07-25: every card carries a bit of
   * the enrichment we already paid for. Null when the record has no descriptor (~10 of 992).
   */
  summary: string | null
  /** True when the facet filter yielded too few and this row came from the widened pool. */
  relaxed: boolean
  matchStatus: string | null
}

export interface YcPeopleMatchOutput {
  results: YcPeopleMatchResult[]
  poolSize: number
  /** How many survived the facet stage — surfaced so Claire can be honest about a narrow ask. */
  facetMatched: number
  /** True when we widened because the facets were too narrow. */
  didRelax: boolean
  /**
   * The ASK itself landed on nobody in this pool, so these people were ranked by the asker's own
   * domain instead of by what they asked for. Not a failure and not a filter — the results are still
   * the closest we have — but the intro has to say so rather than presenting them as the ask's
   * answer. See the `askMissed` block in `runYcPeopleMatch` for the measured split.
   */
  askMissed?: boolean
  reason?: "no_intake" | "empty_pool" | "embed_failed"
}

// ---------------------------------------------------------------------------
// Step 3 — the people projection
// ---------------------------------------------------------------------------

const MAX_TEXT = 8000

/**
 * What the person's company actually DOES — derived once at index time by
 * `scripts/describe-yc-attendees.ts` (gpt-5.4-nano) and cached on the record.
 * A profile says "Software Engineer @ Faire", never "two-sided marketplace", so business-MODEL
 * queries had no surface to bind to. This gives them one.
 */
export interface BusinessDescriptor {
  /** e.g. ["two_sided_marketplace", "ecommerce"] */
  businessModel: string[]
  /** e.g. ["wholesale retail", "logistics"] */
  domain: string[]
  /** One sentence: product category + who buys it. */
  whatTheyBuild: string
  /**
   * WHAT KIND OF PERSON this is — `PERSON_TYPE_VOCAB`, multi-pick. Also nano-derived.
   *
   * This is the single most common ask at the event and semantics answered it only by luck of
   * wording. Measured 2026-07-25 over the real cohort: "investors, VCs, angel investors" ranked
   * actual investors (Hico Ventures, pebblebed) because those companies have the word "Ventures"
   * in them; "operators at startups" returned a YC Fellow and an a16z design fellow, and
   * "senior mentors or advisors" returned a CS tutor and a research intern. A title is a job, not
   * a kind of person — so the kind gets materialised here and filtered as a FACET.
   */
  personType?: string[]
  generatedAt?: string
}

/**
 * The kinds of person people actually ask for at Startup School. Grounded, not invented: every
 * value below appears verbatim in a real `ycIntake.wantsToMeet` answer or an inbound text read on
 * 2026-07-25 — "consumer founders and investors", "infra founders and anyone doing dev tools",
 * "operators who need to face them directly", "creatives", "people who run fellowships",
 * "someone who would be willing to mentor me", "Finding cofounder / Product side".
 *
 * Multi-pick: a founder is usually also an engineer, and both are true.
 */
export const PERSON_TYPE_VOCAB = [
  "founder",
  "investor",
  /** Runs a fellowship / accelerator / community / event programme (YC staff, Cansbridge, ASES). */
  "program_operator",
  "engineer",
  "researcher",
  "product",
  "designer",
  /** Non-founder, non-engineer at an operating company — GTM, bizops, ops, sales. */
  "operator",
  "executive",
  "recruiter",
  /** Still in school (or an internship as their current role). */
  "student",
] as const

/**
 * How confident the `companyStage` value is. Load-bearing for honesty: Adam 2026-07-25,
 * "查不到就不要硬匹配，给用户说咱们这个确实少" — a stage we GUESSED from headcount must not be
 * presented like a funding round we looked up.
 */
export type CompanyStageSource = "funding_round" | "library" | "company_size" | "unknown"

/**
 * Coresignal `funding_rounds[].type` → `COMPANY_STAGE_VOCAB`. An exact lookup over the vendor's
 * closed set of round names — no pattern matching. An unlisted round type yields null, which
 * becomes `unknown` rather than a guess.
 */
const ROUND_TYPE_TO_STAGE: Record<string, string> = {
  "pre seed round": "pre_seed",
  "angel round": "pre_seed",
  grant: "pre_seed",
  "seed round": "seed",
  "convertible note": "seed",
  "series a round": "series_a",
  "venture round": "series_a",
  "series b round": "series_b",
  "series c round": "series_c",
  "series d round": "series_d_plus",
  "series e round": "series_d_plus",
  "series f round": "series_d_plus",
  "post ipo equity": "ipo_public",
  "post ipo debt": "ipo_public",
}

/** The real last funding round as a vocab stage, or null when we don't recognise it. */
export function roundTypeToStage(roundType: string | null | undefined): string | null {
  if (typeof roundType !== "string") return null
  return ROUND_TYPE_TO_STAGE[roundType.trim().toLowerCase()] ?? null
}

/**
 * LinkedIn/Coresignal `company_size_range` → the single most likely stage. An exact lookup over the
 * vendor's closed value set, both comma and non-comma spellings. A value we have never seen yields
 * `unknown` — it does not fall through to a nearest-match guess.
 */
const SIZE_RANGE_TO_STAGE: Record<string, string> = {
  "myself only": "pre_seed",
  "1-10 employees": "seed",
  "11-50 employees": "series_a",
  "51-200 employees": "series_b",
  "201-500 employees": "series_c",
  "501-1000 employees": "series_d_plus",
  "501-1,000 employees": "series_d_plus",
  "1001-5000 employees": "series_d_plus",
  "1,001-5,000 employees": "series_d_plus",
  "5001-10000 employees": "ipo_public",
  "5,001-10,000 employees": "ipo_public",
  "10001+ employees": "ipo_public",
  "10,001+ employees": "ipo_public",
}

/**
 * Funding stage for an attendee's CURRENT company.
 *
 * WHY NOT THE COMPANY LIBRARY: `pa-companies` was accumulated from JOB POSTINGS, so it knows
 * mature employers. Against this cohort it resolves 137 of 937 (15%) — 83 `ipo_public`,
 * 26 `series_d_plus`, 9 `private_mature`, and exactly ONE `series_b`. Startup School people are
 * overwhelmingly at their own just-founded company (dossierai.org, Operon, Coasty), which no
 * job-board-derived library will ever contain. So the library is kept as an exact override where
 * it exists and everything else is inferred.
 *
 * WHAT IT READS, most authoritative first. No pattern matching anywhere — every step is an exact
 * lookup over a vendor-closed value set, or nothing:
 *
 *   1. `profileStage` — the REAL last funding round from `companyProfile.stage` (Coresignal).
 *      The only actual answer. 20 of the 120 founders we have a company for.
 *   2. `libraryStage` — `pa-companies`, exact override where the company is in the library.
 *   3. `companySizeRange` — headcount, `source: "company_size"` so the card can present it as the
 *      weaker evidence it is.
 *   4. nothing → `unknown`.
 *
 * A `fundingStage` facet matches this value EXACTLY, so `unknown` yields ~nothing and trips the
 * relax/honesty path — the correct outcome for a stage we cannot establish (Adam 2026-07-25,
 * "查不到就不要硬匹配").
 *
 * MEASURED, against the 20 founders whose real round we now hold: the string rules this function
 * used to run were wrong 11 times in 20; reading the real round first is right 19 of 20 (the miss
 * is Entrepreneurs First, series_c, which has no headcount and no round on its record).
 *
 * WHAT IT DELIBERATELY NO LONGER DOES:
 *  - "(YC W24)" → `seed`. Measured false: W24 companies still show "Pre Seed Round" as their
 *    latest (xPay, Centralize, Focal). A batch tag says "YC-backed and this old", not which round.
 *  - "Stealth" → `pre_seed`. "Stealth" is a founder declining to say, not a stage.
 *
 * NOT CHANGED, because the data refused it (checked 2026-07-25, do not "fix" this on intuition):
 * shifting the headcount bands down one notch for a YC crowd looks obviously right and is WORSE —
 * 4 of 12 correct vs the current 5 of 12, because "1-10 → seed" carries seven right answers that a
 * shift to pre_seed would break to win three.
 */
export function inferCompanyStage(p: {
  /** `companyProfile.stage` — the real last funding round type. Beats everything below. */
  profileStage?: string | null
  /** Coresignal experience rows — `companySizeRange` is read off the current role. */
  experience?: Array<{ currentRole?: unknown; companySizeRange?: unknown }>
  /** `pa-companies.companyStage`, when the company is in the library. */
  libraryStage?: string | null
}): { stage: string; source: CompanyStageSource } {
  const funded = roundTypeToStage(p.profileStage)
  if (funded) return { stage: funded, source: "funding_round" }

  const lib = String(p.libraryStage ?? "").trim().toLowerCase().replace(/[\s-]+/g, "_")
  if (lib && lib !== "unknown") return { stage: lib, source: "library" }

  const exp = p.experience ?? []
  const cur = exp.find((e) => e?.currentRole === true) ?? exp[0]
  const size = typeof cur?.companySizeRange === "string" ? cur.companySizeRange.trim().toLowerCase() : ""
  const stage = SIZE_RANGE_TO_STAGE[size]
  return stage ? { stage, source: "company_size" } : { stage: "unknown", source: "unknown" }
}

/**
 * Flatten a descriptor into embeddable prose. Empty string when absent.
 * Also the exact text of the SECOND, descriptor-only vector (`descriptorEmbedding`) —
 * `scripts/embed-yc-attendees.ts` embeds this string verbatim.
 */
export function descriptorText(b: BusinessDescriptor | null | undefined): string {
  if (!b) return ""
  const parts = [
    (b.businessModel ?? []).map((x) => x.replace(/_/g, " ")).join(", "),
    (b.domain ?? []).join(", "),
    typeof b.whatTheyBuild === "string" ? b.whatTheyBuild : "",
  ].filter((x) => x && x.trim().length > 0)
  return parts.join(". ")
}

/**
 * The business-model tokens, repeated, as the FIRST line of the projection.
 *
 * Repetition is not decoration: a profile is ~1500 tokens and the descriptor ~40, so folding it in
 * once only moves "marketplace" precision@8 from 0.13 → 0.38. Repeating the model tokens at the
 * head takes it to 0.88 (measured over the 988-person cohort, 2026-07-25) — the abstraction has to
 * hold real mass in a mean-pooled vector or the profile prose drowns it.
 *
 * The separate descriptor-only vector this comment used to point at is now SHIPPED
 * (`descriptorEmbedding`, max() in `runYcPeopleMatch`) and measured at P@8 0.977 vs 0.886 for this
 * head alone. The head stays: it is what the ~10 descriptor-less records still rank on, and removing
 * it is an unmeasured change to every stored vector.
 *
 * MEASURED AND REJECTED (2026-07-25), do not re-litigate without new data: a centroid/"hub" penalty
 * (score -= W * cos(member, poolCentroid)) and mean-centering. The 20 members nearest the pool
 * centroid never appeared in ANY top-8 across 17 queries, so hubness was not the cause of repeated
 * faces (query dilution was — see the embed-target note in `runYcPeopleMatch`), and every hub
 * variant cost person-level quality: judged P@8 0.613 → 0.487 (W=.15) / 0.412 (.30) / 0.400 (.50),
 * mean-centering 0.512, while coverage barely moved (42 → 45 of 50 slots).
 */
const MODEL_REPEATS = 3

function businessModelHead(b: BusinessDescriptor | null | undefined): string {
  const models = (b?.businessModel ?? []).map((x) => x.replace(/_/g, " ")).filter((x) => x.trim())
  if (models.length === 0) return ""
  return `${models.join(", ")}. `.repeat(MODEL_REPEATS).trim()
}

/**
 * Build the text we embed for people matching.
 *
 * `synthesizeCvSummaryText` (lib/embeddings.ts:68) already contains skills / experience / education
 * / industry / location — nothing is "lost" by not using it. The difference is WEIGHTING: it is a
 * job projection (skills prominent, top-3 experiences, 25 skills), so two people who both list
 * `Python, React, AWS` score as similar even when one does biotech and the other games. For "should
 * I meet this person" the dominant signal is what they're building and in what domain, so:
 *   - current role first (strongest),
 *   - all prior experience (not truncated to 3 — serial founders lose their early companies),
 *   - skills capped at 12 (not 25) so they cannot drown the domain signal,
 *   - education last.
 */
export function synthesizePeopleMatchText(p: {
  name?: string | null
  currentTitle?: string | null
  currentCompany?: string | null
  location?: string | null
  experience?: Array<{ title?: string | null; company?: string | null; description?: string | null }>
  education?: Array<{ school?: string | null; degree?: string | null }>
  skills?: string[]
  industry?: string[]
  /** The person's own words — beats any inferred profile. Only the asker has these. */
  intent?: string | null
  /** Index-time company knowledge (business model / domain). Absent for the asker. */
  businessDescriptor?: BusinessDescriptor | null
  /**
   * `companyProfile.matchLine` — measured company facts (industry, headcount, funding
   * round, investors, founded year) as one embeddable sentence. Absent for the asker
   * and for anyone whose employer we could not establish.
   */
  companyMatchLine?: string | null
}): string {
  const lines: string[] = []
  const s = (v: unknown) => (typeof v === "string" ? v.trim() : "")

  // 0. Business model, weighted to the head — the only surface an abstract query
  // ("marketplace", "B2B SaaS") can bind to. Nobody writes it on their profile.
  const head = businessModelHead(p.businessDescriptor)
  if (head) lines.push(head)

  // 1. What they do NOW — the single strongest signal for "worth meeting".
  const title = s(p.currentTitle)
  const company = s(p.currentCompany)
  if (title || company) lines.push(title && company ? `${title} @ ${company}` : title || company)

  // 1b. What that company actually does — sits right behind the role so the abstraction
  // ("marketplace", "b2b saas") is near the top of the projection, where cosine weights it.
  const bd = descriptorText(p.businessDescriptor)
  if (bd) lines.push(bd)

  // 1c. Measured facts about that company — headcount, funding round, investors, industry.
  // Sits with the other company lines so "early-stage startup" / "YC-backed" / "big company"
  // asks have something to bind to. The descriptor above says WHAT they build; this says
  // what KIND of company it is, which no profile text ever states.
  const cml = s(p.companyMatchLine)
  if (cml) lines.push(cml)

  // 2. Domain.
  const industry = (p.industry ?? []).filter((x) => s(x))
  if (industry.length > 0) lines.push(industry.join(", "))

  // 3. Stated intent — what they SAY they're building / who they want to meet.
  const intent = s(p.intent)
  if (intent) lines.push(intent)

  // 4. Full experience timeline (title @ company + description), not truncated.
  const exp: string[] = []
  for (const e of p.experience ?? []) {
    const t = s(e?.title)
    const c = s(e?.company)
    const d = s(e?.description)
    const head = t && c ? `${t} @ ${c}` : t || c
    if (!head && !d) continue
    exp.push(d ? `${head}\n${d}` : head)
  }
  if (exp.length > 0) lines.push(exp.join("\n"))

  // 5. Skills, capped low on purpose.
  const skills = dedupeLower(p.skills ?? []).slice(0, 12)
  if (skills.length > 0) lines.push(skills.join(", "))

  // 6. Education last — weakest signal for "should we meet".
  const edu = (p.education ?? [])
    .map((e) => {
      const d = s(e?.degree)
      const sc = s(e?.school)
      return d && sc ? `${d} @ ${sc}` : d || sc
    })
    .filter((x) => x.length > 0)
  if (edu.length > 0) lines.push(edu.join("\n"))

  const loc = s(p.location)
  if (loc) lines.push(loc)

  return lines.join("\n").trim().slice(0, MAX_TEXT)
}

function dedupeLower(xs: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const x of xs) {
    const k = String(x ?? "").trim().toLowerCase()
    if (!k || seen.has(k)) continue
    seen.add(k)
    out.push(String(x).trim())
  }
  return out
}

// ---------------------------------------------------------------------------
// Step 4 — hybrid retrieval
// ---------------------------------------------------------------------------

/**
 * THE FACET STAGE IS TOKEN EQUALITY. No substring test, no RegExp, no length floor anywhere below.
 * Adam 2026-07-25: "所有的regex，完全不能有，我服了，regex只会让事情变麻烦".
 *
 * WHAT WAS HERE: `looseHit`, bidirectional substring containment, plus the chain of patches it
 * needed — an escape function, a `MIN_REVERSE_MATCH = 4` length floor, and word-boundary RegExps in
 * both directions. Each patch plugged a hole the previous one opened: a bare "rl" matched "world"
 * and "early" (63 irrelevant people), a member carrying the skill "c" matched EVERY query
 * containing the letter c (235 of 988, still live when this was written), "chi" matched "machine
 * learning". A text fragment is not an identity, and no amount of boundary-tightening makes it one.
 *
 * WHAT IT IS NOW: both sides canonicalize through the SAME resolver (`entity-token.ts`; skills via
 * `skill-token.ts`) and the test is set intersection over the resulting identifiers. Query/storage
 * parity is structural rather than remembered — there is one function, so the two cannot drift.
 *
 * MEASURED on the live 988-person pool (`scripts/probe-yc-facet-tokens.ts`), before → after:
 *   skill "c"          235 → 0     the wildcard, gone
 *   skill "art"          6 → 0     no longer hits "smart"
 *   school "MIT"         4 → 53    substring never matched the spelled-out name; identity does
 *   location asks        0 → 247   substring could not match a location token AT ALL
 *   company "Google"    61 → 64    gains DeepMind, drops Metaculus / MetaProp
 *   school "Berkeley"   68 → 66    keeps College of Engineering / Haas / EECS
 * Recall went UP, not traded away. Full table and named ceilings live in that script.
 */
function skillTokens(xs: readonly string[]): string[] {
  const out = new Set<string>()
  for (const x of xs) {
    const t = normalizeSkillToken(x)
    if (t) out.add(t)
  }
  return [...out]
}

/** The member's canonical identifiers for one facet. */
function memberTokens(m: PeoplePoolMember, kind: EntityKind): string[] {
  const raws =
    kind === "school" ? m.schools
    : kind === "company" ? m.companies
    : kind === "major" ? m.majors
    : m.location ? [m.location] : []
  return canonicalEntityTokens(kind, raws, YC_ENTITY_OVERLAY)
}

/** The asked values as canonical identifiers. Unresolvable values simply do not appear. */
function askedTokens(kind: EntityKind, values: readonly string[]): string[] {
  return canonicalEntityTokens(kind, values, YC_ENTITY_OVERLAY)
}

/** Closed-vocab token normaliser — "Series B" / "series-b" → "series_b". */
function norm(x: string): string {
  return String(x ?? "").trim().toLowerCase().replace(/[\s-]+/g, "_")
}

/**
 * A MULTI-KIND ASK GETS EVERY KIND IT NAMED.
 *
 * `personType` is OR-ed, so "founders and investors" admits both — and then loses, because the pool
 * is not balanced: 214 people whose primary type is `founder` against 21 investors. Cosine ranks them
 * together and the majority sweeps every slot. Measured live on the 1159-pool, "Majorly founders and
 * investors" (personType [founder,investor], the shape 8 real asks used today) returned FIVE founders
 * and ZERO investors — an answer to half the question that looks like an answer to all of it.
 *
 * So take turns: best founder, best investor, next founder, next investor. Order WITHIN each kind is
 * still pure cosine, so nobody is promoted over a better match of their own kind, and the head of the
 * list is still the single best person we found. A kind the pool cannot fill simply contributes
 * nothing and the others close up — this never pads and never invents.
 *
 * Single-kind asks and unfaceted asks return the input untouched.
 */
export function interleaveByPersonType<T extends { m: PeoplePoolMember; relaxed: boolean }>(
  rows: readonly T[],
  kinds: readonly string[],
): T[] {
  if (kinds.length < 2) return [...rows]
  const taken = new Set<T>()
  const buckets = kinds.map((k) => {
    const want = norm(k)
    const b = rows.filter((r) => !r.relaxed && !taken.has(r) && r.m.personType[0] === want)
    // A person is only ever counted once, even if two named kinds could claim them.
    for (const r of b) taken.add(r)
    return b
  })
  const out: T[] = []
  for (let i = 0; buckets.some((b) => b[i] !== undefined); i++) {
    for (const b of buckets) {
      const r = b[i]
      if (r) out.push(r)
    }
  }
  // Anything the buckets did not claim (relaxed filler, or a primary type nobody asked for that only
  // got here via the cosine floors) keeps its place behind them, in its original order.
  return [...out, ...rows.filter((r) => !taken.has(r))]
}

/** Apply every set facet. All AND-ed; an unset facet is a pass. */
export function passesFacets(
  m: PeoplePoolMember,
  f: YcPeopleMatchFilters,
  asker: { schools: string[]; companies: string[]; majors: string[] },
): boolean {
  // Skills canonicalize with abbreviations EXPANDED (`ml` → `machine_learning`), so BOTH sides go
  // through `normalizeSkillToken` or the facet silently returns nobody.
  if (f.skills?.length && !tokensIntersect(skillTokens(m.skills), skillTokens(f.skills))) return false
  if (f.schools?.length && !tokensIntersect(memberTokens(m, "school"), askedTokens("school", f.schools))) return false
  if (f.companies?.length && !tokensIntersect(memberTokens(m, "company"), askedTokens("company", f.companies))) return false
  if (f.major?.length && !tokensIntersect(memberTokens(m, "major"), askedTokens("major", f.major))) return false
  if (f.location?.length && !tokensIntersect(memberTokens(m, "location"), askedTokens("location", f.location))) return false
  // `industrySector` / `roleFunction` are NOT facets and no longer gate membership. Coresignal
  // stores no canonical industry or role per attendee, so this used to compare a canonical enum
  // value against free prose by substring — a membership gate built on string containment, which is
  // the same bug wearing a facet's clothes. MEASURED (scripts/probe-yc-industry-fold.ts): the
  // `financial_technology` gate admitted 2 people out of 988 and neither was a fintech match, and
  // the `sales` gate admitted a dishwasher and a Software Engineer at Salesforce ("sales" ⊂
  // "Salesforce"). They are folded into the semantic query in `runYcPeopleMatch` instead, where
  // they steer ranking — which is what "所有的root都必须是语意匹配" actually asks for.
  //
  // EXACT, not loose: both are closed vocabularies we generated ourselves, and `includes` here is
  // array membership over canonical tokens, not text containment.
  // PRIMARY personType only (Adam 2026-07-25: "this person ask for investor why we keep sending
  // wrong match???"). `personType` is a RANKED list from the descriptor LLM — slot 0 is who the
  // person actually is, slots 1-2 are weak secondary colour. Membership treated every slot as equal,
  // so an "investors" ask returned:
  //     Jack Lau      Co-Founder @ Stealth AI     founder,investor
  //     Ryan Schwartz Co-Founder @ Stealth        founder,investor
  //     Calvin Cha    Product & Growth @ Blidz    product,founder,investor
  //     Teresa Huang  Product Manager @ DataVisor product,engineer,investor
  // — four founders/PMs — while 13 people whose PRIMARY type is `investor` (Richard Liu @ Llama
  // Ventures, Sonica Prakash @ Crater Ventures, Raghav Goyal @ Antler, Samuel Kim @ Hico Ventures…)
  // were never surfaced. 22 records carry `investor` anywhere; only 13 of those ARE investors.
  // Matching slot 0 is what makes the facet mean what the user meant. If that yields too few, the
  // EXISTING relax path widens and says so out loud — the honest behaviour we already have, rather
  // than a silent substitution dressed up as a match.
  if (f.personType?.length && !f.personType.some((x) => norm(x) === m.personType[0])) return false
  if (f.fundingStage?.length && !f.fundingStage.some((x) => norm(x) === m.companyStage)) return false
  // Relational — a JOIN on identifiers resolved from the ASKER, so the model never has to know
  // their school name and the comparison stops being fuzzy at all.
  if (f.sameSchool && !tokensIntersect(memberTokens(m, "school"), askedTokens("school", asker.schools))) return false
  if (f.sameCompany && !tokensIntersect(memberTokens(m, "company"), askedTokens("company", asker.companies))) return false
  if (f.sameMajor && !tokensIntersect(memberTokens(m, "major"), askedTokens("major", asker.majors))) return false
  return true
}

/** Which facet actually produced this hit — so the "why" line is honest, not generic. */
export function explainMatch(
  m: PeoplePoolMember,
  f: YcPeopleMatchFilters,
  asker: { schools: string[]; companies: string[]; majors: string[] },
): string {
  /** The member's own raw value whose token is in `want` — the label we can honestly show. */
  const naming = (kind: EntityKind, raws: string[], want: string[]): string | null => {
    if (want.length === 0) return null
    const set = new Set(want)
    for (const raw of raws) {
      const t = canonicalEntityToken(kind, raw, YC_ENTITY_OVERLAY)
      if (t && set.has(t)) return raw
    }
    return null
  }
  if (f.sameSchool) {
    const hit = naming("school", m.schools, askedTokens("school", asker.schools))
    if (hit) return `also went to ${hit}`
  }
  if (f.sameCompany) {
    const hit = naming("company", m.companies, askedTokens("company", asker.companies))
    if (hit) return `also worked at ${hit}`
  }
  if (f.schools?.length) {
    const hit = naming("school", m.schools, askedTokens("school", f.schools))
    if (hit) return `${hit}`
  }
  if (f.companies?.length) {
    const hit = naming("company", m.companies, askedTokens("company", f.companies))
    if (hit) return `${hit}`
  }
  if (f.skills?.length) {
    const want = new Set(skillTokens(f.skills))
    const hit = m.skills.find((s) => {
      const t = normalizeSkillToken(s)
      return t !== null && want.has(t)
    })
    if (hit) return `works on ${hit}`
  }
  // NO FACET SET — the DEFAULT path. The intake-complete auto-fire passes only `query`, so every
  // branch above is skipped and the old fallback returned "title @ company"… which is byte-identical
  // to the bubble's own header, so `buildPersonBubble` suppressed it and the person arrived with NO
  // why-line at all (live 2026-07-25: "Max Chen — Associate Product Manager @ Tesla" + a URL, for an
  // "ai agent or robotics" ask — he actually builds AI agent products for supply-chain ops at Tesla,
  // and the match was good, but it READ like a random Tesla PM).
  // `whatTheyBuild` is the index-time descriptor already loaded on the record and already the thing
  // the semantic stage matched on, so it is the honest "why". First sentence only — the generator
  // often appends a second, weaker clause.
  const built = firstSentence(m.whatTheyBuild)
  if (built) return built
  const t = m.currentTitle ?? ""
  const c = m.currentCompany ?? ""
  return t && c ? `${t} @ ${c}` : t || c || "worth meeting"
}

/** First sentence, trimmed to one bubble line. "" when there is nothing usable. */
function firstSentence(v: string | null | undefined): string {
  const s = String(v ?? "").trim()
  if (!s) return ""
  const head = (s.split(/(?<=\.)\s+/)[0] ?? s).trim().replace(/\.$/, "")
  return head.length > 180 ? `${head.slice(0, 177).trimEnd()}…` : head
}

// ---------------------------------------------------------------------------
// Pool loading
// ---------------------------------------------------------------------------

const RECORDS = "pa-external-candidate-records"

/**
 * The pool record id for a WeKruit user who joined the pool themselves (`yc-pool-sync.ts`).
 *
 * DERIVED FROM THE `pa-users` ID, never random, for two reasons:
 *  1. IDEMPOTENCE — a second enrichment for the same person updates their row instead of forking a
 *     duplicate face into the pool.
 *  2. SELF-EXCLUSION — `runYcPeopleMatch` knows the asker's userId and nothing else, so a derivable
 *     id is what lets it drop the asker from their own pool. Without it the first person to scan
 *     after the sync ships gets themselves back as their own top match at cosine ~1.0.
 */
export function ycPoolRecordId(userId: string): string {
  return `yc-user:${userId}`
}

/**
 * Per-record counter: how many distinct users have been shown this person.
 *
 * WHY A SCALAR ON THE RECORD, not a list or a shared map doc: the delivery path writes it with
 * `FieldValue.increment(1)` per delivered recordId, which is server-side atomic, so two users
 * matched concurrently cannot lose an increment. The repo already has the counterexample —
 * `set(..., {merge:true})` on an ARRAY replaces the whole array and clobbers concurrent writes
 * (`sendblue/pool.ts`, which moved its counters into a map doc for exactly this reason). A single
 * shared map doc would work too but funnels every delivery through one hot document; the record
 * doc is already loaded by `loadCohortPool`, so reading the count here is free.
 *
 * WRITER (owned by `claire-agent/tools/yc-people-tools.ts`): after a delivered match, alongside the
 * existing `ycPeopleMatchSent` arrayUnion, increment ONLY ids not already in that array — the field
 * counts distinct users, so a repeat delivery to the same user must not double-count:
 *     for (const id of newlySentIds) {
 *       batch.set(db.collection("pa-external-candidate-records").doc(id),
 *                 { ycExposureCount: FieldValue.increment(1) }, { merge: true })
 *     }
 * Until that hook exists the field is absent, the count reads 0, and scoring is unchanged.
 */
export const EXPOSURE_FIELD = "ycExposureCount"

/**
 * Soft exposure demotion: `EXPOSURE_STEP * min(timesShown, EXPOSURE_CAP)` off the cosine.
 *
 * Adam 2026-07-25: "不要来重复就推荐这几个人；要够零散". Per-user dedupe (`ycPeopleMatchSent`) only stops
 * repeats WITHIN one user — nothing stopped one person being shown to every attendee.
 *
 * TUNED, not guessed. Sequential simulation over all 15 distinct intake users (production limit=5,
 * 75 slots), sweeping the step: 0 → 55 distinct people / max 4 repeats; 0.01 → 59; 0.02 → 61;
 * 0.04 → 70 distinct / max 2 repeats. Blind-judged quality of what each user received did NOT drop
 * (P@5 rel>=1: 0.547 / 0.547 / 0.547 / 0.613). SOFT on purpose: 0.20 is the largest total penalty,
 * so a genuinely strong match still outranks a never-shown weak one.
 */
const EXPOSURE_STEP = 0.04
const EXPOSURE_CAP = 5

/**
 * Tie-break bonus for a founder background (Adam 2026-07-25: "for YC match pool, prefer founders
 * background"). Strictly a nudge: smaller than a single EXPOSURE_STEP, so relevance and exposure
 * spreading both still dominate and no founder is ever surfaced over a materially better match.
 */
const FOUNDER_PRIOR = 0.03

function strArr(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim().length > 0) : []
}

/** Flatten an external-candidate record into a matchable pool member. */
export function toPoolMember(recordId: string, d: Record<string, unknown>): PeoplePoolMember {
  const exp = (Array.isArray(d.experience) ? d.experience : []) as Array<Record<string, unknown>>
  const edu = (Array.isArray(d.education) ? d.education : []) as Array<Record<string, unknown>>
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null)
  // PREFER the cleaned list. `sourceTags` is Coresignal's raw inferred+historical skills and is
  // bimodal junk — measured on this cohort: some records carry 81 tokens including "across",
  // "analyst", "analyzing", "ases", "c", while ~half carry ZERO. A `skills:["machine learning"]`
  // facet against the raw field matched 429 of 988 — useless as a filter.
  // `normalizedSkills` (scripts/normalize-yc-skills.ts) drops the noise and backfills the empties
  // from title/experience text. Fall back to the raw field when a record hasn't been normalized yet,
  // so the matcher degrades instead of returning nobody.
  const skills = strArr(d.normalizedSkills).length > 0 ? strArr(d.normalizedSkills) : strArr(d.sourceTags)
  const member: PeoplePoolMember = {
    recordId,
    name: str(d.name),
    linkedinUrl: str(d.canonicalLinkedInUrl),
    currentTitle: str(d.currentTitle),
    currentCompany: str(d.currentCompany),
    location: str(d.location),
    schools: exp.length >= 0 ? edu.map((e) => String(e.school ?? "")).filter(Boolean) : [],
    majors: edu.map((e) => String(e.degree ?? "")).filter(Boolean),
    companies: exp.map((e) => String(e.company ?? "")).filter(Boolean),
    skills,
    matchStatus:
      typeof (d.enrichment as Record<string, unknown> | undefined)?.matchStatus === "string"
        ? String((d.enrichment as Record<string, unknown>).matchStatus)
        : null,
    matchText: "",
    whatTheyBuild: str((d.businessDescriptor as BusinessDescriptor | undefined)?.whatTheyBuild),
    embedding: Array.isArray(d.matchEmbedding) ? (d.matchEmbedding as number[]) : null,
    descriptorEmbedding: Array.isArray(d.descriptorEmbedding)
      ? (d.descriptorEmbedding as number[])
      : null,
    exposureCount: typeof d[EXPOSURE_FIELD] === "number" ? (d[EXPOSURE_FIELD] as number) : 0,
    personType: strArr((d.businessDescriptor as BusinessDescriptor | undefined)?.personType),
    ...(() => {
      // Read-time, not a stored field: `companySizeRange` already rides every Coresignal record, so
      // deriving here needs no backfill and can never go stale against the profile it came from.
      // `companyStageLibrary` is the only cached part (a `pa-companies` lookup the record can't do).
      const { stage, source } = inferCompanyStage({
        profileStage: str((d.companyProfile as Record<string, unknown> | undefined)?.stage),
        experience: exp as Array<{ currentRole?: unknown; companySizeRange?: unknown }>,
        libraryStage: typeof d.companyStageLibrary === "string" ? d.companyStageLibrary : null,
      })
      return { companyStage: stage, companyStageSource: source }
    })(),
  }
  member.matchText = synthesizePeopleMatchText({
    name: member.name,
    currentTitle: member.currentTitle,
    currentCompany: member.currentCompany,
    location: member.location,
    experience: exp.map((e) => ({
      title: typeof e.title === "string" ? e.title : null,
      company: typeof e.company === "string" ? e.company : null,
      description: typeof e.description === "string" ? e.description : null,
    })),
    education: edu.map((e) => ({
      school: typeof e.school === "string" ? e.school : null,
      degree: typeof e.degree === "string" ? e.degree : null,
    })),
    skills,
    businessDescriptor: (d.businessDescriptor ?? null) as BusinessDescriptor | null,
    companyMatchLine: str((d.companyProfile as Record<string, unknown> | undefined)?.matchLine),
  })
  return member
}

/** Load a cohort's enriched, matchable members. Cohort is server-side — never model-supplied. */
export async function loadCohortPool(db: Firestore, cohort: string): Promise<PeoplePoolMember[]> {
  const snap = await db.collection(RECORDS).where("enrichment.cohort", "==", cohort).get()
  const out: PeoplePoolMember[] = []
  for (const doc of snap.docs) {
    const d = doc.data() as Record<string, unknown>
    // Only rows we actually resolved — an unenriched row has no title/company to match on.
    if (d.coresignalMatch !== "ok") continue
    const m = toPoolMember(doc.id, d)
    if (m.matchText.length < 20) continue
    out.push(m)
  }
  return out
}

// ---------------------------------------------------------------------------
// The driver
// ---------------------------------------------------------------------------

export interface YcPeopleMatchDeps {
  db: Firestore
  /** Embed arbitrary text (1536-d). Injected so tests never call OpenAI. */
  embed: (text: string) => Promise<number[] | null>
  cosine: (a: readonly number[], b: readonly number[]) => number
  /** Already-sent recordIds, so "show me more" never repeats a face. */
  loadAlreadySent?: (db: Firestore, userId: string, cohort: string) => Promise<Set<string>>
  log?: (event: string, payload?: Record<string, unknown>) => void
}

/** Below this, a facet ask is treated as too narrow and we widen — visibly, never silently. */
const MIN_FACET_RESULTS = 3

/**
 * An ask that carries no target ("anyone", "no preference", "whoever honestly") embeds to a vector
 * sitting near nothing in particular, so the pool ranks flat and the result is noise — measured
 * 2026-07-25 on the live 988-person pool, those asks returned the SAME top-5 for 5 different real
 * askers, and two real users resolved to identical people purely because both shrugged at intake.
 * 3 of 5 askers shrugged, so this is the common answer, not an edge case.
 */
const MIN_ASK_SIGNAL = 0.33

/**
 * Did the ask actually bind to anybody? Judged by its BEST achieved similarity in the pool.
 *
 * A contentless ask ("anyone", "no preference", "whoever honestly") embeds to a vector that sits
 * near nothing in particular, so the entire pool scores flat and the ranking is noise — measured
 * 2026-07-25 on the live 988-person pool, those asks returned the SAME top-5 for 5 different real
 * askers, and two real users resolved to identical people purely because both shrugged at intake.
 * 3 of 5 askers shrugged, so this is the common answer, not an edge case.
 *
 * A BACKSTOP, NOT THE DECISION (Adam 2026-07-25: "一定不能只用regex或者string去做match，所有的root
 * 都必须是语意匹配，然后不清楚要问用户clarifying"). The primary judgment lives in the agent, which
 * has the conversation and can simply ASK when an answer names no target — see the `match_yc_people`
 * tool description. This floor only catches what still reaches the matcher.
 *
 * An earlier pass used a stopword set: it needed hand-maintenance, could never cover the paraphrase
 * a real person types, and read "anyone building robotics" as empty for the same reason it read
 * "anyone" as empty. So the test is on the RESULT, not the words — did the ask land on anybody?
 *
 * MEASURED, live 988-person pool, 2026-07-25 (33 asks, `scripts/probe-ask-signal.ts`):
 *   real ask                     0.365 - 0.675   design .365 · climate .398 · fintech .674
 *   meaningful one-worder        0.353 - 0.401   founders .353 · engineers .382 · students .401
 *   junk                         0.180 - 0.327   yes .180 · ok .248 · "?" .293 · hi .327
 *   contentless                  0.192 - 0.296   doesn't-matter .192 · anyone .289 · open-to-anything .296
 * 0.33 is the widest-margin split of that data — everything meaningful above, everything empty
 * below, on a 0.069 gap.
 *
 * TWO THINGS I TRIED THAT DO NOT WORK, so nobody re-derives them:
 *  - A HIGHER floor (0.40, 0.52) looks safe against the contentless numbers and quietly eats real
 *    asks: 0.52 ate "investors" (.501), 0.40 ate "design" (.365) and "climate" (.398). Absolute
 *    cosine tracks ask LENGTH as much as content — a one-word ask scores low against long profile
 *    prose even when it is perfectly clear.
 *  - The z-score of the top hit (discrimination rather than magnitude) SOUNDS scale-free and is
 *    not: real asks scored z 2.91-6.60 and contentless z 3.24-4.46, fully overlapping, with
 *    "AI agents" (z 2.91) ranking BELOW "anyone" (z 4.46).
 * The margin here is thin, which is exactly why this is the backstop and the model is the gate.
 * Re-measure with that script before moving it; do not nudge it to fix one anecdote.
 */
function askBoundToAnyone(topScore: number): boolean {
  return topScore >= MIN_ASK_SIGNAL
}

export async function runYcPeopleMatch(
  input: { userId: string; cohort?: string; limit?: number; filters?: YcPeopleMatchFilters },
  deps: YcPeopleMatchDeps,
): Promise<YcPeopleMatchOutput> {
  const cohort = input.cohort ?? YC_COHORT_2026
  // HARD CAP 5, server-side (Adam 2026-07-25 live: "match一次给3-5就行了别给他多了"). The ceiling
  // used to be 20 and the tool let the model ask for 10 — which it did: one attendee who asked for
  // "IB, consulting ppl, investors" received TEN cards in one burst, several of them software
  // engineers, and replied "I don't want swe". Twenty names is not a better answer than five, it is
  // a worse one: the weak tail is what the person remembers, and it buries the good matches.
  // Clamped HERE rather than in the tool schema so no caller — model, MCP, or a future surface —
  // can widen it.
  // 3-5 BY DEFAULT, MORE ONLY IF THEY ASK (Adam 2026-07-25). The default is unchanged at 5 and the
  // model cannot drift upward on its own — `limit` is only ever above 5 when it was set from the
  // user's own words ("give me 10 more", "as many investors as u can"), which used to be silently
  // clamped to 5 with no acknowledgement. 10 is the ceiling: past that it is a wall of bubbles
  // again, which is the flood this cap exists to prevent.
  const limit = Math.max(1, Math.min(input.limit ?? 5, 10))
  const f = input.filters ?? {}
  const log = deps.log ?? (() => {})

  // 1. The asker.
  const userSnap = await deps.db.collection("pa-users").doc(input.userId).get()
  const u = (userSnap.data() ?? {}) as Record<string, unknown>
  const intake = (u.ycIntake ?? {}) as { building?: unknown; wantsToMeet?: unknown }
  const building = typeof intake.building === "string" ? intake.building : ""
  const wantsToMeet = typeof intake.wantsToMeet === "string" ? intake.wantsToMeet : ""

  const highlights = (Array.isArray(u.experienceHighlights) ? u.experienceHighlights : []) as Array<
    Record<string, unknown>
  >
  const asker = {
    schools: strArr((u.tags as Record<string, unknown> | undefined)?.schools).concat(
      highlights.map((h) => String(h.school ?? "")).filter(Boolean),
    ),
    companies: highlights.map((h) => String(h.company ?? "")).filter(Boolean),
    majors: strArr((u.tags as Record<string, unknown> | undefined)?.major),
  }

  // The query: an explicit ask wins; otherwise their own recorded answers. This is the point where
  // "record the user's response AND USE IT" is actually honoured.
  const intent = [building, wantsToMeet].filter(Boolean).join(". ")
  // `industrySector` / `roleFunction` steer the SEMANTICS rather than gating membership — see the
  // note in `passesFacets`. Underscores become words because this is embedding text, not a compare.
  const steer = [...(f.industrySector ?? []), ...(f.roleFunction ?? [])]
    .map((x) => String(x ?? "").replace(/_/g, " ").trim())
    .filter(Boolean)
    .join(", ")
  // THE ASK ADDS TO THEIR DOMAIN, IT DOES NOT REPLACE IT.
  //
  // This line used to be `f.query || intent`, so an explicit ask THREW AWAY everything the person
  // had told us they were building. That is the whole of the 2026-07-25 bad-match incident, because
  // the asks people actually make name a KIND OF PERSON and nothing else — the domain only ever
  // lives in `building`:
  //   ask "builders" (8 chars)             discarded "robotics + autonomous systems; custom corexy
  //                                        gantry for micro-vascular anastomosis"
  //   ask "investors/operators" (19)       discarded "phd in ML and drug development modelling"
  //   ask "open to all" (11)               discarded "finance/fintech and hardware/robotics"
  // Stripped of the domain, the ask lands on nobody in particular and the pool ranks FLAT — measured
  // on the live 1033-person pool, "builders" scored mean 0.171 / sd 0.037 across everyone, and the
  // single highest PROFILE cosine in the entire cohort (0.335) belonged to an Assistant Manager in
  // construction at Larsen & Toubro, which is exactly the card that got delivered. Ranking noise at
  // 4σ still produces a confident-looking list of five.
  //
  // MEASURED, live pool, the four flagged asks (scripts/probe-yc-ask-context.ts), before → after:
  //   "builders"                       construction / B2B automation → humanoid-soccer-robot
  //                                    autonomy, robotics systems integration, robotics tooling
  //   "founders who are hiring;        a dishwasher, an SEO mobile app, an EU tender platform →
  //    investors/operators"            eIF4E cancer therapeutics @ YC, AI-for-drug-discovery @
  //                                    Stanford, drug-discovery AI @ Acyclic Labs
  //   "open to all"                    diabetes app / CTF writeups → AI-native fintech, Jane Street
  //   "people at UPenn M&T"            UPenn M&T #1 BEFORE and after (0.422 → 0.527) — a sharp,
  //                                    self-sufficient ask is not diluted by this; it gets sharper
  //
  // MEASURED AND REJECTED, do not re-derive: scoring the ask and the domain as SEPARATE vectors and
  // blending them, `(askCos + w*ctxCos)/(1+w)`, at w = 0.5 / 1 / 2. It is worse than concatenation at
  // every weight, because the two cosines live on different scales (a bare ask means 0.17, a domain
  // line 0.37) so the blend is dominated by the flat, noisy term it was meant to rescue — "builders"
  // kept its wrong #1 at all three weights.
  //
  // `wantsToMeet` is deliberately NOT folded in: it is a who-ask, the current `query` supersedes it,
  // and `personType` already handles who as a facet. Only `building` — what they are actually doing —
  // travels with every ask.
  const ask = (f.query ?? "").trim()
  const queryText = [ask || intent, ask ? building : "", steer].filter(Boolean).join(". ")
  if (!queryText) {
    log("yc_people_match.no_intake", { userId: input.userId })
    return { results: [], poolSize: 0, facetMatched: 0, didRelax: false, reason: "no_intake" }
  }

  // 2. Pool.
  const pool = await loadCohortPool(deps.db, cohort)
  if (pool.length === 0) {
    return { results: [], poolSize: 0, facetMatched: 0, didRelax: false, reason: "empty_pool" }
  }

  const alreadySent = deps.loadAlreadySent
    ? await deps.loadAlreadySent(deps.db, input.userId, cohort)
    : new Set<string>()
  // SELF-EXCLUSION. The asker is now IN the pool (`yc-pool-sync.ts` upserts every YC scanner), and
  // `ycPeopleMatchSent` cannot cover it — that ledger only holds people we already delivered, and
  // nobody delivers you to yourself. Their own row is also the single highest-cosine row for their
  // own ask by construction, so without this the #1 result is the asker, at ~1.0.
  const selfId = ycPoolRecordId(input.userId)
  const fresh = pool.filter((m) => m.recordId !== selfId && !alreadySent.has(m.recordId))

  // 3. Facet stage.
  const faceted = fresh.filter((m) => passesFacets(m, f, asker))
  const anyFacetSet = Boolean(
    f.skills?.length || f.schools?.length || f.companies?.length || f.major?.length ||
      f.location?.length || f.personType?.length || f.fundingStage?.length ||
      f.sameSchool || f.sameCompany || f.sameMajor,
  )
  // Sparse-result rule: never silently substitute. We keep the facet hits FIRST and mark anything
  // from the widened pool `relaxed`, so Claire can say "only 2 from your school — these are close".
  const didRelax = anyFacetSet && faceted.length < MIN_FACET_RESULTS
  // WIDEN THE CIRCUMSTANCES, NEVER THE PERSON (Adam 2026-07-25: "this person ask for investor why we
  // keep sending wrong match???"). Relaxing used to drop EVERY facet, so an under-filled ask like
  // `personType:[investor] + location:[nyc]` fell back to the whole 1159-person cohort and padded the
  // list with founders — the exact card a user then screenshots with "none of these people are
  // investors tho". A school, a company or a city is a CIRCUMSTANCE and widening it still answers the
  // question loosely; WHO SOMEONE IS is the question itself, and a non-investor in an investor ask is
  // not a loose answer, it is a wrong one. So the widened pool still has to clear `personType`
  // (passing only that facet — every other one is unset, therefore a pass). When the user named no
  // person-type this is a no-op and relax behaves exactly as before.
  const ranked =
    didRelax ?
      [
        ...faceted,
        ...fresh.filter(
          (m) => !faceted.includes(m) && passesFacets(m, { personType: f.personType }, asker),
        ),
      ]
    : faceted
  const facetMatched = faceted.length

  // 4. Semantic stage — rank inside whatever survived.
  const askerText = synthesizePeopleMatchText({
    currentTitle: typeof u.recentRoleTitle === "string" ? u.recentRoleTitle : null,
    currentCompany: typeof u.recentCompany === "string" ? u.recentCompany : null,
    experience: highlights.map((h) => ({
      title: typeof h.title === "string" ? h.title : null,
      company: typeof h.company === "string" ? h.company : null,
      description: typeof h.description === "string" ? h.description : null,
    })),
    // `intent`, NOT `queryText`. This projection is the FALLBACK — who the asker is when their ask
    // carried nothing. Folding the ask back into it makes the fallback circular for the askers who
    // need it most: someone with no experience highlights degenerates to the intent alone, so an
    // "anyone" ask would recover onto an embedding of "anyone". Their intake `building` line is
    // real content they gave us, and it survives here even when an explicit ask overrode it.
    intent,
  })
  // WHICH TEXT DO WE EMBED? The ask goes in ALONE — explicit OR from intake.
  //
  // The projection above is ~1500 tokens of the asker's own experience with the ask as ONE line, so
  // for anyone with a real profile the ask barely moves the vector: measured over 6 unrelated asks
  // (investor / series B / hiring / cofounder / pre-seed / student founder) for three real askers
  // with 10 experience highlights each, top-8 overlap across asks was 0.41 / 0.56 / 0.93 Jaccard —
  // only 9-16 DISTINCT people across 48 slots, and the SAME two faces (Daniel Kim, Jerry Xiao) came
  // back #1/#2 for all six. Embedding the ask alone: 0.033 overlap, 42 distinct, and "hiring"
  // actually returns recruiters. (Askers with no highlights were never affected — their projection
  // degenerates to the intent, which is why this only showed up for enriched users.)
  //
  // THE SAME DILUTION HITS THE DEFAULT AUTO-FIRE LANE — the one 100% of event users hit, where
  // there is no `f.query` and the ask is their own `ycIntake.building` + `wantsToMeet`. Swept over
  // the 19 real users who completed intake (2026-07-25, 988-person pool, judged precision@8 against
  // what each literally said they wanted): profile-diluted 0.563 → intent-alone 0.813 on the 4
  // askers who have a profile at all, monotone in the blend weight (W=.25 .625 / .50 .719 /
  // .80 .719 / .90 .781 / 1.0 .813), so the blend never beats the endpoint and no constant is
  // needed. Distinct people held (90 → 89 of 152 slots) and cross-user overlap held (0.024 →
  // 0.028), so this does not undo exposure spreading. MEASURED AND REJECTED: dual max(intent,
  // profile) is a NO-OP (0.563 — the 1500-token profile vector out-cosines the short intent on
  // every slot), and head-repeating the intent x3 (the `businessModelHead` trick, which works
  // index-side) HURT: 0.563 and distinct 90 → 84, while perturbing all 15 profile-less users.
  //
  // NO STRING TESTS ON THE ASK (Adam 2026-07-25). Two used to live here and both are gone:
  //
  //  - a `/\b(like|similar to)\s+(me|mine)\b/` regex for self-referential asks ("something like
  //    mine"), which have no content of their own and want the asker's profile instead. That is a
  //    reference-resolution question, and the agent — which has the conversation — answers it by
  //    calling this tool with `query` NULL, the documented "match from what they already told you"
  //    path. A regex could only ever catch the phrasings someone thought of; measured, it missed
  //    "anyone doing what i'm doing" and "people with a similar background".
  //  - a MIN_INTENT_CHARS length floor on a thin intake answer, which is redundant with the signal
  //    gate below and actively wrong: "founders" (8 chars) and "students" (8) are real asks that
  //    score 0.353 / 0.401, while "hi" and "yes" fail the gate on their own merits.
  //
  // What remains is: embed the ask, and check whether it landed on anybody (`askBoundToAnyone`).
  const useProfile = !queryText

  // The user named a person-type, so we are no longer guessing — the founder prior stands down.
  const personTypeAsked = Boolean(f.personType?.length)
  const scoreAgainst = (qVec: number[]) => {
    const out: Array<{ m: PeoplePoolMember; score: number; relaxed: boolean }> = []
    for (const m of ranked) {
      if (!m.embedding || m.embedding.length === 0) continue
      let score = deps.cosine(qVec, m.embedding)
      // TWO VECTORS, take the better. The profile vector is ~1500 tokens of role/experience prose;
      // the descriptor vector is the ~40-token business abstraction alone. An abstract ask
      // ("marketplace", "devtools") binds to the second, a person-shaped ask ("who's like me") to
      // the first, and max() lets each query use whichever surface actually carries it instead of
      // averaging one into noise. Fail-soft: no descriptor vector (~10 of 992) → profile score.
      //
      // THIS max() IS LENGTH-BIASED and that is FINE now — do not "fix" it without re-measuring.
      // The descriptor is ~40 tokens and the profile ~1500, so a SHORT query out-cosines against the
      // descriptor for every member alike, and max() then picks the surface by text length rather
      // than by fit: measured on the live pool, descriptor won 74-81% of rows for an 11-19 char ask
      // versus 21-22% for a 140-223 char one, crossing over around 60-100 chars. The fix is upstream:
      // now that every ask carries the asker's `building` line (see `queryText`), the pool-wide
      // descriptor-minus-profile offset measures 0.000 on four of the five flagged asks — the bias is
      // gone by construction. A self-calibrating de-bias (subtract that offset before max()) was
      // built and measured on top of this: it is a NO-OP everywhere except a genuinely contentless
      // ask ("researchers" + a `building` line that literally reads "research"), where it reorders
      // two near-identical research interns. Not worth the code.
      if (m.descriptorEmbedding?.length) {
        score = Math.max(score, deps.cosine(qVec, m.descriptorEmbedding))
      }
      // A "Needs Review" row is a semi-automatic, possibly-wrong LinkedIn match. Demote rather than
      // drop — the sheet itself warns some rows are the wrong person.
      if (m.matchStatus === "Needs Review") score -= 0.05
      // Spread exposure across the 988 instead of concentrating on the same ~20 faces.
      if (m.exposureCount > 0) score -= EXPOSURE_STEP * Math.min(m.exposureCount, EXPOSURE_CAP)
      // FOUNDER PRIOR (Adam 2026-07-25: "for YC match pool, prefer founders background").
      // A BONUS, never a filter: cosine still decides, this only breaks near-ties toward the people
      // this event is actually about. Sized deliberately below one exposure step (0.04) so it can
      // never overpower relevance or undo exposure spreading — a clearly better non-founder still
      // wins. What it fixes, live: an ask for hard-tech/robotics BUILDERS returned "Assistant
      // Manager @ Larsen & Toubro" (construction).
      //
      // NEVER AGAINST AN EXPLICIT ASK (regression, same day — Adam: "why the investors query was
      // working and it failed so bad now?"). A default preference must not overrule the user's own
      // words. When they asked for investors, the membership facet let founder-labelled people
      // through AND this prior then PROMOTED them, so the two compounded into five founders for an
      // investor ask, six asks running. The prior is a tiebreak for when we are guessing; the moment
      // they name a type, we are not guessing. `personTypeAsked` is false for a plain query, so the
      // default behaviour Adam asked for is unchanged.
      if (!personTypeAsked && m.personType.includes("founder")) score += FOUNDER_PRIOR
      out.push({ m, score, relaxed: didRelax && !faceted.includes(m) })
    }
    return out
  }

  const qVec = await deps.embed(useProfile ? askerText || queryText : queryText)
  if (!qVec) {
    log("yc_people_match.embed_failed", { userId: input.userId })
    return { results: [], poolSize: pool.length, facetMatched, didRelax, reason: "embed_failed" }
  }
  let scored = scoreAgainst(qVec)

  // Did the ask bind to anyone? Asked of the RESULT, not of the words — see `askBoundToAnyone`.
  // Only the ask lane can fail this: the profile lane is already the fallback.
  const topScore = scored.reduce((mx, s) => Math.max(mx, s.score), -1)
  if (!useProfile && scored.length > 0 && !askBoundToAnyone(topScore)) {
    const pVec = askerText ? await deps.embed(askerText) : null
    log("yc_people_match.ask_carried_no_signal", {
      userId: input.userId,
      topScore: Math.round(topScore * 1000) / 1000,
      recovered: Boolean(pVec),
    })
    if (pVec) scored = scoreAgainst(pVec)
  }

  // HONESTY, MEASURED ON THE ASK ALONE — do not fold this into the gate above.
  //
  // Now that `queryText` carries their `building` line, every score sits in the same band the
  // asker's own intake ask reaches, so `ABSOLUTE_FLOOR` stopped biting for an ask the pool cannot
  // answer. Measured on the live 1033-person pool right after that change: "professional opera
  // singers", "farmers" and "commercial airline pilots" each came back as FIVE confident-looking
  // robotics people at 0.46-0.49, because the domain half of the blend was doing all the ranking.
  // Before the change those same asks returned one person and the intro said the list was thin —
  // the honesty Adam asked for ("如果没有那么好的人就说现在profile pool就这些") was real, and folding
  // the domain in is what removed it.
  //
  // So judge the ASK on its own merits, with the same 0.33 test, which is the data it was measured
  // on. Ask alone, live pool: opera singers .282 · farmers .293 · dentists .322 · airline pilots
  // .327 all fail, while every genuine in-pool ask clears it — builders .335 · open to all .338 ·
  // researchers .445 · investors/operators .456 · UPenn M&T .462 · fintech .560 · robotics founders
  // .573. A contentless shrug ("anyone" .280, "no preference" .228) fails it too, which is correct
  // and not a separate case: in BOTH situations the people we are about to send were chosen by the
  // asker's own domain, not by what they asked for, and the card should say so.
  //
  // NOT A FILTER. Nobody is dropped and nothing is re-ranked — this only sets a flag so the intro
  // can be honest ("nobody here matches that exactly — but these are the closest on what you're
  // building"). The alternative, staying silent, passes robotics engineers off as opera singers.
  let askMissed = false
  // A FACET THAT MATCHED PEOPLE HAS ALREADY ANSWERED THE ASK, so do not then tell the person nobody
  // matches. This gate is a cosine test on the ask text, and "investors" cosines weakly against every
  // VC profile in the pool (0.28-0.44 measured) — enough to trip it while 21 verified investors sit
  // in `faceted`. Firing here would put "nobody here matches that exactly" on top of a list of
  // exactly the right people, which is a worse lie than the one this flag exists to prevent.
  const facetAnsweredIt = Boolean(f.personType?.length) && facetMatched > 0
  if (ask && !useProfile && !facetAnsweredIt && scored.length > 0) {
    // The ask's OWN best hit. No second embed when the ask already IS the whole query (an asker with
    // no `building` line on file) — `topScore` measured exactly that, on exactly these vectors.
    let best = topScore
    if (queryText !== ask) {
      const aVec = await deps.embed(ask)
      best = -1
      for (const m of ranked) {
        if (!aVec || !m.embedding?.length) continue
        let s = deps.cosine(aVec, m.embedding)
        if (m.descriptorEmbedding?.length) s = Math.max(s, deps.cosine(aVec, m.descriptorEmbedding))
        if (s > best) best = s
      }
    }
    // `best < 0` means we could not measure (embed failed / nobody had a vector) — say nothing
    // rather than claim a miss we did not establish.
    askMissed = best >= 0 && !askBoundToAnyone(best)
    if (askMissed) {
      log("yc_people_match.ask_missed_pool", {
        userId: input.userId,
        ask,
        bestAskScore: Math.round(best * 1000) / 1000,
      })
    }
  }
  scored.sort((a, b) => {
    // Facet hits always outrank relaxed filler regardless of cosine.
    if (a.relaxed !== b.relaxed) return a.relaxed ? 1 : -1
    return b.score - a.score
  })

  // 3-5, NOT always 5 (Adam 2026-07-25: "可以是3-5个不一定要固定5个，然后如果小的话就说ok我们确实
  // 没有太多匹配的"). Padding to a fixed count is what makes a good list look random: slots 4 and 5
  // get filled by whoever happened to rank next, and one weak card discredits the three good ones
  // above it. So keep everyone who clears the floor, stop at `limit`, and never pad — a short,
  // honest list beats a padded one, and the intro says so when it is short.
  //
  // The floor is RELATIVE to this query's best hit, not absolute: cosine magnitude tracks how long
  // the ask is (measured — a one-word "design" tops out at 0.365 while "fintech" reaches 0.674), so
  // a fixed cutoff would gut short asks and pass everything on long ones. Relative asks the only
  // question that matters: is this person in the same league as the best person we found?
  const RELATIVE_FLOOR = 0.88
  // ABSOLUTE floor too (Adam 2026-07-25 live: "我们的match还是一直都是5个，如果没有那么好的人就说现在
  // profile pool就这些"). Relative-only always yields a full five, because the fifth-best person is
  // always within 12% of the best one — it measures the SHAPE of the tail, never whether anybody was
  // actually a good match. Measured on this pool, a person scoring under ~0.42 is not someone you
  // would walk across a room for: the sharp asks top out at 0.49-0.67, so this cuts the filler
  // without touching a genuinely good set.
  const ABSOLUTE_FLOOR = 0.42
  // NOT a quota. Whoever clears the bar is the answer, even if that is one person — the intro line
  // then says the list is short, which is a true statement about the pool and is what Adam asked
  // for. Padding to three was the same mistake as padding to five, one size smaller.
  const MIN_RESULTS = 1
  // `scored` is sorted, so the head is the best hit. Not `topScore` from the signal gate above —
  // that one is measured BEFORE the profile-recovery rescore, so it can describe a ranking we threw
  // away.
  const bestScore = scored[0]?.score ?? 0
  // A PERSON-TYPE FACET HIT IS A CATEGORICAL MATCH, NOT A DEGREE OF ONE — the floors do not apply to
  // it (Adam 2026-07-25: "I just want u to give me as many investors as u can", and separately
  // "可以是3-5个"). The floors are cosine tests, and cosine on an investor ask measures DOMAIN overlap
  // between the asker's startup and the investor's thesis prose — not whether the person invests.
  // Measured on the live 1159-pool over four real investor asks: 21 people whose PRIMARY type is
  // `investor` cleared the facet, and the absolute floor then cut every one of those lists to a
  // SINGLE person, because a VC's profile simply does not cosine-match "DJ transition graphs" or
  // "digital accessibility compliance". One card in answer to "as many investors as u can" reads as
  // us having nobody, when we had twenty-one.
  //
  // The floors still guard everything they were built for. `relaxed` rows — the widened filler — face
  // them unchanged, so an under-filled ask cannot pad itself with confident-looking noise. And the
  // facet exemption cannot manufacture a match: it only ever admits people the closed-vocab facet
  // ALREADY verified are the kind of person that was asked for. Cosine still orders them, so the best
  // domain fit is still card #1; it just stops being a veto over a question it cannot answer.
  const facetIsTheAnswer = Boolean(f.personType?.length)
  const strong = scored.filter(
    (s) =>
      (facetIsTheAnswer && !s.relaxed) ||
      (s.score >= bestScore * RELATIVE_FLOOR && s.score >= ABSOLUTE_FLOOR),
  )
  // Below the floor we still show up to MIN_RESULTS — three plausible people are worth the walk
  // across the room, and `didRelax`/the intro line keep us honest about what they are.
  const shortlist = strong.length >= MIN_RESULTS ? strong : scored.slice(0, MIN_RESULTS)
  const kept = interleaveByPersonType(shortlist, f.personType ?? []).slice(0, limit)
  const thin = kept.length < limit
  log("yc_people_match.result_count", {
    userId: input.userId,
    kept: kept.length,
    aboveFloor: strong.length,
    limit,
    thin,
  })

  const results = kept.map(({ m, score, relaxed }) => ({
    recordId: m.recordId,
    name: m.name,
    linkedinUrl: m.linkedinUrl,
    title: m.currentTitle,
    company: m.currentCompany,
    location: m.location,
    score: Math.round(score * 1000) / 1000,
    reason: explainMatch(m, f, asker),
    summary: firstSentence(m.whatTheyBuild) || null,
    relaxed,
    matchStatus: m.matchStatus,
  }))

  log("yc_people_match.ok", {
    userId: input.userId,
    poolSize: pool.length,
    facetMatched,
    didRelax,
    returned: results.length,
  })
  return { results, poolSize: pool.length, facetMatched, didRelax, askMissed }
}
