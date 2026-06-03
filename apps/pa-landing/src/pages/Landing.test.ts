// @ts-nocheck - landing app typecheck only includes Vite/browser types; this file runs with node --test via tsx.
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import test from "node:test"

const here = dirname(fileURLToPath(import.meta.url))
const landingSource = readFileSync(resolve(here, "Landing.tsx"), "utf8")
const sequenceSource = readFileSync(resolve(here, "../components/Sequence.tsx"), "utf8")
const source = `${landingSource}\n${sequenceSource}`

test("Landing frames the candidate promise as Claire-first passed-profile flow", () => {
  assert.doesNotMatch(source, /interview directly with the hiring manager/i)
  assert.doesNotMatch(source, /hiring managers who want to meet you this week/i)
  assert.doesNotMatch(source, /hiring managers<\/strong> taking interviews this week/i)
  assert.doesNotMatch(source, /Claire texts back within a minute/i)
  assert.doesNotMatch(source, /interview seats fill up/i)
  assert.doesNotMatch(source, /Got <em className="wk-accent">3 interviews<\/em> in a week/i)
  assert.doesNotMatch(source, /direct first interview with the hiring manager/i)
  assert.doesNotMatch(source, /No recruiter screen|No take-home tournament|Calendar invite in 48 hours/i)
  assert.doesNotMatch(source, />\s*Interview with hiring manager\s*</i)
  assert.match(source, /builds one WeKruit profile that keeps working across roles/i)
  assert.match(source, /Claire starts the first interview/i)
  assert.match(source, /passed profile/i)
})

test("Landing does not invent role availability or interview scarcity", () => {
  assert.doesNotMatch(landingSource, /claireReadyCount \|\| jobs\.length \|\| 6/)
  assert.doesNotMatch(landingSource, /data\.hiringManagerOnline \?\? \(h % 3 !== 0\)/)
  assert.doesNotMatch(landingSource, /data\.interviewSeats \?\? \(\(h % 4\) \+ 1\)/)
  assert.doesNotMatch(landingSource, /I've got 3 roles I can interview you for this week/)
  assert.doesNotMatch(landingSource, /Claire-ready roles/)
  assert.doesNotMatch(landingSource, /Loading Claire-ready roles/)
  assert.doesNotMatch(landingSource, /No Claire-ready roles are open right now\. Claire will text you when one opens\./)
  assert.doesNotMatch(landingSource, /Review opens tomorrow/)
  assert.doesNotMatch(landingSource, /job\.seats/)
  assert.doesNotMatch(landingSource, /Claire interview \{job\.seats === 1 \? "slot" : "slots"\} this week/)

  assert.match(landingSource, /public roles Claire can screen against/)
  assert.match(landingSource, /Claire interviews against real role briefs/)
  assert.match(landingSource, /Claire starts with the role interview/)
  assert.match(landingSource, /No public WeKruit roles are open right now/)
})

test("Landing trust section uses product proof instead of fake customer proof", () => {
  assert.doesNotMatch(landingSource, /Anthropic", "Perplexity", "Figma", "Stripe", "Vercel", "Cursor"/)
  assert.doesNotMatch(landingSource, /Built around hiring-team signal at/)
  assert.doesNotMatch(landingSource, /Renée Holloway|Renee Holloway/)
  assert.doesNotMatch(landingSource, /matched in 9 days/)
  assert.doesNotMatch(landingSource, /Claire turned my résumé into a real role conversation/)
  assert.doesNotMatch(landingSource, /wk-trust-logos/)
  assert.doesNotMatch(landingSource, /wk-quote/)

  assert.match(landingSource, /What Claire can prove/)
  assert.match(landingSource, /Evidence packet/)
  assert.match(landingSource, /Candidate-controlled sharing/)
  assert.match(landingSource, /Profile memory/)
  assert.match(landingSource, /pass reason, risks, fit notes, and transcript excerpts/)
})

test("Landing sample artifacts avoid borrowed real-company proof", () => {
  assert.doesNotMatch(source, /Maya Okafor/)
  assert.doesNotMatch(source, /Stripe|Anthropic|Snowflake|Notion|Vercel/)
  assert.doesNotMatch(source, /Claude APIs/)
  assert.doesNotMatch(source, /Replit|Linear/)

  assert.match(source, /Sample candidate/)
  assert.match(source, /AI infra platform/)
  assert.match(source, /Developer platform/)
  assert.match(source, /Productivity suite/)
})

test("Landing explains the candidate operating model without turning into an apply board", () => {
  assert.match(landingSource, /Candidate operating model/)
  assert.match(landingSource, /Who sees my profile\?/)
  assert.match(landingSource, /What if I do not pass a role screen\?/)
  assert.match(landingSource, /Does Claire apply for me\?/)
  assert.match(landingSource, /How do corrections stick\?/)

  assert.match(landingSource, /Only employers for roles you pass and consent to share with/)
  assert.match(landingSource, /Once you enter a role flow, Claire starts the first interview/)
  assert.match(landingSource, /A not-pass is role-specific/)
  assert.match(landingSource, /Public roles are role briefs Claire can interview against/)
  assert.match(landingSource, /Corrections update your durable profile and preferences/)

  assert.doesNotMatch(landingSource, /we apply to every role/i)
  assert.doesNotMatch(landingSource, /auto-submit/i)
  assert.doesNotMatch(landingSource, /guaranteed interview/i)
})

test("Landing exposes the market source layer without becoming an apply queue", () => {
  assert.match(landingSource, /<Link to="\/market" className="wk-btn wk-btn--secondary wk-btn--lg">/)
  assert.match(landingSource, /Open market/)
  assert.match(landingSource, /Tracked roles are source evidence, not applications/)
  assert.match(landingSource, /Use roles as signal before Claire chases anything/)

  assert.doesNotMatch(landingSource, /Apply queue/i)
  assert.doesNotMatch(landingSource, /auto-submit/i)
  assert.doesNotMatch(landingSource, /we pitch you anyway/i)
})

test("Landing formats public job type chips before rendering candidate cards", () => {
  assert.match(landingSource, /import \{ formatPublicJobType \} from "\.\.\/lib\/public-job-labels\.js"/)
  assert.match(landingSource, /jobType: formatPublicJobType\(data\.jobType \?\? data\.prescreenConfig\?\.jobType\)/)
  assert.doesNotMatch(landingSource, /jobType: data\.jobType \?\? data\.prescreenConfig\?\.jobType/)
})

test("Landing sequence avoids rough job-board-as-verb copy", () => {
  assert.doesNotMatch(sequenceSource, /you don&apos;t job-board/i)
  assert.match(sequenceSource, /You don&apos;t apply, you don&apos;t chase job boards, and you don&apos;t get spammed\./)
})
