import { CSV_COLUMNS, CSV_ROWS, SOURCE_RECORDS, DEMO_NETWORK_ROWS, type SourceRow } from "./catchem-candidates.js"

export const STARTER_PROMPT = "Find a Founding CEO for Catchem, a US-remote platform bringing graded trading cards on-chain. Prioritize technical builders who have shipped a venture or product, understand TCGs or graded collectibles, and can own launch, community, growth, partnerships, and fundraising. Treat crypto experience as a bonus. Rank the imported candidates by job-relevant evidence, flag high signals and gaps, and mark people in WeKruit’s network."
export const JOB_URL = "https://wekruit.com/j/catchem-founding-ceo"
export type Candidate = { id: string; source: "import" | "profile"; row: SourceRow; network: boolean; sources: typeof SOURCE_RECORDS[number] }
const aniRow = { ...Object.fromEntries(CSV_COLUMNS.map(key => [key, ""])), name: "Anirudh (Ani) Manjesh", linkedin_url: "https://www.linkedin.com/in/amanjesh/", location: "San Francisco Bay Area", current_role: "Ada Labs", venture_evidence: "Public profile lists Ada Labs; specific venture ownership and traction need confirmation.", technical_evidence: "Public profile describes machine-learning research and building experimental rigs. Software delivery depth needs confirmation.", card_evidence: "Not supplied; TCG or collector experience needs confirmation.", outreach_hook: "Reconnect through WeKruit’s founder community and share the Catchem brief.", rule_us_based: "match", source_url: "https://www.linkedin.com/in/amanjesh/" } as SourceRow
Object.assign(aniRow, { current_role: "Startup builder · Afore Capital", venture_evidence: "Building startups at Afore Capital, according to his conversation with Claire as relayed by Noah. Ownership, shipped products, and traction need confirmation.", card_evidence: "Previously traded cards, according to his conversation with Claire as relayed by Noah.", outreach_hook: "Connect his card-trading background and current startup building at Afore Capital to Catchem’s founder opportunity.", rule_card_enthusiast: "match", rule_prior_venture: "match" })
export const CANDIDATES: Candidate[] = [
  ...CSV_ROWS.map((row, index) => ({ id: row.name === "Lei Liu" ? "lei-liu" : `import-${index + 1}`, source: "import" as const, row, sources: SOURCE_RECORDS[index], network: row.name !== "Lei Liu" && DEMO_NETWORK_ROWS.includes(index) })),
  { id: "ani", source: "profile", row: aniRow, network: true, sources: [{ file: "LinkedIn public profile", row: 1, fields: { name: aniRow.name, linkedin_url: aniRow.linkedin_url, location: aniRow.location, listed_company: "Ada Labs", profile_evidence: aniRow.technical_evidence, source_url: aniRow.source_url } }, { file: "Claire conversation · relayed by Noah", row: 1, fields: { card_signal: "Traded cards in high school.", venture_signal: "Building startups at Afore Capital.", network_status: "Within WeKruit’s network, confirmed by Noah.", reply_status: "Replied, confirmed by Noah; exact reply text not supplied.", provenance: "User-provided context; Claire’s underlying transcript was not fetched." } }] },
]
export type Focus = "balanced" | "cards" | "founder" | "technical" | "web3"
export type Filters = { network: boolean; us: boolean; strong: boolean; query: string; focus: Focus }
export const DEFAULT_FILTERS: Filters = { network: false, us: false, strong: false, query: "", focus: "balanced" }
export const FOCUS_LABELS: Record<Focus, string> = { balanced: "Best evidence match", cards: "Cards & collectibles", founder: "Venture ownership", technical: "Technical depth", web3: "Web3 experience" }
const WEIGHTS: Record<Focus, number[]> = {
  balanced: [25, 30, 25, 15, 5], cards: [20, 20, 45, 10, 5],
  founder: [20, 45, 20, 10, 5], technical: [45, 20, 20, 10, 5], web3: [20, 25, 20, 10, 25],
}
export function evidence(candidate: Candidate) {
  const r = candidate.row
  if (candidate.id === "ani") return { axes: [.6, .8, 1, .7, 0], signals: ["Card trading · Claire", "Startup builder · Afore", "Research experience"], gaps: ["Venture ownership, shipped products, and traction need confirmation.", "Technical delivery, full-time availability, and compensation fit need confirmation."], reason: "Claire conversation, relayed by Noah: card-trading experience and building startups at Afore Capital. Technical delivery and venture outcomes remain to be verified." }
  // Only job-relevant fields inform this provisional evidence rubric. Never use
  // age, school, graduation year, original fit score/rationale, or personal traits.
  const technical = `${r.technical_evidence} ${r.current_role}`
  const venture = r.venture_evidence
  const card = r.card_evidence
  const founder = /(?:exited founder|\bco.?founder\b|\bfounded\b|\bfounder\b)/i.test(technical) || r.rule_prior_venture === "match"
  const cardRelated = /(?:\btcgs?\b|pok[eé]mon|tcgplayer|magic.the.gathering|graded.card|trading.card|sports.card|lorcana|y[uū].?gi.?oh|one.piece.card|\bmtg\b)/i.test(card) && !/^No evidence/i.test(card)
  const indirectCard = /Personal website for|native notch cards|spoken yes\/no verdict/i.test(card)
  const commercialCards = cardRelated && !indirectCard && /(?:graded|grading|\bpsa\b|slab|auction|marketplace|buying\/selling|pricing|prices|fulfillment|selling inventory|sold prices)/i.test(card)
  const web3 = /(?:\bweb3\b|\bblockchain\b|\bchainlink\b|on.chain|collector crypt|token fees)/i.test(`${technical} ${card}`)
  const techDepth = /(?:engineer|\bswe\b|full.stack|\bpython\b|\btypescript\b|\breact\b|\bbackend\b|technical product|\bsoftware\b)/i.test(technical)
  const traction = /(?:\$[\d,.]+|\b[\d,.]+[kKmM]?\+?\s+(?:users|orders|signups|members)|\bMRR\b|millions in sales)/.test(venture)
  const growth = traction || /(?:public users|community|lead conversion|fundrais|partnership|growth|led eng)/i.test(`${technical} ${venture}`)
  const axes = [techDepth ? 1 : r.github_url ? .8 : .3, founder ? 1 : /shipped|built|author of/i.test(venture) ? .55 : .15, commercialCards ? 1 : cardRelated && !indirectCard ? .75 : .15, growth ? .7 : 0, web3 ? 1 : 0]
  const signals = [traction && "Reported traction", founder && "Venture / product", commercialCards && "Card commerce", cardRelated && !indirectCard && !commercialCards && "TCG experience", techDepth && "Technical depth", web3 && "Web3 overlap", growth && !traction && "Launch / leadership evidence"].filter(Boolean) as string[]
  const gaps = [!founder && "Founder ownership and venture traction not established.", !growth && "Community, growth, and fundraising results not established.", (!cardRelated || indirectCard || /unconfirmed|not independently|not yet|team.level|personal.*(?:unverified|pending|not)/i.test(card)) && "Personal collector experience needs confirmation.", r.rule_us_based !== "match" && "US location needs confirmation.", "Full-time availability and acceptance of the initial compensation need confirmation."].filter(Boolean) as string[]
  return { axes, signals, gaps, reason: `${signals.join("; ") || "Public project evidence"}. ${gaps[0]}` }
}
export function fitScore(candidate: Candidate, focus: Focus = "balanced"): number | null {
  return Math.round(evidence(candidate).axes.reduce((sum, value, i) => sum + value * WEIGHTS[focus][i], 0))
}
export function scoreBreakdown(candidate: Candidate, focus: Focus) {
  return ["Technical work", "Venture / shipped product", "Cards & collectibles", "Launch / leadership", "Web3 bonus"].map((label, i) => ({ label, points: Math.round(evidence(candidate).axes[i] * WEIGHTS[focus][i] * 10) / 10, max: WEIGHTS[focus][i] }))
}
export function rankCandidates(candidates: Candidate[], filters: Filters): Candidate[] {
  return candidates.filter((candidate) => {
    const r = candidate.row
    return (!filters.network || candidate.network)
      && (!filters.us || r.rule_us_based === "match")
      && (!filters.strong || (fitScore(candidate, filters.focus) ?? -1) >= 70)
      && (!filters.query || [r.name, r.location, r.current_role, r.technical_evidence, r.venture_evidence, r.card_evidence].join(" ").toLowerCase().includes(filters.query.toLowerCase()))
  }).sort((a, b) => (fitScore(b, filters.focus) ?? -1) - (fitScore(a, filters.focus) ?? -1) || a.row.name.localeCompare(b.row.name))
}
export function refineRequest(text: string, current: Filters): { filters: Filters; reply: string; sequence?: boolean } {
  const q = text.toLowerCase()
  const filters = { ...current }
  if (/\b(age|young|younger|graduate|graduation|2021|gender|race)\b/.test(q)) return { filters, reply: "I can refine by technical work, venture ownership, card experience, US location, or network. Age, graduation year, and personal traits do not affect the fit ranking." }
  if (/\b(reset|clear|everyone|all candidates)\b/.test(q)) return { filters: { ...DEFAULT_FILTERS }, reply: `Reset to all ${CANDIDATES.length} contacts, sorted by job-relevant evidence from your source files.` }
  let changed = false
  if (/network|warm|connection/.test(q)) { filters.network = !/outside|remove|ignore/.test(q); changed = true }
  if (/\bus\b|united states|us-based/.test(q)) { filters.us = !/anywhere|remove|ignore/.test(q); changed = true }
  if (/high.signal|strong|70\+|best fit/.test(q)) { filters.strong = true; changed = true }
  if (/\bfounder|venture|startup/.test(q)) { filters.focus = "founder"; changed = true }
  if (/technical|engineer/.test(q)) { filters.focus = "technical"; changed = true }
  if (/\b(cards?|collectibles|collector|tcg|pokemon)\b/.test(q)) { filters.focus = "cards"; changed = true }
  if (/web3|crypto|on.chain/.test(q)) { filters.focus = "web3"; changed = true }
  const name = /(?:show|find)\s+(lei(?: liu)?)/.exec(q)
  if (name) { filters.query = "Lei Liu"; filters.us = false; filters.strong = false; changed = true }
  const sequence = /outbound|sequence|reach out/.test(q)
  if (sequence) return { filters, sequence: true, reply: "Opening the sequence editor for your selection. If nothing is selected, I’ll include all 121 candidates. Five are in WeKruit’s network; Lei is an external contact. You can edit every message before starting outreach." }
  return changed ? { filters, reply: `Updated the search: ${FOCUS_LABELS[filters.focus].toLowerCase()}${filters.network ? ", WeKruit network only" : ""}${filters.us ? ", US location marked in the CSV" : ""}${filters.strong ? ", evidence score 70+" : ""}. ${rankCandidates(CANDIDATES, filters).length} contacts match. Review the signals and verification gaps before outreach.` } : { filters, reply: "I can refine by network, US location, high signals, founder experience, technical depth, cards, and Web3. Try “prioritize graded cards,” “show my network,” or “set up a sequence.”" }
}

export type Step = { title: string; waitDays: number; body: string }
export const DEFAULT_STEPS: Step[] = [
  { title: "A personal introduction", waitDays: 0, body: "Hi {{first_name}}, I’m reaching out on Noah’s behalf about Catchem’s Founding CEO opportunity. {{signal}} Catchem brings graded trading cards on-chain, with a built product and founder-level equity. Would you be open to a short conversation?" },
  { title: "Share the opportunity", waitDays: 3, body: "Hi {{first_name}}, a little more context: this is a full-time, US-remote role owning launch, community, growth, partnerships, and fundraising. The initial six-month period pays $2,500–$4,000/month plus founder-level equity. Here’s the role: https://wekruit.com/j/catchem-founding-ceo. Interested in exploring it?" },
  { title: "One final check-in", waitDays: 7, body: "Hi {{first_name}}, one final check-in on Catchem. If the timing is right, you can find Noah here: https://cal.com/noah-liu-wzqq8w/chat-with-noah. If it’s not a fit, no worries — I’ll close the loop." },
]
export function personalize(body: string, candidate: Candidate) {
  const signals = evidence(candidate).signals
  return body.replaceAll("{{first_name}}", candidate.id === "ani" ? "Ani" : candidate.row.name.split(" ")[0]).replaceAll("{{signal}}", candidate.id === "lei-liu" ? "Noah was interested in what you’re building and thought it would be worth connecting." : candidate.id === "ani" ? "Your card-trading background and the startups you’re building at Afore Capital came up in your conversation with Claire — a compelling overlap with Catchem." : `Your ${signals[0]?.toLowerCase() || "public project work"} caught our attention.`)
}
export type Message = { sender: "agent" | "candidate"; at: string; body: string; link?: string; attachment?: string }
// Demo adaptation supplied by the user. These are not actual automated sends.
export const LEI_THREAD: Message[] = [
  { sender: "agent", at: "Opening · 6:20 PM", body: "Hi Lei, I’m reaching out on Noah’s behalf. He’s interested in what you’re building and knows someone who may invest. Would you be open to chatting?" },
  { sender: "candidate", at: "6:21 PM", body: "Hi Noah, let me know when you're free for a chat. I should have some time this week if you're available." },
  { sender: "agent", at: "6:25 PM", body: "Are you available for a quick chat now?" },
  { sender: "agent", at: "6:43 PM", body: "Let’s find a time on Noah’s calendar.", link: "https://cal.com/noah-liu-wzqq8w/chat-with-noah" },
  { sender: "candidate", at: "7:03 PM", body: "Hi Noah, sorry I am not free tonight. I can find a time in the afternoon tomorrow that we can talk." },
  { sender: "agent", at: "7:07 PM", body: "Sounds good — looking forward to it." },
  { sender: "candidate", at: "7:45 PM", body: "Hi Noah, scheduled a chat for 1:30PM CST for tomorrow. Looking forward to chatting." },
  { sender: "agent", at: "Sep 15 · 11:43 AM", body: "Here’s the Catchem Founding CEO brief and background on Draper Dragon and Draper Associates.", attachment: "Catchem · Founding CEO brief", link: JOB_URL },
  { sender: "candidate", at: "Sep 15 · 12:04 PM", body: "Hi Noah, I read through the description and I am interested in setting up a meeting with Draper Dragon to discuss the opportunity. Here is my meeting times available. Looking forward to hearing back.", link: "https://calendly.com/lei-curateplatform/30min" },
  { sender: "agent", at: "Sep 15 · 12:12 PM", body: "Great — your availability has been shared with the investor." },
  { sender: "agent", at: "Sep 18 · 1:09 PM", body: "How was the chat?" },
  { sender: "candidate", at: "Sep 18 · 3:28 PM", body: "Hi Noah, Ryo had a conflict and rescheduled the chat for Monday." },
]
export const ANI_THREAD: Message[] = [
  { sender: "agent", at: "Day 0", body: "Hi Ani — reaching out on Noah’s behalf through WeKruit. Claire noted your card-trading background and that you’re building startups at Afore Capital. Catchem is looking for a Founding CEO to launch a graded-card platform. Open to taking a look?" },
  { sender: "candidate", at: "Day 0 · reply", body: "Hey, thanks for thinking of me! Could you send me the role brief and a little more context on the team?" },
  { sender: "agent", at: "Day 0 · follow-up", body: "Of course. Here’s the role brief — it covers the product, founder equity, and the initial six-month period. Happy to connect you with Noah if you’d like to explore it.", link: JOB_URL },
]
export type Campaign = { id: string; recipientIds: string[]; steps: Step[]; paused: boolean; followupStage: number; followupBatches: string[][]; replied: boolean; aniReplied: boolean; extraMessages: Record<string, Message[]> }
/** The walkthrough opens after first-touch outreach to the entire imported pool. */
export function contactedCampaign(saved?: Campaign | null): Campaign {
  return {
    id: "catchem-existing-outreach",
    steps: DEFAULT_STEPS.map(step => ({ ...step })),
    paused: false,
    followupStage: 0,
    followupBatches: [],
    extraMessages: {},
    ...saved,
    recipientIds: CANDIDATES.map(candidate => candidate.id),
    replied: true,
    aniReplied: true,
  }
}
export function hasReplied(id: string, campaign: Campaign | null) { return !!campaign?.recipientIds.includes(id) && (id === "lei-liu" && campaign.replied || id === "ani" && campaign.aniReplied) }
export function metrics(campaign: Campaign | null) {
  const sent = campaign?.recipientIds.length ?? 0
  const lei = hasReplied("lei-liu", campaign) ? 1 : 0
  const ani = hasReplied("ani", campaign) ? 1 : 0
  const replied = lei + ani
  const threadMessages = (lei ? LEI_THREAD.filter(m => m.sender === "agent").length - 1 : 0) + (ani ? ANI_THREAD.filter(m => m.sender === "agent").length - 1 : 0)
  const messages = sent + (campaign?.followupBatches.reduce((sum, batch) => sum + batch.length, 0) ?? 0) + threadMessages + (campaign ? Object.values(campaign.extraMessages).flat().filter(m => m.sender === "agent").length : 0)
  return { sent, replied, interested: lei, meeting: lei, messages, awaiting: sent - replied, replyRate: sent ? Math.round(replied / sent * 1000) / 10 : 0 }
}
export function status(candidate: Candidate, campaign: Campaign | null) {
  if (!campaign?.recipientIds.includes(candidate.id)) return "Not contacted"
  if (candidate.id === "lei-liu" && campaign.replied) return "Interested · rescheduled"
  if (candidate.id === "ani" && campaign.aniReplied) return "Replied · requested brief"
  return campaign.paused ? "Contacted · paused" : "Contacted · awaiting reply"
}
