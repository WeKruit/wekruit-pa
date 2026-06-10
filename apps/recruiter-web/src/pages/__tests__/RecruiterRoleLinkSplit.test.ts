// @ts-nocheck - source-contract test runs with node --test via tsx.
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import test from "node:test"

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(resolve(here, "../RecruiterRole.tsx"), "utf8")
const apiSource = readFileSync(resolve(here, "../../lib/recruiter-board-api.ts"), "utf8")

test("submit form splits candidate link into LinkedIn URL and resume link fields", () => {
  assert.match(source, /<label>LinkedIn URL<\/label>/)
  assert.match(source, /<label>Resume link<\/label>/)
  assert.match(source, /value=\{form\.candidateLinkedinUrl\}/)
  assert.match(source, /value=\{form\.candidateResumeUrl\}/)
  assert.match(source, /At least one of LinkedIn URL or resume link is required\./)
})

test("at least one of the two link fields is required", () => {
  assert.match(source, /required=\{!form\.candidateResumeUrl\.trim\(\)\}/, "LinkedIn field required only while resume link is empty")
  assert.match(source, /required=\{!form\.candidateLinkedinUrl\.trim\(\)\}/, "resume field required only while LinkedIn is empty")
  assert.match(source, /const candidateLink = candidateLinkValue\(form\)/)
  assert.match(source, /if \(!candidateLink\) blockers\.push\("LinkedIn or resume link is missing\."\)/)
  assert.match(source, /return form\.candidateLinkedinUrl\.trim\(\) \|\| form\.candidateResumeUrl\.trim\(\)/)
})

test("payload keeps candidate.link back-compat and adds both split fields top-level", () => {
  assert.match(source, /link: candidateLinkedinUrl \|\| candidateResumeUrl,/)
  assert.match(source, /candidateLinkedinUrl: candidateLinkedinUrl \|\| undefined,/)
  assert.match(source, /candidateResumeUrl: candidateResumeUrl \|\| undefined,/)
  assert.match(apiSource, /candidateLinkedinUrl\?: string/)
  assert.match(apiSource, /candidateResumeUrl\?: string/)
})

test("saved drafts and sourced candidates with a single link migrate into the right field", () => {
  assert.match(source, /function splitCandidateLink\(link: string \| undefined\)/)
  assert.match(source, /\? splitCandidateLink\(candidateLink\)/, "old localStorage drafts migrate their single link")
  const prefillCount = (source.match(/\.\.\.splitCandidateLink\(candidate\.candidate\?\.link\),/g) ?? []).length
  assert.equal(prefillCount, 2, "both sourced-candidate prefill paths split the stored link")
  assert.match(source, /value\.toLowerCase\(\)\.includes\("linkedin\."\)/)
})

test("identity preflight watches both link fields", () => {
  assert.match(source, /const link = candidateLinkValue\(form\)/)
  assert.match(source, /\}, \[form\.candidateEmail, form\.candidateLinkedinUrl, form\.candidateResumeUrl, jobId, session\]\)/)
  assert.match(source, /candidateLink=\{candidateLinkValue\(form\)\}/)
})
