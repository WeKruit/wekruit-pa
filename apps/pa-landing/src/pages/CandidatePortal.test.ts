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

test("CandidatePortal renders honest connector data", () => {
  assert.match(source, /linkedinOauthProfile/)
  assert.match(source, /githubOauthProfile/)
  assert.match(source, /githubPublicRepos/)
  assert.match(source, /wkv2-conn__repos/)
  assert.doesNotMatch(source, /Backfills experience/)
  assert.doesNotMatch(source, /oauth-linked/)
})
