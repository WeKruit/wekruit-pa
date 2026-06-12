import { readFileSync } from "node:fs"
import { join } from "node:path"
import { test } from "node:test"
import assert from "node:assert/strict"

const root = process.cwd()
const pageSource = readFileSync(join(root, "src/pages/RecruiterSubmissions.tsx"), "utf8")
const apiSource = readFileSync(join(root, "src/lib/recruiter-platform-api.ts"), "utf8")

test("recruiter access page exposes invite email resend actions", () => {
  assert.match(pageSource, /resendRecruiterInviteCodeEmail/)
  assert.match(pageSource, /Resend all pending/)
  assert.match(pageSource, /Resend email/)
})

test("recruiter platform API posts invite resends to the recruiter-board function", () => {
  assert.match(apiSource, /paRecruiterInviteCodeResend/)
  assert.match(apiSource, /body: JSON\.stringify\(\{ inviteCodeId \}\)/)
})
