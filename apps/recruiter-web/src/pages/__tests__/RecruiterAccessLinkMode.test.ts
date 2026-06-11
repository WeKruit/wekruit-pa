// @ts-nocheck - source-contract test runs with node --test via tsx.
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import test from "node:test"

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(resolve(here, "../RecruiterBoard.tsx"), "utf8")

test("invite link params are captured once and stripped from the URL", () => {
  assert.match(source, /const code = cleanRecruiterInviteCode\(params\.get\("code"\) \?\? ""\)/)
  assert.match(source, /const emailHint = cleanRecruiterEmail\(params\.get\("email"\) \?\? ""\)/)
  assert.match(source, /useState<RecruiterInviteLink \| null>\(readRecruiterInviteLinkFromLocation\)/)
  assert.match(source, /next\.delete\("code"\)\s*\n\s*next\.delete\("email"\)\s*\n\s*next\.delete\("invite"\)\s*\n\s*setSearchParams\(next, \{ replace: true \}\)/)
})

test("codeless ?invite=1 links enter link capture with the email hint and no code", () => {
  assert.match(source, /if \(!code && params\.get\("invite"\) !== "1"\) return null/)
  assert.match(source, /return \{ code, emailHint \}/)
})

test("invite link persists code + email hint to the pending-claim slot before auth resolves", () => {
  assert.match(source, /writePendingRecruiterAccess\(inviteLink\.code, "", inviteLink\.emailHint \|\| undefined\)/)
  assert.match(source, /function writePendingRecruiterAccess\(inviteCode: string, name: string, emailHint\?: string\)/)
  assert.match(source, /\.\.\.\(emailHint \? \{ emailHint \} : \{\}\),/)
  const captureIdx = source.indexOf("// Invite-link mode:")
  const gateIdx = source.indexOf("function RecruiterAccessGate")
  assert.ok(captureIdx > 0 && captureIdx < gateIdx, "capture effect registers before the gate claim flow")
})

test("invite link renders a single-action gate with no code shown and no typing", () => {
  const formStart = source.indexOf("onSubmit={submitSignIn}")
  assert.ok(formStart > 0, "sign-in form exists")
  const formEnd = source.indexOf("</form>", formStart)
  const formSlice = source.slice(formStart, formEnd)
  assert.match(formSlice, /You're invited/)
  assert.match(formSlice, /Continue with Google/)
  assert.doesNotMatch(formSlice, /<input/, "gate has no text inputs")
  assert.doesNotMatch(formSlice, /access code/i, "no access code language")
  const gateRenderCount = (source.match(/<RecruiterAccessGate/g) ?? []).length
  assert.equal(gateRenderCount, 1, "gate renders only on the no-session branch")
})

test("claim falls back to the Google displayName for the required name", () => {
  assert.match(source, /name: pending\.name \|\| cleanRecruiterName\(user\.displayName \?\? ""\) \|\| "Recruiter",/)
})

test("email mismatch shows the invite email hint with a usable retry", () => {
  assert.match(source, /if \(error\.message === "email_mismatch"\) \{/)
  assert.match(source, /`This invite is for \$\{inviteEmailHint\}\. Sign in with that Google account\.`/)
  assert.match(source, /if \(initialError\) setBusy\(false\)/, "claim rejection re-enables the gate button for retry")
})

test("no manual access code path exists", () => {
  assert.doesNotMatch(source, /setManualMode/, "no manual mode")
  assert.doesNotMatch(source, /<span>Access code<\/span>/, "no code input label")
})
