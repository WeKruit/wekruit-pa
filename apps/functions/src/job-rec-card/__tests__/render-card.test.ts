/**
 * render-card.test.ts — smoke test the real satori→resvg-wasm renderer.
 * Verifies the pipeline produces a valid PNG from a fully-populated payload
 * (audited fields only) AND from a minimal job-only payload (graceful omit).
 *
 * Slower than the pure tests (font + wasm init), but bounded — one cold init
 * is cached across both renders.
 */
import { test } from "node:test"
import assert from "node:assert/strict"

import { buildCardTree, renderRecCardPng } from "../render-card.js"
import { buildRecCardPayload } from "../card-payload.js"

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47]) // \x89PNG

test("buildCardTree: pure tree has no Team node (team source removed)", () => {
  const payload = buildRecCardPayload({
    job: { companyName: "Invoko", jobTitle: "Designer" },
    company: { companyStage: "series_a", employeeRange: "51-200" },
  })!
  const tree = JSON.stringify(buildCardTree(payload))
  assert.ok(!/TEAM/.test(tree))
  assert.match(tree, /Series A/)
  assert.match(tree, /51-200 people/)
})

test("buildCardTree: emits an <img> logo chip when logoDataUri present", () => {
  const payload = buildRecCardPayload({
    job: { companyName: "MetaVoice", jobTitle: "Research Scientist" },
  })!
  const dataUri =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="
  payload.logoDataUri = dataUri
  const tree = JSON.stringify(buildCardTree(payload))
  // an <img> with the data URI src — NOT a monogram chip.
  assert.match(tree, /"type":"img"/)
  assert.match(tree, /data:image\/png;base64,/)
})

test("buildCardTree: FAIL-OPEN — no logoDataUri → monogram chip, no <img>", () => {
  const payload = buildRecCardPayload({
    job: { companyName: "VoiceCursor", jobTitle: "Founding Engineer" },
  })!
  // No logoDataUri (logo fetch failed/absent) — must NOT emit an <img>.
  assert.equal(payload.logoDataUri, undefined)
  const tree = JSON.stringify(buildCardTree(payload))
  assert.ok(!/"type":"img"/.test(tree), "must not emit <img> without a data URI")
  // monogram from company initials.
  assert.match(tree, /VO/)
})

test("renderRecCardPng: FAIL-OPEN — no logo still produces a valid PNG (monogram)", async () => {
  const payload = buildRecCardPayload({
    job: { companyName: "Helium", jobTitle: "Product Engineer", locationRaw: "Remote" },
  })!
  assert.equal(payload.logoDataUri, undefined)
  const png = await renderRecCardPng(payload)
  assert.ok(png.subarray(0, 4).equals(PNG_MAGIC), "not a PNG")
  assert.ok(png.length > 1000)
})

test("renderRecCardPng: with logoDataUri → valid PNG (logo embedded, no egress)", async () => {
  const payload = buildRecCardPayload({
    job: { companyName: "MetaVoice", jobTitle: "Research Scientist", locationRaw: "Remote" },
  })!
  // A real 1x1 PNG data URI — satori embeds it without any network fetch.
  payload.logoDataUri =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="
  const png = await renderRecCardPng(payload)
  assert.ok(png.subarray(0, 4).equals(PNG_MAGIC), "not a PNG")
  assert.ok(png.length > 1000)
})

test("renderRecCardPng: full payload → valid PNG buffer", async () => {
  const payload = buildRecCardPayload({
    job: {
      companyName: "Invoko",
      jobTitle: "Senior Product Designer",
      seniorityLevel: "senior",
      salaryMin: 200000,
      salaryMax: 400000,
      locationRaw: "SF",
      jobType: "in-office full_time",
      reason: "your Figma + design-systems work lines up directly",
    },
    company: {
      companyStage: "series_a",
      employeeRange: "51-200",
      industry: "fintech",
      hqLocation: "San Francisco",
      logoUrl: "https://logo.clearbit.com/invoko.com",
      wekruitCollab: true,
      fundingRounds: [{ round: "series_a", amount: 26, date: "2024-06-01", investors: ["sequoia", "a16z"] }],
    },
    reasons: { whyFits: ["Figma + design systems", "fintech lane"], whyCompany: ["ships fast", "design-led"] },
  })!
  const png = await renderRecCardPng(payload)
  assert.ok(Buffer.isBuffer(png))
  assert.ok(png.length > 2000, `png too small: ${png.length}`)
  assert.ok(png.subarray(0, 4).equals(PNG_MAGIC), "not a PNG")
})

test("renderRecCardPng: minimal job-only payload still renders a valid PNG", async () => {
  const payload = buildRecCardPayload({
    job: { companyName: "Rainforest", jobTitle: "Backend Engineer", locationRaw: "Remote" },
  })!
  const png = await renderRecCardPng(payload)
  assert.ok(png.subarray(0, 4).equals(PNG_MAGIC))
  assert.ok(png.length > 1000)
})
