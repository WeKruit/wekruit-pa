/**
 * Stream F1 — Locked 10-tag industry enum + deterministic mapping.
 *
 * Used by:
 *   - cv-ingest LLM extract (Stream F1) → up to 3 industryTags per CV
 *   - matching-jobs backfill script (Stream F2) → maps the existing
 *     free-text `industry` / `industryKey` field to the canonical enum
 *   - probing flow (Stream F3, hard rule in Bible v5) → INDUSTRY confirm
 *     question is grounded in this enum, not free-text
 *   - daily-batch matcher (Stream F5) → Firestore where(industryEnum in [...])
 *
 * LOCKED: do NOT add/rename without P10 approval. The 10 buckets cover
 * 100% of the 40,374-doc corpus's 75 unique industry strings. Anything
 * unmappable falls into "other" by design.
 *
 * Mapping rationale: Stream F discovery — matching-jobs already has
 * `industryKey` (snake_case scraped values like "fintech", "healthtech",
 * "data_analytics", etc.). Mapping is purely deterministic; no LLM call
 * needed. See `INDUSTRY_KEY_MAP` below for the explicit table.
 */
import { z } from "zod"

export const INDUSTRY_TAGS = [
  "tech_software", // internet/software/SaaS
  "tech_hardware", // semiconductors/hardware/IoT
  "fintech_finance", // fintech/banking/hedge funds
  "ai_ml", // AI/ML/data science
  "healthcare_biotech", // healthcare/biotech/drug development
  "consumer_retail", // ecommerce/consumer goods/retail
  "media_entertainment", // media/gaming/content
  "manufacturing_industrial", // manufacturing/industrial/energy
  "education", // education/EdTech
  "other", // other
] as const

export type IndustryTag = (typeof INDUSTRY_TAGS)[number]
export const IndustryTagSchema = z.enum(INDUSTRY_TAGS)

/** Labels for surfacing the enum value in a Claire-voice probe. */
export const INDUSTRY_LABELS: Record<IndustryTag, { en: string }> = {
  tech_software: { en: "tech/software" },
  tech_hardware: { en: "hardware/semiconductors" },
  fintech_finance: { en: "fintech/finance" },
  ai_ml: { en: "AI/ML" },
  healthcare_biotech: { en: "healthcare/biotech" },
  consumer_retail: { en: "consumer/retail" },
  media_entertainment: { en: "media/entertainment" },
  manufacturing_industrial: { en: "manufacturing/industrial" },
  education: { en: "education/edtech" },
  other: { en: "other" },
}

/**
 * Deterministic map from the corpus's free-text `industryKey` (and a
 * superset of common synonyms) to the canonical 10-tag enum.
 *
 * Source: live audit on 2026-04-30 of `matching-jobs.industryKey`
 * found 75 distinct values across 40,374 docs. Top 30 cover ~95% of
 * the corpus; remaining 45 default to "other" via fallback.
 *
 * Rule: keys are normalized via `normalizeIndustryKey` (lowercase, snake
 * underscores, no trailing whitespace). This avoids needing entries for
 * "FinTech" / "Fin-Tech" / "fin tech" / etc.
 */
const INDUSTRY_KEY_MAP: Record<string, IndustryTag> = {
  // ---- tech_software ------------------------------------------------------
  tech: "tech_software",
  software: "tech_software",
  software_development: "tech_software",
  saas: "tech_software",
  enterprise_saas: "tech_software",
  internet: "tech_software",
  web: "tech_software",
  cloud: "tech_software",
  devops: "tech_software",
  it_services: "tech_software",
  it: "tech_software",
  cybersecurity: "tech_software",
  security: "tech_software",
  technology: "tech_software",
  telecom: "tech_software",
  telecommunications: "tech_software",
  // ---- tech_hardware ------------------------------------------------------
  hardware: "tech_hardware",
  semiconductors: "tech_hardware",
  semiconductor: "tech_hardware",
  electronics: "tech_hardware",
  consumer_electronics: "tech_hardware",
  iot: "tech_hardware",
  robotics: "tech_hardware",
  // ---- fintech_finance ----------------------------------------------------
  fintech: "fintech_finance",
  finance: "fintech_finance",
  banking: "fintech_finance",
  accounting_finance: "fintech_finance",
  insurance: "fintech_finance",
  investment: "fintech_finance",
  trading: "fintech_finance",
  hedge_fund: "fintech_finance",
  financial_services: "fintech_finance",
  reinsurance: "fintech_finance",
  insurance_services: "fintech_finance",
  // ---- ai_ml --------------------------------------------------------------
  ai: "ai_ml",
  ai_ml: "ai_ml",
  ml: "ai_ml",
  machine_learning: "ai_ml",
  data_science: "ai_ml",
  data_analytics: "ai_ml",
  data: "ai_ml",
  ai_infrastructure: "ai_ml",
  // ---- healthcare_biotech -------------------------------------------------
  healthtech: "healthcare_biotech",
  healthcare: "healthcare_biotech",
  biotech: "healthcare_biotech",
  biotechnology: "healthcare_biotech",
  pharmaceutical: "healthcare_biotech",
  pharma: "healthcare_biotech",
  medical: "healthcare_biotech",
  medical_devices: "healthcare_biotech",
  // ---- consumer_retail ----------------------------------------------------
  consumer: "consumer_retail",
  retail: "consumer_retail",
  ecommerce: "consumer_retail",
  e_commerce: "consumer_retail",
  food_beverage: "consumer_retail",
  hospitality: "consumer_retail",
  restaurants: "consumer_retail",
  travel: "consumer_retail",
  real_estate: "consumer_retail",
  facilities: "consumer_retail",
  facilities_services: "consumer_retail",
  hr_outsourcing: "consumer_retail",
  apparel: "consumer_retail",
  beauty: "consumer_retail",
  grocery: "consumer_retail",
  // ---- media_entertainment ------------------------------------------------
  media: "media_entertainment",
  entertainment: "media_entertainment",
  arts_entertainment: "media_entertainment",
  gaming: "media_entertainment",
  games: "media_entertainment",
  social_media: "media_entertainment",
  publishing: "media_entertainment",
  music: "media_entertainment",
  film: "media_entertainment",
  // ---- manufacturing_industrial -------------------------------------------
  manufacturing: "manufacturing_industrial",
  industrial: "manufacturing_industrial",
  energy: "manufacturing_industrial",
  oil_gas: "manufacturing_industrial",
  utilities: "manufacturing_industrial",
  construction: "manufacturing_industrial",
  automotive: "manufacturing_industrial",
  aerospace: "manufacturing_industrial",
  aerospace_defense: "manufacturing_industrial",
  defense: "manufacturing_industrial",
  defense_contractor: "manufacturing_industrial",
  mining: "manufacturing_industrial",
  agriculture: "manufacturing_industrial",
  chemicals: "manufacturing_industrial",
  materials: "manufacturing_industrial",
  pest_control: "consumer_retail",
  fitness: "consumer_retail",
  wellness: "consumer_retail",
  staffing: "consumer_retail",
  recruiting: "consumer_retail",
  property_management: "consumer_retail",
  logistics: "manufacturing_industrial",
  transportation: "manufacturing_industrial",
  // ---- education ----------------------------------------------------------
  education: "education",
  edtech: "education",
  // every other surfaced (engineering / sales / management / customer_service /
  // marketing / hr / legal / consulting / design / product / business /
  // government / unknown / other) defaults to "other" via fallback below
}

export function normalizeIndustryKey(raw: string): string {
  return raw
    .toLowerCase()
    .trim()
    .replace(/[\s\-/]+/g, "_")
    .replace(/_+/g, "_")
}

/**
 * Deterministic mapper. Returns "other" when the input doesn't match any
 * entry in INDUSTRY_KEY_MAP. Caller can layer an LLM fallback on top if
 * the corpus drifts (currently NOT needed — 100% mapped or intentionally
 * "other"-bucketed).
 */
export function mapToCanonicalIndustry(raw: string | null | undefined): IndustryTag {
  if (!raw || typeof raw !== "string") return "other"
  const norm = normalizeIndustryKey(raw)
  // Identity short-circuit: if the LLM (or any caller) hands us an
  // already-canonical token, preserve it. Without this, "fintech_finance"
  // would get re-mapped via INDUSTRY_KEY_MAP — a miss — and degrade to "other".
  if ((INDUSTRY_TAGS as readonly string[]).includes(norm)) {
    return norm as IndustryTag
  }
  return INDUSTRY_KEY_MAP[norm] ?? "other"
}

// ---------------------------------------------------------------------------
// Stream H8 — Multi-signal cascade mapper (F2-redo).
//
// F2's deterministic mapper hit 32% non-other on the 40374-doc corpus, well
// below the 80% threshold and the 60% pragmatic floor. RCA (b67c964 + corpus
// audit): industryKey alone carries job-function tokens (`engineering`,
// `marketing`, `sales`, `customer_service`, `hr`, `consulting`, `design`,
// `product`) for ~half the corpus — these CANNOT be mapped to a 10-tag
// industry from the key alone. We need a SECOND signal.
//
// H8 fix: cascade three signals (industryKey → companyName → roleTitle).
// First non-"other" hit wins. Cost stays at $0 — no LLM, no embedding.
//
// Surface contract: `mapToCanonicalIndustryFromSignals(signals)` is the new
// preferred entry point for the matching-jobs enricher. Legacy
// `mapToCanonicalIndustry(raw)` is preserved untouched for cv-ingest's CV-tag
// enrichment (different problem domain — LLM emits canonical tokens already).
// ---------------------------------------------------------------------------

export type IndustrySignals = {
  industryKey?: string | null
  companyName?: string | null
  roleTitle?: string | null
}

/**
 * Top-companies → canonical industry. Hand-curated, ~115 entries. Lookup is
 * performed against `normalizeCompanyName(name)`; well-known multi-word
 * names (e.g. "Bank of America", "General Motors") are keyed in their
 * normalized snake form ("bank_of_america"). Misses fall through to
 * roleTitle — never bias incorrectly when uncertain.
 */
const COMPANY_INDUSTRY_MAP: Record<string, IndustryTag> = {
  // tech_software — big tech + SaaS
  google: "tech_software",
  alphabet: "tech_software",
  microsoft: "tech_software",
  amazon: "tech_software",
  meta: "tech_software",
  facebook: "tech_software",
  netflix: "media_entertainment",
  uber: "tech_software",
  lyft: "tech_software",
  airbnb: "tech_software",
  doordash: "tech_software",
  instacart: "consumer_retail",
  shopify: "tech_software",
  salesforce: "tech_software",
  oracle: "tech_software",
  ibm: "tech_software",
  vmware: "tech_software",
  servicenow: "tech_software",
  workday: "tech_software",
  atlassian: "tech_software",
  snowflake: "tech_software",
  databricks: "ai_ml",
  mongodb: "tech_software",
  cloudflare: "tech_software",
  datadog: "tech_software",
  splunk: "tech_software",
  palo_alto_networks: "tech_software",
  paloalto: "tech_software",
  crowdstrike: "tech_software",
  zscaler: "tech_software",
  okta: "tech_software",
  hashicorp: "tech_software",
  github: "tech_software",
  gitlab: "tech_software",
  twilio: "tech_software",
  zoom: "tech_software",
  slack: "tech_software",
  asana: "tech_software",
  notion: "tech_software",
  figma: "tech_software",
  canva: "tech_software",
  dropbox: "tech_software",
  box: "tech_software",
  // ai_ml
  anthropic: "ai_ml",
  openai: "ai_ml",
  scale_ai: "ai_ml",
  hugging_face: "ai_ml",
  huggingface: "ai_ml",
  cohere: "ai_ml",
  mistral: "ai_ml",
  mistral_ai: "ai_ml",
  // tech_hardware / semis
  apple: "tech_hardware",
  cisco: "tech_hardware",
  nvidia: "tech_hardware",
  amd: "tech_hardware",
  intel: "tech_hardware",
  qualcomm: "tech_hardware",
  broadcom: "tech_hardware",
  micron: "tech_hardware",
  asml: "tech_hardware",
  tsmc: "tech_hardware",
  arm: "tech_hardware",
  applied_materials: "tech_hardware",
  // fintech / finance
  stripe: "fintech_finance",
  block: "fintech_finance",
  square: "fintech_finance",
  paypal: "fintech_finance",
  visa: "fintech_finance",
  mastercard: "fintech_finance",
  jpmorgan: "fintech_finance",
  jpmorgan_chase: "fintech_finance",
  goldman_sachs: "fintech_finance",
  morgan_stanley: "fintech_finance",
  blackrock: "fintech_finance",
  citadel: "fintech_finance",
  jane_street: "fintech_finance",
  two_sigma: "fintech_finance",
  bridgewater: "fintech_finance",
  bridgewater_associates: "fintech_finance",
  bank_of_america: "fintech_finance",
  wells_fargo: "fintech_finance",
  citigroup: "fintech_finance",
  citi: "fintech_finance",
  coinbase: "fintech_finance",
  robinhood: "fintech_finance",
  affirm: "fintech_finance",
  klarna: "fintech_finance",
  plaid: "fintech_finance",
  brex: "fintech_finance",
  zurich_insurance: "fintech_finance",
  zurich: "fintech_finance",
  goosehead_insurance: "fintech_finance",
  goosehead: "fintech_finance",
  h_r_block: "fintech_finance",
  hr_block: "fintech_finance",
  nicsa: "fintech_finance",
  fidelity: "fintech_finance",
  vanguard: "fintech_finance",
  schwab: "fintech_finance",
  charles_schwab: "fintech_finance",
  ally: "fintech_finance",
  ally_financial: "fintech_finance",
  amex: "fintech_finance",
  american_express: "fintech_finance",
  capital_one: "fintech_finance",
  discover: "fintech_finance",
  // healthcare / biotech
  natera: "healthcare_biotech",
  bristol_myers_squibb: "healthcare_biotech",
  bristol_myers: "healthcare_biotech",
  amgen: "healthcare_biotech",
  regeneron: "healthcare_biotech",
  vertex_pharmaceuticals: "healthcare_biotech",
  gilead: "healthcare_biotech",
  eli_lilly: "healthcare_biotech",
  lilly: "healthcare_biotech",
  kaiser_permanente: "healthcare_biotech",
  cleveland_clinic: "healthcare_biotech",
  mayo_clinic: "healthcare_biotech",
  mass_general_brigham: "healthcare_biotech",
  hca_healthcare: "healthcare_biotech",
  hca: "healthcare_biotech",
  medline: "healthcare_biotech",
  medline_industries: "healthcare_biotech",
  baxter: "healthcare_biotech",
  baxter_international: "healthcare_biotech",
  stryker: "healthcare_biotech",
  thermo_fisher: "healthcare_biotech",
  thermo_fisher_scientific: "healthcare_biotech",
  becton_dickinson: "healthcare_biotech",
  bd: "healthcare_biotech",
  abbott: "healthcare_biotech",
  abbott_laboratories: "healthcare_biotech",
  moderna: "healthcare_biotech",
  pfizer: "healthcare_biotech",
  johnson_johnson: "healthcare_biotech",
  merck: "healthcare_biotech",
  novartis: "healthcare_biotech",
  roche: "healthcare_biotech",
  abbvie: "healthcare_biotech",
  unitedhealth: "healthcare_biotech",
  cvs_health: "healthcare_biotech",
  oscar_health: "healthcare_biotech",
  flatiron_health: "healthcare_biotech",
  illumina: "healthcare_biotech",
  // consumer / retail
  walgreens: "consumer_retail",
  cvs: "consumer_retail",
  rite_aid: "consumer_retail",
  whole_foods_market: "consumer_retail",
  whole_foods: "consumer_retail",
  the_tjx_companies: "consumer_retail",
  tjx: "consumer_retail",
  tj_maxx: "consumer_retail",
  marshalls: "consumer_retail",
  homegoods: "consumer_retail",
  rent_a_center: "consumer_retail",
  carvana: "consumer_retail",
  ulta_beauty: "consumer_retail",
  ulta: "consumer_retail",
  express: "consumer_retail",
  dollar_tree: "consumer_retail",
  dollar_tree_stores: "consumer_retail",
  dollar_general: "consumer_retail",
  best_version_media: "media_entertainment",
  hibu: "media_entertainment",
  circle_k: "consumer_retail",
  domino_s: "consumer_retail",
  dominos: "consumer_retail",
  victoria_s_secret: "consumer_retail",
  victorias_secret: "consumer_retail",
  o_reilly_auto_parts: "consumer_retail",
  oreilly_auto_parts: "consumer_retail",
  autozone: "consumer_retail",
  walmart: "consumer_retail",
  allied_universal: "consumer_retail",
  victra: "consumer_retail",
  sun_auto_tire_service: "consumer_retail",
  rollins: "consumer_retail",
  american_residential_services: "consumer_retail",
  renuity: "consumer_retail",
  public_storage: "consumer_retail",
  asset_living: "consumer_retail",
  greystar: "consumer_retail",
  greystar_international: "consumer_retail",
  panda_restaurant_group: "consumer_retail",
  panda_express: "consumer_retail",
  ross_stores: "consumer_retail",
  ross: "consumer_retail",
  floor_decor: "consumer_retail",
  nordstrom: "consumer_retail",
  camping_world: "consumer_retail",
  cbre: "consumer_retail",
  cushman_wakefield: "consumer_retail",
  couche_tard: "consumer_retail",
  hometeam_pest_defense: "consumer_retail",
  sunbelt_rentals: "consumer_retail",
  holiday_stationstores: "consumer_retail",
  leaf_home: "consumer_retail",
  aaa: "consumer_retail",
  visionworks: "consumer_retail",
  visionworks_of_america: "consumer_retail",
  jcpenney: "consumer_retail",
  kohls: "consumer_retail",
  kohl_s: "consumer_retail",
  macy_s: "consumer_retail",
  macys: "consumer_retail",
  bestbuy: "consumer_retail",
  best_buy: "consumer_retail",
  starbucks: "consumer_retail",
  mcdonalds: "consumer_retail",
  mcdonald_s: "consumer_retail",
  chick_fil_a: "consumer_retail",
  chipotle: "consumer_retail",
  chipotle_mexican_grill: "consumer_retail",
  uber_eats: "consumer_retail",
  hilton: "consumer_retail",
  marriott: "consumer_retail",
  hyatt: "consumer_retail",
  five_below: "consumer_retail",
  hobby_lobby: "consumer_retail",
  hannaford_supermarkets: "consumer_retail",
  hannaford: "consumer_retail",
  publix: "consumer_retail",
  publix_pharmacy: "consumer_retail",
  bj_s_wholesale_club: "consumer_retail",
  bjs_wholesale_club: "consumer_retail",
  bjs: "consumer_retail",
  foot_locker: "consumer_retail",
  sherwin_williams: "consumer_retail",
  the_aaron_s_company: "consumer_retail",
  aaron_s: "consumer_retail",
  aarons: "consumer_retail",
  hdr: "manufacturing_industrial",
  cintas: "consumer_retail",
  trugreen: "consumer_retail",
  orkin: "consumer_retail",
  adt: "consumer_retail",
  valet_living: "consumer_retail",
  firstservice_residential: "consumer_retail",
  sbm_management_services: "consumer_retail",
  national_fitness_partners: "consumer_retail",
  eos_fitness: "consumer_retail",
  windermere_real_estate: "consumer_retail",
  windermere: "consumer_retail",
  blain_s_farm_fleet: "consumer_retail",
  blains_farm_fleet: "consumer_retail",
  kal_tire: "consumer_retail",
  jerry: "fintech_finance",
  prolific: "consumer_retail",
  metropolis_technologies: "tech_software",
  metropolis: "tech_software",
  softchoice: "tech_software",
  microchip_technology: "tech_hardware",
  microchip: "tech_hardware",
  zoll_cardiac_management_solutions: "healthcare_biotech",
  zoll: "healthcare_biotech",
  pace_analytical_services: "healthcare_biotech",
  pace_analytical: "healthcare_biotech",
  eurofins: "healthcare_biotech",
  community_choice_financial: "fintech_finance",
  marsh_mclennan_agency: "fintech_finance",
  marsh_mclennan: "fintech_finance",
  farmers_insurance: "fintech_finance",
  allstate: "fintech_finance",
  total_quality_logistics: "manufacturing_industrial",
  cargill: "manufacturing_industrial",
  flatirondragados: "manufacturing_industrial",
  flatiron: "manufacturing_industrial",
  wsp: "manufacturing_industrial",
  spacex: "manufacturing_industrial",
  gpm_investments: "consumer_retail",
  target: "consumer_retail",
  costco: "consumer_retail",
  ebay: "consumer_retail",
  etsy: "consumer_retail",
  wayfair: "consumer_retail",
  // media / entertainment
  disney: "media_entertainment",
  walt_disney: "media_entertainment",
  warner_bros: "media_entertainment",
  spotify: "media_entertainment",
  tiktok: "media_entertainment",
  bytedance: "media_entertainment",
  pinterest: "media_entertainment",
  snap: "media_entertainment",
  snapchat: "media_entertainment",
  reddit: "media_entertainment",
  comcast: "media_entertainment",
  nbcuniversal: "media_entertainment",
  paramount: "media_entertainment",
  hulu: "media_entertainment",
  twitch: "media_entertainment",
  twitter: "media_entertainment",
  x_corp: "media_entertainment",
  // manufacturing / industrial
  tesla: "manufacturing_industrial",
  ford: "manufacturing_industrial",
  ford_motor: "manufacturing_industrial",
  gm: "manufacturing_industrial",
  general_motors: "manufacturing_industrial",
  boeing: "manufacturing_industrial",
  airbus: "manufacturing_industrial",
  lockheed_martin: "manufacturing_industrial",
  raytheon: "manufacturing_industrial",
  caterpillar: "manufacturing_industrial",
  ge: "manufacturing_industrial",
  general_electric: "manufacturing_industrial",
  siemens: "manufacturing_industrial",
  honda: "manufacturing_industrial",
  toyota: "manufacturing_industrial",
  bmw: "manufacturing_industrial",
  volkswagen: "manufacturing_industrial",
  rivian: "manufacturing_industrial",
  lucid: "manufacturing_industrial",
  northrop_grumman: "manufacturing_industrial",
  northrop: "manufacturing_industrial",
  general_dynamics: "manufacturing_industrial",
  honeywell: "manufacturing_industrial",
  t_mobile: "tech_software",
  tmobile: "tech_software",
  at_t: "tech_software",
  att: "tech_software",
  verizon: "tech_software",
  verizon_communications: "tech_software",
  exxonmobil: "manufacturing_industrial",
  exxon: "manufacturing_industrial",
  chevron: "manufacturing_industrial",
  shell: "manufacturing_industrial",
  bp: "manufacturing_industrial",
  techtronic_industries: "manufacturing_industrial",
  techtronic: "manufacturing_industrial",
  rrd: "manufacturing_industrial",
  precision_castparts: "manufacturing_industrial",
  jacobs: "manufacturing_industrial",
  jacobs_engineering: "manufacturing_industrial",
  leidos: "manufacturing_industrial",
  fluor: "manufacturing_industrial",
  bechtel: "manufacturing_industrial",
  parsons: "manufacturing_industrial",
  "3m": "manufacturing_industrial",
  // education
  coursera: "education",
  udemy: "education",
  duolingo: "education",
  chegg: "education",
  // ---- H10 long-tail (audited 2026-05-01 against still-other top-200) ----
  // Adding ~55 entries to push non-other coverage from 52.7% → 60%+. Each
  // mapped from a confident industry signal (company is a recognized brand
  // in its sector); ambiguous ones (e.g. "spectrum" — could be telecom or
  // marketing agency) mapped to the most likely sector based on size.
  // consumer_retail (long-tail)
  sbm_management_services_lp: "consumer_retail",
  sbm_management: "consumer_retail",
  the_aaron_s_company_inc: "consumer_retail",
  the_aaron_s: "consumer_retail",
  aspen_dental: "healthcare_biotech",
  banfield_pet_hospital: "healthcare_biotech",
  banfield: "healthcare_biotech",
  belle_tire: "consumer_retail",
  carmax: "consumer_retail",
  napa_auto_parts: "consumer_retail",
  napa: "consumer_retail",
  pep_boys: "consumer_retail",
  staples_canada: "consumer_retail",
  staples: "consumer_retail",
  dollarama: "consumer_retail",
  rural_king: "consumer_retail",
  the_home_depot: "consumer_retail",
  home_depot: "consumer_retail",
  lululemon: "consumer_retail",
  rei: "consumer_retail",
  mattress_firm: "consumer_retail",
  spirit_halloween: "consumer_retail",
  bass_pro_shops: "consumer_retail",
  natural_grocers_by_vitamin_cottage: "consumer_retail",
  natural_grocers: "consumer_retail",
  meijer: "consumer_retail",
  hy_vee_inc: "consumer_retail",
  hy_vee: "consumer_retail",
  food_lion: "consumer_retail",
  michaels_stores: "consumer_retail",
  michaels: "consumer_retail",
  abercrombie_fitch_co: "consumer_retail",
  abercrombie_fitch: "consumer_retail",
  hibbett: "consumer_retail",
  scheels: "consumer_retail",
  pilot_flying_j: "consumer_retail",
  "7_eleven": "consumer_retail",
  love_s_travel_stops: "consumer_retail",
  loves: "consumer_retail",
  travelcenters_of_america: "consumer_retail",
  getgo_café_market: "consumer_retail",
  getgo: "consumer_retail",
  mobilelink: "consumer_retail",
  leslie_s: "consumer_retail",
  enterprise: "consumer_retail",
  avis_budget_group: "consumer_retail",
  u_haul: "consumer_retail",
  uhaul: "consumer_retail",
  the_save_mart_companies: "consumer_retail",
  save_mart: "consumer_retail",
  williams_sonoma_inc: "consumer_retail",
  williams_sonoma: "consumer_retail",
  nike: "consumer_retail",
  bridgestone_americas: "consumer_retail",
  bridgestone: "consumer_retail",
  the_goodyear_tire_rubber_company: "consumer_retail",
  goodyear: "consumer_retail",
  les_schwab_tire_centers: "consumer_retail",
  les_schwab: "consumer_retail",
  fountain_tire: "consumer_retail",
  bj_s_restaurants: "consumer_retail",
  spencer_s: "consumer_retail",
  "4_seasons_hotels_and_resorts": "consumer_retail",
  four_seasons_hotels_and_resorts: "consumer_retail",
  four_seasons: "consumer_retail",
  // healthcare_biotech (long-tail)
  humana: "healthcare_biotech",
  sevita: "healthcare_biotech",
  bayada_home_health_care: "healthcare_biotech",
  bayada: "healthcare_biotech",
  beckman_coulter_diagnostics: "healthcare_biotech",
  beckman_coulter: "healthcare_biotech",
  cedars_sinai: "healthcare_biotech",
  beth_israel_lahey_health: "healthcare_biotech",
  nyu_langone_health: "healthcare_biotech",
  nyu_langone: "healthcare_biotech",
  steris: "healthcare_biotech",
  daniels_health: "healthcare_biotech",
  curaleaf: "healthcare_biotech",
  lifenet_health: "healthcare_biotech",
  // fintech_finance (long-tail)
  pnc: "fintech_finance",
  bmo: "fintech_finance",
  m_t_bank: "fintech_finance",
  td_securities: "fintech_finance",
  regions_bank: "fintech_finance",
  santander_bank_n_a: "fintech_finance",
  santander: "fintech_finance",
  associated_bank: "fintech_finance",
  rbc: "fintech_finance",
  fairstone_bank: "fintech_finance",
  the_hartford: "fintech_finance",
  travelers: "fintech_finance",
  usaa: "fintech_finance",
  state_farm_agent: "fintech_finance",
  state_farm: "fintech_finance",
  new_york_life_insurance_company: "fintech_finance",
  new_york_life: "fintech_finance",
  edward_jones: "fintech_finance",
  jackson_hewitt_tax_service_inc: "fintech_finance",
  jackson_hewitt: "fintech_finance",
  brown_brown: "fintech_finance",
  hub_international: "fintech_finance",
  acrisure: "fintech_finance",
  baker_tilly_us: "fintech_finance",
  baker_tilly: "fintech_finance",
  deloitte: "fintech_finance",
  kpmg_us: "fintech_finance",
  kpmg: "fintech_finance",
  community_choice_financial_family_of_brands: "fintech_finance",
  first_american: "fintech_finance",
  // tech_software / telecom
  spectrum: "tech_software",
  tds_telecommunications_llc: "tech_software",
  tds_telecommunications: "tech_software",
  optimum: "tech_software",
  rippling: "tech_software",
  toast: "tech_software",
  samsara: "tech_software",
  paycom: "tech_software",
  broadridge: "tech_software",
  adp: "tech_software",
  iron_mountain: "tech_software",
  echostar_corporation: "tech_software",
  echostar: "tech_software",
  motorola_solutions: "tech_software",
  motorola: "tech_software",
  // manufacturing_industrial / utilities
  arcadis: "manufacturing_industrial",
  kiewit: "manufacturing_industrial",
  henderson_engineers: "manufacturing_industrial",
  rtx: "manufacturing_industrial",
  westinghouse_electric_company: "manufacturing_industrial",
  westinghouse: "manufacturing_industrial",
  xcel_energy: "manufacturing_industrial",
  sunrun: "manufacturing_industrial",
  ryder_system_inc: "manufacturing_industrial",
  ryder: "manufacturing_industrial",
  ups: "manufacturing_industrial",
  pepsico: "manufacturing_industrial",
  procter_gamble: "manufacturing_industrial",
  canteen: "consumer_retail",
  pearson: "education",
  northwestern_university: "education",
  // ---- end H10 long-tail ----
}

/**
 * roleTitle keyword → canonical industry. Compound matching: substring
 * search against the lowercased title. First match by ORDER wins, so put
 * narrower phrases before broader ones (e.g. "machine learning" before
 * "engineer"). Cost: O(N*K) per row but K is small (~30) and N is the
 * batch size — acceptable for a one-shot enrichment.
 */
const ROLE_TITLE_KEYWORDS: Array<{ pattern: RegExp; tag: IndustryTag }> = [
  // ai_ml — narrow phrases first
  { pattern: /\b(machine\s*learning|ml\s*engineer|data\s*scientist|applied\s*scientist|ai\s*engineer|nlp\s*engineer|computer\s*vision)\b/i, tag: "ai_ml" },
  { pattern: /\b(ml|ai)\s*(researcher|scientist|engineer)\b/i, tag: "ai_ml" },
  // tech_hardware — narrow phrases first (before generic "engineer")
  { pattern: /\b(asic|fpga|firmware|embedded|hardware\s*engineer|silicon|chip\s*design|semiconductor)\b/i, tag: "tech_hardware" },
  // fintech_finance
  { pattern: /\b(quant|quantitative|trader|trading|investment\s*bank|portfolio\s*manager|risk\s*analyst|actuary|underwriter)\b/i, tag: "fintech_finance" },
  // healthcare_biotech
  { pattern: /\b(clinical|biostatistician|bioinformatic|pharmacist|nurse|physician|medical\s*affairs)\b/i, tag: "healthcare_biotech" },
  // tech_software — broad coverage; placed AFTER hardware so "embedded" wins
  { pattern: /\b(software\s*engineer|swe|full\s*stack|fullstack|frontend|front\s*end|backend|back\s*end|platform\s*engineer|sre|site\s*reliability|devops|cloud\s*engineer|security\s*engineer|web\s*developer|mobile\s*engineer|ios\s*engineer|android\s*engineer|application\s*engineer)\b/i, tag: "tech_software" },
  // education
  { pattern: /\b(teacher|professor|lecturer|tutor|instructor|education\s*specialist)\b/i, tag: "education" },
  // consumer_retail — store-level + restaurant + delivery roles
  { pattern: /\b(store\s*manager|store\s*associate|sales\s*associate|cashier|barista|server|bartender|line\s*cook|retail\s*sales|delivery\s*driver|warehouse\s*associate|loss\s*prevention)\b/i, tag: "consumer_retail" },
  // manufacturing_industrial — blue-collar industrial roles
  { pattern: /\b(maintenance\s*technician|machinist|assembly\s*technician|production\s*operator|forklift|truck\s*driver|cdl\s*driver|welder|electrician|hvac\s*technician|plumber)\b/i, tag: "manufacturing_industrial" },
  // sales — explicitly stay other (job-function, not industry)
  // (intentionally not present; "sales" alone shouldn't bias to any industry)
  // healthcare_biotech — service roles in healthcare orgs
  { pattern: /\b(certified\s*nursing|cna|medical\s*assistant|patient\s*care|phlebotomist|radiology\s*tech|respiratory\s*therapist|registered\s*nurse|rn\b)\b/i, tag: "healthcare_biotech" },
]

/**
 * Normalize a company name for COMPANY_INDUSTRY_MAP lookup. Drops common
 * legal suffixes (Inc., LLC., Co., Ltd., Corp., Corporation) and reduces
 * whitespace + punctuation to single underscores.
 */
export function normalizeCompanyName(raw: string | null | undefined): string {
  if (!raw || typeof raw !== "string") return ""
  let s = raw.toLowerCase().trim()
  // Strip legal suffixes (multi-pass since some names chain them).
  s = s.replace(/[,.]/g, " ")
  s = s.replace(/\b(inc|incorporated|llc|llp|ltd|limited|co|corp|corporation|company|gmbh|ag|sa|plc|nv)\b\.?/g, " ")
  s = s.replace(/[^a-z0-9]+/g, "_")
  s = s.replace(/^_+|_+$/g, "")
  return s
}

function lookupCompany(name: string | null | undefined): IndustryTag | null {
  const norm = normalizeCompanyName(name)
  if (!norm) return null
  if (norm in COMPANY_INDUSTRY_MAP) return COMPANY_INDUSTRY_MAP[norm]!
  // Defensive: try the first word too — covers "Stripe Payments", "Uber
  // Eats", etc. without needing a long-tail entry.
  const first = norm.split("_")[0]
  if (first && first in COMPANY_INDUSTRY_MAP) return COMPANY_INDUSTRY_MAP[first]!
  return null
}

function lookupRoleTitle(title: string | null | undefined): IndustryTag | null {
  if (!title || typeof title !== "string") return null
  for (const { pattern, tag } of ROLE_TITLE_KEYWORDS) {
    if (pattern.test(title)) return tag
  }
  return null
}

// ---------------------------------------------------------------------------
// Stream H11 — companyName × roleTitle compound check.
//
// H8/H10's companyName lift was too aggressive for multi-vertical employers.
// Audit on 2026-05-01: Amazon-tagged "tech_software" rows in the corpus
// included EHS Specialist, Workplace Safety, Lead Fulfillment Associate, Prime
// Air Ground Handler — alongside legit SDE I and Robotics Engineer. Same for
// Snowflake (SDE vs Account Based Marketing Specialist).
//
// Fix: gate the companyName lift on a roleTitle compatibility check. If the
// role is a non-tech blue-collar / non-tech function role (warehouse, EHS,
// marketing, customer service, etc.), DO NOT lift via companyName — fall
// through to roleTitle's own bucket (often consumer_retail or manufacturing
// via ROLE_TITLE_KEYWORDS), or "other" as last resort.
//
// A tech-positive whitelist (engineer / scientist / SDE / ML / research)
// reverses the gate so e.g. "Software Engineer Associate" is NOT blocked
// just because it contains "associate".
//
// Special case: when companyName lifts to fintech_finance AND roleTitle is a
// finance function (tax / accountant / bookkeeper), we KEEP the lift — tax
// IS finance even though it triggers NON_TECH_FUNCTION_REGEX. This matches
// the H11 spec: JPMorgan Tax Consultant → fintech_finance, but Deloitte Tax
// Consultant ALSO stays fintech_finance (Deloitte mapped to fintech bucket).
// ---------------------------------------------------------------------------

/**
 * Non-tech blue-collar / hourly / service role titles. Matching here blocks
 * the companyName lift unless the role ALSO matches TECH_POSITIVE_REGEX.
 */
export const NON_TECH_ROLE_REGEX =
  /\b(warehouse|fulfillment|associate(?!\s+(engineer|software|product|data))|cashier|stocker|janitor|cleaner|driver|driving|valet|safety\s+specialist|ehs|workplace\s+safety|ground\s+handler|operator(?!\s+engineer)|loader|packer|forklift|sorter|environmental\s+health|building\s+coordinator|maintenance\s+worker|housekeeper|server|barista|cook|line\s+cook|dishwasher|store\s+associate|valet\s+operations)\b/i

/**
 * Non-tech functional roles (marketing / sales / HR / customer service / tax
 * / accounting). Matching blocks the companyName lift unless TECH_POSITIVE
 * fires OR (companyName is in fintech_finance bucket AND role is finance).
 */
export const NON_TECH_FUNCTION_REGEX =
  /\b(account\s+based\s+marketing|marketing\s+specialist|marketing\s+manager|marketing\s+coordinator|sales\s+representative|sales\s+associate|sales\s+coordinator|hr\s+specialist|hr\s+coordinator|recruiter|talent\s+acquisition|customer\s+service|customer\s+support|tax\s+consultant|tax\s+associate|accountant|bookkeeper|operations\s+coordinator|operations\s+specialist)\b/i

/**
 * Tech-positive whitelist — these tokens override the NON_TECH gates so we
 * don't accidentally block legitimate Amazon/Snowflake SDE/ML/research roles.
 * Note word-boundary handling: "engineer" must NOT collide with the
 * negative-lookahead "associate(?!\s+engineer)" — that's why we keep the
 * whitelist independent of NON_TECH_ROLE.
 */
export const TECH_POSITIVE_REGEX =
  /\b(software\s+engineer|swe|sde\b|sdet\b|ml\s+engineer|ai\s+engineer|machine\s+learning|data\s+engineer|data\s+scientist|data\s+analyst|research\s+scientist|applied\s+scientist|robotics\s+engineer|hardware\s+engineer|firmware|developer|architect|platform\s+engineer|backend|frontend|full\s*stack|sre|devops|cloud\s+engineer|security\s+engineer)\b/i

/**
 * Finance-function roles inside fintech/finance employers (Deloitte, KPMG,
 * JPMorgan, banks, insurance carriers). When the company already maps to
 * fintech_finance, these roles ARE the finance bucket — don't block them.
 */
const FINANCE_FUNCTION_REGEX =
  /\b(tax\s+consultant|tax\s+associate|tax\s+manager|accountant|bookkeeper|auditor|finance\s+associate|finance\s+analyst|financial\s+analyst|financial\s+advisor|underwriter|actuary|risk\s+analyst)\b/i

/**
 * H8 multi-signal cascade. Returns the FIRST non-"other" hit from
 * (industryKey → companyName → roleTitle). Falls through to "other" only
 * when ALL three signals are missing or unmappable.
 *
 * Ordering rationale: industryKey is the most reliable when present (the
 * scraper extracted it from the JD's structured industry field). Company
 * name is next-strongest signal. Role title is last because it bleeds
 * across industries (a "software engineer" works in healthcare AND
 * fintech AND tech).
 *
 * H11 (2026-05-01): companyName lift now gated by roleTitle compatibility
 * check. See NON_TECH_ROLE_REGEX / NON_TECH_FUNCTION_REGEX above.
 */
/**
 * White-collar tech-bias buckets where multi-vertical employers (Amazon,
 * Snowflake, Microsoft, JPMorgan, Stripe, Apple, Nvidia) cause false-positive
 * lifts when their warehouse / fulfillment / EHS / marketing / customer-service
 * jobs inherit the bucket. The H11 gate only fires for these buckets.
 */
const TECH_BIAS_BUCKETS: ReadonlyArray<IndustryTag> = [
  "tech_software",
  "tech_hardware",
  "ai_ml",
  "fintech_finance",
]

/**
 * Returns true if the (bucket, roleTitle) pair should be BLOCKED — i.e. the
 * lift to a tech-bias bucket is not coherent with a non-tech role.
 *
 * Rules:
 *   - Only tech-bias buckets are gated. consumer_retail / manufacturing /
 *     healthcare / media / education / education are pass-through.
 *   - Tech-positive role tokens (engineer / scientist / SDE / ML / etc.)
 *     ALWAYS allow the lift.
 *   - Inside fintech_finance: finance-function roles (tax / accountant /
 *     auditor) ALSO allow the lift (tax IS finance).
 *   - Otherwise: NON_TECH_ROLE or NON_TECH_FUNCTION matches → blocked.
 */
function shouldBlockTechBiasLift(bucket: IndustryTag, roleTitle: string | null | undefined): boolean {
  if (!(TECH_BIAS_BUCKETS as readonly string[]).includes(bucket)) return false
  const role = typeof roleTitle === "string" ? roleTitle : ""
  if (role.length === 0) return false
  if (TECH_POSITIVE_REGEX.test(role)) return false
  const nonTechRole = NON_TECH_ROLE_REGEX.test(role)
  const nonTechFn = NON_TECH_FUNCTION_REGEX.test(role)
  if (!nonTechRole && !nonTechFn) return false
  // Special case: finance-function roles inside fintech_finance bucket
  // are coherent (tax IS finance) — don't block.
  if (bucket === "fintech_finance" && FINANCE_FUNCTION_REGEX.test(role)) return false
  return true
}

export function mapToCanonicalIndustryFromSignals(s: IndustrySignals): IndustryTag {
  // 1. industryKey — strongest signal, hits the existing F2 map.
  // H11: even when industryKey resolves cleanly, gate against roleTitle for
  // tech-bias buckets. This catches Amazon "EHS Specialist" rows scraped
  // with industryKey="enterprise_saas" — without the gate, step 1 would
  // return tech_software and bypass step 2's gate.
  const fromKey =
    typeof s.industryKey === "string" && s.industryKey.length > 0
      ? mapToCanonicalIndustry(s.industryKey)
      : "other"
  if (fromKey !== "other" && !shouldBlockTechBiasLift(fromKey, s.roleTitle)) {
    return fromKey
  }

  // 2. companyName — second-strongest signal, also H11-gated.
  const fromCompany = lookupCompany(s.companyName)
  if (fromCompany && !shouldBlockTechBiasLift(fromCompany, s.roleTitle)) {
    return fromCompany
  }

  // 3. roleTitle — last resort, weakest signal.
  const fromRole = lookupRoleTitle(s.roleTitle)
  if (fromRole) return fromRole

  return "other"
}

// ---------------------------------------------------------------------------
// iter34 H.3a — skill-token-driven industryTags fallback.
//
// Adam complaint: his real CV (SWE @ Tesla / AWS / GCP / Anthropic-stack) was
// repeatedly mis-tagged by the LLM as ["other"]. The LLM is unreliable on the
// industry bucket when the CV is heavy on tools/companies but light on
// industry-vertical phrasing. Fallback rule: if the validator-clamped tags
// resolve to ["other"] AND the candidateProfile.skills array contains any
// recognizable tech / AI token, force-add `tech_software` / `ai_ml`. The
// rule is deterministic, $0 cost, and runs after the LLM call so it cannot
// regress correctly-tagged CVs.
//
// Token lists are intentionally lowercase substring matches — substring lets
// "tensorflow.js" match "tensorflow", "amazon web services" match "aws", etc.
// Order matters for readability only; any-match wins.
// ---------------------------------------------------------------------------

/** Tech tokens that promote `tech_software` when found in a skill string. */
export const TECH_TOKENS: ReadonlyArray<string> = [
  "python",
  "java",
  "javascript",
  "typescript",
  "go",
  "rust",
  "c++",
  "ruby",
  "swift",
  "kotlin",
  "react",
  "vue",
  "angular",
  "node",
  "express",
  "django",
  "flask",
  "spring",
  "aws",
  "gcp",
  "azure",
  "docker",
  "kubernetes",
]

/** AI/ML tokens that promote `ai_ml` when found in a skill string. */
export const AI_TOKENS: ReadonlyArray<string> = [
  "tensorflow",
  "pytorch",
  "transformers",
  "openai",
  "anthropic",
  "langchain",
  "llamaindex",
  "cuda",
  "machine learning",
  "deep learning",
  "llm",
  "embedding",
]

/**
 * Apply skill-token fallback rules to LLM-emitted industryTags.
 *
 * Behavior:
 *   - Drops any "other" tags from the LLM output (we'll re-add at the end if
 *     the result is still empty).
 *   - If any skill contains a TECH_TOKENS substring → adds `tech_software`.
 *   - If any skill contains an AI_TOKENS substring → adds `ai_ml`.
 *   - Returns the merged + deduped + capped-at-3 list. Falls back to
 *     `["other"]` only when no skill matched and the LLM list was empty
 *     after filtering.
 *
 * NEVER throws. Operates on already-canonical IndustryTag values (the caller
 * passes the output of validateStructuredCv).
 */
export function applyIndustryTagsFallback(
  llmTags: readonly IndustryTag[],
  skills: readonly string[]
): IndustryTag[] {
  const norm = Array.isArray(skills)
    ? skills.filter((s): s is string => typeof s === "string").map((s) => s.toLowerCase())
    : []
  const seen = new Set<IndustryTag>()
  const result: IndustryTag[] = []
  // Preserve LLM-emitted tags except "other" (we re-add at the end if empty).
  for (const t of llmTags) {
    if (t === "other") continue
    if (!seen.has(t)) {
      seen.add(t)
      result.push(t)
    }
  }
  // Tech-skill fallback.
  if (norm.some((s) => TECH_TOKENS.some((tok) => s.includes(tok)))) {
    if (!seen.has("tech_software")) {
      seen.add("tech_software")
      result.push("tech_software")
    }
  }
  // AI-skill fallback.
  if (norm.some((s) => AI_TOKENS.some((tok) => s.includes(tok)))) {
    if (!seen.has("ai_ml")) {
      seen.add("ai_ml")
      result.push("ai_ml")
    }
  }
  if (result.length === 0) return ["other"]
  // Honor StructuredCv contract (≤3 tags).
  return result.slice(0, 3)
}

/**
 * Render the user's industryTags into a 1-line block for system prompt
 * injection. Used by Stream D's appendCvContextToSystemPrompt extension.
 */
export function renderIndustryTagsLine(tags: readonly IndustryTag[]): string | null {
  if (!Array.isArray(tags) || tags.length === 0) return null
  const seen = new Set<IndustryTag>()
  const ordered: IndustryTag[] = []
  for (const t of tags) {
    if (INDUSTRY_TAGS.includes(t) && !seen.has(t)) {
      seen.add(t)
      ordered.push(t)
    }
  }
  if (ordered.length === 0) return null
  const parts = ordered.map((t) => `${t} (${INDUSTRY_LABELS[t].en})`)
  return `Industry tags (top guesses from CV experiences): ${parts.join(", ")}`
}
