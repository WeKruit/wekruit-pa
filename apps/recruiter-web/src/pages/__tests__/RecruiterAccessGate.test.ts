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

test("Recruiter access gate captures recruiter name before Google binding", () => {
  assert.match(source, /const \[recruiterName, setRecruiterName\] = useState\(""\)/)
  assert.match(source, /Enter your name before claiming recruiter access\./)
  assert.match(source, /writePendingRecruiterAccess\(trimmedInviteCode, trimmedRecruiterName\)/)
  assert.match(source, /<span>Your name<\/span>/)
  assert.match(source, /name: pending\.name \|\| cleanRecruiterName\(user\.displayName \?\? ""\) \|\| "Recruiter",/)
})

test("Returning signed-in recruiters skip the gate when paRecruiterMe recognizes them", () => {
  assert.match(source, /const next = await getRecruiterProfile\(\)\s*\n\s*if \(active\) \{\s*\n\s*setAccessError\(null\)\s*\n\s*setProfileLoadFailed\(false\)\s*\n\s*setSession\(next\)/)
  assert.match(source, /if \(!authReady\) \{\s*\n\s*return <div className="rb-access"/)
  assert.match(source, /if \(!session\) \{\s*\n\s*if \(profileLoadFailed\) \{/)
  const gateRenderCount = (source.match(/<RecruiterAccessGate/g) ?? []).length
  assert.equal(gateRenderCount, 1, "gate renders only on the no-session branch")
})

test("Transient paRecruiterMe failures keep the Firebase session and offer an inline retry", () => {
  assert.match(source, /catch \(e\) \{\s*\n\s*if \(!isRecruiterProfileRejection\(e\)\) \{\s*\n\s*handlingUid = null\s*\n\s*if \(active\) setProfileLoadFailed\(true\)\s*\n\s*return\s*\n\s*\}\s*\n\s*await signOut\(auth\(\)\)/)
  assert.match(source, /Couldn't load your recruiter profile\. You're still signed in\./)
  assert.match(source, /setProfileRetryToken\(\(n\) => n \+ 1\)\}>Retry<\/button>/)
  assert.match(source, /\}, \[profileRetryToken\]\)/)
  const apiSource = readFileSync(resolve(here, "../../lib/recruiter-board-api.ts"), "utf8")
  assert.match(apiSource, /error\.status === 401 \|\| error\.status === 403/)
  assert.match(apiSource, /throw new RecruiterApiError\(body\.reason \?\? `paRecruiterMe HTTP \$\{res\.status\}`, res\.status\)/)
})
