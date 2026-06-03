// @ts-nocheck - landing app typecheck only includes Vite/browser types; this file runs with node --test via tsx.
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import test from "node:test"

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(resolve(here, "CandidatePortal.tsx"), "utf8")

test("CandidatePortal renders review decisions only inside committed pipeline rows", () => {
  assert.match(source, /reviewDecision/)
  assert.match(source, /CandidateReviewDecision/)
  assert.match(source, /shouldShowReviewDecision/)
  assert.match(source, /profile stays active/i)
  assert.match(source, /decisionReason/)
  assert.match(source, /recommendedActions/)
  assert.doesNotMatch(source, /employer_visible/)
})

test("CandidatePortal labels review-pending pipeline state as WeKruit-side review", () => {
  assert.match(source, /Reviewing/)
  assert.doesNotMatch(source, /With employer/)
})

test("CandidatePortal visibility copy describes active pipeline without employer-talking implication", () => {
  assert.match(source, /active .*pipeline/i)
  assert.doesNotMatch(source, /employers? (?:is|are) talking with you/i)
})

test("CandidatePortal matches inbox does not present local-only feedback as durable learning", () => {
  assert.doesNotMatch(source, /Mark\s+each\s+one\s+so\s+she\s+learns/i)
  assert.doesNotMatch(source, /hiring managers? says? yes|employers say yes/i)
  assert.doesNotMatch(source, /setVote|wkv3-fb--yes|wkv3-fb--no|No teaches Claire/)
  assert.match(source, /Use as profile signal/)
})

test("CandidatePortal roles inbox routes role preference edits with role context", () => {
  assert.match(
    source,
    /<Link to="\/me\/profile#match-preferences" className="wk-btn wk-btn--primary wk-btn--sm">[\s\S]*Adjust matching/,
  )
  assert.match(source, /function profileSignalHrefForRecommendedMatch\(match: CandidateMatchCard\): string/)
  assert.match(source, /params\.set\("profileRoleSignalTitle", match\.job\.title\)/)
  assert.match(source, /params\.set\("profileRoleSignalCompany", match\.job\.company\)/)
  assert.match(source, /params\.set\("profileRoleSignalLocation", match\.job\.location\)/)
  assert.match(source, /params\.set\("profileRoleSignalReason", match\.whyMatched\.slice\(0, 3\)\.join\("\\n"\)\)/)
  assert.match(source, /const recommendedSignalHref = match\.status === "recommended" \? profileSignalHrefForRecommendedMatch\(match\) : null/)
  assert.match(
    source,
    /<Link\s+to=\{recommendedSignalHref \?\? "\/me\/profile#match-preferences"\}\s+className="wkv3-match__prefs">[\s\S]*recommendedSignalHref \? "Use as profile signal" : "Update matching preferences"/,
  )
  assert.doesNotMatch(source, /href="#"\s+className="wkv3-match__prefs"/)
  assert.doesNotMatch(source, /navigate\("\/me\/profile"\)/)
})

test("CandidatePortal roles inbox distinguishes WeKruit-screened roles from external recommendations", () => {
  assert.doesNotMatch(source, /Matches · \{all\.length\} active/)
  assert.doesNotMatch(source, /You don&apos;t apply cold/)
  assert.doesNotMatch(source, /WeKruit collab/)
  assert.match(source, /Roles · \{all\.length\} total/)
  assert.match(source, /WeKruit-screened roles/)
  assert.match(source, /external recommendations/)
})

test("CandidatePortal roles page disables zero-count filters instead of opening dead views", () => {
  assert.match(source, /const disabled = counts\[f\.id\] === 0 && filter !== f\.id/)
  assert.match(source, /disabled=\{disabled\}/)
  assert.match(source, /aria-disabled=\{disabled\}/)
  assert.match(source, /className=\{`wkmp-chip\$\{filter === f\.id \? " is-on" : ""\}\$\{disabled \? " is-disabled" : ""\}`\}/)
})

test("CandidatePortal roles inbox exposes action-first state filters", () => {
  assert.match(source, /type MatchesFilter = "all" \| "action" \| "review" \| "outcome" \| "collab" \| "rec"/)
  assert.match(source, /\{ id: "action", label: "Needs action" \}/)
  assert.match(source, /\{ id: "review", label: "In review" \}/)
  assert.match(source, /\{ id: "outcome", label: "Outcomes" \}/)
  assert.match(source, /function matchNeedsCandidateAction\(match: CandidateMatchCard\): boolean/)
  assert.match(source, /match\.status === "recommended" \|\|[\s\S]*match\.status === "invited" \|\|[\s\S]*match\.status === "interview_started"/)
  assert.match(source, /function matchHasCandidateOutcome\(match: CandidateMatchCard\): boolean/)
  assert.match(source, /match\.status === "passed" \|\|[\s\S]*match\.status === "intro_accepted" \|\|[\s\S]*match\.status === "intro_rejected" \|\|[\s\S]*match\.status === "not_passed"/)
  assert.match(source, /function matchesForFilter\(matches: CandidateMatchCard\[\], filter: MatchesFilter\): CandidateMatchCard\[\]/)
  assert.match(source, /const filtered = matchesForFilter\(all, filter\)/)
  assert.match(source, /const counts = MATCHES_FILTERS\.reduce/)
})

test("CandidatePortal roles page empty state offers real next actions", () => {
  assert.match(source, /function MatchesEmptyState\(/)
  assert.match(source, /No roles match your profile yet\./)
  assert.match(source, /Keep target roles, locations, and deal-breakers current/)
  assert.match(source, /<Link to="\/me\/profile#match-preferences" className="wk-btn wk-btn--primary wk-btn--sm">[\s\S]*Update matching profile/)
  assert.match(source, /claireHref \? \([\s\S]*Message Claire/)
  assert.doesNotMatch(source, /<h3>Nothing here\.<\/h3>/)
})

test("CandidatePortal /me new roles empty state offers real next actions", () => {
  assert.match(source, /<MeNewMatches[\s\S]*claireHref=\{claireHref\}/)
  assert.match(source, /function MeNewRolesEmptyState\(/)
  assert.match(source, /No new roles match your profile yet\./)
  assert.match(source, /Update target roles, locations, and deal-breakers/)
  assert.match(source, /<Link to="\/me\/profile#match-preferences" className="wk-btn wk-btn--primary wk-btn--sm">[\s\S]*Update matching profile/)
  assert.match(source, /claireHref \? \([\s\S]*Message Claire/)
  assert.doesNotMatch(source, /<h3>No roles yet\.<\/h3>/)
})

test("CandidatePortal /me new role preview exposes role signal action", () => {
  assert.match(source, /function MeMatchPeek\(\{ match \}: \{ match: CandidateMatchCard \}\)/)
  assert.match(source, /const recommendedSignalHref = profileSignalHrefForRecommendedMatch\(match\)/)
  assert.match(source, /const target = matchPrimaryTarget\(match\)/)
  assert.match(source, /target\.external \? \(/)
  assert.match(source, /const peekCtaLabel = isCollab \? statusDisplay\.ctaLabel : "View source"/)
  assert.match(source, /href=\{target\.url\}[\s\S]*\{peekCtaLabel\}/)
  assert.match(source, /to=\{target\.url\}[\s\S]*\{peekCtaLabel\}/)
  assert.match(source, /<Link to=\{recommendedSignalHref\} className="wkv3-peek__signal">[\s\S]*Use as signal/)
  assert.doesNotMatch(source, /const peekCtaLabel = isCollab \? statusDisplay\.ctaLabel : "See role"/)
  assert.doesNotMatch(source, /className="wkv3-peek"[\s\S]{0,160}role="link"/)
  assert.doesNotMatch(source, /const go = \(\) =>/)
})

test("CandidatePortal empty waiting states do not claim unproven Claire background work", () => {
  assert.doesNotMatch(source, /Claire is working/)
  assert.doesNotMatch(source, /WeKruit is working/)
  assert.doesNotMatch(source, /Claire is matching you with new roles/)
  assert.doesNotMatch(source, /Claire keeps scanning/)
  assert.doesNotMatch(source, /Claire is still matching/)
  assert.doesNotMatch(source, /We&apos;ll text you when Claire finds/)
  assert.match(source, /function MeWaitingCard/)
  assert.match(
    source,
    /<Link to="\/me\/profile#match-preferences" className="wk-btn wk-btn--secondary wk-btn--sm">[\s\S]*Review matching preferences/,
  )
})

test("CandidatePortal does not label pipeline reasons as Claire match evidence", () => {
  assert.doesNotMatch(source, /<em>Roles<\/em> Claire matched for you\./)
  assert.doesNotMatch(source, /Pulling the roles Claire matched for you\./)
  assert.doesNotMatch(source, /shows why each matched/)
  assert.match(source, /<em>Roles<\/em> WeKruit is tracking for you\./)
  assert.match(source, /const reasonsLabel = isCollab \? "Why this is in your pipeline" : "Why Claire matched you"/)
  assert.match(source, /className="wkv3-match__ev-eye">\{reasonsLabel\}/)
})

test("CandidatePortal interview pipeline does not mix recommendation inbox into stage filters", () => {
  assert.doesNotMatch(source, /\{ id: "new", label: "New"/)
  assert.doesNotMatch(source, /const c: Record<string, number> = \{ new: recommendedCount \}/)
  assert.doesNotMatch(source, /<MePipeline[\s\S]*recommendedCount=\{recommended\.length\}/)
  assert.match(source, /<h2 className="wkv3-sec__h">Interview pipeline<\/h2>/)
  assert.match(source, /<MeNewMatches\s+matches=\{recommended\}/)
})

test("CandidatePortal surfaces employer intro outcomes without leaking private feedback records", () => {
  assert.match(source, /intro_accepted/)
  assert.match(source, /intro_rejected/)
  assert.match(source, /label: "Intro"/)
  assert.match(source, /Intro accepted/)
  assert.match(source, /Intro closed/)
  assert.match(source, /feedback signals/)
  assert.match(source, /future matching/)
  assert.doesNotMatch(source, /latestEmployerFeedbackEventId/)
  assert.doesNotMatch(source, /private employer feedback/i)
})

test("CandidatePortal privacy card does not present local-only toggles as binding controls", () => {
  assert.doesNotMatch(source, /setShowMe|setBlockEmployer|setShareResume|wk-prof-toggle|These toggles read/i)
  assert.doesNotMatch(source, /Visible to employers|Show me to employers/i)
  assert.match(source, /Privacy requests/)
  assert.match(source, /Binding changes go through reviewed privacy requests/)
})

test("CandidatePortal wires connector buttons through the account OAuth start callable", () => {
  assert.match(source, /label: "LinkedIn"/)
  assert.match(source, /label: "GitHub"/)
  assert.match(source, /label: "Cal\.com"/)
  assert.match(source, /paCandidateConnectorOAuthStart/)
  assert.match(source, /provider: "linkedin"/)
  assert.match(source, /provider: "github"/)
  assert.match(source, /github_oauth_config_missing/)
  assert.match(source, /calcom_oauth_config_missing/)
  assert.match(source, /wkv2-conn__btn--connect/)
  assert.match(source, />\s*Connect\s*</)
})

test("CandidatePortal connector rows do not use dead profile links for non-OAuth actions", () => {
  assert.match(source, /action: "send_resume"/)
  assert.match(source, /buildClaireImessageHref\(profile\.senderNumber\)/)
  assert.match(source, /<ConnectorAction connector=\{c\} claireHref=\{claireHref\} \/>/)
  assert.match(source, /connector\.action === "send_resume"[\s\S]*href=\{claireHref\}[\s\S]*Send PDF/)
  assert.match(
    source,
    /connector\.action === "send_resume"[\s\S]*!claireHref[\s\S]*to="\/me\/profile#profile-corrections"[\s\S]*Update profile/,
  )
  assert.doesNotMatch(
    source,
    /return <Link to="\/me\/profile" className="wkv2-conn__btn wkv2-conn__btn--connect">Connect<\/Link>/,
  )
})

test("CandidatePortal avoids dead Claire pending actions when the sender number is missing", () => {
  assert.doesNotMatch(source, /Claire pending/)
  assert.doesNotMatch(source, /Claire line pending/)
  assert.doesNotMatch(source, /<button[^>]*disabled[^>]*>\s*Claire line pending\s*<\/button>/)
  assert.match(
    source,
    /<Link to="\/me\/profile#profile-corrections" className="wk-btn wk-btn--secondary wk-btn--block wk-btn--sm">[\s\S]*Update profile/,
  )
})

test("CandidatePortal connector errors render inline candidate-safe feedback", () => {
  assert.doesNotMatch(source, /window\.alert/)
  assert.doesNotMatch(source, /Add the GitHub OAuth app secrets first/)
  assert.doesNotMatch(source, /Add the Cal\.com OAuth app secrets first/)
  assert.match(source, /const \[error, setError\] = useState<string \| null>\(null\)/)
  assert.match(source, /<span className="wkv2-conn__error" role="status">\{error\}<\/span>/)
  assert.match(source, /setError\(connectorErrorMessage\(err, connector\.provider\)\)/)
  assert.match(source, /GitHub connection is not available yet\. Message Claire to add your GitHub context\./)
  assert.match(source, /Cal\.com connection is not available yet\. Message Claire to share scheduling context\./)
})

test("CandidatePortal submit errors do not echo raw callable detail to candidates", () => {
  assert.match(source, /function callableSubmitErrorMessage\(err: unknown\): string/)
  assert.doesNotMatch(source, /if \(code === "functions\/failed-precondition"\) return raw \|\|/)
  assert.doesNotMatch(source, /if \(code === "functions\/invalid-argument"\) return raw \|\|/)
  assert.doesNotMatch(source, /return raw \|\| "Something went wrong submitting that\. Try again\."/)
  assert.match(source, /We need to review your profile before saving this\./)
  assert.match(source, /Review the form and try again\. Claire can still update this from your message\./)
  assert.match(source, /That did not submit\. Try again in a moment, or message Claire if this is urgent\./)
})

test("CandidatePortal does not advertise unavailable account or role actions", () => {
  assert.doesNotMatch(source, /\bManage\s*<\/span>/)
  assert.doesNotMatch(source, /filter,\s*save\s*&\s*decide/i)
  assert.match(source, /\bConnected\s*<\/span>/)
  assert.match(source, /filter and review/i)
})

test("CandidatePortal recommendation cards avoid unsupported timing and internal collab wording", () => {
  assert.doesNotMatch(source, /48 hours|usually within/i)
  assert.doesNotMatch(source, />\s*See match\s*</)
  assert.doesNotMatch(source, /<PulseDot size=\{5\} \/>\s*Collab/)
  assert.match(source, /WeKruit-screened/)
  assert.match(source, /const peekCtaLabel = isCollab \? statusDisplay\.ctaLabel : "View source"/)
})

test("CandidatePortal external recommendations are source evidence, not apply-board actions", () => {
  assert.doesNotMatch(source, /you apply there/i)
  assert.doesNotMatch(source, /non-collab "See role"/)
  assert.doesNotMatch(source, />\s*See role\s*<Icon name="arrow-right" size=\{13\} stroke=\{2\} \/>/)
  assert.match(source, /External source listing — non-collab recommendations open this for inspection/)
  assert.match(source, /View source <Icon name="arrow-right" size=\{13\} stroke=\{2\} \/>/)
  assert.match(source, /\{peekCtaLabel\} <Icon name="arrow-right" size=\{12\} stroke=\{2\} \/>/)
})

test("CandidatePortal visibility actions route to the standalone privacy surface", () => {
  assert.doesNotMatch(source, /Pause for a week|Manage availability|Who&apos;s seeing me|Manage visibility/)
  assert.match(source, /Request outreach change/)
  assert.match(source, /Request availability change/)
  assert.match(source, /to="\/me\/privacy#privacy-requests"/)
  assert.match(source, /to="\/me\/privacy#privacy"/)
  assert.doesNotMatch(source, /to="\/me\/profile#privacy/)
  assert.match(source, /id="privacy"/)
  assert.match(source, /id="privacy-requests"/)
  assert.match(source, /function useProfileHashScroll/)
  assert.match(source, /function PrivacySurface\(\{ profile \}: \{ profile: CandidateSelfProfile \}\)[\s\S]*useProfileHashScroll\(\)/)
  assert.match(source, /document\.getElementById\(hash\)\?\.scrollIntoView/)
})

test("CandidateProfile derives visibility from real matches instead of zero-state placeholders", () => {
  assert.match(source, /function deriveVisibilityFromMatches\(matches: CandidateMatchCard\[\]\): MeVisibility/)
  assert.match(source, /const visibility = matchesState\.status === "ready" \? deriveVisibilityFromMatches\(allMatches\) : null/)
  assert.match(source, /const visibilityLabel = visibility\?\.label \?\? \(matchesErrored \? "Pipeline unavailable" : "Checking pipeline"\)/)
  assert.match(source, /visibilityLabel=\{visibilityLabel\}/)
  assert.match(source, /\{visibility \? <MeVisibilityCard visibility=\{visibility\} \/> : <MeVisibilityPendingCard error=\{matchesError\} \/>\}/)
  assert.doesNotMatch(source, /<MeStatusHeader[\s\S]{0,300}visibility=\{visibility\}/)
  assert.match(source, /function ProfileSurface[\s\S]*const matchesState = useCandidateMatches\(true\)/)
  assert.match(
    source,
    /matchesState\.status === "ready" \? deriveVisibilityFromMatches\(matchesState\.matches\) : null/,
  )
  assert.match(source, /<MeVisibilityPendingCard error=\{visibilityError\} \/>/)
  assert.match(source, /<div className="wkv3-vis wkv3-vis--pending">/)
  assert.match(source, /\.wkv3-vis--pending \.wkv3-vis__label::after/)
  assert.doesNotMatch(source, /deriveVisibility\(0,\s*0\)/)
})

test("CandidatePortal renders honest connector data", () => {
  assert.match(source, /linkedinOauthProfile/)
  assert.match(source, /githubOauthProfile/)
  assert.match(source, /githubPublicRepos/)
  assert.match(source, /wkv2-conn__repos/)
  assert.doesNotMatch(source, /Backfills experience/)
  assert.doesNotMatch(source, /oauth-linked/)
})

test("CandidatePortal routes Claire message actions through the claimed sender number", () => {
  assert.doesNotMatch(source, /CLAIRE_IMESSAGE_HREF/)
  assert.match(source, /buildClaireImessageHref\(profile\.senderNumber\)/)
  assert.match(source, /claireHref=\{claireHref\}/)
  assert.match(source, /href: claireHref/)
  assert.match(source, /<MeMatchFull key=\{m\.matchId\} match=\{m\} claireHref=\{claireHref\} \/>/)
})

test("CandidatePortal /me surfaces real Claire matching signals from the claimed profile", () => {
  assert.match(source, /<MeClaireSignalsCard profile=\{profile\} \/>/)
  assert.match(source, /function MeClaireSignalsCard/)
  assert.match(source, /deriveClaireSignalRows\(profile\)/)
  assert.match(source, /What Claire is matching on/)
  assert.match(source, /Pulled from your resume, tags, and corrections/)
  assert.match(source, /roleFunction/)
  assert.match(source, /targetLocations/)
  assert.match(source, /minSalaryUsd/)
  assert.match(
    source,
    /<Link to="\/me\/profile#match-preferences" className="wkv3-signal__link">[\s\S]*Update matching profile/,
  )
  assert.doesNotMatch(source, /<Link to="\/me\/profile" className="wkv3-signal__link">/)
  assert.doesNotMatch(source, /mock signal|example signal|sample signal/i)
})

test("CandidateProfile empty profile cards provide real Claire actions", () => {
  assert.match(source, /<WhatClairePitchesCard profile=\{profile\} claireHref=\{claireHref\} \/>/)
  assert.match(source, /<SkillsCard profile=\{profile\} editing=\{editing\} claireHref=\{claireHref\} \/>/)
  assert.match(source, /function WhatClairePitchesCard\(\{[\s\S]*profile,[\s\S]*claireHref,[\s\S]*\}/)
  assert.match(source, /function SkillsCard\(\{[\s\S]*profile,[\s\S]*editing,[\s\S]*claireHref,[\s\S]*\}/)
  assert.match(source, /Claire hasn&apos;t captured these yet/)
  assert.match(source, /href=\{claireHref\}[\s\S]*Message Claire/)
  assert.match(source, /href=\{claireHref\}[\s\S]*Send résumé/)
  assert.match(source, /to="\/me\/profile#profile-corrections"[\s\S]*Update preferences/)
  assert.doesNotMatch(source, /Tell her on iMessage or use "Update preferences" below/)
  assert.doesNotMatch(source, /Upload one on iMessage to see them here\./)
})

test("CandidatePortal /me shows recent role activity from real matches", () => {
  assert.match(source, /<MeActivityLog matches=\{allMatches\} claireHref=\{claireHref\} \/>/)
  assert.match(source, /function deriveMeActivityRows/)
  assert.match(source, /function MeActivityLog/)
  assert.match(source, /Recent activity/)
  assert.match(source, /computedAt/)
  assert.match(source, /reviewDecision/)
  assert.match(source, /getCandidateJobStatusDisplay\(match\.status, match\.job\.title\)/)
  assert.doesNotMatch(source, /mock activity|sample activity|fake timeline/i)
})

test("CandidatePortal recent activity rows route to the real match action target", () => {
  assert.match(source, /function activityTargetForMatch\(match: CandidateMatchCard, claireHref: string \| null\)/)
  assert.match(source, /if \(match\.status === "interview_started" && claireHref\)/)
  assert.match(source, /return matchPrimaryTarget\(match\)/)
  assert.match(source, /const target = activityTargetForMatch\(match, claireHref\)/)
  assert.match(source, /external: target\.external/)
  assert.match(source, /row\.external \? \(/)
  assert.match(source, /target=\{activityTargetOpensNewTab\(row\.href\) \? "_blank" : undefined\}/)
  assert.doesNotMatch(source, /rows\.map\(\(row\) => \(\s*<Link to=\{row\.href\}/)
})

test("CandidatePortal pipeline rows route active Claire interviews to Claire", () => {
  assert.match(source, /<MePipeline[\s\S]*claireHref=\{claireHref\}/)
  assert.match(source, /function pipelineActionForMatch\(match: CandidateMatchCard, claireHref: string \| null\)/)
  assert.match(source, /if \(match\.status === "interview_started" && claireHref\)/)
  assert.match(source, /label: "Continue with Claire"/)
  assert.match(source, /<MePipelineRow key=\{m\.matchId\} match=\{m\} claireHref=\{claireHref\} \/>/)
  assert.match(source, /const action = pipelineActionForMatch\(match, claireHref\)/)
  assert.match(source, /action\.external \? \(/)
  assert.match(source, /href=\{action\.url\}[\s\S]*\{action\.label\}/)
  assert.match(source, /to=\{action\.url\}[\s\S]*\{action\.label\}/)
  assert.doesNotMatch(source, /<Link to=\{match\.job\.href\} className="wk-btn wk-btn--secondary wk-btn--sm">\s*Open/)
})

test("CandidatePortal roles inbox makes active Claire interviews the primary action", () => {
  assert.match(source, /const activeClaireHref = match\.status === "interview_started" \? claireHref : null/)
  assert.match(source, /activeClaireHref \? \(/)
  assert.match(source, /href=\{activeClaireHref\}[\s\S]*className="wk-btn wk-btn--primary wk-btn--sm"[\s\S]*Continue with Claire/)
  assert.match(source, /<Link to=\{match\.job\.href\} className="wk-btn wk-btn--secondary wk-btn--sm">[\s\S]*View role/)
  assert.doesNotMatch(source, /<a href=\{claireHref\} className="wk-btn wk-btn--secondary wk-btn--sm">\s*<Icon name="message"[^>]*\/> Continue with Claire/)
})

test("CandidatePortal /me treats incomplete profile data as an Up Next action", () => {
  assert.match(source, /function deriveProfileNextAction/)
  assert.match(source, /function profileActionHrefForMissing/)
  assert.match(source, /const profileNextAction = deriveProfileNextAction\(completeness\)/)
  assert.match(source, /profileNextAction=\{profileNextAction\}/)
  assert.match(source, /Complete your Claire profile/)
  assert.match(source, /href: profileActionHrefForMissing\(missing\)/)
  assert.match(source, /case "resume":\s*return "\/me\/profile#connector-resume"/)
  assert.match(source, /case "linkedin":\s*return "\/me\/profile#connector-linkedin"/)
  assert.match(source, /case "skills":\s*return "\/me\/profile#skills"/)
  assert.match(source, /return "\/me\/profile#match-preferences"/)
  assert.match(source, /id=\{`connector-\$\{c\.id\}`\}/)
  assert.match(source, /id="match-preferences"/)
  assert.match(source, /function ConnectedAccountsCard[\s\S]*<section id="connected-accounts"/)
  assert.match(source, /function ContactCard[\s\S]*<section className="wkv2-card wk-prof-card"/)
  assert.match(source, /id="profile-corrections"/)
  assert.match(source, /navigate\(profileActionHrefForMissing\(missing\[0\]\)\)/)
  assert.doesNotMatch(source, /<p className="wkv3-wait__meta">No action needed right now\.<\/p>/)
})

test("CandidatePortal missing resume copy treats it as stronger evidence, not the only path to matching", () => {
  assert.match(source, /impact: "Improves matching evidence"/)
  assert.match(source, /Add a résumé so Claire can compare roles with stronger evidence\./)
  assert.doesNotMatch(source, /Unblocks matching/)
  assert.doesNotMatch(source, /Add a résumé so Claire can match you\./)
})

test("CandidatePortal profile guidance avoids unsupported lift and batch promises", () => {
  assert.doesNotMatch(source, /2× more roles/)
  assert.doesNotMatch(source, /Claire pitches sharper/)
  assert.doesNotMatch(source, /Better pitch by Claire/)
  assert.doesNotMatch(source, /\bsharp(?:er)?\b/i)
  assert.doesNotMatch(source, /next batch/i)
  assert.doesNotMatch(source, /next batch has better evidence/)
  assert.match(source, /impact: "Sets Claire's role target"/)
  assert.match(source, /impact: "Keeps location filters honest"/)
  assert.match(source, /impact: "Adds context for role review"/)
  assert.match(source, /roles can surface with clearer evidence/)
  assert.match(source, /keeps future matching tied to evidence you can review/)
  assert.match(source, /Add a few things so Claire has more evidence to compare\./)
  assert.match(source, /The more\s+complete this is, the more evidence Claire has for role review\./)
  assert.match(source, /Claire needs more target-role signal before roles can surface with clear evidence\./)
  assert.match(source, /Profile edits keep future matching tied to evidence you can review\./)
})

test("CandidatePortal /me treats new recommended roles as an Up Next action", () => {
  assert.match(source, /function deriveRecommendedRolesAction\(recommendedCount: number\): MeAction \| null/)
  assert.match(source, /const recommendedNextAction = deriveRecommendedRolesAction\(recommended\.length\)/)
  assert.match(source, /recommendedNextAction=\{recommendedNextAction\}/)
  assert.match(source, /actions\.length \+ \(recommendedNextAction \? 1 : 0\) \+ \(profileNextAction \? 1 : 0\)/)
  assert.match(source, /key: "recommended-roles"/)
  assert.match(source, /meta: `New roles · \$\{recommendedCount\} \$\{recommendedCount === 1 \? "role" : "roles"\}`/)
  assert.match(source, /title: "Review new roles Claire found"/)
  assert.match(source, /href: "\/me\/matches"/)
  assert.match(source, /recommendedNextAction \? \[recommendedNextAction\] : \[\]/)
})

test("CandidatePortal /me turns passed and accepted-intro outcomes into follow-up actions", () => {
  assert.match(source, /function deriveRoleFollowupActions\(matches: CandidateMatchCard\[\]\): MeAction\[\]/)
  assert.match(source, /m\.status === "passed" \|\| m\.status === "intro_accepted"/)
  assert.match(source, /const roleFollowupActions = deriveRoleFollowupActions\(allMatches\)/)
  assert.match(source, /const actions: MeAction\[\] = \[\.\.\.interviewActions, \.\.\.roleFollowupActions\]/)
  assert.match(source, /actions=\{actions\}/)
  assert.match(source, /const introRejectedSignal = match\.status === "intro_rejected" && Boolean\(profileSignalHref\)/)
  assert.match(source, /const profileSignalMeta = introRejectedSignal \? "Intro closed · profile signal" : "Role closed · profile signal"/)
  assert.match(source, /meta: profileSignalHref \? profileSignalMeta : accepted \? "Intro accepted · next step" : "Passed profile · review"/)
  assert.match(source, /cta: profileSignalHref \? "Update profile signal" : accepted \? "Review intro" : "Review pass note"/)
  assert.match(source, /sub: match\.reviewDecision\?\.decisionReason \|\| display\.nextStep/)
  assert.doesNotMatch(source, /employer will reach out directly/i)
})

test("CandidatePortal closed review outcomes route to durable profile signal updates", () => {
  assert.match(source, /function profileSignalHrefForMatch\(match: CandidateMatchCard\): string \| null/)
  assert.match(source, /match\.status === "not_passed" && match\.reviewDecision/)
  assert.match(source, /match\.status === "intro_rejected"/)
  assert.match(source, /const params = new URLSearchParams\(\)/)
  assert.match(source, /params\.set\("profileRoleSignalTitle", match\.job\.title\)/)
  assert.match(source, /params\.set\("profileRoleSignalCompany", match\.job\.company\)/)
  assert.match(source, /params\.set\("profileRoleSignalOutcome", "not_passed"\)/)
  assert.match(source, /params\.set\("profileRoleSignalOutcome", "intro_rejected"\)/)
  assert.match(source, /params\.set\("profileRoleSignalReason", match\.reviewDecision\.decisionReason\)/)
  assert.match(source, /params\.set\("profileRoleSignalReason", display\.nextStep\)/)
  assert.match(source, /params\.set\("profileRoleSignalActions", match\.reviewDecision\.recommendedActions\.slice\(0, 3\)\.join\("\\n"\)\)/)
  assert.match(source, /return `\/me\/profile\?\$\{params\.toString\(\)\}#profile-corrections`/)
  assert.match(source, /profileSignalHrefForMatch\(m\)/)
  assert.match(source, /const profileSignalHref = profileSignalHrefForMatch\(match\)/)
  assert.match(source, /const introRejectedSignal = match\.status === "intro_rejected" && Boolean\(profileSignalHref\)/)
  assert.match(source, /const profileSignalMeta = introRejectedSignal \? "Intro closed · profile signal" : "Role closed · profile signal"/)
  assert.match(source, /meta: profileSignalHref \? profileSignalMeta/)
  assert.match(source, /cta: profileSignalHref \? "Update profile signal"/)
  assert.match(source, /href: profileSignalHref \?\? target\.url/)
  assert.match(source, /if \(profileSignalHref\) return \{ external: false, url: profileSignalHref \}/)
  assert.match(source, /label: "Update profile signal"/)
  assert.match(source, /profileSignalHref \? \(/)
  assert.match(source, /to=\{profileSignalHref\}[\s\S]*className="wk-btn wk-btn--primary wk-btn--sm"[\s\S]*Update profile signal/)
  assert.match(source, /<Link to=\{match\.job\.href\} className="wk-btn wk-btn--secondary wk-btn--sm">[\s\S]*View role/)
})

test("CandidatePortal profile corrections can draft role signals from market and closed reviews", () => {
  assert.match(source, /type ProfileSignalDraft = \{ text: string; sourceLabel: string; structuredFields: Record<string, unknown> \}/)
  assert.match(source, /function useProfileSignalDraft\(\): ProfileSignalDraft \| null/)
  assert.match(source, /new URLSearchParams\(location\.search\)/)
  assert.match(source, /profileRoleSignalTitle/)
  assert.match(source, /profileRoleSignalCompany/)
  assert.match(source, /profileRoleSignalOutcome/)
  assert.match(source, /profileRoleSignalReason/)
  assert.match(source, /profileRoleSignalActions/)
  assert.match(source, /Recommended role signal/)
  assert.match(source, /Use this recommended role as profile signal/)
  assert.match(source, /Claire surfaced this role because/)
  assert.match(source, /Use this market role as profile signal/)
  assert.match(source, /Use this closed role as profile signal/)
  assert.match(source, /Use this closed intro as profile signal/)
  assert.match(source, /Employer intro outcome/)
  assert.match(source, /Update my durable matching preferences or profile evidence to avoid repeating this mismatch/)
  assert.match(source, /Update my durable matching preferences or profile evidence if this closure should change future matching/)
  assert.match(source, /<UpdatePreferencesPanel onProfileUpdated=\{setProfile\} initialCorrectionDraft=\{profileSignalDraft\} \/>/)
  assert.match(source, /initialCorrectionText,?[\s\S]*onProfileUpdated/)
  assert.match(source, /useState\(\(\) => initialCorrectionText \?\? ""\)/)
  assert.match(source, /setCorrectionText\(initialCorrectionText\)/)
  assert.match(source, /Source role from market/)
  assert.match(source, /Closed role signal/)
  assert.match(source, /Closed intro signal/)
  assert.match(source, /Tell Claire what to change[\s\S]*market role context/)
})

test("CandidatePortal role signal corrections persist structured evidence", () => {
  assert.match(source, /type ProfileSignalDraft = \{ text: string; sourceLabel: string; structuredFields: Record<string, unknown> \}/)
  assert.match(source, /roleSignal: \{[\s\S]*source: "recommended_role"[\s\S]*title[\s\S]*company[\s\S]*reason/)
  assert.match(source, /roleSignal: \{[\s\S]*source: "market_role"[\s\S]*title[\s\S]*company[\s\S]*context/)
  assert.match(source, /roleSignal: \{[\s\S]*source: "closed_role"[\s\S]*outcome: "not_passed"[\s\S]*actions/)
  assert.match(source, /roleSignal: \{[\s\S]*source: "closed_intro"[\s\S]*outcome: "intro_rejected"/)
  assert.match(source, /const structuredFields = initialCorrectionDraft\?\.structuredFields/)
  assert.match(source, /submitCorrection\(\{ correctionText, structuredFields \}\)/)
})

test("CandidatePortal match preference saves route canonical tags as user tag corrections", () => {
  assert.match(source, /const result = await submit\(\{ correctionText, targetType: "user_tags", structuredFields \}\)/)
  assert.match(source, /submitCorrection\(\{ correctionText, structuredFields \}\)/)
  assert.doesNotMatch(source, /submitCorrection\(\{ correctionText, targetType: "user_tags", structuredFields \}\)/)
})

test("CandidatePortal role signal success copy is candidate-facing", () => {
  assert.match(source, /const roleSignalSubmitted = Boolean\(initialCorrectionDraft\?\.structuredFields\.roleSignal\)/)
  assert.match(source, /Role signal saved — Claire will use it as matching evidence\./)
  assert.doesNotMatch(source, /Updated: \$\{result\.appliedKeys\.join\(", "\)\}/)
  assert.doesNotMatch(source, /Updated: roleSignal/)
})

test("CandidatePortal /me/matches sidebar shows the real matching basis", () => {
  assert.match(source, /function MatchesView\([\s\S]*<MeClaireSignalsCard profile=\{profile\} \/>/)
  assert.match(source, /function deriveClaireSignalRows\(profile: CandidateSelfProfile\): MeSignalRow\[\]/)
  assert.match(source, /What Claire is matching on/)
  assert.match(source, /roleFunction/)
  assert.match(source, /targetLocations/)
  assert.match(source, /minSalaryUsd/)
  assert.doesNotMatch(source, /Claire scans/)
  assert.doesNotMatch(source, /Active · iMessage/)
})

test("CandidatePortal Up Next orders critical profile blockers before recommended roles", () => {
  assert.match(source, /function buildUpNextActions\(/)
  assert.match(source, /const urgentActions = actions\.filter\(\(a\) => a\.urgent\)/)
  assert.match(source, /const nonUrgentActions = actions\.filter\(\(a\) => !a\.urgent\)/)
  assert.match(source, /const criticalProfileAction = profileNextAction\?\.urgent \? profileNextAction : null/)
  assert.match(source, /const nonCriticalProfileAction = profileNextAction && !profileNextAction\.urgent \? profileNextAction : null/)
  assert.match(
    source,
    /return \[\s*\.\.\.urgentActions,\s*\.\.\.\(criticalProfileAction \? \[criticalProfileAction\] : \[\]\),\s*\.\.\.nonUrgentActions,\s*\.\.\.\(recommendedNextAction \? \[recommendedNextAction\] : \[\]\),\s*\.\.\.\(nonCriticalProfileAction \? \[nonCriticalProfileAction\] : \[\]\),\s*\]/,
  )
  assert.match(source, /const upNextActions = buildUpNextActions\(\{ actions, recommendedNextAction, profileNextAction \}\)/)
  assert.doesNotMatch(source, /const upNextActions = \[\.\.\.actions, \.\.\.\(recommendedNextAction \? \[recommendedNextAction\] : \[\]\), \.\.\.\(profileNextAction \? \[profileNextAction\] : \[\]\)\]/)
})

test("CandidatePortal status header CTA labels the scroll action honestly", () => {
  assert.match(source, /document\.getElementById\("up-next"\)\?\.scrollIntoView/)
  assert.match(source, /Review up next <Icon name="arrow-right" size=\{13\} stroke=\{2\} \/>/)
  assert.doesNotMatch(
    source,
    /className="wkv3-status__cta"[\s\S]{0,800}Continue with Claire <Icon name="arrow-right" size=\{13\} stroke=\{2\} \/>/,
  )
})

test("CandidatePortal pipeline stage filters avoid dead zero-count taps", () => {
  assert.match(source, /const hasPipelineRows = matches\.length > 0/)
  assert.match(source, /const disabled = n === 0 && !active/)
  assert.match(source, /disabled=\{disabled\}/)
  assert.match(source, /aria-disabled=\{disabled\}/)
  assert.match(source, /hasPipelineRows \? "Tap a stage to filter\." : "Stages appear as roles move forward\."/)
  assert.doesNotMatch(source, /"Tap a stage to filter\."\s*\)\s*<\/span>/)
})

test("CandidatePortal /me surfaces role load failures instead of treating them as an empty pipeline", () => {
  assert.match(source, /reload: \(\) => void/)
  assert.match(source, /const reload = useCallback\(\(\) => setTick\(\(n\) => n \+ 1\), \[\]\)/)
  assert.match(source, /<MeRoleDashboardError message=\{matchesError\} onRetry=\{matchesState\.reload\} \/>/)
  assert.match(source, /function MeRoleDashboardError\(/)
  assert.match(source, /role="alert"/)
  assert.match(source, /Your role dashboard couldn&apos;t load/)
  assert.match(source, /<MePipeline[\s\S]*errored=\{matchesErrored\}[\s\S]*error=\{matchesError\}/)
  assert.match(source, /function MePipeline\(\{[\s\S]*errored,[\s\S]*error,[\s\S]*\}/)
  assert.match(source, /errored \? \([\s\S]*<div className="wkv3-empty-block wkv3-empty-block--error">\{error\}<\/div>/)
  assert.doesNotMatch(source, /matchesErrored[\s\S]{0,400}<MeWaitingCard/)
})

test("CandidatePortal /me summarizes the real candidate operating loop", () => {
  assert.match(source, /deriveCandidateOperatingLoop/)
  assert.match(source, /const operatingLoop = deriveCandidateOperatingLoop\(allMatches\)/)
  assert.match(source, /<MeOperatingLoopPanel loop=\{operatingLoop\} \/>/)
  assert.match(source, /function MeOperatingLoopPanel/)
  assert.match(source, /WeKruit loop/)
  assert.match(source, /Candidate-visible role states and feedback signals in one place\./)
  assert.match(source, /stat\.label/)
  assert.doesNotMatch(source, /WeKruit is working/)
  assert.doesNotMatch(source, /Claire keeps scanning/)
})

test("CandidatePortal exposes privacy as a standalone signed-in marketplace surface", () => {
  assert.match(source, /export function CandidatePrivacy\(\)/)
  assert.match(source, /const gate = useCandidatePortalGate\(\)/)
  assert.match(source, /const state = useClaimedProfile\(\)/)
  assert.match(source, /<PortalGatePending gate=\{gate\} kicker="Privacy" \/>/)
  assert.match(source, /if \(state\.status === "signed_out"\) return <SignInRequired kicker="Privacy" \/>/)
  assert.match(source, /if \(state\.status === "loading"\) return <PortalLoading kicker="Privacy" \/>/)
  assert.match(source, /if \(state\.status === "error"\) return <PortalError kicker="Privacy" message=\{state\.message\} \/>/)
  assert.match(source, /return <PrivacySurface profile=\{state\.profile\} \/>/)
  assert.match(source, /function PrivacySurface\(\{ profile \}: \{ profile: CandidateSelfProfile \}\)/)
  assert.match(source, /<PrivacyCard \/>/)
  assert.match(source, /<PrivacyRequestPanel \/>/)
  assert.match(source, /Candidate privacy/)
  assert.match(source, /Export, deletion, outreach, and employer-block requests stay reviewed/)
  assert.doesNotMatch(source, /mock privacy|sample privacy|fake privacy/i)
})
