// @ts-nocheck - landing app tests run with node --test via tsx.
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(resolve(here, "WkJobs.tsx"), "utf8")
const backend = readFileSync(
  resolve(here, "../../../functions/src/wkjobs/store.ts"),
  "utf8",
)

test("consent version matches the backend constant exactly", () => {
  // The backend refuses any other value, so drift here would silently break
  // every approval. Pin them together rather than discovering it in prod.
  const page = source.match(/const CONSENT_VERSION = "([^"]+)"/)
  const server = backend.match(/export const WKJOBS_CONSENT_VERSION = "([^"]+)"/)
  assert.ok(page, "page must declare CONSENT_VERSION")
  assert.ok(server, "backend must declare WKJOBS_CONSENT_VERSION")
  assert.equal(page[1], server[1], "wkjobs consent version drifted between page and backend")
})

test("consent is required before the device can be approved", () => {
  assert.match(source, /const \[consented, setConsented\] = useState\(false\)/)
  // The Connect button stays disabled until the box is ticked.
  assert.match(source, /onClick=\{\(\) => void decide\(true\)\}\s*disabled=\{!consented/)
})

test("declining never requires accepting the terms", () => {
  // consent_version is attached only on the approve path; "This wasn't me" must
  // work for someone who refuses the terms outright.
  assert.match(source, /\.\.\.\(approve \? \{ consent_version: CONSENT_VERSION \} : \{\}\)/)
  assert.match(source, /onClick=\{\(\) => void decide\(false\)\}/)
})

test("consent text names what is distinct about the CLI, not generic terms", () => {
  assert.match(source, /stores my LinkedIn session there/)
  assert.match(source, /never sent to WeKruit/)
  assert.match(source, /wkjobs logout/)
  assert.match(source, /<a href="\/legal">Terms<\/a>/)
  assert.match(source, /<a href="\/legal">Privacy Policy<\/a>/)
})

test("the page delegates sign-in rather than reimplementing it", () => {
  assert.match(source, /\/login\?next=\$\{encodeURIComponent\(next\)\}/)
  // No provider SDK usage here — Google/LinkedIn/magic-link stay in CandidateLogin.
  assert.doesNotMatch(source, /GoogleAuthProvider|signInWithPopup|signInWithCustomToken/)
})

test("the browser never names the candidate", () => {
  // Identity is derived server-side from pa-candidate-auth; sending a candidate
  // id from the page would be the whole vulnerability.
  assert.doesNotMatch(source, /candidate_id|candidateId/)
  assert.match(source, /authorization: `Bearer \$\{idToken\}`/)
})

test("resume upload is offered only after approval and is dismissible", () => {
  // The nudge lives in Approved(), which renders on phase === "approved" only.
  assert.match(source, /\{phase === "approved" && <Approved \/>\}/)
  assert.match(source, /function Approved\(\)/)
  assert.match(source, /Add your resume for better matches/)
  assert.match(source, /onClick=\{\(\) => setState\("dismissed"\)\}/)
  assert.match(source, /Maybe later/)
})

test("resume upload reuses the existing ingest helper and its source tag", () => {
  assert.match(source, /import \{ uploadResume \} from "\.\.\/lib\/onboarding-cv\.js"/)
  assert.match(source, /uploadResume\(file, \{ source: "wkjobs_cli" \}\)/)
  assert.match(
    source,
    /accept="\.pdf,\.docx,application\/pdf,application\/vnd\.openxmlformats-officedocument\.wordprocessingml\.document"/,
  )
})

test("the confirm step shows the code so it can be compared with the terminal", () => {
  assert.match(source, /Check that this code matches the one in your terminal/)
  assert.match(source, /function CodeChip\(\{ code \}: \{ code: string \}\)/)
  // Read aloud digit-by-digit for screen readers rather than as one word.
  assert.match(source, /aria-label=\{`Code \$\{code\.split\(""\)\.join\(" "\)\}`\}/)
})

test("every failure reason has candidate-facing copy", () => {
  for (const reason of [
    "unknown_code",
    "expired",
    "already_decided",
    "no_candidate_profile",
    "sign_in_required",
  ]) {
    assert.match(source, new RegExp(`${reason}:`), `missing copy for ${reason}`)
  }
})

test("headline rows follow the ConnectLinkedin treatment", () => {
  assert.match(source, /\.wk-wkjobs__title \{[\s\S]*font-size: clamp\(40px, 5vw, 62px\);[\s\S]*line-height: 1\.18;/)
  assert.match(source, /\.wk-wkjobs__title > span \{ display: block; line-height: inherit; \}/)
  assert.match(
    source,
    /@media \(max-width: 520px\) \{[\s\S]*\.wk-wkjobs__title \{[\s\S]*font-size: clamp\(34px, 11vw, 42px\)/,
  )
})
