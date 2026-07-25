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
export type CompanyStageSource = "library" | "yc_batch" | "stealth" | "company_size" | "unknown"

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
 * WHAT WE INFER FROM: Coresignal already hands us `companySizeRange` on the current role for
 * 809 of 992 records (82%) — six times the library's reach, free, no LLM. Headcount is NOT funding
 * stage, and this function does not pretend otherwise; it returns the single most likely stage and
 * a `source` saying it came from headcount, and `unknown` (never a guess) when there is no signal.
 * A `fundingStage` facet matches this value EXACTLY, so a stage nobody in the room is at yields
 * ~nothing and trips the existing relax/honesty path instead of manufacturing five confident hits.
 *
 * The YC batch tag beats headcount: "(YC S26)" in a title is a direct statement of stage, and
 * those companies are usually too new for Coresignal to have sized at all.
 */
export function inferCompanyStage(p: {
  currentTitle?: string | null
  currentCompany?: string | null
  /** Coresignal experience rows — `companySizeRange` is read off the current role. */
  experience?: Array<{ currentRole?: unknown; companySizeRange?: unknown }>
  /** `pa-companies.companyStage`, when the company is in the library. Wins outright. */
  libraryStage?: string | null
}): { stage: string; source: CompanyStageSource } {
  const lib = String(p.libraryStage ?? "").trim().toLowerCase().replace(/[\s-]+/g, "_")
  if (lib && lib !== "unknown") return { stage: lib, source: "library" }

  const titleAndCompany = `${p.currentTitle ?? ""} ${p.currentCompany ?? ""}`
  // "(YC S26)", "YC W24", "(YC F25)" — a batch tag names the stage better than headcount does.
  if (/\(?\byc\s*[swf]\d{2}\b\)?/i.test(titleAndCompany)) return { stage: "seed", source: "yc_batch" }
  if (/\bstealth\b/i.test(titleAndCompany)) return { stage: "pre_seed", source: "stealth" }

  const exp = p.experience ?? []
  const cur = exp.find((e) => e?.currentRole === true) ?? exp[0]
  const size = String(cur?.companySizeRange ?? "")
  // Single most likely stage per headcount band. Deliberately NOT a range: a band would match
  // every stage query and never trip the honesty path.
  const stage =
    /^myself only/i.test(size) ? "pre_seed"
    : /^1-10\b/.test(size) ? "seed"
    : /^11-50\b/.test(size) ? "series_a"
    : /^51-200\b/.test(size) ? "series_b"
    : /^201-500\b/.test(size) ? "series_c"
    : /^501-1000\b/.test(size) ? "series_d_plus"
    : /^1001-5000\b/.test(size) ? "series_d_plus"
    : /^5001-10,?000\b/.test(size) ? "ipo_public"
    : /^10,?001\+/.test(size) ? "ipo_public"
    : ""
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

/** Loose containment match — "Berkeley" should hit "University of California, Berkeley". */
/** Escape a user/model-supplied token before it goes into a RegExp. */
function escapeRe(x: string): string {
  return x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/** Shortest haystack token allowed to substring-match a longer query. */
const MIN_REVERSE_MATCH = 4

function looseHit(haystack: string[], needles: string[]): boolean {
  if (needles.length === 0) return true
  const hay = haystack.map((h) => h.trim().toLowerCase()).filter((h) => h.length > 0)
  return needles.some((n) => {
    const q = n.trim().toLowerCase()
    if (!q) return false
    return hay.some((h) => {
      // Forward: the member's value contains the query. "Berkeley" hits
      // "University of California, Berkeley" — this is the case the facet exists for.
      // WORD BOUNDARY for short queries: a bare "rl" was matching "world" / "early" and
      // returned 63 irrelevant people (measured 2026-07-25). Long queries keep plain
      // containment so "machine learn" still hits "machine learning".
      if (q.length < MIN_REVERSE_MATCH) {
        if (new RegExp(`\\b${escapeRe(q)}\\b`).test(h)) return true
      } else if (h.includes(q)) return true
      // Reverse: the member's value is a substring of the query. Needed for
      // "Stanford University" (stored) vs "Stanford" (asked)... but it is also how a
      // 1-2 char token becomes a wildcard: a member carrying the skill "c" matched EVERY
      // query containing the letter c, and "chi" matched "machine learning" (found by the
      // skills audit, 2026-07-25). Require a real token before allowing the reverse
      // direction, and require a word boundary so "art" cannot hit "smart".
      if (h.length < MIN_REVERSE_MATCH) return false
      return new RegExp(`\\b${escapeRe(h)}\\b`).test(q)
    })
  })
}

/** Closed-vocab token normaliser — "Series B" / "series-b" → "series_b". */
function norm(x: string): string {
  return String(x ?? "").trim().toLowerCase().replace(/[\s-]+/g, "_")
}

/** Apply every set facet. All AND-ed; an unset facet is a pass. */
export function passesFacets(
  m: PeoplePoolMember,
  f: YcPeopleMatchFilters,
  asker: { schools: string[]; companies: string[]; majors: string[] },
): boolean {
  // QUERY-SIDE PARITY: stored skills are canonicalized with abbreviations EXPANDED
  // (`ml` → `machine learning`, `k8s` → `kubernetes`), so a raw "ML" from the model would no
  // longer substring-hit anything. Normalize the query the same way before comparing; keep the
  // original too, so an unrecognized token still matches literally.
  if (f.skills?.length) {
    const needles = f.skills.flatMap((s) => {
      const norm = normalizeSkillToken(s)
      return norm && norm !== s.trim().toLowerCase() ? [s, norm] : [s]
    })
    if (!looseHit(m.skills, needles)) return false
  }
  if (f.schools?.length && !looseHit(m.schools, f.schools)) return false
  if (f.companies?.length && !looseHit(m.companies, f.companies)) return false
  if (f.major?.length && !looseHit(m.majors, f.major)) return false
  if (f.location?.length && !looseHit(m.location ? [m.location] : [], f.location)) return false
  if (f.industrySector?.length || f.roleFunction?.length) {
    // Coresignal gives us no canonical industry/roleFunction per attendee, so these degrade to a
    // text probe over title+company rather than silently dropping everyone.
    const probe = [m.currentTitle ?? "", m.currentCompany ?? "", ...m.skills].filter(Boolean)
    const needles = [...(f.industrySector ?? []), ...(f.roleFunction ?? [])].map((x) =>
      x.replace(/_/g, " "),
    )
    if (!looseHit(probe, needles)) return false
  }
  // EXACT, not loose: both are closed vocabularies we generated ourselves, so a substring match
  // would only create false hits ("founder" ⊂ "co_founder" is fine, "product" ⊂ "product_operator"
  // is not) and there is no user typing to be forgiving about.
  if (f.personType?.length && !f.personType.some((x) => m.personType.includes(norm(x)))) return false
  if (f.fundingStage?.length && !f.fundingStage.some((x) => norm(x) === m.companyStage)) return false
  // Relational — resolved from the ASKER, so the model never has to know their school name.
  if (f.sameSchool && !looseHit(m.schools, asker.schools)) return false
  if (f.sameCompany && !looseHit(m.companies, asker.companies)) return false
  if (f.sameMajor && !looseHit(m.majors, asker.majors)) return false
  return true
}

/** Which facet actually produced this hit — so the "why" line is honest, not generic. */
export function explainMatch(
  m: PeoplePoolMember,
  f: YcPeopleMatchFilters,
  asker: { schools: string[]; companies: string[]; majors: string[] },
): string {
  if (f.sameSchool) {
    const hit = m.schools.find((s) => looseHit([s], asker.schools))
    if (hit) return `also went to ${hit}`
  }
  if (f.sameCompany) {
    const hit = m.companies.find((c) => looseHit([c], asker.companies))
    if (hit) return `also worked at ${hit}`
  }
  if (f.schools?.length) {
    const hit = m.schools.find((s) => looseHit([s], f.schools!))
    if (hit) return `${hit}`
  }
  if (f.companies?.length) {
    const hit = m.companies.find((c) => looseHit([c], f.companies!))
    if (hit) return `${hit}`
  }
  if (f.skills?.length) {
    const hit = m.skills.find((s) => looseHit([s], f.skills!))
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
        currentTitle: str(d.currentTitle),
        currentCompany: str(d.currentCompany),
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
  const limit = Math.max(1, Math.min(input.limit ?? 5, 20))
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
  const queryText = (f.query ?? "").trim() || intent
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
  const fresh = pool.filter((m) => !alreadySent.has(m.recordId))

  // 3. Facet stage.
  const faceted = fresh.filter((m) => passesFacets(m, f, asker))
  const anyFacetSet = Boolean(
    f.skills?.length || f.schools?.length || f.companies?.length || f.major?.length ||
      f.location?.length || f.industrySector?.length || f.roleFunction?.length ||
      f.personType?.length || f.fundingStage?.length ||
      f.sameSchool || f.sameCompany || f.sameMajor,
  )
  // Sparse-result rule: never silently substitute. We keep the facet hits FIRST and mark anything
  // from the widened pool `relaxed`, so Claire can say "only 2 from your school — these are close".
  const didRelax = anyFacetSet && faceted.length < MIN_FACET_RESULTS
  const ranked = didRelax ? [...faceted, ...fresh.filter((m) => !faceted.includes(m))] : faceted
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
      if (m.descriptorEmbedding?.length) {
        score = Math.max(score, deps.cosine(qVec, m.descriptorEmbedding))
      }
      // A "Needs Review" row is a semi-automatic, possibly-wrong LinkedIn match. Demote rather than
      // drop — the sheet itself warns some rows are the wrong person.
      if (m.matchStatus === "Needs Review") score -= 0.05
      // Spread exposure across the 988 instead of concentrating on the same ~20 faces.
      if (m.exposureCount > 0) score -= EXPOSURE_STEP * Math.min(m.exposureCount, EXPOSURE_CAP)
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
  scored.sort((a, b) => {
    // Facet hits always outrank relaxed filler regardless of cosine.
    if (a.relaxed !== b.relaxed) return a.relaxed ? 1 : -1
    return b.score - a.score
  })

  const results = scored.slice(0, limit).map(({ m, score, relaxed }) => ({
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
  return { results, poolSize: pool.length, facetMatched, didRelax }
}
