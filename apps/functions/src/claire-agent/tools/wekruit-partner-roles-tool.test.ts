/**
 * The narrow Adam-authorized exception (2026-07-25) must not become a hole. These lock:
 *   (a) the tool is YC-ONLY — absent from every other lane, and it does NOT re-open any job tool;
 *   (b) the YC prompt still forbids volunteering job content, and gates the tool on the user's ask;
 *   (c) the delivery-seam scrub still kills an unsolicited "want me to pull roles" while the
 *       user-requested partner list passes through byte-identical.
 *
 * Run: node --import tsx --test apps/functions/src/claire-agent/tools/wekruit-partner-roles-tool.test.ts
 */
import assert from "node:assert/strict"
import test from "node:test"

import { buildClaireTools } from "./index.js"
import {
  formatPartnerRolesBubble,
  isEligiblePartnerJob,
  toPartnerRole,
  PARTNER_ROLES_BROWSE_URL,
  type PartnerRole,
} from "./wekruit-partner-roles-tool.js"
import { buildClairePrompt } from "../prompt.js"
import { scrubYcJobOffers, scrubYcJobOffersFromBubble } from "../yc-people-guard.js"
import type { ClaireToolContext } from "../types.js"

const ctx = {
  userId: "8fEwIduUrzxZsblHHsNz",
  sessionId: "ses_x",
  transport: {
    tapback: async () => {},
    noReply: async () => {},
    sendStatus: async () => {},
    sendText: async () => {},
    typing: async () => {},
    markRead: async () => {},
    sendReadReceipt: async () => {},
  },
  findMatch: async () => ({ roles: [], delivered: false }),
} as unknown as ClaireToolContext

const names = (tools: ReadonlyArray<unknown>): string[] =>
  tools.map((t) => (t as { name?: string }).name ?? "").filter(Boolean)

const TOOL = "show_wekruit_partner_roles"
const YC = { mode: "triage" as const, lang: "en" as const, entryPosture: "yc_startup_school" as const }
const NORMAL = { mode: "triage" as const, lang: "en" as const }

// Real shape (live pa-jobs, 2026-07-25): 33 eligible roles across 11 partner companies.
const LIVE_SAMPLE: PartnerRole[] = [
  { company: "Sekai", title: "AI Product Engineer" },
  { company: "Sekai", title: "Technical Lead" },
  { company: "Sekai", title: "Founding Product Designer" },
  { company: "Sekai", title: "Senior Analytics Engineer" },
  { company: "invoko.ai", title: "Product Manager" },
  { company: "invoko.ai", title: "UI/UX Designer" },
  { company: "Helium", title: "Product Engineer (Full-Stack)" },
  { company: "VoiceCursor", title: "Founding Engineer" },
]

// ------------------------------------------------------- (a) tool scoping

test("show_wekruit_partner_roles is YC-ONLY — absent from every non-YC lane", () => {
  const normal = names(buildClaireTools(ctx))
  assert.equal(
    normal.includes(TOOL),
    false,
    `a non-YC agent must NEVER see the partner-roles tool; got ${normal.join(",")}`,
  )
  const pitchTurn = names(buildClaireTools(ctx, { forbidSuppressingDelivery: true }))
  assert.equal(pitchTurn.includes(TOOL), false, "not on the pitch turn either")

  const yc = names(buildClaireTools(ctx, { ycPeopleMode: true }))
  assert.ok(yc.includes(TOOL), `YC lane exposes the partner-roles tool; got ${yc.join(",")}`)
})

test("the exception does NOT re-open any job tool — the omission invariant is literally unchanged", () => {
  const yc = names(buildClaireTools(ctx, { ycPeopleMode: true }))
  for (const n of [
    "find_match",
    "match_collab",
    "save_job_profile",
    "set_daily_subscription",
    "find_my_role",
    "begin_collab_prescreen",
    "get_public_role_start",
    "set_matching_preferences",
    "capture_match_feedback",
    "check_prescreen_progress",
  ]) {
    assert.equal(yc.includes(n), false, `YC lane must STILL NOT expose ${n}; got ${yc.join(",")}`)
  }
})

// ------------------------------------------------------- (b) prompt gating

test("YC prompt still forbids volunteering job content, and gates the tool on THEIR ask", () => {
  const p = buildClairePrompt(YC)
  // The blanket bans survive verbatim.
  assert.match(p, /ABSOLUTELY NO JOB CONTENT AND NO JOB QUESTIONS/i)
  assert.match(p, /Do NOT ask 'want me to pull roles now\?'/i)
  // The exception is present AND explicitly user-initiated + never-volunteered.
  assert.match(p, /show_wekruit_partner_roles/)
  assert.match(p, /ONLY WHEN THEY ASK FIRST/i)
  assert.match(p, /NEVER bring it up yourself/i)
  assert.match(p, /NEVER follow a people\s+match with it/i)
  assert.match(p, /never ask whether THEY are hiring/i)
  // Still no job-search onboarding asks (the #611 / prompt-yc-no-job-asks contract).
  assert.doesNotMatch(p, /pull a few roles/i)
  assert.doesNotMatch(p, /recommendations → find_match/i)
})

test("the exception never leaks into the normal candidate prompt", () => {
  assert.doesNotMatch(buildClairePrompt(NORMAL), /show_wekruit_partner_roles/)
})

// ------------------------------------------------------- (c) scrub interaction

test("the scrub STILL kills an unsolicited 'want me to pull roles' offer", () => {
  const { bubbles, scrubbed } = scrubYcJobOffers([
    "want me to pull a few roles that fit this kind of cv/ml focus?",
  ])
  assert.equal(scrubbed, 1, "the model volunteering roles must still be scrubbed")
  assert.doesNotMatch(bubbles[0]!, /pull a few roles/i)
})

test("the user-requested partner list survives the scrub byte-identical", () => {
  // The list is delivered via ctx.transport inside the tool, so it never reaches the model-bubble
  // scrub at all. Asserted anyway: even if it were routed through, the copy carries no offer
  // pattern — so the exception needs NO regex carve-out and the ban on offers stays absolute.
  const text = formatPartnerRolesBubble(LIVE_SAMPLE)
  assert.equal(scrubYcJobOffersFromBubble(text), text)
  const { bubbles, scrubbed } = scrubYcJobOffers([text])
  assert.equal(scrubbed, 0)
  assert.equal(bubbles[0], text)
})

// ------------------------------------------------------- copy + eligibility

test("bubble copy is honest — current list, no match claim, no apply pitch", () => {
  const text = formatPartnerRolesBubble(LIVE_SAMPLE)
  assert.match(text, /since you asked/i)
  assert.match(text, /nothing matched to you/i)
  assert.doesNotMatch(text, /you should apply|apply now|perfect fit|great fit|hiring you/i)
  assert.ok(text.includes(PARTNER_ROLES_BROWSE_URL))
  // Grouped by company, alphabetical, per-company overflow rolled up.
  const lines = text.split("\n").filter((l, i) => i > 0 && l.includes(" — "))
  assert.deepEqual(
    lines.map((l) => l.split(" — ")[0]),
    ["Helium", "invoko.ai", "Sekai", "VoiceCursor"],
  )
  assert.ok(
    lines.some((l) => l.startsWith("Sekai — ") && /\(\+1 more\)$/.test(l)),
    `Sekai's 4 roles must show 3 + "(+1 more)"; got ${lines.join(" | ")}`,
  )
})

test("eligibility mirrors the public partner feed exactly", () => {
  const ok = { publicVisible: true, wekruitCollaborationStatus: "collaborated" }
  assert.equal(isEligiblePartnerJob(ok), true)
  assert.equal(isEligiblePartnerJob({ ...ok, dead: true }), false, "dead role never listed")
  assert.equal(
    isEligiblePartnerJob({ ...ok, publicVisible: false }),
    false,
    "non-public role never listed",
  )
  assert.equal(
    isEligiblePartnerJob({ publicVisible: true, wekruitCollaborationStatus: "not_collaborated" }),
    false,
    "scraped / non-partner job never listed",
  )
})

test("toPartnerRole takes the live field fallbacks and drops incomplete docs", () => {
  assert.deepEqual(toPartnerRole({ title: "Backend Engineer", companyName: "Photon" }), {
    company: "Photon",
    title: "Backend Engineer",
  })
  assert.deepEqual(toPartnerRole({ jobTitle: "AI Builder (NYC)", company: "Hyde" }), {
    company: "Hyde",
    title: "AI Builder (NYC)",
  })
  assert.equal(toPartnerRole({ title: "Orphan role" }), null)
})
