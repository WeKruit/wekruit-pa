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
  assert.match(source, /Update matching preferences/)
})

test("CandidatePortal roles inbox routes preference edits to the match-preferences editor", () => {
  assert.match(
    source,
    /<Link to="\/me\/profile#match-preferences" className="wk-btn wk-btn--primary wk-btn--sm">[\s\S]*Adjust matching/,
  )
  assert.match(
    source,
    /<Link\s+to="\/me\/profile#match-preferences"\s+className="wkv3-match__prefs">[\s\S]*Update matching preferences/,
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
  assert.match(source, />Connect</)
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
  assert.match(source, /const peekCtaLabel = isCollab \? statusDisplay\.ctaLabel : "See role"/)
})

test("CandidatePortal visibility actions route to reviewed privacy requests", () => {
  assert.doesNotMatch(source, /Pause for a week|Manage availability|Who&apos;s seeing me|Manage visibility/)
  assert.match(source, /Request outreach change/)
  assert.match(source, /Request availability change/)
  assert.match(source, /to="\/me\/profile#privacy-requests"/)
  assert.match(source, /id="privacy"/)
  assert.match(source, /id="privacy-requests"/)
  assert.match(source, /function useProfileHashScroll/)
  assert.match(source, /document\.getElementById\(hash\)\?\.scrollIntoView/)
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

test("CandidatePortal /me shows recent role activity from real matches", () => {
  assert.match(source, /<MeActivityLog matches=\{allMatches\} \/>/)
  assert.match(source, /function deriveMeActivityRows/)
  assert.match(source, /function MeActivityLog/)
  assert.match(source, /Recent activity/)
  assert.match(source, /computedAt/)
  assert.match(source, /reviewDecision/)
  assert.match(source, /getCandidateJobStatusDisplay\(match\.status, match\.job\.title\)/)
  assert.doesNotMatch(source, /mock activity|sample activity|fake timeline/i)
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
