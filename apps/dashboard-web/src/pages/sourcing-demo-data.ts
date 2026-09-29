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
}


export const SAMPLE_JD = "We are hiring a Senior Account Executive to sell a property operations platform to multifamily owners. We need 4+ years of B2B SaaS sales, full-cycle closing, and experience selling into real estate teams."

export const CANDIDATES: Candidate[] = [
  {
    id: "morgan", name: "Morgan Lee", initials: "ML", color: "peach", role: "Senior Account Executive", company: "LeasePilot", location: "Los Angeles, CA", years: "6 years in B2B sales", previous: ["VTS", "AppFolio"], skillsList: ["PropTech", "Full-cycle sales", "Multifamily"], visa: "Not shown", salary: "$145k–$170k OTE", linkedin: "linkedin.com/in/morgan-lee-demo", email: "morgan.lee@example.com", experience: 96, skills: 93, locationFit: 100, compensationFit: 86, summary: "Closed mid-market property-management accounts and grew an LA territory. Direct overlap with multifamily buyers and full-cycle SaaS sales.", companyDetail: "Property operations software", companySize: "201–500 employees", companyHQ: "Los Angeles, CA",
  },
  {
    id: "avery", name: "Avery Patel", initials: "AP", color: "lavender", role: "Account Executive", company: "Buildium", location: "San Diego, CA", years: "5 years in SaaS sales", previous: ["RealPage", "HubSpot"], skillsList: ["Real estate", "Pipeline creation", "Closing"], visa: "Not shown", salary: "$135k–$160k OTE", linkedin: "linkedin.com/in/avery-patel-demo", email: "avery.patel@example.com", experience: 91, skills: 89, locationFit: 75, compensationFit: 95, summary: "Sold property-management software to residential operators. Strong buyer overlap; location would need a conversation.", companyDetail: "Property-management platform", companySize: "501–1,000 employees", companyHQ: "Boston, MA",
  },
  {
    id: "jordan", name: "Jordan Brooks", initials: "JB", color: "sage", role: "Enterprise Account Executive", company: "Procore", location: "Los Angeles, CA", years: "8 years in enterprise sales", previous: ["CoStar", "Yardi"], skillsList: ["Enterprise sales", "Real estate", "Strategic accounts"], visa: "Not shown", salary: "$180k–$210k OTE", linkedin: "linkedin.com/in/jordan-brooks-demo", email: "jordan.brooks@example.com", experience: 88, skills: 85, locationFit: 100, compensationFit: 38, summary: "Deep real-estate technology background and local network. Compensation is above the sample range and needs review.", companyDetail: "Construction management software", companySize: "1,001–5,000 employees", companyHQ: "Carpinteria, CA",
  },
  {
    id: "sam", name: "Sam Rivera", initials: "SR", color: "blue", role: "Commercial Account Executive", company: "VTS", location: "New York, NY", years: "4 years in commercial sales", previous: ["Zillow", "Compass"], skillsList: ["PropTech", "Outbound", "Land-and-expand"], visa: "Not shown", salary: "$120k–$150k OTE", linkedin: "linkedin.com/in/sam-rivera-demo", email: "sam.rivera@example.com", experience: 82, skills: 87, locationFit: 45, compensationFit: 100, summary: "Relevant commercial real-estate network with strong outbound motion. Relocation or remote fit is unconfirmed.", companyDetail: "Commercial real-estate leasing platform", companySize: "501–1,000 employees", companyHQ: "New York, NY",
  },
  {
    id: "taylor", name: "Taylor Kim", initials: "TK", color: "gold", role: "Account Executive", company: "Gong", location: "Los Angeles, CA", years: "5 years in SaaS sales", previous: ["Salesforce", "OpenTable"], skillsList: ["Full-cycle sales", "SaaS", "Forecasting"], visa: "Not shown", salary: "$140k–$165k OTE", linkedin: "linkedin.com/in/taylor-kim-demo", email: "taylor.kim@example.com", experience: 71, skills: 77, locationFit: 100, compensationFit: 90, summary: "Strong SaaS sales fundamentals and local fit. No clear property-operations or multifamily selling evidence in the sample profile.", companyDetail: "Revenue intelligence software", companySize: "1,001–5,000 employees", companyHQ: "San Francisco, CA",
  },
]

