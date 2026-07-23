// @ts-nocheck - source contract test for the Vite page.
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import test from "node:test"

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(resolve(here, "Onboarding.tsx"), "utf8")

test("job-origin onboarding is framed as Claire role continuity, not bare registration", () => {
  assert.match(source, /returnJobId/)
  assert.match(source, /Profile \+ role context/)
  assert.match(source, /Claire role interview/)
  assert.match(source, /role context stays attached/)
  assert.match(source, /same role interview/)
  assert.doesNotMatch(source, /Register \+ resume/)
  assert.doesNotMatch(source, /Step 1 · Register/)
})

test("duplicate onboarding avoids reset-style visible actions", () => {
  assert.match(source, /Use latest info/)
  assert.match(source, /Replace your old info with what you just entered/)
  assert.doesNotMatch(source, />Start fresh</)
  assert.doesNotMatch(source, /<strong[^>]*>Start fresh<\/strong>/)
})

test("done handoff continues an existing Claire conversation when verification proves one exists", () => {
  assert.match(source, /claireConversationStarted=\{claireConversationStarted\}/)
  assert.match(source, /claireConversationStarted: boolean/)
  assert.match(source, /const continuingClaireConversation = claireConversationStarted \|\| isJobInterview/)
  assert.match(source, /Claire already has your thread/)
  assert.match(source, /continuingClaireConversation\s*\n?\s*\? "Continue with Claire"/)
  assert.match(source, /I’ll pick up from our existing thread\./)
  assert.match(source, /Claire thread found/)
})

test("YC Startup School onboarding keeps source, reuses profile context, and opens people-matching handoff", () => {
  assert.match(source, /source === "yc_startup_school"/)
  assert.match(source, /YC Startup School · SF people matching/)
  assert.match(source, /Step 1 · Startup School context/)
  assert.match(source, /profilePathAlreadyKnown/)
  assert.match(source, /knownProfileSummary/)
  assert.match(source, /Boolean\(verified\.hasExistingProfileInfo\)/)
  assert.match(source, /Boolean\(verified\.linkedinUrl\)/)
  assert.match(source, /Claire already has some of your background/)
  assert.match(source, /No need to paste LinkedIn again/)
  assert.match(source, /Startup School people-matching flow/)
  assert.match(source, /yc_startup_school_signup/)
})

test("signed-in onboarding offers existing Claire phone-thread linking before intake", () => {
  assert.match(source, /startCandidatePhoneLink/)
  assert.match(source, /verifyCandidatePhoneLink/)
  assert.match(source, /if \(!intakeChecked\) \{[\s\S]*Already talked to <em style=\{\{ fontStyle: "italic" \}\}>Claire<\/em>\?[\s\S]*<OnboardingPhoneThreadLink authUser=\{authUser\} onLinked=\{onPhoneThreadLinked\} \/>[\s\S]*Checking whether this sign-in already has a WeKruit profile/)
  assert.match(source, /<OnboardingPhoneThreadLink authUser=\{authUser\} onLinked=\{onPhoneThreadLinked\} \/>/)
  assert.match(source, /I've texted Claire/)
  assert.match(source, /Skip onboarding with your phone thread\./)
  assert.match(source, /Verify the phone number Claire already knows/)
  assert.match(source, /if \(returnPath\) \{[\s\S]*navigate\(returnPath, \{ replace: true \}\)/)
  assert.match(source, /redirectToCandidatePortal\("\/me"\)/)
  assert.match(source, /navigate\("\/me", \{ replace: true \}\)/)
})

test("generic onboarding does not inherit a stale remembered job return path", () => {
  assert.match(source, /resolveExplicitOnboardingReturnPath/)
  assert.match(source, /const returnPath = useMemo\(\(\) => resolveExplicitOnboardingReturnPath\(searchParams\.get\("next"\)\), \[searchParams\]\)/)
  assert.doesNotMatch(source, /readRememberedReturnJobPath/)
})

test("transient verify failures keep the session and offer an inline retry", () => {
  // Sign-out + bounce-to-login is gated on auth-class failures only.
  assert.match(source, /shouldSignOutOnVerifyError/)
  assert.match(source, /if \(shouldSignOutOnVerifyError\(err\)\) \{[\s\S]*await clearSsoCookie\(\)[\s\S]*await signOut\(auth\(\)\)[\s\S]*navigate\(`\/login\?next=\$\{encodeURIComponent\(loginNextPath\)\}`, \{ replace: true \}\)[\s\S]*\}/)
  // No unconditional sign-out inside the catch: signOut appears only after the gate.
  assert.doesNotMatch(
    source,
    /setIntakeChecked\(false\)\s*\n\s*try \{\s*\n\s*await clearSsoCookie\(\)/,
  )
  // Retry affordance re-runs the verify effect without destroying the session.
  assert.match(source, /const \[verifyAttempt, setVerifyAttempt\] = useState\(0\)/)
  assert.match(source, /setVerifyAttempt\(\(n\) => n \+ 1\)/)
  assert.match(source, /Retry verification/)
  assert.match(source, /\[authUser, loginNextPath, navigate, returnPath, source, verifyAttempt\]\)/)
})
