// @ts-nocheck - source-contract test runs with node --test via tsx.
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import test from "node:test"

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(resolve(here, "../RecruiterBoard.tsx"), "utf8")

test("Recruiter access gate lets users leave the recruiter-only app for public WeKruit", () => {
  assert.doesNotMatch(source, new RegExp('<Link to="/" className="rb-access__link">Back to WeKruit</Link>'))
  assert.match(source, new RegExp('<a href="https://candidate\\.wekruit\\.com/" className="rb-access__link">Back to WeKruit</a>'))
})

test("Gate is a single Continue-with-Google card with no code or name inputs", () => {
  const formStart = source.indexOf("onSubmit={submitSignIn}")
  assert.ok(formStart > 0, "sign-in form exists")
  const formEnd = source.indexOf("</form>", formStart)
  const formSlice = source.slice(formStart, formEnd)
  assert.doesNotMatch(formSlice, /<input/, "gate has no text inputs")
  assert.match(formSlice, /Continue with Google/)
  assert.doesNotMatch(formSlice, /access code/i, "no access code language in the gate")
})

test("Codeless claim sends the payload without inviteCode and pulls the Google displayName", () => {
  assert.match(source, /\.\.\.\(pending\.inviteCode \? \{ inviteCode: pending\.inviteCode \} : \{\}\),/)
  assert.match(source, /name: pending\.name \|\| cleanRecruiterName\(user\.displayName \?\? ""\) \|\| "Recruiter",/)
  assert.match(source, /if \(typeof parsed\.inviteCode !== "string"\) return null/, "codeless pending slot survives the storage round-trip")
  const apiSource = readFileSync(resolve(here, "../../lib/recruiter-board-api.ts"), "utf8")
  assert.match(apiSource, /inviteCode\?: string/, "claim API accepts a payload without inviteCode")
})

test("Claim rejection shows the no-invite message with a different-account retry", () => {
  assert.match(source, /No invitation found for \$\{invitedAddress\}\. Ask your WeKruit contact to invite this address/)
  const formStart = source.indexOf("onSubmit={submitSignIn}")
  const formSlice = source.slice(formStart, source.indexOf("</form>", formStart))
  assert.match(formSlice, /Try a different Google account/)
  assert.match(formSlice, /clearStuckGoogleState/)
})

test("No manual access code form exists", () => {
  assert.doesNotMatch(source, /setManualMode/, "no manual mode toggle")
  assert.doesNotMatch(source, /placeholder="WK-XXXX/, "no invite code input field")
  assert.doesNotMatch(source, /<span>Access code<\/span>/, "no access code label")
  assert.doesNotMatch(source, /Have an access code\?/, "no access code disclosure button")
})

test("Returning signed-in recruiters skip the gate when paRecruiterMe recognizes them", () => {
  assert.match(source, /useRecruiterSession\(\)/)
  assert.doesNotMatch(source, /onAuthStateChanged\(auth\(\)/)
  assert.doesNotMatch(source, /const \[session, setSession\] = useState<RecruiterSession \| null>\(null\)/)
  assert.match(source, /if \(!authReady\) \{\s*\n\s*return <div className="rb-access"/)
  assert.match(source, /if \(!session\) \{\s*\n\s*if \(profileLoadFailed\) \{/)
  const gateRenderCount = (source.match(/<RecruiterAccessGate/g) ?? []).length
  assert.equal(gateRenderCount, 1, "gate renders only on the no-session branch")
})

test("Transient paRecruiterMe failures keep the Firebase session and offer an inline retry", () => {
  assert.match(source, /Couldn't load your recruiter profile\. You're still signed in\./)
  assert.match(source, /onClick=\{retryProfile\}>Retry<\/button>/)
  const contextSource = readFileSync(resolve(here, "../../lib/recruiter-session-context.tsx"), "utf8")
  assert.match(contextSource, /if \(!isRecruiterProfileRejection\(e\)\) \{\s*\n\s*handlingUid = null\s*\n\s*if \(active\) setProfileLoadFailed\(true\)\s*\n\s*return\s*\n\s*\}\s*\n\s*await signOut\(auth\(\)\)/)
  assert.match(contextSource, /retryProfile: \(\) => setRetryToken\(\(n\) => n \+ 1\)/)
  const apiSource = readFileSync(resolve(here, "../../lib/recruiter-board-api.ts"), "utf8")
  assert.match(apiSource, /error\.status === 401 \|\| error\.status === 403/)
  assert.match(apiSource, /throw new RecruiterApiError\(body\.reason \?\? `paRecruiterMe HTTP \$\{res\.status\}`, res\.status\)/)
})
