// @ts-nocheck - landing app typecheck only includes Vite/browser types; this file runs with node --test via tsx.
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import test from "node:test"

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(resolve(here, "PublicJob.tsx"), "utf8")

test("PublicJob frames role entry as Claire-first passed-profile flow", () => {
  assert.doesNotMatch(source, /Meet the hiring manager/)
  assert.doesNotMatch(source, /interview \$\{seats === 1 \? "seat" : "seats"\} this week/)
  assert.doesNotMatch(source, /job\.interviewSeats \?\? 3/)
  assert.doesNotMatch(source, /interviewSeats: job\.interviewSeats \?\? \(\(h % 4\) \+ 1\)/)
  assert.doesNotMatch(source, /Claire interview \$\{seats === 1 \? "slot" : "slots"\} this week/)
  assert.doesNotMatch(source, /See Claire-ready roles/)
  assert.doesNotMatch(source, /It may have filled or been pulled back\./)
  assert.doesNotMatch(source, />\s*Interview for this job\s*</)
  assert.doesNotMatch(source, /See open interviews/)
  assert.match(source, /Passed profile shared with consent/)
  assert.match(source, /Claire starts with the role interview/)
  assert.match(source, /See public roles/)
  assert.match(source, /Start Claire interview/)
})

test("PublicJob first-viewport process strip shows the role interview contract, not a generic apply funnel", () => {
  assert.doesNotMatch(source, /const steps = \["Upload your resume", "Interview with Claire", "Passed profile to hiring team"\]/)
  assert.match(source, /label: "Attach resume signals"/)
  assert.match(source, /body: "Claire keeps this role tied to your durable WeKruit profile\."/)
  assert.match(source, /label: "Prove nearest work"/)
  assert.match(source, /body: "Claire probes for the closest evidence before any hard stop\."/)
  assert.match(source, /label: "Passed profile shared with consent"/)
  assert.match(source, /body: "Only passed, candidate-approved evidence reaches the hiring team\."/)

  assert.doesNotMatch(source, /<p className="wk-eyebrow">How it works<\/p>/)
  assert.match(source, /<p className="wk-eyebrow">Role interview plan<\/p>/)
})

test("PublicJob exposes Claire's role interview contract before signup", () => {
  assert.match(source, /function ClaireInterviewContract/)
  assert.match(source, /Claire will check/)
  assert.match(source, /Nearest matching work/)
  assert.match(source, /Role constraints/)
  assert.match(source, /Candidate-controlled sharing/)
  assert.match(source, /Claire asks for nearest-overlap evidence before any hard stop/)
  assert.match(source, /A not-pass stays role-specific and improves future matching/)
  assert.equal((source.match(/<ClaireInterviewContract \/>/g) ?? []).length, 1)
  assert.equal((source.match(/<ClaireInterviewContract compact \/>/g) ?? []).length, 1)

  assert.doesNotMatch(source, /we submit you automatically/i)
  assert.doesNotMatch(source, /hiring team sees every candidate/i)
})

test("PublicJob keeps both interview entry methods reachable in the mobile sign-in modal", () => {
  assert.match(source, /<ClaireInterviewContract compact \/>[\s\S]*\{renderLoginControls\("modal"\)\}/)
  assert.match(source, /\.wk-pj-contract--compact[\s\S]*\.wk-pj-contract__item em\s*\{\s*display: none;/)
})

test("PublicJob keeps the role page visible until the candidate starts Claire", () => {
  assert.doesNotMatch(source, /loginPromptAutoOpened/)
  assert.doesNotMatch(source, /loginPromptDismissed/)
  assert.doesNotMatch(source, /loading \|\| !job \|\| user !== null[\s\S]*setLoginPromptOpen\(true\)/)
  assert.match(source, /onApply=\{\(\) => \{[\s\S]*if \(!user\) \{[\s\S]*setLoginPromptOpen\(true\)/)
  assert.match(source, /loginPromptOpen && !user/)
})

test("PublicJob resume upload avoids internal configuration errors", () => {
  assert.doesNotMatch(source, /CV ingest endpoint is not configured/)
  assert.match(source, /Resume upload is temporarily unavailable\. Message Claire and we'll attach it to this role\./)
})

test("PublicJob resume upload avoids status-code fallback errors", () => {
  assert.doesNotMatch(source, /Upload failed \(\$\{res\.status\}\)/)
  assert.doesNotMatch(source, /Upload failed \(\$\{status\}\)\. Try again\./)
  assert.match(source, /Resume upload did not finish\. Message Claire and we'll attach it to this role\./)
})

test("PublicJob resume gate keeps upload framed as role-interview continuity", () => {
  assert.match(source, /Checking the resume Claire needs for this role interview\./)
  assert.match(source, /Upload your resume to keep this role attached\./)
  assert.match(source, /unlock Claire's role interview/)
  assert.match(source, /Role context is saved while your resume is parsed and labeled\./)
  assert.match(source, /We will use it to keep this role attached to Claire's interview\./)
  assert.match(source, /Resume parsed\. Rechecking this role interview\./)
  assert.match(source, /selected\. Upload it to keep this role attached\./)
  assert.match(source, /Open role interview/)

  assert.doesNotMatch(source, /Checking resume…/)
  assert.doesNotMatch(source, /Upload resume to continue/)
  assert.doesNotMatch(source, /Upload it to continue/)
  assert.doesNotMatch(source, /Open interview"/)
})

test("PublicJob formats job type metadata before rendering candidate-visible labels", () => {
  assert.match(source, /import \{ formatPublicJobType \} from "\.\.\/lib\/public-job-labels\.js"/)
  assert.match(source, /jobType: formatPublicJobType\(cfg\.jobType\)/)
  assert.doesNotMatch(source, /jobType: cfg\.jobType/)
  assert.doesNotMatch(source, /role\.jobType\?\.replace\(\//)
})
