import assert from "node:assert/strict"
import { test } from "node:test"
import { IMPORT_COUNTS, SOURCE_RECORDS } from "./catchem-candidates.js"
import { CANDIDATES, DEFAULT_FILTERS, DEFAULT_STEPS, contactedCampaign, evidence, fitScore, metrics, personalize, rankCandidates, refineRequest, status, type Campaign } from "./catchem-demo-model.js"

test("all three files are reconciled without losing source records or duplicating Lei", () => {
  assert.equal(Object.values(IMPORT_COUNTS).reduce((a, b) => a + b, 0), 124)
  assert.equal(CANDIDATES.length, 121)
  assert.equal(SOURCE_RECORDS.flat().length, 124)
  assert.equal(CANDIDATES.filter(c => c.network).length, 5)
  const lei = CANDIDATES.filter(c => c.id === "lei-liu")
  assert.equal(lei.length, 1)
  assert.equal(lei[0].row.linkedin_url, "https://www.linkedin.com/in/liu-lei")
  assert.equal(lei[0].network, false)
  assert.ok(lei[0].sources.some(s => s.file.endsWith(".xlsx")))
})

test("ranking excludes school, graduation year, imported score, and network labels", () => {
  const person = CANDIDATES[0]
  const changed = { ...person, network: !person.network, row: { ...person.row, school: "Different school", graduation_year: "1960", fit_score: "0", fit_rationale: "Different age or personal trait", rule_grad_2021_plus: "miss" } }
  assert.equal(fitScore(person), fitScore(changed))
  assert.equal(rankCandidates(CANDIDATES, DEFAULT_FILTERS).length, 121)
  const originalOrder = CANDIDATES.map(c => c.id)
  rankCandidates(CANDIDATES, { ...DEFAULT_FILTERS, focus: "cards" })
  assert.deepEqual(CANDIDATES.map(c => c.id), originalOrder)
  const ranked = rankCandidates(CANDIDATES, DEFAULT_FILTERS)
  assert.ok(ranked.every((c, i) => i === 0 || fitScore(ranked[i - 1])! >= fitScore(c)!))
})

test("refinement changes the result set and focus while unsupported input is honest", () => {
  const network = refineRequest("Show my network", DEFAULT_FILTERS)
  assert.equal(rankCandidates(CANDIDATES, network.filters).length, 5)
  assert.ok(rankCandidates(CANDIDATES, network.filters).some(c => c.id === "ani"))
  assert.ok(!rankCandidates(CANDIDATES, network.filters).some(c => c.id === "lei-liu"))
  const cards = refineRequest("Prioritize graded cards", DEFAULT_FILTERS)
  assert.equal(cards.filters.focus, "cards")
  assert.notDeepEqual(rankCandidates(CANDIDATES, cards.filters).slice(0, 10).map(c => c.id), rankCandidates(CANDIDATES, DEFAULT_FILTERS).slice(0, 10).map(c => c.id))
  assert.deepEqual(refineRequest("Only younger graduates", DEFAULT_FILTERS).filters, DEFAULT_FILTERS)
  assert.match(refineRequest("Something unsupported", DEFAULT_FILTERS).reply, /I can refine/)
  assert.equal(refineRequest("Set up a sequence", DEFAULT_FILTERS).sequence, true)
})

test("source evidence distinguishes unrelated cards from TCG work", () => {
  const fraud = CANDIDATES.find(c => c.row.name === "Jeneel Panchal")!
  const founder = CANDIDATES.find(c => c.row.name === "Joseph Zhang")!
  assert.ok(fitScore(founder)! > fitScore(fraud)!)
  assert.ok(!evidence(fraud).signals.includes("Card commerce"))
  assert.ok(evidence(founder).signals.includes("Venture / product"))
})

test("campaign totals count recipients and messages separately; reply replay is idempotent", () => {
  const recipients = [...CANDIDATES.filter(c => c.network).map(c => c.id), "lei-liu"]
  const campaign: Campaign = { id: "test", recipientIds: recipients, steps: DEFAULT_STEPS, paused: false, followupStage: 0, followupBatches: [], replied: false, aniReplied: false, extraMessages: {} }
  assert.deepEqual(metrics(null), { sent: 0, replied: 0, interested: 0, meeting: 0, messages: 0, awaiting: 0, replyRate: 0 })
  assert.equal(metrics(campaign).messages, 6)
  campaign.replied = true
  campaign.aniReplied = true
  const replied = metrics(campaign)
  assert.deepEqual(replied, { sent: 6, replied: 2, interested: 1, meeting: 1, messages: 13, awaiting: 4, replyRate: 33.3 })
  assert.deepEqual(metrics({ ...campaign, replied: true }), replied)
  campaign.followupBatches = [recipients.filter(id => id !== "lei-liu" && id !== "ani")]
  campaign.followupStage = 1
  assert.equal(metrics(campaign).messages, 17)
  assert.equal(metrics(campaign).sent, 6)
  assert.equal(status(CANDIDATES.find(c => c.id === "lei-liu")!, campaign), "Interested · rescheduled")
  campaign.extraMessages["lei-liu"] = [{ sender: "agent", at: "Now", body: "A demo reply" }]
  assert.equal(metrics(campaign).messages, 18)
})

test("personalization resolves supported placeholders without inventing contacts", () => {
  const lei = CANDIDATES.find(c => c.id === "lei-liu")!
  const body = personalize(DEFAULT_STEPS[0].body, lei)
  assert.match(body, /Hi Lei/)
  assert.ok(!body.includes("{{"))
  assert.equal(lei.row.github_url, "")
})

test("Ani uses user-supplied Claire signals without gaining points for network status", () => {
  const ani = CANDIDATES.find(c => c.id === "ani")!
  assert.equal(ani.network, true)
  assert.ok(evidence(ani).signals.includes("Card trading · Claire"))
  assert.match(ani.row.venture_evidence, /Afore Capital/)
  assert.equal(fitScore(ani), fitScore({ ...ani, network: false }))
  assert.ok(fitScore(ani)! >= 70)
  assert.match(personalize(DEFAULT_STEPS[0].body, ani), /Claire/)
})

test("full-audience outreach includes every candidate and preserves the two-reply funnel", () => {
  const campaign: Campaign = { id: "all", recipientIds: CANDIDATES.map(c => c.id), steps: DEFAULT_STEPS, paused: false, followupStage: 0, followupBatches: [], replied: true, aniReplied: true, extraMessages: {} }
  assert.deepEqual(metrics(campaign), { sent: 121, replied: 2, interested: 1, meeting: 1, messages: 128, awaiting: 119, replyRate: 1.7 })
})


test("fresh, reset, and partial saved campaigns start with every candidate already contacted", () => {
  for (const saved of [undefined, null, { ...contactedCampaign(), recipientIds: ["ani"], replied: false, aniReplied: false }]) {
    const campaign = contactedCampaign(saved)
    assert.equal(metrics(campaign).sent, CANDIDATES.length)
    assert.equal(metrics(campaign).replied, 2)
    assert.ok(CANDIDATES.every(candidate => status(candidate, campaign) !== "Not contacted"))
  }
  const saved = contactedCampaign()
  saved.paused = true
  saved.extraMessages.ani = [{ sender: "agent", at: "Now", body: "Saved follow-up" }]
  assert.equal(contactedCampaign(saved).paused, true)
  assert.equal(contactedCampaign(saved).extraMessages.ani[0].body, "Saved follow-up")
})
