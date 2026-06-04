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
  assert.match(source, /@media \(max-width: 980px\) \{[\s\S]*\.wk-pj-process-strip \{[\s\S]*grid-template-columns: 1fr;[\s\S]*gap: 8px;[\s\S]*\}/)
  assert.match(source, /@media \(max-width: 980px\) \{[\s\S]*\.wk-pj-process-strip__step \{[\s\S]*min-height: 0;[\s\S]*padding: 9px 10px;[\s\S]*align-items: center;[\s\S]*\}/)
  assert.match(source, /@media \(max-width: 980px\) \{[\s\S]*\.wk-pj-process-strip__body em \{[\s\S]*display: none;[\s\S]*\}/)
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

test("PublicJob role sign-in modal offers LinkedIn at the exact interview entry point", () => {
  assert.match(source, /const LINKEDIN_AUTH_START_URL =/)
  assert.match(source, /type LoginStatus = "idle" \| "google" \| "linkedin" \| "email" \| "sent" \| "error"/)
  assert.match(source, /function takeLinkedinAuthPayload\(\)/)
  assert.match(source, /signInWithCustomToken\(auth\(\), linkedinPayload\.customToken\)/)
  assert.match(source, /function startLinkedInSignIn\(\)/)
  assert.match(source, /const returnTo = `\$\{window\.location\.origin\}\$\{nextPath\}`/)
  assert.match(source, /window\.location\.assign\(`\$\{LINKEDIN_AUTH_START_URL\}\?returnTo=\$\{encodeURIComponent\(returnTo\)\}`\)/)
  assert.match(source, /className="wk-btn wk-btn--linkedin wk-btn--block"/)
  assert.match(source, /\{loginStatus === "linkedin" \? "Opening LinkedIn…" : "Continue with LinkedIn"\}/)
  assert.match(source, /loginStatus === "google" \|\| loginStatus === "linkedin" \|\| loginStatus === "email"/)
})

test("PublicJob modal stays focused on role context and login controls", () => {
  assert.doesNotMatch(source, /<ProcessStrip compact \/>/)
  assert.match(source, /<div className="wk-pj-modal__job" aria-label="Selected role">/)
  assert.match(source, /<ClaireInterviewContract compact \/>[\s\S]*\{renderLoginControls\("modal"\)\}/)
  assert.match(source, /Create or confirm your WeKruit profile so Claire carries your resume and this role context into the interview\./)
})

test("PublicJob keeps the role page visible until the candidate starts Claire", () => {
  assert.doesNotMatch(source, /loginPromptAutoOpened/)
  assert.doesNotMatch(source, /loginPromptDismissed/)
  assert.doesNotMatch(source, /loading \|\| !job \|\| user !== null[\s\S]*setLoginPromptOpen\(true\)/)
  assert.match(source, /onApply=\{\(\) => \{[\s\S]*if \(!user\) \{[\s\S]*setLoginPromptOpen\(true\)/)
  assert.match(source, /loginPromptOpen && !user/)
})

test("PublicJob mobile Claire CTA is inline and does not cover role content", () => {
  assert.match(
    source,
    /<div className="wk-pj-meta-row">[\s\S]*\{!signedIn \? \([\s\S]*<div className="wk-pj-mobile-apply">[\s\S]*Start Claire interview[\s\S]*<div className="wk-pj-hero__process">/,
  )
  assert.match(source, /@media \(max-width: 980px\) \{[\s\S]*\.wk-pj-mobile-apply \{[\s\S]*display: block;[\s\S]*margin-top: -4px;/)
  assert.doesNotMatch(source, /\.wk-pj-mobile-apply \{[^}]*position: fixed;/)
  assert.doesNotMatch(source, /\.wk-pj-mobile-apply \{[^}]*bottom: 0;/)
  assert.doesNotMatch(source, /\.wk-pj \{ padding-bottom: 108px; \}/)
})

test("PublicJob role hero title keeps long job names readable on mobile", () => {
  assert.match(
    source,
    /\.wk-pj-hero__role \{[\s\S]*font-size: 68px;[\s\S]*line-height: 1\.08;[\s\S]*letter-spacing: 0;/,
  )
  assert.match(
    source,
    /@media \(max-width: 980px\) \{[\s\S]*\.wk-pj-hero__role \{ font-size: 44px; line-height: 1\.14; \}/,
  )
  assert.match(
    source,
    /@media \(max-width: 480px\) \{[\s\S]*\.wk-pj-hero__role \{ font-size: 38px; line-height: 1\.16; \}/,
  )
  assert.match(
    source,
    /@media \(min-width: 981px\) and \(max-width: 1180px\) \{[\s\S]*\.wk-pj-hero__role \{ font-size: 58px; line-height: 1\.1; \}/,
  )
  assert.doesNotMatch(source, /\.wk-pj-hero__role \{[\s\S]*font-size: clamp\(46px, 5\.8vw, 76px\);/)
  assert.doesNotMatch(source, /\.wk-pj-hero__role \{[\s\S]*line-height: 0\.98;/)
  assert.doesNotMatch(source, /\.wk-pj-hero__role \{[\s\S]*letter-spacing: -0\.024em;/)
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
