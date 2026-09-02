import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import assert from "node:assert/strict"
import { describe, it } from "node:test"

const source = readFileSync(resolve(import.meta.dirname, "../recruiter-board.ts"), "utf8")

describe("recruiter invite endpoint scaling", () => {
  it("lets rare admin invite email endpoints scale to zero while staying capped", () => {
    assert.match(source, /const ADMIN_INVITE_ENDPOINT_SCALE = \{\s*maxInstances: 1,\s*\}/)
    assert.doesNotMatch(source, /const ADMIN_INVITE_ENDPOINT_SCALE = \{[^}]*minInstances:/)
    assert.match(source, /paRecruiterInviteCodeCreate = onRequest\(\n  \{[\s\S]*\.\.\.ADMIN_INVITE_ENDPOINT_SCALE[\s\S]*secrets: \[\.\.\.MAILGUN_SECRETS, PA_ADMIN_TOKEN_SECRET\]/)
    assert.match(source, /paRecruiterInviteCodeResend = onRequest\(\n  \{[\s\S]*\.\.\.ADMIN_INVITE_ENDPOINT_SCALE[\s\S]*secrets: \[\.\.\.MAILGUN_SECRETS, PA_ADMIN_TOKEN_SECRET\]/)
  })
})
