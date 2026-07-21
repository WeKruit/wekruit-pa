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
  assert.match(source, /const firstTimeHref = roleInterviewNext/)
  assert.match(source, /roleSignalNext[\s\S]*roleSignalFirstTimeHref \?\? onboardingDestination\(peekSource\(\)\)/)
  assert.match(source, /onboardingNext[\s\S]*nextDest\.to[\s\S]*onboardingDestination\(peekSource\(\)\)/)
  assert.match(source, /First time\? <Link to=\{firstTimeHref\} className="wk-link">Continue here<\/Link> and Claire will start the same profile flow\./)
})

test("CandidateLogin preserves role interview context for first-time job candidates", () => {
  assert.match(source, /isPublicJobPath/)
  assert.match(source, /roleInterviewNext\s*=\s*isPublicJobPath\(nextDest\.pathname\) \|\| Boolean\(onboardingRoleReturn\)/)
  assert.doesNotMatch(source, /Start this role with Claire/)
  assert.match(source, /function roleInterviewFirstTimeHref\(next: ReturnType<typeof parseLoginNextPath>\): string \| null/)
  assert.match(source, /const rolePath = onboardingRoleReturnPath\(next\) \?\? \(isPublicJobPath\(next\.pathname\) \? next\.to : null\)/)
  assert.match(source, /roleDest\.pathname\.replace\(\/\\\/cv\$\/, ""\)/)
  assert.match(source, /function roleInterviewSummary\(next: ReturnType<typeof parseLoginNextPath>\): \{ title: string; company: string \} \| null/)
  assert.match(source, /\.replace\(\/\^\(\?:wekruit\|standout\)-\[a-f0-9\]\{8\}-\/i, ""\)/)
  assert.match(source, /const \[companyToken, \.\.\.roleTokens\] = decodedSlug\.split\("-"\)\.filter\(Boolean\)/)
  assert.match(source, /return fullstack \? `\$\{title\} \(Full-Stack\)` : title/)
  assert.match(source, /function LoginRoleInterviewSummary\(\{ title, company, href \}: \{ title: string; company: string; href: string \}\)/)
  assert.match(source, /aria-label="Selected role for this interview"/)
  assert.match(source, /Selected role/)
  assert.match(source, /Claire role interview/)
  assert.match(source, /const roleFirstTimeHref = roleInterviewFirstTimeHref\(nextDest\)/)
  assert.match(source, /const roleInterview = roleInterviewSummary\(nextDest\)/)
  assert.match(source, /\{roleInterviewNext && roleInterview \? \([\s\S]*<LoginRoleInterviewSummary title=\{roleInterview\.title\} company=\{roleInterview\.company\} href=\{roleFirstTimeHref \?\? nextDest\.to\} \/>/)
  assert.match(source, /roleInterviewNext[\s\S]*\? roleFirstTimeHref \?\? nextDest\.to/)
  assert.match(source, /Role interview/)
  assert.match(source, /First time on this role\? <Link to=\{firstTimeHref\} className="wk-link">Continue here<\/Link> and Claire will keep the role attached\./)
  const roleSummaryIndex = source.indexOf("<LoginRoleInterviewSummary title={roleInterview.title}")
  const contextStripIndex = source.indexOf("<LoginContextStrip kind={loginContextKind} />")
  assert.ok(roleSummaryIndex > 0)
  assert.ok(contextStripIndex > roleSummaryIndex)
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
  // yc entry keeps its own eyebrow; every other onboarding entry stays "Start with Claire".
  assert.match(source, /onboardingNext[\s\S]*: "Start with Claire"/)
  assert.match(source, /ycEntry[\s\S]*\? "YC Startup School × WeKruit"/)
  assert.match(source, /onboardingNext[\s\S]*<>Start with <em className="wk-accent">Claire\.<\/em><\/>/)
  assert.match(source, /Claire starts a guided profile chat: resume or LinkedIn first, then target roles, constraints, and nearest-work evidence/)
  assert.match(source, /onboardingNext \? "Start with Google" : "Continue with Google"/)
  assert.match(source, /onboardingNext \? "Start with LinkedIn" : "Continue with LinkedIn"/)
  assert.match(source, /\{!onboardingNext \? \([\s\S]*<p className="wk-login__fine">/)
})

test("CandidateLogin offers existing Claire phone-thread linking before onboarding", () => {
  assert.match(source, /PHONE_LINK_INTENT_KEY\s*=\s*"pa_phone_link_intent"/)
  assert.match(source, /function readPhoneLinkIntentParam\(searchParams: URLSearchParams\): boolean/)
  assert.match(source, /const phoneLinkIntentFromUrl = useMemo\(\(\) => readPhoneLinkIntentParam\(searchParams\), \[searchParams\]\)/)
  assert.match(source, /const \[phoneLinkMode, setPhoneLinkMode\] = useState\(\(\) => phoneLinkIntentFromUrl \|\| readPhoneLinkIntent\(\)\)/)
  assert.match(source, /if \(!phoneLinkIntentFromUrl\) return[\s\S]*rememberPhoneLinkIntent\(\)[\s\S]*setPhoneLinkMode\(true\)/)
  assert.match(source, /startCandidatePhoneLink/)
  assert.match(source, /verifyCandidatePhoneLink/)
  assert.match(source, /if \(readPhoneLinkIntent\(\)\) \{[\s\S]*setPhoneLinkMode\(true\)[\s\S]*return/)
  assert.match(source, /I've texted Claire/)
  assert.match(source, /Already talked with Claire by phone\? Verify that number and open the WeKruit profile Claire already knows\./)
  assert.match(source, /Signed in as \{signedInUser\.email \?\? "this account"\}/)
  assert.match(source, /Text me a code/)
  assert.match(source, /Connect Claire thread/)
  assert.match(source, /const showCompletingLink = isCompletingLink && !phoneLinkMode/)
  assert.match(source, /const showAuthControls = !showCompletingLink && !\(phoneLinkMode && signedInUser\)/)
  assert.match(source, /const phoneLinkAuthActive = phoneLinkMode && !signedInUser && showAuthControls/)
  assert.match(source, /const showMainAuthControls = showAuthControls && !phoneLinkAuthActive/)
  assert.match(source, /const destination = nextDest\.isOnboarding[\s\S]*\? "\/me"[\s\S]*: resolvePostLoginDestination\(nextDest, true, verifySource\)/)
})

test("CandidateLogin phone-link preauth keeps sign-in controls inside the Claire thread branch", () => {
  assert.match(source, /function activatePhoneLink\(\)[\s\S]*rememberPhoneLinkIntent\(\)[\s\S]*rememberLoginNext\(nextDest\.to\)[\s\S]*setPhoneLinkMode\(true\)/)
  assert.match(source, /className=\{`wk-login__card\$\{showPipelinePreview \? " wk-login__card--pipeline" : ""\}\$\{phoneLinkMode \? " wk-login__card--phone-link" : ""\}`\}/)
  assert.match(source, /Choose a sign-in method below\. Then Claire texts a code to connect the phone thread she already knows\./)
  assert.match(source, /<div className="wk-login-phone-link__auth" aria-label="Sign in before connecting Claire phone thread">[\s\S]*\{renderAuthControls\(\)\}[\s\S]*<\/div>/)
  assert.match(source, /\{showMainAuthControls \? renderAuthControls\(\) : null\}/)
  assert.match(source, /@media \(max-width: 480px\)[\s\S]*\.wk-login__card--phone-link \.wk-login-context \{ display: none; \}/)
})

test("CandidateLogin keeps onboarding auth controls before the explanatory preview", () => {
  assert.match(source, /function LoginOnboardingPreview\(\)/)
  assert.match(source, /function LoginContextStrip\(\{ kind \}: \{ kind: LoginContextKind \}\)/)
  assert.match(source, /aria-label="What Claire keeps through sign-in"/)
  assert.match(source, /After sign-in, Claire keeps/)
  assert.match(source, /onboarding: \[[\s\S]*\{ title: "Profile chat", body: "Claire asks before anything is shared\." \}/)
  assert.match(source, /\{ title: "Resume \+ LinkedIn", body: "Background turns into reusable evidence\." \}/)
  assert.match(source, /\{ title: "Nearest proof", body: "Fit comes from closest-overlap work\." \}/)
  assert.match(source, /className="wk-login-context__dot"/)
  assert.match(source, /What Claire starts after sign-in/)
  assert.match(source, /One durable Claire profile/)
  assert.match(source, /same WeKruit profile Claire uses across role interviews, evidence, and corrections/)
  assert.match(source, /Resume and LinkedIn uptake/)
  assert.match(source, /Target roles and constraints/)
  assert.match(source, /Nearest-work evidence/)
  assert.match(source, /Profile corrections stay editable/)
  assert.match(source, /const showOnboardingPreview = !showCompletingLink && onboardingNext/)
  const mainAuthIndex = source.indexOf("{showMainAuthControls ? renderAuthControls() : null}")
  const contextStripIndex = source.indexOf("<LoginContextStrip kind={loginContextKind} />")
  const onboardingPreviewIndex = source.indexOf("{showOnboardingPreview ? <LoginOnboardingPreview /> : null}")
  assert.ok(mainAuthIndex > 0)
  assert.ok(contextStripIndex > 0)
  assert.ok(onboardingPreviewIndex > mainAuthIndex)
  assert.match(source, /@media \(max-width: 480px\)[\s\S]*\.wk-login \{ padding: 32px 0 72px; \}/)
  assert.match(source, /\.wk-login-context__items \{[\s\S]*grid-template-columns: repeat\(3, minmax\(0, 1fr\)\);/)
  assert.match(source, /@media \(max-width: 480px\)[\s\S]*\.wk-login-context__items \{[\s\S]*display: grid;[\s\S]*grid-template-columns: 1fr;[\s\S]*gap: 7px;[\s\S]*\}/)
  assert.match(source, /@media \(max-width: 480px\)[\s\S]*\.wk-login-context__item \{[\s\S]*display: grid;[\s\S]*grid-template-columns: 18px minmax\(0, 1fr\);[\s\S]*border-radius: 14px;[\s\S]*\}/)
  assert.match(source, /@media \(max-width: 480px\)[\s\S]*\.wk-login-context__item em \{[\s\S]*display: block;[\s\S]*font-size: 11\.5px;[\s\S]*line-height: 1\.25;[\s\S]*\}/)
  assert.match(source, /@media \(max-width: 480px\)[\s\S]*\.wk-login__providers \{ margin-top: 2px; \}/)
})

test("CandidateLogin mobile sign-in puts auth actions before secondary context", () => {
  assert.match(source, /@media \(max-width: 480px\)[\s\S]*\.wk-login__auth-block \{ order: 3; gap: 10px; \}/)
  assert.match(source, /@media \(max-width: 480px\)[\s\S]*\.wk-login-phone-link \{ order: 4; \}/)
  assert.match(source, /@media \(max-width: 480px\)[\s\S]*\.wk-login-context \{ order: 5; \}/)
  assert.match(source, /@media \(max-width: 480px\)[\s\S]*\.wk-login-preview \{ order: 6; \}/)
  assert.match(source, /@media \(max-width: 480px\)[\s\S]*\.wk-login__fine \{ order: 7; \}/)
})

test("CandidateLogin /me sign-in keeps auth controls before the operating-home preview", () => {
  assert.match(source, /function LoginPipelinePreview/)
  assert.match(source, /What opens after sign-in/)
  assert.match(source, /Active role interviews/)
  assert.match(source, /Claire session history/)
  assert.match(source, /Profile signals and corrections/)
  assert.match(source, /Passed-profile consent/)
  assert.match(source, /const referralNext = nextDest\.pathname === "\/me\/refer"/)
  assert.match(source, /const showPipelinePreview = !showCompletingLink && !roleInterviewNext && !roleSignalNext && !onboardingNext && !referralNext/)
  const mainAuthIndex = source.indexOf("{showMainAuthControls ? renderAuthControls() : null}")
  const pipelinePreviewIndex = source.indexOf("{showPipelinePreview ? <LoginPipelinePreview /> : null}")
  assert.ok(mainAuthIndex > 0)
  assert.ok(pipelinePreviewIndex > mainAuthIndex)
  assert.match(source, /className=\{`wk-login__card\$\{showPipelinePreview \? " wk-login__card--pipeline" : ""\}\$\{phoneLinkMode \? " wk-login__card--phone-link" : ""\}`\}/)
  assert.match(source, /@media \(max-width: 480px\)[\s\S]*\.wk-login__card--pipeline \{ padding-top: 24px; padding-bottom: 24px; gap: 12px; \}/)
  assert.match(source, /@media \(max-width: 480px\)[\s\S]*\.wk-login__card--pipeline \.wk-login-context__items \{ gap: 6px; \}/)
  assert.match(source, /@media \(max-width: 480px\)[\s\S]*\.wk-login__card--pipeline \.wk-login__providers \{ gap: 8px; margin-top: 0; \}/)
  assert.match(source, /@media \(max-width: 480px\)[\s\S]*\.wk-login__card--pipeline \.wk-login-preview \{ gap: 7px; padding: 10px 0; \}/)
})

test("CandidateLogin /me signing-in status opens the pipeline, not onboarding", () => {
  assert.match(source, /: "One sec — confirming your sign-in and pulling up your active pipeline\."/)
  assert.doesNotMatch(source, /: "One sec — confirming your sign-in and opening onboarding\."/)
})

test("CandidateLogin frames referral dashboard auth around rewards and invite tracking", () => {
  assert.match(source, /const referralNext = nextDest\.pathname === "\/me\/refer"/)
  assert.match(source, /referralNext \? "referral" : "pipeline"/)
  assert.match(source, /referralNext[\s\S]*\? "Referral dashboard"/)
  assert.match(source, /Open referral <em className="wk-accent">dashboard\.<\/em>/)
  assert.match(source, /Sign in once to track referral invites, verified interview rewards, and offer\/start payouts\./)
  assert.match(source, /One sec — confirming your sign-in and opening the referral ledger\./)
  assert.match(source, /function LoginReferralPreview\(\)/)
  assert.match(source, /Referral dashboard after sign-in/)
  assert.match(source, /Invite tracking/)
  assert.match(source, /Verified milestones/)
  assert.match(source, /Candidate-first loop/)
  assert.match(source, /Payout status/)
  assert.match(source, /referral: \[[\s\S]*\{ title: "Invite ledger", body: "Your friend and milestone status stay attached\." \}/)
  assert.match(source, /\{ title: "\$50 interview reward", body: "Tracked after a verified hiring-manager interview\." \}/)
  assert.match(source, /\{ title: "\$4k placement reward", body: "Tracked after a verified offer\/start\." \}/)
  assert.match(source, /const showReferralPreview = !showCompletingLink && referralNext/)
  assert.match(source, /\{showReferralPreview \? <LoginReferralPreview \/> : null\}/)
})

test("CandidateLogin preserves market role signal context through auth", () => {
  assert.match(source, /isProfileRoleSignalPath/)
  assert.match(source, /onboardingDestinationWithReturnPath/)
  assert.match(source, /function profileRoleSignalSummary\(next: ReturnType<typeof parseLoginNextPath>\): \{ title: string; company: string \} \| null/)
  assert.match(source, /const profileRoleSignal = profileRoleSignalSummary\(nextDest\)/)
  assert.match(source, /const roleSignalNext = Boolean\(profileRoleSignal\)/)
  assert.match(source, /const roleSignalFirstTimeHref = roleSignalNext \? onboardingDestinationWithReturnPath\(nextDest\.to, peekSource\(\)\) : null/)
  assert.match(source, /Save this <em className="wk-accent">role signal\.<\/em>/)
  assert.match(source, /Sign in and Claire will add this role to your durable profile signals\./)
  assert.match(source, /function LoginRoleSignalPreview\(\{ title, company \}: \{ title: string; company: string \}\)/)
  assert.match(source, /Role signal after sign-in/)
  assert.match(source, /Claire will start your profile with this role signal\./)
  assert.match(source, /const showPipelinePreview = !showCompletingLink && !roleInterviewNext && !roleSignalNext && !onboardingNext && !referralNext/)
  assert.match(source, /\{showRoleSignalPreview && profileRoleSignal \? <LoginRoleSignalPreview title=\{profileRoleSignal\.title\} company=\{profileRoleSignal\.company\} \/> : null\}/)
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

test("CandidateShell mobile header keeps the primary candidate start action visible", () => {
  assert.match(source, /startHref = "\/onboarding"/)
  assert.match(source, /startLabel = "Start with Claire"/)
  assert.match(source, /<Link to=\{startHref\} className="wk-btn wk-btn--ink wk-btn--sm wk-header__primary" aria-label=\{startLabel\}>/)
  assert.doesNotMatch(source, /<Link to="\/login" className="wk-btn wk-btn--ink wk-btn--sm wk-header__primary" aria-label="Start with Claire">/)
  assert.match(source, /className="wk-header__primary-full" aria-hidden="true">Start with Claire<\/span>/)
  assert.match(source, /className="wk-header__primary-short" aria-hidden="true">Claire<\/span>/)
  assert.doesNotMatch(source, /className="wk-header__primary-short" aria-hidden="true">Start<\/span>/)
  assert.match(source, /@media \(max-width: 820px\) \{[\s\S]*\.wk-header__inner > \.wk-header__cta \{ margin-left: auto; \}/)
  assert.match(source, /@media \(max-width: 480px\) \{[\s\S]*\.wk-header__inner \{ padding: 12px; \}/)
  assert.match(source, /@media \(max-width: 480px\) \{[\s\S]*\.wk-header__signin \{ display: none; font-size: 13\.5px; margin-right: 0; \}/)
  assert.match(source, /@media \(max-width: 480px\) \{[\s\S]*\.wk-header__primary \{[\s\S]*display: inline-flex !important;[\s\S]*height: 32px;/)
  assert.match(source, /@media \(max-width: 480px\) \{[\s\S]*\.wk-header__primary-full \{ display: none; \}/)
  assert.match(source, /@media \(max-width: 480px\) \{[\s\S]*\.wk-header__primary-short \{ display: inline; \}/)
})

test("CandidateShell auth-aware marketing header exposes only one My WeKruit entry", () => {
  assert.match(source, /\{!isAuthed \? <Link to="\/me" className="wk-nav__link">My WeKruit<\/Link> : null\}/)
  assert.match(source, /isAuthed \? \([\s\S]*<Link to="\/me" className="wk-btn wk-btn--ink wk-btn--sm">My WeKruit<\/Link>/)
  assert.doesNotMatch(source, /<Link to="\/me" className="wk-nav__link">My WeKruit<\/Link>\s*<\/nav>[\s\S]*isAuthed \? \(/)
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

test("phone-link code submit never silently no-ops when state was reset mid-flow", () => {
  // Guard failure with a typed code surfaces an explicit expiry error instead
  // of doing nothing (which read as "it threw me back to the start").
  assert.match(source, /That code session expired — tap 'Text me a code' to get a fresh one\./)
  assert.match(source, /if \(phoneLinkCode\.trim\(\)\) \{/)
})

test("phone-link in-flight request survives a reload via sessionStorage", () => {
  // Persisted with a 10-minute TTL when the code is sent…
  assert.match(source, /PHONE_LINK_REQUEST_KEY\s*=\s*"pa_phone_link_request"/)
  assert.match(source, /PHONE_LINK_REQUEST_TTL_MS\s*=\s*10 \* 60 \* 1000/)
  assert.match(source, /rememberPhoneLinkRequest\(result\.requestId, result\.phoneMasked\)/)
  // …rehydrated back onto the code-entry step on mount / sign-in resume…
  assert.match(source, /function resumePhoneLinkRequestState\(\): PhoneLinkState \| null/)
  assert.match(source, /resumePhoneLinkRequestState\(\) \?\?/)
  // …and cleared on success and on close.
  assert.match(source, /clearPhoneLinkIntent\(\)\s*\n\s*clearPhoneLinkRequest\(\)/)
  assert.match(source, /function closePhoneLink\(\) \{[\s\S]*?clearPhoneLinkRequest\(\)[\s\S]*?\n  \}/)
})
