#!/usr/bin/env node
/**
 * v1.9 — run real-LLM simulator against all 4 seeded Handshake jobs.
 *
 * Per job: canonical strong-candidate replies → expect PASS terminal.
 *
 * Tests catch "config + LLM combo regresses to HARD_STOP" BEFORE we ask
 * a human tester to send real SMS.
 */
import { spawnSync } from "node:child_process"

const cases = [
  {
    jobId: "hs-11005382-invoko-product-designer",
    replies: [
      "I shipped 2 consumer apps end-to-end at a fintech startup over 18 months — owned visual design + flow + design system from scratch",
      "Yes — fluent in Figma, recently started prototyping with Framer and v0 for interactive demos. Shipped 3 prototypes this quarter using Cursor + Lovable.",
    ],
    expected: "PASS",
  },
  {
    jobId: "hs-11005377-invoko-ui-ux-designer",
    replies: [
      "I designed and shipped the onboarding + dashboard for a Series A consumer health app — both visual and interaction flows, 50k+ MAU",
      "I ship rough Figma prototypes within 2 days then run user feedback loops weekly — recently threw away 3 weeks of work after a usability test and rebuilt in 4 days",
    ],
    expected: "PASS",
  },
  {
    jobId: "hs-11005308-paradigm-gtm-growth",
    replies: [
      "I owned organic TikTok strategy for a learning startup — grew from 0 to 80k followers in 6 months, drove 12k signups",
      "Yes — I started a creator economy podcast from scratch as a senior. No template, designed the format, booked guests, ran ads, scaled to 200 listens/episode in 3 months",
    ],
    expected: "PASS",
  },
  {
    jobId: "hs-10996795-invoko-product-manager",
    replies: [
      "I was the first PM hire at a consumer travel app — shipped the booking flow rewrite, drove 18% conversion lift through 3 iterations driven by user interview signal",
      "I prioritize by user-signal magnitude × effort × strategic alignment — recently we cut 2 'cool' features to ship a friction-reducer that moved retention 9 pts. Boss disagreed initially, data won.",
    ],
    expected: "PASS",
  },
]

const results = []
for (const c of cases) {
  console.log(`\n${"=".repeat(70)}`)
  console.log(`SIMULATE: ${c.jobId}`)
  console.log("=".repeat(70))
  const r = spawnSync(
    "node",
    ["scripts/v19-simulate-prescreen.mjs", c.jobId, c.replies.join("|")],
    { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" }
  )
  const out = r.stdout || ""
  const last = out.split("\n").filter((l) => l.trim()).slice(-3).join("\n")
  console.log(last)
  const passed = out.includes("TERMINAL PASS")
  results.push({ jobId: c.jobId, expected: c.expected, actual: passed ? "PASS" : "FAIL/HARD_STOP/PAUSE", ok: passed })
}

console.log(`\n${"=".repeat(70)}`)
console.log("SUMMARY")
console.log("=".repeat(70))
let allOk = true
for (const r of results) {
  const mark = r.ok ? "✓" : "✗"
  console.log(`${mark} ${r.jobId}  expected=${r.expected}  actual=${r.actual}`)
  if (!r.ok) allOk = false
}
process.exit(allOk ? 0 : 1)
