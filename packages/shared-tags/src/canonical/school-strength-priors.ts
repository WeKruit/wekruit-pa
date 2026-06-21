/**
 * Role-aware US target-school strength priors (generated 2026-06-15; widened pass).
 *
 * WHY: school prestige is RELATIVE TO THE ROLE — a school elite for CS may be average for
 * design, and vice-versa. This gives the candidate evaluator a deterministic, role-scoped
 * prior so school strength is not an LLM prestige-guess. The lists are intentionally WIDE
 * (a long tier_3 "recognized" tail + a broad general_top_us fallback) so that almost any
 * real US 4-year school resolves to at least "recognized" rather than "unknown".
 *
 * STRICTLY ADVISORY. school strength is NEVER a hard filter, NEVER a standalone reject
 * reason, and a not-found / "unknown" result is NEVER surfaced as a negative — it only
 * suppresses the positive note and defers to the LLM. Feed lookupSchoolPrior() to the LLM
 * judge as a soft prior; the LLM keeps final judgment.
 *
 * Tiers per lens: tier_1 = elite/top target, tier_2 = strong/well-recruited, tier_3 = solid
 * recognized tail. Counts (t1/t2/t3): engineering_cs: 12/23/50  design: 9/18/44  go_to_market: 11/26/52  marketing: 9/18/51  product_management: 11/22/88  data_ml: 9/18/39  finance_consulting: 10/15/47  general_top_us: 12/22/147  ·  total entries: 763
 */
import type { RoleFunction } from "./role-function.js"

export type SchoolLens =
  | "engineering_cs" | "design" | "go_to_market" | "marketing"
  | "product_management" | "data_ml" | "finance_consulting" | "general_top_us"
export type SchoolTier = "tier_1" | "tier_2" | "tier_3"
/** strong = tier_1/tier_2 · recognized = tier_3 · unknown = not found (defer to LLM, NOT a negative). */
export type SchoolStrength = "strong" | "recognized" | "unknown"
export interface SchoolEntry { canonical: string; aliases: string[]; program?: string; note?: string }

/** Every canonical roleFunction token maps to exactly one school lens (general_top_us = fallback). */
export const ROLE_FUNCTION_TO_LENS: Record<RoleFunction, SchoolLens> = {
  "software_engineering": "engineering_cs",
  "engineering_and_development": "engineering_cs",
  "data_analysis": "data_ml",
  "business_analyst": "finance_consulting",
  "product_management": "product_management",
  "creatives_and_design": "design",
  "arts_and_entertainment": "general_top_us",
  "consultant": "finance_consulting",
  "accounting_and_finance": "finance_consulting",
  "marketing": "marketing",
  "sales": "go_to_market",
  "customer_service_and_support": "go_to_market",
  "management_and_executive": "general_top_us",
  "human_resources": "general_top_us",
  "legal_and_compliance": "general_top_us",
  "education_and_training": "general_top_us",
  "public_sector_and_government": "general_top_us"
}

export const SCHOOL_TIERS: Record<SchoolLens, Record<SchoolTier, SchoolEntry[]>> = {
  "engineering_cs": {
    "tier_1": [
      {
        "canonical": "California Institute of Technology",
        "aliases": [
          "CIT",
          "Caltech"
        ],
        "note": "Tiny but elite CS/EE/CS-theory; strong quant/HFT and deep-tech pull. Low volume, very high signal."
      },
      {
        "canonical": "Carnegie Mellon University",
        "aliases": [
          "C.M.U.",
          "CMU",
          "Carnegie Mellon",
          "Tepper"
        ],
        "program": "School of Computer Science (SCS)",
        "note": "Perennial top-1/2 CS program; cornerstone long-distance pipeline into FAANG (per-capita rate into Meta ~2x Georgia Tech). Universal SWE target."
      },
      {
        "canonical": "Cornell University",
        "aliases": [
          "Cornell",
          "Cornell Dyson",
          "Dyson",
          "Johnson",
          "SC Johnson"
        ],
        "program": "Bowers CIS / College of Engineering",
        "note": "Top-tier CS, high tech-hire volume; Ivy brand plus genuine SWE pipeline."
      },
      {
        "canonical": "Georgia Institute of Technology",
        "aliases": [
          "GT",
          "GaTech",
          "Georgia Tech",
          "Georgia Tech (GA Tech)"
        ],
        "program": "College of Computing",
        "note": "Top CS/engineering feeder with exceptional ROI; strong in software, cybersecurity, systems."
      },
      {
        "canonical": "Massachusetts Institute of Technology",
        "aliases": [
          "M.I.T.",
          "MIT",
          "MIT Sloan",
          "Sloan"
        ],
        "program": "EECS (Course 6)",
        "note": "Top-4 CS/EECS; elite for SWE, hardware/EE, and quant/HFT recruiting."
      },
      {
        "canonical": "Princeton University",
        "aliases": [
          "Princeton"
        ],
        "note": "Elite CS theory/systems; especially strong quant/HFT and elite-startup pull. Lower raw SWE volume, very high signal."
      },
      {
        "canonical": "Stanford University",
        "aliases": [
          "Stanford",
          "Stanford Univ"
        ],
        "note": "Undisputed Silicon Valley feeder; top-4 CS. Center of AI/ML recruiting alongside Berkeley."
      },
      {
        "canonical": "The University of Texas at Austin",
        "aliases": [
          "Texas",
          "UT",
          "UT Austin",
          "UT-Austin",
          "UTexas",
          "University of Texas at Austin"
        ],
        "program": "Department of Computer Science",
        "note": "Top-7 CS program; major SWE feeder, strongest tech anchor in Texas."
      },
      {
        "canonical": "University of California, Berkeley",
        "aliases": [
          "Berkeley",
          "Cal",
          "Haas",
          "UC Berkeley",
          "UC-Berkeley",
          "UCB",
          "University of California-Berkeley"
        ],
        "program": "EECS / EECS+CS (L&S)",
        "note": "#1 by raw placement volume into 15 major tech firms; top-4 CS and a primary Google/Meta/Apple feeder."
      },
      {
        "canonical": "University of Illinois Urbana-Champaign",
        "aliases": [
          "Gies",
          "Illinois",
          "Illinois Urbana-Champaign",
          "U of I",
          "UIUC",
          "University of Illinois",
          "University of Illinois at Urbana-Champaign"
        ],
        "program": "Grainger / Siebel School of Computing & Data Science",
        "note": "#2 by tech-hire volume; elite CS and a top public SWE feeder despite lower overall-prestige perception."
      },
      {
        "canonical": "University of Michigan",
        "aliases": [
          "Michigan",
          "Michigan Ann Arbor",
          "Michigan Ross",
          "Ross",
          "U Michigan",
          "U of M",
          "U-M",
          "UMich",
          "University of Michigan Ann Arbor",
          "University of Michigan-Ann Arbor"
        ],
        "program": "College of Engineering / CSE (EECS)",
        "note": "#3 by tech-hire volume; top public engineering+CS feeder."
      },
      {
        "canonical": "University of Washington",
        "aliases": [
          "Foster",
          "U Dub",
          "U Washington",
          "U-Dub",
          "UDub",
          "UW",
          "UW Seattle",
          "University of Washington Seattle",
          "University of Washington-Seattle",
          "Washington"
        ],
        "program": "Paul G. Allen School of Computer Science & Engineering",
        "note": "Top-tier CS (Allen School); 100+ companies at CSE career fairs; major Microsoft/Amazon/Google feeder."
      }
    ],
    "tier_2": [
      {
        "canonical": "Boston University",
        "aliases": [
          "BU",
          "Boston U",
          "Boston Univ",
          "Questrom"
        ],
        "program": "Department of Computer Science / College of Engineering",
        "note": "Strong CS+ENG brand in the Boston tech hub; solid SWE volume."
      },
      {
        "canonical": "California Polytechnic State University, San Luis Obispo",
        "aliases": [
          "CPSLO",
          "Cal Poly",
          "Cal Poly SLO",
          "Cal Poly San Luis Obispo",
          "California Polytechnic State University-San Luis Obispo"
        ],
        "program": "Computer Science & Software Engineering",
        "note": "Notable hands-on West-Coast SWE feeder; high tech-hire volume relative to size."
      },
      {
        "canonical": "Columbia University",
        "aliases": [
          "CU",
          "Columbia",
          "Columbia Univ"
        ],
        "program": "Fu Foundation School of Engineering / CS",
        "note": "Ivy brand, NYC tech + quant adjacency; solid SWE volume."
      },
      {
        "canonical": "Harvard University",
        "aliases": [
          "Harvard",
          "Harvard College",
          "Harvard Univ"
        ],
        "program": "SEAS / CS",
        "note": "Elite brand; strong startup and quant pull, more modest pure-SWE volume than the CS-flagship publics."
      },
      {
        "canonical": "New York University",
        "aliases": [
          "N.Y.U.",
          "NYU",
          "NYU Stern",
          "Stern"
        ],
        "program": "Courant Institute / Tandon School of Engineering",
        "note": "NYC tech + quant adjacency (Courant); good SWE volume."
      },
      {
        "canonical": "Northeastern University",
        "aliases": [
          "D'Amore-McKim",
          "NEU",
          "NU Boston",
          "Northeastern"
        ],
        "program": "Khoury College of Computer Sciences",
        "note": "Co-op program drives strong industry placement; high tech-hire volume."
      },
      {
        "canonical": "Purdue University",
        "aliases": [
          "Daniels",
          "Daniels School of Business",
          "Krannert",
          "Mitch Daniels School",
          "Purdue",
          "Purdue West Lafayette"
        ],
        "program": "College of Engineering / CS",
        "note": "Large, well-recruited engineering+CS feeder."
      },
      {
        "canonical": "Rensselaer Polytechnic Institute",
        "aliases": [
          "RPI",
          "Rensselaer",
          "Rensselaer Poly",
          "Rensselaer Polytechnic"
        ],
        "program": "Department of Computer Science",
        "note": "Historic tech institute with strong systems/graphics CS; recognized national SWE feeder."
      },
      {
        "canonical": "Rutgers University",
        "aliases": [
          "RU",
          "Rutgers",
          "Rutgers Business School",
          "Rutgers New Brunswick",
          "Rutgers University-New Brunswick",
          "Rutgers — New Brunswick",
          "Rutgers-New Brunswick"
        ],
        "program": "Department of Computer Science",
        "note": "Large, well-recruited public CS in the NYC/NJ tech corridor; solid SWE and quant-adjacent feeder."
      },
      {
        "canonical": "Santa Clara University",
        "aliases": [
          "Leavey",
          "SCU",
          "Santa Clara"
        ],
        "program": "Department of Computer Science & Engineering",
        "note": "Heart-of-Silicon-Valley location drives strong local big-tech placement; well-recognized SWE feeder."
      },
      {
        "canonical": "Stevens Institute of Technology",
        "aliases": [
          "SIT",
          "Stevens",
          "Stevens Tech"
        ],
        "program": "Department of Computer Science",
        "note": "Tech-focused institute across from NYC; strong co-op/industry placement into finance-tech and SWE."
      },
      {
        "canonical": "University of California, Irvine",
        "aliases": [
          "Irvine",
          "UC Irvine",
          "UC-Irvine",
          "UCI",
          "University of California-Irvine"
        ],
        "program": "Donald Bren School of ICS",
        "note": "Dedicated computing school; solid SoCal tech feeder."
      },
      {
        "canonical": "University of California, Los Angeles",
        "aliases": [
          "Anderson",
          "U.C.L.A.",
          "UC Los Angeles",
          "UC-LA",
          "UCLA",
          "University of California-Los Angeles"
        ],
        "program": "Samueli / CS",
        "note": "Top public CS with high tech-hire volume."
      },
      {
        "canonical": "University of California, San Diego",
        "aliases": [
          "UC San Diego",
          "UC-San Diego",
          "UCSD",
          "University of California-San Diego"
        ],
        "program": "Jacobs School of Engineering / CSE",
        "note": "Very high tech-hire volume; strong systems/CSE feeder."
      },
      {
        "canonical": "University of Maryland, College Park",
        "aliases": [
          "Maryland",
          "Smith",
          "U Maryland",
          "UMCP",
          "UMD",
          "UMD College Park",
          "University of Maryland",
          "University of Maryland-College Park"
        ],
        "program": "Department of Computer Science",
        "note": "Top-20 CS grad program; strong DC-corridor and big-tech feeder."
      },
      {
        "canonical": "University of Massachusetts Amherst",
        "aliases": [
          "Isenberg",
          "Massachusetts Amherst",
          "U Mass",
          "UMass",
          "UMass Amherst",
          "UMass-Amherst",
          "University of Massachusetts",
          "University of Massachusetts-Amherst"
        ],
        "program": "Manning College of Information & Computer Sciences (CICS)",
        "note": "Top-30 CS, #1 public in the Northeast; solid SWE feeder."
      },
      {
        "canonical": "University of Pennsylvania",
        "aliases": [
          "Annenberg",
          "Penn",
          "U Penn",
          "U. Penn",
          "UPenn",
          "Wharton",
          "Wharton School"
        ],
        "program": "CIS / School of Engineering & Applied Science",
        "note": "Ivy brand; M&T / CIS pipeline into SWE and quant."
      },
      {
        "canonical": "University of Pittsburgh",
        "aliases": [
          "College of Business Administration",
          "Katz",
          "Pitt",
          "Pittsburgh",
          "U Pitt",
          "U Pittsburgh",
          "UPitt",
          "University of Pittsburgh Pittsburgh"
        ],
        "program": "Department of Computer Science / SCI",
        "note": "Strong CS in a top tech-research city (CMU adjacency); good regional SWE feeder."
      },
      {
        "canonical": "University of Southern California",
        "aliases": [
          "Annenberg",
          "Leventhal",
          "Marshall",
          "Southern Cal",
          "Southern California",
          "U.S.C.",
          "USC",
          "USC Leventhal",
          "USC Marshall"
        ],
        "program": "Viterbi School of Engineering",
        "note": "High volume into SoCal/Bay tech; strong CS/EE pipeline."
      },
      {
        "canonical": "University of Texas at Dallas",
        "aliases": [
          "Naveen Jindal",
          "UT Dallas",
          "UT-Dallas",
          "UTD",
          "University of Texas-Dallas"
        ],
        "program": "Department of Computer Science",
        "note": "Large CS program; strong Texas tech feeder (secondary to UT Austin)."
      },
      {
        "canonical": "University of Waterloo",
        "aliases": [
          "U Waterloo",
          "UW Waterloo",
          "UWaterloo",
          "Waterloo"
        ],
        "note": "CANADIAN — listed per US-centric exception. The single most heavily US-recruited non-US SWE feeder; its co-op pipeline makes US big-tech treat it as a domestic-equivalent target."
      },
      {
        "canonical": "University of Wisconsin–Madison",
        "aliases": [
          "Madison",
          "U Wisconsin",
          "UW Madison",
          "UW-Madison",
          "UWisc",
          "University of Wisconsin",
          "University of Wisconsin Madison",
          "University of Wisconsin-Madison",
          "Wisconsin",
          "Wisconsin School of Business",
          "Wisconsin-Madison"
        ],
        "program": "Department of Computer Sciences",
        "note": "Strong CS systems/DB heritage; solid tech feeder."
      },
      {
        "canonical": "Worcester Polytechnic Institute",
        "aliases": [
          "WPI",
          "Worcester Poly",
          "Worcester Polytechnic"
        ],
        "program": "Department of Computer Science",
        "note": "Project-based tech institute in the Boston metro; strong applied SWE/robotics placement."
      }
    ],
    "tier_3": [
      {
        "canonical": "Arizona State University",
        "aliases": [
          "ASU",
          "Arizona State",
          "Cronkite",
          "W. P. Carey",
          "W.P. Carey",
          "WP Carey"
        ],
        "note": "Very large CS pipeline (Ira Fulton); positive signal at scale."
      },
      {
        "canonical": "Auburn University",
        "aliases": [
          "AU",
          "Auburn",
          "Auburn Univ",
          "Harbert"
        ],
        "program": "Department of Computer Science & Software Engineering",
        "note": "Large engineering+CS program; positive Southeast signal."
      },
      {
        "canonical": "Binghamton University",
        "aliases": [
          "BU SUNY",
          "Binghamton",
          "SUNY Binghamton",
          "State University of New York at Binghamton"
        ],
        "program": "Department of Computer Science",
        "note": "Selective public (SUNY) CS in NY metro reach; positive signal."
      },
      {
        "canonical": "Brown University",
        "aliases": [
          "Brown"
        ],
        "note": "Respected CS; Ivy brand, solid SWE/startup pull."
      },
      {
        "canonical": "California State Polytechnic University, Pomona",
        "aliases": [
          "CPP",
          "Cal Poly Pomona",
          "Cal Poly-Pomona"
        ],
        "program": "Department of Computer Science",
        "note": "Hands-on polytechnic CS in SoCal; recognized applied-SWE feeder."
      },
      {
        "canonical": "California State University, Long Beach",
        "aliases": [
          "CSU Long Beach",
          "CSULB",
          "Cal State Long Beach",
          "Long Beach State"
        ],
        "program": "Department of Computer Engineering & Computer Science",
        "note": "High-volume SoCal CS feeder; recruiters recognize it for SWE."
      },
      {
        "canonical": "Case Western Reserve University",
        "aliases": [
          "CWRU",
          "Case",
          "Case Western",
          "Weatherhead"
        ],
        "program": "Department of Computer & Data Sciences",
        "note": "Strong private research CS+ENG; recognized national signal, moderate volume."
      },
      {
        "canonical": "Clemson University",
        "aliases": [
          "CU",
          "Clemson"
        ],
        "program": "School of Computing",
        "note": "Strong engineering+CS land-grant; recognized Southeast tech feeder."
      },
      {
        "canonical": "Colorado School of Mines",
        "aliases": [
          "CSM",
          "Colorado Mines",
          "Mines",
          "School of Mines"
        ],
        "program": "Department of Computer Science",
        "note": "Selective engineering/applied-science institute; strong per-capita placement in systems/CS."
      },
      {
        "canonical": "Drexel University",
        "aliases": [
          "Drexel",
          "LeBow",
          "LeBow College of Business"
        ],
        "program": "College of Computing & Informatics",
        "note": "Co-op-driven CS in Philadelphia; strong industry placement for its size."
      },
      {
        "canonical": "Duke University",
        "aliases": [
          "Duke"
        ],
        "note": "Strong CS within an elite brand; moderate SWE volume."
      },
      {
        "canonical": "Florida State University",
        "aliases": [
          "FL State",
          "FSU",
          "Florida St",
          "Florida State",
          "Seminoles"
        ],
        "program": "Department of Computer Science",
        "note": "State flagship CS; positive Southeast signal."
      },
      {
        "canonical": "Illinois Institute of Technology",
        "aliases": [
          "IIT",
          "Illinois Institute",
          "Illinois Tech",
          "Stuart School of Business"
        ],
        "program": "Department of Computer Science",
        "note": "Tech-focused institute in Chicago; recognized regional SWE feeder."
      },
      {
        "canonical": "Indiana University Bloomington",
        "aliases": [
          "IU",
          "IU Bloomington",
          "Indiana",
          "Indiana Bloomington",
          "Indiana University",
          "Kelley",
          "Kelley School of Business"
        ],
        "program": "Luddy School of Informatics, Computing & Engineering",
        "note": "Dedicated computing/informatics school; recognized Midwest tech feeder."
      },
      {
        "canonical": "Iowa State University",
        "aliases": [
          "ISU",
          "ISU Ames",
          "Iowa St",
          "Iowa State",
          "Iowa State Univ",
          "Iowa State University of Science and Technology",
          "Ivy College of Business"
        ],
        "program": "Department of Computer Science",
        "note": "Large land-grant engineering+CS feeder; positive Midwest signal."
      },
      {
        "canonical": "Michigan State University",
        "aliases": [
          "Broad",
          "Eli Broad",
          "MSU",
          "Mich State",
          "Michigan St",
          "Michigan State"
        ],
        "program": "Department of Computer Science & Engineering",
        "note": "Large Big Ten engineering+CS program; solid Midwest tech feeder."
      },
      {
        "canonical": "Missouri University of Science and Technology",
        "aliases": [
          "Missouri S&T",
          "Missouri ST",
          "Missouri Science and Technology",
          "Rolla"
        ],
        "program": "Department of Computer Science",
        "note": "Tech-focused public institute; strong engineering+CS placement for its size."
      },
      {
        "canonical": "New Jersey Institute of Technology",
        "aliases": [
          "NJIT",
          "New Jersey Tech"
        ],
        "program": "Ying Wu College of Computing",
        "note": "Tech-focused institute in the NYC/NJ corridor; recognized applied-CS feeder."
      },
      {
        "canonical": "North Carolina State University",
        "aliases": [
          "N.C. State",
          "NC State",
          "NC State University",
          "NCSU",
          "North Carolina State",
          "Poole"
        ],
        "note": "Large engineering+CS; Research Triangle tech feeder."
      },
      {
        "canonical": "Oregon State University",
        "aliases": [
          "OSU",
          "OSU Corvallis",
          "Oregon St",
          "Oregon State",
          "OregonState"
        ],
        "program": "School of EECS",
        "note": "Large engineering+CS program; Pacific NW tech feeder."
      },
      {
        "canonical": "Pennsylvania State University",
        "aliases": [
          "PSU",
          "Penn St",
          "Penn State",
          "Penn State Smeal",
          "Penn State University",
          "Penn State University Park",
          "Pennsylvania State",
          "Smeal"
        ],
        "note": "Large engineering+CS feeder; positive signal."
      },
      {
        "canonical": "Rice University",
        "aliases": [
          "Rice"
        ],
        "note": "Selective CS; strong per-capita placement, lower raw volume."
      },
      {
        "canonical": "Rochester Institute of Technology",
        "aliases": [
          "RIT",
          "Rochester Institute",
          "Saunders"
        ],
        "note": "Co-op-heavy applied CS/SE; high tech-hire volume for its size."
      },
      {
        "canonical": "San Diego State University",
        "aliases": [
          "Aztecs",
          "Fowler",
          "SD State",
          "SDSU",
          "San Diego State"
        ],
        "program": "Department of Computer Science",
        "note": "Large SoCal CS pipeline; recognized regional SWE feeder."
      },
      {
        "canonical": "San Jose State University",
        "aliases": [
          "SJ State",
          "SJSU",
          "San Jose State",
          "San José State University"
        ],
        "note": "Highest-volume Silicon Valley local feeder; recruiters know it well for SWE."
      },
      {
        "canonical": "Stony Brook University",
        "aliases": [
          "SBU",
          "SUNY Stony Brook",
          "State University of New York at Stony Brook",
          "Stony Brook"
        ],
        "note": "Strong public CS in NY metro; positive signal."
      },
      {
        "canonical": "Texas A&M University",
        "aliases": [
          "A&M",
          "Aggies",
          "Mays",
          "Mays Business School",
          "TAMU",
          "Texas A&M",
          "Texas A&M University-College Station"
        ],
        "note": "Large engineering+CS program; Texas tech feeder."
      },
      {
        "canonical": "The Ohio State University",
        "aliases": [
          "OSU",
          "Ohio St",
          "Ohio State",
          "Ohio State University",
          "tOSU"
        ],
        "note": "Large state flagship; solid Midwest tech feeder."
      },
      {
        "canonical": "University at Buffalo",
        "aliases": [
          "Buffalo",
          "SUNY Buffalo",
          "State University of New York at Buffalo",
          "UB",
          "University at Buffalo SUNY"
        ],
        "program": "Department of Computer Science & Engineering",
        "note": "Large public CSE program in NY; recognized regional feeder."
      },
      {
        "canonical": "University of Arizona",
        "aliases": [
          "Arizona",
          "Eller",
          "U Arizona",
          "U of A",
          "UA",
          "UA Tucson",
          "UArizona"
        ],
        "program": "Department of Computer Science",
        "note": "Large state flagship CS; positive signal at scale in the Southwest."
      },
      {
        "canonical": "University of California, Davis",
        "aliases": [
          "Davis",
          "UC Davis",
          "UC-Davis",
          "UCD",
          "University of California-Davis"
        ],
        "note": "Solid UC CS feeder into Bay-area tech."
      },
      {
        "canonical": "University of California, Santa Barbara",
        "aliases": [
          "Santa Barbara",
          "UC Santa Barbara",
          "UC-Santa Barbara",
          "UCSB",
          "University of California-Santa Barbara"
        ],
        "note": "Respected CS (strong systems/graphics); positive signal."
      },
      {
        "canonical": "University of California, Santa Cruz",
        "aliases": [
          "Santa Cruz",
          "UC Santa Cruz",
          "UCSC",
          "University of California-Santa Cruz"
        ],
        "note": "Solid UC CS (games/graphics strength); positive signal."
      },
      {
        "canonical": "University of Central Florida",
        "aliases": [
          "Central Florida",
          "U Central Florida",
          "UCF"
        ],
        "program": "Department of Computer Science",
        "note": "One of the largest CS pipelines in the US; recognized at scale, strong Florida tech feeder."
      },
      {
        "canonical": "University of Colorado Boulder",
        "aliases": [
          "Boulder",
          "CU",
          "CU Boulder",
          "CU-Boulder",
          "Colorado",
          "Colorado Boulder",
          "Leeds",
          "Leeds School of Business",
          "UC Boulder",
          "University of Colorado",
          "University of Colorado-Boulder"
        ],
        "note": "Solid CS+engineering; Front Range tech feeder."
      },
      {
        "canonical": "University of Florida",
        "aliases": [
          "Florida",
          "Gainesville",
          "Gators",
          "U of Florida",
          "UF",
          "UFlorida",
          "Univ of Florida",
          "Warrington"
        ],
        "note": "Large engineering+CS flagship; regional tech feeder."
      },
      {
        "canonical": "University of Georgia",
        "aliases": [
          "Georgia",
          "Grady",
          "Terry",
          "U Georgia",
          "UGA"
        ],
        "program": "School of Computing",
        "note": "State flagship CS; recognized Southeast tech feeder."
      },
      {
        "canonical": "University of Houston",
        "aliases": [
          "Bauer",
          "C. T. Bauer",
          "Houston",
          "U Houston",
          "U of H",
          "UH"
        ],
        "program": "Department of Computer Science",
        "note": "Large urban CS program; solid Texas tech feeder."
      },
      {
        "canonical": "University of Iowa",
        "aliases": [
          "Hawkeyes",
          "Iowa",
          "The University of Iowa",
          "Tippie",
          "Tippie College of Business",
          "U Iowa",
          "U of Iowa",
          "UIowa"
        ],
        "program": "Department of Computer Science",
        "note": "State flagship CS program; positive regional signal."
      },
      {
        "canonical": "University of Kansas",
        "aliases": [
          "Jayhawks",
          "KU",
          "Kansas",
          "U Kansas",
          "U of Kansas",
          "University of Kansas Lawrence",
          "William Allen White School"
        ],
        "program": "Department of EECS",
        "note": "State flagship engineering+CS; recognized regional feeder."
      },
      {
        "canonical": "University of Maryland, Baltimore County",
        "aliases": [
          "Maryland Baltimore County",
          "UMBC",
          "University of Maryland Baltimore County"
        ],
        "note": "Strong applied CS/cyber feeder in the DC corridor."
      },
      {
        "canonical": "University of Minnesota Twin Cities",
        "aliases": [
          "Carlson",
          "Carlson School of Management",
          "Minnesota",
          "Minnesota Twin Cities",
          "U of M",
          "UMN",
          "University of Minnesota",
          "University of Minnesota, Twin Cities",
          "University of Minnesota-Twin Cities"
        ],
        "note": "Solid Midwest CS/engineering feeder."
      },
      {
        "canonical": "University of Nebraska-Lincoln",
        "aliases": [
          "Cornhuskers",
          "Husker",
          "Huskers",
          "Nebraska",
          "Nebraska Lincoln",
          "Nebraska-Lincoln",
          "UNL",
          "University of Nebraska",
          "University of Nebraska–Lincoln"
        ],
        "program": "School of Computing",
        "note": "State flagship engineering+CS; recognized regional feeder."
      },
      {
        "canonical": "University of Oregon",
        "aliases": [
          "Lundquist",
          "Oregon",
          "SOJC",
          "U Oregon",
          "U of O",
          "UO"
        ],
        "program": "Department of Computer Science",
        "note": "Solid CS in the Pacific NW; positive regional signal."
      },
      {
        "canonical": "University of South Carolina",
        "aliases": [
          "Darla Moore",
          "Darla Moore School",
          "Gamecocks",
          "Moore School",
          "South Carolina",
          "USC Columbia",
          "USCarolina",
          "UofSC"
        ],
        "program": "Department of Computer Science & Engineering",
        "note": "State flagship CS+ENG; recognized regional feeder."
      },
      {
        "canonical": "University of Tennessee",
        "aliases": [
          "Haslam",
          "Rocky Top",
          "Tennessee",
          "U Tennessee",
          "UT Knoxville",
          "UTK",
          "University of Tennessee Knoxville",
          "University of Tennessee-Knoxville",
          "Vols"
        ],
        "program": "Min H. Kao Department of EECS",
        "note": "State flagship engineering+CS (Oak Ridge adjacency); positive Southeast signal."
      },
      {
        "canonical": "University of Utah",
        "aliases": [
          "David Eccles",
          "Eccles",
          "The U",
          "The University of Utah",
          "U Utah",
          "U of U",
          "UU",
          "University of Utah Salt Lake",
          "UofU",
          "Utah",
          "Utah Salt Lake"
        ],
        "program": "Kahlert School of Computing",
        "note": "Strong graphics/systems CS heritage; Silicon Slopes tech feeder."
      },
      {
        "canonical": "University of Virginia",
        "aliases": [
          "McIntire",
          "U Va",
          "U-Va",
          "U.Va.",
          "UVA",
          "University of Virginia Charlottesville",
          "Virginia"
        ],
        "note": "Strong engineering+CS; DC-corridor feeder."
      },
      {
        "canonical": "Virginia Tech",
        "aliases": [
          "Pamplin",
          "VPI",
          "VT",
          "Virginia Polytechnic",
          "Virginia Polytechnic Institute and State University",
          "Virginia Tech University"
        ],
        "note": "Large engineering+CS program; solid regional/DC tech feeder."
      },
      {
        "canonical": "Washington State University",
        "aliases": [
          "Carson",
          "Cougars",
          "Edward R. Murrow College",
          "Murrow",
          "WSU",
          "Washington State",
          "Wazzu"
        ],
        "program": "School of EECS",
        "note": "Land-grant engineering+CS; recognized Pacific NW regional feeder."
      }
    ]
  },
  "design": {
    "tier_1": [
      {
        "canonical": "ArtCenter College of Design",
        "aliases": [
          "ACCD",
          "Art Center",
          "Art Center College of Design",
          "ArtCenter"
        ],
        "note": "Top industrial/product/transportation design feeder; deep automotive, consumer-electronics, and entertainment hiring pipeline (Apple, BMW, Tesla, Nike). Also strong interaction design MDes."
      },
      {
        "canonical": "California College of the Arts",
        "aliases": [
          "CCA",
          "California College of Arts",
          "California College of Arts and Crafts"
        ],
        "note": "Top SF Bay Area design school (interaction, industrial, graphic/comm design); strong Bay Area tech UX/product-design feeder."
      },
      {
        "canonical": "Carnegie Mellon University",
        "aliases": [
          "C.M.U.",
          "CMU",
          "Carnegie Mellon",
          "Tepper"
        ],
        "program": "School of Design + Human-Computer Interaction Institute (HCII / MHCI / MDes)",
        "note": "#1 undergrad UX/UI/HCI and a top graduate HCI program; HCII + School of Design are the premier interaction/UX feeder into Apple, Google, Microsoft, NVIDIA, IDEO. The one school elite for BOTH CS and design."
      },
      {
        "canonical": "Parsons School of Design",
        "aliases": [
          "Parsons",
          "Parsons The New School for Design",
          "The New School — Parsons"
        ],
        "program": "Design & Technology MFA / Communication Design (Digital Product Design)",
        "note": "Top-ranked design school (QS); NYC product/visual/digital-product feeder. Strong for UX, communication, and digital product design."
      },
      {
        "canonical": "Pratt Institute",
        "aliases": [
          "Pratt"
        ],
        "note": "Top-tier NYC industrial design, communication design, and digital/UX programs; rigorous studio craft and strong NYC design-community placement."
      },
      {
        "canonical": "Rhode Island School of Design",
        "aliases": [
          "RISD"
        ],
        "note": "Perennial #1 art-and-design school; gold-standard portfolio/craft signal. Top feeder for industrial/product design and visual design (Apple, Nike, consumer hardware). Invisible on CS rankings — pure design prestige."
      },
      {
        "canonical": "School of Visual Arts",
        "aliases": [
          "SVA",
          "School of Visual Arts NYC"
        ],
        "program": "MFA Interaction Design / Products of Design / Design",
        "note": "Top NYC art-and-design school; strong interaction, communication, and product design pipeline. Elite for design, absent from CS lists."
      },
      {
        "canonical": "Stanford University",
        "aliases": [
          "Stanford",
          "Stanford Univ"
        ],
        "program": "Hasso Plattner Institute of Design (d.school) / Design program",
        "note": "Elite for design thinking and product design leadership; strong big-tech UX/product-design placement. Earns the tier via the d.school, not generic prestige."
      },
      {
        "canonical": "University of Washington",
        "aliases": [
          "Foster",
          "U Dub",
          "U Washington",
          "U-Dub",
          "UDub",
          "UW",
          "UW Seattle",
          "University of Washington Seattle",
          "University of Washington-Seattle",
          "Washington"
        ],
        "program": "Human Centered Design & Engineering (HCDE) + MHCI+D",
        "note": "#1 graduate UX/UI/HCI program; dominant Pacific-NW UX feeder into Microsoft, Amazon, Google, Adobe, Apple."
      }
    ],
    "tier_2": [
      {
        "canonical": "Cornell University",
        "aliases": [
          "Cornell",
          "Cornell Dyson",
          "Dyson",
          "Johnson",
          "SC Johnson"
        ],
        "program": "Information Science (HCI) / Design + Environmental Analysis",
        "note": "Strong Information Science HCI track; recruited for UX research/design at major tech firms."
      },
      {
        "canonical": "Drexel University",
        "aliases": [
          "Drexel",
          "LeBow",
          "LeBow College of Business"
        ],
        "program": "Westphal College — UX & Interaction Design / Graphic Design",
        "note": "Co-op-driven UX/graphic design program with strong industry placement."
      },
      {
        "canonical": "Georgia Institute of Technology",
        "aliases": [
          "GT",
          "GaTech",
          "Georgia Tech",
          "Georgia Tech (GA Tech)"
        ],
        "program": "MS in Human-Computer Interaction (MS-HCI)",
        "note": "Top public HCI program (Interactive Computing + Industrial Design + LMC + Psychology); strong UX research/design hiring."
      },
      {
        "canonical": "Maryland Institute College of Art",
        "aliases": [
          "MICA",
          "Maryland Institute College of Art (MICA)"
        ],
        "note": "Top art-and-design school for graphic/communication and UX design; AIGA-decorated faculty, strong brand/visual-design placement."
      },
      {
        "canonical": "Massachusetts Institute of Technology",
        "aliases": [
          "M.I.T.",
          "MIT",
          "MIT Sloan",
          "Sloan"
        ],
        "program": "MIT Media Lab",
        "note": "Earns a design tier ONLY via the Media Lab (interaction/research/speculative design), not via core EECS. Different signal than its CS-tier-1 status."
      },
      {
        "canonical": "North Carolina State University",
        "aliases": [
          "N.C. State",
          "NC State",
          "NC State University",
          "NCSU",
          "North Carolina State",
          "Poole"
        ],
        "program": "College of Design — Industrial Design / Graphic & Experience Design",
        "note": "Top public design college (industrial, graphic, experience design); research-driven program with strong Research-Triangle and national design placement."
      },
      {
        "canonical": "Northeastern University",
        "aliases": [
          "D'Amore-McKim",
          "NEU",
          "NU Boston",
          "Northeastern"
        ],
        "program": "Art + Design — Experience Design / co-op",
        "note": "Co-op model drives strong UX/experience-design placement into Boston and national tech."
      },
      {
        "canonical": "Ringling College of Art and Design",
        "aliases": [
          "Ringling",
          "Ringling College",
          "Ringling College of Art & Design"
        ],
        "program": "Graphic Design / Motion Design / Game Art / User Experience Design",
        "note": "Premier illustration, motion, and game-art feeder (top pipeline into animation/entertainment studios and consumer product design); strong craft signal, absent from CS lists."
      },
      {
        "canonical": "Savannah College of Art and Design",
        "aliases": [
          "SCAD",
          "Savannah College of Art & Design"
        ],
        "note": "Large, well-recruited art-and-design school; #3 undergrad UX/UI/HCI. SCADpro client work (Google, BMW, Delta) and broad UX/graphic/industrial placement."
      },
      {
        "canonical": "School of the Art Institute of Chicago",
        "aliases": [
          "Art Institute of Chicago — School",
          "SAIC",
          "School of the Art Institute"
        ],
        "note": "Top art-and-design school; strong for visual/communication and interaction design in the Midwest design market."
      },
      {
        "canonical": "Syracuse University",
        "aliases": [
          "Cuse",
          "Newhouse",
          "SU",
          "Syracuse",
          "Syracuse Univ",
          "Whitman"
        ],
        "program": "College of Visual and Performing Arts (VPA) — Industrial & Interaction Design / Communications Design",
        "note": "Well-recruited industrial/interaction and communication-design programs; established VPA design pipeline into national consumer and tech firms."
      },
      {
        "canonical": "University of California, Berkeley",
        "aliases": [
          "Berkeley",
          "Cal",
          "Haas",
          "UC Berkeley",
          "UC-Berkeley",
          "UCB",
          "University of California-Berkeley"
        ],
        "program": "School of Information (MIMS) / DESIGN @ Berkeley",
        "note": "Strong UX research/design and information-school pipeline into Bay Area tech."
      },
      {
        "canonical": "University of California, San Diego",
        "aliases": [
          "UC San Diego",
          "UC-San Diego",
          "UCSD",
          "University of California-San Diego"
        ],
        "program": "Design Lab / Cognitive Science (HCI)",
        "note": "Strong cognitive-science + Design Lab HCI pipeline (Don Norman heritage); well-recruited for UX research/design."
      },
      {
        "canonical": "University of Cincinnati",
        "aliases": [
          "Cincinnati",
          "DAAP",
          "Lindner",
          "UC",
          "University of Cincinnati DAAP"
        ],
        "program": "College of Design, Architecture, Art and Planning (DAAP) — Industrial Design",
        "note": "Legendary mandatory co-op program; classic industrial/product-design feeder (LEGO, Nike, P&G, consumer hardware). Top ID pipeline despite no CS reputation."
      },
      {
        "canonical": "University of Maryland, College Park",
        "aliases": [
          "Maryland",
          "Smith",
          "U Maryland",
          "UMCP",
          "UMD",
          "UMD College Park",
          "University of Maryland",
          "University of Maryland-College Park"
        ],
        "program": "College of Information (iSchool) — HCI / HCIM",
        "note": "Established HCI lab (HCIL) and information-school UX pipeline."
      },
      {
        "canonical": "University of Michigan",
        "aliases": [
          "Michigan",
          "Michigan Ann Arbor",
          "Michigan Ross",
          "Ross",
          "U Michigan",
          "U of M",
          "U-M",
          "UMich",
          "University of Michigan Ann Arbor",
          "University of Michigan-Ann Arbor"
        ],
        "program": "School of Information (UMSI) — UX Research & Design",
        "note": "Top information-school UX pipeline; near-universal placement into Microsoft, Google, Meta, Amazon, IBM."
      },
      {
        "canonical": "University of Notre Dame",
        "aliases": [
          "Mendoza",
          "ND",
          "Notre Dame",
          "Notre Dame Mendoza",
          "Notre Dame du Lac",
          "Univ of Notre Dame"
        ],
        "program": "Department of Art, Art History & Design — Industrial Design / Visual Communication Design",
        "note": "Well-regarded industrial and visual-communication design program; strong-school brand plus solid design-studio craft and national placement."
      },
      {
        "canonical": "Virginia Commonwealth University",
        "aliases": [
          "VCU",
          "VCU Arts",
          "VCUarts",
          "Virginia Commonwealth"
        ],
        "program": "VCUarts — Graphic Design / Communication Arts / Product Innovation",
        "note": "#1 public art-and-design school (consistently top US art school overall); deep graphic/communication and product-design pipeline. Strong portfolio/craft signal distinct from any CS reputation."
      }
    ],
    "tier_3": [
      {
        "canonical": "Academy of Art University",
        "aliases": [
          "AAU",
          "Academy of Art",
          "Academy of Art College",
          "Academy of Art University San Francisco"
        ],
        "program": "School of Web Design & New Media / Industrial Design / Graphic Design",
        "note": "Large San Francisco art-and-design university; broad web/UX, graphic, and industrial design programs with Bay Area portfolio output."
      },
      {
        "canonical": "Arizona State University",
        "aliases": [
          "ASU",
          "Arizona State",
          "Cronkite",
          "W. P. Carey",
          "W.P. Carey",
          "WP Carey"
        ],
        "program": "Herberger Institute — Design / The Design School",
        "note": "Large, well-ranked UX/UI/HCI and design program; solid positive signal."
      },
      {
        "canonical": "Auburn University",
        "aliases": [
          "AU",
          "Auburn",
          "Auburn Univ",
          "Harbert"
        ],
        "program": "Industrial + Graphic Design / Human-Centered Design",
        "note": "Well-regarded public industrial and graphic design program in the School of Industrial + Graphic Design; solid Southeast placement."
      },
      {
        "canonical": "Brigham Young University",
        "aliases": [
          "BYU",
          "BYU Provo",
          "Brigham Young",
          "Marriott",
          "Marriott School"
        ],
        "program": "Graphic Design / UX",
        "note": "Well-regarded graphic and UX design program with a strong portfolio reputation and consistent tech-UX placement."
      },
      {
        "canonical": "Cleveland Institute of Art",
        "aliases": [
          "CIA Cleveland"
        ],
        "note": "Respected industrial/product and visual design school; solid ID pipeline."
      },
      {
        "canonical": "Columbia College Chicago",
        "aliases": [
          "CCC",
          "Columbia Chicago",
          "Columbia College Chicago (Columbia)"
        ],
        "program": "Design Department — Graphic / Interaction (UX) Design",
        "note": "Large Chicago creative-arts college; recognized graphic and interaction (UX) design programs with Midwest design-market placement."
      },
      {
        "canonical": "Columbus College of Art and Design",
        "aliases": [
          "CCAD",
          "Columbus College of Art & Design"
        ],
        "program": "Industrial Design / Interior Design / UX & Interaction Design",
        "note": "AICAD school with a strong industrial-design reputation; solid Midwest product/consumer-design pipeline."
      },
      {
        "canonical": "DePaul University",
        "aliases": [
          "DePaul",
          "Driehaus"
        ],
        "program": "Jarvis College — UX Design / HCI",
        "note": "Strong UX/UI/HCI program (top-10 undergrad); solid Chicago-market placement."
      },
      {
        "canonical": "Indiana University Bloomington",
        "aliases": [
          "IU",
          "IU Bloomington",
          "Indiana",
          "Indiana Bloomington",
          "Indiana University",
          "Kelley",
          "Kelley School of Business"
        ],
        "program": "Luddy School — HCI/d (Informatics)",
        "note": "Well-regarded HCI/design (HCI/d) master's program."
      },
      {
        "canonical": "Indiana University–Purdue University Indianapolis",
        "aliases": [
          "Herron",
          "Herron School of Art and Design",
          "IU Indianapolis",
          "IUPUI",
          "Indiana University Indianapolis"
        ],
        "program": "Herron School of Art and Design — Visual Communication / Industrial Design",
        "note": "Herron is a recognized visual-communication and industrial design program with solid Midwest placement."
      },
      {
        "canonical": "Iowa State University",
        "aliases": [
          "ISU",
          "ISU Ames",
          "Iowa St",
          "Iowa State",
          "Iowa State Univ",
          "Iowa State University of Science and Technology",
          "Ivy College of Business"
        ],
        "program": "College of Design — Graphic Design / Industrial Design / HCI",
        "note": "Large public design college with strong industrial, graphic, and HCI tracks; recognized Midwest design pipeline."
      },
      {
        "canonical": "Kansas City Art Institute",
        "aliases": [
          "KCAI",
          "Kansas City Art Institute (KCAI)"
        ],
        "program": "Graphic Design / Illustration / Product Design",
        "note": "Established AICAD school; recognized graphic, illustration, and product-design program with solid regional placement."
      },
      {
        "canonical": "Kent State University",
        "aliases": [
          "KSU Ohio",
          "Kent St",
          "Kent State"
        ],
        "program": "School of Visual Communication Design (VCD) / UX Design",
        "note": "Recognized visual-communication design (VCD) program with a dedicated UX track; solid Ohio/Midwest placement."
      },
      {
        "canonical": "Laguna College of Art and Design",
        "aliases": [
          "LCAD",
          "Laguna College of Art & Design",
          "Laguna College of Art and Design (LCAD)"
        ],
        "program": "Graphic Design + Digital Media / Game Art",
        "note": "SoCal AICAD school; recognized for graphic/digital-media and entertainment design with solid regional craft signal."
      },
      {
        "canonical": "Loyola Marymount University",
        "aliases": [
          "LMU",
          "Loyola Marymount",
          "Loyola Marymount Univ"
        ],
        "program": "Graphic Design / Interaction Design",
        "note": "Recognized LA graphic and interaction design program; solid SoCal design/entertainment placement."
      },
      {
        "canonical": "Massachusetts College of Art and Design",
        "aliases": [
          "MCAD Boston",
          "Mass Art",
          "MassArt",
          "Massachusetts College of Art & Design"
        ],
        "program": "Graphic Design / Industrial Design / UX",
        "note": "Only freestanding public art-and-design college in the US; respected graphic and industrial design programs feeding the Boston design market."
      },
      {
        "canonical": "Memphis College of Art",
        "aliases": [
          "MCA Memphis",
          "Memphis College of Art (MCA)"
        ],
        "program": "Graphic Design / Illustration",
        "note": "Recognized regional art-and-design program (graphic design and illustration); positive/neutral signal."
      },
      {
        "canonical": "Michigan State University",
        "aliases": [
          "Broad",
          "Eli Broad",
          "MSU",
          "Mich State",
          "Michigan St",
          "Michigan State"
        ],
        "program": "Experience Architecture (XA) / Media & Information",
        "note": "Established experience-architecture UX program; positive signal."
      },
      {
        "canonical": "Milwaukee Institute of Art and Design",
        "aliases": [
          "MIAD",
          "Milwaukee Institute of Art & Design"
        ],
        "program": "Communication Design / Industrial Design / UX",
        "note": "AICAD school; recognized communication and industrial design programs feeding the Upper-Midwest design market."
      },
      {
        "canonical": "Minneapolis College of Art and Design",
        "aliases": [
          "MCAD",
          "Minneapolis College of Art & Design",
          "Minneapolis College of Art and Design (MCAD)"
        ],
        "program": "Graphic Design / Web & Multimedia Environments",
        "note": "Respected AICAD art-and-design school; strong graphic/communication and interaction-design placement in the Upper-Midwest design market."
      },
      {
        "canonical": "Moore College of Art and Design",
        "aliases": [
          "Moore",
          "Moore College",
          "Moore College of Art & Design"
        ],
        "program": "Graphic Design / UX Design",
        "note": "Philadelphia AICAD school; recognized graphic and UX design program with solid Mid-Atlantic placement."
      },
      {
        "canonical": "New York University",
        "aliases": [
          "N.Y.U.",
          "NYU",
          "NYU Stern",
          "Stern"
        ],
        "program": "Tisch ITP / Integrated Digital Media",
        "note": "ITP is a respected interaction/creative-technology pipeline for NYC product/experience design."
      },
      {
        "canonical": "OCAD University",
        "aliases": [
          "OCAD",
          "Ontario College of Art and Design"
        ],
        "note": "CANADIAN — top Canadian art-and-design school occasionally recruited by US firms for industrial/interaction design. Note-only; US-centric list."
      },
      {
        "canonical": "Otis College of Art and Design",
        "aliases": [
          "Otis",
          "Otis Art Institute",
          "Otis College"
        ],
        "program": "Product Design / Communication Arts / Toy Design",
        "note": "Recognized LA art-and-design school; solid product, communication, and entertainment-design pipeline into the SoCal market."
      },
      {
        "canonical": "Pacific Northwest College of Art",
        "aliases": [
          "PNCA",
          "PNCA at Willamette",
          "Pacific Northwest College of Art (PNCA)"
        ],
        "program": "Communication Design / Design Systems",
        "note": "Portland AICAD school; recognized communication and design-systems program with Pacific-NW design placement."
      },
      {
        "canonical": "Pennsylvania State University",
        "aliases": [
          "PSU",
          "Penn St",
          "Penn State",
          "Penn State Smeal",
          "Penn State University",
          "Penn State University Park",
          "Pennsylvania State",
          "Smeal"
        ],
        "program": "College of IST / Graphic Design",
        "note": "Solid IST UX and graphic design programs."
      },
      {
        "canonical": "Purdue University",
        "aliases": [
          "Daniels",
          "Daniels School of Business",
          "Krannert",
          "Mitch Daniels School",
          "Purdue",
          "Purdue West Lafayette"
        ],
        "program": "UX Design / Industrial Design",
        "note": "Strong UX/UI/HCI and industrial design programs (top-10 undergrad UX)."
      },
      {
        "canonical": "Rochester Institute of Technology",
        "aliases": [
          "RIT",
          "Rochester Institute",
          "Saunders"
        ],
        "program": "School of Design — Industrial Design / HCI",
        "note": "Solid industrial design and HCI programs with co-op."
      },
      {
        "canonical": "Rutgers University",
        "aliases": [
          "RU",
          "Rutgers",
          "Rutgers Business School",
          "Rutgers New Brunswick",
          "Rutgers University-New Brunswick",
          "Rutgers — New Brunswick",
          "Rutgers-New Brunswick"
        ],
        "program": "Mason Gross — Design / Information",
        "note": "Solid design/UX program; positive regional signal."
      },
      {
        "canonical": "San Jose State University",
        "aliases": [
          "SJ State",
          "SJSU",
          "San Jose State",
          "San José State University"
        ],
        "program": "Design / HCI",
        "note": "Bay Area location drives strong access to Silicon Valley UX/product-design roles despite a less-elite brand."
      },
      {
        "canonical": "Temple University",
        "aliases": [
          "Fox",
          "Fox School",
          "Fox School of Business",
          "Klein",
          "TU",
          "Temple",
          "Tyler",
          "Tyler School of Art",
          "Tyler School of Art and Architecture"
        ],
        "program": "Tyler School of Art and Architecture — Graphic & Interactive Design",
        "note": "Tyler School of Art is a respected graphic and interactive design program feeding the Philadelphia design market."
      },
      {
        "canonical": "Texas State University",
        "aliases": [
          "TXST",
          "Texas State",
          "Texas State Univ",
          "Texas State University-San Marcos"
        ],
        "program": "Communication Design / UX",
        "note": "Recognized communication and UX design program serving the growing Austin/Central-Texas design market."
      },
      {
        "canonical": "The Ohio State University",
        "aliases": [
          "OSU",
          "Ohio St",
          "Ohio State",
          "Ohio State University",
          "tOSU"
        ],
        "program": "Department of Design — Industrial / Visual Communication / Interaction Design",
        "note": "Strong public Department of Design (industrial, visual communication, interaction); recognized national design placement."
      },
      {
        "canonical": "University of California, Irvine",
        "aliases": [
          "Irvine",
          "UC Irvine",
          "UC-Irvine",
          "UCI",
          "University of California-Irvine"
        ],
        "program": "Informatics (HCI) / Donald Bren ICS",
        "note": "Strong informatics HCI track; well-recruited in SoCal."
      },
      {
        "canonical": "University of Colorado Boulder",
        "aliases": [
          "Boulder",
          "CU",
          "CU Boulder",
          "CU-Boulder",
          "Colorado",
          "Colorado Boulder",
          "Leeds",
          "Leeds School of Business",
          "UC Boulder",
          "University of Colorado",
          "University of Colorado-Boulder"
        ],
        "program": "ATLAS / Creative Technology & Design",
        "note": "Solid creative-technology and HCI design program."
      },
      {
        "canonical": "University of Illinois Urbana-Champaign",
        "aliases": [
          "Gies",
          "Illinois",
          "Illinois Urbana-Champaign",
          "U of I",
          "UIUC",
          "University of Illinois",
          "University of Illinois at Urbana-Champaign"
        ],
        "program": "School of Information Sciences (iSchool) / Design",
        "note": "iSchool UX track; design signal distinct from its CS powerhouse status."
      },
      {
        "canonical": "University of Kansas",
        "aliases": [
          "Jayhawks",
          "KU",
          "Kansas",
          "U Kansas",
          "U of Kansas",
          "University of Kansas Lawrence",
          "William Allen White School"
        ],
        "program": "School of Architecture & Design — Visual Communication / Industrial Design / UX",
        "note": "Public flagship design school with visual-communication, industrial, and UX tracks; recognized regional placement."
      },
      {
        "canonical": "University of Minnesota",
        "aliases": [
          "Carlson",
          "Minnesota",
          "Minnesota Twin Cities",
          "U Minnesota",
          "U of M",
          "U of M Minnesota",
          "U of M Twin Cities",
          "UMN",
          "University of Minnesota Twin Cities",
          "University of Minnesota-Twin Cities"
        ],
        "program": "College of Design — Graphic Design / Product Design / HCI",
        "note": "Public flagship College of Design with graphic, product, and HCI tracks; recognized Upper-Midwest UX/design pipeline."
      },
      {
        "canonical": "University of North Texas",
        "aliases": [
          "North Texas",
          "UNT"
        ],
        "program": "College of Visual Arts and Design — Design / Communication Design",
        "note": "Recognized communication and design program in the Texas market."
      },
      {
        "canonical": "University of Oregon",
        "aliases": [
          "Lundquist",
          "Oregon",
          "SOJC",
          "U Oregon",
          "U of O",
          "UO"
        ],
        "program": "College of Design — Product Design / Interaction & UX",
        "note": "Recognized product-design and interaction programs (Portland + Eugene); Nike/consumer-product design ties drive Pacific-NW placement."
      },
      {
        "canonical": "University of Texas at Austin",
        "aliases": [
          "McCombs",
          "Moody",
          "Texas",
          "UT",
          "UT Austin",
          "UT-Austin",
          "University of Texas",
          "University of Texas Austin"
        ],
        "program": "School of Information / Design",
        "note": "Solid iSchool UX and design pipeline in the growing Austin tech market."
      },
      {
        "canonical": "University of Utah",
        "aliases": [
          "David Eccles",
          "Eccles",
          "The U",
          "The University of Utah",
          "U Utah",
          "U of U",
          "UU",
          "University of Utah Salt Lake",
          "UofU",
          "Utah",
          "Utah Salt Lake"
        ],
        "program": "Multi-Disciplinary Design / Games (EAE) / HCI",
        "note": "Recognized multi-disciplinary design and games/HCI programs (EAE); positive signal in the growing Salt Lake tech market."
      },
      {
        "canonical": "University of Waterloo",
        "aliases": [
          "U Waterloo",
          "UW Waterloo",
          "UWaterloo",
          "Waterloo"
        ],
        "note": "CANADIAN — not US, but US tech employers recruit its Systems Design Engineering / GBDA grads for UX/product design. Note-only; keep list US-centric."
      },
      {
        "canonical": "University of Wisconsin–Madison",
        "aliases": [
          "Madison",
          "U Wisconsin",
          "UW Madison",
          "UW-Madison",
          "UWisc",
          "University of Wisconsin",
          "University of Wisconsin Madison",
          "University of Wisconsin-Madison",
          "Wisconsin",
          "Wisconsin School of Business",
          "Wisconsin-Madison"
        ],
        "program": "Design Studies / Information School (UX)",
        "note": "Recognized design-studies and iSchool UX tracks at a public flagship; solid Midwest design/UX signal."
      }
    ]
  },
  "go_to_market": {
    "tier_1": [
      {
        "canonical": "Baylor University",
        "aliases": [
          "Baylor",
          "Baylor ProSales",
          "Hankamer"
        ],
        "program": "Center for Professional Selling / ProSales (Hankamer School of Business)",
        "note": "ROLE-SPECIFIC elite: SEF top sales program 13+ consecutive years; guarantees paid sales internships. Strongest dedicated-sales signal in the US for GTM."
      },
      {
        "canonical": "Cornell University",
        "aliases": [
          "Cornell",
          "Cornell Dyson",
          "Dyson",
          "Johnson",
          "SC Johnson"
        ],
        "program": "Dyson School of Applied Economics and Management",
        "note": "U.S. News 2026 #3 undergrad business; Ivy brand + business pipeline into GTM."
      },
      {
        "canonical": "Georgetown University",
        "aliases": [
          "GU",
          "Georgetown",
          "Georgetown McDonough",
          "McDonough"
        ],
        "program": "McDonough School of Business",
        "note": "DC/East-coast network; partnerships and enterprise GTM feeder."
      },
      {
        "canonical": "Indiana University",
        "aliases": [
          "IU",
          "Indiana",
          "Indiana University Bloomington",
          "Kelley",
          "Kelley School"
        ],
        "program": "Kelley School of Business — Center for Global Sales Leadership",
        "note": "Rare double signal: top-brand public business school AND a leading SEF professional-sales program."
      },
      {
        "canonical": "New York University",
        "aliases": [
          "N.Y.U.",
          "NYU",
          "NYU Stern",
          "Stern"
        ],
        "program": "Stern School of Business",
        "note": "NYC enterprise-sales and partnerships feeder; strong brand for GTM."
      },
      {
        "canonical": "Stanford University",
        "aliases": [
          "Stanford",
          "Stanford Univ"
        ],
        "note": "No dedicated sales program, but elite brand/network; grads strong in tech GTM, partnerships, and GTM leadership."
      },
      {
        "canonical": "University of California, Berkeley",
        "aliases": [
          "Berkeley",
          "Cal",
          "Haas",
          "UC Berkeley",
          "UC-Berkeley",
          "UCB",
          "University of California-Berkeley"
        ],
        "program": "Haas School of Business",
        "note": "Bay Area tech GTM proximity + elite brand; strong SaaS sales/CS pipeline."
      },
      {
        "canonical": "University of Michigan",
        "aliases": [
          "Michigan",
          "Michigan Ann Arbor",
          "Michigan Ross",
          "Ross",
          "U Michigan",
          "U of M",
          "U-M",
          "UMich",
          "University of Michigan Ann Arbor",
          "University of Michigan-Ann Arbor"
        ],
        "program": "Ross School of Business",
        "note": "U.S. News 2026 #4 undergrad business; huge GTM/tech alumni network."
      },
      {
        "canonical": "University of Pennsylvania",
        "aliases": [
          "Annenberg",
          "Penn",
          "U Penn",
          "U. Penn",
          "UPenn",
          "Wharton",
          "Wharton School"
        ],
        "program": "The Wharton School",
        "note": "Top US undergrad business program (U.S. News 2026 #1-tie); premier network/brand signal for enterprise GTM and GTM leadership pipelines."
      },
      {
        "canonical": "University of Southern California",
        "aliases": [
          "Annenberg",
          "Leventhal",
          "Marshall",
          "Southern Cal",
          "Southern California",
          "U.S.C.",
          "USC",
          "USC Leventhal",
          "USC Marshall"
        ],
        "program": "Marshall School of Business",
        "note": "U.S. News 2026 #5 undergrad business; powerhouse alumni/network school for sales and media/tech GTM."
      },
      {
        "canonical": "University of Virginia",
        "aliases": [
          "McIntire",
          "U Va",
          "U-Va",
          "U.Va.",
          "UVA",
          "University of Virginia Charlottesville",
          "Virginia"
        ],
        "program": "McIntire School of Commerce",
        "note": "Top-tier business undergrad; strong polished-candidate signal for enterprise GTM."
      }
    ],
    "tier_2": [
      {
        "canonical": "Bentley University",
        "aliases": [
          "Bentley",
          "Bentley College"
        ],
        "program": "Professional Sales / business",
        "note": "Business-focused school near Boston with strong analytical-business and dedicated-sales output; common in tech/SaaS GTM."
      },
      {
        "canonical": "Boston College",
        "aliases": [
          "BC",
          "Boston Coll",
          "Carroll"
        ],
        "program": "Carroll School of Management",
        "note": "Strong East-coast business network; common in enterprise sales/CS."
      },
      {
        "canonical": "College of William & Mary",
        "aliases": [
          "Mason School",
          "Mason School of Business",
          "W&M",
          "WM",
          "William & Mary",
          "William and Mary"
        ],
        "program": "Mason School of Business sales program",
        "note": "Dedicated sales/sales-leadership program with strong placement."
      },
      {
        "canonical": "Emory University",
        "aliases": [
          "Emory",
          "Goizueta"
        ],
        "program": "Goizueta Business School",
        "note": "Atlanta tech/healthcare GTM feeder; strong brand."
      },
      {
        "canonical": "Florida State University",
        "aliases": [
          "FL State",
          "FSU",
          "Florida St",
          "Florida State",
          "Seminoles"
        ],
        "program": "Sales Institute (College of Business)",
        "note": "Premier dedicated professional-sales program; major source of trained SDR/AE talent."
      },
      {
        "canonical": "Harvard University",
        "aliases": [
          "Harvard",
          "Harvard College",
          "Harvard Univ"
        ],
        "note": "No sales program, but apex brand/network; common in GTM leadership, partnerships, and high-end enterprise sales."
      },
      {
        "canonical": "Marquette University",
        "aliases": [
          "Diederich",
          "MU",
          "Marquette"
        ],
        "program": "Kohler Center for Entrepreneurship / Professional Sales program",
        "note": "Recognized dedicated professional-sales program; reliable Midwest rep pipeline."
      },
      {
        "canonical": "Ohio State University",
        "aliases": [
          "Fisher",
          "OSU",
          "Ohio State",
          "The Ohio State University",
          "tOSU"
        ],
        "program": "Fisher College of Business — Center for Professional Sales",
        "note": "SEF top sales program; large, well-recruited GTM pipeline."
      },
      {
        "canonical": "Pennsylvania State University",
        "aliases": [
          "PSU",
          "Penn St",
          "Penn State",
          "Penn State Smeal",
          "Penn State University",
          "Penn State University Park",
          "Pennsylvania State",
          "Smeal"
        ],
        "program": "Smeal College of Business",
        "note": "Huge alumni network valued in GTM; broad rep output."
      },
      {
        "canonical": "Purdue University",
        "aliases": [
          "Daniels",
          "Daniels School of Business",
          "Krannert",
          "Mitch Daniels School",
          "Purdue",
          "Purdue West Lafayette"
        ],
        "program": "Daniels School of Business — Selling and Sales Management",
        "note": "SEF-recognized sales program; technical-sales and sales-engineering pipeline."
      },
      {
        "canonical": "Santa Clara University",
        "aliases": [
          "Leavey",
          "SCU",
          "Santa Clara"
        ],
        "program": "Leavey School of Business",
        "note": "Silicon Valley location drives heavy access to Bay Area SaaS GTM, sales, and customer-success roles."
      },
      {
        "canonical": "Southern Methodist University",
        "aliases": [
          "Cox",
          "Cox School of Business",
          "Lyle",
          "SMU",
          "Southern Methodist"
        ],
        "program": "SMU Cox School of Business",
        "note": "Dallas enterprise-sales feeder; strong regional GTM brand."
      },
      {
        "canonical": "Texas A&M University",
        "aliases": [
          "A&M",
          "Aggies",
          "Mays",
          "Mays Business School",
          "TAMU",
          "Texas A&M",
          "Texas A&M University-College Station"
        ],
        "program": "Mays Business School — Reynolds & Reynolds Sales Leadership Institute",
        "note": "Large sales program + strong loyal alumni network; well-recruited for GTM."
      },
      {
        "canonical": "Texas Christian University",
        "aliases": [
          "Neeley",
          "TCU",
          "Texas Christian"
        ],
        "program": "Neeley School of Business — Center for Professional Sales",
        "note": "SEF top sales program; well-recruited relationship-sales pipeline into Texas/Southwest enterprise and SaaS GTM."
      },
      {
        "canonical": "University of California, Los Angeles",
        "aliases": [
          "Anderson",
          "U.C.L.A.",
          "UC Los Angeles",
          "UC-LA",
          "UCLA",
          "University of California-Los Angeles"
        ],
        "note": "Elite brand + LA tech/media GTM proximity; strong partnerships/CS pipeline (no dedicated undergrad sales program)."
      },
      {
        "canonical": "University of Florida",
        "aliases": [
          "Florida",
          "Gainesville",
          "Gators",
          "U of Florida",
          "UF",
          "UFlorida",
          "Univ of Florida",
          "Warrington"
        ],
        "program": "Warrington College of Business",
        "note": "Top public business school; strong SaaS GTM output."
      },
      {
        "canonical": "University of Georgia",
        "aliases": [
          "Georgia",
          "Grady",
          "Terry",
          "U Georgia",
          "UGA"
        ],
        "program": "Terry College of Business — sales program",
        "note": "SEC flagship; deep Southeast tech/enterprise GTM network."
      },
      {
        "canonical": "University of Houston",
        "aliases": [
          "Bauer",
          "C. T. Bauer",
          "Houston",
          "U Houston",
          "U of H",
          "UH"
        ],
        "program": "Stephen Stagner Sales Excellence Institute",
        "note": "Top-ranked dedicated sales program; strong energy/enterprise GTM pipeline."
      },
      {
        "canonical": "University of North Carolina at Chapel Hill",
        "aliases": [
          "Carolina",
          "Chapel Hill",
          "Hussman",
          "Kenan-Flagler",
          "North Carolina",
          "UNC",
          "UNC Chapel Hill",
          "UNC-Chapel Hill"
        ],
        "program": "Kenan-Flagler Business School",
        "note": "Top public business school; well-recruited for GTM."
      },
      {
        "canonical": "University of Notre Dame",
        "aliases": [
          "Mendoza",
          "ND",
          "Notre Dame",
          "Notre Dame Mendoza",
          "Notre Dame du Lac",
          "Univ of Notre Dame"
        ],
        "program": "Mendoza College of Business",
        "note": "Top business undergrad; relationship-driven alumni network valued in GTM."
      },
      {
        "canonical": "University of Texas at Austin",
        "aliases": [
          "McCombs",
          "Moody",
          "Texas",
          "UT",
          "UT Austin",
          "UT-Austin",
          "University of Texas",
          "University of Texas Austin"
        ],
        "program": "McCombs — Center for Customer Insight & Marketing Solutions / sales track",
        "note": "Major SaaS/tech GTM hub (Austin); deep rep and GTM-leadership output."
      },
      {
        "canonical": "University of Texas at Dallas",
        "aliases": [
          "Naveen Jindal",
          "UT Dallas",
          "UT-Dallas",
          "UTD",
          "University of Texas-Dallas"
        ],
        "program": "SMU Cox School of Business",
        "note": "Dallas enterprise-sales feeder; strong regional GTM brand."
      },
      {
        "canonical": "University of Waterloo",
        "aliases": [
          "U Waterloo",
          "UW Waterloo",
          "UWaterloo",
          "Waterloo"
        ],
        "note": "CANADIAN — not US, included only as a known cross-border feeder; weight low for a US-focused GTM pool."
      },
      {
        "canonical": "University of Wisconsin-Eau Claire",
        "aliases": [
          "Eau Claire",
          "UW-Eau Claire",
          "UWEC"
        ],
        "program": "Center for Sales and Sales Management",
        "note": "SEF top sales program; produces ready-to-ramp reps despite modest overall prestige."
      },
      {
        "canonical": "University of Wisconsin-Madison",
        "aliases": [
          "Madison",
          "U Wisconsin",
          "UW Madison",
          "UW-Madison",
          "UWisc",
          "University of Wisconsin",
          "University of Wisconsin Madison",
          "University of Wisconsin–Madison",
          "Wisconsin",
          "Wisconsin School of Business",
          "Wisconsin-Madison"
        ],
        "program": "Wisconsin School of Business",
        "note": "Big-brand business school + SEF-aligned sales curriculum; broad rep output."
      },
      {
        "canonical": "Villanova University",
        "aliases": [
          "Nova",
          "VSB",
          "Villanova",
          "Villanova School of Business"
        ],
        "program": "Villanova School of Business",
        "note": "Top-tier undergrad business brand; strong Northeast enterprise-sales and partnerships pipeline."
      }
    ],
    "tier_3": [
      {
        "canonical": "Arizona State University",
        "aliases": [
          "ASU",
          "Arizona State",
          "Cronkite",
          "W. P. Carey",
          "W.P. Carey",
          "WP Carey"
        ],
        "program": "W. P. Carey School of Business",
        "note": "Large business school; broad GTM output, Phoenix tech hub."
      },
      {
        "canonical": "Auburn University",
        "aliases": [
          "AU",
          "Auburn",
          "Auburn Univ",
          "Harbert"
        ],
        "program": "Harbert College of Business — Professional Sales",
        "note": "SEC flagship with a dedicated sales program; strong loyal alumni network valued in Southeast GTM."
      },
      {
        "canonical": "Babson College",
        "aliases": [
          "Babson"
        ],
        "note": "Entrepreneurship/business-focused; produces strong BD/partnerships and founder-adjacent GTM talent."
      },
      {
        "canonical": "Ball State University",
        "aliases": [
          "Ball State"
        ],
        "program": "Professional Selling program",
        "note": "SEF-recognized sales program; solid Midwest rep output."
      },
      {
        "canonical": "Boston University",
        "aliases": [
          "BU",
          "Boston U",
          "Boston Univ",
          "Questrom"
        ],
        "program": "Questrom School of Business",
        "note": "Strong East-coast business brand; common in SaaS GTM."
      },
      {
        "canonical": "Bradley University",
        "aliases": [
          "Bradley"
        ],
        "program": "Professional Sales program (Foster College of Business)",
        "note": "Recognized dedicated sales program."
      },
      {
        "canonical": "Brigham Young University",
        "aliases": [
          "BYU",
          "BYU Provo",
          "Brigham Young",
          "Marriott",
          "Marriott School"
        ],
        "program": "Marriott School of Business",
        "note": "Strong undergrad business brand; reliable, work-ready GTM/CS output and a notably loyal alumni network."
      },
      {
        "canonical": "Bryant University",
        "aliases": [
          "Bryant",
          "Bryant University Sales Institute"
        ],
        "program": "Bryant University Sales Institute",
        "note": "Business-focused school with a dedicated sales institute; recognized Northeast rep/GTM pipeline."
      },
      {
        "canonical": "Clemson University",
        "aliases": [
          "CU",
          "Clemson"
        ],
        "program": "Center for Sales Excellence",
        "note": "Recognized sales program; Southeast tech GTM feeder."
      },
      {
        "canonical": "DePaul University",
        "aliases": [
          "DePaul",
          "Driehaus"
        ],
        "program": "Center for Sales Leadership (Driehaus College of Business)",
        "note": "Strong Chicago dedicated-sales program."
      },
      {
        "canonical": "Fordham University",
        "aliases": [
          "Fordham",
          "Gabelli",
          "Gabelli School of Business"
        ],
        "program": "Gabelli School of Business",
        "note": "NYC business school; strong access to media/tech/financial-services enterprise GTM and partnerships."
      },
      {
        "canonical": "Illinois State University",
        "aliases": [
          "ISU",
          "Illinois State",
          "Illinois State Univ"
        ],
        "program": "Professional Sales Institute (College of Business)",
        "note": "USCA-member dedicated professional-sales program; reliable Midwest SDR/AE pipeline."
      },
      {
        "canonical": "Iowa State University",
        "aliases": [
          "ISU",
          "ISU Ames",
          "Iowa St",
          "Iowa State",
          "Iowa State Univ",
          "Iowa State University of Science and Technology",
          "Ivy College of Business"
        ],
        "program": "Ivy College of Business",
        "note": "Big-brand land-grant business school; solid Midwest rep and sales-engineering output."
      },
      {
        "canonical": "Kansas State University",
        "aliases": [
          "K-State",
          "KSU",
          "KSU Manhattan",
          "Kansas State"
        ],
        "program": "National Strategic Selling Institute (College of Business)",
        "note": "Dedicated professional-selling institute; reliable trained-rep pipeline."
      },
      {
        "canonical": "Kennesaw State University",
        "aliases": [
          "KSU",
          "Kennesaw",
          "Kennesaw State"
        ],
        "program": "Center for Professional Selling (Coles College of Business)",
        "note": "Long-standing SEF top sales program; reliable trained-rep pipeline in Atlanta tech corridor."
      },
      {
        "canonical": "Miami University",
        "aliases": [
          "Farmer",
          "Farmer School of Business",
          "MU Ohio",
          "Miami (OH)",
          "Miami Ohio",
          "Miami University Ohio",
          "Miami of Ohio"
        ],
        "program": "Farmer School of Business",
        "note": "Strong undergrad business brand feeding GTM and consulting-adjacent sales."
      },
      {
        "canonical": "Michigan State University",
        "aliases": [
          "Broad",
          "Eli Broad",
          "MSU",
          "Mich State",
          "Michigan St",
          "Michigan State"
        ],
        "program": "Broad College of Business — sales leadership program",
        "note": "Large business school; broad rep output."
      },
      {
        "canonical": "Northeastern University",
        "aliases": [
          "D'Amore-McKim",
          "NEU",
          "NU Boston",
          "Northeastern"
        ],
        "program": "D'Amore-McKim School of Business",
        "note": "Co-op model produces work-ready GTM/CS candidates."
      },
      {
        "canonical": "Northern Illinois University",
        "aliases": [
          "NIU",
          "Northern Illinois"
        ],
        "program": "Professional Sales Program (College of Business)",
        "note": "Founding USCA member; established dedicated-sales program feeding Chicago-area GTM."
      },
      {
        "canonical": "Northwood University",
        "aliases": [
          "Northwood"
        ],
        "program": "Professional Sales / Sales & Marketing",
        "note": "SEF top sales program; long-standing dedicated-sales school producing ready-to-ramp reps."
      },
      {
        "canonical": "Oklahoma State University",
        "aliases": [
          "OSU",
          "OSU Stillwater",
          "Oklahoma State",
          "Spears",
          "Spears School of Business"
        ],
        "program": "Spears School of Business — Marketing/Sales",
        "note": "Recognized state business school; solid regional rep pipeline."
      },
      {
        "canonical": "Rutgers University",
        "aliases": [
          "RU",
          "Rutgers",
          "Rutgers Business School",
          "Rutgers New Brunswick",
          "Rutgers University-New Brunswick",
          "Rutgers — New Brunswick",
          "Rutgers-New Brunswick"
        ],
        "program": "Rutgers Business School",
        "note": "Large NY/NJ-metro business school; broad enterprise-sales and customer-success pipeline."
      },
      {
        "canonical": "San Diego State University",
        "aliases": [
          "Aztecs",
          "Fowler",
          "SD State",
          "SDSU",
          "San Diego State"
        ],
        "program": "Fowler College of Business — Centers for Sales/Marketing",
        "note": "Large SoCal business school; solid access to West-Coast SaaS GTM and rep roles."
      },
      {
        "canonical": "Temple University",
        "aliases": [
          "Fox",
          "Fox School",
          "Fox School of Business",
          "Klein",
          "TU",
          "Temple",
          "Tyler",
          "Tyler School of Art",
          "Tyler School of Art and Architecture"
        ],
        "program": "Fox School of Business — Institute for Sales Excellence",
        "note": "Dedicated sales institute in Philadelphia; recognized Northeast rep/GTM pipeline."
      },
      {
        "canonical": "Texas Tech University",
        "aliases": [
          "Rawls",
          "TTU",
          "Texas Tech"
        ],
        "program": "Rawls College of Business",
        "note": "Large Texas business school; deep regional enterprise/energy GTM and rep output."
      },
      {
        "canonical": "Tulane University",
        "aliases": [
          "A.B. Freeman",
          "Freeman",
          "Freeman School of Business",
          "Tulane"
        ],
        "program": "A. B. Freeman School of Business",
        "note": "Selective private business school; solid brand and partnerships/enterprise-sales pipeline in the South."
      },
      {
        "canonical": "University of Alabama",
        "aliases": [
          "Alabama",
          "Bama",
          "Culverhouse",
          "Roll Tide",
          "UA",
          "Univ of Alabama"
        ],
        "program": "Culverhouse College of Business — sales program",
        "note": "SEC flagship; strong loyal alumni network valued in GTM."
      },
      {
        "canonical": "University of Arizona",
        "aliases": [
          "Arizona",
          "Eller",
          "U Arizona",
          "U of A",
          "UA",
          "UA Tucson",
          "UArizona"
        ],
        "program": "Eller College of Management — sales program",
        "note": "SEF-recognized sales track."
      },
      {
        "canonical": "University of Central Florida",
        "aliases": [
          "Central Florida",
          "U Central Florida",
          "UCF"
        ],
        "program": "Professional Selling Program",
        "note": "Large program feeding Florida SaaS/tech GTM."
      },
      {
        "canonical": "University of Cincinnati",
        "aliases": [
          "Cincinnati",
          "DAAP",
          "Lindner",
          "UC",
          "University of Cincinnati DAAP"
        ],
        "program": "Center for Professional Selling (Lindner College of Business)",
        "note": "Established SEF professional-selling program."
      },
      {
        "canonical": "University of Colorado Boulder",
        "aliases": [
          "Boulder",
          "CU",
          "CU Boulder",
          "CU-Boulder",
          "Colorado",
          "Colorado Boulder",
          "Leeds",
          "Leeds School of Business",
          "UC Boulder",
          "University of Colorado",
          "University of Colorado-Boulder"
        ],
        "program": "Leeds School of Business",
        "note": "Front Range tech-hub business school; recognized SaaS GTM and rep pipeline in Denver/Boulder."
      },
      {
        "canonical": "University of Illinois Urbana-Champaign",
        "aliases": [
          "Gies",
          "Illinois",
          "Illinois Urbana-Champaign",
          "U of I",
          "UIUC",
          "University of Illinois",
          "University of Illinois at Urbana-Champaign"
        ],
        "program": "Gies College of Business",
        "note": "Strong business undergrad; broad GTM and tech-adjacent sales output."
      },
      {
        "canonical": "University of Iowa",
        "aliases": [
          "Hawkeyes",
          "Iowa",
          "The University of Iowa",
          "Tippie",
          "Tippie College of Business",
          "U Iowa",
          "U of Iowa",
          "UIowa"
        ],
        "program": "Tippie College — marketing/sales program",
        "note": "Big Ten business school; solid Midwest rep output."
      },
      {
        "canonical": "University of Kansas",
        "aliases": [
          "Jayhawks",
          "KU",
          "Kansas",
          "U Kansas",
          "U of Kansas",
          "University of Kansas Lawrence",
          "William Allen White School"
        ],
        "program": "School of Business",
        "note": "State flagship business school; broad GTM and tech-adjacent sales output in the central US."
      },
      {
        "canonical": "University of Kentucky",
        "aliases": [
          "Gatton",
          "Kentucky",
          "U Kentucky",
          "UK"
        ],
        "program": "Gatton College of Business and Economics",
        "note": "State flagship business school; recognized regional GTM and enterprise-sales output."
      },
      {
        "canonical": "University of Louisville",
        "aliases": [
          "Louisville",
          "UofL"
        ],
        "program": "College of Business — Professional Sales / Marketing",
        "note": "Recognized regional business program; solid Ohio Valley rep pipeline."
      },
      {
        "canonical": "University of Minnesota",
        "aliases": [
          "Carlson",
          "Minnesota",
          "Minnesota Twin Cities",
          "U Minnesota",
          "U of M",
          "U of M Minnesota",
          "U of M Twin Cities",
          "UMN",
          "University of Minnesota Twin Cities",
          "University of Minnesota-Twin Cities"
        ],
        "program": "Carlson School of Management",
        "note": "Top public business school; solid GTM/medtech sales pipeline."
      },
      {
        "canonical": "University of Mississippi",
        "aliases": [
          "Mississippi",
          "Ole Miss",
          "Olemiss",
          "UM"
        ],
        "program": "School of Business Administration",
        "note": "SEC flagship; loyal alumni network and solid Southeast rep pipeline."
      },
      {
        "canonical": "University of Missouri",
        "aliases": [
          "MU",
          "Missouri",
          "Missouri School of Journalism",
          "Mizzou",
          "Mizzou Journalism",
          "Trulaske",
          "U Missouri",
          "University of Missouri-Columbia"
        ],
        "program": "Trulaske College of Business — sales/marketing",
        "note": "SEC flagship business school; solid Midwest rep and brand-adjacent sales pipeline."
      },
      {
        "canonical": "University of Nebraska-Lincoln",
        "aliases": [
          "Cornhuskers",
          "Husker",
          "Huskers",
          "Nebraska",
          "Nebraska Lincoln",
          "Nebraska-Lincoln",
          "UNL",
          "University of Nebraska",
          "University of Nebraska–Lincoln"
        ],
        "program": "College of Business",
        "note": "State flagship business school; broad GTM output with a strong regional alumni network."
      },
      {
        "canonical": "University of Oklahoma",
        "aliases": [
          "Gaylord",
          "OU",
          "Oklahoma",
          "Price",
          "Price College",
          "Price College of Business",
          "Sooners",
          "U Oklahoma"
        ],
        "program": "Price College of Business",
        "note": "State flagship business school; broad rep output and Plains/energy-sector enterprise GTM network."
      },
      {
        "canonical": "University of Oregon",
        "aliases": [
          "Lundquist",
          "Oregon",
          "SOJC",
          "U Oregon",
          "U of O",
          "UO"
        ],
        "program": "Lundquist College of Business",
        "note": "Pacific-NW business school; solid brand and West-Coast GTM/partnerships output."
      },
      {
        "canonical": "University of Pittsburgh",
        "aliases": [
          "College of Business Administration",
          "Katz",
          "Pitt",
          "Pittsburgh",
          "U Pitt",
          "U Pittsburgh",
          "UPitt",
          "University of Pittsburgh Pittsburgh"
        ],
        "program": "Joseph M. Katz / College of Business Administration",
        "note": "Recognized business undergrad; solid Mid-Atlantic GTM and tech-sales output."
      },
      {
        "canonical": "University of South Carolina",
        "aliases": [
          "Darla Moore",
          "Darla Moore School",
          "Gamecocks",
          "Moore School",
          "South Carolina",
          "USC Columbia",
          "USCarolina",
          "UofSC"
        ],
        "program": "Darla Moore School of Business — sales program",
        "note": "SEF-recognized sales track."
      },
      {
        "canonical": "University of Tennessee, Knoxville",
        "aliases": [
          "Haslam",
          "Tennessee",
          "Tennessee Knoxville",
          "UT Knoxville",
          "UTK"
        ],
        "program": "Haslam College of Business — sales program",
        "note": "Dedicated sales program; Southeast GTM pipeline."
      },
      {
        "canonical": "University of Toledo",
        "aliases": [
          "Toledo",
          "UToledo"
        ],
        "program": "Edward Schmidt School of Professional Sales",
        "note": "One of the oldest dedicated professional-sales schools."
      },
      {
        "canonical": "University of Utah",
        "aliases": [
          "David Eccles",
          "Eccles",
          "The U",
          "The University of Utah",
          "U Utah",
          "U of U",
          "UU",
          "University of Utah Salt Lake",
          "UofU",
          "Utah",
          "Utah Salt Lake"
        ],
        "program": "David Eccles School of Business",
        "note": "Salt Lake City tech-hub proximity (Silicon Slopes); strong SaaS GTM and rep pipeline."
      },
      {
        "canonical": "University of Washington",
        "aliases": [
          "Foster",
          "U Dub",
          "U Washington",
          "U-Dub",
          "UDub",
          "UW",
          "UW Seattle",
          "University of Washington Seattle",
          "University of Washington-Seattle",
          "Washington"
        ],
        "program": "Foster School of Business",
        "note": "Seattle tech proximity (Microsoft/Amazon GTM pipeline)."
      },
      {
        "canonical": "Virginia Tech",
        "aliases": [
          "Pamplin",
          "VPI",
          "VT",
          "Virginia Polytechnic",
          "Virginia Polytechnic Institute and State University",
          "Virginia Tech University"
        ],
        "program": "Pamplin College — Professional Sales Program",
        "note": "SEF-recognized professional-sales program; solid technical-sales and enterprise GTM feeder in the DC/Mid-Atlantic corridor."
      },
      {
        "canonical": "Weber State University",
        "aliases": [
          "WSU Weber",
          "Weber State"
        ],
        "program": "Center for Professional Sales (Goddard School of Business)",
        "note": "USCA-affiliated; offers the most sales-specific courses nationally — strong trained-rep signal despite low overall prestige."
      },
      {
        "canonical": "Western Michigan University",
        "aliases": [
          "Haworth",
          "WMU",
          "Western Michigan"
        ],
        "program": "Haworth College of Business — Sales and Business Marketing",
        "note": "SEF top sales program 18+ consecutive years; one of the deepest dedicated undergrad rep pipelines despite modest overall prestige."
      },
      {
        "canonical": "William Paterson University",
        "aliases": [
          "Russ Berrie Institute",
          "WPU",
          "William Paterson"
        ],
        "program": "Russ Berrie Institute for Professional Sales (Cotsakos College of Business)",
        "note": "SEF top sales program; recognized NY/NJ-metro professional-selling pipeline."
      }
    ]
  },
  "marketing": {
    "tier_1": [
      {
        "canonical": "Indiana University Bloomington",
        "aliases": [
          "IU",
          "IU Bloomington",
          "Indiana",
          "Indiana Bloomington",
          "Indiana University",
          "Kelley",
          "Kelley School of Business"
        ],
        "program": "Kelley School of Business (marketing)",
        "note": "US News #4 undergrad marketing; one of the deepest dedicated undergrad CPG/brand-marketing feeders despite lower overall prestige — a clear role-relative tier-1."
      },
      {
        "canonical": "New York University",
        "aliases": [
          "N.Y.U.",
          "NYU",
          "NYU Stern",
          "Stern"
        ],
        "program": "Stern School of Business (marketing) + strong media/comms",
        "note": "NYC media + brand + tech-marketing hub; Stern is a top undergrad business/marketing target."
      },
      {
        "canonical": "Northwestern University",
        "aliases": [
          "Kellogg",
          "Medill",
          "NU",
          "Northwestern"
        ],
        "program": "Medill (IMC/comms/journalism) — Kellogg drives CPG brand marketing at grad level",
        "note": "Medill is THE most-recruited communications/integrated-marketing name; Kellogg defines CPG brand management."
      },
      {
        "canonical": "Stanford University",
        "aliases": [
          "Stanford",
          "Stanford Univ"
        ],
        "note": "Premier feeder for growth/product/tech marketing and brand strategy in Silicon Valley; analytical generalist prestige, no marketing major needed."
      },
      {
        "canonical": "University of California, Berkeley",
        "aliases": [
          "Berkeley",
          "Cal",
          "Haas",
          "UC Berkeley",
          "UC-Berkeley",
          "UCB",
          "University of California-Berkeley"
        ],
        "program": "Haas School of Business",
        "note": "Elite analytical generalist + Haas; primary feeder for growth/performance marketing at Bay Area tech."
      },
      {
        "canonical": "University of Michigan",
        "aliases": [
          "Michigan",
          "Michigan Ann Arbor",
          "Michigan Ross",
          "Ross",
          "U Michigan",
          "U of M",
          "U-M",
          "UMich",
          "University of Michigan Ann Arbor",
          "University of Michigan-Ann Arbor"
        ],
        "program": "Ross School of Business (marketing)",
        "note": "Top undergrad business + marketing; heavy CPG and tech-marketing recruiting."
      },
      {
        "canonical": "University of Pennsylvania",
        "aliases": [
          "Annenberg",
          "Penn",
          "U Penn",
          "U. Penn",
          "UPenn",
          "Wharton",
          "Wharton School"
        ],
        "program": "Wharton (marketing) / Annenberg (communications)",
        "note": "Wharton is the single strongest undergrad marketing/brand feeder; Annenberg is elite for communications. Top of both axes."
      },
      {
        "canonical": "University of Southern California",
        "aliases": [
          "Annenberg",
          "Leventhal",
          "Marshall",
          "Southern Cal",
          "Southern California",
          "U.S.C.",
          "USC",
          "USC Leventhal",
          "USC Marshall"
        ],
        "program": "Marshall (business) + Annenberg (communications/journalism)",
        "note": "Rare school elite on BOTH the business-marketing and communications axes; strong LA media/entertainment + brand recruiting."
      },
      {
        "canonical": "University of Virginia",
        "aliases": [
          "McIntire",
          "U Va",
          "U-Va",
          "U.Va.",
          "UVA",
          "University of Virginia Charlottesville",
          "Virginia"
        ],
        "program": "McIntire School of Commerce (marketing track)",
        "note": "Top-target undergrad business/marketing program; strong brand and consulting-adjacent marketing recruiting."
      }
    ],
    "tier_2": [
      {
        "canonical": "Boston University",
        "aliases": [
          "BU",
          "Boston U",
          "Boston Univ",
          "Questrom"
        ],
        "program": "College of Communication + Questrom (business)",
        "note": "Strong communications/PR/advertising and business-marketing recruiting."
      },
      {
        "canonical": "Carnegie Mellon University",
        "aliases": [
          "C.M.U.",
          "CMU",
          "Carnegie Mellon",
          "Tepper"
        ],
        "program": "Tepper School of Business",
        "note": "Analytical/quantitative marketing and growth/marketing-analytics feeder for tech."
      },
      {
        "canonical": "Cornell University",
        "aliases": [
          "Cornell",
          "Cornell Dyson",
          "Dyson",
          "Johnson",
          "SC Johnson"
        ],
        "program": "Dyson School of Applied Economics & Management",
        "note": "Ivy business feeder; strong CPG/brand and tech-marketing recruiting."
      },
      {
        "canonical": "Emory University",
        "aliases": [
          "Emory",
          "Goizueta"
        ],
        "program": "Goizueta Business School",
        "note": "Strong undergrad business/marketing; Atlanta brand/CPG recruiting."
      },
      {
        "canonical": "Georgetown University",
        "aliases": [
          "GU",
          "Georgetown",
          "Georgetown McDonough",
          "McDonough"
        ],
        "program": "McDonough School of Business + comms/PR strength",
        "note": "Strong DC-area comms/PR and brand-marketing feeder."
      },
      {
        "canonical": "Ohio State University",
        "aliases": [
          "Fisher",
          "OSU",
          "Ohio State",
          "The Ohio State University",
          "tOSU"
        ],
        "program": "Fisher College of Business (marketing)",
        "note": "Large, well-recruited Midwest CPG/brand marketing program."
      },
      {
        "canonical": "Purdue University",
        "aliases": [
          "Daniels",
          "Daniels School of Business",
          "Krannert",
          "Mitch Daniels School",
          "Purdue",
          "Purdue West Lafayette"
        ],
        "program": "Mitch Daniels School of Business (marketing) + Brian Lamb School of Communication",
        "note": "Large STEM-heavy flagship with a well-recruited business/marketing program and strong analytics/marketing-technology pipeline into CPG and B2B tech."
      },
      {
        "canonical": "Syracuse University",
        "aliases": [
          "Cuse",
          "Newhouse",
          "SU",
          "Syracuse",
          "Syracuse Univ",
          "Whitman"
        ],
        "program": "S.I. Newhouse School of Public Communications",
        "note": "Premier dedicated PR/advertising/communications/content school — top target for comms and content roles."
      },
      {
        "canonical": "University of California, Los Angeles",
        "aliases": [
          "Anderson",
          "U.C.L.A.",
          "UC Los Angeles",
          "UC-LA",
          "UCLA",
          "University of California-Los Angeles"
        ],
        "note": "Strong LA media/entertainment + growth/tech-marketing generalist feeder."
      },
      {
        "canonical": "University of Florida",
        "aliases": [
          "Florida",
          "Gainesville",
          "Gators",
          "U of Florida",
          "UF",
          "UFlorida",
          "Univ of Florida",
          "Warrington"
        ],
        "program": "Warrington College of Business (marketing) + strong PR/advertising",
        "note": "US News top-10 undergrad marketing; strong advertising/PR and brand recruiting."
      },
      {
        "canonical": "University of Georgia",
        "aliases": [
          "Georgia",
          "Grady",
          "Terry",
          "U Georgia",
          "UGA"
        ],
        "program": "Terry (business) + Grady College (advertising/PR)",
        "note": "Grady is a top advertising/PR school; strong brand and comms recruiting."
      },
      {
        "canonical": "University of Iowa",
        "aliases": [
          "Hawkeyes",
          "Iowa",
          "The University of Iowa",
          "Tippie",
          "Tippie College of Business",
          "U Iowa",
          "U of Iowa",
          "UIowa"
        ],
        "program": "Tippie College of Business (marketing/sales) + School of Journalism & Mass Communication",
        "note": "Strong Big Ten business + journalism/strategic-comms feeder with deep Midwest CPG and B2B sales-and-marketing recruiting."
      },
      {
        "canonical": "University of Maryland",
        "aliases": [
          "Maryland",
          "Merrill",
          "Philip Merrill College",
          "Smith",
          "U of Maryland",
          "UMCP",
          "UMD",
          "University of Maryland College Park"
        ],
        "program": "Philip Merrill College of Journalism + Smith (business)",
        "note": "Merrill is a top-tier journalism/strategic-comms school and Smith a strong business feeder; promote-worthy on the comms axis. (NOTE: only add if not already deduped against the existing tier_3 Maryland entry — listed here as a tier_2 comms candidate.)"
      },
      {
        "canonical": "University of Missouri",
        "aliases": [
          "MU",
          "Missouri",
          "Missouri School of Journalism",
          "Mizzou",
          "Mizzou Journalism",
          "Trulaske",
          "U Missouri",
          "University of Missouri-Columbia"
        ],
        "program": "Missouri School of Journalism (advertising/strategic comms)",
        "note": "Oldest/most-storied journalism + strategic-communications school; strong content/PR feeder."
      },
      {
        "canonical": "University of North Carolina at Chapel Hill",
        "aliases": [
          "Carolina",
          "Chapel Hill",
          "Hussman",
          "Kenan-Flagler",
          "North Carolina",
          "UNC",
          "UNC Chapel Hill",
          "UNC-Chapel Hill"
        ],
        "program": "Kenan-Flagler (business) + Hussman (media & journalism)",
        "note": "Strong on both business-marketing and comms/PR axes."
      },
      {
        "canonical": "University of Notre Dame",
        "aliases": [
          "Mendoza",
          "ND",
          "Notre Dame",
          "Notre Dame Mendoza",
          "Notre Dame du Lac",
          "Univ of Notre Dame"
        ],
        "program": "Mendoza College of Business (marketing)",
        "note": "Highly-regarded undergrad business/marketing feeder."
      },
      {
        "canonical": "University of Texas at Austin",
        "aliases": [
          "McCombs",
          "Moody",
          "Texas",
          "UT",
          "UT Austin",
          "UT-Austin",
          "University of Texas",
          "University of Texas Austin"
        ],
        "program": "McCombs (business) + Moody College (advertising/PR/comms)",
        "note": "Top public business + a leading advertising/comms school; strong brand and tech-marketing pipeline."
      },
      {
        "canonical": "University of Wisconsin-Madison",
        "aliases": [
          "Madison",
          "U Wisconsin",
          "UW Madison",
          "UW-Madison",
          "UWisc",
          "University of Wisconsin",
          "University of Wisconsin Madison",
          "University of Wisconsin–Madison",
          "Wisconsin",
          "Wisconsin School of Business",
          "Wisconsin-Madison"
        ],
        "program": "Wisconsin School of Business (marketing)",
        "note": "Historically top undergrad marketing program with deep CPG brand recruiting."
      }
    ],
    "tier_3": [
      {
        "canonical": "American University",
        "aliases": [
          "AU",
          "American",
          "American U",
          "Kogod"
        ],
        "program": "School of Communication + Kogod (business)",
        "note": "DC communications/PR and political/brand comms feeder."
      },
      {
        "canonical": "Arizona State University",
        "aliases": [
          "ASU",
          "Arizona State",
          "Cronkite",
          "W. P. Carey",
          "W.P. Carey",
          "WP Carey"
        ],
        "program": "W. P. Carey (business) + Cronkite (journalism/comms)",
        "note": "Cronkite is a strong journalism/strategic-comms school; large marketing pipeline."
      },
      {
        "canonical": "Babson College",
        "aliases": [
          "Babson"
        ],
        "note": "Entrepreneurship-led; strong for startup/growth-marketing and brand-building roles."
      },
      {
        "canonical": "Baylor University",
        "aliases": [
          "Baylor",
          "Baylor ProSales",
          "Hankamer"
        ],
        "program": "Hankamer School of Business (marketing) + communication studies",
        "note": "Solid Texas private business/marketing program with strong regional CPG, retail, and sales recruiting."
      },
      {
        "canonical": "Bentley University",
        "aliases": [
          "Bentley",
          "Bentley College"
        ],
        "note": "Business-focused; solid marketing/marketing-analytics recruiting in the Northeast."
      },
      {
        "canonical": "Boston College",
        "aliases": [
          "BC",
          "Boston Coll",
          "Carroll"
        ],
        "program": "Carroll School of Management (marketing)",
        "note": "Well-regarded undergrad business/marketing feeder in the Northeast."
      },
      {
        "canonical": "California Polytechnic State University, San Luis Obispo",
        "aliases": [
          "CPSLO",
          "Cal Poly",
          "Cal Poly SLO",
          "Cal Poly San Luis Obispo",
          "California Polytechnic State University-San Luis Obispo"
        ],
        "program": "Orfalea College of Business (marketing) + Journalism",
        "note": "Hands-on California public with a strong marketing program and growing California tech/brand and growth-marketing recruiting."
      },
      {
        "canonical": "Clemson University",
        "aliases": [
          "CU",
          "Clemson"
        ],
        "program": "Wilbur O. and Ann Powers College of Business (marketing)",
        "note": "Southeast flagship with a solid marketing program and steady regional corporate and CPG recruiting."
      },
      {
        "canonical": "DePaul University",
        "aliases": [
          "DePaul",
          "Driehaus"
        ],
        "program": "Driehaus College of Business (marketing) + College of Communication",
        "note": "Chicago private with strong agency, advertising, and brand-marketing recruiting in the Midwest media market."
      },
      {
        "canonical": "Drexel University",
        "aliases": [
          "Drexel",
          "LeBow",
          "LeBow College of Business"
        ],
        "program": "LeBow College of Business (marketing)",
        "note": "Philadelphia co-op-driven business program with strong digital-marketing and brand internship-to-hire pipeline."
      },
      {
        "canonical": "Elon University",
        "aliases": [
          "Elon",
          "School of Communications"
        ],
        "program": "School of Communications + Love School of Business",
        "note": "Southeast private known for its communications/strategic-comms program and steady brand, PR, and agency recruiting."
      },
      {
        "canonical": "Florida State University",
        "aliases": [
          "FL State",
          "FSU",
          "Florida St",
          "Florida State",
          "Seminoles"
        ],
        "program": "College of Business (marketing) + College of Communication & Information",
        "note": "Large Florida flagship with strong advertising/integrated-marketing-communication and broad Southeast brand recruiting."
      },
      {
        "canonical": "Fordham University",
        "aliases": [
          "Fordham",
          "Gabelli",
          "Gabelli School of Business"
        ],
        "program": "Gabelli School of Business",
        "note": "NYC media/brand and marketing feeder."
      },
      {
        "canonical": "Hofstra University",
        "aliases": [
          "Hofstra",
          "Lawrence Herbert School"
        ],
        "program": "Lawrence Herbert School of Communication",
        "note": "Solid NYC-area communications/PR/advertising program."
      },
      {
        "canonical": "Iowa State University",
        "aliases": [
          "ISU",
          "ISU Ames",
          "Iowa St",
          "Iowa State",
          "Iowa State Univ",
          "Iowa State University of Science and Technology",
          "Ivy College of Business"
        ],
        "program": "Ivy College of Business (marketing) + Greenlee School of Journalism & Communication",
        "note": "Midwest flagship with a recognized advertising/PR program and ag/CPG-brand recruiting strength."
      },
      {
        "canonical": "Ithaca College",
        "aliases": [
          "Ithaca",
          "Park School",
          "Roy H. Park School"
        ],
        "program": "Roy H. Park School of Communications",
        "note": "Strong dedicated communications/media program; recognized feeder for content, PR, advertising, and media-marketing roles."
      },
      {
        "canonical": "James Madison University",
        "aliases": [
          "JMU",
          "James Madison"
        ],
        "program": "College of Business (marketing) + School of Media Arts & Design",
        "note": "Mid-Atlantic public with a well-recruited undergrad marketing program and solid DC-region corporate and brand recruiting."
      },
      {
        "canonical": "Loyola Marymount University",
        "aliases": [
          "LMU",
          "Loyola Marymount",
          "Loyola Marymount Univ"
        ],
        "program": "College of Business Administration + School of Film & Television / Communication",
        "note": "LA private with strong media/entertainment and brand-marketing ties in the Southern California market."
      },
      {
        "canonical": "Marquette University",
        "aliases": [
          "Diederich",
          "MU",
          "Marquette"
        ],
        "program": "College of Business Administration + Diederich College of Communication",
        "note": "Midwest private with a well-known advertising/PR program and steady Milwaukee/Chicago brand and agency recruiting."
      },
      {
        "canonical": "Michigan State University",
        "aliases": [
          "Broad",
          "Eli Broad",
          "MSU",
          "Mich State",
          "Michigan St",
          "Michigan State"
        ],
        "program": "Broad College of Business + College of Communication Arts",
        "note": "Strong advertising/PR and supply-chain-adjacent marketing recruiting."
      },
      {
        "canonical": "Northeastern University",
        "aliases": [
          "D'Amore-McKim",
          "NEU",
          "NU Boston",
          "Northeastern"
        ],
        "program": "D'Amore-McKim School of Business (marketing)",
        "note": "Boston co-op program with strong digital/growth-marketing and tech-brand recruiting via its experiential model."
      },
      {
        "canonical": "Pennsylvania State University",
        "aliases": [
          "PSU",
          "Penn St",
          "Penn State",
          "Penn State Smeal",
          "Penn State University",
          "Penn State University Park",
          "Pennsylvania State",
          "Smeal"
        ],
        "program": "Smeal College of Business + Bellisario (comms)",
        "note": "Large business + communications program with broad corporate recruiting."
      },
      {
        "canonical": "Pepperdine University",
        "aliases": [
          "Graziadio",
          "Pepperdine",
          "Seaver"
        ],
        "program": "Graziadio Business School (marketing)",
        "note": "Southern California business program with strong media/entertainment and brand-marketing ties in the LA market."
      },
      {
        "canonical": "Quinnipiac University",
        "aliases": [
          "QU",
          "Quinnipiac"
        ],
        "program": "School of Communications + School of Business (marketing)",
        "note": "Northeast private with a well-regarded communications/journalism program and steady regional brand and media recruiting."
      },
      {
        "canonical": "Rutgers University",
        "aliases": [
          "RU",
          "Rutgers",
          "Rutgers Business School",
          "Rutgers New Brunswick",
          "Rutgers University-New Brunswick",
          "Rutgers — New Brunswick",
          "Rutgers-New Brunswick"
        ],
        "program": "Rutgers Business School (marketing) + School of Communication & Information",
        "note": "Large NJ/NY-metro flagship with a deep marketing and pharma/consumer-brand recruiting base in the Northeast corridor."
      },
      {
        "canonical": "San Diego State University",
        "aliases": [
          "Aztecs",
          "Fowler",
          "SD State",
          "SDSU",
          "San Diego State"
        ],
        "program": "Fowler College of Business (marketing) + School of Journalism & Media Studies",
        "note": "Large California public with a solid marketing program and Southern-California brand, media, and agency recruiting."
      },
      {
        "canonical": "Southern Methodist University",
        "aliases": [
          "Cox",
          "Cox School of Business",
          "Lyle",
          "SMU",
          "Southern Methodist"
        ],
        "program": "Cox School of Business + Meadows (advertising/comms)",
        "note": "Dallas-area marketing/advertising and brand feeder."
      },
      {
        "canonical": "Temple University",
        "aliases": [
          "Fox",
          "Fox School",
          "Fox School of Business",
          "Klein",
          "TU",
          "Temple",
          "Tyler",
          "Tyler School of Art",
          "Tyler School of Art and Architecture"
        ],
        "program": "Fox School of Business (marketing) + Klein College of Media & Communication",
        "note": "Large Philadelphia public with strong advertising/PR (Klein) and a well-recruited marketing program."
      },
      {
        "canonical": "Texas A&M University",
        "aliases": [
          "A&M",
          "Aggies",
          "Mays",
          "Mays Business School",
          "TAMU",
          "Texas A&M",
          "Texas A&M University-College Station"
        ],
        "program": "Mays Business School (marketing)",
        "note": "Large, well-recruited business-marketing program."
      },
      {
        "canonical": "Texas Christian University",
        "aliases": [
          "Neeley",
          "TCU",
          "Texas Christian"
        ],
        "program": "Neeley School of Business + Bob Schieffer College of Communication",
        "note": "Well-regarded DFW business and a respected strategic-communication/advertising program with strong Texas brand recruiting."
      },
      {
        "canonical": "Tulane University",
        "aliases": [
          "A.B. Freeman",
          "Freeman",
          "Freeman School of Business",
          "Tulane"
        ],
        "program": "A. B. Freeman School of Business (marketing)",
        "note": "New Orleans private with a respected undergrad business/marketing program and Gulf-South corporate recruiting."
      },
      {
        "canonical": "University of Alabama",
        "aliases": [
          "Alabama",
          "Bama",
          "Culverhouse",
          "Roll Tide",
          "UA",
          "Univ of Alabama"
        ],
        "program": "Culverhouse College of Business + College of Communication & Information Sciences",
        "note": "Large flagship; nationally-known advertising/PR program and broad Southeast brand and corporate marketing recruiting."
      },
      {
        "canonical": "University of Arizona",
        "aliases": [
          "Arizona",
          "Eller",
          "U Arizona",
          "U of A",
          "UA",
          "UA Tucson",
          "UArizona"
        ],
        "program": "Eller College of Management (marketing) + School of Information / Communication",
        "note": "Southwest flagship with a strong marketing/MIS program and solid regional brand and analytics recruiting."
      },
      {
        "canonical": "University of Arkansas",
        "aliases": [
          "Arkansas",
          "Razorbacks",
          "U Arkansas",
          "U of A",
          "UARK",
          "Walton",
          "Walton College"
        ],
        "program": "Sam M. Walton College of Business (marketing/retail)",
        "note": "Home of Walmart-driven retail and CPG marketing recruiting; strong shopper/retail-marketing and vendor-side brand pipeline."
      },
      {
        "canonical": "University of California, Davis",
        "aliases": [
          "Davis",
          "UC Davis",
          "UC-Davis",
          "UCD",
          "University of California-Davis"
        ],
        "note": "Strong for CPG/food-and-beverage and ag-adjacent brand marketing."
      },
      {
        "canonical": "University of Colorado Boulder",
        "aliases": [
          "Boulder",
          "CU",
          "CU Boulder",
          "CU-Boulder",
          "Colorado",
          "Colorado Boulder",
          "Leeds",
          "Leeds School of Business",
          "UC Boulder",
          "University of Colorado",
          "University of Colorado-Boulder"
        ],
        "program": "Leeds School of Business + College of Media, Communication & Information",
        "note": "Mountain-West flagship with a respected advertising/strategic-comms program and growing tech/brand recruiting in Denver-Boulder."
      },
      {
        "canonical": "University of Connecticut",
        "aliases": [
          "Connecticut",
          "U Conn",
          "UCONN",
          "UConn",
          "UConn School of Business",
          "University of Connecticut Storrs"
        ],
        "program": "School of Business (marketing) + Communication",
        "note": "New England flagship with a solid undergrad marketing program and Northeast insurance/CPG/financial-services brand recruiting."
      },
      {
        "canonical": "University of Denver",
        "aliases": [
          "DU",
          "Daniels",
          "Daniels College of Business",
          "Denver",
          "U Denver"
        ],
        "program": "Daniels College of Business (marketing)",
        "note": "Rocky-Mountain private with a respected undergrad business/marketing program and Denver-region brand recruiting."
      },
      {
        "canonical": "University of Illinois Urbana-Champaign",
        "aliases": [
          "Gies",
          "Illinois",
          "Illinois Urbana-Champaign",
          "U of I",
          "UIUC",
          "University of Illinois",
          "University of Illinois at Urbana-Champaign"
        ],
        "program": "Gies College of Business + College of Media",
        "note": "Solid business-marketing and advertising/media program."
      },
      {
        "canonical": "University of Kansas",
        "aliases": [
          "Jayhawks",
          "KU",
          "Kansas",
          "U Kansas",
          "U of Kansas",
          "University of Kansas Lawrence",
          "William Allen White School"
        ],
        "program": "William Allen White School of Journalism & Mass Communications (strategic comms/advertising) + business",
        "note": "Storied journalism/strategic-communications school with a strong advertising and integrated-marketing-comms pipeline."
      },
      {
        "canonical": "University of Miami",
        "aliases": [
          "Herbert",
          "Herbert Business School",
          "Miami",
          "Miami FL",
          "The U",
          "U Miami",
          "UM",
          "UMiami"
        ],
        "program": "Herbert Business School + School of Communication",
        "note": "Rising business + strong communications/media program; Latin-American brand reach."
      },
      {
        "canonical": "University of Minnesota",
        "aliases": [
          "Carlson",
          "Minnesota",
          "Minnesota Twin Cities",
          "U Minnesota",
          "U of M",
          "U of M Minnesota",
          "U of M Twin Cities",
          "UMN",
          "University of Minnesota Twin Cities",
          "University of Minnesota-Twin Cities"
        ],
        "program": "Carlson School of Management",
        "note": "Strong Midwest CPG/brand-marketing recruiting (Target, General Mills, 3M)."
      },
      {
        "canonical": "University of Nebraska-Lincoln",
        "aliases": [
          "Cornhuskers",
          "Husker",
          "Huskers",
          "Nebraska",
          "Nebraska Lincoln",
          "Nebraska-Lincoln",
          "UNL",
          "University of Nebraska",
          "University of Nebraska–Lincoln"
        ],
        "program": "College of Business (marketing) + College of Journalism & Mass Communications",
        "note": "Big Ten flagship with strong advertising/PR and a steady Midwest CPG, ag-brand, and insurance recruiting base."
      },
      {
        "canonical": "University of Oklahoma",
        "aliases": [
          "Gaylord",
          "OU",
          "Oklahoma",
          "Price",
          "Price College",
          "Price College of Business",
          "Sooners",
          "U Oklahoma"
        ],
        "program": "Gaylord College of Journalism & Mass Communication + Price College of Business",
        "note": "Well-known journalism/advertising/PR program (Gaylord) with a solid undergrad marketing pipeline in the Southwest."
      },
      {
        "canonical": "University of Oregon",
        "aliases": [
          "Lundquist",
          "Oregon",
          "SOJC",
          "U Oregon",
          "U of O",
          "UO"
        ],
        "program": "School of Journalism & Communication (advertising)",
        "note": "Notable advertising/strategic-communications program (Nike/PNW brand ties)."
      },
      {
        "canonical": "University of Pittsburgh",
        "aliases": [
          "College of Business Administration",
          "Katz",
          "Pitt",
          "Pittsburgh",
          "U Pitt",
          "U Pittsburgh",
          "UPitt",
          "University of Pittsburgh Pittsburgh"
        ],
        "program": "Joseph M. Katz Graduate School / College of Business Administration (marketing)",
        "note": "Well-recruited Northeast business/marketing program with strong B2B and healthcare-marketing ties in the Pittsburgh corporate corridor."
      },
      {
        "canonical": "University of South Carolina",
        "aliases": [
          "Darla Moore",
          "Darla Moore School",
          "Gamecocks",
          "Moore School",
          "South Carolina",
          "USC Columbia",
          "USCarolina",
          "UofSC"
        ],
        "program": "Darla Moore School of Business (marketing/international business)",
        "note": "Top-ranked international-business and a solid marketing program; strong Southeast brand and corporate recruiting."
      },
      {
        "canonical": "University of Tennessee",
        "aliases": [
          "Haslam",
          "Rocky Top",
          "Tennessee",
          "U Tennessee",
          "UT Knoxville",
          "UTK",
          "University of Tennessee Knoxville",
          "University of Tennessee-Knoxville",
          "Vols"
        ],
        "program": "Haslam College of Business (marketing) + College of Communication & Information",
        "note": "Large flagship with a well-regarded marketing/supply-chain program and strong advertising/PR and Southeast CPG recruiting."
      },
      {
        "canonical": "University of Washington",
        "aliases": [
          "Foster",
          "U Dub",
          "U Washington",
          "U-Dub",
          "UDub",
          "UW",
          "UW Seattle",
          "University of Washington Seattle",
          "University of Washington-Seattle",
          "Washington"
        ],
        "program": "Foster School of Business + Communication",
        "note": "Seattle tech/brand and growth-marketing feeder (Amazon, Microsoft, Starbucks)."
      },
      {
        "canonical": "Villanova University",
        "aliases": [
          "Nova",
          "VSB",
          "Villanova",
          "Villanova School of Business"
        ],
        "program": "Villanova School of Business (marketing)",
        "note": "Strong Northeast undergrad business/marketing recruiting."
      },
      {
        "canonical": "Washington State University",
        "aliases": [
          "Carson",
          "Cougars",
          "Edward R. Murrow College",
          "Murrow",
          "WSU",
          "Washington State",
          "Wazzu"
        ],
        "program": "Edward R. Murrow College of Communication + Carson College of Business",
        "note": "Home of the Murrow communications school; strong advertising/PR/strategic-comms and PNW brand recruiting."
      }
    ]
  },
  "product_management": {
    "tier_1": [
      {
        "canonical": "California Institute of Technology",
        "aliases": [
          "CIT",
          "Caltech"
        ],
        "note": "Part of West Coast Caltech/Stanford/Berkeley big-tech cluster"
      },
      {
        "canonical": "Carnegie Mellon University",
        "aliases": [
          "C.M.U.",
          "CMU",
          "Carnegie Mellon",
          "Tepper"
        ],
        "program": "School of Computer Science / HCII / MSPM (Tepper+SCS)",
        "note": "Cornerstone Meta/big-tech pipeline; HCII and MSPM are dedicated PM/HCI feeders"
      },
      {
        "canonical": "Georgia Institute of Technology",
        "aliases": [
          "GT",
          "GaTech",
          "Georgia Tech",
          "Georgia Tech (GA Tech)"
        ],
        "note": "Major East Coast big-tech/Meta CS feeder; strong technical PM"
      },
      {
        "canonical": "Harvard University",
        "aliases": [
          "Harvard",
          "Harvard College",
          "Harvard Univ"
        ],
        "note": "Elite generalist + HBS; strong analytical/leadership PM signal"
      },
      {
        "canonical": "Massachusetts Institute of Technology",
        "aliases": [
          "M.I.T.",
          "MIT",
          "MIT Sloan",
          "Sloan"
        ],
        "note": "Elite CS/EECS + Sloan; strong technical-PM signal"
      },
      {
        "canonical": "Princeton University",
        "aliases": [
          "Princeton"
        ],
        "note": "Elite CS + generalist prestige; common APM feeder"
      },
      {
        "canonical": "Stanford University",
        "aliases": [
          "Stanford",
          "Stanford Univ"
        ],
        "note": "Top APM/RPM feeder; CS + GSB + d.school; dominant in big-tech PM rosters"
      },
      {
        "canonical": "University of California, Berkeley",
        "aliases": [
          "Berkeley",
          "Cal",
          "Haas",
          "UC Berkeley",
          "UC-Berkeley",
          "UCB",
          "University of California-Berkeley"
        ],
        "note": "Top CS + Haas; heavy Google/Meta APM feeder"
      },
      {
        "canonical": "University of California, Los Angeles",
        "aliases": [
          "Anderson",
          "U.C.L.A.",
          "UC Los Angeles",
          "UC-LA",
          "UCLA",
          "University of California-Los Angeles"
        ],
        "note": "Top employers Google/Meta/Amazon; strong CS + analytical PM feeder"
      },
      {
        "canonical": "University of Pennsylvania",
        "aliases": [
          "Annenberg",
          "Penn",
          "U Penn",
          "U. Penn",
          "UPenn",
          "Wharton",
          "Wharton School"
        ],
        "program": "Wharton (+ M&T / CIS)",
        "note": "Wharton business rigor + M&T dual-degree is a premier PM signal"
      },
      {
        "canonical": "Yale University",
        "aliases": [
          "Yale"
        ],
        "note": "Elite generalist prestige; well-recruited for PM"
      }
    ],
    "tier_2": [
      {
        "canonical": "Brown University",
        "aliases": [
          "Brown"
        ],
        "note": "Strong CS + Ivy prestige"
      },
      {
        "canonical": "Columbia University",
        "aliases": [
          "CU",
          "Columbia",
          "Columbia Univ"
        ],
        "note": "Elite CS + NYC tech/finance PM recruiting"
      },
      {
        "canonical": "Cornell University",
        "aliases": [
          "Cornell",
          "Cornell Dyson",
          "Dyson",
          "Johnson",
          "SC Johnson"
        ],
        "note": "Ivy CS + engineering; common APM feeder"
      },
      {
        "canonical": "Dartmouth College",
        "aliases": [
          "Dartmouth"
        ],
        "note": "Elite generalist + Tuck; solid PM signal"
      },
      {
        "canonical": "Duke University",
        "aliases": [
          "Duke"
        ],
        "note": "Strong analytical/CS + Fuqua; well-recruited PM"
      },
      {
        "canonical": "New York University",
        "aliases": [
          "N.Y.U.",
          "NYU",
          "NYU Stern",
          "Stern"
        ],
        "program": "Stern / Courant CS",
        "note": "Stern + CS; strong NYC tech/finance PM recruiting"
      },
      {
        "canonical": "Northwestern University",
        "aliases": [
          "Kellogg",
          "Medill",
          "NU",
          "Northwestern"
        ],
        "program": "Kellogg / McCormick (MMM, MBAi)",
        "note": "Kellogg + engineering combo strong for PM"
      },
      {
        "canonical": "Purdue University",
        "aliases": [
          "Daniels",
          "Daniels School of Business",
          "Krannert",
          "Mitch Daniels School",
          "Purdue",
          "Purdue West Lafayette"
        ],
        "program": "CS / Engineering",
        "note": "Large strong engineering/CS; well-recruited technical PM"
      },
      {
        "canonical": "Rice University",
        "aliases": [
          "Rice"
        ],
        "note": "Elite small private; strong CS/engineering PM signal"
      },
      {
        "canonical": "University of California, San Diego",
        "aliases": [
          "UC San Diego",
          "UC-San Diego",
          "UCSD",
          "University of California-San Diego"
        ],
        "program": "CSE",
        "note": "Strong public CS; West Coast tech feeder"
      },
      {
        "canonical": "University of Chicago",
        "aliases": [
          "Chicago",
          "U Chicago",
          "U of C",
          "U. of Chicago",
          "UChicago"
        ],
        "program": "Booth",
        "note": "Elite analytical/quant; Booth strong for data/strategy PM"
      },
      {
        "canonical": "University of Illinois Urbana-Champaign",
        "aliases": [
          "Gies",
          "Illinois",
          "Illinois Urbana-Champaign",
          "U of I",
          "UIUC",
          "University of Illinois",
          "University of Illinois at Urbana-Champaign"
        ],
        "program": "Grainger CS",
        "note": "Top public CS; heavily recruited for technical PM"
      },
      {
        "canonical": "University of Michigan",
        "aliases": [
          "Michigan",
          "Michigan Ann Arbor",
          "Michigan Ross",
          "Ross",
          "U Michigan",
          "U of M",
          "U-M",
          "UMich",
          "University of Michigan Ann Arbor",
          "University of Michigan-Ann Arbor"
        ],
        "program": "Ross / CSE",
        "note": "Ross business + strong CS; reliable PM placement"
      },
      {
        "canonical": "University of North Carolina at Chapel Hill",
        "aliases": [
          "Carolina",
          "Chapel Hill",
          "Hussman",
          "Kenan-Flagler",
          "North Carolina",
          "UNC",
          "UNC Chapel Hill",
          "UNC-Chapel Hill"
        ],
        "program": "Kenan-Flagler / CS",
        "note": "Strong business + CS; solid PM recruiting"
      },
      {
        "canonical": "University of Southern California",
        "aliases": [
          "Annenberg",
          "Leventhal",
          "Marshall",
          "Southern Cal",
          "Southern California",
          "U.S.C.",
          "USC",
          "USC Leventhal",
          "USC Marshall"
        ],
        "program": "Viterbi / Marshall",
        "note": "Large LA tech feeder; strong CS + business"
      },
      {
        "canonical": "University of Texas at Austin",
        "aliases": [
          "McCombs",
          "Moody",
          "Texas",
          "UT",
          "UT Austin",
          "UT-Austin",
          "University of Texas",
          "University of Texas Austin"
        ],
        "program": "McCombs / CS",
        "note": "Large strong CS + business; major Austin/big-tech feeder"
      },
      {
        "canonical": "University of Texas at Dallas",
        "aliases": [
          "Naveen Jindal",
          "UT Dallas",
          "UT-Dallas",
          "UTD",
          "University of Texas-Dallas"
        ],
        "program": "Jindal School of Management / CS",
        "note": "Strong analytics/CS + business; major Texas tech and product feeder"
      },
      {
        "canonical": "University of Virginia",
        "aliases": [
          "McIntire",
          "U Va",
          "U-Va",
          "U.Va.",
          "UVA",
          "University of Virginia Charlottesville",
          "Virginia"
        ],
        "program": "McIntire / CS",
        "note": "Strong business + analytical; well-recruited"
      },
      {
        "canonical": "University of Washington",
        "aliases": [
          "Foster",
          "U Dub",
          "U Washington",
          "U-Dub",
          "UDub",
          "UW",
          "UW Seattle",
          "University of Washington Seattle",
          "University of Washington-Seattle",
          "Washington"
        ],
        "program": "Paul G. Allen School of CS",
        "note": "Top CS in a major tech hub (Amazon/Microsoft); strong technical PM"
      },
      {
        "canonical": "University of Waterloo",
        "aliases": [
          "U Waterloo",
          "UW Waterloo",
          "UWaterloo",
          "Waterloo"
        ],
        "note": "Canadian, not US — but US tech employers recruit it extremely heavily for PM/SWE; flag as positive on a US-focused résumé"
      },
      {
        "canonical": "University of Wisconsin-Madison",
        "aliases": [
          "Madison",
          "U Wisconsin",
          "UW Madison",
          "UW-Madison",
          "UWisc",
          "University of Wisconsin",
          "University of Wisconsin Madison",
          "University of Wisconsin–Madison",
          "Wisconsin",
          "Wisconsin School of Business",
          "Wisconsin-Madison"
        ],
        "note": "Strong public CS + business feeder"
      },
      {
        "canonical": "University of Wisconsin-Madison School of Business",
        "aliases": [
          "Wisconsin Business"
        ],
        "program": "Bachelor of Business Administration",
        "note": "Placeholder removed — see note"
      }
    ],
    "tier_3": [
      {
        "canonical": "American University",
        "aliases": [
          "AU",
          "American",
          "American U",
          "Kogod"
        ],
        "program": "Kogod School of Business",
        "note": "Solid business/analytical signal, DC"
      },
      {
        "canonical": "Arizona State University",
        "aliases": [
          "ASU",
          "Arizona State",
          "Cronkite",
          "W. P. Carey",
          "W.P. Carey",
          "WP Carey"
        ],
        "program": "Barrett Honors / Ira A. Fulton Engineering",
        "note": "Large CS/engineering feeder; Barrett honors a positive signal"
      },
      {
        "canonical": "Auburn University",
        "aliases": [
          "AU",
          "Auburn",
          "Auburn Univ",
          "Harbert"
        ],
        "program": "Harbert College of Business / Engineering",
        "note": "Solid public engineering + business feeder, Southeast"
      },
      {
        "canonical": "Babson College",
        "aliases": [
          "Babson"
        ],
        "program": "Entrepreneurship / Business",
        "note": "Premier entrepreneurship/business program; recognized startup-PM signal"
      },
      {
        "canonical": "Baylor University",
        "aliases": [
          "Baylor",
          "Baylor ProSales",
          "Hankamer"
        ],
        "program": "Hankamer School of Business",
        "note": "Solid business/analytical feeder, Texas"
      },
      {
        "canonical": "Bentley University",
        "aliases": [
          "Bentley",
          "Bentley College"
        ],
        "program": "Business + Information Design / IT",
        "note": "Business-and-tech focused; recognized Boston-area analytical PM feeder"
      },
      {
        "canonical": "Binghamton University",
        "aliases": [
          "BU SUNY",
          "Binghamton",
          "SUNY Binghamton",
          "State University of New York at Binghamton"
        ],
        "program": "Watson Engineering / School of Management",
        "note": "Selective SUNY CS + business feeder; solid analytical PM signal"
      },
      {
        "canonical": "Boston College",
        "aliases": [
          "BC",
          "Boston Coll",
          "Carroll"
        ],
        "note": "Strong analytical/business signal, Boston-area"
      },
      {
        "canonical": "Boston University",
        "aliases": [
          "BU",
          "Boston U",
          "Boston Univ",
          "Questrom"
        ],
        "note": "Strong Boston-area CS/business PM feeder"
      },
      {
        "canonical": "Brigham Young University",
        "aliases": [
          "BYU",
          "BYU Provo",
          "Brigham Young",
          "Marriott",
          "Marriott School"
        ],
        "program": "Marriott School of Business / CS",
        "note": "Strong Marriott business + CS; recognized Silicon Slopes PM feeder"
      },
      {
        "canonical": "Bryant University",
        "aliases": [
          "Bryant",
          "Bryant University Sales Institute"
        ],
        "program": "Business / Information Systems",
        "note": "Solid business/analytics signal, New England"
      },
      {
        "canonical": "California Polytechnic State University, San Luis Obispo",
        "aliases": [
          "CPSLO",
          "Cal Poly",
          "Cal Poly SLO",
          "Cal Poly San Luis Obispo",
          "California Polytechnic State University-San Luis Obispo"
        ],
        "program": "CS / Orfalea College of Business",
        "note": "Strong learn-by-doing CS + business; well-recruited California tech feeder"
      },
      {
        "canonical": "California State University, Fullerton",
        "aliases": [
          "CSU Fullerton",
          "CSUF",
          "Cal State Fullerton",
          "Fullerton"
        ],
        "program": "CS / Mihaylo College of Business",
        "note": "Large SoCal CS + business feeder; recognized regional signal"
      },
      {
        "canonical": "Case Western Reserve University",
        "aliases": [
          "CWRU",
          "Case",
          "Case Western",
          "Weatherhead"
        ],
        "program": "CS / Weatherhead School of Management",
        "note": "Strong technical CS + Weatherhead business; recognized analytical signal"
      },
      {
        "canonical": "Clemson University",
        "aliases": [
          "CU",
          "Clemson"
        ],
        "program": "CS / Wilbur O. and Ann Powers College of Business",
        "note": "Strong public engineering/CS feeder, Southeast tech"
      },
      {
        "canonical": "Colorado State University",
        "aliases": [
          "CSU",
          "CSU Fort Collins",
          "Colorado State"
        ],
        "program": "College of Business / CS",
        "note": "Solid public business + CS feeder, Colorado tech"
      },
      {
        "canonical": "DePaul University",
        "aliases": [
          "DePaul",
          "Driehaus"
        ],
        "program": "CDM (Computing) / Driehaus College of Business",
        "note": "Strong computing + business in Chicago; recognized regional PM feeder"
      },
      {
        "canonical": "Drexel University",
        "aliases": [
          "Drexel",
          "LeBow",
          "LeBow College of Business"
        ],
        "program": "LeBow / CCI",
        "note": "Co-op pipeline into tech/product roles, Philadelphia"
      },
      {
        "canonical": "Emory University",
        "aliases": [
          "Emory",
          "Goizueta"
        ],
        "program": "Goizueta",
        "note": "Strong business/analytical signal"
      },
      {
        "canonical": "Florida State University",
        "aliases": [
          "FL State",
          "FSU",
          "Florida St",
          "Florida State",
          "Seminoles"
        ],
        "program": "College of Business / CS",
        "note": "Large public business + CS feeder, Southeast"
      },
      {
        "canonical": "Fordham University",
        "aliases": [
          "Fordham",
          "Gabelli",
          "Gabelli School of Business"
        ],
        "program": "Gabelli School of Business",
        "note": "Solid business/analytical signal, NYC tech and finance"
      },
      {
        "canonical": "George Washington University",
        "aliases": [
          "GW",
          "GW University",
          "GWU",
          "George Washington"
        ],
        "program": "School of Business / SEAS",
        "note": "Solid business/analytical signal; DC tech and product feeder"
      },
      {
        "canonical": "Georgetown University",
        "aliases": [
          "GU",
          "Georgetown",
          "Georgetown McDonough",
          "McDonough"
        ],
        "program": "McDonough",
        "note": "Strong business/analytical, DC tech"
      },
      {
        "canonical": "Indiana University Bloomington",
        "aliases": [
          "IU",
          "IU Bloomington",
          "Indiana",
          "Indiana Bloomington",
          "Indiana University",
          "Kelley",
          "Kelley School of Business"
        ],
        "program": "Kelley",
        "note": "Kelley business + informatics; solid PM signal"
      },
      {
        "canonical": "Iowa State University",
        "aliases": [
          "ISU",
          "ISU Ames",
          "Iowa St",
          "Iowa State",
          "Iowa State Univ",
          "Iowa State University of Science and Technology",
          "Ivy College of Business"
        ],
        "program": "CS / Ivy College of Business",
        "note": "Strong public engineering/CS feeder; recognized Midwest signal"
      },
      {
        "canonical": "Lehigh University",
        "aliases": [
          "College of Business",
          "Lehigh"
        ],
        "program": "College of Business / CSE",
        "note": "Strong engineering/CS + business; recognized technical-PM signal"
      },
      {
        "canonical": "Louisiana State University",
        "aliases": [
          "E. J. Ourso",
          "LSU",
          "Louisiana State",
          "Ourso"
        ],
        "program": "E. J. Ourso College of Business",
        "note": "Solid public business/CS feeder, Gulf South"
      },
      {
        "canonical": "Loyola Marymount University",
        "aliases": [
          "LMU",
          "Loyola Marymount",
          "Loyola Marymount Univ"
        ],
        "program": "College of Business Administration / CS",
        "note": "Solid LA business + CS feeder; recognized regional signal"
      },
      {
        "canonical": "Marquette University",
        "aliases": [
          "Diederich",
          "MU",
          "Marquette"
        ],
        "program": "College of Business Administration / CS",
        "note": "Solid business + CS feeder, Midwest"
      },
      {
        "canonical": "Michigan State University",
        "aliases": [
          "Broad",
          "Eli Broad",
          "MSU",
          "Mich State",
          "Michigan St",
          "Michigan State"
        ],
        "program": "Broad / CSE",
        "note": "Large public CS + Broad business; recognized Midwest PM feeder"
      },
      {
        "canonical": "North Carolina State University",
        "aliases": [
          "N.C. State",
          "NC State",
          "NC State University",
          "NCSU",
          "North Carolina State",
          "Poole"
        ],
        "program": "CS / Poole College of Management",
        "note": "Strong public CS in the Research Triangle; recognized technical-PM feeder"
      },
      {
        "canonical": "Northeastern University",
        "aliases": [
          "D'Amore-McKim",
          "NEU",
          "NU Boston",
          "Northeastern"
        ],
        "note": "Co-op pipeline into tech PM/SWE roles"
      },
      {
        "canonical": "Oregon State University",
        "aliases": [
          "OSU",
          "OSU Corvallis",
          "Oregon St",
          "Oregon State",
          "OregonState"
        ],
        "program": "EECS / College of Business",
        "note": "Strong public CS/engineering feeder, Pacific Northwest"
      },
      {
        "canonical": "Pennsylvania State University",
        "aliases": [
          "PSU",
          "Penn St",
          "Penn State",
          "Penn State Smeal",
          "Penn State University",
          "Penn State University Park",
          "Pennsylvania State",
          "Smeal"
        ],
        "note": "Large strong public engineering/business feeder"
      },
      {
        "canonical": "Pepperdine University",
        "aliases": [
          "Graziadio",
          "Pepperdine",
          "Seaver"
        ],
        "program": "Graziadio Business School",
        "note": "Solid business/analytical signal, SoCal"
      },
      {
        "canonical": "Rensselaer Polytechnic Institute",
        "aliases": [
          "RPI",
          "Rensselaer",
          "Rensselaer Poly",
          "Rensselaer Polytechnic"
        ],
        "program": "CS / Lally School of Management",
        "note": "Strong technical CS/engineering + management; recognized technical-PM signal"
      },
      {
        "canonical": "Rutgers University",
        "aliases": [
          "RU",
          "Rutgers",
          "Rutgers Business School",
          "Rutgers New Brunswick",
          "Rutgers University-New Brunswick",
          "Rutgers — New Brunswick",
          "Rutgers-New Brunswick"
        ],
        "note": "Large public CS/business feeder, NY/NJ tech"
      },
      {
        "canonical": "San Diego State University",
        "aliases": [
          "Aztecs",
          "Fowler",
          "SD State",
          "SDSU",
          "San Diego State"
        ],
        "program": "Fowler College of Business / CS",
        "note": "Large SoCal business + CS feeder; recognized regional signal"
      },
      {
        "canonical": "San Jose State University",
        "aliases": [
          "SJ State",
          "SJSU",
          "San Jose State",
          "San José State University"
        ],
        "program": "CS / Lucas College of Business",
        "note": "Largest single supplier of grads to Silicon Valley tech; recognized PM/SWE feeder"
      },
      {
        "canonical": "Santa Clara University",
        "aliases": [
          "Leavey",
          "SCU",
          "Santa Clara"
        ],
        "program": "Leavey School of Business / CSE",
        "note": "Heart of Silicon Valley; strong Leavey business + CS PM feeder"
      },
      {
        "canonical": "Southern Methodist University",
        "aliases": [
          "Cox",
          "Cox School of Business",
          "Lyle",
          "SMU",
          "Southern Methodist"
        ],
        "program": "Cox School of Business / Lyle Engineering",
        "note": "Strong Cox business + CS; recognized Dallas tech feeder"
      },
      {
        "canonical": "Stevens Institute of Technology",
        "aliases": [
          "SIT",
          "Stevens",
          "Stevens Tech"
        ],
        "program": "CS / School of Business",
        "note": "Tech-focused CS + business near NYC; recognized technical-PM feeder"
      },
      {
        "canonical": "Stony Brook University",
        "aliases": [
          "SBU",
          "SUNY Stony Brook",
          "State University of New York at Stony Brook",
          "Stony Brook"
        ],
        "program": "CS / College of Business",
        "note": "Strong SUNY CS feeder near NYC tech; recognized technical-PM signal"
      },
      {
        "canonical": "Syracuse University",
        "aliases": [
          "Cuse",
          "Newhouse",
          "SU",
          "Syracuse",
          "Syracuse Univ",
          "Whitman"
        ],
        "program": "Whitman School of Management / iSchool",
        "note": "Whitman business + information school; recognized analytical PM signal"
      },
      {
        "canonical": "Temple University",
        "aliases": [
          "Fox",
          "Fox School",
          "Fox School of Business",
          "Klein",
          "TU",
          "Temple",
          "Tyler",
          "Tyler School of Art",
          "Tyler School of Art and Architecture"
        ],
        "program": "Fox School of Business / CS",
        "note": "Strong Fox business (MIS) + CS; recognized Philadelphia tech feeder"
      },
      {
        "canonical": "Texas A&M University",
        "aliases": [
          "A&M",
          "Aggies",
          "Mays",
          "Mays Business School",
          "TAMU",
          "Texas A&M",
          "Texas A&M University-College Station"
        ],
        "note": "Large engineering/CS feeder, Texas tech"
      },
      {
        "canonical": "Texas Christian University",
        "aliases": [
          "Neeley",
          "TCU",
          "Texas Christian"
        ],
        "program": "Neeley School of Business",
        "note": "Strong Neeley business signal; recognized Texas feeder"
      },
      {
        "canonical": "The Ohio State University",
        "aliases": [
          "OSU",
          "Ohio St",
          "Ohio State",
          "Ohio State University",
          "tOSU"
        ],
        "note": "Large public CS/business feeder"
      },
      {
        "canonical": "Tufts University",
        "aliases": [
          "Tufts"
        ],
        "program": "CS / Gordon Institute",
        "note": "Strong CS + analytical signal; recognized Boston-area PM feeder"
      },
      {
        "canonical": "University at Buffalo",
        "aliases": [
          "Buffalo",
          "SUNY Buffalo",
          "State University of New York at Buffalo",
          "UB",
          "University at Buffalo SUNY"
        ],
        "program": "CSE / School of Management",
        "note": "Large SUNY CS + management feeder; recognized positive signal"
      },
      {
        "canonical": "University of Alabama",
        "aliases": [
          "Alabama",
          "Bama",
          "Culverhouse",
          "Roll Tide",
          "UA",
          "Univ of Alabama"
        ],
        "program": "Culverhouse College of Business",
        "note": "Large Culverhouse business + CS; recognized Southeast feeder"
      },
      {
        "canonical": "University of Arizona",
        "aliases": [
          "Arizona",
          "Eller",
          "U Arizona",
          "U of A",
          "UA",
          "UA Tucson",
          "UArizona"
        ],
        "program": "Eller College of Management",
        "note": "Eller business (strong MIS) + CS; recognized analytical PM signal"
      },
      {
        "canonical": "University of California, Davis",
        "aliases": [
          "Davis",
          "UC Davis",
          "UC-Davis",
          "UCD",
          "University of California-Davis"
        ],
        "note": "Solid UC CS/analytical feeder"
      },
      {
        "canonical": "University of California, Irvine",
        "aliases": [
          "Irvine",
          "UC Irvine",
          "UC-Irvine",
          "UCI",
          "University of California-Irvine"
        ],
        "note": "Solid UC CS feeder, SoCal tech"
      },
      {
        "canonical": "University of California, Riverside",
        "aliases": [
          "Riverside",
          "UC Riverside",
          "UC-Riverside",
          "UCR",
          "University of California-Riverside"
        ],
        "program": "CSE / School of Business",
        "note": "Solid UC CS + business feeder, SoCal tech adjacency"
      },
      {
        "canonical": "University of California, Santa Barbara",
        "aliases": [
          "Santa Barbara",
          "UC Santa Barbara",
          "UC-Santa Barbara",
          "UCSB",
          "University of California-Santa Barbara"
        ],
        "note": "Solid UC CS/engineering signal"
      },
      {
        "canonical": "University of California, Santa Cruz",
        "aliases": [
          "Santa Cruz",
          "UC Santa Cruz",
          "UCSC",
          "University of California-Santa Cruz"
        ],
        "note": "Solid UC CS feeder near Silicon Valley"
      },
      {
        "canonical": "University of Central Florida",
        "aliases": [
          "Central Florida",
          "U Central Florida",
          "UCF"
        ],
        "program": "CS / College of Business",
        "note": "Very large CS feeder in Florida tech corridor; recognized regional signal"
      },
      {
        "canonical": "University of Colorado Boulder",
        "aliases": [
          "Boulder",
          "CU",
          "CU Boulder",
          "CU-Boulder",
          "Colorado",
          "Colorado Boulder",
          "Leeds",
          "Leeds School of Business",
          "UC Boulder",
          "University of Colorado",
          "University of Colorado-Boulder"
        ],
        "note": "Strong engineering/CS, Denver/Boulder tech"
      },
      {
        "canonical": "University of Connecticut",
        "aliases": [
          "Connecticut",
          "U Conn",
          "UCONN",
          "UConn",
          "UConn School of Business",
          "University of Connecticut Storrs"
        ],
        "program": "School of Business / CSE",
        "note": "Solid public CS + business feeder, Northeast tech corridor"
      },
      {
        "canonical": "University of Delaware",
        "aliases": [
          "Delaware",
          "Lerner",
          "U Delaware",
          "UD",
          "UDel"
        ],
        "program": "Lerner College of Business / CIS",
        "note": "Solid business + CS feeder, Mid-Atlantic corridor"
      },
      {
        "canonical": "University of Denver",
        "aliases": [
          "DU",
          "Daniels",
          "Daniels College of Business",
          "Denver",
          "U Denver"
        ],
        "program": "Daniels College of Business",
        "note": "Solid Daniels business signal; recognized Denver tech feeder"
      },
      {
        "canonical": "University of Florida",
        "aliases": [
          "Florida",
          "Gainesville",
          "Gators",
          "U of Florida",
          "UF",
          "UFlorida",
          "Univ of Florida",
          "Warrington"
        ],
        "note": "Large strong public CS/business feeder"
      },
      {
        "canonical": "University of Georgia",
        "aliases": [
          "Georgia",
          "Grady",
          "Terry",
          "U Georgia",
          "UGA"
        ],
        "program": "Terry College of Business",
        "note": "Strong Terry business + CS; recognized Atlanta-adjacent tech signal"
      },
      {
        "canonical": "University of Houston",
        "aliases": [
          "Bauer",
          "C. T. Bauer",
          "Houston",
          "U Houston",
          "U of H",
          "UH"
        ],
        "program": "Bauer College of Business",
        "note": "Large Bauer business + CS; recognized Texas/energy-tech feeder"
      },
      {
        "canonical": "University of Iowa",
        "aliases": [
          "Hawkeyes",
          "Iowa",
          "The University of Iowa",
          "Tippie",
          "Tippie College of Business",
          "U Iowa",
          "U of Iowa",
          "UIowa"
        ],
        "program": "Tippie",
        "note": "Tippie business + CS; solid analytical/product signal"
      },
      {
        "canonical": "University of Kansas",
        "aliases": [
          "Jayhawks",
          "KU",
          "Kansas",
          "U Kansas",
          "U of Kansas",
          "University of Kansas Lawrence",
          "William Allen White School"
        ],
        "program": "School of Business / EECS",
        "note": "Solid public business + CS feeder, Midwest"
      },
      {
        "canonical": "University of Kentucky",
        "aliases": [
          "Gatton",
          "Kentucky",
          "U Kentucky",
          "UK"
        ],
        "program": "Gatton College of Business and Economics",
        "note": "Solid public business/analytical feeder, Southeast"
      },
      {
        "canonical": "University of Maryland, College Park",
        "aliases": [
          "Maryland",
          "Smith",
          "U Maryland",
          "UMCP",
          "UMD",
          "UMD College Park",
          "University of Maryland",
          "University of Maryland-College Park"
        ],
        "program": "CS / Smith",
        "note": "Strong public CS near DC tech corridor"
      },
      {
        "canonical": "University of Massachusetts Amherst",
        "aliases": [
          "Isenberg",
          "Massachusetts Amherst",
          "U Mass",
          "UMass",
          "UMass Amherst",
          "UMass-Amherst",
          "University of Massachusetts",
          "University of Massachusetts-Amherst"
        ],
        "program": "Manning CICS / Isenberg",
        "note": "Strong public CS (CICS) + Isenberg business; recognized New England PM feeder"
      },
      {
        "canonical": "University of Miami",
        "aliases": [
          "Herbert",
          "Herbert Business School",
          "Miami",
          "Miami FL",
          "The U",
          "U Miami",
          "UM",
          "UMiami"
        ],
        "program": "Miami Herbert Business School",
        "note": "Solid business/analytical signal; recognized Southeast feeder"
      },
      {
        "canonical": "University of Minnesota",
        "aliases": [
          "Carlson",
          "Minnesota",
          "Minnesota Twin Cities",
          "U Minnesota",
          "U of M",
          "U of M Minnesota",
          "U of M Twin Cities",
          "UMN",
          "University of Minnesota Twin Cities",
          "University of Minnesota-Twin Cities"
        ],
        "note": "Strong public CS/Carlson business feeder"
      },
      {
        "canonical": "University of Missouri",
        "aliases": [
          "MU",
          "Missouri",
          "Missouri School of Journalism",
          "Mizzou",
          "Mizzou Journalism",
          "Trulaske",
          "U Missouri",
          "University of Missouri-Columbia"
        ],
        "program": "Trulaske College of Business",
        "note": "Solid public business/CS feeder, Midwest"
      },
      {
        "canonical": "University of Nebraska-Lincoln",
        "aliases": [
          "Cornhuskers",
          "Husker",
          "Huskers",
          "Nebraska",
          "Nebraska Lincoln",
          "Nebraska-Lincoln",
          "UNL",
          "University of Nebraska",
          "University of Nebraska–Lincoln"
        ],
        "program": "College of Business / School of Computing",
        "note": "Solid public business + CS feeder, Midwest"
      },
      {
        "canonical": "University of Notre Dame",
        "aliases": [
          "Mendoza",
          "ND",
          "Notre Dame",
          "Notre Dame Mendoza",
          "Notre Dame du Lac",
          "Univ of Notre Dame"
        ],
        "program": "Mendoza",
        "note": "Strong business/analytical PM signal"
      },
      {
        "canonical": "University of Oklahoma",
        "aliases": [
          "Gaylord",
          "OU",
          "Oklahoma",
          "Price",
          "Price College",
          "Price College of Business",
          "Sooners",
          "U Oklahoma"
        ],
        "program": "Price College of Business / Gallogly Engineering",
        "note": "Solid public business + engineering feeder"
      },
      {
        "canonical": "University of Oregon",
        "aliases": [
          "Lundquist",
          "Oregon",
          "SOJC",
          "U Oregon",
          "U of O",
          "UO"
        ],
        "program": "Lundquist College of Business",
        "note": "Solid business/CS feeder, Pacific Northwest tech"
      },
      {
        "canonical": "University of Pittsburgh",
        "aliases": [
          "College of Business Administration",
          "Katz",
          "Pitt",
          "Pittsburgh",
          "U Pitt",
          "U Pittsburgh",
          "UPitt",
          "University of Pittsburgh Pittsburgh"
        ],
        "note": "Solid CS/business, Pittsburgh tech adjacency"
      },
      {
        "canonical": "University of Rochester",
        "aliases": [
          "Rochester",
          "Simon",
          "Simon Business School",
          "U Rochester",
          "U of R",
          "UR"
        ],
        "program": "Simon Business School / CS",
        "note": "Strong analytical/quant business + CS; recognized PM signal"
      },
      {
        "canonical": "University of San Francisco",
        "aliases": [
          "San Francisco",
          "USF",
          "USF San Francisco",
          "USFCA"
        ],
        "program": "School of Management / CS",
        "note": "SF-based business + CS feeder; recognized Bay Area regional signal"
      },
      {
        "canonical": "University of South Carolina",
        "aliases": [
          "Darla Moore",
          "Darla Moore School",
          "Gamecocks",
          "Moore School",
          "South Carolina",
          "USC Columbia",
          "USCarolina",
          "UofSC"
        ],
        "program": "Darla Moore School of Business",
        "note": "Solid business/analytical signal; recognized Southeast feeder"
      },
      {
        "canonical": "University of South Florida",
        "aliases": [
          "Muma",
          "South Florida",
          "U South Florida",
          "USF"
        ],
        "program": "Muma College of Business / CSE",
        "note": "Large public business + CS feeder, Tampa tech"
      },
      {
        "canonical": "University of Tennessee",
        "aliases": [
          "Haslam",
          "Rocky Top",
          "Tennessee",
          "U Tennessee",
          "UT Knoxville",
          "UTK",
          "University of Tennessee Knoxville",
          "University of Tennessee-Knoxville",
          "Vols"
        ],
        "program": "Haslam / Tickle EECS",
        "note": "Large public business + engineering; recognized Southeast PM feeder"
      },
      {
        "canonical": "University of Utah",
        "aliases": [
          "David Eccles",
          "Eccles",
          "The U",
          "The University of Utah",
          "U Utah",
          "U of U",
          "UU",
          "University of Utah Salt Lake",
          "UofU",
          "Utah",
          "Utah Salt Lake"
        ],
        "program": "Kahlert School of Computing / Eccles",
        "note": "Strong CS + Eccles business; recognized Salt Lake tech (Silicon Slopes) feeder"
      },
      {
        "canonical": "Vanderbilt University",
        "aliases": [
          "Owen",
          "Vanderbilt",
          "Vandy"
        ],
        "note": "Elite private; solid CS/business PM signal"
      },
      {
        "canonical": "Virginia Tech",
        "aliases": [
          "Pamplin",
          "VPI",
          "VT",
          "Virginia Polytechnic",
          "Virginia Polytechnic Institute and State University",
          "Virginia Tech University"
        ],
        "program": "CS / Pamplin College of Business",
        "note": "Large strong CS/engineering feeder; recognized DC/Mid-Atlantic tech signal"
      },
      {
        "canonical": "Washington University in St. Louis",
        "aliases": [
          "Olin",
          "Olin Business School",
          "WUSTL",
          "Wash U",
          "WashU",
          "Washington University"
        ],
        "program": "Olin / CS",
        "note": "Strong business + CS; solid PM feeder"
      },
      {
        "canonical": "Worcester Polytechnic Institute",
        "aliases": [
          "WPI",
          "Worcester Poly",
          "Worcester Polytechnic"
        ],
        "program": "CS / Business School",
        "note": "Project-based CS/engineering feeder, New England tech"
      }
    ]
  },
  "data_ml": {
    "tier_1": [
      {
        "canonical": "Carnegie Mellon University",
        "aliases": [
          "C.M.U.",
          "CMU",
          "Carnegie Mellon",
          "Tepper"
        ],
        "program": "School of Computer Science / Machine Learning Department",
        "note": "#1-tier in CSRankings AI; the single strongest ML/AI research brand. MLD, LTI (NLP), MCDS are premier DS/ML feeders."
      },
      {
        "canonical": "Georgia Institute of Technology",
        "aliases": [
          "GT",
          "GaTech",
          "Georgia Tech",
          "Georgia Tech (GA Tech)"
        ],
        "program": "College of Computing / ML@GT",
        "note": "Top-5 CSRankings AI; large ML and analytics (OMSA/ISyE) feeder."
      },
      {
        "canonical": "Massachusetts Institute of Technology",
        "aliases": [
          "M.I.T.",
          "MIT",
          "MIT Sloan",
          "Sloan"
        ],
        "program": "EECS / CSAIL",
        "note": "Top AI-lab and quant-DS feeder; CSAIL research depth."
      },
      {
        "canonical": "Princeton University",
        "aliases": [
          "Princeton"
        ],
        "program": "Computer Science (ML theory)",
        "note": "Weighs UP for data_ml vs general SWE — elite ML theory/research, strong AI-lab pipeline despite smaller program."
      },
      {
        "canonical": "Stanford University",
        "aliases": [
          "Stanford",
          "Stanford Univ"
        ],
        "program": "CS (AI Lab) + Statistics",
        "note": "Elite for both ML/AI (SAIL) and statistics; top source of AI-lab researchers and applied DS."
      },
      {
        "canonical": "University of California, Berkeley",
        "aliases": [
          "Berkeley",
          "Cal",
          "Haas",
          "UC Berkeley",
          "UC-Berkeley",
          "UCB",
          "University of California-Berkeley"
        ],
        "program": "EECS (BAIR) + Statistics",
        "note": "BAIR + #2 statistics dept; dual ML-research and analytics powerhouse."
      },
      {
        "canonical": "University of Illinois Urbana-Champaign",
        "aliases": [
          "Gies",
          "Illinois",
          "Illinois Urbana-Champaign",
          "U of I",
          "UIUC",
          "University of Illinois",
          "University of Illinois at Urbana-Champaign"
        ],
        "program": "Computer Science",
        "note": "#2 in 2025 CSRankings AI; deep ML/data-systems research pipeline."
      },
      {
        "canonical": "University of Michigan",
        "aliases": [
          "Michigan",
          "Michigan Ann Arbor",
          "Michigan Ross",
          "Ross",
          "U Michigan",
          "U of M",
          "U-M",
          "UMich",
          "University of Michigan Ann Arbor",
          "University of Michigan-Ann Arbor"
        ],
        "program": "CSE + Statistics",
        "note": "Top-10 CSRankings AI standout; strong ML research and applied-DS recruiting."
      },
      {
        "canonical": "University of Washington",
        "aliases": [
          "Foster",
          "U Dub",
          "U Washington",
          "U-Dub",
          "UDub",
          "UW",
          "UW Seattle",
          "University of Washington Seattle",
          "University of Washington-Seattle",
          "Washington"
        ],
        "program": "Allen School (CSE) + Statistics",
        "note": "Top CSRankings AI/NLP, strong statistics & biostatistics; major Seattle-tech DS/ML feeder."
      }
    ],
    "tier_2": [
      {
        "canonical": "California Institute of Technology",
        "aliases": [
          "CIT",
          "Caltech"
        ],
        "program": "Computing + Mathematical Sciences",
        "note": "Small but elite ML/theory and quant-DS pipeline."
      },
      {
        "canonical": "Columbia University",
        "aliases": [
          "CU",
          "Columbia",
          "Columbia Univ"
        ],
        "program": "CS + Statistics / Data Science Institute",
        "note": "Heavy NYC DS/quant recruiting; strong applied-DS and stats."
      },
      {
        "canonical": "Cornell Tech",
        "aliases": [
          "Cornell NYC Tech"
        ],
        "program": "Cornell Tech (applied ML/DS)",
        "note": "NYC applied-ML campus; strong industry DS placement."
      },
      {
        "canonical": "Cornell University",
        "aliases": [
          "Cornell",
          "Cornell Dyson",
          "Dyson",
          "Johnson",
          "SC Johnson"
        ],
        "program": "CS + Statistics & Data Science",
        "note": "Strong ML and stats; Cornell Tech adds applied-DS pipeline."
      },
      {
        "canonical": "Harvard University",
        "aliases": [
          "Harvard",
          "Harvard College",
          "Harvard Univ"
        ],
        "program": "Statistics / Biostatistics + SEAS",
        "note": "Tier earned mainly via elite statistics & biostatistics (analytics/DS) more than CS depth."
      },
      {
        "canonical": "New York University",
        "aliases": [
          "N.Y.U.",
          "NYU",
          "NYU Stern",
          "Stern"
        ],
        "program": "Courant / Center for Data Science",
        "note": "CDS (LeCun lineage) is a premier DS/ML feeder; strong NYC recruiting."
      },
      {
        "canonical": "Rice University",
        "aliases": [
          "Rice"
        ],
        "program": "Computer Science + Statistics",
        "note": "Strong CS (ML/scientific computing) and well-regarded statistics dept; punches above general SWE for data_ml in the Texas/energy-analytics market."
      },
      {
        "canonical": "Stony Brook University",
        "aliases": [
          "SBU",
          "SUNY Stony Brook",
          "State University of New York at Stony Brook",
          "Stony Brook"
        ],
        "program": "Computer Science + Applied Math & Statistics",
        "note": "Top-25 CSRankings AI (CV/ML research depth); AMS dept makes it a stronger data_ml signal than its general reputation."
      },
      {
        "canonical": "University of California, Los Angeles",
        "aliases": [
          "Anderson",
          "U.C.L.A.",
          "UC Los Angeles",
          "UC-LA",
          "UCLA",
          "University of California-Los Angeles"
        ],
        "program": "CS + Statistics & Data Science",
        "note": "Strong CV/ML research and statistics; large applied-DS pipeline."
      },
      {
        "canonical": "University of California, San Diego",
        "aliases": [
          "UC San Diego",
          "UC-San Diego",
          "UCSD",
          "University of California-San Diego"
        ],
        "program": "CSE / Halıcıoğlu Data Science Institute",
        "note": "Top-5 CSRankings AI; dedicated data science institute."
      },
      {
        "canonical": "University of California, Santa Barbara",
        "aliases": [
          "Santa Barbara",
          "UC Santa Barbara",
          "UC-Santa Barbara",
          "UCSB",
          "University of California-Santa Barbara"
        ],
        "program": "Computer Science (NLP/ML)",
        "note": "Notable CSRankings AI standing driven by NLP/ML groups; recognized California research-DS feeder."
      },
      {
        "canonical": "University of Chicago",
        "aliases": [
          "Chicago",
          "U Chicago",
          "U of C",
          "U. of Chicago",
          "UChicago"
        ],
        "program": "Statistics + CS / Data Science Institute",
        "note": "Elite statistics; strong for analytics/DS and quant roles."
      },
      {
        "canonical": "University of Maryland",
        "aliases": [
          "Maryland",
          "Merrill",
          "Philip Merrill College",
          "Smith",
          "U of Maryland",
          "UMCP",
          "UMD",
          "University of Maryland College Park"
        ],
        "program": "Computer Science",
        "note": "#3 CSRankings AI (NLP/CV strength); higher for data_ml than its general-SWE reputation."
      },
      {
        "canonical": "University of Massachusetts Amherst",
        "aliases": [
          "Isenberg",
          "Massachusetts Amherst",
          "U Mass",
          "UMass",
          "UMass Amherst",
          "UMass-Amherst",
          "University of Massachusetts",
          "University of Massachusetts-Amherst"
        ],
        "program": "College of Information & Computer Sciences",
        "note": "#11 CSRankings AI (IR/NLP/ML); punches well above general-SWE reputation for data_ml."
      },
      {
        "canonical": "University of Pennsylvania",
        "aliases": [
          "Annenberg",
          "Penn",
          "U Penn",
          "U. Penn",
          "UPenn",
          "Wharton",
          "Wharton School"
        ],
        "program": "CIS + Statistics (Wharton)",
        "note": "Strong ML and top statistics (Wharton); analytics + quant pipeline."
      },
      {
        "canonical": "University of Texas at Austin",
        "aliases": [
          "McCombs",
          "Moody",
          "Texas",
          "UT",
          "UT Austin",
          "UT-Austin",
          "University of Texas",
          "University of Texas Austin"
        ],
        "program": "Computer Science + Statistics & Data Sciences",
        "note": "Top CSRankings AI/ML research; large Texas-tech DS feeder."
      },
      {
        "canonical": "University of Toronto",
        "aliases": [
          "Toronto",
          "U of T",
          "UofT"
        ],
        "program": "CS / Vector Institute",
        "note": "Canadian — flagged for US-centric list; deep-learning birthplace (Hinton/Vector), heavily recruited by US AI labs."
      },
      {
        "canonical": "University of Wisconsin-Madison",
        "aliases": [
          "Madison",
          "U Wisconsin",
          "UW Madison",
          "UW-Madison",
          "UWisc",
          "University of Wisconsin",
          "University of Wisconsin Madison",
          "University of Wisconsin–Madison",
          "Wisconsin",
          "Wisconsin School of Business",
          "Wisconsin-Madison"
        ],
        "program": "Statistics + Computer Science",
        "note": "Up vs general SWE — top statistics dept + strong ML (optimization) research."
      }
    ],
    "tier_3": [
      {
        "canonical": "Arizona State University",
        "aliases": [
          "ASU",
          "Arizona State",
          "Cronkite",
          "W. P. Carey",
          "W.P. Carey",
          "WP Carey"
        ],
        "program": "CS / Data Science",
        "note": "#28 CSRankings AI; large-scale CS/DS programs."
      },
      {
        "canonical": "Boston University",
        "aliases": [
          "BU",
          "Boston U",
          "Boston Univ",
          "Questrom"
        ],
        "program": "Computer Science + Faculty of Computing & Data Sciences",
        "note": "New Faculty of Computing & Data Sciences plus solid CS/ML; recognized Boston-area DS feeder."
      },
      {
        "canonical": "Brown University",
        "aliases": [
          "Brown"
        ],
        "program": "CS + Data Science Initiative",
        "note": "Solid ML research; strong analytics/DS placement."
      },
      {
        "canonical": "Duke University",
        "aliases": [
          "Duke"
        ],
        "program": "Statistical Science + CS",
        "note": "Top statistics dept (Bayesian); strong DS/analytics signal."
      },
      {
        "canonical": "Indiana University Bloomington",
        "aliases": [
          "IU",
          "IU Bloomington",
          "Indiana",
          "Indiana Bloomington",
          "Indiana University",
          "Kelley",
          "Kelley School of Business"
        ],
        "program": "Luddy School of Informatics, Computing & Engineering",
        "note": "Large informatics/data-science school; recognized Midwest analytics/DS feeder."
      },
      {
        "canonical": "Iowa State University",
        "aliases": [
          "ISU",
          "ISU Ames",
          "Iowa St",
          "Iowa State",
          "Iowa State Univ",
          "Iowa State University of Science and Technology",
          "Ivy College of Business"
        ],
        "program": "Statistics + Computer Science",
        "note": "Historically elite statistics dept (land-grant stats heritage); solid Midwest data-science signal."
      },
      {
        "canonical": "Johns Hopkins University",
        "aliases": [
          "Hopkins",
          "JHU",
          "Johns Hopkins"
        ],
        "program": "CLSP (NLP) + Biostatistics",
        "note": "Top biostatistics and strong NLP (CLSP); strong for health-DS/analytics."
      },
      {
        "canonical": "Michigan State University",
        "aliases": [
          "Broad",
          "Eli Broad",
          "MSU",
          "Mich State",
          "Michigan St",
          "Michigan State"
        ],
        "program": "Computer Science & Engineering + Statistics",
        "note": "Strong CSE (CV/ML) research and large statistics dept; recognized Midwest DS/ML feeder."
      },
      {
        "canonical": "North Carolina State University",
        "aliases": [
          "N.C. State",
          "NC State",
          "NC State University",
          "NCSU",
          "North Carolina State",
          "Poole"
        ],
        "program": "Institute for Advanced Analytics / Statistics + CS",
        "note": "Pioneer MS in Analytics (Institute for Advanced Analytics) and top statistics dept; classic analytics/DS recruiting brand."
      },
      {
        "canonical": "Northeastern University",
        "aliases": [
          "D'Amore-McKim",
          "NEU",
          "NU Boston",
          "Northeastern"
        ],
        "program": "Khoury College of Computer Sciences",
        "note": "#24 CSRankings AI; co-op model = strong applied-DS placement."
      },
      {
        "canonical": "Northwestern University",
        "aliases": [
          "Kellogg",
          "Medill",
          "NU",
          "Northwestern"
        ],
        "program": "CS + Statistics & Data Science",
        "note": "Strong analytics/DS and ML; Chicago recruiting pipeline."
      },
      {
        "canonical": "Ohio State University",
        "aliases": [
          "Fisher",
          "OSU",
          "Ohio State",
          "The Ohio State University",
          "tOSU"
        ],
        "program": "CSE + Statistics",
        "note": "Large CS/stats research base; solid analytics pipeline."
      },
      {
        "canonical": "Pennsylvania State University",
        "aliases": [
          "PSU",
          "Penn St",
          "Penn State",
          "Penn State Smeal",
          "Penn State University",
          "Penn State University Park",
          "Pennsylvania State",
          "Smeal"
        ],
        "program": "Computer Science + Statistics",
        "note": "#22 CSRankings AI; broad CS/stats research."
      },
      {
        "canonical": "Purdue University",
        "aliases": [
          "Daniels",
          "Daniels School of Business",
          "Krannert",
          "Mitch Daniels School",
          "Purdue",
          "Purdue West Lafayette"
        ],
        "program": "Computer Science + Statistics",
        "note": "Large CS/stats research output; solid Midwest DS/ML feeder."
      },
      {
        "canonical": "Rensselaer Polytechnic Institute",
        "aliases": [
          "RPI",
          "Rensselaer",
          "Rensselaer Poly",
          "Rensselaer Polytechnic"
        ],
        "program": "Computer Science + Data Science",
        "note": "Strong technical CS/ML and IBM-AI ties; recognized data-science and analytics signal."
      },
      {
        "canonical": "Rutgers University",
        "aliases": [
          "RU",
          "Rutgers",
          "Rutgers Business School",
          "Rutgers New Brunswick",
          "Rutgers University-New Brunswick",
          "Rutgers — New Brunswick",
          "Rutgers-New Brunswick"
        ],
        "program": "CS + Statistics",
        "note": "Strong ML/data-mining research; NJ/NYC DS pipeline."
      },
      {
        "canonical": "Stevens Institute of Technology",
        "aliases": [
          "SIT",
          "Stevens",
          "Stevens Tech"
        ],
        "program": "Computer Science + Business Analytics & Data Science",
        "note": "Strong applied analytics/financial-DS programs near NYC; recognized industry-DS feeder."
      },
      {
        "canonical": "Texas A&M University",
        "aliases": [
          "A&M",
          "Aggies",
          "Mays",
          "Mays Business School",
          "TAMU",
          "Texas A&M",
          "Texas A&M University-College Station"
        ],
        "program": "CS + Statistics",
        "note": "#29 CSRankings AI; large statistics dept; solid Texas DS feeder."
      },
      {
        "canonical": "University of California, Davis",
        "aliases": [
          "Davis",
          "UC Davis",
          "UC-Davis",
          "UCD",
          "University of California-Davis"
        ],
        "program": "Computer Science + Statistics",
        "note": "Strong statistics dept and growing ML research; solid Northern California applied-DS feeder."
      },
      {
        "canonical": "University of California, Irvine",
        "aliases": [
          "Irvine",
          "UC Irvine",
          "UC-Irvine",
          "UCI",
          "University of California-Irvine"
        ],
        "program": "CS (ML/Bayesian) + Statistics",
        "note": "Notable ML/statistics research (UCI ML repository heritage)."
      },
      {
        "canonical": "University of California, Riverside",
        "aliases": [
          "Riverside",
          "UC Riverside",
          "UC-Riverside",
          "UCR",
          "University of California-Riverside"
        ],
        "program": "Computer Science & Engineering + Statistics",
        "note": "Active data-mining/ML research and a growing statistics dept; recognized California DS feeder."
      },
      {
        "canonical": "University of Colorado Boulder",
        "aliases": [
          "Boulder",
          "CU",
          "CU Boulder",
          "CU-Boulder",
          "Colorado",
          "Colorado Boulder",
          "Leeds",
          "Leeds School of Business",
          "UC Boulder",
          "University of Colorado",
          "University of Colorado-Boulder"
        ],
        "program": "Computer Science + Applied Mathematics",
        "note": "Solid CS/ML and applied-math research; recognized Mountain-West tech and analytics pipeline."
      },
      {
        "canonical": "University of Connecticut",
        "aliases": [
          "Connecticut",
          "U Conn",
          "UCONN",
          "UConn",
          "UConn School of Business",
          "University of Connecticut Storrs"
        ],
        "program": "Computer Science & Engineering + Statistics",
        "note": "Solid statistics dept and growing data-science programs; recognized Northeast DS feeder."
      },
      {
        "canonical": "University of Florida",
        "aliases": [
          "Florida",
          "Gainesville",
          "Gators",
          "U of Florida",
          "UF",
          "UFlorida",
          "Univ of Florida",
          "Warrington"
        ],
        "program": "Computer & Information Science + Statistics",
        "note": "Large CS/stats research base and HiPerGator AI computing; recognized Southeast DS/ML feeder."
      },
      {
        "canonical": "University of Iowa",
        "aliases": [
          "Hawkeyes",
          "Iowa",
          "The University of Iowa",
          "Tippie",
          "Tippie College of Business",
          "U Iowa",
          "U of Iowa",
          "UIowa"
        ],
        "program": "Statistics & Actuarial Science + Computer Science",
        "note": "Strong statistics/biostatistics heritage; solid Midwest analytics/DS signal."
      },
      {
        "canonical": "University of Minnesota",
        "aliases": [
          "Carlson",
          "Minnesota",
          "Minnesota Twin Cities",
          "U Minnesota",
          "U of M",
          "U of M Minnesota",
          "U of M Twin Cities",
          "UMN",
          "University of Minnesota Twin Cities",
          "University of Minnesota-Twin Cities"
        ],
        "program": "CS + Statistics",
        "note": "Strong stats/data-mining heritage; solid Midwest DS feeder."
      },
      {
        "canonical": "University of North Carolina at Chapel Hill",
        "aliases": [
          "Carolina",
          "Chapel Hill",
          "Hussman",
          "Kenan-Flagler",
          "North Carolina",
          "UNC",
          "UNC Chapel Hill",
          "UNC-Chapel Hill"
        ],
        "program": "Computer Science + Statistics & Operations Research",
        "note": "Strong statistics/biostatistics and CS; Research Triangle DS/analytics pipeline."
      },
      {
        "canonical": "University of Notre Dame",
        "aliases": [
          "Mendoza",
          "ND",
          "Notre Dame",
          "Notre Dame Mendoza",
          "Notre Dame du Lac",
          "Univ of Notre Dame"
        ],
        "program": "Computer Science & Engineering + Applied & Computational Math & Statistics",
        "note": "Solid CS/ML and ACMS statistics; recognized analytics/DS recruiting brand."
      },
      {
        "canonical": "University of Pittsburgh",
        "aliases": [
          "College of Business Administration",
          "Katz",
          "Pitt",
          "Pittsburgh",
          "U Pitt",
          "U Pittsburgh",
          "UPitt",
          "University of Pittsburgh Pittsburgh"
        ],
        "program": "Computer Science + Statistics",
        "note": "Solid CS/ML and biostatistics; strong health-DS pipeline alongside the Pittsburgh tech cluster."
      },
      {
        "canonical": "University of Rochester",
        "aliases": [
          "Rochester",
          "Simon",
          "Simon Business School",
          "U Rochester",
          "U of R",
          "UR"
        ],
        "program": "Computer Science (NLP/HLT) + Data Science Institute",
        "note": "Strong NLP/speech and a dedicated Goergen Institute for Data Science; recognized research-DS signal."
      },
      {
        "canonical": "University of Southern California",
        "aliases": [
          "Annenberg",
          "Leventhal",
          "Marshall",
          "Southern Cal",
          "Southern California",
          "U.S.C.",
          "USC",
          "USC Leventhal",
          "USC Marshall"
        ],
        "program": "CS (ISI) + Data Science",
        "note": "Large ML/NLP research (ISI); strong applied-DS volume."
      },
      {
        "canonical": "University of Texas at Dallas",
        "aliases": [
          "Naveen Jindal",
          "UT Dallas",
          "UT-Dallas",
          "UTD",
          "University of Texas-Dallas"
        ],
        "program": "CS + Data Science",
        "note": "Growing ML/DS research; solid Texas-tech pipeline."
      },
      {
        "canonical": "University of Utah",
        "aliases": [
          "David Eccles",
          "Eccles",
          "The U",
          "The University of Utah",
          "U Utah",
          "U of U",
          "UU",
          "University of Utah Salt Lake",
          "UofU",
          "Utah",
          "Utah Salt Lake"
        ],
        "program": "Kahlert School of Computing + Data Science",
        "note": "Strong scientific-computing/visualization and ML research; recognized Mountain-West DS/ML signal."
      },
      {
        "canonical": "University of Virginia",
        "aliases": [
          "McIntire",
          "U Va",
          "U-Va",
          "U.Va.",
          "UVA",
          "University of Virginia Charlottesville",
          "Virginia"
        ],
        "program": "Computer Science + School of Data Science",
        "note": "Dedicated School of Data Science and solid CS; recognized analytics/DS signal in the DC corridor."
      },
      {
        "canonical": "University of Waterloo",
        "aliases": [
          "U Waterloo",
          "UW Waterloo",
          "UWaterloo",
          "Waterloo"
        ],
        "program": "Statistics & Actuarial Science + CS",
        "note": "Canadian — flagged for US-centric list. Heavily US-recruited co-op feeder; very strong for SWE, still a positive (slightly weaker differentiator) for research-DS/ML."
      },
      {
        "canonical": "Vanderbilt University",
        "aliases": [
          "Owen",
          "Vanderbilt",
          "Vandy"
        ],
        "program": "Computer Science + Data Science Institute",
        "note": "Growing ML/health-DS research and a Data Science Institute; recognized Southeast analytics signal."
      },
      {
        "canonical": "Virginia Tech",
        "aliases": [
          "Pamplin",
          "VPI",
          "VT",
          "Virginia Polytechnic",
          "Virginia Polytechnic Institute and State University",
          "Virginia Tech University"
        ],
        "program": "Computer Science + Statistics",
        "note": "Solid CS/ML and statistics research; strong Mid-Atlantic/DC-area DS and analytics pipeline."
      },
      {
        "canonical": "Washington University in St. Louis",
        "aliases": [
          "Olin",
          "Olin Business School",
          "WUSTL",
          "Wash U",
          "WashU",
          "Washington University"
        ],
        "program": "Computer Science & Engineering + Statistics",
        "note": "Solid CSE/ML and biostatistics (med-school adjacency); recognized health-DS/analytics signal."
      },
      {
        "canonical": "Worcester Polytechnic Institute",
        "aliases": [
          "WPI",
          "Worcester Poly",
          "Worcester Polytechnic"
        ],
        "program": "Computer Science + Data Science",
        "note": "Early dedicated Data Science program and project-based CS; recognized New England applied-DS signal."
      }
    ]
  },
  "finance_consulting": {
    "tier_1": [
      {
        "canonical": "Columbia University",
        "aliases": [
          "CU",
          "Columbia",
          "Columbia Univ"
        ],
        "note": "NYC location drives top-tier IB recruiting; CBS at MBA level."
      },
      {
        "canonical": "Dartmouth College",
        "aliases": [
          "Dartmouth"
        ],
        "program": "Tuck at MBA level",
        "note": "Outsized IB/PE and consulting placement relative to size; classic Wall Street feeder."
      },
      {
        "canonical": "Harvard University",
        "aliases": [
          "Harvard",
          "Harvard College",
          "Harvard Univ"
        ],
        "note": "Core IB and #1 MBB undergrad/MBA feeder (HBS at MBA level)."
      },
      {
        "canonical": "Massachusetts Institute of Technology",
        "aliases": [
          "M.I.T.",
          "MIT",
          "MIT Sloan",
          "Sloan"
        ],
        "note": "Elite for quant finance, consulting, and strategy/ops; Sloan at MBA level."
      },
      {
        "canonical": "Northwestern University",
        "aliases": [
          "Kellogg",
          "Medill",
          "NU",
          "Northwestern"
        ],
        "program": "Kellogg (MBA); strong undergrad consulting pipeline",
        "note": "Named top MBB undergrad/MBA feeder; strong IB too."
      },
      {
        "canonical": "Princeton University",
        "aliases": [
          "Princeton"
        ],
        "note": "HYPS — heavy IB and consulting placement despite no business school."
      },
      {
        "canonical": "Stanford University",
        "aliases": [
          "Stanford",
          "Stanford Univ"
        ],
        "note": "Top target for IB, PE, MBB, and strategy/ops; GSB at MBA level."
      },
      {
        "canonical": "University of Chicago",
        "aliases": [
          "Chicago",
          "U Chicago",
          "U of C",
          "U. of Chicago",
          "UChicago"
        ],
        "program": "Booth at MBA level; strong economics undergrad",
        "note": "Top target for IB, consulting, and quant/economics-driven roles."
      },
      {
        "canonical": "University of Pennsylvania",
        "aliases": [
          "Annenberg",
          "Penn",
          "U Penn",
          "U. Penn",
          "UPenn",
          "Wharton",
          "Wharton School"
        ],
        "program": "The Wharton School (undergraduate business)",
        "note": "The single strongest undergraduate brand in IB/PE; Wharton is the gold standard. Non-Wharton Penn (CAS/SEAS) is also a top target."
      },
      {
        "canonical": "Yale University",
        "aliases": [
          "Yale"
        ],
        "note": "HYPS core target; SOM at MBA level."
      }
    ],
    "tier_2": [
      {
        "canonical": "Amherst College",
        "aliases": [
          "Amherst"
        ],
        "note": "Elite liberal arts feeder into IB/consulting; function-specific."
      },
      {
        "canonical": "Brown University",
        "aliases": [
          "Brown"
        ],
        "note": "Ivy IB/consulting feeder; strong MBB undergrad pipeline."
      },
      {
        "canonical": "Carnegie Mellon University",
        "aliases": [
          "C.M.U.",
          "CMU",
          "Carnegie Mellon",
          "Tepper"
        ],
        "program": "Tepper School of Business; strong for quant finance/analytics & strategy-ops",
        "note": "Particularly strong for quantitative finance, analytics, and operations-heavy strategy roles."
      },
      {
        "canonical": "Claremont McKenna College",
        "aliases": [
          "CMC",
          "Claremont McKenna",
          "Claremont-McKenna"
        ],
        "note": "Strongest liberal arts college for finance specifically; economics/government pipeline to IB and PE."
      },
      {
        "canonical": "Cornell University",
        "aliases": [
          "Cornell",
          "Cornell Dyson",
          "Dyson",
          "Johnson",
          "SC Johnson"
        ],
        "note": "Ivy target for IB and consulting; Dyson (applied economics/business) strengthens the signal."
      },
      {
        "canonical": "Duke University",
        "aliases": [
          "Duke"
        ],
        "program": "Fuqua at MBA level",
        "note": "Named top MBB feeder and strong IB target."
      },
      {
        "canonical": "Georgetown University",
        "aliases": [
          "GU",
          "Georgetown",
          "Georgetown McDonough",
          "McDonough"
        ],
        "program": "McDonough School of Business (undergraduate)",
        "note": "Strong DC/NYC IB and consulting target; business-school-driven signal."
      },
      {
        "canonical": "New York University",
        "aliases": [
          "N.Y.U.",
          "NYU",
          "NYU Stern",
          "Stern"
        ],
        "program": "Stern School of Business (undergraduate)",
        "note": "Wall Street proximity + elite undergrad business program = very high IB placement; punches above generic ranking for this function."
      },
      {
        "canonical": "University of California, Berkeley",
        "aliases": [
          "Berkeley",
          "Cal",
          "Haas",
          "UC Berkeley",
          "UC-Berkeley",
          "UCB",
          "University of California-Berkeley"
        ],
        "program": "Haas School of Business (undergraduate)",
        "note": "Top public for IB, consulting, and tech-finance; Haas is the program brand recruiters value."
      },
      {
        "canonical": "University of Michigan",
        "aliases": [
          "Michigan",
          "Michigan Ann Arbor",
          "Michigan Ross",
          "Ross",
          "U Michigan",
          "U of M",
          "U-M",
          "UMich",
          "University of Michigan Ann Arbor",
          "University of Michigan-Ann Arbor"
        ],
        "program": "Stephen M. Ross School of Business (undergraduate)",
        "note": "Top public for IB and a named MBB target; Ross BBA is a recognized recruiter screen."
      },
      {
        "canonical": "University of Notre Dame",
        "aliases": [
          "Mendoza",
          "ND",
          "Notre Dame",
          "Notre Dame Mendoza",
          "Notre Dame du Lac",
          "Univ of Notre Dame"
        ],
        "program": "Mendoza College of Business (undergraduate)",
        "note": "Recognized IB/consulting feeder with a strong alumni network on the Street."
      },
      {
        "canonical": "University of Southern California",
        "aliases": [
          "Annenberg",
          "Leventhal",
          "Marshall",
          "Southern Cal",
          "Southern California",
          "U.S.C.",
          "USC",
          "USC Leventhal",
          "USC Marshall"
        ],
        "program": "Leventhal School of Accounting",
        "note": "NOTE: USC already exists in tier_3 (Marshall). Listing here only to flag the Leventhal accounting brand as a stronger function-specific signal; do NOT create a duplicate canonical — fold these aliases into the existing USC entry rather than adding a second row."
      },
      {
        "canonical": "University of Virginia",
        "aliases": [
          "McIntire",
          "U Va",
          "U-Va",
          "U.Va.",
          "UVA",
          "University of Virginia Charlottesville",
          "Virginia"
        ],
        "program": "McIntire School of Commerce (undergraduate)",
        "note": "Top public for IB; McIntire is a recruiter-screened business program."
      },
      {
        "canonical": "Vanderbilt University",
        "aliases": [
          "Owen",
          "Vanderbilt",
          "Vandy"
        ],
        "program": "Owen at MBA level",
        "note": "Strong IB and consulting placement; rising target."
      },
      {
        "canonical": "Williams College",
        "aliases": [
          "Williams"
        ],
        "note": "Top liberal arts feeder into IB and MBB; function-specific signal (no business school but heavy Wall Street recruiting)."
      }
    ],
    "tier_3": [
      {
        "canonical": "Arizona State University",
        "aliases": [
          "ASU",
          "Arizona State",
          "Cronkite",
          "W. P. Carey",
          "W.P. Carey",
          "WP Carey"
        ],
        "program": "W. P. Carey School of Business (undergraduate)",
        "note": "Large flagship with a well-known, large business school; recognized accounting/finance pipeline and growing consulting placement."
      },
      {
        "canonical": "Babson College",
        "aliases": [
          "Babson"
        ],
        "note": "Specialist business/entrepreneurship college; recognized for finance and consulting placement, especially in the Northeast."
      },
      {
        "canonical": "Bentley University",
        "aliases": [
          "Bentley",
          "Bentley College"
        ],
        "note": "Business-focused school near Boston; well-known accounting/finance pipeline and a recognized Northeast IB/consulting semi-target."
      },
      {
        "canonical": "Boston College",
        "aliases": [
          "BC",
          "Boston Coll",
          "Carroll"
        ],
        "program": "Carroll School of Management (undergraduate)",
        "note": "Reliable Northeast IB feeder."
      },
      {
        "canonical": "Boston University",
        "aliases": [
          "BU",
          "Boston U",
          "Boston Univ",
          "Questrom"
        ],
        "program": "Questrom School of Business (undergraduate)",
        "note": "Boston-area semi-target with solid IB/consulting placement."
      },
      {
        "canonical": "Bowdoin College",
        "aliases": [
          "Bowdoin"
        ],
        "note": "Elite liberal arts feeder into finance and MBB; function-specific."
      },
      {
        "canonical": "Bucknell University",
        "aliases": [
          "Bucknell"
        ],
        "note": "Liberal-arts-scale university with an outsized IB feeder reputation; recognized Northeast semi-target."
      },
      {
        "canonical": "Colgate University",
        "aliases": [
          "Colgate"
        ],
        "note": "Liberal arts college with a notably strong IB feeder reputation and dense Wall Street alumni network (function-specific)."
      },
      {
        "canonical": "College of William & Mary",
        "aliases": [
          "Mason School",
          "Mason School of Business",
          "W&M",
          "WM",
          "William & Mary",
          "William and Mary"
        ],
        "note": "Regional IB/consulting semi-target (DC/Mid-Atlantic)."
      },
      {
        "canonical": "Davidson College",
        "aliases": [
          "Davidson"
        ],
        "note": "Southeast liberal arts college with a recognized finance/consulting pipeline, especially Charlotte-area banking (function-specific)."
      },
      {
        "canonical": "Emory University",
        "aliases": [
          "Emory",
          "Goizueta"
        ],
        "program": "Goizueta Business School (undergraduate)",
        "note": "Solid IB and consulting placement, especially Southeast offices."
      },
      {
        "canonical": "Fordham University",
        "aliases": [
          "Fordham",
          "Gabelli",
          "Gabelli School of Business"
        ],
        "program": "Gabelli School of Business (undergraduate)",
        "note": "NYC location drives a steady IB and corporate-finance pipeline; recognized regional feeder on the Street."
      },
      {
        "canonical": "Georgia Institute of Technology",
        "aliases": [
          "GT",
          "GaTech",
          "Georgia Tech",
          "Georgia Tech (GA Tech)"
        ],
        "note": "Function-specific: strong for quantitative finance, operations, and analytics-driven strategy roles rather than classic generalist IB."
      },
      {
        "canonical": "Hamilton College",
        "aliases": [
          "Hamilton"
        ],
        "note": "Liberal arts feeder into IB and consulting; recognized function-specific signal."
      },
      {
        "canonical": "Indiana University Bloomington",
        "aliases": [
          "IU",
          "IU Bloomington",
          "Indiana",
          "Indiana Bloomington",
          "Indiana University",
          "Kelley",
          "Kelley School of Business"
        ],
        "program": "Kelley School of Business (undergraduate)",
        "note": "Strong undergrad business / Investment Banking Workshop; reliable Street feeder."
      },
      {
        "canonical": "Lehigh University",
        "aliases": [
          "College of Business",
          "Lehigh"
        ],
        "note": "Recognized Northeast IB semi-target; strong finance pipeline and active Wall Street alumni network."
      },
      {
        "canonical": "Miami University",
        "aliases": [
          "Farmer",
          "Farmer School of Business",
          "MU Ohio",
          "Miami (OH)",
          "Miami Ohio",
          "Miami University Ohio",
          "Miami of Ohio"
        ],
        "program": "Farmer School of Business (undergraduate)",
        "note": "Public business school with a recognized undergrad finance pipeline into Midwest IB and corporate finance; distinct from University of Miami (FL)."
      },
      {
        "canonical": "Middlebury College",
        "aliases": [
          "Midd",
          "Middlebury"
        ],
        "note": "Liberal arts feeder into IB/consulting; function-specific."
      },
      {
        "canonical": "Ohio State University",
        "aliases": [
          "Fisher",
          "OSU",
          "Ohio State",
          "The Ohio State University",
          "tOSU"
        ],
        "program": "Fisher College of Business (undergraduate)",
        "note": "Big Ten flagship; Fisher is a solid undergrad business program with reliable corporate-finance and Midwest IB/consulting placement."
      },
      {
        "canonical": "Pennsylvania State University",
        "aliases": [
          "PSU",
          "Penn St",
          "Penn State",
          "Penn State Smeal",
          "Penn State University",
          "Penn State University Park",
          "Pennsylvania State",
          "Smeal"
        ],
        "program": "Smeal College of Business (undergraduate)",
        "note": "Large state flagship; Smeal is a recognized business brand with steady IB/consulting and corporate-finance placement, especially Mid-Atlantic offices."
      },
      {
        "canonical": "Pepperdine University",
        "aliases": [
          "Graziadio",
          "Pepperdine",
          "Seaver"
        ],
        "note": "West Coast business program with a recognized regional finance/consulting pipeline into Los Angeles offices."
      },
      {
        "canonical": "Pomona College",
        "aliases": [
          "Pomona"
        ],
        "note": "Elite liberal arts college; recognized feeder into IB and MBB consulting (function-specific, no business school)."
      },
      {
        "canonical": "Rice University",
        "aliases": [
          "Rice"
        ],
        "note": "Solid IB feeder, especially energy/Houston; strong quant signal."
      },
      {
        "canonical": "Rutgers University",
        "aliases": [
          "RU",
          "Rutgers",
          "Rutgers Business School",
          "Rutgers New Brunswick",
          "Rutgers University-New Brunswick",
          "Rutgers — New Brunswick",
          "Rutgers-New Brunswick"
        ],
        "program": "Rutgers Business School (undergraduate)",
        "note": "New Jersey flagship near NYC; recognized accounting/finance pipeline and steady regional IB placement."
      },
      {
        "canonical": "Southern Methodist University",
        "aliases": [
          "Cox",
          "Cox School of Business",
          "Lyle",
          "SMU",
          "Southern Methodist"
        ],
        "program": "Cox School of Business (undergraduate)",
        "note": "Dallas business school with a recognized regional IB/consulting pipeline into Texas offices."
      },
      {
        "canonical": "Swarthmore College",
        "aliases": [
          "Swarthmore",
          "Swat"
        ],
        "note": "Elite liberal arts college with a recognized economics pipeline into IB and consulting (function-specific)."
      },
      {
        "canonical": "Texas A&M University",
        "aliases": [
          "A&M",
          "Aggies",
          "Mays",
          "Mays Business School",
          "TAMU",
          "Texas A&M",
          "Texas A&M University-College Station"
        ],
        "program": "Mays Business School (undergraduate)",
        "note": "Major Texas flagship; Mays feeds Texas/Houston IB and energy-finance offices with a strong alumni network."
      },
      {
        "canonical": "Tufts University",
        "aliases": [
          "Tufts"
        ],
        "note": "Strong economics/quant placement into IB and MBB; Boston-area semi-target."
      },
      {
        "canonical": "Tulane University",
        "aliases": [
          "A.B. Freeman",
          "Freeman",
          "Freeman School of Business",
          "Tulane"
        ],
        "program": "A. B. Freeman School of Business (undergraduate)",
        "note": "Southeast/Gulf semi-target; Freeman has a recognized finance pipeline including a managed student investment fund."
      },
      {
        "canonical": "University of Arizona",
        "aliases": [
          "Arizona",
          "Eller",
          "U Arizona",
          "U of A",
          "UA",
          "UA Tucson",
          "UArizona"
        ],
        "program": "Eller College of Management (undergraduate)",
        "note": "State flagship; Eller is a recognized business school with solid accounting/finance and corporate-finance placement."
      },
      {
        "canonical": "University of California, Los Angeles",
        "aliases": [
          "Anderson",
          "U.C.L.A.",
          "UC Los Angeles",
          "UC-LA",
          "UCLA",
          "University of California-Los Angeles"
        ],
        "note": "Strong public for IB (West Coast), consulting, and strategy/ops; Anderson at MBA level."
      },
      {
        "canonical": "University of Connecticut",
        "aliases": [
          "Connecticut",
          "U Conn",
          "UCONN",
          "UConn",
          "UConn School of Business",
          "University of Connecticut Storrs"
        ],
        "note": "NOTE: intended canonical is 'University of Connecticut' (the 'Babson aside —' prefix is a labeling artifact, ignore it). State flagship with a recognized accounting/finance program and steady regional corporate-finance/IB placement."
      },
      {
        "canonical": "University of Florida",
        "aliases": [
          "Florida",
          "Gainesville",
          "Gators",
          "U of Florida",
          "UF",
          "UFlorida",
          "Univ of Florida",
          "Warrington"
        ],
        "program": "Warrington College of Business (undergraduate)",
        "note": "Top public business school in the Southeast; strong accounting/finance pipeline and growing IB placement."
      },
      {
        "canonical": "University of Georgia",
        "aliases": [
          "Georgia",
          "Grady",
          "Terry",
          "U Georgia",
          "UGA"
        ],
        "program": "Terry College of Business (undergraduate)",
        "note": "Southeast flagship; Terry is a recognized business program with solid finance/consulting placement into Atlanta-area offices."
      },
      {
        "canonical": "University of Illinois Urbana-Champaign",
        "aliases": [
          "Gies",
          "Illinois",
          "Illinois Urbana-Champaign",
          "U of I",
          "UIUC",
          "University of Illinois",
          "University of Illinois at Urbana-Champaign"
        ],
        "program": "Gies College of Business (undergraduate)",
        "note": "Flagship with a nationally top-ranked accounting program (Gies/Big Four pipeline) plus solid finance placement."
      },
      {
        "canonical": "University of Maryland, College Park",
        "aliases": [
          "Maryland",
          "Smith",
          "U Maryland",
          "UMCP",
          "UMD",
          "UMD College Park",
          "University of Maryland",
          "University of Maryland-College Park"
        ],
        "program": "Robert H. Smith School of Business (undergraduate)",
        "note": "State flagship near DC/NYC; Smith is a recognized business program with steady IB and consulting placement."
      },
      {
        "canonical": "University of Minnesota",
        "aliases": [
          "Carlson",
          "Minnesota",
          "Minnesota Twin Cities",
          "U Minnesota",
          "U of M",
          "U of M Minnesota",
          "U of M Twin Cities",
          "UMN",
          "University of Minnesota Twin Cities",
          "University of Minnesota-Twin Cities"
        ],
        "program": "Carlson School of Management (undergraduate)",
        "note": "Big Ten flagship; Carlson is a recognized business brand with solid corporate-finance and Midwest consulting/IB placement."
      },
      {
        "canonical": "University of North Carolina at Chapel Hill",
        "aliases": [
          "Carolina",
          "Chapel Hill",
          "Hussman",
          "Kenan-Flagler",
          "North Carolina",
          "UNC",
          "UNC Chapel Hill",
          "UNC-Chapel Hill"
        ],
        "program": "Kenan-Flagler Business School (undergraduate)",
        "note": "Solid public business program with consistent IB/consulting placement."
      },
      {
        "canonical": "University of Richmond",
        "aliases": [
          "Richmond",
          "Robins",
          "U Richmond"
        ],
        "program": "Robins School of Business (undergraduate)",
        "note": "Recognized Mid-Atlantic business program with steady IB and consulting placement."
      },
      {
        "canonical": "University of Texas at Austin",
        "aliases": [
          "McCombs",
          "Moody",
          "Texas",
          "UT",
          "UT Austin",
          "UT-Austin",
          "University of Texas",
          "University of Texas Austin"
        ],
        "program": "McCombs School of Business (undergraduate)",
        "note": "Strong public business program; major IB feeder into Texas/Houston offices."
      },
      {
        "canonical": "University of Washington",
        "aliases": [
          "Foster",
          "U Dub",
          "U Washington",
          "U-Dub",
          "UDub",
          "UW",
          "UW Seattle",
          "University of Washington Seattle",
          "University of Washington-Seattle",
          "Washington"
        ],
        "program": "Michael G. Foster School of Business (undergraduate)",
        "note": "Pacific Northwest flagship; Foster places reliably into West Coast IB, consulting, and corporate finance."
      },
      {
        "canonical": "University of Waterloo",
        "aliases": [
          "U Waterloo",
          "UW Waterloo",
          "UWaterloo",
          "Waterloo"
        ],
        "note": "Canadian; noted only for its strong co-op pipeline into quant/fintech and some US IB/consulting — not US-centric, included as a recognized cross-border feeder."
      },
      {
        "canonical": "University of Wisconsin-Madison",
        "aliases": [
          "Madison",
          "U Wisconsin",
          "UW Madison",
          "UW-Madison",
          "UWisc",
          "University of Wisconsin",
          "University of Wisconsin Madison",
          "University of Wisconsin–Madison",
          "Wisconsin",
          "Wisconsin School of Business",
          "Wisconsin-Madison"
        ],
        "note": "Strong undergrad business + Applied Security Analysis Program; Midwest IB feeder."
      },
      {
        "canonical": "Villanova University",
        "aliases": [
          "Nova",
          "VSB",
          "Villanova",
          "Villanova School of Business"
        ],
        "program": "Villanova School of Business (undergraduate)",
        "note": "Recognized Northeast/Mid-Atlantic business program with consistent IB and consulting placement."
      },
      {
        "canonical": "Wake Forest University",
        "aliases": [
          "WFU",
          "Wake",
          "Wake Forest"
        ],
        "note": "Recognized semi-target for IB and consulting."
      },
      {
        "canonical": "Washington and Lee University",
        "aliases": [
          "W&L",
          "WLU",
          "Washington & Lee",
          "Washington and Lee"
        ],
        "note": "Liberal arts college with the Williams School of Commerce; recognized IB/consulting feeder, especially Mid-Atlantic/Southeast."
      },
      {
        "canonical": "Washington University in St. Louis",
        "aliases": [
          "Olin",
          "Olin Business School",
          "WUSTL",
          "Wash U",
          "WashU",
          "Washington University"
        ],
        "program": "Olin Business School (undergraduate)",
        "note": "Solid IB/consulting feeder, especially Chicago/Midwest."
      }
    ]
  },
  "general_top_us": {
    "tier_1": [
      {
        "canonical": "California Institute of Technology",
        "aliases": [
          "CIT",
          "Caltech"
        ],
        "note": "US News 2026 #11. Elite STEM signal."
      },
      {
        "canonical": "Cornell University",
        "aliases": [
          "Cornell",
          "Cornell Dyson",
          "Dyson",
          "Johnson",
          "SC Johnson"
        ],
        "note": "US News 2026 #12. Ivy with broad recruiting reach."
      },
      {
        "canonical": "Duke University",
        "aliases": [
          "Duke"
        ],
        "note": "US News 2026 #7 (tied). Consistent cross-functional target."
      },
      {
        "canonical": "Harvard University",
        "aliases": [
          "Harvard",
          "Harvard College",
          "Harvard Univ"
        ],
        "note": "US News 2026 #3. Maximal cross-functional brand recognition."
      },
      {
        "canonical": "Johns Hopkins University",
        "aliases": [
          "Hopkins",
          "JHU",
          "Johns Hopkins"
        ],
        "note": "US News 2026 #7 (tied)."
      },
      {
        "canonical": "Massachusetts Institute of Technology",
        "aliases": [
          "M.I.T.",
          "MIT",
          "MIT Sloan",
          "Sloan"
        ],
        "note": "US News 2026 #2. Elite across STEM, business, and quant functions."
      },
      {
        "canonical": "Northwestern University",
        "aliases": [
          "Kellogg",
          "Medill",
          "NU",
          "Northwestern"
        ],
        "note": "US News 2026 #7 (tied)."
      },
      {
        "canonical": "Princeton University",
        "aliases": [
          "Princeton"
        ],
        "note": "US News 2026 #1; LinkedIn Top Colleges 2025 #1. Top of essentially every overall-prestige list."
      },
      {
        "canonical": "Stanford University",
        "aliases": [
          "Stanford",
          "Stanford Univ"
        ],
        "note": "US News 2026 #4. Elite for tech, business, and research."
      },
      {
        "canonical": "University of Chicago",
        "aliases": [
          "Chicago",
          "U Chicago",
          "U of C",
          "U. of Chicago",
          "UChicago"
        ],
        "note": "US News 2026 #6. Strong econ/finance/consulting prestige."
      },
      {
        "canonical": "University of Pennsylvania",
        "aliases": [
          "Annenberg",
          "Penn",
          "U Penn",
          "U. Penn",
          "UPenn",
          "Wharton",
          "Wharton School"
        ],
        "note": "US News 2026 #7 (tied). Wharton drives finance/consulting prestige."
      },
      {
        "canonical": "Yale University",
        "aliases": [
          "Yale"
        ],
        "note": "US News 2026 #5 (tied). HYPS anchor."
      }
    ],
    "tier_2": [
      {
        "canonical": "Brown University",
        "aliases": [
          "Brown"
        ],
        "note": "US News 2026 #13 (tied). Ivy."
      },
      {
        "canonical": "Carnegie Mellon University",
        "aliases": [
          "C.M.U.",
          "CMU",
          "Carnegie Mellon",
          "Tepper"
        ],
        "note": "US News 2026 #20 (tied). Elite for CS/tech; strong across functions."
      },
      {
        "canonical": "Case Western Reserve University",
        "aliases": [
          "CWRU",
          "Case",
          "Case Western",
          "Weatherhead"
        ],
        "note": "US News 2026 ~#51 (tied). Strong STEM/engineering and pre-professional national private."
      },
      {
        "canonical": "College of William & Mary",
        "aliases": [
          "Mason School",
          "Mason School of Business",
          "W&M",
          "WM",
          "William & Mary",
          "William and Mary"
        ],
        "note": "US News 2026 ~#54 but the second-oldest US college; elite public-Ivy brand recognized broadly across functions."
      },
      {
        "canonical": "Columbia University",
        "aliases": [
          "CU",
          "Columbia",
          "Columbia Univ"
        ],
        "note": "US News 2026 #15 (tied). Ivy; strong finance/consulting feeder."
      },
      {
        "canonical": "Dartmouth College",
        "aliases": [
          "Dartmouth"
        ],
        "note": "US News 2026 #13 (tied). Ivy."
      },
      {
        "canonical": "Emory University",
        "aliases": [
          "Emory",
          "Goizueta"
        ],
        "note": "US News 2026 #24 (tied)."
      },
      {
        "canonical": "Georgetown University",
        "aliases": [
          "GU",
          "Georgetown",
          "Georgetown McDonough",
          "McDonough"
        ],
        "note": "US News 2026 #24 (tied). Strong finance/consulting/policy feeder."
      },
      {
        "canonical": "Rice University",
        "aliases": [
          "Rice"
        ],
        "note": "US News 2026 #17 (tied)."
      },
      {
        "canonical": "Tulane University",
        "aliases": [
          "A.B. Freeman",
          "Freeman",
          "Freeman School of Business",
          "Tulane"
        ],
        "note": "US News 2026 ~#73 but a long-recognized selective national private with strong recruiter brand."
      },
      {
        "canonical": "University of California, Berkeley",
        "aliases": [
          "Berkeley",
          "Cal",
          "Haas",
          "UC Berkeley",
          "UC-Berkeley",
          "UCB",
          "University of California-Berkeley"
        ],
        "note": "US News 2026 #15 (tied). Top public, elite STEM/business."
      },
      {
        "canonical": "University of California, Los Angeles",
        "aliases": [
          "Anderson",
          "U.C.L.A.",
          "UC Los Angeles",
          "UC-LA",
          "UCLA",
          "University of California-Los Angeles"
        ],
        "note": "US News 2026 #17 (tied). Top public flagship."
      },
      {
        "canonical": "University of California, San Diego",
        "aliases": [
          "UC San Diego",
          "UC-San Diego",
          "UCSD",
          "University of California-San Diego"
        ],
        "note": "US News 2026 #29. Strong public, esp. STEM/bio."
      },
      {
        "canonical": "University of Michigan",
        "aliases": [
          "Michigan",
          "Michigan Ann Arbor",
          "Michigan Ross",
          "Ross",
          "U Michigan",
          "U of M",
          "U-M",
          "UMich",
          "University of Michigan Ann Arbor",
          "University of Michigan-Ann Arbor"
        ],
        "note": "US News 2026 #20 (tied). Top public, broadly recruited (Ross/engineering)."
      },
      {
        "canonical": "University of North Carolina at Chapel Hill",
        "aliases": [
          "Carolina",
          "Chapel Hill",
          "Hussman",
          "Kenan-Flagler",
          "North Carolina",
          "UNC",
          "UNC Chapel Hill",
          "UNC-Chapel Hill"
        ],
        "note": "US News 2026 #26 (tied). Top public."
      },
      {
        "canonical": "University of Notre Dame",
        "aliases": [
          "Mendoza",
          "ND",
          "Notre Dame",
          "Notre Dame Mendoza",
          "Notre Dame du Lac",
          "Univ of Notre Dame"
        ],
        "note": "US News 2026 #20 (tied). Strong finance/consulting alumni network."
      },
      {
        "canonical": "University of Southern California",
        "aliases": [
          "Annenberg",
          "Leventhal",
          "Marshall",
          "Southern Cal",
          "Southern California",
          "U.S.C.",
          "USC",
          "USC Leventhal",
          "USC Marshall"
        ],
        "note": "US News 2026 #28. Strong in media/tech/business."
      },
      {
        "canonical": "University of Texas at Austin",
        "aliases": [
          "McCombs",
          "Moody",
          "Texas",
          "UT",
          "UT Austin",
          "UT-Austin",
          "University of Texas",
          "University of Texas Austin"
        ],
        "note": "US News 2026 #30 (tied). Flagship; strong tech/finance/accounting feeder."
      },
      {
        "canonical": "University of Virginia",
        "aliases": [
          "McIntire",
          "U Va",
          "U-Va",
          "U.Va.",
          "UVA",
          "University of Virginia Charlottesville",
          "Virginia"
        ],
        "note": "US News 2026 #26 (tied). Top public; strong recruiting."
      },
      {
        "canonical": "Vanderbilt University",
        "aliases": [
          "Owen",
          "Vanderbilt",
          "Vandy"
        ],
        "note": "US News 2026 #17 (tied)."
      },
      {
        "canonical": "Wake Forest University",
        "aliases": [
          "WFU",
          "Wake",
          "Wake Forest"
        ],
        "note": "US News 2026 ~#46 (tied). Strong national private; well-recruited in finance/consulting (top accounting program)."
      },
      {
        "canonical": "Washington University in St. Louis",
        "aliases": [
          "Olin",
          "Olin Business School",
          "WUSTL",
          "Wash U",
          "WashU",
          "Washington University"
        ],
        "note": "US News 2026 #20 (tied)."
      }
    ],
    "tier_3": [
      {
        "canonical": "American University",
        "aliases": [
          "AU",
          "American",
          "American U",
          "Kogod"
        ],
        "note": "Washington DC private; recognized policy/IR/government signal."
      },
      {
        "canonical": "Amherst College",
        "aliases": [
          "Amherst"
        ],
        "note": "Top-tier liberal arts college; recognized elite-LAC signal across functions."
      },
      {
        "canonical": "Arizona State University",
        "aliases": [
          "ASU",
          "Arizona State",
          "Cronkite",
          "W. P. Carey",
          "W.P. Carey",
          "WP Carey"
        ],
        "note": "Very large public; broadly recognized, strong business/engineering scale."
      },
      {
        "canonical": "Auburn University",
        "aliases": [
          "AU",
          "Auburn",
          "Auburn Univ",
          "Harbert"
        ],
        "note": "Land-grant flagship; recognized engineering/business signal."
      },
      {
        "canonical": "Barnard College",
        "aliases": [
          "Barnard"
        ],
        "note": "Selective women's college affiliated with Columbia; recognized signal."
      },
      {
        "canonical": "Bates College",
        "aliases": [
          "Bates"
        ],
        "note": "Selective liberal arts college (Maine); recognized signal."
      },
      {
        "canonical": "Baylor University",
        "aliases": [
          "Baylor",
          "Baylor ProSales",
          "Hankamer"
        ],
        "note": "Large private (Texas); recognized regional business signal."
      },
      {
        "canonical": "Binghamton University",
        "aliases": [
          "BU SUNY",
          "Binghamton",
          "SUNY Binghamton",
          "State University of New York at Binghamton"
        ],
        "note": "Selective SUNY (a 'public Ivy' of the system); strong recognized signal."
      },
      {
        "canonical": "Boston College",
        "aliases": [
          "BC",
          "Boston Coll",
          "Carroll"
        ],
        "note": "US News 2026 #36 (tied)."
      },
      {
        "canonical": "Boston University",
        "aliases": [
          "BU",
          "Boston U",
          "Boston Univ",
          "Questrom"
        ],
        "note": "US News 2026 #42 (tied)."
      },
      {
        "canonical": "Bowdoin College",
        "aliases": [
          "Bowdoin"
        ],
        "note": "Top liberal arts college; recognized selective-LAC signal."
      },
      {
        "canonical": "Brigham Young University",
        "aliases": [
          "BYU",
          "BYU Provo",
          "Brigham Young",
          "Marriott",
          "Marriott School"
        ],
        "note": "Large private; recognized, strong accounting/business pipeline."
      },
      {
        "canonical": "Bucknell University",
        "aliases": [
          "Bucknell"
        ],
        "note": "Selective liberal arts university; recognized engineering/finance feeder."
      },
      {
        "canonical": "Carleton College",
        "aliases": [
          "Carleton"
        ],
        "note": "Top liberal arts college (Minnesota); recognized academics signal."
      },
      {
        "canonical": "Claremont McKenna College",
        "aliases": [
          "CMC",
          "Claremont McKenna",
          "Claremont-McKenna"
        ],
        "note": "Top liberal arts college; recognized finance/consulting/government feeder."
      },
      {
        "canonical": "Clemson University",
        "aliases": [
          "CU",
          "Clemson"
        ],
        "note": "Land-grant flagship; recognized public, strong engineering."
      },
      {
        "canonical": "Colby College",
        "aliases": [
          "Colby"
        ],
        "note": "Selective liberal arts college (Maine); recognized signal."
      },
      {
        "canonical": "Colgate University",
        "aliases": [
          "Colgate"
        ],
        "note": "Selective liberal arts college; recognized finance/consulting feeder."
      },
      {
        "canonical": "Colorado State University",
        "aliases": [
          "CSU",
          "CSU Fort Collins",
          "Colorado State"
        ],
        "note": "Land-grant flagship; recognized public signal."
      },
      {
        "canonical": "Creighton University",
        "aliases": [
          "Creighton",
          "Heider"
        ],
        "note": "Midwest Jesuit private; recognized regional business/health signal."
      },
      {
        "canonical": "Davidson College",
        "aliases": [
          "Davidson"
        ],
        "note": "Selective liberal arts college; recognized academics and finance feeder signal."
      },
      {
        "canonical": "DePaul University",
        "aliases": [
          "DePaul",
          "Driehaus"
        ],
        "note": "Large Chicago private; recognized regional business signal."
      },
      {
        "canonical": "Drexel University",
        "aliases": [
          "Drexel",
          "LeBow",
          "LeBow College of Business"
        ],
        "note": "Private with strong co-op program; recognized engineering/business recruiting signal."
      },
      {
        "canonical": "Florida A&M University",
        "aliases": [
          "FAMU",
          "Florida A&M",
          "Florida Agricultural and Mechanical University"
        ],
        "note": "Leading public HBCU; recognized signal, strong business/pharmacy programs."
      },
      {
        "canonical": "Florida State University",
        "aliases": [
          "FL State",
          "FSU",
          "Florida St",
          "Florida State",
          "Seminoles"
        ],
        "note": "State flagship-tier public; broadly recognized signal."
      },
      {
        "canonical": "Fordham University",
        "aliases": [
          "Fordham",
          "Gabelli",
          "Gabelli School of Business"
        ],
        "note": "NYC Jesuit private; recognized finance/business feeder."
      },
      {
        "canonical": "George Washington University",
        "aliases": [
          "GW",
          "GW University",
          "GWU",
          "George Washington"
        ],
        "note": "Washington DC private; recognized policy/IR/finance feeder."
      },
      {
        "canonical": "Georgia Institute of Technology",
        "aliases": [
          "GT",
          "GaTech",
          "Georgia Tech",
          "Georgia Tech (GA Tech)"
        ],
        "note": "US News 2026 #32 (tied). Elite for engineering/CS; included here on the GENERIC overall lens — function-specific tech list ranks it higher."
      },
      {
        "canonical": "Gonzaga University",
        "aliases": [
          "Gonzaga",
          "Zags"
        ],
        "note": "Pacific Northwest Jesuit private; recognized regional signal."
      },
      {
        "canonical": "Grinnell College",
        "aliases": [
          "Grinnell"
        ],
        "note": "Selective liberal arts college (Iowa); recognized academics signal."
      },
      {
        "canonical": "Hamilton College",
        "aliases": [
          "Hamilton"
        ],
        "note": "Selective liberal arts college; recognized academics signal."
      },
      {
        "canonical": "Haverford College",
        "aliases": [
          "Haverford"
        ],
        "note": "Selective liberal arts college; recognized rigorous-academics signal."
      },
      {
        "canonical": "Howard University",
        "aliases": [
          "HU",
          "Howard"
        ],
        "note": "Premier HBCU; strong recognized national brand and recruiter pipeline."
      },
      {
        "canonical": "Illinois Institute of Technology",
        "aliases": [
          "IIT",
          "Illinois Institute",
          "Illinois Tech",
          "Stuart School of Business"
        ],
        "note": "Chicago tech institute; recognized engineering signal."
      },
      {
        "canonical": "Indiana State University",
        "aliases": [],
        "note": "placeholder; ignore (not added)."
      },
      {
        "canonical": "Indiana University",
        "aliases": [
          "IU",
          "Indiana",
          "Indiana University Bloomington",
          "Kelley",
          "Kelley School"
        ],
        "note": "Duplicate of Indiana University Bloomington above; ignore (placeholder)."
      },
      {
        "canonical": "Indiana University Bloomington",
        "aliases": [
          "IU",
          "IU Bloomington",
          "Indiana",
          "Indiana Bloomington",
          "Indiana University",
          "Kelley",
          "Kelley School of Business"
        ],
        "note": "Flagship; Kelley is a nationally recognized business feeder."
      },
      {
        "canonical": "Iowa State University",
        "aliases": [
          "ISU",
          "ISU Ames",
          "Iowa St",
          "Iowa State",
          "Iowa State Univ",
          "Iowa State University of Science and Technology",
          "Ivy College of Business"
        ],
        "note": "Land-grant flagship; recognized engineering/agriculture/STEM signal."
      },
      {
        "canonical": "Kansas State University",
        "aliases": [
          "K-State",
          "KSU",
          "KSU Manhattan",
          "Kansas State"
        ],
        "note": "Land-grant flagship; recognized regional signal, strong agriculture/engineering."
      },
      {
        "canonical": "Lehigh University",
        "aliases": [
          "College of Business",
          "Lehigh"
        ],
        "note": "US News 2026 #46 (tied); LinkedIn 2025 #17 for career outcomes."
      },
      {
        "canonical": "Louisiana State University",
        "aliases": [
          "E. J. Ourso",
          "LSU",
          "Louisiana State",
          "Ourso"
        ],
        "note": "Land-grant flagship; recognized public signal."
      },
      {
        "canonical": "Loyola Marymount University",
        "aliases": [
          "LMU",
          "Loyola Marymount",
          "Loyola Marymount Univ"
        ],
        "note": "Los Angeles private; recognized regional signal, strong film/media."
      },
      {
        "canonical": "Loyola University Chicago",
        "aliases": [
          "LUC",
          "Loyola Chicago",
          "Quinlan"
        ],
        "note": "Chicago Jesuit private; recognized regional signal."
      },
      {
        "canonical": "Macalester College",
        "aliases": [
          "Mac",
          "Macalester"
        ],
        "note": "Selective liberal arts college (Minnesota); recognized academics/IR signal."
      },
      {
        "canonical": "Marquette University",
        "aliases": [
          "Diederich",
          "MU",
          "Marquette"
        ],
        "note": "Midwest Jesuit private; recognized regional business/engineering signal."
      },
      {
        "canonical": "Miami University",
        "aliases": [
          "Farmer",
          "Farmer School of Business",
          "MU Ohio",
          "Miami (OH)",
          "Miami Ohio",
          "Miami University Ohio",
          "Miami of Ohio"
        ],
        "note": "Public 'public Ivy'; recognized business/finance feeder (not to be confused with U. of Miami FL)."
      },
      {
        "canonical": "Michigan State University",
        "aliases": [
          "Broad",
          "Eli Broad",
          "MSU",
          "Mich State",
          "Michigan St",
          "Michigan State"
        ],
        "note": "Big Ten land-grant flagship; widely recognized, strong supply-chain/accounting programs."
      },
      {
        "canonical": "Middlebury College",
        "aliases": [
          "Midd",
          "Middlebury"
        ],
        "note": "Top liberal arts college; recognized selective-LAC signal, strong languages/IR."
      },
      {
        "canonical": "Mississippi State University",
        "aliases": [
          "MSU",
          "MSstate",
          "Mississippi State"
        ],
        "note": "Land-grant flagship; recognized regional engineering/agriculture signal."
      },
      {
        "canonical": "Montana State University",
        "aliases": [
          "MSU Bozeman",
          "Montana State"
        ],
        "note": "Land-grant flagship; recognized regional STEM/engineering signal."
      },
      {
        "canonical": "Morehouse College",
        "aliases": [
          "Morehouse"
        ],
        "note": "Top men's HBCU; recognized positive signal and notable alumni network."
      },
      {
        "canonical": "New York University",
        "aliases": [
          "N.Y.U.",
          "NYU",
          "NYU Stern",
          "Stern"
        ],
        "note": "US News 2026 #32 (tied). Strong in finance/media/arts."
      },
      {
        "canonical": "North Carolina A&T State University",
        "aliases": [
          "Aggies",
          "NC A&T",
          "NCAT",
          "North Carolina A&T"
        ],
        "note": "Largest HBCU; recognized engineering/STEM signal."
      },
      {
        "canonical": "North Carolina State University",
        "aliases": [
          "N.C. State",
          "NC State",
          "NC State University",
          "NCSU",
          "North Carolina State",
          "Poole"
        ],
        "note": "Land-grant flagship; recognized engineering/STEM signal (Research Triangle)."
      },
      {
        "canonical": "North Dakota State University",
        "aliases": [
          "NDSU",
          "North Dakota State"
        ],
        "note": "Land-grant flagship; recognized regional engineering/agriculture signal."
      },
      {
        "canonical": "Northeastern University",
        "aliases": [
          "D'Amore-McKim",
          "NEU",
          "NU Boston",
          "Northeastern"
        ],
        "note": "US News 2026 #46 (tied). Co-op program drives strong recruiter demand."
      },
      {
        "canonical": "Oberlin College",
        "aliases": [
          "Oberlin"
        ],
        "note": "Selective liberal arts college; recognized academics/music signal."
      },
      {
        "canonical": "Ohio State University",
        "aliases": [
          "Fisher",
          "OSU",
          "Ohio State",
          "The Ohio State University",
          "tOSU"
        ],
        "note": "US News 2026 #41. Large Big Ten flagship."
      },
      {
        "canonical": "Oklahoma State University",
        "aliases": [
          "OSU",
          "OSU Stillwater",
          "Oklahoma State",
          "Spears",
          "Spears School of Business"
        ],
        "note": "Land-grant flagship; recognized regional engineering/business signal."
      },
      {
        "canonical": "Oregon State University",
        "aliases": [
          "OSU",
          "OSU Corvallis",
          "Oregon St",
          "Oregon State",
          "OregonState"
        ],
        "note": "Land-grant flagship; recognized STEM/engineering signal."
      },
      {
        "canonical": "Pennsylvania State University",
        "aliases": [
          "PSU",
          "Penn St",
          "Penn State",
          "Penn State Smeal",
          "Penn State University",
          "Penn State University Park",
          "Pennsylvania State",
          "Smeal"
        ],
        "note": "Large Big Ten flagship; deep alumni network and broad recruiter reach across functions."
      },
      {
        "canonical": "Pepperdine University",
        "aliases": [
          "Graziadio",
          "Pepperdine",
          "Seaver"
        ],
        "note": "Selective private (Southern California); recognized business signal."
      },
      {
        "canonical": "Pomona College",
        "aliases": [
          "Pomona"
        ],
        "note": "Top liberal arts college (Claremont); recognized elite-LAC signal."
      },
      {
        "canonical": "Purdue University",
        "aliases": [
          "Daniels",
          "Daniels School of Business",
          "Krannert",
          "Mitch Daniels School",
          "Purdue",
          "Purdue West Lafayette"
        ],
        "note": "US News 2026 #46 (tied). Strong engineering flagship."
      },
      {
        "canonical": "Rensselaer Polytechnic Institute",
        "aliases": [
          "RPI",
          "Rensselaer",
          "Rensselaer Poly",
          "Rensselaer Polytechnic"
        ],
        "note": "Selective tech institute; recognized engineering signal."
      },
      {
        "canonical": "Rochester Institute of Technology",
        "aliases": [
          "RIT",
          "Rochester Institute",
          "Saunders"
        ],
        "note": "Tech-focused private; recognized engineering/computing/design co-op signal."
      },
      {
        "canonical": "Rutgers University",
        "aliases": [
          "RU",
          "Rutgers",
          "Rutgers Business School",
          "Rutgers New Brunswick",
          "Rutgers University-New Brunswick",
          "Rutgers — New Brunswick",
          "Rutgers-New Brunswick"
        ],
        "note": "US News 2026 #42 (tied)."
      },
      {
        "canonical": "Saint Louis University",
        "aliases": [
          "Chaifetz",
          "SLU",
          "Saint Louis",
          "St. Louis University"
        ],
        "note": "Midwest Jesuit private; recognized regional signal."
      },
      {
        "canonical": "Santa Clara University",
        "aliases": [
          "Leavey",
          "SCU",
          "Santa Clara"
        ],
        "note": "Silicon Valley Jesuit private; recognized tech/business recruiting signal."
      },
      {
        "canonical": "Seton Hall University",
        "aliases": [
          "SHU",
          "Seton Hall",
          "Stillman"
        ],
        "note": "New Jersey Catholic private; recognized regional business signal."
      },
      {
        "canonical": "Smith College",
        "aliases": [
          "Smith"
        ],
        "note": "Selective women's liberal arts college (Seven Sisters); recognized signal."
      },
      {
        "canonical": "South Dakota State University",
        "aliases": [
          "SDSU",
          "South Dakota State"
        ],
        "note": "Land-grant flagship; recognized regional signal."
      },
      {
        "canonical": "Southern Methodist University",
        "aliases": [
          "Cox",
          "Cox School of Business",
          "Lyle",
          "SMU",
          "Southern Methodist"
        ],
        "note": "Selective private (Dallas); recognized business/finance feeder in the Southwest."
      },
      {
        "canonical": "Spelman College",
        "aliases": [
          "Spelman"
        ],
        "note": "Top women's HBCU; recognized positive signal with strong recruiter relationships."
      },
      {
        "canonical": "Stevens Institute of Technology",
        "aliases": [
          "SIT",
          "Stevens",
          "Stevens Tech"
        ],
        "note": "Selective tech-focused private; recognized engineering/CS signal (NJ/NYC)."
      },
      {
        "canonical": "Stony Brook University",
        "aliases": [
          "SBU",
          "SUNY Stony Brook",
          "State University of New York at Stony Brook",
          "Stony Brook"
        ],
        "note": "Flagship-tier SUNY; strong STEM, recognized national public."
      },
      {
        "canonical": "Swarthmore College",
        "aliases": [
          "Swarthmore",
          "Swat"
        ],
        "note": "Top liberal arts college; recognized rigorous-academics signal."
      },
      {
        "canonical": "Syracuse University",
        "aliases": [
          "Cuse",
          "Newhouse",
          "SU",
          "Syracuse",
          "Syracuse Univ",
          "Whitman"
        ],
        "note": "National private; recognized, strong Newhouse communications/media program."
      },
      {
        "canonical": "Temple University",
        "aliases": [
          "Fox",
          "Fox School",
          "Fox School of Business",
          "Klein",
          "TU",
          "Temple",
          "Tyler",
          "Tyler School of Art",
          "Tyler School of Art and Architecture"
        ],
        "note": "Large urban public; recognized regional signal (Philadelphia)."
      },
      {
        "canonical": "Texas A&M University",
        "aliases": [
          "A&M",
          "Aggies",
          "Mays",
          "Mays Business School",
          "TAMU",
          "Texas A&M",
          "Texas A&M University-College Station"
        ],
        "note": "Very large land-grant flagship; powerful alumni network, strong engineering recruiting."
      },
      {
        "canonical": "Texas Christian University",
        "aliases": [
          "Neeley",
          "TCU",
          "Texas Christian"
        ],
        "note": "Selective private; recognized regional business/finance signal."
      },
      {
        "canonical": "Texas Tech University",
        "aliases": [
          "Rawls",
          "TTU",
          "Texas Tech"
        ],
        "note": "Major public; recognized regional signal."
      },
      {
        "canonical": "Tufts University",
        "aliases": [
          "Tufts"
        ],
        "note": "US News 2026 #36 (tied)."
      },
      {
        "canonical": "University at Albany",
        "aliases": [
          "Albany",
          "SUNY Albany",
          "UAlbany"
        ],
        "note": "SUNY public; recognized regional signal, strong public-policy/criminal-justice."
      },
      {
        "canonical": "University at Buffalo",
        "aliases": [
          "Buffalo",
          "SUNY Buffalo",
          "State University of New York at Buffalo",
          "UB",
          "University at Buffalo SUNY"
        ],
        "note": "Largest SUNY; recognized public research university."
      },
      {
        "canonical": "University of Alabama",
        "aliases": [
          "Alabama",
          "Bama",
          "Culverhouse",
          "Roll Tide",
          "UA",
          "Univ of Alabama"
        ],
        "note": "SEC state flagship; broadly recognized public."
      },
      {
        "canonical": "University of Alaska Fairbanks",
        "aliases": [
          "Alaska Fairbanks",
          "UAF",
          "University of Alaska"
        ],
        "note": "State flagship; recognized regional STEM/Arctic-research signal."
      },
      {
        "canonical": "University of Arizona",
        "aliases": [
          "Arizona",
          "Eller",
          "U Arizona",
          "U of A",
          "UA",
          "UA Tucson",
          "UArizona"
        ],
        "note": "State flagship; recognized national public, Eller business school."
      },
      {
        "canonical": "University of Arkansas",
        "aliases": [
          "Arkansas",
          "Razorbacks",
          "U Arkansas",
          "U of A",
          "UARK",
          "Walton",
          "Walton College"
        ],
        "note": "State flagship; recognized public, Walton supply-chain/retail program (Walmart pipeline)."
      },
      {
        "canonical": "University of California, Davis",
        "aliases": [
          "Davis",
          "UC Davis",
          "UC-Davis",
          "UCD",
          "University of California-Davis"
        ],
        "note": "US News 2026 #32 (tied)."
      },
      {
        "canonical": "University of California, Irvine",
        "aliases": [
          "Irvine",
          "UC Irvine",
          "UC-Irvine",
          "UCI",
          "University of California-Irvine"
        ],
        "note": "US News 2026 #32 (tied)."
      },
      {
        "canonical": "University of California, Santa Barbara",
        "aliases": [
          "Santa Barbara",
          "UC Santa Barbara",
          "UC-Santa Barbara",
          "UCSB",
          "University of California-Santa Barbara"
        ],
        "note": "US News 2026 #40."
      },
      {
        "canonical": "University of Central Florida",
        "aliases": [
          "Central Florida",
          "U Central Florida",
          "UCF"
        ],
        "note": "Very large public; recognized regional signal, strong scale in engineering/hospitality."
      },
      {
        "canonical": "University of Cincinnati",
        "aliases": [
          "Cincinnati",
          "DAAP",
          "Lindner",
          "UC",
          "University of Cincinnati DAAP"
        ],
        "note": "Large public; recognized regional signal, strong co-op program."
      },
      {
        "canonical": "University of Colorado Boulder",
        "aliases": [
          "Boulder",
          "CU",
          "CU Boulder",
          "CU-Boulder",
          "Colorado",
          "Colorado Boulder",
          "Leeds",
          "Leeds School of Business",
          "UC Boulder",
          "University of Colorado",
          "University of Colorado-Boulder"
        ],
        "note": "State flagship; recognized public, strong aerospace/engineering."
      },
      {
        "canonical": "University of Connecticut",
        "aliases": [
          "Connecticut",
          "U Conn",
          "UCONN",
          "UConn",
          "UConn School of Business",
          "University of Connecticut Storrs"
        ],
        "note": "State flagship; broadly recognized positive signal."
      },
      {
        "canonical": "University of Dayton",
        "aliases": [
          "Dayton",
          "UD"
        ],
        "note": "Catholic private (Ohio); recognized regional engineering/business signal."
      },
      {
        "canonical": "University of Delaware",
        "aliases": [
          "Delaware",
          "Lerner",
          "U Delaware",
          "UD",
          "UDel"
        ],
        "note": "State flagship; recognized public, strong Lerner business/finance program."
      },
      {
        "canonical": "University of Denver",
        "aliases": [
          "DU",
          "Daniels",
          "Daniels College of Business",
          "Denver",
          "U Denver"
        ],
        "note": "Private (Colorado); recognized regional business/IR signal."
      },
      {
        "canonical": "University of Florida",
        "aliases": [
          "Florida",
          "Gainesville",
          "Gators",
          "U of Florida",
          "UF",
          "UFlorida",
          "Univ of Florida",
          "Warrington"
        ],
        "note": "US News 2026 #30 (tied). Large flagship."
      },
      {
        "canonical": "University of Georgia",
        "aliases": [
          "Georgia",
          "Grady",
          "Terry",
          "U Georgia",
          "UGA"
        ],
        "note": "US News 2026 #46 (tied)."
      },
      {
        "canonical": "University of Hawaii at Manoa",
        "aliases": [
          "Hawaii",
          "Shidler",
          "UH Manoa",
          "University of Hawaii"
        ],
        "note": "State flagship; recognized regional public signal."
      },
      {
        "canonical": "University of Houston",
        "aliases": [
          "Bauer",
          "C. T. Bauer",
          "Houston",
          "U Houston",
          "U of H",
          "UH"
        ],
        "note": "Large urban public; recognized regional signal, strong energy/business pipeline."
      },
      {
        "canonical": "University of Idaho",
        "aliases": [
          "Idaho",
          "U Idaho",
          "UI"
        ],
        "note": "Land-grant flagship; recognized regional public signal."
      },
      {
        "canonical": "University of Illinois Urbana-Champaign",
        "aliases": [
          "Gies",
          "Illinois",
          "Illinois Urbana-Champaign",
          "U of I",
          "UIUC",
          "University of Illinois",
          "University of Illinois at Urbana-Champaign"
        ],
        "note": "US News 2026 #36 (tied). Strong engineering/CS/accounting feeder."
      },
      {
        "canonical": "University of Iowa",
        "aliases": [
          "Hawkeyes",
          "Iowa",
          "The University of Iowa",
          "Tippie",
          "Tippie College of Business",
          "U Iowa",
          "U of Iowa",
          "UIowa"
        ],
        "note": "Big Ten state flagship; recognized regional/national signal."
      },
      {
        "canonical": "University of Kansas",
        "aliases": [
          "Jayhawks",
          "KU",
          "Kansas",
          "U Kansas",
          "U of Kansas",
          "University of Kansas Lawrence",
          "William Allen White School"
        ],
        "note": "State flagship; recognized public signal."
      },
      {
        "canonical": "University of Kentucky",
        "aliases": [
          "Gatton",
          "Kentucky",
          "U Kentucky",
          "UK"
        ],
        "note": "State flagship; recognized public signal."
      },
      {
        "canonical": "University of Maine",
        "aliases": [
          "Maine",
          "U Maine",
          "UMaine"
        ],
        "note": "Land-grant flagship; recognized regional public signal."
      },
      {
        "canonical": "University of Maryland, College Park",
        "aliases": [
          "Maryland",
          "Smith",
          "U Maryland",
          "UMCP",
          "UMD",
          "UMD College Park",
          "University of Maryland",
          "University of Maryland-College Park"
        ],
        "note": "US News 2026 #42 (tied). Strong CS/engineering flagship."
      },
      {
        "canonical": "University of Massachusetts Amherst",
        "aliases": [
          "Isenberg",
          "Massachusetts Amherst",
          "U Mass",
          "UMass",
          "UMass Amherst",
          "UMass-Amherst",
          "University of Massachusetts",
          "University of Massachusetts-Amherst"
        ],
        "note": "Flagship of the UMass system; recognized public, strong Isenberg business school."
      },
      {
        "canonical": "University of Miami",
        "aliases": [
          "Herbert",
          "Herbert Business School",
          "Miami",
          "Miami FL",
          "The U",
          "U Miami",
          "UM",
          "UMiami"
        ],
        "note": "Selective Florida private; recognized national signal (distinct from Miami University Ohio)."
      },
      {
        "canonical": "University of Minnesota, Twin Cities",
        "aliases": [
          "Carlson",
          "Carlson School of Management",
          "Minnesota",
          "Minnesota Twin Cities",
          "U of M",
          "UMN",
          "University of Minnesota",
          "University of Minnesota Twin Cities",
          "University of Minnesota-Twin Cities"
        ],
        "note": "Big Ten flagship; strong public, broad recognition."
      },
      {
        "canonical": "University of Mississippi",
        "aliases": [
          "Mississippi",
          "Ole Miss",
          "Olemiss",
          "UM"
        ],
        "note": "State flagship; recognized regional public signal."
      },
      {
        "canonical": "University of Missouri",
        "aliases": [
          "MU",
          "Missouri",
          "Missouri School of Journalism",
          "Mizzou",
          "Mizzou Journalism",
          "Trulaske",
          "U Missouri",
          "University of Missouri-Columbia"
        ],
        "note": "State flagship; recognized public, well-known journalism program."
      },
      {
        "canonical": "University of Nebraska–Lincoln",
        "aliases": [
          "Cornhuskers",
          "Husker",
          "Huskers",
          "Nebraska",
          "Nebraska Lincoln",
          "Nebraska-Lincoln",
          "UNL",
          "University of Nebraska",
          "University of Nebraska-Lincoln"
        ],
        "note": "Big Ten land-grant flagship; recognized public signal."
      },
      {
        "canonical": "University of Nevada, Las Vegas",
        "aliases": [
          "Lee Business School",
          "Nevada Las Vegas",
          "UNLV"
        ],
        "note": "Large public; recognized regional signal, strong hospitality program."
      },
      {
        "canonical": "University of New Hampshire",
        "aliases": [
          "New Hampshire",
          "Paul College",
          "UNH"
        ],
        "note": "State flagship; recognized regional public signal."
      },
      {
        "canonical": "University of New Mexico",
        "aliases": [
          "Anderson",
          "New Mexico",
          "UNM"
        ],
        "note": "State flagship; recognized regional public signal."
      },
      {
        "canonical": "University of Oklahoma",
        "aliases": [
          "Gaylord",
          "OU",
          "Oklahoma",
          "Price",
          "Price College",
          "Price College of Business",
          "Sooners",
          "U Oklahoma"
        ],
        "note": "State flagship; recognized public, strong energy-industry pipeline."
      },
      {
        "canonical": "University of Oregon",
        "aliases": [
          "Lundquist",
          "Oregon",
          "SOJC",
          "U Oregon",
          "U of O",
          "UO"
        ],
        "note": "State flagship; recognized, strong in sports business/marketing/design."
      },
      {
        "canonical": "University of Pittsburgh",
        "aliases": [
          "College of Business Administration",
          "Katz",
          "Pitt",
          "Pittsburgh",
          "U Pitt",
          "U Pittsburgh",
          "UPitt",
          "University of Pittsburgh Pittsburgh"
        ],
        "note": "Major public research university; recognized national signal, strong in health/engineering."
      },
      {
        "canonical": "University of Rhode Island",
        "aliases": [
          "Rhode Island",
          "URI"
        ],
        "note": "State flagship; recognized regional public signal."
      },
      {
        "canonical": "University of Rochester",
        "aliases": [
          "Rochester",
          "Simon",
          "Simon Business School",
          "U Rochester",
          "U of R",
          "UR"
        ],
        "note": "US News 2026 #46 (tied)."
      },
      {
        "canonical": "University of San Diego",
        "aliases": [
          "Knauss",
          "San Diego",
          "USD"
        ],
        "note": "California private; recognized regional signal."
      },
      {
        "canonical": "University of San Francisco",
        "aliases": [
          "San Francisco",
          "USF",
          "USF San Francisco",
          "USFCA"
        ],
        "note": "Bay Area Jesuit private; recognized regional signal."
      },
      {
        "canonical": "University of South Carolina",
        "aliases": [
          "Darla Moore",
          "Darla Moore School",
          "Gamecocks",
          "Moore School",
          "South Carolina",
          "USC Columbia",
          "USCarolina",
          "UofSC"
        ],
        "note": "State flagship; recognized public, Darla Moore international-business program."
      },
      {
        "canonical": "University of South Florida",
        "aliases": [
          "Muma",
          "South Florida",
          "U South Florida",
          "USF"
        ],
        "note": "Large emerging public research university; recognized regional signal."
      },
      {
        "canonical": "University of Tennessee, Knoxville",
        "aliases": [
          "Haslam",
          "Tennessee",
          "Tennessee Knoxville",
          "UT Knoxville",
          "UTK"
        ],
        "note": "SEC state flagship; recognized regional/national public."
      },
      {
        "canonical": "University of Toronto",
        "aliases": [
          "Toronto",
          "U of T",
          "UofT"
        ],
        "note": "CANADIAN — not US; cross-border context only. Broadly recruited by US firms, esp. tech/finance."
      },
      {
        "canonical": "University of Tulsa",
        "aliases": [
          "Collins College of Business",
          "TU",
          "Tulsa"
        ],
        "note": "Selective private (Oklahoma); recognized regional engineering/energy signal."
      },
      {
        "canonical": "University of Utah",
        "aliases": [
          "David Eccles",
          "Eccles",
          "The U",
          "The University of Utah",
          "U Utah",
          "U of U",
          "UU",
          "University of Utah Salt Lake",
          "UofU",
          "Utah",
          "Utah Salt Lake"
        ],
        "note": "State flagship; recognized public, growing tech/CS feeder (Silicon Slopes)."
      },
      {
        "canonical": "University of Vermont",
        "aliases": [
          "Grossman",
          "UVM",
          "Vermont"
        ],
        "note": "State flagship; recognized public liberal-arts-leaning signal."
      },
      {
        "canonical": "University of Washington",
        "aliases": [
          "Foster",
          "U Dub",
          "U Washington",
          "U-Dub",
          "UDub",
          "UW",
          "UW Seattle",
          "University of Washington Seattle",
          "University of Washington-Seattle",
          "Washington"
        ],
        "note": "US News 2026 #42 (tied). Strong tech/CS feeder (Seattle)."
      },
      {
        "canonical": "University of Waterloo",
        "aliases": [
          "U Waterloo",
          "UW Waterloo",
          "UWaterloo",
          "Waterloo"
        ],
        "note": "CANADIAN — not US; noted only as cross-border context. US tech employers heavily recruit Waterloo co-ops for SWE. Treat as positive signal but the candidate pool is US-focused."
      },
      {
        "canonical": "University of Wisconsin-Madison",
        "aliases": [
          "Madison",
          "U Wisconsin",
          "UW Madison",
          "UW-Madison",
          "UWisc",
          "University of Wisconsin",
          "University of Wisconsin Madison",
          "University of Wisconsin–Madison",
          "Wisconsin",
          "Wisconsin School of Business",
          "Wisconsin-Madison"
        ],
        "note": "US News 2026 #36 (tied)."
      },
      {
        "canonical": "University of Wyoming",
        "aliases": [
          "U Wyoming",
          "UW",
          "Wyoming"
        ],
        "note": "State flagship; recognized regional public signal."
      },
      {
        "canonical": "Vassar College",
        "aliases": [
          "Vassar"
        ],
        "note": "Selective liberal arts college; recognized academics/arts signal."
      },
      {
        "canonical": "Villanova University",
        "aliases": [
          "Nova",
          "VSB",
          "Villanova",
          "Villanova School of Business"
        ],
        "note": "Selective private; recognized, strong business/finance recruiting."
      },
      {
        "canonical": "Virginia Tech",
        "aliases": [
          "Pamplin",
          "VPI",
          "VT",
          "Virginia Polytechnic",
          "Virginia Polytechnic Institute and State University",
          "Virginia Tech University"
        ],
        "note": "Land-grant flagship; strong recognized engineering signal."
      },
      {
        "canonical": "Washington State University",
        "aliases": [
          "Carson",
          "Cougars",
          "Edward R. Murrow College",
          "Murrow",
          "WSU",
          "Washington State",
          "Wazzu"
        ],
        "note": "Land-grant flagship; recognized regional public signal."
      },
      {
        "canonical": "Wellesley College",
        "aliases": [
          "Wellesley"
        ],
        "note": "Top women's liberal arts college; recognized elite-LAC signal, strong alumnae network."
      },
      {
        "canonical": "Wesleyan University",
        "aliases": [
          "Wes",
          "Wesleyan"
        ],
        "note": "Selective liberal arts university; recognized academics/arts signal."
      },
      {
        "canonical": "West Virginia University",
        "aliases": [
          "Chambers College",
          "WVU",
          "West Virginia"
        ],
        "note": "Land-grant flagship; recognized regional public signal."
      },
      {
        "canonical": "Williams College",
        "aliases": [
          "Williams"
        ],
        "note": "Top-tier liberal arts college; recognized elite-LAC signal, strong finance/consulting feeder."
      },
      {
        "canonical": "Worcester Polytechnic Institute",
        "aliases": [
          "WPI",
          "Worcester Poly",
          "Worcester Polytechnic"
        ],
        "note": "Selective tech institute; recognized engineering/STEM signal."
      },
      {
        "canonical": "Yeshiva University",
        "aliases": [
          "Sy Syms",
          "YU",
          "Yeshiva"
        ],
        "note": "NYC private; recognized signal, particularly in finance/business."
      }
    ]
  }
}

/** Normalize a school string for matching: fold diacritics, lowercase, &→and, strip punctuation, collapse spaces. */
export function normalizeSchoolKey(raw: string): string {
  return String(raw)
    .normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

interface IndexHit { lens: SchoolLens; tier: SchoolTier; canonical: string }
let REVERSE_INDEX: Map<string, Map<SchoolLens, IndexHit>> | null = null
function buildIndex(): Map<string, Map<SchoolLens, IndexHit>> {
  if (REVERSE_INDEX) return REVERSE_INDEX
  const idx = new Map<string, Map<SchoolLens, IndexHit>>()
  for (const lens of Object.keys(SCHOOL_TIERS) as SchoolLens[]) {
    for (const tier of ["tier_1", "tier_2", "tier_3"] as SchoolTier[]) {
      for (const e of SCHOOL_TIERS[lens][tier]) {
        for (const key of [e.canonical, ...e.aliases]) {
          const nk = normalizeSchoolKey(key)
          if (!nk) continue
          if (!idx.has(nk)) idx.set(nk, new Map())
          const byLens = idx.get(nk)!
          const prev = byLens.get(lens)
          if (!prev || tierRank(tier) < tierRank(prev.tier)) byLens.set(lens, { lens, tier, canonical: e.canonical })
        }
      }
    }
  }
  REVERSE_INDEX = idx
  return idx
}
function tierRank(t: SchoolTier): number { return t === "tier_1" ? 0 : t === "tier_2" ? 1 : 2 }
function strengthOf(t: SchoolTier | null): SchoolStrength { return t === "tier_1" || t === "tier_2" ? "strong" : t === "tier_3" ? "recognized" : "unknown" }

export interface SchoolPriorResult {
  strength: SchoolStrength
  tier: SchoolTier | null
  lens: SchoolLens | null
  matchedVia: "lens" | "general_fallback" | "none"
  canonical: string | null
}

/**
 * Look up the role-scoped school-strength prior for a parsed school string + the job's
 * roleFunction(s). Multi-pick jobs: resolves each roleFunction's lens and takes the BEST
 * (strongest) hit, then falls back to the broad general US list. ADVISORY — see file header.
 */
export function lookupSchoolPrior(
  rawSchool: string | undefined | null,
  roleFunction: RoleFunction | RoleFunction[] | undefined | null,
): SchoolPriorResult {
  const none: SchoolPriorResult = { strength: "unknown", tier: null, lens: null, matchedVia: "none", canonical: null }
  const nk = normalizeSchoolKey(rawSchool ?? "")
  if (!nk) return none
  const idx = buildIndex()
  const byLens = idx.get(nk)
  if (!byLens) return none

  const rfs = (Array.isArray(roleFunction) ? roleFunction : roleFunction ? [roleFunction] : []) as RoleFunction[]
  const lensesToTry = rfs.length ? [...new Set(rfs.map((rf) => ROLE_FUNCTION_TO_LENS[rf]).filter(Boolean))] : []

  let best: IndexHit | null = null
  for (const lens of lensesToTry) {
    const hit = byLens.get(lens)
    if (hit && (!best || tierRank(hit.tier) < tierRank(best.tier))) best = hit
  }
  if (best) return { strength: strengthOf(best.tier), tier: best.tier, lens: best.lens, matchedVia: "lens", canonical: best.canonical }

  const gen = byLens.get("general_top_us")
  if (gen) return { strength: strengthOf(gen.tier), tier: gen.tier, lens: "general_top_us", matchedVia: "general_fallback", canonical: gen.canonical }
  return none
}
