/**
 * Phase 52 — Canonical `location` vocab. [TAG-07]
 *
 * 130+ spelled-out values: US/CA/EU/APAC/LATAM/MEA + remote variants.
 * Hard filter intersect with `anywhere` bypass (MATCH-04).
 *
 * Adam-locked:
 *  - D5: spelled-out, no abbreviations (`san_francisco_bay_area` not `sf`)
 *
 * Convention: city-level uses metro/region (e.g., `san_francisco_bay_area`,
 * `new_york_metro`) so we don't fragment between South Bay / SF / Berkeley etc.
 * Country-level disambiguator suffixes added where needed
 * (`london_united_kingdom`, `dublin_ireland`).
 */

import { z } from "zod"

export const LOCATION_VOCAB = [
  // ─── United States — major metros ───
  "san_francisco_bay_area",
  "new_york_metro",
  "los_angeles_metro",
  "seattle_metro",
  "boston_metro",
  "chicago_metro",
  "austin_metro",
  "denver_metro",
  "portland_oregon",
  "washington_dc_metro",
  "atlanta_metro",
  "miami_metro",
  "philadelphia_metro",
  "dallas_fort_worth",
  "houston_metro",
  "raleigh_durham",
  "minneapolis_st_paul",
  "san_diego",
  "salt_lake_city",
  "phoenix",
  "detroit",
  "st_louis",
  "kansas_city",
  "indianapolis",
  "columbus_ohio",
  "cleveland",
  "pittsburgh",
  "nashville",
  "charlotte",
  "tampa",
  "orlando",
  "jacksonville",
  "las_vegas",
  "sacramento",
  "providence",
  "hartford",
  "richmond_virginia",
  "milwaukee",
  "cincinnati",
  "buffalo",
  "rochester_new_york",
  "albuquerque",
  "boise",
  "honolulu",
  "anchorage",
  "tucson",
  "ann_arbor",
  "madison_wisconsin",
  "santa_barbara",
  "reno",
  // ─── Canada ───
  "toronto",
  "vancouver",
  "montreal",
  "ottawa",
  "calgary",
  "edmonton",
  "waterloo_ontario",
  "quebec_city",
  "halifax",
  "winnipeg",
  // ─── European Union + UK ───
  "london_united_kingdom",
  "manchester_united_kingdom",
  "edinburgh_united_kingdom",
  "cambridge_united_kingdom",
  "oxford_united_kingdom",
  "dublin_ireland",
  "berlin",
  "munich",
  "hamburg",
  "frankfurt",
  "amsterdam",
  "rotterdam",
  "paris",
  "lyon",
  "stockholm",
  "gothenburg",
  "copenhagen",
  "zurich",
  "geneva",
  "vienna",
  "prague",
  "warsaw",
  "krakow",
  "barcelona",
  "madrid",
  "valencia",
  "lisbon",
  "porto",
  "helsinki",
  "oslo",
  "brussels",
  "luxembourg_city",
  "budapest",
  "athens",
  "milan",
  "rome",
  "tallinn",
  "riga",
  "vilnius",
  "reykjavik",
  // ─── Asia Pacific ───
  "singapore",
  "tokyo",
  "osaka",
  "kyoto",
  "yokohama",
  "hong_kong",
  "shanghai",
  "beijing",
  "shenzhen",
  "guangzhou",
  "hangzhou",
  "chengdu",
  "seoul",
  "busan",
  "sydney",
  "melbourne",
  "brisbane",
  "perth",
  "auckland",
  "wellington",
  "bangalore",
  "mumbai",
  "delhi_ncr",
  "hyderabad",
  "chennai",
  "pune",
  "kolkata",
  "taipei",
  "kaohsiung",
  "bangkok",
  "ho_chi_minh_city",
  "hanoi",
  "kuala_lumpur",
  "jakarta",
  "manila",
  // ─── Latin America ───
  "sao_paulo",
  "rio_de_janeiro",
  "mexico_city",
  "guadalajara",
  "monterrey",
  "buenos_aires",
  "bogota",
  "medellin",
  "santiago",
  "lima",
  "san_jose_costa_rica",
  "panama_city",
  "quito",
  "montevideo",
  // ─── Middle East + Africa ───
  "tel_aviv",
  "haifa",
  "dubai",
  "abu_dhabi",
  "riyadh",
  "doha",
  "istanbul",
  "ankara",
  "cairo",
  "johannesburg",
  "cape_town",
  "nairobi",
  "lagos",
  "accra",
  "casablanca",
  "addis_ababa",
  // ─── Remote variants ───
  "remote_united_states",
  "remote_canada",
  "remote_europe",
  "remote_united_kingdom",
  "remote_apac",
  "remote_latam",
  "remote_global",
  "remote_anywhere",
  "remote_americas",
  "remote_emea",
] as const

export type Location = (typeof LOCATION_VOCAB)[number]

export const LocationSchema = z.enum(LOCATION_VOCAB)

export const LocationListSchema = z.array(LocationSchema)

/** Bypass token for "open to anywhere" preference. */
export const ANYWHERE_LOCATION_TOKENS: ReadonlySet<Location> = new Set([
  "remote_anywhere",
  "remote_global",
])

// ---------------------------------------------------------------------------
// Canonical locationBucket → ISO-3166-1 alpha-2 country map (2026-06-02).
//
// WHY: the matcher's US-only platform gate previously decided "is this job
// foreign?" with hardcoded per-city substring arrays (`NON_US_BUCKET_HINTS` /
// `US_BUCKET_*`) that OMITTED entire regions (the Middle East — doha/dubai/
// riyadh leaked a Scale AI "Global Public Sector" role to a US candidate).
// This is a single DATA map (not regex, not per-city `.includes()` hardcoding
// in the matcher) so coverage is exhaustive and auditable, and adding a region
// is a one-line data edit here, NOT a code change in the filter.
//
// Coverage: every canonical `LOCATION_VOCAB` metro/city PLUS the common
// scraped country/region tokens that appear in `matching-jobs.locationBuckets`
// but are NOT canonical (e.g. "uae", "qatar", "saudi_arabia", "us") — job
// buckets carry raw scraped tokens, so the map must accept both forms.
//
// `remote_*` regional tokens map to their region's representative country
// (e.g. remote_europe→GB). `remote_global` / `remote_anywhere` are
// INTENTIONALLY ABSENT — they are region-agnostic and handled separately by
// the matcher (a globally-remote role is US-accessible), never via this map.
// ---------------------------------------------------------------------------

/** ISO-3166-1 alpha-2 country code, uppercase (e.g. "US", "AE", "QA"). */
export type IsoCountry = string

/**
 * Bucket token (lowercased) → ISO country. Keys include canonical vocab tokens
 * AND common non-canonical scraped tokens. Lookups MUST lowercase + trim first.
 */
export const LOCATION_BUCKET_TO_COUNTRY: Readonly<Record<string, IsoCountry>> = {
  // ─── United States — major metros (canonical) ───
  san_francisco_bay_area: "US", new_york_metro: "US", los_angeles_metro: "US",
  seattle_metro: "US", boston_metro: "US", chicago_metro: "US", austin_metro: "US",
  denver_metro: "US", portland_oregon: "US", washington_dc_metro: "US",
  atlanta_metro: "US", miami_metro: "US", philadelphia_metro: "US",
  dallas_fort_worth: "US", houston_metro: "US", raleigh_durham: "US",
  minneapolis_st_paul: "US", san_diego: "US", salt_lake_city: "US", phoenix: "US",
  detroit: "US", st_louis: "US", kansas_city: "US", indianapolis: "US",
  columbus_ohio: "US", cleveland: "US", pittsburgh: "US", nashville: "US",
  charlotte: "US", tampa: "US", orlando: "US", jacksonville: "US", las_vegas: "US",
  sacramento: "US", providence: "US", hartford: "US", richmond_virginia: "US",
  milwaukee: "US", cincinnati: "US", buffalo: "US", rochester_new_york: "US",
  albuquerque: "US", boise: "US", honolulu: "US", anchorage: "US", tucson: "US",
  ann_arbor: "US", madison_wisconsin: "US", santa_barbara: "US", reno: "US",
  // ─── US — common scraped (non-canonical) tokens / aliases ───
  us: "US", usa: "US", united_states: "US", united_states_of_america: "US",
  america: "US", new_york_city: "US", new_york: "US", san_francisco: "US",
  los_angeles: "US", remote_united_states: "US", remote_us: "US",
  // ─── Canada (canonical) ───
  toronto: "CA", vancouver: "CA", montreal: "CA", ottawa: "CA", calgary: "CA",
  edmonton: "CA", waterloo_ontario: "CA", quebec_city: "CA", halifax: "CA",
  winnipeg: "CA", canada: "CA", remote_canada: "CA",
  // ─── United Kingdom + Ireland ───
  london_united_kingdom: "GB", manchester_united_kingdom: "GB",
  edinburgh_united_kingdom: "GB", cambridge_united_kingdom: "GB",
  oxford_united_kingdom: "GB", london: "GB", manchester: "GB", uk: "GB",
  united_kingdom: "GB", england: "GB", remote_united_kingdom: "GB",
  dublin_ireland: "IE", dublin: "IE", ireland: "IE",
  // ─── European Union ───
  berlin: "DE", munich: "DE", hamburg: "DE", frankfurt: "DE", germany: "DE",
  amsterdam: "NL", rotterdam: "NL", netherlands: "NL",
  paris: "FR", lyon: "FR", france: "FR",
  stockholm: "SE", gothenburg: "SE", sweden: "SE",
  copenhagen: "DK", denmark: "DK",
  zurich: "CH", geneva: "CH", switzerland: "CH",
  vienna: "AT", austria: "AT",
  prague: "CZ", czech_republic: "CZ", czechia: "CZ",
  warsaw: "PL", krakow: "PL", poland: "PL",
  barcelona: "ES", madrid: "ES", valencia: "ES", spain: "ES",
  lisbon: "PT", porto: "PT", portugal: "PT",
  helsinki: "FI", finland: "FI",
  oslo: "NO", norway: "NO",
  brussels: "BE", belgium: "BE",
  luxembourg_city: "LU", luxembourg: "LU",
  budapest: "HU", hungary: "HU",
  athens: "GR", greece: "GR",
  milan: "IT", rome: "IT", italy: "IT",
  tallinn: "EE", estonia: "EE",
  riga: "LV", latvia: "LV",
  vilnius: "LT", lithuania: "LT",
  reykjavik: "IS", iceland: "IS",
  remote_europe: "EU", remote_emea: "EU",
  // ─── Asia Pacific ───
  singapore: "SG",
  tokyo: "JP", osaka: "JP", kyoto: "JP", yokohama: "JP", japan: "JP",
  hong_kong: "HK",
  shanghai: "CN", beijing: "CN", shenzhen: "CN", guangzhou: "CN", hangzhou: "CN",
  chengdu: "CN", china: "CN",
  seoul: "KR", busan: "KR", korea: "KR", south_korea: "KR",
  sydney: "AU", melbourne: "AU", brisbane: "AU", perth: "AU", australia: "AU",
  auckland: "NZ", wellington: "NZ", new_zealand: "NZ",
  bangalore: "IN", mumbai: "IN", delhi_ncr: "IN", delhi: "IN", hyderabad: "IN",
  chennai: "IN", pune: "IN", kolkata: "IN", india: "IN",
  taipei: "TW", kaohsiung: "TW", taiwan: "TW",
  bangkok: "TH", thailand: "TH",
  ho_chi_minh_city: "VN", hanoi: "VN", vietnam: "VN",
  kuala_lumpur: "MY", malaysia: "MY",
  jakarta: "ID", indonesia: "ID",
  manila: "PH", philippines: "PH",
  remote_apac: "APAC",
  // ─── Latin America ───
  sao_paulo: "BR", rio_de_janeiro: "BR", brazil: "BR",
  mexico_city: "MX", guadalajara: "MX", monterrey: "MX", mexico: "MX",
  buenos_aires: "AR", argentina: "AR",
  bogota: "CO", medellin: "CO", colombia: "CO",
  santiago: "CL", chile: "CL",
  lima: "PE", peru: "PE",
  san_jose_costa_rica: "CR", costa_rica: "CR",
  panama_city: "PA", panama: "PA",
  quito: "EC", ecuador: "EC",
  montevideo: "UY", uruguay: "UY",
  remote_latam: "LATAM", remote_americas: "AMER",
  // ─── Middle East + Africa (the previously-OMITTED region) ───
  tel_aviv: "IL", haifa: "IL", israel: "IL",
  dubai: "AE", abu_dhabi: "AE", uae: "AE", united_arab_emirates: "AE",
  riyadh: "SA", jeddah: "SA", saudi_arabia: "SA",
  doha: "QA", qatar: "QA",
  istanbul: "TR", ankara: "TR", turkey: "TR",
  cairo: "EG", egypt: "EG",
  johannesburg: "ZA", cape_town: "ZA", south_africa: "ZA",
  nairobi: "KE", kenya: "KE",
  lagos: "NG", nigeria: "NG",
  accra: "GH", ghana: "GH",
  casablanca: "MA", morocco: "MA",
  addis_ababa: "ET", ethiopia: "ET",
}

/**
 * Region-agnostic remote tokens that grant US accessibility (a globally-remote
 * role can be done from the US). These NEVER map to a foreign country and are
 * the only buckets that escape the US-only platform gate on their own.
 */
export const GLOBAL_REMOTE_BUCKET_TOKENS: ReadonlySet<string> = new Set([
  "remote_anywhere",
  "remote_global",
  "remote",
  "anywhere",
  "worldwide",
])

/**
 * Map a single bucket token to its ISO country, or `undefined` when unknown /
 * region-agnostic. Lowercases + trims. Pure; no regex classification.
 */
export function locationBucketCountry(bucket: string): IsoCountry | undefined {
  return LOCATION_BUCKET_TO_COUNTRY[bucket.trim().toLowerCase()]
}

/**
 * True iff ANY of the job's buckets maps to a US location, OR a bucket is an
 * explicit US-remote token. The single source of truth for "is this job
 * US-eligible by its buckets?". Region-agnostic remote tokens do NOT count as
 * US here (the matcher handles global-remote separately).
 */
export function bucketsHaveUs(buckets: readonly string[]): boolean {
  for (const b of buckets) {
    if (locationBucketCountry(b) === "US") return true
  }
  return false
}

/**
 * True iff at least one bucket maps to a KNOWN NON-US country. A bucket that is
 * unknown (not in the map) or region-agnostic-remote does NOT count as foreign
 * — only a positively-identified foreign country does (conservative: we never
 * drop a job we cannot prove is foreign).
 */
export function bucketsHaveKnownNonUs(buckets: readonly string[]): boolean {
  for (const b of buckets) {
    const c = locationBucketCountry(b)
    if (c && c !== "US") return true
  }
  return false
}

/** True iff a bucket token is a region-agnostic global-remote escape token. */
export function isGlobalRemoteBucket(bucket: string): boolean {
  return GLOBAL_REMOTE_BUCKET_TOKENS.has(bucket.trim().toLowerCase())
}
