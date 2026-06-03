// @ts-nocheck - landing app typecheck only includes Vite/browser types; this file runs with node --test via tsx.
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import test from "node:test"

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(resolve(here, "CandidateLogin.tsx"), "utf8")

test("CandidateShell does not hardcode a fake Claire SMS handoff", () => {
  assert.doesNotMatch(source, /\+18004448888/)
  assert.doesNotMatch(source, /CLAIRE_IMESSAGE_HREF/)
  assert.match(source, /buildClaireImessageHref/)
  assert.match(source, /claireHref/)
})

test("CandidateLogin sends first-time candidates into onboarding", () => {
  assert.doesNotMatch(source, /First time\?\s*<Link to="\/"/)
  assert.doesNotMatch(source, /firstTimeOnboardingHref/)
  assert.match(source, /fallback\s*=\s*isLayoffHost\(\)/)
  assert.match(source, /: onboardingDestination\(peekSource\(\)\)/)
  assert.match(source, /return parseLoginNextPath\(nextInput, fallback\)/)
  assert.match(source, /const firstTimeHref = roleInterviewNext \? roleFirstTimeHref \?\? nextDest\.to : onboardingNext \? nextDest\.to : onboardingDestination\(peekSource\(\)\)/)
  assert.match(source, /First time\? <Link to=\{firstTimeHref\} className="wk-link">Continue here<\/Link> and Claire will start the same profile flow\./)
})

test("CandidateLogin preserves role interview context for first-time job candidates", () => {
  assert.match(source, /isPublicJobPath/)
  assert.match(source, /roleInterviewNext\s*=\s*isPublicJobPath\(nextDest\.pathname\)/)
  assert.doesNotMatch(source, /Start this role with Claire/)
  assert.match(source, /function roleInterviewFirstTimeHref\(next: ReturnType<typeof parseLoginNextPath>\): string \| null/)
  assert.match(source, /const rolePath = onboardingRoleReturnPath\(next\) \?\? \(isPublicJobPath\(next\.pathname\) \? next\.to : null\)/)
  assert.match(source, /roleDest\.pathname\.replace\(\/\\\/cv\$\/, ""\)/)
  assert.match(source, /const roleFirstTimeHref = roleInterviewFirstTimeHref\(nextDest\)/)
  assert.match(source, /roleInterviewNext \? roleFirstTimeHref \?\? nextDest\.to/)
  assert.match(source, /Role interview/)
  assert.match(source, /First time on this role\? <Link to=\{firstTimeHref\} className="wk-link">Continue here<\/Link> and Claire will keep the role attached\./)
})

test("CandidateLogin preserves role context when onboarding carries a public job return path", () => {
  assert.match(source, /function onboardingRoleReturnPath\(next: ReturnType<typeof parseLoginNextPath>\): string \| null/)
  assert.match(source, /const roleReturnPath = params\.get\("next"\)/)
  assert.match(source, /return roleReturnPath && isPublicJobPath\(roleReturnPath\) \? roleReturnPath : null/)
  assert.match(source, /const onboardingRoleReturn = onboardingRoleReturnPath\(nextDest\)/)
  assert.match(source, /const roleInterviewNext = isPublicJobPath\(nextDest\.pathname\) \|\| Boolean\(onboardingRoleReturn\)/)
  assert.match(source, /Sign in once and Claire will keep this role attached to your profile flow/)
  assert.match(source, /First time on this role\? <Link to=\{firstTimeHref\} className="wk-link">Continue here<\/Link> and Claire will keep the role attached\./)
})

test("CandidateLogin frames onboarding login as a first-time Claire start", () => {
  assert.match(source, /onboardingNext\s*=\s*nextDest\.isOnboarding && !roleInterviewNext/)
  assert.match(source, /onboardingNext[\s\S]*\? "Start with Claire"/)
  assert.match(source, /onboardingNext[\s\S]*<>Start with <em className="wk-accent">Claire\.<\/em><\/>/)
  assert.match(source, /Claire will start your profile flow/)
  assert.match(source, /\{!onboardingNext \? \([\s\S]*<p className="wk-login__fine">/)
})

test("CandidateLogin previews the first Claire conversation before onboarding auth controls", () => {
  assert.match(source, /function LoginOnboardingPreview\(\)/)
  assert.match(source, /What Claire starts after sign-in/)
  assert.match(source, /One durable Claire profile/)
  assert.match(source, /same WeKruit profile Claire uses across role interviews, evidence, and corrections/)
  assert.match(source, /Resume and LinkedIn uptake/)
  assert.match(source, /Target roles and constraints/)
  assert.match(source, /Nearest-work evidence/)
  assert.match(source, /Profile corrections stay editable/)
  assert.match(source, /const showOnboardingPreview = !isCompletingLink && onboardingNext/)
  assert.match(source, /\{showOnboardingPreview \? <LoginOnboardingPreview \/> : null\}[\s\S]*<div className="wk-login__providers">/)
})

test("CandidateLogin /me sign-in previews the operating home before auth controls", () => {
  assert.match(source, /function LoginPipelinePreview/)
  assert.match(source, /What opens after sign-in/)
  assert.match(source, /Active role interviews/)
  assert.match(source, /Claire session history/)
  assert.match(source, /Profile signals and corrections/)
  assert.match(source, /Passed-profile consent/)
  assert.match(source, /const showPipelinePreview = !isCompletingLink && !roleInterviewNext && !onboardingNext/)
  assert.match(source, /\{showPipelinePreview \? <LoginPipelinePreview \/> : null\}[\s\S]*<div className="wk-login__providers">/)
})

test("CandidateLogin only reuses remembered next during an OAuth return", () => {
  assert.match(source, /safeRaw\s*=\s*raw && raw\.startsWith\("\/"\) && !raw\.startsWith\("\/\/"\) \? raw : null/)
  assert.match(source, /oauthPendingForNext\s*=\s*window\.sessionStorage\.getItem\(OAUTH_PENDING_KEY\) === "1"/)
  assert.match(source, /const remembered\s*=\s*oauthPendingForNext \? readRememberedLoginNext\(\) : null/)
  assert.match(source, /const nextInput\s*=\s*safeRaw \?\? remembered \?\? fallback/)
  assert.match(source, /return parseLoginNextPath\(nextInput, fallback\)/)
})

test("CandidateLogin keeps stale OAuth retry copy domain-neutral", () => {
  assert.doesNotMatch(source, /on layoff we open Google in a popup instead/)
  assert.doesNotMatch(source, /Google sign-in didn't finish after redirect/)
  assert.doesNotMatch(source, /Allow popups for layoff\.wekruit\.com/)
  assert.match(
    source,
    /Sign-in didn't finish after redirect\. Choose Google or LinkedIn again, or use Try again if the provider already completed\./,
  )
  assert.match(source, /Your browser blocked the Google sign-in popup\. Allow popups for this site and try again\./)
})

test("CandidateShell signed-in nav keeps candidates inside the operating home and market source surfaces", () => {
  assert.match(source, /\{ to: "\/me", icon: "pipeline", label: "Home" \}/)
  assert.match(source, /\{ to: "\/me\/matches", icon: "match", label: "Roles" \}/)
  assert.match(source, /\{ to: "\/market", icon: "market", label: "Market" \}/)
  assert.match(source, /\{ to: "\/me\/profile", icon: "profile", label: "Profile" \}/)
  assert.match(source, /\{ to: "\/me\/privacy", icon: "privacy", label: "Privacy" \}/)
  assert.match(source, /\{ to: "\/me\/refer", icon: "refer", label: "Refer · \$4k" \}/)
  assert.match(source, /if \(to === "\/market"\) return pathname === "\/market"/)
  assert.match(source, /if \(to === "\/me\/privacy"\) return pathname === "\/me\/privacy"/)
})

test("CandidateShell footer routes employers to the actual employer surface", () => {
  assert.match(source, /<Link to="\/employers">For employers<\/Link>/)
  assert.doesNotMatch(source, /href="https:\/\/wekruit\.com"[\s\S]*For employers/)
})

test("CandidateShell routes missing Claire-line states to a real profile action", () => {
  assert.doesNotMatch(source, /Claire line pending/)
  assert.doesNotMatch(source, /wk-sidenav__claire is-pending" aria-disabled="true"/)
  assert.match(
    source,
    /<Link to="\/me\/profile#profile-corrections" className="wk-apptopbar__claire is-pending" aria-label="Update profile">/,
  )
  assert.match(
    source,
    /<Link[\s\S]*to="\/me\/profile#profile-corrections"[\s\S]*className="wk-sidenav__claire is-pending"[\s\S]*Update profile[\s\S]*Add context for Claire/,
  )
})
