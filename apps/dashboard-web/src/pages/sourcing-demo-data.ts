import type { DemoCandidate } from "./sourcing-demo-score.js"

export type Candidate = DemoCandidate & {
  initials: string
  color: string
  years: string
  previous: string[]
  skillsList: string[]
  visa: string
  salary: string
  linkedin: string
  summary: string
  companyDetail: string
  companySize: string
  companyHQ: string
  email: string
  headline: string
  about: string
  industryYears: number
  education: string
  employment: { title: string; company: string; dates: string; detail: string }[]
}

export const RELATED_COMPANIES = [
  { name: "Buildium", group: "Property management software", note: "Residential property management platform" },
  { name: "AppFolio", group: "Property management software", note: "Property operations platform" },
  { name: "Yardi", group: "Property management software", note: "Real estate and property software" },
  { name: "RealPage", group: "Property management software", note: "Residential property software" },
  { name: "VTS", group: "Commercial real estate technology", note: "Leasing and asset workflows" },
  { name: "CoStar", group: "Commercial real estate technology", note: "Commercial real estate data and software" },
] as const


export const SAMPLE_JD = "We are hiring a Senior Account Executive to sell a property operations platform to multifamily owners. We need 4+ years of B2B SaaS sales, full-cycle closing, and experience selling into real estate teams."

export const CANDIDATES: Candidate[] = [
  {
    id: "morgan", name: "Morgan Lee", initials: "ML", color: "peach", role: "Senior Account Executive", company: "LeasePilot", location: "Los Angeles, CA", years: "6 years in B2B sales", previous: ["VTS", "AppFolio"], skillsList: ["PropTech", "Full-cycle sales", "Multifamily"], visa: "Not shown", salary: "$145k–$170k OTE", linkedin: "linkedin.com/in/morgan-lee-demo", email: "morgan.lee@example.com", experience: 96, skills: 93, locationFit: 100, compensationFit: 86, summary: "Closed mid-market property-management accounts and grew an LA territory. Direct overlap with multifamily buyers and full-cycle SaaS sales.", companyDetail: "Property operations software", companySize: "201–500 employees", companyHQ: "Los Angeles, CA", headline: "Senior Account Executive | Property technology & multifamily", about: "B2B SaaS seller focused on multifamily operators. Led discovery, demos, negotiation, and expansion across a Los Angeles territory.", industryYears: 5, education: "BA, Business Administration · sample record", employment: [{ title: "Senior Account Executive", company: "LeasePilot", dates: "2023–Present", detail: "Owns full-cycle sales to multifamily owners and property teams." }, { title: "Account Executive", company: "VTS", dates: "2021–2023", detail: "Sold commercial real estate software to leasing teams." }, { title: "Sales Development Representative", company: "AppFolio", dates: "2019–2021", detail: "Prospected property managers and supported product demos." }],
  },
  {
    id: "avery", name: "Avery Patel", initials: "AP", color: "lavender", role: "Account Executive", company: "Buildium", location: "San Diego, CA", years: "5 years in SaaS sales", previous: ["RealPage", "HubSpot"], skillsList: ["Real estate", "Pipeline creation", "Closing"], visa: "Not shown", salary: "$135k–$160k OTE", linkedin: "linkedin.com/in/avery-patel-demo", email: "avery.patel@example.com", experience: 91, skills: 89, locationFit: 75, compensationFit: 95, summary: "Sold property-management software to residential operators. Strong buyer overlap; location would need a conversation.", companyDetail: "Property-management platform", companySize: "501–1,000 employees", companyHQ: "Boston, MA", headline: "Account Executive | Residential property software", about: "SaaS account executive serving property managers and residential real estate operators.", industryYears: 5, education: "BS, Marketing · sample record", employment: [{ title: "Account Executive", company: "Buildium", dates: "2023–Present", detail: "Closes property management software deals with residential operators." }, { title: "Business Development Representative", company: "RealPage", dates: "2021–2023", detail: "Built pipeline with multifamily property teams." }, { title: "Sales Development Representative", company: "HubSpot", dates: "2020–2021", detail: "Worked in SaaS prospecting and qualification." }],
  },
  {
    id: "jordan", name: "Jordan Brooks", initials: "JB", color: "sage", role: "Enterprise Account Executive", company: "Procore", location: "Los Angeles, CA", years: "8 years in enterprise sales", previous: ["CoStar", "Yardi"], skillsList: ["Enterprise sales", "Real estate", "Strategic accounts"], visa: "Not shown", salary: "$180k–$210k OTE", linkedin: "linkedin.com/in/jordan-brooks-demo", email: "jordan.brooks@example.com", experience: 88, skills: 85, locationFit: 100, compensationFit: 38, summary: "Deep real-estate technology background and local network. Compensation is above the sample range and needs review.", companyDetail: "Construction management software", companySize: "1,001–5,000 employees", companyHQ: "Carpinteria, CA", headline: "Enterprise Account Executive | Real estate technology", about: "Enterprise seller with experience across construction, commercial real estate data, and property software.", industryYears: 4, education: "BA, Economics · sample record", employment: [{ title: "Enterprise Account Executive", company: "Procore", dates: "2022–Present", detail: "Manages strategic software accounts and complex sales cycles." }, { title: "Account Executive", company: "CoStar", dates: "2020–2022", detail: "Sold commercial real estate data products." }, { title: "Account Executive", company: "Yardi", dates: "2018–2020", detail: "Worked with property operations teams." }],
  },
  {
    id: "sam", name: "Sam Rivera", initials: "SR", color: "blue", role: "Commercial Account Executive", company: "VTS", location: "New York, NY", years: "4 years in commercial sales", previous: ["Zillow", "Compass"], skillsList: ["PropTech", "Outbound", "Land-and-expand"], visa: "Not shown", salary: "$120k–$150k OTE", linkedin: "linkedin.com/in/sam-rivera-demo", email: "sam.rivera@example.com", experience: 82, skills: 87, locationFit: 45, compensationFit: 100, summary: "Relevant commercial real-estate network with strong outbound motion. Relocation or remote fit is unconfirmed.", companyDetail: "Commercial real-estate leasing platform", companySize: "501–1,000 employees", companyHQ: "New York, NY", headline: "Commercial Account Executive | Real estate technology", about: "Commercial real estate account executive with outbound and expansion experience.", industryYears: 4, education: "BA, Communications · sample record", employment: [{ title: "Commercial Account Executive", company: "VTS", dates: "2022–Present", detail: "Works with leasing and asset management teams." }, { title: "Sales Specialist", company: "Zillow", dates: "2020–2022", detail: "Supported real estate professionals in a digital marketplace." }, { title: "Account Coordinator", company: "Compass", dates: "2019–2020", detail: "Supported brokerage accounts." }],
  },
  {
    id: "taylor", name: "Taylor Kim", initials: "TK", color: "gold", role: "Account Executive", company: "Gong", location: "Los Angeles, CA", years: "5 years in SaaS sales", previous: ["Salesforce", "OpenTable"], skillsList: ["Full-cycle sales", "SaaS", "Forecasting"], visa: "Not shown", salary: "$140k–$165k OTE", linkedin: "linkedin.com/in/taylor-kim-demo", email: "taylor.kim@example.com", experience: 71, skills: 77, locationFit: 100, compensationFit: 90, summary: "Strong SaaS sales fundamentals and local fit. No clear property-operations or multifamily selling evidence in the sample profile.", companyDetail: "Revenue intelligence software", companySize: "1,001–5,000 employees", companyHQ: "San Francisco, CA", headline: "Account Executive | B2B SaaS", about: "Full-cycle SaaS seller with a focus on forecasting and sales operations.", industryYears: 0, education: "BS, Business · sample record", employment: [{ title: "Account Executive", company: "Gong", dates: "2022–Present", detail: "Sells revenue intelligence software." }, { title: "Account Executive", company: "Salesforce", dates: "2020–2022", detail: "Managed CRM software opportunities." }, { title: "Sales Associate", company: "OpenTable", dates: "2019–2020", detail: "Worked with restaurant operators." }],
  },
]
