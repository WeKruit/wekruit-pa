/**
 * entity-token.ts — ONE canonical token for a school / company / major / location, shared by the
 * index-time generator (scripts/canonicalize-yc-entities.ts) and the matcher's facet stage.
 *
 * WHY: the facet stage used to be substring/RegExp containment. Every documented bug it had was
 * the same bug — a text fragment is not an identity. A bare "rl" matched "world" and "early"
 * (63 irrelevant people), a member carrying the skill "c" matched every query containing the
 * letter c, "chi" matched "machine learning". Each fix (escape, length floor, word boundaries)
 * plugged one hole and opened the next. Adam 2026-07-25: "所有的regex，完全不能有".
 *
 * SO: canonicalize both sides to a token, then compare tokens with SET EQUALITY. There is no
 * substring test, no RegExp, and no length floor anywhere in the match path — a facet either
 * resolves to the same identifier or it does not match.
 *
 * NOT A MATCHER: the string operations below (case folding, diacritics, punctuation) run INSIDE
 * canonicalization, on one value at a time, to produce a key. They never compare two values.
 * That distinction is the whole design: normalize with strings, match with identifiers.
 */
import { LOCATION_VOCAB, MAJOR_VOCAB, SCHOOL_TIERS, normalizeSchoolKey } from "@wekruit/shared-tags"

export type EntityKind = "school" | "company" | "major" | "location"

/** normalizedRaw → canonical token. Built at index time, read by both sides. */
export type EntityOverlay = Partial<Record<EntityKind, Record<string, string>>>

const slug = (nk: string): string => nk.replace(/ /g, "_")

/** Legal-entity suffixes. Dropped so "Stripe, Inc." and "Stripe" are the same identity. */
const LEGAL_SUFFIX = new Set([
  "inc", "llc", "ltd", "limited", "corp", "corporation", "co", "gmbh", "plc", "pte", "pvt",
  "llp", "lp", "sa", "nv", "bv", "ag", "ab", "oy", "as", "kk", "srl", "spa", "pty",
])

/** Alumni prefixes — "ex-Stripe" and "Stripe" are the same company. */
const ALUMNI_PREFIX = new Set(["ex", "former", "formerly", "alum", "alumni", "prev", "previously"])

/** normalizedKey → canonical school slug, over EVERY lens (lens choice is a scoring concern). */
let SCHOOL_INDEX: Map<string, string> | null = null
function schoolIndex(): Map<string, string> {
  if (SCHOOL_INDEX) return SCHOOL_INDEX
  const idx = new Map<string, string>()
  for (const lens of Object.keys(SCHOOL_TIERS) as Array<keyof typeof SCHOOL_TIERS>) {
    for (const tier of ["tier_1", "tier_2", "tier_3"] as const) {
      for (const e of SCHOOL_TIERS[lens][tier]) {
        const token = slug(normalizeSchoolKey(e.canonical))
        if (!token) continue
        for (const key of [e.canonical, ...e.aliases]) {
          const nk = normalizeSchoolKey(key)
          if (nk && !idx.has(nk)) idx.set(nk, token)
        }
      }
    }
  }
  SCHOOL_INDEX = idx
  return idx
}

const MAJOR_TOKENS: ReadonlySet<string> = new Set(MAJOR_VOCAB)
const LOCATION_TOKENS: ReadonlySet<string> = new Set(LOCATION_VOCAB)

/** Fold one raw value to a comparison key. Parentheticals are always an abbreviation or a
 *  disambiguator ("Amazon Web Services (AWS)"), never new identity, so they go. */
export function entityFoldKey(raw: string | null | undefined): string {
  return normalizeSchoolKey(String(raw ?? "").replace(/\([^)]*\)/g, " "))
}

/**
 * The parenthetical of a raw value, folded — "Amazon Web Services (AWS)" → "aws".
 *
 * FREE ALIASES, NO LLM: the parenthetical a source writes is the abbreviation people actually
 * type, so the generator registers it as an alias of the outer name's token. That is why "AWS"
 * finds Amazon Web Services without anyone hand-listing it.
 */
export function entityParenAlias(raw: string | null | undefined): string | null {
  const m = /\(([^)]{2,60})\)/.exec(String(raw ?? ""))
  if (!m) return null
  const key = normalizeSchoolKey(m[1]!)
  return key || null
}

function companyToken(nk: string): string | null {
  let words = nk.split(" ").filter(Boolean)
  while (words.length > 1 && ALUMNI_PREFIX.has(words[0]!)) words = words.slice(1)
  while (words.length > 1 && LEGAL_SUFFIX.has(words[words.length - 1]!)) words = words.slice(0, -1)
  return words.length ? slug(words.join(" ")) : null
}

/**
 * The canonical token for one raw value, or null when we cannot establish an identity.
 *
 * NULL IS A RESULT, NOT A FALLBACK TRIGGER. A school nobody else lists resolves to its own
 * normalized identity and simply matches nobody; a major we cannot place in the closed vocab
 * returns null and that facet yields fewer people. We never fall back to substring — the sparse
 * path (`didRelax`) reports the shortfall honestly instead.
 */
export function canonicalEntityToken(
  kind: EntityKind,
  raw: string | null | undefined,
  overlay?: EntityOverlay,
): string | null {
  const nk = entityFoldKey(raw)
  if (!nk) return null
  const fromOverlay = overlay?.[kind]?.[nk]
  if (fromOverlay) return fromOverlay
  if (kind === "school") return schoolIndex().get(nk) ?? slug(nk)
  if (kind === "company") return companyToken(nk)
  const token = slug(nk)
  if (kind === "major") return MAJOR_TOKENS.has(token) ? token : null
  return LOCATION_TOKENS.has(token) ? token : null
}

/** Canonicalize a list, dropping unresolvable values. Order-free — the caller compares as a set. */
export function canonicalEntityTokens(
  kind: EntityKind,
  raws: readonly (string | null | undefined)[],
  overlay?: EntityOverlay,
): string[] {
  const out = new Set<string>()
  for (const r of raws) {
    const t = canonicalEntityToken(kind, r, overlay)
    if (t) out.add(t)
  }
  return [...out]
}

/** Do these two token sets share an identifier? The entire match test. */
export function tokensIntersect(a: readonly string[], b: readonly string[]): boolean {
  if (a.length === 0 || b.length === 0) return false
  const set = new Set(a)
  return b.some((x) => set.has(x))
}
