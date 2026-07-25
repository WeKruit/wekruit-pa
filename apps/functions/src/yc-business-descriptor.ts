/**
 * yc-business-descriptor.ts — the `businessDescriptor` generator, shared by the batch script
 * (`scripts/describe-yc-attendees.ts`) and the live scanner path (`yc-pool-sync.ts`).
 *
 * WHY IT LIVES IN src/ (Adam 2026-07-25): a scanner is now described INSIDE a live turn, and a
 * second copy of this prompt would put the new arrivals in a different descriptor vocabulary than
 * the 992 rows they are ranked against. One prompt, one schema, one caller-agnostic function.
 *
 * WHY IT EXISTS AT ALL: a LinkedIn profile says "Software Engineer @ Faire", never "two-sided
 * marketplace". Concrete-domain queries ("robotics") match verbatim text; business-MODEL queries
 * ("marketplace", "B2B SaaS") have nothing to bind to, so they rank noise (measured: top hit for
 * "marketplace" was a web agency, cosine 0.31). Company → business model is world knowledge the LLM
 * has and the profile does not state, so it is materialised at index time and folded into the
 * embedded text (`synthesizePeopleMatchText({ businessDescriptor })`).
 */
import { callWithFallback } from "@pa/pa-resume-parser"
import { PERSON_TYPE_VOCAB, type BusinessDescriptor } from "./yc-people-match.js"

export const DESCRIPTOR_SYSTEM = `You label a person's professional profile with WHAT THE COMPANIES THEY WORK(ED) AT ACTUALLY DO.

You are given titles, companies and experience blurbs. Use your own knowledge of the named companies — the profile itself almost never states the business model, and that is exactly the gap you are filling.

businessModel: the company's model, lowercase, from this vocabulary where it fits:
  marketplace, two_sided_marketplace, b2b_saas, vertical_saas, enterprise_software, consumer_app,
  consumer_social, consumer_subscription, ecommerce, dtc_brand, fintech, payments, insurtech,
  developer_tools, infrastructure, cloud_platform, ai_foundation_model, ai_application, hardware,
  robotics, semiconductors, biotech, medical_device, healthcare_provider, edtech, govtech, defense,
  agency_consulting, staffing, research_lab, university, nonprofit, media, gaming, adtech, logistics,
  real_estate, proptech, climate, energy, agtech, legaltech, hrtech, cybersecurity, open_source.
  Add a term outside the list only when none fits. 1-3 entries, most specific first.

domain: the industry/problem space in plain words (e.g. "logistics", "clinical care", "consumer finance",
  "developer productivity"). 1-3 entries.

whatTheyBuild: ONE sentence, max 25 words, naming the product category AND who buys it —
  e.g. "freight matching platform connecting shippers and carriers" or
  "subscription billing software sold to B2B SaaS finance teams".

personType: WHAT KIND OF PERSON this is, from EXACTLY this closed list, 1-3 entries, most defining first:
  founder, investor, program_operator, engineer, researcher, product, designer, operator, executive,
  recruiter, student.
  Definitions that are easy to get wrong:
    investor        — CURRENTLY sits at an organisation whose business is deploying capital (VC, PE,
                      angel syndicate, family office, corporate venture arm, student-run venture
                      fund) in a role that sources, evaluates or decides on investments.
                      THE SENIORITY OF THE TITLE IS IRRELEVANT. Intern, Extern, Fellow, Scout,
                      Analyst, Associate, Partner, Managing Partner and Board Observer AT A FUND all
                      mean investor: "Intern @ Khosla Ventures" is an investor, NOT a student;
                      "Fellow @ Comma Capital" is an investor, NOT a program_operator; "Analyst @
                      Harvard Undergraduate Venture Capital Group" is an investor, NOT a student.
                      NOT someone who merely works at a fintech or a bank, and NOT an engineer /
                      PM / salesperson at a company that merely has "Capital", "Partners" or
                      "Ventures" in its NAME (Capital One, Goldman Sachs and Tower Research Capital
                      are not funds for this purpose — judge the ORGANISATION, then the ROLE).
                      A founder who raised money is NOT an investor; but someone who founded a fund
                      AND runs it ("Co-founder & Managing Partner @ X Ventures") IS — investor
                      first, founder second, because their job is deploying the fund.
    program_operator— runs a fellowship / accelerator / community / event programme (YC staff,
                      Cansbridge, ASES). Adjacent to investors but distinct — if the programme IS a
                      fund and the person works on its investments, they are an investor, not this.
    operator        — non-founder, non-engineer at an operating company: GTM, sales, bizops, ops.
    executive       — VP/C-level at a company they did not found.
    student         — still in school, or an internship IS their current role. An "Incoming X Intern"
                      is a student, not an engineer. EXCEPT when that internship is at an investment
                      fund, where investor comes first.
  A person is often two (a technical founder is founder+engineer). Pick from the CURRENT role first.

Weight the CURRENT role most. If a company is unknown to you, infer conservatively from the title and
blurb rather than inventing a product. Students/interns with no company: describe the field they work in.

NEVER INVENT A ROLE. If the input carries no current title, no company and no experience, return an
EMPTY personType — a skills list alone is not evidence that someone is an investor, a founder or an
executive, and a wrong label there is a person we hand to a stranger under a false description.`

export const DESCRIPTOR_SCHEMA = {
  type: "object",
  properties: {
    businessModel: { type: "array", items: { type: "string" } },
    domain: { type: "array", items: { type: "string" } },
    whatTheyBuild: { type: "string" },
    // WHAT KIND of person, not what they do. A title is a job; "investor" is a kind. Measured live
    // 2026-07-25: "angels and investors pls" returned an IBM UX designer and two software engineers,
    // because cosine can only tell that text is ABOUT investing — it cannot tell that a person IS an
    // investor. This is the facet that answers it.
    personType: { type: "array", items: { type: "string" } },
  },
  required: ["businessModel", "domain", "whatTheyBuild", "personType"],
  additionalProperties: false,
} as const

function s(v: unknown): string {
  return typeof v === "string" ? v.trim() : ""
}

/** The profile text nano sees — companies are the load-bearing part. */
export function buildDescriptorInput(d: Record<string, unknown>): string {
  const exp = (Array.isArray(d.experience) ? d.experience : []) as Array<Record<string, unknown>>
  const lines: string[] = []
  const cur = [s(d.currentTitle), s(d.currentCompany)].filter(Boolean).join(" @ ")
  if (cur) lines.push(`Current: ${cur}`)
  for (const e of exp.slice(0, 6)) {
    const head = [s(e.title), s(e.company)].filter(Boolean).join(" @ ")
    const desc = s(e.description).slice(0, 300)
    if (!head && !desc) continue
    lines.push(desc ? `- ${head}: ${desc}` : `- ${head}`)
  }
  const tags = (Array.isArray(d.sourceTags) ? d.sourceTags : []).filter((x) => typeof x === "string")
  if (tags.length) lines.push(`Skills: ${tags.slice(0, 15).join(", ")}`)
  return lines.join("\n").slice(0, 4000)
}

/** One nano call → a validated descriptor. Throws on LLM/parse failure; every caller fails soft. */
export async function describeBusiness(text: string, apiKey: string): Promise<BusinessDescriptor> {
  const res = await callWithFallback({
    apiKey,
    systemPrompt: DESCRIPTOR_SYSTEM,
    userText: text,
    schemaName: "business_descriptor",
    schema: DESCRIPTOR_SCHEMA as unknown as Record<string, unknown>,
  })
  const p = JSON.parse(res.rawJson) as Partial<BusinessDescriptor>
  const arr = (v: unknown) =>
    (Array.isArray(v) ? v : [])
      .filter((x): x is string => typeof x === "string" && x.trim().length > 0)
      .map((x) => x.trim())
      .slice(0, 3)
  return {
    businessModel: arr(p.businessModel),
    domain: arr(p.domain),
    whatTheyBuild: s(p.whatTheyBuild).slice(0, 250),
    // Closed vocabulary — anything the model invents is DROPPED rather than stored, because the
    // facet matches by exact token and an off-vocab value would silently match nothing while
    // looking populated.
    personType: arr(p.personType)
      .map((x) => x.toLowerCase().replace(/[\s-]+/g, "_"))
      .filter((x): x is (typeof PERSON_TYPE_VOCAB)[number] =>
        (PERSON_TYPE_VOCAB as readonly string[]).includes(x),
      ),
  }
}
